// The deterministic screenshot scenes behind ?shot=start|play|levelup|end.
// Each one plays the real rules forward from a fresh world for a fixed
// number of steps, steered by a simple autopilot (kite away from the nearest
// foe, drift toward the nearest shard, dash when surrounded), so the frame
// is what a short game really looks like and the same seed always gives
// the same frame.
import { FIELD, STEP } from './config.js';
import { EVENT_LEVEL, EVENT_OVER, EVENT_WIN } from './world.js';
import { SCREEN_LEVEL, SCREEN_OVER, SCREEN_PLAY, SCREEN_TITLE, SCREEN_VICTORY } from './render.js';

const START_SECONDS = 6;
const PLAY_SECONDS = 45;
const LEVELUP_SECONDS = 150;
const END_LIMIT_SECONDS = 600;
const SAMPLE = 1 / 30;

/**
 * Where the autopilot wants to go: it orbits the nearest foe at bolt range,
 * strafing sideways so the fight stays in the middle of the arena, and
 * drifts toward the nearest shard when the way is clear. Returns a unit
 * move vector.
 */
function autopilotMove(state) {
  const p = state.player;
  let mx = 0;
  let my = 0;
  let nearest = null;
  let nearestD = Infinity;
  for (const e of state.enemies) {
    if (!e.active) continue;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d = dx * dx + dy * dy;
    if (d < nearestD) {
      nearestD = d;
      nearest = e;
    }
  }
  if (nearest && nearestD < 300 * 300) {
    const d = Math.sqrt(nearestD) || 1;
    const awayX = (p.x - nearest.x) / d;
    const awayY = (p.y - nearest.y) / d;
    // Radial: back off when too close, close in when too far; strafe
    // sideways the whole time so the fight keeps moving.
    const radial = d < 170 ? 1 : d > 280 ? -0.7 : 0;
    mx = awayX * radial - awayY * 0.9;
    my = awayY * radial + awayX * 0.9;
  } else {
    let shard = null;
    let shardD = Infinity;
    for (const s of state.shards) {
      if (!s.active) continue;
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      const d = dx * dx + dy * dy;
      if (d < shardD) {
        shardD = d;
        shard = s;
      }
    }
    if (shard) {
      const d = Math.sqrt(shardD) || 1;
      mx = (shard.x - p.x) / d;
      my = (shard.y - p.y) / d;
    } else {
      mx = (FIELD.width / 2 - p.x) / 400;
      my = (FIELD.height / 2 - p.y) / 400;
    }
  }
  // A gentle pull toward the middle keeps the fight on screen.
  mx += (FIELD.width / 2 - p.x) / 900;
  my += (FIELD.height / 2 - p.y) / 900;
  const len = Math.hypot(mx, my) || 1;
  return { x: mx / len, y: my / len };
}

function autopilotDash(state) {
  const p = state.player;
  if (p.dashTimer > 0) return false;
  let close = 0;
  for (const e of state.enemies) {
    if (!e.active) continue;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    if (dx * dx + dy * dy < 110 * 110) close += 1;
  }
  return close >= 3;
}

function stepWorld(world, dt, events) {
  const move = autopilotMove(world.state);
  const dash = autopilotDash(world.state);
  return world.step(dt, move, null, dash, events);
}

/**
 * Set `world` to the named scene and return the screen to draw over it and
 * the best score to show. Unknown names stage the title.
 */
export function stageShot(name, world) {
  world.reset();
  const events = {};
  if (name !== 'play' && name !== 'levelup' && name !== 'end') {
    for (let i = 0; i < START_SECONDS / STEP; i += 1) world.step(STEP, { x: 0, y: 0 }, null, false, events);
    return { screen: SCREEN_TITLE, best: 0 };
  }
  if (name === 'levelup') {
    for (let i = 0; i < LEVELUP_SECONDS / STEP; i += 1) {
      const result = stepWorld(world, STEP, events);
      if (result & EVENT_LEVEL) break;
      if (result & (EVENT_OVER | EVENT_WIN)) break;
    }
    return { screen: world.state.levelChoices ? SCREEN_LEVEL : SCREEN_PLAY, best: world.state.score };
  }
  const limit = name === 'end' ? END_LIMIT_SECONDS : PLAY_SECONDS;
  let ended = false;
  for (let i = 0; i < limit / STEP; i += 1) {
    const result = stepWorld(world, STEP, events);
    if (result & EVENT_LEVEL) {
      // The pilot takes the first card and keeps playing.
      const choice = world.state.levelChoices?.[0];
      if (choice) world.applyUpgrade(choice);
      continue;
    }
    if (result & (EVENT_OVER | EVENT_WIN)) {
      ended = true;
      break;
    }
  }
  if (!ended && name === 'end') {
    // The pilot survived the whole limit: play recklessly (walk into the
    // nearest foe, never dash) until the dark takes it, so the shot still
    // shows a real end screen.
    for (let i = 0; i < 120 / STEP; i += 1) {
      const p = world.state.player;
      let foe = null;
      let foeD = Infinity;
      for (const e of world.state.enemies) {
        if (!e.active) continue;
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const d = dx * dx + dy * dy;
        if (d < foeD) {
          foeD = d;
          foe = e;
        }
      }
      const move = foe
        ? { x: (foe.x - p.x) / (Math.sqrt(foeD) || 1), y: (foe.y - p.y) / (Math.sqrt(foeD) || 1) }
        : { x: 0, y: 0 };
      const result = world.step(STEP, move, null, false, events);
      if (result & EVENT_LEVEL) {
        const choice = world.state.levelChoices?.[0];
        if (choice) world.applyUpgrade(choice);
        continue;
      }
      if (result & (EVENT_OVER | EVENT_WIN)) break;
    }
  }
  const over = world.state.player.hp <= 0;
  const won = world.state.bossDefeated;
  return {
    screen: won ? SCREEN_VICTORY : over ? SCREEN_OVER : SCREEN_PLAY,
    best: world.state.score,
  };
}

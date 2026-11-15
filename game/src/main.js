// Boot and the one loop: input is read every frame, the world advances in
// fixed 1/60 s steps (several in a slow frame, none in a fast one), and the
// renderer paints what is there. The game moves between six screens:
// title, play, level-up, paused, victory and game over.
//
// ?seed=N fixes the spawn pattern. ?shot=start|play|levelup|end (with
// &seed=N) stages that scene instead of running the loop, paints it twice
// and sets window.__shotReady for a screenshot.
import { BEST_KEY, STEP } from './config.js';
import { createRandom } from './random.js';
import { createWorld, EVENT_LEVEL, EVENT_OVER, EVENT_WIN } from './world.js';
import { ACTION_CONFIRM, ACTION_DASH, ACTION_MUTE, ACTION_PAUSE, ACTION_PICK_1, ACTION_PICK_2, ACTION_PICK_3, ACTION_RESTART, createInput } from './input.js';
import { createAudio } from './audio.js';
import { createRenderer, SCREEN_LEVEL, SCREEN_OVER, SCREEN_PAUSED, SCREEN_PLAY, SCREEN_TITLE, SCREEN_VICTORY } from './render.js';
import { stageShot } from './shots.js';

/** The longest frame the loop catches up on; a longer stall is dropped. */
const MAX_FRAME = 0.25;
/** Card hit-boxes, in logical coordinates; must match render.js's layout. */
const CARD = { y: 240, w: 280, h: 240, gap: 32 };

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const status = document.getElementById('status');
const world = createWorld(createRandom(seed));
const renderer = createRenderer(canvas);
const audio = createAudio();

function readBest() {
  try {
    return Number.parseInt(window.localStorage.getItem(BEST_KEY) ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

function saveBest(value) {
  try {
    window.localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // Storage can be off (private windows): the best score then lasts this visit only.
  }
}

function runShot(name) {
  const scene = stageShot(name, world);
  // A read-only handle for the screenshot run (never used by the game).
  window.__emberfall = { screen: scene.screen, state: world.state, world };
  let painted = 0;
  function paint() {
    renderer.draw(world.state, scene.screen, scene.best);
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

function runGame() {
  const input = createInput(canvas);
  let screen = SCREEN_TITLE;
  let best = readBest();
  let accumulator = 0;
  let last = performance.now();
  let dashQueued = false;

  // Screen readers (and anyone watching the page's text) hear the changes.
  function announce(message) {
    status.textContent = message;
  }

  function startGame() {
    world.reset();
    accumulator = 0;
    screen = SCREEN_PLAY;
    audio.unlock();
    announce('Playing. Survive all five waves.');
  }

  function endGame(victory) {
    screen = victory ? SCREEN_VICTORY : SCREEN_OVER;
    if (world.state.score > best) {
      best = world.state.score;
      saveBest(best);
    }
    if (victory) audio.victory();
    else audio.defeat();
    announce(victory ? `Victory! Score ${world.state.score}. Best ${best}.` : `Game over. Score ${world.state.score}. Best ${best}.`);
  }

  function pickCard(index) {
    const choices = world.state.levelChoices;
    if (!choices || index >= choices.length) return;
    world.applyUpgrade(choices[index]);
    audio.levelUp();
    screen = SCREEN_PLAY;
    announce(`Chose ${choices[index].name}.`);
  }

  function cardAt(mouse) {
    const choices = world.state.levelChoices ?? [];
    const total = choices.length * CARD.w + (choices.length - 1) * CARD.gap;
    let x = 640 - total / 2;
    for (let i = 0; i < choices.length; i += 1) {
      if (mouse.x >= x && mouse.x <= x + CARD.w && mouse.y >= CARD.y && mouse.y <= CARD.y + CARD.h) return i;
      x += CARD.w + CARD.gap;
    }
    return -1;
  }

  function handleActions() {
    const actions = input.takeActions();
    if (actions & ACTION_MUTE) {
      const muted = audio.toggleMute();
      announce(muted ? 'Muted.' : 'Sound on.');
    }
    if (actions & ACTION_DASH) dashQueued = true;
    if (actions & ACTION_RESTART && screen !== SCREEN_TITLE) {
      startGame();
      return;
    }
    if (screen === SCREEN_LEVEL) {
      if (actions & ACTION_PICK_1) pickCard(0);
      else if (actions & ACTION_PICK_2) pickCard(1);
      else if (actions & ACTION_PICK_3) pickCard(2);
      else if (input.takeClick()) {
        const index = cardAt(input.mouse());
        if (index >= 0) pickCard(index);
      }
      return;
    }
    if (actions & ACTION_CONFIRM && (screen === SCREEN_TITLE || screen === SCREEN_OVER || screen === SCREEN_VICTORY)) {
      startGame();
    } else if (actions & ACTION_PAUSE && screen === SCREEN_PLAY) {
      screen = SCREEN_PAUSED;
      announce('Paused.');
    } else if (actions & (ACTION_PAUSE | ACTION_CONFIRM) && screen === SCREEN_PAUSED) {
      screen = SCREEN_PLAY;
      announce('Playing.');
    }
    if (actions & ACTION_CONFIRM) audio.unlock();
  }

  function playStep() {
    const events = {};
    const dir = input.direction();
    let fireAngle = null;
    if (input.mouseDown()) {
      const m = input.mouse();
      fireAngle = Math.atan2(m.y - world.state.player.y, m.x - world.state.player.x);
    }
    const result = world.step(STEP, dir, fireAngle, dashQueued, events);
    dashQueued = false;
    if (events.shoot) audio.shoot();
    if (events.pickup) audio.pickup();
    if (events.hurt) audio.hurt();
    if (events.kill) audio.kill();
    if (events.dash) audio.dash();
    if (events.wave) audio.wave();
    if (events.boss) audio.boss();
    if (result & EVENT_WIN) endGame(true);
    else if (result & EVENT_OVER) endGame(false);
    else if (result & EVENT_LEVEL) {
      screen = SCREEN_LEVEL;
      audio.levelUp();
      announce('Level up! Choose a boon.');
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    accumulator += Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    handleActions();
    if (screen === SCREEN_TITLE) {
      const events = {};
      while (accumulator >= STEP) {
        world.step(STEP, { x: 0, y: 0 }, null, false, events);
        accumulator -= STEP;
      }
    } else if (screen === SCREEN_PLAY) {
      while (accumulator >= STEP && screen === SCREEN_PLAY) {
        playStep();
        accumulator -= STEP;
      }
    } else {
      accumulator = 0;
    }
    renderer.draw(world.state, screen, best);
  }

  // Leaving the tab pauses a running game rather than letting the dark close in unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === SCREEN_PLAY) {
      screen = SCREEN_PAUSED;
      announce('Paused.');
    }
  });

  announce('Emberfall. Press Space or click to start.');
  // A read-only handle for automated playtests (never used by the game).
  window.__emberfall = {
    get screen() {
      return screen;
    },
    get best() {
      return best;
    },
    state: world.state,
    world,
  };
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();

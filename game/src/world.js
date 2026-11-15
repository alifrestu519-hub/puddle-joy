// The arena itself: player, enemies, bolts, shards, particles and waves.
// The world advances in fixed 1/60 s steps and reports events as a bitmask,
// so the loop, the screenshots and the autopilot all share one simulation.
import { BOSS, ENEMY, FIELD, LEVEL_XP, PLAYER, POOL, SPAWN, WAVE_QUOTA, WAVE_REST, WAVES } from './config.js';
import { rollUpgrades } from './upgrades.js';

export const EVENT_HIT = 1;
export const EVENT_OVER = 2;
export const EVENT_LEVEL = 4;
export const EVENT_WAVE = 8;
export const EVENT_WIN = 16;
export const EVENT_KILL = 32;

const TAU = Math.PI * 2;

function makePool(size, make) {
  const items = [];
  for (let i = 0; i < size; i += 1) items.push(make());
  return items;
}

export function createWorld(random) {
  const state = {
    time: 0,
    wave: 1,
    waveKills: 0,
    waveState: 'fight', // fight | rest | boss
    restTimer: 0,
    spawnTimer: 0,
    kills: 0,
    score: 0,
    level: 1,
    xp: 0,
    xpNext: LEVEL_XP[0],
    shake: 0,
    flash: 0,
    boss: null,
    bossSpawned: false,
    levelChoices: null,
    taken: {},
    player: null,
    enemies: makePool(POOL.enemies, () => ({ active: false })),
    bolts: makePool(POOL.bolts, () => ({ active: false })),
    shards: makePool(POOL.shards, () => ({ active: false })),
    particles: makePool(POOL.particles, () => ({ active: false })),
    texts: makePool(POOL.texts, () => ({ active: false })),
    stars: [],
  };

  for (let i = 0; i < 90; i += 1) {
    state.stars.push({
      x: random.range(0, FIELD.width),
      y: random.range(0, FIELD.height),
      r: random.range(0.6, 2.2),
      twinkle: random.range(0, TAU),
      speed: random.range(0.4, 1.6),
    });
  }

  function spawnParticle(x, y, colour, count, speed, life, size) {
    let made = 0;
    for (let i = 0; i < state.particles.length && made < count; i += 1) {
      const p = state.particles[i];
      if (p.active) continue;
      const a = random.angle();
      const v = random.range(speed * 0.3, speed);
      p.active = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.life = random.range(life * 0.5, life);
      p.maxLife = p.life;
      p.size = random.range(size * 0.6, size * 1.4);
      p.colour = colour;
      made += 1;
    }
  }

  function floatText(x, y, text, colour, size = 14) {
    for (let i = 0; i < state.texts.length; i += 1) {
      const t = state.texts[i];
      if (t.active) continue;
      t.active = true;
      t.x = x;
      t.y = y;
      t.text = text;
      t.colour = colour;
      t.size = size;
      t.life = 0.9;
      return;
    }
  }

  function free(list) {
    for (let i = 0; i < list.length; i += 1) if (!list[i].active) return list[i];
    return null;
  }

  function spawnEnemy(kind, x, y) {
    const def = ENEMY[kind];
    const e = free(state.enemies);
    if (!e) return null;
    const waveScale = 1 + (state.wave - 1) * 0.14;
    e.active = true;
    e.kind = kind;
    e.x = x;
    e.y = y;
    e.hp = def.hp * waveScale;
    e.maxHp = e.hp;
    e.speed = def.speed * random.range(0.9, 1.1);
    e.radius = def.radius;
    e.damage = def.damage;
    e.xp = def.xp;
    e.score = def.score;
    e.colour = def.colour;
    e.hitFlash = 0;
    e.slowUntil = 0;
    e.shootTimer = random.range(1, 2);
    e.chargeTimer = BOSS.chargeEvery;
    e.charging = 0;
    e.chargeDir = { x: 0, y: 0 };
    e.moteTimer = BOSS.spawnMotesEvery;
    e.wobble = random.range(0, TAU);
    return e;
  }

  function spawnAtEdge(kind) {
    const side = random.int(0, 3);
    const m = FIELD.margin;
    let x;
    let y;
    if (side === 0) { x = random.range(m, FIELD.width - m); y = -30; }
    else if (side === 1) { x = random.range(m, FIELD.width - m); y = FIELD.height + 30; }
    else if (side === 2) { x = -30; y = random.range(m, FIELD.height - m); }
    else { x = FIELD.width + 30; y = random.range(m, FIELD.height - m); }
    return spawnEnemy(kind, x, y);
  }

  function pickKind() {
    const wave = state.wave;
    const roll = random.next();
    if (wave >= 5) {
      if (roll < 0.3) return 'cinder';
      if (roll < 0.5) return 'spark';
      if (roll < 0.66) return 'gloom';
      if (roll < 0.82) return 'mote';
      return 'spitter';
    }
    if (wave >= 4) {
      if (roll < 0.34) return 'cinder';
      if (roll < 0.56) return 'spark';
      if (roll < 0.72) return 'gloom';
      if (roll < 0.88) return 'mote';
      return 'spitter';
    }
    if (wave >= 3) {
      if (roll < 0.4) return 'cinder';
      if (roll < 0.62) return 'spark';
      if (roll < 0.8) return 'gloom';
      return 'mote';
    }
    if (wave >= 2) {
      if (roll < 0.5) return 'cinder';
      if (roll < 0.78) return 'spark';
      return 'gloom';
    }
    return roll < 0.7 ? 'cinder' : 'spark';
  }

  function dropShard(x, y, value) {
    const s = free(state.shards);
    if (!s) return;
    s.active = true;
    s.x = x;
    s.y = y;
    s.vx = random.range(-50, 50);
    s.vy = random.range(-50, 50);
    s.value = value;
    s.life = 14;
    s.magnet = false;
  }

  function killEnemy(e, awardXp) {
    e.active = false;
    state.kills += 1;
    state.waveKills += 1;
    state.score += e.score;
    spawnParticle(e.x, e.y, e.colour, e.kind === 'boss' ? 60 : 12, 190, 0.6, 4);
    spawnParticle(e.x, e.y, '#ffd97a', 6, 120, 0.5, 3);
    if (e.kind === 'mote') {
      spawnEnemy('spark', e.x - 14, e.y);
      spawnEnemy('spark', e.x + 14, e.y);
    }
    if (e.kind === 'boss') {
      state.boss = null;
      state.bossDefeated = true;
      floatText(e.x, e.y - 30, 'THE ASHEN MAW FALLS!', '#ffd97a', 26);
      return;
    }
    if (awardXp) {
      for (let i = 0; i < e.xp; i += 1) dropShard(e.x + random.range(-12, 12), e.y + random.range(-12, 12), 1);
    }
  }

  function hurtPlayer(damage, fromX, fromY) {
    const p = state.player;
    if (p.invulnerable > 0 || p.dashTime > 0) return 0;
    p.hp -= damage;
    p.invulnerable = PLAYER.hurtInvulnerable;
    state.flash = 0.35;
    state.shake = 10;
    const dx = p.x - fromX;
    const dy = p.y - fromY;
    const d = Math.hypot(dx, dy) || 1;
    p.x += (dx / d) * 18;
    p.y += (dy / d) * 18;
    spawnParticle(p.x, p.y, '#ff5d73', 10, 160, 0.5, 4);
    floatText(p.x, p.y - 26, `-${damage}`, '#ff5d73', 16);
    if (p.hp <= 0) {
      p.hp = 0;
      return EVENT_OVER;
    }
    return EVENT_HIT;
  }

  function fireBolt(angle, damage, pierce) {
    const p = state.player;
    const b = free(state.bolts);
    if (!b) return;
    b.active = true;
    b.x = p.x + Math.cos(angle) * (p.radius + 6);
    b.y = p.y + Math.sin(angle) * (p.radius + 6);
    b.vx = Math.cos(angle) * PLAYER.boltSpeed;
    b.vy = Math.sin(angle) * PLAYER.boltSpeed;
    b.damage = damage;
    b.radius = PLAYER.boltRadius;
    b.pierce = pierce;
    b.enemy = false;
    b.life = 1.4;
    spawnParticle(b.x, b.y, '#ffcf5c', 2, 40, 0.25, 3);
  }

  function fireVolley(angle) {
    const p = state.player;
    const n = p.projectiles;
    const spread = 0.16;
    for (let i = 0; i < n; i += 1) {
      const offset = n === 1 ? 0 : (i - (n - 1) / 2) * spread;
      fireBolt(angle + offset, p.boltDamage, p.pierce);
    }
  }

  function nearestEnemy(x, y, maxDist) {
    let best = null;
    let bestD = maxDist * maxDist;
    for (let i = 0; i < state.enemies.length; i += 1) {
      const e = state.enemies[i];
      if (!e.active) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  function resetPlayer() {
    state.player = {
      x: FIELD.width / 2,
      y: FIELD.height / 2,
      radius: PLAYER.radius,
      hp: PLAYER.maxHp,
      maxHp: PLAYER.maxHp,
      speed: PLAYER.speed,
      fireInterval: PLAYER.fireInterval,
      boltDamage: PLAYER.boltDamage,
      projectiles: 1,
      pierce: 0,
      pickupRadius: PLAYER.pickupRadius,
      dashCooldown: PLAYER.dashCooldown,
      dashDamage: 0,
      fireTimer: 0,
      dashTimer: 0,
      dashTime: 0,
      dashDir: { x: 1, y: 0 },
      invulnerable: 0,
      aim: -Math.PI / 2,
      walkPhase: 0,
      moving: false,
    };
  }

  function reset() {
    state.time = 0;
    state.wave = 1;
    state.waveKills = 0;
    state.waveState = 'fight';
    state.restTimer = 0;
    state.spawnTimer = 0.8;
    state.kills = 0;
    state.score = 0;
    state.level = 1;
    state.xp = 0;
    state.xpNext = LEVEL_XP[0];
    state.shake = 0;
    state.flash = 0;
    state.boss = null;
    state.bossSpawned = false;
    state.bossDefeated = false;
    state.levelChoices = null;
    state.taken = {};
    for (const list of [state.enemies, state.bolts, state.shards, state.particles, state.texts]) {
      for (const item of list) item.active = false;
    }
    resetPlayer();
  }

  function gainXp(amount) {
    state.xp += amount;
    if (state.xp < state.xpNext) return false;
    state.xp -= state.xpNext;
    state.level += 1;
    state.xpNext = LEVEL_XP[Math.min(state.level - 1, LEVEL_XP.length - 1)];
    state.levelChoices = rollUpgrades(random, state.taken);
    spawnParticle(state.player.x, state.player.y, '#8be9c9', 26, 220, 0.8, 4);
    floatText(state.player.x, state.player.y - 34, 'LEVEL UP!', '#8be9c9', 22);
    return true;
  }

  function applyUpgrade(upgrade) {
    upgrade.apply(state.player);
    state.taken[upgrade.id] = (state.taken[upgrade.id] ?? 0) + 1;
    state.levelChoices = null;
  }

  function startWave(wave) {
    state.wave = wave;
    state.waveKills = 0;
    state.waveState = 'fight';
    state.spawnTimer = 0.6;
    state.bossSpawned = false;
    if (wave === WAVES) {
      const boss = spawnAtEdge('boss');
      state.boss = boss;
      state.bossSpawned = true;
    }
  }

  function step(dt, move, fireAngle, dash, events) {
    const p = state.player;
    state.time += dt;
    state.shake = Math.max(0, state.shake - dt * 26);
    state.flash = Math.max(0, state.flash - dt);
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    p.dashTimer = Math.max(0, p.dashTimer - dt);

    // --- player movement and dash ---
    const len = Math.hypot(move.x, move.y);
    p.moving = len > 0;
    if (p.moving) {
      p.walkPhase += dt * 11;
      const nx = move.x / (len || 1);
      const ny = move.y / (len || 1);
      p.x += nx * p.speed * dt;
      p.y += ny * p.speed * dt;
      if (dash && p.dashTimer <= 0) {
        p.dashTime = PLAYER.dashTime;
        p.dashTimer = p.dashCooldown;
        p.dashDir = { x: nx, y: ny };
        p.invulnerable = Math.max(p.invulnerable, PLAYER.dashInvulnerable);
        spawnParticle(p.x, p.y, '#8be9c9', 10, 140, 0.4, 3);
        events.dash = true;
      }
    }
    if (p.dashTime > 0) {
      p.dashTime -= dt;
      p.x += p.dashDir.x * PLAYER.dashSpeed * dt;
      p.y += p.dashDir.y * PLAYER.dashSpeed * dt;
      spawnParticle(p.x, p.y, '#ffd97a', 2, 30, 0.3, 3);
      // Dashing through foes burns them.
      if (p.dashDamage > 0) {
        for (const e of state.enemies) {
          if (!e.active) continue;
          const dx = e.x - p.x;
          const dy = e.y - p.y;
          if (dx * dx + dy * dy < (e.radius + p.radius + 8) ** 2) {
            e.hp -= p.dashDamage;
            e.hitFlash = 0.12;
            if (e.hp <= 0) killEnemy(e, true);
          }
        }
      }
    }
    p.x = Math.min(FIELD.width - FIELD.margin, Math.max(FIELD.margin, p.x));
    p.y = Math.min(FIELD.height - FIELD.margin, Math.max(FIELD.margin, p.y));

    // --- aiming and auto-fire ---
    if (fireAngle !== null) p.aim = fireAngle;
    p.fireTimer -= dt;
    const target = nearestEnemy(p.x, p.y, 520);
    if (target) p.aim = Math.atan2(target.y - p.y, target.x - p.x);
    if (p.fireTimer <= 0 && target) {
      p.fireTimer = p.fireInterval;
      fireVolley(p.aim);
      events.shoot = true;
    }

    // --- spawning ---
    const quota = WAVE_QUOTA[state.wave - 1];
    if (state.waveState === 'fight') {
      state.spawnTimer -= dt;
      const interval = Math.max(SPAWN.min, SPAWN.base - state.waveKills * SPAWN.shrinkPerKill);
      if (state.spawnTimer <= 0 && state.waveKills + aliveCount() < quota + 12) {
        state.spawnTimer = interval;
        spawnAtEdge(pickKind());
      }
      if (state.waveKills >= quota && state.wave !== WAVES) {
        state.waveState = 'rest';
        state.restTimer = WAVE_REST;
        events.wave = true;
      } else if (state.waveKills >= quota && state.wave === WAVES && state.bossDefeated) {
        return EVENT_WIN;
      }
    } else if (state.waveState === 'rest') {
      state.restTimer -= dt;
      if (state.restTimer <= 0) {
        startWave(state.wave + 1);
        events.wave = true;
      }
    }

    // --- bolts ---
    for (const b of state.bolts) {
      if (!b.active) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0 || b.x < -20 || b.x > FIELD.width + 20 || b.y < -20 || b.y > FIELD.height + 20) {
        b.active = false;
        continue;
      }
      if (b.enemy) continue; // Enemy globs are checked against the player below.
      for (const e of state.enemies) {
        if (!e.active) continue;
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        const rr = e.radius + b.radius;
        if (dx * dx + dy * dy < rr * rr) {
          e.hp -= b.damage;
          e.hitFlash = 0.12;
          spawnParticle(b.x, b.y, '#ffcf5c', 4, 120, 0.3, 3);
          floatText(e.x, e.y - e.radius - 6, String(Math.round(b.damage)), '#ffe9a8', 13);
          events.hit = true;
          if (e.hp <= 0) {
            killEnemy(e, true);
            events.kill = true;
          }
          if (b.pierce > 0) {
            b.pierce -= 1;
          } else {
            b.active = false;
          }
          break;
        }
      }
    }

    // --- enemies ---
    for (const e of state.enemies) {
      if (!e.active) continue;
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.wobble += dt * 3;
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const slow = state.time < e.slowUntil ? 0.6 : 1;
      let vx = (dx / dist) * e.speed * slow;
      let vy = (dy / dist) * e.speed * slow;

      if (e.kind === 'spitter') {
        // Keep a shooting distance, then lob globs.
        const want = 260;
        const dir = dist < want ? -1 : 1;
        vx = (dx / dist) * e.speed * slow * dir * 0.7;
        vy = (dy / dist) * e.speed * slow * dir * 0.7;
        e.shootTimer -= dt;
        if (e.shootTimer <= 0 && dist < 480) {
          e.shootTimer = random.range(1.8, 2.6);
          const g = free(state.bolts);
          if (g) {
            // Enemy globs reuse the bolt pool with a negative flag via damage sign.
            g.active = true;
            g.x = e.x;
            g.y = e.y;
            g.vx = (dx / dist) * 190;
            g.vy = (dy / dist) * 190;
            g.damage = -e.damage;
            g.radius = 8;
            g.pierce = 0;
            g.life = 3;
            g.enemy = true;
          }
        }
      }

      if (e.kind === 'boss') {
        e.moteTimer -= dt;
        if (e.moteTimer <= 0) {
          e.moteTimer = BOSS.spawnMotesEvery;
          spawnEnemy('mote', e.x - 40, e.y);
          spawnEnemy('mote', e.x + 40, e.y);
          events.boss = true;
        }
        e.chargeTimer -= dt;
        if (e.charging > 0) {
          e.charging -= dt;
          vx = e.chargeDir.x * BOSS.chargeSpeed;
          vy = e.chargeDir.y * BOSS.chargeSpeed;
        } else if (e.chargeTimer <= 0) {
          e.chargeTimer = BOSS.chargeEvery;
          e.charging = BOSS.chargeTime;
          e.chargeDir = { x: dx / dist, y: dy / dist };
          events.boss = true;
        }
      }

      e.x += vx * dt;
      e.y += vy * dt;

      // Touch damage.
      const rr = e.radius + p.radius - 2;
      if (dx * dx + dy * dy < rr * rr) {
        const result = hurtPlayer(e.damage, e.x, e.y);
        if (result & EVENT_OVER) return EVENT_OVER;
        if (result & EVENT_HIT) events.hurt = true;
        // Push the enemy back a little so one touch is one hit.
        e.x -= (dx / dist) * 26;
        e.y -= (dy / dist) * 26;
      }
    }

    // --- enemy globs vs player ---
    for (const b of state.bolts) {
      if (!b.active || !b.enemy) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      const rr = p.radius + b.radius;
      if (dx * dx + dy * dy < rr * rr) {
        b.active = false;
        const result = hurtPlayer(-b.damage, b.x - b.vx, b.y - b.vy);
        if (result & EVENT_OVER) return EVENT_OVER;
        if (result & EVENT_HIT) events.hurt = true;
      }
    }

    // --- shards ---
    for (const s of state.shards) {
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.92;
      s.vy *= 0.92;
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < p.pickupRadius) s.magnet = true;
      if (s.magnet) {
        s.x += (dx / dist) * 420 * dt;
        s.y += (dy / dist) * 420 * dt;
      }
      if (dist < p.radius + 10) {
        s.active = false;
        events.pickup = true;
        if (gainXp(s.value)) return EVENT_LEVEL;
      }
    }

    // --- particles and floating text ---
    for (const pt of state.particles) {
      if (!pt.active) continue;
      pt.life -= dt;
      if (pt.life <= 0) {
        pt.active = false;
        continue;
      }
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.94;
      pt.vy *= 0.94;
    }
    for (const t of state.texts) {
      if (!t.active) continue;
      t.life -= dt;
      t.y -= 34 * dt;
      if (t.life <= 0) t.active = false;
    }

    return 0;
  }

  function aliveCount() {
    let n = 0;
    for (const e of state.enemies) if (e.active) n += 1;
    return n;
  }

  reset();

  return {
    state,
    reset,
    applyUpgrade,
    startWave,
    /** Advance one fixed step. `events` is filled with what happened. */
    step,
    aliveCount,
  };
}

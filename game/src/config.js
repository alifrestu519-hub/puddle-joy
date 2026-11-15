// Emberfall — every tuning number and colour in one place.
// The arena is a fixed 1280x720 logical field; the renderer scales it to
// the window, so no rule below depends on the screen size.
export const FIELD = { width: 1280, height: 720, margin: 28 };

/** The simulation's fixed step, in seconds: 60 updates a second. */
export const STEP = 1 / 60;

/** Survive all five waves and fell the Ashen Maw to win. */
export const WAVES = 5;

export const PLAYER = {
  radius: 16,
  speed: 265,
  maxHp: 100,
  fireInterval: 0.42,
  boltSpeed: 620,
  boltDamage: 12,
  boltRadius: 5,
  pickupRadius: 70,
  dashSpeed: 780,
  dashTime: 0.16,
  dashCooldown: 2.4,
  dashInvulnerable: 0.35,
  hurtInvulnerable: 0.7,
};

export const ENEMY = {
  cinder: { hp: 22, speed: 102, radius: 15, damage: 10, xp: 1, score: 10, colour: '#e5534b' },
  spark: { hp: 12, speed: 178, radius: 11, damage: 7, xp: 1, score: 15, colour: '#f2a541' },
  gloom: { hp: 70, speed: 58, radius: 24, damage: 16, xp: 3, score: 30, colour: '#9b7ede' },
  mote: { hp: 16, speed: 132, radius: 12, damage: 8, xp: 1, score: 15, colour: '#7ed6a5' },
  spitter: { hp: 26, speed: 78, radius: 14, damage: 9, xp: 2, score: 25, colour: '#4fc3f7' },
  boss: { hp: 800, speed: 66, radius: 46, damage: 24, xp: 25, score: 500, colour: '#ff5d73' },
};

/** Kills needed to clear each wave (index 0 = wave 1). */
export const WAVE_QUOTA = [14, 20, 26, 32, 10];
/** Seconds of calm between waves. */
export const WAVE_REST = 3.5;
/** Spawn interval per wave, seconds; it shrinks as the wave goes on. */
export const SPAWN = { base: 0.9, min: 0.24, shrinkPerKill: 0.016 };

/** XP needed to reach each level (index 0 = level 1 -> 2). */
export const LEVEL_XP = [6, 14, 26, 42, 62, 86, 114, 146, 182, 222];

export const BOSS = { spawnMotesEvery: 6, chargeEvery: 9, chargeSpeed: 340, chargeTime: 0.7 };

export const PALETTE = {
  backdrop: '#0b0e1d',
  backdropEdge: '#070912',
  ground: '#12162b',
  groundDot: '#1b2140',
  player: '#f5b942',
  playerCore: '#fff3c4',
  lantern: '#ffd97a',
  bolt: '#ffcf5c',
  shard: '#8be9c9',
  text: '#f2ead8',
  muted: '#9aa3c0',
  panel: 'rgba(16, 20, 40, 0.88)',
  panelEdge: '#3a4470',
  hp: '#ff5d73',
  hpBack: '#2a2130',
  xp: '#8be9c9',
  danger: '#ff5d73',
  card: '#1a2040',
  cardEdge: '#f5b942',
};

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Where the best score is kept between visits (this browser only). */
export const BEST_KEY = 'emberfall.best';

/** How many entities can exist at once; pools are allocated once, at boot. */
export const POOL = { enemies: 90, bolts: 160, shards: 220, particles: 420, texts: 48 };

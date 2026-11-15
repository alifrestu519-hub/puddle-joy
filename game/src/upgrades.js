// The level-up choices: eight upgrades, each with a short name, a line of
// flavour and the effect it applies to the player. A card can be taken at
// most three times; the roll never offers a maxed-out upgrade.
export const UPGRADES = [
  {
    id: 'split',
    name: 'Ember Split',
    icon: '✦',
    text: '+1 ember bolt per volley',
    max: 3,
    apply(p) {
      p.projectiles += 1;
    },
  },
  {
    id: 'rapid',
    name: 'Rapid Wick',
    icon: '≫',
    text: 'Lantern fires 18% faster',
    max: 4,
    apply(p) {
      p.fireInterval *= 0.82;
    },
  },
  {
    id: 'heavy',
    name: 'Heavy Ember',
    icon: '●',
    text: 'Bolts deal 30% more damage',
    max: 4,
    apply(p) {
      p.boltDamage *= 1.3;
    },
  },
  {
    id: 'boots',
    name: 'Swift Boots',
    icon: '»',
    text: 'Move 12% faster',
    max: 4,
    apply(p) {
      p.speed *= 1.12;
    },
  },
  {
    id: 'magnet',
    name: 'Magnet Glow',
    icon: '◎',
    text: 'Ember shards fly to you from 45% farther',
    max: 3,
    apply(p) {
      p.pickupRadius *= 1.45;
    },
  },
  {
    id: 'heart',
    name: 'Lantern Heart',
    icon: '♥',
    text: '+25 max health and mend 25 now',
    max: 4,
    apply(p) {
      p.maxHp += 25;
      p.hp = Math.min(p.maxHp, p.hp + 25);
    },
  },
  {
    id: 'dash',
    name: 'Dash Charm',
    icon: '↯',
    text: 'Dash recharges 30% faster, dashing burns foes',
    max: 3,
    apply(p) {
      p.dashCooldown *= 0.7;
      p.dashDamage += 12;
    },
  },
  {
    id: 'pierce',
    name: 'Piercing Flame',
    icon: '→',
    text: 'Bolts pierce through +1 foe',
    max: 3,
    apply(p) {
      p.pierce += 1;
    },
  },
];

/** Roll three distinct upgrades the player has not maxed out yet. */
export function rollUpgrades(random, taken) {
  const available = UPGRADES.filter((u) => (taken[u.id] ?? 0) < u.max);
  const picks = [];
  while (picks.length < 3 && available.length > 0) {
    const index = Math.floor(random.next() * available.length);
    picks.push(available.splice(index, 1)[0]);
  }
  return picks;
}

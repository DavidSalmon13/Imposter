'use strict';

// Warfront engine, layer 2: static data tables. Races, units (stats, RPS classes), terrain,
// facilities, weapons, events, phrases, map sizes and match lengths, plus pure lookups on them.
// Must NOT contain: anything that reads or mutates battle state.
// Spec: "Races", "Units", "Terrain", "Facilities", "Special weapons", "Battlefield events".

const { WF_MATCH_CAP_MS, WF_EVENT_MS, TUNING } = require('./constants');

// ---------------------------------------------------------------------------
// Races & units
// ---------------------------------------------------------------------------
const RACES = Object.freeze({
  forge: {
    id: 'forge',
    name: 'Forge',
    specialty: 'Defense + economy: Workers earn bonus Supply, structures cost 1 Mineral less, only Forge fields the Bastion.',
    workerType: 'laborer',
    airdropUnit: 'militiaman',
  },
  horde: {
    id: 'horde',
    name: 'Horde',
    specialty: 'Raw combat: ×1.15 attack and a narrower luck swing.',
    workerType: 'peon',
    airdropUnit: 'warrior',
  },
  arcane: {
    id: 'arcane',
    name: 'Arcane',
    specialty: 'Area magic + luck manipulation: fragile, expensive, high-impact.',
    workerType: 'acolyte',
    airdropUnit: 'apprentice',
  },
});

// Combat classes. The RPS triangle is melee > mounted > ranged > melee; the
// other four sit outside it (flat ×1).
const RPS_CLASSES = Object.freeze(['melee', 'mounted', 'ranged']);
const UNIT_CLASSES = Object.freeze([...RPS_CLASSES, 'worker', 'siege', 'caster', 'structure']);
const RPS_BEATS = Object.freeze({ melee: 'mounted', mounted: 'ranged', ranged: 'melee' });

// Flags: 'aoe' (Battlemage), 'luckBend' (Archmage), 'summonsGolem' (Summoner),
// 'summoned' (Golem: never produced directly). Siege/structure behaviour comes
// from `class`. `attackMs` defaults to TUNING.attackMs.
function unit(id, name, race, cls, hp, atk, supply, minerals, move, range, flags = []) {
  return Object.freeze({
    id,
    name,
    race,
    class: cls,
    hp,
    atk,
    supply,
    minerals,
    move,
    range,
    attackMs: TUNING.attackMs,
    basic: minerals === 0,
    producible: !flags.includes('summoned'),
    flags: Object.freeze(flags),
  });
}

const UNIT_TYPES = Object.freeze({
  // Workers (same stats, race flavour name)
  laborer: unit('laborer', 'Laborer', 'forge', 'worker', 10, 1, 3, 0, 1, 1),
  peon: unit('peon', 'Peon', 'horde', 'worker', 10, 1, 3, 0, 1, 1),
  acolyte: unit('acolyte', 'Acolyte', 'arcane', 'worker', 10, 1, 3, 0, 1, 1),
  // Forge
  militiaman: unit('militiaman', 'Militiaman', 'forge', 'melee', 22, 4, 3, 0, 1, 1),
  crossbow: unit('crossbow', 'Crossbow', 'forge', 'ranged', 14, 5, 4, 0, 1, 2),
  outrider: unit('outrider', 'Outrider', 'forge', 'mounted', 16, 4, 5, 2, 2, 1),
  bastion: unit('bastion', 'Bastion', 'forge', 'structure', 40, 3, 6, 3, 0, 0),
  ballista: unit('ballista', 'Ballista', 'forge', 'siege', 16, 4, 6, 4, 1, 2),
  // Horde
  warrior: unit('warrior', 'Warrior', 'horde', 'melee', 22, 5, 3, 0, 1, 1),
  skirmisher: unit('skirmisher', 'Skirmisher', 'horde', 'ranged', 14, 5, 4, 0, 1, 2),
  raider: unit('raider', 'Raider', 'horde', 'mounted', 18, 4, 5, 2, 3, 1),
  berserker: unit('berserker', 'Berserker', 'horde', 'melee', 12, 9, 5, 2, 1, 1),
  warchief: unit('warchief', 'Warchief', 'horde', 'melee', 32, 7, 8, 5, 1, 1),
  // Arcane
  apprentice: unit('apprentice', 'Apprentice', 'arcane', 'caster', 12, 4, 3, 0, 1, 2),
  mysticArcher: unit('mysticArcher', 'Mystic Archer', 'arcane', 'ranged', 12, 5, 4, 0, 1, 2),
  battlemage: unit('battlemage', 'Battlemage', 'arcane', 'caster', 16, 6, 6, 3, 1, 1, ['aoe']),
  summoner: unit('summoner', 'Summoner', 'arcane', 'caster', 14, 3, 6, 4, 1, 2, ['summonsGolem']),
  archmage: unit('archmage', 'Archmage', 'arcane', 'caster', 20, 7, 9, 6, 1, 2, ['luckBend']),
  golem: unit('golem', 'Golem', 'arcane', 'structure', 36, 5, 0, 0, 0, 1, ['summoned']),
});

/** Unit type ids a player of `race` may produce (summoned units excluded). */
function producibleTypes(race) {
  return Object.values(UNIT_TYPES)
    .filter((u) => u.race === race && u.producible)
    .map((u) => u.id);
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
const TERRAIN_TYPES = Object.freeze({
  plains: Object.freeze({ id: 'plains', passable: true, defense: 1.0, moveCost: 1 }),
  forest: Object.freeze({ id: 'forest', passable: true, defense: 1.25, moveCost: 2 }),
  hills: Object.freeze({ id: 'hills', passable: true, defense: 1.45, moveCost: 2 }),
  water: Object.freeze({ id: 'water', passable: false, defense: null, moveCost: null }),
  rock: Object.freeze({ id: 'rock', passable: false, defense: null, moveCost: null }),
});

// ---------------------------------------------------------------------------
// Facilities & towers (all 💎 Minerals; Forge pays forgeStructureDiscount less)
// ---------------------------------------------------------------------------
const FACILITIES = Object.freeze({
  refinery: Object.freeze({ id: 'refinery', name: 'Refinery', minerals: 5, hp: 15, buildMs: 8000, needsVein: true }),
  barracks: Object.freeze({ id: 'barracks', name: 'Forward Barracks', minerals: 7, hp: 20, buildMs: 10000, spawnPoint: true }),
  workshop: Object.freeze({ id: 'workshop', name: 'Workshop', minerals: 7, hp: 15, buildMs: 10000, buildsWeapons: true }),
  tower: Object.freeze({
    id: 'tower', name: 'Tower', minerals: 4, hp: 18, buildMs: 6000, atk: 3, range: 1, attackMs: TUNING.attackMs,
  }),
});

// Facilities and towers stand on the field as `structure` units (spec "Server state":
// facilities are mirrored as structure units for combat). Their unit-like stats:
// no race, can't move, and only the Tower attacks.
const FACILITY_UNITS = Object.freeze(Object.fromEntries(Object.values(FACILITIES).map((f) => [f.id, Object.freeze({
  id: f.id,
  name: f.name,
  race: null,
  class: 'structure',
  hp: f.hp,
  atk: f.atk || 0,
  supply: 0,
  minerals: f.minerals,
  move: 0,
  range: f.range || 0,
  attackMs: f.attackMs || TUNING.attackMs,
  basic: false,
  producible: false,
  flags: Object.freeze(['facility']),
})])));

/** Stats of anything that stands on the field: a unit type or a facility/tower. */
function unitStats(type) {
  return UNIT_TYPES[type] || FACILITY_UNITS[type];
}

/** 💎 a player of `race` pays for a facility or tower (Forge pays forgeStructureDiscount less). */
function facilityCost(race, facility) {
  const f = FACILITIES[facility];
  const discount = race === 'forge' ? TUNING.forgeStructureDiscount : 0;
  return Math.max(0, f.minerals - discount);
}

// ---------------------------------------------------------------------------
// Special weapons, battlefield events, team phrases (closed menus)
// ---------------------------------------------------------------------------
// `target` says what the tapped tile must be (enforced in Step 10).
const WEAPON_EFFECTS = Object.freeze({
  artillery: Object.freeze({ id: 'artillery', name: 'Artillery', target: 'anyTile' }),
  emp: Object.freeze({ id: 'emp', name: 'EMP', target: 'enemyStructure' }),
  airdrop: Object.freeze({ id: 'airdrop', name: 'Airdrop', target: 'friendlyVisiblePassable' }),
  bombard: Object.freeze({ id: 'bombard', name: 'Bombard', target: 'enemyBase' }),
  aegis: Object.freeze({ id: 'aegis', name: 'Aegis', target: 'ownBase' }),
});

// `durationMs` 0 = instant (or no effect). `title`/`text` are the generic
// fallback flavor used until (or instead of) the AI flavor.
const EVENT_EFFECTS = Object.freeze({
  supplyDrop: Object.freeze({ id: 'supplyDrop', durationMs: 0, title: 'Supply Drop', text: 'Every commander receives fresh Supply.' }),
  mineralRush: Object.freeze({ id: 'mineralRush', durationMs: WF_EVENT_MS, title: 'Mineral Rush', text: 'Every vein yields double while it lasts.' }),
  sandstorm: Object.freeze({ id: 'sandstorm', durationMs: WF_EVENT_MS, title: 'Sandstorm', text: 'Blinding winds make every blow a gamble.' }),
  reinforcements: Object.freeze({ id: 'reinforcements', durationMs: 0, title: 'Reinforcements', text: 'A fresh Worker arrives at each base.' }),
  calm: Object.freeze({ id: 'calm', durationMs: 0, title: 'Calm', text: 'An uneasy quiet settles over the field.' }),
});

// Preset phrases for the private team channel (ids match the mockup's buttons).
const TEAM_PHRASES = Object.freeze({
  push: 'Push!',
  defend: 'Defend base',
  needResources: 'Need resources',
  hitBase: 'Hit their base',
});

// ---------------------------------------------------------------------------
// Host options
// ---------------------------------------------------------------------------
const MAP_SIZES = Object.freeze({
  small: Object.freeze({ id: 'small', label: 'Small', width: 12, height: 8 }),
  medium: Object.freeze({ id: 'medium', label: 'Medium', width: 16, height: 11 }),
  large: Object.freeze({ id: 'large', label: 'Large', width: 20, height: 13 }),
});
const DEFAULT_MAP_SIZE = 'medium';

const MATCH_LENGTHS = Object.freeze({
  short: Object.freeze({ id: 'short', label: '8 min', ms: 8 * 60000 }),
  standard: Object.freeze({ id: 'standard', label: '12 min', ms: WF_MATCH_CAP_MS }),
  long: Object.freeze({ id: 'long', label: '16 min', ms: 16 * 60000 }),
});
const DEFAULT_MATCH_LENGTH = 'standard';

// ---------------------------------------------------------------------------
// Rock-paper-scissors
// ---------------------------------------------------------------------------
function classOf(classOrType) {
  if (UNIT_TYPES[classOrType]) return UNIT_TYPES[classOrType].class;
  return classOrType;
}

/**
 * Attack multiplier for an attacker hitting a defender, by combat class (or unit
 * type id). ×1.5 when the attacker's class beats the defender's, ×0.67 when it's
 * beaten, ×1 otherwise (same class, or either side outside the triangle).
 */
function rpsMultiplier(attacker, defender) {
  const a = classOf(attacker);
  const d = classOf(defender);
  if (!RPS_BEATS[a] || !RPS_BEATS[d] || a === d) return 1;
  if (RPS_BEATS[a] === d) return TUNING.rpsCounter;
  return TUNING.rpsCountered;
}

module.exports = {
  RACES,
  RPS_CLASSES,
  UNIT_CLASSES,
  RPS_BEATS,
  UNIT_TYPES,
  producibleTypes,
  TERRAIN_TYPES,
  FACILITIES,
  FACILITY_UNITS,
  unitStats,
  facilityCost,
  WEAPON_EFFECTS,
  EVENT_EFFECTS,
  TEAM_PHRASES,
  MAP_SIZES,
  DEFAULT_MAP_SIZE,
  MATCH_LENGTHS,
  DEFAULT_MATCH_LENGTH,
  rpsMultiplier,
};

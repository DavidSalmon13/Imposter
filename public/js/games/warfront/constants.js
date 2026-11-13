/**
 * Warfront client: fixed tables. Host menus, world geometry, race/facility/weapon/unit names,
 * card names and hotkeys. Must NOT contain: state, DOM or functions.
 * Mirrors the server tables where both exist (server/games/warfront/engine/data.js).
 */

export const RACES = [
  { id: 'forge', name: 'FORGE', desc: 'The great builders. Defense + economy; fields structures.' },
  { id: 'horde', name: 'HORDE', desc: 'The great fighters. Raw combat; reliable brutes.' },
  { id: 'arcane', name: 'ARCANE', desc: 'The magicians. Area magic + luck manipulation.' },
];
export const MATCH_LENGTHS = [
  { id: 'short', label: '8 MIN' },
  { id: 'standard', label: '12 MIN' },
  { id: 'long', label: '16 MIN' },
];
export const MAP_SIZES = [
  { id: 'small', label: 'SMALL' },
  { id: 'medium', label: 'MEDIUM' },
  { id: 'large', label: 'LARGE' },
];

// ===========================================================================
// Battlefield (2-battlefield.html)
// ===========================================================================

export const TILE = 70; // world px per tile, as in the mockup's 16x11 grid of 70px cells
export const ELEVATION = { hills: 24, rock: 30 }; // raised ground (plateau heights from the mockup)
export const BASE_PAD_Z = 20;
export const RACE_NAMES = { forge: 'Forge', horde: 'Horde', arcane: 'Arcane' };
// Stack formations from the mockup: figure offsets inside a 76x74 squad billboard.
export const FORMATIONS = {
  1: [[21, 24]],
  2: [[6, 24], [36, 24]],
  3: [[21, 10], [3, 28], [39, 28]],
  4: [[6, 10], [36, 10], [6, 28], [36, 28]],
};

// Facilities and towers (Step 9): drawn as buildings, never as unit stacks.
// How far up its billboard the Tower's roof deck is (sprites.js tower), where its garrison stands.
export const TOWER_ROOF_PX = 100;
export const FACILITY_TYPES = new Set(['refinery', 'barracks', 'workshop', 'tower']);
export const FACILITY_NAMES = { refinery: 'Refinery', barracks: 'Forward Barracks', workshop: 'Workshop', tower: 'Tower' };
export const FACILITY_ORDERS = {
  refinery: '▸ YOUR HAULERS UNLOAD HERE · +1💎/S ON ITS VEIN',
  barracks: '▸ RECRUIT: NEW UNITS STEP OUT HERE',
  workshop: '▸ CRAFT A WEAPON BELOW · ONE AT A TIME',
  tower: '▸ SEND UP TO 3 UNITS ONTO ITS ROOF',
};
export const WEAPON_NAMES = { artillery: 'Artillery', emp: 'EMP', airdrop: 'Airdrop', bombard: 'Bombard', aegis: 'Aegis' };
export const WEAPON_IDS = Object.keys(WEAPON_NAMES);
// What each weapon does (card tooltip) and, while it's armed, where to tap (the info well's order line).
export const WEAPON_INFO = {
  artillery: 'Shells one tile: damage to every enemy on it. Fire into the fog if you dare.',
  emp: 'Switches off an enemy building you can see for 15 s: no shots, no bonus, no production.',
  airdrop: 'Drops three of your basic soldiers on any tile your team can see.',
  bombard: 'Strikes the enemy base directly, even with defenders on it. An Aegis stops it.',
  aegis: 'Your base takes no damage at all for 10 s.',
};
export const WEAPON_AIM = {
  artillery: '▸ TAP ANY TILE TO SHELL IT · FOG TOO',
  emp: '▸ TAP AN ENEMY BUILDING YOU CAN SEE',
  airdrop: '▸ TAP A GREEN TILE TO DROP YOUR SQUAD',
  bombard: '▸ TAP THE ENEMY BASE TO BOMBARD IT',
  aegis: '▸ TAP YOUR BASE TO SHIELD IT',
};

// Per-type numbers (power, max HP, speed, range, class), synced from the server's wfState
// `unitStats` by syncUnitStats; the values below are only the fallback until it arrives.
export const UNIT_MAX_HP = {
  refinery: 15, barracks: 20, workshop: 15, tower: 40,
  laborer: 15, peon: 15, acolyte: 15,
  militiaman: 33, crossbow: 21, outrider: 24, bastion: 60, ballista: 24,
  warrior: 33, skirmisher: 21, raider: 27, berserker: 18, warchief: 48,
  apprentice: 18, mysticArcher: 18, battlemage: 24, summoner: 21, archmage: 30, golem: 54,
};
export const UNIT_STATS = {};

/** Takes the server's per-type numbers (wfState.unitStats) as the truth for HP bars and stat lines. */
export function syncUnitStats(stats) {
  if (!stats) return;
  Object.entries(stats).forEach(([type, st]) => {
    UNIT_STATS[type] = st;
    UNIT_MAX_HP[type] = st.hp;
  });
}

// Speed words for the stat line (the engine's move 0–3).
export const SPEED_NAMES = ['Static', 'Normal', 'Fast', 'Very fast'];

// One line on what each unit is for, shown in the info well and on a card's long press.
export const UNIT_INFO = {
  laborer: 'Carves 🔩 from the supply wall, hauls 💎 from veins, builds. Forge Workers carve faster.',
  peon: 'Carves 🔩 from the supply wall, hauls 💎 from veins, builds. Cheap and tireless.',
  acolyte: 'Carves 🔩 from the supply wall, hauls 💎 from veins, builds. Serves the Arcane circle.',
  militiaman: 'Spear infantry. Holds the line and beats cavalry.',
  crossbow: 'Shoots two tiles. Shreds infantry, but riders run it down.',
  outrider: 'Fast cavalry. Rides down archers and casters.',
  bastion: 'A walking fortress that never moves. Very tough; guards its tile.',
  ballista: 'Siege engine. Hits buildings and bases far harder.',
  warrior: 'Axe infantry. Hits hard and beats cavalry.',
  skirmisher: 'Throws javelins two tiles. Strong against infantry.',
  raider: 'The fastest unit. Hit-and-run cavalry that hunts archers.',
  berserker: 'Glass cannon. Huge damage, little HP.',
  warchief: 'Horde champion. Big HP and a slam that shakes the ground.',
  apprentice: 'Young mage. Casts violet orbs two tiles away.',
  mysticArcher: 'Glowing arrows from two tiles. Strong against infantry.',
  battlemage: 'Blasts everyone on the target tile at once.',
  summoner: 'Brings a Golem with it and sends spirit wisps two tiles.',
  archmage: 'Master caster. Steadies your luck nearby and curses the enemy\'s.',
  golem: 'A summoned stone guardian. Slow to kill, never moves.',
  tower: 'Up to 3 of your units can stand on its roof. Archers and mages shoot from it with +1 range, and nobody can hit them until the tower falls.',
  refinery: 'Your haulers unload here. +1💎 per second on its vein.',
  barracks: 'A forward spawn point: new units can step out here.',
  workshop: 'Crafts special weapons for your arsenal.',
};

/** "⚔ 5 · ❤ 21 · » Normal · ◎ 2" for a type (falls back to just HP before stats arrive). */
export function statLine(type) {
  const st = UNIT_STATS[type];
  if (!st) return `❤ ${UNIT_MAX_HP[type] || '?'}`;
  const parts = [];
  if (st.atk) parts.push(`⚔ ${st.atk}`);
  parts.push(`❤ ${st.hp}`);
  parts.push(`» ${SPEED_NAMES[st.move] || st.move}`);
  if (st.atk) parts.push(`◎ ${st.range}`);
  return parts.join(' · ');
}

export const UNIT_NAMES = {
  laborer: 'Laborer', peon: 'Peon', acolyte: 'Acolyte',
  militiaman: 'Militiaman', crossbow: 'Crossbow', outrider: 'Outrider', bastion: 'Bastion', ballista: 'Ballista',
  warrior: 'Warrior', skirmisher: 'Skirmisher', raider: 'Raider', berserker: 'Berserker', warchief: 'Warchief',
  apprentice: 'Apprentice', mysticArcher: 'Mystic Archer', battlemage: 'Battlemage', summoner: 'Summoner', archmage: 'Archmage', golem: 'Golem',
};

// ---------- Command console (2-battlefield.html + 2c-command-cards.html) ----------

// Letter keys, as the mockup's cards show them (desktop players can press them too).
export const HOTKEYS = {
  laborer: 'W', militiaman: 'M', crossbow: 'C', outrider: 'O', bastion: 'B', ballista: 'L',
  peon: 'P', warrior: 'W', skirmisher: 'S', raider: 'R', berserker: 'B', warchief: 'C',
  acolyte: 'C', apprentice: 'A', mysticArcher: 'R', battlemage: 'B', summoner: 'S', archmage: 'G',
};
// Card labels break long names the way the mockup does.
export const CARD_NAMES = {
  militiaman: 'Militia-man', skirmisher: 'Skirmish-er', battlemage: 'Battle-mage', mysticArcher: 'Mystic Archer',
  // Six cards a row (the Worker joins the mockup's five) leave a little less room.
  apprentice: 'Appren-tice', summoner: 'Summon-er', archmage: 'Arch-mage', crossbow: 'Cross-bow', berserker: 'Berserk-er',
};
export const RACE_CARD_CLASS = { forge: 'f', horde: 'h', arcane: '' };
export const WORKER_TYPES = new Set(['laborer', 'peon', 'acolyte']);

export const BUILD_HOTKEYS = { refinery: 'R', barracks: 'B', workshop: 'W', tower: 'T' };
export const BUILD_CARD_NAMES = { refinery: 'Refin-ery', barracks: 'Forward Barracks', workshop: 'Work-shop', tower: 'Tower' };

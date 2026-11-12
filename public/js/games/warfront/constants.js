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
export const FACILITY_TYPES = new Set(['refinery', 'barracks', 'workshop', 'tower']);
export const FACILITY_NAMES = { refinery: 'Refinery', barracks: 'Forward Barracks', workshop: 'Workshop', tower: 'Tower' };
export const FACILITY_ORDERS = {
  refinery: '▸ YOUR HAULERS UNLOAD HERE · +1💎/S ON ITS VEIN',
  barracks: '▸ RECRUIT: NEW UNITS STEP OUT HERE',
  workshop: '▸ CRAFT A WEAPON BELOW · ONE AT A TIME',
  tower: '▸ GUARDS ITS OWN TILE AND THE NEXT',
};
export const WEAPON_NAMES = { artillery: 'Artillery', emp: 'EMP', airdrop: 'Airdrop', bombard: 'Bombard', aegis: 'Aegis' };
export const WEAPON_IDS = Object.keys(WEAPON_NAMES);

// Max HP per unit type, for the stack HP bar (mirrors the server's UNIT_TYPES and FACILITIES).
export const UNIT_MAX_HP = {
  refinery: 15, barracks: 20, workshop: 15, tower: 18,
  laborer: 10, peon: 10, acolyte: 10,
  militiaman: 22, crossbow: 14, outrider: 16, bastion: 40, ballista: 16,
  warrior: 22, skirmisher: 14, raider: 18, berserker: 12, warchief: 32,
  apprentice: 12, mysticArcher: 12, battlemage: 16, summoner: 14, archmage: 20, golem: 36,
};

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

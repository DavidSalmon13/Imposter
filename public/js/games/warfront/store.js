/**
 * Warfront client: the one shared mutable store. Every former module-level `let` (and the
 * Maps/Sets/objects several modules mutate) is a field of S, because ES modules cannot
 * reassign each other's bindings. Each field says which module(s) write it; everything else
 * only reads. Must NOT contain: functions or DOM lookups (dom.js).
 */

export const S = {
  ctx: null, // written by index.js
  state: null, // written by index.js
  errorTimer: null, // written by util.js, index.js
  raceButtons: {}, // written by teamSelect.js
  lengthButtons: {}, // filled by teamSelect.js (buildSeg)
  sizeButtons: {}, // filled by teamSelect.js (buildSeg)
  builtFor: null, // written by battle.js, gameOver.js, index.js; clock.startedAt of the battle the world was built for
  unitLayer: null, // written by world/build.js
  orderLayer: null, // written by world/build.js
  fogRects: [], // written by world/build.js; per tile: the fog <rect> on the haze plane
  decor: [], // written by world/build.js, map-objects.js; [{ tileId, node }]: billboards that dim under fog
  pickupNodes: new Map(), // written by world/build.js, map-objects.js; tileId -> weapon-token billboard
  miniUnits: null, // written by minimap.js
  miniFog: null, // written by minimap.js
  miniView: null, // written by minimap.js
  clockTimer: null, // written by battle.js, index.js
  clockSkew: 0, // written by clock.js; server clock minus ours
  live: null, // written by battle.js, gameOver.js, index.js; the latest fogged view (wfState's live part, then every wfLive)
  lastVisible: null, // written by world/build.js, fog.js
  selected: new Set(), // written by battle.js, input.js, gameOver.js, index.js; ids of my own selected units
  stackNodes: new Map(), // written by world/build.js, units.js; stack key -> { node, sig, group }
  clickNodes: new Map(), // written by world/build.js, orders.js; destination tileId -> .click marker
  ordersSig: '', // written by world/build.js, orders.js
  rafId: null, // written by units.js, index.js
  stripSeen: null, // written by battle.js; whether the strip last showed enemies in sight
  fxLayer: null, // written by world/build.js, index.js; one-shot combat effects (3-resolution.html), removed when they end
  castleBoards: {}, // written by world/build.js; team -> the castle's billboard (for the burning state)
  lastHp: { red: null, blue: null }, // written by world/build.js
  alertTile: null, // written by fx.js
  alertTimer: null, // written by fx.js
  stepSeen: new Map(), // written by world/build.js, fx.js; stack key -> stepStartedAt we already puffed dust for
  mode: 'move', // written by battle.js, console/build.js, console/selection.js, input.js, index.js; what a tap on the map does with the selection: 'move' | 'haul'
  cardsFor: '', // written by console/cards.js, index.js; race|team the command card was built for
  cardNodes: new Map(), // written by console/cards.js; unitType -> { btn, q, bar, sig }
  dropNodes: new Map(), // written by world/build.js, map-objects.js; tileId -> dropped-load billboard
  gainNodes: new Map(), // written by fx.js; tileId -> { node, total }: the "+N💎" floating over a deposit
  lighthouseNodes: new Map(), // written by world/build.js; tileId -> { node, mini, team }: lighthouse billboard + minimap marker
  structLayer: null, // written by world/build.js; facilities and towers (Step 9), under the unit stacks
  hintLayer: null, // written by world/build.js, structures.js; build mode: the tiles you may build on
  structNodes: new Map(), // written by world/build.js, structures.js; unit id -> { node, bb, sig }: a facility/tower billboard
  structureTiles: new Set(), // written by world/build.js, structures.js; tiles a facility or tower stands on (stacks stand at its foot)
  tab: 'produce', // written by battle.js, console/build.js; the console's tab: 'produce' | 'build'
  buildMode: null, // written by battle.js, console/build.js, input.js; the facility armed for placement (next map tap builds it), or null
  selBase: false, // written by input.js, battle.js, console/bulk.js; your team's base is picked on the map (its info shows in the well)
  selStructure: null, // written by structures.js, battle.js, console/build.js, input.js; id of my facility/tower picked on the map (a Barracks is where units spawn)
  buildCardNodes: new Map(), // written by console/build.js; facility -> { btn, q, bar, info, sig }
  craftCardNodes: new Map(), // written by console/build.js; weaponId -> { btn, q, bar, sig }
  skewSamples: [], // written by clock.js
  skewReady: false, // written by clock.js
  lore: null, // written by console/cards.js; { type, until }: a Produce card long-pressed, its description shown in the info well
  infoSig: {}, // written by world/build.js, console/selection.js; what renderInfo last drew, so unchanged parts aren't rebuilt
  suppressClickUntil: 0, // written by camera.js
  inspect: null, // written by console/buildingInfo.js, console/cards.js, battle.js; { id, until }: a building long-pressed on the map, shown in the info well for 4 s
  inspectHinted: false, // written by console/buildingInfo.js; the long-press hint was shown (fallback when localStorage is blocked)
  goBuiltFor: null, // written by gameOver.js, index.js; clock.startedAt of the battle the scene was built for
};

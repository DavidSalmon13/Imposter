'use strict';

// Warfront shell: battlefield generation. The OpenAI prompt and call (the only place OpenAI
// is used), the procedural fallback on any failure, and starting the battle.
// Must NOT contain: map validation rules (engine/mapgen.js). Spec: "Map generation".

const { TEAMS, WF_MAP_TIMEOUT_MS } = require('./constants');
const { devMatchMs, startLoop } = require('./loop');
const { teamMembers, startBlocker } = require('./roster');
const { broadcastWfState } = require('./payloads');
const { chatCompletionJson } = require('../../lib/openai');
const { rngFor, randomSeed } = require('../../lib/rng');
const engine = require('./engine');

// ---------------------------------------------------------------------------
// Map generation (spec "Map generation")
// ---------------------------------------------------------------------------
function battlefieldPrompt(size, avoid) {
  const { width, height } = size;
  const half = Math.floor(width / 2);
  return (
    `Design a top-down grid battlefield for a two-team strategy game. The grid is ${width} tiles wide ` +
    `and ${height} tiles tall; x runs 0..${width - 1} left to right, y runs 0..${height - 1} top to bottom. ` +
    `Terrain types: "plains" (open), "forest", "hills" (both slow but defensive), "water" and "rock" ` +
    `(both impassable). Mostly plains, with forests and hills for cover, and water/rock shaping a few ` +
    `lanes and natural chokepoints - but every base, vein and weapon must stay reachable on foot. ` +
    `Put the red base near the left edge (x < ${half}) and the blue base near the right edge ` +
    `(x >= ${width - half}), roughly level with each other. Put exactly one supply source on a tile ` +
    `directly next to each base (up, down, left or right). Put 1-2 mineral veins out in the contested ` +
    `middle, equally far from both bases (richness 1-3, richest in the centre). Scatter 2-4 weapon ` +
    `tokens, placed fairly for both sides, rarer ones deeper in contested ground. Place 2-4 ` +
    `lighthouses (tall watchtowers that give whoever holds them a wide view): exactly one near each ` +
    `base (on that base's half, within ${engine.LIGHTHOUSE_HOME_RANGE} tiles of it but not on it), plus up to two at ` +
    `strategic contested spots - hills, chokepoints or near the veins - either equally far from both ` +
    `bases (within 2 tiles) or as a mirrored pair; keep the contested ones more than ` +
    `${engine.LIGHTHOUSE_HOME_RANGE} tiles from both bases. Keep the layout ` +
    `roughly mirror-symmetric so neither side has an advantage. No two features (base, supply source, ` +
    `vein, weapon, lighthouse) on the same tile, and none on water or rock. Also give the map an evocative theme ` +
    `name (max 40 characters) and 1-2 sentences of lore.` +
    (avoid.length ? ` Recent map themes - pick something different from all of them: ${avoid.join('; ')}.` : '') +
    ` Respond with ONLY compact JSON in exactly this shape: {"theme": "...", "lore": "...", ` +
    `"width": ${width}, "height": ${height}, "tiles": [{"terrain": "plains"}, ...], ` +
    `"bases": [{"team": "red", "x": 0, "y": 0}, {"team": "blue", "x": 0, "y": 0}], ` +
    `"supplySources": [{"x": 0, "y": 0}, {"x": 0, "y": 0}], ` +
    `"veins": [{"x": 0, "y": 0, "richness": 2, "contested": true}], ` +
    `"weapons": [{"x": 0, "y": 0, "weaponId": "artillery|emp|airdrop|bombard|aegis"}], ` +
    `"lighthouses": [{"x": 0, "y": 0}, {"x": 0, "y": 0}], ` +
    `"chokepoints": [{"x": 0, "y": 0}]}. "tiles" must have exactly ${width * height} entries in ` +
    `row-major order (all of row y=0 left to right, then row y=1, and so on).`
  );
}

/** Asks OpenAI for a battlefield and hard-validates it. Throws on any problem. */
async function generateBattlefield(room, sizeId) {
  const size = engine.MAP_SIZES[sizeId] || engine.MAP_SIZES[engine.DEFAULT_MAP_SIZE];
  const avoid = room.state.warfront.mapHistory.slice(-engine.TUNING.mapHistoryWindow);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OpenAI map request timed out')), WF_MAP_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([
      chatCompletionJson(battlefieldPrompt(size, avoid), { temperature: 1.1 }),
      timeout,
    ]);
    return engine.validateMap(raw, size);
  } finally {
    clearTimeout(timer);
  }
}

/** Team members with a race, as the engine's roster. */
function battleRoster(ctx, room) {
  const races = room.state.warfront.lobbyRaces;
  return TEAMS.flatMap((team) => teamMembers(ctx, room, team).map((name) => ({ name, team, race: races[name] })));
}

/**
 * Start Battle / Play Again: generating -> (AI map or fallback) -> playing.
 * Never fails for lack of a map: any OpenAI or validation error uses the
 * procedural fallback.
 */
async function generateBattle(ctx, roomCode, room) {
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'warfront' });
  broadcastWfState(ctx, roomCode, room);

  const sizeId = room.state.warfront.phaseConfig.mapSize;
  const seed = randomSeed();
  let map;
  try {
    map = await generateBattlefield(room, sizeId);
  } catch (err) {
    console.error('Warfront map generation failed, using the fallback map:', err.message);
    map = engine.buildFallbackMap(sizeId, rngFor(seed, 0));
  }

  // The room may have been closed, or sent back to the lobby, while we waited.
  if (ctx.rooms.get(roomCode) !== room || room.game !== 'warfront' || room.phase !== 'generating') return;

  const blocker = startBlocker(ctx, room);
  if (blocker) {
    room.phase = 'teamSelect';
    broadcastWfState(ctx, roomCode, room);
    ctx.roomEmit(roomCode, 'wfNotice', { text: `Battle cancelled: ${blocker}` });
    return;
  }

  const wf = room.state.warfront;
  const battle = engine.createBattleState(map, battleRoster(ctx, room), {
    seed,
    now: Date.now(),
    matchCapMs: devMatchMs() || wf.phaseConfig.matchCapMs,
  });
  Object.assign(wf, battle);
  wf.mapHistory.push(map.theme);
  if (wf.mapHistory.length > engine.TUNING.mapHistoryWindow) {
    wf.mapHistory.splice(0, wf.mapHistory.length - engine.TUNING.mapHistoryWindow);
  }
  room.phase = 'playing';
  broadcastWfState(ctx, roomCode, room);
  startLoop(ctx, roomCode);
}

module.exports = {
  generateBattle,
};

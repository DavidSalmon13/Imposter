'use strict';

// Warfront engine, layer 3: tile coordinates and per-tile terrain queries (passable, high ground,
// move cost). Must NOT contain: path search (pathing.js) or anything about units.
// Spec: "Map", "Terrain".

const { TERRAIN_TYPES } = require('./data');

// ---------------------------------------------------------------------------
// Grid helpers (tile ids are row-major: id = y * width + x)
// ---------------------------------------------------------------------------
function tileId(x, y, width) {
  return y * width + x;
}

function tileXY(id, width) {
  return { x: id % width, y: Math.floor(id / width) };
}

/** Manhattan distance between two tile ids on a grid of `width`. */
function manhattan(a, b, width) {
  const p = tileXY(a, width);
  const q = tileXY(b, width);
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
}

/** Orthogonal neighbours of a tile, in fixed order N, E, S, W (deterministic). */
function neighbors(id, width, height) {
  const { x, y } = tileXY(id, width);
  const out = [];
  if (y > 0) out.push(id - width);
  if (x < width - 1) out.push(id + 1);
  if (y < height - 1) out.push(id + width);
  if (x > 0) out.push(id - 1);
  return out;
}

function terrainAt(map, id) {
  const t = map.tiles[id];
  return typeof t === 'string' ? t : t && t.terrain;
}

function isPassable(map, id) {
  if (!Number.isInteger(id) || id < 0 || id >= map.width * map.height) return false;
  const t = TERRAIN_TYPES[terrainAt(map, id)];
  return Boolean(t && t.passable);
}

/** Time cost of walking onto a tile (its terrain's moveCost; plains 1, forest/hills 2). */
function moveCostAt(map, id) {
  return TERRAIN_TYPES[terrainAt(map, id)].moveCost;
}

// ---------------------------------------------------------------------------
// High ground (spec "High ground")
// ---------------------------------------------------------------------------
/** Hills are high ground; every other tile is low. */
function isHigh(map, id) {
  return terrainAt(map, id) === 'hills';
}

module.exports = {
  tileId,
  tileXY,
  manhattan,
  neighbors,
  terrainAt,
  isPassable,
  moveCostAt,
  isHigh,
};

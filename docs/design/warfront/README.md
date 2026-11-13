# WARFRONT — UI mockup

Design mockup for **WARFRONT**, a same-room, two-team (Red vs Blue) strategy game.
Each round, players secretly queue orders on their phones, then everything reveals
and resolves at once. You win by destroying the enemy base. There are three races:
Forge (builders), Horde (fighters) and Arcane (magicians).

This is a visual mockup only. It is not wired into the server, `gameRegistry.js` or `public/`.

## Viewing it

Open `index.html` in a browser. A tab bar switches between the screens. Each screen is
also a standalone, self-contained HTML file with no external assets:

| File | Screen |
| --- | --- |
| `1-team-select.html` | Red/Blue team columns, race picker, host options, Start Battle |
| `2-battlefield.html` | Planning screen: scrollable battlefield, HUD, chance card, command console, Lock Orders |
| `2b-unit-roster.html` | All 15 unit characters, grouped by race |
| `2c-command-cards.html` | Forge and Horde recruit panels |
| `3-resolution.html` | Reveal key frames: march, clash, base hit |
| `4-game-over.html` | Winner banner, final base HP, final map, scoreboard |
| `5a-ffa-team-select.html` | Free for all (Step 28): Teams / Free for all switch, one roster, Small map greyed |
| `5b-ffa-battlefield.html` | Free for all: 4-bar base HUD, knock-out banners, green and gold side colours, minimap |
| `5c-ffa-game-over.html` | Free for all: placings 1st–4th, every base, points |

The battlefield is a 1120×770 world inside a 390px-wide phone viewport. Drag or scroll
to pan it.

## Where each screen lives in the game

The real game ports these screens into small modules. Full map: `docs/implementation/warfront-code-map.md`.

| Mockup | Client module(s) in `public/js/games/warfront/` | Styles in `public/warfront/` |
| --- | --- | --- |
| `1-team-select.html` | `teamSelect.js` | `team-select.css` |
| `2-battlefield.html` | `world/build.js`, `world/geometry.js`, `units.js`, `orders.js`, `fog.js`, `minimap.js`, `camera.js`, `map-objects.js`, `hud.js`, `console/selection.js` | `battlefield.css`, `lighthouses.css` |
| `2b-unit-roster.html` | `units.js`, art in `sprites.js` | `battlefield.css` (squads) |
| `2c-command-cards.html` | `console/cards.js`, `console/build.js`, `structures.js` | `console.css`, `facilities.css` |
| `3-resolution.html` | `fx.js` (played once per event, live) | `fx.css` |
| `4-game-over.html` | `gameOver.js` | `game-over.css` |

The page shell and how every rule is scoped live in `shell.css`. The markup (screen ids) is in
`public/index.html`.

## How it's built

- **2.5D with plain HTML + CSS.** Each map is a flat `.world` plane tilted with
  `transform: rotateX(40deg)` inside a `perspective` camera, with `transform-style:
  preserve-3d`. Raised ground (`.plat`) is lifted with `translateZ` and has cliff walls
  rotated down from its edges. Trees, units, buildings and effects are billboards
  (`.ent > .bb`) counter-rotated so they stand upright. Shadows, selection rings, move
  lines and range circles lie flat on the ground plane.
- Characters, castles, towers, trees and crystals are inline SVG. Terrain textures are
  layered CSS gradients and masks. Animation is CSS keyframes only. There is no canvas,
  no WebGL and there are no images.
- Team colour comes from a wrapper class: `.tm-red .tc` and `.tm-blue .tc` fill the
  sprites' team-coloured parts.
- The battlefield is still a 16×11 grid underneath. The `.tiles` layer (70px cells) is the
  tap target, and everything else is positioned in world pixels.
- Interactions are static in this export, for example the race picker and the unit
  selection.
- Billboards stay parallel to the screen, so they lean back slightly in the world. Keep
  units a little in front of cliff edges, or their tops clip into the plateau.

The `5*-ffa-*` screens (Step 28) were not drawn on the design canvas: they are built from the
static files above (same CSS, markup and SVG, with green `.tm-green` and gold `.tm-gold` side
colours added), so they have no `source/*.dc.html` original.

`source/` holds the editable originals (`*.dc.html` + `canvas.json`) from the Claude design
canvas. The static files above were generated from them.

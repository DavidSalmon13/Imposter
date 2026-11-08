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

The battlefield is a 960×660 world inside a 390px-wide phone viewport. Drag or scroll
to pan it.

## How it's built

- Plain HTML + CSS. Characters, castles, towers and crystals are inline SVG. Terrain is
  layered CSS gradients and masks. Animation is CSS keyframes only. There is no canvas
  and there are no images.
- Team colour comes from a wrapper class: `.tm-red .tc` and `.tm-blue .tc` fill the
  sprites' team-coloured parts.
- The battlefield is still a 16×11 tile grid underneath. The `.tiles` layer is the tap
  target, and terrain, units and nodes are positioned in pixels (60px per tile).
- Interactions are static in this export, for example the race picker and the unit
  selection.

`source/` holds the editable originals (`*.dc.html` + `canvas.json`) from the Claude design
canvas. The static files above were generated from them.

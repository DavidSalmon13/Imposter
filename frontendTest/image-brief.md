# Shorot redesign — image generation brief

Two assets needed. Generate with your tool of choice, then drop them at the exact
paths below (create the folder if it doesn't exist) — I'll wire them in once they land.

```
public/images/bg-gamenight.jpg
public/images/logo-shorot.png
```

---

## 1. Background — `public/images/bg-gamenight.jpg`

**Subject:** A cozy living-room game-night scene, illustrated/painterly style
(same general rendering quality as a mobile game menu background — soft
painted lighting, not flat vector). Warm string lights strung along the top
edge, a low wooden coffee table scattered with dice, playing cards, a
scoreboard notepad, maybe a confetti sprinkle — evening indoor lighting, cozy
and inviting rather than busy or cluttered. Suggest a couch/rug at the edges
of frame. No visible people/faces needed — keep it an empty "set the scene"
shot, not a portrait.

**Composition constraint (important):** On phones, a card/panel sits centered
over most of the screen, covering roughly the middle 90% of the width and a
large vertical band in the center. Only the very top (behind the header), a
thin margin on the sides, and the bottom are reliably visible. So:
- Put the richest detail near the **top edge** (string lights, tops of
  shelves/frames) and along the **left/right edges**.
- Keep the **vertical center** calm, darker, and low-contrast (soft bokeh or
  shadow is fine) — it'll mostly be hidden or only need to read as ambience
  behind semi-transparent edges.
- Avoid a single focal subject dead-center.

**Palette anchor** (steer the generation toward these tones so it reads as
one family with the rest of the app):
- Deep warm brown backdrop, around `#341008`–`#241812`
- Cream/gold highlight, around `#ffcf7a`
- Coral/orange accent, around `#ff6b57`
- Warm off-white for light sources/string lights, around `#fff8ee`

**Orientation/size:** Portrait, mobile-first. Generate at the largest
portrait size your tool supports (e.g. 1024×1536 or 1536×2048 — exact pixels
don't matter, it's applied via CSS `background-size: cover`, so orientation
and resolution headroom matter more than an exact ratio).

**Format:** JPG, reasonably compressed (aim under ~800KB — this loads on
phones with no build-time image optimization in this project).

---

## 2. Logo + mascot — `public/images/logo-shorot.png`

**Subject:** A "Shorot" wordmark in chunky, rounded, playful 3D letters —
think puffy fabric-banner or rounded-wood-plank lettering, not sharp/flat
text — paired with a small, simple, friendly mascot character (e.g. a
googly-eyed die, or a little party-hat blob character) positioned beside or
perched on top of the wordmark. Keep the mascot generic/game-agnostic — it
shouldn't visually tie to any single one of the app's specific games
(Imposter, Codenames, etc.), since it represents the app as a whole.

**Style:** Same painterly/illustrated rendering as the background, matching
the same warm palette anchor above (coral/orange + cream/gold, dark brown
outline/shading for the carved look).

**Background:** Transparent (must be a real alpha-channel PNG, not a white
or colored box) — this gets placed over the background image and various
panel colors, so it needs to work on multiple backdrops.

**Framing:** Roughly landscape/wide, generous transparent padding on all
sides so it can be scaled down for a compact header without clipping.

**Format:** PNG with transparency, reasonably compressed (aim under ~300KB).

---

Once both files are in place at those exact paths, tell me and I'll start on
the join + lobby screens.

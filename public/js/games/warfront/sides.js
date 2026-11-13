/**
 * Warfront client: the four sides' names and colours (spec "Free-for-all mode"; mockups
 * 5a/5b/5c-ffa-*.html). Red and blue are the team colours from the original mockups; green and
 * gold join for free for all. Sprites take the side colour from a `.tm-<side>` wrapper (CSS);
 * this file is for colours set from JS. Must NOT contain: imports or behaviour beyond lookups.
 */

export const SIDES = ['red', 'blue', 'green', 'gold'];

/**
 * label: names and HP text in the HUD; bright: buttons, bars and minimap; ring: a dim well
 * outline; glow: a lit well's inner glow; dark: the deep end of a gradient; portrait: an info-well
 * portrait in the owner's colour.
 */
export const SIDE = {
  red: { name: 'Red', label: '#ff7a7e', bright: '#ff5a5f', dark: '#7c1418', ring: '#7a2a2e', glow: 'rgba(229,72,77,.3)', portrait: { backgroundColor: '#1a0c0e', boxShadow: 'inset 0 0 0 1px #8a2a2e, inset 0 0 16px rgba(255,90,95,.35)' } },
  blue: { name: 'Blue', label: '#7fb0ff', bright: '#4f93ff', dark: '#1d4fb0', ring: '#23477e', glow: 'rgba(59,130,246,.3)', portrait: { backgroundColor: '#0b1222', boxShadow: 'inset 0 0 0 1px #2a4f9a, inset 0 0 16px rgba(79,147,255,.35)' } },
  green: { name: 'Green', label: '#5fd6a8', bright: '#21b37f', dark: '#12704e', ring: '#1c5a44', glow: 'rgba(33,179,127,.3)', portrait: { backgroundColor: '#07170f', boxShadow: 'inset 0 0 0 1px #1c7a54, inset 0 0 16px rgba(33,179,127,.35)' } },
  gold: { name: 'Gold', label: '#ffd95e', bright: '#f2c230', dark: '#8a6a0c', ring: '#6e5512', glow: 'rgba(242,194,48,.3)', portrait: { backgroundColor: '#171206', boxShadow: 'inset 0 0 0 1px #8a6a0c, inset 0 0 16px rgba(242,194,48,.35)' } },
};

export const sideOf = (team) => SIDE[team] || SIDE.red;

/** 1 → '1ST' … 4 → '4TH'. */
export const ordinal = (n) => `${n}${['', 'ST', 'ND', 'RD'][n] || 'TH'}`;

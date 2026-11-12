/**
 * Warfront client: every element lookup (`$('wf-…')`), grouped by screen: team select,
 * battlefield (map, HUD, console), game over. Ids are the markup in public/index.html.
 * Must NOT contain: state or behaviour.
 */

export const $ = (id) => document.getElementById(id);
export const vista = $('wf-team-vista');
export const subEl = $('wf-team-sub');
export const hostBadge = $('wf-host-badge');
export const slotsEl = { red: $('wf-red-slots'), blue: $('wf-blue-slots') };
export const countEl = { red: $('wf-red-count'), blue: $('wf-blue-count') };
export const joinBtn = { red: $('wf-join-red'), blue: $('wf-join-blue') };
export const captainBtn = $('wf-captain-btn');
export const benchEl = $('wf-bench');
export const raceList = $('wf-race-list');
export const settingsEl = $('wf-settings');
export const lengthSeg = $('wf-length-seg');
export const sizeSeg = $('wf-size-seg');
export const randomizeBtn = $('wf-randomize-btn');
export const startBtn = $('wf-start-btn');
export const statusEl = $('wf-team-status');
export const errorEl = $('wf-team-error');
export const backBtn = $('wf-team-back-btn');

export const vp = $('wf-vp');
export const cam = $('wf-cam');
export const world = $('wf-world');
export const hpEl = { red: $('wf-red-hp'), blue: $('wf-blue-hp') };
export const hpSegEl = { red: $('wf-red-hpseg'), blue: $('wf-blue-hpseg') };
export const clockEl = $('wf-clock');
export const stripEl = $('wf-strip');
export const edgeL = $('wf-edge-l');
export const edgeR = $('wf-edge-r');
export const minimap = $('wf-minimap');
export const infoPortrait = $('wf-info-portrait');
export const infoTitle = $('wf-info-title');
export const infoTag = $('wf-info-tag');
export const infoSub = $('wf-info-sub');
export const infoHp = $('wf-info-hp');
export const infoDesc = $('wf-info-desc');
export const infoOrder = $('wf-info-order');
export const armyLabel = $('wf-army-label');
export const supplyEl = $('wf-supply');
export const supplyRateEl = $('wf-supply-rate');
export const mineralsEl = $('wf-minerals');
export const armyEl = $('wf-army');
export const armyCapEl = $('wf-army-cap');
export const cardsEl = $('wf-cards');
export const cmdBtn = { move: $('wf-cmd-move'), haul: $('wf-cmd-haul'), hold: $('wf-cmd-hold'), all: $('wf-cmd-all') };
export const tabsEl = $('wf-tabs');
export const tabBtn = { produce: $('wf-tab-produce'), build: $('wf-tab-build') };
export const buildCardsEl = $('wf-build-cards');
export const craftCardsEl = $('wf-craft-cards');
export const feedEl = $('wf-feed');
export const menuBtn = $('wf-menu-btn');
export const alertEl = $('wf-alert');
export const alertText = $('wf-alert-text');

// ---------- Game over (4-game-over.html) ----------

const goScreen = $('wf-gameover-screen');
export const goRoot = goScreen ? goScreen.querySelector('.wf') : null;
export const goVp = $('wf-go-vp');
export const goCam = $('wf-go-cam');
export const goWorld = $('wf-go-world');
export const goConfetti = $('wf-go-confetti');
export const goReason = $('wf-go-reason');
export const goTitle = $('wf-go-title');
export const goSub = $('wf-go-sub');
export const goRows = $('wf-go-rows');
export const goMvp = $('wf-go-mvp');
export const goAgain = $('wf-go-again');
export const goBack = $('wf-go-back');
export const goError = $('wf-go-error');
export const goScoreboard = $('wf-go-scoreboard');

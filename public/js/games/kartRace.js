/**
 * Kart Race client module.
 * Step 12: kart meshes + chase camera + interpolated motion.
 */

import * as THREE from 'three';
import { renderScoreboardFx } from '../fx.js';

const ITEM_LABELS = {
  boost: 'Boost',
  shield: 'Shield',
  shell: 'Shell',
};

const KART_COLORS = [
  0xe74c3c, // red
  0x3498db, // blue
  0x2ecc71, // green
  0xf1c40f, // yellow
  0x9b59b6, // purple
  0xe67e22, // orange
  0x1abc9c, // teal
  0xecf0f1, // white
];

const RENDER_DELAY_MS = 100;
const CAM_DIST = 14;
const CAM_HEIGHT = 7;
const CAM_LOOK_AHEAD = 4;
const CAM_SMOOTH = 0.12;

let socket = null;
let lastState = null;
let steerLeft = false;
let steerRight = false;
let braking = false;
let inputResendHandle = null;
let countdownTickHandle = null;

// --- Three.js ---
let trackData = null;
let scene = null;
let camera = null;
let renderer = null;
let rafHandle = null;
let sceneReady = false;
let itemBoxMeshes = [];
/** @type {Map<string, THREE.Group>} */
const kartMeshes = new Map();
/** Ring buffer of last 2 krState snapshots for interpolation. */
let stateBuffer = [];
let viewerName = null;
const camDesired = new THREE.Vector3();
const camLook = new THREE.Vector3();
const _fwd = new THREE.Vector3();

function el(id) {
  return document.getElementById(id);
}

function isViewerHost(data) {
  return !!(data.host && data.viewerName && data.host === data.viewerName);
}

function currentSteer() {
  if (steerRight) return 1;
  if (steerLeft) return -1;
  return 0;
}

function emitInput() {
  if (!socket) return;
  socket.emit('krInput', { steer: currentSteer(), braking: !!braking });
}

function startInputResend() {
  stopInputResend();
  inputResendHandle = setInterval(emitInput, 200);
}

function stopInputResend() {
  if (inputResendHandle) {
    clearInterval(inputResendHandle);
    inputResendHandle = null;
  }
}

function stopCountdownTick() {
  if (countdownTickHandle) {
    clearInterval(countdownTickHandle);
    countdownTickHandle = null;
  }
}

function updateCountdownDisplay(raceStartAt) {
  const countdownEl = el('kr-countdown');
  if (!countdownEl || !raceStartAt) {
    if (countdownEl) countdownEl.classList.add('hidden');
    return;
  }
  const remaining = raceStartAt - Date.now();
  countdownEl.classList.remove('hidden');
  if (remaining <= 0) {
    countdownEl.textContent = 'GO';
  } else {
    countdownEl.textContent = String(Math.ceil(remaining / 1000));
  }
}

function bindHoldButton(btn, onDown, onUp) {
  if (!btn) return;
  const down = (e) => {
    e.preventDefault();
    onDown();
  };
  const up = (e) => {
    e.preventDefault();
    onUp();
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
}

function applyReady(data) {
  const readyPanel = el('kr-ready-panel');
  const playerList = el('kr-player-list');
  const startBtn = el('kr-start-btn');
  const readyError = el('kr-ready-error');

  readyPanel.classList.remove('hidden');
  playerList.innerHTML = '';
  (data.players || []).forEach((n) => {
    const li = document.createElement('li');
    li.textContent = n === data.host ? `${n} (host)` : n;
    playerList.appendChild(li);
  });

  const host = isViewerHost(data);
  startBtn.classList.toggle('hidden', !host);
  startBtn.disabled = !data.canStart;
  if (readyError) readyError.textContent = '';
}

function applyRace(data) {
  const racePanel = el('kr-race-panel');
  const endBtn = el('kr-end-race-btn');
  const itemBtn = el('kr-item-btn');
  const lapDisplay = el('kr-lap-display');
  const rankDisplay = el('kr-rank-display');

  racePanel.classList.remove('hidden');

  const me = (data.karts || []).find((k) => k.name === data.viewerName);
  if (lapDisplay) {
    lapDisplay.textContent = me ? `Lap ${Math.min((me.lap || 0) + 1, 1)} / 1` : '';
  }
  if (rankDisplay) {
    const finished = (data.karts || []).filter((k) => k.finished).sort((a, b) => a.finishRank - b.finishRank);
    const myRank = me && me.finished ? me.finishRank : null;
    rankDisplay.textContent = myRank != null ? `Finished #${myRank}` : '';
    if (!myRank && finished.length) {
      rankDisplay.textContent = `${finished.length} finished`;
    }
  }

  if (itemBtn) {
    const held = me && me.heldItem;
    itemBtn.classList.toggle('hidden', !held);
    itemBtn.textContent = held ? ITEM_LABELS[held] || held : '';
  }

  const host = isViewerHost(data);
  if (endBtn) {
    endBtn.classList.toggle('hidden', !(host && data.canEndRace));
  }

  if (data.phase === 'countdown') {
    updateCountdownDisplay(data.raceStartAt);
    stopCountdownTick();
    countdownTickHandle = setInterval(() => updateCountdownDisplay(data.raceStartAt), 100);
    stopInputResend();
  } else {
    stopCountdownTick();
    const countdownEl = el('kr-countdown');
    if (countdownEl) countdownEl.classList.add('hidden');
    startInputResend();
  }

  pushStateSnapshot(data);
  syncKartMeshes(data.karts || []);
  syncItemBoxVisibility(data.itemBoxes || []);

  requestAnimationFrame(() => {
    resizeRenderer();
    startRenderLoop();
  });
}

function applyResults(data) {
  const resultsPanel = el('kr-results-panel');
  const resultsList = el('kr-results-list');
  const playAgainBtn = el('kr-play-again-btn');

  resultsPanel.classList.remove('hidden');
  resultsList.innerHTML = '';
  (data.results || []).forEach((entry, i) => {
    const li = document.createElement('li');
    const place = entry.finishRank != null ? entry.finishRank : i + 1;
    const detail =
      entry.finishTime != null
        ? `${(entry.finishTime / 1000).toFixed(2)}s`
        : `progress ${(entry.progress || 0).toFixed(0)}`;
    li.textContent = `#${place} ${entry.name} — ${detail}`;
    resultsList.appendChild(li);
  });

  renderScoreboardFx(el('kr-scoreboard'), data.scoreboard);
  playAgainBtn.classList.toggle('hidden', !isViewerHost(data));
}

// --- Track mesh helpers ---

function waypointTangent(waypoints, i) {
  const n = waypoints.length;
  const a = waypoints[i];
  const b = waypoints[(i + 1) % n];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { fx: dx / len, fz: dz / len, rx: dz / len, rz: -dx / len };
}

function worldPosAt(waypoints, wpIndex, lateralOffset) {
  const a = waypoints[wpIndex];
  const { rx, rz } = waypointTangent(waypoints, wpIndex);
  const lat = lateralOffset || 0;
  return { x: a.x + rx * lat, z: a.z + rz * lat };
}

function buildTrackRibbon(waypoints, halfWidth) {
  const n = waypoints.length;
  const positions = [];
  const indices = [];

  for (let i = 0; i < n; i++) {
    const { rx, rz } = waypointTangent(waypoints, i);
    const p = waypoints[i];
    positions.push(p.x - rx * halfWidth, 0.02, p.z - rz * halfWidth);
    positions.push(p.x + rx * halfWidth, 0.02, p.z + rz * halfWidth);
  }

  for (let i = 0; i < n; i++) {
    const i0 = i * 2;
    const i1 = i0 + 1;
    const j0 = ((i + 1) % n) * 2;
    const j1 = j0 + 1;
    indices.push(i0, j0, i1);
    indices.push(i1, j0, j1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x3a3f4a,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

function buildCenterlineMarkers(waypoints) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x6a7385 });
  for (let i = 0; i < waypoints.length; i += 4) {
    const p = waypoints[i];
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, 0.35), mat);
    m.position.set(p.x, 0.06, p.z);
    group.add(m);
  }
  return group;
}

function buildFinishLine(waypoints) {
  const group = new THREE.Group();
  const { rx, rz, fx, fz } = waypointTangent(waypoints, 0);
  const p = waypoints[0];
  const stripeMatA = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const stripeMatB = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const halfW = trackData.trackHalfWidth;
  const stripes = 8;
  const stripeW = (halfW * 2) / stripes;
  for (let i = 0; i < stripes; i++) {
    const lat = -halfW + stripeW * (i + 0.5);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(stripeW * 0.95, 0.05, 1.2),
      i % 2 === 0 ? stripeMatA : stripeMatB
    );
    mesh.position.set(p.x + rx * lat - fx * 0.2, 0.05, p.z + rz * lat - fz * 0.2);
    mesh.rotation.y = Math.atan2(fx, fz);
    group.add(mesh);
  }
  return group;
}

function buildItemBoxes(waypoints, boxes) {
  const meshes = [];
  const geo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffc857,
    emissive: 0x664400,
    roughness: 0.4,
    metalness: 0.2,
  });
  for (const box of boxes) {
    const pos = worldPosAt(waypoints, box.waypointIndex, 0);
    const mesh = new THREE.Mesh(geo, mat.clone());
    mesh.position.set(pos.x, 1.0, pos.z);
    mesh.userData.waypointIndex = box.waypointIndex;
    meshes.push(mesh);
  }
  return meshes;
}

function buildOilSlicks(waypoints, slicks) {
  const group = new THREE.Group();
  const geo = new THREE.CircleGeometry(1.8, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x1a1520,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  for (const slick of slicks) {
    const pos = worldPosAt(waypoints, slick.waypointIndex, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, 0.04, pos.z);
    group.add(mesh);
  }
  return group;
}

function buildWallHazards(waypoints, walls) {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1.6, 1.8, 1.6);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc45c5c, roughness: 0.7, metalness: 0.1 });
  for (const wall of walls) {
    const pos = worldPosAt(waypoints, wall.waypointIndex, wall.lateralOffset || 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, 0.9, pos.z);
    group.add(mesh);
  }
  return group;
}

function buildGroundPlane() {
  const geo = new THREE.PlaneGeometry(160, 160);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1e2a22, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.02;
  return mesh;
}

function createKartMesh(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 2.4), bodyMat);
  body.position.y = 0.55;
  body.name = 'body';
  group.add(body);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.45, 1.1),
    new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.4, metalness: 0.2 })
  );
  cabin.position.set(0, 1.05, -0.15);
  group.add(cabin);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.35, 12);
  const wheelOffsets = [
    [0.9, 0.35, 0.85],
    [-0.9, 0.35, 0.85],
    [0.9, 0.35, -0.85],
    [-0.9, 0.35, -0.85],
  ];
  for (const [x, y, z] of wheelOffsets) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, y, z);
    group.add(w);
  }

  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(1.9, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    })
  );
  shield.name = 'shield';
  shield.visible = false;
  group.add(shield);

  group.userData.bodyMat = bodyMat;
  group.userData.baseColor = color;

  // Nose points along local +Z (matches server heading 0 → +z travel).
  return group;
}

function clearKartMeshes() {
  for (const mesh of kartMeshes.values()) {
    scene.remove(mesh);
  }
  kartMeshes.clear();
}

function syncKartMeshes(karts) {
  if (!scene) return;
  const alive = new Set();
  karts.forEach((k, index) => {
    alive.add(k.name);
    let mesh = kartMeshes.get(k.name);
    if (!mesh) {
      mesh = createKartMesh(KART_COLORS[index % KART_COLORS.length]);
      kartMeshes.set(k.name, mesh);
      scene.add(mesh);
      mesh.position.set(k.x, 0, k.z);
      mesh.rotation.y = k.headingRad || 0;
    }
    // Ghost disconnected karts
    mesh.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = k.connected === false ? 0.35 : 1;
        }
      }
    });
  });
  for (const [name, mesh] of kartMeshes) {
    if (!alive.has(name)) {
      scene.remove(mesh);
      kartMeshes.delete(name);
    }
  }
}

function syncItemBoxVisibility(boxes) {
  const now = Date.now();
  for (const mesh of itemBoxMeshes) {
    const entry = boxes.find((b) => b.waypointIndex === mesh.userData.waypointIndex);
    const taken = entry && entry.takenUntil > now;
    mesh.visible = !taken;
  }
}

function pushStateSnapshot(data) {
  viewerName = data.viewerName || viewerName;
  stateBuffer.push({
    timestamp: Date.now(),
    karts: (data.karts || []).map((k) => ({ ...k })),
  });
  if (stateBuffer.length > 2) stateBuffer.shift();
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function sampleKartPose(name, renderTime) {
  if (stateBuffer.length === 0) return null;
  if (stateBuffer.length === 1) {
    const k = stateBuffer[0].karts.find((x) => x.name === name);
    return k
      ? {
          x: k.x,
          z: k.z,
          headingRad: k.headingRad || 0,
          spinningUntil: k.spinningUntil || 0,
          boostUntil: k.boostUntil || 0,
          shieldUntil: k.shieldUntil || 0,
        }
      : null;
  }
  const a = stateBuffer[0];
  const b = stateBuffer[1];
  const span = b.timestamp - a.timestamp || 1;
  let t = (renderTime - a.timestamp) / span;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const ka = a.karts.find((x) => x.name === name);
  const kb = b.karts.find((x) => x.name === name);
  if (!ka && !kb) return null;
  const src = kb || ka;
  if (!ka) {
    return {
      x: kb.x,
      z: kb.z,
      headingRad: kb.headingRad || 0,
      spinningUntil: kb.spinningUntil || 0,
      boostUntil: kb.boostUntil || 0,
      shieldUntil: kb.shieldUntil || 0,
    };
  }
  if (!kb) {
    return {
      x: ka.x,
      z: ka.z,
      headingRad: ka.headingRad || 0,
      spinningUntil: ka.spinningUntil || 0,
      boostUntil: ka.boostUntil || 0,
      shieldUntil: ka.shieldUntil || 0,
    };
  }
  return {
    x: ka.x + (kb.x - ka.x) * t,
    z: ka.z + (kb.z - ka.z) * t,
    headingRad: lerpAngle(ka.headingRad || 0, kb.headingRad || 0, t),
    spinningUntil: src.spinningUntil || 0,
    boostUntil: src.boostUntil || 0,
    shieldUntil: src.shieldUntil || 0,
  };
}

function updateChaseCamera(localPose) {
  if (!localPose) return;
  const h = localPose.headingRad;
  _fwd.set(Math.sin(h), 0, Math.cos(h));
  camDesired.set(
    localPose.x - _fwd.x * CAM_DIST,
    CAM_HEIGHT,
    localPose.z - _fwd.z * CAM_DIST
  );
  camLook.set(
    localPose.x + _fwd.x * CAM_LOOK_AHEAD,
    0.8,
    localPose.z + _fwd.z * CAM_LOOK_AHEAD
  );
  camera.position.lerp(camDesired, CAM_SMOOTH);
  camera.lookAt(camLook);
}

function resizeRenderer() {
  if (!renderer || !camera) return;
  const canvas = el('kr-canvas');
  if (!canvas) return;
  const w = canvas.clientWidth || 360;
  const h = canvas.clientHeight || 240;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

function stopRenderLoop() {
  if (rafHandle != null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function startRenderLoop() {
  if (rafHandle != null || !sceneReady) return;
  const tick = () => {
    rafHandle = requestAnimationFrame(tick);
    const now = performance.now() * 0.001;
    const renderTime = Date.now() - RENDER_DELAY_MS;

    for (const mesh of itemBoxMeshes) {
      if (!mesh.visible) continue;
      mesh.rotation.y = now * 1.4;
      mesh.position.y = 1.0 + Math.sin(now * 2 + mesh.position.x) * 0.15;
    }

    const wallNow = Date.now();
    let localPose = null;
    for (const [name, mesh] of kartMeshes) {
      const pose = sampleKartPose(name, renderTime);
      if (!pose) continue;
      mesh.position.set(pose.x, 0, pose.z);
      let heading = pose.headingRad;
      if (pose.spinningUntil > wallNow) {
        heading += now * 10;
      }
      mesh.rotation.y = heading;

      const shield = mesh.getObjectByName('shield');
      if (shield) shield.visible = pose.shieldUntil > wallNow;

      const bodyMat = mesh.userData.bodyMat;
      if (bodyMat) {
        if (pose.boostUntil > wallNow) {
          bodyMat.emissive.setHex(0xff6600);
          bodyMat.emissiveIntensity = 0.65;
        } else {
          bodyMat.emissive.setHex(0x000000);
          bodyMat.emissiveIntensity = 0;
        }
      }

      if (name === viewerName) localPose = pose;
    }

    if (localPose) {
      updateChaseCamera(localPose);
    }

    renderer.render(scene, camera);
  };
  tick();
}

async function buildScene() {
  const canvas = el('kr-canvas');
  if (!canvas) return;

  const res = await fetch('/data/kart-track.json');
  trackData = await res.json();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a0b5);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  // Start roughly behind the start line so the first frame isn't empty.
  camera.position.set(20, CAM_HEIGHT, -CAM_DIST);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xfff2dd, 0.9);
  sun.position.set(40, 80, 20);
  scene.add(sun);

  scene.add(buildGroundPlane());
  scene.add(buildTrackRibbon(trackData.waypoints, trackData.trackHalfWidth));
  scene.add(buildCenterlineMarkers(trackData.waypoints));
  scene.add(buildFinishLine(trackData.waypoints));
  scene.add(buildOilSlicks(trackData.waypoints, trackData.oilSlicks || []));
  scene.add(buildWallHazards(trackData.waypoints, trackData.wallHazards || []));

  itemBoxMeshes = buildItemBoxes(trackData.waypoints, trackData.itemBoxes || []);
  for (const m of itemBoxMeshes) scene.add(m);

  sceneReady = true;
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);

  if (lastState && (lastState.phase === 'countdown' || lastState.phase === 'racing')) {
    pushStateSnapshot(lastState);
    syncKartMeshes(lastState.karts || []);
    requestAnimationFrame(() => {
      resizeRenderer();
      startRenderLoop();
    });
  }
}

function resetRaceVisuals() {
  stopRenderLoop();
  stateBuffer = [];
  if (scene) clearKartMeshes();
}

export const KartRace = {
  init(sock) {
    socket = sock;

    const startBtn = el('kr-start-btn');
    const endBtn = el('kr-end-race-btn');
    const playAgainBtn = el('kr-play-again-btn');
    const backBtn = el('kr-back-btn');
    const itemBtn = el('kr-item-btn');
    const readyError = el('kr-ready-error');

    if (startBtn) {
      startBtn.addEventListener('click', () => {
        if (readyError) readyError.textContent = '';
        socket.emit('startKartRace', (res) => {
          if (res && !res.ok && readyError) readyError.textContent = res.error || 'Could not start';
        });
      });
    }

    if (endBtn) {
      endBtn.addEventListener('click', () => {
        socket.emit('krEndRace', (res) => {
          if (res && !res.ok && readyError) readyError.textContent = res.error || 'Could not end race';
        });
      });
    }

    if (playAgainBtn) {
      playAgainBtn.addEventListener('click', () => {
        socket.emit('playAgainKartRace', (res) => {
          if (res && !res.ok && readyError) readyError.textContent = res.error || 'Could not restart';
        });
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        socket.emit('backToLobby', () => {});
      });
    }

    if (itemBtn) {
      itemBtn.addEventListener('click', () => {
        socket.emit('krUseItem');
      });
    }

    bindHoldButton(
      el('kr-left-btn'),
      () => {
        steerLeft = true;
        emitInput();
      },
      () => {
        steerLeft = false;
        emitInput();
      }
    );
    bindHoldButton(
      el('kr-right-btn'),
      () => {
        steerRight = true;
        emitInput();
      },
      () => {
        steerRight = false;
        emitInput();
      }
    );
    bindHoldButton(
      el('kr-brake-btn'),
      () => {
        braking = true;
        emitInput();
      },
      () => {
        braking = false;
        emitInput();
      }
    );

    if (backBtn) backBtn.classList.remove('hidden');

    buildScene().catch((err) => {
      console.error('KartRace scene build failed', err);
    });
  },

  applyState(data) {
    lastState = data;
    viewerName = data.viewerName || viewerName;

    el('kr-ready-panel').classList.add('hidden');
    el('kr-race-panel').classList.add('hidden');
    el('kr-results-panel').classList.add('hidden');

    if (data.phase === 'ready') {
      stopInputResend();
      stopCountdownTick();
      resetRaceVisuals();
      applyReady(data);
      return;
    }

    if (data.phase === 'countdown' || data.phase === 'racing') {
      applyRace(data);
      return;
    }

    if (data.phase === 'results') {
      stopInputResend();
      stopCountdownTick();
      resetRaceVisuals();
      applyResults(data);
    }
  },

  stop() {
    stopInputResend();
    stopCountdownTick();
    resetRaceVisuals();
    steerLeft = false;
    steerRight = false;
    braking = false;
    lastState = null;
    viewerName = null;
  },
};

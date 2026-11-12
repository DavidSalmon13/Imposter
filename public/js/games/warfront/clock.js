/**
 * Warfront client: the server clock as seen from this phone (skew-smoothed), used to tween
 * units and draw timers between 5 Hz snapshots. Must NOT contain: rendering.
 * Plan "Architecture" (the client never simulates).
 */

import { S } from './store.js';

export const serverNow = () => Date.now() + S.clockSkew;

/**
 * Keeps clockSkew steady. Each snapshot's serverNow minus our clock is the true
 * offset minus that packet's network delay, which jitters from packet to packet;
 * adopting each sample raw made walking stacks jump back and forth 5×/s. The best
 * estimate is the largest recent sample (the least-delayed packet), and we ease
 * toward it instead of snapping.
 */
export function syncClock(serverStamp) {
  S.skewSamples.push(serverStamp - Date.now());
  if (S.skewSamples.length > 25) S.skewSamples.shift(); // ~5 s of snapshots
  const target = Math.max(...S.skewSamples);
  if (!S.skewReady || Math.abs(target - S.clockSkew) > 1000) {
    S.clockSkew = target; // first sample, or a real clock jump (phone slept): snap
    S.skewReady = true;
  } else {
    S.clockSkew += (target - S.clockSkew) * 0.2;
  }
}

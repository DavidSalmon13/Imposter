/**
 * Small display formatters shared across games.
 */

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

export function formatCnTimer(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatTsTime(ms) {
  const clamped = Math.max(0, ms);
  return (clamped / 1000).toFixed(3);
}

export function formatTsDistance(ms) {
  if (!Number.isFinite(ms)) return 'DNF';
  return `${(ms / 1000).toFixed(3)}s`;
}

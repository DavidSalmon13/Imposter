/**
 * The token balance pill under the logo (#token-pill in index.html), shown on every
 * screen for a signed-in player while betting is on. Fed from two places: /api/me
 * (shared/account.js's refreshCard - startup, back to lobby, a bet resolving) and the
 * live betting view on Bluff's state broadcasts. `null` = no wallet to show (guest, or
 * betting off) and hides it.
 */
const pill = document.getElementById('token-pill');
const amountEl = document.getElementById('token-pill-amount');

let current = null;

export function setTokenBalance(balance) {
  if (!pill) return;
  if (balance == null) {
    current = null;
    pill.classList.add('hidden');
    return;
  }
  const changed = current !== null && balance !== current;
  const up = balance > current;
  current = balance;
  amountEl.textContent = balance.toLocaleString();
  pill.setAttribute('aria-label', `${balance} token${balance === 1 ? '' : 's'}`);
  pill.classList.remove('hidden');
  if (changed) {
    pill.classList.remove('token-pill-up', 'token-pill-down');
    // Restart the animation when two changes land back to back.
    void pill.offsetWidth;
    pill.classList.add(up ? 'token-pill-up' : 'token-pill-down');
  }
}

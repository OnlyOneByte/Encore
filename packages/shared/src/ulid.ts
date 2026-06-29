// Client-minted ULID — lexicographically sortable, time-prefixed, collision-resistant.
// Generating ids on the CLIENT is what makes optimistic add reconcile with zero flicker:
// the optimistic row already carries its final id, so the server's echo matches by id.
// See docs/reconciliation-contract.md §1.
//
// NOTE: uses Math.random for the entropy section. Fine for queue-entry ids (not security
// tokens). Session tokens are minted server-side with crypto — do not use this for those.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

export function ulid(seedTimeMs?: number): string {
  const time = seedTimeMs ?? Date.now();
  let t = time;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < RAND_LEN; i++) {
    out += ENCODING[Math.floor(Math.random() * 32)];
  }
  return out;
}

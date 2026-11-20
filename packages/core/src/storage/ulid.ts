import type { TodoId } from "./model";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

// Shared by every Store in the process so ids stay ordered across stores.
let lastTime = -1;
let lastRandom: number[] = [];

/** Monotonic ULID: within one millisecond (or if the clock steps back) the random part increments. */
export function nextUlid(timeMs: number): TodoId {
  if (timeMs <= lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = timeMs;
    lastRandom = Array.from(crypto.getRandomValues(new Uint8Array(RANDOM_LEN)), (b) => b & 31);
  }
  let time = "";
  for (let t = lastTime, i = 0; i < TIME_LEN; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  return (time + lastRandom.map((d) => ALPHABET[d]).join("")) as TodoId;
}

function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]!++;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("ULID random component overflowed within one millisecond");
}

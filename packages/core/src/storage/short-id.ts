import { InvalidTodoError, type TodoId } from "./model";

const PREFIX = "t-";
const MIN_LEN = 4;
const SUFFIX = /^[0-9A-HJKMNP-TV-Z]{4,26}$/;

/**
 * Maps each id to `t-` plus its shortest suffix, at least MIN_LEN chars, that no other id ends with.
 * Suffix, not prefix: a ULID starts with its timestamp, so recent ids share their first chars.
 */
export function shortenIds(ids: TodoId[]): Map<TodoId, string> {
  // Sorted by reversed id, the longest suffix an id shares with any other is the one it shares with a neighbor.
  const byEnd = ids.map((id) => ({ id, rev: [...id].reverse().join("") })).sort((a, b) => (a.rev < b.rev ? -1 : 1));
  const shared = (i: number) => commonPrefix(byEnd[i - 1]?.rev ?? "", byEnd[i]?.rev ?? "");
  return new Map(
    byEnd.map(({ id }, i) => {
      const len = Math.max(MIN_LEN, shared(i) + 1, shared(i + 1) + 1);
      return [id, PREFIX + id.slice(-len).toLowerCase()];
    }),
  );
}

/** Accepts `t-<suffix>`, a bare suffix, or a full id, in any case; returns the uppercase suffix to match. */
export function parseIdRef(ref: string): string {
  const suffix = ref.replace(/^t-/i, "").toUpperCase();
  if (!SUFFIX.test(suffix)) {
    throw new InvalidTodoError(
      `Invalid todo id ${JSON.stringify(ref)}: expected a full id, or its last ${MIN_LEN} or more characters with or without ${PREFIX}`,
    );
  }
  return suffix;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && a[n] === b[n]) n++;
  return n;
}

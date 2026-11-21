import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmbiguousIdError, InvalidTodoError, NotFoundError, openStore, type Store, type TodoId } from "@todo/core";

let root: string;
let store: Store;

/** A fixed ULID whose last chars are `end`, so tests can force suffix collisions. */
const idEnding = (end: string) => ("01JD3K7Q9XW2M4V8R5T6Y1Z0AB".slice(0, 26 - end.length) + end) as TodoId;

function writeTodo(id: TodoId) {
  const frontmatter = [
    `id: ${id}`,
    "title: Pulled from git",
    "status: open",
    "created_at: 2026-11-01T09:00:00.000Z",
    "updated_at: 2026-11-01T09:00:00.000Z",
    "created_by: human:someone",
    "updated_by: human:someone",
    "rev: 1",
  ].join("\n");
  writeFileSync(join(root, "todos", `${id}.md`), `---\n${frontmatter}\n---\n`);
}

function ambiguity(ref: string): AmbiguousIdError {
  try {
    store.resolveId(ref);
  } catch (e) {
    if (e instanceof AmbiguousIdError) return e;
    throw e;
  }
  throw new Error(`${ref} resolved`);
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "todo-short-")), ".todo");
  store = openStore(root);
});

afterEach(() => {
  store.close();
  rmSync(join(root, ".."), { recursive: true, force: true });
});

test("short ids are t- and the id's last 4 chars, lowercased", () => {
  const a = store.create({ title: "One" }, "human:cj");
  const b = store.create({ title: "Two" }, "human:cj");
  expect(store.shortIds()).toEqual(
    new Map([
      [a.id, `t-${a.id.slice(-4).toLowerCase()}`],
      [b.id, `t-${b.id.slice(-4).toLowerCase()}`],
    ]),
  );
});

test("ids sharing their last chars each get the shortest suffix no other id ends with", () => {
  const [one, two, three, other] = [idEnding("13FK2"), idEnding("YA3FK2"), idEnding("BA3FK2"), idEnding("WXYZ")];
  for (const id of [one, two, three, other]) writeTodo(id);
  expect(store.shortIds()).toEqual(
    new Map([
      [one, "t-13fk2"],
      [two, "t-ya3fk2"],
      [three, "t-ba3fk2"],
      [other, "t-wxyz"],
    ]),
  );
});

test("a short id shrinks back once the todo it collided with is deleted", () => {
  const [one, two] = [idEnding("13FK2"), idEnding("A3FK2")];
  writeTodo(one);
  writeTodo(two);
  expect(store.shortIds().get(one)).toBe("t-13fk2");
  store.delete(two, "human:cj");
  expect(store.shortIds().get(one)).toBe("t-3fk2");
});

test("resolveId accepts short ids, bare suffixes, and full ids in any case", () => {
  const [one, two] = [idEnding("13FK2"), idEnding("A3FK2")];
  writeTodo(one);
  writeTodo(two);
  const created = store.create({ title: "Fresh" }, "human:cj");

  for (const [id, short] of store.shortIds()) {
    expect(store.resolveId(short)).toBe(id);
    expect(store.resolveId(short.toUpperCase())).toBe(id);
    expect(store.resolveId(short.slice(2))).toBe(id);
  }
  expect(store.resolveId(created.id)).toBe(created.id);
  expect(store.resolveId(created.id.toLowerCase())).toBe(created.id);
  expect(store.resolveId("a3fk2")).toBe(two);
  expect(store.resolveId(one.slice(-8))).toBe(one);
});

test("resolveId rejects a ref several ids end with and lists their short ids", () => {
  const [one, two, three] = [idEnding("13FK2"), idEnding("YA3FK2"), idEnding("BA3FK2")];
  for (const id of [one, two, three]) writeTodo(id);

  const all = ambiguity("t-3fk2");
  expect(all.candidates.toSorted()).toEqual(["t-13fk2", "t-ba3fk2", "t-ya3fk2"]);
  for (const short of all.candidates) expect(all.message).toContain(short);

  expect(ambiguity("A3FK2").candidates.toSorted()).toEqual(["t-ba3fk2", "t-ya3fk2"]);
});

test("resolveId throws NotFoundError when no id ends with the ref", () => {
  store.create({ title: "Only" }, "human:cj");
  expect(() => store.resolveId("t-0000")).toThrow(NotFoundError);
  expect(() => store.resolveId(idEnding("0000"))).toThrow(NotFoundError);
});

test("resolveId throws InvalidTodoError for refs too short or outside Crockford base32", () => {
  for (const bad of ["", "t-", "t-3fk", "3fk", "t-3fku", "3fk!", "t-3fk2 ", "x-3fk2", "0".repeat(27)]) {
    expect(() => store.resolveId(bad)).toThrow(InvalidTodoError);
  }
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type Event,
  InvalidTodoError,
  NotFoundError,
  openStore,
  parseActor,
  RevConflictError,
  type Store,
  type TodoId,
} from "@todo/core";

const cj: Actor = "human:cj";
const claude: Actor = "agent:claude";

let root: string;
let clock: number;
let stores: Store[];

const now = () => new Date(clock);
const tick = (ms = 1000) => {
  clock += ms;
};

function open(): Store {
  const store = openStore(root, { now });
  stores.push(store);
  return store;
}

const todoPath = (id: TodoId) => join(root, "todos", `${id}.md`);

function readTodoFile(id: TodoId): { frontmatter: Record<string, unknown>; keys: string[]; body: string; raw: string } {
  const raw = readFileSync(todoPath(id), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`not a frontmatter file:\n${raw}`);
  const frontmatter = Bun.YAML.parse(match[1]!) as Record<string, unknown>;
  return { frontmatter, keys: Object.keys(frontmatter), body: match[2]!.trim(), raw };
}

function logEvents(): Record<string, Event[]> {
  const dir = join(root, "log");
  if (!existsSync(dir)) return {};
  const byFile: Record<string, Event[]> = {};
  for (const name of readdirSync(dir)) {
    byFile[name] = readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);
  }
  return byFile;
}

const allLogEvents = () => Object.values(logEvents()).flat();

function writeRawTodo(id: string, frontmatter: string, body = "") {
  writeFileSync(join(root, "todos", `${id}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

function bumpMtime(path: string) {
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "todo-store-")), ".todo");
  clock = Date.parse("2026-11-19T10:00:00.000Z");
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.close();
  rmSync(join(root, ".."), { recursive: true, force: true });
});

test("openStore creates the todos and log directories", () => {
  open();
  expect(statSync(join(root, "todos")).isDirectory()).toBe(true);
  expect(statSync(join(root, "log")).isDirectory()).toBe(true);
});

test("parseActor accepts human and agent actors and rejects anything else", () => {
  expect(parseActor("human:cj")).toBe("human:cj");
  expect(parseActor("agent:claude")).toBe("agent:claude");
  for (const bad of ["cj", "robot:x", "human:", "agent:a b", ":cj"]) {
    expect(() => parseActor(bad)).toThrow(InvalidTodoError);
  }
});

test("create writes a readable Markdown file and returns the todo", () => {
  const store = open();
  const todo = store.create(
    {
      title: "Draft architecture doc",
      project: "todo-app",
      tags: ["docs", "planning"],
      due: "2026-11-21",
      priority: 2,
      body: "Free-form notes in Markdown.",
    },
    cj,
  );

  expect(todo.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(todo).toMatchObject({
    title: "Draft architecture doc",
    status: "open",
    project: "todo-app",
    tags: ["docs", "planning"],
    due: "2026-11-21",
    priority: 2,
    created_at: "2026-11-19T10:00:00.000Z",
    updated_at: "2026-11-19T10:00:00.000Z",
    created_by: cj,
    updated_by: cj,
    rev: 1,
    body: "Free-form notes in Markdown.",
  });

  const file = readTodoFile(todo.id);
  expect(file.raw.startsWith("---\n")).toBe(true);
  expect(file.keys).toEqual([
    "id",
    "title",
    "status",
    "project",
    "tags",
    "due",
    "priority",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "rev",
  ]);
  expect(file.frontmatter).toEqual({
    id: todo.id,
    title: "Draft architecture doc",
    status: "open",
    project: "todo-app",
    tags: ["docs", "planning"],
    due: "2026-11-21",
    priority: 2,
    created_at: "2026-11-19T10:00:00.000Z",
    updated_at: "2026-11-19T10:00:00.000Z",
    created_by: cj,
    updated_by: cj,
    rev: 1,
  });
  expect(file.body).toBe("Free-form notes in Markdown.");

  expect(store.get(todo.id)).toEqual(todo);
  expect(store.list()).toEqual([todo]);

  const events = allLogEvents();
  expect(events).toEqual([{ ts: "2026-11-19T10:00:00.000Z", actor: cj, op: "create", id: todo.id, rev: 1 }]);
  expect(store.history(todo.id)).toEqual(events);
});

test("create omits unset optional fields from the file", () => {
  const store = open();
  const todo = store.create({ title: "Bare" }, claude);
  expect(todo.tags).toEqual([]);
  expect(todo.body).toBe("");
  expect(readTodoFile(todo.id).keys).toEqual([
    "id",
    "title",
    "status",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "rev",
  ]);
});

test("titles and tags that look like YAML syntax round-trip as strings", () => {
  const store = open();
  const tricky = { title: "fix: the #1 bug, [urgent]", tags: ["123", "true", "a b", "x,y"], project: "null" };
  const todo = store.create(tricky, cj);
  expect(readTodoFile(todo.id).frontmatter).toMatchObject(tricky);
  store.close();
  rmSync(join(root, ".cache.db"));
  expect(open().get(todo.id)).toMatchObject(tricky);
});

test("create rejects invalid input", () => {
  const store = open();
  expect(() => store.create({ title: "  " }, cj)).toThrow(InvalidTodoError);
  expect(() => store.create({ title: "x", due: "tomorrow" }, cj)).toThrow(InvalidTodoError);
  expect(() => store.create({ title: "x", due: "2026-02-30" }, cj)).toThrow(InvalidTodoError);
  expect(() => store.create({ title: "x", priority: 1.5 }, cj)).toThrow(InvalidTodoError);
  expect(() => store.create({ title: "line\nbreak" }, cj)).toThrow(InvalidTodoError);
  expect(store.list()).toEqual([]);
  expect(allLogEvents()).toEqual([]);
});

test("create with an existing key returns that todo and writes nothing", () => {
  const store = open();
  const first = store.create({ title: "Once", key: "retry-1" }, claude);
  tick();
  const second = store.create({ title: "Once, retried", key: "retry-1" }, claude);

  expect(second).toEqual(first);
  expect(readdirSync(join(root, "todos"))).toEqual([`${first.id}.md`]);
  expect(allLogEvents()).toHaveLength(1);
  expect(readTodoFile(first.id).frontmatter.key).toBe("retry-1");
});

test("update bumps rev, records the actor and logs a field diff", () => {
  const store = open();
  const todo = store.create({ title: "Ship it", tags: ["a"] }, cj);
  tick();
  const updated = store.update(todo.id, { status: "done", tags: ["a", "b"], project: "work" }, claude);

  expect(updated).toMatchObject({
    status: "done",
    tags: ["a", "b"],
    project: "work",
    rev: 2,
    created_by: cj,
    updated_by: claude,
    created_at: "2026-11-19T10:00:00.000Z",
    updated_at: "2026-11-19T10:00:01.000Z",
  });
  expect(readTodoFile(todo.id).frontmatter).toMatchObject({ status: "done", rev: 2, updated_by: claude });
  expect(store.get(todo.id)).toEqual(updated);

  const events = store.history(todo.id);
  expect(events).toHaveLength(2);
  expect(events[1]).toEqual({
    ts: "2026-11-19T10:00:01.000Z",
    actor: claude,
    op: "update",
    id: todo.id,
    rev: 2,
    diff: { status: ["open", "done"], tags: [["a"], ["a", "b"]], project: [null, "work"] },
  });
});

test("update with null clears an optional field", () => {
  const store = open();
  const todo = store.create({ title: "x", project: "p", due: "2026-12-01", priority: 1 }, cj);
  const updated = store.update(todo.id, { project: null, due: null, priority: null }, cj);
  expect(updated.project).toBeUndefined();
  expect(updated.due).toBeUndefined();
  expect(updated.priority).toBeUndefined();
  expect(readTodoFile(todo.id).keys).not.toContain("project");
  expect(store.history(todo.id)[1]!.diff).toEqual({
    project: ["p", null],
    due: ["2026-12-01", null],
    priority: [1, null],
  });
});

test("a patch that changes nothing writes nothing and logs nothing", () => {
  const store = open();
  const todo = store.create({ title: "Same", tags: ["a"] }, cj);
  const before = readFileSync(todoPath(todo.id), "utf8");
  const mtimeBefore = statSync(todoPath(todo.id), { bigint: true }).mtimeNs;
  tick();

  const result = store.update(todo.id, { title: "Same", tags: ["a"] }, claude);

  expect(result).toEqual(todo);
  expect(readFileSync(todoPath(todo.id), "utf8")).toBe(before);
  expect(statSync(todoPath(todo.id), { bigint: true }).mtimeNs).toBe(mtimeBefore);
  expect(allLogEvents()).toHaveLength(1);
});

test("update with a stale ifRev throws RevConflictError and leaves the file alone", () => {
  const store = open();
  const todo = store.create({ title: "Contested" }, cj);
  store.update(todo.id, { title: "Changed by human" }, cj);
  const before = readFileSync(todoPath(todo.id), "utf8");

  let error: unknown;
  try {
    store.update(todo.id, { status: "done" }, claude, { ifRev: 1 });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RevConflictError);
  expect(error).toMatchObject({ expected: 1, actual: 2 });
  expect(readFileSync(todoPath(todo.id), "utf8")).toBe(before);
  expect(allLogEvents()).toHaveLength(2);

  expect(store.update(todo.id, { status: "done" }, claude, { ifRev: 2 }).rev).toBe(3);
});

test("update and delete of a missing todo throw NotFoundError", () => {
  const store = open();
  const ghost = "01JD3K7Q9XW2M4V8R5T6Y1Z0AB" as TodoId;
  expect(() => store.get(ghost)).toThrow(NotFoundError);
  expect(() => store.update(ghost, { title: "x" }, cj)).toThrow(NotFoundError);
  expect(() => store.delete(ghost, cj)).toThrow(NotFoundError);
});

test("delete removes the file and keeps the history", () => {
  const store = open();
  const todo = store.create({ title: "Doomed" }, cj);
  tick();
  store.delete(todo.id, claude);

  expect(existsSync(todoPath(todo.id))).toBe(false);
  expect(() => store.get(todo.id)).toThrow(NotFoundError);
  expect(store.list()).toEqual([]);
  expect(store.history(todo.id).map((e) => [e.op, e.actor, e.rev])).toEqual([
    ["create", cj, 1],
    ["delete", claude, 1],
  ]);
});

test("delete with a stale ifRev throws RevConflictError and keeps the file", () => {
  const store = open();
  const todo = store.create({ title: "Keep" }, cj);
  store.update(todo.id, { title: "Kept" }, cj);
  expect(() => store.delete(todo.id, claude, { ifRev: 1 })).toThrow(RevConflictError);
  expect(existsSync(todoPath(todo.id))).toBe(true);
});

test("list filters by status, project and all-of tags", () => {
  const store = open();
  const a = store.create({ title: "a", project: "work", tags: ["urgent", "x"] }, cj);
  const b = store.create({ title: "b", project: "work", tags: ["x"], status: "done" }, cj);
  const c = store.create({ title: "c", project: "home", tags: ["urgent"], status: "cancelled" }, cj);
  const ids = (filter: Parameters<Store["list"]>[0]) => store.list(filter).map((t) => t.id);

  expect(ids({})).toEqual([a.id, b.id, c.id]);
  expect(ids({ status: "open" })).toEqual([a.id]);
  expect(ids({ status: ["done", "cancelled"] })).toEqual([b.id, c.id]);
  expect(ids({ project: "work" })).toEqual([a.id, b.id]);
  expect(ids({ tags: ["x"] })).toEqual([a.id, b.id]);
  expect(ids({ tags: ["urgent", "x"] })).toEqual([a.id]);
  expect(ids({ project: "work", status: "done", tags: ["x"] })).toEqual([b.id]);
  expect(ids({ tags: ["nope"] })).toEqual([]);
});

test("ids sort in creation order, even within one millisecond", () => {
  const store = open();
  const created = Array.from({ length: 50 }, (_, i) => store.create({ title: `t${i}` }, cj).id);
  expect([...created].sort()).toEqual(created);
  expect(new Set(created).size).toBe(50);
});

test("a hand edit to a file shows up in get and list", () => {
  const store = open();
  const todo = store.create({ title: "Original", tags: ["a"] }, cj);
  store.list();

  const path = todoPath(todo.id);
  writeFileSync(path, readFileSync(path, "utf8").replace("title: Original", "title: Edited by hand"));
  bumpMtime(path);

  expect(store.get(todo.id).title).toBe("Edited by hand");
  expect(store.list({ tags: ["a"] }).map((t) => t.title)).toEqual(["Edited by hand"]);
});

test("a file deleted outside the store disappears from list", () => {
  const store = open();
  const keep = store.create({ title: "keep" }, cj);
  const gone = store.create({ title: "gone" }, cj);
  store.list();

  rmSync(todoPath(gone.id));

  expect(store.list().map((t) => t.id)).toEqual([keep.id]);
  expect(() => store.get(gone.id)).toThrow(NotFoundError);
});

test("a file dropped in from outside appears in list", () => {
  const store = open();
  store.list();
  const id = "01JD3K7Q9XW2M4V8R5T6Y1Z0AB";
  writeRawTodo(
    id,
    [
      `id: ${id}`,
      "title: Pulled from git",
      "status: open",
      "project: todo-app",
      "tags: [docs]",
      "created_at: 2026-11-01T09:00:00.000Z",
      "updated_at: 2026-11-02T09:00:00.000Z",
      "created_by: human:someone",
      "updated_by: agent:other",
      "rev: 3",
    ].join("\n"),
    "Body from elsewhere.\n",
  );

  expect(store.list({ project: "todo-app" })).toEqual([
    {
      id: id as TodoId,
      title: "Pulled from git",
      status: "open",
      project: "todo-app",
      tags: ["docs"],
      created_at: "2026-11-01T09:00:00.000Z",
      updated_at: "2026-11-02T09:00:00.000Z",
      created_by: "human:someone",
      updated_by: "agent:other",
      rev: 3,
      body: "Body from elsewhere.",
    },
  ]);
});

test("an invalid file is reported by reconcile and left out of list", () => {
  const store = open();
  const good = store.create({ title: "good" }, cj);
  const badId = "01JD3K7Q9XW2M4V8R5T6Y1Z0AB";
  writeRawTodo(badId, `id: ${badId}\ntitle: [unclosed\nstatus: open`);
  writeFileSync(join(root, "todos", "01JD3K7Q9XW2M4V8R5T6Y1Z0AC.md"), "no frontmatter at all");

  const result = store.reconcile();
  expect(result.invalid.map((i) => i.path.split("/").pop()).sort()).toEqual([
    `${badId}.md`,
    "01JD3K7Q9XW2M4V8R5T6Y1Z0AC.md",
  ]);
  for (const entry of result.invalid) expect(entry.error).not.toBe("");

  expect(store.list().map((t) => t.id)).toEqual([good.id]);
  expect(() => store.get(badId as TodoId)).toThrow(NotFoundError);
  expect(store.reconcile().invalid).toHaveLength(2);
});

test("a file that becomes invalid drops out of the index", () => {
  const store = open();
  const todo = store.create({ title: "fine" }, cj);
  store.list();
  writeFileSync(todoPath(todo.id), "---\nbroken: [\n---\n");
  bumpMtime(todoPath(todo.id));

  expect(store.list()).toEqual([]);
  expect(store.reconcile().invalid).toHaveLength(1);
});

test("a second reconcile with no changes indexes nothing", () => {
  const store = open();
  store.create({ title: "a" }, cj);
  store.create({ title: "b" }, cj);
  expect(store.reconcile()).toEqual({ indexed: 0, removed: 0, invalid: [] });
});

test("reindex rebuilds the whole index from the files", () => {
  const store = open();
  const a = store.create({ title: "a" }, cj);
  store.update(a.id, { status: "done" }, claude);
  store.create({ title: "b" }, cj);

  expect(store.reindex()).toEqual({ indexed: 2, removed: 0, invalid: [] });
  expect(store.list().map((t) => t.title)).toEqual(["a", "b"]);
  expect(store.history(a.id).map((e) => e.op)).toEqual(["create", "update"]);
});

test("deleting the cache keeps all data", () => {
  let store = open();
  const todo = store.create({ title: "survivor", tags: ["t"] }, cj);
  store.update(todo.id, { status: "done" }, claude);
  const expected = store.get(todo.id);
  store.close();

  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, `.cache.db${suffix}`), { force: true });

  store = open();
  expect(store.get(todo.id)).toEqual(expected);
  expect(store.list({ tags: ["t"] })).toEqual([expected]);
  expect(store.history(todo.id).map((e) => e.op)).toEqual(["create", "update"]);
});

test("a corrupt cache is rebuilt on open", () => {
  let store = open();
  const todo = store.create({ title: "survivor" }, cj);
  store.close();

  for (const suffix of ["-wal", "-shm"]) rmSync(join(root, `.cache.db${suffix}`), { force: true });
  writeFileSync(join(root, ".cache.db"), "this is not a sqlite database".repeat(100));

  store = open();
  expect(store.get(todo.id)).toEqual(todo);
  expect(store.history(todo.id)).toHaveLength(1);
});

test("history merges every actor's log in timestamp order", () => {
  const store = open();
  const todo = store.create({ title: "shared" }, cj);
  tick();
  store.update(todo.id, { status: "done" }, claude);
  tick();
  store.update(todo.id, { status: "open" }, cj);

  const files = logEvents();
  expect(Object.keys(files)).toHaveLength(2);
  for (const events of Object.values(files)) {
    expect(new Set(events.map((e) => e.actor)).size).toBe(1);
  }

  expect(store.history(todo.id).map((e) => [e.ts, e.actor, e.op, e.rev])).toEqual([
    ["2026-11-19T10:00:00.000Z", cj, "create", 1],
    ["2026-11-19T10:00:01.000Z", claude, "update", 2],
    ["2026-11-19T10:00:02.000Z", cj, "update", 3],
  ]);
});

test("history picks up log lines appended by another writer", () => {
  const store = open();
  const todo = store.create({ title: "x" }, cj);
  store.history(todo.id);

  const foreign: Event = { ts: "2026-11-19T11:00:00.000Z", actor: "agent:other", op: "update", id: todo.id, rev: 2 };
  writeFileSync(join(root, "log", "agent-other.jsonl"), `${JSON.stringify(foreign)}\n`);

  expect(store.history(todo.id).map((e) => e.actor)).toEqual([cj, "agent:other"]);
});

test("history follows a log file rewritten shorter, as after a git checkout", () => {
  const store = open();
  const todo = store.create({ title: "x" }, cj);
  store.update(todo.id, { title: "y" }, cj);
  expect(store.history(todo.id)).toHaveLength(2);

  const [name, events] = Object.entries(logEvents())[0]!;
  writeFileSync(join(root, "log", name), `${JSON.stringify(events[0])}\n`);

  expect(store.history(todo.id).map((e) => e.op)).toEqual(["create"]);
});

test("two stores reconciling the same log lines at once record each event once", () => {
  const a = open();
  const b = open();
  const todo = a.create({ title: "x" }, cj);

  // Let b reconcile while a has read the log but not yet recorded what it read.
  const readSync = fs.readSync;
  let interleaved = false;
  const spy = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => {
    if (!interleaved) {
      interleaved = true;
      b.reconcile();
    }
    return readSync(...args);
  }) as typeof readSync);
  try {
    a.reconcile();
  } finally {
    spy.mockRestore();
  }

  expect(interleaved).toBe(true);
  expect(a.history(todo.id).map((e) => e.op)).toEqual(["create"]);
});

test("two stores on the same root see each other's writes", () => {
  const a = open();
  const b = open();

  const todo = a.create({ title: "from a" }, cj);
  expect(b.get(todo.id)).toEqual(todo);

  const updated = b.update(todo.id, { status: "done" }, claude, { ifRev: 1 });
  expect(a.get(todo.id)).toEqual(updated);
  expect(a.list({ status: "done" })).toEqual([updated]);
  expect(a.history(todo.id).map((e) => e.actor)).toEqual([cj, claude]);

  expect(() => a.update(todo.id, { title: "stale" }, cj, { ifRev: 1 })).toThrow(RevConflictError);

  b.delete(todo.id, claude);
  expect(a.list()).toEqual([]);
});

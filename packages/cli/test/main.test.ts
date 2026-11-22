import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const entry = new URL("../src/main.ts", import.meta.url).pathname;

let home: string;
let storeDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "todo-cli-"));
  storeDir = join(home, "store");
});

type Env = Record<string, string | undefined>;

// A minimal env, so the caller's CLAUDECODE, TODO_ACTOR or ~/.todo never leak in.
// Pipes make stdout a non-TTY, so JSON is the default. stdin stays open and
// unwritten so a command that waits for input would hang until the test times out.
async function todoWith(env: Env, ...args: string[]) {
  const merged: Env = { PATH: process.env.PATH, HOME: home, TODO_DIR: storeDir, USER: "tester", ...env };
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: home,
    env: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, json: () => JSON.parse(stdout) };
}

const todo = (...args: string[]) => todoWith({}, ...args);

const titles = (todos: { title: string }[]) => todos.map((t) => t.title).sort();

const idEnding = (end: string) => "01JD3K7Q9XW2M4V8R5T6Y1Z0AB".slice(0, 26 - end.length) + end;

function writeTodoFile(id: string, status = "open") {
  mkdirSync(join(storeDir, "todos"), { recursive: true });
  const frontmatter = [
    `id: ${id}`,
    "title: Pulled from git",
    `status: ${status}`,
    "created_at: 2026-11-01T09:00:00.000Z",
    "updated_at: 2026-11-01T09:00:00.000Z",
    "created_by: human:someone",
    "updated_by: human:someone",
    "rev: 1",
  ].join("\n");
  writeFileSync(join(storeDir, "todos", `${id}.md`), `---\n${frontmatter}\n---\n`);
}

test("add prints the new todo with its short id, and ls and show return it", async () => {
  const added = await todo("add", "Buy", "milk", "--project", "home", "--tags", "errand,food", "--due", "2026-12-01", "--priority", "2", "--body", "Oat");
  expect(added.exitCode).toBe(0);
  const created = added.json();
  expect(created).toMatchObject({
    title: "Buy milk",
    status: "open",
    project: "home",
    tags: ["errand", "food"],
    due: "2026-12-01",
    priority: 2,
    body: "Oat",
    rev: 1,
    created_by: "human:tester",
  });
  expect(created.short_id).toBe(`t-${created.id.slice(-4).toLowerCase()}`);

  const listed = await todo("ls");
  expect(listed.exitCode).toBe(0);
  expect(listed.json()).toEqual([created]);

  const shown = await todo("show", created.short_id);
  expect(shown.exitCode).toBe(0);
  expect(shown.json()).toEqual(created);
});

test("show accepts the bare suffix and the full id", async () => {
  const { id } = (await todo("add", "Call mom")).json();
  expect((await todo("show", id.slice(-4))).json().id).toBe(id);
  expect((await todo("show", id)).json().id).toBe(id);
});

test("add --key returns the existing todo on retry", async () => {
  const first = (await todo("add", "Once", "--key", "k1")).json();
  const second = (await todo("add", "Once again", "--key", "k1")).json();
  expect(second.id).toBe(first.id);
  expect((await todo("ls")).json()).toHaveLength(1);
});

test("ls filters by status, project and tags", async () => {
  await todo("add", "Home thing", "--project", "home", "--tags", "a,b");
  await todo("add", "Work thing", "--project", "work", "--tags", "a");
  await todo("add", "Shelved", "--project", "home");
  writeTodoFile(idEnding("D0NE"), "done");
  const ls = async (...args: string[]) => titles((await todo("ls", ...args)).json());

  expect(await ls()).toEqual(["Home thing", "Shelved", "Work thing"]);
  expect(await ls("--status", "done")).toEqual(["Pulled from git"]);
  expect(await ls("--status", "all")).toHaveLength(4);
  expect(await ls("--project", "home")).toEqual(["Home thing", "Shelved"]);
  expect(await ls("--tags", "a,b")).toEqual(["Home thing"]);
});

test("--dir beats TODO_DIR", async () => {
  const other = join(home, "other");
  await todo("add", "In TODO_DIR");
  await todo("add", "In --dir", "--dir", other);
  expect(titles((await todo("ls")).json())).toEqual(["In TODO_DIR"]);
  expect(titles((await todo("ls", "--dir", other)).json())).toEqual(["In --dir"]);
});

test("the actor comes from --as, then TODO_ACTOR, then USER", async () => {
  expect((await todoWith({ TODO_ACTOR: "agent:bot" }, "add", "A", "--as", "agent:flag")).json().created_by).toBe("agent:flag");
  expect((await todoWith({ TODO_ACTOR: "agent:bot" }, "add", "B")).json().created_by).toBe("agent:bot");
  expect((await todo("add", "C")).json().created_by).toBe("human:tester");
});

test("an invalid --as exits 2 with code invalid and writes nothing", async () => {
  const { stderr, exitCode } = await todo("add", "A", "--as", "robot");
  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "invalid" } });
  expect((await todo("ls")).json()).toEqual([]);
});

test("read commands need no actor", async () => {
  const { id } = (await todo("add", "Mine")).json();
  const env = { USER: undefined };
  expect((await todoWith(env, "ls")).exitCode).toBe(0);
  expect((await todoWith(env, "show", id)).exitCode).toBe(0);
  const write = await todoWith(env, "add", "Nobody");
  expect(write.exitCode).toBe(2);
  expect(JSON.parse(write.stderr)).toMatchObject({ error: { code: "invalid" } });
});

test("an unknown id exits 3 with code not_found", async () => {
  const { stdout, stderr, exitCode } = await todo("show", "t-zzzz");
  expect(exitCode).toBe(3);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "not_found" } });
});

test("an ambiguous id exits 4 with the candidates", async () => {
  writeTodoFile(idEnding("A3FK2"));
  writeTodoFile(idEnding("B3FK2"));
  const { stderr, exitCode } = await todo("show", "3fk2");
  expect(exitCode).toBe(4);
  const { error } = JSON.parse(stderr);
  expect(error.code).toBe("ambiguous");
  expect(error.candidates.sort()).toEqual(["t-a3fk2", "t-b3fk2"]);
});

test("invalid flag values exit 2", async () => {
  for (const [code, ...args] of [
    ["usage", "add", "A", "--priority", "high"],
    ["usage", "ls", "--status", "later"],
    ["usage", "add"],
    ["invalid", "add", "A", "--due", "2026-02-30"],
  ]) {
    const { stderr, exitCode } = await todo(...args);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr).error.code).toBe(code!);
  }
});

test("an unknown command exits 2 with a usage error on stderr", async () => {
  const { stdout, stderr, exitCode } = await todo("nope");
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "usage" } });
});

test("an unknown option exits 2 with a usage error on stderr", async () => {
  const { stderr, exitCode } = await todo("ls", "--stauts", "done");
  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "usage" } });
});

test("--version prints the package version", async () => {
  const { stdout, exitCode } = await todo("--version");
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(pkg.version);
});

test("bare todo without a TTY prints usage and exits without reading stdin", async () => {
  const { stdout, exitCode } = await todo();
  expect(exitCode).toBe(0);
  expect(stdout).toContain("USAGE");
  expect(stdout).toContain("add");
});

test("show with more than one id exits 2 instead of ignoring the rest", async () => {
  const { stderr, exitCode } = await todo("show", "t-aaaa", "t-bbbb");
  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "usage" } });
});

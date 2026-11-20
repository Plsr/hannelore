import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStore } from "@todo/core";

let base: string;
let home: string;
let cwd: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "todo-discover-")));
  home = join(base, "home");
  cwd = join(base, "work", "repo", "src");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test("the flag wins over the env var and a local store", () => {
  mkdirSync(join(cwd, ".todo"));
  expect(findStore({ cwd, home, dir: "/flag", envDir: "/env" })).toEqual({ root: "/flag", source: "flag" });
});

test("the env var wins over a local store", () => {
  mkdirSync(join(cwd, ".todo"));
  expect(findStore({ cwd, home, envDir: "/env" })).toEqual({ root: "/env", source: "env" });
});

test("relative flag and env paths resolve against cwd", () => {
  expect(findStore({ cwd, home, dir: "../store" })).toEqual({ root: join(base, "work", "repo", "store"), source: "flag" });
  expect(findStore({ cwd, home, envDir: "store" })).toEqual({ root: join(cwd, "store"), source: "env" });
});

test("an empty env var counts as unset", () => {
  mkdirSync(join(cwd, ".todo"));
  expect(findStore({ cwd, home, envDir: "" })).toEqual({ root: join(cwd, ".todo"), source: "local" });
});

test("finds a .todo directory in an ancestor", () => {
  mkdirSync(join(base, "work", ".todo"));
  expect(findStore({ cwd, home })).toEqual({ root: join(base, "work", ".todo"), source: "local" });
});

test("the nearest .todo directory wins", () => {
  mkdirSync(join(base, "work", ".todo"));
  mkdirSync(join(base, "work", "repo", ".todo"));
  expect(findStore({ cwd, home })).toEqual({ root: join(base, "work", "repo", ".todo"), source: "local" });
});

test("a plain file named .todo is skipped", () => {
  writeFileSync(join(base, "work", "repo", ".todo"), "");
  mkdirSync(join(base, "work", ".todo"));
  expect(findStore({ cwd, home })).toEqual({ root: join(base, "work", ".todo"), source: "local" });
});

test("falls back to the global store in home", () => {
  expect(findStore({ cwd, home })).toEqual({ root: join(home, ".todo"), source: "global" });
});

test("finding the home store by walking up reports it as global", () => {
  const inHome = join(home, "projects", "app");
  mkdirSync(inHome, { recursive: true });
  mkdirSync(join(home, ".todo"));
  expect(findStore({ cwd: inHome, home })).toEqual({ root: join(home, ".todo"), source: "global" });
});

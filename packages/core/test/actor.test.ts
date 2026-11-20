import { expect, test } from "bun:test";
import { InvalidTodoError, resolveActor } from "@todo/core";

const all = { TODO_ACTOR: "agent:env", CLAUDECODE: "1", USER: "cj" };

test("the flag wins over everything else", () => {
  expect(resolveActor({ flag: "human:flag", env: all })).toEqual({ actor: "human:flag", source: "flag" });
});

test("TODO_ACTOR wins over agent detection and USER", () => {
  expect(resolveActor({ env: all })).toEqual({ actor: "agent:env", source: "env" });
});

test("a known agent wins over USER", () => {
  expect(resolveActor({ env: { CLAUDECODE: "1", USER: "cj" } })).toEqual({ actor: "agent:claude", source: "agent" });
});

test("falls back to USER as a human", () => {
  expect(resolveActor({ env: { USER: "cj" } })).toEqual({ actor: "human:cj", source: "user" });
});

test("an invalid flag throws instead of falling through", () => {
  expect(() => resolveActor({ flag: "cj", env: all })).toThrow(InvalidTodoError);
  expect(() => resolveActor({ flag: "", env: all })).toThrow(InvalidTodoError);
});

test("an invalid TODO_ACTOR throws instead of falling through", () => {
  expect(() => resolveActor({ env: { ...all, TODO_ACTOR: "robot:x" } })).toThrow(/TODO_ACTOR/);
});

test("an empty TODO_ACTOR counts as unset", () => {
  expect(resolveActor({ env: { ...all, TODO_ACTOR: "" } })).toEqual({ actor: "agent:claude", source: "agent" });
});

test("CLAUDECODE only matches when it is 1", () => {
  for (const CLAUDECODE of ["0", "true", ""]) {
    expect(resolveActor({ env: { CLAUDECODE, USER: "cj" } })).toEqual({ actor: "human:cj", source: "user" });
  }
});

test("a missing, empty or invalid USER throws and points to --as and TODO_ACTOR", () => {
  for (const env of [{}, { USER: "" }, { USER: "c j" }]) {
    expect(() => resolveActor({ env })).toThrow(/--as.*TODO_ACTOR/);
  }
});

import { expect, test } from "bun:test";
import { greet } from "@todo/core";

test("greets the world by default", () => {
  expect(greet()).toEqual({ message: "Hello, world!" });
});

test("greets a named person", () => {
  expect(greet("Ada")).toEqual({ message: "Hello, Ada!" });
});

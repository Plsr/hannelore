import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

const entry = new URL("../src/main.ts", import.meta.url).pathname;

// Pipes make stdout a non-TTY, so JSON is the default. stdin stays open and
// unwritten so a command that waits for input would hang until the test times out.
async function todo(...args: string[]) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("hello prints the greeting as JSON when stdout is not a TTY", async () => {
  const { stdout, exitCode } = await todo("hello");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ message: "Hello, world!" });
});

test("hello --name greets that name", async () => {
  const { stdout, exitCode } = await todo("hello", "--name", "Ada");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ message: "Hello, Ada!" });
});

test("hello --json prints JSON", async () => {
  const { stdout, exitCode } = await todo("hello", "--json");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ message: "Hello, world!" });
});

test("an unknown command exits 2 with a usage error on stderr", async () => {
  const { stdout, stderr, exitCode } = await todo("nope");
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({ error: { code: "usage" } });
});

test("an unknown option exits 2 with a usage error on stderr", async () => {
  const { stderr, exitCode } = await todo("hello", "--nmae", "Ada");
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
  expect(stdout).toContain("hello");
});

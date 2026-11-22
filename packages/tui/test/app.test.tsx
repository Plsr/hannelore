import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";
import { App } from "@todo/tui";

let setup: TestRendererSetup | undefined;

afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

test("shows the title and the quit hint", async () => {
  setup = await testRender(() => <App />, { width: 40, height: 10 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("todo");
  expect(frame).toContain("q to quit");
});

test("q closes the renderer", async () => {
  setup = await testRender(() => <App />, { width: 40, height: 10 });
  setup.mockInput.pressKey("q");
  await setup.renderer.closed;
  expect(setup.renderer.isDestroyed).toBe(true);
});

test("Ctrl+C closes the renderer", async () => {
  setup = await testRender(() => <App />, { width: 40, height: 10 });
  setup.mockInput.pressKey("c", { ctrl: true });
  await setup.renderer.closed;
  expect(setup.renderer.isDestroyed).toBe(true);
});

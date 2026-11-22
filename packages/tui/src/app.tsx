import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard, useRenderer } from "@opentui/solid";

export function App() {
  const renderer = useRenderer();
  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) renderer.destroy();
  });
  return (
    <box flexDirection="column" padding={1}>
      <text>todo</text>
      <text fg="#808080">q to quit</text>
    </box>
  );
}

export async function runTui(): Promise<void> {
  // Ctrl+C goes through the same keyboard handler as q instead of OpenTUI's process.exit.
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  await render(() => <App />, renderer);
  await renderer.closed;
}

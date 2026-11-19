import solidPlugin from "../packages/tui/build-plugin";

const result = await Bun.build({
  entrypoints: ["packages/cli/src/main.ts"],
  plugins: [solidPlugin],
  minify: true,
  // The repo's bunfig preloads the dev-time Solid transform; the binary is already transformed.
  compile: { outfile: "dist/todo", autoloadBunfig: false },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

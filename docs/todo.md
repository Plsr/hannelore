# Todo

## Tech debt

### Startup cost

Measured on the hello-world scaffold. The architecture targets roughly 10–20ms startup.

- **Source runs (~197ms per command).** `bunfig.toml` preloads OpenTUI's Solid JSX transform, which loads Babel on every `bun run todo`, including non-TUI commands that agents run. Without the preload a command takes ~74ms. Fix: register the transform only right before the dynamic TUI import, with a build-time define so Babel stays out of the compiled binary.
- **Compiled binary (~92ms against ~73ms for an empty Bun binary).** The dynamic `import()` does not keep OpenTUI out of the single bundle, so its code is likely parsed at startup (unprofiled guess). Fix: profile first, then split or lazy-load the TUI code.

# todo

Terminal to-do app for humans and agents. The design lives in `docs/architecture.md`.

Bun workspace, TypeScript strict, ESM. Bun is at `~/.bun/bin/bun`.

- `packages/core`: all behavior and domain types. No argv, env or terminal access.
- `packages/cli`: the `todo` entry (citty). The only place that parses argv and env.
- `packages/tui`: OpenTUI + Solid, loaded with a dynamic `import()` only when the TUI launches.

## Commands

```sh
bun install
bun run todo <args>    # run the CLI from source
bun test               # all packages
bun run typecheck      # tsc, no emit
bun run build          # single binary at dist/todo
```

`bunfig.toml` preloads OpenTUI's Solid JSX transform for source runs and tests. The build applies the same transform as a plugin, so the binary needs no preload.

## Agent CLI contract

- `todo hello [--name <n>]` prints `Hello, <n>!`. `<n>` defaults to `world`.
- `--json` prints `{"message":"Hello, <n>!"}`. JSON is also the default when stdout is not a TTY.
- Exit codes: `0` success, `2` usage error (unknown command, unknown option, missing value), `1` internal error.
- Errors go to stderr. In JSON mode they are `{"error":{"code":"usage"|"internal","message":"..."}}`.
- `todo --version` prints the version. `todo --help` and `todo <command> --help` print usage.
- Bare `todo` launches the TUI only when stdin and stdout are both TTYs. Otherwise it prints usage and exits 0.
- No command ever prompts or reads stdin.

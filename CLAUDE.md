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

- `todo add <title...> [--project p] [--tags a,b] [--due YYYY-MM-DD] [--priority n] [--body text] [--key k]` creates a todo. A repeated `--key` returns the existing todo.
- `todo ls [--status open|done|cancelled|all] [--project p] [--tags a,b]` lists todos, open ones by default. `--tags` matches todos that have all of them.
- `todo show <id>` prints one todo.
- `todo edit <id> [--title t] [--status open|done|cancelled] [--project p] [--tags a,b] [--due d] [--priority n] [--body text] [--clear project,due,priority]` changes the given fields. `--tags` replaces the tags. Editing with no field option is a usage error.
- `todo done <id>` sets the status to done. `todo rm <id>` deletes the todo and prints `{"id","short_id","deleted":true}`. `todo history <id>` prints its events, oldest first.
- `edit`, `done` and `rm` take `--if-rev <n>` and fail with `conflict` unless the todo is at that rev.
- `<id>` is a short id (`t-3fk2`), its suffix without `t-`, or the full ULID.
- Every store command takes `--dir <path>`. The store is the first of `--dir`, `$TODO_DIR`, the nearest `.todo/` above the cwd, `~/.todo`.
- Write commands take `--as <actor>` (`human:<name>` or `agent:<name>`). Without it the actor is `$TODO_ACTOR`, a known agent (`CLAUDECODE=1` is `agent:claude`), then `human:$USER`. Read commands never need an actor.
- `--json` prints JSON. JSON is also the default when stdout is not a TTY. A todo is the stored todo plus `short_id`. `ls` prints an array.
- Errors go to stderr. In JSON mode they are `{"error":{"code":"...","message":"..."}}`. Codes and exit statuses:

  | code | exit | when |
  | --- | --- | --- |
  | `usage` | 2 | unknown command or option, missing or malformed value |
  | `invalid` | 2 | a value core rejects: bad date, actor or id |
  | `not_found` | 3 | no todo with that id |
  | `ambiguous` | 4 | the id matches several todos; `candidates` lists their short ids |
  | `conflict` | 5 | the todo changed since the given rev |
  | `internal` | 1 | anything else |

- `todo --version` prints the version. `todo --help` and `todo <command> --help` print usage.
- Bare `todo` launches the TUI only when stdin and stdout are both TTYs. Otherwise it prints usage and exits 0.
- No command ever prompts or reads stdin.

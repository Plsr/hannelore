# Architecture

A to-do app that lives entirely in the terminal and that humans and agents operate side by side.

Goals:

1. Very fast and responsive.
2. CLI-only: a scriptable command line plus an interactive TUI.
3. A first-class interface for agents, with clear attribution of who changed what.
4. Storage that is fast, but also plain-text, exportable and versionable with git. No database server.
5. Projects and tags on to-dos, with filtering and saved views.

## Runtime: Bun

For a CLI, perceived speed is dominated by process startup. Bun starts in roughly 10–20ms against 40–60ms for Node.

- `bun:sqlite` is built into the runtime: no native module, no node-gyp, and it benchmarks around 2x faster than `better-sqlite3`.
- `bun build --compile` produces a single self-contained binary for distribution.
- OpenTUI, the TUI library chosen below, resolves its native core fastest on Bun.

Trade-off: compiled Bun binaries are about 50MB. The fallback, if Bun ever becomes a problem, is Node with `better-sqlite3` and Ink, at the cost of startup time and render performance.

## Storage

Plain-text files are the source of truth. A local SQLite database is a disposable index over them. There is no database server.

```
.todo/
  todos/<ulid>.md        # one file per to-do: YAML frontmatter + Markdown body
  log/<actor>.jsonl      # append-only audit log, one file per actor
  views.toml             # saved views
  config.toml
  .cache.db              # SQLite index, gitignored, rebuildable
  .gitignore             # ignores .cache.db*
```

Exporting is copying the directory. Versioning is git.

### Store location

The first match wins:

1. `--dir <path>`
2. `TODO_DIR`, ignored when empty
3. The nearest `.todo/` directory in the working directory or one of its ancestors. A plain file named `.todo` is skipped.
4. `~/.todo`, the global store

Relative paths in `--dir` and `TODO_DIR` resolve against the working directory. `mkdir .todo` in a repo gives it its own store. A `.todo/` found by walking up that is `~/.todo` still counts as the global store.

Opening a store creates any missing directories and writes `.todo/.gitignore` if there is none, so the index stays out of git in any repo. An existing `.gitignore` is left alone.

### To-do files

Each to-do is one Markdown file named by its ULID, which never changes. The CLI and TUI display a short ID such as `t-3fk2`, made of `t-` and the shortest suffix of the ULID, at least 4 characters, that no other to-do's ULID ends with. It is a suffix because the first 10 characters of a ULID are its timestamp, so to-dos made in the same few days share a prefix. Commands accept a short ID, the suffix without `t-`, or the full ULID, in any case.

Fields are always written in the order below, and unset optional fields (`project`, `tags`, `due`, `priority`, and the idempotency `key`) are left out.

```markdown
---
id: 01JD3K7Q9XW2M4V8R5T6Y1Z0AB
title: Draft architecture doc
status: open
project: todo-app
tags: [docs, planning]
due: 2026-11-21
priority: 2
created_at: 2026-11-18T09:12:44.512Z
updated_at: 2026-11-19T10:42:01.123Z
created_by: human:cj
updated_by: agent:claude
rev: 4
---

Free-form notes in Markdown.
```

One file per to-do keeps files hand-editable, git diffs small, and concurrent writers on different to-dos from ever touching the same file.

All writes are atomic: write to a temp file in the same directory, then rename over the target.

### Audit log

Every mutation appends one line to `log/<actor>.jsonl`, with the colon in the actor written as a dash (`log/agent-claude.jsonl`). Actor names are limited to letters, digits, `.`, `_` and `-`, so every actor maps to a safe file name:

```json
{"ts":"2026-11-19T10:42:01.123Z","actor":"agent:claude","op":"update","id":"01JD3K…","rev":4,"diff":{"status":["open","done"]}}
```

Each actor only ever appends to its own file, so log files cannot merge-conflict. The log answers "who changed what" without walking git history. The to-do files remain the source of truth for current state; the log is the history.

### SQLite index

`.cache.db` is gitignored and can be deleted at any time.

Schema:

- `todos`: one row per to-do, with indexed columns for `project`, `status`, `due` and `priority`
- `todo_tags(todo_id, tag)`: tag filters become index lookups
- `todos_fts`: FTS5 over title and body
- `events`: the audit log, indexed by to-do and actor
- `files(path, mtime_ns, size)`: the state of each source file when it was last indexed
- `logs(source, offset, ino, tail)`: how far each log file has been read, its inode, and the bytes just before that offset
- `meta`: schema version

Every command reconciles the index before running its query:

1. Open the database in WAL mode with a busy timeout, so a running TUI and agent commands do not block each other.
2. List `todos/` and stat every file. Compare `mtime_ns` and `size` against the `files` table.
3. In a single transaction, parse and upsert new or changed files, and delete rows whose file is gone.
4. For each `log/*.jsonl`, compare its size against the stored offset and parse only the appended bytes. A new inode, a shorter file, or changed bytes before the offset mean the file was rewritten (git checkout, editor save), so it is read again from the start. The new offset is recorded only if no other process moved it in the meantime.
5. Run the query as SQL.

When nothing changed, step 3 is a no-op. A command then costs startup, the stat pass and a single query.

When the tool writes, it does the atomic file write and then updates the index row and the `files` entry in the same step, so the next reconcile finds nothing to do.

Other cases:

- **Hand edits, `git pull`, branch switches** change mtimes and are picked up by the next reconcile. No hooks or watchers are required.
- **Schema version change or corrupt index**: delete and rebuild from the files.
- **Live TUI**: `fs.watch` on `.todo/` triggers the same reconcile, so an agent's changes appear in the human's TUI immediately.
- **Concurrent reconciles** are safe because upserts are idempotent.
- **A file that fails to parse** is left out of the index and reported by every reconcile until it is fixed. It never breaks a listing.
- **An edit that leaves mtime and size unchanged** is missed. This is practically impossible with nanosecond mtimes on APFS. `todo reindex` forces a full rebuild.

### Scaling

The stat pass grows with the number of files in `todos/`. Measured with Bun 1.3.5 on macOS:

| Files | Equivalent to | Stat pass |
|---|---|---|
| 3,650 | 1 year at 10 to-dos/day | ~6 ms |
| 36,500 | 10 years | ~60 ms |

With 3,650 to-dos, `scripts/bench-reconcile.ts` measures a no-op reconcile at ~10 ms, of which ~7 ms is the stat pass, and a full reindex at ~170 ms.

The first years are well within budget. Archiving finished to-dos (see [Future work](#future-work)) keeps the cost flat over longer periods.

## Agent interface

Agents use the same CLI as humans, under a stricter contract. No separate API is needed for day one.

- **Machine-readable output.** Every command supports `--json`, which is also the default when stdout is not a TTY. Exit codes are stable and documented. Errors go to stderr as JSON when in JSON mode.
- **Actor identity.** Every write records an actor. It resolves in this order:
  1. `--as <actor>` flag
  2. `TODO_ACTOR` environment variable
  3. auto-detection of known agents (for example `CLAUDECODE=1` resolves to `agent:claude`)
  4. `$USER`, as `human:<name>`
- **Idempotency.** `todo add --key <key>` makes creates safe to retry: a second create with the same key returns the existing to-do.
- **Optimistic concurrency.** Every to-do carries a `rev`. Mutations accept `--if-rev <n>` and fail if the to-do changed in the meantime, so an agent never silently overwrites a human's edit.
- **Never block on input.** The TUI only launches for a bare `todo` in an interactive TTY. Subcommands never prompt.
- **Later.** A thin MCP server or an agent skill file can wrap the same core library once the CLI contract is stable.

## Projects, tags and views

One small filter language is used by the CLI, the TUI and agents alike:

```
project:work tag:urgent status:open due:<7d -tag:waiting
```

The query is parsed into an AST and compiled to SQL against the local index. A **view** is a named query, stored in `views.toml`:

```toml
[views.today]
query = "status:open due:<=today"

[views.work]
query = "project:work status:open"
```

Views are invoked with `todo ls @today` on the CLI and shown as tabs in the TUI. Because the language is shared, a view means the same thing to every consumer.

Projects are a field on the to-do, not a directory, so moving a to-do between projects does not move or rename anything.

## TUI: OpenTUI

[OpenTUI](https://github.com/anomalyco/opentui) is a TypeScript API over a native rendering core written in Zig, with flexbox layout and React and Solid bindings. It powers OpenCode in production.

We use it with the **Solid** binding: fine-grained reactivity updates only what changed instead of re-rendering component trees.

Alternatives considered:

- **Ink**: mature and widely used, but markedly slower (32fps cap, expensive rerenders).
- **Rezi**: self-published benchmarks show it about 2.6x faster than OpenTUI Core, but it is newer and has a smaller ecosystem. Worth revisiting.

Risk: OpenTUI is pre-1.0 and its API may change. The TUI is kept as a thin layer over `core` so it can be swapped.

## Package layout

```
packages/core   # domain model, storage, index, query language, actor and audit log
packages/cli    # argument parsing (citty), --json output contract
packages/tui    # OpenTUI + Solid
```

All behavior lives in `core`. The CLI and TUI are presentation layers over it.

## Future work

### v2: Archive finished to-dos into collection files

To-dos that have been `done` or `cancelled` for longer than a configurable period (default 14 days) move out of `todos/` and are appended to one collection file per year:

```
.todo/
  todos/<ulid>.md        # open to-dos, plus recently finished ones
  archive/2026.jsonl     # one line per archived to-do: frontmatter fields + body
  archive/2025.jsonl
```

Archiving runs automatically during reconcile, or explicitly with `todo archive`.

- `todos/` stays at a few hundred files, so the stat pass stays under a millisecond regardless of history.
- A year of archive is roughly 3,600 lines and 1–2MB. The index tracks it the same way as log files: by size and byte offset, reading only appended lines.
- Archived to-dos remain fully queryable through the index.
- Unarchiving (`todo reopen` on an archived to-do) writes the to-do back to `todos/` and records the removal in the archive, either as a tombstone line or by rewriting the year file.

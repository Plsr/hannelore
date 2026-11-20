import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type FileStamp, type Index, openIndex } from "./index-db";
import {
  type Actor,
  AmbiguousIdError,
  type CreateInput,
  type EditableField,
  type Event,
  InvalidTodoError,
  NotFoundError,
  type ReconcileResult,
  RevConflictError,
  type Store,
  type Todo,
  type TodoId,
  type TodoPatch,
} from "./model";
import { parseIdRef, shortenIds } from "./short-id";
import { parseEvent, parseTodo, parseTodoFile, serializeTodo } from "./todo-file";
import { nextUlid } from "./ulid";

/** Bytes kept from just before a log's read offset, to notice the file being rewritten in place. */
const LOG_TAIL = 256;

const EDITABLE: readonly EditableField[] = ["title", "status", "project", "tags", "due", "priority", "body"];

function writeIfAbsent(path: string, content: string) {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

export function openStore(root: string, opts: { now?: () => Date } = {}): Store {
  const now = opts.now ?? (() => new Date());
  const todosDir = join(root, "todos");
  const logDir = join(root, "log");
  mkdirSync(todosDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeIfAbsent(join(root, ".gitignore"), ".cache.db*\n");
  const index = openIndex(join(root, ".cache.db"));

  const fileOf = (id: TodoId) => `${id}.md`;

  function readTodo(id: TodoId): Todo {
    let text: string;
    try {
      text = readFileSync(join(todosDir, fileOf(id)), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError(id);
      throw e;
    }
    return parseTodoFile(text, id);
  }

  /** Atomic write, then the index row and `files` entry, so the next reconcile finds nothing to do. */
  function writeTodo(todo: Todo) {
    const file = fileOf(todo.id);
    const tmp = join(todosDir, `.${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, serializeTodo(todo));
    // rename keeps mtime and size, so stamping the temp file is race-free against a later outside edit.
    const stamp = stampOf(tmp);
    try {
      renameSync(tmp, join(todosDir, file));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    index.putTodo(todo, file, stamp);
  }

  function log(event: Event) {
    // Each actor appends only to its own file, so logs never merge-conflict in git.
    const line = JSON.stringify(event);
    appendFileSync(join(logDir, `${event.actor.replace(":", "-")}.jsonl`), `${line}\n`);
  }

  function checkRev(todo: Todo, ifRev: number | undefined) {
    if (ifRev !== undefined && ifRev !== todo.rev) throw new RevConflictError(todo.id, ifRev, todo.rev);
  }

  function reconcileTodos(): ReconcileResult {
    const known = index.files();
    const puts: Parameters<Index["applyTodos"]>[0] = [];
    const removals: Parameters<Index["applyTodos"]>[1] = [];
    const invalid: ReconcileResult["invalid"] = [];

    for (const file of readdirSync(todosDir)) {
      if (!file.endsWith(".md") || file.startsWith(".")) continue;
      const path = join(todosDir, file);
      let stamp: FileStamp;
      try {
        stamp = stampOf(path);
      } catch {
        continue; // gone since readdir; left in `known`, so its row is removed below
      }
      const previous = known.get(file);
      known.delete(file);
      if (previous && previous.mtimeNs === stamp.mtimeNs && previous.size === stamp.size) continue;
      const id = file.slice(0, -3) as TodoId;
      try {
        puts.push({ todo: parseTodoFile(readFileSync(path, "utf8"), id), file, stamp });
      } catch (e) {
        if (!(e instanceof InvalidTodoError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        if (e instanceof InvalidTodoError) invalid.push({ path, error: e.message });
        removals.push({ id, file });
      }
    }
    for (const file of known.keys()) removals.push({ id: file.slice(0, -3) as TodoId, file });

    const removed = puts.length + removals.length > 0 ? index.applyTodos(puts, removals) : 0;
    return { indexed: puts.length, removed, invalid };
  }

  function reconcileLogs() {
    const marks = index.logMarks();
    for (const file of readdirSync(logDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const mark = marks.get(file);
      marks.delete(file);
      const path = join(logDir, file);
      const stat = statSync(path, { bigint: true });
      const size = Number(stat.size);
      const ino = String(stat.ino);
      // Store writes append in place. git checkout and most editors replace the file (new inode);
      // a shorter file or changed bytes before the mark mean it was rewritten in place.
      const grown = mark !== undefined && mark.ino === ino && size >= mark.offset;
      if (grown && size === mark.offset) continue;
      const append =
        grown && Buffer.compare(readRange(path, mark.offset - mark.tail.length, mark.offset), mark.tail) === 0;
      const start = append ? mark.offset : 0;
      const bytes = readRange(path, start, size);
      // A writer may be mid-append; leave a trailing partial line for the next reconcile.
      const end = start + bytes.lastIndexOf(0x0a) + 1;
      const events = bytes
        .subarray(0, end - start)
        .toString("utf8")
        .split("\n")
        .flatMap((line) => parseEvent(line) ?? []);
      const tail = readRange(path, Math.max(0, end - LOG_TAIL), end);
      index.applyLog(file, mark, events, { offset: end, ino, tail }, !append);
    }
    for (const [gone, mark] of marks) index.applyLog(gone, mark, [], null, true);
  }

  function reconcile(): ReconcileResult {
    const result = reconcileTodos();
    reconcileLogs();
    return result;
  }

  return {
    create(input: CreateInput, actor: Actor): Todo {
      if (input.key !== undefined) {
        reconcileTodos();
        const existing = index.todoByKey(input.key.trim());
        if (existing) return existing;
      }
      const at = now();
      const ts = at.toISOString();
      const todo = parseTodo(
        { ...input, id: nextUlid(at.getTime()), status: input.status ?? "open", created_at: ts, updated_at: ts, created_by: actor, updated_by: actor, rev: 1 },
        input.body ?? "",
      );
      writeTodo(todo);
      log({ ts, actor, op: "create", id: todo.id, rev: todo.rev });
      return todo;
    },

    update(id: TodoId, patch: TodoPatch, actor: Actor, opts = {}): Todo {
      const current = readTodo(id);
      checkRev(current, opts.ifRev);

      const merged: Record<string, unknown> = { ...current };
      for (const field of EDITABLE) if (patch[field] !== undefined) merged[field] = patch[field];
      const candidate = parseTodo(merged, String(merged.body));

      const diff: Record<string, [unknown, unknown]> = {};
      for (const field of EDITABLE) {
        const [before, after] = [current[field] ?? null, candidate[field] ?? null];
        if (JSON.stringify(before) !== JSON.stringify(after)) diff[field] = [before, after];
      }
      if (Object.keys(diff).length === 0) return current;

      const ts = now().toISOString();
      const next: Todo = { ...candidate, rev: current.rev + 1, updated_at: ts, updated_by: actor };
      writeTodo(next);
      log({ ts, actor, op: "update", id, rev: next.rev, diff });
      return next;
    },

    delete(id: TodoId, actor: Actor, opts = {}): void {
      const current = readTodo(id);
      checkRev(current, opts.ifRev);
      unlinkSync(join(todosDir, fileOf(id)));
      index.removeTodo(id, fileOf(id));
      log({ ts: now().toISOString(), actor, op: "delete", id, rev: current.rev });
    },

    get(id: TodoId): Todo {
      reconcile();
      const todo = index.todo(id);
      if (!todo) throw new NotFoundError(id);
      return todo;
    },

    resolveId(ref: string): TodoId {
      const suffix = parseIdRef(ref);
      reconcileTodos();
      const matches = index.idsEndingWith(suffix);
      if (matches.length === 1) return matches[0]!;
      if (matches.length === 0) throw new NotFoundError(ref);
      const short = shortenIds(index.ids());
      throw new AmbiguousIdError(ref, matches.map((id) => short.get(id)!));
    },

    shortIds(): Map<TodoId, string> {
      reconcileTodos();
      return shortenIds(index.ids());
    },

    list(filter = {}) {
      reconcile();
      return index.list(filter);
    },

    history(id: TodoId): Event[] {
      reconcile();
      return index.history(id);
    },

    reconcile,

    reindex(): ReconcileResult {
      index.clear();
      return reconcile();
    },

    close() {
      index.close();
    },
  };
}

function stampOf(path: string): FileStamp {
  const stat = statSync(path, { bigint: true });
  return { mtimeNs: String(stat.mtimeNs), size: Number(stat.size) };
}

function readRange(path: string, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(end - start);
  const fd = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start));
  } finally {
    closeSync(fd);
  }
}

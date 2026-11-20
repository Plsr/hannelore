import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import type { Event, ListFilter, Todo, TodoId } from "./model";

const SCHEMA_VERSION = "2";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE todos (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL,
  due TEXT,
  priority INTEGER,
  key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  rev INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX todos_project ON todos (project);
CREATE INDEX todos_status ON todos (status);
CREATE INDEX todos_due ON todos (due);
CREATE INDEX todos_priority ON todos (priority);
CREATE INDEX todos_key ON todos (key) WHERE key IS NOT NULL;
CREATE TABLE todo_tags (tag TEXT NOT NULL, todo_id TEXT NOT NULL, PRIMARY KEY (tag, todo_id)) WITHOUT ROWID;
CREATE INDEX todo_tags_todo ON todo_tags (todo_id);
CREATE VIRTUAL TABLE todos_fts USING fts5 (title, body, content = 'todos', content_rowid = 'seq');
CREATE TRIGGER todos_fts_insert AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts (rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
CREATE TRIGGER todos_fts_delete AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts (todos_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
END;
CREATE TRIGGER todos_fts_update AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts (todos_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  INSERT INTO todos_fts (rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  op TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  diff TEXT
);
CREATE INDEX events_todo ON events (todo_id, ts);
CREATE INDEX events_actor ON events (actor, ts);
CREATE INDEX events_source ON events (source);
CREATE TABLE files (path TEXT PRIMARY KEY, mtime_ns TEXT NOT NULL, size INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE logs (source TEXT PRIMARY KEY, offset INTEGER NOT NULL, ino TEXT NOT NULL, tail BLOB NOT NULL) WITHOUT ROWID;
`;

/** What a source file looked like when it was indexed. mtime is a bigint ns string; it does not fit a JS number. */
export type FileStamp = { mtimeNs: string; size: number };

/**
 * How far a log file has been read: the byte offset, the file's inode (a bigint string), and the
 * bytes just before the offset. A new inode or different tail bytes mean the file was rewritten.
 */
export type LogMark = { offset: number; ino: string; tail: Uint8Array };

type TodoRow = Omit<Todo, "tags" | "project" | "due" | "priority" | "key"> & {
  tags: string;
  project: string | null;
  due: string | null;
  priority: number | null;
  key: string | null;
};

type EventRow = Omit<Event, "diff"> & { diff: string | null };

type MarkRow = LogMark & { source: string };

function sameMark(a: LogMark | undefined, b: LogMark | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.offset === b.offset && a.ino === b.ino && Buffer.compare(a.tail, b.tail) === 0;
}

/** The disposable SQLite index. Everything in it can be rebuilt from the files. */
export type Index = ReturnType<typeof openIndex>;

export function openIndex(path: string) {
  const db = connect(path);

  const upsertTodo = db.query(`
    INSERT INTO todos (id, title, status, project, tags, due, priority, key, created_at, updated_at, created_by, updated_by, rev, body)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT (id) DO UPDATE SET
      title = ?2, status = ?3, project = ?4, tags = ?5, due = ?6, priority = ?7, key = ?8,
      created_at = ?9, updated_at = ?10, created_by = ?11, updated_by = ?12, rev = ?13, body = ?14`);
  const deleteTags = db.query("DELETE FROM todo_tags WHERE todo_id = ?");
  const insertTag = db.query("INSERT OR IGNORE INTO todo_tags (tag, todo_id) VALUES (?, ?)");
  const deleteTodo = db.query("DELETE FROM todos WHERE id = ?");
  const upsertFile = db.query("INSERT OR REPLACE INTO files (path, mtime_ns, size) VALUES (?, ?, ?)");
  const deleteFile = db.query("DELETE FROM files WHERE path = ?");
  const insertEvent = db.query(
    "INSERT INTO events (source, ts, actor, op, todo_id, rev, diff) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const selectMarks = db.query("SELECT source, offset, ino, tail FROM logs");
  const selectMark = db.query("SELECT source, offset, ino, tail FROM logs WHERE source = ?");
  const upsertMark = db.query("INSERT OR REPLACE INTO logs (source, offset, ino, tail) VALUES (?, ?, ?, ?)");

  const applyLog = db.transaction(
    (source: string, from: LogMark | undefined, events: Event[], to: LogMark | null, reset: boolean) => {
      const stored = selectMark.get(source) as MarkRow | null;
      if (!sameMark(stored ?? undefined, from)) return;
      if (reset) db.query("DELETE FROM events WHERE source = ?").run(source);
      for (const e of events) {
        insertEvent.run(source, e.ts, e.actor, e.op, e.id, e.rev, e.diff ? JSON.stringify(e.diff) : null);
      }
      if (to === null) db.query("DELETE FROM logs WHERE source = ?").run(source);
      else upsertMark.run(source, to.offset, to.ino, to.tail);
    },
  );

  const putTodo = (todo: Todo, file: string, stamp: FileStamp) => {
    upsertTodo.run(
      todo.id,
      todo.title,
      todo.status,
      todo.project ?? null,
      JSON.stringify(todo.tags),
      todo.due ?? null,
      todo.priority ?? null,
      todo.key ?? null,
      todo.created_at,
      todo.updated_at,
      todo.created_by,
      todo.updated_by,
      todo.rev,
      todo.body,
    );
    deleteTags.run(todo.id);
    for (const tag of todo.tags) insertTag.run(tag, todo.id);
    upsertFile.run(file, stamp.mtimeNs, stamp.size);
  };

  const removeTodo = (id: TodoId, file: string): boolean => {
    const removed = deleteTodo.run(id).changes > 0;
    deleteTags.run(id);
    deleteFile.run(file);
    return removed;
  };

  return {
    files(): Map<string, FileStamp> {
      const rows = db.query("SELECT path, mtime_ns, size FROM files").all() as {
        path: string;
        mtime_ns: string;
        size: number;
      }[];
      return new Map(rows.map((r) => [r.path, { mtimeNs: r.mtime_ns, size: r.size }]));
    },

    /** Applies a batch of todo changes in one transaction; returns how many indexed todos were removed. */
    applyTodos: db.transaction(
      (puts: { todo: Todo; file: string; stamp: FileStamp }[], removals: { id: TodoId; file: string }[]) => {
        for (const p of puts) putTodo(p.todo, p.file, p.stamp);
        let removed = 0;
        for (const r of removals) if (removeTodo(r.id, r.file)) removed++;
        return removed;
      },
    ),

    putTodo: db.transaction(putTodo),
    removeTodo: db.transaction(removeTodo),

    todo(id: TodoId): Todo | undefined {
      const row = db.query("SELECT * FROM todos WHERE id = ?").get(id) as TodoRow | null;
      return row ? fromRow(row) : undefined;
    },

    ids(): TodoId[] {
      return (db.query("SELECT id FROM todos").values() as [TodoId][]).map(([id]) => id);
    },

    /** `suffix` must be uppercase Crockford base32, so it holds no LIKE wildcards. */
    idsEndingWith(suffix: string): TodoId[] {
      return (db.query("SELECT id FROM todos WHERE id LIKE '%' || ? ORDER BY id").values(suffix) as [TodoId][]).map(
        ([id]) => id,
      );
    },

    todoByKey(key: string): Todo | undefined {
      const row = db.query("SELECT * FROM todos WHERE key = ? ORDER BY id LIMIT 1").get(key) as TodoRow | null;
      return row ? fromRow(row) : undefined;
    },

    list(filter: ListFilter): Todo[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.status !== undefined) {
        const statuses = [filter.status].flat();
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
      if (filter.project !== undefined) {
        where.push("project = ?");
        params.push(filter.project);
      }
      const tags = [...new Set(filter.tags ?? [])];
      if (tags.length > 0) {
        where.push(
          `id IN (SELECT todo_id FROM todo_tags WHERE tag IN (${tags.map(() => "?").join(", ")}) GROUP BY todo_id HAVING count(*) = ?)`,
        );
        params.push(...tags, tags.length);
      }
      const sql = `SELECT * FROM todos ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
      return (db.query(sql).all(...params) as TodoRow[]).map(fromRow);
    },

    history(id: TodoId): Event[] {
      const rows = db
        .query("SELECT ts, actor, op, todo_id AS id, rev, diff FROM events WHERE todo_id = ? ORDER BY ts, rev, seq")
        .all(id) as EventRow[];
      return rows.map(({ diff, ...event }) => (diff === null ? event : { ...event, diff: JSON.parse(diff) }));
    },

    logMarks(): Map<string, LogMark> {
      return new Map((selectMarks.all() as MarkRow[]).map(({ source, ...mark }) => [source, mark]));
    },

    /**
     * Records events read from `source` between marks `from` (undefined: never read) and `to`
     * (null: the file is gone). `reset` first drops what was read before. Skips the batch when
     * another process moved the stored mark since `from` was read, because it already recorded these events.
     */
    applyLog: (source: string, from: LogMark | undefined, events: Event[], to: LogMark | null, reset: boolean) =>
      applyLog.immediate(source, from, events, to, reset),

    clear: db.transaction(() => {
      db.run("DELETE FROM todos");
      db.run("DELETE FROM todo_tags");
      db.run("DELETE FROM events");
      db.run("DELETE FROM files");
      db.run("DELETE FROM logs");
    }),

    close() {
      db.close();
    },
  };
}

/** Opens the index, rebuilding it from scratch when it is corrupt or from another schema version. */
function connect(path: string): Database {
  try {
    return init(new Database(path, { create: true }));
  } catch {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    return init(new Database(path, { create: true }));
  }
}

function init(db: Database): Database {
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.transaction(() => {
      const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
      if (!hasMeta) {
        db.run(SCHEMA);
        db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
        return;
      }
      const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
      if (row?.value !== SCHEMA_VERSION) throw new Error(`index schema ${row?.value} is not ${SCHEMA_VERSION}`);
    }).immediate();
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function fromRow(row: TodoRow): Todo {
  const todo: Todo = {
    id: row.id,
    title: row.title,
    status: row.status,
    tags: JSON.parse(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    rev: row.rev,
    body: row.body,
  };
  if (row.project !== null) todo.project = row.project;
  if (row.due !== null) todo.due = row.due;
  if (row.priority !== null) todo.priority = row.priority;
  if (row.key !== null) todo.key = row.key;
  return todo;
}

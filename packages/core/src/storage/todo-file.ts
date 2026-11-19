import { type Actor, type Event, type EventOp, InvalidTodoError, STATUSES, type Status, type Todo, type TodoId } from "./model";

const ACTOR = /^(human|agent):[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseActor(s: string): Actor {
  if (!ACTOR.test(s)) throw new InvalidTodoError(`Invalid actor ${JSON.stringify(s)}: expected human:<name> or agent:<name>`);
  return s as Actor;
}

export function parseTodoId(s: string): TodoId {
  if (!ULID.test(s)) throw new InvalidTodoError(`Invalid todo id ${JSON.stringify(s)}`);
  return s as TodoId;
}

/** Field order of the frontmatter. Keeping it fixed keeps git diffs small. */
const FIELDS = [
  "id",
  "title",
  "status",
  "project",
  "tags",
  "due",
  "priority",
  "key",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "rev",
] as const satisfies readonly Exclude<keyof Todo, "body">[];

/** Validates and normalizes an untyped record into a Todo. The single definition of a valid todo. */
export function parseTodo(raw: Record<string, unknown>, body: string): Todo {
  const todo: Todo = {
    id: parseTodoId(str(raw.id, "id")),
    title: line(raw.title, "title"),
    status: status(raw.status),
    tags: tags(raw.tags),
    created_at: timestamp(raw.created_at, "created_at"),
    updated_at: timestamp(raw.updated_at, "updated_at"),
    created_by: parseActor(str(raw.created_by, "created_by")),
    updated_by: parseActor(str(raw.updated_by, "updated_by")),
    rev: int(raw.rev, "rev", 1),
    body: body.replace(/^\n+/, "").trimEnd(),
  };
  if (raw.project != null) todo.project = line(raw.project, "project");
  if (raw.due != null) todo.due = date(raw.due);
  if (raw.priority != null) todo.priority = int(raw.priority, "priority");
  if (raw.key != null) todo.key = line(raw.key, "key");
  return todo;
}

export function serializeTodo(todo: Todo): string {
  const lines: string[] = [];
  for (const field of FIELDS) {
    const value = todo[field];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    lines.push(`${field}: ${Array.isArray(value) ? `[${value.map(scalar).join(", ")}]` : scalar(value)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${todo.body ? `\n${todo.body}\n` : ""}`;
}

export function parseTodoFile(text: string, fileId: string): Todo {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)^---[ \t]*(?:\n|$)/m.exec(normalized);
  if (!normalized.startsWith("---\n") || !match || match.index !== 0) {
    throw new InvalidTodoError("missing YAML frontmatter between --- lines");
  }
  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(match[1]!);
  } catch (e) {
    throw new InvalidTodoError(`frontmatter is not valid YAML: ${(e as Error).message}`);
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new InvalidTodoError("frontmatter must be a mapping");
  }
  const todo = parseTodo(frontmatter as Record<string, unknown>, normalized.slice(match[0].length));
  if (todo.id !== fileId) throw new InvalidTodoError(`id ${todo.id} does not match file name ${fileId}.md`);
  return todo;
}

const OPS: readonly EventOp[] = ["create", "update", "delete"];

/** Parses one audit log line; returns undefined for anything malformed. */
export function parseEvent(line: string): Event | undefined {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const op = raw.op as EventOp;
    if (!OPS.includes(op) || typeof raw.ts !== "string" || !Number.isInteger(raw.rev)) return undefined;
    const event: Event = {
      ts: raw.ts,
      actor: parseActor(String(raw.actor)),
      op,
      id: parseTodoId(String(raw.id)),
      rev: raw.rev as number,
    };
    if (raw.diff !== undefined) {
      if (typeof raw.diff !== "object" || raw.diff === null) return undefined;
      event.diff = raw.diff as Event["diff"];
    }
    return event;
  } catch {
    return undefined;
  }
}

/** Plain YAML when the string survives a flow-context round trip unchanged, else a JSON (= YAML double-quoted) string. */
function scalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  try {
    const parsed = Bun.YAML.parse(`[${value}]`);
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] === value) return value;
  } catch {}
  return JSON.stringify(value);
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw new InvalidTodoError(`${field} must be a string`);
  return value;
}

function line(value: unknown, field: string): string {
  const trimmed = str(value, field).trim();
  if (trimmed === "" || trimmed.includes("\n")) throw new InvalidTodoError(`${field} must be a non-empty single line`);
  return trimmed;
}

function status(value: unknown): Status {
  if (!STATUSES.includes(value as Status)) throw new InvalidTodoError(`status must be one of ${STATUSES.join(", ")}`);
  return value as Status;
}

function tags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InvalidTodoError("tags must be a list");
  return [...new Set(value.map((tag) => line(tag, "each tag")))];
}

function timestamp(value: unknown, field: string): string {
  if (Number.isNaN(Date.parse(str(value, field)))) throw new InvalidTodoError(`${field} must be an ISO timestamp`);
  return value as string;
}

function date(value: unknown): string {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (!match || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new InvalidTodoError(`due must be a date as YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value as string;
}

function int(value: unknown, field: string, min = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new InvalidTodoError(`${field} must be an integer`);
  return value as number;
}

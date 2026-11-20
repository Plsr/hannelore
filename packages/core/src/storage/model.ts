export type TodoId = string & { readonly __brand: "TodoId" };
export type Actor = `human:${string}` | `agent:${string}`;

export const STATUSES = ["open", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

export type Todo = {
  id: TodoId;
  title: string;
  status: Status;
  project?: string;
  tags: string[];
  due?: string;
  priority?: number;
  key?: string;
  created_at: string;
  updated_at: string;
  created_by: Actor;
  updated_by: Actor;
  rev: number;
  body: string;
};

export type CreateInput = {
  title: string;
  status?: Status;
  project?: string;
  tags?: string[];
  due?: string;
  priority?: number;
  body?: string;
  key?: string;
};

/** `null` clears an optional field; an omitted field is left as is. */
export type TodoPatch = {
  title?: string;
  status?: Status;
  project?: string | null;
  tags?: string[];
  due?: string | null;
  priority?: number | null;
  body?: string;
};

export type EditableField = keyof TodoPatch;

export type EventOp = "create" | "update" | "delete";
export type Event = {
  ts: string;
  actor: Actor;
  op: EventOp;
  id: TodoId;
  rev: number;
  diff?: Record<string, [unknown, unknown]>;
};

export type ListFilter = {
  status?: Status | Status[];
  project?: string;
  /** All tags must match. */
  tags?: string[];
};

export type ReconcileResult = {
  indexed: number;
  removed: number;
  invalid: { path: string; error: string }[];
};

export interface Store {
  create(input: CreateInput, actor: Actor): Todo;
  update(id: TodoId, patch: TodoPatch, actor: Actor, opts?: { ifRev?: number }): Todo;
  delete(id: TodoId, actor: Actor, opts?: { ifRev?: number }): void;
  get(id: TodoId): Todo;
  list(filter?: ListFilter): Todo[];
  history(id: TodoId): Event[];
  reconcile(): ReconcileResult;
  reindex(): ReconcileResult;
  close(): void;
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
  constructor(readonly id: string) {
    super(`No todo with id ${id}`);
  }
}

export class RevConflictError extends Error {
  override name = "RevConflictError";
  constructor(
    readonly id: TodoId,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Todo ${id} is at rev ${actual}, expected ${expected}`);
  }
}

export class InvalidTodoError extends Error {
  override name = "InvalidTodoError";
}

import type { Event, Status, Todo } from "@todo/core";

/** A todo as the CLI prints it, in JSON and to humans: the stored todo plus its display id. */
export type TodoView = Todo & { short_id: string };

const MARKERS: Record<Status, string> = { open: "", done: "[done] ", cancelled: "[cancelled] " };

export function formatLine(todo: TodoView, idWidth = todo.short_id.length): string {
  const meta = [
    todo.project && `project:${todo.project}`,
    ...todo.tags.map((tag) => `tag:${tag}`),
    todo.due && `due:${todo.due}`,
  ].filter(Boolean);
  const title = `${MARKERS[todo.status]}${todo.title}`;
  return [todo.short_id.padEnd(idWidth), title, ...(meta.length ? [meta.join(" ")] : [])].join("  ");
}

export function formatList(todos: TodoView[]): string {
  const width = Math.max(0, ...todos.map((t) => t.short_id.length));
  return todos.map((t) => formatLine(t, width)).join("\n");
}

export function formatDetail(todo: TodoView): string {
  const rows: [string, string | number | undefined][] = [
    ["status", todo.status],
    ["project", todo.project],
    ["tags", todo.tags.join(", ") || undefined],
    ["due", todo.due],
    ["priority", todo.priority],
    ["created", `${todo.created_at} by ${todo.created_by}`],
    ["updated", `${todo.updated_at} by ${todo.updated_by} (rev ${todo.rev})`],
    ["id", todo.id],
  ];
  const fields = rows.flatMap(([label, value]) => (value === undefined ? [] : [`${label.padEnd(8)}  ${value}`]));
  return [`${todo.short_id}  ${todo.title}`, ...fields, ...(todo.body ? ["", todo.body] : [])].join("\n");
}

export function formatEvent(event: Event): string {
  const changes = Object.entries(event.diff ?? {}).map(([field, [from, to]]) => `${field}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  return [event.ts, event.actor, `${event.op} rev ${event.rev}`, ...changes].join("  ");
}

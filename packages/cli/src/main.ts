import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { type ArgsDef, type CittyPlugin, type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import {
  type Actor,
  AmbiguousIdError,
  InvalidTodoError,
  NotFoundError,
  RevConflictError,
  STATUSES,
  type Store,
  type Todo,
  type TodoPatch,
  findStore,
  openStore,
  resolveActor,
} from "@todo/core";
import { formatDetail, formatEvent, formatLine, formatList, type TodoView } from "./format";
import pkg from "../package.json" with { type: "json" };

class UsageError extends Error {}

const argv = process.argv.slice(2);
const json = argv.includes("--json") || !process.stdout.isTTY;

// citty ignores options it does not declare; agents need typos to fail loudly.
const strict: CittyPlugin = {
  name: "strict",
  async setup({ cmd, rawArgs, args }) {
    const declared: ArgsDef = (await (typeof cmd.args === "function" ? cmd.args() : cmd.args)) ?? {};
    for (const arg of rawArgs) {
      if (arg === "--") break;
      if (!arg.startsWith("-")) continue;
      const name = arg.replace(/^--?/, "").split("=")[0] ?? "";
      if (!(name in declared)) throw new UsageError(`Unknown option ${arg}`);
    }
    for (const [name, def] of Object.entries(declared)) {
      if ((def.type === "string" || def.type === "enum") && args[name] === "") throw new UsageError(`Missing value for --${name}`);
    }
  },
};

// citty drops extra positionals, and `todo done a b` must not quietly skip b.
const oneId: CittyPlugin = {
  name: "one-id",
  setup({ args }) {
    if (args._.length > 1) throw new UsageError(`Expected one todo id, got ${args._.length}`);
  },
};

const storeArgs = {
  dir: { type: "string", description: "Store directory (default: $TODO_DIR, nearest .todo/, ~/.todo)", valueHint: "path" },
  json: { type: "boolean", description: "Print JSON (default when stdout is not a TTY)" },
} as const satisfies ArgsDef;

const writeArgs = {
  ...storeArgs,
  as: {
    type: "string",
    description: "Acting actor, such as human:ada or agent:claude (default: $TODO_ACTOR, a known agent, human:$USER)",
    valueHint: "actor",
  },
} as const satisfies ArgsDef;

const idArg = {
  id: { type: "positional", required: true, description: "Todo id: t-3fk2, 3fk2 or the full id" },
} as const satisfies ArgsDef;

const revArg = {
  "if-rev": { type: "string", description: "Fail with a conflict unless the todo is at this rev", valueHint: "n" },
} as const satisfies ArgsDef;

const fieldArgs = {
  project: { type: "string", description: "Project", valueHint: "name" },
  tags: { type: "string", description: "Comma-separated tags", valueHint: "a,b" },
  due: { type: "string", description: "Due date", valueHint: "YYYY-MM-DD" },
  priority: { type: "string", description: "Priority, an integer", valueHint: "n" },
  body: { type: "string", description: "Markdown body", valueHint: "text" },
} as const satisfies ArgsDef;

type FieldValues = { project?: string; tags?: string; due?: string; priority?: string; body?: string };

function fields(args: FieldValues) {
  return {
    project: args.project,
    tags: args.tags === undefined ? undefined : list(args.tags),
    due: args.due,
    priority: args.priority === undefined ? undefined : integer(args.priority, "priority"),
    body: args.body,
  };
}

function list(value: string): string[] {
  return value.split(",").map((s) => s.trim());
}

function integer(value: string, flag: string): number {
  if (!/^-?\d+$/.test(value)) throw new UsageError(`--${flag} must be an integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

function revOpts(args: { "if-rev"?: string }): { ifRev?: number } {
  return { ifRev: args["if-rev"] === undefined ? undefined : integer(args["if-rev"], "if-rev") };
}

function actor(flag: string | undefined): Actor {
  return resolveActor({ flag, env: process.env }).actor;
}

function withStore<T>(dir: string | undefined, fn: (store: Store) => T): T {
  const { root } = findStore({ cwd: process.cwd(), home: homedir(), dir, envDir: process.env.TODO_DIR });
  const store = openStore(root);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function view(store: Store, todo: Todo): TodoView {
  return { ...todo, short_id: store.shortIds().get(todo.id)! };
}

function print(value: unknown, human: string): void {
  if (json) console.log(JSON.stringify(value));
  else if (human) console.log(human);
}

const add = defineCommand({
  meta: { name: "add", description: "Add a todo" },
  args: {
    title: { type: "positional", required: true, description: "Title; the words are joined with spaces" },
    ...fieldArgs,
    key: { type: "string", description: "Idempotency key; adding again with it returns the existing todo", valueHint: "key" },
    ...writeArgs,
  },
  plugins: [strict],
  run({ args }) {
    const by = actor(args.as);
    withStore(args.dir, (store) => {
      const todo = view(store, store.create({ title: args._.join(" "), ...fields(args), key: args.key }, by));
      print(todo, formatLine(todo));
    });
  },
});

const ls = defineCommand({
  meta: { name: "ls", description: "List todos" },
  args: {
    status: { type: "enum", options: [...STATUSES, "all"], default: "open", description: "Status to list" },
    project: fieldArgs.project,
    tags: { type: "string", description: "Comma-separated tags; a todo must have all of them", valueHint: "a,b" },
    ...storeArgs,
  },
  plugins: [strict],
  run({ args }) {
    withStore(args.dir, (store) => {
      const status = args.status === "all" ? undefined : (args.status as Todo["status"]);
      const tags = args.tags === undefined ? undefined : list(args.tags);
      const short = store.shortIds();
      const todos = store.list({ status, project: args.project, tags }).map((t) => ({ ...t, short_id: short.get(t.id)! }));
      print(todos, formatList(todos));
    });
  },
});

const show = defineCommand({
  meta: { name: "show", description: "Show a todo" },
  args: {
    ...idArg,
    ...storeArgs,
  },
  plugins: [strict, oneId],
  run({ args }) {
    withStore(args.dir, (store) => {
      const todo = view(store, store.get(store.resolveId(args.id)));
      print(todo, formatDetail(todo));
    });
  },
});

const CLEARABLE = ["project", "due", "priority"] as const;
const isClearable = (field: string): field is (typeof CLEARABLE)[number] => (CLEARABLE as readonly string[]).includes(field);

const edit = defineCommand({
  meta: { name: "edit", description: "Change a todo's fields" },
  args: {
    ...idArg,
    title: { type: "string", description: "Title", valueHint: "text" },
    status: { type: "enum", options: [...STATUSES], description: "Status" },
    ...fieldArgs,
    clear: { type: "string", description: `Comma-separated fields to unset: ${CLEARABLE.join(", ")}`, valueHint: "fields" },
    ...revArg,
    ...writeArgs,
  },
  plugins: [strict, oneId],
  run({ args }) {
    const patch: TodoPatch = { title: args.title, status: args.status as TodoPatch["status"], ...fields(args) };
    for (const field of args.clear === undefined ? [] : list(args.clear)) {
      if (!isClearable(field)) throw new UsageError(`--clear takes ${CLEARABLE.join(", ")}, got ${JSON.stringify(field)}`);
      if (patch[field] !== undefined) throw new UsageError(`--${field} and --clear ${field} conflict`);
      patch[field] = null;
    }
    if (Object.values(patch).every((v) => v === undefined)) throw new UsageError("Nothing to edit: pass a field option or --clear");
    const opts = revOpts(args);
    const by = actor(args.as);
    withStore(args.dir, (store) => {
      const todo = view(store, store.update(store.resolveId(args.id), patch, by, opts));
      print(todo, formatLine(todo));
    });
  },
});

const done = defineCommand({
  meta: { name: "done", description: "Mark a todo done" },
  args: { ...idArg, ...revArg, ...writeArgs },
  plugins: [strict, oneId],
  run({ args }) {
    const opts = revOpts(args);
    const by = actor(args.as);
    withStore(args.dir, (store) => {
      const todo = view(store, store.update(store.resolveId(args.id), { status: "done" }, by, opts));
      print(todo, formatLine(todo));
    });
  },
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete a todo" },
  args: { ...idArg, ...revArg, ...writeArgs },
  plugins: [strict, oneId],
  run({ args }) {
    const opts = revOpts(args);
    const by = actor(args.as);
    withStore(args.dir, (store) => {
      const todo = view(store, store.get(store.resolveId(args.id)));
      store.delete(todo.id, by, opts);
      print({ id: todo.id, short_id: todo.short_id, deleted: true }, `deleted ${formatLine(todo)}`);
    });
  },
});

const history = defineCommand({
  meta: { name: "history", description: "List a todo's changes, oldest first" },
  args: { ...idArg, ...storeArgs },
  plugins: [strict, oneId],
  run({ args }) {
    withStore(args.dir, (store) => {
      const events = store.history(store.resolveId(args.id));
      print(events, events.map(formatEvent).join("\n"));
    });
  },
});

// citty's own SubCommandsDef erases each command's args the same way.
const subCommands: Record<string, CommandDef<any>> = { add, ls, show, edit, done, rm, history };

const main = defineCommand({
  meta: { name: "todo", version: pkg.version, description: "A to-do app for humans and agents" },
  subCommands,
});

async function printUsage(sub?: CommandDef<any>): Promise<void> {
  const usage = sub ? await renderUsage(sub, main) : await renderUsage(main);
  console.log(process.stdout.isTTY ? usage : stripVTControlCharacters(usage));
}

async function run(): Promise<void> {
  if (argv[0] === "--version") {
    console.log(pkg.version);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    const sub = subCommands[argv[0] ?? ""];
    await printUsage(sub);
    return;
  }
  if (argv.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { runTui } = await import("@todo/tui");
      await runTui();
    } else {
      await printUsage();
    }
    return;
  }
  await runCommand(main, { rawArgs: argv });
}

type ErrorKind = { code: string; exit: number; details?: (error: any) => object };

/** First match wins. Codes and exit statuses are part of the agent contract. */
const ERRORS: [(error: unknown) => boolean, ErrorKind][] = [
  [(e) => e instanceof UsageError || (e instanceof Error && e.name === "CLIError"), { code: "usage", exit: 2 }],
  [(e) => e instanceof InvalidTodoError, { code: "invalid", exit: 2 }],
  [(e) => e instanceof NotFoundError, { code: "not_found", exit: 3 }],
  [(e) => e instanceof AmbiguousIdError, { code: "ambiguous", exit: 4, details: (e: AmbiguousIdError) => ({ candidates: e.candidates }) }],
  [(e) => e instanceof RevConflictError, { code: "conflict", exit: 5 }],
];
const INTERNAL: ErrorKind = { code: "internal", exit: 1 };

try {
  await run();
} catch (error) {
  const kind = ERRORS.find(([matches]) => matches(error))?.[1] ?? INTERNAL;
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  console.error(json ? JSON.stringify({ error: { code: kind.code, message, ...kind.details?.(error) } }) : `todo: ${message}`);
  process.exitCode = kind.exit;
}

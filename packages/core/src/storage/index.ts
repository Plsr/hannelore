import type { Actor, Store, TodoId } from "./model";

export * from "./model";

export function parseActor(_s: string): Actor {
  throw new Error("not implemented");
}

export function parseTodoId(_s: string): TodoId {
  throw new Error("not implemented");
}

export function openStore(_root: string, _opts?: { now?: () => Date }): Store {
  throw new Error("not implemented");
}

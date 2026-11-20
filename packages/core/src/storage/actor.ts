import { type Actor, InvalidTodoError } from "./model";
import { parseActor } from "./todo-file";

export type ActorSource = "flag" | "env" | "agent" | "user";
export type ResolvedActor = { actor: Actor; source: ActorSource };

const KNOWN_AGENTS: { env: string; value: string; actor: Actor }[] = [{ env: "CLAUDECODE", value: "1", actor: "agent:claude" }];

/** Resolves who is acting. First match wins: `flag`, `TODO_ACTOR`, a known agent's env var, `human:$USER`. */
export function resolveActor(opts: { flag?: string; env: Record<string, string | undefined> }): ResolvedActor {
  const { flag, env } = opts;
  if (flag !== undefined) return { actor: parseActor(flag), source: "flag" };
  if (env.TODO_ACTOR) {
    try {
      return { actor: parseActor(env.TODO_ACTOR), source: "env" };
    } catch (e) {
      throw new InvalidTodoError(`TODO_ACTOR: ${(e as Error).message}`);
    }
  }
  const agent = KNOWN_AGENTS.find((a) => env[a.env] === a.value);
  if (agent) return { actor: agent.actor, source: "agent" };
  try {
    return { actor: parseActor(`human:${env.USER ?? ""}`), source: "user" };
  } catch {
    throw new InvalidTodoError(`Cannot derive an actor from USER=${JSON.stringify(env.USER ?? "")}: pass --as <actor> or set TODO_ACTOR`);
  }
}

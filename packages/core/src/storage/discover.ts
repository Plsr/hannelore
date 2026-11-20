import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type StoreSource = "flag" | "env" | "local" | "global";
export type StoreLocation = { root: string; source: StoreSource };

const STORE_DIR = ".todo";

/** Resolves where the store lives without creating anything. First match wins: `dir`, `envDir`, nearest ancestor `.todo/`, `<home>/.todo`. */
export function findStore(opts: { cwd: string; home: string; dir?: string; envDir?: string }): StoreLocation {
  if (opts.dir) return { root: resolve(opts.cwd, opts.dir), source: "flag" };
  if (opts.envDir) return { root: resolve(opts.cwd, opts.envDir), source: "env" };
  const global = join(opts.home, STORE_DIR);
  for (let dir = resolve(opts.cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, STORE_DIR);
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
      return { root: candidate, source: candidate === global ? "global" : "local" };
    }
    if (dirname(dir) === dir) break;
  }
  return { root: global, source: "global" };
}

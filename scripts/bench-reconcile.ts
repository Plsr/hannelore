// Usage: bun scripts/bench-reconcile.ts [todos=3650] [runs=9]
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../packages/core/src";

const n = Number(process.argv[2] ?? 3650);
const runs = Number(process.argv[3] ?? 9);
const dir = mkdtempSync(join(tmpdir(), "todo-bench-"));
const root = join(dir, ".todo");

function time(label: string, fn: () => unknown, check: (result: any) => boolean) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = Bun.nanoseconds();
    const result = fn();
    samples.push((Bun.nanoseconds() - start) / 1e6);
    if (!check(result)) throw new Error(`${label}: unexpected result ${JSON.stringify(result)}`);
  }
  samples.sort((a, b) => a - b);
  const f = (ms: number) => ms.toFixed(2);
  console.log(`${label.padEnd(28)} median ${f(samples[runs >> 1]!)} ms  (min ${f(samples[0]!)}, max ${f(samples.at(-1)!)})`);
}

try {
  const store = openStore(root);
  const tags = ["work", "home", "urgent", "waiting", "docs"];
  const seedStart = performance.now();
  for (let i = 0; i < n; i++) {
    store.create(
      {
        title: `Todo number ${i}`,
        project: `project-${i % 12}`,
        tags: [tags[i % 5]!, tags[(i + 2) % 5]!],
        status: i % 3 === 0 ? "done" : "open",
        body: `Notes for todo ${i}.\n\nSome more text so the body is not empty.`,
      },
      "human:bench",
    );
  }
  console.log(`seeded ${n} todos in ${(performance.now() - seedStart).toFixed(0)} ms, ${runs} runs each\n`);

  const todosDir = join(root, "todos");
  time("readdir + stat (floor)", () => readdirSync(todosDir).map((f) => statSync(join(todosDir, f), { bigint: true })), (r) => r.length === n);
  time("no-op reconcile", () => store.reconcile(), (r) => r.indexed === 0 && r.removed === 0 && r.invalid.length === 0);
  time("list() incl. reconcile", () => store.list(), (r) => r.length === n);
  time("cold reindex", () => store.reindex(), (r) => r.indexed === n && r.invalid.length === 0);
  store.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

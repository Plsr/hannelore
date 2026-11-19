import { stripVTControlCharacters } from "node:util";
import { type ArgsDef, type CittyPlugin, type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import { greet } from "@todo/core";
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
      if (def.type === "string" && args[name] === "") throw new UsageError(`Missing value for --${name}`);
    }
  },
};

const jsonArg = {
  type: "boolean",
  description: "Print JSON (default when stdout is not a TTY)",
} as const;

const hello = defineCommand({
  meta: { name: "hello", description: "Print a greeting" },
  args: {
    name: { type: "string", description: "Who to greet", valueHint: "name" },
    json: jsonArg,
  },
  plugins: [strict],
  run({ args }) {
    const greeting = greet(args.name);
    console.log(json ? JSON.stringify(greeting) : greeting.message);
  },
});

// citty's own SubCommandsDef erases each command's args the same way.
const subCommands: Record<string, CommandDef<any>> = { hello };

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
    await printUsage();
    return;
  }
  await runCommand(main, { rawArgs: argv });
}

function isUsageError(error: unknown): error is Error {
  return error instanceof UsageError || (error instanceof Error && error.name === "CLIError");
}

try {
  await run();
} catch (error) {
  const usage = isUsageError(error);
  const code = usage ? "usage" : "internal";
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  console.error(json ? JSON.stringify({ error: { code, message } }) : `todo: ${message}`);
  process.exitCode = usage ? 2 : 1;
}

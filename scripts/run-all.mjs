import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const GATES = Object.freeze(["check", "test", "build"]);
const TARGETS = Object.freeze([
  Object.freeze({ name: "contracts", directory: "packages/contracts" }),
  Object.freeze({ name: "api-server", directory: "apps/api-server" }),
  Object.freeze({ name: "photoshop-uxp", directory: "apps/photoshop-uxp" }),
]);

export class CommandExecutionError extends Error {
  constructor(command, exitCode, signal = null, cause = undefined) {
    const outcome = signal ? `signal ${signal}` : `exit code ${exitCode}`;
    super(`${command.label} failed with ${outcome}`, { cause });
    this.name = "CommandExecutionError";
    this.exitCode = exitCode;
    this.signal = signal;
    this.command = command;
  }
}

export function pnpmInvocation({
  platform = process.platform,
  env = process.env,
  nodeExecutable = process.execPath,
} = {}) {
  if (platform !== "win32") {
    return Object.freeze({ command: "pnpm", argsPrefix: Object.freeze([]) });
  }

  if (typeof env.npm_execpath === "string" && env.npm_execpath.length > 0) {
    const extension = path.extname(env.npm_execpath).toLowerCase();
    if ([".js", ".cjs", ".mjs"].includes(extension)) {
      // Package scripts usually expose pnpm's JavaScript entrypoint.
      return Object.freeze({
        command: nodeExecutable,
        argsPrefix: Object.freeze([env.npm_execpath]),
      });
    }
    if (extension === ".exe") {
      return Object.freeze({
        command: env.npm_execpath,
        argsPrefix: Object.freeze([]),
      });
    }
    if ([".cmd", ".bat"].includes(extension)) {
      return Object.freeze({
        command: env.ComSpec ?? "cmd.exe",
        argsPrefix: Object.freeze(["/d", "/c", env.npm_execpath]),
      });
    }
    return Object.freeze({
      command: env.ComSpec ?? "cmd.exe",
      argsPrefix: Object.freeze(["/d", "/c", "pnpm.cmd"]),
    });
  }

  // Direct `node scripts/run-all.mjs ...` fallback. All following arguments
  // come from the frozen command plan, never user-provided shell text.
  return Object.freeze({
    command: env.ComSpec ?? "cmd.exe",
    argsPrefix: Object.freeze(["/d", "/c", "pnpm.cmd"]),
  });
}

export function createCommandPlan(
  mode,
  {
    platform = process.platform,
    env = process.env,
    nodeExecutable = process.execPath,
  } = {},
) {
  const selectedGates = mode === "verify" ? GATES : [mode];
  if (selectedGates.some((gate) => !GATES.includes(gate))) {
    throw new TypeError(`gate must be one of ${[...GATES, "verify"].join(", ")}`);
  }

  const invocation = pnpmInvocation({ platform, env, nodeExecutable });
  return selectedGates.flatMap((gate) => [
    ...TARGETS.map((target) =>
      Object.freeze({
        gate,
        label: `${target.name}:${gate}`,
        command: invocation.command,
        args: Object.freeze([
          ...invocation.argsPrefix,
          "--dir",
          target.directory,
          "run",
          gate,
        ]),
      }),
    ),
    Object.freeze({
      gate,
      label: `root:${gate}`,
      command: invocation.command,
      args: Object.freeze([
        ...invocation.argsPrefix,
        "run",
        `${gate}:root`,
      ]),
    }),
  ]);
}

export function runCommand(
  command,
  {
    cwd = ROOT_DIR,
    spawnFn = spawn,
    output = (line) => console.log(line),
  } = {},
) {
  output(`> ${command.label}`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command.command, command.args, {
        cwd,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(new CommandExecutionError(command, 1, null, error));
      return;
    }

    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new CommandExecutionError(command, 1, null, error));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new CommandExecutionError(command, Number.isInteger(code) ? code : 1, signal));
    });
  });
}

export async function runPlan(plan, options = {}) {
  for (const command of plan) {
    await runCommand(command, options);
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    platform = process.platform,
    errorOutput = (line) => console.error(line),
    ...runOptions
  } = {},
) {
  if (argv.length !== 1) {
    errorOutput("usage: node scripts/run-all.mjs <check|test|build|verify>");
    return 2;
  }

  let plan;
  try {
    plan = createCommandPlan(argv[0], { platform });
  } catch (error) {
    errorOutput(error.message);
    return 2;
  }

  try {
    await runPlan(plan, runOptions);
    return 0;
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    return error instanceof CommandExecutionError ? error.exitCode : 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main();
}

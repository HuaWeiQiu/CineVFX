import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CommandExecutionError,
  createCommandPlan,
  main,
  pnpmInvocation,
  runPlan,
} from "../scripts/run-all.mjs";

function fakeSpawnWithCodes(codes, calls) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    const code = codes.shift() ?? 0;
    queueMicrotask(() => child.emit("close", code, null));
    return child;
  };
}

test("command plans run every package before the matching root-only gate", () => {
  const plan = createCommandPlan("check", { platform: "darwin", env: {} });
  assert.deepEqual(
    plan.map(({ command, args }) => [command, ...args].join(" ")),
    [
      "pnpm --dir packages/contracts run check",
      "pnpm --dir apps/api-server run check",
      "pnpm --dir apps/photoshop-uxp run check",
      "pnpm run check:root",
    ],
  );
  assert.doesNotMatch(JSON.stringify(plan), /&&|\*/);

  const verifyPlan = createCommandPlan("verify", { platform: "linux" });
  assert.equal(verifyPlan.length, 12);
  assert.deepEqual(
    verifyPlan.map(({ gate }) => gate),
    [
      "check", "check", "check", "check",
      "test", "test", "test", "test",
      "build", "build", "build", "build",
    ],
  );
  assert.deepEqual(
    verifyPlan.filter(({ label }) => label.startsWith("root:")).map(({ label }) => label),
    ["root:check", "root:test", "root:build"],
  );
});

test("Windows command plans execute pnpm's JS entrypoint without a shell", async () => {
  const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
  const pnpmCli = "C:\\pnpm\\pnpm.cjs";
  assert.deepEqual(
    pnpmInvocation({
      platform: "win32",
      env: { npm_execpath: pnpmCli },
      nodeExecutable,
    }),
    { command: nodeExecutable, argsPrefix: [pnpmCli] },
  );
  const calls = [];
  const plan = createCommandPlan("build", {
    platform: "win32",
    env: { npm_execpath: pnpmCli },
    nodeExecutable,
  });
  await runPlan(plan, {
    spawnFn: fakeSpawnWithCodes([0, 0, 0, 0], calls),
    output() {},
  });

  assert.ok(calls.every(({ command }) => command === nodeExecutable));
  assert.ok(calls.every(({ args }) => args[0] === pnpmCli));
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.ok(calls.every(({ options }) => options.stdio === "inherit"));

  assert.deepEqual(
    pnpmInvocation({
      platform: "win32",
      env: { npm_execpath: "C:\\pnpm\\pnpm.exe" },
      nodeExecutable,
    }),
    { command: "C:\\pnpm\\pnpm.exe", argsPrefix: [] },
  );
  assert.deepEqual(
    pnpmInvocation({
      platform: "win32",
      env: {
        npm_execpath: "C:\\Program Files\\pnpm\\pnpm.cmd",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      nodeExecutable,
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      argsPrefix: [
        "/d",
        "/c",
        "C:\\Program Files\\pnpm\\pnpm.cmd",
      ],
    },
  );
  assert.deepEqual(
    pnpmInvocation({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      argsPrefix: ["/d", "/c", "pnpm.cmd"],
    },
  );
});

test("a child failure preserves its exit code and stops the remaining plan", async () => {
  const calls = [];
  const plan = createCommandPlan("test", { platform: "linux" });
  await assert.rejects(
    runPlan(plan, {
      spawnFn: fakeSpawnWithCodes([0, 7, 0, 0], calls),
      output() {},
    }),
    (error) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.equal(error.exitCode, 7);
      assert.equal(error.command.label, "api-server:test");
      return true;
    },
  );
  assert.equal(calls.length, 2);

  const cliCalls = [];
  const errors = [];
  const exitCode = await main(["check"], {
    platform: "linux",
    spawnFn: fakeSpawnWithCodes([0, 9, 0, 0], cliCalls),
    output() {},
    errorOutput: (line) => errors.push(line),
  });
  assert.equal(exitCode, 9);
  assert.equal(cliCalls.length, 2);
  assert.match(errors[0], /api-server:check failed with exit code 9/);
});

test("invalid command-line gates fail before spawning", async () => {
  const errors = [];
  assert.equal(
    await main(["unknown"], { errorOutput: (line) => errors.push(line) }),
    2,
  );
  assert.match(errors[0], /gate must be one of/);
});

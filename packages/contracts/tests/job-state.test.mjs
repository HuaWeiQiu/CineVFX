import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_JOB_STATES,
  ALTERNATIVE_TERMINAL_STATES,
  SUCCESS_TERMINAL_STATE,
  TERMINAL_JOB_STATES,
  isAllowedJobTransition,
  requiresManifest,
} from "../src/job-state.mjs";
import { validateAgainstSchema } from "../src/validate-json-schema.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("active lifecycle is monotonic single-step", () => {
  for (let i = 0; i < ACTIVE_JOB_STATES.length - 1; i += 1) {
    assert.equal(
      isAllowedJobTransition(ACTIVE_JOB_STATES[i], ACTIVE_JOB_STATES[i + 1]),
      true,
    );
  }
  assert.equal(isAllowedJobTransition("CREATED", "QUEUED"), false);
  assert.equal(isAllowedJobTransition("RENDERING", "VALIDATING"), false);
});

test("terminal alternatives are allowed from active states only", () => {
  for (const active of ACTIVE_JOB_STATES) {
    for (const terminal of ALTERNATIVE_TERMINAL_STATES) {
      assert.equal(isAllowedJobTransition(active, terminal), true);
    }
    assert.equal(
      isAllowedJobTransition(active, SUCCESS_TERMINAL_STATE),
      active === "EXPORTING",
    );
  }
  for (const terminal of TERMINAL_JOB_STATES) {
    assert.equal(isAllowedJobTransition(terminal, "CREATED"), false);
    assert.equal(isAllowedJobTransition(terminal, "FAILED"), terminal === "FAILED");
  }
});

test("succeeded status example requires manifest id", async () => {
  const status = JSON.parse(
    await readFile(
      path.join(packageRoot, "examples/valid/job-status.succeeded.json"),
      "utf8",
    ),
  );
  assert.equal(requiresManifest(status.state), true);
  assert.ok(status.manifestId);
  const result = await validateAgainstSchema(status, "job-status.schema.json");
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("illegal job state names are rejected by schema", async () => {
  const bad = JSON.parse(
    await readFile(
      path.join(packageRoot, "examples/invalid/job-status.illegal-transition-state.json"),
      "utf8",
    ),
  );
  const result = await validateAgainstSchema(bad, "job-status.schema.json");
  assert.equal(result.valid, false);
});

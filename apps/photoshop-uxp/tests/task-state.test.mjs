import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTaskController,
  TASK_STATES,
} from "../src/task/task-state.mjs";

describe("createTaskController", () => {
  it("starts idle and tracks proxy planning", () => {
    const task = createTaskController();
    assert.equal(task.getSnapshot().state, TASK_STATES.IDLE);
    task.beginProxyPlanning({ kind: "proxy_export_plan" });
    assert.equal(task.getSnapshot().state, TASK_STATES.PLANNING_PROXY);
    task.finishProxyPlanning();
    assert.equal(task.getSnapshot().state, TASK_STATES.IDLE);
  });

  it("walks submit -> polling -> succeeded -> import planned", () => {
    const events = [];
    const task = createTaskController();
    task.subscribe((s) => events.push(s.state));

    task.beginSubmit({ effectLabel: "lightning" });
    assert.equal(task.getSnapshot().effectLabel, "lightning");
    task.markPolling({ jobId: "job_mock_0001" });
    task.updateProgress({ ratio: 0.5, stage: "render_passes" });
    task.markSucceeded({
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
    });
    task.markImportPlanned({ kind: "manifest_import_plan" });

    assert.equal(task.getSnapshot().state, TASK_STATES.IMPORT_PLANNED);
    assert.ok(events.includes(TASK_STATES.POLLING));
    assert.ok(events.includes(TASK_STATES.SUCCEEDED));
  });

  it("supports cancel and failure paths", () => {
    const task = createTaskController();
    task.beginSubmit();
    task.markPolling({ jobId: "job_mock_0002" });
    task.markCancelRequested();
    assert.equal(task.getSnapshot().cancelRequested, true);
    task.markCancelled();
    assert.equal(task.getSnapshot().state, TASK_STATES.CANCELLED);

    task.reset();
    task.beginSubmit();
    task.markFailed({ code: "boom", message: "failed" });
    assert.equal(task.getSnapshot().state, TASK_STATES.FAILED);
    assert.equal(task.getSnapshot().lastError.code, "boom");
  });

  it("rejects illegal transitions", () => {
    const task = createTaskController();
    assert.throws(() => task.markSucceeded({ jobId: "j", manifestId: "m" }));
  });
});

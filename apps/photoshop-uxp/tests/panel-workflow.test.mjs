import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTaskController } from "../src/task/task-state.mjs";
import { createWriteScopeGuard } from "../src/safety/network-boundary.mjs";
import {
  createPanelWorkflow,
  advanceEventCursor,
  bindManifestToSucceededJob,
  DEFAULT_MAX_POLLS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../src/ui/panel-workflow.mjs";
import { createCinevfxClient } from "../src/client/http-client.mjs";
import {
  createMockFetch,
  validAssetDescriptor,
  validJobRequest,
  validManifest,
  digest,
} from "./fixtures.mjs";

const protectedSource = {
  layerStableId: "ps_layer_stable_source_01",
  documentStableId: "ps_doc_stable_01",
  bounds: { x: 0, y: 0, width: 1024, height: 1024 },
};

function defaultSubmitInput(effectLabel = "cinematic-light") {
  return {
    baseUrl: "http://127.0.0.1:8787",
    effectLabel,
    protectedSource: {
      ...protectedSource,
      bounds: { ...protectedSource.bounds },
    },
    assetDescriptors: [
      validAssetDescriptor({ purpose: "proxy" }),
      validAssetDescriptor({
        assetId: "asset_subject_mask_01",
        purpose: "mask",
        digest: digest("3"),
        sourceRole: "user_mask",
      }),
      validAssetDescriptor({
        assetId: "asset_effect_ref_01",
        purpose: "effect_reference",
        digest: digest("a"),
        sourceRole: "user_effect_reference",
      }),
    ],
    jobRequest: validJobRequest(),
  };
}

function buildLifecycleFetch({ cancelCalls }) {
  /** @type {Map<string, unknown>} */
  const assets = new Map();
  let jobState = "CREATED";
  let polls = 0;
  let cancelCount = 0;
  const jobId = "job_mock_0001";
  const manifest = validManifest();

  return createMockFetch({
    "POST /v1/assets": ({ body }) => {
      assets.set(body.assetId, body);
      return { status: 201, body };
    },
    "POST /v1/jobs": ({ body, headers }) => {
      assert.equal(headers.get("Idempotency-Key"), body.idempotencyKey);
      jobState = "QUEUED";
      return {
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: jobState,
          cancelRequested: false,
          progress: { ratio: 0.05, stage: "queued" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      };
    },
    [`GET /v1/jobs/${jobId}`]: () => {
      polls += 1;
      if (jobState === "CANCELLED") {
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "CANCELLED",
            cancelRequested: true,
            progress: { ratio: 0.2, stage: "cancelled" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:02Z",
            finishedAt: "2026-08-12T10:00:02Z",
          },
        };
      }
      if (polls >= 2) {
        jobState = "SUCCEEDED";
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "SUCCEEDED",
            cancelRequested: false,
            progress: { ratio: 1, stage: "succeeded" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:05Z",
            finishedAt: "2026-08-12T10:00:05Z",
            manifestId: manifest.manifestId,
          },
        };
      }
      jobState = "RENDERING";
      return {
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "RENDERING",
          cancelRequested: false,
          progress: { ratio: 0.4, stage: "render" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:01Z",
        },
      };
    },
    [`GET /v1/jobs/${jobId}/events`]: () => ({
      status: 200,
      body: {
        jobId,
        events: [
          {
            schemaVersion: "1.0.0",
            eventId: `evt_progress_${polls}`,
            jobId,
            sequence: polls,
            type: "progress",
            state: "RENDERING",
            timestamp: "2026-08-12T10:00:01Z",
            progress: { ratio: 0.4, stage: "render" },
          },
        ],
      },
    }),
    [`POST /v1/jobs/${jobId}/cancel`]: () => {
      cancelCount += 1;
      if (cancelCalls) cancelCalls.count = cancelCount;
      jobState = "CANCELLED";
      return {
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "CANCELLED",
          cancelRequested: true,
          progress: { ratio: 0.2, stage: "cancelled" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
        },
      };
    },
    [`GET /v1/jobs/${jobId}/manifest`]: () => ({
      status: 200,
      body: manifest,
    }),
  });
}

describe("panel workflow", () => {
  it("uses bounded production polling defaults and rejects burst settings", () => {
    assert.equal(DEFAULT_POLL_INTERVAL_MS, 1_000);
    assert.equal(DEFAULT_MAX_POLLS, 300);
    for (const deps of [
      { pollIntervalMs: 10 },
      { pollIntervalMs: Number.POSITIVE_INFINITY },
      { maxPolls: 0 },
      { maxPolls: 3_601 },
    ]) {
      assert.throws(
        () =>
          createPanelWorkflow({
            task: createTaskController(),
            writeGuard: createWriteScopeGuard(),
            ...deps,
          }),
        /pollIntervalMs|maxPolls/,
      );
    }
  });

  it("starts a new proxy plan from every recoverable terminal UI state", () => {
    for (const terminal of [
      "succeeded",
      "failed",
      "cancelled",
      "import_planned",
    ]) {
      const task = createTaskController();
      task.beginSubmit({ effectLabel: "previous" });
      if (terminal === "failed") {
        task.markFailed({ code: "previous", message: "previous failure" });
      } else if (terminal === "cancelled") {
        task.markCancelled();
      } else {
        task.markPolling({ jobId: "job_previous_0001" });
        task.markSucceeded({
          jobId: "job_previous_0001",
          manifestId: "manifest_previous_0001",
        });
        if (terminal === "import_planned") {
          task.markImportPlanned({ kind: "previous_import" });
        }
      }
      const workflow = createPanelWorkflow({
        task,
        writeGuard: createWriteScopeGuard(),
      });

      const plan = workflow.planProxy(protectedSource, {
        effectLabel: `next-${terminal}`,
      });
      assert.equal(plan.effectLabel, `next-${terminal}`);
      assert.equal(task.getSnapshot().state, "idle");
    }
  });

  it("preserves a completed task when a new proxy plan is invalid", async () => {
    const task = createTaskController();
    task.beginSubmit({ effectLabel: "completed" });
    task.markPolling({ jobId: "job_mock_0001" });
    task.markSucceeded({
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
    });
    const before = task.getSnapshot();

    assert.throws(
      () =>
        workflow.planProxy(protectedSource, {
          effectLabel: "x".repeat(129),
        }),
      /effectLabel/i,
    );
    assert.deepEqual(task.getSnapshot(), before);

    const importResult = await workflow.planImport({
      baseUrl: "http://127.0.0.1:8787",
      protectedSource,
      manifest: validManifest(),
    });
    assert.equal(importResult.ok, true);
    assert.equal(task.getSnapshot().state, "import_planned");
  });

  it("does not execute dynamic options before proxy planning", () => {
    const task = createTaskController();
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
    });
    let reads = 0;
    const options = {};
    Object.defineProperty(options, "effectLabel", {
      enumerable: true,
      get() {
        reads += 1;
        return "dynamic";
      },
    });

    assert.throws(
      () => workflow.planProxy(protectedSource, options),
      /stable metadata|data-only/i,
    );
    assert.equal(reads, 0);
    assert.equal(task.getSnapshot().state, "idle");
  });

  it("snapshots and validates the complete submit wrapper before network", async () => {
    for (const mode of ["dynamic", "object"]) {
      const task = createTaskController();
      let networkCalls = 0;
      const workflow = createPanelWorkflow({
        task,
        writeGuard: createWriteScopeGuard(),
        createClient: (opts) =>
          createCinevfxClient({
            ...opts,
            fetchImpl: async () => {
              networkCalls += 1;
              throw new Error("network must not run for invalid submit input");
            },
          }),
      });
      const input = defaultSubmitInput();
      let reads = 0;
      if (mode === "dynamic") {
        Object.defineProperty(input, "effectLabel", {
          enumerable: true,
          get() {
            reads += 1;
            return "dynamic";
          },
        });
      } else {
        input.effectLabel = /** @type {any} */ ({ mutable: "caller-owned" });
      }

      await assert.rejects(
        () => workflow.submitJob(input),
        (error) =>
          error?.code === "invalid_structured_input" ||
          error?.code === "invalid_submit_input",
      );
      assert.equal(reads, 0);
      assert.equal(networkCalls, 0);
      assert.equal(task.getSnapshot().state, "idle");
      assert.equal(task.getSnapshot().effectLabel, "effect");
    }
  });

  it("validates cancel input before changing or aborting active state", async () => {
    const task = createTaskController();
    task.beginSubmit({ effectLabel: "active" });
    let networkCalls = 0;
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      createClient: (opts) =>
        createCinevfxClient({
          ...opts,
          fetchImpl: async () => {
            networkCalls += 1;
            throw new Error("network must not run for invalid cancel input");
          },
        }),
    });
    let reads = 0;
    const input = {};
    Object.defineProperty(input, "baseUrl", {
      enumerable: true,
      get() {
        reads += 1;
        return "http://127.0.0.1:8787";
      },
    });

    await assert.rejects(
      () => workflow.cancelActiveJob(input),
      (error) => error?.code === "invalid_structured_input",
    );
    assert.equal(reads, 0);
    assert.equal(networkCalls, 0);
    assert.equal(task.getSnapshot().state, "submitting");
    assert.equal(task.getSnapshot().cancelRequested, false);
  });

  it("rejects foreign submit, cancel, and import origins before side effects", async () => {
    let networkCalls = 0;
    const makeWorkflow = (task) =>
      createPanelWorkflow({
        task,
        writeGuard: createWriteScopeGuard(),
        createClient: (opts) =>
          createCinevfxClient({
            ...opts,
            fetchImpl: async () => {
              networkCalls += 1;
              throw new Error("network must not run for a foreign origin");
            },
          }),
      });

    const submitTask = createTaskController();
    await assert.rejects(() =>
      makeWorkflow(submitTask).submitJob({
        ...defaultSubmitInput(),
        baseUrl: "https://example.com:8787",
      }),
    );
    assert.equal(submitTask.getSnapshot().state, "idle");

    const cancelTask = createTaskController();
    cancelTask.beginSubmit({ effectLabel: "active" });
    await assert.rejects(() =>
      makeWorkflow(cancelTask).cancelActiveJob({
        baseUrl: "https://localhost:8787/path",
      }),
    );
    assert.equal(cancelTask.getSnapshot().state, "submitting");
    assert.equal(cancelTask.getSnapshot().cancelRequested, false);

    const importTask = createTaskController();
    importTask.beginSubmit({ effectLabel: "complete" });
    importTask.markPolling({ jobId: "job_mock_0001" });
    importTask.markSucceeded({
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
    });
    await assert.rejects(() =>
      makeWorkflow(importTask).planImport({
        baseUrl: "not a url",
        protectedSource,
        manifest: validManifest(),
      }),
    );
    assert.equal(importTask.getSnapshot().state, "succeeded");
    assert.equal(networkCalls, 0);
  });

  it("Submit posts assets and job, polls, validates manifest, enables import planning", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const logs = [];
    /** @type {string[]} */
    const methods = [];

    const cancelCalls = { count: 0 };
    const fetchImpl = buildLifecycleFetch({ cancelCalls });
    const trackedFetch = async (url, init = {}) => {
      methods.push(`${(init.method ?? "GET").toUpperCase()} ${new URL(url).pathname}`);
      return fetchImpl(url, init);
    };

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      log: (m, f) => logs.push({ m, f }),
      sleep: async () => {},
      maxPolls: 10,
      createClient: (opts) =>
        createCinevfxClient({
          ...opts,
          fetchImpl: trackedFetch,
        }),
    });

    const proxyPlan = workflow.planProxy(protectedSource, {
      effectLabel: "lightning-burst",
    });
    assert.equal(proxyPlan.effectLabel, "lightning-burst");

    await workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "lightning-burst",
      protectedSource,
      proxyPlan,
      assetDescriptors: [
        validAssetDescriptor({
          assetId: "asset_proxy_source_01",
          digest: digest("1"),
          purpose: "proxy",
        }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          digest: digest("3"),
          purpose: "mask",
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          digest: digest("a"),
          purpose: "effect_reference",
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest({
        effectSpec: {
          ...validJobRequest().effectSpec,
          label: "lightning-burst",
        },
      }),
    });

    const snap = task.getSnapshot();
    assert.equal(snap.state, "succeeded");
    assert.equal(snap.jobId, "job_mock_0001");
    assert.equal(snap.manifestId, "manifest_mock_0001");
    assert.ok(methods.some((m) => m.startsWith("POST /v1/assets")));
    assert.ok(methods.some((m) => m === "POST /v1/jobs"));
    assert.ok(methods.some((m) => m === "GET /v1/jobs/job_mock_0001"));
    assert.ok(methods.some((m) => m === "GET /v1/jobs/job_mock_0001/manifest"));

    const afterStaleCancel = await workflow.cancelActiveJob({
      baseUrl: "http://127.0.0.1:8787",
    });
    assert.equal(afterStaleCancel.state, "succeeded");
    assert.equal(afterStaleCancel.cancelRequested, false);
    assert.equal(cancelCalls.count, 0);

    const importResult = await workflow.planImport({
      baseUrl: "http://127.0.0.1:8787",
      protectedSource,
    });
    assert.equal(importResult.ok, true);
    assert.equal(task.getSnapshot().state, "import_planned");
    assert.equal(importResult.plan.transaction.noPartialGroup, true);
  });

  it("Cancel posts cancel endpoint and is idempotent on repeat", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const cancelCalls = { count: 0 };

    // Fetch that stays rendering until cancel.
    const jobId = "job_mock_0001";
    let cancelled = false;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: cancelled ? "CANCELLED" : "RENDERING",
          cancelRequested: cancelled,
          progress: { ratio: 0.3, stage: cancelled ? "cancelled" : "render" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:01Z",
          ...(cancelled
            ? { finishedAt: "2026-08-12T10:00:02Z" }
            : {}),
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({ hang: true }),
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCalls.count += 1;
        cancelled = true;
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "CANCELLED",
            cancelRequested: true,
            progress: { ratio: 0.3, stage: "cancelled" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:02Z",
            finishedAt: "2026-08-12T10:00:02Z",
          },
        };
      },
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      maxPolls: 5,
      requestTimeoutMs: 60_000,
      createClient: (opts) =>
        createCinevfxClient({ ...opts, fetchImpl }),
    });

    // Start submit without awaiting full completion: drive to polling then cancel.
    const submitPromise = workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "smoke",
      protectedSource,
      assetDescriptors: [
        validAssetDescriptor({ assetId: "asset_proxy_source_01", purpose: "proxy" }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          purpose: "mask",
          digest: digest("3"),
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          purpose: "effect_reference",
          digest: digest("a"),
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest(),
    });

    for (let i = 0; i < 50 && !task.getSnapshot().jobId; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.ok(task.getSnapshot().jobId, "job id should be assigned");

    await workflow.cancelActiveJob({ baseUrl: "http://127.0.0.1:8787" });
    await submitPromise;

    assert.equal(cancelCalls.count, 1);
    const after = task.getSnapshot();
    assert.equal(after.state, "cancelled");

    const repeated = await workflow.cancelActiveJob({
      baseUrl: "http://127.0.0.1:8787",
    });
    assert.equal(repeated.state, "cancelled");
    assert.equal(cancelCalls.count, 1);

    // Idempotent cancel on a fresh polling-like re-call using client path:
    const client = createCinevfxClient({ fetchImpl });
    const c1 = await client.cancelJob(jobId);
    const c2 = await client.cancelJob(jobId);
    assert.equal(c1.state, "CANCELLED");
    assert.equal(c2.state, "CANCELLED");
    assert.equal(cancelCalls.count, 3);
  });

  it("rejects foreign manifest jobId/manifestId and does not cache success", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    const foreign = validManifest({
      jobId: "job_other_9999",
      manifestId: "manifest_other_9999",
    });
    let polls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => {
        polls += 1;
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "SUCCEEDED",
            cancelRequested: false,
            progress: { ratio: 1, stage: "done" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:02Z",
            finishedAt: "2026-08-12T10:00:02Z",
            manifestId: "manifest_mock_0001",
          },
        };
      },
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: foreign,
      }),
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 5,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await assert.rejects(
      () =>
        workflow.submitJob({
          baseUrl: "http://127.0.0.1:8787",
          effectLabel: "fire",
          protectedSource,
          assetDescriptors: [
            validAssetDescriptor({ purpose: "proxy" }),
            validAssetDescriptor({
              assetId: "asset_subject_mask_01",
              purpose: "mask",
              digest: digest("3"),
              sourceRole: "user_mask",
            }),
            validAssetDescriptor({
              assetId: "asset_effect_ref_01",
              purpose: "effect_reference",
              digest: digest("a"),
              sourceRole: "user_effect_reference",
            }),
          ],
          jobRequest: validJobRequest(),
        }),
      (error) => error?.code === "invalid_response",
    );

    const snap = task.getSnapshot();
    assert.equal(snap.state, "failed");
    assert.equal(snap.lastError?.code, "invalid_response");
    assert.equal(workflow.getLastValidatedManifest(), null);
    assert.ok(polls >= 1);
  });

  it("rejects valid manifest with mismatched manifestId from JobStatus", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    const wrongId = validManifest({
      jobId,
      manifestId: "manifest_other_0002",
    });
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "done" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: wrongId,
      }),
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 3,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "fire",
      protectedSource,
      assetDescriptors: [
        validAssetDescriptor({ purpose: "proxy" }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          purpose: "mask",
          digest: digest("3"),
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          purpose: "effect_reference",
          digest: digest("a"),
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest(),
    });

    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(task.getSnapshot().lastError?.code, "manifest_id_mismatch");
    assert.equal(workflow.getLastValidatedManifest(), null);
  });

  it("rejects manifest whose protectedSource differs from submitted source", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    const foreignSource = validManifest({
      protectedSource: {
        layerStableId: "ps_layer_other",
        documentStableId: "ps_doc_stable_01",
        immutable: true,
        untouched: true,
      },
    });
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "done" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: foreignSource,
      }),
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 3,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "fire",
      protectedSource,
      assetDescriptors: [
        validAssetDescriptor({ purpose: "proxy" }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          purpose: "mask",
          digest: digest("3"),
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          purpose: "effect_reference",
          digest: digest("a"),
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest(),
    });

    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(
      task.getSnapshot().lastError?.code,
      "manifest_protected_source_mismatch",
    );
    assert.equal(workflow.getLastValidatedManifest(), null);
  });

  it("advances event cursor through sequence zero", async () => {
    assert.equal(advanceEventCursor(-1, 0), 0);
    assert.equal(advanceEventCursor(0, 0), 0);
    assert.equal(advanceEventCursor(0, 1), 1);

    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    /** @type {string[]} */
    const afterValues = [];
    let polls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: ({ url }) => {
        const after = url.searchParams.get("afterSequence");
        afterValues.push(after ?? "");
        if (after === "-1") {
          return {
            status: 200,
            body: {
              jobId,
              events: [
                {
                  schemaVersion: "1.0.0",
                  eventId: "evt_0",
                  jobId,
                  sequence: 0,
                  type: "progress",
                  state: "RENDERING",
                  timestamp: "2026-08-12T10:00:01Z",
                  progress: { ratio: 0.1, stage: "start" },
                },
              ],
            },
          };
        }
        // After advancing past 0, subsequent polls must use afterSequence=0 (not -1).
        return {
          status: 200,
          body: {
            jobId,
            events: [
              {
                schemaVersion: "1.0.0",
                eventId: "evt_1",
                jobId,
                sequence: 1,
                type: "progress",
                state: "RENDERING",
                timestamp: "2026-08-12T10:00:02Z",
                progress: { ratio: 0.5, stage: "render" },
              },
            ],
          },
        };
      },
      [`GET /v1/jobs/${jobId}`]: () => {
        polls += 1;
        if (polls < 2) {
          return {
            status: 200,
            body: {
              schemaVersion: "1.0.0",
              jobId,
              idempotencyKey: "idem_mock_slice_request_0001",
              state: "RENDERING",
              cancelRequested: false,
              progress: { ratio: 0.5, stage: "render" },
              createdAt: "2026-08-12T10:00:00Z",
              updatedAt: "2026-08-12T10:00:01Z",
            },
          };
        }
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "SUCCEEDED",
            cancelRequested: false,
            progress: { ratio: 1, stage: "done" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:03Z",
            finishedAt: "2026-08-12T10:00:03Z",
            manifestId: "manifest_mock_0001",
          },
        };
      },
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: validManifest(),
      }),
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 5,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "smoke",
      protectedSource,
      assetDescriptors: [
        validAssetDescriptor({ purpose: "proxy" }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          purpose: "mask",
          digest: digest("3"),
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          purpose: "effect_reference",
          digest: digest("a"),
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest(),
    });

    assert.equal(task.getSnapshot().state, "succeeded");
    assert.ok(afterValues.includes("-1"));
    assert.ok(
      afterValues.includes("0"),
      `expected afterSequence=0 after first event, got ${JSON.stringify(afterValues)}`,
    );
    // Must not re-request with -1 after seeing sequence 0.
    const firstZero = afterValues.indexOf("0");
    assert.ok(firstZero > 0);
    assert.equal(afterValues.slice(firstZero).includes("-1"), false);
  });

  it("rejects a regressing sequence of individually valid job statuses", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    const states = ["RENDERING", "VALIDATING", "SUCCEEDED"];
    let statusIndex = 0;
    const statusBody = (state) => ({
      schemaVersion: "1.0.0",
      jobId,
      idempotencyKey: "idem_mock_slice_request_0001",
      state,
      cancelRequested: false,
      progress: {
        ratio: state === "RENDERING" ? 0.4 : state === "VALIDATING" ? 0.1 : 1,
        stage: state.toLowerCase(),
      },
      createdAt: "2026-08-12T10:00:00Z",
      updatedAt: "2026-08-12T10:00:01Z",
      ...(state === "SUCCEEDED"
        ? {
            finishedAt: "2026-08-12T10:00:02Z",
            manifestId: "manifest_mock_0001",
          }
        : {}),
    });
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          ...statusBody("CREATED"),
          idempotencyKey: body.idempotencyKey,
          progress: { ratio: 0, stage: "created" },
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: statusBody(states[statusIndex++] ?? "SUCCEEDED"),
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: validManifest(),
      }),
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 5,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await assert.rejects(
      () => workflow.submitJob(defaultSubmitInput()),
      (error) => error?.code === "job_state_regression",
    );
    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(task.getSnapshot().lastError?.code, "job_state_regression");
    assert.equal(workflow.getLastValidatedManifest(), null);
  });

  it("rejects a caller-supplied submission graph before any network request", async () => {
    const validInput = defaultSubmitInput();
    const validRequest = validJobRequest();
    const sparseRequest = validJobRequest();
    sparseRequest.effectSpec.primitives.length += 1;
    const overriddenArrayRequest = validJobRequest();
    overriddenArrayRequest.effectSpec.references[0].prompt = "must-reject";
    overriddenArrayRequest.effectSpec.references.forEach = () => {};
    overriddenArrayRequest.effectSpec.references.map = () =>
      overriddenArrayRequest.effectSpec.references;
    const duplicateProxy = {
      ...validInput.assetDescriptors[0],
    };
    for (const input of [
      {
        ...defaultSubmitInput(),
        jobRequest: validJobRequest({
          protectedSource: { layerStableId: "ps_layer_foreign_0001" },
        }),
      },
      {
        ...defaultSubmitInput(),
        assetDescriptors: [
          validAssetDescriptor({
            assetId: "asset_unbound_proxy_0001",
            purpose: "proxy",
          }),
          ...defaultSubmitInput().assetDescriptors.slice(1),
        ],
      },
      {
        ...validInput,
        assetDescriptors: [...validInput.assetDescriptors, duplicateProxy],
        jobRequest: validJobRequest({
          inputAssets: [
            ...validRequest.inputAssets,
            { ...validRequest.inputAssets[0] },
          ],
        }),
      },
      {
        ...validInput,
        assetDescriptors: validInput.assetDescriptors.slice(1),
        jobRequest: validJobRequest({
          inputAssets: validRequest.inputAssets.slice(1),
        }),
      },
      {
        ...validInput,
        jobRequest: validJobRequest({
          effectSpec: { canvas: { width: 0 } },
        }),
      },
      {
        ...validInput,
        assetDescriptors: [
          validInput.assetDescriptors[0],
          {
            ...validInput.assetDescriptors[1],
            dimensions: { width: 0, height: 1024 },
          },
          validInput.assetDescriptors[2],
        ],
      },
      {
        ...validInput,
        assetDescriptors: [
          validInput.assetDescriptors[0],
          Object.create(validInput.assetDescriptors[1]),
          validInput.assetDescriptors[2],
        ],
      },
      {
        ...validInput,
        jobRequest: Object.create(validRequest),
      },
      {
        ...validInput,
        jobRequest: sparseRequest,
      },
      {
        ...validInput,
        jobRequest: overriddenArrayRequest,
      },
      {
        ...validInput,
        assetDescriptors: [
          validInput.assetDescriptors[0],
          {
            ...validInput.assetDescriptors[1],
            dimensions: JSON.parse(
              '{"__proto__":{"width":1024},"height":1024}',
            ),
          },
          validInput.assetDescriptors[2],
        ],
      },
    ]) {
      const task = createTaskController();
      let networkCalls = 0;
      const workflow = createPanelWorkflow({
        task,
        writeGuard: createWriteScopeGuard(),
        createClient: (opts) =>
          createCinevfxClient({
            ...opts,
            fetchImpl: async () => {
              networkCalls += 1;
              throw new Error("network must not run for an unbound graph");
            },
          }),
      });

      await assert.rejects(
        () => workflow.submitJob(input),
        (error) =>
          error?.code === "submission_graph_mismatch" ||
          error?.code === "invalid_job_request" ||
          error?.code === "invalid_asset_descriptor" ||
          error?.code === "invalid_structured_input",
      );
      assert.equal(networkCalls, 0);
      assert.equal(task.getSnapshot().state, "idle");
      assert.equal(task.getSnapshot().lastError, null);
    }
  });

  it("does not treat remote error codes as local cancellation or leak details", async () => {
    const secret = "sk-live-secret";
    const privatePath = "/Users/alice/private/source.psd";
    for (const fixture of [
      {
        body: {
          code: "aborted",
          message: `Bearer ${secret} ${privatePath}`,
        },
        expectedCode: "invalid_response",
      },
      {
        body: {
          code: "BACKEND_FAILURE",
          message: `Bearer ${secret} ${privatePath}`,
        },
        expectedCode: "BACKEND_FAILURE",
      },
    ]) {
      const task = createTaskController();
      let networkCalls = 0;
      const workflow = createPanelWorkflow({
        task,
        writeGuard: createWriteScopeGuard(),
        createClient: (opts) =>
          createCinevfxClient({
            ...opts,
            fetchImpl: createMockFetch({
              "POST /v1/assets": () => {
                networkCalls += 1;
                return { status: 500, body: fixture.body };
              },
            }),
          }),
      });

      let thrown;
      await assert.rejects(
        () => workflow.submitJob(defaultSubmitInput()),
        (error) => {
          thrown = error;
          return error?.code === fixture.expectedCode;
        },
      );
      const snapshot = task.getSnapshot();
      assert.equal(networkCalls, 1);
      assert.equal(snapshot.state, "failed");
      assert.equal(snapshot.lastError?.code, fixture.expectedCode);
      const exposed = JSON.stringify({ thrown, snapshot });
      assert.equal(exposed.includes(secret), false);
      assert.equal(exposed.includes(privatePath), false);
    }
  });

  it("redacts terminal job and transport text before task state", async () => {
    const secret = "sk-workflow-secret";
    const privatePath = "/Users/alice/private/source.psd";
    const jobId = "job_mock_0001";
    const statusFetch = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "FAILED",
          cancelRequested: false,
          progress: {
            ratio: 1,
            stage: `Bearer ${secret}`,
            message: privatePath,
          },
          error: {
            code: "BACKEND_FAILURE",
            message: `Bearer ${secret} ${privatePath}`,
          },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
        },
      }),
    });
    const statusTask = createTaskController();
    const statusWorkflow = createPanelWorkflow({
      task: statusTask,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 2,
      createClient: (opts) =>
        createCinevfxClient({ ...opts, fetchImpl: statusFetch }),
    });
    const failed = await statusWorkflow.submitJob(defaultSubmitInput());
    assert.equal(failed.state, "failed");
    assert.equal(JSON.stringify(failed).includes(secret), false);
    assert.equal(JSON.stringify(failed).includes(privatePath), false);

    const transportTask = createTaskController();
    const transportWorkflow = createPanelWorkflow({
      task: transportTask,
      writeGuard: createWriteScopeGuard(),
      createClient: (opts) =>
        createCinevfxClient({
          ...opts,
          fetchImpl: async () => {
            throw new Error(`Bearer ${secret} ${privatePath}`);
          },
        }),
    });
    let thrown;
    await assert.rejects(
      () => transportWorkflow.submitJob(defaultSubmitInput()),
      (error) => {
        thrown = error;
        return error?.code === "network_error";
      },
    );
    const exposed = JSON.stringify({
      errorMessage: thrown?.message,
      snapshot: transportTask.getSnapshot(),
    });
    assert.equal(exposed.includes(secret), false);
    assert.equal(exposed.includes(privatePath), false);
  });

  it("preserves a prior importable success when a new submission fails preflight", async () => {
    const task = createTaskController();
    const routedFetch = buildLifecycleFetch({});
    let networkCalls = 0;
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 5,
      createClient: (opts) =>
        createCinevfxClient({
          ...opts,
          fetchImpl: (...args) => {
            networkCalls += 1;
            return routedFetch(...args);
          },
        }),
    });

    await workflow.submitJob(defaultSubmitInput());
    const before = task.getSnapshot();
    const cachedManifest = workflow.getLastValidatedManifest();
    const callsBeforeInvalidSubmit = networkCalls;
    await assert.rejects(
      () =>
        workflow.submitJob({
          ...defaultSubmitInput(),
          jobRequest: validJobRequest({
            effectSpec: { label: "x".repeat(129) },
          }),
        }),
      (error) => error?.code === "invalid_job_request",
    );

    assert.deepEqual(task.getSnapshot(), before);
    assert.equal(workflow.getLastValidatedManifest(), cachedManifest);
    assert.equal(networkCalls, callsBeforeInvalidSubmit);
    const importResult = await workflow.planImport({
      baseUrl: "http://127.0.0.1:8787",
      protectedSource,
    });
    assert.equal(importResult.ok, true);
    assert.equal(task.getSnapshot().state, "import_planned");
  });

  it("preserves contract-valid constructor and prototype primitive params", async () => {
    const task = createTaskController();
    const request = validJobRequest();
    request.effectSpec.primitives[0].params.constructor = 1;
    request.effectSpec.primitives[0].params.prototype = 2;
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 5,
      createClient: (opts) =>
        createCinevfxClient({
          ...opts,
          fetchImpl: buildLifecycleFetch({}),
        }),
    });

    const result = await workflow.submitJob({
      ...defaultSubmitInput(),
      jobRequest: request,
    });
    assert.equal(result.state, "succeeded");
  });

  it("rejects conflicting terminal states across events and job status", async () => {
    const task = createTaskController();
    const jobId = "job_mock_0001";
    let manifestCalls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: {
          jobId,
          events: [
            {
              schemaVersion: "1.0.0",
              eventId: "evt_cancelled_0001",
              jobId,
              sequence: 0,
              type: "cancel_accepted",
              state: "CANCELLED",
              timestamp: "2026-08-12T10:00:01Z",
            },
          ],
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => {
        manifestCalls += 1;
        return { status: 200, body: validManifest() };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 2,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await assert.rejects(
      () => workflow.submitJob(defaultSubmitInput()),
      (error) => error?.code === "terminal_observation_conflict",
    );
    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(manifestCalls, 0);
  });

  it("binds manifest_ready identity to the succeeded status", async () => {
    const task = createTaskController();
    const jobId = "job_mock_0001";
    let manifestCalls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: {
          jobId,
          events: [
            {
              schemaVersion: "1.0.0",
              eventId: "evt_manifest_ready_0001",
              jobId,
              sequence: 0,
              type: "manifest_ready",
              state: "SUCCEEDED",
              timestamp: "2026-08-12T10:00:01Z",
              manifestId: "manifest_foreign_0001",
            },
          ],
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => {
        manifestCalls += 1;
        return { status: 200, body: validManifest() };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 2,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await assert.rejects(
      () => workflow.submitJob(defaultSubmitInput()),
      (error) => error?.code === "manifest_observation_conflict",
    );
    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(manifestCalls, 0);
  });

  it("binds a replayed createJob success manifestId to the fetched manifest", async () => {
    const task = createTaskController();
    const jobId = "job_mock_0001";
    let manifestCalls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:01Z",
          finishedAt: "2026-08-12T10:00:01Z",
          manifestId: "manifest_first_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => {
        manifestCalls += 1;
        return { status: 200, body: validManifest() };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 2,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    const result = await workflow.submitJob(defaultSubmitInput());
    assert.equal(result.state, "failed");
    assert.equal(result.lastError?.code, "manifest_id_mismatch");
    assert.equal(manifestCalls, 1);
  });

  it("recovers task state when client initialization throws", async () => {
    const task = createTaskController();
    let initCalls = 0;
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      createClient: () => {
        initCalls += 1;
        throw new Error("client initialization failed");
      },
    });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assert.rejects(
        () => workflow.submitJob(defaultSubmitInput()),
        /client initialization failed/,
      );
      assert.equal(task.getSnapshot().state, "idle");
      assert.equal(task.getSnapshot().lastError, null);
      assert.equal(initCalls, attempt);
    }
  });

  it("uses an immutable submission snapshot across network awaits", async () => {
    const task = createTaskController();
    const jobId = "job_mock_0001";
    const submitInput = defaultSubmitInput();
    let assetCalls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => {
        assetCalls += 1;
        if (assetCalls === 1) {
          submitInput.protectedSource.layerStableId = "ps_layer_foreign_0001";
          submitInput.jobRequest.protectedSource.layerStableId =
            "ps_layer_foreign_0001";
        }
        return { status: 201, body };
      },
      "POST /v1/jobs": ({ body }) => {
        assert.equal(
          body.protectedSource.layerStableId,
          "ps_layer_stable_source_01",
        );
        return {
          status: 201,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: body.idempotencyKey,
            state: "CREATED",
            cancelRequested: false,
            progress: { ratio: 0, stage: "created" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:00Z",
          },
        };
      },
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: validManifest(),
      }),
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      sleep: async () => {},
      maxPolls: 2,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    const result = await workflow.submitJob(submitInput);
    assert.equal(result.state, "succeeded");
    assert.equal(assetCalls, 3);
    assert.equal(
      submitInput.protectedSource.layerStableId,
      "ps_layer_foreign_0001",
    );
    assert.equal(
      workflow.getLastValidatedManifest()?.protectedSource.layerStableId,
      "ps_layer_stable_source_01",
    );
  });

  it("rejects a repeated eventId across paginated event responses", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    const repeatedEventId = "evt_reused_across_pages_0001";
    let polls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: ({ url }) => {
        const after = Number(url.searchParams.get("afterSequence"));
        const sequence = after < 0 ? 0 : 1;
        return {
          status: 200,
          body: {
            jobId,
            events: [
              {
                schemaVersion: "1.0.0",
                eventId: repeatedEventId,
                jobId,
                sequence,
                type: "progress",
                state: "RENDERING",
                timestamp: "2026-08-12T10:00:01Z",
                progress: { ratio: 0.4, stage: "render" },
              },
            ],
          },
        };
      },
      [`GET /v1/jobs/${jobId}`]: () => {
        polls += 1;
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "RENDERING",
            cancelRequested: false,
            progress: { ratio: 0.4, stage: "render" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:01Z",
          },
        };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 3,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await assert.rejects(
      () => workflow.submitJob(defaultSubmitInput()),
      (error) => error?.code === "duplicate_event_id",
    );
    assert.equal(polls, 1);
    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(task.getSnapshot().lastError?.code, "duplicate_event_id");
  });

  it("cancels a stalled in-flight request via AbortSignal", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    let cancelCount = 0;
    let assetCalls = 0;
    const jobId = "job_mock_0001";
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => {
        assetCalls += 1;
        if (assetCalls === 1) {
          return { status: 201, body };
        }
        // Second asset hangs until abort.
        return { hang: true };
      },
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCount += 1;
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "CANCELLED",
            cancelRequested: true,
            progress: { ratio: 0, stage: "cancelled" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:02Z",
            finishedAt: "2026-08-12T10:00:02Z",
          },
        };
      },
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 5,
      requestTimeoutMs: 60_000,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    const submitPromise = workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "smoke",
      protectedSource,
      assetDescriptors: [
        validAssetDescriptor({ purpose: "proxy" }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          purpose: "mask",
          digest: digest("3"),
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          purpose: "effect_reference",
          digest: digest("a"),
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest(),
    });

    // Wait until network hang is active.
    for (let i = 0; i < 50 && !writeGuard.isNetworkActive(); i += 1) {
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(writeGuard.isNetworkActive(), true);

    const cancelSnap = await workflow.cancelActiveJob({
      baseUrl: "http://127.0.0.1:8787",
    });
    // cancelActiveJob must return even while a request was stalled.
    assert.ok(cancelSnap.cancelRequested || cancelSnap.state === "cancelled");

    const finalSnap = await submitPromise;
    assert.ok(
      finalSnap.state === "cancelled" || finalSnap.cancelRequested === true,
      `unexpected final state ${finalSnap.state}`,
    );
    // No hang left holding the network guard.
    assert.equal(writeGuard.isNetworkActive(), false);
  });

  it("consumes replayed terminal create responses without polling", async () => {
    for (const state of ["CANCELLED", "FAILED", "SUCCEEDED"]) {
      const task = createTaskController();
      const jobId = "job_mock_0001";
      let eventCalls = 0;
      let statusCalls = 0;
      let manifestCalls = 0;
      const fetchImpl = createMockFetch({
        "POST /v1/assets": ({ body }) => ({ status: 201, body }),
        "POST /v1/jobs": ({ body }) => ({
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: body.idempotencyKey,
            state,
            cancelRequested: state === "CANCELLED",
            progress: { ratio: 1, stage: state.toLowerCase() },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:02Z",
            finishedAt: "2026-08-12T10:00:02Z",
            ...(state === "FAILED"
              ? {
                  error: {
                    code: "BACKEND_FAILURE",
                    message: "render failed",
                  },
                }
              : {}),
            ...(state === "SUCCEEDED"
              ? { manifestId: "manifest_mock_0001" }
              : {}),
          },
        }),
        [`GET /v1/jobs/${jobId}/events`]: () => {
          eventCalls += 1;
          return {
            status: 503,
            body: { code: "BACKEND_UNAVAILABLE", message: "must not poll" },
          };
        },
        [`GET /v1/jobs/${jobId}`]: () => {
          statusCalls += 1;
          return {
            status: 503,
            body: { code: "BACKEND_UNAVAILABLE", message: "must not poll" },
          };
        },
        [`GET /v1/jobs/${jobId}/manifest`]: () => {
          manifestCalls += 1;
          return { status: 200, body: validManifest() };
        },
      });
      const workflow = createPanelWorkflow({
        task,
        writeGuard: createWriteScopeGuard(),
        createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
      });

      const result = await workflow.submitJob(defaultSubmitInput());
      assert.equal(result.state, state.toLowerCase());
      assert.equal(eventCalls, 0);
      assert.equal(statusCalls, 0);
      assert.equal(manifestCalls, state === "SUCCEEDED" ? 1 : 0);
      if (state === "FAILED") {
        assert.equal(result.lastError?.code, "BACKEND_FAILURE");
      }
    }
  });

  it("keeps replayed success authoritative when cancel races with manifest fetch", async () => {
    const task = createTaskController();
    const jobId = "job_mock_0001";
    let manifestCalls = 0;
    let cancelCalls = 0;
    let releaseManifest = () => {};
    const manifestGate = new Promise((resolve) => {
      releaseManifest = () =>
        resolve({ status: 200, body: validManifest() });
    });
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: "manifest_mock_0001",
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: async () => {
        manifestCalls += 1;
        return manifestGate;
      },
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCalls += 1;
        return {
          status: 409,
          body: { code: "ALREADY_TERMINAL", message: "already succeeded" },
        };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
      requestTimeoutMs: 60_000,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    const pending = workflow.submitJob(defaultSubmitInput());
    for (let index = 0; index < 50 && manifestCalls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(manifestCalls, 1);
    assert.equal(task.getSnapshot().state, "polling");
    assert.equal(task.getSnapshot().jobId, jobId);

    const duringFetch = await workflow.cancelActiveJob({
      baseUrl: "http://127.0.0.1:8787",
    });
    assert.equal(duringFetch.state, "polling");
    assert.equal(duringFetch.cancelRequested, false);
    assert.equal(cancelCalls, 0);

    releaseManifest();
    const result = await pending;
    assert.equal(result.state, "succeeded");
    assert.equal(result.jobId, jobId);
    assert.equal(result.manifestId, "manifest_mock_0001");
    assert.equal(cancelCalls, 0);
  });

  it("does not let cancellation override an observed successful terminal event", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    let statusCalls = 0;
    let cancelCalls = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: {
          jobId,
          events: [
            {
              schemaVersion: "1.0.0",
              eventId: "evt_manifest_ready_0002",
              jobId,
              sequence: 0,
              type: "manifest_ready",
              state: "SUCCEEDED",
              timestamp: "2026-08-12T10:00:01Z",
              manifestId: "manifest_mock_0001",
            },
          ],
        },
      }),
      [`GET /v1/jobs/${jobId}`]: () => {
        statusCalls += 1;
        return { hang: true };
      },
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCalls += 1;
        return {
          status: 200,
          body: {
            schemaVersion: "1.0.0",
            jobId,
            idempotencyKey: "idem_mock_slice_request_0001",
            state: "CANCELLED",
            cancelRequested: true,
            progress: { ratio: 1, stage: "cancelled" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:02Z",
            finishedAt: "2026-08-12T10:00:02Z",
          },
        };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      requestTimeoutMs: 60_000,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });
    const submitPromise = workflow.submitJob(defaultSubmitInput());
    for (let i = 0; i < 50 && statusCalls === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(statusCalls, 1);

    await workflow.cancelActiveJob({ baseUrl: "http://127.0.0.1:8787" });
    await assert.rejects(
      submitPromise,
      (error) => error?.code === "terminal_observation_conflict",
    );
    assert.equal(cancelCalls, 1);
    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(
      task.getSnapshot().lastError?.code,
      "terminal_observation_conflict",
    );
  });

  it("does not let concurrent cancellation hide an invalid HTTP success response", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    let cancelCalls = 0;
    /** @type {Promise<unknown> | null} */
    let cancelPromise = null;
    /** @type {ReturnType<typeof createPanelWorkflow>} */
    let workflow;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({
        status: 200,
        body: { jobId, events: [] },
      }),
      [`GET /v1/jobs/${jobId}`]: () => {
        queueMicrotask(() => {
          cancelPromise = workflow.cancelActiveJob({
            baseUrl: "http://127.0.0.1:8787",
          });
        });
        return {
          status: 200,
          body: { schemaVersion: "1.0.0", jobId },
        };
      },
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCalls += 1;
        return { status: 500, body: { code: "unexpected_cancel" } };
      },
    });
    workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 2,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    await assert.rejects(
      () => workflow.submitJob(defaultSubmitInput()),
      (error) => error?.code === "invalid_response",
    );
    if (cancelPromise) await cancelPromise;
    assert.equal(cancelCalls, 0);
    assert.equal(task.getSnapshot().state, "failed");
    assert.equal(task.getSnapshot().lastError?.code, "invalid_response");
  });

  it("preserves a validated success when cancel races with server completion", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    const manifest = validManifest();
    let cancelCount = 0;
    let manifestCount = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({ hang: true }),
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCount += 1;
        return {
          status: 409,
          body: {
            code: "JOB_TERMINAL",
            message: "job already succeeded",
          },
        };
      },
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_mock_slice_request_0001",
          state: "SUCCEEDED",
          cancelRequested: false,
          progress: { ratio: 1, stage: "succeeded" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
          manifestId: manifest.manifestId,
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => {
        manifestCount += 1;
        return { status: 200, body: manifest };
      },
    });

    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      sleep: async () => {},
      maxPolls: 5,
      requestTimeoutMs: 60_000,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });
    const submitPromise = workflow.submitJob({
      baseUrl: "http://127.0.0.1:8787",
      effectLabel: "cinematic-light",
      protectedSource,
      assetDescriptors: [
        validAssetDescriptor({ purpose: "proxy" }),
        validAssetDescriptor({
          assetId: "asset_subject_mask_01",
          purpose: "mask",
          digest: digest("3"),
          sourceRole: "user_mask",
        }),
        validAssetDescriptor({
          assetId: "asset_effect_ref_01",
          purpose: "effect_reference",
          digest: digest("a"),
          sourceRole: "user_effect_reference",
        }),
      ],
      jobRequest: validJobRequest(),
    });

    for (let i = 0; i < 50 && !task.getSnapshot().jobId; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(task.getSnapshot().jobId, jobId);
    await workflow.cancelActiveJob({ baseUrl: "http://127.0.0.1:8787" });

    const finalSnap = await submitPromise;
    assert.equal(finalSnap.state, "succeeded");
    assert.equal(finalSnap.manifestId, manifest.manifestId);
    assert.equal(finalSnap.cancelRequested, false);
    assert.equal(cancelCount, 1);
    assert.equal(manifestCount, 1);
    assert.equal(workflow.getLastValidatedManifest()?.manifestId, manifest.manifestId);
    assert.equal(writeGuard.isNetworkActive(), false);
  });

  it("fails closed when cancellation cannot be confirmed by the server", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const jobId = "job_mock_0001";
    let cancelCount = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": ({ body }) => ({
        status: 201,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: body.idempotencyKey,
          state: "CREATED",
          cancelRequested: false,
          progress: { ratio: 0, stage: "created" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:00Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: () => ({ hang: true }),
      [`POST /v1/jobs/${jobId}/cancel`]: () => {
        cancelCount += 1;
        return {
          status: 503,
          body: { code: "UNAVAILABLE", message: "cancel unavailable" },
        };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      requestTimeoutMs: 60_000,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    const submitPromise = workflow.submitJob(defaultSubmitInput());
    for (let i = 0; i < 50 && !task.getSnapshot().jobId; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(task.getSnapshot().jobId, jobId);
    await workflow.cancelActiveJob({ baseUrl: "http://127.0.0.1:8787" });

    const finalSnap = await submitPromise;
    assert.equal(finalSnap.state, "failed");
    assert.equal(finalSnap.lastError?.code, "cancel_reconcile_failed");
    assert.equal(cancelCount, 1);
    assert.equal(workflow.getLastValidatedManifest(), null);
    assert.equal(writeGuard.isNetworkActive(), false);
  });

  it("reports an unconfirmed outcome when job creation is aborted before identity", async () => {
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    let createAttempts = 0;
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => ({ status: 201, body }),
      "POST /v1/jobs": () => {
        createAttempts += 1;
        return { hang: true };
      },
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      requestTimeoutMs: 60_000,
      createClient: (opts) => createCinevfxClient({ ...opts, fetchImpl }),
    });

    const submitPromise = workflow.submitJob(defaultSubmitInput());
    for (let i = 0; i < 50 && createAttempts === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(createAttempts, 1);
    await workflow.cancelActiveJob({ baseUrl: "http://127.0.0.1:8787" });

    const finalSnap = await submitPromise;
    assert.equal(finalSnap.state, "failed");
    assert.equal(finalSnap.lastError?.code, "cancel_unconfirmed");
    assert.equal(finalSnap.jobId, null);
    assert.equal(writeGuard.isNetworkActive(), false);
  });

  it("bindManifestToSucceededJob rejects identity mismatches", () => {
    const ok = bindManifestToSucceededJob(validManifest(), {
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
      protectedSource,
    });
    assert.equal(ok.ok, true);

    const badJob = bindManifestToSucceededJob(
      validManifest({ jobId: "job_other" }),
      {
        jobId: "job_mock_0001",
        manifestId: "manifest_mock_0001",
        protectedSource,
      },
    );
    assert.equal(badJob.ok, false);
    assert.equal(badJob.code, "manifest_job_mismatch");

    const missingDocument = validManifest();
    delete missingDocument.protectedSource.documentStableId;
    const badDocument = bindManifestToSucceededJob(missingDocument, {
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
      protectedSource,
    });
    assert.equal(badDocument.ok, false);
    assert.equal(badDocument.code, "manifest_document_mismatch");
  });

  it("planImport rejects a same-job manifest with a different manifestId", async () => {
    const task = createTaskController();
    task.beginSubmit({ effectLabel: "fire" });
    task.markPolling({ jobId: "job_mock_0001" });
    task.markSucceeded({
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
    });
    const result = await workflow.planImport({
      baseUrl: "http://127.0.0.1:8787",
      protectedSource,
      manifest: validManifest({ manifestId: "manifest_other_0001" }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === "#/manifestId"));
    assert.equal(task.getSnapshot().state, "succeeded");
  });

  it("rejects a dynamic import wrapper input without executing it", async () => {
    const task = createTaskController();
    task.beginSubmit({ effectLabel: "fire" });
    task.markPolling({ jobId: "job_mock_0001" });
    task.markSucceeded({
      jobId: "job_mock_0001",
      manifestId: "manifest_mock_0001",
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard: createWriteScopeGuard(),
    });
    let reads = 0;
    const input = {
      baseUrl: "http://127.0.0.1:8787",
      protectedSource,
    };
    Object.defineProperty(input, "manifest", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("must not execute");
      },
    });

    const result = await workflow.planImport(input);
    assert.equal(result.ok, false);
    assert.equal(result.plan, null);
    assert.equal(result.errors[0]?.path, "#/input");
    assert.equal(reads, 0);
    assert.equal(task.getSnapshot().state, "succeeded");
  });

});

import assert from "node:assert/strict";
import test from "node:test";
import {
  validateDocument,
  validateJobEventStream,
  validateManifestSemantics,
} from "../../../packages/contracts/src/index.mjs";
import { createMockApi } from "../src/service.mjs";
import {
  digest,
  loadValidExample,
  makeAsset,
  makeJobRequest,
  registerDefaultAssets,
  silentLogger,
} from "./helpers.mjs";

function createApi(overrides = {}) {
  const { sink, lines } = silentLogger();
  const api = createMockApi({
    logSink: sink,
    ...overrides,
  });
  return { api, lines };
}

test("registers assets and rejects digest conflicts", async () => {
  const { api } = createApi();
  const asset = makeAsset({
    assetId: "asset_proxy_source_01",
    digest: digest("1"),
    purpose: "proxy",
  });
  const created = await api.createAsset(asset);
  assert.equal(created.status, 201);
  assert.equal(created.body.assetId, asset.assetId);

  const replay = await api.createAsset(asset);
  assert.equal(replay.status, 201);

  await assert.rejects(
    () =>
      api.createAsset({
        ...asset,
        digest: digest("2"),
      }),
    (error) => error.status === 409 && error.code === "ASSET_DIGEST_CONFLICT",
  );
});

test("rejects invalid asset metadata", async () => {
  const { api } = createApi();
  await assert.rejects(
    () =>
      api.createAsset({
        schemaVersion: "1.0.0",
        assetId: "asset_bad",
        mediaType: "image/png",
        // missing required fields
      }),
    (error) => error.status === 400 && error.code === "INVALID_ASSET",
  );
});

test("creates job with success lifecycle, ordered events, and validated manifest", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);

  const request = makeJobRequest({
    idempotencyKey: "idem_success_path_0001",
    label: "arbitrary-lightning-overlay",
  });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "SUCCEEDED");
  assert.equal(created.body.progress.ratio, 1);
  assert.ok(created.body.manifestId);
  assert.equal(created.body.cancelRequested, false);

  const jobId = created.body.jobId;
  const status = api.getJob(jobId);
  assert.equal(status.body.state, "SUCCEEDED");

  const events = api.getJobEvents(jobId);
  assert.equal(events.status, 200);
  assert.ok(events.body.events.length >= 8);
  const stream = validateJobEventStream(events.body.events, { requireContiguousFrom: 0 });
  assert.equal(stream.valid, true, JSON.stringify(stream.errors));

  // sequences strictly increasing
  for (let i = 1; i < events.body.events.length; i += 1) {
    assert.ok(events.body.events[i].sequence > events.body.events[i - 1].sequence);
  }

  const manifestRes = api.getJobManifest(jobId);
  assert.equal(manifestRes.status, 200);
  const manifest = manifestRes.body;
  const schema = await validateDocument("LayerManifest", manifest);
  assert.equal(schema.valid, true, JSON.stringify(schema.errors));
  const semantic = validateManifestSemantics(manifest);
  assert.equal(semantic.valid, true, JSON.stringify(semantic.errors));
  assert.ok(manifest.passes.length >= 1);
  assert.ok(manifest.passes.every((pass) => pass.editable === true));
  assert.equal(manifest.protectedSource.immutable, true);
  assert.equal(manifest.protectedSource.untouched, true);
  for (const pass of manifest.passes) {
    const listed = manifest.assets.find((asset) => asset.assetId === pass.asset.assetId);
    assert.ok(listed);
    assert.equal(listed.digest, pass.asset.digest);
    assert.equal(listed.verified, true);
  }
});

test("exact idempotent replay returns 200 and same jobId", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({ idempotencyKey: "idem_replay_same_0001" });
  const first = await api.createJob(request, request.idempotencyKey);
  const second = await api.createJob(request, request.idempotencyKey);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(first.body.jobId, second.body.jobId);
  assert.equal(first.body.state, second.body.state);
});

test("concurrent exact job replays publish one job atomically", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_concurrent_replay_0001",
    label: "force-hold-concurrent-replay",
  });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => api.createJob(request, request.idempotencyKey)),
  );
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [200, 200, 200, 200, 200, 201],
  );
  assert.equal(new Set(results.map((result) => result.body.jobId)).size, 1);
  assert.equal(api.store.jobsById.size, 1);
  assert.equal(api.store.jobsByIdempotencyKey.size, 1);
  assert.equal(api.store.counters.jobs, 1);
});

test("concurrent conflicting idempotency requests cannot overwrite each other", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const first = makeJobRequest({
    idempotencyKey: "idem_concurrent_conflict_01",
    label: "force-hold-concurrent-first",
  });
  const second = makeJobRequest({
    idempotencyKey: first.idempotencyKey,
    label: "force-hold-concurrent-second",
  });

  const results = await Promise.allSettled([
    api.createJob(first, first.idempotencyKey),
    api.createJob(second, second.idempotencyKey),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.status, 201);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(api.store.jobsById.values().next().value.request, first);
});

test("mutation queue recovers after rejection and preserves maxJobs", async () => {
  const { api } = createApi({ limits: { maxJobs: 1 } });
  await registerDefaultAssets(api);
  const invalid = makeJobRequest({
    idempotencyKey: "idem_queue_reject_first_0001",
    assets: [],
  });
  const valid = makeJobRequest({
    idempotencyKey: "idem_queue_valid_second_0001",
    label: "force-hold-queue-recovery",
  });

  const [failed, created] = await Promise.allSettled([
    api.createJob(invalid, invalid.idempotencyKey),
    api.createJob(valid, valid.idempotencyKey),
  ]);
  assert.equal(failed.status, "rejected");
  assert.equal(created.status, "fulfilled");
  assert.equal(created.value.status, 201);
  assert.equal(created.value.body.jobId, "job_mock_0001");
  assert.equal(api.store.jobsById.size, 1);
  assert.equal(api.store.counters.jobs, 1);
});

test("idempotency conflict rejects different body with same key", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_replay_conflict_0001",
    label: "one",
  });
  await api.createJob(request, request.idempotencyKey);
  const altered = makeJobRequest({
    idempotencyKey: "idem_replay_conflict_0001",
    label: "two",
  });
  await assert.rejects(
    () => api.createJob(altered, altered.idempotencyKey),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("header/body idempotency mismatch is 400", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({ idempotencyKey: "idem_header_body_mismatch1" });
  await assert.rejects(
    () => api.createJob(request, "idem_header_body_mismatch2"),
    (error) => error.status === 400 && error.code === "IDEMPOTENCY_KEY_MISMATCH",
  );
});

test("missing registered asset is rejected", async () => {
  const { api } = createApi();
  // register only proxy, omit effect ref
  await api.createAsset(
    makeAsset({
      assetId: "asset_proxy_source_01",
      digest: digest("1"),
      purpose: "proxy",
    }),
  );
  const request = makeJobRequest({ idempotencyKey: "idem_missing_asset_0001" });
  await assert.rejects(
    () => api.createJob(request, request.idempotencyKey),
    (error) => error.status === 400 && error.code === "ASSET_VALIDATION_FAILED",
  );
});

test("digest mismatch against registered asset is rejected", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_digest_mismatch_0001",
    assets: [
      {
        assetId: "asset_proxy_source_01",
        digest: digest("9"),
        purpose: "proxy",
      },
      {
        assetId: "asset_effect_ref_01",
        digest: digest("a"),
        purpose: "effect_reference",
      },
    ],
  });
  await assert.rejects(
    () => api.createJob(request, request.idempotencyKey),
    (error) => error.status === 400 && error.code === "ASSET_VALIDATION_FAILED",
  );
});

test("idempotent cancellation and terminal immutability", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_cancel_hold_0001",
    label: "force-hold-cancel-case",
  });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.body.state, "RENDERING");
  assert.equal(created.body.cancelRequested, false);

  const cancelled = api.cancelJob(created.body.jobId);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, "CANCELLED");
  assert.equal(cancelled.body.cancelRequested, true);
  assert.ok(cancelled.body.finishedAt);
  assert.equal(cancelled.body.manifestId, undefined);
  assert.equal(cancelled.body.error, undefined);

  const again = api.cancelJob(created.body.jobId);
  assert.equal(again.status, 200);
  assert.equal(again.body.state, "CANCELLED");
  assert.equal(again.body.jobId, cancelled.body.jobId);

  assert.throws(
    () => api.getJobManifest(created.body.jobId),
    (error) => error.status === 409 && error.code === "MANIFEST_UNAVAILABLE",
  );
});

test("cancellation capacity failure leaves the live job completely unchanged", async () => {
  const { api } = createApi({ limits: { maxEventsPerJob: 7 } });
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_cancel_atomic_limit_0001",
    label: "force-hold-cancel-atomic",
  });
  const created = await api.createJob(request, request.idempotencyKey);
  const jobId = created.body.jobId;
  const job = api.store.jobsById.get(jobId);
  const before = {
    status: api.getJob(jobId).body,
    events: api.getJobEvents(jobId).body.events,
    nextSequence: job.nextSequence,
    terminal: job.terminal,
  };

  assert.throws(
    () => api.cancelJob(jobId),
    (error) => error.status === 400 && error.code === "RESOURCE_LIMIT",
  );
  assert.deepEqual(
    {
      status: api.getJob(jobId).body,
      events: api.getJobEvents(jobId).body.events,
      nextSequence: job.nextSequence,
      terminal: job.terminal,
    },
    before,
  );

  api.store.limits.maxEventsPerJob = 8;
  const cancelled = api.cancelJob(jobId);
  assert.equal(cancelled.body.state, "CANCELLED");
  const events = api.getJobEvents(jobId).body.events;
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index));
});

test("cancel on succeeded job is 409", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({ idempotencyKey: "idem_cancel_success_0001" });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.body.state, "SUCCEEDED");
  assert.throws(
    () => api.cancelJob(created.body.jobId),
    (error) => error.status === 409 && error.code === "JOB_TERMINAL",
  );
});

test("failure path is terminal and immutable", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_fail_path_0001",
    label: "mock-fail-validation",
  });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.body.state, "FAILED");
  assert.ok(created.body.error);
  assert.equal(created.body.error.code, "MOCK_FORCED_FAILURE");
  assert.equal(created.body.manifestId, undefined);
  assert.equal(created.body.cancelRequested, false);

  assert.throws(
    () => api.cancelJob(created.body.jobId),
    (error) => error.status === 409,
  );
  assert.throws(
    () => api.getJobManifest(created.body.jobId),
    (error) => error.status === 409,
  );

  const events = api.getJobEvents(created.body.jobId).body.events;
  assert.ok(events.some((event) => event.type === "error"));
});

test("expiry path is terminal and immutable", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_expire_path_0001",
    label: "force-expire-case",
  });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.body.state, "EXPIRED");
  assert.ok(created.body.finishedAt);
  assert.equal(created.body.manifestId, undefined);
  assert.equal(created.body.error, undefined);
  assert.equal(created.body.cancelRequested, false);

  assert.throws(() => api.cancelJob(created.body.jobId), (error) => error.status === 409);
});

test("events afterSequence filters ordered stream", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({ idempotencyKey: "idem_events_filter_0001" });
  const created = await api.createJob(request, request.idempotencyKey);
  const all = api.getJobEvents(created.body.jobId).body.events;
  assert.ok(all.length > 2);
  const mid = all[1].sequence;
  const filtered = api.getJobEvents(created.body.jobId, mid).body.events;
  assert.ok(filtered.every((event) => event.sequence > mid));
  assert.equal(filtered.length, all.length - 2);
});

test("contract valid examples can drive a success job", async () => {
  const { api } = createApi();
  const proxy = await loadValidExample("asset-descriptor.proxy.json");
  const effect = await loadValidExample("asset-descriptor.effect-reference.json");
  const mask = makeAsset({
    assetId: "asset_subject_mask_01",
    digest: digest("3"),
    purpose: "mask",
    sourceRole: "user_mask",
  });
  await api.createAsset(proxy);
  await api.createAsset(effect);
  await api.createAsset(mask);

  const request = await loadValidExample("job-request.mock.json");
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "SUCCEEDED");
  const statusValidation = await validateDocument("JobStatus", created.body);
  assert.equal(statusValidation.valid, true, JSON.stringify(statusValidation.errors));
});

test("unknown job returns 404", async () => {
  const { api } = createApi();
  assert.throws(
    () => api.getJob("job_missing_0001"),
    (error) => error.status === 404 && error.code === "JOB_NOT_FOUND",
  );
});

test("resource limits are enforced", async () => {
  const { api } = createApi({ limits: { maxAssets: 1, maxJobs: 1 } });
  const first = makeAsset({
    assetId: "asset_proxy_source_01",
    digest: digest("1"),
    purpose: "proxy",
  });
  await api.createAsset(first);
  // Exact asset replay remains allowed at the resource ceiling.
  const replay = await api.createAsset(first);
  assert.equal(replay.status, 201);
  await assert.rejects(
    () =>
      api.createAsset(
        makeAsset({
          assetId: "asset_effect_ref_01",
          digest: digest("a"),
          purpose: "effect_reference",
        }),
      ),
    (error) => error.status === 400 && error.code === "RESOURCE_LIMIT",
  );
});

test("concurrent asset writes respect resource limits", async () => {
  const { api } = createApi({ limits: { maxAssets: 1 } });
  const first = makeAsset({
    assetId: "asset_concurrent_first_01",
    digest: digest("1"),
    purpose: "proxy",
  });
  const second = makeAsset({
    assetId: "asset_concurrent_second_01",
    digest: digest("2"),
    purpose: "mask",
  });
  const results = await Promise.allSettled([api.createAsset(first), api.createAsset(second)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "RESOURCE_LIMIT");
  assert.equal(api.store.assetsById.size, 1);
});

test("job request semantic mismatch is rejected", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_semantic_mismatch_001",
    assets: [
      {
        assetId: "asset_proxy_source_01",
        digest: digest("1"),
        purpose: "proxy",
      },
      // effectSpec references effect_ref_01, but it is omitted from inputAssets
    ],
  });
  // Rebuild effectSpec to still reference the missing asset.
  request.effectSpec.references = [
    {
      id: "effect_ref",
      assetId: "asset_effect_ref_01",
      role: "effect",
      digest: digest("a"),
      weight: 1,
    },
  ];
  await assert.rejects(
    () => api.createJob(request, request.idempotencyKey),
    (error) => error.status === 400 && error.code === "INVALID_JOB_REQUEST",
  );
});

test("ttl-based expiry path is terminal", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_ttl_expire_path_0001",
    label: "short-ttl-job",
    // Schema minimum is 60; Mock treats the minimum TTL as an expiry steer.
    options: { priority: "normal", dryRun: false, ttlSeconds: 60 },
  });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.body.state, "EXPIRED");
  assert.throws(() => api.cancelJob(created.body.jobId), (error) => error.status === 409);
});

test("dryRun leaves job in CREATED without terminal fields", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_dry_run_created_0001",
    options: { priority: "normal", dryRun: true, ttlSeconds: 1800 },
  });
  const created = await api.createJob(request, request.idempotencyKey);
  assert.equal(created.body.state, "CREATED");
  assert.equal(created.body.progress.ratio, 0);
  assert.equal(created.body.manifestId, undefined);
  assert.equal(created.body.finishedAt, undefined);
  const statusValidation = await validateDocument("JobStatus", created.body);
  assert.equal(statusValidation.valid, true, JSON.stringify(statusValidation.errors));
});


test("idempotency conflict rejects invalid different body before schema validation", async () => {
  const { api } = createApi();
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_invalid_conflict_0001",
    label: "valid-first",
  });
  await api.createJob(request, request.idempotencyKey);

  // Structurally invalid body that still carries the same idempotency key.
  const invalidConflicting = {
    schemaVersion: "1.0.0",
    idempotencyKey: "idem_invalid_conflict_0001",
    // Missing required fields; would be INVALID_JOB_REQUEST if checked first.
  };
  await assert.rejects(
    () => api.createJob(invalidConflicting, invalidConflicting.idempotencyKey),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("maxEventsPerJob rejection leaves no partial published job state", async () => {
  // Success path emits more than 10 events (state changes + progress + assets + manifest).
  const { api } = createApi({ limits: { maxEventsPerJob: 10 } });
  await registerDefaultAssets(api);
  const request = makeJobRequest({
    idempotencyKey: "idem_event_limit_no_partial_01",
    label: "event-limit-case",
  });
  await assert.rejects(
    () => api.createJob(request, request.idempotencyKey),
    (error) => error.status === 400 && error.code === "RESOURCE_LIMIT",
  );

  assert.equal(api.store.jobsById.size, 0);
  assert.equal(api.store.jobsByIdempotencyKey.size, 0);
  assert.equal(api.store.eventsByJobId.size, 0);
  assert.equal(api.store.manifestsByJobId.size, 0);
  assert.equal(api.store.counters.jobs, 0);

  // Retry after raising the limit must create cleanly (no stuck EXPORTING replay).
  const { api: api2 } = createApi({ limits: { maxEventsPerJob: 256 } });
  await registerDefaultAssets(api2);
  const ok = await api2.createJob(request, request.idempotencyKey);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.state, "SUCCEEDED");
});

test("maxJobs limit is enforced and keeps store consistent", async () => {
  const { api } = createApi({ limits: { maxJobs: 1 } });
  await registerDefaultAssets(api);
  const first = makeJobRequest({
    idempotencyKey: "idem_max_jobs_first_0001",
    label: "force-hold-max-jobs",
  });
  const created = await api.createJob(first, first.idempotencyKey);
  assert.equal(created.status, 201);
  assert.equal(api.store.jobsById.size, 1);

  const second = makeJobRequest({
    idempotencyKey: "idem_max_jobs_second_0001",
    label: "force-hold-max-jobs-2",
  });
  await assert.rejects(
    () => api.createJob(second, second.idempotencyKey),
    (error) => error.status === 400 && error.code === "RESOURCE_LIMIT",
  );
  assert.equal(api.store.jobsById.size, 1);
  assert.equal(api.store.jobsByIdempotencyKey.size, 1);
  // Exact replay of the first job remains allowed.
  const replay = await api.createJob(first, first.idempotencyKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.jobId, created.body.jobId);
});

test("createJob logs never include user-controlled effect labels", async () => {
  const captured = silentLogger();
  const { api } = createApi({ logSink: captured.sink });
  await registerDefaultAssets(api);
  const secretLabel = "user-secret-effect-label-should-not-log";
  const request = makeJobRequest({
    idempotencyKey: "idem_no_label_in_logs_0001",
    label: secretLabel,
  });
  await api.createJob(request, request.idempotencyKey);
  const joined = captured.lines.join("\n");
  assert.equal(joined.includes(secretLabel), false);
  assert.ok(captured.lines.length > 0);
});

/**
 * Node-only real-socket integration evidence.
 * This suite does not validate the Photoshop UXP runtime, OS certificate trust,
 * or enforcement of manifest network-origin permissions inside Photoshop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { listen } from "../../apps/api-server/src/index.mjs";
import {
  CinevfxApiError,
  createCinevfxClient,
  createPanelWorkflow,
  createTaskController,
  createWriteScopeGuard,
} from "../../apps/photoshop-uxp/src/public-api.mjs";
import {
  CLIENT_LOOPBACK_ORIGIN,
  PROTECTED_SOURCE,
  createDeferred,
  createEphemeralLoopbackFetch,
  makeAssets,
  makeJobRequest,
  withTimeout,
} from "./fixtures.mjs";

const TEST_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 2_000;

const silentLogSink = Object.freeze({
  info() {},
  warn() {},
  error() {},
  log() {},
});

async function startRuntime(t) {
  const raw = await withTimeout(
    listen({ host: "127.0.0.1", port: 0, logSink: silentLogSink }),
    2_000,
    "Mock API listen",
  );
  let closePromise = null;
  const runtime = {
    ...raw,
    close() {
      if (!closePromise) {
        closePromise = withTimeout(raw.close(), 2_000, "Mock API close").catch(
          async (error) => {
            raw.server.closeAllConnections?.();
            await withTimeout(raw.close(), 1_000, "forced Mock API close").catch(
              () => {},
            );
            throw error;
          },
        );
      }
      return closePromise;
    },
  };
  t.after(async () => {
    await runtime.close();
  });
  assert.equal(runtime.host, "127.0.0.1");
  assert.ok(Number.isInteger(runtime.port) && runtime.port > 0);
  return runtime;
}

function clientFor(runtime, options = {}) {
  const transport = createEphemeralLoopbackFetch(runtime.baseUrl);
  const client = createCinevfxClient({
    baseUrl: CLIENT_LOOPBACK_ORIGIN,
    fetchImpl: transport.fetchImpl,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...options,
  });
  return { client, transport };
}

async function registerAssets(client, assets = makeAssets()) {
  for (const descriptor of assets) {
    const created = await client.createAsset(descriptor);
    assert.deepEqual(created, descriptor);
  }
  return assets;
}

function assertNativeResponsesOnly(transport) {
  assert.equal(
    transport.responses.length,
    transport.requests.length,
    "every dispatched request must return exactly one native fetch response",
  );
  for (const response of transport.responses) {
    assert.match(response.url, /^http:\/\/127\.0\.0\.1:\d+\/(?:healthz|v1\/)/);
    assert.match(response.contentType ?? "", /^application\/json\b/);
  }
}

function assertAuthenticatedBusinessRequests(transport) {
  const healthRequests = transport.requests.filter(
    ({ sourceUrl }) => new URL(sourceUrl).pathname === "/healthz",
  );
  assert.equal(healthRequests.length, 1, "each client must bootstrap exactly once");
  assert.equal(healthRequests[0].hasSessionHeader, false);
  const businessRequests = transport.requests.filter(({ sourceUrl }) =>
    new URL(sourceUrl).pathname.startsWith("/v1/"),
  );
  assert.ok(businessRequests.length > 0);
  assert.ok(
    businessRequests.every(({ hasValidSessionHeader }) => hasValidSessionHeader),
    "every business request must carry a valid bootstrapped session header",
  );
}

test(
  "Node-only real socket: public client crosses the Mock API asset/job/events/status/manifest path",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const runtime = await startRuntime(t);
    const { client, transport } = clientFor(runtime);
    const assets = await registerAssets(client);
    const request = makeJobRequest();

    const created = await client.createJob(request, {
      idempotencyKey: request.idempotencyKey,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, "SUCCEEDED");

    const events = await client.listJobEvents(created.body.jobId);
    assert.equal(events.jobId, created.body.jobId);
    assert.ok(events.events.length > 0);
    assert.ok(events.events.some((event) => event.type === "manifest_ready"));

    const status = await client.getJob(created.body.jobId, {
      expectedIdempotencyKey: request.idempotencyKey,
    });
    assert.equal(status.state, "SUCCEEDED");
    assert.equal(status.manifestId, created.body.manifestId);

    const manifest = await client.getManifest(created.body.jobId);
    assert.equal(manifest.jobId, created.body.jobId);
    assert.equal(manifest.manifestId, status.manifestId);
    assert.equal(manifest.protectedSource.layerStableId, PROTECTED_SOURCE.layerStableId);
    assert.ok(manifest.passes.length > 0);
    assert.ok(manifest.passes.every((pass) => pass.editable === true));
    assert.equal(assets.length, 3);
    assert.equal(JSON.stringify(client).includes("sessionToken"), false);

    assert.deepEqual(
      transport.requests.map(({ method, sourceUrl }) => {
        const url = new URL(sourceUrl);
        return `${method} ${url.pathname}`;
      }),
      [
        "GET /healthz",
        "POST /v1/assets",
        "POST /v1/assets",
        "POST /v1/assets",
        "POST /v1/jobs",
        `GET /v1/jobs/${created.body.jobId}/events`,
        `GET /v1/jobs/${created.body.jobId}`,
        `GET /v1/jobs/${created.body.jobId}/manifest`,
      ],
    );
    assertNativeResponsesOnly(transport);
    assertAuthenticatedBusinessRequests(transport);
  },
);

test(
  "Node-only real socket: panel workflow submits and produces an editable import plan",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const runtime = await startRuntime(t);
    const transport = createEphemeralLoopbackFetch(runtime.baseUrl);
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      pollIntervalMs: 500,
      maxPolls: 4,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      createClient: (options) =>
        createCinevfxClient({ ...options, fetchImpl: transport.fetchImpl }),
    });
    const assets = makeAssets();
    const jobRequest = makeJobRequest({
      idempotencyKey: "idem_integration_workflow_0001",
      label: "integration-workflow-light",
    });

    const snapshot = await workflow.submitJob({
      baseUrl: CLIENT_LOOPBACK_ORIGIN,
      effectLabel: jobRequest.effectSpec.label,
      protectedSource: PROTECTED_SOURCE,
      assetDescriptors: assets,
      jobRequest,
    });
    assert.equal(snapshot.state, "succeeded");
    assert.match(snapshot.jobId ?? "", /^job_/);
    assert.match(snapshot.manifestId ?? "", /^manifest_/);
    assert.equal(writeGuard.isNetworkActive(), false);
    assert.equal(JSON.stringify(snapshot).includes("sessionToken"), false);

    const importResult = await workflow.planImport({
      baseUrl: CLIENT_LOOPBACK_ORIGIN,
      protectedSource: PROTECTED_SOURCE,
    });
    assert.equal(importResult.ok, true, JSON.stringify(importResult.errors));
    assert.ok(importResult.plan);
    assert.ok(importResult.plan.passes.every((pass) => pass.editable === true));
    assert.equal(task.getSnapshot().state, "import_planned");

    const paths = transport.requests.map(({ method, sourceUrl }) => {
      const url = new URL(sourceUrl);
      return `${method} ${url.pathname}`;
    });
    assert.deepEqual(paths.slice(0, 5), [
      "GET /healthz",
      "POST /v1/assets",
      "POST /v1/assets",
      "POST /v1/assets",
      "POST /v1/jobs",
    ]);
    assert.ok(paths.some((entry) => entry.endsWith("/manifest")));
    assertNativeResponsesOnly(transport);
    assertAuthenticatedBusinessRequests(transport);
  },
);

test(
  "Node-only real socket: panel workflow cancels a held job outside its write scope",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const runtime = await startRuntime(t);
    const transport = createEphemeralLoopbackFetch(runtime.baseUrl);
    const task = createTaskController();
    const writeGuard = createWriteScopeGuard();
    const pollSleepReached = createDeferred();
    const releasePollSleep = createDeferred();
    const jobRequest = makeJobRequest({
      idempotencyKey: "idem_integration_cancel_0001",
      label: "force-hold-integration-cancel",
    });
    const workflow = createPanelWorkflow({
      task,
      writeGuard,
      pollIntervalMs: 500,
      maxPolls: 4,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      sleep: async () => {
        pollSleepReached.resolve();
        await releasePollSleep.promise;
      },
      createClient: (options) =>
        createCinevfxClient({ ...options, fetchImpl: transport.fetchImpl }),
    });

    const submitPromise = workflow.submitJob({
      baseUrl: CLIENT_LOOPBACK_ORIGIN,
      effectLabel: jobRequest.effectSpec.label,
      protectedSource: PROTECTED_SOURCE,
      assetDescriptors: makeAssets(),
      jobRequest,
    });

    const verification = clientFor(runtime);
    try {
      await withTimeout(pollSleepReached.promise, 3_000, "held job polling");
      assert.equal(task.getSnapshot().state, "polling");
      assert.equal(writeGuard.isNetworkActive(), true);
      const activeJobId = task.getSnapshot().jobId;
      const crossSiteCancel = await fetch(
        `${runtime.baseUrl}/v1/jobs/${activeJobId}/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            origin: "https://untrusted.example",
          },
          body: "cross-site-cancel-without-session",
        },
      );
      assert.equal(crossSiteCancel.status, 404);
      assert.equal((await crossSiteCancel.json()).code, "NOT_FOUND");
      assert.equal(crossSiteCancel.headers.get("access-control-allow-origin"), null);

      const statusAfterCrossSiteAttempt = await verification.client.getJob(
        activeJobId,
        { expectedIdempotencyKey: jobRequest.idempotencyKey },
      );
      assert.equal(statusAfterCrossSiteAttempt.state, "RENDERING");
      await workflow.cancelActiveJob({ baseUrl: CLIENT_LOOPBACK_ORIGIN });
    } finally {
      releasePollSleep.resolve();
    }

    const finalSnapshot = await withTimeout(
      submitPromise,
      3_000,
      "held job cancellation",
    );
    assert.equal(finalSnapshot.state, "cancelled");
    assert.equal(finalSnapshot.cancelRequested, true);
    assert.equal(writeGuard.isNetworkActive(), false);

    const serverStatus = await verification.client.getJob(finalSnapshot.jobId, {
      expectedIdempotencyKey: jobRequest.idempotencyKey,
    });
    assert.equal(serverStatus.state, "CANCELLED");
    assert.equal(serverStatus.cancelRequested, true);
    const events = await verification.client.listJobEvents(finalSnapshot.jobId);
    assert.ok(events.events.some((event) => event.type === "cancel_accepted"));

    const paths = transport.requests.map(({ method, sourceUrl }) => {
      const url = new URL(sourceUrl);
      return `${method} ${url.pathname}`;
    });
    assert.ok(paths.includes(`POST /v1/jobs/${finalSnapshot.jobId}/cancel`));
    assertNativeResponsesOnly(transport);
    assertAuthenticatedBusinessRequests(transport);
    assertNativeResponsesOnly(verification.transport);
    assertAuthenticatedBusinessRequests(verification.transport);
  },
);

test(
  "Node-only real socket: API, identity, and closed-server transport errors stay distinct",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const runtime = await startRuntime(t);
    const { client, transport } = clientFor(runtime);
    await registerAssets(client);
    const request = makeJobRequest({
      idempotencyKey: "idem_integration_identity_0001",
      label: "integration-identity-boundary",
    });
    const created = await client.createJob(request);

    await assert.rejects(
      client.getJob(created.body.jobId, {
        expectedIdempotencyKey: "idem_integration_foreign_0001",
      }),
      (error) => {
        assert.ok(error instanceof CinevfxApiError);
        assert.equal(error.status, 200);
        assert.equal(error.code, "invalid_response");
        return true;
      },
    );

    await assert.rejects(client.getJob("job_missing_0001"), (error) => {
      assert.ok(error instanceof CinevfxApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "JOB_NOT_FOUND");
      return true;
    });
    assertNativeResponsesOnly(transport);
    assertAuthenticatedBusinessRequests(transport);

    const requestsBeforeClose = transport.requests.length;
    const responsesBeforeClose = transport.responses.length;
    await runtime.close();
    await assert.rejects(client.getJob(created.body.jobId), (error) => {
      assert.ok(error instanceof CinevfxApiError);
      assert.equal(error.status, 0);
      assert.equal(error.code, "network_error");
      return true;
    });
    assert.equal(transport.requests.length, requestsBeforeClose + 1);
    assert.equal(
      transport.responses.length,
      responsesBeforeClose,
      "the adapter must not fabricate a response when native fetch rejects",
    );
  },
);

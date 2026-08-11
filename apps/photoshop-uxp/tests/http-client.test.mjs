import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCinevfxClient,
  CinevfxApiError,
} from "../src/client/http-client.mjs";
import {
  createMockFetch,
  digest,
  validAssetDescriptor,
  validJobRequest,
  validManifest,
} from "./fixtures.mjs";
import { MOCK_ENDPOINTS } from "../src/constants.mjs";
import { assertBoundedJsonBody } from "../src/client/contract-shapes.mjs";

function validJobStatus(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    jobId: "job_mock_0001",
    idempotencyKey: "idem_x_00000001",
    state: "RENDERING",
    cancelRequested: false,
    progress: { ratio: 0.4, stage: "render" },
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:00:01Z",
    ...overrides,
  };
}

function textResponse(status, text, headers = {}) {
  return {
    status,
    statusText: String(status),
    headers: new Headers(headers),
    async text() {
      return text;
    },
  };
}

describe("createCinevfxClient", () => {
  it("exposes all six frozen mock endpoints in package constants", () => {
    assert.equal(MOCK_ENDPOINTS.length, 6);
    assert.ok(MOCK_ENDPOINTS.includes("POST /v1/assets"));
    assert.ok(MOCK_ENDPOINTS.includes("GET /v1/jobs/{id}/manifest"));
  });

  it("accepts only the four exact manifest loopback origins", () => {
    for (const baseUrl of [
      "https://localhost:8787",
      "https://127.0.0.1:8787",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ]) {
      assert.equal(createCinevfxClient({ baseUrl }).baseUrl, baseUrl);
    }

    for (const baseUrl of [
      "not a url",
      "https://example.com:8787",
      "https://localhost:8787/path",
      "https://user@localhost:8787",
      "https://localhost:8787/?query=1",
      "https://localhost:8787/#fragment",
      "http://localhost:8788",
      "ftp://localhost:8787",
      " https://localhost:8787",
    ]) {
      assert.throws(
        () => createCinevfxClient({ baseUrl }),
        /allowed.*loopback origin|match an allowed loopback origin/i,
      );
    }
  });

  it("registers asset metadata via POST /v1/assets", async () => {
    const descriptor = validAssetDescriptor();
    const fetchImpl = createMockFetch({
      "POST /v1/assets": ({ body }) => {
        assert.equal(body.assetId, descriptor.assetId);
        assert.equal(body.digest, descriptor.digest);
        assert.equal("bytes" in body, false);
        assert.equal("imageBytes" in body, false);
        return { status: 201, body: descriptor };
      },
    });
    const client = createCinevfxClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl,
    });
    const result = await client.createAsset(descriptor);
    assert.equal(result.assetId, descriptor.assetId);
  });

  it("rejects an undeclared 200 asset success even with a valid body", async () => {
    const descriptor = validAssetDescriptor();
    const client = createCinevfxClient({
      fetchImpl: createMockFetch({
        "POST /v1/assets": () => ({ status: 200, body: descriptor }),
      }),
    });

    await assert.rejects(
      () => client.createAsset(descriptor),
      (error) =>
        error instanceof CinevfxApiError &&
        error.status === 200 &&
        error.code === "invalid_response",
    );
  });

  it("rejects asset descriptors with imageBytes or unknown fields before network", async () => {
    let fetched = false;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
    });
    await assert.rejects(
      () =>
        client.createAsset({
          ...validAssetDescriptor(),
          imageBytes: "AAAA",
        }),
      (err) => err instanceof CinevfxApiError && err.status === 400,
    );
    assert.equal(fetched, false);
  });

  it("rejects asset fields inherited from a custom prototype before network", async () => {
    let calls = 0;
    const client = createCinevfxClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run");
      },
    });
    const inherited = Object.create(validAssetDescriptor());

    await assert.rejects(
      () => client.createAsset(inherited),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_asset_descriptor",
    );
    assert.equal(calls, 0);
  });

  it("creates jobs with matching Idempotency-Key header and body", async () => {
    const jobRequest = validJobRequest();
    const status = {
      schemaVersion: "1.0.0",
      jobId: "job_mock_0001",
      idempotencyKey: jobRequest.idempotencyKey,
      state: "CREATED",
      cancelRequested: false,
      progress: { ratio: 0, stage: "created" },
      createdAt: "2026-08-12T10:00:00Z",
      updatedAt: "2026-08-12T10:00:00Z",
    };
    const fetchImpl = createMockFetch({
      "POST /v1/jobs": ({ headers, body }) => {
        assert.equal(headers.get("Idempotency-Key"), body.idempotencyKey);
        assert.equal("imageBytes" in body, false);
        assert.equal("prompt" in body, false);
        return { status: 201, body: status };
      },
    });
    const client = createCinevfxClient({ fetchImpl });
    const result = await client.createJob(jobRequest);
    assert.equal(result.status, 201);
    assert.equal(result.body.jobId, "job_mock_0001");
  });

  it("fills body idempotency key from options when body omits it", async () => {
    const jobRequest = validJobRequest();
    delete jobRequest.idempotencyKey;
    const fetchImpl = createMockFetch({
      "POST /v1/jobs": ({ headers, body }) => {
        assert.equal(headers.get("Idempotency-Key"), "idem_header_only_0001");
        assert.equal(body.idempotencyKey, "idem_header_only_0001");
        return {
          status: 201,
          body: {
            schemaVersion: "1.0.0",
            jobId: "job_mock_0001",
            idempotencyKey: body.idempotencyKey,
            state: "CREATED",
            cancelRequested: false,
            progress: { ratio: 0, stage: "created" },
            createdAt: "2026-08-12T10:00:00Z",
            updatedAt: "2026-08-12T10:00:00Z",
          },
        };
      },
    });
    const client = createCinevfxClient({ fetchImpl });
    const result = await client.createJob(jobRequest, {
      idempotencyKey: "idem_header_only_0001",
    });
    assert.equal(result.status, 201);
  });

  it("rejects mismatched idempotency keys before network", async () => {
    const client = createCinevfxClient({
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    });
    await assert.rejects(
      () =>
        client.createJob(validJobRequest(), {
          idempotencyKey: "idem_header_other_0001",
        }),
      (err) => err instanceof CinevfxApiError && err.status === 400,
    );
  });

  it("rejects job requests with sensitive or unknown fields before network", async () => {
    let fetched = false;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
    });
    await assert.rejects(
      () =>
        client.createJob({
          ...validJobRequest(),
          imageBytes: "nope",
        }),
      (err) => err instanceof CinevfxApiError && err.code === "invalid_job_request",
    );
    assert.equal(fetched, false);
  });

  it("rejects sparse arrays throughout job requests before network", async () => {
    let calls = 0;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run");
      },
    });
    const requests = [
      validJobRequest(),
      validJobRequest(),
      validJobRequest(),
      validJobRequest(),
      validJobRequest(),
    ];
    requests[0].effectSpec.references.length += 1;
    requests[1].effectSpec.guidance.anchors.length += 1;
    requests[2].effectSpec.primitives.length += 1;
    requests[3].inputAssets.length += 1;
    requests[4].protectedSource.operationsForbidden.length += 1;

    for (const request of requests) {
      await assert.rejects(
        () => client.createJob(request),
        (error) =>
          error instanceof CinevfxApiError &&
          error.code === "invalid_job_request",
      );
    }
    assert.equal(calls, 0);
  });

  it("does not trust caller-owned array iteration methods", async () => {
    let calls = 0;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run");
      },
    });
    const request = validJobRequest();
    request.effectSpec.references[0].prompt = "must-reject";
    request.effectSpec.references.forEach = () => {};

    await assert.rejects(
      () => client.createJob(request),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_job_request",
    );
    assert.equal(calls, 0);
  });

  it("snapshots only data properties before validating asset and job requests", async () => {
    let calls = 0;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run");
      },
    });
    const asset = validAssetDescriptor();
    Object.defineProperty(asset.dimensions, "width", {
      enumerable: true,
      get() {
        return 1024;
      },
    });
    const job = validJobRequest();
    const reference = job.effectSpec.references[0];
    Object.defineProperty(job.effectSpec.references, "0", {
      enumerable: true,
      get() {
        return reference;
      },
    });

    await assert.rejects(
      () => client.createAsset(asset),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_asset_descriptor",
    );
    await assert.rejects(
      () => client.createJob(job),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_job_request",
    );
    assert.equal(calls, 0);
  });

  it("rejects request-owned JSON conversion hooks before network", async () => {
    let calls = 0;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run");
      },
    });
    const asset = {
      ...validAssetDescriptor(),
      imageBytes: "must-reject",
      toJSON() {
        return validAssetDescriptor();
      },
    };
    const job = {
      ...validJobRequest(),
      prompt: "must-reject",
      toJSON() {
        return validJobRequest();
      },
    };

    await assert.rejects(
      () => client.createAsset(asset),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_asset_descriptor",
    );
    await assert.rejects(
      () => client.createJob(job),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_job_request",
    );
    assert.equal(calls, 0);
  });

  it("gets job, events, cancel, and manifest", async () => {
    const jobId = "job_mock_0001";
    const fetchImpl = createMockFetch({
      [`GET /v1/jobs/${jobId}`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_x_00000001",
          state: "RENDERING",
          cancelRequested: false,
          progress: { ratio: 0.4, stage: "render" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:01Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/events`]: ({ url }) => {
        assert.equal(url.searchParams.get("afterSequence"), "2");
        return {
          status: 200,
          body: {
            jobId,
            events: [
              {
                schemaVersion: "1.0.0",
                eventId: "evt_1",
                jobId,
                sequence: 3,
                type: "progress",
                state: "RENDERING",
                timestamp: "2026-08-12T10:00:01Z",
                progress: { ratio: 0.4 },
              },
            ],
          },
        };
      },
      [`POST /v1/jobs/${jobId}/cancel`]: () => ({
        status: 200,
        body: {
          schemaVersion: "1.0.0",
          jobId,
          idempotencyKey: "idem_x_00000001",
          state: "CANCELLED",
          cancelRequested: true,
          progress: { ratio: 0.4, stage: "cancelled" },
          createdAt: "2026-08-12T10:00:00Z",
          updatedAt: "2026-08-12T10:00:02Z",
          finishedAt: "2026-08-12T10:00:02Z",
        },
      }),
      [`GET /v1/jobs/${jobId}/manifest`]: () => ({
        status: 200,
        body: validManifest({ jobId }),
      }),
    });
    const client = createCinevfxClient({ fetchImpl });
    const job = await client.getJob(jobId);
    assert.equal(job.state, "RENDERING");
    const events = await client.listJobEvents(jobId, { afterSequence: 2 });
    assert.equal(events.events.length, 1);
    const cancelled = await client.cancelJob(jobId);
    assert.equal(cancelled.state, "CANCELLED");
    const manifest = await client.getManifest(jobId);
    assert.equal(manifest.manifestId, "manifest_mock_0001");
  });

  it("rejects invalid event cursors before network", async () => {
    let calls = 0;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run for an invalid cursor");
      },
    });

    for (const afterSequence of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -2]) {
      await assert.rejects(
        () => client.listJobEvents("job_mock_0001", { afterSequence }),
        (error) =>
          error instanceof CinevfxApiError &&
          error.code === "invalid_after_sequence",
      );
    }
    assert.equal(calls, 0);
  });

  it("counts CJK and emoji bytes correctly without TextEncoder", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
    try {
      Object.defineProperty(globalThis, "TextEncoder", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      assert.throws(
        () => assertBoundedJsonBody({ label: "界".repeat(90_000) }),
        /exceeds 262144 bytes/,
      );
      assert.throws(
        () => assertBoundedJsonBody({ label: "😀".repeat(70_000) }),
        /exceeds 262144 bytes/,
      );
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "TextEncoder", original);
      } else {
        delete globalThis.TextEncoder;
      }
    }
  });

  it("invokes onBeforeNetwork before each call", async () => {
    let calls = 0;
    const fetchImpl2 = createMockFetch({
      "GET /v1/jobs/job_mock_0001": () => ({
        status: 200,
        body: validJobStatus(),
      }),
    });
    const client = createCinevfxClient({
      fetchImpl: fetchImpl2,
      onBeforeNetwork: () => {
        calls += 1;
      },
    });
    await client.getJob("job_mock_0001");
    assert.equal(calls, 1);
  });

  it("surfaces HTTP errors as CinevfxApiError", async () => {
    const client = createCinevfxClient({
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_missing": () => ({
          status: 404,
          body: { code: "NOT_FOUND", message: "missing" },
        }),
      }),
    });
    await assert.rejects(
      () => client.getJob("job_missing"),
      (err) =>
        err instanceof CinevfxApiError &&
        err.status === 404 &&
        err.code === "NOT_FOUND",
    );
  });

  it("validates and redacts non-success error envelopes", async () => {
    const secret = "sk-live-secret";
    const privatePath = "/Users/alice/private/source.psd";
    const validClient = createCinevfxClient({
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_missing": () => ({
          status: 500,
          body: {
            code: "BACKEND_FAILURE",
            message: `Bearer ${secret} ${privatePath}`,
          },
        }),
      }),
    });
    await assert.rejects(
      () => validClient.getJob("job_missing"),
      (error) => {
        assert.ok(error instanceof CinevfxApiError);
        assert.equal(error.code, "BACKEND_FAILURE");
        const exposed = JSON.stringify({
          message: error.message,
          code: error.code,
          body: error.body,
        });
        assert.equal(exposed.includes(secret), false);
        assert.equal(exposed.includes(privatePath), false);
        return true;
      },
    );

    const malformedClient = createCinevfxClient({
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_missing": () => ({
          status: 500,
          body: { code: "aborted", message: "must not impersonate local abort" },
        }),
      }),
    });
    await assert.rejects(
      () => malformedClient.getJob("job_missing"),
      (error) =>
        error instanceof CinevfxApiError &&
        error.code === "invalid_response",
    );
  });

  it("redacts successful status text and transport failures", async () => {
    const secret = "sk-status-secret";
    const privatePath = "/Users/alice/private/source.psd";
    const failedStatus = validJobStatus({
      state: "FAILED",
      progress: {
        ratio: 1,
        stage: `Bearer ${secret}`,
        message: privatePath,
      },
      finishedAt: "2026-08-12T10:00:02Z",
      error: {
        code: "BACKEND_FAILURE",
        message: `Bearer ${secret} ${privatePath}`,
      },
    });
    const statusClient = createCinevfxClient({
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_mock_0001": () => ({
          status: 200,
          body: failedStatus,
        }),
      }),
    });
    const status = await statusClient.getJob("job_mock_0001");
    const exposedStatus = JSON.stringify(status);
    assert.equal(exposedStatus.includes(secret), false);
    assert.equal(exposedStatus.includes(privatePath), false);

    const expansionClient = createCinevfxClient({
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_mock_0001": () => ({
          status: 200,
          body: validJobStatus({
            state: "FAILED",
            progress: {
              ratio: 1,
              stage: "Bearer a ".repeat(7).trim(),
              message: "Bearer a ".repeat(28).trim(),
            },
            finishedAt: "2026-08-12T10:00:02Z",
            error: {
              code: "BACKEND_FAILURE",
              message: "Bearer a ".repeat(56).trim(),
            },
          }),
        }),
        "GET /v1/jobs/job_mock_0001/events": () => ({
          status: 200,
          body: {
            jobId: "job_mock_0001",
            events: [
              {
                schemaVersion: "1.0.0",
                eventId: "evt_progress_0001",
                jobId: "job_mock_0001",
                sequence: 1,
                type: "progress",
                state: "RENDERING",
                timestamp: "2026-08-12T10:00:01Z",
                message: "Bearer a ".repeat(28).trim(),
                progress: {
                  ratio: 0.5,
                  stage: "Bearer a ".repeat(7).trim(),
                },
              },
            ],
          },
        }),
      }),
    });
    const boundedStatus = await expansionClient.getJob("job_mock_0001");
    assert.ok(boundedStatus.progress.stage.length <= 64);
    assert.ok(boundedStatus.progress.message.length <= 256);
    assert.ok(boundedStatus.error.message.length <= 512);
    const boundedEvents = await expansionClient.listJobEvents("job_mock_0001");
    assert.ok(boundedEvents.events[0].message.length <= 256);
    assert.ok(boundedEvents.events[0].progress.stage.length <= 64);

    const transportClient = createCinevfxClient({
      fetchImpl: async () => {
        throw new Error(`Bearer ${secret} ${privatePath}`);
      },
    });
    await assert.rejects(
      () => transportClient.getJob("job_mock_0001"),
      (error) => {
        assert.ok(error instanceof CinevfxApiError);
        assert.equal(error.code, "network_error");
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(privatePath), false);
        return true;
      },
    );
  });

  it("rejects malformed or foreign asset and job success responses", async () => {
    const descriptor = validAssetDescriptor();
    const request = validJobRequest();
    const cases = [
      {
        call: (client) => client.createAsset(descriptor),
        route: "POST /v1/assets",
        body: { ...descriptor, assetId: "asset_foreign_0001" },
      },
      {
        call: (client) => client.createAsset(descriptor),
        route: "POST /v1/assets",
        body: { ...descriptor, digest: digest("f") },
      },
      {
        call: (client) => client.createAsset(descriptor),
        route: "POST /v1/assets",
        body: { ...descriptor, unexpected: true },
      },
      {
        call: (client) => client.createJob(request),
        route: "POST /v1/jobs",
        body: validJobStatus({ idempotencyKey: "idem_foreign_00000001" }),
      },
      {
        call: (client) => client.getJob("job_mock_0001"),
        route: "GET /v1/jobs/job_mock_0001",
        body: validJobStatus({ jobId: "job_foreign_0001" }),
      },
      {
        call: (client) => client.getJob("job_mock_0001"),
        route: "GET /v1/jobs/job_mock_0001",
        body: validJobStatus({ finishedAt: "2026-08-12T10:00:02Z" }),
      },
      {
        call: (client) => client.cancelJob("job_mock_0001"),
        route: "POST /v1/jobs/job_mock_0001/cancel",
        body: validJobStatus({ jobId: "job_foreign_0001" }),
      },
    ];

    for (const fixture of cases) {
      const client = createCinevfxClient({
        fetchImpl: createMockFetch({
          [fixture.route]: () => ({
            status: fixture.route === "POST /v1/assets" ? 201 : 200,
            body: fixture.body,
          }),
        }),
      });
      await assert.rejects(
        () => fixture.call(client),
        (err) =>
          err instanceof CinevfxApiError && err.code === "invalid_response",
        fixture.route,
      );
    }
  });

  it("binds get and cancel status responses to an expected idempotency key", async () => {
    const jobId = "job_mock_0001";
    const foreign = validJobStatus({
      jobId,
      idempotencyKey: "idem_foreign_status_0001",
    });
    const fetchImpl = createMockFetch({
      [`GET /v1/jobs/${jobId}`]: () => ({ status: 200, body: foreign }),
      [`POST /v1/jobs/${jobId}/cancel`]: () => ({
        status: 200,
        body: {
          ...foreign,
          state: "CANCELLED",
          cancelRequested: true,
          finishedAt: "2026-08-12T10:00:02Z",
        },
      }),
    });
    const client = createCinevfxClient({ fetchImpl });
    const expectedIdempotencyKey = "idem_mock_slice_request_0001";
    for (const call of [
      () => client.getJob(jobId, { expectedIdempotencyKey }),
      () => client.cancelJob(jobId, { expectedIdempotencyKey }),
    ]) {
      await assert.rejects(
        call,
        (error) =>
          error instanceof CinevfxApiError && error.code === "invalid_response",
      );
    }
  });

  it("snapshots identity call options before request and response binding", async () => {
    const jobId = "job_mock_0001";
    const foreign = validJobStatus({
      jobId,
      idempotencyKey: "idem_foreign_status_0001",
    });
    let calls = 0;
    const dynamicOptions = {};
    let reads = 0;
    Object.defineProperty(dynamicOptions, "expectedIdempotencyKey", {
      enumerable: true,
      get() {
        reads += 1;
        return "idem_mock_slice_request_0001";
      },
    });
    const rejectingClient = createCinevfxClient({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("dynamic options must not dispatch");
      },
    });
    for (const call of [
      () => rejectingClient.getJob(jobId, dynamicOptions),
      () => rejectingClient.cancelJob(jobId, dynamicOptions),
    ]) {
      await assert.rejects(
        call,
        (error) =>
          error instanceof CinevfxApiError &&
          error.code === "invalid_call_options",
      );
    }
    assert.equal(reads, 0);
    assert.equal(calls, 0);

    for (const method of ["get", "cancel"]) {
      const options = {
        expectedIdempotencyKey: "idem_mock_slice_request_0001",
      };
      const client = createCinevfxClient({
        fetchImpl: createMockFetch({
          [`GET /v1/jobs/${jobId}`]: () => {
            options.expectedIdempotencyKey = undefined;
            return { status: 200, body: foreign };
          },
          [`POST /v1/jobs/${jobId}/cancel`]: () => {
            options.expectedIdempotencyKey = undefined;
            return {
              status: 200,
              body: {
                ...foreign,
                state: "CANCELLED",
                cancelRequested: true,
                finishedAt: "2026-08-12T10:00:02Z",
              },
            };
          },
        }),
      });
      await assert.rejects(
        () =>
          method === "get"
            ? client.getJob(jobId, options)
            : client.cancelJob(jobId, options),
        (error) =>
          error instanceof CinevfxApiError && error.code === "invalid_response",
      );
    }
  });

  it("validates event envelope identity, event identity, shape, and ordering", async () => {
    const jobId = "job_mock_0001";
    const event = {
      schemaVersion: "1.0.0",
      eventId: "evt_progress_0001",
      jobId,
      sequence: 3,
      type: "progress",
      state: "RENDERING",
      timestamp: "2026-08-12T10:00:01Z",
      progress: { ratio: 0.4, stage: "render" },
    };
    const invalidBodies = [
      { jobId: "job_foreign_0001", events: [event] },
      {
        jobId,
        events: [{ ...event, jobId: "job_foreign_0001" }],
      },
      {
        jobId,
        events: [{ ...event, unexpected: true }],
      },
      {
        jobId,
        events: [
          { ...event, sequence: 4 },
          { ...event, eventId: "evt_progress_0002", sequence: 3 },
        ],
      },
      {
        jobId,
        events: [
          { ...event, sequence: 3 },
          { ...event, sequence: 4 },
        ],
      },
      {
        jobId,
        events: [{ ...event, sequence: 2 }],
      },
      {
        jobId,
        events: [{ ...event, state: "SUCCEEDED" }],
      },
    ];

    for (const body of invalidBodies) {
      const client = createCinevfxClient({
        fetchImpl: createMockFetch({
          [`GET /v1/jobs/${jobId}/events`]: () => ({ status: 200, body }),
        }),
      });
      await assert.rejects(
        () => client.listJobEvents(jobId, { afterSequence: 2 }),
        (err) =>
          err instanceof CinevfxApiError && err.code === "invalid_response",
      );
    }
  });

  it("validates fetched manifests and requested job identity", async () => {
    const jobId = "job_mock_0001";
    for (const body of [
      validManifest({ jobId: "job_foreign_0001" }),
      { ...validManifest({ jobId }), passes: [] },
      { ...validManifest({ jobId }), unexpected: true },
    ]) {
      const client = createCinevfxClient({
        fetchImpl: createMockFetch({
          [`GET /v1/jobs/${jobId}/manifest`]: () => ({ status: 200, body }),
        }),
      });
      await assert.rejects(
        () => client.getManifest(jobId),
        (err) =>
          err instanceof CinevfxApiError && err.code === "invalid_response",
      );
    }
  });

  it("rejects malformed JSON on successful responses", async () => {
    const client = createCinevfxClient({
      fetchImpl: async () => textResponse(200, "{not-json"),
    });
    await assert.rejects(
      () => client.getJob("job_mock_0001"),
      (err) =>
        err instanceof CinevfxApiError &&
        err.code === "invalid_response_json" &&
        err.status === 200,
    );
  });

  it("bounds streaming success and error response bodies", async () => {
    const streamingClient = createCinevfxClient({
      maxResponseBytes: 64,
      fetchImpl: async () =>
        new Response(JSON.stringify({ padding: "x".repeat(256) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(
      () => streamingClient.getJob("job_mock_0001"),
      (err) =>
        err instanceof CinevfxApiError && err.code === "response_too_large",
    );

    const errorClient = createCinevfxClient({
      maxResponseBytes: 64,
      fetchImpl: async () =>
        textResponse(
          500,
          JSON.stringify({ code: "ERROR", message: "x".repeat(200) }),
          { "content-length": "260" },
        ),
    });
    await assert.rejects(
      () => errorClient.getJob("job_mock_0001"),
      (err) =>
        err instanceof CinevfxApiError &&
        err.code === "response_too_large" &&
        err.status === 500,
    );
  });

  it("rejects frozen invalid job-request semantic fixtures before network", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
      "packages/contracts/examples/invalid",
    );
    const files = [
      "job-request.digest-mismatch-reference.json",
      "job-request.missing-referenced-asset.json",
      "job-request.mutable-protected-source.json",
    ];
    let fetched = false;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
    });
    for (const file of files) {
      const raw = JSON.parse(await readFile(join(root, file), "utf8"));
      await assert.rejects(
        () => client.createJob(raw),
        (err) =>
          err instanceof CinevfxApiError &&
          err.code === "invalid_job_request",
        `expected rejection for ${file}`,
      );
    }
    assert.equal(fetched, false);
  });

  it("rejects duplicate input assets and missing proxy purpose before network", async () => {
    let fetched = false;
    const client = createCinevfxClient({
      fetchImpl: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
    });
    const base = validJobRequest();
    await assert.rejects(
      () =>
        client.createJob({
          ...base,
          inputAssets: [
            ...base.inputAssets,
            { ...base.inputAssets[0] },
          ],
        }),
      (err) => err instanceof CinevfxApiError && err.code === "invalid_job_request",
    );
    await assert.rejects(
      () =>
        client.createJob({
          ...base,
          inputAssets: base.inputAssets.filter((a) => a.purpose !== "proxy"),
        }),
      (err) => err instanceof CinevfxApiError && err.code === "invalid_job_request",
    );
    assert.equal(fetched, false);
  });

  it("propagates AbortSignal and aborts a stalled request", async () => {
    const controller = new AbortController();
    let sawSignal = false;
    const client = createCinevfxClient({
      timeoutMs: 60_000,
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_mock_0001": ({ signal }) => {
          sawSignal = signal instanceof AbortSignal;
          return { hang: true };
        },
      }),
    });
    const pending = client.getJob("job_mock_0001", { signal: controller.signal });
    // Allow the hang promise to attach abort listeners.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await assert.rejects(
      () => pending,
      (err) => err instanceof CinevfxApiError && err.code === "aborted",
    );
    assert.equal(sawSignal, true);
  });

  it("rejects pre-aborted GET and POST calls without dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    let beforeNetworkCalls = 0;
    const client = createCinevfxClient({
      onBeforeNetwork: () => {
        beforeNetworkCalls += 1;
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("pre-aborted request must not dispatch");
      },
    });

    for (const call of [
      () => client.getJob("job_mock_0001", { signal: controller.signal }),
      () => client.createJob(validJobRequest(), { signal: controller.signal }),
    ]) {
      await assert.rejects(
        call,
        (error) =>
          error instanceof CinevfxApiError &&
          error.status === 0 &&
          error.code === "aborted",
      );
    }
    assert.equal(beforeNetworkCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  it("times out a stalled request with a bounded timeout", async () => {
    const client = createCinevfxClient({
      timeoutMs: 20,
      fetchImpl: createMockFetch({
        "GET /v1/jobs/job_mock_0001": () => ({ hang: true }),
      }),
    });
    await assert.rejects(
      () => client.getJob("job_mock_0001"),
      (err) =>
        err instanceof CinevfxApiError &&
        err.code === "timeout",
    );
  });

  it("distinguishes timeout from external abort while reading a response body", async () => {
    const bodyWaitFetch = async (_url, init = {}) => ({
      status: 200,
      statusText: "200",
      headers: new Headers(),
      text() {
        return new Promise((resolve, reject) => {
          const signal = init.signal;
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const timeoutClient = createCinevfxClient({
      timeoutMs: 10,
      fetchImpl: bodyWaitFetch,
    });
    await assert.rejects(
      () => timeoutClient.getJob("job_mock_0001"),
      (error) =>
        error instanceof CinevfxApiError && error.code === "timeout",
    );

    const controller = new AbortController();
    const abortClient = createCinevfxClient({
      timeoutMs: 60_000,
      fetchImpl: bodyWaitFetch,
    });
    const pending = abortClient.getJob("job_mock_0001", {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(
      () => pending,
      (error) =>
        error instanceof CinevfxApiError && error.code === "aborted",
    );
  });

});

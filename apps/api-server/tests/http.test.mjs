import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { URL } from "node:url";
import {
  validateDocument,
} from "../../../packages/contracts/src/index.mjs";
import { listen, requestJson } from "../src/http.mjs";
import {
  digest,
  makeAsset,
  makeJobRequest,
  silentLogger,
} from "./helpers.mjs";

async function withServer(run) {
  const { sink } = silentLogger();
  const runtime = await listen({
    host: "127.0.0.1",
    port: 0,
    logSink: sink,
  });
  try {
    await run(runtime);
  } finally {
    await runtime.close();
  }
}

async function seedAssets(baseUrl) {
  const assets = [
    makeAsset({
      assetId: "asset_proxy_source_01",
      digest: digest("1"),
      purpose: "proxy",
    }),
    makeAsset({
      assetId: "asset_effect_ref_01",
      digest: digest("a"),
      purpose: "effect_reference",
      width: 32,
      height: 32,
    }),
  ];
  for (const asset of assets) {
    const res = await requestJson(baseUrl, "POST", "/v1/assets", { body: asset });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
}

test("HTTP happy path covers all six endpoints", async () => {
  await withServer(async ({ baseUrl }) => {
    await seedAssets(baseUrl);

    const request = makeJobRequest({
      idempotencyKey: "idem_http_happy_path_0001",
      label: "http-arbitrary-smoke",
    });
    const created = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: request,
      headers: { "Idempotency-Key": request.idempotencyKey },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, "SUCCEEDED");
    const jobId = created.body.jobId;

    const status = await requestJson(baseUrl, "GET", `/v1/jobs/${jobId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.jobId, jobId);

    const events = await requestJson(baseUrl, "GET", `/v1/jobs/${jobId}/events`);
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.body.events));
    assert.ok(events.body.events.length > 0);

    const manifest = await requestJson(baseUrl, "GET", `/v1/jobs/${jobId}/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.jobId, jobId);
    assert.ok(manifest.body.passes.every((pass) => pass.editable === true));

    // cancel after success should conflict
    const cancel = await requestJson(baseUrl, "POST", `/v1/jobs/${jobId}/cancel`);
    assert.equal(cancel.status, 409);
  });
});

test("HTTP idempotent replay and cancel hold path", async () => {
  await withServer(async ({ baseUrl }) => {
    await seedAssets(baseUrl);
    const request = makeJobRequest({
      idempotencyKey: "idem_http_cancel_hold_0001",
      label: "force-hold-http",
    });
    const created = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: request,
      headers: { "Idempotency-Key": request.idempotencyKey },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, "RENDERING");

    const replay = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: request,
      headers: { "Idempotency-Key": request.idempotencyKey },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.jobId, created.body.jobId);

    const cancelled = await requestJson(
      baseUrl,
      "POST",
      `/v1/jobs/${created.body.jobId}/cancel`,
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, "CANCELLED");

    const cancelledAgain = await requestJson(
      baseUrl,
      "POST",
      `/v1/jobs/${created.body.jobId}/cancel`,
    );
    assert.equal(cancelledAgain.status, 200);
    assert.equal(cancelledAgain.body.state, "CANCELLED");
  });
});

test("HTTP rejects oversized JSON bodies", async () => {
  await withServer(async ({ baseUrl, api }) => {
    const max = api.store.limits.maxBodyBytes;
    const huge = "x".repeat(max + 64);
    const response = await fetch(`${baseUrl}/v1/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(huge.length + 10),
      },
      body: `{"pad":"${huge}"}`,
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.code, "BODY_TOO_LARGE");
  });
});

test("HTTP unknown route is 404", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await requestJson(baseUrl, "GET", "/v1/unknown");
    assert.equal(res.status, 404);
  });
});


async function postChunked(baseUrl, path, bodyText, { contentType = "application/json" } = {}) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "content-type": contentType,
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              json = { raw: text };
            }
          }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on("error", reject);
    // Write as a single chunk without Content-Length so framing is chunked.
    req.write(bodyText);
    req.end();
  });
}

test("HTTP rejects oversized chunked cancel bodies without Content-Length", async () => {
  await withServer(async ({ baseUrl, api }) => {
    await seedAssets(baseUrl);
    const request = makeJobRequest({
      idempotencyKey: "idem_http_chunked_cancel_0001",
      label: "force-hold-chunked-cancel",
    });
    const created = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: request,
      headers: { "Idempotency-Key": request.idempotencyKey },
    });
    assert.equal(created.status, 201);
    const jobId = created.body.jobId;

    const max = api.store.limits.maxBodyBytes;
    const huge = "x".repeat(max + 128);
    const response = await postChunked(baseUrl, `/v1/jobs/${jobId}/cancel`, huge, {
      contentType: "text/plain",
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.code, "BODY_TOO_LARGE");
    assert.equal(typeof response.body.message, "string");
    assert.equal(response.body.retriable, false);

    // Job must remain active after bounded cancel-body rejection.
    const status = await requestJson(baseUrl, "GET", `/v1/jobs/${jobId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.state, "RENDERING");
  });
});

test("HTTP contract-validates success, failure, conflict, and invalid query documents", async () => {
  await withServer(async ({ baseUrl }) => {
    await seedAssets(baseUrl);

    // Asset create
    const asset = makeAsset({
      assetId: "asset_proxy_source_01",
      digest: digest("1"),
      purpose: "proxy",
    });
    const assetRes = await requestJson(baseUrl, "POST", "/v1/assets", { body: asset });
    assert.equal(assetRes.status, 201);
    const assetValidation = await validateDocument("AssetDescriptor", assetRes.body);
    assert.equal(assetValidation.valid, true, JSON.stringify(assetValidation.errors));

    // Success job + status + events + manifest
    const successReq = makeJobRequest({
      idempotencyKey: "idem_http_contract_success_01",
      label: "contract-success",
    });
    const created = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: successReq,
      headers: { "Idempotency-Key": successReq.idempotencyKey },
    });
    assert.equal(created.status, 201);
    const statusValidation = await validateDocument("JobStatus", created.body);
    assert.equal(statusValidation.valid, true, JSON.stringify(statusValidation.errors));

    const jobId = created.body.jobId;
    const events = await requestJson(baseUrl, "GET", `/v1/jobs/${jobId}/events`);
    assert.equal(events.status, 200);
    for (const event of events.body.events) {
      const eventValidation = await validateDocument("JobEvent", event);
      assert.equal(eventValidation.valid, true, JSON.stringify(eventValidation.errors));
    }

    const manifest = await requestJson(baseUrl, "GET", `/v1/jobs/${jobId}/manifest`);
    assert.equal(manifest.status, 200);
    const manifestValidation = await validateDocument("LayerManifest", manifest.body);
    assert.equal(manifestValidation.valid, true, JSON.stringify(manifestValidation.errors));

    // Failure path status
    const failReq = makeJobRequest({
      idempotencyKey: "idem_http_contract_fail_0001",
      label: "mock-fail-contract",
    });
    const failed = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: failReq,
      headers: { "Idempotency-Key": failReq.idempotencyKey },
    });
    assert.equal(failed.status, 201);
    assert.equal(failed.body.state, "FAILED");
    const failStatusValidation = await validateDocument("JobStatus", failed.body);
    assert.equal(failStatusValidation.valid, true, JSON.stringify(failStatusValidation.errors));

    // Expiry path status
    const expireReq = makeJobRequest({
      idempotencyKey: "idem_http_contract_expire_01",
      label: "force-expire-contract",
    });
    const expired = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: expireReq,
      headers: { "Idempotency-Key": expireReq.idempotencyKey },
    });
    assert.equal(expired.status, 201);
    assert.equal(expired.body.state, "EXPIRED");
    const expireStatusValidation = await validateDocument("JobStatus", expired.body);
    assert.equal(expireStatusValidation.valid, true, JSON.stringify(expireStatusValidation.errors));

    // Replay conflict error document
    const conflict = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: makeJobRequest({
        idempotencyKey: "idem_http_contract_success_01",
        label: "different-label-conflict",
      }),
      headers: { "Idempotency-Key": "idem_http_contract_success_01" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(typeof conflict.body.message, "string");
    assert.equal(conflict.body.retriable, false);

    // Invalid afterSequence
    const badQuery = await requestJson(
      baseUrl,
      "GET",
      `/v1/jobs/${jobId}/events?afterSequence=not-an-int`,
    );
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.code, "INVALID_QUERY");
    assert.equal(typeof badQuery.body.message, "string");
  });
});

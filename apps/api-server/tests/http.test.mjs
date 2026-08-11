import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { URL } from "node:url";
import {
  validateDocument,
} from "../../../packages/contracts/src/index.mjs";
import { createServer, listen, requestJson } from "../src/http.mjs";
import {
  digest,
  makeAsset,
  makeJobRequest,
  silentLogger,
} from "./helpers.mjs";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./tls-fixture.mjs";

const SESSION_HEADER = "x-cinevfx-session";

async function withServer(run, options = {}) {
  const { sink } = silentLogger();
  const runtime = await listen({
    host: "127.0.0.1",
    port: 0,
    logSink: sink,
    ...options,
  });
  try {
    await run(runtime);
  } finally {
    await closeRuntime(runtime);
  }
}

async function closeRuntime(runtime, timeoutMs = 2_000) {
  let timeout;
  try {
    await Promise.race([
      runtime.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => {
            runtime.server.closeAllConnections?.();
            reject(new Error(`server close exceeded ${timeoutMs}ms`));
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
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

async function fetchSessionToken(baseUrl) {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["ok", "service", "sessionToken"]);
  assert.match(body.sessionToken, /^[A-Za-z0-9_-]{32,128}$/);
  return body.sessionToken;
}

function requestHttps(baseUrl, path, { ca } = {}) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      req.setTimeout(0);
      callback(value);
    };
    const req = https.request(url, { ca, rejectUnauthorized: true, agent: false }, (res) => {
      const socket = res.socket;
      const encrypted = socket?.encrypted === true;
      const authorized = socket?.authorized === true;
      const tlsProtocol = socket?.getProtocol() ?? null;
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          finish(resolve, {
            status: res.statusCode,
            body: text ? JSON.parse(text) : null,
            encrypted,
            authorized,
            tlsProtocol,
            headers: res.headers,
          });
        } catch (error) {
          finish(reject, error);
        }
      });
      res.on("error", (error) => finish(reject, error));
    });
    req.setTimeout(3_000, () => req.destroy(new Error("HTTPS test request timed out")));
    req.on("error", (error) => finish(reject, error));
    req.end();
  });
}

test("HTTPS mode performs a real TLS handshake and reports an https baseUrl", async () => {
  const certificate = new X509Certificate(TEST_TLS_CERT);
  assert.match(certificate.subject, /CN=CineVFX TEST ONLY/);
  assert.ok(Date.now() >= Date.parse(certificate.validFrom));
  assert.ok(Date.now() <= Date.parse(certificate.validTo));
  assert.equal(certificate.checkHost("localhost"), "localhost");
  assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");

  const { sink } = silentLogger();
  const runtime = await listen({
    host: "127.0.0.1",
    port: 0,
    tls: { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    logSink: sink,
  });
  try {
    assert.equal(runtime.protocol, "https");
    assert.match(runtime.baseUrl, /^https:\/\/127\.0\.0\.1:\d+$/);
    const response = await requestHttps(runtime.baseUrl, "/healthz", { ca: TEST_TLS_CERT });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.encrypted, true);
    assert.equal(response.authorized, true);
    assert.match(response.tlsProtocol, /^TLSv1\.[23]$/);

    await assert.rejects(
      () => requestHttps(runtime.baseUrl, "/healthz"),
      /self-signed certificate|unable to verify the first certificate/,
    );
  } finally {
    await closeRuntime(runtime);
  }
});

test("explicit TLS configuration rejects every missing key/cert combination", async () => {
  for (const tls of [
    {},
    { key: TEST_TLS_KEY },
    { cert: TEST_TLS_CERT },
    null,
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT, minVersion: "TLSv1.1" },
  ]) {
    assert.throws(
      () => createServer({ tls }),
      /tls must be an object|TLS key and certificate must be provided together|TLS minVersion/,
    );
    await assert.rejects(
      () => listen({ host: "127.0.0.1", port: 0, tls }),
      /tls must be an object|TLS key and certificate must be provided together|TLS minVersion/,
    );
  }
});

test("listen rejects non-loopback hosts before opening a socket", async () => {
  for (const host of ["0.0.0.0", "192.168.1.20", "::1", ""]) {
    await assert.rejects(
      () => listen({ host, port: 0 }),
      /host must be the loopback address/,
    );
  }
});

test("HTTP rejects invalid or oversized body limits before opening a socket", async () => {
  for (const maxBodyBytes of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    256 * 1024 + 1,
  ]) {
    assert.throws(
      () => createServer({ maxBodyBytes }),
      /maxBodyBytes must be a positive safe integer/,
    );
    await assert.rejects(
      () => listen({ host: "127.0.0.1", port: 0, maxBodyBytes }),
      /maxBodyBytes must be a positive safe integer/,
    );
  }
});

test("each server exposes a distinct no-store health session without returning it from listen", async () => {
  const tokens = [];
  for (let index = 0; index < 2; index += 1) {
    await withServer(async (runtime) => {
      assert.equal(Object.hasOwn(runtime, "sessionToken"), false);
      tokens.push(await fetchSessionToken(runtime.baseUrl));
    });
  }
  assert.notEqual(tokens[0], tokens[1]);
});

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

test("unexpected route failures return the declared 500 ErrorObject", async () => {
  const sessionToken = `${"A".repeat(31)}-`;
  const errorLines = [];
  await withServer(
    async ({ baseUrl }) => {
      await seedAssets(baseUrl);
      const request = makeJobRequest({
        idempotencyKey: "idem_http_internal_error_0001",
      });
      const response = await requestJson(baseUrl, "POST", "/v1/jobs", {
        body: request,
        headers: { "Idempotency-Key": request.idempotencyKey },
      });
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, {
        code: "INTERNAL",
        message: "internal server error",
        retriable: true,
      });
      assert.ok(errorLines.length > 0);
      assert.equal(errorLines.join("\n").includes(sessionToken), false);
    },
    {
      sessionToken,
      logSink: {
        error(line) {
          errorLines.push(line);
        },
      },
      clock() {
        const error = new Error(`clock failure ${sessionToken}`);
        error.name = sessionToken;
        throw error;
      },
    },
  );
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
    const sessionToken = await fetchSessionToken(baseUrl);
    const max = api.store.limits.maxBodyBytes;
    const huge = "x".repeat(max + 64);
    const response = await fetch(`${baseUrl}/v1/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(huge.length + 10),
        [SESSION_HEADER]: sessionToken,
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
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("JSON POST endpoints reject simple text/plain requests and do not enable CORS", async () => {
  await withServer(async ({ baseUrl, api }) => {
    const sessionToken = await fetchSessionToken(baseUrl);
    const asset = makeAsset({
      assetId: "asset_content_type_guard_01",
      digest: digest("4"),
      purpose: "proxy",
    });
    for (const path of ["/v1/assets", "/v1/jobs"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://untrusted.example",
          [SESSION_HEADER]: sessionToken,
        },
        body: JSON.stringify(asset),
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal((await response.json()).code, "INVALID_CONTENT_TYPE");
    }
    assert.equal(api.store.assetsById.has(asset.assetId), false);

    const accepted = await fetch(`${baseUrl}/v1/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        [SESSION_HEADER]: sessionToken,
      },
      body: JSON.stringify(asset),
    });
    assert.equal(accepted.status, 201);

    const preflight = await fetch(`${baseUrl}/v1/jobs`, { method: "OPTIONS" });
    assert.equal(preflight.status, 404);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal((await preflight.json()).code, "NOT_FOUND");
  });
});

test("missing or wrong sessions cannot create resources, probe jobs, or cancel work", async () => {
  await withServer(async ({ baseUrl, api }) => {
    await seedAssets(baseUrl);
    const request = makeJobRequest({
      idempotencyKey: "idem_http_session_cancel_0001",
      label: "force-hold-session-guard",
    });
    const created = await requestJson(baseUrl, "POST", "/v1/jobs", {
      body: request,
      headers: { "Idempotency-Key": request.idempotencyKey },
    });
    assert.equal(created.body.state, "RENDERING");

    const attackerCancel = await fetch(
      `${baseUrl}/v1/jobs/${created.body.jobId}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://untrusted.example" },
        body: "cancel",
      },
    );
    assert.equal(attackerCancel.status, 404);
    assert.equal((await attackerCancel.json()).code, "NOT_FOUND");
    assert.equal(
      (await requestJson(baseUrl, "GET", `/v1/jobs/${created.body.jobId}`)).body.state,
      "RENDERING",
    );

    const assetCount = api.store.assetsById.size;
    const wrongCreate = await fetch(`${baseUrl}/v1/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_HEADER]: "wrong_session_token_0123456789abcdef",
      },
      body: JSON.stringify(
        makeAsset({
          assetId: "asset_wrong_session_01",
          digest: digest("5"),
          purpose: "proxy",
        }),
      ),
    });
    assert.equal(wrongCreate.status, 400);
    assert.equal((await wrongCreate.json()).code, "INVALID_SESSION");
    assert.equal(api.store.assetsById.size, assetCount);

    const wrongProbe = await fetch(`${baseUrl}/v1/jobs/${created.body.jobId}`, {
      headers: { [SESSION_HEADER]: "wrong_session_token_0123456789abcdef" },
    });
    assert.equal(wrongProbe.status, 404);
    assert.equal((await wrongProbe.json()).code, "NOT_FOUND");
  });
});

test("Host validation blocks DNS rebinding before health or API state access", async () => {
  await withServer(async ({ baseUrl, api, port }) => {
    const sessionToken = await fetchSessionToken(baseUrl);
    const assetCount = api.store.assetsById.size;
    for (const host of [
      "attacker.example",
      `127.1:${port}`,
      `2130706433:${port}`,
    ]) {
      const response = await postChunked(
        baseUrl,
        "/v1/assets",
        JSON.stringify(
          makeAsset({
            assetId: "asset_rebinding_attempt_01",
            digest: digest("6"),
            purpose: "proxy",
          }),
        ),
        {
          headers: {
            host,
            [SESSION_HEADER]: sessionToken,
          },
        },
      );
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "INVALID_HOST");
    }
    assert.equal(api.store.assetsById.size, assetCount);
  });
});

test("partial request bodies time out and close their connection without state changes", async () => {
  await withServer(async ({ baseUrl, host, port, api }) => {
    const sessionToken = await fetchSessionToken(baseUrl);
    const assetCount = api.store.assetsById.size;
    const socket = net.createConnection({ host, port });
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(
      [
        "POST /v1/assets HTTP/1.1",
        `Host: ${host}:${port}`,
        `X-CineVFX-Session: ${sessionToken}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );
    let deadline;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("partial request socket did not close")),
            500,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(api.store.assetsById.size, assetCount);
  }, { bodyTimeoutMs: 30 });
});

test("runtime close is idempotent and force-closes lingering sockets by its deadline", async () => {
  const { sink } = silentLogger();
  const runtime = await listen({
    host: "127.0.0.1",
    port: 0,
    closeGraceMs: 30,
    logSink: sink,
  });
  const socket = net.createConnection({ host: runtime.host, port: runtime.port });
  try {
    await once(socket, "connect");
    const closed = new Promise((resolve) => {
      socket.once("error", () => {});
      socket.once("close", resolve);
    });
    const started = Date.now();
    const firstClose = runtime.close();
    assert.equal(runtime.close(), firstClose);
    await firstClose;
    assert.ok(Date.now() - started < 500);
    await closed;
  } finally {
    socket.destroy();
    await runtime.close();
  }
});

test("malformed percent-encoded job IDs return a non-retriable 404 ErrorObject", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await requestJson(baseUrl, "GET", "/v1/jobs/%ZZ");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      code: "NOT_FOUND",
      message: "endpoint not found",
      retriable: false,
    });
  });
});


async function postChunked(
  baseUrl,
  path,
  bodyText,
  { contentType = "application/json", headers = {} } = {},
) {
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
          ...headers,
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
    const sessionToken = await fetchSessionToken(baseUrl);
    const huge = "x".repeat(max + 128);
    const response = await postChunked(baseUrl, `/v1/jobs/${jobId}/cancel`, huge, {
      contentType: "text/plain",
      headers: { [SESSION_HEADER]: sessionToken },
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

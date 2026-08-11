import assert from "node:assert/strict";

export const CLIENT_LOOPBACK_ORIGIN = "http://127.0.0.1:8787";
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export const PROTECTED_SOURCE = Object.freeze({
  layerStableId: "ps_layer_stable_source_01",
  documentStableId: "ps_doc_stable_01",
  bounds: Object.freeze({ x: 0, y: 0, width: 64, height: 64 }),
});

export function digest(character) {
  return `sha256:${String(character).repeat(64)}`;
}

export function makeAssets() {
  const common = {
    schemaVersion: "1.0.0",
    mediaType: "image/png",
    dimensions: { width: 64, height: 64 },
    alphaMode: "straight",
    byteLength: 1024,
    ttlSeconds: 3600,
    createdAt: "2026-08-12T10:00:00Z",
    colorSpace: "srgb",
  };
  return [
    {
      ...common,
      assetId: "asset_proxy_source_01",
      digest: digest("1"),
      purpose: "proxy",
      sourceRole: "user_proxy",
    },
    {
      ...common,
      assetId: "asset_subject_mask_01",
      digest: digest("3"),
      purpose: "mask",
      sourceRole: "user_mask",
    },
    {
      ...common,
      assetId: "asset_effect_ref_01",
      digest: digest("a"),
      purpose: "effect_reference",
      sourceRole: "user_effect_reference",
    },
  ];
}

export function makeJobRequest({
  idempotencyKey = "idem_integration_happy_0001",
  label = "integration-cinematic-light",
} = {}) {
  return {
    schemaVersion: "1.0.0",
    idempotencyKey,
    clientRequestId: "integration_client_0001",
    effectSpec: {
      schemaVersion: "1.0.0",
      effectSpecVersion: "1.0.0",
      seed: 42,
      label,
      canvas: {
        width: 64,
        height: 64,
        colorSpace: "srgb",
        pixelAspectRatio: 1,
        normalized: true,
      },
      references: [
        {
          id: "effect_ref",
          assetId: "asset_effect_ref_01",
          role: "effect",
          digest: digest("a"),
          weight: 1,
        },
      ],
      guidance: {
        anchors: [
          {
            id: "anchor_center",
            point: { x: 0.5, y: 0.5 },
            radius: 0.2,
          },
        ],
        strength: 0.7,
        subjectMaskAssetId: "asset_subject_mask_01",
      },
      primitives: [
        {
          id: "effect_sprite",
          kind: "sprite",
          enabled: true,
          params: { scale: 1 },
        },
      ],
    },
    inputAssets: makeAssets().map(({ assetId, digest: assetDigest, purpose }) => ({
      assetId,
      digest: assetDigest,
      purpose,
    })),
    protectedSource: {
      layerStableId: PROTECTED_SOURCE.layerStableId,
      documentStableId: PROTECTED_SOURCE.documentStableId,
      immutable: true,
      operationsForbidden: [
        "modify_pixels",
        "move",
        "transform",
        "resize",
        "replace",
        "warp",
        "delete",
      ],
    },
    options: {
      priority: "normal",
      dryRun: false,
      ttlSeconds: 1800,
    },
  };
}

/**
 * The public UXP client deliberately accepts only manifest-declared port 8787.
 * Integration servers use port 0 to avoid collisions, so this adapter strictly
 * rewrites that one allowed origin and delegates to native fetch. It never
 * creates, changes, or fabricates a response.
 */
export function createEphemeralLoopbackFetch(runtimeBaseUrl) {
  const runtime = new URL(runtimeBaseUrl);
  assert.equal(runtime.protocol, "http:");
  assert.equal(runtime.hostname, "127.0.0.1");
  assert.equal(runtime.pathname, "/");
  assert.match(runtime.port, /^\d+$/);

  const requests = [];
  const responses = [];

  async function fetchImpl(input, init = {}) {
    assert.equal(typeof input, "string", "UXP client must pass an absolute URL string");
    const source = new URL(input);
    assert.equal(
      source.origin,
      CLIENT_LOOPBACK_ORIGIN,
      "adapter only accepts the fixed manifest-declared client origin",
    );
    assert.equal(source.username, "");
    assert.equal(source.password, "");
    assert.equal(source.hash, "");

    const target = new URL(`${source.pathname}${source.search}`, runtime);
    const headers = new Headers(init.headers ?? {});
    const sessionHeader = headers.get("X-CineVFX-Session");
    requests.push({
      method: String(init.method ?? "GET").toUpperCase(),
      sourceUrl: source.href,
      targetUrl: target.href,
      hasBody: init.body !== undefined,
      hasSignal: init.signal !== undefined,
      hasSessionHeader: sessionHeader !== null,
      hasValidSessionHeader:
        typeof sessionHeader === "string" && SESSION_TOKEN_RE.test(sessionHeader),
    });

    const response = await globalThis.fetch(target, init);
    assert.ok(response instanceof Response, "native fetch must provide the response");
    responses.push({
      status: response.status,
      url: response.url,
      contentType: response.headers.get("content-type"),
    });
    return response;
  }

  return { fetchImpl, requests, responses };
}

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

export function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

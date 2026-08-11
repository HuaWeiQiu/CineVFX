/** Shared fixtures for UXP shell tests (metadata only, no image bytes). */

export function digest(hexChar) {
  return `sha256:${String(hexChar).repeat(64)}`;
}

export function validManifest(overrides = {}) {
  const base = {
    schemaVersion: "1.0.0",
    manifestId: "manifest_mock_0001",
    jobId: "job_mock_0001",
    createdAt: "2026-08-12T10:00:18Z",
    canvas: {
      width: 1024,
      height: 1024,
      colorSpace: "srgb",
      pixelAspectRatio: 1,
      normalized: true,
    },
    protectedSource: {
      layerStableId: "ps_layer_stable_source_01",
      documentStableId: "ps_doc_stable_01",
      immutable: true,
      untouched: true,
    },
    groupName: "CineVFX Passes",
    passes: [
      {
        id: "pass_effect",
        name: "Effect",
        order: 0,
        kind: "effect",
        editable: true,
        visible: true,
        opacity: 1,
        blendMode: "screen",
        asset: {
          assetId: "asset_pass_effect_01",
          digest: digest("2"),
        },
        mask: {
          asset: {
            assetId: "asset_pass_effect_mask_01",
            digest: digest("4"),
          },
          inverted: false,
          density: 1,
        },
      },
      {
        id: "pass_relight",
        name: "Relight",
        order: 1,
        kind: "relight",
        editable: true,
        visible: true,
        opacity: 0.65,
        blendMode: "soft_light",
        asset: {
          assetId: "asset_pass_relight_01",
          digest: digest("5"),
        },
      },
    ],
    assets: [
      {
        assetId: "asset_pass_effect_01",
        digest: digest("2"),
        mediaType: "image/png",
        purpose: "pass",
        verified: true,
        dimensions: { width: 1024, height: 1024 },
      },
      {
        assetId: "asset_pass_effect_mask_01",
        digest: digest("4"),
        mediaType: "image/png",
        purpose: "mask",
        verified: true,
        dimensions: { width: 1024, height: 1024 },
      },
      {
        assetId: "asset_pass_relight_01",
        digest: digest("5"),
        mediaType: "image/png",
        purpose: "pass",
        verified: true,
        dimensions: { width: 1024, height: 1024 },
      },
    ],
    importHints: {
      singleHistoryState: true,
      placeAboveProtectedSource: true,
      rollbackOnAnyFailure: true,
    },
  };
  return deepMerge(base, overrides);
}

export function validAssetDescriptor(overrides = {}) {
  const base = {
    schemaVersion: "1.0.0",
    assetId: "asset_proxy_source_01",
    mediaType: "image/png",
    dimensions: { width: 1024, height: 1024 },
    digest: digest("1"),
    alphaMode: "straight",
    byteLength: 100,
    ttlSeconds: 3600,
    purpose: "proxy",
    createdAt: "2026-08-12T10:00:00Z",
    colorSpace: "srgb",
    sourceRole: "user_proxy",
  };
  return deepMerge(base, overrides);
}

export function validJobRequest(overrides = {}) {
  const base = {
    schemaVersion: "1.0.0",
    idempotencyKey: "idem_mock_slice_request_0001",
    clientRequestId: "uxp_panel_req_0001",
    effectSpec: {
      schemaVersion: "1.0.0",
      effectSpecVersion: "1.0.0",
      seed: 42,
      label: "fire-smoke",
      canvas: {
        width: 1024,
        height: 1024,
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
            point: { x: 0.5, y: 0.42 },
            radius: 0.18,
          },
        ],
        strength: 0.72,
        subjectMaskAssetId: "asset_subject_mask_01",
      },
      primitives: [
        {
          id: "spark_curve",
          kind: "curve",
          enabled: true,
          params: {
            intensity: 0.8,
            thickness: 0.03,
            segments: 12,
          },
        },
      ],
    },
    inputAssets: [
      {
        assetId: "asset_proxy_source_01",
        digest: digest("1"),
        purpose: "proxy",
      },
      {
        assetId: "asset_subject_mask_01",
        digest: digest("3"),
        purpose: "mask",
      },
      {
        assetId: "asset_effect_ref_01",
        digest: digest("a"),
        purpose: "effect_reference",
      },
    ],
    protectedSource: {
      layerStableId: "ps_layer_stable_source_01",
      documentStableId: "ps_doc_stable_01",
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
  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return source === undefined ? target : source;
  }
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      out[key] = deepMerge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Minimal mock fetch router for client tests.
 * @param {Record<string, (req: { method: string, url: string, headers: Headers, body: unknown }) => { status: number, body: unknown }>} routes
 */
export function createMockFetch(routes) {
  return async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url, "http://127.0.0.1:8787");
    const key = `${method} ${u.pathname}`;
    const handler = routes[key] ?? routes["*"];
    if (!handler) {
      return jsonResponse(404, {
        code: "not_found",
        message: `no mock for ${key}`,
      });
    }
    let body = null;
    if (init.body) {
      body = JSON.parse(String(init.body));
    }
    const result = handler({
      method,
      url: u,
      headers: new Headers(init.headers ?? {}),
      body,
      signal: init.signal,
    });
    // Support async handlers and never-resolving promises for abort tests.
    const resolved = typeof result?.then === "function" ? await result : result;
    if (resolved && resolved.hang === true) {
      return hangUntilAbort(init.signal);
    }
    return jsonResponse(resolved.status, resolved.body);
  };
}

/**
 * @param {AbortSignal | undefined} signal
 */
function hangUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    if (!signal) {
      // Never resolves — used only with explicit timeout/abort in tests.
      return;
    }
    const onAbort = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function jsonResponse(status, body) {
  return {
    status,
    statusText: String(status),
    async text() {
      return body == null ? "" : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

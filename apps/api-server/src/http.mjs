/**
 * Minimal Node HTTP/HTTPS server for the six frozen Mock API endpoints.
 * Uses only Node built-ins. No external frameworks.
 */

import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { HttpError, errorBody } from "./errors.mjs";
import { createLogger, redactForLog } from "./redact.mjs";
import { createMockApi } from "./service.mjs";
import { DEFAULT_LIMITS } from "./store.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_GRACE_MS = 250;
const SESSION_HEADER = "x-cinevfx-session";
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function resolveTlsOptions(tls) {
  if (tls === undefined) {
    return null;
  }
  if (tls === null || typeof tls !== "object" || Array.isArray(tls)) {
    throw new TypeError("tls must be an object containing both key and cert");
  }

  const hasKey = tls.key !== undefined && tls.key !== null;
  const hasCert = tls.cert !== undefined && tls.cert !== null;
  if (!hasKey || !hasCert) {
    throw new TypeError("TLS key and certificate must be provided together");
  }
  const minVersion = tls.minVersion ?? "TLSv1.2";
  if (minVersion !== "TLSv1.2" && minVersion !== "TLSv1.3") {
    throw new TypeError("TLS minVersion must be TLSv1.2 or TLSv1.3");
  }
  return { ...tls, minVersion };
}

function hostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function requireLoopbackHost(host) {
  if (
    typeof host !== "string" ||
    (host !== "127.0.0.1" && host.toLowerCase() !== "localhost")
  ) {
    throw new TypeError("host must be the loopback address 127.0.0.1 or localhost");
  }
  return host;
}

function resolveSessionToken(value) {
  const token = value ?? randomBytes(32).toString("base64url");
  if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) {
    throw new TypeError("sessionToken must be a 32-128 character base64url string");
  }
  return token;
}

function tokenDigest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function scrubSessionToken(value, sessionToken) {
  if (typeof value !== "string") return value;
  return value.split(sessionToken).join("[REDACTED:session-token]");
}

function sessionMatches(candidate, expectedDigest) {
  if (typeof candidate !== "string") return false;
  return timingSafeEqual(tokenDigest(candidate), expectedDigest);
}

function sessionError(method, pathname) {
  const isCreateEndpoint =
    method === "POST" && (pathname === "/v1/assets" || pathname === "/v1/jobs");
  return new HttpError(
    isCreateEndpoint ? 400 : 404,
    isCreateEndpoint ? "INVALID_SESSION" : "NOT_FOUND",
    isCreateEndpoint ? "valid local session is required" : "endpoint not found",
    { retriable: false, headers: { connection: "close" } },
  );
}

function requireRequestHost(rawHost, protocol) {
  if (
    typeof rawHost !== "string" ||
    rawHost.trim() !== rawHost ||
    !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(rawHost)
  ) {
    throw new HttpError(400, "INVALID_HOST", "host header must target loopback", {
      retriable: false,
      headers: { connection: "close" },
    });
  }

  let parsed;
  try {
    parsed = new URL(`${protocol}://${rawHost}`);
  } catch {
    throw new HttpError(400, "INVALID_HOST", "host header must target loopback", {
      retriable: false,
      headers: { connection: "close" },
    });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    (hostname !== "127.0.0.1" && hostname !== "localhost") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new HttpError(400, "INVALID_HOST", "host header must target loopback", {
      retriable: false,
      headers: { connection: "close" },
    });
  }
  return rawHost;
}

function boundedDuration(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 60_000) {
    throw new TypeError(`${name} must be an integer from 1 to 60000 milliseconds`);
  }
  return resolved;
}

function boundedPositiveSafeInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

function readBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    function fail(error, { destroy = false } = {}) {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) {
        req.destroy();
      } else {
        // Drain remaining data so the socket can close cleanly after response.
        req.once("error", () => {});
        req.resume();
      }
      reject(error);
    }

    function onData(chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new HttpError(413, "BODY_TOO_LARGE", `request body exceeds ${maxBytes} bytes`, {
            retriable: false,
          }),
        );
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    function onError(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    const timeout = setTimeout(() => {
      fail(
        new HttpError(408, "BODY_TIMEOUT", "request body was not received in time", {
          retriable: true,
        }),
        { destroy: true },
      );
    }, timeoutMs);
    timeout.unref();
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function parseJsonBody(req, maxBytes, timeoutMs) {
  const raw = await readBody(req, maxBytes, timeoutMs);
  const contentType = req.headers["content-type"];
  const mediaType =
    typeof contentType === "string" ? contentType.split(";", 1)[0].trim().toLowerCase() : "";
  if (mediaType !== "application/json") {
    throw new HttpError(
      400,
      "INVALID_CONTENT_TYPE",
      "content-type must be application/json",
      { retriable: false },
    );
  }
  if (raw.length === 0) {
    throw new HttpError(400, "EMPTY_BODY", "request body is required", { retriable: false });
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "request body must be valid JSON", {
      retriable: false,
    });
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function notFound() {
  throw new HttpError(404, "NOT_FOUND", "endpoint not found", { retriable: false });
}

function decodeJobId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(404, "NOT_FOUND", "endpoint not found", { retriable: false });
  }
}

/**
 * Create an HTTP server bound to a Mock API service instance.
 */
export function createServer(options = {}) {
  const api = options.api ?? createMockApi(options);
  const logger = options.logger ?? api.logger ?? createLogger();
  const maxBodyBytes = boundedPositiveSafeInteger(
    options.maxBodyBytes ??
      api.store?.limits?.maxBodyBytes ??
      DEFAULT_LIMITS.maxBodyBytes,
    "maxBodyBytes",
    DEFAULT_LIMITS.maxBodyBytes,
  );
  const bodyTimeoutMs = boundedDuration(
    options.bodyTimeoutMs,
    "bodyTimeoutMs",
    DEFAULT_BODY_TIMEOUT_MS,
  );
  const tlsOptions = resolveTlsOptions(options.tls);
  const protocol = tlsOptions ? "https" : "http";
  const sessionToken = resolveSessionToken(options.sessionToken);
  const sessionDigest = tokenDigest(sessionToken);

  const requestHandler = async (req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      const host = requireRequestHost(req.headers.host, protocol);
      const url = new URL(req.url ?? "/", `${protocol}://${host}`);
      pathname = url.pathname;

      // Health for local ops (not one of the six contract endpoints).
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "cinevfx-mock-api",
          sessionToken,
        });
        return;
      }

      if (pathname.startsWith("/v1/") && !sessionMatches(req.headers[SESSION_HEADER], sessionDigest)) {
        throw sessionError(method, pathname);
      }

      if (method === "POST" && pathname === "/v1/assets") {
        const body = await parseJsonBody(req, maxBodyBytes, bodyTimeoutMs);
        const result = await api.createAsset(body);
        sendJson(res, result.status, result.body);
        return;
      }

      if (method === "POST" && pathname === "/v1/jobs") {
        const body = await parseJsonBody(req, maxBodyBytes, bodyTimeoutMs);
        const headerKey = req.headers["idempotency-key"];
        const result = await api.createJob(body, headerKey);
        sendJson(res, result.status, result.body);
        return;
      }

      const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const result = api.getJob(decodeJobId(jobMatch[1]));
        sendJson(res, result.status, result.body);
        return;
      }

      const eventsMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch) {
        const afterRaw = url.searchParams.get("afterSequence");
        let afterSequence = -1;
        if (afterRaw !== null) {
          afterSequence = Number(afterRaw);
          if (!Number.isInteger(afterSequence)) {
            throw new HttpError(400, "INVALID_QUERY", "afterSequence must be an integer", {
              retriable: false,
            });
          }
        }
        const result = api.getJobEvents(decodeJobId(eventsMatch[1]), afterSequence);
        sendJson(res, result.status, result.body);
        return;
      }

      const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        // Always drain and bound the body regardless of Content-Length/chunked framing.
        // Cancel does not require a body, but oversized payloads must still be rejected.
        await readBody(req, maxBodyBytes, bodyTimeoutMs);
        const result = api.cancelJob(decodeJobId(cancelMatch[1]));
        sendJson(res, result.status, result.body);
        return;
      }

      const manifestMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/manifest$/);
      if (method === "GET" && manifestMatch) {
        const result = api.getJobManifest(decodeJobId(manifestMatch[1]));
        sendJson(res, result.status, result.body);
        return;
      }

      notFound();
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const rawBody =
        error instanceof HttpError
          ? error.toJSON()
          : errorBody("INTERNAL", "internal server error", true);
      const body = {
        ...rawBody,
        message: scrubSessionToken(rawBody.message, sessionToken),
      };
      logger.error("request failed", {
        method,
        path: pathname,
        status,
        code: body.code,
        message: body.message,
        durationMs: Date.now() - started,
      });
      if (!(error instanceof HttpError)) {
        logger.error("unhandled error", {
          name: scrubSessionToken(error?.name, sessionToken),
          message: scrubSessionToken(error?.message, sessionToken),
        });
      }
      if (!res.destroyed && !res.headersSent) {
        sendJson(res, status, body, error instanceof HttpError ? error.headers : undefined);
      }
    } finally {
      logger.debug?.("request complete", {
        method,
        path: pathname,
        durationMs: Date.now() - started,
      });
    }
  };

  const server = tlsOptions
    ? https.createServer(tlsOptions, requestHandler)
    : http.createServer(requestHandler);

  return { server, api, protocol };
}

/**
 * Listen helper used by start script and integration-style tests.
 */
export async function listen(options = {}) {
  const host = requireLoopbackHost(options.host ?? DEFAULT_HOST);
  const port = options.port ?? DEFAULT_PORT;
  const closeGraceMs = boundedDuration(
    options.closeGraceMs,
    "closeGraceMs",
    DEFAULT_CLOSE_GRACE_MS,
  );
  const { server, api, protocol } = createServer(options);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `${protocol}://${hostForUrl(host)}:${resolvedPort}`;
  let closePromise;

  return {
    server,
    api,
    host,
    port: resolvedPort,
    protocol,
    baseUrl,
    close() {
      if (!closePromise) {
        closePromise = new Promise((resolve, reject) => {
          let settled = false;
          let forceTimer;
          let hardTimer;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            clearTimeout(hardTimer);
            if (error) reject(error);
            else resolve();
          };
          forceTimer = setTimeout(() => {
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
          }, closeGraceMs);
          forceTimer.unref();
          hardTimer = setTimeout(
            () => finish(new Error("Mock API server did not close by its deadline")),
            Math.min(60_000, closeGraceMs + 1_000),
          );
          hardTimer.unref();
          server.close((error) => finish(error));
        });
      }
      return closePromise;
    },
  };
}

/**
 * Tiny fetch helper for package tests (Node 24 global fetch).
 */
export async function requestJson(
  baseUrl,
  method,
  path,
  { body, headers, sessionToken: explicitSessionToken } = {},
) {
  async function bootstrapSession() {
    const response = await fetch(`${baseUrl}/healthz`);
    if (!response.ok) {
      throw new Error(`session bootstrap failed with status ${response.status}`);
    }
    const payload = await response.json();
    if (!SESSION_TOKEN_PATTERN.test(payload?.sessionToken ?? "")) {
      throw new Error("session bootstrap returned an invalid token");
    }
    return payload.sessionToken;
  }

  async function send(sessionToken) {
    const requestHeaders = new Headers(headers);
    if (body !== undefined && !requestHeaders.has("content-type")) {
      requestHeaders.set("content-type", "application/json");
    }
    if (sessionToken !== undefined && !requestHeaders.has(SESSION_HEADER)) {
      requestHeaders.set(SESSION_HEADER, sessionToken);
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  let response;
  if (explicitSessionToken !== undefined) {
    response = await send(explicitSessionToken);
  } else {
    response = await send(await bootstrapSession());
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: response.status, body: json, headers: response.headers };
}

export { DEFAULT_HOST, DEFAULT_PORT, redactForLog };

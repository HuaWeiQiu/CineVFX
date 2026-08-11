/**
 * Minimal Node http server for the six frozen Mock API endpoints.
 * Uses only Node built-ins. No external frameworks.
 */

import http from "node:http";
import { URL } from "node:url";
import { HttpError, errorBody } from "./errors.mjs";
import { createLogger, redactForLog } from "./redact.mjs";
import { createMockApi } from "./service.mjs";
import { DEFAULT_LIMITS } from "./store.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      // Drain remaining data so the socket can close cleanly after response.
      req.resume();
      reject(error);
    }

    req.on("data", (chunk) => {
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
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function parseJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
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

/**
 * Create an HTTP server bound to a Mock API service instance.
 */
export function createServer(options = {}) {
  const api = options.api ?? createMockApi(options);
  const logger = options.logger ?? api.logger ?? createLogger();
  const maxBodyBytes = options.maxBodyBytes ?? api.store?.limits?.maxBodyBytes ?? DEFAULT_LIMITS.maxBodyBytes;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      const host = req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`;
      const url = new URL(req.url ?? "/", `http://${host}`);
      pathname = url.pathname;

      // Health for local ops (not one of the six contract endpoints).
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "cinevfx-mock-api" });
        return;
      }

      if (method === "POST" && pathname === "/v1/assets") {
        const body = await parseJsonBody(req, maxBodyBytes);
        const result = await api.createAsset(body);
        sendJson(res, result.status, result.body);
        return;
      }

      if (method === "POST" && pathname === "/v1/jobs") {
        const body = await parseJsonBody(req, maxBodyBytes);
        const headerKey = req.headers["idempotency-key"];
        const result = await api.createJob(body, headerKey);
        sendJson(res, result.status, result.body);
        return;
      }

      const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const result = api.getJob(decodeURIComponent(jobMatch[1]));
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
        const result = api.getJobEvents(decodeURIComponent(eventsMatch[1]), afterSequence);
        sendJson(res, result.status, result.body);
        return;
      }

      const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        // Always drain and bound the body regardless of Content-Length/chunked framing.
        // Cancel does not require a body, but oversized payloads must still be rejected.
        await readBody(req, maxBodyBytes);
        const result = api.cancelJob(decodeURIComponent(cancelMatch[1]));
        sendJson(res, result.status, result.body);
        return;
      }

      const manifestMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/manifest$/);
      if (method === "GET" && manifestMatch) {
        const result = api.getJobManifest(decodeURIComponent(manifestMatch[1]));
        sendJson(res, result.status, result.body);
        return;
      }

      notFound();
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const body =
        error instanceof HttpError
          ? error.toJSON()
          : errorBody("INTERNAL", "internal server error", true);
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
          name: error?.name,
          message: error?.message,
        });
      }
      sendJson(res, status, body);
    } finally {
      logger.debug?.("request complete", {
        method,
        path: pathname,
        durationMs: Date.now() - started,
      });
    }
  });

  return { server, api };
}

/**
 * Listen helper used by start script and integration-style tests.
 */
export async function listen(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const { server, api } = createServer(options);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${resolvedPort}`;

  return {
    server,
    api,
    host,
    port: resolvedPort,
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * Tiny fetch helper for package tests (Node 24 global fetch).
 */
export async function requestJson(baseUrl, method, path, { body, headers } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

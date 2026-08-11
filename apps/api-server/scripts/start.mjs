import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listen } from "../src/http.mjs";

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8787;
const ALLOW_HTTP_ENV = "CINEVFX_MOCK_ALLOW_HTTP";
const TLS_CERT_ENV = "CINEVFX_MOCK_TLS_CERT_FILE";
const TLS_KEY_ENV = "CINEVFX_MOCK_TLS_KEY_FILE";

function parsePort(raw) {
  if (raw !== String(DEFAULT_PORT)) {
    throw new Error(`CINEVFX_MOCK_PORT must be ${DEFAULT_PORT}`);
  }
  return DEFAULT_PORT;
}

/** Resolve environment configuration before opening a listening socket. */
export async function loadStartOptions(
  env = process.env,
  { readFileFn = readFile } = {},
) {
  const host = env.CINEVFX_MOCK_HOST ?? DEFAULT_HOST;
  if (
    typeof host !== "string" ||
    (host !== "127.0.0.1" && host.toLowerCase() !== "localhost")
  ) {
    throw new Error("CINEVFX_MOCK_HOST must be 127.0.0.1 or localhost");
  }
  const port = parsePort(env.CINEVFX_MOCK_PORT ?? String(DEFAULT_PORT));

  const certConfigured = env[TLS_CERT_ENV] !== undefined;
  const keyConfigured = env[TLS_KEY_ENV] !== undefined;
  const allowHttp = env[ALLOW_HTTP_ENV];
  if (allowHttp !== undefined && allowHttp !== "1") {
    throw new Error(`${ALLOW_HTTP_ENV} must be exactly 1 when configured`);
  }
  if (certConfigured !== keyConfigured) {
    throw new Error(`${TLS_CERT_ENV} and ${TLS_KEY_ENV} must be configured together`);
  }
  if (!certConfigured) {
    if (allowHttp !== "1") {
      throw new Error(
        `TLS is required; configure ${TLS_CERT_ENV} and ${TLS_KEY_ENV}, or explicitly set ${ALLOW_HTTP_ENV}=1 for local HTTP`,
      );
    }
    return { host, port };
  }

  const certFile = env[TLS_CERT_ENV];
  const keyFile = env[TLS_KEY_ENV];
  if (certFile.trim().length === 0 || keyFile.trim().length === 0) {
    throw new Error(`${TLS_CERT_ENV} and ${TLS_KEY_ENV} must not be empty`);
  }

  let cert;
  let key;
  try {
    [cert, key] = await Promise.all([readFileFn(certFile), readFileFn(keyFile)]);
  } catch {
    throw new Error("TLS certificate or key file could not be read");
  }
  if (cert.length === 0 || key.length === 0) {
    throw new Error("TLS certificate and key files must not be empty");
  }

  return { host, port, tls: { cert, key } };
}

const endpoints = [
  "POST /v1/assets",
  "POST /v1/jobs",
  "GET /v1/jobs/{id}",
  "GET /v1/jobs/{id}/events",
  "POST /v1/jobs/{id}/cancel",
  "GET /v1/jobs/{id}/manifest",
];

export async function startFromEnvironment({
  env = process.env,
  readFileFn = readFile,
  listenFn = listen,
  output = console.log,
  installSignalHandlers = true,
} = {}) {
  const options = await loadStartOptions(env, { readFileFn });
  const runtime = await listenFn(options);
  output(
    JSON.stringify({
      message: "CineVFX Mock API listening",
      baseUrl: runtime.baseUrl,
      endpoints,
    }),
  );

  if (installSignalHandlers) {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      output(JSON.stringify({ message: "shutting down", signal }));
      runtime.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  return runtime;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await startFromEnvironment();
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "CineVFX Mock API failed to start",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

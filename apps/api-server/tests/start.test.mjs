import assert from "node:assert/strict";
import test from "node:test";
import { loadStartOptions, startFromEnvironment } from "../scripts/start.mjs";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./tls-fixture.mjs";

const certFile = "/private/cinevfx-test/server-cert.pem";
const keyFile = "/private/cinevfx-test/server-key.pem";

function tlsEnvironment(overrides = {}) {
  return {
    CINEVFX_MOCK_HOST: "127.0.0.1",
    CINEVFX_MOCK_PORT: "8787",
    CINEVFX_MOCK_TLS_CERT_FILE: certFile,
    CINEVFX_MOCK_TLS_KEY_FILE: keyFile,
    ...overrides,
  };
}

test("start options enforce canonical HTTPS defaults and explicit HTTP opt-in", async () => {
  await assert.rejects(() => loadStartOptions({}), /TLS is required/);
  assert.deepEqual(
    await loadStartOptions({ CINEVFX_MOCK_ALLOW_HTTP: "1" }),
    { host: "localhost", port: 8787 },
  );
  assert.deepEqual(
    await loadStartOptions({
      CINEVFX_MOCK_ALLOW_HTTP: "1",
      CINEVFX_MOCK_HOST: "127.0.0.1",
      CINEVFX_MOCK_PORT: "8787",
    }),
    { host: "127.0.0.1", port: 8787 },
  );

  await assert.rejects(
    () => loadStartOptions({ CINEVFX_MOCK_PORT: "8787.5" }),
    /must be 8787/,
  );
  await assert.rejects(
    () => loadStartOptions({ CINEVFX_MOCK_PORT: "65536" }),
    /must be 8787/,
  );
  await assert.rejects(
    () => loadStartOptions({ CINEVFX_MOCK_ALLOW_HTTP: "true" }),
    /must be exactly 1/,
  );
  await assert.rejects(
    () => loadStartOptions({ CINEVFX_MOCK_HOST: "" }),
    /must be 127\.0\.0\.1 or localhost/,
  );
  await assert.rejects(
    () => loadStartOptions({ CINEVFX_MOCK_HOST: "0.0.0.0" }),
    /must be 127\.0\.0\.1 or localhost/,
  );
});

test("start options reject half-configured TLS before file reads or listen", async () => {
  for (const env of [
    { CINEVFX_MOCK_TLS_CERT_FILE: certFile },
    { CINEVFX_MOCK_TLS_KEY_FILE: keyFile },
  ]) {
    let readCalled = false;
    let listenCalled = false;
    await assert.rejects(
      () =>
        startFromEnvironment({
          env,
          readFileFn: async () => {
            readCalled = true;
            return Buffer.from("not-used");
          },
          listenFn: async () => {
            listenCalled = true;
          },
          installSignalHandlers: false,
        }),
      /must be configured together/,
    );
    assert.equal(readCalled, false);
    assert.equal(listenCalled, false);
  }
});

test("start options read both TLS files and pass only in-memory material to listen", async () => {
  const reads = [];
  const outputs = [];
  let listenedOptions;
  const runtime = {
    baseUrl: "https://127.0.0.1:8787",
    async close() {},
  };

  const result = await startFromEnvironment({
    env: tlsEnvironment(),
    readFileFn: async (file) => {
      reads.push(file);
      if (file === certFile) return Buffer.from(TEST_TLS_CERT);
      if (file === keyFile) return Buffer.from(TEST_TLS_KEY);
      throw new Error("unexpected file");
    },
    listenFn: async (options) => {
      listenedOptions = options;
      return runtime;
    },
    output: (line) => outputs.push(line),
    installSignalHandlers: false,
  });

  assert.equal(result, runtime);
  assert.deepEqual(reads, [certFile, keyFile]);
  assert.equal(listenedOptions.host, "127.0.0.1");
  assert.equal(listenedOptions.port, 8787);
  assert.equal(listenedOptions.tls.cert.toString("utf8"), TEST_TLS_CERT);
  assert.equal(listenedOptions.tls.key.toString("utf8"), TEST_TLS_KEY);
  assert.equal(outputs.length, 1);
  assert.equal(JSON.parse(outputs[0]).baseUrl, runtime.baseUrl);
  assert.equal(outputs[0].includes("sessionToken"), false);
  assert.equal(outputs[0].includes(TEST_TLS_KEY), false);

  const canonical = await loadStartOptions(
    {
      CINEVFX_MOCK_TLS_CERT_FILE: certFile,
      CINEVFX_MOCK_TLS_KEY_FILE: keyFile,
    },
    {
      readFileFn: async (file) =>
        Buffer.from(file === certFile ? TEST_TLS_CERT : TEST_TLS_KEY),
    },
  );
  assert.equal(canonical.host, "localhost");
  assert.equal(canonical.port, 8787);
});

test("start fails closed on unreadable or empty TLS files without leaking paths", async () => {
  let listenCalled = false;
  await assert.rejects(
    () =>
      startFromEnvironment({
        env: tlsEnvironment(),
        readFileFn: async () => {
          throw new Error(`ENOENT: ${certFile}`);
        },
        listenFn: async () => {
          listenCalled = true;
        },
        installSignalHandlers: false,
      }),
    (error) => {
      assert.equal(error.message, "TLS certificate or key file could not be read");
      assert.equal(error.message.includes(certFile), false);
      return true;
    },
  );
  assert.equal(listenCalled, false);

  await assert.rejects(
    () =>
      loadStartOptions(tlsEnvironment(), {
        readFileFn: async (file) =>
          file === certFile ? Buffer.alloc(0) : Buffer.from(TEST_TLS_KEY),
      }),
    /must not be empty/,
  );
});

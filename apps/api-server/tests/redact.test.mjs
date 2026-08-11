import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, redactForLog } from "../src/redact.mjs";

test("redactForLog strips sensitive keys and path-like values", () => {
  const redacted = redactForLog({
    assetId: "asset_proxy_source_01",
    prompt: "should not appear",
    password: "secret",
    apiKey: "abc",
    accessToken: "at-secret",
    refresh_token: "rt-secret",
    sessionToken: "test_session_token_0123456789abcdef",
    clientSecret: "cs-secret",
    privateKey: "pk-secret",
    cookie: "session=abc",
    note: "see /Users/tanye/secret/project",
    volumes: "/Volumes/External/cinevfx/private.png",
    linux: "/home/user/private.png",
    root: "/root/private.png",
    workspace: "open /workspace/cine vfx/private.png",
    mounted: "/mnt/render/private.png",
    service: "/srv/cinevfx/private.png",
    customRoot: "/custom-root/private.png",
    winBackslash: "C:\\Users\\tanye\\secret\\file.png",
    winForward: "C:/Users/tanye/secret/file.png",
    unc: "\\\\fileserver\\share\\private.psd",
    uncForward: "//fileserver/share/private.psd",
    authorizationHeader: "Bearer super-secret-token-value",
    content: "AAAA".repeat(40),
    effectLabel: "user-private-effect-label",
    label: "another-user-label",
  });

  assert.equal(redacted.prompt, "[REDACTED]");
  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.apiKey, "[REDACTED]");
  assert.equal(redacted.accessToken, "[REDACTED]");
  assert.equal(redacted.refresh_token, "[REDACTED]");
  assert.equal(redacted.sessionToken, "[REDACTED]");
  assert.equal(redacted.clientSecret, "[REDACTED]");
  assert.equal(redacted.privateKey, "[REDACTED]");
  assert.equal(redacted.cookie, "[REDACTED]");
  assert.equal(redacted.content, "[REDACTED]");
  assert.equal(redacted.effectLabel, "[REDACTED]");
  assert.equal(redacted.label, "[REDACTED]");
  assert.match(redacted.note, /REDACTED:absolute-unix-path/);
  assert.match(redacted.volumes, /REDACTED:absolute-unix-path/);
  assert.match(redacted.linux, /REDACTED:absolute-unix-path/);
  assert.match(redacted.root, /REDACTED:absolute-unix-path/);
  assert.match(redacted.workspace, /REDACTED:absolute-unix-path/);
  assert.match(redacted.mounted, /REDACTED:absolute-unix-path/);
  assert.match(redacted.service, /REDACTED:absolute-unix-path/);
  assert.match(redacted.customRoot, /REDACTED:absolute-unix-path/);
  assert.match(redacted.winBackslash, /REDACTED:absolute-windows-path/);
  assert.match(redacted.winForward, /REDACTED:absolute-windows-path/);
  assert.match(redacted.unc, /REDACTED:unc-path/);
  assert.match(redacted.uncForward, /REDACTED:unc-path/);
  assert.match(redacted.authorizationHeader, /REDACTED:bearer-token/);
  assert.equal(redacted.assetId, "asset_proxy_source_01");
});

test("redactForLog replaces binary containers before object traversal", () => {
  const arrayBuffer = new ArrayBuffer(6);
  const redacted = redactForLog({
    buffer: Buffer.from([101, 102, 103]),
    typed: new Uint8Array([104, 105, 106, 107]),
    arrayBuffer,
    view: new DataView(arrayBuffer, 1, 3),
  });
  assert.equal(redacted.buffer, "[REDACTED:binary len=3]");
  assert.equal(redacted.typed, "[REDACTED:binary len=4]");
  assert.equal(redacted.arrayBuffer, "[REDACTED:binary len=6]");
  assert.equal(redacted.view, "[REDACTED:binary len=3]");
});

test("path redaction handles wrappers and file URIs without hiding HTTPS URLs", () => {
  for (const value of [
    "[/root/private.psd]",
    "{/workspace/private.psd}",
    "</mnt/private.psd>",
    ";/srv/private.psd",
    "[C:\\Users\\secret\\file.psd]",
    "[\\\\server\\share\\file.psd]",
    "file:///root/private.psd",
  ]) {
    const redacted = redactForLog(value);
    assert.match(redacted, /REDACTED/);
    assert.equal(redacted.includes("private.psd"), false);
  }
  assert.equal(
    redactForLog("https://example.com/v1/jobs"),
    "https://example.com/v1/jobs",
  );
});

test("logger emits JSON without sensitive values", () => {
  const lines = [];
  const logger = createLogger({
    sink: {
      info(line) {
        lines.push(line);
      },
    },
  });
  logger.info("created", {
    prompt: "hidden",
    path: "/home/user/private.png",
    accessToken: "tok-xyz",
    volumesPath: "/Volumes/Drive/secret.psd",
    jobId: "job_mock_0001",
    sessionToken: "test_session_token_0123456789abcdef",
  });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.fields.prompt, "[REDACTED]");
  assert.match(parsed.fields.path, /REDACTED/);
  assert.equal(parsed.fields.accessToken, "[REDACTED]");
  assert.match(parsed.fields.volumesPath, /REDACTED/);
  assert.equal(parsed.fields.jobId, "job_mock_0001");
  assert.equal(parsed.fields.sessionToken, "[REDACTED]");
  assert.equal(lines[0].includes("hidden"), false);
  assert.equal(lines[0].includes("/home/user/private.png"), false);
  assert.equal(lines[0].includes("tok-xyz"), false);
  assert.equal(lines[0].includes("/Volumes/Drive/secret.psd"), false);
  assert.equal(lines[0].includes("test_session_token_0123456789abcdef"), false);
});

test("logger redacts a session credential embedded in free text", () => {
  for (const token of [
    "test_session_token_0123456789abcdef",
    `${"A".repeat(31)}-`,
  ]) {
    const structured = redactForLog({
      headers: { "X-CineVFX-Session": [token] },
    });
    assert.equal(JSON.stringify(structured).includes(token), false);
    assert.equal(structured.headers["X-CineVFX-Session"], "[REDACTED]");

    for (const text of [
      `X-CineVFX-Session: ${token}`,
      JSON.stringify({ headers: { "X-CineVFX-Session": token } }),
      JSON.stringify({ headers: { "X-CineVFX-Session": [token] } }),
      JSON.stringify({ headers: [["X-CineVFX-Session", token]] }),
    ]) {
      const redacted = redactForLog(text);
      assert.equal(redacted.includes(token), false);
      assert.match(redacted, /REDACTED:session-token/);
    }
  }
});

test("logger redacts non-string message values", () => {
  const lines = [];
  const logger = createLogger({
    sink: {
      info(line) {
        lines.push(line);
      },
    },
  });
  logger.info(Buffer.from([115, 101, 99, 114, 101, 116]));
  logger.info({ path: "/workspace/private file.psd" });
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).message, "[REDACTED:binary len=6]");
  assert.match(JSON.parse(lines[1]).message.path, /REDACTED:absolute-unix-path/);
  assert.equal(lines.join("\n").includes("/workspace/private file.psd"), false);
});

test("logger never exposes arbitrary user-controlled effect labels", () => {
  const lines = [];
  const logger = createLogger({
    sink: {
      info(line) {
        lines.push(line);
      },
    },
  });
  const secretLabel = "user-private-magic-label-xyzzy";
  logger.info("job created", {
    jobId: "job_mock_0001",
    effectLabel: secretLabel,
    label: secretLabel,
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(secretLabel), false);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.fields.effectLabel, "[REDACTED]");
  assert.equal(parsed.fields.label, "[REDACTED]");
});

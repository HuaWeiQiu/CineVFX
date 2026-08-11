import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redactValue,
  redactString,
  formatSafeLog,
  createSafeLogger,
} from "../src/log/redact.mjs";

describe("log redaction", () => {
  it("redacts absolute paths, data URLs, bearer tokens, and sensitive keys", () => {
    const redacted = redactValue({
      message: "ok",
      filePath: "/Users/tanye/secret/file.psd",
      prompt: "do not log me",
      token: "abc",
      nested: {
        authorization: "Bearer super-secret-token-value",
        note: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    });
    assert.equal(redacted.filePath, "[redacted]");
    assert.equal(redacted.prompt, "[redacted]");
    assert.equal(redacted.token, "[redacted]");
    assert.equal(redacted.nested.authorization, "[redacted]");
    assert.match(String(redacted.nested.note), /redacted/);
    assert.equal(String(redacted.nested.note).includes("iVBORw0KGgo"), false);
  });

  it("redacts path-like strings in free text", () => {
    const text = redactString("failed at /Users/tanye/project/file.psd");
    assert.equal(text.includes("/Users/tanye"), false);
    assert.match(text, /path-redacted/);
  });

  it("redacts absolute paths with spaces and file URIs", () => {
    for (const path of [
      "/Users/Jane Doe/Cine Project/source image.psd",
      "/Users/Jane Doe/Cine and FX",
      "C:\\Users\\Jane Doe\\Cine Project\\source image.psd",
      "C:\\Users\\Jane Doe\\Cine and FX",
      "\\\\fileserver\\shared folder\\Cine Project\\source image.psd",
      "\\\\fileserver\\shared folder\\Cine and FX",
      "file:///Users/Jane%20Doe/Cine%20Project/source.psd",
      "file:///Users/Jane Doe/Cine Project/source image.psd",
    ]) {
      const redacted = redactString(`failed to open ${path}`);
      assert.equal(redacted.includes("Jane Doe"), false, redacted);
      assert.equal(redacted.includes("source image.psd"), false, redacted);
      assert.match(redacted, /path-redacted/, redacted);
    }
  });

  it("redacts POSIX paths outside the old allowlist, UNC shares, and sourcePath keys", () => {
    const free = redactString(
      "open /etc/passwd and /opt/company/project.psd and \\\\fileserver\\share\\clip.psd",
    );
    assert.equal(free.includes("/etc/passwd"), false);
    assert.equal(free.includes("/opt/company"), false);
    assert.equal(free.includes("fileserver"), false);
    assert.match(free, /path-redacted/);

    const obj = redactValue({
      sourcePath: "/opt/company/project.psd",
      documentPath: "C:\\Users\\someone\\clip.psd",
      workingDir: "/var/tmp/work",
      accessToken: "secret-token-value",
      refresh_token: "refresh-secret",
      userPrompt: "hidden prompt text",
    });
    assert.equal(obj.sourcePath, "[redacted]");
    assert.equal(obj.documentPath, "[redacted]");
    assert.equal(obj.workingDir, "[redacted]");
    assert.equal(obj.accessToken, "[redacted]");
    assert.equal(obj.refresh_token, "[redacted]");
    assert.equal(obj.userPrompt, "[redacted]");
  });

  it("formatSafeLog never includes raw credentials", () => {
    const line = formatSafeLog("auth", {
      password: "hunter2",
      jobId: "job_mock_0001",
    });
    assert.equal(line.includes("hunter2"), false);
    assert.match(line, /job_mock_0001/);
  });

  it("redacts the local session header in structured and free-text logs", () => {
    for (const token of [
      "test_session_token_0123456789abcdef",
      `${"A".repeat(31)}-`,
    ]) {
      const structured = redactValue({
        sessionToken: token,
        headers: { "X-CineVFX-Session": [token] },
      });
      assert.equal(structured.sessionToken, "[redacted]");
      assert.equal(structured.headers["X-CineVFX-Session"], "[redacted]");
      for (const value of [
        `X-CineVFX-Session: ${token}`,
        JSON.stringify({ headers: { "X-CineVFX-Session": token } }),
        JSON.stringify({ headers: { "X-CineVFX-Session": [token] } }),
        JSON.stringify({ headers: [["X-CineVFX-Session", token]] }),
      ]) {
        const text = redactString(value);
        assert.equal(text.includes(token), false);
        assert.match(text, /X-CineVFX-Session: \[redacted\]/);
      }
    }
  });

  it("redacts Basic auth and secrets embedded in URLs", () => {
    const redacted = redactString(
      "Basic dXNlcjpzdXBlcnNlY3JldA== https://alice:secret@example.com/render?token=abc123&quality=high&api_key=xyz&accessToken=camel-secret&client_secret=client-secret#done",
    );
    for (const secret of [
      "dXNlcjpzdXBlcnNlY3JldA==",
      "alice",
      "abc123",
      "xyz",
      "camel-secret",
      "client-secret",
    ]) {
      assert.equal(redacted.includes(secret), false, redacted);
    }
    assert.equal(redacted.includes("alice:secret@"), false, redacted);
    assert.match(redacted, /Basic \[redacted\]/);
    assert.match(redacted, /token=\[redacted\]/);
    assert.match(redacted, /quality=high/);
  });

  it("preserves ordinary HTTPS URLs", () => {
    const message =
      "fetch https://example.com/assets/image.png?width=100&height=200#preview";
    assert.equal(redactString(message), message);
    const alongsidePath = redactString(
      "open file:///Users/Jane Doe/source.psd then https://example.com/help",
    );
    assert.equal(alongsidePath.includes("Jane Doe"), false);
    assert.match(alongsidePath, /https:\/\/example\.com\/help/);
  });

  it("safe logger emits every line but retains at most 200 redacted lines", () => {
    const lines = [];
    const logger = createSafeLogger({ write: (l) => lines.push(l) });
    for (let index = 0; index < 205; index += 1) {
      logger.info(`line-${index}`, { apiKey: `secret-${index}` });
    }
    assert.equal(lines.length, 205);
    assert.equal(lines.some((line) => line.includes("secret-204")), false);
    assert.equal(logger.lines().length, 200);
    assert.match(logger.lines()[0], /^line-5 /);
    assert.match(logger.lines()[199], /^line-204 /);
  });
});

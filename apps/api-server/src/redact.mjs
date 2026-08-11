/**
 * Log redaction helpers. Never log image bytes, prompts, credentials,
 * absolute local paths, or protected user content.
 */

/**
 * Key names that must never appear in logs with their raw values.
 * Covers camelCase, snake_case, and common credential aliases.
 */
const SENSITIVE_KEY_PATTERN =
  /^(prompt|password|passwd|passphrase|api[_-]?key|authorization|auth|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?id|private[_-]?key|secret|credential|credentials|cookie|set[_-]?cookie|session|session[_-]?id|token|bearer|content|image[_-]?bytes|pixels|raw[_-]?bytes|local[_-]?path|file[_-]?path|absolute[_-]?path|source[_-]?path|upload[_-]?path|effect[_-]?label|label|user[_-]?content|protected[_-]?content)$/i;

const SENSITIVE_VALUE_PATTERNS = [
  { name: "data-url-image", regex: /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi },
  { name: "bearer-token", regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
];

function absolutePathKind(value) {
  if (/file:\/\/\//i.test(value)) return "absolute-file-uri-path";
  if (/(^|[^A-Za-z0-9:\/\\])(?:\\\\|\/\/)[^\\/]/.test(value)) return "unc-path";
  if (/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(value)) return "absolute-windows-path";
  if (/(^|[^A-Za-z0-9:\/\\])\/(?!\/)/.test(value)) return "absolute-unix-path";
  return null;
}

function redactString(value) {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  const pathKind = absolutePathKind(out);
  if (pathKind) {
    return `[REDACTED:${pathKind}]`;
  }
  return out;
}

/**
 * Returns a JSON-safe structure safe for logging.
 * Sensitive keys are replaced; long base64-like strings are truncated/redacted.
 */
export function redactForLog(value, depth = 0) {
  if (depth > 12) {
    return "[REDACTED:max-depth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 256 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return `[REDACTED:long-token len=${value.length}]`;
    }
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return `[REDACTED:binary len=${value.byteLength}]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[REDACTED:binary len=${value.byteLength}]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = redactForLog(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function createLogger(options = {}) {
  const sink = options.sink ?? console;
  const level = options.level ?? "info";

  function write(method, message, fields) {
    const payload = {
      level: method,
      message: redactForLog(message),
    };
    if (fields !== undefined) {
      payload.fields = redactForLog(fields);
    }
    const line = JSON.stringify(payload);
    if (typeof sink[method] === "function") {
      sink[method](line);
    } else if (typeof sink.log === "function") {
      sink.log(line);
    }
  }

  return {
    level,
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, fields) {
      write("error", message, fields);
    },
    debug(message, fields) {
      if (level === "debug") {
        write("debug", message, fields);
      }
    },
  };
}

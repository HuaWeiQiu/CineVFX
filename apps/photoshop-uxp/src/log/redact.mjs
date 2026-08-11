/**
 * Log redaction helpers. Never log image bytes, prompts, local paths,
 * credentials, or protected user content.
 */

const SENSITIVE_KEY =
  /(?:^|[_-])(prompt|password|passwd|token|authorization|auth|cookie|secret|api[_-]?key|private[_-]?key|access[_-]?key|refresh[_-]?token|bearer|bytes|image[_-]?bytes|pixel[_-]?data|raw[_-]?data|content[_-]?base64|file[_-]?path|local[_-]?path|absolute[_-]?path|source[_-]?path|document[_-]?path|working[_-]?dir|cwd|homedir|home[_-]?dir)(?:$|[_-])|^path$/i;

/** Absolute / local paths without spaces (POSIX, Windows drive, UNC). */
const ABSOLUTE_PATH_NO_SPACES =
  /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s\\/]+\\[^\s"']+|(?:\/(?:Users|home|var|tmp|private|Volumes|etc|opt|usr|root|Library|Applications|System|bin|sbin|data|mnt|media|proc|dev|run|boot|srv)\/)[^\s"']+|(?:\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+))/g;

const DATA_URL = /data:[a-z0-9.+/-]+;base64,[a-z0-9+/=\s]+/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9._~+/=-]+/gi;
const CINEVFX_SESSION =
  /\bX-CineVFX-Session["']?\s*(?::|=>?|,)\s*(?:\[\s*)?["']?[A-Za-z0-9_-]{32,128}(?![A-Za-z0-9_-])["']?(?:\s*\])?/gi;
const HTTP_URL = /\bhttps?:\/\/[^\s<>"']+/gi;
const FILE_URI_NO_SPACES = /\bfile:\/\/\/?[^\s<>"']+/gi;
const PATH_WITH_EXTENSION = new RegExp(
  String.raw`(?:file:\/\/\/?(?:[A-Za-z]:)?[\\/]|[A-Za-z]:\\|\\\\|\/)[^\r\n"'<>]+?\.(?:psd|psb|png|jpe?g|webp|tiff?|gif|bmp|json|txt|log|bin|dat|tmp|zip|pdf|mp4|mov)`,
  "gi",
);
const SPACED_ABSOLUTE_PATH_TO_LINE_END =
  /(?:[A-Za-z]:\\|\\\\[^\r\n"'<>]+\\|\/(?:Users|home|var|tmp|private|Volumes|etc|opt|usr|root|Library|Applications|System|bin|sbin|data|mnt|media|proc|dev|run|boot|srv)\/)(?=[^\r\n"'<>]*\s)[^\r\n"'<>]+?(?=\s+CINEVFX_URL_\d+_END|$)/gm;
const BASE64_BLOB = /(?:[A-Za-z0-9+/]{48,}={0,2})/g;
const SENSITIVE_URL_PARAM =
  /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|password|passwd|secret|authorization|auth|cookie|session|credential|signature|sig|key)$/i;
const MAX_LOG_LINES = 200;

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactValue(child, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * @param {string} key
 */
function isSensitiveKey(key) {
  if (typeof key !== "string") return false;
  if (/^x-cinevfx-session$/i.test(key)) return true;
  if (SENSITIVE_KEY.test(key)) return true;
  // Common path-ish suffixes even when not matched by the full regex.
  if (/(?:^|[_-])path$/i.test(key)) return true;
  if (/(?:file|local|source|document|absolute)path$/i.test(key)) return true;
  // CamelCase variants: accessToken, userPrompt, refreshToken, imageBytes, ...
  const camel = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (camel !== key.toLowerCase() && SENSITIVE_KEY.test(camel)) return true;
  if (
    /(?:^|[_-])(token|prompt|password|secret|authorization|bearer)(?:$|[_-])/i.test(
      camel,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function redactString(text) {
  if (typeof text !== "string") return "";
  /** @type {string[]} */
  const preservedUrls = [];
  const withProtectedUrls = text.replace(HTTP_URL, (url) => {
    const placeholder = `CINEVFX_URL_${preservedUrls.length}_END`;
    preservedUrls.push(redactHttpUrl(url));
    return placeholder;
  });

  const redacted = withProtectedUrls
    .replace(DATA_URL, "data:[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(BASIC_AUTH, "Basic [redacted]")
    .replace(CINEVFX_SESSION, "X-CineVFX-Session: [redacted]")
    .replace(PATH_WITH_EXTENSION, "[path-redacted]")
    .replace(FILE_URI_NO_SPACES, "[path-redacted]")
    .replace(SPACED_ABSOLUTE_PATH_TO_LINE_END, "[path-redacted]")
    .replace(ABSOLUTE_PATH_NO_SPACES, "[path-redacted]")
    .replace(BASE64_BLOB, "[bytes-redacted]");

  return redacted.replace(/CINEVFX_URL_(\d+)_END/g, (_placeholder, index) => {
    return preservedUrls[Number(index)] ?? "[url-redacted]";
  });
}

/**
 * Redact HTTP credentials without changing ordinary URLs.
 * @param {string} rawUrl
 */
function redactHttpUrl(rawUrl) {
  let safeUrl = rawUrl.replace(
    /^(https?:\/\/)[^/?#@\s]+@/i,
    "$1[redacted]@",
  );
  const queryStart = safeUrl.indexOf("?");
  if (queryStart < 0) return safeUrl;

  const hashStart = safeUrl.indexOf("#", queryStart);
  const queryEnd = hashStart < 0 ? safeUrl.length : hashStart;
  const query = safeUrl.slice(queryStart + 1, queryEnd);
  const redactedQuery = query
    .split("&")
    .map((entry) => {
      const separator = entry.indexOf("=");
      const rawKey = separator < 0 ? entry : entry.slice(0, separator);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        // Malformed URL encoding is treated as an opaque, non-sensitive key.
      }
      if (!SENSITIVE_URL_PARAM.test(key) && !isSensitiveKey(key)) return entry;
      return `${rawKey}=[redacted]`;
    })
    .join("&");
  return `${safeUrl.slice(0, queryStart + 1)}${redactedQuery}${safeUrl.slice(queryEnd)}`;
}

/**
 * Build a safe log line from a message and optional structured fields.
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 * @returns {string}
 */
export function formatSafeLog(message, fields) {
  const safeMessage = redactString(String(message ?? ""));
  if (!fields || Object.keys(fields).length === 0) return safeMessage;
  const safeFields = redactValue(fields);
  return `${safeMessage} ${JSON.stringify(safeFields)}`;
}

/**
 * Create a logger that only emits redacted text.
 * @param {{ write?: (line: string) => void }} [options]
 */
export function createSafeLogger(options = {}) {
  const write = options.write ?? (() => {});
  const lines = [];

  function emit(message, fields) {
    const line = formatSafeLog(message, fields);
    lines.push(line);
    if (lines.length > MAX_LOG_LINES) {
      lines.splice(0, lines.length - MAX_LOG_LINES);
    }
    write(line);
  }

  return {
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    info(message, fields) {
      emit(message, fields);
    },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    warn(message, fields) {
      emit(`WARN ${message}`, fields);
    },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    error(message, fields) {
      emit(`ERROR ${message}`, fields);
    },
    lines() {
      return [...lines];
    },
  };
}

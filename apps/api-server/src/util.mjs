import { createHash } from "node:crypto";

/** Deep structural equality for JSON-compatible values. */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((value, index) => deepEqual(value, b[index]));
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Stable JSON stringify with sorted object keys for canonical comparison. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function padCounter(value, width = 4) {
  return String(value).padStart(width, "0");
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Format an ISO-8601 UTC timestamp without milliseconds (contract pattern). */
export function formatIsoUtc(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

export function addSecondsIso(iso, seconds) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid ISO timestamp: ${iso}`);
  }
  return formatIsoUtc(new Date(ms + seconds * 1000));
}

export function isIsoAfter(a, b) {
  return Date.parse(a) > Date.parse(b);
}

/**
 * Deterministic-ish helpers for panel workflow metadata ids.
 */

/**
 * @param {string} hexChar
 */
export function digestPlaceholder(hexChar) {
  const c = String(hexChar).toLowerCase().slice(0, 1) || "0";
  return `sha256:${c.repeat(64)}`;
}

let seq = 0;

/**
 * Build a contract-valid idempotency key.
 * @param {string} [suffix]
 */
export function makeIdempotencyKey(suffix) {
  seq += 1;
  const tail =
    suffix && suffix.length > 0
      ? suffix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)
      : String(seq).padStart(4, "0");
  return `idem_uxp_panel_${tail}_${Date.now().toString(36)}`;
}

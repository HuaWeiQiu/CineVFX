/**
 * Semantic checks for JobEvent documents and ordered event streams.
 */

export function validateJobEventSemantics(event) {
  const errors = [];
  if (!event || typeof event !== "object") {
    return { valid: false, errors: [{ path: "#", message: "event must be an object" }] };
  }

  // Schema covers most type/state constraints; keep a defensive mirror for
  // consumers that call semantic helpers without schema validation.
  if (event.type === "asset_ready" && !event.assetRef) {
    errors.push({ path: "#/assetRef", message: "asset_ready requires assetRef" });
  }
  if (event.type === "cancel_accepted" && event.state !== "CANCELLED") {
    errors.push({
      path: "#/state",
      message: "cancel_accepted requires state CANCELLED",
    });
  }
  if (event.type === "error" && !event.error) {
    errors.push({ path: "#/error", message: "error event requires error payload" });
  }
  if (event.type === "manifest_ready") {
    if (!event.manifestId) {
      errors.push({ path: "#/manifestId", message: "manifest_ready requires manifestId" });
    }
    if (event.state !== "SUCCEEDED") {
      errors.push({ path: "#/state", message: "manifest_ready requires state SUCCEEDED" });
    }
  }
  if (event.type === "progress" && !event.progress) {
    errors.push({ path: "#/progress", message: "progress event requires progress payload" });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an ordered event collection for uniqueness and strict sequence growth.
 * Sequences must be unique and strictly increasing in array order.
 */
export function validateJobEventStream(events, options = {}) {
  const errors = [];
  if (!Array.isArray(events)) {
    return { valid: false, errors: [{ path: "#", message: "events must be an array" }] };
  }

  const requireContiguousFrom =
    options.requireContiguousFrom === undefined ? null : options.requireContiguousFrom;
  const seenSequences = new Set();
  const seenEventIds = new Set();
  let previousSequence = null;

  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object") {
      errors.push({ path: `#/${index}`, message: "event must be an object" });
      continue;
    }

    const semantic = validateJobEventSemantics(event);
    for (const error of semantic.errors) {
      errors.push({
        path: error.path === "#" ? `#/${index}` : `#/${index}${error.path.slice(1)}`,
        message: error.message,
      });
    }

    if (typeof event.sequence !== "number") {
      errors.push({ path: `#/${index}/sequence`, message: "sequence is required" });
      continue;
    }

    if (seenSequences.has(event.sequence)) {
      errors.push({
        path: `#/${index}/sequence`,
        message: `duplicate sequence ${event.sequence}`,
      });
    }
    seenSequences.add(event.sequence);

    if (event.eventId) {
      if (seenEventIds.has(event.eventId)) {
        errors.push({
          path: `#/${index}/eventId`,
          message: `duplicate eventId ${event.eventId}`,
        });
      }
      seenEventIds.add(event.eventId);
    }

    if (previousSequence !== null && event.sequence <= previousSequence) {
      errors.push({
        path: `#/${index}/sequence`,
        message: `sequence ${event.sequence} is not strictly increasing after ${previousSequence}`,
      });
    }
    previousSequence = event.sequence;

    if (requireContiguousFrom !== null && index === 0 && event.sequence !== requireContiguousFrom) {
      errors.push({
        path: `#/0/sequence`,
        message: `stream must start at sequence ${requireContiguousFrom}`,
      });
    }
    if (
      requireContiguousFrom !== null &&
      index > 0 &&
      event.sequence !== events[index - 1].sequence + 1
    ) {
      errors.push({
        path: `#/${index}/sequence`,
        message: "stream sequences must be contiguous",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

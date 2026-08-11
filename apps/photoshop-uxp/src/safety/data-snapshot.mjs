/**
 * Clone caller-owned metadata into a stable, data-only JSON graph without
 * invoking accessors, custom iterators, or toJSON hooks.
 * @param {unknown} value
 * @param {{ maxDepth?: number }} [options]
 * @returns {unknown}
 */
export function cloneDataOnlyGraph(value, options = {}) {
  const maxDepth = options.maxDepth ?? 32;
  return cloneValue(value, new Set(), 0, maxDepth);
}

/**
 * @param {unknown} value
 * @param {Set<object>} ancestors
 * @param {number} depth
 * @param {number} maxDepth
 * @returns {unknown}
 */
function cloneValue(value, ancestors, depth, maxDepth) {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("metadata numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`metadata contains unsupported ${typeof value} value`);
  }
  if (depth > maxDepth) {
    throw new Error(`metadata nesting exceeds ${maxDepth} levels`);
  }
  if (ancestors.has(value)) throw new Error("metadata must not be cyclic");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) throw new Error(`metadata omits array item ${index}`);
        if (!("value" in descriptor)) {
          throw new Error(`metadata array item ${index} must be data-only`);
        }
        copy[index] = cloneValue(
          descriptor.value,
          ancestors,
          depth + 1,
          maxDepth,
        );
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("metadata must not use a custom prototype");
    }
    const copy = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(`metadata field ${key} must be data-only`);
      }
      Object.defineProperty(copy, key, {
        value: cloneValue(
          descriptor.value,
          ancestors,
          depth + 1,
          maxDepth,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

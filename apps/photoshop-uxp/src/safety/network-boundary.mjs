/**
 * Enforce that network/model waits never run inside Photoshop write scopes.
 * Real executeAsModal binding is UNVERIFIED; this module records plan boundaries
 * and tracks active network phases so modal plans cannot overlap them.
 */

/**
 * @typedef {"outside" | "inside_modal"} WriteScope
 */

/**
 * @returns {{
 *   getScope: () => WriteScope,
 *   isNetworkActive: () => boolean,
 *   runOutsideWrites: <T>(fn: () => Promise<T> | T) => Promise<T>,
 *   runInsideWrites: <T>(fn: (ctx: { assertNoNetwork: () => void }) => Promise<T> | T) => Promise<T>,
 *   planModalTransaction: <T>(fn: (ctx: { assertNoNetwork: () => void }) => Promise<T> | T) => Promise<{ planned: true, result: T }>,
 *   assertNetworkAllowed: () => void,
 * }}
 */
export function createWriteScopeGuard() {
  /** @type {WriteScope} */
  let scope = "outside";
  /** Number of concurrent network phases started via runOutsideWrites. */
  let activeNetworkPhases = 0;

  return {
    getScope() {
      return scope;
    },

    isNetworkActive() {
      return activeNetworkPhases > 0;
    },

    assertNetworkAllowed() {
      if (scope === "inside_modal") {
        throw new Error(
          "network waits are forbidden inside a Photoshop write/modal plan",
        );
      }
    },

    /**
     * Run work that may include network waits. Always outside modal scope.
     * Tracks an active network phase so modal entry is rejected until it settles.
     * @template T
     * @param {() => Promise<T> | T} fn
     * @returns {Promise<T>}
     */
    async runOutsideWrites(fn) {
      if (scope !== "outside") {
        throw new Error("nested outside-write scopes are not supported");
      }
      activeNetworkPhases += 1;
      try {
        return await fn();
      } finally {
        activeNetworkPhases -= 1;
      }
    },

    /**
     * Run one bounded Photoshop write transaction. The callback is an adapter
     * boundary; the real host is responsible for executeAsModal/history.
     * @template T
     * @param {(ctx: { assertNoNetwork: () => void }) => Promise<T> | T} fn
     * @returns {Promise<T>}
     */
    async runInsideWrites(fn) {
      if (scope !== "outside") {
        throw new Error("write transaction already active");
      }
      if (activeNetworkPhases > 0) {
        throw new Error(
          "write transaction forbidden while a network wait is active",
        );
      }
      scope = "inside_modal";
      try {
        return await fn({ assertNoNetwork: rejectNetworkInsideWrites });
      } finally {
        scope = "outside";
      }
    },

    /**
     * Plan a single bounded modal transaction. Does not call Photoshop APIs.
     * Network is rejected while the plan callback runs, and while any network
     * phase started via runOutsideWrites is still outstanding.
     * @template T
     * @param {(ctx: { assertNoNetwork: () => void }) => Promise<T> | T} fn
     * @returns {Promise<{ planned: true, result: T }>}
     */
    async planModalTransaction(fn) {
      if (scope !== "outside") {
        throw new Error("modal transaction plan already active");
      }
      if (activeNetworkPhases > 0) {
        throw new Error(
          "modal transaction plan forbidden while a network wait is active",
        );
      }
      scope = "inside_modal";
      try {
        const result = await fn({
          assertNoNetwork: () => {
            // Always reject — this context only exists inside a modal plan.
            throw new Error(
              "network waits are forbidden inside a Photoshop write/modal plan",
            );
          },
        });
        return { planned: true, result };
      } finally {
        scope = "outside";
      }
    },
  };

  function rejectNetworkInsideWrites() {
    throw new Error(
      "network waits are forbidden inside a Photoshop write/modal plan",
    );
  }
}

/**
 * Assert a planned import never schedules network inside its write phase.
 * @param {{ phases: Array<{ name: string, allowsNetwork: boolean }> }} plan
 */
export function assertNetworkOutsideWrites(plan) {
  if (!plan || !Array.isArray(plan.phases)) {
    throw new Error("import plan phases required");
  }
  for (const phase of plan.phases) {
    if (phase.name === "photoshop_write" && phase.allowsNetwork) {
      throw new Error("photoshop_write phase must not allow network");
    }
    if (phase.name === "network_wait" && !phase.allowsNetwork) {
      throw new Error("network_wait phase must allow network");
    }
  }
  return true;
}

/**
 * Panel workflow orchestration for the Mock vertical slice.
 * Extracted so Node tests can exercise Submit / Cancel / Import without a
 * Photoshop DOM. Real Photoshop host calls remain UNVERIFIED.
 */

import { createCinevfxClient } from "../client/http-client.mjs";
import { planProxyExport } from "../proxy/proxy-plan.mjs";
import { planManifestImport } from "../import/import-plan.mjs";
import { validateLayerManifest } from "../manifest/validate-manifest.mjs";
import {
  validateAssetDescriptor,
  validateJobRequestComplete,
} from "../client/contract-shapes.mjs";
import {
  ACTIVE_JOB_STATES,
  FORBIDDEN_SOURCE_OPS,
  SCHEMA_VERSION,
  TASK_STATES,
  TERMINAL_JOB_STATES,
} from "../constants.mjs";
import { digestPlaceholder, makeIdempotencyKey } from "./workflow-ids.mjs";
import { cloneDataOnlyGraph } from "../safety/data-snapshot.mjs";

export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_POLLS = 300;

/**
 * @typedef {{
 *   layerStableId: string,
 *   documentStableId?: string,
 *   bounds?: { x: number, y: number, width: number, height: number },
 * }} ProtectedSourceRef
 */

/**
 * @typedef {{
 *   task: ReturnType<import('../task/task-state.mjs').createTaskController>,
 *   writeGuard: ReturnType<import('../safety/network-boundary.mjs').createWriteScopeGuard>,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   createClient?: (opts: { baseUrl: string, onBeforeNetwork: () => void, timeoutMs?: number, fetchImpl?: typeof fetch }) => ReturnType<typeof createCinevfxClient>,
 *   pollIntervalMs?: number,
 *   maxPolls?: number,
 *   requestTimeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} WorkflowDeps
 */

/**
 * @param {WorkflowDeps} deps
 */
export function createPanelWorkflow(deps) {
  const log = deps.log ?? (() => {});
  const createClient =
    deps.createClient ?? ((opts) => createCinevfxClient(opts));
  const sleep =
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 500 ||
    pollIntervalMs > 10_000
  ) {
    throw new Error("pollIntervalMs must be an integer in [500, 10000]");
  }
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 3_600) {
    throw new Error("maxPolls must be an integer in [1, 3600]");
  }

  /** @type {unknown | null} */
  let lastValidatedManifest = null;
  /** @type {AbortController | null} */
  let activeSubmitAbort = null;
  /** @type {ProtectedSourceRef | null} */
  let lastSubmittedProtectedSource = null;
  /** @type {string | null} */
  let lastSubmittedIdempotencyKey = null;
  let terminalManifestBindingActive = false;
  /** Serializes cancel + submit network phases against the shared write guard. */
  let cancelRequestedDuringSubmit = false;

  /**
   * @param {ProtectedSourceRef} protectedSource
   * @param {{ effectLabel?: string, maxEdge?: number }} [opts]
   */
  function planProxy(protectedSource, opts = {}) {
    const plan = planProxyExport(protectedSource, opts);
    ensurePlannable();
    deps.task.beginProxyPlanning(plan);
    log("Proxy plan created (metadata only)", {
      assets: plan.plannedAssets.length,
    });
    deps.task.finishProxyPlanning();
    return plan;
  }

  function ensurePlannable() {
    const state = deps.task.getSnapshot().state;
    if (state === TASK_STATES.IDLE) return;
    if (
      state === TASK_STATES.SUCCEEDED ||
      state === TASK_STATES.FAILED ||
      state === TASK_STATES.CANCELLED ||
      state === TASK_STATES.IMPORT_PLANNED
    ) {
      deps.task.reset();
      return;
    }
    throw new Error(`cannot plan proxy from state ${state}`);
  }

  function ensureSubmittable() {
    const state = deps.task.getSnapshot().state;
    if (state === TASK_STATES.IDLE) return;
    if (state === TASK_STATES.PLANNING_PROXY) {
      deps.task.finishProxyPlanning();
      return;
    }
    if (
      state === TASK_STATES.FAILED ||
      state === TASK_STATES.CANCELLED ||
      state === TASK_STATES.SUCCEEDED ||
      state === TASK_STATES.IMPORT_PLANNED
    ) {
      deps.task.reset();
      return;
    }
    throw new Error(`cannot submit from state ${state}`);
  }

  /**
   * Fetch, bind, and cache the exact manifest for an observed SUCCEEDED status.
   * @param {ReturnType<typeof createCinevfxClient>} client
   * @param {{ jobId: string, manifestId?: string }} job
   * @param {ProtectedSourceRef} protectedSource
   * @param {{ manifestId: string | null }} observations
   * @param {{ signal: AbortSignal }} callOpts
   */
  async function completeSucceededJob(
    client,
    job,
    protectedSource,
    observations,
    callOpts,
  ) {
    const jobId = job.jobId;
    const expectedManifestId = job.manifestId;
    if (!expectedManifestId) {
      deps.task.markFailed({
        code: "missing_manifest",
        message: "SUCCEEDED job missing manifestId",
      });
      return;
    }
    if (
      observations.manifestId !== null &&
      observations.manifestId !== expectedManifestId
    ) {
      throw createWorkflowError(
        "manifest_observation_conflict",
        `manifest_ready ${observations.manifestId} conflicts with job status ${expectedManifestId}`,
      );
    }
    log("Fetching manifest", { jobId, manifestId: expectedManifestId });
    let manifest;
    terminalManifestBindingActive = true;
    try {
      manifest = await client.getManifest(
        /** @type {any} */ (jobId),
        callOpts,
      );
    } finally {
      terminalManifestBindingActive = false;
    }
    const binding = bindManifestToSucceededJob(manifest, {
      jobId,
      manifestId: String(expectedManifestId),
      protectedSource,
    });
    if (!binding.ok) {
      deps.task.markFailed({ code: binding.code, message: binding.message });
      log("Manifest identity/binding failed", {
        code: binding.code,
        message: binding.message,
      });
      return;
    }
    lastValidatedManifest = binding.manifest;
    deps.task.markSucceeded({ jobId, manifestId: binding.manifestId });
    log("Job succeeded; manifest validated", {
      jobId,
      manifestId: binding.manifestId,
      passes: Array.isArray(
        /** @type {{ passes?: unknown[] }} */ (binding.manifest).passes,
      )
        ? /** @type {{ passes: unknown[] }} */ (binding.manifest).passes.length
        : 0,
    });
  }

  /**
   * Submit assets + job, poll until terminal, fetch/validate manifest on success.
   * Network waits always run outside modal write scope.
   *
   * @param {{
   *   baseUrl: string,
   *   effectLabel: string,
   *   protectedSource: ProtectedSourceRef,
   *   proxyPlan?: ReturnType<typeof planProxyExport>,
   *   assetDescriptors?: import('../client/http-client.d.mts').AssetDescriptor[],
   *   jobRequest?: import('../client/http-client.d.mts').JobRequest,
   * }} input
   */
  async function submitJob(input) {
    // Freeze the complete caller-owned graph before changing task state or
    // yielding. External mutation during a network wait must not retarget work.
    const stableInput = cloneStructuredValue(input);
    if (
      !stableInput ||
      typeof stableInput !== "object" ||
      Array.isArray(stableInput)
    ) {
      throw createWorkflowError(
        "invalid_submit_input",
        "submit input must be an object",
      );
    }
    const safeInput = /** @type {{
     *   baseUrl: unknown,
     *   effectLabel: unknown,
     *   protectedSource: ProtectedSourceRef,
     *   proxyPlan?: ReturnType<typeof planProxyExport>,
     *   assetDescriptors?: import('../client/http-client.d.mts').AssetDescriptor[],
     *   jobRequest?: import('../client/http-client.d.mts').JobRequest,
     * }} */ (stableInput);
    if (typeof safeInput.baseUrl !== "string" || safeInput.baseUrl.length === 0) {
      throw createWorkflowError(
        "invalid_submit_input",
        "baseUrl must be a non-empty string",
      );
    }
    if (
      typeof safeInput.effectLabel !== "string" ||
      safeInput.effectLabel.trim().length === 0 ||
      safeInput.effectLabel.length > 128
    ) {
      throw createWorkflowError(
        "invalid_submit_input",
        "effectLabel must be a non-empty string of at most 128 characters",
      );
    }
    const baseUrl = safeInput.baseUrl;
    const effectLabel = safeInput.effectLabel;
    const protectedSource = /** @type {ProtectedSourceRef} */ (
      safeInput.protectedSource
    );
    const assets = /** @type {import('../client/http-client.d.mts').AssetDescriptor[]} */ (
      safeInput.assetDescriptors ?? buildDefaultAssets(protectedSource, effectLabel)
    );
    const jobRequest = /** @type {import('../client/http-client.d.mts').JobRequest} */ (
      safeInput.jobRequest ??
        buildDefaultJobRequest({
          effectLabel,
          protectedSource,
          assets,
          proxyPlan: safeInput.proxyPlan,
        })
    );
    assertCompleteAssetDescriptors(assets);
    assertCompleteJobRequest(jobRequest);
    assertSubmissionGraph(jobRequest, protectedSource, assets);

    // Client construction is synchronous and network-free. Validate it before
    // replacing a prior terminal result with a new submitting task.
    const client = createClient({
      baseUrl,
      onBeforeNetwork: () => deps.writeGuard.assertNetworkAllowed(),
      timeoutMs: deps.requestTimeoutMs,
    });

    ensureSubmittable();
    lastValidatedManifest = null;
    cancelRequestedDuringSubmit = false;
    terminalManifestBindingActive = false;
    lastSubmittedProtectedSource = { ...protectedSource };
    lastSubmittedIdempotencyKey = null;
    deps.task.beginSubmit({ effectLabel });

    activeSubmitAbort = new AbortController();
    const signal = activeSubmitAbort.signal;

    /** @type {{ signal: AbortSignal }} */
    const callOpts = { signal };
    let jobCreateAttempted = false;
    /** @type {string | null} */
    let lastStatusState = null;
    /** @type {string | null} */
    let lastEventState = null;
    const observations = {
      /** @type {string | null} */ terminalState: null,
      /** @type {string | null} */ manifestId: null,
    };
    const seenEventIds = new Set();

    try {
      await deps.writeGuard.runOutsideWrites(async () => {
        log("Network phase (outside writes)", { endpoint: "POST /v1/assets" });

        /** @type {Array<{ assetId: string, digest: string, purpose: string }>} */
        const registered = [];
        for (const descriptor of assets) {
          if (shouldAbort(signal)) {
            deps.task.markCancelled();
            log("Submit aborted before job create");
            return;
          }
          const created = await client.createAsset(descriptor, callOpts);
          registered.push({
            assetId: created.assetId,
            digest: created.digest,
            purpose: created.purpose,
          });
        }

        // Bind the request again to the server-confirmed asset identities.
        assertSubmissionGraph(jobRequest, protectedSource, registered);

        log("Network phase (outside writes)", { endpoint: "POST /v1/jobs" });
        if (shouldAbort(signal)) {
          deps.task.markCancelled();
          log("Submit aborted before job create");
          return;
        }

        jobCreateAttempted = true;
        const { body: status } = await client.createJob(jobRequest, callOpts);
        assertObservedJobStateMonotonic(lastStatusState, status.state, "job status");
        observeJobStatusIdentity(observations, status, "job creation response");
        lastStatusState = status.state;
        lastSubmittedIdempotencyKey = status.idempotencyKey;
        const jobId = /** @type {string} */ (status.jobId);
        log("Job created", { jobId, state: status.state });

        // Persist confirmed job identity before any terminal manifest wait so
        // cancellation can never misclassify the create outcome as unknown.
        deps.task.markPolling({
          jobId,
          progress: status.progress ?? { ratio: 0.05, stage: "queued" },
        });

        if (status.state === "SUCCEEDED") {
          await completeSucceededJob(
            client,
            status,
            protectedSource,
            observations,
            callOpts,
          );
          return;
        }
        if (status.state === "FAILED") {
          deps.task.markFailed({
            code: status.error?.code ?? "job_failed",
            message: status.error?.message ?? "job failed",
          });
          return;
        }
        if (status.state === "CANCELLED") {
          deps.task.markCancelled();
          return;
        }
        if (status.state === "EXPIRED") {
          deps.task.markFailed({ code: "expired", message: "job expired" });
          return;
        }

        let afterSequence = -1;
        for (let i = 0; i < maxPolls; i += 1) {
          if (shouldAbort(signal)) {
            // Cancellation must not hang on the aborted submit signal.
            await requestCancelAndReconcile(
              client,
              jobId,
              protectedSource,
              status.idempotencyKey,
              observations,
            );
            return;
          }

          const events = await client.listJobEvents(
            /** @type {any} */ (jobId),
            { afterSequence, ...callOpts },
          );
          for (const event of events.events ?? []) {
            if (seenEventIds.has(event.eventId)) {
              throw createWorkflowError(
                "duplicate_event_id",
                `job eventId repeated across pages: ${event.eventId}`,
              );
            }
            seenEventIds.add(event.eventId);
            assertObservedJobStateMonotonic(
              lastEventState,
              event.state,
              "job event stream",
            );
            observations.terminalState = observeTerminalState(
              observations.terminalState,
              event.state,
              "job event stream",
            );
            if (event.type === "manifest_ready") {
              observations.manifestId = observeManifestId(
                observations.manifestId,
                event.manifestId,
                "manifest_ready event",
              );
            }
            lastEventState = event.state;
            afterSequence = advanceEventCursor(afterSequence, event.sequence);
            if (event.progress) {
              deps.task.updateProgress({
                ratio: Number(event.progress.ratio) || 0,
                stage: String(
                  event.progress.stage ?? event.type ?? "progress",
                ),
                message: event.message,
              });
            }
          }

          const job = await client.getJob(/** @type {any} */ (jobId), {
            ...callOpts,
            expectedIdempotencyKey: /** @type {any} */ (status.idempotencyKey),
          });
          assertObservedJobStateMonotonic(
            lastStatusState,
            job.state,
            "job status",
          );
          observeJobStatusIdentity(observations, job, "job status");
          lastStatusState = job.state;
          if (job.progress) {
            deps.task.updateProgress({
              ratio: Number(job.progress.ratio) || 0,
              stage: String(job.progress.stage ?? job.state),
              message: job.progress.message,
            });
          }

          if (job.state === "SUCCEEDED") {
            await completeSucceededJob(
              client,
              job,
              protectedSource,
              observations,
              callOpts,
            );
            return;
          }

          if (job.state === "FAILED") {
            deps.task.markFailed({
              code: job.error?.code ?? "job_failed",
              message: job.error?.message ?? "job failed",
            });
            return;
          }

          if (job.state === "CANCELLED") {
            deps.task.markCancelled();
            return;
          }

          if (job.state === "EXPIRED") {
            deps.task.markFailed({
              code: "expired",
              message: "job expired",
            });
            return;
          }

          await sleep(pollIntervalMs);
        }

        deps.task.markFailed({
          code: "poll_timeout",
          message: "job did not reach a terminal state before poll limit",
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === "object" && "code" in err
          ? String(/** @type {{ code?: unknown }} */ (err).code ?? "submit_error")
          : "submit_error";
      const state = deps.task.getSnapshot().state;
      const integrityFailure = WORKFLOW_INTEGRITY_ERROR_CODES.has(code);
      const aborted =
        !integrityFailure && (code === "aborted" || shouldAbort(signal));
      if (aborted) {
        const snap = deps.task.getSnapshot();
        if (snap.jobId) {
          try {
            await deps.writeGuard.runOutsideWrites(async () => {
              await requestCancelAndReconcile(
                client,
                snap.jobId,
                lastSubmittedProtectedSource,
                lastSubmittedIdempotencyKey,
                observations,
              );
            });
          } catch (cancelErr) {
            const current = deps.task.getSnapshot().state;
            const cancelCode =
              cancelErr && typeof cancelErr === "object" && "code" in cancelErr
                ? String(
                    /** @type {{ code?: unknown }} */ (cancelErr).code ??
                      "cancel_reconcile_failed",
                  )
                : "cancel_reconcile_failed";
            if (WORKFLOW_INTEGRITY_ERROR_CODES.has(cancelCode)) {
              if (
                current === TASK_STATES.SUBMITTING ||
                current === TASK_STATES.POLLING
              ) {
                deps.task.markFailed({
                  code: cancelCode,
                  message:
                    cancelErr instanceof Error
                      ? cancelErr.message
                      : String(cancelErr),
                });
              }
              throw cancelErr;
            }
            if (
              current === TASK_STATES.SUBMITTING ||
              current === TASK_STATES.POLLING
            ) {
              deps.task.markFailed({
                code: "cancel_reconcile_failed",
                message: "cancel could not be confirmed by the server",
              });
            }
            log("Cancel after abort failed", {
              message:
                cancelErr instanceof Error
                  ? cancelErr.message
                  : String(cancelErr),
            });
          }
        } else {
          const current = deps.task.getSnapshot().state;
          if (
            current === TASK_STATES.SUBMITTING ||
            current === TASK_STATES.POLLING
          ) {
            if (jobCreateAttempted) {
              deps.task.markFailed({
                code: "cancel_unconfirmed",
                message: "job creation outcome is unknown after cancellation",
              });
            } else {
              deps.task.markCancelled();
            }
          }
        }
        log("Submit aborted", { message, code });
        return deps.task.getSnapshot();
      }
      if (state === TASK_STATES.SUBMITTING || state === TASK_STATES.POLLING) {
        deps.task.markFailed({ message, code });
      }
      log("Submit failed", { message, code });
      throw err;
    } finally {
      activeSubmitAbort = null;
      cancelRequestedDuringSubmit = false;
      terminalManifestBindingActive = false;
    }

    return deps.task.getSnapshot();
  }

  /**
   * Request cancellation for the active job. Idempotent when repeated.
   * @param {{ baseUrl: string }} input
   */
  async function cancelActiveJob(input) {
    const before = deps.task.getSnapshot();
    if (
      before.state !== TASK_STATES.SUBMITTING &&
      before.state !== TASK_STATES.POLLING
    ) {
      return before;
    }
    if (terminalManifestBindingActive) {
      log("Cancel ignored after server-confirmed success", {
        jobId: before.jobId,
      });
      return before;
    }

    const stableInput = cloneStructuredValue(input);
    if (
      !stableInput ||
      typeof stableInput !== "object" ||
      Array.isArray(stableInput)
    ) {
      throw createWorkflowError(
        "invalid_cancel_input",
        "cancel input must be an object",
      );
    }
    const safeInput = /** @type {{ baseUrl?: unknown }} */ (stableInput);
    if (typeof safeInput.baseUrl !== "string" || safeInput.baseUrl.length === 0) {
      throw createWorkflowError(
        "invalid_cancel_input",
        "baseUrl must be a non-empty string",
      );
    }
    // Constructing the client validates the URL without performing network IO.
    // Do it before setting cancellation state or aborting an active request.
    const client = createClient({
      baseUrl: safeInput.baseUrl,
      onBeforeNetwork: () => deps.writeGuard.assertNetworkAllowed(),
    });

    cancelRequestedDuringSubmit = true;
    deps.task.markCancelRequested();
    if (activeSubmitAbort) activeSubmitAbort.abort();

    const snap = deps.task.getSnapshot();
    if (!snap.jobId) {
      log("Cancel requested (no job id yet; will abort submit if in flight)");
      return deps.task.getSnapshot();
    }
    if (!lastSubmittedIdempotencyKey) {
      deps.task.markFailed({
        code: "missing_job_identity",
        message: "cannot cancel without the submitted idempotency identity",
      });
      return deps.task.getSnapshot();
    }

    // If submit's network phase is still holding the write guard, the submit
    // loop observes cancelRequested and calls cancelJob itself.
    if (deps.writeGuard.isNetworkActive()) {
      log("Cancel requested during active network phase", {
        jobId: snap.jobId,
      });
      return deps.task.getSnapshot();
    }

    await deps.writeGuard.runOutsideWrites(async () => {
      log("Network phase (outside writes)", {
        endpoint: "POST /v1/jobs/{id}/cancel",
        jobId: snap.jobId,
      });
      await requestCancelAndReconcile(
        client,
        snap.jobId,
        lastSubmittedProtectedSource,
        lastSubmittedIdempotencyKey,
      );
    });

    return deps.task.getSnapshot();
  }

  /**
   * Validate a manifest (stashed or fetched) and build a protected-source-safe plan.
   * @param {{
   *   baseUrl: string,
   *   protectedSource: ProtectedSourceRef,
   *   manifest?: unknown,
   * }} input
   */
  async function planImport(input) {
    const snap = deps.task.getSnapshot();
    if (
      snap.state !== TASK_STATES.SUCCEEDED &&
      snap.state !== TASK_STATES.IMPORT_PLANNED
    ) {
      throw new Error(`cannot plan import from state ${snap.state}`);
    }

    let stableInput;
    try {
      stableInput = cloneDataOnlyGraph(input);
      if (
        !stableInput ||
        typeof stableInput !== "object" ||
        Array.isArray(stableInput)
      ) {
        throw new Error("input must be an object");
      }
    } catch (error) {
      const result = {
        ok: false,
        errors: [
          {
            path: "#/input",
            message: `import input must be stable JSON metadata: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        plan: null,
      };
      log("Import planning failed: unstable input", { errorCount: 1 });
      return result;
    }
    const safeInput = /** @type {{ baseUrl: string, protectedSource: ProtectedSourceRef, manifest?: unknown }} */ (
      stableInput
    );
    const client = createClient({
      baseUrl: safeInput.baseUrl,
      onBeforeNetwork: () => deps.writeGuard.assertNetworkAllowed(),
    });

    let manifest = safeInput.manifest ?? lastValidatedManifest;
    if (!manifest) {
      if (!snap.jobId) {
        throw new Error("no jobId available for manifest fetch");
      }
      await deps.writeGuard.runOutsideWrites(async () => {
        log("Network phase (outside writes)", {
          endpoint: "GET /v1/jobs/{id}/manifest",
          jobId: snap.jobId,
        });
        manifest = await client.getManifest(/** @type {any} */ (snap.jobId));
      });
    }

    const expectedIdentity = {
      ...(snap.jobId ? { expectedJobId: snap.jobId } : {}),
      ...(snap.manifestId ? { expectedManifestId: snap.manifestId } : {}),
    };
    const result = planManifestImport(
      manifest,
      safeInput.protectedSource,
      expectedIdentity,
    );
    if (!result.ok || !result.plan) {
      log("Import planning failed", { errorCount: result.errors.length });
      return result;
    }

    // markImportPlanned only from SUCCEEDED; if already IMPORT_PLANNED, keep plan.
    if (deps.task.getSnapshot().state === TASK_STATES.SUCCEEDED) {
      deps.task.markImportPlanned(result.plan);
    }
    log("Import plan ready (execution UNVERIFIED)", {
      passes: result.plan.passes.length,
      history: result.plan.transaction.mode,
    });
    return result;
  }

  function getLastValidatedManifest() {
    return lastValidatedManifest;
  }

  /**
   * A cancel request can race with an immutable terminal state. The server's
   * terminal status wins; SUCCEEDED is accepted only after fetching and binding
   * the exact manifest to the submitted protected source.
   * @param {ReturnType<typeof createCinevfxClient>} client
   * @param {string} jobId
   * @param {ProtectedSourceRef | null} protectedSource
   * @param {string | null} expectedIdempotencyKey
   */
  async function requestCancelAndReconcile(
    client,
    jobId,
    protectedSource,
    expectedIdempotencyKey,
    observations = { terminalState: null, manifestId: null },
  ) {
    if (!expectedIdempotencyKey) {
      throw new Error("expected idempotency identity is required");
    }
    const identityOptions = {
      expectedIdempotencyKey: /** @type {any} */ (expectedIdempotencyKey),
    };
    let status;
    try {
      status = await client.cancelJob(
        /** @type {any} */ (jobId),
        identityOptions,
      );
    } catch (error) {
      const httpStatus =
        error && typeof error === "object" && "status" in error
          ? Number(/** @type {{ status?: unknown }} */ (error).status)
          : 0;
      if (httpStatus !== 409) throw error;
      status = await client.getJob(
        /** @type {any} */ (jobId),
        identityOptions,
      );
    }
    observeJobStatusIdentity(observations, status, "cancel reconciliation");

    const current = deps.task.getSnapshot().state;
    if (status.state === "CANCELLED") {
      if (current === TASK_STATES.SUBMITTING || current === TASK_STATES.POLLING) {
        deps.task.markCancelled();
      }
      log("Cancel reconciled", { jobId, state: status.state });
      return deps.task.getSnapshot();
    }

    if (status.state === "SUCCEEDED") {
      if (!status.manifestId || !protectedSource) {
        if (current === TASK_STATES.SUBMITTING || current === TASK_STATES.POLLING) {
          deps.task.markFailed({
            code: "cancel_race_manifest_missing",
            message: "SUCCEEDED cancel race missing manifest identity or protected source",
          });
        }
        return deps.task.getSnapshot();
      }
      const manifest = await client.getManifest(/** @type {any} */ (jobId));
      const binding = bindManifestToSucceededJob(manifest, {
        jobId,
        manifestId: String(status.manifestId),
        protectedSource,
      });
      if (!binding.ok) {
        if (current === TASK_STATES.SUBMITTING || current === TASK_STATES.POLLING) {
          deps.task.markFailed({ code: binding.code, message: binding.message });
        }
        return deps.task.getSnapshot();
      }
      lastValidatedManifest = binding.manifest;
      if (current === TASK_STATES.SUBMITTING || current === TASK_STATES.POLLING) {
        deps.task.markSucceeded({ jobId, manifestId: binding.manifestId });
      }
      log("Cancel raced with success; manifest validated", {
        jobId,
        manifestId: binding.manifestId,
      });
      return deps.task.getSnapshot();
    }

    if (status.state === "FAILED" || status.state === "EXPIRED") {
      if (current === TASK_STATES.SUBMITTING || current === TASK_STATES.POLLING) {
        deps.task.markFailed({
          code: status.error?.code ?? status.state.toLowerCase(),
          message: status.error?.message ?? `job ended as ${status.state}`,
        });
      }
      return deps.task.getSnapshot();
    }

    if (current === TASK_STATES.SUBMITTING || current === TASK_STATES.POLLING) {
      deps.task.markFailed({
        code: "cancel_not_terminal",
        message: `cancel returned non-terminal state ${String(status.state)}`,
      });
    }
    return deps.task.getSnapshot();
  }

  /**
   * @param {AbortSignal} signal
   */
  function shouldAbort(signal) {
    return (
      signal.aborted ||
      cancelRequestedDuringSubmit ||
      deps.task.getSnapshot().cancelRequested
    );
  }

  return {
    planProxy,
    submitJob,
    cancelActiveJob,
    planImport,
    getLastValidatedManifest,
  };
}

const ACTIVE_JOB_INDEX = new Map(
  ACTIVE_JOB_STATES.map((state, index) => [state, index]),
);

const WORKFLOW_INTEGRITY_ERROR_CODES = new Set([
  "duplicate_event_id",
  "invalid_response",
  "invalid_response_json",
  "job_state_regression",
  "manifest_observation_conflict",
  "response_too_large",
  "submission_graph_mismatch",
  "terminal_observation_conflict",
]);

/**
 * Polling may skip unobserved active states, but an observed stream must never
 * move backward or continue after a terminal state.
 * @param {string | null} previous
 * @param {string} next
 * @param {string} source
 */
function assertObservedJobStateMonotonic(previous, next, source) {
  if (previous === null || previous === next) return;
  const previousTerminal = TERMINAL_JOB_STATES.includes(previous);
  const previousRank = ACTIVE_JOB_INDEX.get(previous);
  const nextRank = ACTIVE_JOB_INDEX.get(next);
  const regressed =
    previousTerminal ||
    (previousRank !== undefined &&
      nextRank !== undefined &&
      nextRank < previousRank);
  if (!regressed) return;

  throw createWorkflowError(
    "job_state_regression",
    `${source} regressed from ${previous} to ${next}`,
  );
}

/**
 * Once either response channel observes a terminal state, every subsequent
 * event/status observation must report that same terminal state.
 * @param {string | null} observed
 * @param {string} next
 * @param {string} source
 * @returns {string | null}
 */
function observeTerminalState(observed, next, source) {
  if (observed !== null && next !== observed) {
    throw createWorkflowError(
      "terminal_observation_conflict",
      `${source} reported ${next} after terminal ${observed}`,
    );
  }
  return TERMINAL_JOB_STATES.includes(next) ? next : observed;
}

/**
 * Bind every successful status response to one manifest identity, including a
 * terminal response returned directly by createJob or cancelJob.
 * @param {{ terminalState: string | null, manifestId: string | null }} observations
 * @param {{ state: string, manifestId?: unknown }} status
 * @param {string} source
 */
function observeJobStatusIdentity(observations, status, source) {
  observations.terminalState = observeTerminalState(
    observations.terminalState,
    status.state,
    source,
  );
  if (status.state === "SUCCEEDED") {
    observations.manifestId = observeManifestId(
      observations.manifestId,
      status.manifestId,
      source,
    );
  }
}

/**
 * @param {string | null} observed
 * @param {unknown} next
 * @param {string} source
 * @returns {string}
 */
function observeManifestId(observed, next, source) {
  if (typeof next !== "string" || next.length === 0) {
    throw createWorkflowError(
      "manifest_observation_conflict",
      `${source} reported SUCCEEDED without a manifestId`,
    );
  }
  if (observed !== null && observed !== next) {
    throw createWorkflowError(
      "manifest_observation_conflict",
      `${source} changed manifestId from ${observed} to ${next}`,
    );
  }
  return next;
}

/**
 * @param {string} code
 * @param {string} message
 */
function createWorkflowError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Run the same frozen semantic validator as createJob before registering any
 * assets, so an invalid job cannot leave partial server-side metadata behind.
 * @param {unknown} jobRequest
 */
function assertCompleteJobRequest(jobRequest) {
  const validation = validateJobRequestComplete(jobRequest);
  if (validation.valid) return;
  throw createWorkflowError(
    "invalid_job_request",
    `invalid job request: ${validation.errors[0]?.message ?? "shape"}`,
  );
}

/**
 * Validate the full asset batch before registering its first member.
 * @param {unknown[]} assets
 */
function assertCompleteAssetDescriptors(assets) {
  for (const asset of assets) {
    const validation = validateAssetDescriptor(asset);
    if (validation.valid) continue;
    throw createWorkflowError(
      "invalid_asset_descriptor",
      `invalid asset descriptor: ${validation.errors[0]?.message ?? "shape"}`,
    );
  }
}

/**
 * Keep the panel source, uploaded assets, and job payload in one immutable
 * identity graph. Ordering is irrelevant; duplicate/missing entries are not.
 * @param {unknown} jobRequest
 * @param {ProtectedSourceRef} protectedSource
 * @param {Array<{ assetId?: unknown, digest?: unknown, purpose?: unknown }>} assets
 */
function assertSubmissionGraph(jobRequest, protectedSource, assets) {
  const request =
    jobRequest && typeof jobRequest === "object"
      ? /** @type {Record<string, unknown>} */ (jobRequest)
      : null;
  const requestSource =
    request?.protectedSource && typeof request.protectedSource === "object"
      ? /** @type {Record<string, unknown>} */ (request.protectedSource)
      : null;
  const sameSource =
    requestSource?.layerStableId === protectedSource.layerStableId &&
    requestSource?.documentStableId === protectedSource.documentStableId;
  if (!sameSource) {
    throw createWorkflowError(
      "submission_graph_mismatch",
      "job protectedSource does not match the panel protected source",
    );
  }

  const requestedAssets = Array.isArray(request?.inputAssets)
    ? request.inputAssets
    : [];
  const expected = canonicalAssetIdentities(assets);
  const requested = canonicalAssetIdentities(requestedAssets);
  if (expected === null || requested === null || expected !== requested) {
    throw createWorkflowError(
      "submission_graph_mismatch",
      "job inputAssets do not exactly match the submitted asset descriptors",
    );
  }
}

/**
 * @param {unknown[]} values
 * @returns {string | null}
 */
function canonicalAssetIdentities(values) {
  const identities = [];
  for (const value of values) {
    if (!value || typeof value !== "object") return null;
    const asset = /** @type {Record<string, unknown>} */ (value);
    if (
      typeof asset.assetId !== "string" ||
      typeof asset.digest !== "string" ||
      typeof asset.purpose !== "string"
    ) {
      return null;
    }
    identities.push(
      JSON.stringify([asset.assetId, asset.digest, asset.purpose]),
    );
  }
  identities.sort();
  return JSON.stringify(identities);
}

/**
 * Clone JSON-like submission metadata without relying on structuredClone,
 * which is not guaranteed in every Photoshop UXP runtime.
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneStructuredValue(value) {
  try {
    return cloneDataOnlyGraph(value);
  } catch (error) {
    throw createWorkflowError(
      "invalid_structured_input",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * @param {ProtectedSourceRef} protectedSource
 * @param {string} effectLabel
 */
function buildDefaultAssets(protectedSource, effectLabel) {
  const now = "2026-08-12T10:00:00Z";
  const dims = {
    width: Math.max(1, Math.round(protectedSource.bounds?.width ?? 1024)),
    height: Math.max(1, Math.round(protectedSource.bounds?.height ?? 1024)),
  };
  void effectLabel;
  return [
    {
      schemaVersion: SCHEMA_VERSION,
      assetId: "asset_proxy_source_01",
      mediaType: "image/png",
      dimensions: dims,
      digest: digestPlaceholder("1"),
      alphaMode: "straight",
      byteLength: 1024,
      ttlSeconds: 3600,
      purpose: "proxy",
      createdAt: now,
      colorSpace: "srgb",
      sourceRole: "user_proxy",
    },
    {
      schemaVersion: SCHEMA_VERSION,
      assetId: "asset_subject_mask_01",
      mediaType: "image/png",
      dimensions: dims,
      digest: digestPlaceholder("3"),
      alphaMode: "straight",
      byteLength: 512,
      ttlSeconds: 3600,
      purpose: "mask",
      createdAt: now,
      colorSpace: "srgb",
      sourceRole: "user_mask",
    },
    {
      schemaVersion: SCHEMA_VERSION,
      assetId: "asset_effect_ref_01",
      mediaType: "image/png",
      dimensions: dims,
      digest: digestPlaceholder("a"),
      alphaMode: "straight",
      byteLength: 768,
      ttlSeconds: 3600,
      purpose: "effect_reference",
      createdAt: now,
      colorSpace: "srgb",
      sourceRole: "user_effect_reference",
    },
  ];
}

/**
 * @param {{
 *   effectLabel: string,
 *   protectedSource: ProtectedSourceRef,
 *   assets: Array<{ assetId: string, digest: string, purpose: string }>,
 *   proxyPlan?: { canvas?: { width: number, height: number, colorSpace?: string }, seed?: number },
 * }} input
 */
function buildDefaultJobRequest(input) {
  const canvas = input.proxyPlan?.canvas ?? {
    width: 1024,
    height: 1024,
    colorSpace: "srgb",
    pixelAspectRatio: 1,
    normalized: true,
  };
  const proxy =
    input.assets.find((a) => a.purpose === "proxy") ?? input.assets[0];
  const mask = input.assets.find((a) => a.purpose === "mask");
  const effectRef = input.assets.find((a) => a.purpose === "effect_reference");

  return {
    schemaVersion: SCHEMA_VERSION,
    idempotencyKey: makeIdempotencyKey(),
    clientRequestId: "uxp_panel_req_local",
    effectSpec: {
      schemaVersion: SCHEMA_VERSION,
      effectSpecVersion: "1.0.0",
      seed: Number.isInteger(input.proxyPlan?.seed) ? input.proxyPlan.seed : 42,
      label: input.effectLabel,
      canvas: {
        width: canvas.width,
        height: canvas.height,
        colorSpace: canvas.colorSpace ?? "srgb",
        pixelAspectRatio: 1,
        normalized: true,
      },
      references: [
        {
          id: "effect_ref",
          assetId: effectRef?.assetId ?? proxy.assetId,
          role: "effect",
          digest: effectRef?.digest ?? proxy.digest,
          weight: 1,
        },
      ],
      guidance: {
        anchors: [
          {
            id: "anchor_center",
            point: { x: 0.5, y: 0.5 },
            radius: 0.2,
          },
        ],
        strength: 0.7,
        subjectMaskAssetId: mask?.assetId,
      },
      primitives: [
        {
          id: "spark_curve",
          kind: "curve",
          enabled: true,
          params: { intensity: 0.8, thickness: 0.03 },
        },
      ],
    },
    inputAssets: input.assets.map((a) => ({
      assetId: a.assetId,
      digest: a.digest,
      purpose: a.purpose,
    })),
    protectedSource: {
      layerStableId: input.protectedSource.layerStableId,
      ...(input.protectedSource.documentStableId !== undefined
        ? { documentStableId: input.protectedSource.documentStableId }
        : {}),
      immutable: true,
      operationsForbidden: [...FORBIDDEN_SOURCE_OPS],
    },
    options: {
      priority: "normal",
      dryRun: false,
      ttlSeconds: 1800,
    },
  };
}


/**
 * Advance the event polling cursor. Sequence 0 is contract-valid and must not
 * fall back via `||` (which would leave the cursor stuck at -1).
 * @param {number} afterSequence
 * @param {unknown} sequence
 */
export function advanceEventCursor(afterSequence, sequence) {
  const n = Number(sequence);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return afterSequence;
  }
  return Math.max(afterSequence, n);
}

/**
 * Bind a fetched Layer Manifest to the succeeded JobStatus and submitted
 * protected source before caching or marking success.
 *
 * @param {unknown} manifest
 * @param {{
 *   jobId: string,
 *   manifestId: string,
 *   protectedSource: ProtectedSourceRef,
 * }} expected
 * @returns {{
 *   ok: true,
 *   manifest: unknown,
 *   manifestId: string,
 * } | {
 *   ok: false,
 *   code: string,
 *   message: string,
 * }}
 */
export function bindManifestToSucceededJob(manifest, expected) {
  const validation = validateLayerManifest(manifest);
  if (!validation.valid) {
    return {
      ok: false,
      code: "invalid_manifest",
      message: validation.errors[0]?.message ?? "manifest invalid",
    };
  }

  const m = /** @type {Record<string, unknown>} */ (manifest);
  if (m.jobId !== expected.jobId) {
    return {
      ok: false,
      code: "manifest_job_mismatch",
      message: `manifest jobId ${String(m.jobId)} does not match job ${expected.jobId}`,
    };
  }
  if (m.manifestId !== expected.manifestId) {
    return {
      ok: false,
      code: "manifest_id_mismatch",
      message: `manifest manifestId ${String(m.manifestId)} does not match job.manifestId ${expected.manifestId}`,
    };
  }

  const protectedSource =
    m.protectedSource && typeof m.protectedSource === "object"
      ? /** @type {Record<string, unknown>} */ (m.protectedSource)
      : null;
  if (!protectedSource) {
    return {
      ok: false,
      code: "manifest_protected_source_missing",
      message: "manifest missing protectedSource",
    };
  }
  if (protectedSource.layerStableId !== expected.protectedSource.layerStableId) {
    return {
      ok: false,
      code: "manifest_protected_source_mismatch",
      message:
        "manifest protectedSource does not match the submitted protected source",
    };
  }
  if (
    protectedSource.documentStableId !==
    expected.protectedSource.documentStableId
  ) {
    return {
      ok: false,
      code: "manifest_document_mismatch",
      message: "manifest documentStableId does not match submitted source",
    };
  }

  return {
    ok: true,
    manifest,
    manifestId: String(m.manifestId),
  };
}

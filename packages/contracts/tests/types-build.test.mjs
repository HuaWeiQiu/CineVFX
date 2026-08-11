import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertJobEventSchemaCoverage,
  assertJobStatusSchemaCoverage,
  buildGeneratedTypesText,
  deriveJobEventBranches,
  deriveJobStatusBranches,
  generateTypesArtifacts,
  JOB_EVENT_PAYLOAD_FIELDS,
  renderJobEventUnion,
  renderJobStatusUnion,
} from "../scripts/generate-types.mjs";
import { validateJobEventSemantics } from "../src/job-event.mjs";
import { validateAgainstSchema } from "../src/validate-json-schema.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadSchema(name) {
  return JSON.parse(await readFile(path.join(packageRoot, "schemas", name), "utf8"));
}

function extractArm(typesText, typeName, discriminatorValue) {
  const marker =
    typeName === "JobStatus"
      ? `state: ${JSON.stringify(discriminatorValue)};`
      : `type: ${JSON.stringify(discriminatorValue)};`;
  const start = typesText.indexOf(marker);
  assert.ok(start >= 0, `missing arm for ${typeName} ${discriminatorValue}`);
  // Walk backward to the arm start `| {` or `| (JobStatusBase`.
  const armStart = typesText.lastIndexOf("|", start);
  assert.ok(armStart >= 0);
  // Stop at this arm's own closing line so later declarations cannot satisfy
  // payload assertions accidentally.
  const rest = typesText.slice(armStart);
  const closing = typeName === "JobStatus" ? "\n    })" : "\n    }";
  const end = rest.indexOf(closing);
  assert.ok(end >= 0, `unterminated arm for ${typeName} ${discriminatorValue}`);
  return rest.slice(0, end + closing.length);
}

test("generated declarations match schema-derived output with writes disabled", async () => {
  const typesPath = path.join(packageRoot, "generated/types.d.ts");
  await access(typesPath);
  const committed = await readFile(typesPath, "utf8");
  const derived = await buildGeneratedTypesText();
  assert.equal(committed, derived);

  const artifacts = await generateTypesArtifacts({ write: false });
  assert.equal(artifacts.wrote, false);
  assert.equal(artifacts.typesText, committed);

  for (const name of [
    "EffectSpec",
    "AssetDescriptor",
    "JobRequest",
    "LayerManifest",
  ]) {
    assert.match(derived, new RegExp(`export interface ${name}`));
  }
  assert.match(derived, /export type JobStatus =/);
  assert.match(derived, /export type JobEvent =/);
  assert.match(derived, /state: "SUCCEEDED";[\s\S]*manifestId: ManifestId;/);
  assert.match(derived, /type: "manifest_ready";[\s\S]*state: "SUCCEEDED";/);
  assert.match(derived, /export type JobState/);
  assert.match(derived, /CREATED/);
  assert.match(derived, /SUCCEEDED/);
  assert.match(derived, /JobStatusBranches=\d+/);
  assert.match(derived, /JobEventBranches=\d+/);
});

test("generator loads job-status schema and covers every JobState branch", async () => {
  const common = await loadSchema("common.schema.json");
  const jobStatus = await loadSchema("job-status.schema.json");
  const jobStates = common.$defs.JobState.enum;
  const activeStates = common.$defs.ActiveJobState.enum;
  const branches = deriveJobStatusBranches(jobStatus, jobStates, activeStates);
  assert.equal(branches.length, jobStates.length);
  assert.deepEqual(
    branches.map((branch) => branch.state).sort(),
    [...jobStates].sort(),
  );
  // Read-only coverage helper agrees with derivation.
  assert.equal(
    assertJobStatusSchemaCoverage(jobStatus, jobStates, activeStates).length,
    jobStates.length,
  );

  // Render is schema-authoritative: every JobState appears in the union text.
  const rendered = renderJobStatusUnion(branches, jobStates, activeStates);
  for (const state of jobStates) {
    if (state === "CREATED") {
      assert.match(rendered, /state: "CREATED";/);
    } else if (activeStates.includes(state)) {
      // Non-CREATED actives may be grouped as Exclude<ActiveJobState, "CREATED">.
      assert.match(
        rendered,
        /Exclude<ActiveJobState, "CREATED">|state: "VALIDATING"/,
      );
    } else {
      assert.match(rendered, new RegExp(`state: "${state}";`));
    }
  }
});

test("generator covers every JobEvent type/state/payload variant from schema", async () => {
  const common = await loadSchema("common.schema.json");
  const jobEvent = await loadSchema("job-event.schema.json");
  const jobStates = common.$defs.JobState.enum;
  const activeStates = common.$defs.ActiveJobState.enum;
  const eventTypes = jobEvent.properties.type.enum;
  const branches = deriveJobEventBranches(
    jobEvent,
    eventTypes,
    jobStates,
    activeStates,
  );
  assert.equal(branches.length, eventTypes.length);
  assert.deepEqual(
    branches.map((branch) => branch.type),
    eventTypes,
  );

  const stateChanged = branches.find((branch) => branch.type === "state_changed");
  assert.ok(stateChanged);
  for (const field of ["progress", "error", "assetRef", "manifestId"]) {
    assert.equal(
      stateChanged.payloads[field],
      "forbidden",
      `state_changed must forbid ${field}`,
    );
  }
  assert.equal(
    stateChanged.payloads.message,
    "optional",
    "state_changed must continue permitting message",
  );

  const derived = await buildGeneratedTypesText();
  // Generated state_changed arm must permit message and prohibit irrelevant payloads.
  assert.match(
    derived,
    /type: "state_changed";[\s\S]*?message\?: string;[\s\S]*?progress\?: never;[\s\S]*?error\?: never;[\s\S]*?assetRef\?: never;[\s\S]*?manifestId\?: never;/,
  );

  // Exhaustive schema/type agreement for every event arm payload field.
  for (const branch of branches) {
    const arm = extractArm(derived, "JobEvent", branch.type);
    for (const field of JOB_EVENT_PAYLOAD_FIELDS) {
      const presence = branch.payloads[field];
      if (presence === "required") {
        assert.match(
          arm,
          new RegExp(`${field}: `),
          `${branch.type} must require ${field}`,
        );
        assert.doesNotMatch(
          arm,
          new RegExp(`${field}\\?: never`),
          `${branch.type} must not mark required ${field} as never`,
        );
      } else if (presence === "optional") {
        assert.match(
          arm,
          new RegExp(`${field}\\?: (?!never)`),
          `${branch.type} must permit optional ${field}`,
        );
      } else if (presence === "forbidden") {
        assert.match(
          arm,
          new RegExp(`${field}\\?: never;`),
          `${branch.type} must mark ${field} as never`,
        );
      } else {
        assert.fail(`unexpected presence ${presence} for ${branch.type}.${field}`);
      }
    }
  }
});

test("schema enum or branch drift fails generation fail-closed", async () => {
  const common = await loadSchema("common.schema.json");
  const jobStatus = await loadSchema("job-status.schema.json");
  const jobEvent = await loadSchema("job-event.schema.json");
  const jobStates = common.$defs.JobState.enum;
  const activeStates = common.$defs.ActiveJobState.enum;
  const eventTypes = jobEvent.properties.type.enum;

  // Drop SUCCEEDED status branch.
  const statusMissingSucceeded = structuredClone(jobStatus);
  statusMissingSucceeded.allOf = statusMissingSucceeded.allOf.filter(
    (rule) => rule.if?.properties?.state?.const !== "SUCCEEDED",
  );
  assert.throws(
    () => deriveJobStatusBranches(statusMissingSucceeded, jobStates, activeStates),
    /missing branches for states: SUCCEEDED|SUCCEEDED branch/,
  );

  // Inject unknown status state.
  const statusExtra = structuredClone(jobStatus);
  statusExtra.allOf.push({
    if: { properties: { state: { const: "BOGUS" } }, required: ["state"] },
    then: { required: ["finishedAt"] },
  });
  assert.throws(
    () => deriveJobStatusBranches(statusExtra, jobStates, activeStates),
    /unknown state branches: BOGUS/,
  );

  // Unhandled required field on SUCCEEDED must fail closed (not silent).
  const statusStartedAtRequired = structuredClone(jobStatus);
  const succeededRule = statusStartedAtRequired.allOf.find(
    (rule) => rule.if?.properties?.state?.const === "SUCCEEDED",
  );
  succeededRule.then.required = [...(succeededRule.then.required ?? []), "startedAt"];
  assert.throws(
    () => deriveJobStatusBranches(statusStartedAtRequired, jobStates, activeStates),
    /unhandled required fields: startedAt/,
  );

  // Unhandled constrained property must fail closed.
  const statusStartedAtConst = structuredClone(jobStatus);
  const succeededConstRule = statusStartedAtConst.allOf.find(
    (rule) => rule.if?.properties?.state?.const === "SUCCEEDED",
  );
  succeededConstRule.then.properties = {
    ...(succeededConstRule.then.properties ?? {}),
    startedAt: { const: "2026-01-01T00:00:00Z" },
  };
  assert.throws(
    () => deriveJobStatusBranches(statusStartedAtConst, jobStates, activeStates),
    /unsupported keys: startedAt|unhandled constrained property: startedAt/,
  );

  // Root JobStatus state reference drift must fail closed.
  const statusRootStateDrift = structuredClone(jobStatus);
  statusRootStateDrift.properties.state.$ref =
    "common.schema.json#/$defs/ActiveJobState";
  assert.throws(
    () => deriveJobStatusBranches(statusRootStateDrift, jobStates, activeStates),
    /job-status\.properties\.state does not match the supported frozen contract shape/,
  );

  const statusRootStateSibling = structuredClone(jobStatus);
  statusRootStateSibling.properties.state.not = { const: "FAILED" };
  assert.throws(
    () => deriveJobStatusBranches(statusRootStateSibling, jobStates, activeStates),
    /job-status\.properties\.state does not match the supported frozen contract shape/,
  );

  const statusRequiredDrift = structuredClone(jobStatus);
  statusRequiredDrift.required.push("startedAt");
  assert.throws(
    () => deriveJobStatusBranches(statusRequiredDrift, jobStates, activeStates),
    /job-status root required fields/,
  );

  const statusAdditionalPropertiesDrift = structuredClone(jobStatus);
  statusAdditionalPropertiesDrift.additionalProperties = true;
  assert.throws(
    () =>
      deriveJobStatusBranches(
        statusAdditionalPropertiesDrift,
        jobStates,
        activeStates,
      ),
    /job-status additionalProperties/,
  );

  const statusRootConstraintDrift = structuredClone(jobStatus);
  statusRootConstraintDrift.not = { required: ["startedAt"] };
  assert.throws(
    () =>
      deriveJobStatusBranches(statusRootConstraintDrift, jobStates, activeStates),
    /job-status root has unsupported keys: not/,
  );

  const statusPatternPropertiesDrift = structuredClone(jobStatus);
  statusPatternPropertiesDrift.patternProperties = {
    "^x-": { type: "string" },
  };
  assert.throws(
    () =>
      deriveJobStatusBranches(statusPatternPropertiesDrift, jobStates, activeStates),
    /job-status root has unsupported keys: patternProperties/,
  );

  const statusJobIdDrift = structuredClone(jobStatus);
  statusJobIdDrift.properties.jobId = { type: "number" };
  assert.throws(
    () => deriveJobStatusBranches(statusJobIdDrift, jobStates, activeStates),
    /job-status root properties/,
  );

  const statusProgressRootDrift = structuredClone(jobStatus);
  statusProgressRootDrift.properties.progress.properties.stage.type = "integer";
  assert.throws(
    () =>
      deriveJobStatusBranches(statusProgressRootDrift, jobStates, activeStates),
    /job-status root properties/,
  );

  const statusDiscriminatorSibling = structuredClone(jobStatus);
  statusDiscriminatorSibling.allOf[0].if.allOf = [];
  assert.throws(
    () =>
      deriveJobStatusBranches(statusDiscriminatorSibling, jobStates, activeStates),
    /JobStatus CREATED discriminator/,
  );

  const statusCancelSibling = structuredClone(jobStatus);
  statusCancelSibling.allOf[0].then.properties.cancelRequested.type = "boolean";
  assert.throws(
    () => deriveJobStatusBranches(statusCancelSibling, jobStates, activeStates),
    /JobStatus CREATED/,
  );

  const statusProgressSibling = structuredClone(jobStatus);
  statusProgressSibling.allOf[0].then.properties.progress.properties.stage = {
    const: "invented",
  };
  assert.throws(
    () => deriveJobStatusBranches(statusProgressSibling, jobStates, activeStates),
    /JobStatus CREATED/,
  );

  // Frozen active-state constraints reject representable-looking drift too.
  const activeCancelDrift = structuredClone(jobStatus);
  const activeRule = activeCancelDrift.allOf.find((rule) =>
    Array.isArray(rule.if?.properties?.state?.enum),
  );
  activeRule.then.properties = {
    ...(activeRule.then.properties ?? {}),
    cancelRequested: { const: false },
  };
  assert.throws(
    () => deriveJobStatusBranches(activeCancelDrift, jobStates, activeStates),
    /supported frozen contract shape/,
  );

  // Incomplete ARCHIVED branch with unhandled required fields must fail closed.
  const archivedStates = [...jobStates, "ARCHIVED"];
  const archivedActive = [...activeStates];
  const statusArchivedUnhandled = structuredClone(jobStatus);
  statusArchivedUnhandled.allOf.push({
    if: { properties: { state: { const: "ARCHIVED" } }, required: ["state"] },
    then: {
      required: ["finishedAt", "startedAt"],
      properties: { cancelRequested: { const: false } },
      not: {
        anyOf: [{ required: ["manifestId"] }, { required: ["error"] }],
      },
    },
  });
  assert.throws(
    () =>
      deriveJobStatusBranches(
        statusArchivedUnhandled,
        archivedStates,
        archivedActive,
      ),
    /unsupported JobState enum drift/,
  );

  // The Mock contract is frozen; even coordinated new enum members require an
  // explicit generator update rather than silently widening declarations.
  const statusArchived = structuredClone(jobStatus);
  statusArchived.allOf.push({
    if: { properties: { state: { const: "ARCHIVED" } }, required: ["state"] },
    then: {
      required: ["finishedAt"],
      properties: { cancelRequested: { const: false } },
      not: {
        anyOf: [{ required: ["manifestId"] }, { required: ["error"] }],
      },
    },
  });
  assert.throws(
    () => deriveJobStatusBranches(statusArchived, archivedStates, archivedActive),
    /unsupported JobState enum drift/,
  );

  // Removing EXPORTING from ActiveJobState while it remains a status branch must fail.
  const activeMissingExporting = activeStates.filter((state) => state !== "EXPORTING");
  assert.throws(
    () => deriveJobStatusBranches(jobStatus, jobStates, activeMissingExporting),
    /ActiveJobState enum drift/,
  );

  // Drop state_changed event branch.
  const eventMissing = structuredClone(jobEvent);
  eventMissing.allOf = eventMissing.allOf.filter(
    (rule) => rule.if?.properties?.type?.const !== "state_changed",
  );
  assert.throws(
    () =>
      deriveJobEventBranches(eventMissing, eventTypes, jobStates, activeStates),
    /missing branches for types: state_changed/,
  );

  // Remove progress from state_changed forbidden list.
  const eventWeakStateChanged = structuredClone(jobEvent);
  const sc = eventWeakStateChanged.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "state_changed",
  );
  sc.then.not.anyOf = sc.then.not.anyOf.filter(
    (clause) => !(clause.required && clause.required.includes("progress")),
  );
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventWeakStateChanged,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /state_changed payload progress must be forbidden/,
  );

  // Forbidding message on state_changed must fail closed (message remains optional).
  const eventForbidMessage = structuredClone(jobEvent);
  const scMessage = eventForbidMessage.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "state_changed",
  );
  scMessage.then.not.anyOf.push({ required: ["message"] });
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventForbidMessage,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /state_changed payload message must be optional/,
  );

  // Contradictory required+forbidden progress on progress branch must fail closed.
  const eventProgressConflict = structuredClone(jobEvent);
  const progressRule = eventProgressConflict.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "progress",
  );
  progressRule.then.not = {
    anyOf: [
      ...(progressRule.then.not?.anyOf ?? []),
      { required: ["progress"] },
    ],
  };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventProgressConflict,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /contradictory required and forbidden fields: progress|cannot be both required and forbidden/,
  );

  // Root JobEvent state reference drift must fail closed.
  const eventRootStateDrift = structuredClone(jobEvent);
  eventRootStateDrift.properties.state.$ref =
    "common.schema.json#/$defs/ActiveJobState";
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventRootStateDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event\.properties\.state does not match the supported frozen contract shape/,
  );

  const eventRootStateSibling = structuredClone(jobEvent);
  eventRootStateSibling.properties.state.not = { const: "FAILED" };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventRootStateSibling,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event\.properties\.state does not match the supported frozen contract shape/,
  );

  const eventRootRequiredDrift = structuredClone(jobEvent);
  eventRootRequiredDrift.required.push("message");
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventRootRequiredDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root required fields/,
  );

  const eventAdditionalPropertiesDrift = structuredClone(jobEvent);
  eventAdditionalPropertiesDrift.additionalProperties = true;
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventAdditionalPropertiesDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event additionalProperties/,
  );

  const eventRootConstraintDrift = structuredClone(jobEvent);
  eventRootConstraintDrift.not = { required: ["message"] };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventRootConstraintDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root has unsupported keys: not/,
  );

  const eventPatternPropertiesDrift = structuredClone(jobEvent);
  eventPatternPropertiesDrift.patternProperties = {
    "^x-": { type: "string" },
  };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventPatternPropertiesDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root has unsupported keys: patternProperties/,
  );

  const eventSequenceDrift = structuredClone(jobEvent);
  eventSequenceDrift.properties.sequence.type = "string";
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventSequenceDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root properties/,
  );

  const eventTimestampDrift = structuredClone(jobEvent);
  eventTimestampDrift.properties.timestamp = { type: "number" };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventTimestampDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root properties/,
  );

  const eventUnknownRootPayload = structuredClone(jobEvent);
  eventUnknownRootPayload.properties.unknownPayload = { type: "string" };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventUnknownRootPayload,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root property fields/,
  );

  const eventProgressShapeDrift = structuredClone(jobEvent);
  eventProgressShapeDrift.properties.progress.properties.stage.const = "invented";
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventProgressShapeDrift,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event root payload progress/,
  );

  const eventStateConstraintSibling = structuredClone(jobEvent);
  const eventProgressState = eventStateConstraintSibling.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "progress",
  );
  eventProgressState.then.properties.state.not = { const: "CREATED" };
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventStateConstraintSibling,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /job-event progress state constraint/,
  );

  const eventUnknownRequired = structuredClone(jobEvent);
  const eventErrorRequired = eventUnknownRequired.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "error",
  );
  eventErrorRequired.then.required.push("unknownPayload");
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventUnknownRequired,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /unsupported required fields: unknownPayload/,
  );

  const eventUnknownForbidden = structuredClone(jobEvent);
  const eventErrorForbidden = eventUnknownForbidden.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "error",
  );
  eventErrorForbidden.then.not.anyOf.push({ required: ["timestamp"] });
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventUnknownForbidden,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /unsupported forbidden fields: timestamp/,
  );

  const eventCompoundForbidden = structuredClone(jobEvent);
  const eventStateChangedCompound = eventCompoundForbidden.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "state_changed",
  );
  eventStateChangedCompound.then.not.anyOf[0].required = ["progress", "error"];
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventCompoundForbidden,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /compound prohibitions are unsupported/,
  );

  // Allowing progress on asset_ready must fail closed (schema/type parity).
  const eventAssetProgress = structuredClone(jobEvent);
  const assetReady = eventAssetProgress.allOf.find(
    (rule) => rule.if?.properties?.type?.const === "asset_ready",
  );
  assetReady.then.not.anyOf = assetReady.then.not.anyOf.filter(
    (clause) => !(clause.required && clause.required.includes("progress")),
  );
  assert.throws(
    () =>
      deriveJobEventBranches(
        eventAssetProgress,
        eventTypes,
        jobStates,
        activeStates,
      ),
    /asset_ready payload progress must be forbidden/,
  );

  // Perturb event type enum without matching branch.
  assert.throws(
    () =>
      deriveJobEventBranches(
        jobEvent,
        [...eventTypes, "invented_event"],
        jobStates,
        activeStates,
      ),
    /type enum drift|missing branches for types: invented_event/,
  );

  // Render must not invent never-fields beyond schema forbidden sets.
  const healthyBranches = deriveJobEventBranches(
    jobEvent,
    eventTypes,
    jobStates,
    activeStates,
  );
  const eventUnion = renderJobEventUnion(healthyBranches);
  for (const branch of healthyBranches) {
    assert.match(eventUnion, new RegExp(`type: "${branch.type}";`));
  }
});

test("invalid JobStatus and JobEvent combinations are rejected by schema", async () => {
  const succeededWithoutManifest = {
    schemaVersion: "1.0.0",
    jobId: "job_mock_bad",
    idempotencyKey: "idem_mock_bad_key_01",
    state: "SUCCEEDED",
    progress: { ratio: 1, stage: "done" },
    createdAt: "2026-08-12T10:00:00Z",
    updatedAt: "2026-08-12T10:00:01Z",
    finishedAt: "2026-08-12T10:00:01Z",
    cancelRequested: false,
  };
  const statusResult = await validateAgainstSchema(
    succeededWithoutManifest,
    "job-status.schema.json",
  );
  assert.equal(statusResult.valid, false);

  const createdWithManifest = {
    ...succeededWithoutManifest,
    state: "CREATED",
    progress: { ratio: 0, stage: "created" },
    manifestId: "manifest_mock_0001",
    finishedAt: undefined,
  };
  delete createdWithManifest.finishedAt;
  const createdResult = await validateAgainstSchema(
    createdWithManifest,
    "job-status.schema.json",
  );
  assert.equal(createdResult.valid, false);

  const prohibited = [
    "job-event.state-changed-with-progress.json",
    "job-event.state-changed-with-error.json",
    "job-event.state-changed-with-asset-ref.json",
    "job-event.state-changed-with-manifest-id.json",
  ];
  for (const fileName of prohibited) {
    const data = JSON.parse(
      await readFile(path.join(packageRoot, "examples/invalid", fileName), "utf8"),
    );
    const result = await validateAgainstSchema(data, "job-event.schema.json");
    assert.equal(result.valid, false, `${fileName} must be rejected`);
  }

  // Non-progress events with progress payload are rejected by schema.
  const assetReadyWithProgress = {
    schemaVersion: "1.0.0",
    eventId: "evt_job_mock_bad_asset_progress",
    jobId: "job_mock_bad",
    sequence: 2,
    type: "asset_ready",
    state: "RENDERING",
    timestamp: "2026-08-12T10:00:02Z",
    assetRef: {
      assetId: "asset_pass_effect_01",
      digest:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    },
    progress: { ratio: 0.5, stage: "render" },
  };
  const assetProgressResult = await validateAgainstSchema(
    assetReadyWithProgress,
    "job-event.schema.json",
  );
  assert.equal(assetProgressResult.valid, false);

  // Generated type surface encodes invalid combinations as never (read-only evidence).
  const derived = await buildGeneratedTypesText();
  assert.match(derived, /type: "state_changed";[\s\S]*progress\?: never;/);
  assert.match(derived, /type: "error";[\s\S]*state: "FAILED";/);
  assert.match(derived, /type: "asset_ready";[\s\S]*progress\?: never;/);
  assert.match(derived, /state: "CREATED";[\s\S]*manifestId\?: never;/);
  assert.match(derived, /state: "SUCCEEDED";[\s\S]*manifestId: ManifestId;/);

  // Read-only declaration evidence: the schema-derived state_changed arm marks
  // every prohibited payload as never. Actual TypeScript compilation is not
  // claimed by this package because it has no TypeScript compiler dependency.
  for (const field of ["progress", "error", "assetRef", "manifestId"]) {
    assert.match(
      derived,
      new RegExp(`type: "state_changed";[\\s\\S]*${field}\\?: never;`),
    );
  }
});

test("unrelated JobEvent variants and runtime semantics remain frozen", async () => {
  const derived = await buildGeneratedTypesText();

  // Baseline-compatible shapes for non-state_changed variants.
  assert.match(
    derived,
    /type: "progress";[\s\S]*state: ActiveJobState;[\s\S]*progress: \{ ratio: number; stage\?: string \};/,
  );
  assert.match(
    derived,
    /type: "asset_ready";[\s\S]*state: ActiveJobState;[\s\S]*assetRef: VerifiedAssetRef;/,
  );
  assert.match(
    derived,
    /type: "manifest_ready";[\s\S]*state: "SUCCEEDED";[\s\S]*manifestId: ManifestId;/,
  );
  assert.match(
    derived,
    /type: "cancel_accepted";[\s\S]*state: "CANCELLED";/,
  );
  assert.match(
    derived,
    /type: "error";[\s\S]*state: "FAILED";[\s\S]*error: ErrorObject;/,
  );

  // Runtime semantic helper stays frozen: state_changed with progress is not
  // rejected by validateJobEventSemantics (schema owns that contract).
  const stateChangedWithProgress = {
    schemaVersion: "1.0.0",
    eventId: "evt_job_mock_sem_sc_progress",
    jobId: "job_mock_sem",
    sequence: 1,
    type: "state_changed",
    state: "RENDERING",
    timestamp: "2026-08-12T10:00:02Z",
    progress: { ratio: 0.4, stage: "render" },
  };
  const semantic = validateJobEventSemantics(stateChangedWithProgress);
  assert.equal(
    semantic.valid,
    true,
    "validateJobEventSemantics must not expand to reject state_changed progress",
  );

  // Existing required-payload mirrors still fire.
  const assetReadyMissing = {
    schemaVersion: "1.0.0",
    eventId: "evt_job_mock_sem_asset",
    jobId: "job_mock_sem",
    sequence: 2,
    type: "asset_ready",
    state: "RENDERING",
    timestamp: "2026-08-12T10:00:03Z",
  };
  const assetSemantic = validateJobEventSemantics(assetReadyMissing);
  assert.equal(assetSemantic.valid, false);
  assert.ok(
    assetSemantic.errors.some((error) => error.path === "#/assetRef"),
  );
});

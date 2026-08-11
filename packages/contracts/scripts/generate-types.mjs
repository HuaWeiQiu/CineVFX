/**
 * Schema-driven TypeScript type generator for @cinevfx/contracts.
 * Reads packages/contracts/schemas/*.schema.json and emits discriminated types.
 *
 * JobStatus and JobEvent discriminants/variants are derived (and fail-closed
 * verified) from job-status.schema.json and job-event.schema.json. Schema enum
 * or branch drift makes generation throw. Rendered unions come from derived
 * branch shapes so enum/const/payload drift cannot silently leave declarations
 * stale.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./catalog.mjs";

const SCHEMA_DIR = path.join(packageRoot, "schemas");

/** Payload fields that participate in JobEvent type/payload discrimination. */
export const JOB_EVENT_PAYLOAD_FIELDS = Object.freeze([
  "progress",
  "error",
  "assetRef",
  "manifestId",
  "message",
]);

/**
 * JobStatus branch fields the renderer can express. Any other required,
 * forbidden, or const-constrained property fails closed so schema drift cannot
 * produce byte-identical declarations.
 */
export const JOB_STATUS_RENDERABLE_FIELDS = Object.freeze([
  "cancelRequested",
  "progress",
  "finishedAt",
  "error",
  "manifestId",
]);

const JOB_STATE_REF = "common.schema.json#/$defs/JobState";
const ACTIVE_JOB_STATE_REF = "common.schema.json#/$defs/ActiveJobState";
const SUPPORTED_JOB_STATES = Object.freeze([
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "PREPROCESSING",
  "RENDERING",
  "POSTPROCESSING",
  "EXPORTING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);
const SUPPORTED_ACTIVE_JOB_STATES = Object.freeze(SUPPORTED_JOB_STATES.slice(0, 7));
const SUPPORTED_JOB_EVENT_TYPES = Object.freeze([
  "state_changed",
  "progress",
  "asset_ready",
  "manifest_ready",
  "cancel_accepted",
  "error",
]);
const JOB_STATUS_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "jobId",
  "idempotencyKey",
  "state",
  "progress",
  "createdAt",
  "updatedAt",
  "cancelRequested",
]);
const JOB_STATUS_PROPERTY_FIELDS = Object.freeze([
  ...JOB_STATUS_REQUIRED_FIELDS,
  "startedAt",
  "finishedAt",
  "error",
  "manifestId",
  "eventCount",
]);
const JOB_EVENT_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "eventId",
  "jobId",
  "sequence",
  "type",
  "state",
  "timestamp",
]);
const JOB_EVENT_PROPERTY_FIELDS = Object.freeze([
  ...JOB_EVENT_REQUIRED_FIELDS,
  ...JOB_EVENT_PAYLOAD_FIELDS,
]);

async function loadJson(fileName) {
  return JSON.parse(await readFile(path.join(SCHEMA_DIR, fileName), "utf8"));
}

function unionFromEnum(values) {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function requiredFieldNames(schemaNode) {
  return Array.isArray(schemaNode?.required) ? [...schemaNode.required] : [];
}

function constProperty(schemaNode, key) {
  return schemaNode?.properties?.[key]?.const;
}

function enumProperty(schemaNode, key) {
  return schemaNode?.properties?.[key]?.enum;
}

function refProperty(schemaNode, key) {
  return schemaNode?.properties?.[key]?.$ref;
}

function forbiddenRequiredFields(thenNode) {
  const notNode = thenNode?.not;
  if (!notNode) return [];
  if (Array.isArray(notNode.anyOf)) {
    if (Object.keys(notNode).some((key) => key !== "anyOf")) {
      throw new Error("unsupported keys beside not.anyOf");
    }
    return notNode.anyOf
      .map((clause) => {
        if (Object.keys(clause ?? {}).some((key) => key !== "required")) {
          throw new Error("not.anyOf clauses must contain only required");
        }
        const fields = requiredFieldNames(clause);
        if (fields.length !== 1) {
          throw new Error(
            "not.anyOf required clauses must contain exactly one field; compound prohibitions are unsupported",
          );
        }
        return fields[0];
      })
      .sort();
  }
  if (Object.keys(notNode).some((key) => key !== "required")) {
    throw new Error("not clauses must contain only required or anyOf");
  }
  const fields = requiredFieldNames(notNode);
  if (fields.length !== 1) {
    throw new Error(
      "not.required must contain exactly one field; compound prohibitions are unsupported",
    );
  }
  return fields;
}

function ifStateValues(ifNode) {
  const state = ifNode?.properties?.state;
  if (!state) return [];
  if (Object.hasOwn(state, "const")) return [state.const];
  if (Array.isArray(state.enum)) return [...state.enum];
  return [];
}

function ifTypeValues(ifNode) {
  const type = ifNode?.properties?.type;
  if (!type) return [];
  if (Object.hasOwn(type, "const")) return [type.const];
  if (Array.isArray(type.enum)) return [...type.enum];
  return [];
}

function sameStringArray(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function assertOnlyKeys(value, allowed, label) {
  const extras = Object.keys(value ?? {}).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`${label} has unsupported keys: ${extras.join(", ")}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function assertExactValue(actual, expected, label) {
  if (JSON.stringify(stableValue(actual)) !== JSON.stringify(stableValue(expected))) {
    throw new Error(`${label} does not match the supported frozen contract shape`);
  }
}

function cancelRequestedExpr(cancelConst) {
  if (cancelConst === true) return "true";
  if (cancelConst === false) return "false";
  return "boolean";
}

function progressTypeExpr(progressRatio) {
  if (progressRatio === 0) {
    return "{ ratio: 0; stage: string; message?: string }";
  }
  if (progressRatio === 1) {
    return "{ ratio: 1; stage: string; message?: string }";
  }
  return null;
}

function assertNoRequiredForbiddenOverlap(required, forbidden, label) {
  const conflicts = required.filter((field) => forbidden.includes(field));
  if (conflicts.length > 0) {
    throw new Error(
      `${label} has contradictory required and forbidden fields: ${conflicts.join(", ")}`,
    );
  }
}

/**
 * Reject branch constraints the renderer cannot express. Without this check,
 * adding required/forbidden/const fields that render ignores would leave
 * committed declarations byte-identical and hide schema/type drift.
 */
function assertJobStatusBranchRenderable(branch) {
  const unhandledRequired = branch.required.filter(
    (field) => !JOB_STATUS_RENDERABLE_FIELDS.includes(field),
  );
  if (unhandledRequired.length > 0) {
    throw new Error(
      `JobStatus ${branch.state} has unhandled required fields: ${unhandledRequired.join(", ")}`,
    );
  }

  const unhandledForbidden = branch.forbidden.filter(
    (field) => !JOB_STATUS_RENDERABLE_FIELDS.includes(field),
  );
  if (unhandledForbidden.length > 0) {
    throw new Error(
      `JobStatus ${branch.state} has unhandled forbidden fields: ${unhandledForbidden.join(", ")}`,
    );
  }

  for (const field of branch.constrainedProperties ?? []) {
    if (!JOB_STATUS_RENDERABLE_FIELDS.includes(field)) {
      throw new Error(
        `JobStatus ${branch.state} has unhandled constrained property: ${field}`,
      );
    }
  }

  assertNoRequiredForbiddenOverlap(
    branch.required,
    branch.forbidden,
    `JobStatus ${branch.state}`,
  );
}

/**
 * Derive JobStatus state branches from job-status.schema.json allOf rules.
 * Every JobState must be covered exactly once; missing/extra branches fail closed.
 * Branch shapes (required/forbidden/const) are preserved for schema-driven render.
 */
export function deriveJobStatusBranches(jobStatusSchema, jobStates, activeStates) {
  if (!Array.isArray(jobStatusSchema?.allOf) || jobStatusSchema.allOf.length === 0) {
    throw new Error("job-status.schema.json must declare allOf state branches");
  }

  assertOnlyKeys(
    jobStatusSchema,
    [
      "$schema",
      "$id",
      "title",
      "description",
      "type",
      "additionalProperties",
      "required",
      "properties",
      "allOf",
    ],
    "job-status root",
  );

  assertExactValue(jobStatusSchema.type, "object", "job-status root type");
  assertExactValue(
    jobStatusSchema.additionalProperties,
    false,
    "job-status additionalProperties",
  );

  assertExactValue(
    jobStatusSchema.properties?.state,
    { $ref: JOB_STATE_REF },
    "job-status.properties.state",
  );
  assertExactValue(
    requiredFieldNames(jobStatusSchema).sort(),
    [...JOB_STATUS_REQUIRED_FIELDS].sort(),
    "job-status root required fields",
  );
  assertExactValue(
    Object.keys(jobStatusSchema.properties ?? {}).sort(),
    [...JOB_STATUS_PROPERTY_FIELDS].sort(),
    "job-status root property fields",
  );
  assertExactValue(
    jobStatusSchema.properties,
    {
      schemaVersion: { $ref: "common.schema.json#/$defs/SchemaVersion" },
      jobId: { $ref: "common.schema.json#/$defs/JobId" },
      idempotencyKey: { $ref: "common.schema.json#/$defs/IdempotencyKey" },
      state: { $ref: JOB_STATE_REF },
      progress: {
        type: "object",
        additionalProperties: false,
        required: ["ratio", "stage"],
        properties: {
          ratio: { $ref: "common.schema.json#/$defs/UnitInterval" },
          stage: { type: "string", minLength: 1, maxLength: 64 },
          message: { type: "string", maxLength: 256 },
        },
      },
      createdAt: { $ref: "common.schema.json#/$defs/IsoDateTime" },
      updatedAt: { $ref: "common.schema.json#/$defs/IsoDateTime" },
      startedAt: { $ref: "common.schema.json#/$defs/IsoDateTime" },
      finishedAt: { $ref: "common.schema.json#/$defs/IsoDateTime" },
      cancelRequested: { type: "boolean" },
      error: { $ref: "common.schema.json#/$defs/ErrorObject" },
      manifestId: { type: "string", pattern: "^manifest_[a-z0-9_]{1,48}$" },
      eventCount: { $ref: "common.schema.json#/$defs/NonNegativeInt" },
    },
    "job-status root properties",
  );
  if (!sameStringArray(jobStates, SUPPORTED_JOB_STATES)) {
    throw new Error("unsupported JobState enum drift");
  }
  if (!sameStringArray(activeStates, SUPPORTED_ACTIVE_JOB_STATES)) {
    throw new Error("unsupported ActiveJobState enum drift");
  }

  const branchesByState = new Map();

  for (const rule of jobStatusSchema.allOf) {
    assertOnlyKeys(rule, ["if", "then"], "JobStatus allOf rule");
    const states = ifStateValues(rule.if);
    if (states.length === 0) {
      throw new Error("job-status.schema.json allOf entry missing state discriminator");
    }
    assertExactValue(
      rule.if,
      {
        properties: {
          state: states.length === 1 ? { const: states[0] } : { enum: states },
        },
        required: ["state"],
      },
      `JobStatus ${states.join("|")} discriminator`,
    );
    const thenNode = rule.then ?? {};
    assertOnlyKeys(thenNode, ["required", "properties", "not"], "JobStatus branch");
    const required = requiredFieldNames(thenNode).sort();
    const forbidden = forbiddenRequiredFields(thenNode);
    const cancelConst = constProperty(thenNode, "cancelRequested");
    const progressRatioConst = thenNode.properties?.progress?.properties?.ratio?.const;
    const constrainedProperties = Object.keys(thenNode.properties ?? {}).sort();
    assertOnlyKeys(
      thenNode.properties,
      JOB_STATUS_RENDERABLE_FIELDS,
      "JobStatus branch properties",
    );

    for (const state of states) {
      if (branchesByState.has(state)) {
        throw new Error(`job-status.schema.json duplicate branch for state ${state}`);
      }
      const branch = {
        state,
        required,
        forbidden,
        constrainedProperties,
        cancelRequested: cancelConst === undefined ? "boolean" : cancelConst,
        progressRatio: progressRatioConst === undefined ? null : progressRatioConst,
        progressConstraint: thenNode.properties?.progress ?? null,
        propertiesConstraint: thenNode.properties ?? null,
      };
      assertJobStatusBranchRenderable(branch);
      branchesByState.set(state, branch);
    }
  }

  const missing = jobStates.filter((state) => !branchesByState.has(state));
  if (missing.length > 0) {
    throw new Error(
      `job-status.schema.json missing branches for states: ${missing.join(", ")}`,
    );
  }
  const extra = [...branchesByState.keys()].filter((state) => !jobStates.includes(state));
  if (extra.length > 0) {
    throw new Error(
      `job-status.schema.json has unknown state branches: ${extra.join(", ")}`,
    );
  }

  const statusExpectations = {
    CREATED: {
      required: [],
      forbidden: ["error", "finishedAt", "manifestId"],
      constrainedProperties: ["cancelRequested", "progress"],
      cancelRequested: false,
      progressConstraint: {
        type: "object",
        required: ["ratio"],
        properties: { ratio: { const: 0 } },
      },
      propertiesConstraint: {
        cancelRequested: { const: false },
        progress: {
          type: "object",
          required: ["ratio"],
          properties: { ratio: { const: 0 } },
        },
      },
    },
    VALIDATING: {
      required: [],
      forbidden: ["error", "finishedAt", "manifestId"],
      constrainedProperties: [],
      cancelRequested: "boolean",
      progressConstraint: null,
      propertiesConstraint: null,
    },
    QUEUED: null,
    PREPROCESSING: null,
    RENDERING: null,
    POSTPROCESSING: null,
    EXPORTING: null,
    SUCCEEDED: {
      required: ["finishedAt", "manifestId"],
      forbidden: ["error"],
      constrainedProperties: ["cancelRequested", "progress"],
      cancelRequested: false,
      progressConstraint: {
        type: "object",
        required: ["ratio", "stage"],
        properties: { ratio: { const: 1 } },
      },
      propertiesConstraint: {
        cancelRequested: { const: false },
        progress: {
          type: "object",
          required: ["ratio", "stage"],
          properties: { ratio: { const: 1 } },
        },
      },
    },
    FAILED: {
      required: ["error", "finishedAt"],
      forbidden: ["manifestId"],
      constrainedProperties: ["cancelRequested"],
      cancelRequested: false,
      progressConstraint: null,
      propertiesConstraint: { cancelRequested: { const: false } },
    },
    CANCELLED: {
      required: ["finishedAt"],
      forbidden: ["error", "manifestId"],
      constrainedProperties: ["cancelRequested"],
      cancelRequested: true,
      progressConstraint: null,
      propertiesConstraint: { cancelRequested: { const: true } },
    },
    EXPIRED: {
      required: ["finishedAt"],
      forbidden: ["error", "manifestId"],
      constrainedProperties: ["cancelRequested"],
      cancelRequested: false,
      progressConstraint: null,
      propertiesConstraint: { cancelRequested: { const: false } },
    },
  };
  for (const state of [
    "QUEUED",
    "PREPROCESSING",
    "RENDERING",
    "POSTPROCESSING",
    "EXPORTING",
  ]) {
    statusExpectations[state] = statusExpectations.VALIDATING;
  }
  for (const state of jobStates) {
    const branch = branchesByState.get(state);
    const expected = statusExpectations[state];
    if (!expected) throw new Error(`No frozen JobStatus expectation for ${state}`);
    assertExactValue(
      {
        required: branch.required,
        forbidden: branch.forbidden,
        constrainedProperties: branch.constrainedProperties,
        cancelRequested: branch.cancelRequested,
        progressConstraint: branch.progressConstraint,
        propertiesConstraint: branch.propertiesConstraint,
      },
      expected,
      `JobStatus ${state}`,
    );
  }

  // Fail-closed structural expectations aligned with lifecycle semantics.
  const created = branchesByState.get("CREATED");
  if (!created || created.cancelRequested !== false || created.progressRatio !== 0) {
    throw new Error("CREATED branch must force cancelRequested=false and progress.ratio=0");
  }
  for (const field of ["manifestId", "error", "finishedAt"]) {
    if (!created.forbidden.includes(field)) {
      throw new Error(`CREATED branch must forbid ${field}`);
    }
  }

  const activeNonCreated = activeStates.filter((state) => state !== "CREATED");
  for (const state of activeNonCreated) {
    const branch = branchesByState.get(state);
    if (!branch) throw new Error(`Missing active branch ${state}`);
    for (const field of ["manifestId", "error", "finishedAt"]) {
      if (!branch.forbidden.includes(field)) {
        throw new Error(`${state} branch must forbid ${field}`);
      }
    }
  }

  // ActiveJobState must match the set of states whose branches look "active"
  // (forbid finishedAt/error/manifestId and do not require terminal fields).
  const derivedActive = jobStates.filter((state) => {
    const branch = branchesByState.get(state);
    return (
      branch.forbidden.includes("finishedAt") &&
      branch.forbidden.includes("error") &&
      branch.forbidden.includes("manifestId") &&
      !branch.required.includes("finishedAt")
    );
  });
  if (!sameStringArray(derivedActive, activeStates)) {
    throw new Error(
      `ActiveJobState enum drift vs status branches: schema=[${activeStates.join(",")}] derived=[${derivedActive.join(",")}]`,
    );
  }

  const succeeded = branchesByState.get("SUCCEEDED");
  if (
    !succeeded ||
    !succeeded.required.includes("manifestId") ||
    !succeeded.required.includes("finishedAt") ||
    succeeded.cancelRequested !== false ||
    succeeded.progressRatio !== 1 ||
    !succeeded.forbidden.includes("error")
  ) {
    throw new Error(
      "SUCCEEDED branch must require manifestId+finishedAt, forbid error, ratio=1, cancel=false",
    );
  }

  const failed = branchesByState.get("FAILED");
  if (
    !failed ||
    !failed.required.includes("error") ||
    !failed.required.includes("finishedAt") ||
    failed.cancelRequested !== false ||
    !failed.forbidden.includes("manifestId")
  ) {
    throw new Error(
      "FAILED branch must require error+finishedAt, forbid manifestId, cancel=false",
    );
  }

  const cancelled = branchesByState.get("CANCELLED");
  if (
    !cancelled ||
    !cancelled.required.includes("finishedAt") ||
    cancelled.cancelRequested !== true ||
    !cancelled.forbidden.includes("manifestId") ||
    !cancelled.forbidden.includes("error")
  ) {
    throw new Error(
      "CANCELLED branch must require finishedAt, cancel=true, forbid manifestId+error",
    );
  }

  const expired = branchesByState.get("EXPIRED");
  if (
    !expired ||
    !expired.required.includes("finishedAt") ||
    expired.cancelRequested !== false ||
    !expired.forbidden.includes("manifestId") ||
    !expired.forbidden.includes("error")
  ) {
    throw new Error(
      "EXPIRED branch must require finishedAt, cancel=false, forbid manifestId+error",
    );
  }

  return jobStates.map((state) => branchesByState.get(state));
}

function payloadPresence(required, forbidden, field) {
  const isRequired = required.includes(field);
  const isForbidden = forbidden.includes(field);
  if (isRequired && isForbidden) {
    throw new Error(
      `payload field ${field} cannot be both required and forbidden`,
    );
  }
  if (isRequired) return "required";
  if (isForbidden) return "forbidden";
  return "optional";
}

/**
 * Derive JobEvent type/state/payload variants from job-event.schema.json.
 * Every type enum member must have exactly one branch; payload required /
 * optional / forbidden sets are read from schema so schema/type agreement is
 * mechanical.
 */
export function deriveJobEventBranches(jobEventSchema, eventTypes, jobStates, activeStates) {
  if (!Array.isArray(jobEventSchema?.allOf) || jobEventSchema.allOf.length === 0) {
    throw new Error("job-event.schema.json must declare allOf type branches");
  }

  assertOnlyKeys(
    jobEventSchema,
    [
      "$schema",
      "$id",
      "title",
      "description",
      "type",
      "additionalProperties",
      "required",
      "properties",
      "allOf",
    ],
    "job-event root",
  );

  assertExactValue(jobEventSchema.type, "object", "job-event root type");
  assertExactValue(
    jobEventSchema.additionalProperties,
    false,
    "job-event additionalProperties",
  );

  assertExactValue(
    jobEventSchema.properties?.state,
    { $ref: JOB_STATE_REF },
    "job-event.properties.state",
  );
  assertExactValue(
    requiredFieldNames(jobEventSchema).sort(),
    [...JOB_EVENT_REQUIRED_FIELDS].sort(),
    "job-event root required fields",
  );
  assertExactValue(
    Object.keys(jobEventSchema.properties ?? {}).sort(),
    [...JOB_EVENT_PROPERTY_FIELDS].sort(),
    "job-event root property fields",
  );
  if (!sameStringArray(eventTypes, SUPPORTED_JOB_EVENT_TYPES)) {
    throw new Error("unsupported JobEvent type enum drift");
  }
  if (!sameStringArray(jobStates, SUPPORTED_JOB_STATES)) {
    throw new Error("unsupported JobState enum drift");
  }
  if (!sameStringArray(activeStates, SUPPORTED_ACTIVE_JOB_STATES)) {
    throw new Error("unsupported ActiveJobState enum drift");
  }

  const schemaTypeEnum = jobEventSchema.properties?.type?.enum;
  if (!Array.isArray(schemaTypeEnum)) {
    throw new Error("job-event.schema.json must declare properties.type.enum");
  }
  if (
    schemaTypeEnum.length !== eventTypes.length ||
    schemaTypeEnum.some((value, index) => value !== eventTypes[index])
  ) {
    throw new Error("job-event type enum drift between properties.type.enum and caller");
  }
  assertExactValue(
    jobEventSchema.properties.type,
    { type: "string", enum: [...SUPPORTED_JOB_EVENT_TYPES] },
    "job-event.properties.type",
  );

  const rootProperties = jobEventSchema.properties ?? {};
  for (const field of JOB_EVENT_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(rootProperties, field)) {
      throw new Error(`job-event.schema.json missing root payload property ${field}`);
    }
  }
  const expectedPayloadSchemas = {
    progress: {
      type: "object",
      additionalProperties: false,
      required: ["ratio"],
      properties: {
        ratio: { $ref: "common.schema.json#/$defs/UnitInterval" },
        stage: { type: "string", maxLength: 64 },
      },
    },
    error: { $ref: "common.schema.json#/$defs/ErrorObject" },
    assetRef: { $ref: "common.schema.json#/$defs/VerifiedAssetRef" },
    manifestId: { type: "string", pattern: "^manifest_[a-z0-9_]{1,48}$" },
    message: { type: "string", maxLength: 256 },
  };
  for (const field of JOB_EVENT_PAYLOAD_FIELDS) {
    assertExactValue(
      rootProperties[field],
      expectedPayloadSchemas[field],
      `job-event root payload ${field}`,
    );
  }
  assertExactValue(
    rootProperties,
    {
      schemaVersion: { $ref: "common.schema.json#/$defs/SchemaVersion" },
      eventId: { type: "string", pattern: "^evt_[a-z0-9_]{1,58}$" },
      jobId: { $ref: "common.schema.json#/$defs/JobId" },
      sequence: { type: "integer", minimum: 0 },
      type: { type: "string", enum: [...SUPPORTED_JOB_EVENT_TYPES] },
      state: { $ref: JOB_STATE_REF },
      timestamp: { $ref: "common.schema.json#/$defs/IsoDateTime" },
      ...expectedPayloadSchemas,
    },
    "job-event root properties",
  );

  const branchesByType = new Map();

  for (const rule of jobEventSchema.allOf) {
    assertOnlyKeys(rule, ["if", "then"], "JobEvent allOf rule");
    const types = ifTypeValues(rule.if);
    if (types.length !== 1) {
      throw new Error(
        "job-event.schema.json allOf entries must discriminate on a single type const",
      );
    }
    const type = types[0];
    assertExactValue(
      rule.if,
      { properties: { type: { const: type } }, required: ["type"] },
      `job-event ${type} discriminator`,
    );
    if (branchesByType.has(type)) {
      throw new Error(`job-event.schema.json duplicate branch for type ${type}`);
    }
    const thenNode = rule.then ?? {};
    assertOnlyKeys(thenNode, ["required", "properties", "not"], `job-event ${type}`);
    assertOnlyKeys(thenNode.properties, ["state"], `job-event ${type} properties`);
    const required = requiredFieldNames(thenNode).sort();
    const unknownRequired = required.filter(
      (field) => !JOB_EVENT_PAYLOAD_FIELDS.includes(field),
    );
    if (unknownRequired.length > 0) {
      throw new Error(`job-event ${type} has unsupported required fields: ${unknownRequired.join(", ")}`);
    }
    const forbidden = forbiddenRequiredFields(thenNode);
    const unknownForbidden = forbidden.filter(
      (field) => !JOB_EVENT_PAYLOAD_FIELDS.includes(field),
    );
    if (unknownForbidden.length > 0) {
      throw new Error(
        `job-event ${type} has unsupported forbidden fields: ${unknownForbidden.join(", ")}`,
      );
    }
    assertNoRequiredForbiddenOverlap(required, forbidden, `job-event ${type}`);

    let stateExpr;
    const stateConst = constProperty(thenNode, "state");
    const stateEnum = enumProperty(thenNode, "state");
    const stateRef = refProperty(thenNode, "state");
    if (stateConst !== undefined) {
      stateExpr = { kind: "const", value: stateConst };
    } else if (Array.isArray(stateEnum)) {
      stateExpr = { kind: "enum", values: stateEnum };
    } else if (stateRef === ACTIVE_JOB_STATE_REF) {
      stateExpr = { kind: "active" };
    } else if (stateRef === JOB_STATE_REF) {
      stateExpr = { kind: "job" };
    } else if (stateRef === undefined && stateConst === undefined && !stateEnum) {
      // state_changed: when then does not narrow state, root properties.state must
      // already be verified as JobState (asserted above).
      stateExpr = { kind: "job" };
    } else {
      throw new Error(
        `job-event type ${type} has unsupported state constraint: ${stateRef ?? "unknown"}`,
      );
    }

    const expectedStateConstraint = {
      state_changed: undefined,
      progress: { $ref: ACTIVE_JOB_STATE_REF },
      asset_ready: { $ref: ACTIVE_JOB_STATE_REF },
      manifest_ready: { const: "SUCCEEDED" },
      cancel_accepted: { const: "CANCELLED" },
      error: { const: "FAILED" },
    }[type];
    assertExactValue(
      thenNode.properties?.state,
      expectedStateConstraint,
      `job-event ${type} state constraint`,
    );

    const payloads = {};
    for (const field of JOB_EVENT_PAYLOAD_FIELDS) {
      payloads[field] = payloadPresence(required, forbidden, field);
    }

    branchesByType.set(type, {
      type,
      required,
      forbidden,
      stateExpr,
      payloads,
    });
  }

  const missing = eventTypes.filter((type) => !branchesByType.has(type));
  if (missing.length > 0) {
    throw new Error(
      `job-event.schema.json missing branches for types: ${missing.join(", ")}`,
    );
  }
  const extra = [...branchesByType.keys()].filter((type) => !eventTypes.includes(type));
  if (extra.length > 0) {
    throw new Error(
      `job-event.schema.json has unknown type branches: ${extra.join(", ")}`,
    );
  }

  // Fail-closed payload contracts for each known event type. These encode the
  // product-facing Mock event surface; schema drift that weakens them fails closed.
  const expectations = {
    state_changed: {
      payloads: {
        progress: "forbidden",
        error: "forbidden",
        assetRef: "forbidden",
        manifestId: "forbidden",
        message: "optional",
      },
      stateKind: "job",
    },
    progress: {
      payloads: {
        progress: "required",
        error: "forbidden",
        assetRef: "forbidden",
        manifestId: "forbidden",
        message: "optional",
      },
      stateKind: "active",
    },
    asset_ready: {
      payloads: {
        progress: "forbidden",
        error: "forbidden",
        assetRef: "required",
        manifestId: "forbidden",
        message: "optional",
      },
      stateKind: "active",
    },
    manifest_ready: {
      payloads: {
        progress: "forbidden",
        error: "forbidden",
        assetRef: "forbidden",
        manifestId: "required",
        message: "optional",
      },
      stateKind: "const",
      stateValue: "SUCCEEDED",
    },
    cancel_accepted: {
      payloads: {
        progress: "forbidden",
        error: "forbidden",
        assetRef: "forbidden",
        manifestId: "forbidden",
        message: "optional",
      },
      stateKind: "const",
      stateValue: "CANCELLED",
    },
    error: {
      payloads: {
        progress: "forbidden",
        error: "required",
        assetRef: "forbidden",
        manifestId: "forbidden",
        message: "optional",
      },
      stateKind: "const",
      stateValue: "FAILED",
    },
  };

  for (const type of eventTypes) {
    const branch = branchesByType.get(type);
    const expected = expectations[type];
    if (!expected) {
      throw new Error(`No fail-closed expectation registered for event type ${type}`);
    }
    for (const field of JOB_EVENT_PAYLOAD_FIELDS) {
      const actual = branch.payloads[field];
      const want = expected.payloads[field];
      if (actual !== want) {
        throw new Error(
          `job-event ${type} payload ${field} must be ${want}, schema derived ${actual}`,
        );
      }
    }
    if (expected.stateKind === "const") {
      if (branch.stateExpr.kind !== "const" || branch.stateExpr.value !== expected.stateValue) {
        throw new Error(
          `job-event ${type} branch must constrain state to ${expected.stateValue}`,
        );
      }
    } else if (expected.stateKind === "active") {
      if (branch.stateExpr.kind !== "active") {
        throw new Error(`job-event ${type} branch must use ActiveJobState`);
      }
    } else if (expected.stateKind === "job") {
      if (branch.stateExpr.kind !== "job") {
        throw new Error(`job-event ${type} branch must use JobState`);
      }
    }
  }

  // ActiveJobState / JobState coverage sanity (used by generated unions).
  if (!activeStates.includes("CREATED") || activeStates.length < 2) {
    throw new Error("ActiveJobState enum is incomplete");
  }
  if (!jobStates.includes("SUCCEEDED") || jobStates.length < activeStates.length) {
    throw new Error("JobState enum is incomplete");
  }

  return eventTypes.map((type) => branchesByType.get(type));
}

/**
 * Render JobStatus union arms directly from derived branch shapes.
 * Equivalent consecutive shapes may be grouped; every JobState appears exactly once.
 */
export function renderJobStatusUnion(branches, jobStates, activeStates) {
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error("JobStatus render requires derived branches");
  }
  if (branches.length !== jobStates.length) {
    throw new Error(
      `JobStatus render branch count ${branches.length} != JobState count ${jobStates.length}`,
    );
  }
  for (let index = 0; index < branches.length; index += 1) {
    if (branches[index].state !== jobStates[index]) {
      throw new Error(
        `JobStatus branch order drift at ${index}: ${branches[index].state} != ${jobStates[index]}`,
      );
    }
    assertJobStatusBranchRenderable(branches[index]);
  }

  // Group consecutive branches that share an identical rendered shape so the
  // declaration stays compact while remaining fully schema-driven.
  const groups = [];
  for (const branch of branches) {
    const shapeKey = JSON.stringify({
      required: branch.required,
      forbidden: branch.forbidden,
      constrainedProperties: branch.constrainedProperties ?? [],
      cancelRequested: branch.cancelRequested,
      progressRatio: branch.progressRatio,
    });
    const last = groups[groups.length - 1];
    if (last && last.shapeKey === shapeKey) {
      last.states.push(branch.state);
      continue;
    }
    groups.push({ shapeKey, states: [branch.state], branch });
  }

  // Fail-closed: every ActiveJobState must appear, and non-CREATED actives that
  // share the open cancelRequested:boolean shape may be grouped.
  const renderedStates = groups.flatMap((group) => group.states);
  if (!sameStringArray(renderedStates, jobStates)) {
    throw new Error("JobStatus render lost or reordered JobState members");
  }
  for (const state of activeStates) {
    if (!renderedStates.includes(state)) {
      throw new Error(`JobStatus render missing ActiveJobState ${state}`);
    }
  }

  const parts = groups.map((group) => {
    const { branch, states } = group;
    let stateExpr;
    if (states.length === 1) {
      stateExpr = JSON.stringify(states[0]);
    } else if (
      sameStringArray(states, activeStates.filter((state) => state !== "CREATED"))
    ) {
      // Preserve the historical Exclude form when the open active set matches.
      stateExpr = 'Exclude<ActiveJobState, "CREATED">';
    } else {
      stateExpr = unionFromEnum(states);
    }

    const lines = [`state: ${stateExpr};`];
    lines.push(`cancelRequested: ${cancelRequestedExpr(branch.cancelRequested)};`);

    const progressExpr = progressTypeExpr(branch.progressRatio);
    if (progressExpr) {
      lines.push(`progress: ${progressExpr};`);
    }

    // Historical field order: finishedAt, then required terminal payloads, then never.
    if (branch.required.includes("finishedAt")) {
      lines.push("finishedAt: string;");
    } else if (branch.forbidden.includes("finishedAt")) {
      lines.push("finishedAt?: never;");
    }

    if (branch.required.includes("error")) {
      lines.push("error: ErrorObject;");
    }
    if (branch.required.includes("manifestId")) {
      lines.push("manifestId: ManifestId;");
    }
    if (branch.forbidden.includes("error") && !branch.required.includes("error")) {
      lines.push("error?: never;");
    }
    if (branch.forbidden.includes("manifestId") && !branch.required.includes("manifestId")) {
      lines.push("manifestId?: never;");
    }

    return `(JobStatusBase & {
      ${lines.join("\n      ")}
    })`;
  });

  return parts.map((part) => `  | ${part}`).join("\n");
}

function stateTypeExpr(stateExpr) {
  if (stateExpr.kind === "const") return JSON.stringify(stateExpr.value);
  if (stateExpr.kind === "active") return "ActiveJobState";
  if (stateExpr.kind === "job") return "JobState";
  if (stateExpr.kind === "enum") return unionFromEnum(stateExpr.values);
  throw new Error(`Unsupported state expression ${stateExpr.kind}`);
}

function payloadFieldType(field) {
  if (field === "progress") return "{ ratio: number; stage?: string }";
  if (field === "error") return "ErrorObject";
  if (field === "assetRef") return "VerifiedAssetRef";
  if (field === "manifestId") return "ManifestId";
  if (field === "message") return "string";
  throw new Error(`Unknown payload field ${field}`);
}

/**
 * Render JobEvent union arms from schema-derived payload presence.
 * Required / optional / forbidden come only from branch.payloads.
 */
export function renderJobEventUnion(branches) {
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error("JobEvent render requires derived branches");
  }

  const arms = branches.map((branch) => {
    const lines = [
      "schemaVersion: SchemaVersion;",
      "eventId: EventId;",
      "jobId: JobId;",
      "sequence: number;",
      `type: ${JSON.stringify(branch.type)};`,
      `state: ${stateTypeExpr(branch.stateExpr)};`,
      "timestamp: string;",
    ];

    // Stable field order: required payloads first (progress/error/assetRef/manifestId),
    // then message, then remaining forbidden never fields.
    const ordered = ["progress", "error", "assetRef", "manifestId", "message"];
    const requiredLines = [];
    const optionalLines = [];
    const neverLines = [];

    for (const field of ordered) {
      const presence = branch.payloads?.[field];
      if (!presence) {
        throw new Error(`JobEvent ${branch.type} missing payload presence for ${field}`);
      }
      if (presence === "required") {
        requiredLines.push(`${field}: ${payloadFieldType(field)};`);
      } else if (presence === "optional") {
        optionalLines.push(`${field}?: ${payloadFieldType(field)};`);
      } else if (presence === "forbidden") {
        neverLines.push(`${field}?: never;`);
      } else {
        throw new Error(`JobEvent ${branch.type} invalid presence ${presence} for ${field}`);
      }
    }

    // Match historical declaration order: required payloads, message optional,
    // then never fields in progress/error/assetRef/manifestId order.
    lines.push(...requiredLines);
    const messageOptional = optionalLines.filter((line) => line.startsWith("message"));
    const otherOptional = optionalLines.filter((line) => !line.startsWith("message"));
    lines.push(...otherOptional, ...messageOptional, ...neverLines);

    return `  | {
      ${lines.join("\n      ")}
    }`;
  });

  return arms.join("\n");
}

/**
 * Build TypeScript declaration text from schemas.
 * Exported for drift tests that must not write the filesystem.
 */
export async function buildGeneratedTypesText() {
  const common = await loadJson("common.schema.json");
  const effectSpec = await loadJson("effect-spec.schema.json");
  const assetDescriptor = await loadJson("asset-descriptor.schema.json");
  const jobRequest = await loadJson("job-request.schema.json");
  const jobStatus = await loadJson("job-status.schema.json");
  const jobEvent = await loadJson("job-event.schema.json");
  const layerManifest = await loadJson("layer-manifest.schema.json");

  function extractEnum(defName) {
    const def = common.$defs[defName];
    if (!def?.enum) throw new Error(`Missing enum def ${defName}`);
    return def.enum;
  }

  const mediaTypes = extractEnum("MediaType");
  const alphaModes = extractEnum("AlphaMode");
  const purposes = extractEnum("AssetPurpose");
  const colorSpaces = extractEnum("ColorSpace");
  const jobStates = extractEnum("JobState");
  const activeStates = extractEnum("ActiveJobState");
  const terminalStates = extractEnum("TerminalJobState");
  const blendModes = extractEnum("BlendMode");

  const primitiveKind = effectSpec.properties.primitives.items.properties.kind.enum;
  const passKind = layerManifest.properties.passes.items.properties.kind.enum;
  const eventTypes = jobEvent.properties.type.enum;
  const sourceRoles = assetDescriptor.properties.sourceRole.enum;
  const forbiddenOps =
    jobRequest.properties.protectedSource.properties.operationsForbidden.items.enum;

  // Validate required document schema shapes so generator fails on schema drift.
  for (const [name, schema] of [
    ["effect-spec", effectSpec],
    ["asset-descriptor", assetDescriptor],
    ["job-request", jobRequest],
    ["job-status", jobStatus],
    ["job-event", jobEvent],
    ["layer-manifest", layerManifest],
  ]) {
    if (schema.type !== "object" || !schema.properties) {
      throw new Error(`Schema ${name} is not a document object`);
    }
  }

  if (!Array.isArray(primitiveKind) || primitiveKind.length === 0) {
    throw new Error("effect-spec primitives.kind enum missing");
  }
  if (!Array.isArray(passKind) || passKind.length === 0) {
    throw new Error("layer-manifest passes.kind enum missing");
  }
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    throw new Error("job-event type enum missing");
  }

  // TerminalJobState must be the complement of ActiveJobState within JobState.
  const derivedTerminal = jobStates.filter((state) => !activeStates.includes(state));
  if (!sameStringArray(derivedTerminal, terminalStates)) {
    throw new Error(
      `TerminalJobState enum drift: schema=[${terminalStates.join(",")}] derived=[${derivedTerminal.join(",")}]`,
    );
  }

  const jobStatusBranches = deriveJobStatusBranches(jobStatus, jobStates, activeStates);
  const jobEventBranches = deriveJobEventBranches(
    jobEvent,
    eventTypes,
    jobStates,
    activeStates,
  );

  const jobStatusUnion = renderJobStatusUnion(jobStatusBranches, jobStates, activeStates);
  const jobEventUnion = renderJobEventUnion(jobEventBranches);

  const schemaDerivedComment = [
    `// schema-derived enums: JobState=${jobStates.length}`,
    `EventType=${eventTypes.length}`,
    `PrimitiveKind=${primitiveKind.length}`,
    `PassKind=${passKind.length}`,
    `AssetPurpose=${purposes.length}`,
    `JobStatusBranches=${jobStatusBranches.length}`,
    `JobEventBranches=${jobEventBranches.length}`,
  ].join(" ");

  return `/**
 * Generated TypeScript contract types for @cinevfx/contracts.
 * Source of truth: packages/contracts/schemas/*.schema.json
 * Do not edit by hand; regenerate with \`pnpm --dir packages/contracts build\`.
 * ${schemaDerivedComment}
 */

export type SchemaVersion = "1.0.0";

export type MediaType = ${unionFromEnum(mediaTypes)};
export type AlphaMode = ${unionFromEnum(alphaModes)};
export type AssetPurpose = ${unionFromEnum(purposes)};
export type ColorSpace = ${unionFromEnum(colorSpaces)};

export type JobState = ${unionFromEnum(jobStates)};
export type ActiveJobState = ${unionFromEnum(activeStates)};
export type TerminalJobState = ${unionFromEnum(terminalStates)};

export type BlendMode = ${unionFromEnum(blendModes)};
export type PrimitiveKind = ${unionFromEnum(primitiveKind)};
export type PassKind = ${unionFromEnum(passKind)};
export type JobEventType = ${unionFromEnum(eventTypes)};

export type Digest = \`sha256:\${string}\`;
export type AssetId = \`asset_\${string}\`;
export type JobId = \`job_\${string}\`;
export type IdempotencyKey = \`idem_\${string}\`;
export type ManifestId = \`manifest_\${string}\`;
export type EventId = \`evt_\${string}\`;

export interface Dimensions {
  width: number;
  height: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface NormalizedCanvas {
  width: number;
  height: number;
  colorSpace: ColorSpace;
  pixelAspectRatio: number;
  normalized: true;
}

export interface VerifiedAssetRef {
  assetId: AssetId;
  digest: Digest;
}

export interface ErrorObject {
  code: string;
  message: string;
  retriable?: boolean;
}

export interface PassAdjustments {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  blurRadius?: number;
}

export interface EffectReference {
  id: string;
  assetId: AssetId;
  role: "effect" | "style" | "mask" | "depth" | "normal" | "environment";
  digest?: Digest;
  weight?: number;
}

export interface GuidanceAnchor {
  id: string;
  point: NormalizedPoint;
  radius?: number;
}

export interface EffectGuidance {
  anchors: GuidanceAnchor[];
  strength: number;
  subjectMaskAssetId?: AssetId;
  notes?: string;
}

export interface EffectPrimitive {
  id: string;
  kind: PrimitiveKind;
  enabled: boolean;
  params: Record<string, number | boolean | string>;
}

export interface EffectSpec {
  schemaVersion: SchemaVersion;
  effectSpecVersion: string;
  seed: number;
  label?: string;
  canvas: NormalizedCanvas;
  references: EffectReference[];
  guidance: EffectGuidance;
  primitives: [EffectPrimitive, ...EffectPrimitive[]];
  benchmark?: {
    fixtureId?: string;
    description?: string;
  };
}

export interface AssetDescriptor {
  schemaVersion: SchemaVersion;
  assetId: AssetId;
  mediaType: MediaType;
  dimensions: Dimensions;
  digest: Digest;
  alphaMode: AlphaMode;
  byteLength: number;
  ttlSeconds: number;
  purpose: AssetPurpose;
  createdAt: string;
  colorSpace?: ColorSpace;
  expiresAt?: string;
  sourceRole?: ${unionFromEnum(sourceRoles)};
}

export interface JobRequest {
  schemaVersion: SchemaVersion;
  idempotencyKey: IdempotencyKey;
  clientRequestId?: string;
  effectSpec: EffectSpec;
  inputAssets: Array<{
    assetId: AssetId;
    digest: Digest;
    purpose: AssetPurpose;
  }>;
  protectedSource: {
    layerStableId: string;
    documentStableId?: string;
    immutable: true;
    operationsForbidden: Array<${unionFromEnum(forbiddenOps)}>;
  };
  options?: {
    priority?: "normal" | "low";
    dryRun?: boolean;
    ttlSeconds?: number;
  };
}

export interface JobStatusBase {
  schemaVersion: SchemaVersion;
  jobId: JobId;
  idempotencyKey: IdempotencyKey;
  progress: {
    ratio: number;
    stage: string;
    message?: string;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  eventCount?: number;
}

/**
 * State-discriminated JobStatus. SUCCEEDED requires manifestId; FAILED requires
 * error; CANCELLED requires cancelRequested=true; active states forbid terminal fields.
 * Branches are derived from job-status.schema.json allOf rules at generation time.
 */
export type JobStatus =
${jobStatusUnion};

/**
 * Type-discriminated JobEvent payloads.
 * Variants are derived from job-event.schema.json; prohibited fields are \`never\`.
 */
export type JobEvent =
${jobEventUnion};

export interface LayerPass {
  id: string;
  name: string;
  order: number;
  kind: PassKind;
  editable: true;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  asset: VerifiedAssetRef;
  mask?: {
    asset: VerifiedAssetRef;
    inverted?: boolean;
    density?: number;
  };
  adjustments?: PassAdjustments;
}

export interface LayerManifest {
  schemaVersion: SchemaVersion;
  manifestId: ManifestId;
  jobId: JobId;
  createdAt: string;
  canvas: NormalizedCanvas;
  protectedSource: {
    layerStableId: string;
    documentStableId?: string;
    immutable: true;
    untouched: true;
  };
  groupName?: string;
  passes: [LayerPass, ...LayerPass[]];
  assets: Array<{
    assetId: AssetId;
    digest: Digest;
    mediaType: MediaType;
    purpose: AssetPurpose;
    verified: true;
    dimensions?: Dimensions;
  }>;
  importHints?: {
    singleHistoryState?: true;
    placeAboveProtectedSource?: boolean;
    rollbackOnAnyFailure?: true;
  };
}

export type ContractDocument =
  | EffectSpec
  | AssetDescriptor
  | JobRequest
  | JobStatus
  | JobEvent
  | LayerManifest;

export interface ContractsPackageMeta {
  schemaVersion: SchemaVersion;
  documents: [
    "EffectSpec",
    "AssetDescriptor",
    "JobRequest",
    "JobStatus",
    "JobEvent",
    "LayerManifest",
  ];
  mockEndpoints: [
    "POST /v1/assets",
    "POST /v1/jobs",
    "GET /v1/jobs/{id}",
    "GET /v1/jobs/{id}/events",
    "POST /v1/jobs/{id}/cancel",
    "GET /v1/jobs/{id}/manifest",
  ];
}
`;
}

/**
 * Read-only verification helpers for tests.
 * Deliberately perturbing schema discriminants must make derivation throw.
 */
export function assertJobStatusSchemaCoverage(jobStatusSchema, jobStates, activeStates) {
  return deriveJobStatusBranches(jobStatusSchema, jobStates, activeStates);
}

export function assertJobEventSchemaCoverage(
  jobEventSchema,
  eventTypes,
  jobStates,
  activeStates,
) {
  return deriveJobEventBranches(jobEventSchema, eventTypes, jobStates, activeStates);
}

export function buildMetaJson() {
  return `${JSON.stringify(
    {
      schemaVersion: "1.0.0",
      generatedAt: "build-time",
      documents: [
        "EffectSpec",
        "AssetDescriptor",
        "JobRequest",
        "JobStatus",
        "JobEvent",
        "LayerManifest",
      ],
      mockEndpoints: [
        "POST /v1/assets",
        "POST /v1/jobs",
        "GET /v1/jobs/{id}",
        "GET /v1/jobs/{id}/events",
        "POST /v1/jobs/{id}/cancel",
        "GET /v1/jobs/{id}/manifest",
      ],
      typeGenerator: "schema-driven",
    },
    null,
    2,
  )}\n`;
}

async function writeIfChanged(absolutePath, content) {
  let existing = null;
  try {
    existing = await readFile(absolutePath, "utf8");
  } catch {
    existing = null;
  }
  if (existing === content) {
    return false;
  }
  await writeFile(absolutePath, content);
  return true;
}

export async function generateTypesArtifacts({ write = true } = {}) {
  const typesText = await buildGeneratedTypesText();
  const metaText = buildMetaJson();
  const generatedDir = path.join(packageRoot, "generated");
  const typesPath = path.join(generatedDir, "types.d.ts");
  const metaPath = path.join(generatedDir, "meta.json");

  if (!write) {
    return { typesText, metaText, typesPath, metaPath, wrote: false };
  }

  await mkdir(generatedDir, { recursive: true });
  const wroteTypes = await writeIfChanged(typesPath, typesText);
  const wroteMeta = await writeIfChanged(metaPath, metaText);
  return {
    typesText,
    metaText,
    typesPath,
    metaPath,
    wrote: wroteTypes || wroteMeta,
  };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const result = await generateTypesArtifacts({ write: true });
  console.log(
    result.wrote
      ? `Generated ${path.relative(packageRoot, result.typesPath)} and meta.json`
      : "Generated artifacts already up to date",
  );
}

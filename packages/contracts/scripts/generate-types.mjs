/**
 * Schema-driven TypeScript type generator for @cinevfx/contracts.
 * Reads packages/contracts/schemas/*.schema.json and emits discriminated types.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./catalog.mjs";

const SCHEMA_DIR = path.join(packageRoot, "schemas");

async function loadJson(fileName) {
  return JSON.parse(await readFile(path.join(SCHEMA_DIR, fileName), "utf8"));
}

function unionFromEnum(values) {
  return values.map((value) => JSON.stringify(value)).join(" | ");
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
    ["job-event", jobEvent],
    ["layer-manifest", layerManifest],
  ]) {
    if (schema.type !== "object" || !schema.properties) {
      throw new Error(`Schema ${name} is not a document object`);
    }
  }

  const schemaDerivedComment = [
    `// schema-derived enums: JobState=${jobStates.length}`,
    `EventType=${eventTypes.length}`,
    `PrimitiveKind=${primitiveKind.length}`,
    `PassKind=${passKind.length}`,
    `AssetPurpose=${purposes.length}`,
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
 */
export type JobStatus =
  | (JobStatusBase & {
      state: "CREATED";
      cancelRequested: false;
      progress: { ratio: 0; stage: string; message?: string };
      finishedAt?: never;
      error?: never;
      manifestId?: never;
    })
  | (JobStatusBase & {
      state: Exclude<ActiveJobState, "CREATED">;
      cancelRequested: boolean;
      finishedAt?: never;
      error?: never;
      manifestId?: never;
    })
  | (JobStatusBase & {
      state: "SUCCEEDED";
      cancelRequested: false;
      progress: { ratio: 1; stage: string; message?: string };
      finishedAt: string;
      manifestId: ManifestId;
      error?: never;
    })
  | (JobStatusBase & {
      state: "FAILED";
      cancelRequested: false;
      finishedAt: string;
      error: ErrorObject;
      manifestId?: never;
    })
  | (JobStatusBase & {
      state: "CANCELLED";
      cancelRequested: true;
      finishedAt: string;
      error?: never;
      manifestId?: never;
    })
  | (JobStatusBase & {
      state: "EXPIRED";
      cancelRequested: false;
      finishedAt: string;
      error?: never;
      manifestId?: never;
    });

/**
 * Type-discriminated JobEvent payloads.
 */
export type JobEvent =
  | {
      schemaVersion: SchemaVersion;
      eventId: EventId;
      jobId: JobId;
      sequence: number;
      type: "state_changed";
      state: JobState;
      timestamp: string;
      message?: string;
      progress?: never;
      error?: never;
      assetRef?: never;
      manifestId?: never;
    }
  | {
      schemaVersion: SchemaVersion;
      eventId: EventId;
      jobId: JobId;
      sequence: number;
      type: "progress";
      state: ActiveJobState;
      timestamp: string;
      progress: { ratio: number; stage?: string };
      message?: string;
      error?: never;
      assetRef?: never;
      manifestId?: never;
    }
  | {
      schemaVersion: SchemaVersion;
      eventId: EventId;
      jobId: JobId;
      sequence: number;
      type: "asset_ready";
      state: ActiveJobState;
      timestamp: string;
      assetRef: VerifiedAssetRef;
      message?: string;
      progress?: never;
      error?: never;
      manifestId?: never;
    }
  | {
      schemaVersion: SchemaVersion;
      eventId: EventId;
      jobId: JobId;
      sequence: number;
      type: "manifest_ready";
      state: "SUCCEEDED";
      timestamp: string;
      manifestId: ManifestId;
      message?: string;
      progress?: never;
      error?: never;
      assetRef?: never;
    }
  | {
      schemaVersion: SchemaVersion;
      eventId: EventId;
      jobId: JobId;
      sequence: number;
      type: "cancel_accepted";
      state: "CANCELLED";
      timestamp: string;
      message?: string;
      progress?: never;
      error?: never;
      assetRef?: never;
      manifestId?: never;
    }
  | {
      schemaVersion: SchemaVersion;
      eventId: EventId;
      jobId: JobId;
      sequence: number;
      type: "error";
      state: "FAILED";
      timestamp: string;
      error: ErrorObject;
      message?: string;
      progress?: never;
      assetRef?: never;
      manifestId?: never;
    };

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

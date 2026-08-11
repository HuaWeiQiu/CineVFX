/**
 * Generated TypeScript contract types for @cinevfx/contracts.
 * Source of truth: packages/contracts/schemas/*.schema.json
 * Do not edit by hand; regenerate with `pnpm --dir packages/contracts build`.
 * // schema-derived enums: JobState=11 EventType=6 PrimitiveKind=6 PassKind=7 AssetPurpose=6
 */

export type SchemaVersion = "1.0.0";

export type MediaType = "image/png" | "image/jpeg" | "image/webp" | "application/json";
export type AlphaMode = "none" | "opaque" | "straight" | "premultiplied";
export type AssetPurpose = "proxy" | "mask" | "effect_reference" | "guidance" | "pass" | "metadata";
export type ColorSpace = "srgb" | "display-p3" | "adobe-rgb";

export type JobState = "CREATED" | "VALIDATING" | "QUEUED" | "PREPROCESSING" | "RENDERING" | "POSTPROCESSING" | "EXPORTING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";
export type ActiveJobState = "CREATED" | "VALIDATING" | "QUEUED" | "PREPROCESSING" | "RENDERING" | "POSTPROCESSING" | "EXPORTING";
export type TerminalJobState = "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "soft_light" | "hard_light" | "color_dodge" | "color_burn" | "darken" | "lighten" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity" | "linear_dodge" | "linear_burn";
export type PrimitiveKind = "curve" | "particle" | "volume" | "sprite" | "surface" | "lens";
export type PassKind = "effect" | "relight" | "atmosphere" | "grade" | "bloom" | "mask" | "utility";
export type JobEventType = "state_changed" | "progress" | "asset_ready" | "manifest_ready" | "cancel_accepted" | "error";

export type Digest = `sha256:${string}`;
export type AssetId = `asset_${string}`;
export type JobId = `job_${string}`;
export type IdempotencyKey = `idem_${string}`;
export type ManifestId = `manifest_${string}`;
export type EventId = `evt_${string}`;

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
  sourceRole?: "user_proxy" | "user_mask" | "user_effect_reference" | "generated_pass" | "system_metadata";
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
    operationsForbidden: Array<"modify_pixels" | "move" | "transform" | "resize" | "replace" | "warp" | "delete">;
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

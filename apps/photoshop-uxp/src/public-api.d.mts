export {
  createCinevfxClient,
  CinevfxApiError,
  type CinevfxHttpClient,
  type CreateClientOptions,
  type AssetDescriptor,
  type JobRequest,
  type JobStatus,
  type JobEvent,
  type JobEventsResponse,
  type LayerManifest,
  type EffectSpec,
  type MediaType,
  type AlphaMode,
  type ColorSpace,
  type BlendMode,
  type ForbiddenSourceOp,
  type ApiError,
} from "./client/http-client.mjs";

import type {
  AssetDescriptor,
  CinevfxHttpClient,
  CreateClientOptions,
  JobRequest,
} from "./client/http-client.mjs";

export type TaskState =
  | "idle"
  | "planning_proxy"
  | "submitting"
  | "polling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "import_planned";

export interface TaskSnapshot {
  state: TaskState;
  jobId: string | null;
  manifestId: string | null;
  progress: { ratio: number; stage: string; message?: string };
  lastError: { code?: string; message: string } | null;
  effectLabel: string;
  cancelRequested: boolean;
  proxyPlan: unknown | null;
  importPlan: unknown | null;
  updatedAt: string;
}

export interface TaskController {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  beginProxyPlanning(plan: unknown): TaskSnapshot;
  finishProxyPlanning(): TaskSnapshot;
  beginSubmit(options?: { effectLabel?: string }): TaskSnapshot;
  markPolling(info: { jobId: string; progress?: TaskSnapshot["progress"] }): TaskSnapshot;
  updateProgress(progress: TaskSnapshot["progress"]): TaskSnapshot;
  markSucceeded(info: { jobId: string; manifestId: string }): TaskSnapshot;
  markFailed(error: { code?: string; message: string }): TaskSnapshot;
  markCancelRequested(): TaskSnapshot;
  markCancelled(): TaskSnapshot;
  markImportPlanned(plan: unknown): TaskSnapshot;
  reset(): TaskSnapshot;
}

export const TASK_STATES: Readonly<Record<string, TaskState>>;
export function createTaskController(seed?: Partial<TaskSnapshot>): TaskController;

export interface ProtectedSourceRef {
  layerStableId: string;
  documentStableId?: string;
  name?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ProxyPlanInput {
  maxEdge?: number;
  colorSpace?: "srgb" | "display-p3" | "adobe-rgb";
  effectLabel?: string;
  effectLayer?: ProtectedSourceRef;
  subjectMaskLayer?: ProtectedSourceRef;
  guidanceAnchors?: Array<{
    id: string;
    point: { x: number; y: number };
    radius?: number;
  }>;
  seed?: number;
}

export function planProxyExport(
  protectedSource: ProtectedSourceRef,
  input?: ProxyPlanInput,
): Record<string, unknown>;

export interface ValidationError {
  path: string;
  message: string;
}

export function validateLayerManifest(manifest: unknown): {
  valid: boolean;
  errors: ValidationError[];
};

export interface ManifestImportPlanResult {
  ok: boolean;
  errors: ValidationError[];
  plan: Record<string, unknown> | null;
}

export function planManifestImport(
  manifest: unknown,
  protectedSource: ProtectedSourceRef,
  options?: { expectedJobId?: string; expectedManifestId?: string },
): ManifestImportPlanResult;
export function simulateImportPlanExecution(
  plan: Record<string, unknown>,
  options?: { failAtPassId?: string },
): Record<string, unknown>;

export interface WriteScopeGuard {
  getScope(): "outside" | "inside_modal";
  assertNetworkAllowed(): void;
  isNetworkActive(): boolean;
  runOutsideWrites<T>(operation: () => Promise<T> | T): Promise<T>;
  runInsideWrites<T>(operation: (context: {
    assertNoNetwork(): never;
  }) => Promise<T> | T): Promise<T>;
  planModalTransaction<T>(operation: (context: {
    assertNoNetwork(): never;
  }) => Promise<T> | T): Promise<{
    planned: true;
    result: T;
  }>;
}

export function createWriteScopeGuard(): WriteScopeGuard;
export function assertNetworkOutsideWrites(plan: unknown): true;

export interface GlowContext {
  documentId: number;
  sourceLayerId: number;
  documentMode: "rgb";
  bitsPerChannel: 8 | 16;
  layerKind: "pixel" | "smartObject";
  visible: true;
  bounds: { x: number; y: number; width: number; height: number };
  sourceSnapshot: { documentId: number; sourceLayerId: number };
}

export interface GlowSettings {
  recipeId?: "soft_glow";
  color: string;
  intensity: number;
  size: number;
  blur: number;
  blendMode: "screen" | "linearDodge";
}

export interface GlowPlan {
  readonly kind: "local_glow_plan";
  readonly recipeId: "soft_glow";
  readonly source: Readonly<GlowContext & {
    immutable: true;
    operationsForbidden: readonly string[];
  }>;
  readonly settings: Readonly<GlowSettings & {
    recipeId?: never;
    rgb: { red: number; green: number; blue: number };
    outerOpacity: number;
    bloomOpacity: number;
  }>;
  readonly names: Readonly<{ group: string; edge: string; bloom: string }>;
  readonly transaction: Readonly<{
    mode: "single_history_state";
    historyName: string;
    rollbackOnAnyFailure: true;
    noPartialGroup: true;
    allowsNetwork: false;
  }>;
  readonly memory: Readonly<{
    pixelWidth: number;
    pixelHeight: number;
    pixelCount: number;
    estimatedPeakBytes: number;
    hardLimitBytes: number;
    surfaces: number;
    componentsPerPixel: number;
    bytesPerComponent: number;
    calculatedWith: "bigint";
  }>;
}

export function planGlowEffect(
  context: GlowContext,
  settings: GlowSettings,
): GlowPlan;

export class GlowPlanError extends Error {
  constructor(code: string);
  readonly code: string;
}

export interface GlowHostResult {
  committed: true;
  documentId: number;
  sourceLayerId: number;
  groupLayerId: number;
  edgeLayerId: number;
  bloomLayerId: number;
}

export interface PhotoshopGlowHost {
  inspectActiveContext(): GlowContext;
  inspectSelectedLayer(): GlowContext;
  applyGlow(plan: GlowPlan): Promise<GlowHostResult>;
}

export class GlowHostError extends Error {
  constructor(code: string, stage: string);
  readonly code: string;
  readonly stage: string;
}

export function createPhotoshopGlowHost(options?: {
  loadPhotoshop?: () => unknown;
}): PhotoshopGlowHost;

export interface LocalGlowService {
  inspect(): Promise<Readonly<GlowPlan["source"]>>;
  apply(settings: GlowSettings): Promise<Readonly<{
    plan: GlowPlan;
    hostResult: GlowHostResult | null;
  }>>;
}

export function createLocalGlowService(dependencies: {
  host: PhotoshopGlowHost;
  writeGuard: WriteScopeGuard;
}): LocalGlowService;

export function redactValue(value: unknown, depth?: number): unknown;
export function redactString(text: string): string;
export function formatSafeLog(message: string, fields?: Record<string, unknown>): string;
export function createSafeLogger(options?: { write?: (line: string) => void }): {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  lines(): string[];
};

export const SCHEMA_VERSION: "1.0.0";
export const DEFAULT_BASE_URL: "https://localhost:8787";
export const DEV_PLUGIN_ID: "com.cinevfx.dev.shell";
export const MOCK_ENDPOINTS: readonly string[];
export const FORBIDDEN_SOURCE_OPS: readonly string[];
export const UNVERIFIED: Readonly<Record<string, true>>;

export interface PanelDocument {
  getElementById(id: string): unknown;
}

export function createPanelController(task: TaskController, options?: {
  document?: PanelDocument;
  log?: (line: string) => void;
}): {
  appendLog(message: string, fields?: Record<string, unknown>): void;
  render(snapshot: TaskSnapshot): void;
  getLogLines(): string[];
  dispose(): void;
};

export function createPanelWorkflow(deps: {
  task: TaskController;
  writeGuard: WriteScopeGuard;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  createClient?: (options: CreateClientOptions) => CinevfxHttpClient;
  pollIntervalMs?: number;
  maxPolls?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): {
  planProxy(source: ProtectedSourceRef, options?: ProxyPlanInput): Record<string, unknown>;
  submitJob(input: PanelWorkflowSubmitInput): Promise<TaskSnapshot>;
  cancelActiveJob(input: { baseUrl: string }): Promise<TaskSnapshot>;
  planImport(input: {
    baseUrl: string;
    protectedSource: ProtectedSourceRef;
    manifest?: unknown;
  }): Promise<ManifestImportPlanResult>;
  getLastValidatedManifest(): unknown | null;
};

export interface PanelWorkflowSubmitInput {
  baseUrl: string;
  effectLabel: string;
  protectedSource: ProtectedSourceRef;
  proxyPlan?: Record<string, unknown>;
  assetDescriptors?: AssetDescriptor[];
  jobRequest?: JobRequest;
}

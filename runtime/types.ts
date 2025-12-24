import type { PrefetchHandle } from "./actuators.ts";

export type Rect = { x: number; y: number; w: number; h: number };

export type IslandKey = number; // packed token numeric identity
export type TypeId = number;
export type PropsId = number;

export const enum IslandFlags {
  PrefetchSafe = 1 << 0, // safe to prefetch chunk
  HydrateOnEventOnly = 1 << 1, // default qwik-like behavior
  Critical = 1 << 2, // harder to SKIP
  NavLike = 1 << 3, // may have navUrl inside props
}

export type IslandHandle = {
  el: HTMLElement;
  key: IslandKey;
  typeId: TypeId;
  propsId: PropsId;
  flags: number;
  rect: Rect;
};

export type IslandKind = "component" | "nav-link" | "form" | "critical";

export type IslandTypeDef = {
  typeId: TypeId;
  name: string;

  // how to load interactivity
  entry: string; // import URL (chunk)
  exportName?: string; // optional named export

  kind: IslandKind;

  // policy hints (mostly per-type)
  defaultFlags: number;

  // cost/benefit hints (per-type; scheduler/policy use these)
  estBytes: number;
  estCpuMs: number;
  estBenefitMs: number;

  // optional: if nav-like, how to read url from props
  // e.g. "href" or "url"
  navProp?: string;
};

export type IslandsRegistry = {
  version: number;
  types: Record<number, IslandTypeDef>;
};

export type PropsPool = unknown[]; // propsId indexes into this pool

export type Candidate = { key: IslandKey; rect: Rect };

export type ScoredTarget = {
  key: IslandKey;
  score: number;
  d2: number; // distance^2 to nearest point on rect (for ETA/utility heuristics)
};

export type Selection = {
  key: IslandKey | null;
  score: number;

  bestKey: IslandKey | null;
  bestScore: number;
  secondScore: number;
  margin2nd: number;

  nearestKey: IslandKey | null;
  nearestD2: number;

  // cheap kinematic hint for policy (px/ms)
  speed: number;

  // stable enough signal (NOT "prefetch now" by itself)
  actuate: boolean;

  pendingKey: IslandKey | null;
  pendingCount: number;

  // top-N scored candidates for policy/utility (already sorted desc)
  top: ScoredTarget[];
};

// Re-export from utils for backward compatibility
export type {
  NavigatorWithConnectionAPI as NavigatorWithConnection,
  NetworkInformationConnection as NetworkInformation,
} from "./utils.ts";

// ============================================================================
// Shared Config Types
// ============================================================================

export type LedgerConfig = {
  readonly emaAlpha: number;
  readonly minPrior: number;
  readonly maxPrior: number;
};

export type PressureConfig = {
  readonly longTaskWindowMs: number;
  readonly longTaskBudgetMs: number;
};

export type SchedulerConfig = {
  readonly maxInflightFetch: number;
  readonly maxBytesInFlight: number;
  readonly prefetchTTLms: number;
  readonly falsePositiveCooldownMs: number;
  readonly assumeReadyDelayMs: number;
  readonly allowEarlyHydrate: boolean;
  readonly maxAssumeReadyDelayMs: number;
  readonly dispatchScanLimit: number;
};

export type ActuatorConfig = {
  readonly useModulePreload: boolean;
  readonly useFetchPrefetch: boolean;
};

// ============================================================================
// Shared Geometry & Math Types
// ============================================================================

export type DerivedConfig = {
  readonly [key: string]: number | boolean;
};

// ============================================================================
// State Types - Numeric IDs for bundle size & comparison speed
// ============================================================================

/** Numeric state IDs (faster comparisons, smaller bundle than string literals) */
export const enum IslandSt {
  Idle = 0,
  Prefetching = 1,
  Prefetched = 2,
  Hydrating = 3,
  Hydrated = 4,
}

// deno-fmt-ignore
export type IslandState =
  | { st: IslandSt.Idle; lastActionTs: number; cooldownUntil: number }
  | { st: IslandSt.Prefetching; startedTs: number; bytes: number; readyDelayMs: number; handle: PrefetchHandle | null }
  | { st: IslandSt.Prefetched; readyTs: number; expiresTs: number }
  | { st: IslandSt.Hydrating; startedTs: number }
  | { st: IslandSt.Hydrated; readyTs: number };

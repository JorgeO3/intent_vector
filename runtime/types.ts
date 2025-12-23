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

export type NetworkInformation = {
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  rtt?: number;
  downlink?: number;
  saveData?: boolean;
};

export type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformation;
};

import type { IslandKey, IslandsRegistry, Selection } from "./types.ts";
import { IslandFlags } from "./types.ts";
import type { PressureSignals } from "./pressure.ts";
import type { ReputationLedger } from "./reputationLedger.ts";
import { decodeKey } from "./keyCodec.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type UtilityGateConfig = {
  readonly sigmaSkip: number;
  readonly minMargin: number;
  readonly maxTargets: number;
  readonly cpuSigmaGain: number;
  readonly netSigmaGain: number;
  readonly cpuNPFDrop: number;
  readonly netNPFDrop: number;
  readonly wNet: number;
  readonly wCpu: number;
  readonly etaModerateMs: number;
  readonly etaImmediateMs: number;
  readonly ultraScore: number;
  readonly ultraMargin: number;
  readonly ambiguityMargin: number;
};

export type Decision =
  | { action: "SKIP"; tier: 0; reason: string }
  | { action: "PREFETCH"; tier: 0 | 1; reason: string; targets: IslandKey[] }
  | { action: "HYDRATE"; tier: 1; reason: string; targets: IslandKey[] };

type ScoredCandidate = {
  readonly key: IslandKey;
  readonly score: number;
  readonly d2: number;
};

type RankedTarget = {
  readonly key: IslandKey;
  readonly p: number;
  readonly U: number;
  readonly d2: number;
  readonly estBytes: number;
  readonly estCpuMs: number;
  readonly estBenefitMs: number;
  readonly flags: number;
};

type DynamicThresholds = {
  readonly sigma: number;
  readonly maxPrefetchTargets: number;
  readonly minMargin: number;
};

type HydrateEligibility = {
  readonly canHydrate: boolean;
  readonly reason: string;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: UtilityGateConfig = {
  sigmaSkip: 0.02,
  minMargin: 0.04,
  maxTargets: 2,
  cpuSigmaGain: 0.06,
  netSigmaGain: 0.06,
  cpuNPFDrop: 1.0,
  netNPFDrop: 1.0,
  wNet: 0.00002, // 50KB -> ~1ms
  wCpu: 3.0, // 1 cpu-ms ~= 3ms budgeted
  etaModerateMs: 700,
  etaImmediateMs: 140,
  ultraScore: 0.55,
  ultraMargin: 0.18,
  ambiguityMargin: 0.06,
} as const;

const PRESSURE_WEIGHTS = {
  CPU_MARGIN: 0.06,
  NET_MARGIN: 0.04,
} as const;

const PRIOR_CLAMP = {
  MIN: 0.25,
  MAX: 4.0,
} as const;

const HYDRATE_THRESHOLDS = {
  MAX_CPU_PRESSURE: 0.4,
  MAX_NET_PRESSURE: 0.6,
} as const;

const MIN_SPEED = 1e-6;
const MIN_SCORE_SUM = 1e-12;
const MIN_UTILITY = 0;

// ============================================================================
// Utility Gate Class
// ============================================================================

export class UtilityGate {
  private config: UtilityGateConfig;

  constructor(config?: Partial<UtilityGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setConfig(config: Partial<UtilityGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  decide(
    selection: Selection,
    registry: IslandsRegistry,
    pressure: PressureSignals,
    ledger: ReputationLedger,
    routeId: string,
  ): Decision {
    // Early validation
    const validationResult = validateSelection(selection, registry);
    if (validationResult) return validationResult;

    // Compute dynamic thresholds
    const thresholds = computeDynamicThresholds(this.config, pressure);

    if (thresholds.maxPrefetchTargets <= 0) {
      return skipDecision("n_pf=0 (pressure)");
    }

    // Evidence gating
    const gatingResult = checkEvidenceGating(
      selection,
      thresholds,
    );
    if (gatingResult) return gatingResult;

    // Score and rank candidates
    const scored = scoreTopCandidates(
      selection,
      ledger,
      routeId,
      this.config.ambiguityMargin,
    );

    if (!scored.sum || scored.sum <= MIN_SCORE_SUM) {
      return skipDecision("no-signal");
    }

    // Rank by utility
    const ranked = rankCandidatesByUtility(
      scored.candidates,
      scored.sum,
      registry,
      this.config,
    );

    if (!ranked.length || ranked[0].U <= MIN_UTILITY) {
      return skipDecision("utility<=0");
    }

    // Compute ETA
    const eta = computeETA(ranked[0].d2, selection.speed);

    // Determine tier
    const tier = determineTier(eta, pressure, this.config);

    // Check for ultra-confident early hydrate
    const hydrateCheck = checkHydrateEligibility(
      selection,
      ranked[0],
      tier,
      eta,
      pressure,
      this.config,
    );

    if (hydrateCheck.canHydrate) {
      return {
        action: "HYDRATE",
        tier: 1,
        targets: [ranked[0].key],
        reason: hydrateCheck.reason,
      };
    }

    // Select prefetch targets
    const targets = selectPrefetchTargets(
      ranked,
      thresholds.maxPrefetchTargets,
    );

    if (!targets.length) {
      return skipDecision("no-positive-targets");
    }

    return {
      action: "PREFETCH",
      tier,
      targets,
      reason: "utility-positive",
    };
  }
}

// ============================================================================
// Decision Helpers
// ============================================================================

function skipDecision(reason: string): Decision {
  return { action: "SKIP", tier: 0, reason };
}

// ============================================================================
// Validation
// ============================================================================

function validateSelection(
  selection: Selection,
  registry: IslandsRegistry,
): Decision | null {
  if (selection.bestKey == null) {
    return skipDecision("no-candidates");
  }

  const best = decodeKey(selection.bestKey);
  const bestType = registry.types[best.typeId];

  if (!bestType) {
    return skipDecision("unknown-type");
  }

  const bestFlags = combineFlags(best.flags, bestType.defaultFlags);

  if (!isPrefetchSafe(bestFlags)) {
    return skipDecision("winner-not-prefetch-safe");
  }

  return null;
}

// ============================================================================
// Dynamic Thresholds
// ============================================================================

function computeDynamicThresholds(
  config: UtilityGateConfig,
  pressure: PressureSignals,
): DynamicThresholds {
  const sigma = config.sigmaSkip +
    config.cpuSigmaGain * pressure.cpuPressure +
    config.netSigmaGain * pressure.netPressure;

  const maxPrefetchTargets = clamp(
    Math.round(
      config.maxTargets -
        config.cpuNPFDrop * pressure.cpuPressure -
        config.netNPFDrop * pressure.netPressure,
    ),
    0,
    config.maxTargets,
  );

  const minMargin = config.minMargin +
    PRESSURE_WEIGHTS.CPU_MARGIN * pressure.cpuPressure +
    PRESSURE_WEIGHTS.NET_MARGIN * pressure.netPressure;

  return { sigma, maxPrefetchTargets, minMargin };
}

// ============================================================================
// Evidence Gating
// ============================================================================

function checkEvidenceGating(
  selection: Selection,
  thresholds: DynamicThresholds,
): Decision | null {
  if (!selection.actuate) {
    return skipDecision("unstable-signal");
  }

  if (selection.bestScore < thresholds.sigma) {
    return skipDecision("below-sigma");
  }

  if (selection.margin2nd < thresholds.minMargin) {
    return skipDecision("ambiguous");
  }

  return null;
}

// ============================================================================
// Candidate Scoring
// ============================================================================

function scoreTopCandidates(
  selection: Selection,
  ledger: ReputationLedger,
  routeId: string,
  ambiguityMargin: number,
): { candidates: ScoredCandidate[]; sum: number } {
  const isAmbiguous = selection.margin2nd <= ambiguityMargin;
  let sum = 0;

  const candidates = selection.top.map((candidate) => {
    let score = Math.max(0, candidate.score);

    if (isAmbiguous) {
      const prior = ledger.prior(routeId, createIslandId(candidate.key));
      score *= clamp(prior, PRIOR_CLAMP.MIN, PRIOR_CLAMP.MAX);
    }

    sum += score;

    return {
      key: candidate.key,
      score,
      d2: candidate.d2,
    };
  });

  return { candidates, sum };
}

// ============================================================================
// Utility Ranking
// ============================================================================

function rankCandidatesByUtility(
  candidates: ScoredCandidate[],
  totalScore: number,
  registry: IslandsRegistry,
  config: UtilityGateConfig,
): RankedTarget[] {
  const ranked: RankedTarget[] = [];

  for (const candidate of candidates) {
    const decoded = decodeKey(candidate.key);
    const type = registry.types[decoded.typeId];

    if (!type) continue;

    const flags = combineFlags(decoded.flags, type.defaultFlags);

    if (!isPrefetchSafe(flags)) continue;

    const probability = candidate.score / totalScore;
    const utility = computeUtility(type, probability, config);

    ranked.push({
      key: candidate.key,
      p: probability,
      U: utility,
      d2: candidate.d2,
      estBytes: Math.max(0, type.estBytes | 0),
      estCpuMs: Math.max(0, type.estCpuMs),
      estBenefitMs: Math.max(0, type.estBenefitMs),
      flags,
    });
  }

  return ranked.sort((a, b) => b.U - a.U);
}

function computeUtility(
  type: { estBytes: number; estCpuMs: number; estBenefitMs: number },
  probability: number,
  config: UtilityGateConfig,
): number {
  const cost = config.wNet * type.estBytes + config.wCpu * type.estCpuMs;
  const benefit = probability * type.estBenefitMs;
  return benefit - cost;
}

// ============================================================================
// ETA Computation
// ============================================================================

function computeETA(d2: number, speed: number): number {
  const distance = Math.sqrt(Math.max(0, d2));
  const safeSpeed = Math.max(MIN_SPEED, speed);
  return distance / safeSpeed;
}

// ============================================================================
// Tier Determination
// ============================================================================

function determineTier(
  etaMs: number,
  pressure: PressureSignals,
  config: UtilityGateConfig,
): 0 | 1 {
  if (pressure.saveData) return 0;
  if (etaMs <= config.etaModerateMs) return 1;
  return 0;
}

// ============================================================================
// Hydrate Eligibility
// ============================================================================

function checkHydrateEligibility(
  selection: Selection,
  topTarget: RankedTarget,
  tier: 0 | 1,
  etaMs: number,
  pressure: PressureSignals,
  config: UtilityGateConfig,
): HydrateEligibility {
  if (tier !== 1) {
    return { canHydrate: false, reason: "tier-0" };
  }

  if (isHydrateBlocked(topTarget.flags)) {
    return { canHydrate: false, reason: "flag-blocked" };
  }

  const isWinner = selection.key != null && topTarget.key === selection.key;
  if (!isWinner) {
    return { canHydrate: false, reason: "not-winner" };
  }

  if (!meetsUltraThresholds(selection, etaMs, pressure, config)) {
    return { canHydrate: false, reason: "thresholds-not-met" };
  }

  return { canHydrate: true, reason: "ultra-clear" };
}

function meetsUltraThresholds(
  selection: Selection,
  etaMs: number,
  pressure: PressureSignals,
  config: UtilityGateConfig,
): boolean {
  return (
    selection.bestScore >= config.ultraScore &&
    selection.margin2nd >= config.ultraMargin &&
    etaMs <= config.etaImmediateMs &&
    pressure.cpuPressure < HYDRATE_THRESHOLDS.MAX_CPU_PRESSURE &&
    pressure.netPressure < HYDRATE_THRESHOLDS.MAX_NET_PRESSURE
  );
}

// ============================================================================
// Target Selection
// ============================================================================

function selectPrefetchTargets(
  ranked: RankedTarget[],
  maxTargets: number,
): IslandKey[] {
  const targets: IslandKey[] = [];

  for (const target of ranked) {
    if (targets.length >= maxTargets) break;
    if (target.U <= MIN_UTILITY) break;
    targets.push(target.key);
  }

  return targets;
}

// ============================================================================
// Utility Functions
// ============================================================================

function combineFlags(instanceFlags: number, defaultFlags: number): number {
  return (instanceFlags | (defaultFlags | 0)) | 0;
}

function isPrefetchSafe(flags: number): boolean {
  return (flags & IslandFlags.PrefetchSafe) !== 0;
}

function isHydrateBlocked(flags: number): boolean {
  return (flags & IslandFlags.HydrateOnEventOnly) !== 0;
}

function createIslandId(key: IslandKey): string {
  return key.toString(36);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

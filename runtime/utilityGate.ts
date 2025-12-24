// runtime/utilityGate.ts

import type { IslandKey, IslandsRegistry, Selection } from "./types.ts";
import { IslandFlags } from "./types.ts";
import type { PressureSignals } from "./pressure.ts";
import type { ReputationLedger } from "./reputationLedger.ts";
import { decodeKey } from "./keyCodec.ts";
import { clamp, clamp01, clampInt, createIslandId } from "./utils.ts";

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

type DerivedConfig = {
  readonly wNetBytes: number;
  readonly wCpuMs: number;
  readonly cpuMargin: number;
  readonly netMargin: number;
  readonly priorMin: number;
  readonly priorMax: number;
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

// Pre-allocated response objects to avoid allocations in hot path
const HYDRATE_RESPONSES = {
  TIER_0: { canHydrate: false, reason: "tier-0" } as const,
  FLAG_BLOCKED: { canHydrate: false, reason: "flag-blocked" } as const,
  NOT_WINNER: { canHydrate: false, reason: "not-winner" } as const,
  THRESHOLDS_NOT_MET: {
    canHydrate: false,
    reason: "thresholds-not-met",
  } as const,
  ULTRA_CLEAR: { canHydrate: true, reason: "ultra-clear" } as const,
} as const;

// ============================================================================
// Utility Gate Class
// ============================================================================

export class UtilityGate {
  private config: UtilityGateConfig;
  private derived: DerivedConfig;

  // Reusable buffers to minimize allocations
  private readonly scoredBuffer: ScoredCandidate[] = [];
  private readonly rankedBuffer: RankedTarget[] = [];

  constructor(config?: Partial<UtilityGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.derived = computeDerivedConfig(this.config);
  }

  setConfig(config: Partial<UtilityGateConfig>): void {
    this.config = { ...this.config, ...config };
    this.derived = computeDerivedConfig(this.config);
  }

  /**
   * Main decision-making entry point.
   * Evaluates selection and returns prefetch/hydrate/skip decision.
   */
  decide(
    selection: Selection,
    registry: IslandsRegistry,
    pressure: PressureSignals,
    ledger: ReputationLedger,
    routeId: string,
  ): Decision {
    // Early validation
    const validation = this.validateSelection(selection, registry);
    if (validation) return validation;

    // Compute dynamic thresholds based on pressure
    const thresholds = this.computeDynamicThresholds(pressure);

    // Check if pressure allows any prefetching
    if (thresholds.maxPrefetchTargets <= 0) {
      return SKIP_DECISIONS.PRESSURE;
    }

    // Evidence gating (actuate, score, margin checks)
    const gate = this.checkEvidenceGating(selection, thresholds);
    if (gate) return gate;

    // Score candidates with reputation weighting
    const scoreResult = this.scoreTopCandidates(selection, ledger, routeId);
    if (scoreResult.sum <= MIN_SCORE_SUM) {
      return SKIP_DECISIONS.NO_SIGNAL;
    }

    // Rank by utility (benefit - cost)
    const rankCount = this.rankCandidatesByUtility(
      scoreResult.candidates,
      scoreResult.sum,
      scoreResult.count,
      registry,
    );

    if (rankCount === 0 || this.rankedBuffer[0].U <= MIN_UTILITY) {
      return SKIP_DECISIONS.UTILITY_ZERO;
    }

    const topTarget = this.rankedBuffer[0];

    // Compute ETA (estimated time to arrival)
    const etaMs = computeETA(topTarget.d2, selection.speed);

    // Determine tier (urgency)
    const tier = determineTier(etaMs, pressure, this.config);

    // Check for ultra-confident early hydrate
    const hydrateCheck = this.checkHydrateEligibility(
      selection,
      topTarget,
      tier,
      etaMs,
      pressure,
    );

    if (hydrateCheck.canHydrate) {
      return {
        action: "HYDRATE",
        tier: 1,
        targets: [topTarget.key],
        reason: hydrateCheck.reason,
      };
    }

    // Select prefetch targets with positive utility
    const targets = this.selectPrefetchTargets(
      rankCount,
      thresholds.maxPrefetchTargets,
    );

    if (targets.length === 0) {
      return SKIP_DECISIONS.NO_TARGETS;
    }

    return {
      action: "PREFETCH",
      tier,
      targets,
      reason: "utility-positive",
    };
  }

  // ========================================================================
  // Private - Validation
  // ========================================================================

  private validateSelection(
    selection: Selection,
    registry: IslandsRegistry,
  ): Decision | null {
    if (selection.bestKey === null) return SKIP_DECISIONS.NO_CANDIDATES;

    const best = decodeKey(selection.bestKey);
    const bestType = registry.types[best.typeId];

    if (!bestType) return SKIP_DECISIONS.UNKNOWN_TYPE;

    const flags = best.flags | (bestType.defaultFlags | 0);

    if ((flags & IslandFlags.PrefetchSafe) === 0) {
      return SKIP_DECISIONS.NOT_PREFETCH_SAFE;
    }

    return null;
  }

  // ========================================================================
  // Private - Dynamic Thresholds
  // ========================================================================

  private computeDynamicThresholds(
    pressure: PressureSignals,
  ): DynamicThresholds {
    const cpuPressure = pressure.cpuPressure;
    const netPressure = pressure.netPressure;

    // Sigma: score threshold increases with pressure
    const sigma = clamp01(
      this.config.sigmaSkip +
        this.config.cpuSigmaGain * cpuPressure +
        this.config.netSigmaGain * netPressure,
    );

    // Max targets: decreases with pressure
    const maxPrefetchTargets = clampInt(
      Math.round(
        this.config.maxTargets -
          this.config.cpuNPFDrop * cpuPressure -
          this.config.netNPFDrop * netPressure,
      ),
      0,
      this.config.maxTargets,
    );

    // Min margin: increases with pressure
    const minMargin = clamp01(
      this.config.minMargin +
        this.derived.cpuMargin * cpuPressure +
        this.derived.netMargin * netPressure,
    );

    return { sigma, maxPrefetchTargets, minMargin };
  }

  // ========================================================================
  // Private - Evidence Gating
  // ========================================================================

  private checkEvidenceGating(
    selection: Selection,
    thresholds: DynamicThresholds,
  ): Decision | null {
    if (!selection.actuate) return SKIP_DECISIONS.UNSTABLE;
    if (selection.bestScore < thresholds.sigma) {
      return SKIP_DECISIONS.BELOW_SIGMA;
    }
    if (selection.margin2nd < thresholds.minMargin) {
      return SKIP_DECISIONS.AMBIGUOUS;
    }
    return null;
  }

  // ========================================================================
  // Private - Candidate Scoring (HOT PATH)
  // ========================================================================

  /**
   * OPTIMIZATION: Reuses scoredBuffer to avoid allocations.
   */
  private scoreTopCandidates(
    selection: Selection,
    ledger: ReputationLedger,
    routeId: string,
  ): { candidates: ScoredCandidate[]; sum: number; count: number } {
    const top = selection.top;
    const n = top ? top.length : 0;

    const buffer = this.scoredBuffer;
    buffer.length = 0;

    if (n === 0) {
      return { candidates: buffer, sum: 0, count: 0 };
    }

    const isAmbiguous = selection.margin2nd <= this.config.ambiguityMargin;
    let sum = 0;

    for (let i = 0; i < n; i++) {
      const c = top![i];
      let score = c.score > 0 ? c.score : 0;

      // Apply reputation prior in ambiguous cases
      if (isAmbiguous) {
        const islandId = createIslandId(c.key);
        const prior = ledger.prior(routeId, islandId);
        const clampedPrior = clamp(
          prior,
          this.derived.priorMin,
          this.derived.priorMax,
        );
        score *= clampedPrior;
      }

      sum += score;
      buffer.push({ key: c.key, score, d2: c.d2 });
    }

    return { candidates: buffer, sum, count: n };
  }

  // ========================================================================
  // Private - Utility Ranking (HOT PATH)
  // ========================================================================

  /**
   * OPTIMIZATION: Reuses rankedBuffer and returns count instead of array.
   */
  private rankCandidatesByUtility(
    candidates: ScoredCandidate[],
    totalScore: number,
    count: number,
    registry: IslandsRegistry,
  ): number {
    const buffer = this.rankedBuffer;
    buffer.length = 0;

    const invTotal = 1.0 / totalScore;

    for (let i = 0; i < count; i++) {
      const candidate = candidates[i];
      const decoded = decodeKey(candidate.key);
      const type = registry.types[decoded.typeId];

      if (!type) continue;

      const flags = decoded.flags | (type.defaultFlags | 0);

      if ((flags & IslandFlags.PrefetchSafe) === 0) continue;

      const p = candidate.score * invTotal;

      // Inline utility computation
      const estBytes = type.estBytes > 0 ? type.estBytes | 0 : 0;
      const estCpuMs = type.estCpuMs > 0 ? type.estCpuMs : 0;
      const estBenefitMs = type.estBenefitMs > 0 ? type.estBenefitMs : 0;

      const cost = this.derived.wNetBytes * estBytes +
        this.derived.wCpuMs * estCpuMs;
      const benefit = p * estBenefitMs;
      const U = benefit - cost;

      buffer.push({
        key: candidate.key,
        p,
        U,
        d2: candidate.d2,
        estBytes,
        estCpuMs,
        estBenefitMs,
        flags,
      });
    }

    // Sort in-place by utility descending
    buffer.sort((a, b) => b.U - a.U);

    return buffer.length;
  }

  // ========================================================================
  // Private - Hydrate Eligibility
  // ========================================================================

  private checkHydrateEligibility(
    selection: Selection,
    topTarget: RankedTarget,
    tier: 0 | 1,
    etaMs: number,
    pressure: PressureSignals,
  ): HydrateEligibility {
    if (tier !== 1) return HYDRATE_RESPONSES.TIER_0;

    if ((topTarget.flags & IslandFlags.HydrateOnEventOnly) !== 0) {
      return HYDRATE_RESPONSES.FLAG_BLOCKED;
    }

    const isWinner = selection.key !== null && topTarget.key === selection.key;
    if (!isWinner) return HYDRATE_RESPONSES.NOT_WINNER;

    // Inline all comparisons for better branch prediction
    if (
      selection.bestScore >= this.config.ultraScore &&
      selection.margin2nd >= this.config.ultraMargin &&
      etaMs <= this.config.etaImmediateMs &&
      pressure.cpuPressure < HYDRATE_THRESHOLDS.MAX_CPU_PRESSURE &&
      pressure.netPressure < HYDRATE_THRESHOLDS.MAX_NET_PRESSURE
    ) {
      return HYDRATE_RESPONSES.ULTRA_CLEAR;
    }

    return HYDRATE_RESPONSES.THRESHOLDS_NOT_MET;
  }

  // ========================================================================
  // Private - Target Selection
  // ========================================================================

  /**
   * OPTIMIZATION: Builds array directly from rankedBuffer.
   */
  private selectPrefetchTargets(
    rankedCount: number,
    maxTargets: number,
  ): IslandKey[] {
    const targets: IslandKey[] = [];
    const limit = Math.min(rankedCount, maxTargets | 0);
    const buffer = this.rankedBuffer;

    for (let i = 0; i < limit; i++) {
      const target = buffer[i];
      if (target.U <= MIN_UTILITY) break;
      targets.push(target.key);
    }

    return targets;
  }
}

// Pre-allocated SKIP decisions for common cases
const SKIP_DECISIONS = {
  NO_CANDIDATES: {
    action: "SKIP",
    tier: 0,
    reason: "no-candidates",
  } as Decision,
  UNKNOWN_TYPE: { action: "SKIP", tier: 0, reason: "unknown-type" } as Decision,
  NOT_PREFETCH_SAFE: {
    action: "SKIP",
    tier: 0,
    reason: "winner-not-prefetch-safe",
  } as Decision,
  PRESSURE: {
    action: "SKIP",
    tier: 0,
    reason: "n_pf=0 (pressure)",
  } as Decision,
  UNSTABLE: { action: "SKIP", tier: 0, reason: "unstable-signal" } as Decision,
  BELOW_SIGMA: { action: "SKIP", tier: 0, reason: "below-sigma" } as Decision,
  AMBIGUOUS: { action: "SKIP", tier: 0, reason: "ambiguous" } as Decision,
  NO_SIGNAL: { action: "SKIP", tier: 0, reason: "no-signal" } as Decision,
  UTILITY_ZERO: { action: "SKIP", tier: 0, reason: "utility<=0" } as Decision,
  NO_TARGETS: {
    action: "SKIP",
    tier: 0,
    reason: "no-positive-targets",
  } as Decision,
} as const;

// ============================================================================
// Configuration Helpers
// ============================================================================

function computeDerivedConfig(config: UtilityGateConfig): DerivedConfig {
  return {
    wNetBytes: config.wNet,
    wCpuMs: config.wCpu,
    cpuMargin: PRESSURE_WEIGHTS.CPU_MARGIN,
    netMargin: PRESSURE_WEIGHTS.NET_MARGIN,
    priorMin: PRIOR_CLAMP.MIN,
    priorMax: PRIOR_CLAMP.MAX,
  };
}

// ============================================================================
// ETA & Tier Helpers
// ============================================================================

function computeETA(d2: number, speed: number): number {
  const distance = d2 > 0 ? Math.sqrt(d2) : 0;
  const safeSpeed = speed > MIN_SPEED ? speed : MIN_SPEED;
  return distance / safeSpeed;
}

function determineTier(
  etaMs: number,
  pressure: PressureSignals,
  config: UtilityGateConfig,
): 0 | 1 {
  if (pressure.saveData) return 0;
  return etaMs <= config.etaModerateMs ? 1 : 0;
}

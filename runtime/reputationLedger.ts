import type { LedgerConfig } from "./types.ts";
import { computeEMA, clamp } from "./utils.ts";

// ============================================================================
// Type Definitions
// ============================================================================

type StatRecord = {
  prior: number;
  hits: number;
  misses: number;
  lastTs: number;
};

type UpdateTarget = "hit" | "miss";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: LedgerConfig = {
  emaAlpha: 0.18,
  minPrior: 0.6,
  maxPrior: 1.4,
} as const;

const DEFAULT_PRIOR = 1.0;

const INITIAL_STAT: Omit<StatRecord, "lastTs"> = {
  prior: DEFAULT_PRIOR,
  hits: 0,
  misses: 0,
} as const;

const KEY_SEPARATOR = "::";

// ============================================================================
// Reputation Ledger Class
// ============================================================================

export class ReputationLedger {
  private readonly config: LedgerConfig;
  private readonly stats = new Map<string, StatRecord>();

  constructor(config?: Partial<LedgerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  prior(routeId: string, islandId: string): number {
    const key = createKey(routeId, islandId);
    const stat = this.stats.get(key);
    return stat?.prior ?? DEFAULT_PRIOR;
  }

  recordHit(routeId: string, islandId: string, now = performance.now()): void {
    this.recordOutcome(routeId, islandId, "hit", now);
  }

  recordMiss(routeId: string, islandId: string, now = performance.now()): void {
    this.recordOutcome(routeId, islandId, "miss", now);
  }

  private recordOutcome(
    routeId: string,
    islandId: string,
    outcome: UpdateTarget,
    now: number,
  ): void {
    const key = createKey(routeId, islandId);
    const stat = this.getOrCreateStat(key, now);

    this.incrementCounter(stat, outcome);
    this.updatePrior(stat, outcome);

    stat.lastTs = now;
    this.stats.set(key, stat);
  }

  private getOrCreateStat(key: string, timestamp: number): StatRecord {
    const existing = this.stats.get(key);
    if (existing) return existing;

    return createInitialStat(timestamp);
  }

  private incrementCounter(stat: StatRecord, outcome: UpdateTarget): void {
    if (outcome === "hit") {
      stat.hits++;
    } else {
      stat.misses++;
    }
  }

  private updatePrior(stat: StatRecord, outcome: UpdateTarget): void {
    const target = this.getTargetPrior(outcome);
    const newPrior = computeEMA(stat.prior, target, this.config.emaAlpha);
    stat.prior = clampPrior(
      newPrior,
      this.config.minPrior,
      this.config.maxPrior,
    );
  }

  private getTargetPrior(outcome: UpdateTarget): number {
    return outcome === "hit" ? this.config.maxPrior : this.config.minPrior;
  }
}

// ============================================================================
// Key Generation
// ============================================================================

function createKey(routeId: string, islandId: string): string {
  return `${routeId}${KEY_SEPARATOR}${islandId}`;
}

// ============================================================================
// Stat Record Creation
// ============================================================================

function createInitialStat(timestamp: number): StatRecord {
  return {
    ...INITIAL_STAT,
    lastTs: timestamp,
  };
}

// ============================================================================
// Math Helpers
// ============================================================================

function clampPrior(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}

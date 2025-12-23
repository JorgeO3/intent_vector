// runtime/pressureMonitor.ts
import type { NavigatorWithConnection, NetworkInformation } from "./types.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type PressureSignals = {
  readonly cpuPressure: number;
  readonly netPressure: number;
  readonly saveData: boolean;
};

export type PressureConfig = {
  readonly longTaskWindowMs: number;
  readonly longTaskBudgetMs: number;
};

type EffectiveConnectionType = "slow-2g" | "2g" | "3g" | "4g" | "";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: PressureConfig = {
  longTaskWindowMs: 2000,
  longTaskBudgetMs: 120,
} as const;

const PRESSURE_WEIGHTS = {
  LONG_TASK: 0.75,
  ENGINE: 0.25,
} as const;

const ENGINE_HEAVY_THRESHOLD_MS = 4.0;

const NET_PRESSURE_BY_TYPE: Record<string, number> = {
  "slow-2g": 1.0,
  "2g": 0.85,
  "3g": 0.55,
  "4g": 0.25,
} as const;

const PRESSURE_MAX = 1.0;
const PRESSURE_MIN = 0.0;
const MIN_DIVISOR = 1;

const PERFORMANCE_ENTRY_TYPE = "longtask";

// Queue compaction knobs (avoid unbounded arrays)
const COMPACT_HEAD_THRESHOLD = 64;
const COMPACT_RATIO_NUM = 2; // if head * 2 > len => compact

// ============================================================================
// Public API - Network Connection (SSR-safe)
// ============================================================================

export function getConnection(): NetworkInformation | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as NavigatorWithConnection;
  return nav.connection;
}

// ============================================================================
// Pressure Monitor Class
// ============================================================================

export class PressureMonitor {
  private readonly config: PressureConfig;

  // Long task queue (endTime + duration) with head index to avoid shift()
  private longTaskSumMs = 0;
  private longTaskEndTimes: number[] = [];
  private longTaskDurations: number[] = [];
  private longTaskHead = 0;

  private lastEngineMs = 0;

  private observer: PerformanceObserver | null = null;

  constructor(config?: Partial<PressureConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeLongTaskObserver();
  }

  dispose(): void {
    try {
      this.observer?.disconnect();
    } catch {
      // ignore
    }
    this.observer = null;
  }

  setLastEngineCostMs(ms: number): void {
    this.lastEngineMs = Math.max(PRESSURE_MIN, ms);
  }

  read(): PressureSignals {
    const now = safeNow();
    this.compactLongTasks(now);

    const cpuPressure = this.computeCpuPressure();
    const { netPressure, saveData } = this.computeNetPressure();

    return { cpuPressure, netPressure, saveData };
  }

  // ========================================================================
  // Long task observer
  // ========================================================================

  private initializeLongTaskObserver(): void {
    if (!supportsLongTaskObserver()) return;

    try {
      const observer = new PerformanceObserver((list) => {
        this.handleLongTaskEntries(list.getEntries());
      });

      // Prefer observe({ type, buffered }) when available
      try {
        observer.observe(
          {
            type: PERFORMANCE_ENTRY_TYPE,
            buffered: true,
          } as unknown as PerformanceObserverInit,
        );
      } catch {
        observer.observe({ entryTypes: [PERFORMANCE_ENTRY_TYPE] });
      }

      this.observer = observer;
    } catch {
      // ignore
    }
  }

  private handleLongTaskEntries(entries: PerformanceEntryList): void {
    for (const entry of entries) {
      // Long task entries have duration + startTime in ms (same time origin as performance.now()).
      const duration = Number((entry as PerformanceEntry).duration);
      const startTime = Number((entry as PerformanceEntry).startTime);

      if (!Number.isFinite(duration) || duration <= 0) continue;
      if (!Number.isFinite(startTime) || startTime < 0) continue;

      const endTime = startTime + duration;
      this.recordLongTask(endTime, duration);
    }

    this.compactLongTasks(safeNow());
  }

  private recordLongTask(endTime: number, duration: number): void {
    this.longTaskEndTimes.push(endTime);
    this.longTaskDurations.push(duration);
    this.longTaskSumMs += duration;
  }

  private compactLongTasks(now: number): void {
    const windowMs = this.config.longTaskWindowMs;

    // Drop from head while outside window
    const endTimes = this.longTaskEndTimes;
    const durations = this.longTaskDurations;

    while (
      this.longTaskHead < endTimes.length &&
      isOutsideWindow(now, endTimes[this.longTaskHead], windowMs)
    ) {
      this.longTaskSumMs -= durations[this.longTaskHead] ?? 0;
      this.longTaskHead++;
    }

    // Periodic compaction to release memory
    if (
      this.longTaskHead > COMPACT_HEAD_THRESHOLD &&
      this.longTaskHead * COMPACT_RATIO_NUM > endTimes.length
    ) {
      this.longTaskEndTimes = endTimes.slice(this.longTaskHead);
      this.longTaskDurations = durations.slice(this.longTaskHead);
      this.longTaskHead = 0;
    }

    // Defensive clamp
    if (this.longTaskSumMs < 0) this.longTaskSumMs = 0;
  }

  // ========================================================================
  // Pressure computation
  // ========================================================================

  private computeCpuPressure(): number {
    const longTaskPressure = this.computeLongTaskPressure();
    const enginePressure = this.computeEnginePressure();

    const weighted = PRESSURE_WEIGHTS.LONG_TASK * longTaskPressure +
      PRESSURE_WEIGHTS.ENGINE * enginePressure;

    return clampPressure(weighted);
  }

  private computeLongTaskPressure(): number {
    const budget = Math.max(MIN_DIVISOR, this.config.longTaskBudgetMs);
    return Math.min(PRESSURE_MAX, this.longTaskSumMs / budget);
  }

  private computeEnginePressure(): number {
    return Math.min(
      PRESSURE_MAX,
      this.lastEngineMs / ENGINE_HEAVY_THRESHOLD_MS,
    );
  }

  private computeNetPressure(): { netPressure: number; saveData: boolean } {
    const connection = getConnection();
    const saveData = connection?.saveData ?? false;

    if (saveData) return { netPressure: PRESSURE_MAX, saveData: true };

    const effectiveType =
      (connection?.effectiveType ?? "") as EffectiveConnectionType;
    let netPressure = getNetPressureForType(effectiveType);

    // Optional: refine with downlink if present (keep conservative)
    const downlink = (connection as unknown as { downlink?: number })?.downlink;
    if (
      typeof downlink === "number" && Number.isFinite(downlink) && downlink > 0
    ) {
      // crude mapping: slower downlink => higher pressure
      const byDownlink = downlink <= 0.5
        ? 1.0
        : downlink <= 1.0
        ? 0.85
        : downlink <= 2.0
        ? 0.55
        : 0.25;
      netPressure = Math.max(netPressure, byDownlink);
    }

    return { netPressure: clampPressure(netPressure), saveData };
  }
}

// ============================================================================
// Observer Support Helpers (SSR-safe)
// ============================================================================

function supportsLongTaskObserver(): boolean {
  if (typeof PerformanceObserver === "undefined") return false;
  const supported =
    (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
      .supportedEntryTypes;
  return Array.isArray(supported)
    ? supported.includes(PERFORMANCE_ENTRY_TYPE)
    : true;
}

// ============================================================================
// Time helpers
// ============================================================================

function safeNow(): number {
  if (
    typeof performance !== "undefined" && typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

function isOutsideWindow(
  now: number,
  timestamp: number,
  windowMs: number,
): boolean {
  return now - timestamp > windowMs;
}

// ============================================================================
// Network pressure helpers
// ============================================================================

function getNetPressureForType(effectiveType: string): number {
  return NET_PRESSURE_BY_TYPE[effectiveType] ?? PRESSURE_MIN;
}

// ============================================================================
// Utility helpers
// ============================================================================

function clampPressure(value: number): number {
  return Math.min(PRESSURE_MAX, Math.max(PRESSURE_MIN, value));
}

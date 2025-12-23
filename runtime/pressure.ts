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

type PerformanceEntryWithDuration = PerformanceEntry & {
  readonly duration: number;
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

// ============================================================================
// Public API - Network Connection
// ============================================================================

export function getConnection(): NetworkInformation | undefined {
  const nav = navigator as NavigatorWithConnection;
  return nav.connection;
}

// ============================================================================
// Pressure Monitor Class
// ============================================================================

export class PressureMonitor {
  private readonly config: PressureConfig;

  private longTaskSumMs = 0;
  private readonly longTaskTimestamps: number[] = [];
  private readonly longTaskDurations: number[] = [];

  private lastEngineMs = 0;

  constructor(config?: Partial<PressureConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeLongTaskObserver();
  }

  setLastEngineCostMs(ms: number): void {
    this.lastEngineMs = Math.max(PRESSURE_MIN, ms);
  }

  read(): PressureSignals {
    const now = performance.now();
    this.compactLongTasks(now);

    const cpuPressure = this.computeCpuPressure();
    const { netPressure, saveData } = this.computeNetPressure();

    return { cpuPressure, netPressure, saveData };
  }

  private initializeLongTaskObserver(): void {
    if (!supportsPerformanceObserver()) return;

    try {
      const observer = createLongTaskObserver((entries) => {
        this.handleLongTaskEntries(entries);
      });
      observer.observe({ entryTypes: [PERFORMANCE_ENTRY_TYPE] });
    } catch {
      // Observer not supported or failed to initialize
    }
  }

  private handleLongTaskEntries(entries: PerformanceEntryList): void {
    const now = performance.now();

    for (const entry of entries) {
      this.recordLongTask(now, entry.duration);
    }

    this.compactLongTasks(now);
  }

  private recordLongTask(timestamp: number, duration: number): void {
    this.longTaskTimestamps.push(timestamp);
    this.longTaskDurations.push(duration);
    this.longTaskSumMs += duration;
  }

  private compactLongTasks(now: number): void {
    const windowMs = this.config.longTaskWindowMs;

    while (
      this.longTaskTimestamps.length > 0 &&
      isOutsideWindow(now, this.longTaskTimestamps[0], windowMs)
    ) {
      this.removeFrontLongTask();
    }
  }

  private removeFrontLongTask(): void {
    const duration = this.longTaskDurations.shift();
    this.longTaskTimestamps.shift();

    if (duration !== undefined) {
      this.longTaskSumMs -= duration;
    }
  }

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

    if (saveData) {
      return { netPressure: PRESSURE_MAX, saveData: true };
    }

    const effectiveType = connection?.effectiveType ?? "";
    const netPressure = getNetPressureForType(effectiveType);

    return { netPressure, saveData };
  }
}

// ============================================================================
// Performance Observer Helpers
// ============================================================================

function supportsPerformanceObserver(): boolean {
  return "PerformanceObserver" in window;
}

function createLongTaskObserver(
  callback: (entries: PerformanceEntryList) => void,
): PerformanceObserver {
  return new PerformanceObserver((list) => {
    callback(list.getEntries());
  });
}

// ============================================================================
// Time Window Helpers
// ============================================================================

function isOutsideWindow(
  now: number,
  timestamp: number,
  windowMs: number,
): boolean {
  return now - timestamp > windowMs;
}

// ============================================================================
// Network Pressure Helpers
// ============================================================================

function getNetPressureForType(effectiveType: string): number {
  return NET_PRESSURE_BY_TYPE[effectiveType] ?? PRESSURE_MIN;
}

// ============================================================================
// Utility Helpers
// ============================================================================

function clampPressure(value: number): number {
  return Math.min(PRESSURE_MAX, Math.max(PRESSURE_MIN, value));
}

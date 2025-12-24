// ============================================================================
// Build Constants Re-export (for backward compatibility)
// ============================================================================

export {
  __DEV__,
  DEFAULT_FPS,
  DEFAULT_FRAME_MS,
  EPSILON,
  INFINITE_DISTANCE,
  INFINITE_DISTANCE_SQ,
  MIN_DIVISOR,
  NO_SCORE,
  ONE,
  PERFECT_SCORE,
  ZERO,
  ZERO_SCORE,
} from "./constants.ts";

// ============================================================================
// Inline Math Functions - Designed for bundler inlining
// ============================================================================

/**
 * Clamps a value between min and max bounds.
 * NOTE: For hot paths, bundler will inline this.
 */
export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/**
 * Clamps a value between 0 and 1.
 */
export const clamp01 = (x: number): number => x < 0 ? 0 : x > 1 ? 1 : x;

/**
 * Clamps an integer value between min and max bounds.
 * Uses bitwise OR for fast truncation.
 */
export const clampInt = (x: number, min: number, max: number): number => {
  const v = x | 0;
  return v < min ? min : v > max ? max : v;
};

/**
 * Squared distance between two points.
 */
export const distSq = (dx: number, dy: number): number => dx * dx + dy * dy;

/**
 * Squared distance from point to axis-aligned rect (nearest point).
 */
export const pointToRectDistSq = (
  px: number,
  py: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): number => {
  const rx2 = rx + rw;
  const ry2 = ry + rh;
  const cx = px < rx ? rx : px > rx2 ? rx2 : px;
  const cy = py < ry ? ry : py > ry2 ? ry2 : py;
  const dx = cx - px;
  const dy = cy - py;
  return dx * dx + dy * dy;
};

// ============================================================================
// Utility Functions - Time & Performance
// ============================================================================

/**
 * Safe performance.now() that falls back to Date.now() in environments without performance API.
 */
export const safeNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Checks if a timestamp is outside a time window.
 */
export const isOutsideWindow = (
  now: number,
  timestamp: number,
  windowMs: number,
): boolean => now - timestamp > windowMs;

// ============================================================================
// Utility Functions - Island/Key Helpers
// ============================================================================

/**
 * Creates an island ID string from an IslandKey (base-36 encoding).
 */
export const createIslandId = (key: number): string => key.toString(36);

// ============================================================================
// Utility Functions - Network/Connection
// ============================================================================

export type NetworkInformationConnection = {
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  rtt?: number;
  downlink?: number;
  saveData?: boolean;
};

export type NavigatorWithConnectionAPI = Navigator & {
  connection?: NetworkInformationConnection;
};

/**
 * Gets the network connection information if available (SSR-safe).
 */
export const getConnection = (): NetworkInformationConnection | undefined => {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as NavigatorWithConnectionAPI).connection;
};

/**
 * Gets downlink speed in bytes per millisecond.
 */
export const getDownlinkBytesPerMs = (): number => {
  const MBPS_TO_BYTES_PER_MS = 125;
  const conn = getConnection();
  const mbps = conn?.downlink;
  return typeof mbps === "number" && mbps > 0 ? mbps * MBPS_TO_BYTES_PER_MS : 0;
};

// ============================================================================
// Utility Functions - DOM & Environment
// ============================================================================

/**
 * Checks if DOM is available (SSR-safe).
 */
export const canUseDOM = (): boolean =>
  typeof document !== "undefined" && typeof HTMLElement !== "undefined";

/**
 * Gets current route ID from location pathname.
 */
export const getCurrentRouteId = (defaultRoute = "/"): string => {
  const globals = globalThis as typeof globalThis & {
    location?: { pathname?: string };
  };
  const pathname = globals.location?.pathname;
  return typeof pathname === "string" && pathname.length
    ? pathname
    : defaultRoute;
};

/**
 * Safely parses JSON with fallback.
 */
export const parseJsonSafely = (json: string | undefined): unknown => {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

// ============================================================================
// Utility Functions - EMA & Smoothing
// ============================================================================

/**
 * Computes Exponential Moving Average (EMA).
 */
export const computeEMA = (
  current: number,
  target: number,
  alpha: number,
): number => (1 - alpha) * current + alpha * target;

// ============================================================================
// Build-time Constants - Will be eliminated by DCE in production
// ============================================================================

/**
 * Development mode flag.
 * Set to `false` in production builds for dead code elimination.
 * All console.warn/log/error wrapped in if (__DEV__) will be stripped.
 */
export const __DEV__ = true;

// ============================================================================
// Numeric Constants - Inlined by bundlers
// ============================================================================

// Math constants (avoids repeated literals)
export const EPSILON = 1e-6;
export const MIN_DIVISOR = 1e-6;
export const ZERO = 0;
export const ONE = 1;

// Score constants
export const ZERO_SCORE = 0;
export const PERFECT_SCORE = 1.0;
export const NO_SCORE = -1;

// Time constants
export const MS_PER_SECOND = 1000;
export const DEFAULT_FPS = 60;
export const DEFAULT_FRAME_MS = MS_PER_SECOND / DEFAULT_FPS; // 16.67ms

// Distance constants
export const INFINITE_DISTANCE = Infinity;
export const INFINITE_DISTANCE_SQ = Infinity;

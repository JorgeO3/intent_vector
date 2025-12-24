/**
 * Intent Vector - Core bundle (~3.5 KB brotli)
 *
 * Minimal bundle with only the prediction engine and target selection.
 * Use this for custom integrations where you don't need DOM scanning.
 *
 * @example
 * ```ts
 * import { IntentVector, TargetLock } from "./mod.core.ts";
 * ```
 *
 * @module
 */

export { IntentVector } from "./intent/intentVector.ts";
export type { IntentVectorConfig, Kinematics } from "./intent/intentVector.ts";

export { TargetLock } from "./runtime/targetLock.ts";
export type { TargetLockConfig } from "./runtime/targetLock.ts";

export type {
  Candidate,
  IslandKey,
  Rect,
  ScoredTarget,
  Selection,
} from "./runtime/types.ts";

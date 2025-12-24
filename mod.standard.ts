/**
 * Intent Vector - Standard bundle (~5 KB brotli)
 *
 * Includes core + DOM scanning + token encoding.
 * Recommended for typical Fresh/Preact usage without full runtime.
 *
 * @example
 * ```ts
 * import { IntentVector, TargetLock, IslandLocator } from "./mod.standard.ts";
 * ```
 *
 * @module
 */

// Core
export { IntentVector } from "./intent/intentVector.ts";
export type { IntentVectorConfig, Kinematics } from "./intent/intentVector.ts";

export { TargetLock } from "./runtime/targetLock.ts";
export type { TargetLockConfig } from "./runtime/targetLock.ts";

// DOM scanning
export { IslandLocator } from "./runtime/islandLocator.ts";

// Token encoding
export {
  decodeIslandToken,
  encodeIslandToken,
  hasFlag,
} from "./runtime/islandToken.ts";

export { decodeKey, encodeKey, parseIslandKey } from "./runtime/keyCodec.ts";

// Types
export type {
  Candidate,
  IslandHandle,
  IslandKey,
  Rect,
  ScoredTarget,
  Selection,
} from "./runtime/types.ts";

export { IslandFlags } from "./runtime/types.ts";

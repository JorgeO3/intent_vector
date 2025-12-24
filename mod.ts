/**
 * Intent Vector - Predictive cursor intent engine
 *
 * A high-performance library for predicting user cursor intent,
 * enabling intelligent prefetching and hydration of interactive elements.
 *
 * @example Basic usage
 * ```ts
 * import { IntentVector, TargetLock } from "./mod.ts";
 *
 * const iv = new IntentVector();
 * const lock = new TargetLock(iv);
 *
 * // On mouse move
 * iv.update(mouseX, mouseY, deltaTimeMs);
 * const selection = lock.select(candidates, deltaTimeMs);
 *
 * if (selection.key && selection.actuate) {
 *   // Prefetch or hydrate the selected target
 * }
 * ```
 *
 * @module
 */

// =============================================================================
// Core - Kinematic prediction engine
// =============================================================================

export { IntentVector } from "./intent/intentVector.ts";
export type { IntentVectorConfig, Kinematics } from "./intent/intentVector.ts";

// =============================================================================
// Target Selection
// =============================================================================

export { TargetLock } from "./runtime/targetLock.ts";
export type { TargetLockConfig } from "./runtime/targetLock.ts";

// =============================================================================
// DOM Integration
// =============================================================================

export { IslandLocator } from "./runtime/islandLocator.ts";
export { loadPropsPool, loadRegistry } from "./runtime/islandManifest.ts";

// =============================================================================
// Token Encoding
// =============================================================================

export {
  decodeIslandToken,
  encodeIslandToken,
  hasFlag,
} from "./runtime/islandToken.ts";

export { decodeKey, encodeKey, parseIslandKey } from "./runtime/keyCodec.ts";

// =============================================================================
// Scheduling & Hydration
// =============================================================================

export { FlightScheduler } from "./runtime/flightScheduler.ts";
export { UtilityGate } from "./runtime/utilityGate.ts";
export type { Decision } from "./runtime/utilityGate.ts";

export { Actuators } from "./runtime/actuators.ts";
export type { PrefetchHandle } from "./runtime/actuators.ts";

// =============================================================================
// Monitoring & Analytics
// =============================================================================

export { PressureMonitor } from "./runtime/pressure.ts";
export { ReputationLedger } from "./runtime/reputationLedger.ts";

// =============================================================================
// Runtime Orchestrator
// =============================================================================

export { IntentFirstRuntime } from "./runtime/runtime.ts";
export type {
  HydrateContext,
  RuntimeConfig,
  RuntimeHooks,
} from "./runtime/runtime.ts";

// =============================================================================
// Types
// =============================================================================

export type {
  Candidate,
  IslandHandle,
  IslandKey,
  IslandsRegistry,
  IslandState,
  IslandTypeDef,
  PropsPool,
  Rect,
  SchedulerConfig,
  ScoredTarget,
  Selection,
} from "./runtime/types.ts";

export { IslandFlags, IslandSt } from "./runtime/types.ts";

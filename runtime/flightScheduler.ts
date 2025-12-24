import type {
  IslandHandle,
  IslandKey,
  IslandsRegistry,
  IslandState,
  IslandTypeDef,
  SchedulerConfig,
} from "./types.ts";
import { IslandFlags, IslandSt } from "./types.ts";
import type { Decision } from "./utilityGate.ts";
import type { Actuators, PrefetchHandle } from "./actuators.ts";
import type { ReputationLedger } from "./reputationLedger.ts";
import { decodeKey } from "./keyCodec.ts";
import { clamp, createIslandId, getDownlinkBytesPerMs } from "./utils.ts";

// ============================================================================
// Type Definitions
// ============================================================================

type QueueItem = {
  readonly key: IslandKey;
  readonly typeId: number;
  readonly flags: number;
  readonly estBytes: number;
  readonly priority: number;
  readonly tier: 0 | 1;
  readonly reason: string;
};

type DispatchResult = "DISPATCHED" | "DEFER_CAPACITY" | "DROP";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: SchedulerConfig = {
  maxInflightFetch: 2,
  maxBytesInFlight: 160_000,
  prefetchTTLms: 120_000, // 2 minutes
  falsePositiveCooldownMs: 15_000,
  assumeReadyDelayMs: 30,
  allowEarlyHydrate: false,
  maxAssumeReadyDelayMs: 250,
  dispatchScanLimit: 8,
} as const;

const PRIORITY_HIGH = 2;
const PRIORITY_NORMAL = 1;
const MAX_QUEUE_SIZE = 32;
const DEFAULT_ROUTE_ID = "/";
const MIN_BYTES = 0;

// ============================================================================
// Flight Scheduler Class
// ============================================================================

export class FlightScheduler {
  private readonly config: SchedulerConfig;
  private registry: IslandsRegistry;
  private readonly actuators: Actuators;
  private readonly ledger: ReputationLedger;

  // State tracking
  private readonly states = new Map<IslandKey, IslandState>();

  // Queue management (bounded priority queue)
  private readonly queue: QueueItem[] = [];
  private readonly queuedKeys = new Set<IslandKey>();

  // Resource tracking
  private inflightCount = 0;
  private bytesInFlight = 0;

  // Current route
  private routeId = DEFAULT_ROUTE_ID;

  // Cached downlink for adaptive delay estimation
  private cachedDownlinkBytesPerMs = 0;
  private lastDownlinkCheckTs = 0;
  private readonly DOWNLINK_CACHE_MS = 5000; // Re-check every 5s

  constructor(
    registry: IslandsRegistry,
    actuators: Actuators,
    ledger: ReputationLedger,
    config?: Partial<SchedulerConfig>,
  ) {
    this.registry = registry;
    this.actuators = actuators;
    this.ledger = ledger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ========================================================================
  // Public API
  // ========================================================================

  setRouteId(routeId: string): void {
    this.routeId = routeId || DEFAULT_ROUTE_ID;
  }

  setRegistry(registry: IslandsRegistry): void {
    this.registry = registry;
    this.actuators.setRegistry(registry);
  }

  /**
   * Prune inactive islands to prevent unbounded memory growth.
   * Call after route transitions or periodically.
   */
  pruneInactive(
    activeKeys: ReadonlySet<IslandKey>,
    now: number = performance.now(),
  ): void {
    const idleTtl = this.config.prefetchTTLms;

    for (const [key, st] of this.states) {
      if (activeKeys.has(key)) continue;

      // Only prune safe states (never prune in-progress operations)
      if (st.st === IslandSt.Idle && now - st.lastActionTs > idleTtl) {
        this.states.delete(key);
        this.queuedKeys.delete(key);
      }
    }
  }

  /**
   * Enqueue a decision for processing.
   * Validates and queues prefetch/hydrate targets.
   */
  enqueue(decision: Decision, now = performance.now()): void {
    const action = decision.action;

    if (action === "SKIP") return;
    if (action === "HYDRATE" && !this.config.allowEarlyHydrate) return;

    if (action === "PREFETCH" || action === "HYDRATE") {
      this.enqueuePrefetchTargets(
        decision.targets,
        decision.tier,
        decision.reason,
        now,
      );
      this.compactQueue();
    }
  }

  /**
   * Main scheduler tick: advance states and dispatch prefetches.
   * Should be called on RAF or at regular intervals.
   */
  tick(now = performance.now()): void {
    this.advanceStates(now);
    this.dispatchPrefetches(now);
  }

  /**
   * Request immediate hydration of an island.
   * Cancels any in-flight prefetch and executes hydration.
   */
  async requestHydrate(
    handle: IslandHandle,
    props: unknown,
    _reason = "event",
    now = performance.now(),
  ): Promise<void> {
    const state = this.getState(handle.key, now);

    if (isHydrateInProgress(state)) return;

    // Si se está pre-cargando, esperamos a que termine en lugar de abortar
    if (state.st === IslandSt.Prefetching && state.handle?.done) {
      await state.handle.done;
    } else {
      this.cancelPrefetchIfActive(handle.key, now);
    }

    await this.executeHydration(handle, props, now);
  }

  /**
   * Record a prefetch hit (island was used after prefetch).
   */
  feedbackHit(key: IslandKey, now = performance.now()): void {
    this.recordFeedback(key, "hit", now);
  }

  /**
   * Record a prefetch miss (island was prefetched but not used).
   * Applies cooldown to prevent immediate re-prefetch.
   */
  feedbackMiss(key: IslandKey, now = performance.now()): void {
    this.cancelPrefetchIfActive(key, now);
    this.transitionToIdleWithCooldown(key, now);
    this.recordFeedback(key, "miss", now);
  }

  /**
   * Speculative navigation prefetch for nav-like islands.
   */
  maybeSpeculateNav(handle: IslandHandle, props: unknown): void {
    const decoded = decodeKey(handle.key);

    if ((decoded.flags & IslandFlags.NavLike) === 0) return;

    const type = this.registry.types[decoded.typeId];
    if (!type) return;

    const url = this.actuators.getNavUrl(decoded.typeId, props);
    if (url) this.actuators.speculatePrefetchUrl(url);
  }

  // ========================================================================
  // Private - State Management
  // ========================================================================

  private getState(key: IslandKey, now: number): IslandState {
    let state = this.states.get(key);
    if (!state) {
      state = createIdleState(now);
      this.states.set(key, state);
    }
    return state;
  }

  private setState(key: IslandKey, state: IslandState): void {
    this.states.set(key, state);
  }

  private getIslandType(key: IslandKey): IslandTypeDef | null {
    const { typeId } = decodeKey(key);
    return this.registry.types[typeId] ?? null;
  }

  // ========================================================================
  // Private - Queue Management
  // ========================================================================

  private enqueuePrefetchTargets(
    targets: IslandKey[],
    tier: 0 | 1,
    reason: string,
    now: number,
  ): void {
    const priority = tier === 1 ? PRIORITY_HIGH : PRIORITY_NORMAL;

    for (const key of targets) {
      const item = this.prepareQueueItem(key, priority, tier, reason, now);
      if (item) {
        this.queue.push(item);
        this.queuedKeys.add(item.key);
      }
    }

    this.sortQueueByPriority();
  }

  private prepareQueueItem(
    key: IslandKey,
    priority: number,
    tier: 0 | 1,
    reason: string,
    now: number,
  ): QueueItem | null {
    // Already queued
    if (this.queuedKeys.has(key)) return null;

    const decoded = decodeKey(key);

    // Must be prefetch-safe
    if ((decoded.flags & IslandFlags.PrefetchSafe) === 0) return null;

    const type = this.registry.types[decoded.typeId];
    if (!type) return null;

    const state = this.getState(key, now);

    // Can only prefetch from idle state (not in cooldown)
    if (state.st !== IslandSt.Idle) return null;
    if (now < state.cooldownUntil) return null;

    const estBytes = Math.max(MIN_BYTES, type.estBytes | 0);

    return {
      key,
      typeId: decoded.typeId,
      flags: decoded.flags,
      estBytes,
      priority,
      tier,
      reason,
    };
  }

  private sortQueueByPriority(): void {
    // Stable sort: higher priority first
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private compactQueue(): void {
    if (this.queue.length <= MAX_QUEUE_SIZE) return;

    const removed = this.queue.splice(MAX_QUEUE_SIZE);
    for (const item of removed) {
      this.queuedKeys.delete(item.key);
    }
  }

  // ========================================================================
  // Private - State Advancement
  // ========================================================================

  private advanceStates(now: number): void {
    for (const [key, state] of this.states) {
      const newState = this.advanceState(state, now);

      if (newState !== state) {
        this.handleStateTransition(state, newState);
        this.setState(key, newState);
      }
    }
  }

  private advanceState(state: IslandState, now: number): IslandState {
    switch (state.st) {
      case IslandSt.Prefetching:
        return this.advancePrefetchingState(state, now);
      case IslandSt.Prefetched:
        return this.advancePrefetchedState(state, now);
      default:
        return state;
    }
  }

  private advancePrefetchingState(
    state: Extract<IslandState, { st: IslandSt.Prefetching }>,
    now: number,
  ): IslandState {
    const elapsed = now - state.startedTs;
    const readyThreshold = Math.max(
      this.config.assumeReadyDelayMs,
      state.readyDelayMs * 2,
    );

    if (elapsed >= readyThreshold) {
      const expiresTs = now + this.config.prefetchTTLms;
      return createPrefetchedState(now, expiresTs);
    }

    return state;
  }

  private advancePrefetchedState(
    state: Extract<IslandState, { st: IslandSt.Prefetched }>,
    now: number,
  ): IslandState {
    if (now >= state.expiresTs) {
      return createIdleState(now);
    }
    return state;
  }

  private handleStateTransition(from: IslandState, to: IslandState): void {
    // Release budgets when Prefetching -> Prefetched naturally completes
    if (from.st === IslandSt.Prefetching) {
      const shouldProcessFlight = to.st === IslandSt.Prefetched ||
        to.st === IslandSt.Idle ||
        to.st === IslandSt.Hydrating;
      if (shouldProcessFlight) {
        this.releaseFlightResources(from.bytes);
      }
    }
  }

  // ========================================================================
  // Private - Prefetch Dispatch
  // ========================================================================

  /**
   * Dispatch prefetches respecting capacity constraints.
   * Scans queue window to avoid HOL blocking and drops invalid items.
   */
  private dispatchPrefetches(now: number): void {
    const scanLimit = Math.max(1, this.config.dispatchScanLimit | 0);

    while (this.queue.length > 0 && this.hasCapacity()) {
      const windowSize = Math.min(this.queue.length, scanLimit);
      let dispatched = false;

      for (let i = 0; i < windowSize; i++) {
        const item = this.queue[i];
        const eligibility = this.checkEligibility(item, now);

        if (eligibility === "DROP") {
          // Remove invalid item
          this.removeQueueItemAt(i);
          dispatched = true;
          i--; // Adjust index after removal
          continue;
        }

        if (eligibility === "DEFER_CAPACITY") {
          // Not enough capacity for this item, try next
          continue;
        }

        // DISPATCHED: execute and remove from queue
        this.removeQueueItemAt(i);
        const result = this.tryDispatchPrefetch(item, now);

        if (result === "DEFER_CAPACITY") {
          // Requeue to front if capacity was limiting
          this.requeueToFront(item);
          return;
        }

        dispatched = true;
        break;
      }

      // No progress means capacity is limiting
      if (!dispatched) break;
    }
  }

  private checkEligibility(item: QueueItem, now: number): DispatchResult {
    // Validate prefetch-safe flag
    if ((item.flags & IslandFlags.PrefetchSafe) === 0) return "DROP";

    // Validate type still exists
    const type = this.registry.types[item.typeId];
    if (!type) return "DROP";

    // Validate state allows prefetch
    const state = this.getState(item.key, now);
    if (!this.canPrefetchFromState(state, now)) return "DROP";

    // Check capacity
    const bytes = Math.max(MIN_BYTES, type.estBytes | 0);
    if (!this.hasCapacityForBytes(bytes)) return "DEFER_CAPACITY";

    return "DISPATCHED";
  }

  private canPrefetchFromState(state: IslandState, now: number): boolean {
    return state.st === IslandSt.Idle && now >= state.cooldownUntil;
  }

  private tryDispatchPrefetch(item: QueueItem, now: number): DispatchResult {
    const type = this.registry.types[item.typeId];
    if (!type) return "DROP";

    const state = this.getState(item.key, now);
    if (!this.canPrefetchFromState(state, now)) return "DROP";

    const bytes = Math.max(MIN_BYTES, type.estBytes | 0);
    if (!this.hasCapacityForBytes(bytes)) return "DEFER_CAPACITY";

    const success = this.executePrefetch(
      item.key,
      item.flags,
      type,
      bytes,
      now,
    );
    return success ? "DISPATCHED" : "DEFER_CAPACITY";
  }

  private executePrefetch(
    key: IslandKey,
    flags: number,
    type: IslandTypeDef,
    bytes: number,
    now: number,
  ): boolean {
    const readyDelayMs = this.estimateReadyDelay(bytes, now);
    const handle = this.initiatePrefetch(type, flags);

    if (!handle) return false;

    this.allocateFlightResources(bytes);
    this.attachCompletionHandler(key, handle);
    this.setState(
      key,
      createPrefetchingState(now, bytes, readyDelayMs, handle),
    );

    return true;
  }

  private initiatePrefetch(
    type: IslandTypeDef,
    flags: number,
  ): PrefetchHandle | null {
    try {
      return this.actuators.prefetch(type, flags);
    } catch {
      return null;
    }
  }

  private attachCompletionHandler(
    key: IslandKey,
    handle: PrefetchHandle,
  ): void {
    handle.done?.then(() => {
      const state = this.states.get(key);
      if (state?.st === IslandSt.Prefetching) {
        const finishTs = performance.now();
        this.setState(
          key,
          createPrefetchedState(finishTs, finishTs + this.config.prefetchTTLms),
        );
      }
    });
  }
  // ========================================================================
  // Private - Hydration
  // ========================================================================

  private async executeHydration(
    handle: IslandHandle,
    props: unknown,
    now: number,
  ): Promise<void> {
    this.setState(handle.key, createHydratingState(now));

    try {
      await this.actuators.hydrate(handle, props);
      this.onHydrationSuccess(handle.key);
    } catch {
      this.onHydrationFailure(handle.key);
    }
  }

  private onHydrationSuccess(key: IslandKey): void {
    const now = performance.now();
    this.setState(key, createHydratedState(now));
    this.recordFeedback(key, "hit", now);
  }

  private onHydrationFailure(key: IslandKey): void {
    const now = performance.now();
    this.setState(key, createIdleState(now));
    this.recordFeedback(key, "miss", now);
  }

  // ========================================================================
  // Private - Resource Management
  // ========================================================================

  private hasCapacity(): boolean {
    return (
      this.inflightCount < this.config.maxInflightFetch &&
      this.bytesInFlight < this.config.maxBytesInFlight
    );
  }

  private hasCapacityForBytes(bytes: number): boolean {
    return this.bytesInFlight + bytes <= this.config.maxBytesInFlight;
  }

  private allocateFlightResources(bytes: number): void {
    this.inflightCount++;
    this.bytesInFlight += bytes;
  }

  private releaseFlightResources(bytes: number): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
    this.bytesInFlight = Math.max(0, this.bytesInFlight - bytes);
  }

  // ========================================================================
  // Private - Queue Operations
  // ========================================================================

  private removeQueueItemAt(index: number): void {
    const [removed] = this.queue.splice(index, 1);
    if (removed) this.queuedKeys.delete(removed.key);
  }

  private requeueToFront(item: QueueItem): void {
    if (this.queuedKeys.has(item.key)) return;

    this.queue.unshift(item);
    this.queuedKeys.add(item.key);
    this.compactQueue();
  }

  // ========================================================================
  // Private - Cancellation & Feedback
  // ========================================================================

  private cancelPrefetchIfActive(key: IslandKey, now: number): void {
    const state = this.getState(key, now);

    if (state.st === IslandSt.Prefetching) {
      this.abortPrefetch(state.handle);
      this.releaseFlightResources(state.bytes);
      this.setState(key, createIdleState(now));
    }
  }

  private abortPrefetch(handle: { abort?: () => void } | null): void {
    try {
      handle?.abort?.();
    } catch {
      // Ignore abort errors
    }
  }

  private transitionToIdleWithCooldown(key: IslandKey, now: number): void {
    this.setState(key, {
      st: IslandSt.Idle,
      lastActionTs: now,
      cooldownUntil: now + this.config.falsePositiveCooldownMs,
    });
  }

  private recordFeedback(
    key: IslandKey,
    type: "hit" | "miss",
    now: number,
  ): void {
    const islandId = createIslandId(key);

    if (type === "hit") {
      this.ledger.recordHit(this.routeId, islandId, now);
    } else {
      this.ledger.recordMiss(this.routeId, islandId, now);
    }
  }

  // ========================================================================
  // Private - Adaptive Delay Estimation
  // ========================================================================

  private estimateReadyDelay(bytes: number, now: number): number {
    const base = this.config.assumeReadyDelayMs;
    const max = this.config.maxAssumeReadyDelayMs;

    // Update cached downlink periodically
    if (now - this.lastDownlinkCheckTs > this.DOWNLINK_CACHE_MS) {
      this.cachedDownlinkBytesPerMs = getDownlinkBytesPerMs();
      this.lastDownlinkCheckTs = now;
    }

    if (this.cachedDownlinkBytesPerMs <= 0) return base;

    const estimatedMs = bytes / this.cachedDownlinkBytesPerMs;
    return clamp(estimatedMs, base, max);
  }
}

// ============================================================================
// State Factories
// ============================================================================

function createIdleState(timestamp: number): IslandState {
  return { st: IslandSt.Idle, lastActionTs: timestamp, cooldownUntil: 0 };
}

function createPrefetchingState(
  timestamp: number,
  bytes: number,
  readyDelayMs: number,
  handle: PrefetchHandle | null,
): IslandState {
  return {
    st: IslandSt.Prefetching,
    startedTs: timestamp,
    bytes,
    readyDelayMs,
    handle,
  };
}

function createPrefetchedState(
  readyTs: number,
  expiresTs: number,
): IslandState {
  return { st: IslandSt.Prefetched, readyTs, expiresTs };
}

function createHydratingState(timestamp: number): IslandState {
  return { st: IslandSt.Hydrating, startedTs: timestamp };
}

function createHydratedState(timestamp: number): IslandState {
  return { st: IslandSt.Hydrated, readyTs: timestamp };
}

// ============================================================================
// State Predicates
// ============================================================================

function isHydrateInProgress(state: IslandState): boolean {
  return state.st === IslandSt.Hydrated || state.st === IslandSt.Hydrating;
}

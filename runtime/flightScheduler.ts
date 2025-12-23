// runtime/flightScheduler.ts
import type {
  IslandHandle,
  IslandKey,
  IslandsRegistry,
  IslandTypeDef,
} from "./types.ts";
import { IslandFlags } from "./types.ts";
import type { Decision } from "./utilityGate.ts";
import type { Actuators } from "./actuators.ts";
import type { ReputationLedger } from "./reputationLedger.ts";
import { decodeKey } from "./keyCodec.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type SchedulerConfig = {
  readonly maxInflightFetch: number;
  readonly maxBytesInFlight: number;
  readonly prefetchTTLms: number;
  readonly falsePositiveCooldownMs: number;
  readonly assumeReadyDelayMs: number;
  readonly allowEarlyHydrate: boolean;
};

type IslandState =
  | { st: "Idle"; lastActionTs: number; cooldownUntil: number }
  | {
    st: "Prefetching";
    startedTs: number;
    bytes: number;
    handle: { abort?: () => void } | null;
  }
  | { st: "Prefetched"; readyTs: number; expiresTs: number }
  | { st: "Hydrating"; startedTs: number }
  | { st: "Hydrated"; readyTs: number };

type QueueItem = {
  readonly key: IslandKey;
  readonly priority: number;
  readonly tier: 0 | 1;
  readonly reason: string;
};

type StateTransition = {
  readonly from: IslandState["st"];
  readonly to: IslandState["st"];
  readonly timestamp: number;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: SchedulerConfig = {
  maxInflightFetch: 2,
  maxBytesInFlight: 160_000,
  prefetchTTLms: 2 * 60_000,
  falsePositiveCooldownMs: 15_000,
  assumeReadyDelayMs: 30,
  allowEarlyHydrate: false,
} as const;

const PRIORITY_BY_TIER = {
  HIGH: 2,
  NORMAL: 1,
} as const;

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

  private readonly states = new Map<IslandKey, IslandState>();
  private readonly queue: QueueItem[] = [];
  private readonly queuedKeys = new Set<IslandKey>();

  private inflightCount = 0;
  private bytesInFlight = 0;
  private routeId = DEFAULT_ROUTE_ID;

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

  setRouteId(routeId: string): void {
    this.routeId = routeId || DEFAULT_ROUTE_ID;
  }

  setRegistry(registry: IslandsRegistry): void {
    this.registry = registry;
    this.actuators.setRegistry(registry);
  }

  enqueue(decision: Decision, now = performance.now()): void {
    if (!shouldEnqueueDecision(decision, this.config)) {
      return;
    }

    if (decision.action === "PREFETCH" || decision.action === "HYDRATE") {
      this.enqueuePrefetchTargets(
        decision.targets,
        decision.tier,
        decision.reason,
        now,
      );
      this.compactQueue();
    }
  }

  tick(now = performance.now()): void {
    this.advanceStates(now);
    this.dispatchPrefetches(now);
  }

  async requestHydrate(
    handle: IslandHandle,
    props: unknown,
    _reason = "event",
    now = performance.now(),
  ): Promise<void> {
    const type = this.getIslandType(handle.key);
    if (!type) return;

    const state = this.getState(handle.key, now);
    if (isHydrateInProgress(state)) return;

    await this.executeHydration(handle, props, now);
  }

  feedbackHit(key: IslandKey, now = performance.now()): void {
    this.recordFeedback(key, "hit", now);
  }

  feedbackMiss(key: IslandKey, now = performance.now()): void {
    this.cancelPrefetchIfActive(key, now);
    this.transitionToIdleWithCooldown(key, now);
    this.recordFeedback(key, "miss", now);
  }

  maybeSpeculateNav(handle: IslandHandle, props: unknown): void {
    if (!isNavigationIsland(handle.key)) return;

    const type = this.getIslandType(handle.key);
    if (!type) return;

    const url = this.actuators.getNavUrl(decodeKey(handle.key).typeId, props);
    if (url) {
      this.actuators.speculatePrefetchUrl(url);
    }
  }

  // ========================================================================
  // Private - State Management
  // ========================================================================

  private getState(key: IslandKey, now: number): IslandState {
    const existing = this.states.get(key);
    if (existing) return existing;

    const initial = createIdleState(now);
    this.states.set(key, initial);
    return initial;
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
    const priority = tier === 1
      ? PRIORITY_BY_TIER.HIGH
      : PRIORITY_BY_TIER.NORMAL;

    for (const key of targets) {
      if (this.canEnqueueTarget(key, now)) {
        this.enqueueTarget(key, priority, tier, reason);
      }
    }

    this.sortQueueByPriority();
  }

  private canEnqueueTarget(key: IslandKey, now: number): boolean {
    if (!isPrefetchSafeIsland(key)) return false;
    if (this.queuedKeys.has(key)) return false;

    const type = this.getIslandType(key);
    if (!type) return false;

    const state = this.getState(key, now);
    if (state.st !== "Idle") return false;
    if (isInCooldown(state, now)) return false;

    return true;
  }

  private enqueueTarget(
    key: IslandKey,
    priority: number,
    tier: 0 | 1,
    reason: string,
  ): void {
    this.queue.push({ key, priority, tier, reason });
    this.queuedKeys.add(key);
  }

  private sortQueueByPriority(): void {
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
      const newState = advanceState(state, now, this.config);
      if (newState !== state) {
        this.handleStateTransition(state, newState);
        this.setState(key, newState);
      }
    }
  }

  private handleStateTransition(
    from: IslandState,
    to: IslandState,
  ): void {
    if (from.st === "Prefetching" && to.st === "Prefetched") {
      this.releaseFlightResources(from.bytes);
    }
  }

  private releaseFlightResources(bytes: number): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
    this.bytesInFlight = Math.max(0, this.bytesInFlight - bytes);
  }

  // ========================================================================
  // Private - Prefetch Dispatch
  // ========================================================================

  private dispatchPrefetches(now: number): void {
    while (this.queue.length > 0 && this.canDispatchMore()) {
      const item = this.dequeueNext();
      if (!item) break;

      const dispatched = this.tryDispatchPrefetch(item, now);
      if (!dispatched) {
        this.requeueItem(item);
        break;
      }
    }
  }

  private canDispatchMore(): boolean {
    return (
      this.inflightCount < this.config.maxInflightFetch &&
      this.bytesInFlight < this.config.maxBytesInFlight
    );
  }

  private dequeueNext(): QueueItem | null {
    const item = this.queue.shift();
    if (item) {
      this.queuedKeys.delete(item.key);
    }
    return item ?? null;
  }

  private requeueItem(item: QueueItem): void {
    this.queue.unshift(item);
    this.queuedKeys.add(item.key);
  }

  private tryDispatchPrefetch(item: QueueItem, now: number): boolean {
    const type = this.getIslandType(item.key);
    if (!type) return false;

    const state = this.getState(item.key, now);
    if (!canPrefetchFromState(state, item.key, now)) return false;

    const bytes = Math.max(MIN_BYTES, type.estBytes | 0);
    if (!this.hasCapacityFor(bytes)) return false;

    this.executePrefetch(item.key, type, bytes, now);
    return true;
  }

  private hasCapacityFor(bytes: number): boolean {
    return this.bytesInFlight + bytes <= this.config.maxBytesInFlight;
  }

  private executePrefetch(
    key: IslandKey,
    type: IslandTypeDef,
    bytes: number,
    now: number,
  ): void {
    const { flags } = decodeKey(key);
    const handle = this.actuators.prefetch(type, flags);

    this.allocateFlightResources(bytes);
    this.setState(key, createPrefetchingState(now, bytes, handle));
  }

  private allocateFlightResources(bytes: number): void {
    this.inflightCount++;
    this.bytesInFlight += bytes;
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
  // Private - Feedback & Cancellation
  // ========================================================================

  private cancelPrefetchIfActive(key: IslandKey, now: number): void {
    const state = this.getState(key, now);

    if (state.st === "Prefetching") {
      this.abortPrefetch(state.handle);
      this.releaseFlightResources(state.bytes);
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
      st: "Idle",
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
}

// ============================================================================
// State Factories
// ============================================================================

function createIdleState(timestamp: number): IslandState {
  return {
    st: "Idle",
    lastActionTs: timestamp,
    cooldownUntil: 0,
  };
}

function createPrefetchingState(
  timestamp: number,
  bytes: number,
  handle: { abort?: () => void } | null,
): IslandState {
  return {
    st: "Prefetching",
    startedTs: timestamp,
    bytes,
    handle,
  };
}

function createPrefetchedState(
  readyTs: number,
  expiresTs: number,
): IslandState {
  return {
    st: "Prefetched",
    readyTs,
    expiresTs,
  };
}

function createHydratingState(timestamp: number): IslandState {
  return {
    st: "Hydrating",
    startedTs: timestamp,
  };
}

function createHydratedState(timestamp: number): IslandState {
  return {
    st: "Hydrated",
    readyTs: timestamp,
  };
}

// ============================================================================
// State Predicates
// ============================================================================

function isHydrateInProgress(state: IslandState): boolean {
  return state.st === "Hydrated" || state.st === "Hydrating";
}

function isInCooldown(state: IslandState, now: number): boolean {
  return state.st === "Idle" && now < state.cooldownUntil;
}

function canPrefetchFromState(
  state: IslandState,
  key: IslandKey,
  now: number,
): boolean {
  if (state.st !== "Idle") return false;
  if (isInCooldown(state, now)) return false;
  if (!isPrefetchSafeIsland(key)) return false;
  return true;
}

// ============================================================================
// State Advancement
// ============================================================================

function advanceState(
  state: IslandState,
  now: number,
  config: SchedulerConfig,
): IslandState {
  if (state.st === "Prefetching") {
    return advancePrefetchingState(state, now, config);
  }

  if (state.st === "Prefetched") {
    return advancePrefetchedState(state, now);
  }

  return state;
}

function advancePrefetchingState(
  state: Extract<IslandState, { st: "Prefetching" }>,
  now: number,
  config: SchedulerConfig,
): IslandState {
  const elapsed = now - state.startedTs;

  if (elapsed >= config.assumeReadyDelayMs) {
    const expiresTs = now + config.prefetchTTLms;
    return createPrefetchedState(now, expiresTs);
  }

  return state;
}

function advancePrefetchedState(
  state: Extract<IslandState, { st: "Prefetched" }>,
  now: number,
): IslandState {
  if (now >= state.expiresTs) {
    return createIdleState(now);
  }

  return state;
}

// ============================================================================
// Decision Helpers
// ============================================================================

function shouldEnqueueDecision(
  decision: Decision,
  config: SchedulerConfig,
): boolean {
  if (decision.action === "SKIP") return false;

  if (decision.action === "HYDRATE") {
    return config.allowEarlyHydrate;
  }

  return true;
}

// ============================================================================
// Island Helpers
// ============================================================================

function isPrefetchSafeIsland(key: IslandKey): boolean {
  const { flags } = decodeKey(key);
  return (flags & IslandFlags.PrefetchSafe) !== 0;
}

function isNavigationIsland(key: IslandKey): boolean {
  const { flags } = decodeKey(key);
  return (flags & IslandFlags.NavLike) !== 0;
}

function createIslandId(key: IslandKey): string {
  return key.toString(36);
}

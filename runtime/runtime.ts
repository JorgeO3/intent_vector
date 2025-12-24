import { IntentVector } from "../intent/intentVector.ts";
import { loadPropsPool, loadRegistry } from "./islandManifest.ts";
import { IslandLocator } from "./islandLocator.ts";
import { TargetLock } from "./targetLock.ts";
import { PressureMonitor } from "./pressure.ts";
import { ReputationLedger } from "./reputationLedger.ts";
import { UtilityGate } from "./utilityGate.ts";
import { Actuators } from "./actuators.ts";
import { FlightScheduler } from "./flightScheduler.ts";
import { clamp, getCurrentRouteId, parseJsonSafely } from "./utils.ts";

import type {
  Candidate,
  IslandHandle,
  IslandKey,
  IslandsRegistry,
  PropsPool,
  Rect,
} from "./types.ts";

import { decodeKey, parseIslandKey } from "./keyCodec.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type RuntimeConfig = {
  readonly useRAF: boolean;
  readonly policyEveryNFrames: number;
  readonly capturePointerDown: boolean;
  readonly captureClick: boolean;
  readonly captureInput: boolean;
  readonly captureSubmit: boolean;
  readonly captureFocus: boolean;
  readonly islandSelector: string; // must match IslandLocator scan selector
  readonly tokenAttr: string; // dataset attr holding token (base36)
  readonly debugPropsDatasetKey: string;
};

export type HydrateContext = {
  readonly key: IslandKey;
  readonly handle: IslandHandle;
  readonly props: unknown;
  readonly reason: string;
};

export type RuntimeHooks = {
  readonly resolveProps?: (
    handle: IslandHandle,
    propsPool: PropsPool,
  ) => unknown;
  readonly onHydrated?: (ctx: HydrateContext) => void;
  readonly onError?: (err: unknown) => void;
};

type GlobalWithLocation = typeof globalThis & {
  location?: Location;
};

type EventListenerCleanup = () => void;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: RuntimeConfig = {
  useRAF: true,
  policyEveryNFrames: 2,
  capturePointerDown: true,
  captureClick: true,
  captureInput: false,
  captureSubmit: true,
  captureFocus: false,
  islandSelector: "[data-nk]",
  tokenAttr: "data-nk",
  debugPropsDatasetKey: "islandProps",
} as const;

const DEFAULT_ROUTE_ID = "/";
const MIN_DELTA_TIME = 1;
const MAX_DELTA_TIME = 1000;

const EVENT_TYPES = {
  POINTER_MOVE: "pointermove",
  POINTER_DOWN: "pointerdown",
  CLICK: "click",
  INPUT: "input",
  CHANGE: "change",
  SUBMIT: "submit",
  FOCUS_IN: "focusin",
  SCROLL: "scroll",
  RESIZE: "resize",
  POPSTATE: "popstate",
} as const;

const EVENT_OPTIONS = {
  PASSIVE_CAPTURE: { capture: true, passive: true } as const,
  CAPTURE_ONLY: { capture: true } as const,
  PASSIVE: { passive: true } as const,
};

// throttle for layout work
const MIN_LAYOUT_UPDATE_INTERVAL_MS = 32;

// ============================================================================
// Intent First Runtime Class
// ============================================================================

export class IntentFirstRuntime {
  private readonly config: RuntimeConfig;
  private readonly hooks: RuntimeHooks;

  private registry: IslandsRegistry;
  private propsPool: PropsPool;

  private readonly core: IntentVector;
  private readonly locator: IslandLocator;
  private readonly lock: TargetLock;

  private readonly pressure: PressureMonitor;
  private readonly ledger: ReputationLedger;
  private readonly policy: UtilityGate;
  private readonly actuators: Actuators;
  private readonly scheduler: FlightScheduler;

  // pointer state
  private pointerX = 0;
  private pointerY = 0;

  // frame state
  private lastTimestamp = 0;
  private frameCount = 0;

  // cached candidates (avoid alloc per frame)
  private candidatesCache: Candidate[] = [];

  // layout / DOM dirtiness
  private rectsDirty = true;
  private domDirty = true;
  private lastLayoutUpdateTs = 0;

  // route tracking
  private lastRouteId = DEFAULT_ROUTE_ID;

  private running = false;
  private readonly cleanupCallbacks: EventListenerCleanup[] = [];
  private mutationObserver: MutationObserver | null = null;

  constructor(config?: Partial<RuntimeConfig>, hooks?: RuntimeHooks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hooks = hooks ?? {};

    this.registry = loadRegistry();
    this.propsPool = loadPropsPool();

    this.core = new IntentVector();
    this.locator = new IslandLocator();
    this.lock = new TargetLock(this.core);

    this.pressure = new PressureMonitor();
    this.ledger = new ReputationLedger();
    this.policy = new UtilityGate();

    this.actuators = new Actuators(this.registry);
    this.scheduler = new FlightScheduler(
      this.registry,
      this.actuators,
      this.ledger,
    );

    this.lastRouteId = getCurrentRouteId();
    this.scheduler.setRouteId(this.lastRouteId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.setupPointerTracking();
    this.setupEventDelegation();
    this.setupLayoutTracking();
    this.setupRouteTracking();

    this.initializeState();
    this.rescanIslands(); // important: build handles + candidates cache

    if (this.config.useRAF) {
      this.startAnimationLoop();
    }
  }

  stop(): void {
    this.running = false;
    this.cleanupEventListeners();
    this.teardownObservers();
  }

  refresh(): void {
    this.reloadManifest();
    this.updateDependencies();
    this.rescanIslands();
    this.syncRouteId();
  }

  // ========================================================================
  // Private - Initialization
  // ========================================================================

  private initializeState(): void {
    const now = performance.now();
    this.lastTimestamp = now;
    this.core.reset(this.pointerX, this.pointerY);
  }

  // ========================================================================
  // Private - Pointer Tracking
  // ========================================================================

  private setupPointerTracking(): void {
    const onMove = (event: Event) => {
      if (!(event instanceof PointerEvent)) return;

      this.pointerX = event.clientX;
      this.pointerY = event.clientY;

      if (!this.config.useRAF) {
        this.tick(performance.now());
      }
    };

    this.addGlobalListener(
      EVENT_TYPES.POINTER_MOVE,
      onMove,
      EVENT_OPTIONS.PASSIVE_CAPTURE,
    );
  }

  // ========================================================================
  // Private - Event Delegation
  // ========================================================================

  private setupEventDelegation(): void {
    const handler = (event: Event) => {
      // fire-and-forget: hydration is async, do not block the event
      void this.handleUserEvent(event);
    };

    if (this.config.capturePointerDown) {
      this.addGlobalListener(
        EVENT_TYPES.POINTER_DOWN,
        handler,
        EVENT_OPTIONS.PASSIVE_CAPTURE,
      );
    }

    if (this.config.captureClick) {
      this.addGlobalListener(
        EVENT_TYPES.CLICK,
        handler,
        EVENT_OPTIONS.PASSIVE_CAPTURE,
      );
    }

    if (this.config.captureInput) {
      this.addGlobalListener(
        EVENT_TYPES.INPUT,
        handler,
        EVENT_OPTIONS.PASSIVE_CAPTURE,
      );
      this.addGlobalListener(
        EVENT_TYPES.CHANGE,
        handler,
        EVENT_OPTIONS.PASSIVE_CAPTURE,
      );
    }

    if (this.config.captureSubmit) {
      this.addGlobalListener(
        EVENT_TYPES.SUBMIT,
        handler,
        EVENT_OPTIONS.CAPTURE_ONLY,
      );
    }

    if (this.config.captureFocus) {
      this.addGlobalListener(
        EVENT_TYPES.FOCUS_IN,
        handler,
        EVENT_OPTIONS.PASSIVE_CAPTURE,
      );
    }
  }

  private addGlobalListener(
    type: string,
    handler: EventListener,
    options: AddEventListenerOptions,
  ): void {
    globalThis.addEventListener(type, handler, options);

    this.cleanupCallbacks.push(() => {
      globalThis.removeEventListener(
        type,
        handler,
        options as EventListenerOptions,
      );
    });
  }

  private cleanupEventListeners(): void {
    for (const cleanup of this.cleanupCallbacks) cleanup();
    this.cleanupCallbacks.length = 0;
  }

  private teardownObservers(): void {
    try {
      this.mutationObserver?.disconnect();
    } catch {
      // ignore
    }
    this.mutationObserver = null;

    // optional (if your PressureMonitor has dispose())
    try {
      (this.pressure as unknown as { dispose?: () => void }).dispose?.();
    } catch {
      // ignore
    }
  }

  // ========================================================================
  // Private - Layout / DOM tracking
  // ========================================================================

  private setupLayoutTracking(): void {
    const markRectsDirty = () => {
      this.rectsDirty = true;
      if (!this.config.useRAF) this.tick(performance.now());
    };

    const markDomDirty = () => {
      this.domDirty = true;
      this.rectsDirty = true;
      if (!this.config.useRAF) this.tick(performance.now());
    };

    this.addGlobalListener(
      EVENT_TYPES.SCROLL,
      markRectsDirty,
      EVENT_OPTIONS.PASSIVE,
    );
    this.addGlobalListener(
      EVENT_TYPES.RESIZE,
      markRectsDirty,
      EVENT_OPTIONS.PASSIVE,
    );

    if (typeof MutationObserver !== "undefined") {
      const root = document.body ?? document.documentElement;
      if (root) {
        const observer = new MutationObserver(markDomDirty);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        this.mutationObserver = observer;
      }
    }
  }

  private maybeUpdateLayout(now: number): void {
    if (!this.domDirty && !this.rectsDirty) return;

    // throttle expensive layout work
    if (now - this.lastLayoutUpdateTs < MIN_LAYOUT_UPDATE_INTERVAL_MS) return;
    this.lastLayoutUpdateTs = now;

    if (this.domDirty) {
      this.rescanIslands();
      this.domDirty = false;
      this.rectsDirty = false;
      return;
    }

    if (this.rectsDirty) {
      this.updateRectsInPlace();
      this.rectsDirty = false;
    }
  }

  private rescanIslands(): void {
    const handles = this.locator.scan(document);
    // Build stable candidates cache once per scan
    this.candidatesCache = handles.map((h) => ({ key: h.key, rect: h.rect }));
    // Ensure rect objects remain stable afterwards (we mutate in place)
    this.updateRectsInPlace();
  }

  private updateRectsInPlace(): void {
    const handles = this.locator.getAllHandles();

    for (const handle of handles) {
      const bounds = handle.el.getBoundingClientRect();
      // mutate the same Rect object to preserve references held by candidatesCache
      const r = handle.rect;
      r.x = bounds.left;
      r.y = bounds.top;
      r.w = bounds.width;
      r.h = bounds.height;
    }
  }

  // ========================================================================
  // Private - Route tracking
  // ========================================================================

  private setupRouteTracking(): void {
    const onPop = () => this.syncRouteId();
    this.addGlobalListener(EVENT_TYPES.POPSTATE, onPop, EVENT_OPTIONS.PASSIVE);
  }

  private syncRouteId(): void {
    const routeId = getCurrentRouteId();
    if (routeId !== this.lastRouteId) {
      this.lastRouteId = routeId;
      this.scheduler.setRouteId(routeId);
    }
  }

  // ========================================================================
  // Private - Event Handling
  // ========================================================================

  private async handleUserEvent(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const islandElement = findClosestIsland(target, this.config.islandSelector);
    if (!islandElement) return;

    const handle = this.createHandleFromElement(islandElement);
    if (!handle) return;

    const props = this.resolveIslandProps(handle);
    const reason = `event:${event.type}`;

    try {
      await this.scheduler.requestHydrate(handle, props, reason);
      this.hooks.onHydrated?.({ key: handle.key, handle, props, reason });
    } catch (error) {
      this.hooks.onError?.(error);
    }
  }

  // ========================================================================
  // Private - Island Handle Creation (reuse scanned handle when possible)
  // ========================================================================

  private createHandleFromElement(element: HTMLElement): IslandHandle | null {
    const token = element.getAttribute(this.config.tokenAttr);
    if (!token) return null;

    const key = parseIslandKey(token);
    if (!key) return null;

    const existing = this.locator.getHandle(key);
    if (existing) return existing;

    const decoded = decodeKey(key);
    const rect = computeElementRect(element);

    return {
      el: element,
      key,
      typeId: decoded.typeId,
      propsId: decoded.propsId,
      flags: decoded.flags,
      rect,
    };
  }

  // ========================================================================
  // Private - Props Resolution
  // ========================================================================

  private resolveIslandProps(handle: IslandHandle): unknown {
    if (this.hooks.resolveProps) {
      return this.hooks.resolveProps(handle, this.propsPool);
    }

    const poolProps = this.propsPool[handle.propsId];
    if (poolProps !== undefined) return poolProps;

    const datasetKey = this.config.debugPropsDatasetKey;
    const rawJson = handle.el.dataset[datasetKey];
    return parseJsonSafely(rawJson);
  }

  // ========================================================================
  // Private - Animation Loop
  // ========================================================================

  private startAnimationLoop(): void {
    const animate = (timestamp: number) => {
      if (!this.running) return;
      this.tick(timestamp);
      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }

  private tick(timestamp: number): void {
    const startTime = performance.now();

    const deltaTime = this.computeDeltaTime(timestamp);
    this.lastTimestamp = timestamp;

    this.maybeUpdateLayout(timestamp);

    this.core.update(this.pointerX, this.pointerY, deltaTime);

    // selection uses deltaTime in ms (correctness fix)
    const selection = this.lock.select(this.candidatesCache, deltaTime);

    this.frameCount++;
    if (this.shouldRunPolicy()) {
      this.runPolicy(selection, timestamp);
    }

    const endTime = performance.now();
    this.pressure.setLastEngineCostMs(endTime - startTime);
  }

  private computeDeltaTime(timestamp: number): number {
    const raw = timestamp - this.lastTimestamp;
    return clamp(raw, MIN_DELTA_TIME, MAX_DELTA_TIME);
  }

  private shouldRunPolicy(): boolean {
    const interval = Math.max(1, this.config.policyEveryNFrames | 0);
    return (this.frameCount % interval) === 0;
  }

  private runPolicy(
    selection: ReturnType<TargetLock["select"]>,
    timestamp: number,
  ): void {
    this.syncRouteId();

    const pressure = this.pressure.read();
    const decision = this.policy.decide(
      selection,
      this.registry,
      pressure,
      this.ledger,
      this.lastRouteId,
    );

    this.scheduler.enqueue(decision, timestamp);
    this.scheduler.tick(timestamp);
  }

  // ========================================================================
  // Private - Refresh & Updates
  // ========================================================================

  private reloadManifest(): void {
    this.registry = loadRegistry();
    this.propsPool = loadPropsPool();
  }

  private updateDependencies(): void {
    this.actuators.setRegistry(this.registry);
    this.scheduler.setRegistry(this.registry);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function findClosestIsland(
  element: HTMLElement,
  selector: string,
): HTMLElement | null {
  return element.closest<HTMLElement>(selector);
}

function computeElementRect(element: HTMLElement): Rect {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
}

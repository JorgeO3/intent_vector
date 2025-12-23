// runtime/intentFirstRuntime.ts
import { IntentVector } from "../intent/intentVector.ts";
import { loadPropsPool, loadRegistry } from "./islandManifest.ts";
import { IslandLocator } from "./islandLocator.ts";
import { clamp, TargetLock } from "./targetLock.ts";
import { PressureMonitor } from "./pressure.ts";
import { ReputationLedger } from "./reputationLedger.ts";
import { UtilityGate } from "./utilityGate.ts";
import { Actuators } from "./actuators.ts";
import { FlightScheduler } from "./flightScheduler.ts";

import type {
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
  readonly islandSelector: string;
  readonly tokenAttr: string;
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
} as const;

const EVENT_OPTIONS = {
  PASSIVE_CAPTURE: { capture: true, passive: true } as const,
  CAPTURE_ONLY: { capture: true } as const,
};

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

  private pointerX = 0;
  private pointerY = 0;
  private lastTimestamp = 0;
  private frameCount = 0;

  private running = false;
  private readonly cleanupCallbacks: EventListenerCleanup[] = [];

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

    this.scheduler.setRouteId(getCurrentRouteId());
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.setupPointerTracking();
    this.setupEventDelegation();
    this.initializeState();

    if (this.config.useRAF) {
      this.startAnimationLoop();
    }
  }

  stop(): void {
    this.running = false;
    this.cleanupEventListeners();
  }

  refresh(): void {
    this.refreshLocator();
    this.reloadManifest();
    this.updateDependencies();
  }

  // ========================================================================
  // Private - Initialization
  // ========================================================================

  private initializeState(): void {
    const now = performance.now();
    this.lastTimestamp = now;
    this.resetCoreIfAvailable(this.pointerX, this.pointerY);
  }

  private resetCoreIfAvailable(x: number, y: number): void {
    if (hasResetMethod(this.core)) {
      this.core.reset(x, y);
    }
  }

  // ========================================================================
  // Private - Pointer Tracking
  // ========================================================================

  private setupPointerTracking(): void {
    const handlePointerMove = (event: Event) => {
      if (!(event instanceof PointerEvent)) return;

      this.updatePointerPosition(event.clientX, event.clientY);

      if (!this.config.useRAF) {
        this.tick(performance.now());
      }
    };

    this.addGlobalListener(
      EVENT_TYPES.POINTER_MOVE,
      handlePointerMove,
      EVENT_OPTIONS.PASSIVE_CAPTURE,
    );
  }

  private updatePointerPosition(x: number, y: number): void {
    this.pointerX = x;
    this.pointerY = y;
  }

  // ========================================================================
  // Private - Event Delegation
  // ========================================================================

  private setupEventDelegation(): void {
    const handler = (event: Event) => this.handleUserEvent(event);

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
    for (const cleanup of this.cleanupCallbacks) {
      cleanup();
    }
    this.cleanupCallbacks.length = 0;
  }

  // ========================================================================
  // Private - Event Handling
  // ========================================================================

  private async handleUserEvent(event: Event): Promise<void> {
    const target = event.target;
    if (!isHTMLElement(target)) return;

    const islandElement = findClosestIsland(target, this.config.islandSelector);
    if (!islandElement) return;

    const handle = this.createHandleFromElement(islandElement);
    if (!handle) return;

    await this.hydrateIsland(handle, event.type);
  }

  private async hydrateIsland(
    handle: IslandHandle,
    eventType: string,
  ): Promise<void> {
    const props = this.resolveIslandProps(handle);
    const reason = `event:${eventType}`;

    try {
      await this.scheduler.requestHydrate(handle, props, reason);
      this.notifyHydrationSuccess(handle, props, reason);
    } catch (error) {
      this.notifyHydrationError(error);
    }
  }

  private notifyHydrationSuccess(
    handle: IslandHandle,
    props: unknown,
    reason: string,
  ): void {
    this.hooks.onHydrated?.({
      key: handle.key,
      handle,
      props,
      reason,
    });
  }

  private notifyHydrationError(error: unknown): void {
    this.hooks.onError?.(error);
  }

  // ========================================================================
  // Private - Island Handle Creation
  // ========================================================================

  private createHandleFromElement(element: HTMLElement): IslandHandle | null {
    const token = element.getAttribute(this.config.tokenAttr);
    if (!token) return null;

    const key = parseIslandKey(token);
    if (!key) return null;

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

    return this.resolvePropsDefault(handle);
  }

  private resolvePropsDefault(handle: IslandHandle): unknown {
    const poolProps = this.propsPool[handle.propsId];
    if (poolProps !== undefined) return poolProps;

    return this.resolvePropsFromDataset(handle);
  }

  private resolvePropsFromDataset(handle: IslandHandle): unknown {
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

    this.updateIntentVector(deltaTime);
    this.processFrame(timestamp);

    const endTime = performance.now();
    this.updatePressureMetrics(endTime - startTime);
  }

  private computeDeltaTime(timestamp: number): number {
    const raw = timestamp - this.lastTimestamp;
    return clamp(raw, MIN_DELTA_TIME, MAX_DELTA_TIME);
  }

  private updateIntentVector(deltaTime: number): void {
    this.core.update(this.pointerX, this.pointerY, deltaTime);
  }

  private processFrame(timestamp: number): void {
    const candidates = this.locator.candidates();
    const selection = this.lock.select(
      candidates,
      timestamp - this.lastTimestamp,
    );

    this.frameCount++;

    if (this.shouldRunPolicy()) {
      this.runPolicy(selection, timestamp);
    }
  }

  private shouldRunPolicy(): boolean {
    const interval = Math.max(1, this.config.policyEveryNFrames | 0);
    return (this.frameCount % interval) === 0;
  }

  private runPolicy(
    selection: ReturnType<TargetLock["select"]>,
    timestamp: number,
  ): void {
    const pressure = this.pressure.read();
    const routeId = getCurrentRouteId();

    const decision = this.policy.decide(
      selection,
      this.registry,
      pressure,
      this.ledger,
      routeId,
    );

    this.scheduler.enqueue(decision, timestamp);
    this.scheduler.tick(timestamp);
  }

  private updatePressureMetrics(engineCostMs: number): void {
    this.pressure.setLastEngineCostMs(engineCostMs);
  }

  // ========================================================================
  // Private - Refresh & Updates
  // ========================================================================

  private refreshLocator(): void {
    if (hasRefreshMethod(this.locator)) {
      this.locator.refresh();
    }
  }

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

function getCurrentRouteId(): string {
  const globals = globalThis as GlobalWithLocation;
  const pathname = globals.location?.pathname;
  return typeof pathname === "string" ? pathname : DEFAULT_ROUTE_ID;
}

function isHTMLElement(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement;
}

function findClosestIsland(
  element: HTMLElement,
  selector: string,
): HTMLElement | null {
  return element.closest<HTMLElement>(selector);
}

function computeElementRect(element: HTMLElement): Rect {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.left,
    y: bounds.top,
    w: bounds.width,
    h: bounds.height,
  };
}

function parseJsonSafely(json: string | undefined): unknown {
  if (!json) return null;

  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

// ============================================================================
// Type Guards for Optional Methods
// ============================================================================

function hasResetMethod(
  obj: unknown,
): obj is { reset: (x: number, y: number) => void } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "reset" in obj &&
    typeof (obj as { reset: unknown }).reset === "function"
  );
}

function hasRefreshMethod(obj: unknown): obj is { refresh: () => void } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "refresh" in obj &&
    typeof (obj as { refresh: unknown }).refresh === "function"
  );
}

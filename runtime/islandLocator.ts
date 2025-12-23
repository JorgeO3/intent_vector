// runtime/islandLocator.ts
import type { Candidate, IslandHandle, IslandKey, Rect } from "./types.ts";
import { decodeKey, parseIslandKey } from "./keyCodec.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type ScanOptions = {
  /**
   * When true, compute initial rects on scan (calls getBoundingClientRect()).
   * If false, rects will be initialized to zeros and you must call updateRects().
   * @default true
   */
  readonly computeRects?: boolean;

  /**
   * When true, duplicates (same key) will be ignored after the first occurrence.
   * @default true
   */
  readonly dedupeByKey?: boolean;
};

export type RectUpdateOptions = {
  /**
   * Update only these keys (fast path for top-K or visible set).
   * If omitted, updates all handles.
   */
  readonly keys?: ReadonlySet<IslandKey>;

  /**
   * If true, skip rect update for elements that are not connected to the DOM.
   * @default true
   */
  readonly skipDisconnected?: boolean;
};

// ============================================================================
// Constants
// ============================================================================

const ISLAND_ATTRIBUTE = "data-nk";
const ISLAND_SELECTOR = `[${ISLAND_ATTRIBUTE}]`;
const ZERO_RECT: Readonly<Rect> = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });
const DEFAULT_VISIBILITY_ROOT_MARGIN = "256px";
const VISIBILITY_THRESHOLD = 0;

// ============================================================================
// Island Locator
// ============================================================================

export class IslandLocator {
  private handles: IslandHandle[] = [];
  private readonly handlesByKey = new Map<IslandKey, IslandHandle>();

  // Candidate cache to avoid per-call allocations
  private candidatesCache: Candidate[] = [];

  // Optional visibility tracking (IntersectionObserver)
  private io: IntersectionObserver | null = null;
  private readonly visibleKeys = new Set<IslandKey>();

  /**
   * Scans the DOM for island elements and creates handles.
   * @param root - The root node to scan. Defaults to document.
   * @param options - Scan configuration options.
   * @returns Readonly array of island handles found.
   */
  scan(
    root: ParentNode | null = getDefaultRoot(),
    options: ScanOptions = {},
  ): readonly IslandHandle[] {
    this.clearState();

    if (!root) {
      return this.handles;
    }

    const computeRects = options.computeRects !== false;
    const dedupeByKey = options.dedupeByKey !== false;

    const elements = findIslandElements(root);
    const handles = this.collectIslandHandles(
      elements,
      computeRects,
      dedupeByKey,
    );

    this.handles = handles;

    // Keep candidate cache aligned
    this.ensureCandidateCacheSize(handles.length);

    return this.handles;
  }

  /**
   * Updates bounding rectangles for island handles.
   * WARNING: Can force layout reflow if applied to many elements.
   * Prefer calling on scroll/resize/mutation, or only for visible keys.
   * @param options - Update configuration options.
   */
  updateRects(options: RectUpdateOptions = {}): void {
    const { keys, skipDisconnected = true } = options;

    if (!keys) {
      // Update all handles
      this.updateAllRects(skipDisconnected);
      return;
    }

    // Update specific subset
    this.updateSubsetRects(keys, skipDisconnected);
  }

  /**
   * Returns candidates using an internal reusable array (avoid GC pressure).
   * IMPORTANT: Treat the returned array as ephemeral. Call candidates() each tick if needed.
   * @returns Array of candidates (reused across calls).
   */
  candidates(): Candidate[] {
    const n = this.handles.length;
    this.ensureCandidateCacheSize(n);

    for (let i = 0; i < n; i++) {
      const h = this.handles[i];
      const c = this.candidatesCache[i];
      c.key = h.key;
      c.rect = h.rect;
    }

    // Keep array length exact
    this.candidatesCache.length = n;

    return this.candidatesCache;
  }

  /**
   * Zero-allocation alternative: caller provides output array.
   * @param out - Array to write candidates into (will be cleared first).
   */
  writeCandidates(out: Candidate[]): void {
    out.length = 0;

    for (const h of this.handles) {
      out.push({ key: h.key, rect: h.rect });
    }
  }

  /**
   * Retrieves a handle by its key.
   * @param key - The island key.
   * @returns The handle if found, undefined otherwise.
   */
  getHandle(key: IslandKey): IslandHandle | undefined {
    return this.handlesByKey.get(key);
  }

  /**
   * Returns all island handles.
   * @returns Readonly array of all handles.
   */
  getAllHandles(): readonly IslandHandle[] {
    return this.handles;
  }

  /**
   * Returns the total number of island handles.
   * @returns Handle count.
   */
  getHandleCount(): number {
    return this.handles.length;
  }

  /**
   * Enables visibility tracking using IntersectionObserver.
   * Use visibleKeysSet() to get visible islands for selective rect updates.
   * @param rootMargin - Observer root margin (default: "256px").
   */
  enableVisibilityTracking(rootMargin = DEFAULT_VISIBILITY_ROOT_MARGIN): void {
    if (!isIntersectionObserverSupported()) {
      return;
    }

    this.disableVisibilityTracking();

    this.io = new IntersectionObserver(
      (entries) => this.handleVisibilityChange(entries),
      {
        root: null,
        rootMargin,
        threshold: VISIBILITY_THRESHOLD,
      },
    );

    // Observe all current handles
    for (const h of this.handles) {
      this.io.observe(h.el);
    }
  }

  /**
   * Disables visibility tracking and clears visible keys.
   */
  disableVisibilityTracking(): void {
    if (this.io) {
      this.io.disconnect();
      this.io = null;
    }

    this.visibleKeys.clear();
  }

  /**
   * Returns the set of currently visible island keys.
   * @returns Readonly set of visible keys.
   */
  visibleKeysSet(): ReadonlySet<IslandKey> {
    return this.visibleKeys;
  }

  // ========================================================================
  // Private Methods - State Management
  // ========================================================================

  private clearState(): void {
    this.handles.length = 0;
    this.handlesByKey.clear();
    this.candidatesCache.length = 0;
    // Note: visibleKeys are NOT cleared here; managed by IntersectionObserver
  }

  private ensureCandidateCacheSize(requiredSize: number): void {
    // Grow cache if needed, reusing objects to minimize allocations
    while (this.candidatesCache.length < requiredSize) {
      this.candidatesCache.push({
        key: 0 as IslandKey,
        rect: { ...ZERO_RECT },
      });
    }
  }

  // ========================================================================
  // Private Methods - Handle Collection
  // ========================================================================

  private collectIslandHandles(
    elements: NodeListOf<HTMLElement>,
    computeRects: boolean,
    dedupeByKey: boolean,
  ): IslandHandle[] {
    const handles: IslandHandle[] = [];

    for (const el of elements) {
      const handle = createIslandHandle(el, computeRects);

      if (!handle) {
        continue;
      }

      // Skip duplicates if deduplication is enabled
      if (dedupeByKey && this.handlesByKey.has(handle.key)) {
        continue;
      }

      handles.push(handle);
      this.handlesByKey.set(handle.key, handle);
    }

    return handles;
  }

  // ========================================================================
  // Private Methods - Rect Updates
  // ========================================================================

  private updateAllRects(skipDisconnected: boolean): void {
    for (const handle of this.handles) {
      if (skipDisconnected && !handle.el.isConnected) {
        continue;
      }

      handle.rect = computeElementRect(handle.el);
    }
  }

  private updateSubsetRects(
    keys: ReadonlySet<IslandKey>,
    skipDisconnected: boolean,
  ): void {
    for (const key of keys) {
      const handle = this.handlesByKey.get(key);

      if (!handle) {
        continue;
      }

      if (skipDisconnected && !handle.el.isConnected) {
        continue;
      }

      handle.rect = computeElementRect(handle.el);
    }
  }

  // ========================================================================
  // Private Methods - Visibility Tracking
  // ========================================================================

  private handleVisibilityChange(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const token = el.getAttribute(ISLAND_ATTRIBUTE);

      if (!token) {
        continue;
      }

      const key = parseIslandKey(token);

      if (!key) {
        continue;
      }

      if (entry.isIntersecting) {
        this.visibleKeys.add(key);
      } else {
        this.visibleKeys.delete(key);
      }
    }
  }
}

// ============================================================================
// Helper Functions - Environment Detection
// ============================================================================

function isIntersectionObserverSupported(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

function getDefaultRoot(): ParentNode | null {
  return typeof document !== "undefined" ? document : null;
}

// ============================================================================
// Helper Functions - DOM Queries
// ============================================================================

function findIslandElements(root: ParentNode): NodeListOf<HTMLElement> {
  return root.querySelectorAll<HTMLElement>(ISLAND_SELECTOR);
}

// ============================================================================
// Helper Functions - Handle Creation
// ============================================================================

function createIslandHandle(
  element: HTMLElement,
  computeRects: boolean,
): IslandHandle | null {
  const token = element.getAttribute(ISLAND_ATTRIBUTE);

  if (!token) {
    return null;
  }

  const key = parseIslandKey(token);

  if (!key) {
    return null;
  }

  const decoded = decodeKey(key);

  return {
    el: element,
    key,
    typeId: decoded.typeId,
    propsId: decoded.propsId,
    flags: decoded.flags,
    rect: computeRects ? computeElementRect(element) : { ...ZERO_RECT },
  };
}

// ============================================================================
// Helper Functions - Geometry
// ============================================================================

function computeElementRect(element: HTMLElement): Rect {
  const bounds = element.getBoundingClientRect();

  return {
    x: bounds.left,
    y: bounds.top,
    w: bounds.width,
    h: bounds.height,
  };
}

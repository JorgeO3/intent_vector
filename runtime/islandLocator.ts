// runtime/islandLocator.ts
import type { Candidate, IslandHandle, IslandKey, Rect } from "./types.ts";
import { decodeKey, parseIslandKey } from "./keyCodec.ts";

// ============================================================================
// Type Definitions
// ============================================================================

type ElementWithIsland = HTMLElement & {
  readonly dataset: DOMStringMap & { nk?: string };
};

type ScanResult = {
  readonly handles: readonly IslandHandle[];
  readonly count: number;
};

// ============================================================================
// Constants
// ============================================================================

const ISLAND_ATTRIBUTE = "data-nk";
const ISLAND_SELECTOR = `[${ISLAND_ATTRIBUTE}]`;

// ============================================================================
// Island Locator Class
// ============================================================================

export class IslandLocator {
  private handles: IslandHandle[] = [];
  private readonly handlesByKey = new Map<IslandKey, IslandHandle>();

  scan(root: ParentNode = document): readonly IslandHandle[] {
    this.clearState();

    const elements = findIslandElements(root);
    const newHandles = collectIslandHandles(elements);

    this.populateState(newHandles);

    return this.handles;
  }

  updateRects(): void {
    for (const handle of this.handles) {
      handle.rect = computeElementRect(handle.el);
    }
  }

  candidates(): Candidate[] {
    return this.handles.map(createCandidate);
  }

  getHandle(key: IslandKey): IslandHandle | undefined {
    return this.handlesByKey.get(key);
  }

  getAllHandles(): readonly IslandHandle[] {
    return this.handles;
  }

  getHandleCount(): number {
    return this.handles.length;
  }

  private clearState(): void {
    this.handles.length = 0;
    this.handlesByKey.clear();
  }

  private populateState(handles: IslandHandle[]): void {
    this.handles = handles;

    for (const handle of handles) {
      this.handlesByKey.set(handle.key, handle);
    }
  }
}

// ============================================================================
// DOM Query Helpers
// ============================================================================

function findIslandElements(root: ParentNode): NodeListOf<HTMLElement> {
  return root.querySelectorAll<HTMLElement>(ISLAND_SELECTOR);
}

function getIslandToken(element: HTMLElement): string | null {
  return element.getAttribute(ISLAND_ATTRIBUTE);
}

// ============================================================================
// Island Handle Creation
// ============================================================================

function collectIslandHandles(
  elements: NodeListOf<HTMLElement>,
): IslandHandle[] {
  const handles: IslandHandle[] = [];

  for (const element of elements) {
    const handle = createIslandHandle(element);
    if (handle) {
      handles.push(handle);
    }
  }

  return handles;
}

function createIslandHandle(element: HTMLElement): IslandHandle | null {
  const token = getIslandToken(element);
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

// ============================================================================
// Geometry Helpers
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

// ============================================================================
// Transformation Helpers
// ============================================================================

function createCandidate(handle: IslandHandle): Candidate {
  return {
    key: handle.key,
    rect: handle.rect,
  };
}

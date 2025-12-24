/**
 * @file tests/dom_shim.ts
 * @description DOM shim para tests en Deno usando deno-dom.
 *
 * Este módulo provee un DOM simulado para poder ejecutar tests
 * que requieren APIs del browser como document, Element, etc.
 */

// deno-lint-ignore-file no-explicit-any
import { Document, DOMParser, Element } from "jsr:@b-fuze/deno-dom";

// ============================================================================
// DOM Setup
// ============================================================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body></body>
</html>`;

let _document: Document | null = null;

/**
 * Initializes a fresh DOM document for testing.
 * Call this at the beginning of tests that need DOM.
 */
export function initDOM(): Document {
  const parser = new DOMParser();
  _document = parser.parseFromString(HTML_TEMPLATE, "text/html");

  if (!_document) {
    throw new Error("Failed to initialize DOM");
  }

  // Inject globals (use any to bypass type conflicts)
  (globalThis as any).document = _document;
  (globalThis as any).Element = Element;
  (globalThis as any).HTMLElement = Element;
  (globalThis as any).HTMLDivElement = Element;
  (globalThis as any).Document = Document;
  (globalThis as any).window = {
    document: _document,
    location: { pathname: "/test", href: "http://localhost/test" },
    navigator: { connection: undefined },
  };

  return _document;
}

/**
 * Cleans up the DOM and removes globals.
 */
export function cleanupDOM(): void {
  if (_document?.body) {
    _document.body.innerHTML = "";
  }
  _document = null;

  delete (globalThis as any).document;
  delete (globalThis as any).Element;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).HTMLDivElement;
  delete (globalThis as any).Document;
  delete (globalThis as any).window;
}

/**
 * Gets the current document, initializing if needed.
 */
export function getDocument(): Document {
  if (!_document) {
    return initDOM();
  }
  return _document;
}

/**
 * Creates an element with the given tag and optional attributes.
 */
export function createElement(
  tag: string,
  attrs?: Record<string, string>,
): Element {
  const doc = getDocument();
  const el = doc.createElement(tag);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
  }

  return el;
}

/**
 * Appends an element to the document body.
 */
export function appendToBody(el: Element): void {
  const doc = getDocument();
  doc.body?.appendChild(el);
}

/**
 * Helper to check if DOM is available (always true after initDOM).
 */
export function hasDOM(): boolean {
  return typeof document !== "undefined" && document !== null;
}

// ============================================================================
// Mock IntersectionObserver (not available in deno-dom)
// ============================================================================

type IntersectionObserverCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver,
) => void;

interface IntersectionObserverEntry {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
  boundingClientRect: DOMRectReadOnly;
  intersectionRect: DOMRectReadOnly;
  rootBounds: DOMRectReadOnly | null;
  time: number;
}

interface IntersectionObserverInit {
  root?: Element | null;
  rootMargin?: string;
  threshold?: number | number[];
}

class MockIntersectionObserver {
  private callback: IntersectionObserverCallback;
  private observedElements: Set<any> = new Set();

  // Required properties for IntersectionObserver interface
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "0px";
  readonly thresholds: ReadonlyArray<number> = [0];

  constructor(
    callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
  }

  observe(target: any): void {
    this.observedElements.add(target);
    // Simulate immediate visibility callback
    const entry: IntersectionObserverEntry = {
      target,
      isIntersecting: true,
      intersectionRatio: 1.0,
      boundingClientRect: {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        top: 0,
        right: 100,
        bottom: 50,
        left: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly,
      intersectionRect: {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        top: 0,
        right: 100,
        bottom: 50,
        left: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly,
      rootBounds: null,
      time: performance.now(),
    };
    // Defer callback to next tick - use 'this as any' to bypass type check
    queueMicrotask(() => this.callback([entry], this as any));
  }

  unobserve(target: any): void {
    this.observedElements.delete(target);
  }

  disconnect(): void {
    this.observedElements.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * Installs mock IntersectionObserver globally.
 */
export function installIntersectionObserver(): void {
  (globalThis as any).IntersectionObserver = MockIntersectionObserver;
}

/**
 * Removes mock IntersectionObserver.
 */
export function uninstallIntersectionObserver(): void {
  delete (globalThis as any).IntersectionObserver;
}

// ============================================================================
// Mock getBoundingClientRect (deno-dom elements don't have layout)
// ============================================================================

const rectCache = new WeakMap<any, DOMRect>();

/**
 * Sets a mock bounding rect for an element.
 */
export function setMockRect(el: any, rect: Partial<DOMRect>): void {
  const fullRect = {
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width ?? 100,
    height: rect.height ?? 50,
    top: rect.top ?? rect.y ?? 0,
    right: rect.right ?? (rect.x ?? 0) + (rect.width ?? 100),
    bottom: rect.bottom ?? (rect.y ?? 0) + (rect.height ?? 50),
    left: rect.left ?? rect.x ?? 0,
    toJSON() {
      return this;
    },
  } as DOMRect;

  rectCache.set(el, fullRect);

  // Monkey-patch getBoundingClientRect
  el.getBoundingClientRect = () => {
    return rectCache.get(el) ?? fullRect;
  };

  // Monkey-patch isConnected (deno-dom doesn't have it)
  if (el.isConnected === undefined) {
    Object.defineProperty(el, "isConnected", {
      get() {
        return this.parentNode !== null;
      },
      configurable: true,
    });
  }
}

// ============================================================================
// Full DOM Test Setup/Teardown
// ============================================================================

/**
 * Complete setup for DOM tests. Call in beforeEach or at test start.
 */
export function setupDOMTest(): Document {
  const doc = initDOM();
  installIntersectionObserver();
  return doc;
}

/**
 * Complete teardown for DOM tests. Call in afterEach or at test end.
 */
export function teardownDOMTest(): void {
  uninstallIntersectionObserver();
  cleanupDOM();
}

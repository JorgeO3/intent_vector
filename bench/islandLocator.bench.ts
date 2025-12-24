/**
 * @file bench/islandLocator.bench.ts
 * @description Benchmarks para IslandLocator (escaneo DOM)
 *
 * Nota: Estos benchmarks usan deno-dom para simular el DOM
 */

import { IslandLocator } from "../runtime/islandLocator.ts";
import { encodeIslandToken } from "../runtime/islandToken.ts";
import { type Document, DOMParser, Element } from "@b-fuze/deno-dom";

// deno-lint-ignore no-explicit-any
type AnyElement = any;

// Setup DOM
function createDOM(): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    "<!DOCTYPE html><html><body></body></html>",
    "text/html",
  );

  // Inject globals
  (globalThis as AnyElement).document = doc;
  (globalThis as AnyElement).Element = Element;
  (globalThis as AnyElement).HTMLElement = Element;

  return doc!;
}

function createIslandElements(doc: Document, count: number): Element {
  const container = doc.createElement("div");

  for (let i = 0; i < count; i++) {
    const el = doc.createElement("div");
    const token = encodeIslandToken(
      (i % 4095) + 1,
      i * 100,
      i % 8,
    );
    el.setAttribute("data-nk", token);

    // Mock getBoundingClientRect
    (el as AnyElement).getBoundingClientRect = () => ({
      x: (i * 50) % 1200,
      y: (i * 30) % 800,
      width: 100,
      height: 50,
      top: (i * 30) % 800,
      left: (i * 50) % 1200,
      right: ((i * 50) % 1200) + 100,
      bottom: ((i * 30) % 800) + 50,
    });

    // Mock isConnected
    Object.defineProperty(el, "isConnected", {
      get() {
        return this.parentNode !== null;
      },
      configurable: true,
    });

    container.appendChild(el);
  }

  doc.body?.appendChild(container);
  return container;
}

const doc = createDOM();

// Pre-setup containers for benchmarks
const container10 = createIslandElements(doc, 10);
const locator10 = new IslandLocator();

const container100a = createIslandElements(doc, 100);
const locator100a = new IslandLocator();

const container500 = createIslandElements(doc, 500);
const locator500 = new IslandLocator();

const container100b = createIslandElements(doc, 100);
const locator100b = new IslandLocator();
locator100b.scan(container100b as AnyElement);

const container100c = createIslandElements(doc, 100);
const locator100c = new IslandLocator();
locator100c.scan(container100c as AnyElement, { computeRects: false });

const container100d = createIslandElements(doc, 100);
const locator100d = new IslandLocator();
const handles = locator100d.scan(container100d as AnyElement);
const keys = handles.map((h) => h.key);

let counter = 0;

Deno.bench("IslandLocator: scan() 10 elements", () => {
  locator10.scan(container10 as AnyElement);
});

Deno.bench("IslandLocator: scan() 100 elements", () => {
  locator100a.scan(container100a as AnyElement);
});

Deno.bench("IslandLocator: scan() 500 elements", () => {
  locator500.scan(container500 as AnyElement);
});

Deno.bench("IslandLocator: candidates() with 100 elements", () => {
  locator100b.candidates();
});

Deno.bench("IslandLocator: updateRects() with 100 elements", () => {
  locator100c.updateRects();
});

Deno.bench("IslandLocator: getHandle()", () => {
  locator100d.getHandle(keys[counter % keys.length]);
  counter++;
});

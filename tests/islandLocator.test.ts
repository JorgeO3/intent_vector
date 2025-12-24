/**
 * @file tests/islandLocator.test.ts
 * @description Pruebas del escaneo DOM y localización de islas.
 *
 * Usa deno-dom para simular el DOM en Deno.
 *
 * Validaciones críticas:
 * - Escaneo de elementos con data-nk
 * - Deduplicación por key
 * - Cálculo de bounding rects
 * - IntersectionObserver para visibilidad
 * - Elementos anidados
 */

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertExists } from "@std/assert";
import { IslandLocator } from "../runtime/islandLocator.ts";
import { encodeIslandToken } from "../runtime/islandToken.ts";
import type { Candidate, IslandKey } from "../runtime/types.ts";
import { IslandFlags } from "../runtime/types.ts";
import {
  getDocument,
  setMockRect,
  setupDOMTest,
  teardownDOMTest,
} from "./dom_shim.ts";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestContainer(): any {
  const doc = getDocument();
  const container = doc.createElement("div");
  container.setAttribute("id", "test-container");
  doc.body?.appendChild(container);
  return container;
}

function cleanupTestContainer(container: any): void {
  container.parentNode?.removeChild(container);
}

function createIslandElement(
  typeId: number,
  propsId: number,
  flags: number = IslandFlags.PrefetchSafe,
): any {
  const doc = getDocument();
  const el = doc.createElement("div");
  const token = encodeIslandToken(typeId, propsId, flags);
  el.setAttribute("data-nk", token);
  // Set mock rect for getBoundingClientRect
  setMockRect(el, { x: 0, y: 0, width: 100, height: 50 });
  return el;
}

// ============================================================================
// 1. Pruebas de Unit (sin DOM)
// ============================================================================

Deno.test("IslandLocator: instanciación sin DOM no crashea", () => {
  const locator = new IslandLocator();
  assertExists(locator);
});

Deno.test("IslandLocator: scan sin root retorna array vacío", () => {
  const locator = new IslandLocator();
  const handles = locator.scan(null);
  assertEquals(handles.length, 0);
});

Deno.test("IslandLocator: candidates en locator vacío retorna array vacío", () => {
  const locator = new IslandLocator();
  locator.scan(null);
  const candidates = locator.candidates();
  assertEquals(candidates.length, 0);
});

Deno.test("IslandLocator: getAllHandles retorna array readonly", () => {
  const locator = new IslandLocator();
  const handles = locator.getAllHandles();
  assert(Array.isArray(handles));
  assertEquals(handles.length, 0);
});

Deno.test("IslandLocator: getHandleCount es 0 inicialmente", () => {
  const locator = new IslandLocator();
  assertEquals(locator.getHandleCount(), 0);
});

Deno.test("IslandLocator: getHandle de key inexistente retorna undefined", () => {
  const locator = new IslandLocator();
  const handle = locator.getHandle(12345 as IslandKey);
  assertEquals(handle, undefined);
});

Deno.test("IslandLocator: visibleKeysSet retorna Set vacío inicialmente", () => {
  const locator = new IslandLocator();
  const visible = locator.visibleKeysSet();
  assert(visible instanceof Set);
  assertEquals(visible.size, 0);
});

Deno.test("IslandLocator: writeCandidates limpia array de salida", () => {
  const locator = new IslandLocator();
  const out: Candidate[] = [
    { key: 1 as IslandKey, rect: { x: 0, y: 0, w: 0, h: 0 } },
  ];
  locator.writeCandidates(out);
  assertEquals(out.length, 0);
});

// ============================================================================
// 2. Pruebas DOM - Escaneo Básico (con deno-dom)
// ============================================================================

Deno.test("IslandLocator: scan encuentra elementos data-nk", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(
      createIslandElement(1, 100, IslandFlags.PrefetchSafe),
    );
    container.appendChild(
      createIslandElement(2, 200, IslandFlags.PrefetchSafe),
    );

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 2);
    assertEquals(locator.getHandleCount(), 2);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: scan parsea correctamente typeId/propsId/flags", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(createIslandElement(42, 12345, 7));

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 1);
    assertEquals(handles[0].typeId, 42);
    assertEquals(handles[0].propsId, 12345);
    assertEquals(handles[0].flags, 7);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: scan asocia elemento DOM al handle", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    const el = createIslandElement(1, 100, 0);
    el.setAttribute("id", "test-island");
    container.appendChild(el);

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles[0].el.id, "test-island");
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 3. Pruebas DOM - Deduplicación
// ============================================================================

Deno.test("IslandLocator: deduplica elementos con mismo key", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    // Dos elementos con el mismo token (mismo key)
    container.appendChild(createIslandElement(1, 100, 0));
    container.appendChild(createIslandElement(1, 100, 0)); // Duplicado

    const locator = new IslandLocator();
    const handles = locator.scan(container, { dedupeByKey: true });

    assertEquals(handles.length, 1, "Debe deduplicar por key");
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: sin dedupe permite duplicados", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(createIslandElement(1, 100, 0));
    container.appendChild(createIslandElement(1, 100, 0));

    const locator = new IslandLocator();
    const handles = locator.scan(container, { dedupeByKey: false });

    assertEquals(handles.length, 2, "Sin dedupe debe encontrar ambos");
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 4. Pruebas DOM - Rectángulos
// ============================================================================

Deno.test("IslandLocator: computeRects=true calcula bounding rect", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    const el = createIslandElement(1, 100, 0);
    setMockRect(el, { x: 10, y: 20, width: 100, height: 50 });
    container.appendChild(el);

    const locator = new IslandLocator();
    const handles = locator.scan(container, { computeRects: true });

    const rect = handles[0].rect;
    assertEquals(rect.w, 100);
    assertEquals(rect.h, 50);
    assertEquals(rect.x, 10);
    assertEquals(rect.y, 20);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: computeRects=false usa rect cero", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(createIslandElement(1, 100, 0));

    const locator = new IslandLocator();
    const handles = locator.scan(container, { computeRects: false });

    const rect = handles[0].rect;
    assertEquals(rect.x, 0);
    assertEquals(rect.y, 0);
    assertEquals(rect.w, 0);
    assertEquals(rect.h, 0);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: updateRects actualiza rectángulos", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    const el = createIslandElement(1, 100, 0);
    setMockRect(el, { width: 50, height: 25 });
    container.appendChild(el);

    const locator = new IslandLocator();
    locator.scan(container, { computeRects: false });

    // Inicialmente cero
    assertEquals(locator.getAllHandles()[0].rect.w, 0);

    // Actualizar
    locator.updateRects();

    // Ahora debería tener el tamaño del mock
    assertEquals(locator.getAllHandles()[0].rect.w, 50);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: updateRects con subset de keys", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    const el1 = createIslandElement(1, 100, 0);
    const el2 = createIslandElement(2, 200, 0);
    setMockRect(el1, { width: 100 });
    setMockRect(el2, { width: 200 });
    container.appendChild(el1);
    container.appendChild(el2);

    const locator = new IslandLocator();
    const handles = locator.scan(container, { computeRects: false });

    const key1 = handles[0].key;

    // Solo actualizar el primero
    locator.updateRects({ keys: new Set([key1]) });

    assertEquals(locator.getHandle(key1)!.rect.w, 100);
    // El segundo debería seguir en cero
    assertEquals(handles[1].rect.w, 0);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 5. Pruebas DOM - Elementos Anidados
// ============================================================================

Deno.test("IslandLocator: encuentra elementos anidados", () => {
  setupDOMTest();
  const container = createTestContainer();
  const doc = getDocument();

  try {
    const parent = doc.createElement("div");
    const child = createIslandElement(1, 100, 0);
    parent.appendChild(child);
    container.appendChild(parent);

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 1);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: encuentra múltiples niveles de anidamiento", () => {
  setupDOMTest();
  const container = createTestContainer();
  const doc = getDocument();

  try {
    const level1 = doc.createElement("div");
    const level2 = doc.createElement("section");
    const island = createIslandElement(5, 500, 0);

    level2.appendChild(island);
    level1.appendChild(level2);
    container.appendChild(level1);

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 1);
    assertEquals(handles[0].typeId, 5);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 6. Pruebas DOM - Candidates API
// ============================================================================

Deno.test("IslandLocator: candidates retorna array reutilizable", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(createIslandElement(1, 100, 0));
    container.appendChild(createIslandElement(2, 200, 0));

    const locator = new IslandLocator();
    locator.scan(container);

    const candidates1 = locator.candidates();
    const candidates2 = locator.candidates();

    // Mismo array (reutilizado)
    assertEquals(candidates1, candidates2);
    assertEquals(candidates1.length, 2);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: writeCandidates llena array externo", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(createIslandElement(1, 100, 0));

    const locator = new IslandLocator();
    locator.scan(container);

    const out: Candidate[] = [];
    locator.writeCandidates(out);

    assertEquals(out.length, 1);
    assertExists(out[0].key);
    assertExists(out[0].rect);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 7. Pruebas DOM - getHandle
// ============================================================================

Deno.test("IslandLocator: getHandle encuentra handle por key", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    container.appendChild(createIslandElement(42, 999, 0));

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    const key = handles[0].key;
    const found = locator.getHandle(key);

    assertExists(found);
    assertEquals(found!.typeId, 42);
    assertEquals(found!.propsId, 999);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 8. Pruebas DOM - Tokens Inválidos
// ============================================================================

Deno.test("IslandLocator: ignora elementos sin data-nk", () => {
  setupDOMTest();
  const container = createTestContainer();
  const doc = getDocument();

  try {
    const withAttr = createIslandElement(1, 100, 0);
    const withoutAttr = doc.createElement("div");

    container.appendChild(withAttr);
    container.appendChild(withoutAttr);

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 1);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: ignora elementos con data-nk vacío", () => {
  setupDOMTest();
  const container = createTestContainer();
  const doc = getDocument();

  try {
    const validIsland = createIslandElement(1, 100, 0);
    const emptyAttr = doc.createElement("div");
    emptyAttr.setAttribute("data-nk", "");

    container.appendChild(validIsland);
    container.appendChild(emptyAttr);

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 1);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: ignora elementos con data-nk inválido", () => {
  setupDOMTest();
  const container = createTestContainer();
  const doc = getDocument();

  try {
    const validIsland = createIslandElement(1, 100, 0);
    const invalidAttr = doc.createElement("div");
    invalidAttr.setAttribute("data-nk", "!@#$%"); // Truly invalid base-36

    container.appendChild(validIsland);
    container.appendChild(invalidAttr);

    const locator = new IslandLocator();
    const handles = locator.scan(container);

    assertEquals(handles.length, 1);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 9. Pruebas DOM - Visibility Tracking
// ============================================================================

Deno.test("IslandLocator: enableVisibilityTracking no crashea", () => {
  setupDOMTest();
  const locator = new IslandLocator();

  try {
    // Con mock IntersectionObserver, no debería crashear
    locator.enableVisibilityTracking();
    locator.disableVisibilityTracking();
  } finally {
    teardownDOMTest();
  }
});

Deno.test("IslandLocator: disableVisibilityTracking limpia estado", () => {
  setupDOMTest();
  const locator = new IslandLocator();

  try {
    locator.enableVisibilityTracking();
    locator.disableVisibilityTracking();

    assertEquals(locator.visibleKeysSet().size, 0);
  } finally {
    teardownDOMTest();
  }
});

// ============================================================================
// 10. Pruebas DOM - Re-scan
// ============================================================================

Deno.test("IslandLocator: scan múltiples veces reemplaza handles", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    // Primer scan
    container.appendChild(createIslandElement(1, 100, 0));
    const locator = new IslandLocator();
    locator.scan(container);
    assertEquals(locator.getHandleCount(), 1);

    // Limpiar y re-poblar
    container.textContent = "";
    container.appendChild(createIslandElement(2, 200, 0));
    container.appendChild(createIslandElement(3, 300, 0));

    // Segundo scan
    locator.scan(container);
    assertEquals(locator.getHandleCount(), 2);

    // Handles anteriores ya no deberían existir
    const oldHandle = locator.getAllHandles().find((h) => h.typeId === 1);
    assertEquals(oldHandle, undefined);
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

// ============================================================================
// 11. Pruebas de Elementos Desconectados
// ============================================================================

Deno.test("IslandLocator: updateRects skipDisconnected=true no crashea", () => {
  setupDOMTest();
  const container = createTestContainer();

  try {
    const el = createIslandElement(1, 100, 0);
    setMockRect(el, { width: 100 });
    container.appendChild(el);

    const locator = new IslandLocator();
    locator.scan(container, { computeRects: true });

    // Desconectar el elemento
    el.parentNode?.removeChild(el);

    // No debería crashear
    locator.updateRects({ skipDisconnected: true });
  } finally {
    cleanupTestContainer(container);
    teardownDOMTest();
  }
});

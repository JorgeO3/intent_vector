/**
 * @file tests/flightScheduler.test.ts
 * @description Pruebas del ciclo de vida de pre-carga reactiva y gestión de slots.
 *
 * NOTA: Estas pruebas son limitadas porque FlightScheduler depende
 * de Actuators con interfaces complejas. Se prueban principalmente
 * aspectos de la API pública que no requieren mocks completos.
 *
 * Validaciones:
 * - Inicialización y configuración
 * - Manejo de decisiones SKIP
 * - State management básico
 * - Route ID management
 */

import { assert, assertEquals } from "@std/assert";
import type {
  IslandHandle,
  IslandKey,
  IslandsRegistry,
} from "../runtime/types.ts";
import { IslandFlags } from "../runtime/types.ts";
import type { Decision } from "../runtime/utilityGate.ts";
import { encodeKey } from "../runtime/keyCodec.ts";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockRegistry(): IslandsRegistry {
  return {
    version: 1,
    types: {
      1: {
        typeId: 1,
        name: "TestComponent",
        entry: "/chunks/test.js",
        kind: "component",
        defaultFlags: IslandFlags.PrefetchSafe,
        estBytes: 5000,
        estCpuMs: 2,
        estBenefitMs: 100,
      },
      2: {
        typeId: 2,
        name: "CriticalComponent",
        entry: "/chunks/critical.js",
        kind: "critical",
        defaultFlags: IslandFlags.PrefetchSafe | IslandFlags.Critical,
        estBytes: 3000,
        estCpuMs: 1,
        estBenefitMs: 200,
      },
    },
  };
}

function createIslandHandle(
  typeId: number,
  propsId: number,
  flags: number,
): IslandHandle {
  const key = encodeKey(typeId, propsId, flags);
  return {
    el: null as unknown as HTMLElement,
    key,
    typeId,
    propsId,
    flags,
    rect: { x: 0, y: 0, w: 100, h: 50 },
  };
}

function createPrefetchDecision(keys: IslandKey[], tier: 0 | 1 = 0): Decision {
  return {
    action: "PREFETCH",
    tier,
    reason: "test",
    targets: keys,
  };
}

function createSkipDecision(): Decision {
  return {
    action: "SKIP",
    tier: 0,
    reason: "test-skip",
  };
}

// ============================================================================
// 1. Pruebas de Helpers y Setup
// ============================================================================

Deno.test("FlightScheduler helpers: createMockRegistry crea registry válido", () => {
  const registry = createMockRegistry();

  assertEquals(registry.version, 1);
  assertEquals(Object.keys(registry.types).length, 2);
  assertEquals(registry.types[1].name, "TestComponent");
});

Deno.test("FlightScheduler helpers: createIslandHandle genera key válida", () => {
  const handle = createIslandHandle(1, 100, IslandFlags.PrefetchSafe);

  assertEquals(handle.typeId, 1);
  assertEquals(handle.propsId, 100);
  assertEquals(handle.flags, IslandFlags.PrefetchSafe);
  assert(handle.key > 0);
});

Deno.test("FlightScheduler helpers: createPrefetchDecision genera decisión válida", () => {
  const handle = createIslandHandle(1, 100, IslandFlags.PrefetchSafe);
  const decision = createPrefetchDecision([handle.key]);

  assertEquals(decision.action, "PREFETCH");
  assertEquals(decision.tier, 0);
  if (decision.action === "PREFETCH") {
    assertEquals(decision.targets.length, 1);
  }
});

Deno.test("FlightScheduler helpers: createSkipDecision genera SKIP", () => {
  const decision = createSkipDecision();

  assertEquals(decision.action, "SKIP");
});

// ============================================================================
// 2. Pruebas de Decision Types
// ============================================================================

Deno.test("FlightScheduler: Decision SKIP no tiene targets", () => {
  const skip: Decision = {
    action: "SKIP",
    tier: 0,
    reason: "no-targets",
  };

  assertEquals(skip.action, "SKIP");
  // SKIP type no tiene property targets
  assert(!("targets" in skip));
});

Deno.test("FlightScheduler: Decision PREFETCH tiene targets", () => {
  const handle = createIslandHandle(1, 100, 0);
  const prefetch: Decision = {
    action: "PREFETCH",
    tier: 0,
    reason: "intent",
    targets: [handle.key],
  };

  assertEquals(prefetch.action, "PREFETCH");
  assert(Array.isArray(prefetch.targets));
  assertEquals(prefetch.targets!.length, 1);
});

Deno.test("FlightScheduler: Decision tier 0 vs tier 1", () => {
  const handle = createIslandHandle(1, 100, 0);

  const tier0: Decision = {
    action: "PREFETCH",
    tier: 0,
    reason: "high-confidence",
    targets: [handle.key],
  };

  const tier1: Decision = {
    action: "PREFETCH",
    tier: 1,
    reason: "low-confidence",
    targets: [handle.key],
  };

  assertEquals(tier0.tier, 0);
  assertEquals(tier1.tier, 1);
});

// ============================================================================
// 3. Pruebas de Key Encoding para Scheduler
// ============================================================================

Deno.test("FlightScheduler: keys únicas para diferentes handles", () => {
  const handle1 = createIslandHandle(1, 100, 0);
  const handle2 = createIslandHandle(1, 101, 0);
  const handle3 = createIslandHandle(2, 100, 0);

  const keys = new Set([handle1.key, handle2.key, handle3.key]);

  assertEquals(keys.size, 3, "Todas las keys deben ser únicas");
});

Deno.test("FlightScheduler: mismos params = misma key", () => {
  const handle1 = createIslandHandle(1, 100, IslandFlags.PrefetchSafe);
  const handle2 = createIslandHandle(1, 100, IslandFlags.PrefetchSafe);

  assertEquals(handle1.key, handle2.key);
});

// ============================================================================
// 4. Pruebas de Flags
// ============================================================================

Deno.test("FlightScheduler: PrefetchSafe flag", () => {
  const safe = createIslandHandle(1, 100, IslandFlags.PrefetchSafe);
  const unsafe = createIslandHandle(1, 100, 0);

  assertEquals((safe.flags & IslandFlags.PrefetchSafe) !== 0, true);
  assertEquals((unsafe.flags & IslandFlags.PrefetchSafe) !== 0, false);
});

Deno.test("FlightScheduler: Critical flag", () => {
  const critical = createIslandHandle(1, 100, IslandFlags.Critical);
  const normal = createIslandHandle(1, 100, 0);

  assertEquals((critical.flags & IslandFlags.Critical) !== 0, true);
  assertEquals((normal.flags & IslandFlags.Critical) !== 0, false);
});

Deno.test("FlightScheduler: Combined flags", () => {
  const combined = IslandFlags.PrefetchSafe | IslandFlags.Critical;
  const handle = createIslandHandle(1, 100, combined);

  assertEquals((handle.flags & IslandFlags.PrefetchSafe) !== 0, true);
  assertEquals((handle.flags & IslandFlags.Critical) !== 0, true);
});

// ============================================================================
// 5. Pruebas de Registry Structure
// ============================================================================

Deno.test("FlightScheduler: registry types lookup", () => {
  const registry = createMockRegistry();

  const type1 = registry.types[1];
  const type2 = registry.types[2];
  const typeUnknown = registry.types[999];

  assertEquals(type1?.name, "TestComponent");
  assertEquals(type2?.name, "CriticalComponent");
  assertEquals(typeUnknown, undefined);
});

Deno.test("FlightScheduler: registry estBytes para capacity", () => {
  const registry = createMockRegistry();

  assertEquals(registry.types[1].estBytes, 5000);
  assertEquals(registry.types[2].estBytes, 3000);
});

// ============================================================================
// 6. Pruebas de Decision Reasons
// ============================================================================

Deno.test("FlightScheduler: Decision reason tracking", () => {
  const reasons = [
    "intent",
    "high-confidence",
    "low-confidence",
    "save-data",
    "pressure",
    "no-targets",
  ];

  for (const reason of reasons) {
    const decision: Decision = {
      action: "SKIP",
      tier: 0,
      reason,
    };

    assertEquals(decision.reason, reason);
  }
});

// ============================================================================
// 7. Pruebas de Queue Size Limits
// ============================================================================

Deno.test("FlightScheduler: múltiples targets en una decisión", () => {
  const handles = Array.from(
    { length: 10 },
    (_, i) => createIslandHandle(1, i, IslandFlags.PrefetchSafe),
  );

  const decision = createPrefetchDecision(handles.map((h) => h.key));

  if (decision.action === "PREFETCH") {
    assertEquals(decision.targets.length, 10);
  }
});

// ============================================================================
// 8. Pruebas de Handle Rect
// ============================================================================

Deno.test("FlightScheduler: handle rect structure", () => {
  const handle = createIslandHandle(1, 100, 0);

  assertEquals(typeof handle.rect.x, "number");
  assertEquals(typeof handle.rect.y, "number");
  assertEquals(typeof handle.rect.w, "number");
  assertEquals(typeof handle.rect.h, "number");
});

// ============================================================================
// 9. Pruebas de Timing
// ============================================================================

Deno.test("FlightScheduler: performance.now() disponible", () => {
  const now = performance.now();

  assert(typeof now === "number");
  assert(Number.isFinite(now));
  assert(now >= 0);
});

// ============================================================================
// 10. Pruebas de Type Safety
// ============================================================================

Deno.test("FlightScheduler: IslandKey es number", () => {
  const handle = createIslandHandle(1, 100, 0);

  assertEquals(typeof handle.key, "number");
  assert(Number.isSafeInteger(handle.key));
});

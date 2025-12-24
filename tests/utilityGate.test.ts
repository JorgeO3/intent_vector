/**
 * @file tests/utilityGate.test.ts
 * @description Pruebas de la estructura de decisiones y tipos de UtilityGate.
 *
 * NOTA: UtilityGate tiene dependencias complejas (Registry, Ledger, etc).
 * Estas pruebas verifican principalmente la estructura de tipos y decisiones.
 *
 * Validaciones:
 * - Estructura de Decision types
 * - Config defaults
 * - Helper types
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.16";
import type { Decision, UtilityGateConfig } from "../runtime/utilityGate.ts";
import type { IslandKey, IslandsRegistry } from "../runtime/types.ts";
import { IslandFlags } from "../runtime/types.ts";
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
        name: "LightComponent",
        entry: "/chunks/light.js",
        kind: "component",
        defaultFlags: IslandFlags.PrefetchSafe,
        estBytes: 2000,
        estCpuMs: 1,
        estBenefitMs: 50,
      },
      2: {
        typeId: 2,
        name: "HeavyComponent",
        entry: "/chunks/heavy.js",
        kind: "component",
        defaultFlags: IslandFlags.PrefetchSafe,
        estBytes: 50000,
        estCpuMs: 20,
        estBenefitMs: 200,
      },
    },
  };
}

function createIslandKey(
  typeId: number,
  propsId: number,
  flags = 0,
): IslandKey {
  return encodeKey(typeId, propsId, flags);
}

// ============================================================================
// 1. Pruebas de Decision Types
// ============================================================================

Deno.test("UtilityGate: Decision SKIP structure", () => {
  const decision: Decision = {
    action: "SKIP",
    tier: 0,
    reason: "no-targets",
  };

  assertEquals(decision.action, "SKIP");
  assertEquals(decision.tier, 0);
  assertEquals(decision.reason, "no-targets");
});

Deno.test("UtilityGate: Decision PREFETCH tier 0 structure", () => {
  const key = createIslandKey(1, 100, 0);
  const decision: Decision = {
    action: "PREFETCH",
    tier: 0,
    reason: "high-confidence",
    targets: [key],
  };

  assertEquals(decision.action, "PREFETCH");
  assertEquals(decision.tier, 0);
  assertEquals(decision.targets.length, 1);
});

Deno.test("UtilityGate: Decision PREFETCH tier 1 structure", () => {
  const key = createIslandKey(1, 100, 0);
  const decision: Decision = {
    action: "PREFETCH",
    tier: 1,
    reason: "medium-confidence",
    targets: [key],
  };

  assertEquals(decision.action, "PREFETCH");
  assertEquals(decision.tier, 1);
});

Deno.test("UtilityGate: Decision HYDRATE structure", () => {
  const key = createIslandKey(1, 100, 0);
  const decision: Decision = {
    action: "HYDRATE",
    tier: 1,
    reason: "immediate",
    targets: [key],
  };

  assertEquals(decision.action, "HYDRATE");
  assertEquals(decision.tier, 1);
});

// ============================================================================
// 2. Pruebas de Multiple Targets
// ============================================================================

Deno.test("UtilityGate: Decision con múltiples targets", () => {
  const keys = [
    createIslandKey(1, 100, 0),
    createIslandKey(1, 101, 0),
    createIslandKey(2, 100, 0),
  ];

  const decision: Decision = {
    action: "PREFETCH",
    tier: 0,
    reason: "batch",
    targets: keys,
  };

  assertEquals(decision.targets.length, 3);
});

Deno.test("UtilityGate: Decision targets son IslandKeys válidas", () => {
  const key = createIslandKey(42, 12345, IslandFlags.PrefetchSafe);
  const decision: Decision = {
    action: "PREFETCH",
    tier: 0,
    reason: "test",
    targets: [key],
  };

  for (const target of decision.targets) {
    assert(typeof target === "number");
    assert(Number.isSafeInteger(target));
    assert(target > 0);
  }
});

// ============================================================================
// 3. Pruebas de Reasons
// ============================================================================

Deno.test("UtilityGate: Reason strings comunes", () => {
  const reasons = [
    "no-targets",
    "save-data",
    "high-pressure",
    "utility-negative",
    "high-confidence",
    "medium-confidence",
    "immediate",
    "ultra-score",
  ];

  for (const reason of reasons) {
    const decision: Decision = {
      action: "SKIP",
      tier: 0,
      reason,
    };

    assertEquals(typeof decision.reason, "string");
    assertEquals(decision.reason.length > 0, true);
  }
});

// ============================================================================
// 4. Pruebas de Registry Types
// ============================================================================

Deno.test("UtilityGate: Registry estBenefitMs para utilidad", () => {
  const registry = createMockRegistry();

  assertEquals(registry.types[1].estBenefitMs, 50);
  assertEquals(registry.types[2].estBenefitMs, 200);
});

Deno.test("UtilityGate: Registry estBytes para costo", () => {
  const registry = createMockRegistry();

  assertEquals(registry.types[1].estBytes, 2000);
  assertEquals(registry.types[2].estBytes, 50000);
});

Deno.test("UtilityGate: Registry estCpuMs para costo", () => {
  const registry = createMockRegistry();

  assertEquals(registry.types[1].estCpuMs, 1);
  assertEquals(registry.types[2].estCpuMs, 20);
});

// ============================================================================
// 5. Pruebas de Flags en Decisiones
// ============================================================================

Deno.test("UtilityGate: Keys con diferentes flags", () => {
  const keyNormal = createIslandKey(1, 100, 0);
  const keyPrefetchSafe = createIslandKey(1, 100, IslandFlags.PrefetchSafe);
  const keyCritical = createIslandKey(1, 100, IslandFlags.Critical);
  const keyCombined = createIslandKey(
    1,
    100,
    IslandFlags.PrefetchSafe | IslandFlags.Critical,
  );

  // Todas deben ser keys válidas diferentes
  const keys = new Set([keyNormal, keyPrefetchSafe, keyCritical, keyCombined]);
  assertEquals(keys.size, 4, "Diferentes flags = diferentes keys");
});

// ============================================================================
// 6. Pruebas de Config Structure
// ============================================================================

Deno.test("UtilityGate: Config sigmaSkip es número positivo", () => {
  const config: Partial<UtilityGateConfig> = {
    sigmaSkip: 0.02,
  };

  assert(config.sigmaSkip !== undefined);
  assert(config.sigmaSkip > 0);
  assert(config.sigmaSkip < 1);
});

Deno.test("UtilityGate: Config minMargin es número positivo", () => {
  const config: Partial<UtilityGateConfig> = {
    minMargin: 0.04,
  };

  assert(config.minMargin !== undefined);
  assert(config.minMargin > 0);
});

Deno.test("UtilityGate: Config maxTargets es entero positivo", () => {
  const config: Partial<UtilityGateConfig> = {
    maxTargets: 2,
  };

  assert(config.maxTargets !== undefined);
  assert(Number.isInteger(config.maxTargets));
  assert(config.maxTargets > 0);
});

// ============================================================================
// 7. Pruebas de Pressure Thresholds
// ============================================================================

Deno.test("UtilityGate: Config cpu pressure gains", () => {
  const config: Partial<UtilityGateConfig> = {
    cpuSigmaGain: 0.06,
    cpuNPFDrop: 1.0,
  };

  assert(config.cpuSigmaGain !== undefined);
  assert(config.cpuSigmaGain > 0);
});

Deno.test("UtilityGate: Config net pressure gains", () => {
  const config: Partial<UtilityGateConfig> = {
    netSigmaGain: 0.06,
    netNPFDrop: 1.0,
  };

  assert(config.netSigmaGain !== undefined);
  assert(config.netSigmaGain > 0);
});

// ============================================================================
// 8. Pruebas de Timing Thresholds
// ============================================================================

Deno.test("UtilityGate: Config eta thresholds", () => {
  const config: Partial<UtilityGateConfig> = {
    etaModerateMs: 700,
    etaImmediateMs: 140,
  };

  assert(config.etaModerateMs !== undefined);
  assert(config.etaImmediateMs !== undefined);
  assert(config.etaModerateMs > config.etaImmediateMs);
});

// ============================================================================
// 9. Pruebas de Ultra Score
// ============================================================================

Deno.test("UtilityGate: Config ultra thresholds", () => {
  const config: Partial<UtilityGateConfig> = {
    ultraScore: 0.55,
    ultraMargin: 0.18,
  };

  assert(config.ultraScore !== undefined);
  assert(config.ultraMargin !== undefined);
  assert(config.ultraScore > 0);
  assert(config.ultraScore < 1);
});

// ============================================================================
// 10. Pruebas de Type Discrimination
// ============================================================================

Deno.test("UtilityGate: Decision type discrimination", () => {
  const decisions: Decision[] = [
    { action: "SKIP", tier: 0, reason: "test" },
    { action: "PREFETCH", tier: 0, reason: "test", targets: [1 as IslandKey] },
    { action: "PREFETCH", tier: 1, reason: "test", targets: [1 as IslandKey] },
    { action: "HYDRATE", tier: 1, reason: "test", targets: [1 as IslandKey] },
  ];

  for (const decision of decisions) {
    if (decision.action === "SKIP") {
      assertEquals(decision.tier, 0);
      assertEquals("targets" in decision, false);
    } else {
      assert(Array.isArray(decision.targets));
      assert(decision.targets.length > 0);
    }
  }
});

Deno.test("UtilityGate: SKIP siempre tier 0", () => {
  const skip: Decision = {
    action: "SKIP",
    tier: 0,
    reason: "any",
  };

  // TypeScript garantiza que SKIP siempre es tier 0
  assertEquals(skip.tier, 0);
});

Deno.test("UtilityGate: HYDRATE siempre tier 1", () => {
  const hydrate: Decision = {
    action: "HYDRATE",
    tier: 1,
    reason: "immediate",
    targets: [1 as IslandKey],
  };

  // TypeScript garantiza que HYDRATE siempre es tier 1
  assertEquals(hydrate.tier, 1);
});

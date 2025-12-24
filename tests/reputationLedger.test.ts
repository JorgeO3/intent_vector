/**
 * @file tests/reputationLedger.test.ts
 * @description Pruebas unitarias para el sistema de reputación EMA.
 *
 * Validaciones críticas:
 * - Convergencia correcta del EMA
 * - Un solo Hit no borra historial de múltiples Misses
 * - Priors clampeados entre minPrior y maxPrior
 * - Estabilidad ante comportamientos aleatorios
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { ReputationLedger } from "../runtime/reputationLedger.ts";

// ============================================================================
// Constantes de Test
// ============================================================================

const DEFAULT_ROUTE = "/home";
const DEFAULT_ISLAND = "island-1";
const DEFAULT_PRIOR = 1.0;
const EPSILON = 0.001;

// ============================================================================
// 1. Pruebas de Inicialización
// ============================================================================

Deno.test("ReputationLedger: prior inicial es 1.0 para island no registrada", () => {
  const ledger = new ReputationLedger();

  const prior = ledger.prior(DEFAULT_ROUTE, "unknown-island");

  assertEquals(prior, DEFAULT_PRIOR);
});

Deno.test("ReputationLedger: prior inicial con config personalizada", () => {
  const ledger = new ReputationLedger({
    emaAlpha: 0.5,
    minPrior: 0.3,
    maxPrior: 2.0,
  });

  const prior = ledger.prior(DEFAULT_ROUTE, "unknown");

  assertEquals(prior, DEFAULT_PRIOR, "Prior inicial siempre es 1.0");
});

// ============================================================================
// 2. Pruebas de Hit/Miss Básicas
// ============================================================================

Deno.test("ReputationLedger: recordHit aumenta el prior", () => {
  const ledger = new ReputationLedger();

  const priorBefore = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);
  ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  const priorAfter = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  assert(
    priorAfter > priorBefore,
    `Prior debe aumentar: ${priorBefore} -> ${priorAfter}`,
  );
});

Deno.test("ReputationLedger: recordMiss disminuye el prior", () => {
  const ledger = new ReputationLedger();

  const priorBefore = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);
  ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
  const priorAfter = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  assert(
    priorAfter < priorBefore,
    `Prior debe disminuir: ${priorBefore} -> ${priorAfter}`,
  );
});

Deno.test("ReputationLedger: múltiples hits consecutivos aumentan prior gradualmente", () => {
  const ledger = new ReputationLedger({ emaAlpha: 0.18 });

  const priors: number[] = [ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND)];

  for (let i = 0; i < 5; i++) {
    ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
    priors.push(ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND));
  }

  // Cada prior debe ser mayor que el anterior
  for (let i = 1; i < priors.length; i++) {
    assert(priors[i] > priors[i - 1], `Prior[${i}] debe ser > Prior[${i - 1}]`);
  }
});

Deno.test("ReputationLedger: múltiples misses consecutivos disminuyen prior gradualmente", () => {
  const ledger = new ReputationLedger({ emaAlpha: 0.18 });

  const priors: number[] = [ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND)];

  for (let i = 0; i < 5; i++) {
    ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
    priors.push(ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND));
  }

  // Cada prior debe ser menor que el anterior
  for (let i = 1; i < priors.length; i++) {
    assert(priors[i] < priors[i - 1], `Prior[${i}] debe ser < Prior[${i - 1}]`);
  }
});

// ============================================================================
// 3. Pruebas de Convergencia EMA
// ============================================================================

Deno.test("ReputationLedger: EMA converge hacia maxPrior con hits continuos", () => {
  const maxPrior = 1.4;
  const ledger = new ReputationLedger({ emaAlpha: 0.18, maxPrior });

  // Muchos hits
  for (let i = 0; i < 50; i++) {
    ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Debe estar muy cerca del máximo
  assertAlmostEquals(
    prior,
    maxPrior,
    0.05,
    `Prior debe converger a maxPrior: got ${prior}`,
  );
});

Deno.test("ReputationLedger: EMA converge hacia minPrior con misses continuos", () => {
  const minPrior = 0.6;
  const ledger = new ReputationLedger({ emaAlpha: 0.18, minPrior });

  // Muchos misses
  for (let i = 0; i < 50; i++) {
    ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Debe estar muy cerca del mínimo
  assertAlmostEquals(
    prior,
    minPrior,
    0.05,
    `Prior debe converger a minPrior: got ${prior}`,
  );
});

// ============================================================================
// 4. Pruebas de Estabilidad (Un Hit no borra historial de Misses)
// ============================================================================

Deno.test("ReputationLedger: un solo hit NO borra historial de 10 misses", () => {
  const ledger = new ReputationLedger({
    emaAlpha: 0.18,
    minPrior: 0.6,
    maxPrior: 1.4,
  });

  // 10 misses consecutivos
  for (let i = 0; i < 10; i++) {
    ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const priorAfterMisses = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Un solo hit
  ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);

  const priorAfterOneHit = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // El prior debe aumentar pero NO debe volver a 1.0 o cerca
  assert(priorAfterOneHit > priorAfterMisses, "Hit debe aumentar prior");
  assert(
    priorAfterOneHit < 1.0,
    `Un hit no debe borrar historial de misses: ${priorAfterOneHit} debe ser < 1.0`,
  );

  // Debe estar más cerca de minPrior que de maxPrior
  const distToMin = Math.abs(priorAfterOneHit - 0.6);
  const distToMax = Math.abs(priorAfterOneHit - 1.4);
  assert(
    distToMin < distToMax,
    "Prior debe seguir cerca del mínimo después de un hit",
  );
});

Deno.test("ReputationLedger: un solo miss NO borra historial de 10 hits", () => {
  const ledger = new ReputationLedger({
    emaAlpha: 0.18,
    minPrior: 0.6,
    maxPrior: 1.4,
  });

  // 10 hits consecutivos
  for (let i = 0; i < 10; i++) {
    ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const priorAfterHits = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Un solo miss
  ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);

  const priorAfterOneMiss = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // El prior debe disminuir pero NO debe caer dramáticamente
  assert(priorAfterOneMiss < priorAfterHits, "Miss debe disminuir prior");
  assert(
    priorAfterOneMiss > 1.0,
    `Un miss no debe borrar historial de hits: ${priorAfterOneMiss} debe ser > 1.0`,
  );
});

// ============================================================================
// 5. Pruebas de Clamping de Priors
// ============================================================================

Deno.test("ReputationLedger: prior nunca excede maxPrior", () => {
  const maxPrior = 1.4;
  const ledger = new ReputationLedger({ emaAlpha: 0.5, maxPrior }); // Alpha alto para convergencia rápida

  // Muchos hits
  for (let i = 0; i < 100; i++) {
    ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  assert(prior <= maxPrior, `Prior ${prior} excede maxPrior ${maxPrior}`);
});

Deno.test("ReputationLedger: prior nunca cae por debajo de minPrior", () => {
  const minPrior = 0.6;
  const ledger = new ReputationLedger({ emaAlpha: 0.5, minPrior }); // Alpha alto

  // Muchos misses
  for (let i = 0; i < 100; i++) {
    ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  assert(
    prior >= minPrior,
    `Prior ${prior} cae por debajo de minPrior ${minPrior}`,
  );
});

Deno.test("ReputationLedger: clamping funciona con valores extremos de config", () => {
  const ledger = new ReputationLedger({
    emaAlpha: 0.99, // Casi instantáneo
    minPrior: 0.25,
    maxPrior: 4.0,
  });

  // Un hit con alpha alto debería llevar casi al máximo
  ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  let prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);
  assert(prior <= 4.0, "No debe exceder maxPrior extremo");

  // Reset con nueva island
  for (let i = 0; i < 10; i++) {
    ledger.recordMiss(DEFAULT_ROUTE, "island-extreme");
  }
  prior = ledger.prior(DEFAULT_ROUTE, "island-extreme");
  assert(prior >= 0.25, "No debe caer por debajo de minPrior extremo");
});

// ============================================================================
// 6. Pruebas de Aislamiento por Ruta
// ============================================================================

Deno.test("ReputationLedger: priors son independientes por ruta", () => {
  const ledger = new ReputationLedger();

  // Hits en ruta A
  for (let i = 0; i < 5; i++) {
    ledger.recordHit("/route-a", DEFAULT_ISLAND);
  }

  // Misses en ruta B
  for (let i = 0; i < 5; i++) {
    ledger.recordMiss("/route-b", DEFAULT_ISLAND);
  }

  const priorA = ledger.prior("/route-a", DEFAULT_ISLAND);
  const priorB = ledger.prior("/route-b", DEFAULT_ISLAND);

  assert(priorA > DEFAULT_PRIOR, "Ruta A debe tener prior elevado");
  assert(priorB < DEFAULT_PRIOR, "Ruta B debe tener prior reducido");
  assert(priorA > priorB, "Priors deben ser independientes por ruta");
});

Deno.test("ReputationLedger: priors son independientes por island", () => {
  const ledger = new ReputationLedger();

  // Hits para island-1
  for (let i = 0; i < 5; i++) {
    ledger.recordHit(DEFAULT_ROUTE, "island-1");
  }

  // Misses para island-2
  for (let i = 0; i < 5; i++) {
    ledger.recordMiss(DEFAULT_ROUTE, "island-2");
  }

  const prior1 = ledger.prior(DEFAULT_ROUTE, "island-1");
  const prior2 = ledger.prior(DEFAULT_ROUTE, "island-2");

  assert(prior1 > prior2, "Priors deben ser independientes por island");
});

// ============================================================================
// 7. Pruebas de Comportamiento Aleatorio
// ============================================================================

Deno.test("ReputationLedger: estable ante secuencia aleatoria hit/miss", () => {
  const ledger = new ReputationLedger({
    emaAlpha: 0.18,
    minPrior: 0.6,
    maxPrior: 1.4,
  });

  // Secuencia pseudo-aleatoria (determinística para reproducibilidad)
  const sequence = [1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1];

  for (const outcome of sequence) {
    if (outcome === 1) {
      ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
    } else {
      ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
    }
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Prior debe estar dentro de los límites
  assert(prior >= 0.6 && prior <= 1.4, `Prior ${prior} fuera de límites`);

  // Con 10 hits y 10 misses, prior debería estar cerca de 1.0
  assertAlmostEquals(
    prior,
    1.0,
    0.3,
    "Prior debe estar cerca de neutral con 50/50",
  );
});

Deno.test("ReputationLedger: no hay acumulación de error numérico", () => {
  const ledger = new ReputationLedger({ emaAlpha: 0.18 });

  // Muchas operaciones alternadas
  for (let i = 0; i < 1000; i++) {
    if (i % 2 === 0) {
      ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
    } else {
      ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
    }
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Prior debe ser un número finito y dentro de límites
  assert(
    Number.isFinite(prior),
    "Prior debe ser finito después de muchas operaciones",
  );
  assert(
    prior >= 0.6 && prior <= 1.4,
    "Prior debe permanecer dentro de límites",
  );
});

// ============================================================================
// 8. Pruebas de EMA Alpha
// ============================================================================

Deno.test("ReputationLedger: alpha bajo = convergencia lenta", () => {
  const ledger = new ReputationLedger({ emaAlpha: 0.05 });

  for (let i = 0; i < 10; i++) {
    ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Con alpha bajo, 10 hits no deberían llevarlo muy alto
  assert(prior < 1.3, `Alpha bajo: prior debe crecer lentamente, got ${prior}`);
});

Deno.test("ReputationLedger: alpha alto = convergencia rápida", () => {
  const ledger = new ReputationLedger({ emaAlpha: 0.5 });

  for (let i = 0; i < 5; i++) {
    ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  }

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Con alpha alto, pocos hits deberían llevarlo cerca del máximo
  assert(
    prior > 1.2,
    `Alpha alto: prior debe crecer rápidamente, got ${prior}`,
  );
});

// ============================================================================
// 9. Pruebas de Fórmula EMA
// ============================================================================

Deno.test("ReputationLedger: EMA sigue fórmula new = (1-α)*old + α*target", () => {
  const alpha = 0.18;
  const maxPrior = 1.4;
  const minPrior = 0.6;
  const ledger = new ReputationLedger({ emaAlpha: alpha, minPrior, maxPrior });

  // Primer hit: EMA desde 1.0 hacia 1.4
  ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND);
  const expectedAfterHit = (1 - alpha) * 1.0 + alpha * maxPrior;
  const actualAfterHit = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  assertAlmostEquals(
    actualAfterHit,
    expectedAfterHit,
    EPSILON,
    "Fórmula EMA para hit",
  );

  // Segundo evento: miss
  const beforeMiss = actualAfterHit;
  ledger.recordMiss(DEFAULT_ROUTE, DEFAULT_ISLAND);
  const expectedAfterMiss = (1 - alpha) * beforeMiss + alpha * minPrior;
  const actualAfterMiss = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  assertAlmostEquals(
    actualAfterMiss,
    expectedAfterMiss,
    EPSILON,
    "Fórmula EMA para miss",
  );
});

// ============================================================================
// 10. Pruebas de Timestamp
// ============================================================================

Deno.test("ReputationLedger: acepta timestamp personalizado", () => {
  const ledger = new ReputationLedger();

  // Registrar con timestamps específicos (no debería afectar el prior actual)
  ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND, 1000);
  ledger.recordHit(DEFAULT_ROUTE, DEFAULT_ISLAND, 2000);

  const prior = ledger.prior(DEFAULT_ROUTE, DEFAULT_ISLAND);

  // Prior debe haber aumentado
  assert(prior > DEFAULT_PRIOR, "Hits con timestamp deben afectar el prior");
});

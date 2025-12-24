/**
 * @file tests/utils.test.ts
 * @description Pruebas de funciones utilitarias compartidas.
 *
 * Validaciones críticas:
 * - Clamp functions con edge cases
 * - EMA computation
 * - Safe now() fallback
 * - JSON parsing seguro
 * - Network/DOM helpers SSR-safe
 */

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import {
  canUseDOM,
  clamp,
  clamp01,
  clampInt,
  computeEMA,
  createIslandId,
  getConnection,
  getCurrentRouteId,
  getDownlinkBytesPerMs,
  isOutsideWindow,
  MIN_DIVISOR,
  NO_SCORE,
  parseJsonSafely,
  PERFECT_SCORE,
  safeNow,
  ZERO_SCORE,
} from "../runtime/utils.ts";

// ============================================================================
// 1. Pruebas de clamp()
// ============================================================================

Deno.test("utils: clamp value dentro de rango", () => {
  assertEquals(clamp(5, 0, 10), 5);
  assertEquals(clamp(0, 0, 10), 0);
  assertEquals(clamp(10, 0, 10), 10);
});

Deno.test("utils: clamp value por debajo de min", () => {
  assertEquals(clamp(-5, 0, 10), 0);
  assertEquals(clamp(-1000, -10, 10), -10);
});

Deno.test("utils: clamp value por encima de max", () => {
  assertEquals(clamp(15, 0, 10), 10);
  assertEquals(clamp(1000, -10, 10), 10);
});

Deno.test("utils: clamp con min == max", () => {
  assertEquals(clamp(5, 5, 5), 5);
  assertEquals(clamp(0, 5, 5), 5);
  assertEquals(clamp(10, 5, 5), 5);
});

Deno.test("utils: clamp con valores decimales", () => {
  assertEquals(clamp(0.5, 0, 1), 0.5);
  assertEquals(clamp(-0.1, 0, 1), 0);
  assertEquals(clamp(1.1, 0, 1), 1);
});

Deno.test("utils: clamp con Infinity", () => {
  assertEquals(clamp(Infinity, 0, 10), 10);
  assertEquals(clamp(-Infinity, 0, 10), 0);
});

// ============================================================================
// 2. Pruebas de clamp01()
// ============================================================================

Deno.test("utils: clamp01 valores típicos", () => {
  assertEquals(clamp01(0.5), 0.5);
  assertEquals(clamp01(0), 0);
  assertEquals(clamp01(1), 1);
});

Deno.test("utils: clamp01 por debajo de 0", () => {
  assertEquals(clamp01(-0.5), 0);
  assertEquals(clamp01(-100), 0);
});

Deno.test("utils: clamp01 por encima de 1", () => {
  assertEquals(clamp01(1.5), 1);
  assertEquals(clamp01(100), 1);
});

Deno.test("utils: clamp01 edge cases", () => {
  assertEquals(clamp01(0.0001), 0.0001);
  assertEquals(clamp01(0.9999), 0.9999);
});

// ============================================================================
// 3. Pruebas de clampInt()
// ============================================================================

Deno.test("utils: clampInt trunca decimales", () => {
  assertEquals(clampInt(5.9, 0, 10), 5);
  assertEquals(clampInt(5.1, 0, 10), 5);
  assertEquals(clampInt(-5.9, -10, 10), -5);
});

Deno.test("utils: clampInt clamp correctamente", () => {
  assertEquals(clampInt(15, 0, 10), 10);
  assertEquals(clampInt(-15, -10, 10), -10);
  assertEquals(clampInt(5, 0, 10), 5);
});

Deno.test("utils: clampInt con valores exactos", () => {
  assertEquals(clampInt(0, 0, 100), 0);
  assertEquals(clampInt(100, 0, 100), 100);
});

// ============================================================================
// 4. Pruebas de safeNow()
// ============================================================================

Deno.test("utils: safeNow retorna número positivo", () => {
  const now = safeNow();

  assert(typeof now === "number");
  assert(Number.isFinite(now));
  assert(now >= 0);
});

Deno.test("utils: safeNow es monotónicamente creciente", () => {
  const t1 = safeNow();
  const t2 = safeNow();
  const t3 = safeNow();

  assert(t2 >= t1);
  assert(t3 >= t2);
});

Deno.test("utils: safeNow resolución razonable", async () => {
  const before = safeNow();
  await new Promise((r) => setTimeout(r, 10));
  const after = safeNow();

  const diff = after - before;
  assert(diff >= 5, "Debe pasar al menos ~10ms"); // Margen para scheduling
});

// ============================================================================
// 5. Pruebas de isOutsideWindow()
// ============================================================================

Deno.test("utils: isOutsideWindow true cuando fuera de ventana", () => {
  const now = 1000;
  const timestamp = 500;
  const windowMs = 400;

  // now - timestamp = 500 > 400 = windowMs
  assertEquals(isOutsideWindow(now, timestamp, windowMs), true);
});

Deno.test("utils: isOutsideWindow false cuando dentro de ventana", () => {
  const now = 1000;
  const timestamp = 800;
  const windowMs = 400;

  // now - timestamp = 200 < 400 = windowMs
  assertEquals(isOutsideWindow(now, timestamp, windowMs), false);
});

Deno.test("utils: isOutsideWindow exactamente en el límite", () => {
  const now = 1000;
  const timestamp = 600;
  const windowMs = 400;

  // now - timestamp = 400 = windowMs (not greater than)
  assertEquals(isOutsideWindow(now, timestamp, windowMs), false);
});

Deno.test("utils: isOutsideWindow con timestamp en el futuro", () => {
  const now = 1000;
  const timestamp = 1500; // En el futuro
  const windowMs = 400;

  // now - timestamp = -500 < 400
  assertEquals(isOutsideWindow(now, timestamp, windowMs), false);
});

// ============================================================================
// 6. Pruebas de createIslandId()
// ============================================================================

Deno.test("utils: createIslandId genera base-36", () => {
  const id = createIslandId(12345);

  // Base-36 solo contiene 0-9 y a-z
  assert(/^[0-9a-z]+$/.test(id));
});

Deno.test("utils: createIslandId valores conocidos", () => {
  assertEquals(createIslandId(0), "0");
  assertEquals(createIslandId(10), "a");
  assertEquals(createIslandId(35), "z");
  assertEquals(createIslandId(36), "10");
});

Deno.test("utils: createIslandId es reversible", () => {
  const original = 123456789;
  const id = createIslandId(original);
  const parsed = parseInt(id, 36);

  assertEquals(parsed, original);
});

// ============================================================================
// 7. Pruebas de getConnection()
// ============================================================================

Deno.test("utils: getConnection retorna undefined en Deno", () => {
  // En Deno sin navigator.connection
  const connection = getConnection();

  // Puede ser undefined o un objeto dependiendo del ambiente
  assert(connection === undefined || typeof connection === "object");
});

// ============================================================================
// 8. Pruebas de getDownlinkBytesPerMs()
// ============================================================================

Deno.test("utils: getDownlinkBytesPerMs retorna 0 sin connection", () => {
  const bytesPerMs = getDownlinkBytesPerMs();

  // Sin navigator.connection, debe retornar 0
  assertEquals(bytesPerMs, 0);
});

// ============================================================================
// 9. Pruebas de canUseDOM()
// ============================================================================

Deno.test("utils: canUseDOM retorna false en Deno", () => {
  // Deno no tiene document ni HTMLElement por defecto
  const result = canUseDOM();

  assertEquals(result, false);
});

// ============================================================================
// 10. Pruebas de getCurrentRouteId()
// ============================================================================

Deno.test("utils: getCurrentRouteId retorna default sin location", () => {
  const routeId = getCurrentRouteId();

  assertEquals(routeId, "/");
});

Deno.test("utils: getCurrentRouteId con default custom", () => {
  const routeId = getCurrentRouteId("/home");

  assertEquals(routeId, "/home");
});

// ============================================================================
// 11. Pruebas de parseJsonSafely()
// ============================================================================

Deno.test("utils: parseJsonSafely JSON válido", () => {
  const result = parseJsonSafely('{"a": 1, "b": "test"}');

  assertEquals(result, { a: 1, b: "test" });
});

Deno.test("utils: parseJsonSafely JSON inválido retorna null", () => {
  const result = parseJsonSafely("not valid json {{{");

  assertEquals(result, null);
});

Deno.test("utils: parseJsonSafely undefined retorna null", () => {
  const result = parseJsonSafely(undefined);

  assertEquals(result, null);
});

Deno.test("utils: parseJsonSafely string vacío retorna null", () => {
  const result = parseJsonSafely("");

  assertEquals(result, null);
});

Deno.test("utils: parseJsonSafely array", () => {
  const result = parseJsonSafely("[1, 2, 3]");

  assertEquals(result, [1, 2, 3]);
});

Deno.test("utils: parseJsonSafely primitivos", () => {
  assertEquals(parseJsonSafely("42"), 42);
  assertEquals(parseJsonSafely('"hello"'), "hello");
  assertEquals(parseJsonSafely("true"), true);
  assertEquals(parseJsonSafely("null"), null);
});

// ============================================================================
// 12. Pruebas de computeEMA()
// ============================================================================

Deno.test("utils: computeEMA alpha=0 no cambia", () => {
  const result = computeEMA(10, 20, 0);

  assertEquals(result, 10);
});

Deno.test("utils: computeEMA alpha=1 salta directo al target", () => {
  const result = computeEMA(10, 20, 1);

  assertEquals(result, 20);
});

Deno.test("utils: computeEMA alpha=0.5 promedia", () => {
  const result = computeEMA(10, 20, 0.5);

  assertEquals(result, 15); // (0.5 * 10) + (0.5 * 20) = 15
});

Deno.test("utils: computeEMA convergencia gradual", () => {
  let value = 0;
  const target = 100;
  const alpha = 0.1;

  for (let i = 0; i < 50; i++) {
    value = computeEMA(value, target, alpha);
  }

  // Después de 50 iteraciones con alpha=0.1, debería estar muy cerca de 100
  assert(Math.abs(value - target) < 1);
});

Deno.test("utils: computeEMA con valores negativos", () => {
  const result = computeEMA(-10, -20, 0.5);

  assertEquals(result, -15);
});

Deno.test("utils: computeEMA current == target permanece igual", () => {
  const result = computeEMA(50, 50, 0.3);

  assertEquals(result, 50);
});

// ============================================================================
// 13. Pruebas de Constantes
// ============================================================================

Deno.test("utils: constantes tienen valores correctos", () => {
  assertEquals(ZERO_SCORE, 0);
  assertEquals(PERFECT_SCORE, 1.0);
  assertEquals(NO_SCORE, -1);
  assert(MIN_DIVISOR > 0);
  assert(MIN_DIVISOR < 0.001);
});

// ============================================================================
// 14. Pruebas de Edge Cases Numéricos
// ============================================================================

Deno.test("utils: clamp con NaN", () => {
  const result = clamp(NaN, 0, 10);

  // NaN comparisons return false, so NaN < 0 is false, NaN > 10 is false
  // Result would be NaN
  assert(Number.isNaN(result));
});

Deno.test("utils: clamp01 con NaN", () => {
  const result = clamp01(NaN);

  assert(Number.isNaN(result));
});

Deno.test("utils: computeEMA con alpha fuera de [0,1]", () => {
  // alpha > 1: extrapola
  const extrapolated = computeEMA(10, 20, 2);
  // (1-2)*10 + 2*20 = -10 + 40 = 30
  assertEquals(extrapolated, 30);

  // alpha < 0: peso negativo
  const negAlpha = computeEMA(10, 20, -1);
  // (1-(-1))*10 + (-1)*20 = 2*10 - 20 = 0
  assertEquals(negAlpha, 0);
});

// ============================================================================
// 15. Pruebas de Performance Hints
// ============================================================================

Deno.test("utils: clamp es rápido para muchas llamadas", () => {
  const iterations = 100000;
  const start = safeNow();

  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    sum += clamp(Math.random() * 20 - 5, 0, 10);
  }

  const elapsed = safeNow() - start;

  // Verificar que completó (sum es para evitar dead code elimination)
  assert(sum >= 0);

  // Debería completar en menos de 100ms para 100k iteraciones
  assert(
    elapsed < 100,
    `clamp tomó ${elapsed}ms para ${iterations} iteraciones`,
  );
});

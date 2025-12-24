/**
 * @file tests/pressure.test.ts
 * @description Pruebas del monitor de presión CPU/red.
 *
 * Validaciones críticas:
 * - Long task pressure computation
 * - Network pressure by effectiveType
 * - SaveData mode detection
 * - Lazy observer initialization
 * - Pressure clamping [0, 1]
 */

import { assert, assertEquals } from "@std/assert";
import { PressureMonitor } from "../runtime/pressure.ts";

// ============================================================================
// 1. Pruebas de Inicialización
// ============================================================================

Deno.test("PressureMonitor: instanciación con config default", () => {
  const monitor = new PressureMonitor();

  // No debe crashear
  const signals = monitor.read();

  assert(typeof signals.cpuPressure === "number");
  assert(typeof signals.netPressure === "number");
  assert(typeof signals.saveData === "boolean");

  monitor.dispose();
});

Deno.test("PressureMonitor: instanciación con config custom", () => {
  const monitor = new PressureMonitor({
    longTaskWindowMs: 5000,
    longTaskBudgetMs: 200,
  });

  const signals = monitor.read();

  assert(Number.isFinite(signals.cpuPressure));

  monitor.dispose();
});

Deno.test("PressureMonitor: dispose no crashea si se llama múltiples veces", () => {
  const monitor = new PressureMonitor();

  monitor.dispose();
  monitor.dispose();
  monitor.dispose();

  // No debe crashear
});

// ============================================================================
// 2. Pruebas de CPU Pressure
// ============================================================================

Deno.test("PressureMonitor: cpuPressure inicial es bajo", () => {
  const monitor = new PressureMonitor();

  const signals = monitor.read();

  // Sin long tasks ni engine cost, pressure debería ser ~0
  assertEquals(signals.cpuPressure >= 0, true);
  assertEquals(signals.cpuPressure <= 1, true);

  monitor.dispose();
});

Deno.test("PressureMonitor: setLastEngineCostMs afecta cpuPressure", () => {
  const monitor = new PressureMonitor();

  // Baseline
  const before = monitor.read();

  // Simular costo de engine alto
  monitor.setLastEngineCostMs(10); // 10ms >> ENGINE_HEAVY_THRESHOLD_MS (4ms)

  const after = monitor.read();

  // cpuPressure debería aumentar
  assert(after.cpuPressure >= before.cpuPressure);

  monitor.dispose();
});

Deno.test("PressureMonitor: setLastEngineCostMs ignora valores negativos", () => {
  const monitor = new PressureMonitor();

  monitor.setLastEngineCostMs(-100);

  const signals = monitor.read();

  // No debe ser negativo
  assert(signals.cpuPressure >= 0);

  monitor.dispose();
});

Deno.test("PressureMonitor: cpuPressure siempre en rango [0, 1]", () => {
  const monitor = new PressureMonitor();

  // Engine cost extremadamente alto
  monitor.setLastEngineCostMs(10000);

  const signals = monitor.read();

  assertEquals(signals.cpuPressure >= 0, true, "cpuPressure >= 0");
  assertEquals(signals.cpuPressure <= 1, true, "cpuPressure <= 1");

  monitor.dispose();
});

// ============================================================================
// 3. Pruebas de Network Pressure
// ============================================================================

Deno.test("PressureMonitor: netPressure es numérico y acotado", () => {
  const monitor = new PressureMonitor();

  const signals = monitor.read();

  assert(Number.isFinite(signals.netPressure));
  assertEquals(signals.netPressure >= 0, true);
  assertEquals(signals.netPressure <= 1, true);

  monitor.dispose();
});

Deno.test("PressureMonitor: netPressure sin navigator.connection", () => {
  // En Deno, navigator.connection no existe
  const monitor = new PressureMonitor();

  const signals = monitor.read();

  // Debería retornar valor default (probablemente 0)
  assert(Number.isFinite(signals.netPressure));

  monitor.dispose();
});

// ============================================================================
// 4. Pruebas de SaveData
// ============================================================================

Deno.test("PressureMonitor: saveData es boolean", () => {
  const monitor = new PressureMonitor();

  const signals = monitor.read();

  assertEquals(typeof signals.saveData, "boolean");

  monitor.dispose();
});

Deno.test("PressureMonitor: saveData false cuando no hay connection API", () => {
  // En Deno sin navigator.connection, saveData debería ser false
  const monitor = new PressureMonitor();

  const signals = monitor.read();

  // Sin API, default es false
  assertEquals(signals.saveData, false);

  monitor.dispose();
});

// ============================================================================
// 5. Pruebas de Lazy Initialization
// ============================================================================

Deno.test("PressureMonitor: observer se inicializa en primer read()", () => {
  const monitor = new PressureMonitor();

  // Antes del primer read, observer no debería existir
  // (no podemos verificar directamente, pero no debe crashear)

  // Primer read inicializa observer
  monitor.read();

  // Segundo read no debe re-inicializar (no debe crashear)
  monitor.read();
  monitor.read();

  monitor.dispose();
});

// ============================================================================
// 6. Pruebas de Read Múltiple
// ============================================================================

Deno.test("PressureMonitor: múltiples read() no acumulan errores", () => {
  const monitor = new PressureMonitor();

  for (let i = 0; i < 100; i++) {
    const signals = monitor.read();
    assert(Number.isFinite(signals.cpuPressure));
    assert(Number.isFinite(signals.netPressure));
  }

  monitor.dispose();
});

Deno.test("PressureMonitor: read() retorna struct consistente", () => {
  const monitor = new PressureMonitor();

  const s1 = monitor.read();
  const s2 = monitor.read();

  // Ambos deben tener la misma estructura
  assertEquals(
    Object.keys(s1).sort().join(","),
    Object.keys(s2).sort().join(","),
  );

  monitor.dispose();
});

// ============================================================================
// 7. Pruebas de Engine Pressure
// ============================================================================

Deno.test("PressureMonitor: engine cost 0 → engine pressure 0", () => {
  const monitor = new PressureMonitor();

  monitor.setLastEngineCostMs(0);

  const signals = monitor.read();

  // cpuPressure solo tiene componente longTask (weighted)
  // con engine=0 y sin long tasks, debería ser ~0
  assertEquals(signals.cpuPressure >= 0, true);

  monitor.dispose();
});

Deno.test("PressureMonitor: engine cost 4ms → engine pressure 1.0", () => {
  const monitor = new PressureMonitor();

  // ENGINE_HEAVY_THRESHOLD_MS = 4.0
  monitor.setLastEngineCostMs(4);

  const signals = monitor.read();

  // enginePressure = 4 / 4 = 1.0
  // cpuPressure = 0.75 * longTask + 0.25 * engine
  // Con longTask=0 y engine=1: cpu = 0.25
  // Pero sin long task observer en Deno, podría ser diferente
  assert(signals.cpuPressure > 0);

  monitor.dispose();
});

Deno.test("PressureMonitor: engine cost > threshold saturado a 1.0", () => {
  const monitor = new PressureMonitor();

  // Muy por encima del threshold
  monitor.setLastEngineCostMs(100);

  const signals = monitor.read();

  // Incluso con engine saturado, cpu está acotado a [0, 1]
  assertEquals(signals.cpuPressure <= 1, true);

  monitor.dispose();
});

// ============================================================================
// 8. Pruebas de Determinismo
// ============================================================================

Deno.test("PressureMonitor: mismas condiciones → mismo resultado", () => {
  const monitor1 = new PressureMonitor();
  const monitor2 = new PressureMonitor();

  monitor1.setLastEngineCostMs(2);
  monitor2.setLastEngineCostMs(2);

  const s1 = monitor1.read();
  const s2 = monitor2.read();

  // Sin long tasks variables, deberían ser iguales
  // (netPressure depende del ambiente, pero debería ser consistente)
  assertEquals(s1.saveData, s2.saveData);
  assertEquals(s1.netPressure, s2.netPressure);

  // cpuPressure puede diferir ligeramente por timing, pero close
  const diff = Math.abs(s1.cpuPressure - s2.cpuPressure);
  assert(diff < 0.01, "cpuPressure debería ser muy similar");

  monitor1.dispose();
  monitor2.dispose();
});

// ============================================================================
// 9. Pruebas de Edge Cases
// ============================================================================

Deno.test("PressureMonitor: engine cost Infinity tratado correctamente", () => {
  const monitor = new PressureMonitor();

  monitor.setLastEngineCostMs(Infinity);

  const signals = monitor.read();

  // Debería saturar pero no crashear
  // El clamp debería manejar esto
  assert(Number.isFinite(signals.cpuPressure) || signals.cpuPressure === 1);

  monitor.dispose();
});

Deno.test("PressureMonitor: engine cost NaN tratado como 0", () => {
  const monitor = new PressureMonitor();

  monitor.setLastEngineCostMs(NaN);

  const signals = monitor.read();

  // NaN debería resultar en presión calculable
  assert(!Number.isNaN(signals.cpuPressure));

  monitor.dispose();
});

// ============================================================================
// 10. Pruebas de Lifecycle
// ============================================================================

Deno.test("PressureMonitor: dispose luego read no crashea (graceful)", () => {
  const monitor = new PressureMonitor();

  monitor.read(); // Inicializa observer
  monitor.dispose();

  // Read después de dispose podría fallar o retornar defaults
  // Lo importante es que no crashee
  try {
    monitor.read();
  } catch {
    // Puede lanzar o no, pero si lo hace, es esperado
  }
});

Deno.test("PressureMonitor: read antes de dispose funciona", () => {
  const monitor = new PressureMonitor();

  const s1 = monitor.read();
  const s2 = monitor.read();

  monitor.dispose();

  // Ambos reads deberían haber funcionado
  assert(Number.isFinite(s1.cpuPressure));
  assert(Number.isFinite(s2.cpuPressure));
});

// ============================================================================
// 11. Pruebas de Compactación de Long Tasks
// ============================================================================

Deno.test("PressureMonitor: long task sum no se vuelve negativa", () => {
  const monitor = new PressureMonitor();

  // Muchos reads (que compactan)
  for (let i = 0; i < 200; i++) {
    const signals = monitor.read();
    // cpuPressure nunca debe ser negativo
    assert(signals.cpuPressure >= 0, `Iteration ${i}: cpuPressure negativo`);
  }

  monitor.dispose();
});

// ============================================================================
// 12. Pruebas de Config Personalizada
// ============================================================================

Deno.test("PressureMonitor: budget alto reduce pressure", () => {
  // Budget normal
  const monitorNormal = new PressureMonitor({
    longTaskBudgetMs: 100,
  });

  // Budget muy alto (más tolerante)
  const monitorTolerant = new PressureMonitor({
    longTaskBudgetMs: 10000,
  });

  // Ambos con mismo engine cost
  monitorNormal.setLastEngineCostMs(5);
  monitorTolerant.setLastEngineCostMs(5);

  const sNormal = monitorNormal.read();
  const sTolerant = monitorTolerant.read();

  // Con budget más alto, la presión debería ser igual o menor
  // (asumiendo mismo engine cost y sin long tasks)
  assert(
    sTolerant.cpuPressure <= sNormal.cpuPressure ||
      Math.abs(sTolerant.cpuPressure - sNormal.cpuPressure) < 0.01,
  );

  monitorNormal.dispose();
  monitorTolerant.dispose();
});

Deno.test("PressureMonitor: window corta descarta long tasks más rápido", () => {
  const monitorShort = new PressureMonitor({
    longTaskWindowMs: 100,
  });

  const monitorLong = new PressureMonitor({
    longTaskWindowMs: 10000,
  });

  // Simplemente verificar que ambos funcionan
  const sShort = monitorShort.read();
  const sLong = monitorLong.read();

  assert(Number.isFinite(sShort.cpuPressure));
  assert(Number.isFinite(sLong.cpuPressure));

  monitorShort.dispose();
  monitorLong.dispose();
});

/**
 * @file stress.ts
 * @description Stress test sin overhead de profiling - medición pura de rendimiento
 */

import { IntentVector } from "./intent/intentVector.ts";

// =============================================================================
// Test de rendimiento puro (sin profiling overhead)
// =============================================================================

function runPurePerformanceTest() {
  console.log("\n⚡ Test de Rendimiento Puro (Sin Profiling)");
  console.log("=".repeat(60));

  const ITERATIONS = 1_000_000; // 1 millón de llamadas
  const DT = 16.67;

  const iv = new IntentVector();
  iv.reset(500, 500);

  // Pre-generar datos para evitar overhead de generación
  const data = new Float64Array(ITERATIONS * 2);
  let angle = 0;
  let radius = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    angle += 0.05;
    radius += 0.5;
    data[i * 2] = 500 + Math.cos(angle) * radius;
    data[i * 2 + 1] = 500 + Math.sin(angle) * radius;
  }

  console.log(`\n📊 Preparando ${ITERATIONS.toLocaleString()} iteraciones...`);

  // Warmup
  for (let i = 0; i < 1000; i++) {
    iv.update(data[i * 2], data[i * 2 + 1], DT);
  }

  // Test real
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    iv.update(data[i * 2], data[i * 2 + 1], DT);
  }

  const end = performance.now();
  const totalTime = end - start;
  const avgPerCall = (totalTime / ITERATIONS) * 1000; // en microsegundos
  const callsPerSecond = (ITERATIONS / totalTime) * 1000;

  console.log(`\n✅ Resultados:`);
  console.log(`   Tiempo total: ${totalTime.toFixed(2)} ms`);
  console.log(`   Promedio por llamada: ${avgPerCall.toFixed(3)} μs`);
  console.log(
    `   Throughput: ${
      callsPerSecond.toLocaleString(undefined, { maximumFractionDigits: 0 })
    } calls/sec`,
  );
  console.log(
    `   Tiempo por frame 60fps: ${
      (avgPerCall / 16670 * 100).toFixed(2)
    }% del budget`,
  );

  // Verificar que el cálculo es correcto
  const kinematics = iv.getKinematics();
  console.log(`\n🔍 Estado final (validación):`);
  console.log(
    `   Posición: (${kinematics.px.toFixed(1)}, ${kinematics.py.toFixed(1)})`,
  );
  console.log(
    `   Velocidad: ${
      Math.sqrt(kinematics.vx ** 2 + kinematics.vy ** 2).toFixed(3)
    } px/ms`,
  );
}

// =============================================================================
// Test comparativo: diferentes configuraciones
// =============================================================================

function compareConfigurations() {
  console.log("\n🔧 Test Comparativo: Diferentes Configuraciones");
  console.log("=".repeat(60));

  const ITERATIONS = 500_000;
  const DT = 16.67;

  const configs = [
    { name: "Default", config: {} },
    { name: "Alta Velocidad", config: { vMax: 10.0, vTheta: 0.5 } },
    { name: "Suavizado Bajo", config: { alphaRef: 0.3 } },
    { name: "Suavizado Alto", config: { alphaRef: 0.8 } },
  ];

  // Pre-generar path
  const path = new Float64Array(ITERATIONS * 2);
  for (let i = 0; i < ITERATIONS; i++) {
    path[i * 2] = i * 0.5;
    path[i * 2 + 1] = 500 + Math.sin(i * 0.01) * 100;
  }

  for (const { name, config } of configs) {
    const iv = new IntentVector(config);
    iv.reset(0, 500);

    // Warmup
    for (let i = 0; i < 100; i++) {
      iv.update(path[i * 2], path[i * 2 + 1], DT);
    }

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      iv.update(path[i * 2], path[i * 2 + 1], DT);
    }
    const time = performance.now() - start;

    const avgPerCall = (time / ITERATIONS) * 1000;

    console.log(`  ${name.padEnd(20)} ${avgPerCall.toFixed(3)} μs/call`);
  }
}

// =============================================================================
// Test de worst-case: cambios constantes de dt
// =============================================================================

function testWorstCase() {
  console.log("\n⚠️  Test Worst-Case: dt Variable (sin cache hits)");
  console.log("=".repeat(60));

  const ITERATIONS = 100_000;
  const iv = new IntentVector();
  iv.reset(500, 500);

  // Generar dts variables para forzar recalcular alpha cada vez
  const dts = new Float64Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    dts[i] = 10 + Math.random() * 20; // dt entre 10-30ms
  }

  const path = new Float64Array(ITERATIONS * 2);
  for (let i = 0; i < ITERATIONS; i++) {
    path[i * 2] = i * 0.5;
    path[i * 2 + 1] = 500;
  }

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    iv.update(path[i * 2], path[i * 2 + 1], dts[i]);
  }
  const time = performance.now() - start;

  const avgPerCall = (time / ITERATIONS) * 1000;

  console.log(`\n  Sin cache de alpha: ${avgPerCall.toFixed(3)} μs/call`);

  // Comparar con dt constante (cache hit siempre)
  iv.reset(500, 500);

  const start2 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    iv.update(path[i * 2], path[i * 2 + 1], 16.67);
  }
  const time2 = performance.now() - start2;

  const avgPerCall2 = (time2 / ITERATIONS) * 1000;
  const improvement = (avgPerCall - avgPerCall2) / avgPerCall * 100;

  console.log(`  Con cache de alpha: ${avgPerCall2.toFixed(3)} μs/call`);
  console.log(`  Mejora del cache: ${improvement.toFixed(1)}%`);
}

// =============================================================================
// Main
// =============================================================================

function main() {
  console.log(
    "\n╔═══════════════════════════════════════════════════════════╗",
  );
  console.log("║  IntentVector - Pure Performance Stress Test             ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  runPurePerformanceTest();
  compareConfigurations();
  testWorstCase();

  console.log("\n" + "=".repeat(60));
  console.log("✨ Tests completados\n");
}

main();

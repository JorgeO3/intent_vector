/**
 * @file main.ts
 * @description Stress test y profiling de IntentVector.update()
 */

import { IntentVector } from "./intent/intentVector.ts";
import { globalProfiler } from "./intent/profiler.ts";

// =============================================================================
// Configuración del stress test
// =============================================================================

const ITERATIONS = 100_000;
const DT = 16.67; // 60fps

// Simular movimiento de cursor realista
function generateCursorPath(count: number): Array<{ x: number; y: number }> {
  const path: Array<{ x: number; y: number }> = [];

  // Movimiento en espiral con ruido
  let x = 500;
  let y = 500;
  let angle = 0;
  let radius = 0;

  for (let i = 0; i < count; i++) {
    angle += 0.05 + Math.random() * 0.02;
    radius += 0.5;

    x = 500 + Math.cos(angle) * radius + (Math.random() - 0.5) * 5;
    y = 500 + Math.sin(angle) * radius + (Math.random() - 0.5) * 5;

    path.push({ x, y });
  }

  return path;
}

// =============================================================================
// Test 1: Stress test con profiling
// =============================================================================

function runStressTestWithProfiling() {
  console.log("\n🔥 Test 1: Stress Test con Profiling Detallado");
  console.log("=".repeat(60));

  const iv = new IntentVector();
  iv.reset(500, 500);

  const path = generateCursorPath(ITERATIONS);

  globalProfiler.reset();
  globalProfiler.enable();

  const startTime = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const { x, y } = path[i];
    iv.update(x, y, DT);
  }

  const endTime = performance.now();

  globalProfiler.disable();

  const totalTime = endTime - startTime;
  const avgPerCall = totalTime / ITERATIONS;
  const callsPerSecond = 1000 / avgPerCall;

  console.log(`\n✅ Stress test completado`);
  console.log(`   Iteraciones: ${ITERATIONS.toLocaleString()}`);
  console.log(`   Tiempo total: ${totalTime.toFixed(2)} ms`);
  console.log(`   Promedio por llamada: ${(avgPerCall * 1000).toFixed(2)} μs`);
  console.log(`   Throughput: ${callsPerSecond.toLocaleString()} calls/sec`);

  console.log(globalProfiler.getReport());
}

// =============================================================================
// Test 2: Overhead del profiling
// =============================================================================

function measureProfilingOverhead() {
  console.log("\n⚖️  Test 2: Overhead del Profiling");
  console.log("=".repeat(60));

  const path = generateCursorPath(ITERATIONS);

  // Test SIN profiling
  const iv1 = new IntentVector();
  iv1.reset(500, 500);

  globalProfiler.disable();

  const start1 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const { x, y } = path[i];
    iv1.update(x, y, DT);
  }
  const time1 = performance.now() - start1;

  // Test CON profiling
  const iv2 = new IntentVector();
  iv2.reset(500, 500);

  globalProfiler.reset();
  globalProfiler.enable();

  const start2 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const { x, y } = path[i];
    iv2.update(x, y, DT);
  }
  const time2 = performance.now() - start2;

  globalProfiler.disable();

  const overhead = time2 - time1;
  const overheadPercent = (overhead / time1) * 100;

  console.log(`\n📊 Resultados:`);
  console.log(`   Sin profiling: ${time1.toFixed(2)} ms`);
  console.log(`   Con profiling: ${time2.toFixed(2)} ms`);
  console.log(
    `   Overhead: ${overhead.toFixed(2)} ms (${overheadPercent.toFixed(1)}%)`,
  );
  console.log(
    `   Overhead por call: ${(overhead / ITERATIONS * 1000).toFixed(2)} μs`,
  );
}

// =============================================================================
// Test 3: Comparación de diferentes patrones de movimiento
// =============================================================================

function compareMovementPatterns() {
  console.log("\n🎯 Test 3: Diferentes Patrones de Movimiento");
  console.log("=".repeat(60));

  const patterns = [
    {
      name: "Lineal Horizontal",
      generate: (count: number) => {
        const path = [];
        for (let i = 0; i < count; i++) {
          path.push({ x: i * 0.5, y: 500 });
        }
        return path;
      },
    },
    {
      name: "Diagonal Rápida",
      generate: (count: number) => {
        const path = [];
        for (let i = 0; i < count; i++) {
          path.push({ x: i * 2, y: i * 2 });
        }
        return path;
      },
    },
    {
      name: "Zigzag",
      generate: (count: number) => {
        const path = [];
        for (let i = 0; i < count; i++) {
          const x = i * 0.5;
          const y = 500 + Math.sin(i * 0.1) * 100;
          path.push({ x, y });
        }
        return path;
      },
    },
    {
      name: "Random Walk",
      generate: (count: number) => {
        const path = [];
        let x = 500, y = 500;
        for (let i = 0; i < count; i++) {
          x += (Math.random() - 0.5) * 10;
          y += (Math.random() - 0.5) * 10;
          path.push({ x, y });
        }
        return path;
      },
    },
  ];

  const iterations = 50_000;

  for (const pattern of patterns) {
    const iv = new IntentVector();
    iv.reset(500, 500);

    const path = pattern.generate(iterations);

    globalProfiler.reset();
    globalProfiler.enable();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const { x, y } = path[i];
      iv.update(x, y, DT);
    }
    const time = performance.now() - start;

    globalProfiler.disable();

    const timings = globalProfiler.getTimings();
    const avgTotal = timings.total / timings.count;

    console.log(`\n  ${pattern.name}:`);
    console.log(`    Tiempo total: ${time.toFixed(2)} ms`);
    console.log(`    Avg por call: ${(avgTotal * 1000).toFixed(2)} μs`);
    console.log(`    Hotspot: ${findHotspot(timings)}`);
  }
}

function findHotspot(timings: any): string {
  const sections = [
    { name: "Alpha Cache", time: timings.alphaCaching },
    { name: "Brown-Holt", time: timings.brownHolt },
    { name: "Motion Update", time: timings.motionUpdate },
    { name: "Velocity Clamp", time: timings.velocityClamp },
    { name: "Frame Cache", time: timings.frameCache },
    { name: "Brake Boost", time: timings.brakeBoost },
  ];

  sections.sort((a, b) => b.time - a.time);

  const total = timings.total;
  const top = sections[0];
  const percent = (top.time / total * 100).toFixed(1);

  return `${top.name} (${percent}%)`;
}

// =============================================================================
// Main
// =============================================================================

function main() {
  console.log(
    "\n╔═══════════════════════════════════════════════════════════╗",
  );
  console.log("║  IntentVector Performance Profiler & Stress Test         ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  runStressTestWithProfiling();
  measureProfilingOverhead();
  compareMovementPatterns();

  console.log("\n✨ Profiling completado\n");
}

main();

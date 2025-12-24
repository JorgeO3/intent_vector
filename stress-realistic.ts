/**
 * @file stress-realistic.ts
 * @description Test realista: update() + evaluación de múltiples targets
 */

import { IntentVector } from "./intent/intentVector.ts";

// =============================================================================
// Test Realista: update() + scoring de targets
// =============================================================================

function runRealisticScenario() {
  console.log("\n🎯 Escenario Realista: Update + Scoring de Targets");
  console.log("=".repeat(60));

  const FRAMES = 10_000; // Simular 10k frames
  const TARGETS_PER_FRAME = 20; // 20 targets por frame
  const DT = 16.67;

  const iv = new IntentVector();
  iv.reset(500, 500);

  // Pre-generar cursor path
  const cursorPath = new Float64Array(FRAMES * 2);
  let angle = 0;
  for (let i = 0; i < FRAMES; i++) {
    angle += 0.05;
    cursorPath[i * 2] = 500 + Math.cos(angle) * i * 0.1;
    cursorPath[i * 2 + 1] = 500 + Math.sin(angle) * i * 0.1;
  }

  // Pre-generar targets (posiciones fijas)
  const targets = [];
  for (let i = 0; i < TARGETS_PER_FRAME; i++) {
    const angle = (i / TARGETS_PER_FRAME) * Math.PI * 2;
    targets.push({
      x: 500 + Math.cos(angle) * 300,
      y: 500 + Math.sin(angle) * 300,
      radius: 50,
    });
  }

  console.log(`\n📊 Configuración:`);
  console.log(`   Frames: ${FRAMES.toLocaleString()}`);
  console.log(`   Targets por frame: ${TARGETS_PER_FRAME}`);
  console.log(
    `   Total evaluaciones: ${(FRAMES * TARGETS_PER_FRAME).toLocaleString()}`,
  );

  // Test
  let updateTime = 0;
  let scoringTime = 0;
  let totalScores = 0;

  const start = performance.now();

  for (let frame = 0; frame < FRAMES; frame++) {
    const cursorX = cursorPath[frame * 2];
    const cursorY = cursorPath[frame * 2 + 1];

    // Update
    const t1 = performance.now();
    iv.update(cursorX, cursorY, DT);
    updateTime += performance.now() - t1;

    // Score targets
    const t2 = performance.now();
    for (const target of targets) {
      const dx = target.x - cursorX;
      const dy = target.y - cursorY;
      const score = iv.hintVector(dx, dy, target.radius * target.radius);
      totalScores += score;
    }
    scoringTime += performance.now() - t2;
  }

  const totalTime = performance.now() - start;

  console.log(`\n✅ Resultados:`);
  console.log(`   Tiempo total: ${totalTime.toFixed(2)} ms`);
  console.log(
    `   update() time: ${updateTime.toFixed(2)} ms (${
      (updateTime / totalTime * 100).toFixed(1)
    }%)`,
  );
  console.log(
    `   scoring time: ${scoringTime.toFixed(2)} ms (${
      (scoringTime / totalTime * 100).toFixed(1)
    }%)`,
  );
  console.log(
    `\n   Avg update(): ${(updateTime / FRAMES * 1000).toFixed(2)} μs`,
  );
  console.log(`   Avg scoring: ${(scoringTime / FRAMES * 1000).toFixed(2)} μs`);
  console.log(
    `   Avg por target: ${
      (scoringTime / (FRAMES * TARGETS_PER_FRAME) * 1000).toFixed(3)
    } μs`,
  );
  console.log(`\n   Frame time: ${(totalTime / FRAMES).toFixed(3)} ms`);
  console.log(
    `   FPS budget usado: ${((totalTime / FRAMES) / 16.67 * 100).toFixed(2)}%`,
  );

  // Validación
  console.log(`\n🔍 Validación: Total scores = ${totalScores.toFixed(2)}`);
}

// =============================================================================
// Test de hintVector vs hintToPoint
// =============================================================================

function compareHintMethods() {
  console.log("\n⚔️  Comparación: hintVector() vs hintToPoint()");
  console.log("=".repeat(60));

  const ITERATIONS = 1_000_000;
  const iv = new IntentVector();
  iv.reset(500, 500);

  // Setup: mover el cursor para tener velocidad
  for (let i = 0; i < 100; i++) {
    iv.update(500 + i, 500 + i, 16.67);
  }

  const targetX = 700;
  const targetY = 700;
  const radiusSq = 50 * 50;

  // Test hintVector
  const cursorX = 600;
  const cursorY = 600;
  const dx = targetX - cursorX;
  const dy = targetY - cursorY;

  let sum1 = 0;
  const start1 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    sum1 += iv.hintVector(dx, dy, radiusSq);
  }
  const time1 = performance.now() - start1;

  // Test hintToPoint
  let sum2 = 0;
  const start2 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    sum2 += iv.hintToPoint(targetX, targetY, radiusSq);
  }
  const time2 = performance.now() - start2;

  console.log(
    `\n  hintVector():  ${(time1 / ITERATIONS * 1000).toFixed(3)} μs/call`,
  );
  console.log(
    `  hintToPoint(): ${(time2 / ITERATIONS * 1000).toFixed(3)} μs/call`,
  );
  console.log(`\n  Diferencia: ${((time2 - time1) / time1 * 100).toFixed(1)}%`);
  console.log(
    `  (sum1=${sum1.toFixed(0)}, sum2=${sum2.toFixed(0)} - validación)`,
  );
}

// =============================================================================
// Test con diferentes cantidades de targets
// =============================================================================

function scaleTargets() {
  console.log("\n📈 Escalabilidad: Diferentes Cantidades de Targets");
  console.log("=".repeat(60));

  const FRAMES = 5_000;
  const DT = 16.67;
  const targetCounts = [10, 20, 50, 100, 200];

  // Pre-generar cursor path
  const cursorPath = new Float64Array(FRAMES * 2);
  for (let i = 0; i < FRAMES; i++) {
    cursorPath[i * 2] = i * 0.5;
    cursorPath[i * 2 + 1] = 500 + Math.sin(i * 0.01) * 100;
  }

  console.log(`\n  Targets | Frame Time | FPS Budget | Total Time`);
  console.log(`  --------|------------|------------|------------`);

  for (const numTargets of targetCounts) {
    const iv = new IntentVector();
    iv.reset(0, 500);

    // Generar targets
    const targets = [];
    for (let i = 0; i < numTargets; i++) {
      targets.push({
        x: Math.random() * 1000,
        y: Math.random() * 1000,
        radiusSq: 50 * 50,
      });
    }

    const start = performance.now();

    for (let frame = 0; frame < FRAMES; frame++) {
      const cursorX = cursorPath[frame * 2];
      const cursorY = cursorPath[frame * 2 + 1];

      iv.update(cursorX, cursorY, DT);

      for (const target of targets) {
        iv.hintToPoint(target.x, target.y, target.radiusSq);
      }
    }

    const time = performance.now() - start;
    const frameTime = time / FRAMES;
    const fpsBudget = frameTime / 16.67 * 100;

    console.log(
      `  ${numTargets.toString().padStart(7)} | ` +
        `${frameTime.toFixed(3).padStart(10)} ms | ` +
        `${fpsBudget.toFixed(2).padStart(9)}% | ` +
        `${time.toFixed(1).padStart(10)} ms`,
    );
  }
}

// =============================================================================
// Main
// =============================================================================

function main() {
  console.log(
    "\n╔═══════════════════════════════════════════════════════════╗",
  );
  console.log("║  IntentVector - Realistic Performance Test               ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  runRealisticScenario();
  compareHintMethods();
  scaleTargets();

  console.log("\n" + "=".repeat(60));
  console.log("✨ Tests completados\n");
}

main();

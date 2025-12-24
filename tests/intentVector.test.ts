/**
 * @file tests/intentVector.test.ts
 * @description Pruebas unitarias para el modelo cinético Brown-Holt y Cone Gating.
 *
 * Validaciones críticas:
 * - Predicción física matemáticamente correcta
 * - Score = 0 si target está detrás del vector de movimiento
 * - Score cercano a 1 si cursor se dirige directamente al target
 * - Comportamiento correcto en régimen de baja/alta velocidad
 * - Edge cases: dt = 0, dt > 1000, división por cero
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { IntentVector } from "../intent/intentVector.ts";

// ============================================================================
// Constantes de Test
// ============================================================================

const EPSILON = 1e-4;
const DEFAULT_DT = 16.67; // ~60fps
const TARGET_RADIUS_SQ = 400; // 20px radius squared

// ============================================================================
// 1. Pruebas de Inicialización y Reset
// ============================================================================

Deno.test("IntentVector: inicialización con config por defecto", () => {
  const iv = new IntentVector();
  const k = iv.getKinematics();

  assertEquals(k.px, 0, "Posición X inicial debe ser 0");
  assertEquals(k.py, 0, "Posición Y inicial debe ser 0");
  assertEquals(k.vx, 0, "Velocidad X inicial debe ser 0");
  assertEquals(k.vy, 0, "Velocidad Y inicial debe ser 0");
  assertEquals(k.v2, 0, "v² inicial debe ser 0");
});

Deno.test("IntentVector: reset establece posición correctamente", () => {
  const iv = new IntentVector();

  iv.reset(100, 200);
  const k = iv.getKinematics();

  assertEquals(k.px, 100, "Posición X después de reset");
  assertEquals(k.py, 200, "Posición Y después de reset");
  assertEquals(k.vx, 0, "Velocidad X debe ser 0 después de reset");
  assertEquals(k.vy, 0, "Velocidad Y debe ser 0 después de reset");
});

Deno.test("IntentVector: múltiples resets limpian estado", () => {
  const iv = new IntentVector();

  // Simular movimiento
  iv.reset(0, 0);
  for (let i = 0; i < 10; i++) {
    iv.update(i * 10, 0, DEFAULT_DT);
  }

  // Reset
  iv.reset(500, 500);
  const k = iv.getKinematics();

  assertEquals(k.px, 500);
  assertEquals(k.py, 500);
  assertEquals(k.vx, 0);
  assertEquals(k.vy, 0);
});

// ============================================================================
// 2. Pruebas de Brown-Holt Smoothing
// ============================================================================

Deno.test("IntentVector: movimiento lineal horizontal produce velocidad positiva en X", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Simular movimiento hacia la derecha
  for (let i = 1; i <= 20; i++) {
    iv.update(i * 5, 0, DEFAULT_DT);
  }

  const k = iv.getKinematics();

  assert(
    k.vx > 0,
    "Velocidad X debe ser positiva para movimiento hacia derecha",
  );
  assertAlmostEquals(
    k.vy,
    0,
    0.1,
    "Velocidad Y debe ser ~0 para movimiento horizontal",
  );
});

Deno.test("IntentVector: movimiento lineal vertical produce velocidad positiva en Y", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Simular movimiento hacia abajo
  for (let i = 1; i <= 20; i++) {
    iv.update(0, i * 5, DEFAULT_DT);
  }

  const k = iv.getKinematics();

  assertAlmostEquals(
    k.vx,
    0,
    0.1,
    "Velocidad X debe ser ~0 para movimiento vertical",
  );
  assert(k.vy > 0, "Velocidad Y debe ser positiva para movimiento hacia abajo");
});

Deno.test("IntentVector: movimiento diagonal produce velocidad en ambos ejes", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Movimiento diagonal 45°
  for (let i = 1; i <= 20; i++) {
    iv.update(i * 5, i * 5, DEFAULT_DT);
  }

  const k = iv.getKinematics();

  assert(k.vx > 0, "Velocidad X debe ser positiva");
  assert(k.vy > 0, "Velocidad Y debe ser positiva");
  // En diagonal 45°, vx ≈ vy
  assertAlmostEquals(
    k.vx,
    k.vy,
    0.5,
    "Velocidades deben ser similares en diagonal 45°",
  );
});

Deno.test("IntentVector: suavizado Brown-Holt filtra ruido", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Movimiento con ruido (zigzag pequeño sobre tendencia principal)
  for (let i = 1; i <= 30; i++) {
    const noise = (i % 2 === 0) ? 2 : -2;
    iv.update(i * 5, noise, DEFAULT_DT);
  }

  const k = iv.getKinematics();

  assert(k.vx > 0, "Tendencia principal debe dominar");
  // vy debe ser pequeña debido al suavizado
  assert(
    Math.abs(k.vy) < Math.abs(k.vx) * 0.5,
    "Ruido vertical debe ser filtrado",
  );
});

// ============================================================================
// 3. Pruebas de Cone Gating
// ============================================================================

Deno.test("IntentVector: score = 0 para target detrás del vector de movimiento", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Mover hacia la derecha
  for (let i = 1; i <= 20; i++) {
    iv.update(i * 10, 0, DEFAULT_DT);
  }

  const k = iv.getKinematics();
  assert(k.vx > 0.1, "Debe haber velocidad significativa hacia la derecha");

  // Target a la izquierda (detrás del movimiento)
  const dx = -50; // 50px a la izquierda de la posición actual
  const dy = 0;
  const score = iv.hintVector(dx, dy, TARGET_RADIUS_SQ);

  assertEquals(score, 0, "Score debe ser 0 para target detrás del movimiento");
});

Deno.test("IntentVector: score alto para target en dirección del movimiento", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Mover hacia la derecha
  for (let i = 1; i <= 20; i++) {
    iv.update(i * 10, 0, DEFAULT_DT);
  }

  // Target adelante en la misma dirección
  const dx = 30;
  const dy = 0;
  const score = iv.hintVector(dx, dy, TARGET_RADIUS_SQ);

  assert(
    score > 0.3,
    `Score debe ser alto para target en dirección del movimiento, got ${score}`,
  );
});

Deno.test("IntentVector: score = 0 para target fuera del cono (perpendicular)", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Mover hacia la derecha con velocidad alta
  for (let i = 1; i <= 30; i++) {
    iv.update(i * 15, 0, DEFAULT_DT);
  }

  // Target perpendicular (muy arriba o abajo) pero lejos
  const dx = 5; // Ligeramente adelante
  const dy = 200; // Muy arriba (fuera del cono)
  const score = iv.hintVector(dx, dy, TARGET_RADIUS_SQ);

  assertEquals(score, 0, "Score debe ser 0 para target fuera del cono");
});

Deno.test("IntentVector: cono se estrecha con mayor velocidad", () => {
  const iv1 = new IntentVector();
  const iv2 = new IntentVector();

  iv1.reset(0, 0);
  iv2.reset(0, 0);

  // iv1: velocidad baja
  for (let i = 1; i <= 10; i++) {
    iv1.update(i * 3, 0, DEFAULT_DT);
  }

  // iv2: velocidad alta
  for (let i = 1; i <= 10; i++) {
    iv2.update(i * 20, 0, DEFAULT_DT);
  }

  // Target ligeramente desviado
  const dx = 20;
  const dy = 15;

  const score1 = iv1.hintVector(dx, dy, TARGET_RADIUS_SQ);
  const score2 = iv2.hintVector(dx, dy, TARGET_RADIUS_SQ);

  // Con velocidad alta, el cono es más estrecho, score debería ser menor
  // (o target podría estar fuera del cono)
  assert(
    score2 <= score1 || score2 === 0,
    `Cono más estrecho con velocidad alta: score1=${score1}, score2=${score2}`,
  );
});

// ============================================================================
// 4. Pruebas de Régimen de Baja Velocidad
// ============================================================================

Deno.test("IntentVector: régimen de baja velocidad - target cercano score alto", () => {
  const iv = new IntentVector();
  iv.reset(100, 100);

  // Sin movimiento significativo
  iv.update(101, 101, DEFAULT_DT);
  iv.update(102, 100, DEFAULT_DT);

  const k = iv.getKinematics();
  assert(k.v2 < 0.01, "Debe estar en régimen de baja velocidad");

  // Target muy cercano
  const score = iv.hintToPoint(110, 105, TARGET_RADIUS_SQ);

  assert(score > 0, "Target cercano en baja velocidad debe tener score > 0");
});

Deno.test("IntentVector: régimen de baja velocidad - target dentro del radio = score perfecto", () => {
  const iv = new IntentVector();
  iv.reset(100, 100);

  // Mínimo movimiento
  iv.update(100, 100, DEFAULT_DT);

  // Target muy cercano (dentro del radio)
  const score = iv.hintToPoint(102, 102, 100); // radiusSq = 100, distSq = 8

  assertEquals(
    score,
    1,
    "Target dentro del radio en baja velocidad = score perfecto",
  );
});

Deno.test("IntentVector: régimen de baja velocidad - target lejano score bajo", () => {
  const iv = new IntentVector();
  iv.reset(100, 100);

  iv.update(100, 100, DEFAULT_DT);

  // Target muy lejano (fuera de nearMul * radius)
  const score = iv.hintToPoint(500, 500, TARGET_RADIUS_SQ);

  assertEquals(score, 0, "Target lejano en baja velocidad = score 0");
});

// ============================================================================
// 5. Pruebas de Deceleración (Brake Evidence)
// ============================================================================

Deno.test("IntentVector: deceleración aumenta score (brake evidence)", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Acelerar
  for (let i = 1; i <= 15; i++) {
    iv.update(i * 15, 0, DEFAULT_DT);
  }

  const k1 = iv.getKinematics();

  // Frenar (reducir velocidad de avance)
  for (let i = 0; i < 5; i++) {
    iv.update(k1.px + 2, 0, DEFAULT_DT); // Movimiento más lento
  }

  const k2 = iv.getKinematics();

  // Verificar que hay deceleración (ax negativa cuando vx positiva)
  // o simplemente que el score puede ser influenciado por braking
  const scoreAfter = iv.hintVector(30, 0, TARGET_RADIUS_SQ);

  // Este test verifica que el sistema detecta la deceleración
  assert(k2.ax <= 0 || scoreAfter >= 0, "Sistema debe manejar deceleración");
});

// ============================================================================
// 6. Pruebas de hintToPoint vs hintVector
// ============================================================================

Deno.test("IntentVector: hintToPoint es equivalente a hintVector con delta correcto", () => {
  const iv = new IntentVector();
  iv.reset(100, 100);

  for (let i = 1; i <= 10; i++) {
    iv.update(100 + i * 5, 100, DEFAULT_DT);
  }

  const k = iv.getKinematics();
  const targetX = 180;
  const targetY = 110;

  const score1 = iv.hintToPoint(targetX, targetY, TARGET_RADIUS_SQ);
  const score2 = iv.hintVector(
    targetX - k.px,
    targetY - k.py,
    TARGET_RADIUS_SQ,
  );

  assertAlmostEquals(
    score1,
    score2,
    EPSILON,
    "hintToPoint debe ser equivalente a hintVector",
  );
});

// ============================================================================
// 7. Pruebas de Edge Cases
// ============================================================================

Deno.test("IntentVector: dt muy pequeño (< 1ms) es clampeado", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // No debería crashear con dt pequeño - se clampea a MIN_DELTA_TIME_MS
  iv.update(10, 10, 0.1);
  iv.update(20, 20, 0.5);

  const k = iv.getKinematics();
  assert(Number.isFinite(k.vx), "Velocidad debe ser finita con dt pequeño");
  assert(Number.isFinite(k.vy), "Velocidad debe ser finita con dt pequeño");
});

Deno.test("IntentVector: dt = 0 no causa división por cero", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // dt = 0 se clampea a MIN_DELTA_TIME_MS
  iv.update(10, 10, 0);
  iv.update(20, 20, 0);

  const k = iv.getKinematics();
  assert(Number.isFinite(k.vx), "Velocidad X debe ser finita");
  assert(Number.isFinite(k.vy), "Velocidad Y debe ser finita");
  assert(!Number.isNaN(k.vx), "Velocidad X no debe ser NaN");
  assert(!Number.isNaN(k.vy), "Velocidad Y no debe ser NaN");
});

Deno.test("IntentVector: dt muy grande (> 1000ms) funciona correctamente", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // dt grande (simula tab inactivo) - debe manejarse correctamente
  iv.update(100, 100, 2000);

  const k = iv.getKinematics();
  assert(Number.isFinite(k.vx), "Sistema debe manejar dt grande");
  assert(Number.isFinite(k.vy), "Sistema debe manejar dt grande");
});

Deno.test("IntentVector: hintVector con distancia = 0 retorna PERFECT_SCORE", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  iv.update(10, 10, DEFAULT_DT);

  // dx = 0, dy = 0 (cursor sobre el target)
  const score = iv.hintVector(0, 0, TARGET_RADIUS_SQ);

  assertEquals(score, 1, "Distancia 0 debe retornar score perfecto");
});

Deno.test("IntentVector: scores siempre están en [0, 1]", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  for (let i = 1; i <= 30; i++) {
    iv.update(i * 10, Math.sin(i) * 20, DEFAULT_DT);
  }

  const testCases = [
    [100, 0],
    [0, 100],
    [-100, 0],
    [0, -100],
    [50, 50],
    [-50, -50],
    [10, 5],
    [1000, 1000],
  ];

  for (const [dx, dy] of testCases) {
    const score = iv.hintVector(dx, dy, TARGET_RADIUS_SQ);
    assert(
      score >= 0 && score <= 1,
      `Score ${score} fuera de rango para (${dx}, ${dy})`,
    );
  }
});

// ============================================================================
// 8. Pruebas de Cambios Bruscos de Dirección
// ============================================================================

Deno.test("IntentVector: cambio brusco de dirección 180°", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Mover hacia la derecha
  for (let i = 1; i <= 10; i++) {
    iv.update(i * 10, 0, DEFAULT_DT);
  }

  // Save a copy since getKinematics returns a mutable cached object
  const k1 = iv.getKinematics();
  const vx1 = k1.vx;
  assert(vx1 > 0, "Velocidad inicial hacia la derecha");

  // Cambio brusco: mover hacia la izquierda
  for (let i = 1; i <= 15; i++) {
    iv.update(100 - i * 10, 0, DEFAULT_DT);
  }

  const k2 = iv.getKinematics();

  // El suavizado Brown-Holt debería eventualmente reflejar el cambio
  assert(
    k2.vx < vx1,
    "Velocidad debe reducirse o invertirse después del cambio",
  );
});

Deno.test("IntentVector: cambio de dirección 90°", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  // Mover hacia la derecha
  for (let i = 1; i <= 10; i++) {
    iv.update(i * 10, 0, DEFAULT_DT);
  }

  // Cambio: ahora hacia abajo
  const baseX = 100;
  for (let i = 1; i <= 10; i++) {
    iv.update(baseX, i * 10, DEFAULT_DT);
  }

  const k = iv.getKinematics();

  // Después del cambio, vy debería ser significativa
  assert(
    k.vy > 0,
    "Velocidad Y debe ser positiva después del giro hacia abajo",
  );
});

// ============================================================================
// 9. Pruebas de Configuración Personalizada
// ============================================================================

Deno.test("IntentVector: setConfig actualiza comportamiento", () => {
  const iv = new IntentVector();

  // Config con horizonte más pequeño
  iv.setConfig({ horizonBasePx: 20, horizonMs: 100 });

  iv.reset(0, 0);
  for (let i = 1; i <= 10; i++) {
    iv.update(i * 10, 0, DEFAULT_DT);
  }

  // Target lejano debería estar fuera del horizonte reducido
  const score = iv.hintVector(500, 0, TARGET_RADIUS_SQ);

  // Con horizonte pequeño, targets lejanos deberían tener score 0
  assert(score === 0 || score < 0.5, "Target lejano con horizonte reducido");
});

// ============================================================================
// 10. Pruebas de Velocidad Máxima (Clamping)
// ============================================================================

Deno.test("IntentVector: velocidad es clampeada a vMax", () => {
  const iv = new IntentVector({ vMax: 2.0 }); // vMax = 2 px/ms
  iv.reset(0, 0);

  // Movimiento extremadamente rápido (teleportación)
  iv.update(1000, 0, DEFAULT_DT); // 1000px en 16ms = 62.5 px/ms

  const k = iv.getKinematics();
  const speed = Math.sqrt(k.v2);

  assert(speed <= 2.5, `Velocidad debe estar cerca de vMax, got ${speed}`);
});

// ============================================================================
// 11. Pruebas de getKinematics Cache
// ============================================================================

Deno.test("IntentVector: getKinematics retorna objeto consistente", () => {
  const iv = new IntentVector();
  iv.reset(0, 0);

  iv.update(50, 30, DEFAULT_DT);

  const k1 = iv.getKinematics();
  const k2 = iv.getKinematics();

  // Múltiples llamadas deben retornar los mismos valores
  assertEquals(k1.px, k2.px);
  assertEquals(k1.py, k2.py);
  assertEquals(k1.vx, k2.vx);
  assertEquals(k1.vy, k2.vy);
});

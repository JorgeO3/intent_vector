/**
 * @file bench/intentVector.bench.ts
 * @description Benchmarks para el modelo cinético Brown-Holt
 */

import { IntentVector } from "../intent/intentVector.ts";

const DT = 16.67; // ~60fps

// Pre-create and warm up instances
const iv1 = new IntentVector();
iv1.reset(500, 500);
for (let i = 0; i < 10; i++) {
  iv1.update(500 + i, 500 + i, DT);
}

const iv2 = new IntentVector();
iv2.reset(500, 400);
for (let i = 0; i < 10; i++) {
  iv2.update(500 + i * 2, 400 + i, DT);
}

let counter = 0;

Deno.bench({
  name: "IntentVector: update()",
  fn() {
    iv1.update(counter % 1000, (counter * 7) % 800, DT);
    counter++;
  },
});

Deno.bench({
  name: "IntentVector: update() + getKinematics()",
  fn() {
    iv1.update(counter % 1000, (counter * 7) % 800, DT);
    iv1.getKinematics();
    counter++;
  },
});

Deno.bench({
  name: "IntentVector: hintToPoint()",
  fn() {
    iv2.hintToPoint(
      (counter % 800) + 100,
      (counter % 600) + 100,
      400, // radiusSq
    );
    counter++;
  },
});

Deno.bench({
  name: "IntentVector: hintVector()",
  fn() {
    iv2.hintVector(
      (counter % 100) - 50,
      (counter % 80) - 40,
      400,
    );
    counter++;
  },
});

Deno.bench({
  name: "IntentVector: constructor",
  fn() {
    new IntentVector();
  },
});

Deno.bench({
  name: "IntentVector: reset()",
  fn() {
    iv1.reset(counter % 1000, counter % 800);
    counter++;
  },
});

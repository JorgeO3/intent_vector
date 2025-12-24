/**
 * TargetLock benchmarks
 */

import { IntentVector } from "../intent/intentVector.ts";
import { TargetLock } from "../runtime/targetLock.ts";
import type { Candidate, IslandKey } from "../runtime/types.ts";

// Pre-generate test data
const testKeys: IslandKey[] = [];
for (let i = 1; i <= 100; i++) {
  testKeys.push(i as IslandKey);
}

function generateCandidates(
  count: number,
  px: number,
  py: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const x = px + (Math.random() - 0.5) * 400;
    const y = py + (Math.random() - 0.5) * 400;
    candidates.push({
      key: testKeys[i % testKeys.length],
      rect: { x, y, w: 100, h: 40 },
    });
  }
  return candidates;
}

// Pre-warmed instances for select benchmarks
const iv10 = new IntentVector();
const lock10 = new TargetLock(iv10);
const candidates10 = generateCandidates(10, 200, 200);
iv10.update(200, 200, 16.67);
iv10.update(210, 205, 16.67);

const iv50 = new IntentVector();
const lock50 = new TargetLock(iv50);
const candidates50 = generateCandidates(50, 200, 200);
iv50.update(200, 200, 16.67);
iv50.update(210, 205, 16.67);

const iv100 = new IntentVector();
const lock100 = new TargetLock(iv100);
const candidates100 = generateCandidates(100, 200, 200);
iv100.update(200, 200, 16.67);
iv100.update(210, 205, 16.67);

const ivDynamic = new IntentVector();
const lockDynamic = new TargetLock(ivDynamic);
const candidatesDynamic = generateCandidates(30, 300, 300);
let dynamicX = 100, dynamicY = 100;
const dt = 16.67;
ivDynamic.update(dynamicX, dynamicY, dt);

const ivReset = new IntentVector();
const lockReset = new TargetLock(ivReset);
const candidatesReset = generateCandidates(20, 200, 200);
ivReset.update(200, 200, 16.67);
lockReset.select(candidatesReset, 16.67);

const ivConfig = new IntentVector();
const lockConfig = new TargetLock(ivConfig);

let counter = 0;

Deno.bench("TargetLock: select() with 10 candidates", () => {
  lock10.select(candidates10, 16.67);
});

Deno.bench("TargetLock: select() with 50 candidates", () => {
  lock50.select(candidates50, 16.67);
});

Deno.bench("TargetLock: select() with 100 candidates", () => {
  lock100.select(candidates100, 16.67);
});

Deno.bench("TargetLock: dynamic movement simulation", () => {
  // Simulate smooth cursor movement
  dynamicX += (Math.random() - 0.3) * 8;
  dynamicY += (Math.random() - 0.3) * 8;

  ivDynamic.update(dynamicX, dynamicY, dt);
  lockDynamic.select(candidatesDynamic, 16.67);
});

Deno.bench("TargetLock: reset() operation", () => {
  lockReset.reset();
});

Deno.bench("TargetLock: setConfig()", () => {
  lockConfig.setConfig({ topK: 5 + (counter % 10) });
  counter++;
});

Deno.bench("TargetLock: constructor", () => {
  const iv = new IntentVector();
  new TargetLock(iv);
});

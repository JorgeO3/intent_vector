/**
 * Integrated engine benchmarks - simulating real usage patterns
 */

import { IntentVector } from "../intent/intentVector.ts";
import { TargetLock } from "../runtime/targetLock.ts";
import { ReputationLedger } from "../runtime/reputationLedger.ts";
import { UtilityGate } from "../runtime/utilityGate.ts";
import type { Candidate, IslandKey } from "../runtime/types.ts";

// Pre-generate test data
const testKeys: IslandKey[] = [];
for (let i = 1; i <= 200; i++) {
  testKeys.push(i as IslandKey);
}

function generateCandidates(
  count: number,
  cx: number,
  cy: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const radius = 50 + Math.random() * 300;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    candidates.push({
      key: testKeys[i % testKeys.length],
      rect: { x, y, w: 80 + Math.random() * 60, h: 30 + Math.random() * 20 },
    });
  }
  return candidates;
}

// Generates smooth bezier-like mouse movement
function generateMousePath(
  steps: number,
): Array<{ x: number; y: number; dt: number }> {
  const path: Array<{ x: number; y: number; dt: number }> = [];
  const startX = 100, startY = 100;
  const endX = 500, endY = 400;
  const cp1x = 200, cp1y = 50;
  const cp2x = 400, cp2y = 450;

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const u = 1 - t;
    // Cubic bezier
    const x = u * u * u * startX + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x +
      t * t * t * endX;
    const y = u * u * u * startY + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y +
      t * t * t * endY;
    path.push({ x, y, dt: 16.67 });
  }
  return path;
}

// Pre-warmed instances
const iv50 = new IntentVector();
const lock50 = new TargetLock(iv50);
const candidates50 = generateCandidates(50, 300, 300);
iv50.update(300, 300, 16.67);
iv50.update(310, 305, 16.67);

const iv100 = new IntentVector();
const lock100 = new TargetLock(iv100);
const candidates100 = generateCandidates(100, 300, 300);
iv100.update(300, 300, 16.67);
iv100.update(310, 305, 16.67);

const iv200 = new IntentVector();
const lock200 = new TargetLock(iv200);
const candidates200 = generateCandidates(200, 300, 300);
iv200.update(300, 300, 16.67);
iv200.update(310, 305, 16.67);

const ivPath = new IntentVector();
const lockPath = new TargetLock(ivPath);
const candidatesPath = generateCandidates(80, 300, 250);
const path = generateMousePath(60);
let pathIndex = 0;

const ivRep = new IntentVector();
const lockRep = new TargetLock(ivRep);
const ledgerRep = new ReputationLedger();
const candidatesRep = generateCandidates(50, 300, 300);
for (const c of candidatesRep) {
  ledgerRep.recordHit(`/test`, `island-${c.key}`);
}
ivRep.update(300, 300, 16.67);
ivRep.update(310, 305, 16.67);

const iv60fps = new IntentVector();
const lock60fps = new TargetLock(iv60fps);
const gate60fps = new UtilityGate();
const candidates60fps = generateCandidates(60, 400, 300);
let fps60X = 200, fps60Y = 200;
let fps60Frame = 0;
const dt60 = 16.67;
iv60fps.update(fps60X, fps60Y, dt60);

Deno.bench("Engine: single frame (50 candidates)", () => {
  lock50.select(candidates50, 16.67);
});

Deno.bench("Engine: single frame (100 candidates)", () => {
  lock100.select(candidates100, 16.67);
});

Deno.bench("Engine: single frame (200 candidates)", () => {
  lock200.select(candidates200, 16.67);
});

Deno.bench("Engine: realistic mouse movement frame", () => {
  const point = path[pathIndex % path.length];
  ivPath.update(point.x, point.y, point.dt);
  lockPath.select(candidatesPath, 16.67);
  pathIndex++;
});

Deno.bench("Engine: full frame with reputation lookup", () => {
  const selection = lockRep.select(candidatesRep, 16.67);

  // Simulate reputation lookup for winner
  if (selection.key) {
    ledgerRep.prior(`/test`, `island-${selection.key}`);
  }
});

Deno.bench("Engine: 60fps sustained frame", () => {
  // Natural mouse movement
  fps60X += Math.sin(fps60Frame * 0.1) * 5 + (Math.random() - 0.5) * 2;
  fps60Y += Math.cos(fps60Frame * 0.1) * 3 + (Math.random() - 0.5) * 2;

  iv60fps.update(fps60X, fps60Y, dt60);
  lock60fps.select(candidates60fps, dt60);
  fps60Frame++;
});

Deno.bench("Engine: complete initialization", () => {
  const _iv = new IntentVector();
  const _lock = new TargetLock(_iv);
  const _ledger = new ReputationLedger();
  const _gate = new UtilityGate();
});

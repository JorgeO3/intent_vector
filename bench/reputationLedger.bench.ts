/**
 * ReputationLedger benchmarks
 */

import { ReputationLedger } from "../runtime/reputationLedger.ts";

// Pre-generate test route/island pairs
const testPairs: Array<{ routeId: string; islandId: string }> = [];
for (let i = 0; i < 100; i++) {
  testPairs.push({
    routeId: `/route/${i}`,
    islandId: `island-${i}`,
  });
}

// Pre-populated instances
const ledger1 = new ReputationLedger();
const ledger2 = new ReputationLedger();
for (const pair of testPairs) {
  ledger2.recordHit(pair.routeId, pair.islandId);
}

const ledger3 = new ReputationLedger();

let counter = 0;

Deno.bench("ReputationLedger: recordHit()", () => {
  const pair = testPairs[counter % testPairs.length];
  ledger1.recordHit(pair.routeId, pair.islandId);
  counter++;
});

Deno.bench("ReputationLedger: recordMiss()", () => {
  const pair = testPairs[counter % testPairs.length];
  ledger1.recordMiss(pair.routeId, pair.islandId);
  counter++;
});

Deno.bench("ReputationLedger: prior() existing entries", () => {
  const pair = testPairs[counter % testPairs.length];
  ledger2.prior(pair.routeId, pair.islandId);
  counter++;
});

Deno.bench("ReputationLedger: prior() missing entries", () => {
  ledger1.prior(`/unknown/route/${counter}`, `unknown-island-${counter}`);
  counter++;
});

Deno.bench("ReputationLedger: mixed workload", () => {
  const pair = testPairs[counter % testPairs.length];
  const op = counter % 5;

  if (op < 2) {
    ledger3.recordHit(pair.routeId, pair.islandId);
  } else if (op < 3) {
    ledger3.recordMiss(pair.routeId, pair.islandId);
  } else {
    ledger3.prior(pair.routeId, pair.islandId);
  }
  counter++;
});

Deno.bench("ReputationLedger: constructor", () => {
  new ReputationLedger();
});

Deno.bench("ReputationLedger: constructor with custom config", () => {
  new ReputationLedger({ emaAlpha: 0.2, minPrior: 0.5, maxPrior: 1.5 });
});

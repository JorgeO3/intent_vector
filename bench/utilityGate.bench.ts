/**
 * UtilityGate benchmarks
 */

import { UtilityGate } from "../runtime/utilityGate.ts";

const gate1 = new UtilityGate();
const gate2 = new UtilityGate();

let counter = 0;

Deno.bench("UtilityGate: constructor default config", () => {
  new UtilityGate();
});

Deno.bench("UtilityGate: constructor with custom config", () => {
  new UtilityGate({
    sigmaSkip: 0.03,
    minMargin: 0.05,
    maxTargets: 3,
  });
});

Deno.bench("UtilityGate: setConfig()", () => {
  gate1.setConfig({ sigmaSkip: 0.02 + (counter % 10) * 0.001 });
  counter++;
});

Deno.bench("UtilityGate: setConfig() multiple fields", () => {
  gate2.setConfig({
    sigmaSkip: 0.02 + (counter % 10) * 0.001,
    minMargin: 0.04 + (counter % 5) * 0.01,
    maxTargets: 1 + (counter % 3),
  });
  counter++;
});

/**
 * @file bench/pressure.bench.ts
 * @description Benchmarks para el monitor de presión CPU/red
 */

import { PressureMonitor } from "../runtime/pressure.ts";

// Warm instances
const monitor1 = new PressureMonitor();
monitor1.read(); // Initialize

const monitor2 = new PressureMonitor();

let counter = 0;

Deno.bench({
  name: "PressureMonitor: read() cold (first call)",
  fn() {
    const monitor = new PressureMonitor();
    monitor.read();
    monitor.dispose();
  },
});

Deno.bench({
  name: "PressureMonitor: read() warm",
  fn() {
    monitor1.read();
  },
});

Deno.bench({
  name: "PressureMonitor: setLastEngineCostMs()",
  fn() {
    monitor2.setLastEngineCostMs(counter % 10);
    counter++;
  },
});

Deno.bench({
  name: "PressureMonitor: read() + setLastEngineCostMs() mixed",
  fn() {
    monitor1.setLastEngineCostMs(counter % 10);
    if (counter % 10 === 0) {
      monitor1.read();
    }
    counter++;
  },
});

Deno.bench({
  name: "PressureMonitor: constructor + dispose cycle",
  fn() {
    const monitor = new PressureMonitor();
    monitor.dispose();
  },
});

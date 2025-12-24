/**
 * @file profiler.ts
 * @description Sistema de profiling de bajo overhead para IntentVector
 */

export interface ProfileTimings {
  total: number;
  alphaCaching: number;
  brownHolt: number;
  motionUpdate: number;
  velocityClamp: number;
  frameCache: number;
  brakeBoost: number;
  count: number;
}

export class Profiler {
  private timings: ProfileTimings = {
    total: 0,
    alphaCaching: 0,
    brownHolt: 0,
    motionUpdate: 0,
    velocityClamp: 0,
    frameCache: 0,
    brakeBoost: 0,
    count: 0,
  };

  private enabled = false;
  private tempStart = 0;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.timings = {
      total: 0,
      alphaCaching: 0,
      brownHolt: 0,
      motionUpdate: 0,
      velocityClamp: 0,
      frameCache: 0,
      brakeBoost: 0,
      count: 0,
    };
  }

  // Inline methods - zero cost when disabled
  startSection(): number {
    return this.enabled ? performance.now() : 0;
  }

  recordSection(
    section: keyof Omit<ProfileTimings, "count" | "total">,
    start: number,
  ): void {
    if (!this.enabled) return;
    this.timings[section] += performance.now() - start;
  }

  startTotal(): void {
    if (!this.enabled) return;
    this.tempStart = performance.now();
  }

  endTotal(): void {
    if (!this.enabled) return;
    this.timings.total += performance.now() - this.tempStart;
    this.timings.count++;
  }

  getTimings(): Readonly<ProfileTimings> {
    return this.timings;
  }

  getReport(): string {
    const t = this.timings;
    if (t.count === 0) return "No profiling data";

    const avgTotal = t.total / t.count;
    const lines = [
      `\n${"=".repeat(60)}`,
      `IntentVector.update() Profile Report`,
      `${"=".repeat(60)}`,
      `Samples: ${t.count}`,
      `Total time: ${t.total.toFixed(2)} ms (avg: ${
        avgTotal.toFixed(4)
      } ms/call)`,
      ``,
      `Breakdown:`,
      `  Alpha Caching:   ${t.alphaCaching.toFixed(2)} ms (${
        (t.alphaCaching / t.total * 100).toFixed(1)
      }%)`,
      `  Brown-Holt:      ${t.brownHolt.toFixed(2)} ms (${
        (t.brownHolt / t.total * 100).toFixed(1)
      }%)`,
      `  Motion Update:   ${t.motionUpdate.toFixed(2)} ms (${
        (t.motionUpdate / t.total * 100).toFixed(1)
      }%)`,
      `  Velocity Clamp:  ${t.velocityClamp.toFixed(2)} ms (${
        (t.velocityClamp / t.total * 100).toFixed(1)
      }%)`,
      `  Frame Cache:     ${t.frameCache.toFixed(2)} ms (${
        (t.frameCache / t.total * 100).toFixed(1)
      }%)`,
      `  Brake Boost:     ${t.brakeBoost.toFixed(2)} ms (${
        (t.brakeBoost / t.total * 100).toFixed(1)
      }%)`,
      ``,
      `Per-call averages:`,
      `  Alpha Caching:   ${(t.alphaCaching / t.count * 1000).toFixed(2)} μs`,
      `  Brown-Holt:      ${(t.brownHolt / t.count * 1000).toFixed(2)} μs`,
      `  Motion Update:   ${(t.motionUpdate / t.count * 1000).toFixed(2)} μs`,
      `  Velocity Clamp:  ${(t.velocityClamp / t.count * 1000).toFixed(2)} μs`,
      `  Frame Cache:     ${(t.frameCache / t.count * 1000).toFixed(2)} μs`,
      `  Brake Boost:     ${(t.brakeBoost / t.count * 1000).toFixed(2)} μs`,
      `${"=".repeat(60)}\n`,
    ];

    return lines.join("\n");
  }
}

// Singleton global para acceso rápido
export const globalProfiler = new Profiler();

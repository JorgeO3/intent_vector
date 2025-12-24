#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * @file scripts/bundle-size.ts
 * @description Analiza el tamaño del bundle de la librería
 *
 * Genera un reporte con:
 * - Tamaño de cada módulo individual
 * - Tamaño total sin comprimir
 * - Tamaño gzipped
 * - Tamaño brotli
 */

// import { gzip } from "https://deno.land/x/compress@v0.4.5/gzip/mod.ts";
// import { compress as brotli } from "https://deno.land/x/brotli@0.1.7/mod.ts";
import { brotli, gzip } from "@deno-library/compress";

interface ModuleSize {
  name: string;
  path: string;
  raw: number;
  gzipped: number;
  brotli: number;
  lines: number;
}

interface BundleReport {
  modules: ModuleSize[];
  total: {
    raw: number;
    gzipped: number;
    brotli: number;
    lines: number;
  };
  minified?: {
    raw: number;
    gzipped: number;
    brotli: number;
  };
  timestamp: string;
}

const MODULES = [
  { name: "keyCodec", path: "runtime/keyCodec.ts" },
  { name: "types", path: "runtime/types.ts" },
  { name: "intentVector", path: "intent/intentVector.ts" },
  { name: "islandLocator", path: "runtime/islandLocator.ts" },
  { name: "islandManifest", path: "runtime/islandManifest.ts" },
  { name: "islandToken", path: "runtime/islandToken.ts" },
  { name: "reputationLedger", path: "runtime/reputationLedger.ts" },
  { name: "targetLock", path: "runtime/targetLock.ts" },
  { name: "flightScheduler", path: "runtime/flightScheduler.ts" },
  { name: "utilityGate", path: "runtime/utilityGate.ts" },
  { name: "pressure", path: "runtime/pressure.ts" },
  { name: "actuators", path: "runtime/actuators.ts" },
  { name: "runtime", path: "runtime/runtime.ts" },
  { name: "main", path: "main.ts" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function countLines(content: string): number {
  return content.split("\n").length;
}

async function analyzeModule(
  module: { name: string; path: string },
): Promise<ModuleSize | null> {
  try {
    const content = await Deno.readTextFile(module.path);
    const bytes = new TextEncoder().encode(content);
    const raw = bytes.length;
    const compressed = gzip(bytes);
    const brotliCompressed = brotli.compressSync(bytes);

    return {
      name: module.name,
      path: module.path,
      raw,
      gzipped: compressed.length,
      brotli: brotliCompressed.length,
      lines: countLines(content),
    };
  } catch {
    return null;
  }
}

async function generateBundle(): Promise<string> {
  // Use deno bundle equivalent - read and concatenate all modules
  let bundle = "";

  for (const mod of MODULES) {
    try {
      const content = await Deno.readTextFile(mod.path);
      bundle += `// === ${mod.path} ===\n${content}\n\n`;
    } catch {
      // Skip missing files
    }
  }

  return bundle;
}

async function main() {
  console.log("\n🔍 Intent Vector - Bundle Size Analysis\n");
  console.log("=".repeat(70));

  const results: ModuleSize[] = [];

  // Analyze individual modules
  console.log("\n📦 Individual Module Sizes:\n");
  console.log(
    "Module".padEnd(20) + "Raw".padStart(10) + "Gzip".padStart(10) +
      "Brotli".padStart(10) + "Lines".padStart(8),
  );
  console.log("-".repeat(58));

  for (const mod of MODULES) {
    const size = await analyzeModule(mod);
    if (size) {
      results.push(size);
      console.log(
        size.name.padEnd(20) +
          formatBytes(size.raw).padStart(10) +
          formatBytes(size.gzipped).padStart(10) +
          formatBytes(size.brotli).padStart(10) +
          size.lines.toString().padStart(8),
      );
    }
  }

  // Calculate totals
  const totalRaw = results.reduce((sum, m) => sum + m.raw, 0);
  const totalGzipped = results.reduce((sum, m) => sum + m.gzipped, 0);
  const totalBrotli = results.reduce((sum, m) => sum + m.brotli, 0);
  const totalLines = results.reduce((sum, m) => sum + m.lines, 0);

  console.log("-".repeat(58));
  console.log(
    "TOTAL".padEnd(20) +
      formatBytes(totalRaw).padStart(10) +
      formatBytes(totalGzipped).padStart(10) +
      formatBytes(totalBrotli).padStart(10) +
      totalLines.toString().padStart(8),
  );

  // Generate and analyze full bundle
  console.log("\n📊 Full Bundle Analysis:\n");

  const bundle = await generateBundle();
  const bundleBytes = new TextEncoder().encode(bundle);
  const bundleGzipped = gzip(bundleBytes);
  const bundleBrotli = brotli.compressSync(bundleBytes);

  console.log(`  Source (concatenated):  ${formatBytes(bundleBytes.length)}`);
  console.log(`  Gzipped:                ${formatBytes(bundleGzipped.length)}`);
  console.log(`  Brotli:                 ${formatBytes(bundleBrotli.length)}`);
  console.log(
    `  Gzip ratio:             ${
      ((bundleGzipped.length / bundleBytes.length) * 100).toFixed(1)
    }%`,
  );
  console.log(
    `  Brotli ratio:           ${
      ((bundleBrotli.length / bundleBytes.length) * 100).toFixed(1)
    }%`,
  );

  // Try to run esbuild for minified bundle if available
  console.log("\n🔧 Minified Bundle (via esbuild):\n");

  try {
    // Create a temporary entry file
    const entryContent = `
export * from "./runtime/keyCodec.ts";
export * from "./runtime/types.ts";
export * from "./intent/intentVector.ts";
export * from "./runtime/islandLocator.ts";
export * from "./runtime/islandToken.ts";
export * from "./runtime/reputationLedger.ts";
export * from "./runtime/targetLock.ts";
export * from "./runtime/flightScheduler.ts";
export * from "./runtime/utilityGate.ts";
export * from "./runtime/pressure.ts";
export * from "./runtime/actuators.ts";
export * from "./runtime/runtime.ts";
`;
    await Deno.writeTextFile("_bundle_entry.ts", entryContent);

    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "-A",
        "npm:esbuild",
        "_bundle_entry.ts",
        "--bundle",
        "--minify",
        "--format=esm",
        "--outfile=_bundle.min.js",
        "--target=es2022",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const { code } = await cmd.output();

    if (code === 0) {
      const minified = await Deno.readFile("_bundle.min.js");
      const minifiedGzipped = gzip(minified);
      const minifiedBrotli = brotli.compressSync(minified);

      console.log(`  Minified:               ${formatBytes(minified.length)}`);
      console.log(
        `  Minified + Gzipped:     ${formatBytes(minifiedGzipped.length)}`,
      );
      console.log(
        `  Minified + Brotli:      ${formatBytes(minifiedBrotli.length)}`,
      );
      console.log(
        `  Gzip ratio:             ${
          ((minifiedGzipped.length / minified.length) * 100).toFixed(1)
        }%`,
      );
      console.log(
        `  Brotli ratio:           ${
          ((minifiedBrotli.length / minified.length) * 100).toFixed(1)
        }%`,
      );

      // Cleanup
      await Deno.remove("_bundle_entry.ts");
      await Deno.remove("_bundle.min.js");
    } else {
      console.log(
        "  ⚠️  esbuild not available or failed, skipping minification",
      );
      try {
        await Deno.remove("_bundle_entry.ts");
      } catch { /* ignore */ }
    }
  } catch (e) {
    console.log(
      `  ⚠️  Could not run esbuild: ${e instanceof Error ? e.message : e}`,
    );
    try {
      await Deno.remove("_bundle_entry.ts");
    } catch { /* ignore */ }
  }

  // Size budget analysis
  console.log("\n📏 Size Budget Analysis (Brotli):\n");

  const budgets = [
    { name: "Ideal (< 5KB)", limit: 5 * 1024 },
    { name: "Good (< 10KB)", limit: 10 * 1024 },
    { name: "Acceptable (< 15KB)", limit: 15 * 1024 },
    { name: "Large (< 20KB)", limit: 20 * 1024 },
  ];

  for (const budget of budgets) {
    const status = totalBrotli <= budget.limit ? "✅" : "❌";
    console.log(
      `  ${status} ${budget.name}: ${formatBytes(totalBrotli)} / ${
        formatBytes(budget.limit)
      }`,
    );
  }

  // Top modules by size
  console.log("\n🏆 Largest Modules (by Brotli size):\n");

  const sorted = [...results].sort((a, b) => b.brotli - a.brotli);
  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    const m = sorted[i];
    const pct = ((m.brotli / totalBrotli) * 100).toFixed(1);
    console.log(
      `  ${i + 1}. ${m.name.padEnd(20)} ${
        formatBytes(m.brotli).padStart(10)
      } (${pct}%)`,
    );
  }

  // Save report
  const report: BundleReport = {
    modules: results,
    total: {
      raw: totalRaw,
      gzipped: totalGzipped,
      brotli: totalBrotli,
      lines: totalLines,
    },
    timestamp: new Date().toISOString(),
  };

  await Deno.writeTextFile(
    "bundle-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log("\n💾 Report saved to bundle-report.json\n");

  console.log("=".repeat(70));
}

main();

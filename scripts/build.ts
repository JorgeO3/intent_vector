#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * @file scripts/build.ts
 * @description Genera bundles de producción para cada entry point
 *
 * Produce:
 * - dist/intent-vector.min.js       (full bundle)
 * - dist/intent-vector.core.min.js  (core only)
 * - dist/intent-vector.std.min.js   (standard)
 * - Versiones .gz y .br de cada uno
 * - Metafile para análisis
 */

import { brotli, gzip } from "@deno-library/compress";

const DIST_DIR = "dist";

const BUNDLES = [
  { name: "intent-vector", entry: "mod.ts", description: "Full bundle" },
  {
    name: "intent-vector.core",
    entry: "mod.core.ts",
    description: "Core only",
  },
  {
    name: "intent-vector.std",
    entry: "mod.standard.ts",
    description: "Standard",
  },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  }
}

async function buildBundle(
  entry: string,
  outfile: string,
  metafile: string,
): Promise<boolean> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "npm:esbuild",
      entry,
      "--bundle",
      "--minify",
      "--format=esm",
      "--target=es2022",
      "--tree-shaking=true",
      "--drop:debugger",
      `--outfile=${outfile}`,
      `--metafile=${metafile}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await cmd.output();

  if (code !== 0) {
    console.error(`  ❌ Build failed: ${new TextDecoder().decode(stderr)}`);
    return false;
  }

  return true;
}

async function compressFile(
  path: string,
): Promise<{ gzSize: number; brSize: number }> {
  const content = await Deno.readFile(path);

  const gzipped = gzip(content);
  const brotlied = brotli.compressSync(content);

  await Deno.writeFile(`${path}.gz`, gzipped);
  await Deno.writeFile(`${path}.br`, brotlied);

  return { gzSize: gzipped.length, brSize: brotlied.length };
}

interface BundleResult {
  name: string;
  description: string;
  raw: number;
  gzip: number;
  brotli: number;
}

async function main() {
  console.log("\n🔨 Intent Vector - Production Build\n");
  console.log("=".repeat(60));

  await ensureDir(DIST_DIR);

  const results: BundleResult[] = [];

  for (const bundle of BUNDLES) {
    const outfile = `${DIST_DIR}/${bundle.name}.min.js`;
    const metafile = `${DIST_DIR}/${bundle.name}.meta.json`;

    console.log(`\n📦 Building ${bundle.description}...`);
    console.log(`   Entry: ${bundle.entry}`);

    const success = await buildBundle(bundle.entry, outfile, metafile);

    if (!success) {
      console.log(`   ❌ Failed to build ${bundle.name}`);
      continue;
    }

    const stat = await Deno.stat(outfile);
    const { gzSize, brSize } = await compressFile(outfile);

    results.push({
      name: bundle.name,
      description: bundle.description,
      raw: stat.size,
      gzip: gzSize,
      brotli: brSize,
    });

    console.log(`   ✅ ${outfile}`);
    console.log(`      Raw:    ${formatBytes(stat.size)}`);
    console.log(`      Gzip:   ${formatBytes(gzSize)}`);
    console.log(`      Brotli: ${formatBytes(brSize)}`);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("\n📊 Build Summary:\n");
  console.log(
    "Bundle".padEnd(25) +
      "Raw".padStart(10) +
      "Gzip".padStart(10) +
      "Brotli".padStart(10),
  );
  console.log("-".repeat(55));

  for (const r of results) {
    console.log(
      r.name.padEnd(25) +
        formatBytes(r.raw).padStart(10) +
        formatBytes(r.gzip).padStart(10) +
        formatBytes(r.brotli).padStart(10),
    );
  }

  // Budget check
  console.log("\n📏 Size Budget Check:\n");

  const budgets: Record<string, number> = {
    "intent-vector.core": 5 * 1024,
    "intent-vector.std": 7 * 1024,
    "intent-vector": 15 * 1024,
  };

  for (const r of results) {
    const limit = budgets[r.name];
    if (limit) {
      const status = r.brotli <= limit ? "✅" : "❌";
      console.log(
        `  ${status} ${r.name}: ${formatBytes(r.brotli)} / ${
          formatBytes(limit)
        }`,
      );
    }
  }

  // Write manifest
  const manifest = {
    version: "1.0.0",
    buildTime: new Date().toISOString(),
    bundles: results,
  };

  await Deno.writeTextFile(
    `${DIST_DIR}/manifest.json`,
    JSON.stringify(manifest, null, 2),
  );

  console.log(`\n💾 Manifest saved to ${DIST_DIR}/manifest.json`);
  console.log("\n" + "=".repeat(60) + "\n");
}

main();

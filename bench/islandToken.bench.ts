/**
 * @file bench/islandToken.bench.ts
 * @description Benchmarks para encoding/decoding de tokens de isla
 */

import {
  decodeIslandToken,
  encodeIslandToken,
} from "../runtime/islandToken.ts";

// Pre-generate test data
const prodTokens: string[] = [];
const debugTokens: string[] = [];

for (let i = 1; i <= 1000; i++) {
  prodTokens.push(encodeIslandToken(i, i * 100, i % 255));
  debugTokens.push(`t=${i},p=${i * 100},f=${i % 255}`);
}

let counter = 0;

Deno.bench({
  name: "islandToken: encodeIslandToken()",
  fn() {
    encodeIslandToken(
      (counter % 4095) + 1,
      counter % 1048575,
      counter % 255,
    );
    counter++;
  },
});

Deno.bench({
  name: "islandToken: decodeIslandToken() prod format",
  fn() {
    decodeIslandToken(prodTokens[counter % prodTokens.length]);
    counter++;
  },
});

Deno.bench({
  name: "islandToken: decodeIslandToken() debug format",
  fn() {
    decodeIslandToken(debugTokens[counter % debugTokens.length]);
    counter++;
  },
});

Deno.bench({
  name: "islandToken: encode + decode round-trip",
  fn() {
    const token = encodeIslandToken(
      (counter % 4095) + 1,
      counter % 1048575,
      counter % 255,
    );
    decodeIslandToken(token);
    counter++;
  },
});

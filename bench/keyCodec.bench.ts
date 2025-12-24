/**
 * @file bench/keyCodec.bench.ts
 * @description Benchmarks para el sistema de codificación de 40 bits
 */

import { decodeKey, encodeKey, parseIslandKey } from "../runtime/keyCodec.ts";
import type { IslandKey } from "../runtime/types.ts";

// Pre-generate test data
const testKeys: IslandKey[] = [];
const testStrings: string[] = [];
for (let i = 0; i < 1000; i++) {
  const key = encodeKey(
    (i % 4095) + 1,
    i * 17 % 1048575,
    i % 255,
  );
  if (key !== 0) {
    testKeys.push(key);
    testStrings.push((key as number).toString(36));
  }
}

let counter = 0;

Deno.bench({
  name: "keyCodec: encodeKey()",
  fn() {
    encodeKey(
      (counter % 4095) + 1,
      counter % 1048575,
      counter % 255,
    );
    counter++;
  },
});

Deno.bench({
  name: "keyCodec: decodeKey()",
  fn() {
    decodeKey(testKeys[counter % testKeys.length]);
    counter++;
  },
});

Deno.bench({
  name: "keyCodec: parseIslandKey() base-36",
  fn() {
    parseIslandKey(testStrings[counter % testStrings.length]);
    counter++;
  },
});

Deno.bench({
  name: "keyCodec: encode + decode round-trip",
  fn() {
    const key = encodeKey(
      (counter % 4095) + 1,
      counter % 1048575,
      counter % 255,
    );
    decodeKey(key);
    counter++;
  },
});

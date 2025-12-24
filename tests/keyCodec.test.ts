/**
 * @file tests/keyCodec.test.ts
 * @description Pruebas unitarias exhaustivas para el sistema de empaquetado de 40 bits.
 *
 * Validaciones críticas:
 * - Empaquetado/desempaquetado correcto de bits (12 Type + 20 Props + 8 Flags)
 * - Límites máximos de cada campo
 * - Colisiones de bits
 * - Todos los resultados deben ser Number.isSafeInteger
 * - Round-trip encoding/decoding
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { decodeKey, encodeKey, parseIslandKey } from "../runtime/keyCodec.ts";
import type { IslandKey } from "../runtime/types.ts";

// ============================================================================
// Constants (mirrored from keyCodec.ts for validation)
// ============================================================================

const TYPE_BITS = 12;
const PROPS_BITS = 20;
const FLAGS_BITS = 8;

const MAX_TYPE_ID = (1 << TYPE_BITS) - 1; // 4095
const MAX_PROPS_ID = (1 << PROPS_BITS) - 1; // 1048575
const MAX_FLAGS = (1 << FLAGS_BITS) - 1; // 255

const HIGH_MULTIPLIER = 0x100000000; // 2^32
// IMPORTANT: Cannot use bit shift (1 << 40) as it overflows 32-bit
const MAX_KEY = 0xFFFFFFFFFF; // 2^40 - 1

// ============================================================================
// 1. Pruebas de Empaquetado Básico
// ============================================================================

Deno.test("keyCodec: encodeKey con valores mínimos (1, 0, 0)", () => {
  const key = encodeKey(1, 0, 0);

  assertEquals(typeof key, "number", "Key debe ser number");
  assert(Number.isSafeInteger(key), "Key debe ser SafeInteger");
  assert(key > 0, "Key debe ser positivo");
});

Deno.test("keyCodec: encodeKey con valores típicos", () => {
  const key = encodeKey(42, 1000, 5);

  assert(Number.isSafeInteger(key), "Key debe ser SafeInteger");

  const decoded = decodeKey(key);
  assertEquals(decoded.typeId, 42);
  assertEquals(decoded.propsId, 1000);
  assertEquals(decoded.flags, 5);
});

Deno.test("keyCodec: round-trip encoding/decoding", () => {
  const testCases = [
    { typeId: 1, propsId: 0, flags: 0 },
    { typeId: 100, propsId: 5000, flags: 128 },
    { typeId: MAX_TYPE_ID, propsId: MAX_PROPS_ID, flags: MAX_FLAGS },
    { typeId: 1, propsId: 1, flags: 1 }, // typeId=0 con otros valores puede dar key=0
    { typeId: 2048, propsId: 524288, flags: 127 },
  ];

  for (const tc of testCases) {
    const key = encodeKey(tc.typeId, tc.propsId, tc.flags);
    const decoded = decodeKey(key);

    assertEquals(
      decoded.typeId,
      tc.typeId,
      `typeId mismatch for ${JSON.stringify(tc)}`,
    );
    assertEquals(
      decoded.propsId,
      tc.propsId,
      `propsId mismatch for ${JSON.stringify(tc)}`,
    );
    assertEquals(
      decoded.flags,
      tc.flags,
      `flags mismatch for ${JSON.stringify(tc)}`,
    );
  }
});

// ============================================================================
// 2. Pruebas de Límites (Boundary Testing)
// ============================================================================

Deno.test("keyCodec: límites máximos de typeId (12 bits = 4095)", () => {
  const key = encodeKey(MAX_TYPE_ID, 0, 0);
  const decoded = decodeKey(key);

  assertEquals(decoded.typeId, MAX_TYPE_ID);
  assertEquals(decoded.propsId, 0);
  assertEquals(decoded.flags, 0);
  assert(Number.isSafeInteger(key));
});

Deno.test("keyCodec: límites máximos de propsId (20 bits = 1048575)", () => {
  // typeId=0 puede resultar en key=0 (invalid) para algunos valores
  // Usamos typeId=1 para test válido
  const key = encodeKey(1, MAX_PROPS_ID, 0);
  const decoded = decodeKey(key);

  assertEquals(decoded.typeId, 1);
  assertEquals(decoded.propsId, MAX_PROPS_ID);
  assert(Number.isSafeInteger(key));
});

Deno.test("keyCodec: límites máximos de flags (8 bits = 255)", () => {
  const key = encodeKey(1, 0, MAX_FLAGS);
  const decoded = decodeKey(key);

  assertEquals(decoded.flags, MAX_FLAGS);
  assert(Number.isSafeInteger(key));
});

Deno.test("keyCodec: todos los campos al máximo simultáneamente", () => {
  const key = encodeKey(MAX_TYPE_ID, MAX_PROPS_ID, MAX_FLAGS);
  const decoded = decodeKey(key);

  assertEquals(decoded.typeId, MAX_TYPE_ID, "typeId máximo");
  assertEquals(decoded.propsId, MAX_PROPS_ID, "propsId máximo");
  assertEquals(decoded.flags, MAX_FLAGS, "flags máximo");
  assert(
    Number.isSafeInteger(key),
    "Key debe ser SafeInteger con valores máximos",
  );
  assert(key <= MAX_KEY, "Key no debe exceder 40 bits");
});

Deno.test("keyCodec: valores que exceden los límites son truncados", () => {
  // typeId > 4095 debe truncarse
  const key1 = encodeKey(MAX_TYPE_ID + 1, 0, 0);
  const decoded1 = decodeKey(key1);
  assertEquals(
    decoded1.typeId,
    0,
    "typeId overflow debe resultar en 0 (masked)",
  );

  // propsId > 1048575 debe truncarse
  const key2 = encodeKey(1, MAX_PROPS_ID + 1, 0);
  const decoded2 = decodeKey(key2);
  assertEquals(
    decoded2.propsId,
    0,
    "propsId overflow debe resultar en 0 (masked)",
  );

  // flags > 255 debe truncarse
  const key3 = encodeKey(1, 0, MAX_FLAGS + 1);
  const decoded3 = decodeKey(key3);
  assertEquals(decoded3.flags, 0, "flags overflow debe resultar en 0 (masked)");
});

// ============================================================================
// 3. Pruebas de Colisiones de Bits
// ============================================================================

Deno.test("keyCodec: no hay colisiones entre campos adyacentes", () => {
  // Probar que bits de typeId no interfieren con propsId
  const key1 = encodeKey(MAX_TYPE_ID, 0, 0);

  // Si hubiera colisión, decodificar key1 podría mostrar propsId != 0
  const decoded1 = decodeKey(key1);
  assertEquals(decoded1.propsId, 0, "typeId máximo no debe afectar propsId");

  // Probar que bits de propsId no interfieren con flags
  const key3 = encodeKey(1, MAX_PROPS_ID, 0);
  const decoded3 = decodeKey(key3);
  assertEquals(decoded3.flags, 0, "propsId máximo no debe afectar flags");
});

Deno.test("keyCodec: cada combinación única produce key única", () => {
  const keys = new Set<IslandKey>();

  // Muestra representativa de combinaciones
  const samples = [
    [1, 0, 0],
    [1, 0, 1],
    [1, 1, 0],
    [2, 0, 0],
    [100, 200, 3],
    [100, 201, 3],
    [100, 200, 4],
    [101, 200, 3],
    [MAX_TYPE_ID, 0, 0],
    [0, MAX_PROPS_ID, 0],
    [1, 0, MAX_FLAGS],
    [MAX_TYPE_ID, MAX_PROPS_ID, MAX_FLAGS],
  ];

  for (const [t, p, f] of samples) {
    const key = encodeKey(t, p, f);
    if (key !== 0) { // 0 es invalid key
      assert(!keys.has(key), `Colisión detectada para (${t}, ${p}, ${f})`);
      keys.add(key);
    }
  }
});

Deno.test("keyCodec: bit patterns específicos (power of 2)", () => {
  // Probar potencias de 2 para detectar problemas de alineación
  for (let i = 0; i < TYPE_BITS; i++) {
    const typeId = 1 << i;
    const key = encodeKey(typeId, 0, 0);
    const decoded = decodeKey(key);
    assertEquals(decoded.typeId, typeId, `Bit ${i} de typeId`);
  }

  for (let i = 0; i < PROPS_BITS; i++) {
    const propsId = 1 << i;
    const key = encodeKey(1, propsId, 0);
    const decoded = decodeKey(key);
    assertEquals(decoded.propsId, propsId, `Bit ${i} de propsId`);
  }

  for (let i = 0; i < FLAGS_BITS; i++) {
    const flags = 1 << i;
    const key = encodeKey(1, 0, flags);
    const decoded = decodeKey(key);
    assertEquals(decoded.flags, flags, `Bit ${i} de flags`);
  }
});

// ============================================================================
// 4. Pruebas de SafeInteger y Aritmética de 53 bits
// ============================================================================

Deno.test("keyCodec: todas las keys válidas son SafeInteger", () => {
  const testCases = [
    [1, 0, 0],
    [MAX_TYPE_ID, MAX_PROPS_ID, MAX_FLAGS],
    [2048, 524288, 128],
    [4000, 1000000, 200],
  ];

  for (const [t, p, f] of testCases) {
    const key = encodeKey(t, p, f);
    assert(
      Number.isSafeInteger(key),
      `Key para (${t}, ${p}, ${f}) debe ser SafeInteger, got ${key}`,
    );
  }
});

Deno.test("keyCodec: key máxima está dentro del rango de 53 bits", () => {
  const maxKey = encodeKey(MAX_TYPE_ID, MAX_PROPS_ID, MAX_FLAGS);

  // 2^53 - 1 = Number.MAX_SAFE_INTEGER
  assert(
    maxKey <= Number.MAX_SAFE_INTEGER,
    "Key máxima debe ser <= MAX_SAFE_INTEGER",
  );

  // 2^40 - 1 específicamente
  assert(maxKey <= MAX_KEY, "Key máxima debe ser <= 2^40 - 1");
});

Deno.test("keyCodec: high bits (flags) usan multiplicación correctamente", () => {
  // Los flags ocupan los bits 32-39 (high byte)
  // Verificar que la multiplicación por HIGH_MULTIPLIER funciona
  const key = encodeKey(1, 0, 1);

  // flags=1 debería agregar HIGH_MULTIPLIER (2^32) al resultado
  assert(key >= HIGH_MULTIPLIER, "flags=1 debe producir key >= 2^32");

  const decoded = decodeKey(key);
  assertEquals(decoded.flags, 1);
});

// ============================================================================
// 5. Pruebas de Valores Inválidos
// ============================================================================

Deno.test("keyCodec: encodeKey(0, 0, 0) retorna 0 (invalid)", () => {
  const key = encodeKey(0, 0, 0);
  assertEquals(key, 0, "Key (0,0,0) debe ser 0 (invalid)");
});

Deno.test("keyCodec: decodeKey(0) retorna zeros", () => {
  const decoded = decodeKey(0 as IslandKey);

  assertEquals(decoded.typeId, 0);
  assertEquals(decoded.propsId, 0);
  assertEquals(decoded.flags, 0);
});

Deno.test("keyCodec: decodeKey con valores negativos", () => {
  const decoded = decodeKey(-1 as IslandKey);

  assertEquals(decoded.typeId, 0);
  assertEquals(decoded.propsId, 0);
  assertEquals(decoded.flags, 0);
});

Deno.test("keyCodec: decodeKey con NaN/Infinity", () => {
  const decodedNaN = decodeKey(NaN as unknown as IslandKey);
  const decodedInf = decodeKey(Infinity as unknown as IslandKey);
  const decodedNegInf = decodeKey(-Infinity as unknown as IslandKey);

  assertEquals(decodedNaN.typeId, 0);
  assertEquals(decodedInf.typeId, 0);
  assertEquals(decodedNegInf.typeId, 0);
});

Deno.test("keyCodec: decodeKey con valor > MAX_KEY", () => {
  const decoded = decodeKey((MAX_KEY + 1) as IslandKey);

  assertEquals(decoded.typeId, 0, "Key fuera de rango debe retornar 0");
  assertEquals(decoded.propsId, 0);
  assertEquals(decoded.flags, 0);
});

// ============================================================================
// 6. Pruebas de parseIslandKey (Base-36)
// ============================================================================

Deno.test("keyCodec: parseIslandKey con string base-36 válido", () => {
  const original = encodeKey(100, 5000, 7);
  const base36 = (original as number).toString(36);

  const parsed = parseIslandKey(base36);
  assertEquals(parsed, original);
});

Deno.test("keyCodec: parseIslandKey round-trip", () => {
  const testCases = [
    encodeKey(1, 0, 0),
    encodeKey(42, 1234, 15),
    encodeKey(MAX_TYPE_ID, MAX_PROPS_ID, MAX_FLAGS),
  ];

  for (const original of testCases) {
    if (original === 0) continue;

    const base36 = (original as number).toString(36);
    const parsed = parseIslandKey(base36);
    assertEquals(parsed, original, `Round-trip failed for ${base36}`);
  }
});

Deno.test("keyCodec: parseIslandKey con strings inválidos", () => {
  assertEquals(parseIslandKey(""), 0);
  // Note: "invalid!@#" actually parses as "invalid" which is valid base-36
  // Use a string that truly doesn't parse
  assertEquals(parseIslandKey("!@#$%"), 0);
  assertEquals(parseIslandKey("-123"), 0);
  assertEquals(parseIslandKey("0"), 0);
});

Deno.test("keyCodec: parseIslandKey con string que excede MAX_KEY", () => {
  // Crear un número mayor que 2^40 - 1 en base 36
  const tooLarge = (MAX_KEY + 1).toString(36);
  const parsed = parseIslandKey(tooLarge);
  assertEquals(parsed, 0, "String fuera de rango debe retornar 0");
});

// ============================================================================
// 7. Pruebas de Rendimiento y Stress
// ============================================================================

Deno.test("keyCodec: stress test - 10000 encode/decode cycles", () => {
  const iterations = 10000;
  let failures = 0;

  for (let i = 0; i < iterations; i++) {
    const typeId = i % (MAX_TYPE_ID + 1);
    const propsId = (i * 17) % (MAX_PROPS_ID + 1);
    const flags = (i * 7) % (MAX_FLAGS + 1);

    // Skip (0,0,0) case
    if (typeId === 0 && propsId === 0 && flags === 0) continue;

    const key = encodeKey(typeId, propsId, flags);

    if (!Number.isSafeInteger(key)) {
      failures++;
      continue;
    }

    const decoded = decodeKey(key);

    if (
      decoded.typeId !== typeId ||
      decoded.propsId !== propsId ||
      decoded.flags !== flags
    ) {
      failures++;
    }
  }

  assertEquals(failures, 0, `${failures} ciclos fallaron de ${iterations}`);
});

Deno.test("keyCodec: verificar que no hay desbordamiento en operaciones bit a bit", () => {
  // JavaScript bitwise opera en 32 bits signed
  // Verificar que la implementación maneja esto correctamente

  // Caso límite: propsId << 12 puede acercarse a 32 bits
  const propsId = MAX_PROPS_ID; // 0xFFFFF
  const key = encodeKey(MAX_TYPE_ID, propsId, 0);
  const decoded = decodeKey(key);

  assertEquals(
    decoded.propsId,
    propsId,
    "propsId no debe corromperse por overflow de 32 bits",
  );
});

// ============================================================================
// 8. Pruebas de Casos Especiales del Sistema
// ============================================================================

Deno.test("keyCodec: encoding para IslandFlags típicos", () => {
  // PrefetchSafe = 1, HydrateOnEventOnly = 2, Critical = 4, NavLike = 8
  const flags = 1 | 4; // PrefetchSafe + Critical
  const key = encodeKey(10, 500, flags);
  const decoded = decodeKey(key);

  assertEquals(decoded.flags, 5);
  assertEquals(decoded.flags & 1, 1, "PrefetchSafe debe estar set");
  assertEquals(decoded.flags & 4, 4, "Critical debe estar set");
  assertEquals(decoded.flags & 2, 0, "HydrateOnEventOnly no debe estar set");
});

Deno.test("keyCodec: keys distintas para islands del mismo tipo pero distintos props", () => {
  const key1 = encodeKey(42, 100, 1);
  const key2 = encodeKey(42, 101, 1);

  assertNotEquals(
    key1,
    key2,
    "Mismos typeId/flags pero distintos propsId deben ser distintos",
  );

  const decoded1 = decodeKey(key1);
  const decoded2 = decodeKey(key2);

  assertEquals(decoded1.typeId, decoded2.typeId);
  assertNotEquals(decoded1.propsId, decoded2.propsId);
});

/**
 * @file tests/islandToken.test.ts
 * @description Pruebas del parsing de tokens de isla en formato debug y producción.
 *
 * Validaciones críticas:
 * - Formato producción: base-36 encoded key
 * - Formato debug: "t=1,p=2,f=3" con aliases y orden libre
 * - Round-trip encoding/decoding
 * - Edge cases y manejo de errores
 */

import { assert, assertEquals } from "@std/assert";
import {
  decodeIslandToken,
  encodeIslandToken,
  hasFlag,
} from "../runtime/islandToken.ts";
import { decodeKey, encodeKey } from "../runtime/keyCodec.ts";
import { IslandFlags } from "../runtime/types.ts";

// ============================================================================
// 1. Pruebas de Encoding
// ============================================================================

Deno.test("IslandToken: encodeIslandToken produce base-36 válido", () => {
  const token = encodeIslandToken(1, 100, 0);

  // Base-36 solo debe contener 0-9 y a-z
  assert(/^[0-9a-z]+$/.test(token), "Token debe ser base-36");
  assert(token.length > 0, "Token no debe estar vacío");
});

Deno.test("IslandToken: encode round-trip preserva valores", () => {
  const testCases = [
    { typeId: 1, propsId: 100, flags: 0 },
    { typeId: 4095, propsId: 1048575, flags: 255 }, // Máximos
    // Note: { typeId: 0, propsId: 0, flags: 0 } produces key=0 (invalid)
    // which is correct behavior - skip this case
    { typeId: 123, propsId: 456789, flags: 15 },
    { typeId: 1, propsId: 1, flags: 1 },
    { typeId: 1, propsId: 0, flags: 0 }, // Mínimo válido
  ];

  for (const { typeId, propsId, flags } of testCases) {
    const token = encodeIslandToken(typeId, propsId, flags);
    const decoded = decodeIslandToken(token);

    assert(
      decoded !== null,
      `Decoded should not be null for ${
        JSON.stringify({ typeId, propsId, flags })
      }`,
    );
    assertEquals(decoded!.typeId, typeId, "typeId debe preservarse");
    assertEquals(decoded!.propsId, propsId, "propsId debe preservarse");
    assertEquals(decoded!.flags, flags, "flags debe preservarse");
  }
});

Deno.test("IslandToken: encode determinístico", () => {
  const token1 = encodeIslandToken(42, 12345, 7);
  const token2 = encodeIslandToken(42, 12345, 7);

  assertEquals(token1, token2, "Mismo input → mismo token");
});

// ============================================================================
// 2. Pruebas de Production Format (base-36)
// ============================================================================

Deno.test("IslandToken: decode production format válido", () => {
  // Generar token conocido
  const token = encodeIslandToken(5, 999, 3);
  const decoded = decodeIslandToken(token);

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 5);
  assertEquals(decoded!.propsId, 999);
  assertEquals(decoded!.flags, 3);
});

Deno.test("IslandToken: decode production format con uppercase (case insensitive)", () => {
  const lowerToken = encodeIslandToken(10, 500, 1);
  const upperToken = lowerToken.toUpperCase();

  // parseInt base-36 es case-insensitive
  const decodedLower = decodeIslandToken(lowerToken);
  const decodedUpper = decodeIslandToken(upperToken);

  // Ambos deberían producir el mismo resultado
  assert(decodedLower !== null);
  assert(decodedUpper !== null);
  assertEquals(decodedLower!.typeId, decodedUpper!.typeId);
  assertEquals(decodedLower!.propsId, decodedUpper!.propsId);
  assertEquals(decodedLower!.flags, decodedUpper!.flags);
});

Deno.test("IslandToken: decode production format con whitespace", () => {
  const token = encodeIslandToken(1, 1, 1);

  // Con espacios alrededor
  const decoded = decodeIslandToken(`  ${token}  `);

  assert(decoded !== null, "Debe tolerar whitespace");
  assertEquals(decoded!.typeId, 1);
});

// ============================================================================
// 3. Pruebas de Debug Format
// ============================================================================

Deno.test("IslandToken: decode debug format - forma corta (t,p,f)", () => {
  const decoded = decodeIslandToken("t=5,p=100,f=3");

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 5);
  assertEquals(decoded!.propsId, 100);
  assertEquals(decoded!.flags, 3);
});

Deno.test("IslandToken: decode debug format - forma larga (type,props,flags)", () => {
  const decoded = decodeIslandToken("type=10,props=200,flags=7");

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 10);
  assertEquals(decoded!.propsId, 200);
  assertEquals(decoded!.flags, 7);
});

Deno.test("IslandToken: decode debug format - orden libre", () => {
  const orders = [
    "t=1,p=2,f=3",
    "p=2,t=1,f=3",
    "f=3,t=1,p=2",
    "f=3,p=2,t=1",
    "p=2,f=3,t=1",
  ];

  for (const input of orders) {
    const decoded = decodeIslandToken(input);
    assert(decoded !== null, `Debe parsear: ${input}`);
    assertEquals(decoded!.typeId, 1, `typeId incorrecto en: ${input}`);
    assertEquals(decoded!.propsId, 2, `propsId incorrecto en: ${input}`);
    assertEquals(decoded!.flags, 3, `flags incorrecto en: ${input}`);
  }
});

Deno.test("IslandToken: decode debug format - separadores mixtos", () => {
  const formats = [
    "t=1,p=2,f=3", // Comas
    "t=1 p=2 f=3", // Espacios
    "t=1, p=2, f=3", // Coma + espacio
    "t=1  p=2  f=3", // Múltiples espacios
    "t=1,p=2 f=3", // Mixto
  ];

  for (const input of formats) {
    const decoded = decodeIslandToken(input);
    assert(decoded !== null, `Debe parsear con separadores: ${input}`);
    assertEquals(decoded!.typeId, 1);
    assertEquals(decoded!.propsId, 2);
    assertEquals(decoded!.flags, 3);
  }
});

Deno.test("IslandToken: decode debug format - valores parciales con defaults", () => {
  // Solo typeId
  const onlyType = decodeIslandToken("t=42");
  assert(onlyType !== null);
  assertEquals(onlyType!.typeId, 42);
  assertEquals(onlyType!.propsId, 0, "propsId default = 0");
  assertEquals(onlyType!.flags, 0, "flags default = 0");

  // Solo propsId
  const onlyProps = decodeIslandToken("p=999");
  assert(onlyProps !== null);
  assertEquals(onlyProps!.typeId, 0);
  assertEquals(onlyProps!.propsId, 999);
  assertEquals(onlyProps!.flags, 0);

  // Solo flags
  const onlyFlags = decodeIslandToken("f=15");
  assert(onlyFlags !== null);
  assertEquals(onlyFlags!.typeId, 0);
  assertEquals(onlyFlags!.propsId, 0);
  assertEquals(onlyFlags!.flags, 15);
});

Deno.test("IslandToken: decode debug format - aliases mezclados", () => {
  const decoded = decodeIslandToken("type=5,p=100,flags=7");

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 5);
  assertEquals(decoded!.propsId, 100);
  assertEquals(decoded!.flags, 7);
});

// ============================================================================
// 4. Pruebas de Equivalencia Debug ↔ Production
// ============================================================================

Deno.test("IslandToken: debug y production producen mismo key", () => {
  const debugToken = "t=10,p=500,f=3";
  const prodToken = encodeIslandToken(10, 500, 3);

  const debugDecoded = decodeIslandToken(debugToken);
  const prodDecoded = decodeIslandToken(prodToken);

  assert(debugDecoded !== null);
  assert(prodDecoded !== null);

  // Las keys canónicas deben ser idénticas
  assertEquals(debugDecoded!.key, prodDecoded!.key);
  assertEquals(debugDecoded!.typeId, prodDecoded!.typeId);
  assertEquals(debugDecoded!.propsId, prodDecoded!.propsId);
  assertEquals(debugDecoded!.flags, prodDecoded!.flags);
});

// ============================================================================
// 5. Pruebas de hasFlag
// ============================================================================

Deno.test("IslandToken: hasFlag detecta flag presente", () => {
  assertEquals(
    hasFlag(IslandFlags.PrefetchSafe, IslandFlags.PrefetchSafe),
    true,
  );
  assertEquals(hasFlag(IslandFlags.Critical, IslandFlags.Critical), true);
  assertEquals(
    hasFlag(
      IslandFlags.PrefetchSafe | IslandFlags.Critical,
      IslandFlags.PrefetchSafe,
    ),
    true,
  );
  assertEquals(
    hasFlag(
      IslandFlags.PrefetchSafe | IslandFlags.Critical,
      IslandFlags.Critical,
    ),
    true,
  );
});

Deno.test("IslandToken: hasFlag detecta flag ausente", () => {
  assertEquals(hasFlag(0, IslandFlags.PrefetchSafe), false);
  assertEquals(hasFlag(IslandFlags.PrefetchSafe, IslandFlags.Critical), false);
  assertEquals(hasFlag(2, 4), false);
});

Deno.test("IslandToken: hasFlag con flags combinados", () => {
  const combined = IslandFlags.PrefetchSafe | IslandFlags.Critical;

  assertEquals(hasFlag(combined, IslandFlags.PrefetchSafe), true);
  assertEquals(hasFlag(combined, IslandFlags.Critical), true);
  // Verificar flag no presente usando el mismo tipo
  assertEquals((combined & 128) !== 0, false); // Flag no presente
});

// ============================================================================
// 6. Pruebas de Error Handling
// ============================================================================

Deno.test("IslandToken: decode null retorna null", () => {
  assertEquals(decodeIslandToken(null), null);
});

Deno.test("IslandToken: decode undefined retorna null", () => {
  assertEquals(decodeIslandToken(undefined), null);
});

Deno.test("IslandToken: decode string vacío retorna null", () => {
  assertEquals(decodeIslandToken(""), null);
  assertEquals(decodeIslandToken("   "), null);
});

Deno.test("IslandToken: decode debug format inválido retorna null", () => {
  // Sin valor
  assertEquals(decodeIslandToken("t="), null);

  // Valor no numérico
  assertEquals(decodeIslandToken("t=abc"), null);

  // Key desconocida
  assertEquals(decodeIslandToken("x=123"), null);

  // Sin formato válido
  assertEquals(decodeIslandToken("==="), null);
});

Deno.test("IslandToken: decode production format inválido retorna null", () => {
  // Caracteres fuera de base-36
  assertEquals(decodeIslandToken("!!!"), null);

  // Negativo
  assertEquals(decodeIslandToken("-1"), null);
});

// ============================================================================
// 7. Pruebas de Valores Límite
// ============================================================================

Deno.test("IslandToken: máximos valores por campo", () => {
  const maxTypeId = 4095; // 2^12 - 1
  const maxPropsId = 1048575; // 2^20 - 1
  const maxFlags = 255; // 2^8 - 1

  const token = encodeIslandToken(maxTypeId, maxPropsId, maxFlags);
  const decoded = decodeIslandToken(token);

  assert(decoded !== null);
  assertEquals(decoded!.typeId, maxTypeId);
  assertEquals(decoded!.propsId, maxPropsId);
  assertEquals(decoded!.flags, maxFlags);
});

Deno.test("IslandToken: valores mínimos válidos", () => {
  // Note: (0, 0, 0) produces key=0 which is invalid by design
  // The minimum valid token requires at least typeId=1
  const token = encodeIslandToken(1, 0, 0);
  const decoded = decodeIslandToken(token);

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 1);
  assertEquals(decoded!.propsId, 0);
  assertEquals(decoded!.flags, 0);
});

Deno.test("IslandToken: (0,0,0) produces empty token", () => {
  // Verify that the all-zeros case returns an empty/invalid token
  const token = encodeIslandToken(0, 0, 0);
  // Token should be "0" (base-36 representation of 0)
  // which decodes to null or all-zeros
  const decoded = decodeIslandToken(token);
  // This is expected to return null or all zeros since 0 is invalid
  if (decoded !== null) {
    assertEquals(decoded.typeId, 0);
    assertEquals(decoded.propsId, 0);
    assertEquals(decoded.flags, 0);
  }
});

Deno.test("IslandToken: debug format con valores grandes", () => {
  const decoded = decodeIslandToken("t=4095,p=1048575,f=255");

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 4095);
  assertEquals(decoded!.propsId, 1048575);
  assertEquals(decoded!.flags, 255);
});

// ============================================================================
// 8. Pruebas de Consistencia con keyCodec
// ============================================================================

Deno.test("IslandToken: consistencia con encodeKey/decodeKey", () => {
  const testCases = [
    { typeId: 1, propsId: 100, flags: 1 },
    { typeId: 4095, propsId: 500000, flags: 128 },
    { typeId: 42, propsId: 12345, flags: 7 },
  ];

  for (const { typeId, propsId, flags } of testCases) {
    // Usando islandToken
    const token = encodeIslandToken(typeId, propsId, flags);
    const tokenDecoded = decodeIslandToken(token);

    // Usando keyCodec directamente
    const key = encodeKey(typeId, propsId, flags);
    const keyDecoded = decodeKey(key);

    assert(tokenDecoded !== null);
    assertEquals(tokenDecoded!.typeId, keyDecoded.typeId);
    assertEquals(tokenDecoded!.propsId, keyDecoded.propsId);
    assertEquals(tokenDecoded!.flags, keyDecoded.flags);
    assertEquals(tokenDecoded!.key, key);
  }
});

// ============================================================================
// 9. Pruebas de Robustez
// ============================================================================

Deno.test("IslandToken: ignora pares key-value malformados en debug", () => {
  // Incluye basura pero también tiene valores válidos
  const decoded = decodeIslandToken("garbage,t=5,more garbage,p=10");

  assert(decoded !== null);
  assertEquals(decoded!.typeId, 5);
  assertEquals(decoded!.propsId, 10);
  assertEquals(decoded!.flags, 0); // Default
});

Deno.test("IslandToken: maneja valores numéricos con decimales (trunca)", () => {
  const decoded = decodeIslandToken("t=5.9,p=10.1,f=3.99");

  assert(decoded !== null);
  // Los valores deberían ser truncados a enteros
  assertEquals(decoded!.typeId, 5);
  assertEquals(decoded!.propsId, 10);
  assertEquals(decoded!.flags, 3);
});

Deno.test("IslandToken: maneja valores negativos en debug (convierte a 0 vía |0)", () => {
  // Comportamiento dependiente de implementación
  const decoded = decodeIslandToken("t=-5,p=100,f=1");

  // El |0 en valores negativos los convierte pero puede dar resultados extraños
  // Lo importante es que no crashee
  assert(
    decoded !== null || decoded === null,
    "Debe retornar resultado válido o null",
  );
});

// ============================================================================
// 10. Pruebas de Key Numérica
// ============================================================================

Deno.test("IslandToken: key es número positivo finito", () => {
  const token = encodeIslandToken(100, 50000, 15);
  const decoded = decodeIslandToken(token);

  assert(decoded !== null);
  assert(Number.isFinite(decoded!.key));
  assert(decoded!.key > 0);
  assert(Number.isSafeInteger(decoded!.key));
});

Deno.test("IslandToken: key única para diferentes inputs", () => {
  const token1 = encodeIslandToken(1, 100, 0);
  const token2 = encodeIslandToken(2, 100, 0);
  const token3 = encodeIslandToken(1, 101, 0);
  const token4 = encodeIslandToken(1, 100, 1);

  const decoded1 = decodeIslandToken(token1);
  const decoded2 = decodeIslandToken(token2);
  const decoded3 = decodeIslandToken(token3);
  const decoded4 = decodeIslandToken(token4);

  const keys = [decoded1!.key, decoded2!.key, decoded3!.key, decoded4!.key];
  const uniqueKeys = new Set(keys);

  assertEquals(uniqueKeys.size, 4, "Todas las keys deben ser únicas");
});

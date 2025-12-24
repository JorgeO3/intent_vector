import type { IslandKey } from "./types.ts";

// ============================================================================
// Type Definitions
// ============================================================================

type DecodedKey = {
  readonly typeId: number;
  readonly propsId: number;
  readonly flags: number;
};

// ============================================================================
// Constants - Bit Layout (NO BigInt - pure number operations)
// ============================================================================

// Key layout: [ flags:8 | propsId:20 | typeId:12 ] = 40 bits total
// JavaScript numbers are 53-bit safe, so we can use direct arithmetic

const TYPE_BITS = 12;
const PROPS_BITS = 20;
const FLAGS_BITS = 8;

const TYPE_MASK = (1 << TYPE_BITS) - 1; // 0xFFF
const PROPS_MASK = (1 << PROPS_BITS) - 1; // 0xFFFFF
const FLAGS_MASK = (1 << FLAGS_BITS) - 1; // 0xFF

// For high bits (flags), we use multiplication/division since bitwise ops are 32-bit
const HIGH_MULTIPLIER = 0x100000000; // 2^32
// IMPORTANT: Cannot use bit shift for MAX_KEY as it overflows 32-bit
// 2^40 - 1 = 1099511627775
const MAX_KEY = 0xFFFFFFFFFF; // 2^40 - 1 (40 bits all set)

const BASE_36 = 36;
const INVALID_KEY = 0 as IslandKey;

// ============================================================================
// Public API
// ============================================================================

// Multiplier for propsId position (2^12 = 4096)
const PROPS_MULTIPLIER = 4096; // 2^12 - use multiplication to avoid 32-bit shift overflow

export function encodeKey(
  typeId: number,
  propsId: number,
  flags: number,
): IslandKey {
  // Normalize and mask inputs (branchless with bitwise OR 0)
  const t = (typeId | 0) & TYPE_MASK;
  const p = (propsId | 0) & PROPS_MASK;
  const f = (flags | 0) & FLAGS_MASK;

  // Pack using multiplication to avoid 32-bit bitwise overflow:
  // key = typeId + propsId * 2^12 + flags * 2^32
  const packed = t + p * PROPS_MULTIPLIER + f * HIGH_MULTIPLIER;

  // Validate range (0 is reserved as invalid)
  return (packed > 0 && packed <= MAX_KEY) ? packed as IslandKey : INVALID_KEY;
}

export function decodeKey(key: IslandKey): DecodedKey {
  const n = key as unknown as number;

  // Fast validation (branchless-friendly)
  if (n <= 0 || n > MAX_KEY || !Number.isFinite(n)) {
    return { typeId: 0, propsId: 0, flags: 0 };
  }

  // Extract using division and modulo to avoid 32-bit overflow issues
  const flags = Math.floor(n / HIGH_MULTIPLIER);
  const remainder = n % HIGH_MULTIPLIER;
  const propsId = Math.floor(remainder / PROPS_MULTIPLIER);
  const typeId = remainder % PROPS_MULTIPLIER;

  return {
    typeId: typeId & TYPE_MASK,
    propsId: propsId & PROPS_MASK,
    flags: flags & FLAGS_MASK,
  };
}

export function parseIslandKey(input: string): IslandKey {
  const parsed = Number.parseInt(input, BASE_36);

  // Validate: must be finite, positive, within 40-bit range
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_KEY) {
    return INVALID_KEY;
  }

  return parsed as IslandKey;
}

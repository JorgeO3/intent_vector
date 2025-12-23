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
// Constants - Bit Layout
// ============================================================================

// Key layout: [ flags:8 | propsId:20 | typeId:12 ] = 40 bits total
const BIT_LAYOUT = {
  TYPE: 12n,
  PROPS: 20n,
  FLAGS: 8n,
} as const;

const BIT_MASKS = {
  TYPE: (1n << BIT_LAYOUT.TYPE) - 1n,
  PROPS: (1n << BIT_LAYOUT.PROPS) - 1n,
  FLAGS: (1n << BIT_LAYOUT.FLAGS) - 1n, // 0xffn
} as const;

const BIT_SHIFTS = {
  PROPS: BIT_LAYOUT.TYPE,
  FLAGS: BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS,
} as const;

const MAX_KEY_BIG =
  (1n << (BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS + BIT_LAYOUT.FLAGS)) - 1n; // 2^40-1
const MAX_KEY_NUM = Number(MAX_KEY_BIG);

const BASE_36 = 36;
const INVALID_KEY = 0 as IslandKey;

// ============================================================================
// Public API
// ============================================================================

export function encodeKey(
  typeId: number,
  propsId: number,
  flags: number,
): IslandKey {
  // Normalize inputs (avoid NaN/Infinity and floats)
  const t = normalizeNonNegInt(typeId);
  const p = normalizeNonNegInt(propsId);
  const f = normalizeNonNegInt(flags);

  const packed = (BigInt(t) & BIT_MASKS.TYPE) |
    ((BigInt(p) & BIT_MASKS.PROPS) << BIT_SHIFTS.PROPS) |
    ((BigInt(f) & BIT_MASKS.FLAGS) << BIT_SHIFTS.FLAGS);

  // 40-bit safe => always <= MAX_SAFE_INTEGER, but keep guard anyway
  if (packed <= 0n || packed > MAX_KEY_BIG) return INVALID_KEY;

  return Number(packed) as IslandKey;
}

export function decodeKey(key: IslandKey): DecodedKey {
  const n = key as unknown as number;

  // Make it non-throw and robust
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_KEY_NUM) {
    return { typeId: 0, propsId: 0, flags: 0 };
  }

  const packed = BigInt(n);

  const typeId = Number(packed & BIT_MASKS.TYPE);
  const propsId = Number((packed >> BIT_SHIFTS.PROPS) & BIT_MASKS.PROPS);
  const flags = Number((packed >> BIT_SHIFTS.FLAGS) & BIT_MASKS.FLAGS);

  return { typeId, propsId, flags };
}

export function parseIslandKey(input: string): IslandKey {
  const parsed = Number.parseInt(input, BASE_36);

  // Correct validity: must be safe integer within 40-bit range and > 0
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_KEY_NUM) {
    return INVALID_KEY;
  }

  return parsed as IslandKey;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function normalizeNonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const v = Math.trunc(value);
  return v < 0 ? 0 : v;
}

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
  FLAGS: 0xff,
} as const;

const BIT_SHIFTS = {
  PROPS: BIT_LAYOUT.TYPE,
  FLAGS: BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS,
} as const;

const BASE_36 = 36;
const INVALID_KEY = 0 as IslandKey;

// ============================================================================
// Public API
// ============================================================================

export function decodeKey(key: IslandKey): DecodedKey {
  const packed = BigInt(key);

  const typeId = extractTypeId(packed);
  const propsId = extractPropsId(packed);
  const flags = extractFlags(packed);

  return { typeId, propsId, flags };
}

export function parseIslandKey(input: string): IslandKey {
  const parsed = Number.parseInt(input, BASE_36);
  return isValidKey(parsed) ? (parsed as IslandKey) : INVALID_KEY;
}

// ============================================================================
// Internal Helpers - Bit Extraction
// ============================================================================

function extractTypeId(packed: bigint): number {
  return Number(packed & BIT_MASKS.TYPE);
}

function extractPropsId(packed: bigint): number {
  return Number((packed >> BIT_SHIFTS.PROPS) & BIT_MASKS.PROPS);
}

function extractFlags(packed: bigint): number {
  return Number(packed >> BIT_SHIFTS.FLAGS) & BIT_MASKS.FLAGS;
}

// ============================================================================
// Internal Helpers - Validation
// ============================================================================

function isValidKey(value: number): boolean {
  return Number.isFinite(value) && value !== 0;
}

// runtime/islandToken.ts
import type { IslandFlags } from "./types.ts";

// ============================================================================
// Constants & Type Definitions
// ============================================================================

type TokenLayout = {
  readonly ver: number;
  readonly typeId: number;
  readonly propsId: number;
  readonly flags: number;
  readonly key: number;
};

type DebugTokenParts = {
  readonly typeId: number;
  readonly propsId: number;
  readonly flags: number;
  readonly ver: number;
};

type MutableDebugParts = {
  typeId: number;
  propsId: number;
  flags: number;
  ver: number;
};

// Bit layout: [ ver:4 | flags:8 | propsId:20 | typeId:12 ] = 44 bits (< 53)
const BIT_LAYOUT = {
  TYPE: 12,
  PROPS: 20,
  FLAGS: 8,
  VER: 4,
} as const;

const BIT_MASKS = {
  TYPE: (1 << BIT_LAYOUT.TYPE) - 1,
  PROPS: (1 << BIT_LAYOUT.PROPS) - 1,
  FLAGS: (1 << BIT_LAYOUT.FLAGS) - 1,
  VER: (1 << BIT_LAYOUT.VER) - 1,
} as const;

const BIT_SHIFTS = {
  TYPE: 0,
  PROPS: BIT_LAYOUT.TYPE,
  FLAGS: BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS,
  VER: BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS + BIT_LAYOUT.FLAGS,
} as const;

const BIT_DIVISORS = {
  TYPE: 1 << BIT_LAYOUT.TYPE,
  PROPS: 1 << (BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS),
  VER: 1 << (BIT_LAYOUT.TYPE + BIT_LAYOUT.PROPS + BIT_LAYOUT.FLAGS),
} as const;

const DEBUG_KEY_MAP = {
  t: "typeId",
  type: "typeId",
  p: "propsId",
  props: "propsId",
  f: "flags",
  flags: "flags",
  v: "ver",
  ver: "ver",
} as const;

type DebugKey = keyof typeof DEBUG_KEY_MAP;
type DebugProperty = typeof DEBUG_KEY_MAP[DebugKey];

const DEFAULT_VERSION = 1;
const BASE_36 = 36;

// ============================================================================
// Public API
// ============================================================================

export type DecodedIslandToken = TokenLayout;

export function encodeIslandToken(
  typeId: number,
  propsId: number,
  flags: number,
  ver = DEFAULT_VERSION,
): string {
  const packed = packTokenComponents(
    typeId & BIT_MASKS.TYPE,
    propsId & BIT_MASKS.PROPS,
    flags & BIT_MASKS.FLAGS,
    ver & BIT_MASKS.VER,
  );

  return packed.toString(BASE_36);
}

export function decodeIslandToken(
  attr: string | null | undefined,
): DecodedIslandToken | null {
  const normalized = normalizeInput(attr);
  if (!normalized) return null;

  return normalized.includes("=")
    ? decodeDebugFormat(normalized)
    : decodeProductionFormat(normalized);
}

export function hasFlag(flags: number, bit: IslandFlags): boolean {
  return (flags & bit) !== 0;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function packTokenComponents(
  typeId: number,
  propsId: number,
  flags: number,
  ver: number,
): number {
  return (
    typeId |
    (propsId << BIT_SHIFTS.PROPS) |
    (flags << BIT_SHIFTS.FLAGS) |
    (ver << BIT_SHIFTS.VER)
  ) >>> 0;
}

function unpackTokenKey(key: number): TokenLayout {
  const safeKey = key >>> 0;

  const typeId = Math.floor(safeKey % BIT_DIVISORS.TYPE);
  const propsId = Math.floor(safeKey / BIT_DIVISORS.TYPE) %
    (1 << BIT_LAYOUT.PROPS);
  const flags = Math.floor(safeKey / BIT_DIVISORS.PROPS) %
    (1 << BIT_LAYOUT.FLAGS);
  const ver = Math.floor(safeKey / BIT_DIVISORS.VER) % (1 << BIT_LAYOUT.VER);

  return { ver, typeId, propsId, flags, key: safeKey };
}

function normalizeInput(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  return trimmed || null;
}

function parseDebugToken(input: string): DebugTokenParts | null {
  const parts = input.split(/[,\s]+/).filter(Boolean);
  const result: Partial<MutableDebugParts> = { ver: DEFAULT_VERSION };
  let hasValidPart = false;

  for (const part of parts) {
    const [rawKey, rawValue] = part.split("=");
    if (!rawKey || rawValue == null) continue;

    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    const mappedKey = DEBUG_KEY_MAP[rawKey as DebugKey];
    if (mappedKey) {
      result[mappedKey as DebugProperty] = value | 0;
      hasValidPart = true;
    }
  }

  return hasValidPart
    ? {
      typeId: result.typeId ?? 0,
      propsId: result.propsId ?? 0,
      flags: result.flags ?? 0,
      ver: result.ver ?? DEFAULT_VERSION,
    }
    : null;
}

function decodeDebugFormat(input: string): DecodedIslandToken | null {
  const parsed = parseDebugToken(input);
  if (!parsed) return null;

  const encodedKey = encodeIslandToken(
    parsed.typeId,
    parsed.propsId,
    parsed.flags,
    parsed.ver,
  );
  const key = parseInt(encodedKey, BASE_36);

  return { ...parsed, key };
}

function decodeProductionFormat(input: string): DecodedIslandToken | null {
  const key = parseInt(input, BASE_36);
  if (!Number.isFinite(key) || key <= 0) return null;

  return unpackTokenKey(key);
}

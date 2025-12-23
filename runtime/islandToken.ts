// runtime/islandToken.ts
import type { IslandFlags, IslandKey } from "./types.ts";
import { decodeKey, encodeKey, parseIslandKey } from "./keyCodec.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type DecodedIslandToken = {
  readonly typeId: number;
  readonly propsId: number;
  readonly flags: number;
  /** Canonical key as number (safe: 40-bit < 2^53) */
  readonly key: number;
};

type DebugTokenParts = {
  readonly typeId: number;
  readonly propsId: number;
  readonly flags: number;
};

type MutableDebugParts = {
  typeId: number;
  propsId: number;
  flags: number;
};

type DebugProperty = "typeId" | "propsId" | "flags";

// ============================================================================
// Constants
// ============================================================================

const BASE_36 = 36;

/**
 * Lookup table for debug token keys.
 * Supports both short (t, p, f) and long (type, props, flags) formats.
 */
const DEBUG_KEY_LOOKUP: Readonly<Record<string, DebugProperty>> = Object.freeze(
  {
    t: "typeId",
    type: "typeId",
    p: "propsId",
    props: "propsId",
    f: "flags",
    flags: "flags",
  },
);

const DEBUG_DEFAULTS: Readonly<DebugTokenParts> = Object.freeze({
  typeId: 0,
  propsId: 0,
  flags: 0,
});

const DEBUG_TOKEN_SEPARATORS = /[,\s]+/;
const KEY_VALUE_SEPARATOR = "=";

// ============================================================================
// Public API - Encoding
// ============================================================================

/**
 * Encodes island metadata into a canonical token.
 * Uses the same layout as keyCodec.ts: [flags:8 | propsId:20 | typeId:12] = 40 bits.
 * @param typeId - The type identifier (12 bits).
 * @param propsId - The props identifier (20 bits).
 * @param flags - The flags (8 bits).
 * @returns Base-36 encoded token string.
 */
export function encodeIslandToken(
  typeId: number,
  propsId: number,
  flags: number,
): string {
  const key = encodeKey(typeId | 0, propsId | 0, flags | 0);
  return (key as unknown as number).toString(BASE_36);
}

// ============================================================================
// Public API - Decoding
// ============================================================================

/**
 * Decodes an island token from either format:
 * - Production: base-36 encoded key (canonical)
 * - Debug: "t=1,p=2,f=3" (order-free, supports aliases)
 *
 * @param attr - The token string (from data-nk attribute).
 * @returns Decoded token or null if invalid.
 */
export function decodeIslandToken(
  attr: string | null | undefined,
): DecodedIslandToken | null {
  const normalized = normalizeInput(attr);

  if (!normalized) {
    return null;
  }

  // Debug format contains "=" (key-value pairs)
  if (normalized.includes(KEY_VALUE_SEPARATOR)) {
    return decodeDebugFormat(normalized);
  }

  // Production format is pure base-36
  return decodeProductionFormat(normalized);
}

// ============================================================================
// Public API - Flag Utilities
// ============================================================================

/**
 * Checks if a specific flag bit is set.
 * @param flags - The flags value.
 * @param bit - The flag bit to check.
 * @returns True if the flag is set, false otherwise.
 */
export function hasFlag(flags: number, bit: IslandFlags): boolean {
  return (flags & (bit as unknown as number)) !== 0;
}

// ============================================================================
// Debug Format Decoding
// ============================================================================

/**
 * Parses a debug token string into its components.
 * Format: "t=1,p=2,f=3" or "type=1 props=2 flags=3"
 * @param input - Debug format string.
 * @returns Parsed parts or null if invalid.
 */
function parseDebugToken(input: string): DebugTokenParts | null {
  const parts = input.split(DEBUG_TOKEN_SEPARATORS).filter(Boolean);
  const result: Partial<MutableDebugParts> = {};
  let hasValidPart = false;

  for (const part of parts) {
    const [rawKey, rawValue] = part.split(KEY_VALUE_SEPARATOR);

    if (!rawKey || rawValue == null) {
      continue;
    }

    // Lookup table for O(1) key resolution
    const mappedProperty = DEBUG_KEY_LOOKUP[rawKey];

    if (!mappedProperty) {
      continue;
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
      continue;
    }

    result[mappedProperty] = value | 0;
    hasValidPart = true;
  }

  if (!hasValidPart) {
    return null;
  }

  // Return with defaults for missing fields
  return {
    typeId: result.typeId ?? DEBUG_DEFAULTS.typeId,
    propsId: result.propsId ?? DEBUG_DEFAULTS.propsId,
    flags: result.flags ?? DEBUG_DEFAULTS.flags,
  };
}

/**
 * Decodes a debug format token by converting to canonical format first.
 * @param input - Debug format string.
 * @returns Decoded token or null if invalid.
 */
function decodeDebugFormat(input: string): DecodedIslandToken | null {
  const parsed = parseDebugToken(input);

  if (!parsed) {
    return null;
  }

  // Convert debug format to canonical production format
  const canonicalToken = encodeIslandToken(
    parsed.typeId,
    parsed.propsId,
    parsed.flags,
  );

  return decodeProductionFormat(canonicalToken);
}

// ============================================================================
// Production Format Decoding
// ============================================================================

/**
 * Decodes a production format token (base-36 encoded key).
 * @param input - Base-36 token string.
 * @returns Decoded token or null if invalid.
 */
function decodeProductionFormat(input: string): DecodedIslandToken | null {
  const key = parseIslandKey(input);

  if (key == null) {
    return null;
  }

  const decoded = decodeKey(key as unknown as IslandKey);

  // Normalize to integers and validate
  const typeId = decoded.typeId | 0;
  const propsId = decoded.propsId | 0;
  const flags = decoded.flags | 0;

  const numericKey = typeof key === "number" ? key : Number(key);

  // Key must be a positive finite number
  if (!Number.isFinite(numericKey) || numericKey <= 0) {
    return null;
  }

  return {
    typeId,
    propsId,
    flags,
    key: numericKey,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalizes input string by trimming whitespace.
 * @param input - Input string to normalize.
 * @returns Trimmed string or null if empty/null/undefined.
 */
function normalizeInput(input: string | null | undefined): string | null {
  if (input == null) {
    return null;
  }

  const trimmed = input.trim();

  return trimmed.length > 0 ? trimmed : null;
}

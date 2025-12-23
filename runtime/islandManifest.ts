// runtime/islandManifest.ts
import type { IslandsRegistry, IslandTypeDef, PropsPool } from "./types.ts";
import { IslandFlags } from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

const SCRIPT_IDS = {
  TYPES: "__i_types",
  PROPS: "__i_props",
} as const;

const GLOBAL_KEYS = {
  REGISTRY: "__NK_REGISTRY__",
  PROPS: "__NK_PROPS__",
} as const;

const DEFAULT_VERSION = 1;

const DEFAULT_TYPE_CONFIG: Readonly<IslandTypeDefDefaults> = Object.freeze({
  kind: "component",
  exportName: "hydrate",
  defaultFlags: IslandFlags.PrefetchSafe | IslandFlags.HydrateOnEventOnly,
  estBytes: 25_000,
  estCpuMs: 4.0,
  estBenefitMs: 90,
});

// ============================================================================
// Type Definitions
// ============================================================================

type GlobalsWithIslands = typeof globalThis & {
  [GLOBAL_KEYS.REGISTRY]?: IslandsRegistry;
  [GLOBAL_KEYS.PROPS]?: PropsPool;
};

type IslandTypeDefPartial = Partial<IslandTypeDef>;

type IslandTypeDefDefaults = Omit<IslandTypeDef, "typeId" | "name" | "entry">;

type JsonScriptId = "__i_types" | "__i_props";

type TypeDefRequiredFields = Required<Pick<IslandTypeDef, "entry" | "name">>;

// ============================================================================
// Module-level Cache (parse once)
// ============================================================================

let cachedRegistry: IslandsRegistry | null = null;
let cachedProps: PropsPool | null = null;

// ============================================================================
// Public API - Global Registry Access (single source of truth)
// ============================================================================

/**
 * Loads the islands registry from cache or initializes from DOM/globals.
 * @returns The islands registry.
 */
export function loadRegistry(): IslandsRegistry {
  ensureInitialized();
  // Safe assertion: ensureInitialized guarantees non-null
  return cachedRegistry!;
}

/**
 * Loads the props pool from cache or initializes from DOM/globals.
 * @returns The props pool.
 */
export function loadPropsPool(): PropsPool {
  ensureInitialized();
  // Safe assertion: ensureInitialized guarantees non-null
  return cachedProps!;
}

/**
 * Forces re-reading from DOM scripts (useful for dev/hot reload).
 * In production, you typically never call this.
 */
export function reloadFromDom(): void {
  cachedRegistry = null;
  cachedProps = null;
  ensureInitialized(true);
}

// ============================================================================
// Island Manifest Class
// ============================================================================

export class IslandManifest {
  private readonly registry: IslandsRegistry;
  private readonly props: PropsPool;

  constructor() {
    ensureInitialized();
    // Safe assertions: ensureInitialized guarantees non-null
    this.registry = cachedRegistry!;
    this.props = cachedProps!;
  }

  /**
   * Retrieves a type definition by its ID.
   * @param typeId - The type identifier.
   * @returns The type definition if found, null otherwise.
   */
  getType(typeId: number): IslandTypeDef | null {
    return this.registry.types[typeId] ?? null;
  }

  /**
   * Retrieves props by their ID.
   * @param propsId - The props identifier.
   * @returns The props value, or undefined if not found.
   */
  getProps(propsId: number): unknown {
    return this.props[propsId];
  }

  /**
   * Patches a type definition safely (normalizes numbers/flags).
   * Does NOT allow changing typeId, name, or entry.
   * @param typeId - The type to patch.
   * @param patch - Partial type definition with updates.
   */
  patchType(typeId: number, patch: IslandTypeDefPartial): void {
    const current = this.registry.types[typeId];

    if (!current) {
      return;
    }

    // Merge while preserving critical immutable fields
    const merged: IslandTypeDefPartial = {
      ...current,
      ...patch,
      // Immutable fields (prevent tampering)
      typeId: current.typeId,
      name: current.name,
      entry: current.entry,
    };

    const normalized = normalizeTypeDef(typeId, merged);

    if (!normalized) {
      return;
    }

    this.registry.types[typeId] = normalized;

    // Keep globals in sync (single source of truth)
    publishToGlobals(this.registry, this.props);
  }
}

// ============================================================================
// Initialization - Single Source of Truth
// ============================================================================

/**
 * Ensures registry and props are initialized from globals or DOM.
 * @param forceDom - If true, forces reading from DOM scripts.
 */
function ensureInitialized(forceDom = false): void {
  if (!forceDom && cachedRegistry && cachedProps) {
    return;
  }

  const globals = globalThis as GlobalsWithIslands;

  // Prefer already-published globals unless forcing DOM re-read
  if (
    !forceDom && globals[GLOBAL_KEYS.REGISTRY] && globals[GLOBAL_KEYS.PROPS]
  ) {
    cachedRegistry = globals[GLOBAL_KEYS.REGISTRY] ?? null;
    cachedProps = globals[GLOBAL_KEYS.PROPS] ?? [];
    return;
  }

  // Read from DOM scripts
  const rawRegistry = readJsonScript<IslandsRegistry>(SCRIPT_IDS.TYPES);
  const rawProps = readJsonScript<PropsPool>(SCRIPT_IDS.PROPS);

  // Normalize and fallback to defaults
  const normalizedRegistry = normalizeRegistry(
    rawRegistry ?? createDefaultRegistry(),
  );
  const normalizedProps = normalizePropsPool(
    rawProps ?? createDefaultPropsPool(),
  );

  cachedRegistry = normalizedRegistry;
  cachedProps = normalizedProps;

  publishToGlobals(normalizedRegistry, normalizedProps);
}

/**
 * Publishes registry and props to global scope.
 * @param registry - The islands registry.
 * @param props - The props pool.
 */
function publishToGlobals(registry: IslandsRegistry, props: PropsPool): void {
  const globals = globalThis as GlobalsWithIslands;
  globals[GLOBAL_KEYS.REGISTRY] = registry;
  globals[GLOBAL_KEYS.PROPS] = props;
}

// ============================================================================
// Helper Functions - Environment Detection
// ============================================================================

function canUseDOM(): boolean {
  return typeof document !== "undefined" && typeof HTMLElement !== "undefined";
}

// ============================================================================
// Helper Functions - Script Reading (SSR-safe)
// ============================================================================

/**
 * Reads and parses JSON from a script element.
 * @param id - The script element ID.
 * @returns Parsed JSON data or null if unavailable/invalid.
 */
function readJsonScript<T>(id: JsonScriptId): T | null {
  if (!canUseDOM()) {
    return null;
  }

  const element = document.getElementById(id);

  if (!element) {
    return null;
  }

  const content = element.textContent?.trim() ?? "";

  if (!content) {
    return null;
  }

  return parseJsonSafely<T>(content);
}

/**
 * Safely parses JSON string.
 * @param json - JSON string to parse.
 * @returns Parsed object or null on error.
 */
function parseJsonSafely<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Helper Functions - Registry Normalization
// ============================================================================

/**
 * Normalizes a registry by validating and cleaning type definitions.
 * @param registry - Raw registry to normalize.
 * @returns Normalized registry.
 */
function normalizeRegistry(registry: IslandsRegistry): IslandsRegistry {
  const normalized: IslandsRegistry = {
    version: normalizeVersion(registry.version),
    types: {},
  };

  const rawTypes = registry.types ?? {};

  for (const [key, rawType] of Object.entries(rawTypes)) {
    const typeId = parseTypeId(key);

    if (typeId === null) {
      continue;
    }

    const typeDef = normalizeTypeDef(typeId, rawType as IslandTypeDefPartial);

    if (typeDef) {
      normalized.types[typeId] = typeDef;
    }
  }

  return normalized;
}

/**
 * Normalizes version number with fallback.
 * @param version - Raw version.
 * @returns Valid version number.
 */
function normalizeVersion(version: number | undefined): number {
  return typeof version === "number" && Number.isFinite(version)
    ? version
    : DEFAULT_VERSION;
}

/**
 * Parses a type ID from a string key.
 * @param key - String key to parse.
 * @returns Parsed type ID or null if invalid.
 */
function parseTypeId(key: string): number | null {
  const parsed = Number.parseInt(key, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed | 0;
}

/**
 * Normalizes a type definition with defaults and validation.
 * @param typeId - The type identifier.
 * @param raw - Raw partial type definition.
 * @returns Normalized type definition or null if invalid.
 */
function normalizeTypeDef(
  typeId: number,
  raw: IslandTypeDefPartial,
): IslandTypeDef | null {
  if (!isValidTypeDef(raw)) {
    return null;
  }

  return {
    typeId,
    name: raw.name,
    entry: raw.entry,
    exportName: isNonEmptyString(raw.exportName)
      ? raw.exportName
      : DEFAULT_TYPE_CONFIG.exportName,
    kind: raw.kind ?? DEFAULT_TYPE_CONFIG.kind,
    defaultFlags: normalizeFlags(raw.defaultFlags),
    estBytes: normalizeNonNegativeNumber(
      raw.estBytes,
      DEFAULT_TYPE_CONFIG.estBytes,
    ),
    estCpuMs: normalizeNonNegativeNumber(
      raw.estCpuMs,
      DEFAULT_TYPE_CONFIG.estCpuMs,
    ),
    estBenefitMs: normalizeNonNegativeNumber(
      raw.estBenefitMs,
      DEFAULT_TYPE_CONFIG.estBenefitMs,
    ),
    navProp: isNonEmptyString(raw.navProp) ? raw.navProp : undefined,
  };
}

/**
 * Type guard to check if a partial type definition has required fields.
 * @param raw - Partial type definition to check.
 * @returns True if valid, false otherwise.
 */
function isValidTypeDef(
  raw: IslandTypeDefPartial,
): raw is TypeDefRequiredFields & IslandTypeDefPartial {
  return isNonEmptyString(raw.entry) && isNonEmptyString(raw.name);
}

/**
 * Checks if a value is a non-empty string.
 * @param value - Value to check.
 * @returns True if non-empty string, false otherwise.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Normalizes flags to a valid integer.
 * @param flags - Raw flags value.
 * @returns Normalized flags integer.
 */
function normalizeFlags(flags: number | undefined): number {
  const value = typeof flags === "number" && Number.isFinite(flags)
    ? flags
    : DEFAULT_TYPE_CONFIG.defaultFlags;

  return value | 0;
}

/**
 * Normalizes a number to be non-negative with fallback.
 * @param value - Raw number value.
 * @param defaultValue - Fallback value.
 * @returns Non-negative number.
 */
function normalizeNonNegativeNumber(
  value: number | undefined,
  defaultValue: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }

  return value < 0 ? 0 : value;
}

/**
 * Normalizes props pool, ensuring it's an array.
 * @param pool - Raw props pool.
 * @returns Normalized props pool.
 */
function normalizePropsPool(pool: PropsPool): PropsPool {
  return Array.isArray(pool) ? pool : createDefaultPropsPool();
}

// ============================================================================
// Helper Functions - Factory Functions
// ============================================================================

/**
 * Creates a default empty registry.
 * @returns Fresh default registry.
 */
function createDefaultRegistry(): IslandsRegistry {
  return {
    version: DEFAULT_VERSION,
    types: {},
  };
}

/**
 * Creates a default empty props pool.
 * @returns Fresh empty array.
 */
function createDefaultPropsPool(): PropsPool {
  return [];
}

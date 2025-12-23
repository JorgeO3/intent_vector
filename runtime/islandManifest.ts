import type { IslandsRegistry, IslandTypeDef, PropsPool } from "./types.ts";
import { IslandFlags } from "./types.ts";

// ============================================================================
// Type Definitions
// ============================================================================

type GlobalsWithIslands = typeof globalThis & {
  __NK_REGISTRY__?: IslandsRegistry;
  __NK_PROPS__?: PropsPool;
};

type IslandTypeDefPartial = Partial<IslandTypeDef>;

type IslandTypeDefDefaults = Omit<IslandTypeDef, "typeId" | "name" | "entry">;

type JsonScriptId = "__i_types" | "__i_props";

// ============================================================================
// Constants
// ============================================================================

const SCRIPT_IDS = {
  TYPES: "__i_types",
  PROPS: "__i_props",
} as const;

const DEFAULT_REGISTRY: IslandsRegistry = {
  version: 0,
  types: {},
} as const;

const DEFAULT_PROPS: PropsPool = [] as const;

const DEFAULT_TYPE_CONFIG: IslandTypeDefDefaults = {
  kind: "component",
  exportName: "hydrate",
  defaultFlags: IslandFlags.PrefetchSafe | IslandFlags.HydrateOnEventOnly,
  estBytes: 25_000,
  estCpuMs: 4.0,
  estBenefitMs: 90,
} as const;

const DEFAULT_VERSION = 1;

// ============================================================================
// Public API - Global Registry Access
// ============================================================================

export function loadRegistry(): IslandsRegistry {
  const globals = globalThis as GlobalsWithIslands;
  return globals.__NK_REGISTRY__ ?? DEFAULT_REGISTRY;
}

export function loadPropsPool(): PropsPool {
  const globals = globalThis as GlobalsWithIslands;
  return globals.__NK_PROPS__ ?? DEFAULT_PROPS;
}

// ============================================================================
// Island Manifest Class
// ============================================================================

export class IslandManifest {
  private readonly registry: IslandsRegistry;
  private readonly props: PropsPool;

  constructor() {
    const rawRegistry = readJsonScript<IslandsRegistry>(SCRIPT_IDS.TYPES) ??
      createDefaultRegistry();
    const rawProps = readJsonScript<PropsPool>(SCRIPT_IDS.PROPS) ??
      createDefaultPropsPool();

    this.registry = normalizeRegistry(rawRegistry);
    this.props = rawProps;
  }

  getType(typeId: number): IslandTypeDef | null {
    return this.registry.types[typeId] ?? null;
  }

  getProps(propsId: number): unknown {
    return this.props[propsId];
  }

  patchType(typeId: number, patch: IslandTypeDefPartial): void {
    const current = this.registry.types[typeId];
    if (!current) return;

    this.registry.types[typeId] = {
      ...current,
      ...patch,
      typeId,
    };
  }
}

// ============================================================================
// Internal Helpers - Script Reading
// ============================================================================

function readJsonScript<T>(id: JsonScriptId): T | null {
  const element = document.getElementById(id);
  if (!element) return null;

  const content = element.textContent ?? "";
  const trimmedContent = content.trim();
  if (!trimmedContent) return null;

  return parseJsonSafely<T>(trimmedContent);
}

function parseJsonSafely<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Internal Helpers - Registry Normalization
// ============================================================================

function normalizeRegistry(registry: IslandsRegistry): IslandsRegistry {
  const normalized: IslandsRegistry = {
    version: registry.version ?? DEFAULT_VERSION,
    types: {},
  };

  const entries = Object.entries(registry.types ?? {});

  for (const [key, rawType] of entries) {
    const typeId = parseTypeId(key);
    const typeDef = normalizeTypeDef(typeId, rawType);

    if (typeDef) {
      normalized.types[typeId] = typeDef;
    }
  }

  return normalized;
}

function parseTypeId(key: string): number {
  return Number(key) | 0;
}

function normalizeTypeDef(
  typeId: number,
  raw: IslandTypeDefPartial,
): IslandTypeDef | null {
  if (!isValidTypeDef(raw)) return null;

  return {
    typeId,
    name: raw.name,
    entry: raw.entry,
    exportName: raw.exportName ?? DEFAULT_TYPE_CONFIG.exportName,
    kind: raw.kind ?? DEFAULT_TYPE_CONFIG.kind,
    defaultFlags: normalizeFlags(raw.defaultFlags),
    estBytes: normalizeNumber(raw.estBytes, DEFAULT_TYPE_CONFIG.estBytes),
    estCpuMs: normalizeNumber(raw.estCpuMs, DEFAULT_TYPE_CONFIG.estCpuMs),
    estBenefitMs: normalizeNumber(
      raw.estBenefitMs,
      DEFAULT_TYPE_CONFIG.estBenefitMs,
    ),
    navProp: raw.navProp,
  };
}

function isValidTypeDef(raw: IslandTypeDefPartial): raw is
  & Required<
    Pick<IslandTypeDef, "entry" | "name">
  >
  & IslandTypeDefPartial {
  return Boolean(raw.entry && raw.name);
}

function normalizeFlags(flags: number | undefined): number {
  return (flags ?? DEFAULT_TYPE_CONFIG.defaultFlags) | 0;
}

function normalizeNumber(
  value: number | undefined,
  defaultValue: number,
): number {
  return Number.isFinite(value) ? value! : defaultValue;
}

// ============================================================================
// Internal Helpers - Factory Functions
// ============================================================================

function createDefaultRegistry(): IslandsRegistry {
  return {
    version: DEFAULT_VERSION,
    types: {},
  };
}

function createDefaultPropsPool(): PropsPool {
  return [];
}

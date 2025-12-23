// runtime/actuators.ts
import type { IslandHandle, IslandsRegistry, IslandTypeDef } from "./types.ts";
import { IslandFlags } from "./types.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type ActuatorConfig = {
  readonly useModulePreload: boolean;
  readonly useFetchPrefetch: boolean;
};

export type PrefetchHandle = {
  readonly kind: "modulepreload" | "fetch";
  readonly abort?: () => void;
};

type ModuleNamespace = Record<string, unknown>;

type HydrateFn = (el: HTMLElement, props: unknown) => unknown;

type HandlerFn = (event: Event, ctx: unknown) => unknown;

type PrefetchTarget = IslandHandle | { entry: string };

type PrefetchableResource = IslandTypeDef | { entry: string };

type ScriptElementWithSupport = typeof HTMLScriptElement & {
  supports?: (type: string) => boolean;
};

type SpeculationRulesConfig = {
  prefetch: Array<{
    source: "list";
    urls: string[];
  }>;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: ActuatorConfig = {
  useModulePreload: true,
  useFetchPrefetch: false,
} as const;

const MODULE_EXPORT_NAMES = {
  HYDRATE: "hydrate",
  DEFAULT: "default",
  HANDLE: "handle",
} as const;

const LINK_REL_TYPES = {
  MODULE_PRELOAD: "modulepreload",
  PREFETCH: "prefetch",
} as const;

const FETCH_OPTIONS = {
  credentials: "same-origin",
  mode: "cors",
} as const;

const LINK_CROSS_ORIGIN = "anonymous";
const SPECULATION_SCRIPT_TYPE = "speculationrules";

// ============================================================================
// Actuators Class
// ============================================================================

export class Actuators {
  private config: ActuatorConfig;
  private registry: IslandsRegistry;

  private readonly speculatedUrls = new Set<string>();
  private readonly handlerModules = new Map<string, ModuleNamespace>();
  private readonly islandModules = new Map<string, ModuleNamespace>();

  constructor(registry: IslandsRegistry, config?: Partial<ActuatorConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setRegistry(registry: IslandsRegistry): void {
    this.registry = registry;
  }

  prefetch(handle: IslandHandle): PrefetchHandle | null;
  prefetch(type: { entry: string }, flags: number): PrefetchHandle | null;
  prefetch(
    target: PrefetchTarget,
    explicitFlags?: number,
  ): PrefetchHandle | null {
    const type = resolveIslandType(target, this.registry);
    if (!type) return null;

    const flags = resolveFlags(target, explicitFlags);
    if (!isPrefetchSafe(flags)) return null;

    return this.executePrefetch(type.entry);
  }

  async hydrate(handle: IslandHandle, props: unknown): Promise<unknown> {
    const type = getIslandType(handle.typeId, this.registry);
    const module = await this.loadIslandModule(type.entry);
    const hydrateFn = resolveHydrateFn(module, type);

    return hydrateFn(handle.el, props);
  }

  async runHandler(
    entryUrl: string,
    event: Event,
    ctx: unknown,
  ): Promise<unknown> {
    const module = await this.loadHandlerModule(entryUrl);
    const handlerFn = resolveHandlerFn(module);

    if (!handlerFn) return;

    return handlerFn(event, ctx);
  }

  getNavUrl(typeId: number, props: unknown): string | null {
    const type = this.registry.types[typeId];
    if (!type?.navProp) return null;

    return extractNavUrl(props, type.navProp);
  }

  speculatePrefetchUrl(url: string): void {
    if (!url || this.speculatedUrls.has(url)) return;

    if (supportsSpeculationRules()) {
      injectSpeculationRules(url);
    } else {
      injectPrefetchLink(url);
    }

    this.speculatedUrls.add(url);
  }

  private executePrefetch(entry: string): PrefetchHandle | null {
    if (this.config.useModulePreload) {
      ensureModulePreloadLink(entry);
      return { kind: LINK_REL_TYPES.MODULE_PRELOAD };
    }

    if (this.config.useFetchPrefetch) {
      return createFetchPrefetch(entry);
    }

    return null;
  }

  private loadIslandModule(entry: string): Promise<ModuleNamespace> {
    return this.loadModule(entry, this.islandModules);
  }

  private loadHandlerModule(entry: string): Promise<ModuleNamespace> {
    return this.loadModule(entry, this.handlerModules);
  }

  private async loadModule(
    entry: string,
    cache: Map<string, ModuleNamespace>,
  ): Promise<ModuleNamespace> {
    let module = cache.get(entry);

    if (!module) {
      module = await importModule(entry);
      cache.set(entry, module);
    }

    return module;
  }
}

// ============================================================================
// Type Resolution Helpers
// ============================================================================

function resolveIslandType(
  target: PrefetchTarget,
  registry: IslandsRegistry,
): PrefetchableResource | null {
  if ("typeId" in target) {
    return registry.types[target.typeId] ?? null;
  }
  return target as { entry: string };
}

function resolveFlags(target: PrefetchTarget, explicitFlags?: number): number {
  if (typeof explicitFlags === "number") {
    return explicitFlags;
  }
  if ("flags" in target) {
    return target.flags;
  }
  return 0;
}

function isPrefetchSafe(flags: number): boolean {
  return (flags & IslandFlags.PrefetchSafe) !== 0;
}

function getIslandType(
  typeId: number,
  registry: IslandsRegistry,
): IslandTypeDef {
  const type = registry.types[typeId];
  if (!type) {
    throw new Error(`Unknown island typeId=${typeId}`);
  }
  return type;
}

// ============================================================================
// Module Loading Helpers
// ============================================================================

async function importModule(entry: string): Promise<ModuleNamespace> {
  return await import(/* @vite-ignore */ entry) as ModuleNamespace;
}

function resolveHydrateFn(
  module: ModuleNamespace,
  type: IslandTypeDef,
): HydrateFn {
  const candidate = type.exportName
    ? module[type.exportName]
    : (module[MODULE_EXPORT_NAMES.HYDRATE] ??
      module[MODULE_EXPORT_NAMES.DEFAULT]);

  if (typeof candidate !== "function") {
    throw new Error(
      `Island module missing hydrate/export/default: ${type.entry}`,
    );
  }

  return candidate as HydrateFn;
}

function resolveHandlerFn(module: ModuleNamespace): HandlerFn | null {
  const candidate = module[MODULE_EXPORT_NAMES.DEFAULT] ??
    module[MODULE_EXPORT_NAMES.HANDLE];

  return typeof candidate === "function" ? (candidate as HandlerFn) : null;
}

// ============================================================================
// Navigation Helpers
// ============================================================================

function extractNavUrl(props: unknown, navProp: string): string | null {
  if (!props || typeof props !== "object") return null;

  const record = props as Record<string, unknown>;
  const value = record[navProp];

  return typeof value === "string" && value.length ? value : null;
}

// ============================================================================
// Prefetch Implementation - Module Preload
// ============================================================================

function ensureModulePreloadLink(href: string): void {
  if (modulePreloadExists(href)) return;

  const link = createModulePreloadLink(href);
  document.head.append(link);
}

function modulePreloadExists(href: string): boolean {
  const escapedHref = CSS.escape(href);
  const selector =
    `link[rel="${LINK_REL_TYPES.MODULE_PRELOAD}"][href="${escapedHref}"]`;
  return document.head.querySelector(selector) !== null;
}

function createModulePreloadLink(href: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = LINK_REL_TYPES.MODULE_PRELOAD;
  link.href = href;
  link.crossOrigin = LINK_CROSS_ORIGIN;
  return link;
}

// ============================================================================
// Prefetch Implementation - Fetch API
// ============================================================================

function createFetchPrefetch(entry: string): PrefetchHandle {
  const controller = new AbortController();

  fetch(entry, {
    signal: controller.signal,
    credentials: FETCH_OPTIONS.credentials as RequestCredentials,
    mode: FETCH_OPTIONS.mode as RequestMode,
  }).catch(() => {});

  return {
    kind: "fetch",
    abort: () => controller.abort(),
  };
}

// ============================================================================
// Speculation Rules Support
// ============================================================================

function supportsSpeculationRules(): boolean {
  const scriptElement = HTMLScriptElement as ScriptElementWithSupport;
  return typeof scriptElement.supports === "function" &&
    scriptElement.supports(SPECULATION_SCRIPT_TYPE);
}

function injectSpeculationRules(url: string): void {
  const config: SpeculationRulesConfig = {
    prefetch: [{ source: "list", urls: [url] }],
  };

  const script = createSpeculationScript(config);
  const target = getDocumentAppendTarget();

  target.append(script);
}

function createSpeculationScript(
  config: SpeculationRulesConfig,
): HTMLScriptElement {
  const script = document.createElement("script");
  script.type = SPECULATION_SCRIPT_TYPE;
  script.textContent = JSON.stringify(config);
  return script;
}

function getDocumentAppendTarget(): HTMLElement {
  return document.body ?? document.head ?? document.documentElement;
}

// ============================================================================
// Prefetch Fallback - Link Prefetch
// ============================================================================

function injectPrefetchLink(url: string): void {
  const link = createPrefetchLink(url);
  document.head.append(link);
}

function createPrefetchLink(href: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = LINK_REL_TYPES.PREFETCH;
  link.href = href;
  return link;
}

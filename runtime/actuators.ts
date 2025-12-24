import type {
  ActuatorConfig,
  IslandHandle,
  IslandsRegistry,
  IslandTypeDef,
} from "./types.ts";
import { IslandFlags } from "./types.ts";
import { canUseDOM } from "./utils.ts";

// ============================================================================
// Type Definitions
// ============================================================================

export type PrefetchHandle = {
  readonly kind: "modulepreload" | "fetch";
  readonly abort?: () => void;
  /**
   * Optional completion signal.
   * - fetch: resolves when fetch settles
   * - modulepreload: resolves on link load/error when link is created by us
   */
  readonly done?: Promise<void>;
};

type ModuleNamespace = Record<string, unknown>;
type HydrateFn = (el: HTMLElement, props: unknown) => unknown;
type HandlerFn = (event: Event, ctx: unknown) => unknown;

type PrefetchTarget = IslandHandle | { readonly entry: string };
type PrefetchableResource = IslandTypeDef | { readonly entry: string };

type ScriptElementWithSupport = typeof HTMLScriptElement & {
  supports?: (type: string) => boolean;
};

type SpeculationRulesConfig = {
  readonly prefetch: ReadonlyArray<{
    readonly source: "list";
    readonly urls: readonly string[];
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
const SPECULATION_SCRIPT_ID = "__nk_speculation_rules";

// ============================================================================
// Environment Guards (SSR safety)
// ============================================================================

let speculationRulesSupport: boolean | null = null;

function supportsSpeculationRules(): boolean {
  if (speculationRulesSupport !== null) return speculationRulesSupport;

  if (!canUseDOM() || typeof HTMLScriptElement === "undefined") {
    speculationRulesSupport = false;
    return false;
  }

  const scriptElement = HTMLScriptElement as ScriptElementWithSupport;
  speculationRulesSupport = typeof scriptElement.supports === "function" &&
    scriptElement.supports(SPECULATION_SCRIPT_TYPE);

  return speculationRulesSupport;
}

// ============================================================================
// Actuators Class
// ============================================================================

export class Actuators {
  private config: ActuatorConfig;
  private registry: IslandsRegistry;

  // Deduplication & caches
  private readonly speculatedUrls = new Set<string>();
  private readonly modulePreloaded = new Set<string>();
  private readonly prefetchLinked = new Set<string>();

  // Completion tracking (helps scheduler integration)
  private readonly modulePreloadDone = new Map<string, Promise<void>>();

  // Speculation Rules batching (single script)
  private speculationScript: HTMLScriptElement | null = null;
  private speculationFlushScheduled = false;

  // Module caches
  private readonly handlerModules = new Map<string, ModuleNamespace>();
  private readonly islandModules = new Map<string, ModuleNamespace>();

  constructor(registry: IslandsRegistry, config?: Partial<ActuatorConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setRegistry(registry: IslandsRegistry): void {
    this.registry = registry;
  }

  /**
   * Clear URL speculation state (useful on route changes).
   * Keeps module caches intact.
   */
  resetSpeculation(): void {
    this.speculatedUrls.clear();
    this.prefetchLinked.clear();

    if (canUseDOM()) {
      const existing = document.getElementById(SPECULATION_SCRIPT_ID);
      existing?.remove();
      this.speculationScript?.remove();
    }

    this.speculationScript = null;
    this.speculationFlushScheduled = false;
  }

  // Overload signatures
  prefetch(handle: IslandHandle): PrefetchHandle | null;
  prefetch(
    type: { readonly entry: string },
    flags: number,
  ): PrefetchHandle | null;
  prefetch(
    target: PrefetchTarget,
    explicitFlags?: number,
  ): PrefetchHandle | null {
    const resource = this.resolveIslandType(target);
    if (!resource) return null;

    const instanceFlags = this.resolveFlags(target, explicitFlags);
    const combinedFlags = combineFlags(
      instanceFlags,
      hasDefaultFlags(resource) ? resource.defaultFlags : 0,
    );

    if (!isPrefetchSafe(combinedFlags)) return null;

    return this.executePrefetch(resource.entry);
  }

  async hydrate(handle: IslandHandle, props: unknown): Promise<unknown> {
    const type = this.getIslandType(handle.typeId);
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
    if (!handlerFn) return undefined;
    return handlerFn(event, ctx);
  }

  getNavUrl(typeId: number, props: unknown): string | null {
    const type = this.registry.types[typeId];
    if (!type?.navProp) return null;
    return extractNavUrl(props, type.navProp);
  }

  speculatePrefetchUrl(url: string): void {
    if (!url || this.speculatedUrls.has(url)) return;

    this.speculatedUrls.add(url);

    if (!canUseDOM()) return;

    if (supportsSpeculationRules()) {
      this.scheduleSpeculationFlush();
    } else {
      this.ensurePrefetchLink(url);
    }
  }

  // ========================================================================
  // Private Methods - Prefetch Implementation
  // ========================================================================

  private executePrefetch(entry: string): PrefetchHandle | null {
    if (!canUseDOM()) return null;

    if (this.config.useModulePreload) {
      return this.ensureModulePreload(entry);
    }

    if (this.config.useFetchPrefetch) {
      return createFetchPrefetch(entry);
    }

    return null;
  }

  private ensureModulePreload(href: string): PrefetchHandle {
    // If we already track a completion promise, return it
    const existingDone = this.modulePreloadDone.get(href);
    if (existingDone) {
      this.modulePreloaded.add(href);
      return { kind: "modulepreload", done: existingDone };
    }

    // If we already marked it, don't duplicate
    if (this.modulePreloaded.has(href)) {
      return { kind: "modulepreload" };
    }

    // Dedup vs existing DOM link (SSR/other runtime)
    if (modulePreloadExists(href)) {
      this.modulePreloaded.add(href);
      return { kind: "modulepreload" };
    }

    this.modulePreloaded.add(href);

    const link = createModulePreloadLink(href);
    const done = new Promise<void>((resolve) => {
      const onDone = () => resolve();
      link.addEventListener("load", onDone, { once: true });
      link.addEventListener("error", onDone, { once: true });
    });

    this.modulePreloadDone.set(href, done);

    // Append after listeners to avoid missing fast load events
    document.head.appendChild(link);

    return { kind: "modulepreload", done };
  }

  private ensurePrefetchLink(url: string): void {
    if (this.prefetchLinked.has(url)) return;

    // Dedup vs existing DOM link
    if (prefetchLinkExists(url)) {
      this.prefetchLinked.add(url);
      return;
    }

    this.prefetchLinked.add(url);

    const link = createPrefetchLink(url);
    document.head.appendChild(link);
  }

  // ========================================================================
  // Private Methods - Speculation Rules
  // ========================================================================

  private scheduleSpeculationFlush(): void {
    if (this.speculationFlushScheduled) return;
    this.speculationFlushScheduled = true;

    // Batch multiple URLs in same tick to avoid DOM thrashing
    queueMicrotask(() => {
      this.speculationFlushScheduled = false;
      this.flushSpeculationRules();
    });
  }

  private flushSpeculationRules(): void {
    if (!canUseDOM() || !supportsSpeculationRules()) return;
    if (this.speculatedUrls.size === 0) return;

    // Remove existing script to ensure updates are applied
    const existing = document.getElementById(SPECULATION_SCRIPT_ID);
    existing?.remove();
    this.speculationScript?.remove();

    const urls = Array.from(this.speculatedUrls);
    const config: SpeculationRulesConfig = {
      prefetch: [{ source: "list", urls }],
    };

    const script = createSpeculationScript(config);
    script.id = SPECULATION_SCRIPT_ID;

    const target = getDocumentAppendTarget();
    target.appendChild(script);

    this.speculationScript = script;
  }

  // ========================================================================
  // Private Methods - Module Loading
  // ========================================================================

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
    const cached = cache.get(entry);
    if (cached) return cached;

    const module = await importModule(entry);
    cache.set(entry, module);
    return module;
  }

  // ========================================================================
  // Private Methods - Type Resolution
  // ========================================================================

  private resolveIslandType(
    target: PrefetchTarget,
  ): PrefetchableResource | null {
    // Structural: IslandHandle and IslandTypeDef both have typeId
    if ("typeId" in target) {
      return this.registry.types[target.typeId] ?? null;
    }
    return target;
  }

  private resolveFlags(
    target: PrefetchTarget,
    explicitFlags?: number,
  ): number {
    if (typeof explicitFlags === "number") return explicitFlags;

    if ("flags" in target && typeof target.flags === "number") {
      return target.flags;
    }

    return 0;
  }

  private getIslandType(typeId: number): IslandTypeDef {
    const type = this.registry.types[typeId];
    if (!type) throw new Error(`Unknown island typeId=${typeId}`);
    return type;
  }
}

// ============================================================================
// Helper Functions - Flags & Checks
// ============================================================================

function combineFlags(instanceFlags: number, defaultFlags: number): number {
  return (instanceFlags | (defaultFlags | 0)) | 0;
}

function hasDefaultFlags(x: PrefetchableResource): x is IslandTypeDef {
  return typeof (x as IslandTypeDef).defaultFlags === "number";
}

function isPrefetchSafe(flags: number): boolean {
  return (flags & IslandFlags.PrefetchSafe) !== 0;
}

// ============================================================================
// Helper Functions - Module Loading
// ============================================================================

async function importModule(entry: string): Promise<ModuleNamespace> {
  try {
    return (await import(/* @vite-ignore */ entry)) as ModuleNamespace;
  } catch (error) {
    throw new Error(
      `Failed to import module: ${entry}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveHydrateFn(
  module: ModuleNamespace,
  type: IslandTypeDef,
): HydrateFn {
  const candidate = type.exportName
    ? module[type.exportName]
    : module[MODULE_EXPORT_NAMES.HYDRATE] ??
      module[MODULE_EXPORT_NAMES.DEFAULT];

  if (typeof candidate !== "function") {
    throw new Error(
      `Island module missing hydrate function. Entry: ${type.entry}, Export: ${
        type.exportName ?? "hydrate/default"
      }`,
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
// Helper Functions - Navigation
// ============================================================================

function extractNavUrl(props: unknown, navProp: string): string | null {
  if (!props || typeof props !== "object") return null;
  const record = props as Record<string, unknown>;
  const value = record[navProp];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ============================================================================
// Helper Functions - Link Creation & Dedup
// ============================================================================

function modulePreloadExists(href: string): boolean {
  const escaped = CSS.escape(href);
  return document.head.querySelector(
    `link[rel="${LINK_REL_TYPES.MODULE_PRELOAD}"][href="${escaped}"]`,
  ) !== null;
}

function prefetchLinkExists(href: string): boolean {
  const escaped = CSS.escape(href);
  return document.head.querySelector(
    `link[rel="${LINK_REL_TYPES.PREFETCH}"][href="${escaped}"]`,
  ) !== null;
}

function createModulePreloadLink(href: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = LINK_REL_TYPES.MODULE_PRELOAD;
  link.href = href;
  link.crossOrigin = LINK_CROSS_ORIGIN;
  return link;
}

function createPrefetchLink(href: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = LINK_REL_TYPES.PREFETCH;
  link.href = href;
  return link;
}

// ============================================================================
// Helper Functions - Fetch Prefetch
// ============================================================================

function createFetchPrefetch(entry: string): PrefetchHandle {
  const controller = new AbortController();

  const done = fetch(entry, {
    signal: controller.signal,
    credentials: FETCH_OPTIONS.credentials as RequestCredentials,
    mode: FETCH_OPTIONS.mode as RequestMode,
  })
    .then(() => {})
    .catch(() => {});

  return {
    kind: "fetch",
    abort: () => controller.abort(),
    done,
  };
}

// ============================================================================
// Helper Functions - Speculation Rules
// ============================================================================

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

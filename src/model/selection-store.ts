import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProvider } from "../config";
import type { Workspace } from "../tools/workspace";
import type { ModelCatalogEntry } from "./types";
import type { ModelCatalogManager } from "./catalog-manager";
import type { ModelProviderRouter } from "./providers";

const SELECTION_PATH = ".andi-agent/selection.json";
const MAX_FILE_CHARS = 10_000;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_MODEL_ID_LENGTH = 200;

export interface ModelSelection {
  provider: string;
  model: string;
  updatedAt: string;
}

interface StoredModelSelection extends ModelSelection {
  version: 1;
}

/** Remembers the last model the user switched to so restarts do not reset it. */
export class ModelSelectionStore {
  readonly #workspace: Workspace;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async load(): Promise<ModelSelection | undefined> {
    let content: string;
    try {
      content = await this.#workspace.read(SELECTION_PATH);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (content.length > MAX_FILE_CHARS) return undefined;
    try {
      return parseSelection(JSON.parse(content) as unknown);
    } catch {
      return undefined;
    }
  }

  async save(provider: string, model: string): Promise<void> {
    const normalizedProvider = validateProvider(provider);
    const normalizedModel = validateModel(model);
    const operation = this.#writeQueue.then(async () => {
      const selection: StoredModelSelection = {
        version: 1,
        provider: normalizedProvider,
        model: normalizedModel,
        updatedAt: new Date().toISOString(),
      };
      const temporary = `.andi-agent/.selection.${randomUUID()}.tmp`;
      await this.#workspace.write(temporary, `${JSON.stringify(selection, null, 2)}\n`);
      await rename(join(this.#workspace.root, temporary), join(this.#workspace.root, SELECTION_PATH));
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

export interface ApplyPersistedSelectionOptions {
  router: Pick<ModelProviderRouter, "availableProviders" | "currentProvider" | "selectProvider" | "selectModel">;
  catalogs: ReadonlyMap<string, Pick<ModelCatalogManager, "listModels">>;
  selection: ModelSelection | undefined;
}

/**
 * Restores the remembered (provider, model) pair. The selection file records the
 * user's most recent interactive switch, so it intentionally outranks .env
 * defaults (Bun auto-loads .env, which ships these keys in .env.example and
 * would otherwise silently pin every restart to the construction default).
 * Deleting .andi-agent/selection.json returns to .env/built-in defaults.
 */
export async function applyPersistedModelSelection(options: ApplyPersistedSelectionOptions): Promise<boolean> {
  const { router, catalogs, selection } = options;
  if (!selection) return false;
  const provider = selection.provider as AgentProvider;
  if (!router.availableProviders().includes(provider)) return false;
  let applied = false;
  if (router.currentProvider !== provider) {
    router.selectProvider(provider);
    applied = true;
  }
  if (router.currentProvider === provider) {
    const catalog = catalogs.get(selection.provider);
    if (!catalog) return applied;
    try {
      await catalog.listModels();
      router.selectModel(selection.model);
      applied = true;
    } catch {
      // Stale model ID or unavailable catalog: keep the configured default.
    }
  }
  return applied;
}

export interface PersistingModelManager {
  readonly currentModel: string;
  readonly currentProvider: AgentProvider;
  availableProviders(): readonly AgentProvider[];
  selectProvider(provider: AgentProvider): Promise<void>;
  listModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  listAllModels(signal?: AbortSignal, refresh?: boolean): Promise<readonly (ModelCatalogEntry & { provider: AgentProvider })[]>;
  refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]>;
  selectModel(id: string): Promise<void>;
  selectQualifiedModel(provider: AgentProvider, id: string): Promise<void>;
}

/** Wraps the router so every successful REPL switch is written to the selection store. */
export function createPersistingModelManager(
  router: Pick<
    ModelProviderRouter,
    | "currentProvider"
    | "currentModel"
    | "availableProviders"
    | "selectProvider"
    | "selectModel"
    | "selectQualifiedModel"
    | "listModels"
    | "listAllModels"
    | "refreshModels"
  >,
  store: ModelSelectionStore,
): PersistingModelManager {
  const persist = (): Promise<void> =>
    store.save(router.currentProvider, router.currentModel).catch(() => undefined);
  return {
    get currentModel() {
      return router.currentModel;
    },
    get currentProvider() {
      return router.currentProvider;
    },
    availableProviders: () => router.availableProviders(),
    listModels: (signal?: AbortSignal) => router.listModels(signal),
    listAllModels: (signal?: AbortSignal, refresh?: boolean) => router.listAllModels(signal, refresh),
    refreshModels: (signal?: AbortSignal) => router.refreshModels(signal),
    async selectProvider(provider) {
      await router.selectProvider(provider);
      await persist();
    },
    async selectModel(id) {
      await router.selectModel(id);
      await persist();
    },
    async selectQualifiedModel(provider, id) {
      await router.selectQualifiedModel(provider, id);
      await persist();
    },
  };
}

function parseSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) return undefined;
  try {
    return {
      provider: validateProvider(value.provider),
      model: validateModel(value.model),
      updatedAt: value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function validateProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalized)) throw new Error(`Invalid model provider ID: ${provider}`);
  return normalized;
}

function validateModel(model: string): string {
  const normalized = model.trim();
  if (normalized.length === 0 || normalized.length > MAX_MODEL_ID_LENGTH) {
    throw new Error("Model ID must be 1 to 200 characters");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

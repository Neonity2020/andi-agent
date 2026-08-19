import type { ModelCatalogStore } from "./catalog-store";
import type { ModelCatalogEntry, SwitchableModelProvider } from "./types";
import { throwIfAborted } from "../runtime/abort";

export interface ModelCatalogManagerOptions {
  providerId: string;
  source: string;
  provider: SwitchableModelProvider;
  store: ModelCatalogStore;
}

export class ModelCatalogManager {
  readonly #providerId: string;
  readonly #source: string;
  readonly #provider: SwitchableModelProvider;
  readonly #store: ModelCatalogStore;
  #models: ModelCatalogEntry[] | undefined;

  constructor(options: ModelCatalogManagerOptions) {
    this.#providerId = options.providerId;
    this.#source = options.source;
    this.#provider = options.provider;
    this.#store = options.store;
  }

  get currentModel(): string {
    return this.#provider.currentModel;
  }

  async listModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    throwIfAborted(signal);
    if (this.#models) return cloneModels(this.#models);
    const stored = await this.#store.load(this.#providerId, this.#source);
    throwIfAborted(signal);
    if (stored) {
      this.#provider.loadModelCatalog(stored);
      this.#models = stored;
      return cloneModels(stored);
    }
    return this.refreshModels(signal);
  }

  async refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    throwIfAborted(signal);
    const models = await this.#provider.listModels(signal);
    throwIfAborted(signal);
    await this.#store.save(this.#providerId, this.#source, models);
    throwIfAborted(signal);
    this.#models = cloneModels(models);
    return cloneModels(models);
  }

  selectModel(id: string): void {
    this.#provider.selectModel(id);
  }
}

function cloneModels(models: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  return models.map((model) => ({ ...model }));
}

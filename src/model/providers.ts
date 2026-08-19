import type { AgentConfig, AgentProvider, ProviderConfig } from "../config";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { AssistantTurn, CompletionOptions, Message, ModelCatalogEntry, ModelIdentity, ModelProvider, ModelToolDefinition } from "./types";
import type { ModelCatalogManager } from "./catalog-manager";

export const PROVIDER_DEFAULTS = {
  agnes: {
    id: "agnes",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    model: "agnes-2.5-flash",
  },
  minimax: {
    id: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7",
  },
} as const;

export function createModelProvider(
  config: AgentConfig | (ProviderConfig & { provider: AgentProvider }),
): OpenAICompatibleProvider {
  const provider = config.provider ?? "agnes";
  return new OpenAICompatibleProvider({
    apiKey: config.apiKey,
    model: config.model || PROVIDER_DEFAULTS[provider].model,
    baseUrl: config.baseUrl || PROVIDER_DEFAULTS[provider].baseUrl,
    providerId: provider,
  });
}

export function providerId(config: AgentConfig): string {
  return PROVIDER_DEFAULTS[config.provider ?? "agnes"].id;
}

export interface ModelProviderRouterOptions {
  providers: ReadonlyMap<AgentProvider, OpenAICompatibleProvider>;
  catalogs: ReadonlyMap<AgentProvider, ModelCatalogManager>;
  initialProvider: AgentProvider;
}

export interface QualifiedModelCatalogEntry extends ModelCatalogEntry {
  provider: AgentProvider;
}

export class ModelProviderRouter implements ModelProvider {
  readonly #providers: ReadonlyMap<AgentProvider, OpenAICompatibleProvider>;
  readonly #catalogs: ReadonlyMap<AgentProvider, ModelCatalogManager>;
  #activeProvider: AgentProvider;

  constructor(options: ModelProviderRouterOptions) {
    if (!options.providers.has(options.initialProvider)) throw new Error(`Provider '${options.initialProvider}' is not configured`);
    this.#providers = options.providers;
    this.#catalogs = options.catalogs;
    this.#activeProvider = options.initialProvider;
  }

  get currentProvider(): AgentProvider {
    return this.#activeProvider;
  }

  get currentModel(): string {
    return this.#providers.get(this.#activeProvider)!.currentModel;
  }

  getModelIdentity(): ModelIdentity {
    return { provider: this.#activeProvider, model: this.currentModel };
  }

  availableProviders(): AgentProvider[] {
    return [...this.#providers.keys()];
  }

  selectProvider(provider: AgentProvider): void {
    if (!this.#providers.has(provider)) throw new Error(`Provider '${provider}' is not configured`);
    this.#activeProvider = provider;
  }

  async complete(messages: readonly Message[], tools: readonly ModelToolDefinition[], options?: CompletionOptions): Promise<AssistantTurn> {
    return this.#providers.get(this.#activeProvider)!.complete(messages, tools, options);
  }

  listModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    return this.#catalogs.get(this.#activeProvider)!.listModels(signal);
  }

  async listAllModels(signal?: AbortSignal, refresh = false): Promise<QualifiedModelCatalogEntry[]> {
    const all: QualifiedModelCatalogEntry[] = [];
    for (const provider of this.#providers.keys()) {
      const catalog = this.#catalogs.get(provider)!;
      const models = refresh ? await catalog.refreshModels(signal) : await catalog.listModels(signal);
      all.push(...models.map((model) => ({ ...model, provider })));
    }
    return all;
  }

  refreshModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    return this.#catalogs.get(this.#activeProvider)!.refreshModels(signal);
  }

  selectModel(id: string): void {
    this.#catalogs.get(this.#activeProvider)!.selectModel(id);
  }

  selectQualifiedModel(provider: AgentProvider, id: string): void {
    this.selectProvider(provider);
    this.#catalogs.get(provider)!.selectModel(id);
  }
}

export function providerConfig(config: AgentConfig, provider: AgentProvider): ProviderConfig | undefined {
  return config.providers?.[provider];
}

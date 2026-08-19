import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { ModelCatalogEntry } from "./types";
import type { Workspace } from "../tools/workspace";

const CATALOG_PATH = ".andi-agent/models.json";
const MAX_FILE_CHARS = 1_000_000;
const MAX_PROVIDERS = 50;
const MAX_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_OWNER_LENGTH = 120;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface StoredProviderCatalog {
  id: string;
  source: string;
  updatedAt: string;
  models: ModelCatalogEntry[];
}

interface StoredModelCatalog {
  version: 1;
  providers: StoredProviderCatalog[];
}

export class ModelCatalogStore {
  readonly #workspace: Workspace;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async load(providerId: string, source: string): Promise<ModelCatalogEntry[] | undefined> {
    validateProviderId(providerId);
    const normalizedSource = normalizeModelSource(source);
    const catalog = await this.#read();
    const provider = catalog?.providers.find(
      (entry) => entry.id === providerId && entry.source === normalizedSource,
    );
    return provider ? provider.models.map((model) => ({ ...model })) : undefined;
  }

  async save(providerId: string, source: string, models: readonly ModelCatalogEntry[]): Promise<void> {
    validateProviderId(providerId);
    const normalizedSource = normalizeModelSource(source);
    const normalizedModels = validateModels(models);
    const operation = this.#writeQueue.then(async () => {
      const current = (await this.#read()) ?? { version: 1 as const, providers: [] };
      const providers = current.providers.filter((entry) => entry.id !== providerId);
      providers.push({
        id: providerId,
        source: normalizedSource,
        updatedAt: new Date().toISOString(),
        models: normalizedModels,
      });
      providers.sort((left, right) => left.id.localeCompare(right.id));
      if (providers.length > MAX_PROVIDERS) throw new Error(`Model catalog exceeds ${MAX_PROVIDERS} providers`);
      await this.#write({ version: 1, providers });
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async #read(): Promise<StoredModelCatalog | undefined> {
    let content: string;
    try {
      content = await this.#workspace.read(CATALOG_PATH);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (content.length > MAX_FILE_CHARS) return undefined;
    try {
      return parseCatalog(JSON.parse(content) as unknown);
    } catch {
      return undefined;
    }
  }

  async #write(catalog: StoredModelCatalog): Promise<void> {
    const temporary = `.andi-agent/.models.${randomUUID()}.tmp`;
    await this.#workspace.write(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
    await rename(join(this.#workspace.root, temporary), join(this.#workspace.root, CATALOG_PATH));
  }
}

export function normalizeModelSource(source: string): string {
  const url = new URL(source);
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function parseCatalog(value: unknown): StoredModelCatalog | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.providers)) return undefined;
  if (value.providers.length > MAX_PROVIDERS) return undefined;
  const providers: StoredProviderCatalog[] = [];
  const ids = new Set<string>();
  for (const entry of value.providers) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.source !== "string") return undefined;
    if (typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt))) return undefined;
    if (!Array.isArray(entry.models) || ids.has(entry.id)) return undefined;
    try {
      validateProviderId(entry.id);
      const source = normalizeModelSource(entry.source);
      const models = validateModels(entry.models);
      ids.add(entry.id);
      providers.push({ id: entry.id, source, updatedAt: entry.updatedAt, models });
    } catch {
      return undefined;
    }
  }
  return { version: 1, providers };
}

function validateModels(values: readonly unknown[]): ModelCatalogEntry[] {
  if (values.length === 0 || values.length > MAX_MODELS) {
    throw new Error(`Model catalog must contain 1 to ${MAX_MODELS} models`);
  }
  const seen = new Set<string>();
  return values.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string") throw new Error("Model catalog contains an invalid model");
    const id = value.id.trim();
    if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) {
      throw new Error("Model catalog contains an invalid or duplicate model ID");
    }
    if (value.ownedBy !== undefined && (typeof value.ownedBy !== "string" || value.ownedBy.length > MAX_OWNER_LENGTH)) {
      throw new Error("Model catalog contains an invalid owner");
    }
    seen.add(id);
    return { id, ...(value.ownedBy ? { ownedBy: value.ownedBy } : {}) };
  });
}

function validateProviderId(providerId: string): void {
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error(`Invalid model provider ID: ${providerId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

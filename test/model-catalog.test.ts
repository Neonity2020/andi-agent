import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogManager } from "../src/model/catalog-manager";
import { ModelCatalogStore, normalizeModelSource } from "../src/model/catalog-store";
import type {
  AssistantTurn,
  CompletionOptions,
  Message,
  ModelCatalogEntry,
  ModelToolDefinition,
  SwitchableModelProvider,
} from "../src/model/types";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ store: ModelCatalogStore; workspace: Workspace }> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-models-"));
  temporaryDirectories.push(directory);
  const workspace = await Workspace.create(directory);
  return { store: new ModelCatalogStore(workspace), workspace };
}

class FakeSwitchableProvider implements SwitchableModelProvider {
  currentModel = "agnes-2.5-flash";
  networkModels: ModelCatalogEntry[] = [{ id: "agnes-2.5-flash" }, { id: "agnes-2.5-pro" }];
  listCalls = 0;
  loadedCatalogs: ModelCatalogEntry[][] = [];
  failListing = false;
  #selectable = new Set<string>();

  async listModels(): Promise<ModelCatalogEntry[]> {
    this.listCalls += 1;
    if (this.failListing) throw new Error("provider unavailable");
    this.loadModelCatalog(this.networkModels);
    return this.networkModels.map((model) => ({ ...model }));
  }

  loadModelCatalog(models: readonly ModelCatalogEntry[]): void {
    this.loadedCatalogs.push(models.map((model) => ({ ...model })));
    this.#selectable = new Set(models.map((model) => model.id));
  }

  selectModel(id: string): void {
    if (!this.#selectable.has(id)) throw new Error("not selectable");
    this.currentModel = id;
  }

  async complete(
    _messages: readonly Message[],
    _tools: readonly ModelToolDefinition[],
    _options?: CompletionOptions,
  ): Promise<AssistantTurn> {
    return { content: "ok", toolCalls: [] };
  }
}

describe("ModelCatalogStore", () => {
  test("atomically stores multiple providers and isolates entries by source", async () => {
    const { store, workspace } = await setup();
    await Promise.all([
      store.save("agnes", "https://agnes.test/v1/", [{ id: "agnes-2.5-flash", ownedBy: "agnes" }]),
      store.save("openai", "https://api.openai.test/v1", [{ id: "gpt-5" }]),
    ]);

    expect(await store.load("agnes", "https://agnes.test/v1")).toEqual([
      { id: "agnes-2.5-flash", ownedBy: "agnes" },
    ]);
    expect(await store.load("openai", "https://api.openai.test/v1/")).toEqual([{ id: "gpt-5" }]);
    expect(await store.load("agnes", "https://other.test/v1")).toBeUndefined();
    const persisted = JSON.parse(await workspace.read(".andi-agent/models.json")) as {
      version: number;
      providers: unknown[];
    };
    expect(persisted.version).toBe(1);
    expect(persisted.providers).toHaveLength(2);
    expect(() => workspace.assertToolPath(".andi-agent/models.json")).toThrow("reserved");
  });

  test("treats malformed and unknown-version files as cache misses", async () => {
    const { store, workspace } = await setup();
    await workspace.write(".andi-agent/models.json", "{bad json");
    expect(await store.load("agnes", "https://agnes.test/v1")).toBeUndefined();

    await workspace.write(".andi-agent/models.json", JSON.stringify({ version: 2, providers: [] }));
    expect(await store.load("agnes", "https://agnes.test/v1")).toBeUndefined();

    await store.save("agnes", "https://agnes.test/v1", [{ id: "agnes-2.5-flash" }]);
    expect(await store.load("agnes", "https://agnes.test/v1")).toEqual([{ id: "agnes-2.5-flash" }]);
  });

  test("validates provider identities, sources, and model entries", async () => {
    const { store } = await setup();
    await expect(store.save("../agnes", "https://agnes.test/v1", [{ id: "model" }])).rejects.toThrow(
      "Invalid model provider ID",
    );
    await expect(store.save("agnes", "not a url", [{ id: "model" }])).rejects.toThrow();
    await expect(store.save("agnes", "https://agnes.test/v1", [{ id: "same" }, { id: "same" }])).rejects.toThrow(
      "duplicate",
    );
    expect(normalizeModelSource("https://agnes.test/v1/?secret=removed#fragment")).toBe(
      "https://agnes.test/v1",
    );
  });
});

describe("ModelCatalogManager", () => {
  test("fetches on the first miss, then a new instance loads disk without provider traffic", async () => {
    const { store } = await setup();
    const firstProvider = new FakeSwitchableProvider();
    const first = new ModelCatalogManager({
      providerId: "agnes",
      source: "https://agnes.test/v1",
      provider: firstProvider,
      store,
    });

    expect(await first.listModels()).toEqual(firstProvider.networkModels);
    expect(await first.listModels()).toEqual(firstProvider.networkModels);
    expect(firstProvider.listCalls).toBe(1);

    const secondProvider = new FakeSwitchableProvider();
    secondProvider.networkModels = [{ id: "should-not-be-requested" }];
    const second = new ModelCatalogManager({
      providerId: "agnes",
      source: "https://agnes.test/v1/",
      provider: secondProvider,
      store,
    });

    expect(await second.listModels()).toEqual(firstProvider.networkModels);
    expect(secondProvider.listCalls).toBe(0);
    second.selectModel("agnes-2.5-pro");
    expect(second.currentModel).toBe("agnes-2.5-pro");
  });

  test("explicit refresh replaces the provider cache and failures keep the previous memory catalog", async () => {
    const { store } = await setup();
    const provider = new FakeSwitchableProvider();
    const manager = new ModelCatalogManager({
      providerId: "agnes",
      source: "https://agnes.test/v1",
      provider,
      store,
    });
    await manager.listModels();
    provider.networkModels = [{ id: "agnes-3.0-pro" }];

    expect(await manager.refreshModels()).toEqual([{ id: "agnes-3.0-pro" }]);
    expect(provider.listCalls).toBe(2);
    provider.failListing = true;
    await expect(manager.refreshModels()).rejects.toThrow("provider unavailable");
    expect(await manager.listModels()).toEqual([{ id: "agnes-3.0-pro" }]);

    const reloadedProvider = new FakeSwitchableProvider();
    const reloaded = new ModelCatalogManager({
      providerId: "agnes",
      source: "https://agnes.test/v1",
      provider: reloadedProvider,
      store,
    });
    expect(await reloaded.listModels()).toEqual([{ id: "agnes-3.0-pro" }]);
    expect(reloadedProvider.listCalls).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelSelectionStore,
  applyPersistedModelSelection,
  createPersistingModelManager,
  type ModelSelection,
} from "../src/model/selection-store";
import type { AgentProvider } from "../src/config";
import type { ModelCatalogEntry } from "../src/model/types";
import { Workspace } from "../src/tools/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(): Promise<{ store: ModelSelectionStore; workspace: Workspace }> {
  const directory = await mkdtemp(join(tmpdir(), "andi-agent-selection-"));
  temporaryDirectories.push(directory);
  const workspace = await Workspace.create(directory);
  return { store: new ModelSelectionStore(workspace), workspace };
}

class FakeRouter {
  currentProvider: AgentProvider = "agnes";
  currentModel = "agnes-2.5-flash";
  readonly #selectable = new Set<string>();

  constructor(selectable: readonly string[]) {
    for (const id of selectable) this.#selectable.add(id);
  }

  availableProviders(): AgentProvider[] {
    return ["agnes", "minimax"];
  }

  selectProvider(provider: AgentProvider): void {
    if (!this.availableProviders().includes(provider)) throw new Error("not configured");
    this.currentProvider = provider;
  }

  selectModel(id: string): void {
    if (!this.#selectable.has(id)) throw new Error("not selectable");
    this.currentModel = id;
  }

  selectQualifiedModel(provider: AgentProvider, id: string): void {
    this.selectProvider(provider);
    this.selectModel(id);
  }

  listModels(): Promise<ModelCatalogEntry[]> {
    return Promise.resolve([]);
  }

  listAllModels(): Promise<Array<ModelCatalogEntry & { provider: AgentProvider }>> {
    return Promise.resolve([]);
  }

  refreshModels(): Promise<ModelCatalogEntry[]> {
    return Promise.resolve([]);
  }
}

class FakeCatalog {
  failListing = false;

  async listModels(): Promise<ModelCatalogEntry[]> {
    if (this.failListing) throw new Error("provider unavailable");
    return [];
  }
}

describe("ModelSelectionStore", () => {
  test("round-trips the last selected provider and model", async () => {
    const { store } = await setup();

    expect(await store.load()).toBeUndefined();
    await store.save("minimax", "MiniMax-M3");

    const selection = await store.load();
    expect(selection?.provider).toBe("minimax");
    expect(selection?.model).toBe("MiniMax-M3");
    expect(Number.isNaN(Date.parse(selection?.updatedAt ?? ""))).toBeFalse();
  });

  test("treats missing or corrupt files as no selection", async () => {
    const { store, workspace } = await setup();
    await mkdir(join(workspace.root, ".andi-agent"), { recursive: true });
    await writeFile(join(workspace.root, ".andi-agent/selection.json"), "{ not json");

    expect(await store.load()).toBeUndefined();
  });
});

describe("applyPersistedModelSelection", () => {
  test("restores the remembered provider and model", async () => {
    const router = new FakeRouter(["agnes-2.5-flash", "MiniMax-M3"]);
    const catalogs = new Map([["minimax", new FakeCatalog()]]);
    const selection: ModelSelection = { provider: "minimax", model: "MiniMax-M3", updatedAt: new Date().toISOString() };

    const applied = await applyPersistedModelSelection({ router, catalogs, selection });

    expect(applied).toBeTrue();
    expect(router.currentProvider).toBe("minimax");
    expect(router.currentModel).toBe("MiniMax-M3");
  });

  test("restores even when the construction defaults come from .env-style config", async () => {
    const router = new FakeRouter(["agnes-2.5-flash", "MiniMax-M3"]);
    const catalogs = new Map([["minimax", new FakeCatalog()]]);
    const selection: ModelSelection = { provider: "minimax", model: "MiniMax-M3", updatedAt: new Date().toISOString() };

    await applyPersistedModelSelection({ router, catalogs, selection });

    expect(router.currentProvider).toBe("minimax");
    expect(router.currentModel).toBe("MiniMax-M3");
  });

  test("ignores selections for unconfigured providers", async () => {
    const router = new FakeRouter(["agnes-2.5-flash"]);
    const applied = await applyPersistedModelSelection({
      router,
      catalogs: new Map(),
      selection: { provider: "openai", model: "gpt-9", updatedAt: new Date().toISOString() },
    });

    expect(applied).toBeFalse();
    expect(router.currentProvider).toBe("agnes");
    expect(router.currentModel).toBe("agnes-2.5-flash");
  });

  test("falls back to the default when the remembered model is stale or listing fails", async () => {
    const staleRouter = new FakeRouter(["MiniMax-M2.7"]);
    const failingCatalog = new FakeCatalog();
    failingCatalog.failListing = true;

    const staleApplied = await applyPersistedModelSelection({
      router: staleRouter,
      catalogs: new Map([["minimax", new FakeCatalog()]]),
      selection: { provider: "minimax", model: "MiniMax-M3", updatedAt: new Date().toISOString() },
    });
    const failingRouter = new FakeRouter(["MiniMax-M3"]);
    const failedApplied = await applyPersistedModelSelection({
      router: failingRouter,
      catalogs: new Map([["minimax", failingCatalog]]),
      selection: { provider: "minimax", model: "MiniMax-M3", updatedAt: new Date().toISOString() },
    });

    expect(staleApplied).toBeTrue();
    expect(staleRouter.currentProvider).toBe("minimax");
    expect(staleRouter.currentModel).toBe("agnes-2.5-flash");
    expect(failedApplied).toBeTrue();
    expect(failingRouter.currentModel).toBe("agnes-2.5-flash");
  });
});

describe("createPersistingModelManager", () => {
  test("persists every successful switch and exposes live state", async () => {
    const { store } = await setup();
    const router = new FakeRouter(["agnes-2.5-flash", "agnes-2.5-pro", "MiniMax-M3"]);
    const manager = createPersistingModelManager(router, store);

    expect(manager.currentProvider).toBe("agnes");
    expect(manager.currentModel).toBe("agnes-2.5-flash");

    await manager.selectQualifiedModel("minimax", "MiniMax-M3");
    let selection = await store.load();
    expect(selection?.provider).toBe("minimax");
    expect(selection?.model).toBe("MiniMax-M3");

    router.selectProvider("agnes");
    await manager.selectModel("agnes-2.5-pro");
    selection = await store.load();
    expect(selection?.provider).toBe("agnes");
    expect(selection?.model).toBe("agnes-2.5-pro");
    expect(manager.currentProvider).toBe("agnes");
    expect(manager.currentModel).toBe("agnes-2.5-pro");
  });
});

import { describe, expect, test } from "bun:test";
import { createWebSearchTool, searchExa } from "../src/tools/web-search";
import { ToolRegistry } from "../src/tools/registry";

describe("Exa web search", () => {
  test("sends the documented request and returns bounded structured results", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return Response.json({
        requestId: "request-1",
        results: [
          {
            title: "Official docs",
            url: "https://example.com/docs",
            publishedDate: "2026-08-19T00:00:00.000Z",
            author: "Example",
            highlights: ["a".repeat(2_000), "second", "third", "ignored fourth"],
          },
          { title: "missing URL" },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await searchExa(
      { apiKey: "exa-secret", baseUrl: "https://api.exa.test/", fetcher },
      { query: "  latest Bun release  ", numResults: 3, includeDomains: ["bun.sh/docs"] },
    );
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    const headers = requestInit?.headers as Record<string, string>;

    expect(requestUrl).toBe("https://api.exa.test/search");
    expect(headers["x-api-key"]).toBe("exa-secret");
    expect(body).toEqual({
      query: "latest Bun release",
      type: "auto",
      numResults: 3,
      includeDomains: ["bun.sh/docs"],
      contents: { highlights: true },
    });
    expect(result.requestId).toBe("request-1");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.highlights).toHaveLength(3);
    expect(result.results[0]?.highlights[0]).toHaveLength(1_500);
  });

  test("validates model-facing arguments", async () => {
    const registry = new ToolRegistry([
      createWebSearchTool({
        apiKey: "key",
        fetcher: (async () => Response.json({ results: [] })) as unknown as typeof fetch,
      }),
    ]);

    expect(registry.definitions()[0]?.name).toBe("web_search");
    expect(await registry.execute("web_search", JSON.stringify({ query: "x", num_results: 11 }))).toEqual({
      ok: false,
      error: "numResults must be an integer from 1 to 10",
    });
    const invalidDomain = await registry.execute(
      "web_search",
      JSON.stringify({ query: "x", include_domains: ["https://example.com"] }),
    );
    expect(invalidDomain).toMatchObject({ ok: false });
  });

  test("redacts the API key from HTTP and network errors", async () => {
    const httpFetcher = (async () => new Response("invalid key exa-secret", { status: 401 })) as unknown as typeof fetch;
    await expect(searchExa({ apiKey: "exa-secret", fetcher: httpFetcher }, { query: "test" })).rejects.toThrow(
      "invalid key [REDACTED]",
    );

    const networkFetcher = (async () => {
      throw new Error("request failed with exa-secret");
    }) as unknown as typeof fetch;
    await expect(
      searchExa({ apiKey: "exa-secret", fetcher: networkFetcher }, { query: "test" }),
    ).rejects.toThrow("request failed with [REDACTED]");
  });

  test("distinguishes timeout from user cancellation", async () => {
    const createWaitingFetcher = (notifyStarted?: () => void) =>
      ((async (_url: string | URL | Request, init?: RequestInit) => {
        notifyStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      }) as unknown as typeof fetch);

    await expect(
      searchExa({ apiKey: "key", fetcher: createWaitingFetcher(), timeoutMs: 5 }, { query: "wait" }),
    ).rejects.toThrow("timed out after 5ms");

    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const controller = new AbortController();
    const running = searchExa(
      { apiKey: "key", fetcher: createWaitingFetcher(() => notifyStarted?.()), timeoutMs: 1_000 },
      { query: "wait" },
      controller.signal,
    );
    await started;
    controller.abort();

    await expect(running).rejects.toThrow("Operation cancelled");
  });

  test("rejects malformed successful responses", async () => {
    const invalidJson = (async () => new Response("not json")) as unknown as typeof fetch;
    await expect(searchExa({ apiKey: "key", fetcher: invalidJson }, { query: "test" })).rejects.toThrow(
      "invalid JSON",
    );
    const invalidShape = (async () => Response.json({ results: "wrong" })) as unknown as typeof fetch;
    await expect(searchExa({ apiKey: "key", fetcher: invalidShape }, { query: "test" })).rejects.toThrow(
      "invalid response",
    );
  });
});

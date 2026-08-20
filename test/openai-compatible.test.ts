import { describe, expect, test } from "bun:test";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible";

describe("OpenAICompatibleProvider", () => {
  test("sends an Agnes-compatible tool request and parses the tool call", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: "agnes-test-key",
      model: "agnes-2.5-flash",
      baseUrl: "https://apihub.agnes-ai.com/v1/",
      fetcher,
    });

    const result = await provider.complete(
      [{ role: "user", content: "Read the README" }],
      [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
    );

    expect(requestUrl).toBe("https://apihub.agnes-ai.com/v1/chat/completions");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer agnes-test-key");
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: "agnes-2.5-flash",
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(result).toEqual({
      content: null,
      toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
  });

  test("streams text and reconstructs fragmented tool calls", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"README.md\\"}"}}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(events);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 37));
        controller.enqueue(bytes.subarray(37, 121));
        controller.enqueue(bytes.subarray(121));
        controller.close();
      },
    });
    let requestBody: Record<string, unknown> = {};
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "agnes-2.5-flash",
      fetcher,
    });
    const deltas: string[] = [];

    const result = await provider.complete([{ role: "user", content: "read" }], [], {
      onTextDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(requestBody.stream).toBeTrue();
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toEqual({
      content: "Hello",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });
  });

  test("parses provider prompt-cache usage details", async () => {
    const fetcher = (async () => Response.json({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 8,
        total_tokens: 108,
        prompt_tokens_details: { cached_tokens: 72 },
      },
      choices: [{ message: { content: "cached", tool_calls: [] } }],
    })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ apiKey: "test-key", model: "test", fetcher });

    const result = await provider.complete([{ role: "user", content: "read" }], []);

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 8,
      totalTokens: 108,
      cachedInputTokens: 72,
    });
  });

  test("cancels an active SSE reader", async () => {
    let readerCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        readerCancelled = true;
      },
    });
    const fetcher = (async () => new Response(body)) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ apiKey: "test-key", model: "agnes-2.5-flash", fetcher });
    const controller = new AbortController();
    const completion = provider.complete([{ role: "user", content: "wait" }], [], {
      onTextDelta() {},
      signal: controller.signal,
    });

    await Bun.sleep(0);
    controller.abort();

    await expect(completion).rejects.toThrow();
    await Bun.sleep(0);
    expect(readerCancelled).toBeTrue();
  });

  test("lists selectable chat models and switches subsequent completions", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/models")) {
        return Response.json({
          data: [
            { id: "agnes-2.5-flash", owned_by: "agnes" },
            { id: "agnes-image-2.1-flash", owned_by: "agnes" },
            { id: "agnes-video-v2.0", owned_by: "agnes" },
            { id: "agnes-2.5-pro" },
            { id: "agnes-2.5-pro" },
            { id: 42 },
          ],
        });
      }
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: "agnes-test-key",
      model: "agnes-2.5-flash",
      baseUrl: "https://example.test/v1/",
      fetcher,
    });

    const models = await provider.listModels();
    provider.selectModel("agnes-2.5-pro");
    await provider.complete([{ role: "user", content: "hello" }], []);

    expect(models).toEqual([
      { id: "agnes-2.5-flash", ownedBy: "agnes" },
      { id: "agnes-2.5-pro" },
    ]);
    expect(provider.currentModel).toBe("agnes-2.5-pro");
    expect(requests[0]?.url).toBe("https://example.test/v1/models");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer agnes-test-key");
    expect(JSON.parse(String(requests[1]?.init?.body)).model).toBe("agnes-2.5-pro");
  });

  test("only selects models returned by the latest catalog", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "agnes-2.5-flash",
      fetcher: (async () => Response.json({ data: [{ id: "agnes-2.5-pro" }] })) as unknown as typeof fetch,
    });

    expect(() => provider.selectModel("agnes-2.5-pro")).toThrow("List models before selecting one");
    await provider.listModels();
    expect(() => provider.selectModel("unknown-model")).toThrow("not in the current selectable model list");
    expect(provider.currentModel).toBe("agnes-2.5-flash");
  });

  test("rejects malformed or non-chat-only model catalogs", async () => {
    const malformed = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "agnes-2.5-flash",
      fetcher: (async () => Response.json({ models: [] })) as unknown as typeof fetch,
    });
    const nonChat = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "agnes-2.5-flash",
      fetcher: (async () => Response.json({ data: [{ id: "agnes-image-2.0-flash" }] })) as unknown as typeof fetch,
    });

    await expect(malformed.listModels()).rejects.toThrow("invalid response");
    await expect(nonChat.listModels()).rejects.toThrow("did not contain any Chat Completions models");
  });

  test("times out model listing and redacts credentials from failures", async () => {
    const hangingFetcher = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const timed = new OpenAICompatibleProvider({
      apiKey: "top-secret-key",
      model: "agnes-2.5-flash",
      fetcher: hangingFetcher,
      modelListTimeoutMs: 5,
    });
    const failed = new OpenAICompatibleProvider({
      apiKey: "top-secret-key",
      model: "agnes-2.5-flash",
      fetcher: (async () => {
        throw new Error("upstream exposed top-secret-key");
      }) as unknown as typeof fetch,
    });

    await expect(timed.listModels()).rejects.toThrow("timed out after 5ms");
    const failure = failed.listModels().catch((error: unknown) => error);
    expect(String(await failure)).toContain("[REDACTED]");
    expect(String(await failure)).not.toContain("top-secret-key");
  });

  test("propagates caller cancellation while listing models", async () => {
    const fetcher = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      model: "agnes-2.5-flash",
      fetcher,
    });
    const controller = new AbortController();
    const listing = provider.listModels(controller.signal);

    controller.abort(new Error("stop listing"));

    await expect(listing).rejects.toThrow("stop listing");
  });
});

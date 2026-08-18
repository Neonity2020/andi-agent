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
    });
  });

  test("streams text and reconstructs fragmented tool calls", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"README.md\\"}"}}]}}]}\n\n',
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
    });
  });
});

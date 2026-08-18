import { describe, expect, test } from "bun:test";
import { compactMessages } from "../src/context";
import type { Message } from "../src/model/types";

describe("compactMessages", () => {
  test("keeps complete recent user turns", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old".repeat(100) },
      { role: "assistant", content: "old answer", toolCalls: [] },
      { role: "user", content: "new" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call-1", name: "read_file", content: "result" },
    ];

    const result = compactMessages(messages, 250);

    expect(result.droppedMessages).toBe(2);
    expect(result.messages.some((message) => message.role === "user" && message.content === "new")).toBeTrue();
    expect(result.messages.at(-1)?.role).toBe("tool");

    const nextPass = compactMessages(result.messages, 10_000);
    expect(nextPass.droppedMessages).toBe(0);
    expect(nextPass.messages.some((message) => message.role === "system" && message.content.includes("omitted"))).toBeTrue();
  });

  test("does not compact when the history fits", () => {
    const messages: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];
    expect(compactMessages(messages, 10_000)).toEqual({ messages, droppedMessages: 0 });
  });
});

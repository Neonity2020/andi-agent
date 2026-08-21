import type { KnowledgeStore } from "../knowledge/store";
import type { KnowledgeStatus } from "../knowledge/types";
import type { Tool } from "./types";
import { requireRecord, requireString, requireStringArray } from "./validation";

export interface KnowledgeToolOptions {
  writable?: boolean;
}

export function createKnowledgeTools(store: KnowledgeStore, options: KnowledgeToolOptions = {}): Tool[] {
  const tools: Tool[] = [
    {
      name: "knowledge_search",
      description: "搜索本地 LLM Wiki，优先复用已有知识条目。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要查找的概念、Provider、技术或问题" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input) {
        const values = requireRecord(input);
        const limit = values.limit === undefined ? 10 : values.limit;
        if (!Number.isInteger(limit)) throw new Error("字段 'limit' 必须是整数");
        return { matches: await store.search(requireString(values, "query"), limit as number) };
      },
    },
    {
      name: "knowledge_read",
      description: "读取一条本地 LLM Wiki 原子知识条目。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "knowledge_search 返回的知识条目 ID" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input) {
        return store.read(requireString(requireRecord(input), "id"));
      },
    },
  ];
  if (options.writable !== false) {
    tools.push({
      name: "knowledge_capture",
      description:
        "将经过网页来源核对的知识写入本地 LLM Wiki。只有用户明确要求研究、建立或更新知识体系时才能使用；必须提供来源 URL、原子 ID、摘要和事实正文。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "小写层级 ID，例如 providers/agnes 或 concepts/prompt-caching" },
          title: { type: "string", description: "知识条目标题" },
          category: { type: "string", description: "小写分类，例如 providers、concepts、operations" },
          type: { type: "string", description: "条目类型，例如 provider、concept、guide" },
          status: { type: "string", enum: ["verified", "reference", "needs-review"] },
          summary: { type: "string", description: "一行摘要，帮助 MOC 导航" },
          tags: { type: "array", items: { type: "string" }, description: "检索标签" },
          sources: { type: "array", items: { type: "string" }, description: "已核对的 HTTP(S) 来源 URL" },
          related: { type: "array", items: { type: "string" }, description: "相关知识条目 ID" },
          content: { type: "string", description: "原子事实、限制、接入方式和推理结论，不要复制整篇网页" },
          expected_updated: { type: "string", description: "更新已有条目时，填 knowledge_read 返回的 updated" },
        },
        required: ["id", "title", "category", "summary", "tags", "sources", "content"],
        additionalProperties: false,
      },
      async execute(input) {
        const values = requireRecord(input);
        const status = values.status === undefined ? undefined : requireString(values, "status");
        if (status !== undefined && !["verified", "reference", "needs-review"].includes(status)) {
          throw new Error("字段 'status' 无效");
        }
        const expectedUpdated = values.expected_updated === undefined ? undefined : requireString(values, "expected_updated");
        return store.capture({
          id: requireString(values, "id"),
          title: requireString(values, "title"),
          category: requireString(values, "category"),
          ...(values.type === undefined ? {} : { type: requireString(values, "type") }),
          ...(status === undefined ? {} : { status: status as KnowledgeStatus }),
          summary: requireString(values, "summary"),
          tags: requireStringArray(values, "tags"),
          sources: requireStringArray(values, "sources"),
          ...(values.related === undefined ? {} : { related: requireStringArray(values, "related") }),
          content: requireString(values, "content"),
          ...(expectedUpdated === undefined ? {} : { expectedUpdated }),
        });
      },
    });
  }
  return tools;
}

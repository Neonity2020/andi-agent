# andi-agent 本地知识库 (Knowledge Base)

> 设计理念：**Karpathy「LLM OS」——不要把文档一次性塞进上下文（RAM），而是维护一个瘦索引，模型需要时再把指定文档按需分页加载到上下文。**
>
> 用法：先读本清单（`kb/README.md`）建立全局认知 → 任务需要某类细节时，用 `read_file` 只加载对应的小文档。

---

## 何时使用

| 触发场景 | 做法 |
|---|---|
| 任务涉及模型提供商的端点、模型名、鉴权、协议 | 加载 `kb/providers/<provider>.md` |
| 需要查询知识库有没有相关内容 | 先扫描下方「目录」判断，再精准加载，不要整库读入 |
| 不确定该看哪篇、想按需求选型 | 加载 `kb/MOC.md`（内容地图，按需求→文档导航），再落到对应单篇 |
| 与当前任务无关 | 不加载，保持上下文精简 |

## 违反的坏做法

- ❌ 把整本知识库一次性拼进 system prompt / 上下文 —— 违背按需分页理念，浪费上下文预算
- ❌ 凭印象编造端点、模型名、鉴权变量 —— 文档存在就该以文档为准

---

## 文件规范（Karpathy 风格）

1. **单一主题、独立成文**：每份文档只讲一个话题，可在需要时单独加载，不互相依赖。
2. **前置元数据（front-matter）**：文件以 `---` 包裹的 YAML 开头，便于机器扫描和检索，字段见下方。
3. **直奔事实、简短果断**：用表格和要点，避免冗长铺垫；写清 `端点 / 模型 / 鉴权 / 协议 / 注意事项`。
4. **`updated` 日期**：改过配置文档就更新，供判断时效。

### 元数据字段

| 字段 | 说明 |
|---|---|
| `title` | 条目名称 |
| `category` | 所属分类（`providers` 等） |
| `proto` | 线协议：`openai-compatible` 或 `native` |
| `endpoint` | base URL（不含路径尾斜杠） |
| `auth` | 鉴权所需的环境变量名 |
| `models` | 常用模型标识（逗号分隔，可能随厂商更新） |
| `updated` | 最近更新时间 |

---

## 目录

### providers — 模型提供商配置

| 文件 | 提供商 | 协议 | 鉴权 env |
|---|---|---|---|
| `providers/agnes.md` | Agnes (默认) | openai-compatible | `AGNES_API_KEY` |
| `providers/openai.md` | OpenAI | openai-compatible | `OPENAI_API_KEY` |
| `providers/deepseek.md` | DeepSeek | openai-compatible | `DEEPSEEK_API_KEY` |
| `providers/moonshot.md` | Moonshot (Kimi) | openai-compatible | `MOONSHOT_API_KEY` |
| `providers/zhipu.md` | 智谱 GLM (BigModel) | openai-compatible | `ZHIPU_API_KEY` |
| `providers/mistral.md` | Mistral | openai-compatible | `MISTRAL_API_KEY` |
| `providers/groq.md` | Groq | openai-compatible | `GROQ_API_KEY` |
| `providers/together.md` | Together | openai-compatible | `TOGETHER_API_KEY` |
| `providers/ollama.md` | Ollama (本地) | openai-compatible | 无 |
| `providers/anthropic.md` | Anthropic Claude | native（需适配层） | `ANTHROPIC_API_KEY` |
| `providers/gemini.md` | Google Gemini | native（需适配层） | `GEMINI_API_KEY` |

> `native` 协议（Anthropic `/v1/messages`、Gemini `generateContent`）与本项目当前的
> `OpenAICompatibleProvider` 不直接兼容，需在 `src/model/` 新增适配层后才能切换。OpenAI 兼容类
> 提供商可直接通过 `AGENT_BASE_URL` / `AGENT_MODEL` / `AGENT_API_KEY` 覆盖默认 Agnes 连接。

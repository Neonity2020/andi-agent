# andi-agent LLM Wiki

> 设计理念：**Karpathy「LLM OS」——不要把文档一次性塞进上下文（RAM），而是维护一个瘦索引，模型需要时再把指定文档按需分页加载到上下文。**
>
> 用法：先读本说明建立全局认知 → 通过 `MOC.md` 导航 → 用 `read_file` 只加载需要的原子条目。

本目录是 Agent 的稳定、可提交内部知识库，不是运行时记忆，也不是对话历史。

---

## 何时使用

| 触发场景 | 做法 |
|---|---|
| 任务涉及模型提供商的端点、模型名、鉴权、协议 | 通过 MOC 加载 `kb/providers/<provider>.md` |
| 需要查询知识库有没有相关内容 | 先扫描下方「目录」判断，再精准加载，不要整库读入 |
| 不确定该看哪篇、想按需求选型 | 加载 `kb/MOC.md`（内容地图，按需求→文档导航），再落到对应单篇 |
| 与当前任务无关 | 不加载，保持上下文精简 |

## 违反的坏做法

- ❌ 把整本知识库一次性拼进 system prompt / 上下文 —— 违背按需分页理念，浪费上下文预算
- ❌ 凭印象编造端点、模型名、鉴权变量 —— 文档存在就该以文档为准

---

## Wiki 分层

| 层级 | 文件 | 作用 | 是否默认加载 |
|---|---|---|---|
| 入口 | `README.md` | 使用规则、边界和目录 | 先加载 |
| 导航 | `MOC.md` | 按需求、协议和场景定位条目 | 需要导航时加载 |
| 原子条目 | `providers/*.md` | 一个 Provider 一篇，记录可验证事实 | 按需加载 |
| 元规范 | `_meta/*.md` | 维护、字段和质量规则 | 仅维护知识库时加载 |

## 文件规范（Karpathy 风格）

1. **单一主题、独立成文**：每份原子条目只讲一个话题，可单独加载，不复制其他条目正文。
2. **前置元数据（front-matter）**：每份原子条目以 YAML 开头，字段见 `kb/_meta/schema.md`。
3. **直奔事实、简短果断**：用表格和要点，避免冗长铺垫；写清 `端点 / 模型 / 鉴权 / 协议 / 注意事项`。
4. **可追溯和时效**：记录 `updated`；不确定或待核实内容必须标记，不得伪装成事实。
5. **链接导航而非复制**：MOC 只做路由；条目通过 `related` 指向相关条目。

### 元数据字段

| 字段 | 说明 |
|---|---|
| `title` | 条目名称 |
| `id` | 稳定的文件级标识 |
| `category` | 所属分类（`providers` 等） |
| `proto` | 线协议：`openai-compatible` 或 `native` |
| `type` | 条目类型，例如 `provider`、`navigation` |
| `status` | `verified`、`reference` 或 `needs-review` |
| `endpoint` | base URL（不含路径尾斜杠） |
| `auth` | 鉴权所需的环境变量名 |
| `models` | 常用模型标识（逗号分隔，可能随厂商更新） |
| `updated` | 最近更新时间 |
| `source` | 事实来源或官方文档 URL |
| `related` | 相关条目的相对路径列表 |

---

## 目录

### providers — 模型提供商配置

| 文件 | 提供商 | 协议 | 鉴权 env |
|---|---|---|---|
| `providers/agnes.md` | Agnes (默认) | openai-compatible | `AGNES_API_KEY` |
| `providers/minimax.md` | MiniMax 国内版 | openai-compatible | `MINIMAX_API_KEY` |
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

## Agent 加载协议

1. 先读取 `kb/README.md`，只建立目录和边界认知。
2. 任务涉及选型或不知道条目位置时，读取 `kb/MOC.md`。
3. 确定主题后，只读取对应的 `kb/providers/<id>.md`。
4. 不为填充上下文读取无关条目；不把知识库正文写入 Session 或 `.memory/`。
5. 发现过期或冲突信息时，在回答中标明 `updated` 和来源，并建议维护条目。

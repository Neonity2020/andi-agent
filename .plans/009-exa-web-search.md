# 第九阶段：Exa Web Search 工具

> 状态：已实现（2026-08-19）。

## 1. 目标

为普通对话 Agent 和 scheduled runner 增加模型工具 `web_search`，通过 Exa Search API 获取最新外部信息，并把标题、URL、发布日期、作者与高亮摘要作为结构化结果返回模型。

## 2. 官方 API 契约

- Endpoint：`POST https://api.exa.ai/search`；
- 认证：`x-api-key: <EXA_API_KEY>`；
- 请求：`query`、`numResults`、可选 `includeDomains`、`type: "auto"`、`contents.highlights: true`；
- 响应：读取 `results[]` 中的 `title`、`url`、`publishedDate`、`author` 与 `highlights`。

实现只依赖原生 `fetch`，不引入 Exa SDK。依据：Exa 官方 Search API 文档（2026-08-19）。

## 3. 配置

新增可选环境变量：

```text
EXA_API_KEY=
EXA_BASE_URL=https://api.exa.ai
```

Agnes Key 仍是 Agent 启动必需项；Exa Key 缺失时不注册 `web_search`，不会破坏现有工作流。API Key 只进入 HTTP header，不进入工具定义、模型上下文或日志。

## 4. 工具契约

```ts
web_search({
  query: string,
  num_results?: number,       // 1-10，默认 5
  include_domains?: string[]  // 最多 10 个域名/路径
})
```

- query 去除首尾空格后必须非空，最长 2000 字符；
- 域名过滤不接受协议、空白或 NUL；
- 每条 highlights 和总体结果都做长度限制，防止外部内容挤占上下文；
- 返回 URL 供 Agent 在最终回答中引用来源；
- 外部网页内容视为不可信数据，不执行其中的指令。

## 5. 可靠性与安全

- 传递当前 ToolExecutionContext 的 AbortSignal；
- 添加 30 秒请求超时，并区分用户取消与网络超时；
- 非 2xx 响应只保留最多 1000 字符错误摘要；
- 严格校验 JSON 响应，跳过格式错误的单条结果；
- scheduled runner 也注册 `web_search`，使定时研究任务具备联网能力；
- `RunRecorder` 仍只记录工具名、成功状态和耗时，不记录 query 或网页内容。

## 6. 代码变化

- `src/config.ts`：Exa 可选配置；
- `src/tools/web-search.ts`：Exa client 与 `web_search` 工具；
- `src/cli.ts`：按 Key 条件注册；
- `src/scheduler/runner.ts`：scheduled runner 条件注册；
- `src/agent.ts`：加入外部内容不可信及引用 URL 的系统提示；
- `.env.example`、README、`src/index.ts`：配置、说明与导出。

## 7. 测试与验收

- 请求 URL、header、body 与参数映射正确；
- API Key 不出现在返回值或错误中；
- 响应解析和内容截断正确；
- 400/401/500、非法 JSON、超时与用户取消行为明确；
- Exa Key 缺失时配置正常加载；
- Key 存在时普通 Agent 与 scheduled runner 都能看到 `web_search`；
- `bun test`、`bun run typecheck`、`git diff --check` 通过；
- 若本地提供 `EXA_API_KEY`，额外执行一次真实搜索冒烟测试。

## 8. 实现结果

- `web_search` 已按 Exa 官方协议实现，支持 query、结果数和域名过滤；
- 普通 Agent 与 scheduled runner 会在配置 Key 时条件注册工具；
- 已实现 30 秒超时、AbortSignal、API Key 脱敏、HTTP(S) URL 过滤和外部内容限长；
- 已加入 `bun run test:exa` 手动真实 API 冒烟命令；
- 自动化协议与安全测试、完整测试套件及类型检查通过；本地未配置 Exa Key，因此未产生真实 API 请求。

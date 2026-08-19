# 第十二阶段：持久化多 Provider 模型目录

## 状态

已完成。持久化 Store、缓存 Manager、CLI/REPL 接入、显式刷新命令及测试均已落地。

## 目标

将模型目录持久化到工作区的 `.andi-agent/models.json`。普通 `/models` 只读取内存或磁盘缓存，不重复请求 Provider；首次没有缓存时自动获取一次，之后通过 `/models refresh` 显式刷新。

目录从第一版开始支持多个 Provider，后续接入 OpenAI、Anthropic 或其他兼容服务时无需改变文件格式或 REPL 交互。

## 文件格式

采用带版本号的 JSON：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "agnes",
      "source": "https://apihub.agnes-ai.com/v1",
      "updatedAt": "2026-08-19T00:00:00.000Z",
      "models": [{ "id": "agnes-2.5-flash", "ownedBy": "agnes" }]
    }
  ]
}
```

- `id` 是稳定 Provider ID；当前 Agnes 使用 `agnes`。
- `source` 是不含凭据的标准化 API Base URL，用于避免自定义端点误用旧缓存。
- 文件不保存 API Key、请求头或其他凭据。
- 数组结构避免任意 Provider ID 成为对象原型键。

## 运行语义

1. Agent 启动时不发起模型目录网络请求。
2. 第一次 `/models` 优先读进程内缓存，其次读 `.andi-agent/models.json`。
3. 当前 Provider 无匹配缓存时，才调用 `GET /models` 并原子写入文件。
4. 后续 `/models` 直接打开本地目录，直到用户执行 `/models refresh`。
5. `/models refresh` 只刷新当前 Provider，保留文件中的其他 Provider。
6. 缓存损坏、版本未知、source 不匹配或目录为空时视为 cache miss，并通过 Provider 重建。

模型选择仍只影响当前进程；目录缓存和“默认选择哪个模型”是两种不同状态。

## 实现方案

### ModelCatalogStore

新增独立存储层，负责严格解析、边界限制和原子写入：

- 最多 50 个 Provider、每个最多 500 个模型。
- 校验 Provider ID、URL、ISO 时间、模型 ID/owner 长度并去重。
- 使用同目录临时文件加 `rename()`，避免写出半截 JSON。
- 串行化同一进程内的更新，刷新一个 Provider 时保留其他条目。
- `.andi-agent/` 已被 Git 忽略并对通用 Agent 文件工具隐藏。

### ModelCatalogManager

在 REPL 与具体 Provider 之间增加缓存管理器：

- `listModels()`：memory → disk → provider fallback。
- `refreshModels()`：强制调用 Provider，并在成功后替换当前 Provider 的缓存。
- `selectModel()`：只允许当前已加载目录中的模型，并把选择转发给实际 Provider。
- Provider 提供受校验的目录注入方法，使磁盘缓存能初始化其选择白名单。

### CLI/REPL

- CLI 为 Agnes 构造 `ModelCatalogStore` 和 `ModelCatalogManager`，TUI/plain 共用。
- `/models` 使用缓存并打开现有选择器。
- `/models refresh` 显式联网刷新后打开选择器。
- `/help` 和 README 说明缓存路径及刷新方法。

## 测试与完成标准

- Store：缺失、读写、多 Provider 保留、损坏/未知版本、source 隔离、去重与边界、原子更新。
- Manager：内存命中、跨实例磁盘命中不联网、首次 fallback、显式刷新、失败不破坏旧缓存、切换转发。
- REPL：普通命令走缓存接口，refresh 走强制刷新，TUI/plain 行为不回退。
- 完整运行 `bun test`、`bun run typecheck`、`git diff --check`。

完成后，缓存已存在时重复执行 `/models` 必须产生零次 Provider 模型目录请求。

## 验证结果

- 跨 Manager 实例从 `.andi-agent/models.json` 恢复目录时，Provider 请求次数为 0。
- `/models refresh` 只刷新当前 Provider，并保留其他 Provider 条目。
- `bun test`：204 pass，0 fail。
- `bun run typecheck`：通过。
- `git diff --check`：通过。

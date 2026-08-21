# OpenViking 记忆（DeepSeek Harness 插件）

一个可安装的 DeepSeek Harness 插件包，为 DSH 增加 OpenViking 自动召回、会话捕获、`viking://` URI 保护，以及可被模型调用的记忆工具——均可通过 DSH 设置界面配置。

本仓库从规范的 [`examples/dsh-memory-plugin`](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin) 改造（而非复制）而来，以适应该仓库的原生架构：TypeScript 源码、pnpm 构建，以及渲染在 DSH Web 设置面板中的 `openviking` 设置命名空间。

## 功能特性

- **自动召回（Auto-recall）** — `agent/pre-step` 使用当前步骤的输入进行检索，并追加一条持久化、带来源标注的插件用户消息。
- **用户画像注入（Profile injection）** — `agent/session-start` 注入 OpenViking 用户画像与可用记忆索引。
- **会话捕获（Session capture）** — `session/event` 捕获用户、助手以及（可选）工具结果消息，无需抓取对话记录；`turn/end` 在待处理令牌数达到阈值时提交。
- **离线韧性（Offline resilience）** — 写入失败的内容进入 `~/.openviking/pending/`，并在下次会话开始时重放。
- **`viking://` 保护** — `tools/pre-execute` 阻止 DSH 文件系统与 Shell 工具将虚拟 URI 当作本地路径处理。
- **记忆工具** — `viking_search`、`viking_read`、`viking_browse`、`viking_remember`、`viking_forget`、`viking_add_resource`、`viking_archive_expand`。
- **设置** — 连接身份与召回/捕获调优可在 **设置 → OpenViking** 中实时配置。

## 环境要求

- `@deepseek-ai/dsh` `0.1.0-rc.6` 或更新的 `0.1.0-rc.N` 版本（当前：`0.1.0-rc.8`）
- Node.js `^22.19.0` 或 `>=24`
- 可访问的 OpenViking 服务器

该插件包没有任何运行时 npm 依赖。其工具与消息结构来自 DSH 的构造函数（`@deepseek-ai/dsh-tools` 的 `defineTool`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`），并通过灵活的 peerDependencies（`^0.1.0-rc.6`）实现——DSH 会在启动时通过其 profile 回退机制暴露这些依赖，因此这些定义随 DSH 的契约演进，而不是手写的对象结构。由于 DSH 的 rc 版本迭代很快（rc.8 为当前版本且更新频繁），peer 范围接受 `0.1.0` 行内 `rc.6` 及以上任意 `0.1.0-rc.N`；devDependencies 固定到当前 `0.1.0-rc.8`，以便 CI 在插件运行时同样接受的真实 DSH 表面上进行验证。

## 为什么采用 pre-step 用户消息注入而不是系统提示词

召回与画像上下文通过 `agent/pre-step` 瀑布式流程以持久化、带来源标注的用户消息（`source: { kind: 'plugin', … }`）进入。它们刻意**不**加入系统提示词：如果一个 DSH 预设的人设声明了 `complete: true`（自带的 `minimal` 预设即是如此），该预设会在组装后把其人设恢复为唯一的提示词部分，从而静默丢弃其他所有贡献——基于系统提示词的记忆插件在这种预设下会丢失上下文且没有任何报错。Pre-step 注入还能让每次注入都成为可重放、对压缩可见、且永远不会进入 `request/header` 的会话事件。

## 安装

从本地检出目录安装（`lib/` 为构建产物、不随仓库提交，首次使用前请先运行 `pnpm install && pnpm run build`）：

```bash
dsh plugin --profile web add "$PWD"
```

或者安装已发布的包：

```bash
dsh plugin --profile web add @openviking/dsh-memory-plugin
```

确认 profile 中包含该插件包：

```bash
dsh --profile web --dump-config
```

该包的补丁会在一个隔离了 `openvikingMemory` 服务的 Cordis 组内挂载运行时。

## 配置

OpenViking 在 **DSH Web → 设置 → OpenViking**（`openviking` 设置命名空间）中配置。取值叠加在标准 OpenViking 凭据链之上——设置中已填写的字段优先，否则依次回退到：

1. `OPENVIKING_*` 环境变量
2. `~/.openviking/ovcli.conf`
3. `~/.openviking/ov.conf`

设置字段：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| 服务器端点 | `http://127.0.0.1:1933` | OpenViking 服务器基础 URL |
| API 密钥 | *(空)* | Bearer 凭据；以脱敏形式存储 |
| 账号 / 用户 | *(空)* | 受信模式身份 |
| Actor 对等节点 ID | *(空)* | 显式对等节点；默认为由工作区推导 |
| 工作区对等节点 | 开 | 从每个会话工作区推导 actor 对等节点 |
| 召回对等节点范围 | `all` | `actor` 将召回隔离到该会话的对等节点 |
| 最大召回条数 | `10` | Pre-step 召回上限 |
| 召回令牌预算 | `2000` | 每个召回块的令牌预算 |
| 分数阈值 | `0.35` | 最低召回分数 |
| 提交令牌阈值 | `20000` | 触发提交的待处理令牌数阈值 |
| 捕获工具结果 | 关 | 将工具结果消息捕获进记忆 |
| 捕获助手轮次 | 开 | 将助手回复捕获进记忆 |
| 逐事件捕获 | 开 | 在 `session/event` 上同步捕获 |

常用环境变量（当设置中未填写某字段时的回退）：

| 变量 | 用途 |
| --- | --- |
| `OPENVIKING_URL` / `OPENVIKING_BASE_URL` | OpenViking 服务器端点 |
| `OPENVIKING_API_KEY` / `OPENVIKING_BEARER_TOKEN` | Bearer 凭据 |
| `OPENVIKING_ACCOUNT` / `OPENVIKING_USER` | 受信模式身份 |
| `OPENVIKING_PEER_ID` | 显式 actor 对等节点 |
| `OPENVIKING_WORKSPACE_PEER` | `0` 禁用工作区推导对等节点 |
| `OPENVIKING_RECALL_PEER_SCOPE` | `actor` 用于按对等节点隔离召回 |
| `OPENVIKING_RECALL_LIMIT` | 覆盖召回上限 |

补丁还可以携带插件配置：

```yaml
- insert:
    - id: openviking-memory
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      isolate:
        openvikingMemory: true
      config:
        - id: openviking-memory-runtime
          name: '@openviking/dsh-memory-plugin'
          config:
            endpoint: http://127.0.0.1:1933
            recallTokenBudget: 2000
            scoreThreshold: 0.35
            captureToolResults: false
            commitTokenThreshold: 20000
```

## 行为说明

- `agent/session-start` 通过 `agent.inject()` 注入 OpenViking 画像与可用记忆索引。
- `agent/pre-step` 使用当前步骤的输入进行检索，并将一条持久化插件消息追加到同一步骤。
- `session/event` 捕获用户、助手以及（可选）工具结果消息，无需抓取对话记录。
- `turn/end` 检查 OpenViking 待处理令牌阈值，并在需要时提交。
- 写入失败的内容进入共享的 OpenViking 待处理队列，在下次会话开始时重放。
- `tools/pre-execute` 阻止 DSH 文件系统与 Shell 工具将 `viking://` URI 当作本地路径处理。

每个 DSH 会话都映射到 OpenViking 中的 `dsh-<session-id>`。由工作区推导的 actor 对等节点按会话解析，并随每个会话级请求发送。设置变更通过运行时的重新配置路径实时生效。

## 工具

该插件包注册了以下工具：

- `viking_search`
- `viking_read`
- `viking_browse`
- `viking_remember`
- `viking_forget`
- `viking_add_resource`
- `viking_archive_expand`

`viking_forget` 执行永久删除。调用它的模型只应在用户明确要求删除时使用。

## 开发

本仓库是一个 pnpm/TypeScript 项目，`lib/` 为编译产物（已通过 `.gitignore` 排除，不随仓库提交）：

```bash
pnpm install          # 安装固定到 rc.8 的 dsh devDependencies
pnpm run build        # tsc server + tsc client + client bundle -> lib/
pnpm test             # vitest run tests
pnpm run typecheck    # server + client 的 no-emit 类型检查
```

`lib/` 由 `pnpm run build` 生成，`npm publish` 的 `prepack` 钩子会在发布前自动重新构建，因此仓库保持干净、仅含 `src/` 源码。

`live-recall.spec.ts` 是一个针对真实 OpenViking 服务器的可选端到端门禁：它会通过会话提交存入一条哨兵记忆，等待抽取，然后断言召回能返回该哨兵。通过设置 `OPENVIKING_E2E=1` 加上常规凭据链即可启用；否则跳过。

## 许可证

MIT

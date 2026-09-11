# OpenViking 记忆（DeepSeek Harness 插件）

一个可安装的 DeepSeek Harness 插件包，为 DSH 增加 OpenViking 自动召回、会话捕获、`viking://` URI 保护，以及可被模型调用的记忆工具——均可通过 DSH 设置界面配置。

## 功能特性

- **自动召回（Auto-recall）** — `agent/pre-step` 使用当前步骤的输入进行检索，并追加一条持久化、带来源标注的插件用户消息。
- **用户画像注入（Profile injection）** — `agent/session-start` 注入 OpenViking 用户画像与可用记忆索引。
- **会话捕获（Session capture）** — `session/event` 捕获用户、助手以及（可选）工具结果消息，无需抓取对话记录；`turn/end` 在待处理令牌数达到阈值时提交。
- **离线韧性（Offline resilience）** — 写入失败的内容进入 `~/.openviking/pending/`，并在下次会话开始时重放。
- **`viking://` 保护** — `tools/pre-execute` 阻止 DSH 文件系统与 Shell 工具将虚拟 URI 当作本地路径处理。
- **技能注入（Skill catalog）** — 注册名为 `openviking` 的 DSH 技能 provider，把保存在 OpenViking 中的技能（`viking://user/<space>/skills/` 与共享的 `viking://agent/skills`）注入进会话的 `<available_skills>` 目录；模型可像本地技能一样用 `skill` 工具按需加载完整正文。
- **记忆工具** — 15 个 `viking_*` 工具，涵盖检索、读写、浏览、归档展开、监视管理与技能管理（见[工具](#工具)）。
- **设置** — 连接身份与召回/捕获调优可在 **设置 → 插件 → 插件配置**（OpenViking 卡片）中实时配置。

## 环境要求

- `@deepseek-ai/dsh` `0.1.5-rc.2` 或更新的 `0.1.5-rc.N` 版本
- Node.js `^22.19.0` 或 `>=24`
- 可访问的 OpenViking 服务器

## 安装

从本地检出目录安装（首次使用前先运行 `pnpm install && pnpm run build`）：

```bash
dsh plugin --profile web add "$PWD"
```

或者安装已发布的包：

```bash
dsh plugin --profile web add @nextnowlabs/dsh-openviking
```

确认 profile 中包含该插件包：

```bash
dsh --profile web --dump-config
```

该包的补丁会在一个隔离了 `openvikingMemory` 服务的 Cordis 组内挂载运行时。

## 配置

OpenViking 的配置在 **DSH Web → 设置 → 插件 → 插件配置**（OpenViking 配置卡片，`openviking` 设置命名空间）中完成；未填写的字段使用内置默认值。设置变更通过运行时的重新配置路径实时生效。

下表列出全部设置字段；「界面」列为 ✓ 表示可直接在设置界面中编辑，其余字段通过设置文档或补丁 `config` 提供。

### 连接

| 字段 | 界面 | 默认值 | 用途 |
| --- | :-: | --- | --- |
| 服务器端点 `endpoint` | ✓ | `http://127.0.0.1:1933` | OpenViking 服务器基础 URL |
| 凭据引用 `credential` | ✓ | `OPENVIKING_API_KEY` | 保存 Bearer API 密钥的 DSH 凭据引用（环境风格名称）；密钥本体存储在 DSH 凭据存储中，不在设置文档内 |
| 账号 `account` | ✓ | *(空)* | 受信模式账号 |
| 用户 `user` | ✓ | *(空)* | 受信模式用户 |
| Actor 对等节点 ID `peerId` | ✓ | *(空)* | 显式对等节点；留空则按会话工作区推导 |
| 请求超时 `requestTimeoutMs` | | `10000` | 所有 HTTP 请求的超时毫秒数 |

### 召回

| 字段 | 界面 | 默认值 | 用途 |
| --- | :-: | --- | --- |
| 工作区对等节点 `workspacePeer` | ✓ | 开 | 从每个会话工作区推导 actor 对等节点 |
| 召回对等节点范围 `recallPeerScope` | ✓ | `all` | `all` 跨工作区召回；`actor` 仅限本会话对等节点 |
| 最大召回条数 `recallLimit` | ✓ | `10` | Pre-step 召回上限 |
| 召回令牌预算 `recallTokenBudget` | ✓ | `2000` | 每个召回块的令牌预算 |
| 分数阈值 `scoreThreshold` | ✓ | `0.35` | 最低召回分数 |
| 召回硬截止 `recallTimeoutMs` | ✓ | `6000` | 单次 pre-step 召回的硬性截止毫秒数；超时则跳过该步召回（画像与召回并行执行），避免慢/远端服务器拖住模型步 |
| 提交令牌阈值 `commitTokenThreshold` | ✓ | `20000` | 触发提交的待处理令牌数阈值 |
| 服务端查询扩展 `recallQueryExpansion` | | `auto` | `auto` 启用服务端查询扩展；`off` 关闭 |
| 召回内容最大字符 `recallMaxContentChars` | | `500` | 每条召回项最多展示的字符数 |
| 召回优先摘要 `recallPreferAbstract` | | 开 | 回退召回优先使用摘要而非全文 |
| 最小查询长度 `minQueryLength` | | `3` | 低于该长度不触发召回 |
| 画像令牌预算 `profileTokenBudget` | | `10000` | 会话开始时画像注入的令牌预算 |
| 注入画像 `injectProfile` | ✓ | 开 | 是否在每个会话注入 `user-profile` + `<available-memories>` 画像块；关闭后不注入，初始化也不再拉取画像（动态召回不受影响） |
| 技能注入 `injectSkills` | ✓ | 开 | 将 OpenViking 中保存的技能注入 DSH 技能目录 |

### 捕获

| 字段 | 界面 | 默认值 | 用途 |
| --- | :-: | --- | --- |
| 逐事件同步捕获 `syncTurns` | ✓ | 开 | 在 `session/event` 上同步捕获 |
| 捕获工具结果 `captureToolResults` | ✓ | 关 | 将工具结果消息捕获进记忆 |
| 捕获助手轮次 `captureAssistantTurns` | ✓ | 开 | 将助手回复捕获进记忆 |
| 捕获模式 `captureMode` | | `semantic` | 捕获模式：`semantic` 或 `keyword` |
| 单条捕获最大字符 `captureMaxLength` | | `24000` | 每条捕获消息的最大字符数 |
| 工具结果捕获最大字符 `captureToolMaxChars` | | `1000000` | 每条捕获工具结果的最大字符数 |
| 提交保留最近条数 `commitKeepRecentCount` | | `10` | 提交后保留在活动会话中的最近消息条数 |

补丁还可以携带插件配置（含不在界面展示的字段，如 `captureMode`、`requestTimeoutMs`）：

```yaml
- insert:
    - id: openviking-memory
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      isolate:
        openvikingMemory: true
      config:
        - id: openviking-memory-runtime
          name: '@nextnowlabs/dsh-openviking'
          config:
            endpoint: http://127.0.0.1:1933
            recallTokenBudget: 2000
            scoreThreshold: 0.35
            captureToolResults: false
            commitTokenThreshold: 20000
            captureMode: semantic
            requestTimeoutMs: 10000
```

## 行为说明

- **API 密钥存放在 DSH 凭据存储**：设置文档与插件配置只携带 `credential` 引用（默认 `OPENVIKING_API_KEY`）。每个 OpenViking 请求在发出前经 `ctx.credentials.resolve(credential)` 解析密钥并以 `Authorization: Bearer` 发送，因此凭据变更在下一个请求即生效，无需重启；设置界面通过 `/_dsh/openviking/settings` 同源路由写入新密钥，浏览器永不见其明文。
- `agent/session-start` 通过 `agent.inject()` 注入 OpenViking 画像与可用记忆索引（`injectProfile` 关闭时不注入，且初始化不再拉取画像）。
- `agent/pre-step` 使用当前步骤的输入进行检索，并将一条持久化、带来源标注的用户消息追加到同一步骤。画像与召回上下文以会话事件进入，可重放、对压缩可见且不会进入请求头。
- 画像与召回在 `agent/pre-step` 中**并行构建**，并受 `recallTimeoutMs` 硬性截止时间约束：慢/远端服务器超时后该步直接跳过召回（或画像），绝不阻塞模型步；画像构建在基础链路之前启动，与系统提示词装配重叠。
- `session/event` 捕获用户、助手以及（可选）工具结果消息，无需抓取对话记录。
- `turn/end` 检查待处理令牌阈值，并在需要时提交。
- 写入失败的内容进入共享的待处理队列，在下次会话开始时重放。
- `tools/pre-execute` 阻止 DSH 文件系统与 Shell 工具将 `viking://` URI 当作本地路径处理。
- `ctx.skills` 上注册名为 `openviking` 的技能 provider：目录发现走 `GET /api/v1/skills`，正文按需经 `GET /api/v1/skills/{name}?include_content=true` 加载。每个会话构建技能目录时都会重新发现，OpenViking 中新增/修改/删除的技能随即反映到 `<available_skills>`。

每个 DSH 会话都映射到 OpenViking 中的 `dsh-<session-id>`。由工作区推导的 actor 对等节点按会话解析，并随每个会话级请求发送。会话是**惰性创建**的：只有当实际捕获到消息、或有待重放的离线写入时才会在 OpenViking 中落盘，因此关闭捕获（`syncTurns` / `captureAssistantTurns` / `captureToolResults` 均关闭）的会话不会在服务器上留下空的会话记录。

## 技能注入

开启 `injectSkills`（默认开）后，保存在 OpenViking 中的技能会作为名为 `openviking` 的 provider 进入 DSH 技能目录，与本地文件系统技能共用同一套 `skill` 工具与 `<available_skills>` 机制：

- **数据来源** — `GET /api/v1/skills` 返回当前用户私有技能（`viking://user/<space>/skills/`）与账户共享 Agent 技能（`viking://agent/skills`）的合并列表；同名时私有技能优先。
- **技能格式** — 与 DSH 本地技能一致：`SKILL.md` 携带 YAML frontmatter（`name`、`description`，可选 `tags`、`allowed_tools`）。正文中的 frontmatter 会被剥离，仅把说明正文注入 `<skill_instructions>`。
- **优先级** — 排名固定为 `550`：本地用户技能（400–500）优先于同名 OpenViking 技能，而 OpenViking 技能仍高于内置技能（600）。
- **失败韧性** — 服务器不可达时该轮发现报告为不完整（不会把空目录当作权威结果缓存）；无技能时贡献为空，不影响会话。

用 OpenViking 的 `ov add-skill ./skills/my-skill/`（或 Web 端）保存技能后，新建 DSH 会话即可在技能目录中看到并加载它。

## 工具

该插件包注册了以下工具：

- `viking_search` — 语义检索 OpenViking 记忆、资源与技能
- `viking_read` — 按 abstract / overview / full 读取 `viking://` 内容
- `viking_browse` — 列出目录或查看 URI 元数据
- `viking_tree` — 递归列出目录树
- `viking_write` — 写入文本（replace / append / create）
- `viking_edit` — 精确字符串替换
- `viking_grep` — 按正则搜索文件内容
- `viking_glob` — 按文件名通配匹配
- `viking_remember` — 将事实记入当前会话
- `viking_forget` — 永久删除
- `viking_add_resource` — 摄入远程 URL 供检索
- `viking_archive_expand` — 展开当前会话的归档
- `viking_list_watches` — 列出监视任务
- `viking_cancel_watch` — 取消监视任务
- `viking_manage_skill` — 创建 / 更新 / 删除技能（SKILL.md 上传，同名即覆盖；可指定共享技能根）

`viking_forget` 与 `viking_manage_skill`（delete 动作）执行永久删除。调用它们的模型只应在用户明确要求删除时使用。

## 开发

本仓库是一个 pnpm/TypeScript 项目，`lib/` 为编译产物（不随仓库提交）：

```bash
pnpm install          # 安装 dsh devDependencies
pnpm run build        # tsc server + tsc client + client bundle -> lib/
pnpm test             # vitest run tests
pnpm run typecheck    # server + client 的 no-emit 类型检查
```

`lib/` 由 `pnpm run build` 生成，`npm publish` 的 `prepack` 钩子会在发布前自动重新构建。

`live-recall.spec.ts` 是一个针对真实 OpenViking 服务器的可选端到端门禁：设置 `OPENVIKING_E2E=1` 并在测试配置中填入连接凭据即可启用；否则跳过。

## 发布

`scripts/publish.sh` 负责发布到 npmjs 官方 registry：

```bash
npm run release                 # 发布到 npmjs（等价于 ./scripts/publish.sh）
npm run publish:dry             # dry-run：构建 + 预览 tarball，不发布
./scripts/publish.sh --bump patch --push   # 升级 patch 版并发布 + 推送 git tag
./scripts/publish.sh --tag beta            # 发布为 beta dist-tag
```

> 注意：不要直接运行裸 `npm publish`。`publish` 是 npm 的生命周期脚本名，
> npm 在上传完成后会再次执行它，导致 publish.sh 递归重入并报“版本已存在”。
> 统一使用 `npm run release`（或直接调用 `./scripts/publish.sh`）。

发布前会自动检查：位于 `main` 分支、工作区干净（`--skip-checks` 可跳过）、已登录 npmjs、版本号未被占用。需要二步验证时用 `-o <otp>` 或 `NPM_OTP` 环境变量。首次发布先执行 `npm login --registry https://registry.npmjs.org/`。

## 许可证

MIT

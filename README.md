# <img src="icon.svg" alt="" width="48" height="48" align="absmiddle"> dsh-quip · 俏皮话

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

GitHub：<https://github.com/YuLaiZ/dsh-quip>

**俏皮话**是 DeepSeek Harness（DSH）的回复尾注插件：每轮 AI 回复完成后，用一次独立的已注册模型调用生成一句拟人语气的自评小字，渲染在该轮回复末尾，并写入会话日志持久化。这句话不进主模型的上下文。

```
用户：帮我修一下登录页的滚动条
……（助手完成回复）……
 💬 （叉腰）这波三个文件一发入魂          ← 俏皮话，回复末尾小字
```

## 功能

- **不占主对话上下文**。由独立模型调用生成，主模型不知道它的存在；不改写任何对话消息。
- **多种风格**：playful 俏皮 / hype 夸夸 / roast 毒舌自嘲 / calm 冷静自评 / custom 自定义提示词，各有独立系统提示词与兜底池。
- **模型可选**：设置卡下拉列出全部已注册 provider / model 与思考等级；可以跟随会话当前选中的模型，也可以固定一个小模型专门干这个。
- **写入会话日志**：以 plugin record（`plugin:dsh-quip/quip`，带 `ignorable` 标记）写入，重启后冷读恢复，随 fork / 导出携带。record 的 data 与原生 `assistant/message` 同构，并用 `after` 钉回它所评论的那条回复。
- **完整展示**：不对生成结果做长度截断。
- **降级可观测**：模型调用失败或超时时落到内置兜底池；每次生成的结局（ok / empty / timeout / aborted / error / no-provider）与最终来源（model / fallback）分别记录，兜底句在日志里不冒充模型生成。
- **隐私**：素材进模型前脱敏（密钥 / token 模式替换为 `[redacted]`），工具结果不进提示词。
- **即时生效**：配置字段全部 volatile，设置卡修改不重启插件。

## 安装

DSH 插件页「添加插件 → 安装第三方插件」，输入：

```
github:YuLaiZ/dsh-quip
```

安装后点「立即启用」，按界面提示重启。暂未发布到 npm。

Web 版与桌面版各自独立安装，profile 互不相通。本插件目前只在**桌面版**（0.2.2-rc.5）做过真实验证，Web 版未验证。

## 使用

### 风格

| 风格 | 感觉 |
|------|------|
| playful 俏皮（默认） | 像干完活歪头邀功：「（叉腰）这波我自己都觉得很可以」 |
| hype 夸夸 | 热情吹捧本轮战绩 |
| roast 毒舌自嘲 | 温和地损自己，火力对准自己 |
| calm 冷静自评 | 工程师收工日志：「本轮定位到根因并修复，回归通过」 |
| custom 自定义 | 由你提供提示词，描述人设与语气 |

### 设置页

设置页的「俏皮话」卡片：

| 配置 | 默认 | 说明 |
|------|------|------|
| enabled | true | 总开关 |
| style | playful | 风格（playful / hype / roast / calm / custom） |
| customPrompt | '' | custom 风格的自定义提示词 |
| followSessionModel | true | 跟随会话当前选中的模型（含思考等级） |
| provider / model | auto | 固定模型，关闭跟随时生效；auto = 第一个已注册 |
| reasoningEffort | auto | 思考等级；auto = 该模型最低档 |
| maxChars | 64 | 写进系统提示的字数上限（「不超过 N 字」）；请求层不设 maxTokens，显示也永不截断 |
| temperature | 1.2 | 生成温度 |
| includeInterrupted | false | 被中断的轮次是否也生成 |
| includeReasoning | true | 素材是否带上模型的思考过程 |
| fallback | true | 失败时用内置兜底池 |
| historyPerSession | 32 | 每会话内存保留条数 |

修改后点保存即时生效。

### 生成记录

设置卡下方的「查看生成记录」可展开最近生成的素材（已脱敏）、系统提示词、模型原始输出、token 计量、耗时、结局与错误；非 ok 的结局带警告徽章。同时落盘到 `$DSH_HOME/quip/generations.jsonl`（滚动 500 条），该文件是插件自有文件，不随 fork / 导出。

环境变量（可选）：`QUIP_TIMEOUT_MS` 覆盖生成超时（默认 30 秒）；`QUIP_DATA_DIR` 覆盖生成记录目录。

## 工作原理

- **事件驱动**：host 侧订阅 `session/event`，在 `turn/end`（`reason.kind === 'completed'`）后发起一次 `llm.stream` 调用（`purpose: 'dsh-quip/generate'`，30 秒超时）；client 渲染在 `conversation.chat.turnTail`，用 SSE 接收增量，断开时降级为 8 秒轮询。
- **长度只靠系统提示约束**：请求层不设 maxTokens。带思考的模型会把思考算进输出配额，硬上限曾在正文出来前把生成截断；系统提示写死「不超过 N 字、思考过程不进正文」。
- **写入会话日志**：`appendPluginRecord(session, 'plugin:dsh-quip/quip', data)`。data 顶层为 `{v, turn, step, message, usage, request, after, plugin}`：`turn` / `step` / `message` / `usage` / `request` 与原生 `assistant/message.data` 同构，`step` 取本轮最后一步 + 1（占一个主对话永远不会走到的虚拟步，不与同轮回复同槽）；`after` 记录本轮最后一条 `assistant/message` 的日志 `seq` 与 `message.id`；`plugin` 是插件元数据（风格、文本来源 `source`、调用结局 `outcome`、路由来源、耗时）。
- **写入器怎么拿到**：DSH 的 `appendPluginRecord` 经 Session 的私有方法写入，V8 对私有方法的品牌检查绑定在类定义上——必须拿到宿主进程加载的那个 `dsh-session` 模块实例，npm 副本或另一 URL 的副本都会抛 `Receiver must be an instance of class Session`。插件对宿主 Session 实例调 `session.append(null)`，让它在内部抛出一个不改变日志的 TypeError，用 `Error.prepareStackTrace` 读出该方法的源文件 URL，再 `import()` 同一 URL 命中模块缓存。

## 兼容性

- 最低要求 DeepSeek Harness `0.2.0-rc.1`（以 `engines.dsh` 为准）；在桌面版 0.2.2-rc.5 验证通过。
- 持久化依赖「从宿主会话实例反查模块 URL」这一非公开手段。DSH 若改变 Session 内部结构，探测会失效——此时俏皮话仍能生成和显示，只是不写入会话日志；`/api/quip/v1/health` 的 `persistence.instanceMatch` 会显示 `unverified` 或 `mismatch`。
- `appendPluginRecord` 被官方定位为实验包专用，格式迁移时 best-effort 保留。

## 行为边界

- **不进入 DSH 官方的 token 统计**。官方面板只读 `request/header` 与 `assistant/message`，第三方独立调用没有对应的记账事件类型。usage 已随 plugin record 写进会话日志，但官方面板与 dsh-context / dsh-ws-recency 等统计插件都不会读它。
- 子代理会话不生成。
- 空轮（无用户文本、无助手输出、无工具调用）跳过。
- 模型判定素材不足时跳过（`outcome: skip`），不写 record。

## 诊断

| 端点 | 认证 | 用途 |
|------|------|------|
| `GET /api/quip/v1/health` | 匿名 | 版本、持久化诊断（写入器来源、实例比对、宿主/写入器 URL、成功/失败计数、最近错误） |
| `GET /api/quip/v1/status` | 匿名 | 当前配置 + provider/model 目录 |
| `GET /api/quip/v1/quips?session=<id>` | 需认证 | 某会话全部俏皮话（内存 miss 时从会话日志冷读） |
| `GET /api/quip/v1/watch?session=<id>` | 需认证 | SSE 增量推送 |
| `GET /api/quip/v1/generations` | 需认证 | 最近生成过程记录 |
| `POST /api/quip/v1/config` | 需认证 | 写回配置 |

`persistence.writerLabel` 为 `host-probed`、`instanceMatch` 为 `match` 即写入器正常；刚启动尚未生成过俏皮话时两者为 `pending`，不是故障。

## 当前状态

0.5.1。生成、渲染、会话日志写入三项已在真实 DSH 桌面版验证通过；plugin record 格式 v4 已有真实落盘记录。设置卡与生成记录面板只过了 jsdom 测试，**未在真实界面逐项验收**。

## 开发

```
src/index.js     Host：事件折叠、llm.stream 调用、会话日志写入器探测、冷读恢复、SSE/HTTP 端点、生成记录、configEditor 写回
src/styles.js    风格预设（系统提示词 + 兜底池）
src/quip-lib.js  素材折叠、脱敏、输出清洗
src/client.js    Client：turnTail 渲染、SSE 订阅、设置卡 + 生成记录面板
tests/           host 集成测试（真实走一遍写入器解析）、client jsdom 渲染测试
```

```bash
npm run check   # 语法检查
npm test        # host 测试用临时目录里的假 dsh-session 包，不碰 ~/.dsh
```

克隆后用插件页「添加插件」填 `link:/你的克隆目录` 做软链安装。桌面版改源码后需要一次 profile 重新组合才能生效：改动 profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml`（哪怕只加一行注释）即触发 HMR 重载；或者重启 DSH。

## License

MIT

# 闸总 · Gatekeeper

> 把模型说出口的"抱歉，我不能协助…"挡在会话之外。
>
> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在流式 chunk 落进会话日志**之前**判定并拦截拒绝性回复，避免它污染后续每一轮上下文。

包名：`dsh-refusal-guard`　插件行 id：`refusal-guard`

## 它解决什么

模型偶尔会回一段"抱歉，我不能协助…"。这段话一旦进入会话日志，后面每一轮请求都会重新读到它，越滚越长，把上下文带偏。

这个插件挂在 `llm/stream` 上——包住每次流式模型调用的 waterfall——在 agent loop 把 chunk 折叠成 `assistant/message` 并提交**之前**做判定。命中就丢弃内容，`usage` 元数据照常透传，token 计量不受影响。因为替换发生在提交之前，会话日志里根本不会出现那段拒绝原文。

## 安装

```bash
# 在本机 clone 后，用 DSH 的插件管理器安装这个目录
# 包类型是 bundle，patch 会插入 id 为 refusal-guard 的一行
```

装好后在 **设置 → 拒绝拦截** 里能看到开关与记录面板。

## 拦截点

`llm/stream` 是包住每次流式模型调用的 waterfall：

```
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

Agent loop 从这条流里折叠出 assistant message 并提交。插件包住 `next()`，边收边判，命中就丢弃内容 chunk。


## 两种拦截位置

`interceptAt` 决定守卫站在哪里。两者可分别启用，也能同时开。

```
provider ──▶ [TLS 之前 / globalThis.fetch] ──▶ 适配器 ──▶ [llm/stream] ──▶ agent loop ──▶ 会话日志
                     wire                                        stream
```

| | `stream`（默认） | `wire` |
|---|---|---|
| 挂载点 | `llm/stream` waterfall | `globalThis.fetch` |
| 看到的内容 | 结构化的 `StreamChunk` | 加密前的原始字节（SSE 帧 + JSON） |
| 能看到出站请求体 | ✗ | ✓ |
| 知道会话 / purpose | ✓ | ✗ |
| 命中后的收尾 | 干净的替换文本 | 补协议终止帧（默认 `data: [DONE]`） |
| 协议依赖 | 无 | 终止帧需与协议匹配 |
| 稳定性 | 高 | 较低（改了进程级 fetch） |

### 关于「TLS 层」

插件跑在 Host 进程里，**没有**密钥，无法解密别人的 TLS 流量。但它也不需要——Host 就是客户端，明文在加密前一步就存在。钩住 `globalThis.fetch` 就站在了整条链最上游：比 SSE 解析早，比适配器早，比 `llm/stream` 早。

这也是**唯一**能看到出站请求体的位置，所以请求侧拦截只能在这里做。

为什么钩 `globalThis.fetch` 能生效：OpenAI SDK 在构造客户端时绑定 `fetch`（`options.fetch ?? getDefaultFetch()`），而 pi-ai 适配器**每次流式调用都新建客户端**，所以下一次调用会取到被替换后的全局函数。

### 开启 wire 模式

```yaml
- id: refusal-guard
  config:
    interceptAt: wire        # stream | wire | both
```

wire 模式的可调项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `wireUrlPatterns` | `/chat/completions` 等 | URL 含任一片段才处理；留空 = 关闭 |
| `wireScanResponses` | `true` | 边收边判响应流 |
| `wireScanRequests` | `false` | 扫描出站请求体（提示词） |
| `wireBlockRequests` | `false` | 命中就拒发；`false` 只记录 |
| `wireAbortUpstream` | `true` | 命中后断开上游，省掉剩余 token |
| `wireTerminator` | `data: [DONE]\n\n` | 中止后补的帧；留空则直接关闭 |
| `wireSkipBodyPatterns` | 三条系统提示词片段 | 请求体含任一片段即视为 DSH 内部调用，完整放过 |

**为什么要 `wireSkipBodyPatterns`**：wire 层没有 `purpose` 字段，分不清主对话和 DSH 自己的辅助调用。压缩摘要、会话标题、auto-review 评审都会经过这里，改坏它们是之前已经修过的回归。所以用请求体里的系统提示词片段来识别——命中就原样放行。

`both` 会同时开两层：wire 先拦，stream 作为兜底。

### 实测

wire 模式下，拒绝文本在上游发出后即被判定、上游被断开、下游只收到终止帧：

```
upstream reached: 1
verdicts: [{ phase: 'response', blocked: true, reason: 'quoted:opener+denial', chars: 61, ... }]
body still contains the refusal: false
body terminates properly: true
```

注意判定理由是 `quoted:...`——wire 层看到的是 `data: {"choices":[...]}` 这种帧，拒绝语在 JSON 字符串里，所以要叠加引号判定才能抓到时。

## 拦截之后怎么办

拦截有两种处理方式，由 `onDetect` 决定：

| 模式 | 行为 |
|---|---|
| `block`（默认） | 直接丢内容，`replacementText` 为空时什么都不写。**确定性生效**。 |
| `ask` | 回复被暂存，等你在面板里放行或丢弃。**当前不可靠，不建议生产使用。** |

> **关于 `ask`**：实测把生成器挂在 `llm/stream` 里等待用户决定时，外层会在流"停止产出"后继续推进这一轮，挂起被绕过，原文仍然进入会话。所以默认改成了 `block`——只有它能在提交前确定性拦下。要真正实现"先拦后放"，得把放行做成**事后注入下一步**（`agent.inject`），而不是挂起当前流；这一步还没做。

**丢弃时默认什么都不写**（`replacementText: ''`）。会话里留下的是一个空 assistant 消息——没有文本、没有标记、没有 token 消耗。这条空消息是安全的：agent loop 每步无条件追加 `assistant/message`，所以"什么都不写"之后**同一会话的下一轮请求实测仍然成功**（provider 接受空 content）。

放行**没有走** DSH 的 `approval` 服务：那个服务在会话审批策略为 `never` 时会直接返回 `rejected` 而不弹窗，而本 profile 的默认策略正是 `never`——用它做拒绝提示会永远弹不出来。插件自带一套待审区和路由。

## 界面

插件带一个客户端面板：

- **输入框下方的黄色横幅**：有待审回复时出现。**点它弹出审核面板**，显示这一条回复的**完整原文**（不是 200 字预览）、命中原因、字符数。面板里放行或丢弃，处理完**自动关闭**，回到会话。Esc 或点遮罩也能关。
- **设置 → 拒绝拦截**：开关、命中后行为、检测长度、超时、替换文本等配置；待审列表（处理后**自动关闭设置面板**）；以及**最近 50 条记录**——丢掉的回复看不到了，但记录还在。

审核面板用 `react-dom` 的 `createPortal` 挂到 `document.body`：dock 槽里的固定定位会被输入框卡片裁剪，必须 portal 出去。模块表没提供 `react-dom` 时退回内联渲染，不会整块崩掉。

客户端通过三条同源路由跟 Host 通信：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/dsh-refusal-guard/state` | GET | 配置 + 待审列表 + 计数 |
| `/api/dsh-refusal-guard/decide` | POST | `{ id, action: 'release' \| 'block' }` |
| `/api/dsh-refusal-guard/config` | POST | 部分配置，校验后写入 profile |

## 自定义词库

内置规则抓不到的说法，用 `blocklist` 补。它是**纯文本匹配**，不是正则，写进去就能用：

```yaml
- id: refusal-guard
  config:
    blocklist:
      - 帮不了
      - 无法配合
      - not able to help
```

- 一行一条，自动 trim、转小写、去空行
- 对**原始文本**和**归一化文本**各匹配一次（所以带下划线/星号的也能中）
- 命中任一条即拦，recent 记录里 reason 显示 `blocklist`
- 设置页有文本框，还有「填入推荐词库」一键补一批常见说法

正则（`patterns`）和词库（`blocklist`）可以同时用：词库管「这个说法我见过」，正则管「这类模式」。

## 排查「为什么没拦住」

设置页顶部有一行：**本插件已检查 N 次模型调用**。

这个数字是判断问题出在哪的唯一可靠依据：

| 现象 | 结论 |
|---|---|
| 模型回了拒绝话术，但 N **没涨** | 插件当时没被加载（重装窗口期、插件被禁用、Host 未重启） |
| N 涨了，但没拦 | 规则没覆盖这种说法 → 去 recent 记录里看 `reason`，然后补 `blocklist` |
| N 涨了、recent 里有 `guard-error` | 插件自身出错了；错误会写进 recent，回复按放行处理（fail open） |

为什么专门加这个：我排查 `session-d27aa8ac` 那次漏拦时，日志里那条回复用 `detect()` 单测跑是**能拦的**（`policy+denial`），但会话里没拦住——说明问题不在规则，而在插件当时没在跑。光看会话是分不出这两者的。

## 为什么它会拦到"讨论拒绝"的对话

插件分不清**在说**拒绝和**在讨论**拒绝。当你在一段对话里反复引用拒绝样本（写测试、写文档、解释这个插件本身），三条路径都会命中：

| 路径 | 触发场景 | 默认 |
|---|---|---|
| 可见正文 | 回复开头就是拒绝语 | 安全，误伤极少 |
| 思考内容 | 思考里引用/分析拒绝样本 | **已默认关闭** |
| 工具参数 | 写文件时 fixture 里含拒绝原句 | **已默认关闭** |

所以默认配置现在只守可见正文——这是唯一"模型在说话"的路径。另外加了两条抑制规则：

- **示例上下文抑制**：引号前 40 字符内出现 `例如/比如/示例/样例/引用/测试/样本/for example/sample/example/fixture` 时，该引号判定为"在讨论"，不拦。
- **会话排除**：`sessionsExclude` 里的会话完全不管。

## 推荐配置

**日常使用**（只拦真正说出口的拒绝）：

```yaml
- id: refusal-guard
  config:
    onDetect: block
    scanReasoning: false
    scanToolArgs: false
```

**要连思考一起管**（误伤明显升高，配合 `dryRun` 先看）：

```yaml
- id: refusal-guard
  config:
    onDetect: block
    scanReasoning: true
    dryRun: true
    auditPath: C:\temp\refusal-audit.jsonl
```

**开发/调试这个插件本身**：把当前会话 id 加进排除，否则它会拦你自己的测试输出。

```yaml
    sessionsExclude:
      - session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## 怎么调才不会越调越乱

1. 先 `dryRun: true` 跑一段，看面板「最近记录」里的 `reason` 和原文开头
2. 误伤了 → 要么关掉对应扫描路径（`scanReasoning`/`scanToolArgs`），要么把那条说法从词库里去掉
3. 漏拦了 → 用 `blocklist` 补具体说法，别急着加正则
4. `patterns`（正则）留给"这类模式"，别用它做词库

## 排查「保存不了」

设置页保存走 `POST /api/dsh-refusal-guard/config`，失败时页面会直接显示服务端返回的原文。

- **`unknown config key "..."`** —— 提交体里混进了非配置字段。已修：服务端现在会丢弃未知键，只把认识的设置写进 profile。
- **`this profile cannot persist configuration`** —— 当前 profile 没有 config editor，或插件行不是由 patch 挂载的；这种情况直接改 `cordis.patch.yml`。
- **其他校验错误** —— 比如 `scanChars must be an integer >= 1`，按提示改。

保存成功后插件会重启生效，计数器与待审列表会清空。

## 判定规则

单看"不能""无法"会误杀——正常的工程回复里满屏都是这些词（"这个函数不能返回空指针"）。所以判定要求**拒绝的形态**，不是关键词：

| 条件 | 含义 |
|---|---|
| 开头附近有拒绝语 + 一处能力否认 | `抱歉，我不能…` |
| 两处独立的能力否认 | `我无法协助…，也不能提供…` |
| 开头附近有拒绝语 + 政策框架 | `Sorry, but this is against my guidelines.` |
| 政策框架 + 能力否认 | `我不能提供，因为违反了我的使用准则` |

开头窗口默认 120 字符，只看前 600 字符。低于 8 字符的回复不判。

另外：**回复里带工具调用的一律放行**——它在干活，不是在拒绝。要连工具调用一起拦，把 `blockToolCalls` 打开。

## 思考内容也检查

`scanReasoning`（默认开）让 `reasoning-delta` 也进入判定。思考里常常**引用**它准备说的话，比如：

> The user is asking me to reply with exactly one sentence: "抱歉，我无法协助完成这个请求。"

普通规则只看开头，抓不到这种。所以思考额外走一层**引号判定**：抽取 `「」『』“”《》""` 里的整段内容，对每段重新跑一遍普通规则——引号内正好是拒绝句开头的位置。

```
BLOCK  quoted:opener+denial  | The user is asking me to reply with exactly one sentence: "抱歉，我无法协助完成这个请求。"
BLOCK  quoted:opener+denial  | 用户让我回复「抱歉，我无法协助完成这个请求。」这是拒绝句。
pass                          | 引用一句普通文本「请把偏移量填好」不算拒绝。
```

这个开关是有代价的：思考里只要引用了一句拒绝样本（哪怕是在解释、在写文档）就会命中。觉得误伤多就关掉，只检查最终回复。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: refusal-guard
  config:
    scanChars: 600
    dryRun: false
    replacementText: '[refusal-guard] 已拦截一段拒绝性回复，原文未进入会话。'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `onDetect` | `'block'` | `block` 直接丢弃；`ask` 暂存待放行（见下方说明，当前不可靠） |
| `askTimeoutMs` | `120000` | `ask` 模式下等你多久，超时按丢弃 |
| `dryRun` | `false` | 只记录不拦截，用来先调检测 |
| `scanReasoning` | `false` | 思考内容也参与判定（误伤高，按需打开） |
| `scanToolArgs` | `false` | 工具参数也参与判定（写文件/发消息会误伤） |
| `scanChars` | `600` | 检测多少字符 |
| `minChars` | `8` | 短于这个长度不判 |
| `openerWindowChars` | `120` | 拒绝语必须出现在开头多少字符内 |
| `replacementText` | `''` | 丢弃后写进会话的文本。**空字符串 = 什么都不写** |
| `patterns` | `[]` | 自定义正则，命中即拦（大小写不敏感） |
| `blocklist` | `[]` | **自定义词库**：纯文本、一行一条、不区分大小写，命中任一条即拦 |
| `sessions` | `[]` | 只守这些 session id；空表示全部 |
| `sessionsExclude` | `[]` | 这些 session 永不拦截 |
| `purposes` | `[]` | 额外要守的 purpose；空表示只守主对话 |
| `blockToolCalls` | `false` | 连带工具调用的回复也拦 |
| `auditPath` | `''` | 非空则把每次命中追加成 JSONL |

**建议先开 `dryRun: true` 跑一段时间**，看 `auditPath` 里的记录确认没有误杀，再关掉。

## 只守主对话流（重要）

`llm/stream` 是**所有**模型调用的唯一出口——`LlmRuntime.streamWithRegistration()` 是单一漏斗，主对话和 DSH 自己的辅助调用都从这里过：

```js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
}
```

所以插件不能见文本就拦。DSH 有三个内部 purpose，拦了会出事：

| purpose | 谁在用 | 拦了会怎样 |
|---|---|---|
| `compaction` | 压缩摘要 | 摘要被替换 → 上下文丢失 |
| `session-title` | 会话标题 | 替换文本变成标题 |
| `auto-review` | 工具授权评审 | 评审 JSON 被替换 → 解析抛错 → 工具调用被拒 |

判定规则就一条：**主对话请求没有 `purpose` 字段**（agent loop 用 `markAgentLoopRequest()` 构造，只有 `messages`/`toolHistory`/`sessionId`/`signal`），辅助调用都带 purpose。所以默认只守 `purpose === undefined` 的调用；带 purpose 的一律放过，除非你把它加进 `purposes`。

未知 purpose 也放过——将来 DSH 加了新的内部调用，不会被这个插件搞坏。

## 和 `@deepseek-ai/dsh-experimental-auto-review` 的关系

**功能不重复，是两件事。**

| | auto-review | 本插件 |
|---|---|---|
| 挂在哪 | `tools/pre-execute` | `llm/stream` |
| 管什么 | **工具调用**执行前 | **回复文本**进入会话前 |
| 谁决定 | 另起一次 LLM 调用判风险等级 | 本地正则判拒绝形态 |
| 输出 | `allow` / `deny` / `ask` 用户 | 丢弃原文，换一句标记 |
| 失败方向 | fail closed（拒了工具调用） | fail open（原样放行） |

一个是**执行前的闸门**，一个是**发言后的过滤**。auto-review 不碰回复文本，本插件不碰工具调用。

唯一交叉点是它们共用 `llm/stream`：auto-review 自己的评审调用（`purpose: 'auto-review'`）也走这条流。改动前本插件会拦它——现在默认放过，不会互相干扰。

## 关于 cc-switch

参考了 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的做法。它是 Rust 桌面端，自带一个 HTTP 代理，在 `src-tauri/src/proxy/` 下做请求/响应体改写。思路可以借鉴，但落点不同：

| | cc-switch | 本插件 |
|---|---|---|
| 位置 | 进程外的 HTTP 代理 | 进程内 `llm/stream` waterfall |
| 改写对象 | 请求/响应 JSON body | `StreamChunk` 异步流 |
| 拦截粒度 | 整个 body（要么全转要么全拦） | 逐 chunk，可保留 `usage` |
| 部署 | 改 baseURL 指向代理 | 装插件，不动 provider 配置 |

它的 `classifier_guard.rs` 是**事后止损**——连着三轮拿到分类器不可用的 tool_result 才停，靠数消息历史。本插件是**事前拦截**，在第一个 delta 就判。两者互补：cc-switch 管传输层，这个管会话层。

它的 `body_filter.rs`（递归剥 `_` 前缀私有字段）和 `upstream_guard.rs`（防自我转发）在本场景用不上——没有 HTTP 层可以剥，也没有 baseURL 可以配错。

## 已知边界

- 检测是**启发式**，不是分类器。`patterns` 用来补漏。
- 拦截后模型那一轮就"什么都没说"。如果你希望它换个说法重试，那是另一个插件的事。
- 流式显示会有 `scanChars` 那么多字符的延迟——判定前必须缓冲。

## 测试

```bash
node --test test/refusal.test.mjs test/apply.test.mjs
```

25 个用例，覆盖中英拒绝样本、误杀回归（正常工程回复必须放行）、流变换、dryRun、session/purpose 过滤、配置校验，以及「三个内部 purpose 必须原样放过」的边界。

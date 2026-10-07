# OMP Agent Harness 架构设计与实现全景（原生体系 vs. Fork 演进）

> **文档定位**：本文档是关于 `omp`（Oh-My-Pi）作为生产级 CLI Agent 执行宿主（Agent Harness）的系统性架构设计与实现细节全景梳理。旨在拆解其作为大模型与本地操作系统之间的核心执行容器，并明确划分**上游原生（Upstream Baseline）**的设计理念与**本地 Fork 演进分支**针对生产级高频实战场景所做的系统级加固、协议扩展与交互重构。本篇作为博客成文的系统性架构底稿。

---

## 目录

- [1. 什么是 Agent Harness：执行宿主的本质边界](#1-什么是-agent-harness执行宿主的本质边界)
- [2. 全景对比矩阵：Upstream vs. Fork 演进](#2-全景对比矩阵upstream-vs-fork-演进)
  - [2.1 调度韧性与会话生命周期（Scheduling & Session Lifecycle）](#21-调度韧性与会话生命周期scheduling--session-lifecycle)
  - [2.2 网络协议与中转反代对抗（Wire Protocol & Relay Resilience）](#22-网络协议与中转反代对抗wire-protocol--relay-resilience)
  - [2.3 工具运行时、虚拟协议与环境扩展（Tool Runtime, Virtual URIs & Extensions）](#23-工具运行时虚拟协议与环境扩展tool-runtime-virtual-uris--extensions)
  - [2.4 检索通道与长期记忆后端（Search Channels & Memory Backend）](#24-检索通道与长期记忆后端search-channels--memory-backend)
  - [2.5 终端呈现工程与交互美学（TUI Presentation & Interaction Ergonomics）](#25-终端呈现工程与交互美学tui-presentation--interaction-ergonomics)
  - [2.6 运行时可观测性与计量度量（Observability & Telemetry）](#26-运行时可观测性与计量度量observability--telemetry)
- [3. 调度循环、状态生命周期与执行韧性](#3-调度循环状态生命周期与执行韧性)
  - [3.1 原生 ReAct 调度、上下文滑动压缩与会话 DAG](#31-原生-react-调度上下文滑动压缩与会话-dag)
  - [3.2 Fork 流式中途断连恢复机制（Mid-Stream Death Recovery）](#32-fork-流式中途断连恢复机制mid-stream-death-recovery)
  - [3.3 Fork 子任务细粒度不可变状态机与显式续跑协议](#33-fork-子任务细粒度不可变状态机与显式续跑协议)
  - [3.4 Fork 启动期冷启动优化：异步 Git 状态预热](#34-fork-启动期冷启动优化异步-git-状态预热)
- [3.5 全局模糊检索与会话流转引擎（Fuzzy Search & Resume Engine）](#35-全局模糊检索与会话流转引擎fuzzy-search--resume-engine)
- [4. 工具执行运行时、虚拟资源协议与记忆外延](#4-工具执行运行时虚拟资源协议与记忆外延)
  - [4.1 原生工具集体系、MCP 网关与 Rust Native 加速](#41-原生工具集体系mcp-网关与-rust-native-加速)
  - [4.2 Fork 虚拟 URI 资源路由体系（agent://, history://, xd://）](#42-fork-虚拟-uri-资源路由体系agent-history-xd)
  - [4.3 Fork 工具调用意图（Intent）的一等公民管道穿透](#43-fork-工具调用意图intent的一等公民管道穿透)
  - [4.4 Fork 运行时扩展机制（Extension Engine）与 Rebase 免疫架构](#44-fork-运行时扩展机制extension-engine与-rebase-免疫架构)
  - [4.5 Fork 全局长程记忆双引擎：history_search 与 session_search 深度剖析](#45-fork-全局长程记忆双引擎history_search-与-session_search-深度剖析)
  - [4.6 Fork 惰性 MCP 网关（Lazy MCP Gateway）与 Notion 深度实战](#46-fork-惰性-mcp-网关lazy-mcp-gateway与-notion-深度实战)
  - [4.7 Wiki 知识库与 Mnemopi 本地向量双层记忆系统深度剖析](#47-wiki-知识库与-mnemopi-本地向量双层记忆系统深度剖析)
  - [4.8 伴生桌面微宠守护进程（Desktop Pet Bridge）与只读工作区检查器（Workspace Inspector）](#48-伴生桌面微宠守护进程desktop-pet-bridge与只读工作区检查器workspace-inspector)
  - [4.9 Browser Relay 架构深度剖析：真实浏览器接管、CDP 伪装多路复用与安全防线](#49-browser-relay-架构深度剖析真实浏览器接管cdp-伪装多路复用与安全防线)
  - [4.10 Hashline 行级精确定位编辑引擎：告别 Patch 漂移与幻觉覆写](#410-hashline-行级精确定位编辑引擎告别-patch-漂移与幻觉覆写)
  - [4.11 持久化 PTY 会话与 Bash 工具安全沙箱深度剖析](#411-持久化-pty-会话与-bash-工具安全沙箱深度剖析)
  - [4.12 Native 性能基石：Rust 动态库（pi-natives）计算下沉架构](#412-native-性能基石rust-动态库pi-natives计算下沉架构)
  - [4.13 Auto-Learn 机制与 Managed Skill 智能体自进化闭环](#413-auto-learn-机制与-managed-skill-智能体自进化闭环)
- [5. 网络协议、中转对抗与提示词缓存保活](#5-网络协议中转对抗与提示词缓存保活)
  - [5.1 原生多 Provider 抽象与 KDL 声明式规则引擎](#51-原生多-provider-抽象与-kdl-声明式规则引擎)
  - [5.2 Fork 第三方 Relay 思考预算与错误容错阶梯（400 / [1210] / 始终思考）](#52-fork-第三方-relay-思考预算与错误容错阶梯400--1210--始终思考)
  - [5.3 Fork Claude Code 伪装锚定与 Prompt Cache 缓存穿透根治](#53-fork-claude-code-伪装锚定与-prompt-cache-缓存穿透根治)
  - [5.4 Fork 动态热重载重试规则引擎（retry-rules.json）](#54-fork-动态热重载重试规则引擎retry-rulesjson)
  - [5.5 Fork 搜索通道同源复用与 Grok Relay 适配](#55-fork-搜索通道同源复用与-grok-relay-适配)
  - [5.6 Fork 协议报头穿透（Extra Betas / Codex Pins）与多 API Key 轮询凭据池](#56-fork-协议报头穿透extra-betas--codex-pins与多-api-key-轮询凭据池)
  - [5.7 多 Provider 缓存计量差异与协议方言兼容深度剖析](#57-多-provider-缓存计量差异与协议方言兼容深度剖析)
- [6. 终端呈现工程（TUI）与人机交互交互面](#6-终端呈现工程tui与人机交互交互面)
  - [6.1 原生 Pi-Tui 差分渲染引擎与生命周期管理](#61-原生-pi-tui-差分渲染引擎与生命周期管理)
  - [6.2 终端多协议图形渲染与 Kitty Unicode 占位符引擎深度剖析](#62-终端多协议图形渲染与-kitty-unicode-占位符引擎深度剖析)
  - [6.3 Fork 终端排版美学重构：气泡、代码块边框与 Markdown 语法脱敏](#63-fork-终端排版美学重构气泡代码块边框与-markdown-语法脱敏)
  - [6.4 Fork 交互效率跃升：Bash 历史检索、补全与全局视口跳转](#64-fork-交互效率跃升bash-历史检索补全与全局视口跳转)
  - [6.5 无头终端评测工模与真实 PTY 像素级截屏（Headless Verification Rig）](#65-无头终端评测工模与真实-pty-像素级截屏headless-verification-rig)
  - [6.6 TUI 智能输入补全体系：斜杠指令、上下文引用与 Bash 幽灵文本（Composer & Ghost Text）](#66-tui-智能输入补全体系斜杠指令上下文引用与-bash-幽灵文本composer--ghost-text)
- [7. 运行时可观测性与计量度量](#7-运行时可观测性与计量度量)
  - [7.1 原生单次调用计数与统计数据库（stats.db）](#71-原生单次调用计数与统计数据库statsdb)
  - [7.2 Fork Turn 级别聚合计量看板（work-usage.ts）](#72-fork-turn-级别聚合计量看板work-usagets)
  - [7.3 Fork 工具与搜索吞吐量遥测（searchThroughput）](#73-fork-工具与搜索吞吐量遥测searchthroughput)
- [8. 生产级配置全景示例（含 Claude Code 伪装、Codex 与中转实战脱敏模版）](#8-生产级配置全景示例含-claude-code-伪装codex-与中转实战脱敏模版)
  - [8.1 智能体主配置：config.yml](#81-智能体主配置configyml)
  - [8.2 模型与 Provider 注册表：models.yml（多协议实战）](#82-模型与-provider-注册表modelsyml多协议实战)
  - [8.3 热重载重试规则配置：retry-rules.json](#83-热重载重试规则配置retry-rulesjson)
  - [8.4 惰性 MCP 配置：mcp.json（Notion 实战）](#84-惰性-mcp-配置mcpjsonnotion-实战)

---

## 1. 什么是 Agent Harness：执行宿主的本质边界

在当前 LLM 应用与 Coding Agent 的工程实践中，存在一个广泛的认知偏差：常常将 Agent 仅仅视为“带 System Prompt 的 LLM API 循环调用”。

然而，在面对实际编码工程时，LLM 是一个**概率性的、无状态的、对网络与格式极其脆弱的文本补全引擎**；而真实工程场景则要求**确定性的状态变更、操作系统级的进程与文件隔离、精确的错误重试、纳秒级的交互反馈以及对数万行代码上下文的精细编排**。

**Agent Harness（智能体执行宿主）正是连接这两者的中间件核心。** 它不仅是一个运行容器，更是整个系统的“操作系统”：

```
                ┌─────────────────────────────────────────────────┐
                │             Agent Harness (宿主运行环境)          │
                │                                                 │
 ┌──────────┐   │  ┌──────────────┐  ┌─────────────┐  ┌─────────┐ │   ┌───────────┐
 │          │   │  │              │  │             │  │         │ │   │           │
 │ Foundation◀──┼──┤ Wire Protocol│  │ Turn Loop   │  │ Tool    │ ┼───▶ OS & Env  │
 │ Model    │   │  │ & Cache Gate │  │ & Scheduler │  │ Runtime │ │   │ Filesystem│
 │ (Inference)  │  │              │  │             │  │ (Rust)  │ │   │ Process/PTY
 │          │   │  └──────────────┘  └─────────────┘  └─────────┘ │   │ Git/LSP   │
 └──────────┐   │         │                 │              │      │   └───────────┘
                │         ▼                 ▼              ▼      │
                │  ┌────────────────────────────────────────────┐ │
                │  │ TUI Presentation / Virtual URIs / Telemetry│ │
                │  └────────────────────────────────────────────┘ │
                └─────────────────────────┬───────────────────────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │  Developer   │
                                   │  (Terminal)  │
                                   └──────────────┘
```

Harness 的关键职责涵盖五个维度：
1. **调度与状态管理（Scheduler & Lifecycle）**：维护单 Turn 的 ReAct 循环，编排工具结果反馈，管理历史会话的树状分支，并在达到上下文阈值时实施智能压缩。
2. **环境与工具执行沙箱（Tool Runtime & Sandboxing）**：将模型输出的 JSON 结构化动作映射为本地文件 I/O、Patch 修改、PTY 终端命令执行或 LSP 类型诊断。
3. **协议与流式网络防御（Transport & Wire Resilience）**：处理跨供应商差异、思考输出隔离、流式断流恢复，以及针对中转 Relay 和 Prompt Cache 机制的底层微调。
4. **终端交互与视觉反馈（Presentation Engineering）**：以极低延迟（<16ms）通过差分算法渲染 TUI，实现跨终端图像协议呈现，并保证输入法、补全与快捷键的流畅。
5. **上下文外延与长期记忆（Context Extension & Recall）**：在有限的上下文窗口之外，构建开销可控的文件、Git 历史、全局会话与外部 Wiki 检索机制。

---

## 2. 全景对比矩阵：Upstream vs. Fork 演进

在实际编码实践中，本地 Fork 演进绝非仅对 upstream 做了边缘样式的修补，而是针对**国内中转反代网络脆弱性、高并发子任务调度死锁、Prompt Cache 隐蔽击穿、长程编码心智对齐以及终端极客审美**等实战极端痛点，在 6 大核心子系统内进行了系统级的架构强化（累计 33 个核心补丁系列与数十项深度改造）：

### 2.1 调度韧性与会话生命周期（Scheduling & Session Lifecycle）

| 改进特性 / 补丁编号 | 原生 upstream 实现 (`oh-my-pi`) | 本地 Fork 演进实现 | 核心改动文件 / 机制 | 解决的实战痛点与工程收益 |
| :--- | :--- | :--- | :--- | :--- |
| **流式中断断连自愈**<br>`Patch 31` | 流式连接因 Socket 意外关闭或网络超时断开时，由于部分文本已提交界面，原生将其标记为不可重试错误并直接钉死在终端 | 引入 `handlePartialStreamDeath` 三路分支决策，保留已提交文本，注入隐藏 `developer` 续跑指令，上限 3 次递增重试 | `session/turn-recovery.ts`<br>`session/agent-session.ts`<br>`prompts/system/partial-stream-resume.md` | 彻底解决长代码生成过程中遇到网络抖动或反代 RST 断连时，已生成内容全部作废、重复消耗 token 并导致截断死锁的痛点 |
| **子智能体状态机与续跑**<br>`Patch 30` | `AgentProgress.status` 仅粗粒度标记 `"running" / "completed"`；子任务被硬杀或异常退出后只能丢弃转录历史重新创建 | 10 阶段不可变单向跃迁状态机（`queued` $\to$ `tool` $\to$ `retrying` $\to$ `completed` 等），深冻结快照持久化；全面统一至 `write agent://<id>?resume=1` 显式幂等续跑协议 | `task/execution-state.ts`<br>`task/execution-view.ts`<br>`tools/hub/resume.ts`<br>`registry/persisted-agents.ts` | 子智能体在遭遇 429 退避或中途故障时具备精准可观测性；支持保留上下文原位接续执行，消除上下文丢失 |
| **会话模糊智能恢复**<br>`Patch 6` | `--resume` 仅支持传入完全精确的 UUID 会话文件名前缀，参数不匹配时必须退回交互式选择器 | 支持 `omp -r <fuzzy term>`，联合检索会话标题（Title）与首条 Prompt，按子串与子序列双重加权；单命中直接瞬间进入，多命中自动预筛选会话列表 | `src/utils/resume-match.ts`<br>`src/cli/main.ts` | 极大加快工作流切换速度，无需记忆无意义的哈希字符串，随手输入项目关键词即可秒级唤醒历史会话现场 |
| **会话选择器行内重命名**<br>`Patch 4` | 会话列表选择器仅支持查看与选择已有会话，修改会话名只能通过命令或手动编辑 JSONL | 在会话选择器列表内引入 `Ctrl+R` 快捷键，无缝调出行内编辑对话框，直接原子化持久化修改 `FileSessionStorage` 会话标题（标注 source: `"user"`） | `modes/session-selector.ts`<br>`components/custom-editor.ts`<br>`storage/file-session-storage.ts` | 允许开发者在整理归档数十个长会话时，实时重命名为具有明确业务语义的标题，消除认知混乱 |
| **Git 状态首帧极速预热**<br>`Patch 25` | 启动进入 TUI 绘制流程时行内同步或异步触发 Git 扫描，大仓库下首帧底部状态行存在明显卡顿与空白闪烁 | 在 CLI 启动入口初期，并行异步将 `git status` 探测下推至底层 Worker，首帧绘制时状态数据已内存就绪，零延迟上色 | `src/cli/main.ts`<br>`utils/active-repo-context.ts`<br>`status-line/component.ts` | 彻底终结数万文件大仓库中打开 CLI 时状态栏的白屏闪烁感，实现开箱即用的平滑手感 |

### 2.2 网络协议与中转反代对抗（Wire Protocol & Relay Resilience）

| 改进特性 / 补丁编号 | 原生 upstream 实现 (`oh-my-pi`) | 本地 Fork 演进实现 | 核心改动文件 / 机制 | 解决的实战痛点与工程收益 |
| :--- | :--- | :--- | :--- | :--- |
| **中文 400 思考降级**<br>`Patch 2` | 遇到第三方网关返回包含“不支持 thinking”等 400 响应时直接报错终止会话 | 引入自适应协商链，识别常见中文非标报错模式，安全将思考预算字段置空或映射为兼容字段，守住模型原生倾向 | `error/openai-reasoning-fallback.ts`<br>`test/reasoning-fallback-zh.ts` | 彻底兼容国内中转分发商魔改网关对思考参数的各种奇葩拒绝模式，避免无谓报错中断工作流 |
| **三层 [1210] 报错穿透重试**<br>`Patch 3` | 遵循标准 HTTP 语义，认为 4xx 属于客户端不可恢复错误，绝不进行退避重试 | 引入 `retryNonRetryableResponse` 专有通道，将伪装为 400 的中转内部错误（`[1210]`、始终思考网关）归入瞬态异常重试循环，并自动剔除历史 `<think>` 标签降级 | `fetch-retry.ts`<br>`openai-http.ts`<br>`flags.ts`<br>`retryable.ts` | 消除因第三方网关瞬时负载失衡导致的伪 400 假死断连，自动消化掉中转商的偶发路由故障 |
| **`cch` 哈希作用域锁死**<br>`Patch 18` | Claude Code 伪装参数每次会话生成或基于微观时间戳计算，请求头中的 `cch` 每一轮都在漂移，中转节点缓存键全失 | 作用域化限制 Attestation 计算前缀，确保连续多轮对话的认证哈希字节恒定，打通中转网关的缓存键校验 | `providers/claude-code-cloak.ts`<br>`providers/anthropic.ts`<br>`test/anthropic-cch-cache-stability.test.ts` | 实测 5 轮工具调用缓存命中率从 0/6 跃升至 4/6，Cache-write Token 暴降 61%，单会话响应耗时腰斩（80.8s $\to$ 43.4s） |
| **用户 Turn 强制块格式序列化**<br>`Patch 21` | 用户消息未挂载缓存时序列化为裸字符串，挂载缓存时被动态升级为数组，消息中段字符变化截断后续缓存 | 强制所有用户消息均采用标准 `[{type: "text"}]` 内容块序列化，从根本上锁死整个前缀字节序列的绝对恒定 | `providers/anthropic.ts`<br>`test/anthropic-cch-cache-stability.test.ts` | 彻底杜绝由于消息结构来回摆动引发的隐式缓存击穿，保证长会话中每一轮只为增量文本付费 |
| **Provider 声明式 Betas 穿透**<br>`Patch 19` | 客户端强制硬编码剥离非官方认可的 Beta 头；relay 要求专用标记（如 1M 上下文）时直接 400 拒绝 | 引入 `compat.extraBetas` 配置字段，与内置伪装链深度合并去重，安全直达底层传输报头 | `catalog/src/types.ts`<br>`providers/anthropic.ts`<br>`test/anthropic-alignment.test.ts` | 攻克部分中转服务商强制校验 `context-1m-2025-08-07` 请求头的严苛准入门禁 |
| **Prompt 包含型 Token 修正**<br>`Patch 22` | 在 Anthropic 兼容线路上，部分中转网关返回的 `input_tokens` 已经包含了缓存读取的 Token，导致统计严重虚高 | 增加 `promptIncludesCacheRead` 兼容标记，根据协议报文特征自适应剥离重复计算部分 | `providers/anthropic.ts`<br>`models-config-schema-bundle.ts`<br>`test/anthropic-stream-envelope.test.ts` | 保障成本核算与上下文滑动窗口预算的绝对准确，防止误判导致过早触发紧急压缩 |
| **Codex 身份透传保活**<br>`Patch 27` | 原生在请求层覆盖了自定义请求头，导致中转指定的 Originator / UA 被冲掉触发 403 风控 | 在 `createCodexHeaders` 建立缺省才覆盖原则（Set-if-absent），允许模型配置透传专属鉴权指纹 | `providers/openai-codex-responses.ts`<br>`test/openai-codex-header-pins.test.ts` | 解决针对 OpenAI Responses / Codex 接口特殊定制反代环境下的严格身份校验问题 |
| **热重载重试规则引擎**<br>`Patch 28` | 重试判定规则完全硬编码于 TS 源码，遇到线上新型报错必须修改代码并重新编译二进制 | 引入外部配置文件 `~/.omp/agent/retry-rules.json`，支持双向正则、错误事件码与重试预算秒级动态热更新 | `error/user-retry-rules.ts`<br>`error/retryable.ts`<br>`test/user-retry-rules.test.ts` | 生产运维零停机：遇到代理服务商突发临时非标报错时，几秒内追加一行正则即可完成自愈拦截 |
| **多 API Key 轮询凭据池** | 仅支持单一 API Key；Key 配额耗尽或遇并发限速（429）时整个会话崩溃报错 | 运行时引入 `authStorage.keys.setConfigPool` 轮询池，支持配置多 Key 自动故障剔除、权重分配与透明轮转 | `src/auth/` 与模型凭据管理子系统 | 支撑高并发大规模自动化脚本与子智能体团队执行，消除单 Key 速率配额瓶颈 |

### 2.3 工具运行时、虚拟协议与环境扩展（Tool Runtime, Virtual URIs & Extensions）

| 改进特性 / 补丁编号 | 原生 upstream 实现 (`oh-my-pi`) | 本地 Fork 演进实现 | 核心改动文件 / 机制 | 解决的实战痛点与工程收益 |
| :--- | :--- | :--- | :--- | :--- |
| **工具意图一等公民管道**<br>`Patch 9` | 工具卡片仅展示冷冰冰的工具名与物理参数，无法获知 Agent 调用该工具的即时思维动机 | 工具入参统一引入 `i`（Present-participle Intent）参数，管道化穿透至渲染器与转录历史，卡片顶栏金黄色浮雕呈现 | `tool-execution.ts`<br>`read-tool-group.ts`<br>`event-controller.ts` | 消除 Agent 连续执行多步操作时人类的认知黑盒，使机器心智与开发者意图实时同步对齐 |
| **统一虚拟 URI 路由体系** | 内部各种子系统通信与扩展工具依靠异构的方法调用或硬编码魔术参数 | 规范建立全栈虚拟 URI 体系（`agent://`, `history://`, `local://`, `proc://`, `cfg://`, `ssh://`, `xd://`） | `src/tools/` 统一路由派发机制 | 将复杂环境操作升格为一致的 RESTful 资源语义，解耦工具入参契约，天然支持沙箱审计切面 |
| **惰性连接 MCP 工具网关** | 启动时同步或全量异步连接所有声明的 MCP 服务器并拉取全量 Schema，拖慢启动且撑爆首轮上下文 | 实现 Lazy MCP Gateway（`#lazyHeld` / `#lazySources`），平时仅暴露占位设备，当智能体主动接入时按需即时握手挂载 | `src/mcp/manager.ts`<br>`src/mcp/types.ts` | 解决挂载 Notion、GitHub、数据库等多 MCP 时导致的冷启动卡顿和上下文空间被未用工具浪费的问题 |
| **全局会话全量极速回溯**<br>`Patch 11` | 只能加载当前会话；回溯以往会话的决策需要手动切换或者依靠庞大的全局提示词注入 | 引入 `extensions/recall.ts`，提供 `history_search`（单会话全分支）与 `session_search`（全局 800+ 会话 BM25 毫秒级预过滤索引） | `extensions/recall.ts`<br>`packages/coding-agent/src/recall/` | 使得智能体能够以零提示词常驻成本，秒级翻阅数月前沉淀在磁盘上的代码诊断与架构经验 |
| **全局视口无感跳转**<br>`Patch 10` | 数百轮的长会话中，终端翻页与滚动手感极其沉重，极难准确定位早期的问答交界点 | 引入 `session-nav.ts`（快捷键 `Alt+U`），弹出所有用户 Turn 的模糊检索器，回车瞬间将真实转录视口定位至对应区块 | `extensions/session-nav.ts`<br>`src/modes/interactive-mode.ts` | 解放长程审阅与回溯负担，支持以问答为锚点在海量代码输出流中瞬间闪烁穿梭 |
| **伴生桌面微宠守护进程**<br>`Patch 12` | 传统的系统级通知在全屏开发或多屏沉浸时极易被系统静音或忽略，后台长任务缺乏低干扰反馈 | 实现 `pet-bridge.ts`，通过 Unix Domain Socket 异步驱动屏幕角落轻量微宠（`omp_pet.py`），实时镜像 Agent 思考、工具、报错与完工状态 | `extensions/pet-bridge.ts`<br>`omp_pet.py`<br>`skins.py`<br>`motions.json` | 在零打扰的前提下提供全局物理级可观测性，后台并发任务完成时无需频繁切屏检查终端 |
| **只读工作区检查器**<br>`Patch 14` | 开发者在会话中想要审查未提交的 Git 状态或临时修改时，必须中断 Agent 或另开终端执行 `git status/diff` | 引入基于只读快照机制的 Workspace Inspector，支持在会话行内快速调阅当前受控工作区树拓扑与变更指纹 | `workspace-inspector/`<br>`git-snapshot.ts` | 减少会话上下文切换摩擦，提供隔离的环境安全审查视口 |
| **Browser Relay 真实浏览器接管** | 传统无头浏览器（Headless Chromium）缺乏用户登录态（Cookie/2FA/SSO），拉起消耗数百兆内存且极易被 WAF/Turnstile 拦截 | 引入本地 CDP 伪装网桥（`bridge.ts`）+ Chrome MV3 扩展，在 9224 端口模拟标准 CDP，单 Attachment 虚拟复用多个 Puppeteer 客户端；自动建立 `"omp"` 标签组并受控保护用户前台焦点 | `tools/browser/relay/bridge.ts`<br>`tools/browser/relay/server.ts`<br>`tools/browser/relay/daemon.ts` | 赋予 Agent 直接驱动开发者本机已登录真实浏览器（抓取内网文档、调试本地 Web 应用、绕过反爬）的能力，且绝不篡改前台活跃标签或杀掉浏览器进程 |
| **Hashline 行级精确定位编辑引擎** | 传统 Unified Diff 补丁易因缩进空白漂移导致 Hunk failed；Search-and-Replace 易在重复通用代码行处发生歧义误伤 | 4 字节十六进制快照哈希锚定（`[path#TAG]`），乐观锁拦截过期幻觉；确定性物理行号区间（`PUT N.=M:`）+ Tree-sitter 语法块识别（`PUT N*:`）；命名寄存器零 Token 代码搬运 | `packages/hashline/`<br>`packages/coding-agent/src/edit/` | 彻底杜绝代码编辑中的 Patch 拒绝与幻觉覆写风险，跨文件重构零 Token 重写 |
| **持久化 PTY 会话与 Bash 沙箱** | 简单子进程调用（`child_process.exec`）无状态，`cd` 与环境变量无法跨 Turn 维持；缺少真实 PTY 支持导致复杂终端工具卡死 | 后台常驻真实 PTY 进程维持全局状态；注入带随机哈希签名的 `PROMPT_COMMAND` 哨兵精准捕获输出边界与退出码；通过 `proc://<pid>` 虚拟设备纳管长时异步后台作业 | `packages/coding-agent/src/tools/bash.ts`<br>`src/exec/` | 还原真实开发者的终端操作连续性，支持后台服务长期运行与实时审计 |
| **Rust 原生计算下沉架构** | 纯 JavaScript/Bun 正则扫描大仓库文件或解析多语言 AST 时，JS 主线程面临严重 GC 停顿与卡顿 | 核心计算密集型任务下沉至 Rust cdylib（`crates/pi-natives`），内联多线程 Ripgrep 内核、Tree-sitter 语法着色、SIMD 快速哈希；带版本强校验哨兵门禁（`__piNativesV18_x_x`） | `crates/pi-natives/`<br>`packages/natives/` | 保障在数十万行 Monorepo 中高频扫描搜索与语法高亮达到纳秒级响应，ABI 哨兵杜绝内存段错误崩溃 |
| **Auto-Learn 智能体自进化闭环** | 智能体为用完即弃的无状态消耗品，排障踩坑经验随会话结束而消亡；人工写 Skill 成本高昂易中断 | 状态机看门狗判定高复杂度任务（$\ge 5$ 工具调用），过滤 Abort 中止与 Goal 冲突；被动常态模式保活 Prompt Cache，主动采撷模式拉起隔离子 Agent 自动提炼 Managed Skill 与事实沉淀 | `packages/coding-agent/src/autolearn/controller.ts`<br>`autolearn/managed-skills.ts`<br>`prompts/system/autolearn-*.md` | 实现智能体在实战排障中自发沉淀可复用工作流与技能，渐进式披露（Progressive Disclosure）零常驻 Token 负担 |

### 2.4 检索通道与长期记忆后端（Search Channels & Memory Backend）

| 改进特性 / 补丁编号 | 原生 upstream 实现 (`oh-my-pi`) | 本地 Fork 演进实现 | 核心改动文件 / 机制 | 解决的实战痛点与工程收益 |
| :--- | :--- | :--- | :--- | :--- |
| **活跃模型同源搜索通道复用**<br>`Patch 8` | 网络搜索需要配置独立搜索引擎 API Key，无法借用已有的主模型高级权限与连接池 | 建立 Search Affinity 机制：GPT 主模型自动借用 Codex 搜索通道；Claude 主模型自动借用其专属 Messages 传输端点与伪装头 | `web/search/providers/codex-affinity.ts`<br>`web/search/providers/anthropic-affinity.ts`<br>`test/provider-chain.test.ts` | 避免为网络搜索额外购买昂贵的独立专用通道，大幅降低运维成本并复用主模型的优质网络出口 |
| **Grok Relay 网络搜索通道**<br>`Patch 23` | 仅支持 Google/Exa/Brave 等传统引擎，对新兴具备强实时推理能力的搜索通道缺乏支持 | 适配 xAI / Grok 原生搜索接口，支持声明式配置端点、模型与凭据池，并接入真实搜索结果门禁校验 | `web/search/providers/grok.ts`<br>`grok-responses.ts`<br>`web-search-grok.test.ts` | 为复杂实时工程问题（如前沿开源库最新版本、最新 CVE 漏洞）提供极高质量的互联网事实注入通道 |
| **Mnemopi 启动差分同步**<br>`Patch 24` | 每次打开记忆数据库时无条件重新全量比对并重建 FTS 全文索引镜像，冷启动耗时增加约 500ms | 增加版本号与漂移判定门禁（Gated on drift），仅在检测到模式升级或数据漂移时才执行差分同步 | `packages/mnemopi/src/schema.ts`<br>`packages/mnemopi/src/fts-sync.ts`<br>`test/fts-cjk-bigram.test.ts` | 大幅削减 CLI 会话初始化延迟，使交互式终端达到真正的“即敲即开” |
| **向量重建丢失防护与重排熔断**<br>`Patch 26` | 当中转嵌入模型遇到 429 配额限制或网络故障时，向量对齐任务会无限次重试，甚至导致已有本地向量被抹除 | 引入数据丢失防御门禁与持久化的重入冷却时间戳（Cooldown），遇到异常自动熔断并保留本地既有向量资产 | `packages/mnemopi/src/store.ts`<br>`packages/mnemopi/src/embeddings.ts`<br>`test/embedding-model-reconcile.test.ts` | 彻底终结网络不稳定时陷入无休止的模型嵌入重建与配额消耗死循环，守住本地知识库底线 |
| **外部知识库深度对接** | 记忆局限于当前会话或脆弱的内部 SQLite 数据库，不易被其他工具（如 Obsidian/VS Code）直接复用 | 深度对接外部独立知识库（`~/文档/omp-wiki`），通过统一的 `retain`（按需入库）与 `recall`（语义提取）解耦存储 | `src/tools/retain.ts`<br>`src/tools/recall.ts` 结合外部 Markdown Vault | 将特定工程约定、环境架构陷阱沉淀为可由 Git 版本控制的永久性 Markdown 文档，杜绝随会话结束而消亡 |

### 2.5 终端呈现工程与交互美学（TUI Presentation & Interaction Ergonomics）

| 改进特性 / 补丁编号 | 原生 upstream 实现 (`oh-my-pi`) | 本地 Fork 演进实现 | 核心改动文件 / 机制 | 解决的实战痛点与工程收益 |
| :--- | :--- | :--- | :--- | :--- |
| **用户气泡圆角与 Shell 集成**<br>`Patch 1` | 用户输入直接以裸文本或粗糙方框展示，且缺少现代终端 Shell 集成标记 | 采用 `theme.symbols.boxRound` 构建完整包裹的圆角输入气泡，并无缝集成 OSC 133 转义序列 | `packages/tui/src/chat/user-message.ts` | 视觉更加现代柔和，同时允许 Kitty 等终端通过原生快捷键在各次提问之间精准分段跳转 |
| **卡片纯透明轻量化边框**<br>`Patch 5` | 工具卡片在 Pending / Running / Error 状态下采用大面积实心暗色背景填充，破坏透明主题 | 剔除实心背景填充，统一改用高对比度纯外框架构（保留 `borderAccent`），错误文本精准涂红 | `output-block.ts`<br>`default-renderer.ts`<br>`tool-execution.ts` | 消除刺眼的色块割裂感，与现代 Linux 桌面毛玻璃透明环境（`amethyst-glass`）达到完美的视觉融合 |
| **圆角代码块与行号独立槽**<br>`Patch 32` | 仅输出两道暗淡横线（Fence），且代码行缩进与外框存在 1 列右偏错位，无行号展示 | 重写 `#renderCodeBlockBox`：采用 `boxRound` 边框，顶部浮雕语言标头，左侧内置右对齐行号槽与软折行空白槽 | `packages/tui/src/components/markdown.ts`<br>`docs/theme.md`<br>`test/markdown.test.ts` | 达到媲美 GUI 编辑器的代码展示质感，极大降低开发者在终端内审阅数十行代码实现的视觉负担 |
| **Markdown 标题语法脱敏与阶梯字重**<br>`Patch 33` | 三级以下标题直接将 Markdown 源码 `### ` 裸露打印在屏幕上，产生严重的“未解析源码感” | 彻底剥离 `headingPrefix` 标记，建立纯视觉单调递减字重阶梯：H1 终端双倍字高+粗体下划线、H2 粗体、H3 主题色、H4+ 斜体 | `packages/tui/src/components/markdown.ts`<br>`test/markdown.test.ts` | 消除语法泄漏带来的粗糙感，让长篇技术方案的排版层次自然呈现，阅读体验显著跃升 |
| **Kitty 图形多 Screen 账本与 Unicode 占位排版**<br>`Patch 13` | 原生光标绝对坐标定位（`a=p`）在复用器分屏下滚动脱节错位，且进入 Alt Screen 退出后底层纹理被清空变白 | 采用 `U=1` + `\u{10eeee}` 结合 297 个组合字符将图片嵌入普通文本网格，天然支持软折行与水平切片；配合双屏状态账本（`#transmittedMain/Alt`）在退出全屏时自动差分重放 | `packages/tui/src/kitty-graphics.ts`<br>`packages/tui/src/components/image.ts`<br>`packages/tui/src/tui.ts` | 彻底解决终端中全屏查看历史会话或按键交互后图片丢失，使内联图片在分屏复用器下稳定保持相对排版 |
| **草稿图片带形状自适应**<br>`Patch 20` | 原生增加 `band` 无边框模式后，输入框上方的图片待发预览条硬编码了边框占位，导致排版向右突出错位 | 统一走 `style.renderRow` 进行动态排版，抹平 8 种 Composer 形状（box/band/rail 等）的边距差异 | `modes/components/custom-editor.ts`<br>`modes/components/editor.ts` | 保证在多张待发送截图暂存时，不同输入框主题下的预览小图排版均能绝对居中对齐 |
| **WebP 异步转码冻结竞态防御**<br>`Merge 修复` | Upstream 18.1.x 将已结算块视为只读不可变，而 WebP 转 PNG（约 400ms）尚未完成时，提前固化了文本占位符 | `ImageStrip` 暴露 `conversionsPending` 门禁，拦截提早结算；工具执行层支持带防抖的转码重试 | `UserMessageComponent.ts`<br>`tool-execution.ts`<br>`transcript-container.ts` | 根治会话恢复（Resume）时历史图片偶尔被冻结为 `[Image: image/webp]` 文本占位符的暗疾 |
| **Bash 模式下的 Ctrl+R 历史检索**<br>`Patch 15` | 原生内置 Shell 模式仅支持基本的行输入与方向键上下翻阅历史，无法快速回溯多天前的长命令 | 完整引入类似现代 Shell 的 Ctrl+R 模糊逆向匹配交互面板，支持高亮关键词与一键回填执行 | `packages/coding-agent/src/modes/shell-history.ts` | 极大提升在 Agent 会话中临时手动执行辅助诊断命令时的交互效率 |
| **Bash 模式下的 Tab 补全与幽灵文本**<br>`Patch 16` | 输入命令时没有任何内联预测提示，必须完整打出整个长路径或命令名 | 引入基于本地历史命令的实时浅色幽灵文本（Ghost Text）预测，支持按下 `Tab` 或 `Right-Arrow` 一键接受补全 | `packages/coding-agent/src/modes/bash-autocomplete.ts` | 还原真实开发环境下现代智能 Shell（如 Fish / Zsh-autosuggestions）的肌肉记忆手感 |
| **半透明毛玻璃主题深度调优** | 仅官方内置的有限几套纯黑或纯白实心主题，在透明终端下背景会被强制抹黑 | 结合 `amethyst-glass` 专属色彩规范，全量微调行内语法高亮对比度，使字体在多变桌面壁纸上依然清晰可读 | `~/.omp/agent/themes/amethyst-glass.json` | 打造极具未来感的通透开发视口，消除长时间高强度面对纯黑终端产生的视觉疲劳 |
| **Composer 全要素智能补全与东亚宽对齐** | 输入框仅有基础光标移动，缺少高频指令与上下文感知；中文字符导致下拉菜单错位撕裂 | 统一提供 `/` 指令频次加权排序与二级参数级联、`@` 文件树 Git 预热检索；全面基于 `Bun.stringWidth()` 计算 CJK 宽字符与 Nerd 图标物理列宽，弹窗像素级精准对齐光标 | `@oh-my-pi/pi-tui/prompt/`<br>`modes/input-controller.ts`<br>`interactive-mode.ts` | 极大降低路径敲击与指令记忆负担，彻底消除中文终端环境下浮窗向右漂移撕裂的显示瑕疵 |
### 2.6 运行时可观测性与计量度量（Observability & Telemetry）

| 改进特性 / 补丁编号 | 原生 upstream 实现 (`oh-my-pi`) | 本地 Fork 演进实现 | 核心改动文件 / 机制 | 解决的实战痛点与工程收益 |
| :--- | :--- | :--- | :--- | :--- |
| **Turn 级聚合工作计量看板**<br>`Patch 7` | 底层仅按单次模型流式请求在日志中孤立记账，开发者无法直观获知解决单句需求的总实际消耗 | 引入 `WorkUsageAccumulator`，贯穿多轮工具调用，在回合末尾打印暗色聚合看板：`⏱ turn N req 3 ⤵ in 2.4k ⤴ out 420 💾 cache 12k ⚡ span 4.2s` | `packages/coding-agent/src/modes/work-usage.ts`<br>`chat-transcript-builder.ts`<br>`event-controller.ts` | 让用户与模型对当前 Turn 经历的真实往返、缓存效益有明确度量；即使中途被 Esc 强制打断，已产生的算力消耗也能忠实入账 |
| **Web 搜索耗时与吞吐量遥测**<br>`Patch 29` | 搜索卡片仅展示最终获取的网页文本，对耗时分布与网络连接情况缺乏透明度 | 测量从发起检索、链式降级尝试、到获取完整文本的全流程耗时，并动态计算 `searchThroughput` 真实吞吐速率（tok/s） | `web/search/types.ts`<br>`web/search/render.ts`<br>`web/search/provider.ts` | 提供一手量化的网络排障证据，明确指示网络延迟瓶颈究竟源自搜索引擎降级还是模型出流缓慢 |
---

## 3. 调度循环、状态生命周期与执行韧性

### 3.1 原生 ReAct 调度、上下文滑动压缩与会话 DAG

Upstream 的核心控制反转引擎位于 `packages/agent` 与 `packages/coding-agent/src/session/`。其调度循环本质是一个强类型的 ReAct（Reasoning + Acting）流式迭代器：

```mermaid
stateDiagram-v2
    [*] --> Idle: 等待用户输入
    Idle --> AssemblingContext: 用户提交 Prompt
    AssemblingContext --> ContextCompacting: 检查 Token 预算
    ContextCompacting --> ModelStreaming: 组装 System + Tool + Messages
    ModelStreaming --> ParsingChunks: SSE 数据包流式接入
    ParsingChunks --> ToolCallDetected: 模型触发 Tool Call
    ParsingChunks --> TurnSettled: 模型仅输出纯文本 / 结束标记
    ToolCallDetected --> ToolExecuting: 并行/串行执行本地工具
    ToolExecuting --> FeedbackLoop: 格式化 ToolResult 注入上下文
    FeedbackLoop --> ContextCompacting: 进入下一轮调度
    TurnSettled --> Idle: 渲染完整结果并等待
```

#### 上下文滑动压缩（Context Compaction）
在长会话场景下，`compaction.ts` 负责监控 Token 上限。当估算或返回的 Prompt Token 超过设定的阈值时，Harness 会启动自动压缩：
1. 锁定最早的未保护 Turn 集合。
2. 构造专用的 Summary Prompt，调用轻量模型将早期历史提炼为结构化的摘要块（包含文件变更状态、未完成目标、已验证的结论）。
3. 用摘要块替换被裁减的历史消息，并重建会话在内存中的上下文指针。

#### 会话 DAG 持久化
原生会话系统通过 `FileSessionStorage` 以 JSONL 追加写入方式保存。每条记录均包含唯一 `id` 与 `parentId`，天然构成一颗可回溯、可分叉的会话 DAG 树。这使得 `/rewind`（回滚）和 `/fork`（新分支探索）无需拷贝完整副本，仅需在写入新行时调整父节点指针即可实现轻量级状态分叉。

---

### 3.2 Fork 流式中途断连恢复机制（Mid-Stream Death Recovery）

**工程痛点**：在依靠代理网关或大并发使用模型时，经常遭遇由于连接复用中断、TCP 假死、HTTP/2 RST 或反向代理超时引发的底层异常：
`The socket connection was closed unexpectedly` 或 `stream closed before a finish_reason`。

**原生缺陷**：原生 `TurnRecovery` 逻辑会将此类异常归类为终端故障；若已有部分 Token 打印在终端上，原生拒绝回滚重试（避免文本在界面上产生重复内容），直接将错误钉死在当前 Turn，用户只能手动重新发问，丢失上下文连贯性。

**Fork 解决方案**（实现于 `packages/coding-agent/src/session/turn-recovery.ts` 与 `agent-session.ts`）：
1. **断连拦截与分类器**：引入 `matchesMidStreamDeathText`，联合 `@oh-my-pi/pi-utils` 的 `isUnexpectedSocketCloseMessage`，精确捕获底层 Socket 关闭与中途断流异常。
2. **三路续跑决策**：
   - 若断流发生在工具调用已经全部结算之后，走 `classifyResolvedInterruptedToolTurn` 正常完结。
   - 若未曾产生可见输出，走常规回滚重新生成。
   - **核心创新**：若断流发生在已提交（Committed）部分可见文本之后，触发 `handlePartialStreamDeath`。
3. **隐藏指示注入与防重复断言**：
   - 不抹除当前已生成的半截 Assistant 消息，将其封冻在转录历史中。
   - 动态追加一条隐藏的系统层级指令（`prompts/system/partial-stream-resume.md`），以 `developer` 角色提示模型：“*上一轮输出在传输层非预期中断，请紧密承接上文继续输出，切勿重复已生成的前半部分*”。
   - 设置最大递增计数器 `PARTIAL_STREAM_RESUME_MAX_ATTEMPTS = 3`，保障在连续异常时能够安全熔断而不死循环。

---

### 3.3 Fork 子任务细粒度不可变状态机与显式续跑协议

**原生缺陷**：在 upstream v18.0 - v18.2 中，并发派发给 Subagent（`task` 工具）的执行状态仅有一个粗粒度的 `AgentProgress.status: "running" | "completed"`。当一个子任务由于上游 429 陷入退避休眠，或者因为异常被中断时，父级协调器无法探知其细粒度阶段，界面上也只能显示空洞的加载动画；若子智能体异常停止，只能以丢失其所有本地转录记录为代价强行重新创建。

**Fork 解决方案**（重构于 `task/execution-state.ts`, `task/execution-view.ts` 及 v18.3.0 适配）：
1. **不可变状态机快照（Immutable Phase Machine）**：
   设计了具有严格单向跃迁特性的 10 阶段状态机：
   $$\text{queued} \longrightarrow \text{creating} \longrightarrow \text{waiting-model} \longrightarrow \text{responding} \longrightarrow \text{tool} \longrightarrow \text{waiting} \longrightarrow \text{retrying} \longrightarrow \text{finishing} \longrightarrow \{\text{completed} \mid \text{failed} \mid \text{cancelled}\}$$
   每次状态变迁均返回经 `Object.freeze()` 深度冻结的全新快照，杜绝并发竞争导致的状态污染。
2. **低开销写入与崩溃自愈**：
   仅当 `persist: true` 且阶段发生实质变化时，才将执行状态持久化到注册表，避免流式心跳刷爆转录日志；一旦进程重启或会话暂停，历史快照即可作为恢复现场的证据链。
3. **统一协议显式续跑**：
   在 upstream v18.3.0 彻底移除外部 `hub` 独立工具后，Fork 将子任务恢复机制全面升格为标准的内部 URI 协议：
   `write agent://<id>?resume=1`
   - 携带完整的延续血统（Continuation Lineage），将新 Turn 的重试指标与已沉淀的历史合并计算。
   - 具备幂等调度保护：对处于排队中的恢复请求进行防抖去重，避免重复派发并发冲突。

---

### 3.4 Fork 启动期冷启动优化：异步 Git 状态预热

在大型代码仓库（包含数万个变更、深度子模块）中启动 CLI 时，主界面为了在底部 Status Line 显示当前分支名、Dirty 变动数、Staged 统计，原生往往在初次进入 TUI 绘制流程时同步或行内异步触发 Git 扫描，导致终端首屏出现明显的“白屏”或状态栏闪烁。

Fork 在 `main.ts` 入口初始化初期，于加载复杂主题和配置之前，即行内调用 `active-repo-context.ts` 的原生加速接口，将 `git status` 探测下推至后台 Worker 并发线程。当首帧 UI 绘制时，Git 拓扑数据已经处于内存就绪状态，首屏即可直接完成带有高亮差异指示的像素级渲染。

### 3.5 全局模糊检索与会话流转引擎（Fuzzy Search & Resume Engine）

在日常高强度使用中，开发者每天会创建数十个临时或长程会话，同时在输入框中高频引用工程文件。如果每一次会话恢复都依赖精准的 UUID 前缀，每一次文件引用都需要完整敲击长路径，交互摩擦力将成倍放大。

Harness 在底层构建了一套打通 CLI 启动参数、TUI 模态选择器与 Composer 行内编辑器的全场景模糊检索体系：

#### 1. CLI `-r` / `--resume <term>` 模糊唤醒算法（`fuzzyMatchResumableSessions`，Patch 6）
原生 `--resume` 仅支持精确匹配会话文件名（通常是 ISO 时间戳或 UUID）。Fork 在 `packages/coding-agent/src/session/session-listing.ts` 中实现了一套面向开发者心智模型的智能召回算法：
- **双重文本域联合检索**：
  对本地及全局会话列表展开扫描，提取每个会话的两个核心文本特征：会话标题（`session.title`）与用户首轮 Prompt 诉求（`session.firstMessage`）；
- **分级惩罚打分模型（Lower Score = Better Match）**：
  $$\text{Score} = \text{MatchOffset} + (\text{isTitleMatch} ? 0 : 100) + (\text{isLocalScope} ? 0 : 1)$$
  1. **连续子串匹配（Substring）**：`lower.indexOf(normalizedTerm)`。子串匹配拥有绝对优先权，匹配位置越靠前（`MatchOffset` 越小）得分越好；且标题匹配权重大于首条消息匹配（首条消息增加 100 惩罚分）；
  2. **离散字符子序列（Subsequence Fallback）**：若未命中子串，启动 `isFuzzySubsequence` 检查（确保搜索词的每个字符按顺序出现在文本中）。命中子序列赋予 1,000 的保底分；
  3. **项目作用域优先（Scope Boost）**：当前工程本地的会话享受 0 惩罚，跨项目的全局历史会话叠加 +1 惩罚分，确保同等匹配度下本地会话恒定胜出；
- **时间衰减仲裁**：当得分相同时，严格按照修改时间逆序排列（`b.session.modified - a.session.modified`），最近活跃的会话排在最前；
- **二元交互短路矩阵**：
  - **单命中（Single Match）**：直接短路跳过一切 TUI 渲染与选择菜单，毫秒级直接加载目标会话进入主界面，实现“一敲即达”；
  - **多命中（Multiple Matches）**：自动拉起 TUI 会话选择器，但将用户的搜索词直接预填（Prefill）进交互过滤框，高亮首选项供用户快速确认或方向键筛选。

#### 2. TUI 内部 Session Selector 虚拟化滚动与词局部匹配（`packages/tui/src/fuzzy.ts`）
当按下快捷键进入全屏会话选择器时，面临数百个长标题会话的即时过滤挑战：
- **词局部匹配（Word-Local Matching）**：
  原生通用的子序列模糊匹配容易产生严重的“离散噪音”（例如输入 `"image"`，长句中由于随机分散出现了 i-m-a-g-e 五个字母而被错误召回）。`packages/tui/src/fuzzy.ts` 引入基于单词边界的匹配引擎：只在单词首字母、驼峰边界（CamelCase）或连续词块中寻找命中，并给予前缀命中 1,200 分的强劲加成（`COMPACT_PHRASE_BONUS`）；
- **虚拟滚动视口（Virtualized Viewport）**：
  无论本地沉淀了 50 个还是 5,000 个会话，列表组件仅渲染终端视口高度内可见的行切片，配合快速轻量的二分定位，确保无论列表多大，每一击按键的过滤延迟均小于 2 毫秒；
- **行内原子重命名（Ctrl+R Rename，Patch 4）**：
  在选择器列表中选中任一历史会话，按下 `Ctrl+R` 即可在当前行原地置换出输入弹窗（`HookInputComponent`）。提交后调用 `FileSessionStorage.updateSessionTitle` 原子修改 JSONL 头部的标题，并显式标注 `source: "user"`。该标记赋予该标题最高守护权，杜绝后续模型在会话再次恢复时使用自动摘要将其覆盖。

#### 3. Composer 编辑框 `@` 文件引用与符号模糊补全
在交互式提问框中输入 `@` 时，Harness 触发上下文符号补全：
- **文件系统前缀树与 Ripgrep 预热**：通过后台 Worker 缓存活跃 Git 仓库的文件树索引；
- **终端东亚宽字符光标对齐**：通过 `Bun.stringWidth()` 严格计算中文路径与 Nerd 图标的物理单元格占用，确保浮窗始终精确锚定在 `@` 字符正下方，杜绝光标视觉错位。

---

## 4. 工具执行运行时、虚拟资源协议与记忆外延

### 4.1 原生工具集体系、MCP 网关与 Rust Native 加速

Upstream 提供了一组极为精炼的基础工具：
- **文件与搜索**：`read`（支持行区间、多路径、SVG/图片预览）、`edit`（基于 hashline 的高精度局部行编辑，摒弃不稳定的全文正则替换）、`write`、`glob`、`grep`、`find`。
- **执行宿主**：`bash`（内置持久化 Shell 会话、PTY 仿真）、`eval`（基于 Bun / QuickJS 的行内代码沙箱）。
- **Native 扩展**：核心计算密集型操作（如文本模糊匹配、基于 Tree-sitter 的代码高亮切片、Ripgrep 驱动的文件扫描）下沉至 `crates/pi-natives`，编译为 Node-API（`.node`）动态库接入，在 Node/Bun 运行时内取得接近 C/Rust 的极限性能。
- **MCP 接入**：具备标准的 Model Context Protocol 客户端支持，支持通过 stdio 或 SSE 连接远程第三方工具服务器。

---

### 4.2 Fork 虚拟 URI 资源路由体系（agent://, history://, xd://）

为了解决工具生态膨胀后带来的参数异构、权限越权和认知负荷，Fork 在执行宿主内部构建了一套基于标准 URI 语法的**虚拟设备与资源协议层**：

| URI Schema | 资源语义与定位目标 | 典型操作与数据流转 |
| :--- | :--- | :--- |
| `agent://<id>` | 子智能体通信与生命周期总线 | `read agent://<id>` 读取子 Agent 结构化输出；`write agent://<id>?resume=1` 触发显式恢复续跑 |
| `history://<id>` | 只读历史会话转录流 | 提供对历史交互 Turn、系统事件的只读结构化回放，隔离运行期可变状态 |
| `local://<file>` | 智能体之间的共享大工件（Artifacts） | 超出单次 Prompt 预算的大文本/二进制结果写入本地工件池，避免在指令总线中内联撑爆上下文 |
| `proc://<pid>` | 长时间后台任务进程控制面 | `read proc://123` 监控输出流，`write proc://123` 传递标准输入，`write proc://123/kill` 安全终止 |
| `cfg://<ns>/<key>` | 运行时可配置项即时检查与受控修改 | 规范 Agent 对自身配置的读取与热修改，会话级生效与永久保存显式分离 |
| `ssh://host/<path>` | 远程主机文件与环境映射 | 跨越宿主边界，直接利用统一的 `read`/`write`/`grep` 语法操纵远程受控机器文件 |
| `xd://<device>` | 挂载型专用扩展设备总线 | 隔离特殊底层驱动（如 `xd://ast_edit` 结构化语法重构、`xd://debug` DAP 调试、`xd://lsp` 诊断） |

这一设计将原本松散的命令调用提升为结构化的资源操作，天然支持基于 URI 模式的前缀鉴权与审计切面。

---

### 4.3 Fork 工具调用意图（Intent）的一等公民管道穿透

**交互痛点**：当 Agent 连续调用多个工具（例如连续阅读 5 个文件、执行 3 条查找命令）时，终端用户仅能看到冷冰冰的命令名与一长串参数，无法得知 Agent“为什么现在要读这个文件”。

**Fork 解决方案**（贯穿 `tool-execution.ts`, `read-tool-group.ts`, `event-controller.ts`）：
1. **Schema 扩展**：在所有核心工具的入参中统一定义 `i`（Present-participle Intent，如 `"Reading model role settings"`）参数。
2. **管道穿透**：将 `toolCall.intent` 穿透至事件控制流实时渲染器、会话重建器（`chat-transcript-builder`）及合并卡片渲染上下文。
3. **视觉突显**：在 TUI 工具卡片的顶边栏首行，以专属高亮字重和 `✦/*` 图标独立浮雕渲染该意图标签，使 Agent 的思维步调与人类意图对齐。

#### 实机呈现：意图穿透与代码智能工具卡片（LSP References）

下图展示了在定位代码符号调用点时，LSP 工具卡片如何结合意图穿透（Intent Annotation）与层级代码树直观呈现：

![LSP 代码智能工具执行卡片](./assets/tui-lsp-card.png)

- **首行高亮意图浮雕**：`✦ Locating symbol references across auth and router modules` 采用金色 Accent 字体直接嵌入边框内，在工具尚未开始执行或流式传输时即向用户透明化执行动机；
- **分层引用索引树**：清楚呈现跨文件（`src/server/auth.ts`, `src/server/middleware/session.ts`, `src/server/router.ts`, `test/auth.test.ts`）的精确行列定位与符号上下文；
- **透明框架与折叠交互**：支持通过 `Ctrl+O` 动态展开折叠局部代码上下文，摒弃冗长杂乱的终端日志打印。

#### 实机呈现：多模态图像资产只读探测卡片（Read Image Metadata）

针对工程中的图片、架构图与视觉素材，执行宿主支持通过 `read` 工具进行无损探测与轻量级元数据解析，既不污染模型的 Text 上下文，又能为终端开发者提供关键视觉资产信息：

![图像资产读取与元数据解析卡片](./assets/tui-image-read-card.png)

- **意图注入**：`✦ Inspecting system architecture overview graphic asset` 标明当前读取意图；
- **物理规格精确呈现**：清晰呈现 MIME 类型、宽高像素、宽高比、Alpha 透明通道及原始字节数；
- **终端协议自适应**：在 Kitty 终端下自动转码 PNG 触发图形协议传输缩略图，在非图形终端下安全降级为结构化元数据块。

#### 实机呈现：生产环境透明 Diff 卡片、意图浮雕与多 Tab 会话工作台

下图展示了在实际编码中，Agent 协同执行代码编辑（`Edit` 工具）与分段阅读（`Read` 工具）的真实半透明工作台视口（截取自当前会话正在修改本总览文档的真实屏幕）：

![生产环境透明 Diff 卡片、意图浮雕与多 Tab 会话工作台](./assets/tui-transparent-diff-and-intent-cockpit.png)

- **首行意图高亮穿透（Patch 9）**：`Edit` 卡片首行呈现专属紫色的 `✦ Add LSP and Image card showcases to Section 4.3`，紧随其后的 `Read` 卡片呈现绿色 `✦ Read Section 6.3 lines 360-390`，使 Agent 在复杂多文件穿梭时的每一步“心智模型”均清晰投射在屏幕上；
- **去背景实心块的通透边框（Patch 5）**：`Edit` 与 `Read` 工具卡片采用 `boxRound` 边框包裹，彻底剔除了刺眼的黑色纯色填充背景，让文件 Diff 行（`+` 绿色高亮）与上下文行轻盈悬浮于桌面壁纸与毛玻璃之上；
- **多 Tab 跨项目会话编排**：顶部 Tab 栏展示了开发者当前的并发任务流（`π > OMP Harness 设计思路总览`、`π 🗘 更新并启动 aistudio2api`、`~/code/rosereader`），证实 Harness 支持跨项目即时切换与沉浸式操作。

---
### 4.4 Fork 运行时扩展机制（Extension Engine）与 Rebase 免疫架构

在大型开源 CLI 项目的二次开发与长期维护中，开发者面临一个尖锐的架构矛盾：**代码侵入性与上游升级维护成本的对立**。若将每一项高阶功能（如全局会话检索、视口跳转、外部桌面集成）均以补丁形式硬编码入 `packages/coding-agent` 的核心流程，随着 upstream 快速迭代（经历数百个提交、甚至底层重构），每次 Git 合并都会引发海量的文本与语义冲突，最终拖垮维护精力。

为此，本地 Fork 演进分支确立了**“核心机制极简轻量，高阶能力全量外延为运行时扩展（Runtime Extensions）”**的设计哲学，深度复用并扩展了宿主的 Extension 运行模型：

#### 1. 扩展生命周期与两阶段状态机
OMP 的 Extension 严格解耦为两个截然不同的阶段：
- **加载阶段（Load Phase）**：宿主扫描 `~/.omp/agent/extensions/*.ts` 或工作区 `.omp/extensions/*.ts`，通过动态导入（Dynamic Import）执行扩展模块导出的默认工厂函数：
  ```typescript
  export default function myExtension(pi: ExtensionAPI): void {
      // 仅允许注册声明：工具 (registerTool)、命令 (registerCommand)、事件监听 (on)
  }
  ```
  在此阶段，任何尝试调用即时运行时行为（如 `pi.sendMessage()`）的操作都会被严格拦截并抛出 `ExtensionRuntimeNotInitializedError`，杜绝启动期产生难以控制的副作用。
- **运行时接管阶段（Runtime Phase）**：`ExtensionRunner.initialize(...)` 将加载就绪的扩展与活跃的交互模式（InteractiveMode）、上下文会话（`ToolSession`）以及转录树建立双向绑定。

#### 2. 全方位扩展能力契约（ExtensionAPI）
扩展不仅能注册简单命令，还能深度参与宿主的调度与呈现流：
- **工具注册（`pi.registerTool`）**：定义强类型入参 Schema（基于 TypeBox / ArkType / Zod），向模型暴露自定义动作，并在执行函数 `execute(toolCallId, params, signal, onUpdate, ctx)` 中通过 `ctx` 访问当前工作区、转录树与交互视口；
- **指令注册（`pi.registerCommand`）**：注册 `/` 斜杠指令，支持在交互终端中自定义运维动作（如 `/turns` 快速跳转、`/wiki` 知识库编译）；
- **自定义渲染器（`pi.registerCustomRenderer`）**：为特定工具或系统事件注入专属的 TUI 组件，自定义颜色、外框与进度条；
- **事件总线与切面拦截（Interception Pipeline）**：
  - `session_start` / `session_end`：会话生命周期感知；
  - `tool_call`：在工具即将执行前触发切面审查。扩展可返回 `{ block: true, reason: string }` 强制中断危险操作，或者在原地动态重写工具入参；
  - `tool_result`：拦截工具输出，在结果回传给模型前执行脱敏过滤或摘要压缩；
- **交互式 UI 注入（`pi.ui`）**：扩展可调用 `pi.ui.notify(msg, level)` 发送轻量通知，或通过 `pi.ui.select(prompt, options)` / `pi.ui.prompt(...)` 唤起模态弹窗向用户请求决策输入。

#### 3. Rebase 免疫部署体系（Rebase-Immune Deployment）
Fork 的核心扩展（`extensions/recall.ts`、`extensions/session-nav.ts`、`extensions/pet-bridge.ts`）完全遵循无侵入契约：
- 源码统一保存在独立的 `extensions/` 目录下，并通过符号链接（Symlink）挂载至用户全局目录 `~/.omp/agent/extensions/`；
- 无论底层的 `omp` 核心二进制如何基于上游 synthetic commit 经历何种跨大版本升级（如 v18.0 $\to$ v18.3），扩展代码本身不需要重新编译，也不在主干源码树中引入脆弱的侵入式 Diff；
- 宿主启动时，Bun 运行时直接即时编译执行 TypeScript 扩展代码，实现了真正零维护成本、即插即用的**热插拔能力生态**。

---

### 4.5 Fork 全局长程记忆双引擎：history_search 与 session_search 深度剖析

在智能体执行数小时乃至数天的复杂重构任务中，**上下文滑动压缩（Context Compaction）**是一把双刃剑：为了避免 Prompt 突破模型的最大窗口或产生巨额 Token 账单，早期消息会被移出活上下文（Live Context Window）并折叠为高维摘要。然而，这直接导致模型对早期的详细代码输出、尝试过的报错细节与具体文件路径“彻底失忆”。

基于上述 Extension 机制，Fork 在 `extensions/recall.ts` 中构建了一套互补的长程记忆双引擎，赋予模型主动按需翻阅记忆的能力，且**不产生任何常驻 Prompt Token 开销**：

#### 1. 单会话内存全分支检索：`history_search`
传统记忆方案尝试通过全量解析磁盘上的 JSONL 转录文件来回溯历史，存在巨大的 I/O 与解析开销。`history_search` 洞察到了宿主的核心状态真相：**Compaction 从未在物理层面删除数据，被折叠的节点在当前内存的会话 DAG 树上依然常驻**。
- **零 I/O 内存穿刺**：每次执行直接调用 `ctx.sessionManager.getBranch()`，瞬间提取从根节点到当前叶节点的完整原始转录链（涵盖 pre-compaction 与 pre-`/clear` 的全部条目），耗时 < 1ms；
- **分层加权 BM25 检索**：建立面向工程对话特征的层级加权机制：
  $$\text{Weight}(\text{user}) = 1.0 \quad \text{Weight}(\text{task}) = 1.0 \quad > \quad \text{Weight}(\text{assistant}) = 0.9 \quad > \quad \text{Weight}(\text{tool}) = 0.7 \quad > \quad \text{Weight}(\text{thinking}) = 0.4$$
  确保开发者最早提出的关键约束和任务目标拥有最高的召回判定优先级；
- **CJK Bigram 中文分词器**：内置针对中文字符的双字滑动切分分词算法，攻克由于无空格导致中文长句无法被标准分词器命中的顽疾；同时原生支持 `/pattern/` 正则表达式精准定位；
- **多媒体资产重挂载（`include_images: true`）**：模型在会话初期见过的截屏（如报错截图、UI 设计稿），随着上下文压缩会被降级。`history_search` 配合 `expand: [entryId]` 能够直接根据持久化哈希重新唤醒底层的 Image Blob 并挂载回当前 Turn，实现多模态视界的时空连通。

#### 2. 全机跨会话离线挖掘：`session_search`
当开发者的问题涉及到“我上周在另一个项目里怎么修复那个编译报错的”时，单一会话的内存树便无能为力。`session_search` 负责在磁盘海量历史转录库中进行跨工程挖掘：
- **语料真相与规模界定**：实测单机沉淀了 800+ 个历史会话（约 765 MB 的有效 JSONL 转录库；排除了单个可达 14 GB 的 `*.bash.log` 侧车日志干扰）；
- **裸字节极速预过滤（Bare-Byte Prefilter）**：利用底层的 `Buffer#indexOf`，在不进行整文件解码的前提下，直接在原始二进制字节流中扫描多字符 Token 与 CJK 串，只有发生物理命中的行才触发昂贵的 UTF-8 解码与 `JSON.parse`（实测 220 MB / 173 个会话预过滤耗时仅 ~1.1s）；
- **活链路拓扑重构（Active Lineage Reconstruction）**：由于 JSONL 是只追加写入日志，包含了大量用户执行 `/rewind` 回滚或者分支探索遗留下的“死分支行”。算法从文件的最后一条 entry 出发，沿着 `parentId` 逆向攀爬溯源，严格剔除从未真正在活跃分支上生效的幽灵记录；
- **Term Slots 与 Int32Array 极致性能优化**：针对 27,000+ 文档的大规模打分，彻底放弃传统的 JS Map 与对象堆分配，改用连续内存的 `Int32Array` 与固定 Term Slots 统计词频，将排序时间从 2.7 秒极限压缩至 0.1 秒，彻底消除垃圾回收（GC）卡顿；
- **透明预算防御**：设置 5 秒硬超时、6,000 行候选上限，并在结果尾部诚实上报扫描会话总数、有效候选数、过滤死分支数以及跳过文件清单。

---

### 4.6 Fork 惰性 MCP 网关（Lazy MCP Gateway）与 Notion 深度实战

Model Context Protocol（MCP）是当前智能体连接外部生态（知识库、Issue 跟踪系统、云端工具）的工业标准。然而，当宿主接入大量复杂 MCP 服务时，原生全量连接机制暴露了致命的工程瓶颈：
1. **冷启动性能雪崩**：每次启动 CLI，宿主必须逐一与所有声明的 MCP Server 执行 stdio/SSE 握手并同步拉取工具列表，配置 3 个以上服务即可导致冷启动卡顿 3~5 秒；
2. **上下文空间严重挤占**：一个功能完备的 MCP 服务（如 Notion）往往包含十几个工具，其冗长的 JSON Schema 在首轮 Prompt 中瞬间吞噬数千 Token，即便本次编码任务只是修改一行变量名，这部分上下文也会永久消耗宝贵的首轮预算。

#### 1. 惰性网关设计与状态机模型
Fork 在 `mcp/config.ts` 与 `mcp/manager.ts` 中构建了 **Lazy MCP Gateway（惰性 MCP 网关）**：
```text
[声明 lazy: true] ──> [启动期剥离] ──> [内存注册 #lazyHeld] ──> [暴露轻量占位设备 xd://mcp__<name>_gateway]
                                                                                   │
                                                                   智能体主动调用写入 {}
                                                                                   │
                                                                                   ▼
[动态移除占位网关] <── [触发 onToolsChanged] <── [实体工具批量挂载] <── [执行真实 stdio/SSE 握手]
```
- **启动期配置剥离**：在配置中声明 `lazy: true` 后，`MCPConfigLoader` 在启动时将该服务从常规自启动列表中移出，交由 `MCPManager.#lazyHeld` 与 `#lazySources` 独立托管；
- **轻量占位网关暴露**：启动时不建立网络连接、不拉取 Schema，仅在模型可用设备表中挂载一个名为 `LazyMCPServerGateway` 的占位工具（对应 URI 为 `xd://mcp__<server>_gateway`）。该网关在 System Prompt 中仅占用极其廉价的一行提示语：
  > *"Lazily-connected MCP server gateway for 'notion': none of its tools are loaded yet. Write {} here to connect the server now and mount its real tools under xd:// devices."*

#### 2. Notion MCP 深度实战与无感升级
以个人知识库所深度绑定的 Notion MCP 为例：
- **常态开发状态**：日常进行本地代码编写时，Notion 保持完全休眠，会话享有纯净的毫秒级冷启动与无污染的 Prompt 空间；
- **按需激活流转**：当任务明确要求“将本篇架构设计总结发布至我的 Notion 技术博客”时，Agent 识别到该占位设备，主动向 `xd://mcp__notion_gateway` 写入 `{}`；
- **实时连接与无感置换**：
  1. 网关拦截到写入，底层异步触发真实 Node/Python MCP 进程的拉起与 stdio 握手；
  2. 握手成功后，管理器将 `#lazyHeld` 标记清除，从设备表中摘除占位网关；
  3. 真实的 Notion 工具集（`notion_append_block`、`notion_query_database` 等）被原子化注入当前会话，并触发 `onToolsChanged` 事件刷新模型可见的工具表；
  4. 整个激活与替换过程对当前 Turn 透明完成，无需重开会话，实现了极速开发与丰富生态的完美融合。

---

### 4.7 Wiki 知识库与 Mnemopi 本地向量双层记忆系统深度剖析

记忆系统的核心架构矛盾在于：**当前会话上下文具有高度的时效性与易失性，而跨越数月的技术踩坑、架构约定与排障经验必须永久沉淀且随时可信召回**。

为此，宿主设计了“外部独立 Markdown Wiki 知识库 + 本地嵌入向量引擎（Mnemopi）”的双层解耦架构：

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 交互层 (Agent Harness Tool Interface)                                  │
│                                                                        │
│  xd://retain        xd://recall        xd://reflect    xd://memory_edit│
└────────┬─────────────────┬──────────────────┬─────────────────┬────────┘
         │                 │                  │                 │
         ▼                 ▼                  ▼                 ▼
┌─────────────────────────────────────────┐  ┌───────────────────────────┐
│ 外部 Markdown Wiki Vault                │  │ 本地嵌入向量库 (Mnemopi)    │
│ (~/文档/omp-wiki)                        │  │ (~/.omp/mnemopi.db)       │
│                                         │  │                           │
│ ┌─────────────────────────────────────┐ │  │ ┌───────────────────────┐ │
│ │ raw/inbox/<scope>/<uuid>.md (追加证据) │ │  │ │ sqlite-vec 向量存储库 │ │
│ └──────────────────┬──────────────────┘ │  │ └───────────┬───────────┘ │
│                    │                    │  │             │             │
│             /wiki compile (离线编译管线)  │  │             │             │
│                    ▼                    │  │             │             │
│ ┌─────────────────────────────────────┐ │  │ ┌───────────▼───────────┐ │
│ │ wiki/<topic>.md (结构化百科知识图谱)   │◀┼──┼─┤ FTS5 全文索引镜像     │ │
│ └─────────────────────────────────────┘ │  │ │  (CJK Bigram 中文分词) │ │
└─────────────────────────────────────────┘  │ └───────────────────────┘ │
                                             └───────────────────────────┘
```

#### 1. 外部独立 Markdown Wiki 知识库（The Wiki Vault）
宿主将记忆的最终真相来源（Source of Truth）确立为文件系统中完全开放、可读、受 Git 版本控制的独立目录（`~/文档/omp-wiki`）：
- **收件箱追加模型（Inbox Pattern）**：
  当调用 `retain` 沉淀经验时，系统**绝不直接覆写任何既有文件**，而是在 `raw/inbox/<scope>/` 目录下生成一个带时间戳与唯一 UUID 的独立 Markdown 文件（记录事实描述、发生场景、原始证据与作用域）；
- **离线编译管线（`/wiki compile`）**：
  当开发者执行 `/wiki compile` 指令时，宿主启动专门的知识编译器模型：
  1. 扫描未处理的 `raw/inbox/` 文件集合；
  2. 运用知识图谱聚类算法，将零碎、重复的事实归纳提炼至对应的领域百科（`wiki/<topic>.md`）；
  3. 在编译生成的条目下方强制保留原始证据链接（Evidence Links），确保每一句结论都有据可查；
- **四维记忆设备闭环**：
  - `retain`：将关键事实以不可变追加模式写入 Inbox；
  - `recall`：结合编译好的 `wiki/` 百科与待编译的 `inbox/` 原文，执行双轨语义检索；
  - `reflect`：调阅多条领域知识，跨越会话时空推演出综合解决方案；
  - `memory_edit`：以增量追加修正项的方式记录事实勘误，绝不破坏历史审计链。

#### 2. Mnemopi 本地混合向量检索引擎（Local Vector Store）
为了支撑超低延迟的语义模糊检索，本地维护了一个高性能嵌入向量库 Mnemopi（基于 SQLite 与向量插件）：
- **双轨索引架构**：底层建立“`sqlite-vec` 稠密向量索引 + `FTS5` 稀疏全文检索”双轨制。稀疏检索补充专有代码符号的硬匹配，稠密向量解决同义语义泛化；
- **CJK Bigram 双字分词器**：针对原生 SQLite FTS 在处理无空格中文自然语言时的分词缺陷，内建滑动双字分词切片，确保中文技术术语精准命中；
- **多 Key 轮询嵌入管道**：嵌入模型选用 `google/gemini-embedding-2`，通过 `authStorage.keys.setConfigPool` 建立透明凭据池，避免因并发请求触碰 Google API 免费限速（429）；
- **启动差分同步门禁（Patch 24: Gated on Drift）**：原生在每次打开数据库时都会盲目全量重扫文件并重建 FTS 镜像，引入了近 500ms 的冷启动延迟。Fork 增加了版本哈希与漂移门禁，仅当检测到元数据实质变更时才触发差分同步；
- **向量重排冷却熔断（Patch 26: Reconcile Cooldown）**：在网络偶发断连或 API 429 报错时，原生会导致未完成对齐的向量被误删，随后引发永无止境的重复构建死循环。Fork 引入数据丢失保护门禁与重入冷却时间戳，强行拦截异常状态下的清库行为，守护本地向量资产安全。

---

### 4.8 伴生桌面微宠守护进程（Desktop Pet Bridge）与只读工作区检查器（Workspace Inspector）

为了进一步拓宽智能体与物理宿主环境的交互维度，Fork 实现了两项特色能力外延：
1. **伴生桌面微宠（Desktop Pet Bridge，Patch 12）**：
   - 基于 `extensions/pet-bridge.ts` 扩展，通过 Unix Domain Socket 异步连接至系统底层独立的 GTK4 Layer-Shell 守护进程（`omp_pet.py`）；
   - 实时监听宿主事件总线：当模型处于思考推理、工具执行阻塞、遇到网络重试或最终结算时，微宠在屏幕角落实时做出细腻的动作姿态镜像；
   - 巧妙绕过了在开发者全屏工作时极易被系统静音机制（如 KDE 勿扰模式）吞没的传统桌面通知，提供了低侵入感且充满灵动的物理级可观测性。
2. **只读工作区检查器（Workspace Inspector，Patch 14）**：
   - 实现于 `workspace-inspector/` 与 `git-snapshot.ts`；
   - 专为代码审查与自动化自省提供强隔离的只读环境视口。通过建立瞬态 Git 快照，Agent 能够对当前目录下的文件树指纹、未跟踪文件和 Staged 变更进行全局透视，杜绝在检查阶段因误执行清理脚本造成不可逆的文件破坏。

---

### 4.9 Browser Relay 架构深度剖析：真实浏览器接管、CDP 伪装多路复用与安全防线

在 Coding Agent 涉及 Web 调试、抓取鉴权页面（如 GitHub 私有仓库、内部自建系统、Nowcoder 面经）或前台 UI 自测时，业界传统方案通常是借助 Playwright 或 Puppeteer **拉起一个全新的无头浏览器实例（Headless Chromium）**。

然而，在真实生产环境中，无头浏览器暴露出三大约束：
1. **身份认证墙（The Auth Wall）**：全新的无头实例是“白板”，缺乏用户的登录态（Cookie / Session / SSO / 2FA / WebAuthn）。强迫智能体在白板中执行模拟登录不仅脆弱，还会经常触发云盾验证码（Turnstile / Cloudflare 5s 盾）；
2. **高额系统负载**：每次启动一个完整的 Chromium 进程，至少侵占 300~500 MB 物理内存与大量 CPU 调度；
3. **反爬与指纹检测暴露**：Headless 特征（`navigator.webdriver = true`、WebGL 指纹缺失等）极易被目标站点 WAF 判定为僵尸流量并封禁出口 IP。

OMP 原生及 Fork 引入了一套极其精巧的 **Browser Relay（浏览器中继）体系**：**不启动新浏览器，而是直接接管开发者本机正在运行、已登录、带所有 Cookie 与真实指纹的日常 Chrome 浏览器**。

#### 1. 反向代理拓扑与逆向握手架构

浏览器扩展遵循 Manifest V3（MV3）规范，其 Service Worker **只能向外主动发起连接，绝对无法作为服务器监听本地 TCP 端口**。如果直接让 Agent 去连 Chrome，就必须在启动 Chrome 时传入带有极高安全风险的 `--remote-debugging-port`（这会导致全机任意本地进程均可无阻窃取所有 Cookie）。

OMP 巧妙设计了**反向握手拓扑**：

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 开发者真实 Chrome 浏览器 (已登录、带真实指纹)                                 │
│                                                                        │
│  [当前活跃网页 Tab]     [后台 omp 标签组 Tab]                            │
│         ▲                      ▲                                       │
│         │                      │  chrome.debugger API (单个 Attachment)│
│         │       ┌──────────────┴──────────────────────────┐            │
│         └───────┤  OMP Browser Relay Chrome Extension     │            │
│                 │  (MV3 后台 Service Worker)               │            │
│                 └──────────────────┬──────────────────────┘            │
└────────────────────────────────────┼───────────────────────────────────┘
                                     │ WS /ext (主动向外拨号握手, 端口 9224)
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 本地宿主守护进程 (Daemon Broker: omp.browser.relay @ 127.0.0.1:9224)     │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ RelayBridge (CDP Façade & 多路复用仿真引擎)                        │  │
│  │  - 虚拟 Target 树 (/json, /json/version)                          │  │
│  │  - 单 Attachment 拆解为多个虚拟 Pseudo-Session (ST / SP)          │  │
│  │  - 运行时执行上下文追踪与即时重放 (Context Replay)                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│          ▲                                                    ▲        │
│          │ WS /cdp                                            │ WS /cdp│
└──────────┼────────────────────────────────────────────────────┼────────┘
           │                                                    │
┌──────────┴─────────────────────────┐  ┌───────────────────────┴────────┐
│ OMP 宿主 Supervisor 连接            │  │ 并发 Tab Worker 专用连接       │
│ (管理标签生命周期与事件广播)            │  │ (执行具体的 DOM / JS 评估任务)  │
└────────────────────────────────────┘  └────────────────────────────────┘
```

1. **中继守护进程（`daemon.ts` / `server.ts`）**：
   宿主在 `127.0.0.1:9224` 启动一个轻量级 HTTP/WebSocket 中继服务器（通过单例 Broker 守护，多工程共享，单工程退出不销毁端口）；
2. **扩展主动握手**：
   开发者只需通过 `omp browser-relay install` 安装一次轻量 MV3 扩展。扩展启动后自动连接本机的 `WS /ext`，工具栏图标点亮为绿色的 `"on"`；
3. **标准 CDP 伪装暴露**：
   中继服务器对外完美伪装成一个原生的 Chrome DevTools 调试端点：暴露 `GET /json/version`、`GET /json/list` 以及 `WS /cdp`。上层的任何标准客户端（如 Puppeteer、Playwright 甚至普通 Chrome 调试工具）都可以直接把 `http://127.0.0.1:9224` 当成一台真正的远程 Chromium 实例进行连接，完全不感知底层扩展的存在。

#### 2. 突破 Chrome 单调试器限制：CDP 伪装与虚拟多路复用（`bridge.ts`）

在实现该架构时，团队遇到了 Chrome 内核最严苛的安全限制：
> **Chrome 规定：任意一个网页 Tab，在同一时刻绝对只允许附加（Attach）一个 `chrome.debugger` 客户端。**

然而，现代 Agent 框架（如 OMP 内部）往往采用**多连接模型**：一个全局 Supervisor 连接监控 Tab 增删事件，多个并发的 Tab Worker 连接分别操纵不同的 DOM 页面，甚至多个子任务并发访问同一个页面。如果直接透传，第二个连接必定会导致前一个连接被 Chrome 强制掐断。

`packages/coding-agent/src/tools/browser/relay/bridge.ts`（多达 1,327 行的核心协议桥接器）给出了教科书级的解决方案——**CDP 伪装层与多路复用（CDP Multiplexing Façade）**：

1. **单点物理 Attachment 托管**：
   扩展与 Chrome 之间，对每个被接管的 Tab 永远只维持**唯一的一个物理 `chrome.debugger` 附加通道**；
2. **虚拟会话命名空间划分（Minted Pseudo-Sessions）**：
   向下游的每个独立 CDP 客户端分发虚拟的会话 ID：
   - **Tab 级虚拟会话（`ST<tab>.<conn>.<n>`）**：用于响应下游发起的 `Target.*` 自动附加（Auto-attach）协议发现；
   - **Page 级虚拟会话（`SP<tab>.<conn>.<n>`）**：当下游向此 Session 发送具体指令（如 `Page.navigate`、`DOM.getDocument`、`Input.dispatchMouseEvent`）时，网桥负责将该虚拟 ID 解包，映射到底层该 Tab 的物理通道，并将 Chrome 的物理回复打包分发给对应的下游客户端；
   - **子级物理会话穿透**：对于页面内部派生出的 OOPIF（跨域 iframe）或 Web Worker，网桥直接透传 Chrome 原生分发的真实 Child Session ID。

#### 3. 运行时执行上下文追踪与上下文重放（Context Replay）

在标准 Chrome DevTools 协议中，一个极为隐蔽的致命死锁是：
> 当下游客户端连接到一个**已经加载完毕的既有网页**时，由于网页没有重新加载，Chrome 绝不会再次主动推送 `Runtime.executionContextCreated` 事件。

下游的标准 Puppeteer 客户端在执行 `page.evaluate()` 时，会无限期等待该事件以获取主执行上下文（Context ID = 1），最终导致 Agent 任务在评估 JS 时发生 30 秒超时假死。

`RelayBridge` 针对此问题实现了严格的状态追踪与即时重放机制：
- 网桥内部为每个被调试的 Tab 维护全生命周期的 `runtimeContexts` 拓扑缓存；
- 一旦检测到某个下游连接向该 Tab 发起虚拟绑定或发送 `Runtime.enable`，网桥立即从缓存中提取已存在的 Context 元数据，合成标准 CDP 事件：
  ```json
  {
    "method": "Runtime.executionContextCreated",
    "params": {
      "context": { "id": 1, "origin": "https://...", "name": "", "auxData": { "isDefault": true, "type": "page" } }
    }
  }
  ```
  定向向该连接执行**即时事件重放（Context Replay）**，使下游 Puppeteer 客户端在握手微秒内立即捕获上下文，流畅执行 DOM 查询。

#### 4. 安全红线与人机隔离防线（Safety Invariants）

由于接管的是开发者个人日常使用的真实浏览器，稍有不慎就可能破坏用户正在编辑的表单、甚至引发凭据泄露。因此，Harness 筑牢了五道绝对安全红线：

1. **回环地址与同源防穿透**：
   中继服务坚决仅监听 `127.0.0.1` 本地回环；针对 `WS /cdp` 连接，若 HTTP 报头中携带任何 `Origin` 头（表明该连接尝试从某个普通网页中利用 WebSocket 跨域攻击本地中继），直接无条件返回 `403 Forbidden` 拒绝升级；
2. **前台视觉免打扰（Preserve User Focus）**：
   当 Agent 未指明目标而自动认领前台活跃 Tab 时，**严禁主动将浏览器窗口置顶抢夺焦点**；在截取整页快照时（`activateForScreenshot`），优先使用无焦点捕获技术，杜绝开发者打字时被焦点突然切走；
3. **标签组织隔离（`"omp"` Chrome Tab Group）**：
   所有由 Agent 新建或主动纳入受控范围的标签页，会被扩展通过 Chrome 原生的 Tab Group API 自动归拢进一个名为 `"omp"`（青色 Accent 标记）的独立标签分组中，并排在标签栏右侧，与用户的私人浏览标签形成清晰的物理隔离；
4. **严禁越权导航（No Unauthorized Navigation）**：
   严格禁止智能体在没有用户显式授权的情况下，对用户当前正在浏览的前台私人标签页执行 `Page.navigate` 跳转，防止破坏用户未保存的工作现场；
5. **断开永不杀进程（Disconnect Never Kills）**：
   在任务完结、会话退出或执行 `/clear` 时，宿主只会向中继发送 Detach 指令**安全断开 CDP 调试连接并释放标签组**，绝对不会调用 `process.kill()` 终止整个 Chrome 进程。用户打开的数十个日常网页、未读消息与后台播放均安然无恙。

---

### 4.10 Hashline 行级精确定位编辑引擎：告别 Patch 漂移与幻觉覆写

在 Coding Agent 的工具生态中，**文件修改工具（Edit Tool）的设计是决定 Agent 能否稳定交付生产代码的胜负手**。业界在此领域主要存在两种传统派系，但在实战中均暴露出致命短板：
1. **Unified Diff 补丁派（如 `patch`）**：模型必须生成标准 GNU Diff 格式。由于大模型缺乏对空格与换行符的绝对精度控制，一个微小的缩进漂移、行号偏差或空白字符缺失，就会导致底层 `patch` 工具抛出 `Hunk failed` 并整体拒绝；
2. **全局搜索替换派（如 `search_and_replace` / `replace`）**：模型提供被替换的原代码片段与新代码片段。但在大型工程中，类似 `return true;`、`});`、`import * as path from "node:path";` 的通用行随处可见，极易发生多处匹配歧义（Ambiguous Matches），导致错误地覆写了非目标函数。

OMP 原生自研并经 Fork 深度加固的 **Hashline 编辑引擎**，构建了一套兼具确定性、极简语法与防幻觉机制的代码修改协议：

#### 1. 4 字节快照哈希锚定（Snapshot Tagging）
任何发起编辑的请求，必须在文件路径后携带来自最近一次 `read`、`grep` 或 `edit` 的 4 字节十六进制哈希快照标记：
```text
[src/server/auth.ts#1A2B]
PUT 42.=45:
+export function validateToken(token: string): Claims {
+    const claims = verifyJwt(token);
```
- **乐观锁并发防御**：如果该文件在模型阅读后被外部 Git 切换分支、后台格式化工具或并发任务修改过，快照哈希将发生失配（`Snapshot mismatch`）。
- **强制前置阅读**：Harness 在应用补丁前立即拦截并硬拒绝修改，强制模型重新执行 `read` 刷新上下文，彻底消除了**“基于陈旧幻觉修改代码”**的重大生产事故隐患。

#### 2. 精确行号操作与 AST 语法块感知
- **确定性行号区间（`PUT N.=M:`）**：直接指定待替换的物理闭区间行号 `N..M`，所有行号均基于原始未修改的快照，不随同一个请求中前面其他 Hunk 的增删而发生动态偏移；
- **行隙插入（`PUT <N:` / `PUT >N:` / `PUT >$:`）**：支持在行 N 前后或文件末尾追加内容，语义清晰单一；
- **语法块智能替换（`PUT N*:`）**：
  借力 Tree-sitter 语法分析，模型只需声明语法块起始行（如第 42 行），引擎自动从 AST 树上识别该函数、类或类型声明的物理结束边界并整体置换，无需模型在 Prompt 中苦苦计数大括号配对。

#### 3. 命名寄存器（Named Registers）与零 Token 代码重构
当需要在工程内部搬迁代码（如将某个庞大函数从 `auth.ts` 挪到 `utils.ts`）时：
```text
[src/auth.ts#1A2B]
CUT 100.=145 @validateJwt

[src/utils.ts#3C4D]
PUT <20 @validateJwt
```
- **零 Token 消耗与零幻觉搬运**：被剪切的代码片段暂存于当前会话的内存寄存器中。目标文件直接以引用形式粘贴，**模型无需在回复中重新吐出这 45 行代码对应的数百个 Token**。不仅重构吞吐速度提升数倍，而且彻底杜绝了代码搬迁过程中因模型重新采样漏写一行逻辑的经典风险。

---

### 4.11 持久化 PTY 会话与 Bash 工具安全沙箱深度剖析

在许多初级 Agent 框架中，执行 Shell 命令往往直接调用 `child_process.exec("bash -c ...")`。这种无状态的简单执行在工程实战中会迅速崩溃：
1. **环境与目录丢失**：每个命令都在全新的子进程中运行，模型执行 `cd packages/core` 后，下一个命令的工作目录依然停留在根目录；通过 `source .env` 加载的环境变量在下一轮即刻蒸发；
2. **交互式命令伪死锁**：缺少真实终端 PTY 支持，许多针对终端控制台优化的构建工具（Webpack、Vite、Docker CLI）会丢失颜色、输出混乱甚至因等待 TTY 输入而永久挂起。

OMP 构建了生产级的 **持久化 PTY 会话沙箱体系**：

#### 1. 会话状态继承与 PTY 仿真
- **持久化会话维持**：后台维护长期存活的伪终端（PTY）进程实例，模型在跨 Turn 执行的 `cd` 导航、环境变量变更（`export`）、Shell 函数定义在整个会话生命周期内全局保持；
- **真实终端尺寸同步（SIGWINCH）**：随着外部 TUI 视口缩放实时向后台 PTY 下发窗口重绘信号，保障长文本输出自动软折行不被硬截断。

#### 2. 哨兵提示符注入（Prompt Sentinel）与边界精确捕获
在一个连续交互的 Shell 中，最大的工程挑战在于：**如何准确判定一个输出流何时结束，并可靠提取其退出状态码（Exit Code）？**
- 宿主向后台 PTY 注入专属定制的 `PROMPT_COMMAND` 与特化 PS1 哨兵序列；
- 哨兵中携带带随机哈希与状态标记的转义特征帧；
- 无论被执行的脚本输出了多少杂乱的 ANSI 乱码或二进制流，Harness 的流状态机均能精准定位命令输出的绝对边界，并无损捕获真实退出码。

#### 3. 异步后台守护作业控制面（`async: true` / `proc://<pid>`）
针对开发服务器（Dev Server）、编译监控或后台 Docker 构建等长生命周期任务：
- 支持传入 `async: true` 将命令解耦为后台托管作业；
- 统一接入虚拟设备总线 `proc://<pid>`：
  - `read proc://<pid>`：实时非阻塞读取增量输出流；
  - `write proc://<pid>`：向后台进程注入标准输入（模拟回车确认）；
  - `write proc://<pid>/kill`：优雅发送 SIGTERM 并提供超时 SIGKILL 兜底，防止遗留孤儿进程僵尸占用端口。

---

### 4.12 Native 性能基石：Rust 动态库（pi-natives）计算下沉架构

虽然 OMP 基于高性能的 Bun / TypeScript 构建，但在超大工程场景下，纯 JavaScript 的解释执行依然存在物理天花板：
- 在包含数十万行代码的大型单体仓（Monorepo）中，全量正则遍历、代码高亮分词、Git 拓扑分析若全由 V8 / JSC 引擎在主线程跑，必然引发主交互帧率暴跌。

为此，底层计算密集型任务全量下沉至 Rust 原生动态库 **`crates/pi-natives`**（编译为 `.node` 接入）：

#### 1. 核心计算加速域
- **Ripgrep 引擎直接内联**：搜索核心由 Rust 原生接管，绕过跨进程管道调用的序列化开销，直接与操作系统的 `mmap` 与多线程文件 I/O 对接；
- **Tree-sitter 增量语法高亮引擎**：在 Rust 内存空间中维护语法树，毫秒级为终端 TUI 提供代码着色与 AST 语法块切片（直接支撑 Patch 32 的圆角行号框渲染）；
- **微秒级哈希计算与 Git 拓扑探测**：采用 SIMD 加速的快速哈希算法（xxHash / BLAKE3）秒级产出 Hashline 快照指纹。

#### 2. ABI 严格锁死与 Sentinel 版本安全门禁（`__piNativesV18_x_x`）
由于 Node-API 的 C 符号直接涉及底层内存布局，一旦 JS 层的契约发生微变而底层 `.node` 还是旧版，会导致极其灾难性的内存段错误（Segmentation Fault / Core Dump）：
- Fork 在升级合并过程中，严格遵循**原生二进制同步演进**规则；
- 底层导出一个形如 `__piNativesV18_1_10` 的版本强校验哨兵符号。在创建会话的首毫秒内，JS 层会主动探针该哨兵；若发现底层二进制版本不匹配，立即抛出明确异常拦截执行，杜绝因 ABI 漂移破坏开发者的现场代码。
---

### 4.13 Auto-Learn 机制与 Managed Skill 智能体自进化闭环

在传统的 Agent 使用范式中，智能体是**“用完即弃的无状态消耗品”**：无论智能体在一个复杂任务中踩破了多少特定的工程依赖深坑、试探出了多么微妙的启动参数组合，一旦会话结束或执行 `/clear`，下一次启动的新智能体依然会从零开始犯同样的错误；而若强迫开发者在会话后人工总结并手动撰写 `SKILL.md`，高昂的人力心智成本会导致知识沉淀极易中断。

为此，Harness 自研了一套完全闭环的 **Auto-Learn（自适应学习）与 Managed Skill（托管技能）进化体系**（核心位于 `autolearn/controller.ts` 与 `autolearn/managed-skills.ts`）：

#### 1. 学习时机裁决与状态机看门狗（Learning Trigger & Conditions）
自进化机制绝不能“无病呻吟”，更不能在简单问答中频繁产生垃圾技能骚扰开发者。`AutoLearnController` 建立了严苛的多重过滤门禁：
1. **基础开关**：必须显式开启 `autolearn.enabled === true`；
2. **复杂度阈值（`minToolCalls`）**：
   单个回合内调用的工具数必须达到阈值（默认 `cfgAutolearnMinToolCalls = 5`）。简单的问答、单文件阅读等低复杂度任务自动被看门狗过滤，唯有经过多轮重构、排障与测试的高复杂度交互才有资格进入采撷评估；
3. **中止保护（Abort Suppression）**：
   若回合以用户的 `Esc` 或 `Ctrl+C` 强行打断告终（`stopReason === "aborted"`），看门狗立刻放弃，防止将半途而废的错误排障经验固化为伪经验；
4. **任务模式排他保护（Goal / Plan Mode Exclusions）**：
   当处于 Goal Mode 连续目标推进循环或 Plan Mode 架构评审中时，严格跳过学习触发，绝不与核心任务的调度逻辑产生竞争或逻辑抢占；
5. **双运行模式与 Prompt Cache 锁死保活权衡**：
   - **被动常态模式（Passive Mode，`autoContinue: false`）**：
     仅向 System Prompt 注入静态常驻的 `autolearnGuidance` 与 `autolearnGuidanceLearn` 指令。智能体在任务推进中若发现具有通用复用价值的操作规程，直接在主流程中自发调用 `manage_skill` 或 `learn`。
     *架构权衡抉择*：系统早期版本曾尝试在任务结算后向转录队列排队压入一条隐藏的自定义触发消息（Custom Message），但该行为动态改变了历史上下文的前缀字节，直接击穿了 Anthropic Prompt Cache！因此最终改用完全静态的常驻系统指导，确保长会话下的缓存键绝对稳定；
   - **主动独立采撷模式（Active Capture Mode，`autoContinue: true`）**：
     在满足门槛的主任务回合结算后，宿主异步拉起一个专用的轻量级采撷子智能体（`runAutolearnCapture`）。该智能体携带专用的独立指令（`autolearn-nudge-autocontinue.md`），并且**在工具层进行了严格的沙箱隔离（Tool Resolver Isolation）**：仅暴露 `manage_skill` 与 `learn`，绝不继承主会话的文件读写或 Shell 执行工具，杜绝采撷阶段产生意外的外部副作用。

#### 2. 技能召回时机、优先级仲裁与渐进式披露（Recall Timing & Hierarchy）
沉淀下的技能如何被后续智能体精准、安全地复用？系统建立了清晰的物理隔离与加载管道：
- **物理目录隔离（Physical Isolation）**：
  - 用户手动编写的手写技能存放于 `~/.omp/agent/skills/` 或工作区 `.omp/skills/`；
  - 系统自生成的托管技能严格隔离在 `~/.omp/agent/managed-skills/<name>/SKILL.md`；
  - **权限硬红线**：智能体通过 `manage_skill` 只能对 `managed-skills/` 进行增删改，**严禁任何指令越权触碰用户的手写技能**；
- **最低优先级仲裁（Lowest Priority Provider，`MANAGED_SKILLS_PRIORITY = 5`）**：
  在技能发现与去重管线中，用户手写技能拥有绝对裁决权（优先级高于 10）。若托管技能与用户技能重名，系统永远优先加载手写技能；并且在 `manage_skill` 执行创建时，会提前通过 `isNameClaimedByAuthoredSkill` 检查用户技能池，若同名则直接在前端抛错拒绝，杜绝生成被静默覆盖的无效死技能；
- **渐进式披露召回（Progressive Disclosure）**：
  当新会话启动或切换工作区时，系统**绝不将所有技能的正文全量塞进 Prompt**。System Prompt 中仅以微小的 Token 成本注入一览表（包含技能名称与一句话适用场景描述）；唯有当模型在面临特定任务、判定命中了某项技能时，才按需触发 `read skill://<name>` 动态读取该技能的详细执行步骤，实现长效记忆与轻量上下文的最佳平衡。

#### 3. Prompt 体系与结构化自动合成
系统通过三层提示词模板约束知识质量：
1. **`autolearn-guidance.md`**：界定 `manage_skill` 的适用边界——专门捕获可复用的结构化规程（环境搭建时序、复杂缺陷排障流程、跨组件工作流）；
2. **`autolearn-guidance-learn.md`**：界定 `learn` 的适用边界——捕获长效事实、全局约定与用户私人偏好，直接联动 Wiki 或本地向量库；
3. **标准 Frontmatter 自动合成**：模型在沉淀技能时无需手动排版复杂的 YAML 前置元数据，系统自动对其自然语言入参进行校验清洗，合成出包含 `name`、`description` 标准声明的规范 Markdown 实体。

---
## 5. 网络协议、中转对抗与提示词缓存保活

### 5.1 原生多 Provider 抽象与 KDL 声明式规则引擎

Upstream 的 `packages/ai` 提供了对主流大模型供应商的高性能封装，支持 Anthropic Messages、OpenAI Completions、OpenAI Responses 以及 Google Gemini 等多种底层协议。

其最卓越的架构亮点在于**坚决杜绝在 TypeScript 代码中硬编码模型特化逻辑**（如 `if (model.includes("claude-3-5"))`）：
- 所有的模型能力边界、价格模型、上下文限制、思考预算（Thinking Budget）支持、API 路由偏好均抽离在 `packages/catalog/src/compat/rules/` 下的 **KDL 规则树** 中。
- 编译脚本 `bun run gen:compat` 将声明式规则编译为高度优化的静态 `rules.json`。
- 运行时统一由 `classifyModel()` 提供结构化事实判断，确保代码库拥有长周期的可维护性。

---

### 5.2 Fork 第三方 Relay 思考预算与错误容错阶梯（400 / [1210] / 始终思考）

国内使用第三方模型中转分发商时，常会遇到严重的非标行为：
- 中转服务商对带有 `thinking: { type: "enabled" }` 的请求报错 `400: 不支持 thinking / 请使用 reasoning_effort`。
- 特定网关路由错误时抛出 `[1210]` 或中文提示“模型负载已满/内部错误”，但 HTTP 状态码伪装为 400（不可重试）。

**Fork 逐级容错架构**：
1. **中文正则容错降级（`openai-reasoning-fallback.ts`）**：针对中文提示语（“不支持/请使用”等关键词）建立自适应协商链，在保持模型原有思考倾向的同时，安全地将不规范字段置空或转换为供应商兼容形式。
2. **`fetch-retry.ts` 专用通道**：引入 `retryNonRetryableResponse` 专有选项，打破“400 绝不重试”的传统教条，使特定中转站的伪 400 报错能够安全复用退避重试循环，且不破坏正常流式 Body 的读取。
3. **自动剥离历史思考痕迹**：当捕获到目标 Relay 属于“始终思考型”（Always-thinking）且拒绝历史 Message 中携带的 `<think>` 标签时，自动触发清洗钩子（`stripThinkTagsFromCompletionsParams`），确保上下文顺利过关。

---

### 5.3 Fork Claude Code 伪装锚定与 Prompt Cache 缓存穿透根治

在使用 Anthropic Claude 模型时，Anthropic 官方及部分高级反代支持 **Prompt Caching（提示词缓存）**，可降低高达 90% 的长上下文费用并大幅提升首字出流速度。

然而，在伪装模式（Claude Code Cloak）与中转环境下，存在两大隐蔽的缓存击穿陷阱：

```
上游原生/未优化状态:
Turn 1: [System (56KB)] [Tools (40KB)] [User Msg (String)]  ==> Cache Write (96KB)
Turn 2: [System (56KB)] [Tools (40KB)] [User Msg (Array)]   ==> 结构变更导致缓存键失效!
        ^-------------------- Byte Mismatch --------------^   Cache Miss! 再次全量写入 (96KB+)

Fork 修复后状态:
Turn 1: [System (56KB)] [Tools (40KB)] [User Msg (Block)]   ==> Cache Write (96KB)
Turn 2: [System (56KB)] [Tools (40KB)] [User Msg (Block)]   ==> 前缀字节完全一致!
        ^---------------- Byte Identical -----------------^   Cache Hit! (4/6 次命中)
```

1. **`cch` 认证哈希作用域化**：
   原生伪装实现中，每次计算 Attestation 哈希可能受到微观时间戳或未对齐上下文影响，导致请求报头中的 `cch` 每一轮都在漂移。Fork 通过将其限定在稳定前缀哈希范围内，实现了跨 Turn 的哈希值恒定。
2. **用户 Turn 强制块格式序列化（Content Blocks Serialization）**：
   在 `convertAnthropicMessages` 中，原生实现常将简单的用户文本序列化为裸字符串；但在需要挂载缓存锚点（`cache_control`）时，该条目会被临时升级为 `[{type: "text"}]` 块数组。这一来回切换直接在长上下文的中段引入了字节级变动，导致后续所有的缓存前缀完全失效。Fork 强制所有用户消息均采用块格式序列化，彻底守住缓存前缀稳定性。
3. **实测收益**：
   实测在 5 轮工具调用的标准编码任务中，缓存命中率从 **0/6** 逆转至 **4/6**，Cache-write Token 消耗降低 **61%**，单次会话响应耗时由 80.8 秒腰斩至 43.4 秒。

---

### 5.4 Fork 动态热重载重试规则引擎（retry-rules.json）

为了应对复杂多变的网络中转环境，Fork 将硬编码在代码中的重试判定外置为可热重载的规范文件 `~/.omp/agent/retry-rules.json`：
- 支持为特定的供应商、模型或错误响应体定义双向正则表达式（RegEx）。
- 支持配置自定义重试预算（Retry Budget）与特定退避延时。
- 运行时文件监听生效：当线上出现突发的新型非标 HTTP 响应码时，开发者无需修改 TypeScript 源码或重新编译打包 CLI，只需在 JSON 中追加一条规则即可实现全进程秒级生效。

---

### 5.5 Fork 搜索通道同源复用与 Grok Relay 适配

在进行网络搜索（`web_search`）时，原生实现往往需要额外配置独立搜索引擎或硬编码的远端地址。
Fork 实现了两项关键跃升：
1. **活跃模型同源搜索通道复用（Search Affinity）**：
   - 当当前对话的主模型为 GPT 系列时，自动提升 Codex 搜索通道，并复用当前活跃连接的凭据。
   - 当主模型为自定义 Messages 接口的 Claude 时，通过 `anthropic-affinity.ts` 自动复用其底层传输端点、伪装标头与连接池，无需为网络搜索额外购买昂贵的独立专用通道。
2. **Grok 搜索流接入**：
   针对 xAI Grok 的搜索特性，扩展了专用的中转适配器，使得拥有 Grok API 的开发者能够无缝将其作为高质量网页实时信息的注入通道。

### 5.6 Fork 协议报头穿透（Extra Betas / Codex Pins）与多 API Key 轮询凭据池

在跨供应商与非标中转反代网络中，网络报文的细微字节与请求头结构往往是决定请求能否被正常接纳的“死穴”。

Fork 在协议传输底层进行了四项精密手术：
1. **声明式 Betas 报头穿透（`compat.extraBetas`，Patch 19）**：
   - **痛点**：部分第三方 Relay（如 anyrouter）在支持 1M 上下文时，强制要求客户端携带 `context-1m-2025-08-07` 请求头，否则直接以 400 拦截报错（“请启用 1m 上下文后重试”）。而原生为了防止官方 OAuth 凭据撞击未授权 1M 额度导致的 429 报错，硬编码拒绝向外透传该 Beta；
   - **机制**：在 `AnthropicCompat` 配置模型中挂载 `extraBetas` 声明列表，通过 `buildBetaHeader` 与内置伪装链深度合并去重，使自定义中转的特殊门禁头得以安全抵达底层 Wire，成功瓦解反代准入报错。
2. **Codex / Responses 身份特征头保活透传（Patch 27）**：
   - 修复了 `createCodexHeaders` 中无条件覆写 Originator / User-Agent 导致的身份指纹丢失，改为仅在缺省时才补充默认标识（Set-if-absent），允许中转专用鉴权请求头完整保留。
3. **Prompt 包含型 Token 修正（Patch 22）**：
   - 在 Anthropic 协议线路上，部分国内中转镜像返回的 `input_tokens` 计数已经叠加了缓存读取（Cache Read）的 Token 数量，导致上层 Harness 误判当前上下文已逼近极限而过早触发激进压缩；
   - Fork 引入 `promptIncludesCacheRead` 协议特征判定，自适应剔除虚高计数，捍卫了上下文滑动预算与费用账单的真实性。
4. **运行时多 API Key 轮询凭据池（Multi-API-Key Pool）**：
   - 在模型认证存储层（`authStorage.keys.setConfigPool`）实现动态凭据池；
   - 支持为单个 Provider 配置多组备用 API Key，在运行时侦测到 429 限速或配额耗尽时，透明轮转切换并设置冷却时间，无需手动重启即可支撑子智能体团队长时间高吞吐并发作业。

---

### 5.7 多 Provider 缓存计量差异与协议方言兼容深度剖析

在大模型工程化落地中，**Prompt Caching（提示词缓存）**是支撑长文本交互、复杂多轮工具调用（ReAct）并大幅削减成本（高达 90%）的基石。然而，不同供应商底层的缓存协议方言存在巨大的技术鸿沟；加之国内各类中转反代二次加工引入的计费指标畸变，极易导致客户端监控误判与缓存击穿。

#### 1. 三大模型家族 Prompt Caching 的底层 Wire 差异与成本数学

| 缓存维度 / 模型家族 | Anthropic Claude 显式缓存断点 | OpenAI / DeepSeek 隐式前缀对齐 | Google Gemini 上下文缓存 |
| :--- | :--- | :--- | :--- |
| **标记机制** | **客户端显式标注**：在 `system`、`tools` 数组尾部或特定消息块声明 `cache_control: { type: "ephemeral" }` | **服务端隐式命中**：客户端无需发送任何标记，服务端自动计算前缀哈希 | 混合模式：支持隐式前缀缓存或显式创建 `CachedContent` 独立资源 |
| **物理约束** | 全局最多 **4 个显式断点**；存在最小 Token 阈值（1024 或 2048）；默认滑动 **5 分钟 TTL** | 以 **1024 Tokens** 为物理对齐块（Block Boundary）；未对齐部分无法享受缓存 | 显式缓存需指定生命周期（TTL），支持按小时租用存储槽位 |
| **计费成本模型** | **写入（Creation）**：基础费率的 **125%**<br>**读取（Read）**：基础费率的 **10%**（节省 90%） | **写入**：无额外写入惩罚（按标准输入计费）<br>**读取**：约节省 50% ~ 75% 费用 | **存储**：按小时收取驻留费<br>**读取**：极低折扣命中费率 |
| **协议响应报文** | `usage.input_tokens`<br>`usage.cache_creation_input_tokens`<br>`usage.cache_read_input_tokens` | `usage.prompt_tokens`<br>`usage.prompt_tokens_details.cached_tokens` | `usageMetadata.cachedContentTokenCount` |
| **字节对齐敏感度** | **极高**：前缀中哪怕一个标点符号、空格或消息块类型改变，后续断点全数击穿 | **极高**：只要前缀中出现动态时间戳或字典键乱序，整个对齐块全部失效 | 依赖显式资源句柄或严格字节一致前缀 |

#### 2. 中转反代“双重计费”虚高陷阱与纠偏算法（`promptIncludesCacheRead`，Patch 22）

在接入第三方中转服务商时，团队排查捕获了一个极度隐蔽的系统级缺陷：
- **官方标准规范**：在 Anthropic 官方 Messages API 中，`usage.input_tokens` 严格定义为**“本次请求新产生、未命中缓存的增量输入 Token 数”**。
  例如：总提示词 80K，命中缓存 75K，官方返回：
  `input_tokens: 5000, cache_read_input_tokens: 75000`；
- **中转反代严重异化**：国内大量基于 New API / One API 二次修改的分发网关，其内部计费中间件在重组响应时，粗暴地将 `cache_read_input_tokens` 重新叠加进了 `input_tokens`：
  `returned_input_tokens = actual_new_tokens (5K) + cache_read_tokens (75K) = 80000`；
- **对 Harness 的毁灭性打击**：
  Harness 的上下文滑动窗口看门狗（Context Compaction Watchdog）依赖 `input_tokens` 监控当前窗口水位。当阈值设为 95%（例如 100K 窗口）、当前实际仅消耗 5K 增量时，虚高的 80K 报文导致看门狗误判“上下文即将爆仓”，**在第一轮工具调用后便过早且强制触发了 `/compaction` 紧急折叠**！这一折叠强行重写了历史消息，把原本稳定命中的 75K 缓存前缀全部抹杀，不仅没有省钱，反而在每一轮都付出高昂的 125% 重新建仓代价；
- **Fork 差分纠偏机制**：
  通过在模型注册表声明 `compat.promptIncludesCacheRead: true`，Harness 在流式收尾提取 Usage 时执行动态校准：
  $$\text{actualInputTokens} = \max(0, \text{reportedInputTokens} - \text{reportedCacheReadTokens})$$
  彻底平复上下文水位监控，守住了 Prompt Cache 的连贯生命周期。

#### 3. KDL 声明式规则引擎与无分配指针置换（Zero-Allocation Pointer Swap）

为了应对数百家大模型供应商与数千个模型变体所派生出的协议差异（思考格式 `thinkingFormat`、语法严格模式 `strict` 兼容性、推理级别映射 `reasoningEffortMap`），Upstream 与 Fork 坚决杜绝在 TypeScript 业务逻辑中编写 `if (model.id.includes("..."))` 式的条件分支。

所有行为策略完全归拢至 `packages/catalog/src/compat/rules/` 下的 **KDL（Keyboard Document Language）规则树** 中：
- **四层严格职责分层**：
  1. `taxonomy/*.kdl`：定义模型谱系与派生关系（如 Claude、GPT、DeepSeek、Qwen、Kimi）；
  2. `classes/*.kdl`：定义模型固有属性（如最大上下文窗口、原生多模态支持、思考参数支持）；
  3. `providers/*.kdl`：定义特定托管商的魔改行为与约束（如某平台必须关闭 strict 语法校验、某平台思考格式强制采用 `zai` 或 `qwen` 方言）；
  4. `runtime/behavior.kdl`：定义全局运行时启发式、路由兜底与降级梯队；
- **离线编译机制**：构建时运行 `bun run gen:compat`，将散落的 KDL 规则经过优先级仲裁（Priority Arbitration）编译为紧凑、不可变且严格校验的 `rules.json`；
- **运行时无分配指针置换（Zero-Allocation Pointer Swap）**：
  在单次对话或高频流式通信中，每次动态深拷贝或合并对象都会引发 V8 / JavaScriptCore 引擎的内存碎片与 GC 停顿。Harness 在启动时便针对每个模型预先构建好了普通模式与思考模式（`whenThinking`）的静态兼容策略对象；在单次请求发生时，仅需**通过单行指针引用置换即可完成协议切换**：
  ```typescript
  const compat = enabled && baseCompat.whenThinking ? baseCompat.whenThinking : baseCompat;
  ```
  实现真正的零对象分配、零 GC 损耗与极速运行吞吐。

---

## 6. 终端呈现工程（TUI）与人机交互交互面

### 6.1 原生 Pi-Tui 差分渲染引擎与生命周期管理

Upstream 自研了专为现代终端打造的 **Pi-Tui** 渲染框架（位于 `packages/tui`）：
- **虚拟双缓冲与差分输出**：在内存中维护终端网格缓冲，每一帧仅计算产生差异的单元格，最小化写入终端的标准 ANSI 控制码序列，彻底消除了传统终端全量刷新时的闪烁感。
- **三态转录生命周期**：
  - **Active**：可变状态，驻留于活跃视口，随窗口尺寸动态重排；
  - **Settled**：已结算但仍在当前屏展示，随时准备被历史队列吸收；
  - **Committed**：已写入终端回滚缓冲（Scrollback Buffer），释放内存占有。
- 这一架构确保了即便在大规模代码输出与流式 Markdown 高频推送下，终端仍能保持 60fps 级别的顺滑输入响应。

---

### 6.2 终端多协议图形渲染与 Kitty Unicode 占位符引擎深度剖析

在 CLI Agent 领域，传统的文本界面只能输出冷冰冰的 ASCII/ANSI 字符。当 Agent 生成架构设计图、UI 渲染稿或读取本地图片时，主流工具往往只能粗暴地调用外部系统查看器弹窗（如 `open preview.png`），瞬间打断开发者的全屏沉浸感。

OMP 原生及 Fork 在终端内部构建了一套完整的**内嵌多协议图形排版管线**，实现了直接在终端滚动流中无缝渲染真彩图像。

#### 1. 终端图形协议矩阵与自动探测降级
宿主启动时通过异步发送终端能力查询报文（`DA1 / DA2`、`XTVERSION`、`OSC 4` 调色板查询），建立四个层级的协议自适应协商阶梯：
1. **Kitty Graphics Protocol（优先）**：最先进的现代终端图形标准（Kitty、Ghostty、WezTerm 原生支持），具备 GPU 纹理加速、分块传输与虚拟排版；
2. **iTerm2 Inline Images**：macOS 经典终端标准，基于 `OSC 1337;File=inline=1:...^G` 协议传输单帧或动图；
3. **Sixel 协议**：DEC VT 系列古老但兼容性极广的点阵图形标准，由 Rust 原生库 `encodeSixel`（`crates/pi-natives`）极速压缩编码输出；
4. **半块字符回退（Half-Block ANSI Fallback）**：当终端完全不支持图形协议时，自动提取图片调色板，利用 `▀` / `▄` 字符配合 24-bit TrueColor 背景色构建紧凑低分辨率字符画预览。

#### 2. Kitty Graphics Protocol 底层线缆规范与分块传输
在接入 Kitty 协议时，数据通过专用 APC 转义序列（`\x1b_G...;\x1b\`）与终端进行双向通信：
- **格式硬约束（`f=100`）**：Kitty 仅支持 PNG 格式。所有输入的 JPEG、GIF、WebP 资产在送入传输管线前，必须经过预处理转码为标准 PNG 流；
- **分块传输与流量整形（`m=1 / m=0`）**：单条转义控制序列受限于终端 PTY 缓冲区（通常为 4096 字节）。大图像的 Base64 载荷被自动切割为 4096 字节的微块流式下发，前置块标记 `m=1`（还有后续块），收尾块标记 `m=0`；
- **zlib 压缩载荷（`o=z`）**：传输超大高清屏幕截图时，自动启用 zlib 内存压缩，大幅缩减写入 PTY 的字符流体积。

#### 3. 虚拟排版引擎：Kitty Unicode 占位符机制（`packages/tui/src/kitty-graphics.ts`）
传统终端图像直接使用 `a=p`（指定行列绝对坐标放置）。这种做法在复杂交互界面或分屏复用器（tmux、zellij、herdr）下存在灾难性缺陷：**一旦外部文本滚动或窗口局部重排，光标定位的图片会与所属消息脱节、甚至错位漂浮在其他文字上方**。

OMP 采用了颠覆性的 **Unicode 占位符排版引擎（Unicode Placeholders）**：
```text
┌────────────────────────────────────────────────────────┐
│  物理图像数据 (GPU 显存中已加载的 Image ID)                │
└───────────────────────────┬────────────────────────────┘
                            │ 虚拟映射 (U=1)
                            ▼
┌────────────────────────────────────────────────────────┐
│  文本网格中的占位单元格序列:                                 │
│  [\u{10eeee} + Diacritic(Row 0, Col 0)]  [\u{10eeee} + ...]   │
│  [\u{10eeee} + Diacritic(Row 1, Col 0)]  [\u{10eeee} + ...]   │
└────────────────────────────────────────────────────────┘
```
- **基底字符与组合标记**：选用 Plane 16 私有保留字 `KITTY_PLACEHOLDER = "\u{10eeee}"` 作为占位基底，结合 297 个专用的 `ROWCOLUMN_DIACRITICS` 组合字符（Unicode combining class 230，无分解歧义）；
- **文本网格完全平等化**：每一个占位字符单元直接在自身字节中嵌入了对应的 `(row, col)` 图像切片坐标。**图像因此获得了纯文本单元格的一切物理特性**：
  - 随着终端滚动平滑移出屏幕；
  - 支持与其他 ANSI 文本混排，甚至能被文本选择光标选中文本流；
  - 支持差分渲染（仅更新重叠区域）与终端自适应软折行（Soft Wrap）。

#### 4. 跨屏状态账本与 GPU 纹理冲刷自愈（`ImageBudget`，Patch 13）
在终端架构中，主屏（Main Screen）与全屏备用缓冲（Alt Screen，通过 `?1049h` 切换，如运行中的选择器、查看器）在物理上是隔离的：
- **GPU 纹理擦除危机**：Kitty 与 Ghostty 在终端切入 Alt Screen 时，会清空备用屏的图形显存。原生如果简单将已发送的 Image ID 视为全局已缓存，当用户退出全屏查看器回到主屏时，主转录流中的图像由于显存被擦除，将全数变成空白残影；
- **双屏独立账本（`ImageBudget`）**：
  Fork 在 `packages/tui/src/components/image.ts` 中维护了独立的表面状态账本：
  ```typescript
  #transmitted: Record<Surface, Set<number>> = { screen: new Set(), alt: new Set() };
  ```
  在每次进出 Alt Screen 时，状态机精准感知当前物理表面的显存状态；当检测到目标表面的 GPU 纹理未就绪时，自动差分重放图像传输指令，彻底解决了全屏交互后主屏图片坏死的历史顽疾。

#### 5. 异步转码竞态防御与转录块冻结门禁（Post-Merge 关键修复）
在 upstream 18.1.x 的架构演进中，转录容器（`TranscriptContainer`）引入了**追加不可变模型（Append-only Freezing）**：一旦一个转录块判定已结算（Finalized），它在终端回滚缓冲中写入的物理字符将被永久冻结。
这导致了一个严重的非预期并发缺陷：
1. 终端启动前几毫秒，由于异步能力探测尚未完成，`TERMINAL.imageProtocol` 处于 `undefined`；
2. 此时若用户恢复包含 WebP 图片的会话，非原生格式向 PNG 的异步转码需要约 400ms；
3. 原生组件在首帧未就绪时先渲染了临时的文字占位符（如 `[Image: image/webp]`），该帧立刻被追加不可变机制永久固化进转录历史；等 400ms 后真正的 PNG 转换完毕时，界面已经无法刷新该已冻结块！

**Fork 状态拦截门禁**：
- `ImageStrip` 暴露 `conversionsPending` 计数器，严格追踪处于飞行中（In-flight）的转录转换；
- 在 `UserMessageComponent` 中实现严格的 `isTranscriptBlockFinalized` 门禁：**只要异步转码尚未完全落地，该区块绝不允许被判定为 Finalized**；
- 确保只有当真正的高清 PNG 纹理在终端中完成物理绘制后，区块才获准沉淀至不可变历史，终结了图片恢复时偶发白框的竞态暗疾。

#### 实机呈现：Kitty 图形协议终端内联渲染与半透明毛玻璃工作台

在支持 Kitty 图形协议的高级终端中，执行宿主不仅能展示普通的文本行，还能直接利用终端内核指令将生成的架构图、UI 渲染稿以真实像素图元内联输出到历史回滚区中，无缝融入开发者的真实编码视口。

下图截取自真实桌面生产环境下的半透明终端会话（基于 `amethyst-glass` 主题）：

![Kitty 终端内联图形渲染与半透明毛玻璃工作台实况](./assets/tui-kitty-inline-graphics-transparency.png)

**生产环境视觉特征解析**：
- **终端内联图像直出（Inline Graphics）**：终端直接响应 `show_image` 指令，将生成的 `tui-markdown-rendering.png` 作为高精度图元无缝绘制在转录流中，上下紧凑衔接命令指令与下游的 LSP 工具卡片；
- **全透明背景与毛玻璃融合**：打破传统终端“纯黑不透光方块”的沉闷感，转录文本与图元悬浮于桌面工作环境之上，既提供高对比度的阅读体验，又保留与系统桌面壁纸的层次呼应；
- **连续 Turn 工具链无缝排版**：图像上方承接生成任务指示，下方无缝展开下一个工具调用（`Show LSP card showcase` 与 `💡 LSP references`），体现流式 Agent 会话的连贯节奏。

---

### 6.3 Fork 终端排版美学重构：气泡、代码块边框与 Markdown 语法脱敏

为了将终端 CLI 的视觉质感提升至现代桌面应用级别，Fork 对多个关键组件进行了美学重塑（实机捕获的高清真彩渲染效果见 6.5 节图示）。以下为终端渲染对比示意：

**原生渲染效果（语法泄漏 / 无外框 / 缩进对齐瑕疵）**：
````text
### 3. 实现细节
```typescript
function test() {
  return 42;
}
```
````

**Fork 渲染效果（语法脱敏 / 阶梯字重 / 圆角行号边框）**：
```text
3. 实现细节 (标题加粗且彻底无井号，H1-H4 阶梯字重)
╭─── typescript ──────────────────────╮
│ 1 function test() {                 │
│ 2   return 42;                      │
│ 3 }                                 │
╰─────────────────────────────────────╯
```

1. **Markdown 代码块圆角高亮框（`#renderCodeBlockBox`）**：
   - 彻底废除仅有两道暗淡横线的简易 Fence，采用 `theme.symbols.boxRound` 构建包裹外框（`╭─── lang ───╮` / `╰───╯`）。
   - 引入专用的右对齐行号槽（Line Number Gutter），且当代码行发生软折行时，续行自动留白槽位，保证代码缩进严格对齐。
2. **Markdown 标题语法脱敏与字重阶梯**：
   - 彻底剔除三级以下标题直接裸露打印在屏幕上的 `### ` 语法标记。
   - 建立纯视觉字重阶梯：H1 采用 OSC 66 终端双倍字高 + 粗体下划线；H2 粗体；H3 保持正文字重但采用主题主色；H4+ 采用斜体。消除语法泄漏，还给用户沉浸式的阅读体验。
3. **工具执行透明边框卡片**：
   - 针对 Pending / Running / Error 状态的工具调用卡片，移除刺眼的实心背景底色填充，改为仅渲染精致的周边线框，避免破坏终端深色透明主题的通透感。
4. **用户气泡圆角包裹与 OSC 133 标记**：
   - 为用户输入的指令渲染完整的圆角外框，并无缝包裹 OSC 133 Shell 集成转义标记，便于高级终端利用快捷键实现精确的分段定位跳转。

#### 实机排版渲染展示（Markdown 全要素真彩截图）

下图为使用真实终端主题与字库光栅化生成的 Markdown 排版全要素真彩截图（保存于 `./assets/tui-markdown-rendering.png`）：

![终端 Markdown 阶梯排版、圆角行号代码块与表格实机渲染](./assets/tui-markdown-rendering.png)

**排版细节剖析**：
- **标题语法完全脱敏**：首行 H1 标题 `架构解析与执行上下文` 与次级 H2 `核心接口契约定义` 彻底摆脱了源码中的 `#` 与 `##` 前缀，以双倍高粗体与主色对比自然拉开阅读层级；
- **圆角包裹代码块与独立行号槽**：TypeScript 接口定义被平滑收纳在 `╭─── typescript ───╮` 与 `╰───╯` 之间，行号 1–5 拥有严格的右对齐槽位与右侧隔离边距，关键字、类型名均获得 Tree-sitter 高亮；
- **引用边条（Blockquote Rail）**：引用段落左侧配以柔和的 `▏` 边缘指示条，斜体强化设计准则；
- **清晰紧凑的表格布局**：采用细线框 `boxSharp` 渲染四列组件指标，自适应单元格宽度且不溢出物理屏幕。

---

### 6.4 Fork 交互效率跃升：Bash 历史检索、补全与全局视口跳转

1. **Bash 模式下的 Ctrl+R 历史检索与 Tab 补全**：
   在 CLI 内置的 Bash 执行模式下，完整还原了现代 Shell（如 Zsh/Fish）的操作习惯，引入了基于历史命令的实时幽灵文本（Ghost Text）提示与 Ctrl+R 模糊逆向检索。
2. **全局视口跳转（`session-nav.ts` / Alt+U）**：
   在动辄几百轮的长会话中，传统的滚动条滚动手感极其沉重。Fork 开发了无侵入的扩展组件 `session-nav`，用户只需按下 `Alt+U` 即可唤起所有用户 Turn 的模糊检索面板，轻敲回车即可瞬间将真实转录视口定位至对应问答段落，极大释放了长程审阅负担。

### 6.5 无头终端评测工模与真实 PTY 像素级截屏（Headless Verification Rig）

在 CLI Agent 开发与演进中，TUI 视觉呈现的自动化回归验证一直是工程难点：普通控制台输出会自动剥离 ANSI 控制字符，无法校验真实的颜色字重与边框连贯性；人工在终端里肉眼观察则无法融入自动化 CI。

为此，Harness 演化出了一套高保真的无头终端仿真观测流水线：
1. **原生 PTY 会话沙箱**：利用 Bun 底层 PTY 接口（`Bun.spawn` + `terminal: { cols, rows, data }`）加载 `omp-patched` 真实二进制；
2. **WASM 级 Kitty 终端内核追踪**：通过 `kitty-vt-wasm`（编译自 Kitty 的 `screen.c` 与 `vt-parser.c`）接管 PTY 全量字节流，精准还原 SGR 属性、多屏切换（Alt Screen）、Unicode 宽字符折行与 Kitty Graphics 协议图元；
3. **Skia 像素级栅格化与 CJK 字库合成**：借助 `@napi-rs/canvas`，在内存中动态注册等宽编程字体（如 `Maple Nerd Font Mono`）与中文字库（`Noto Sans CJK SC`），模拟真实终端以 2x 缩放光栅化生成 1664x1024 像素的 RGBA 真实真彩截图，为博客及自动化测试提供零误差的可视化证据链。

#### 实机运行抓取效果展示（Space Bunny 模型驱动）

下图为通过上述无头 PTY 流水线实际拉起 `astrdark/space-bunny-free` 运行并光栅化捕获的真机 TUI 状态截图（保存于 `./assets/omp-tui-spacebunny-shot.png`）：

![Space Bunny 驱动下的真实 TUI 交互界面全景](./assets/omp-tui-spacebunny-shot.png)

**截图中的核心 Fork 视觉细节解读**：
- **代码块圆角边框与行号槽**：第 5–21 行 Python LRU Cache 代码块被完整包裹在 `boxRound` 边框内，左侧为独立的右对齐行号槽，注释与类型高亮层次分明；
- **语法脱敏正文**：代码下方的 1–3 点设计说明排版紧凑，正文字重分明，无任何漏网的 Markdown 源码字符；
- **单 Turn 耗时与速率度量**：倒数第 4 行记录了模型单次请求的统计（` 423   412   24K   2.6s   67.2/s`）；
- **Fork `work-usage` 计费看板**：倒数第 2–3 行由两道细分界线框出，聚合统计了本轮用户交互经历的完整开销（3 次请求，总耗时 17.3s，Cache 命中率 98.7%）；
- **冷启动预热状态栏**：底部常驻 Status Line 清晰呈现模型标识 `Space Bunny Alpha`、预热拉取的分支状态 `master *7 ?2` 与 `󰁨 1M` 上下文标识。

---

### 6.6 TUI 智能输入补全体系：斜杠指令、上下文引用与 Bash 幽灵文本（Composer & Ghost Text）

在终端 CLI 中与 AI 智能体协同开发时，开发者需要在**自然语言提问、操作系统命令、工程文件路径与控制性指令**之间高频切换。如果输入框缺乏强大的补全感知，开发者将被迫反复在终端切屏复制长路径、手动敲击繁冗的命令名，甚至因为一个字母的拼写错误导致上下文挂载失败。

Harness 在交互输入层（Composer）自研并经 Fork 增强了一套多维度、可堆叠的 **智能补全与幽灵文本预测引擎**（核心位于 `@oh-my-pi/pi-tui/prompt/` 与 `modes/bash-autocomplete.ts`）：

#### 1. 斜杠指令层级补全与频次动态加权（Slash Commands `/`）
当开发者在输入框首字符键入 `/` 时，`createPromptActionAutocompleteProvider` 立即激活：
- **全指令拓扑索引**：统一聚合内置系统核心指令（`/exit`, `/clear`, `/model`, `/compact`, `/rewind`）、自定义 Prompt 模板、用户自建指令以及通过 Extension 动态注册的全部插件命令；
- **调用频次动态加权（Frequency Ranking）**：
  底层通过 `commandUsage` 记录开发者日常敲击每条指令的历史热度。高频命令（如常用的 `/model`, `/clear`）无需打完整单词，敲出 `/` 后自动浮现在候选菜单的第一位，实现零思考回车直达；
- **次级参数智能级联补全（Sub-argument Completion）**：
  针对复合指令提供上下文感知的二级补全。例如输入 `/mcp ` 时，补全引擎自动转入服务名与子动作状态机，动态列出当前已注册的 MCP Server 清单及 `enable` / `disable` / `test` 动作；输入 `/move ` 时，无缝级联调出工作区目标目录补全浮窗。

#### 2. 上下文文件引用与符号模糊补全（`@` Context Files）
当开发者需要向 Prompt 中挂载当前项目的代码文件或目录时，输入 `@` 字符即可触发文件树智能发现：
- **非阻塞 Git 文件树缓存与 Ripgrep 预扫描**：
  针对数十万文件的大型 Monorepo，引擎坚决避免在击键时同步遍历文件系统，而是复用后台预热的活跃 Git 树索引；
- **智能过滤与图标渲染**：
  天然遵守 `.gitignore` 规范，自动过滤 `node_modules/`、`target/`、`dist/` 等二进制或中间构建产物；在弹窗列表左侧根据扩展名动态渲染对应的 Nerd Font 文件类型图标（如 TypeScript 的 、Rust 的 、Python 的 ）；
- **东亚宽字符像素级锚定（East Asian Width Alignment）**：
  在现代终端中，中文字符与部分 Nerd 图标物理占据 2 个显示单元格（Columns）。若使用常规 `string.length` 计算光标位置，输入框中的弹窗菜单会严重向右漂移撕裂。Harness 全面调用 `Bun.stringWidth()` 精确计算物理视口占用，确保候选浮窗在任何宽窄字符混排下均严格垂直对齐在 `@` 字符的正下方。

#### 3. Bash 模式专用补全与幽灵文本预测（`!` / `!!`，Patch 15/16）
当开发者以 `!` 或 `!!` 开头进入 Bash 执行模式时，`BashAutocompleteProvider` 接管补全流，将传统 Shell 的前沿补全特性移植入 TUI：
- **首词命令与路径智能分流（Token Routing）**：
  - 若首个词以 `/`、`./`、`../` 或 `~` 开头，引擎自动将其判定为路径执行，无缝委托给文件系统补全；
  - 若首个词为常规字符串，引擎立即进入可执行程序与别名扫描管线；
- **全量 `$PATH` 扫描与缓存**：
  扫描环境变量 `$PATH` 下所有目录中的可执行二进制名称，并基于 `$PATH` 字符串指纹建立进程级缓存；
- **用户个人 Shell 别名预热（`alias -L`）**：
  为了不破坏开发者的肌肉记忆，Harness 在后台异步以单例模式拉起一次用户的登录交互式 Shell（`$SHELL -ic 'alias -L'`），带 300ms 按键等待与 5000ms 兜底超时。开发者在个人 `.zshrc` / `.bashrc` 中定义的各种私有简写（如 `gco`, `gst`, `k8s`）在初次按下 Tab 时即刻享有毫秒级补全；
- **行内幽灵文本历史预测（Ghost Text Prediction）**：
  通过流式分析 `~/.omp/agent/shell-history.json` 中的历史命令序列，当开发者键入命令前缀时，光标后方自动以半透明的暗灰色字体投影出最有可能的历史整句。按下 `Tab` 或 `Right-Arrow`，整句直接一键采纳上屏，媲美 Fish / Zsh-autosuggestions 的极速交互手感。

#### 4. 行内拼写预测与 Emoji 快捷展开
- **行内单词补全（`spelling.autocomplete`）**：针对英文长单词提供轻量级行内提示，`Tab` 键带空格采纳，`Right-Arrow` 键无空格采纳；
- **Emoji 快捷展开（`emojiAutocomplete`）**：支持 `:smile:` 等标准 Shortcode 补全，并在打字回车时自动将 `:D`、`:-)` 等传统 ASCII 字符表情就地展开为标准 Unicode 图标。

#### 5. 扩展插件补全堆叠架构（`addAutocompleteProvider`）
Harness 提供了开放的补全接入标准：外部 Extension 可通过 `ExtensionUIContext.addAutocompleteProvider(factory)` 注册自己的自定义补全提供商。所有扩展按注册顺序形成补全处理管道（Pipeline），支持在特定垂直领域（如 SQL 语法补全、特定云厂商资源名补全）实现零侵入的能力扩展。

---
## 7. 运行时可观测性与计量度量

一个成熟的 Agent 执行宿主不仅要管好代码执行与模型交互，还必须向开发者提供**微秒级精度、全局透明、经济账单严密闭环的可观测性体系**。

### 7.1 原生单次调用计数与统计数据库（stats.db）

Upstream 在底层设计了一套轻量但工业级的离线统计流水线：
- **后台异步同步 Worker（`__omp_worker_stats_sync`）**：
  为了防止高频写数据库导致终端 TUI 渲染发生微卡顿，宿主在启动时通过隐藏的 argv 选择器拉起专用的 Worker 线程。主进程通过非阻塞 IPC 将每次流式通信的 Metrics 投递给 Worker，由后者在后台异步向 SQLite 数据库 `~/.omp/stats.db` 批量落盘；
- **结构化三维度量模型**：
  数据库维护 `sessions`、`turns` 与 `requests` 三级树状关联表，精细记录每次请求的 `timestamp`、`model_id`、`provider`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`duration_ms` 以及折算后的美分成本 `cost_cents`；
- **多维大盘报表（`omp stats`）**：
  提供类似 ccusage 风格的终端仪表盘，支持按日、周、月的时间序列统计，并支持按项目目录（Folder）、模型家族（Model Family）以及代码功能块（Blocks）展开多维透视，帮助开发者精确掌握算力支出分布。

---

### 7.2 Fork Turn 级别聚合计量看板（work-usage.ts）

#### 1. 监控缺陷：ReAct 循环的“黑盒记账失真”
在原生的统计模型中，指标是按单次 API 请求孤立切分的。然而在真实的 Agent 工程实践中，解决一个用户需求往往伴随着一长串复杂的 ReAct 往返链条：
$$\text{用户 Prompt} \longrightarrow \text{Request 1 (思考 + 调工具)} \longrightarrow \text{Tool Exec} \longrightarrow \text{Request 2 (思考 + 调工具)} \longrightarrow \text{Tool Exec} \longrightarrow \text{Request 3 (最终回答)}$$
在此过程中，开发者与模型本身无法在当前界面获知**“为了完成眼前这句话，系统总共跑了多少轮、一共耗费了多少混合 Token、时间都花在模型思考还是本地工具执行”**。

#### 2. `WorkUsageAccumulator` 双层状态机实现
Fork 在 `packages/coding-agent/src/modes/work-usage.ts` 中构建了 `WorkUsageAccumulator`（回合级聚合器）与 `SessionUsageAccumulator`（会话级聚合器）：
- **贯穿多轮请求生命周期**：跨多次流式网络往返累加输入、输出、缓存写入与读取 Token 数；
- **精细耗时拓扑拆分**：将总耗时严格划分为四个物理维度：
  1. `workTime`：整个回合的总跨度耗时；
  2. `modelTime`：所有模型请求的净网络出流时间之和；
  3. `toolTime`：本地文件 I/O、Git 扫描或 PTY 执行等工具耗时之和；
  4. `waitTime`：网络建立、排队调度与空闲等待时间；
- **TUI 转录流优雅呈现**：在每个用户 Turn 的最末尾，以低侵入感的暗色样式渲染双行聚合看板：
  ```text
  ────────────────────────────────────────────────────────────────────────────────────────────────────────
   WORK  work 17.3s  model 17.0s  tool 122ms  wait 156ms  3 req
   952   1.6K  R70K/W0  reason 83  cache 98.7% (3/3)  cost N/A (3)
  ────────────────────────────────────────────────────────────────────────────────────────────────────────
  ```

#### 3. 用户 `Esc` 强制打断时的计费强健对账机制（Interrupted Request Reconciliation）
在实际编码中，开发者经常会在看到模型开始输出不符合预期的废话时，按下 `Esc` 键强行中止生成。
- **原生记账漏洞**：客户端触发 `AbortController.abort()` 关闭流式传输后，原生异常处理往往将该次请求标记为 Aborted 并直接丢弃，导致本地统计中这部分 Token 凭空蒸发；但实际上远端大模型服务商早已生成了这部分内容并如实计费，导致本地账单与云端对账产生严重偏差；
- **Fork 对账自愈**：在流式中止捕获逻辑中，Fork 从传输层已经成功接收并结算的字节帧中抽取截断处的 Usage 报文，强制推入 Accumulator 并落盘入库，杜绝“隐瞒实际算力成本”。

---

### 7.3 Fork 工具与搜索吞吐量遥测（searchThroughput）

网络检索工具 `web_search` 背后是一套复杂的复合流水线：
$$\text{Query Rewrite (查询提炼)} \longrightarrow \text{Search Provider (搜索引擎调用)} \longrightarrow \text{Web Scraping (正文清洗)} \longrightarrow \text{Model Summarization (多文档综合提炼)}$$

为了让开发者对搜索过程的延迟分布有直观掌控，Fork 引入了 `searchThroughput` 真实吞吐量建模：
- **首字节到达时间（TTFB）与出流时间分离**：
  将网络建连、搜索引擎接口排队、反爬握手的等待时间与后续模型阅读摘要的真实出流时间严格剥离；
- **吞吐率计算模型**：
  $$\text{Throughput} = \frac{\text{Generated / Read Tokens}}{\text{Duration}_{\text{total}} - \text{Latency}_{\text{network\_wait}}}$$
- **故障与未完成语义严肃性**：当网络发生 504 超时、降级重试或未完成完整测量时，卡片上显式打印为 `null` 而非具有欺骗性的 `0 tok/s`，为开发者排查网络瓶颈源自搜索源还是模型本身提供了坚实的量化依据。

---
## 8. 生产级配置全景示例（含 Claude Code 伪装、Codex 与中转实战脱敏模版）

在实际将 OMP 作为主力开发宿主时，配置文件的合理编排直接决定了模型请求的稳定性、Prompt Cache 命中率、冷启动延迟以及成本控制。

以下整理了本地生产环境实战中所使用的全套**生产级配置脱敏模版**，涵盖四大核心配置文件：

### 8.1 智能体主配置：`~/.omp/agent/config.yml`

该文件定义全局主题外观、多模型角色路由分工、长程记忆持久化策略以及上下文滑动压缩阈值：

```yaml
# ==========================================
# OMP 核心全局配置模版 (~/.omp/agent/config.yml)
# ==========================================
setupVersion: 2
symbolPreset: nerd                   # 终端图标集选用 Nerd Font (支持 󰵗, , ,  等 glyphs)
theme:
  dark: amethyst-glass               # 选用毛玻璃半透明透明主题 (配合 transparent: true)

statusLine:
  transparent: true                  # 状态栏背景完全透明化，与桌面壁纸无缝融合

tui:
  textSizing: false                  # 是否允许 OSC 66 终端双倍字高 (依终端能力自适应)
  titleState: true                   # 是否将当前任务状态实时同步到终端窗口 Title 栏

# ------------------------------------------
# 模型角色分工路由 (Model Roles Architecture)
# ------------------------------------------
modelRoles:
  default: relay-claude/claude-sonnet-4-5:high   # 日常主模型：选用高思考阶梯的 Claude 3.7/Sonnet 4.5
  smol: local-proxy/deepseek-v4.1-flash:high     # 轻量路由/小任务：毫秒级响应小模型，节省配额
  wiki: relay-openai/space-bunny-free:max        # 离线 Wiki 与长文档整理：大上下文免计费模型
  vision: relay-openai/kimi-k3:max               # 多模态图文解析角色
  judge: relay-openai/jev:medium                 # 逻辑裁判与评审角色
  web: web/exa                                   # 网络检索默认解析通道

# ------------------------------------------
# 思考与推理流控
# ------------------------------------------
defaultThinkingLevel: max            # 默认思考预算档位 (low / medium / high / xhigh / max)
hideThinkingBlock: false             # 是否在终端折叠思考块 (false 保持流式思考可视化)
proseOnlyThinking: true              # 纯文本思考过滤：避免非标标签污染正文

# ------------------------------------------
# 知识库与长期记忆后端
# ------------------------------------------
autolearn:
  enabled: true                      # 开启对话自适应技能提炼 (Auto-Learn)
  autoContinue: true

memory:
  backend: "wiki"                    # 记忆后端选用外部独立 Markdown Vault
wiki:
  includeGlobal: true                # 是否加载全局公共记忆库 (~/文档/omp-wiki)

# ------------------------------------------
# 本地向量库 (Mnemopi) 与多 Key 轮询池
# ------------------------------------------
mnemopi:
  embeddingModel: google/gemini-embedding-2
  embeddingApiUrl: https://generativelanguage.googleapis.com/v1beta
  # 支持逗号分隔注入多组 API Key，遭遇 429 配额耗尽时透明轮转
  embeddingApiKey: "AIzaSy-REDACTED_GEMINI_KEY_ALPHA,AIzaSy-REDACTED_GEMINI_KEY_BETA,AIzaSy-REDACTED_GEMINI_KEY_GAMMA"

# ------------------------------------------
# 上下文滑动压缩阈值
# ------------------------------------------
compaction:
  enabled: true
  thresholdPercent: 95               # 触发滑动窗口摘要压缩的上下文水位阈值 (95% 满额时启动)
```

---

### 8.2 模型与 Provider 注册表：`~/.omp/agent/models.yml`（多协议实战）

该文件是 OMP 连接底层大模型网关的神经中枢。以下示例完整展示了 **Claude Code 伪装中转**、**OpenAI Codex 原生接口**、**带思考阶梯的 Chat Completions 网关** 以及 **多 Key 轮询凭据池** 的规范写法：

```yaml
# ==========================================
# 模型与提供商注册表 (~/.omp/agent/models.yml)
# ==========================================
providers:
  # ----------------------------------------------------
  # 1. Claude Code 伪装中转 (Anthropic Messages Wire + 缓存保活)
  # ----------------------------------------------------
  relay-claude:
    baseUrl: https://api.your-relay-domain.com/v1
    api: anthropic-messages          # 底层协议选用 Anthropic Messages 线路
    apiKey: sk-ant-api03-REDACTED_CLAUDE_TOKEN_HERE
    headers:
      User-Agent: claude-cli/2.1.217 # 注入官方 CLI User-Agent，配合 Claude Code Cloak 伪装
    compat:
      sendSessionAffinityHeaders: true   # 保持会话亲和性 (绑定 session_id 与 device_id)
      extraBetas:                        # 声明式穿透 Beta 头，破解部分中转 1M 拦截 (Patch 19)
        - "context-1m-2025-08-07"
      promptIncludesCacheRead: true      # 修正部分国内反代虚高 input_tokens 统计 (Patch 22)
    models:
      - id: claude-opus-5
        name: Claude 3.5/3.7 Opus (Relay Cloak)
        reasoning: true
        cacheRetention: true             # 启用 Prompt Caching 缓存锚点
        contextWindow: 1000000           # 声明支持 1M 超大上下文
        maxTokens: 64000
      - id: claude-sonnet-4-5
        name: Claude 3.7 Sonnet (Relay Cloak)
        reasoning: true
        cacheRetention: true
        contextWindow: 200000
        maxTokens: 64000

  # ----------------------------------------------------
  # 2. OpenAI Codex / Responses 接口 (Codex Wire + 身份透传)
  # ----------------------------------------------------
  openai-codex:
    baseUrl: https://api.codex-proxy.internal/v1
    api: openai-codex-responses      # 底层选用 Responses 原生接口
    apiKey: sk-codex-REDACTED_OPENAI_TOKEN_HERE
    headers:
      Originator: codex-cli          # 配合 Patch 27，防止官方覆盖自定义身份指纹
      User-Agent: codex/1.2.0
    compat:
      supportsDeveloperRole: true    # 将系统指令编译为 developer 角色
    models:
      - id: gpt-5-codex
        name: GPT-5 Codex Preview
        reasoning: true
        contextWindow: 400000
        maxTokens: 32000

  # ----------------------------------------------------
  # 3. OpenAI Chat-Completions 网关 (带自适应思考预算阶梯)
  # ----------------------------------------------------
  relay-openai:
    baseUrl: https://api.your-openai-relay.com/v1
    api: openai-completions          # 标准 OpenAI 兼容线路
    apiKey: sk-relay-REDACTED_MIDDLEWARE_TOKEN_HERE
    compat:
      thinkingFormat: "openai"       # 思考格式：标准 top-level reasoning_effort
      reasoningContentField: "reasoning_content" # 历史消息回放思考痕迹读取字段
      retryWithoutStrictOnGrammarError: true     # 遇到语法报错自适应去 strict 重试
    models:
      - id: space-bunny-free
        name: Space Bunny Alpha (Relay Free)
        reasoning: true
        thinking:
          mode: effort               # 思考模式选用 effort 阶梯
          efforts: [low, medium, high, xhigh, max] # 声明完整的思考档位
          defaultLevel: max
        input:
          - text
          - image                    # 声明多模态输入支持
        contextWindow: 1000000
        maxTokens: 524288

  # ----------------------------------------------------
  # 4. 多 API Key 轮询凭据池 (Multi-API-Key Pool)
  # ----------------------------------------------------
  high-concurrency-pool:
    baseUrl: https://api.pooled-relay.com/v1
    api: openai-completions
    # 声明式注入 Key 轮询池：遭遇 429 / 额度耗尽自动切换并冷却
    apiKeys:
      - "sk-pool-key-01-REDACTED_CREDENTIAL"
      - "sk-pool-key-02-REDACTED_CREDENTIAL"
      - "sk-pool-key-03-REDACTED_CREDENTIAL"
      - "sk-pool-key-04-REDACTED_CREDENTIAL"
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek Flash Pool
        contextWindow: 131072
        maxTokens: 8192
```

---

### 8.3 热重载重试规则配置：`~/.omp/agent/retry-rules.json`

这是 Fork 独有的动态韧性规则文件（Patch 28），**修改即时热重载生效，无需重新编译二进制或重启进程**。可精准捕获中转商各种离奇的非标 400 报错、负载满载和 Codex 错误：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/master/packages/coding-agent/src/error/retry-rules.schema.json",
  "rules": [
    {
      "name": "国内中转 400 伪装错误与始终思考重试拦截",
      "description": "捕获中转商返回的 [1210] 路由错误或'请使用 reasoning_effort'，强制纳入退避重试",
      "match": {
        "status": 400,
        "bodyRegex": "\\[1210\\]|始终思考|请使用 reasoning_effort|不支持 thinking_budget"
      },
      "action": {
        "retry": true,
        "stripThinking": true,
        "maxAttempts": 3,
        "backoffMs": 1000
      }
    },
    {
      "name": "中转网关瞬时负载满载熔断自愈",
      "description": "捕获服务商提示负载达到上限但带有请求 ID 的瞬态错误",
      "match": {
        "status": 503,
        "bodyRegex": "负载已经达到上限|capacity exceeded|server overloaded"
      },
      "action": {
        "retry": true,
        "maxAttempts": 4,
        "backoffMs": 2000
      }
    },
    {
      "name": "Codex 专属事件流重试",
      "description": "拦截 Codex Responses 线路中偶发的流式状态中断",
      "match": {
        "eventCode": "response_stream_interrupted"
      },
      "action": {
        "retry": true,
        "maxAttempts": 3,
        "backoffMs": 1500
      }
    }
  ]
}
```

---

### 8.4 惰性 MCP 配置：`~/.omp/agent/mcp.json`（以 Notion 实战为例）

展示如何利用 Fork 专属的 `"lazy": true` 机制挂载复杂的外部工具服务（如本地 Node 实现的 Notion MCP Server），实现**冷启动零阻塞与首轮 Prompt 零膨胀**：

```json
{
  "mcpServers": {
    "notion": {
      "command": "node",
      "args": ["~/.local/share/mcp/notion/dist/index.js"],
      "env": {
        "NOTION_API_KEY": "secret_REDACTED_NOTION_INTERNAL_INTEGRATION_TOKEN_HERE"
      },
      "lazy": true
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_REDACTED_GITHUB_PERSONAL_ACCESS_TOKEN_HERE"
      },
      "lazy": true
    }
  }
}
```

**工作流解析**：
1. 当会话启动时，`notion` 与 `github` 均不会拉起子进程，也不会与远端服务通信，启动耗时 0ms；
2. 系统仅在当前可用设备树中分别暴露 `xd://mcp__notion_gateway` 与 `xd://mcp__github_gateway` 两个极其轻量的占位设备；
3. 仅当任务指明“向 Notion 追加博客”时，Agent 向 `xd://mcp__notion_gateway` 写入 `{}`；
4. Harness 底层即时拉起 `node` 进程完成握手，随后触发 `onToolsChanged`，将真正的 `notion_append_block`、`notion_query_database` 等十余个专业工具注入当前会话，完成无感即时升级。


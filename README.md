# grow-loop

[![Tests](https://github.com/Trunks820/grow-loop/actions/workflows/test.yml/badge.svg)](https://github.com/Trunks820/grow-loop/actions/workflows/test.yml)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Harness-agnostic, zero-dependency multi-package delivery loop for AI coding agents.**

> `grow-loop` 是面向 AI 编程交付的**确定性治理状态机与跨宿主 Skill**（Node.js >= 18，零外部依赖）。  
> 无论今天由 **Codex、Antigravity、Claude Code、DeepSeek Harness 还是 Cursor** 担任总控，把「状态流转、修复上限、自动升级、审查封顶、授权刹车、错题注入、脱敏证据包」全部外置到代码里，让 AI 按包稳步交付，而不是陷入无限返工或失控自动放行。
>
> 🌱 **Grow 家族**：配套上游工具 [grow-me](https://github.com/Trunks820/grow-me)（持续打磨中）负责**让需求长成方案**，`grow-loop` 负责**让方案长成交付**；同时完全解耦，可直接承接 `ai-dev-workflow` 或任意 Markdown / Issue 任务清单。

---

## 为什么做 `grow-loop`？（而不是又一个多 Agent 控制台）

市面上已有 T3 Code、Antumi 等优秀的多 Agent **控制台（遥控屏）**，适合人盯多个 CLI 线程、切模型、收审批。但真实多包研发交付还缺一层**协议与治理内核**：

| 维度 | 多 Agent 控制台 | `grow-loop`（交付治理协议层） |
|---|---|---|
| 核心对象 | 聊天线程 / 终端窗口 | 工作包（`W01..Wn`）全生命周期状态机 |
| 返工与升级 | 人肉观察并手动换模型 | 确定性 `2 + 2 + 2` 规则自动升级与硬刹车 |
| 质量兜底 | 依赖模型自觉 | 强制 **Verify-First**（机器实测先于审查）+ 封顶关包全量审 |
| 跨包进化 | 每轮重新踩坑 | 教训确认后按适用范围写入任务书 |
| 账号与凭据 | 部分工具接管登录态或换号 | **零托管 5 条红线**（只调本机已登录 CLI，绝不碰凭据） |
| 换宿主续跑 | 绑死在单一客户端 | 状态默认在 `<repo>/.loop/`，随时换宿主无损接力 |

---

## 核心特性

### 1. 默认状态落在 `<repo>/.loop/`，支持跨宿主无损接力
- `grow-loop init` 默认在目标项目/worktree 根目录创建 `.loop/`，并自动写入 `<repo>/.gitignore`（可加 `--no-gitignore` 跳过）。
- 项目改名、多开 Git worktree 不会错乱；上半程用 Codex 跑完 W01–W03，下半程切到 Antigravity / Claude Code / Cursor 直接 `grow-loop status` / `grow-loop next` 无损接手。
- 如需把状态集中存到外部目录（如 Obsidian 知识库），通过 `--state-dir <path>` 或环境变量 `GROW_LOOP_STATE_DIR` 覆盖即可（外部目录不会改动项目 `.gitignore`）。

### 2. 确定性 `2 + 2 + 2` 修复、升级与审查治理
- **爆炸半径预判（Blast-Radius Gate）**：
  - `estimated_files >= 25` 或 `cross_module: true` 或 `risk: "high"` → 自动直接上 `tier2` 起跑，不浪费低阶模型反复返工。
  - `estimated_files >= 50` → 触发 `PAUSED_FOR_HUMAN`（`BLAST_RADIUS_SPLIT`），建议拆包或由人显式批准直接上 `tier2`。
- **Verify-First**：先过本机验证（编译 / 单测 / 隔离实测脚本），再进关包审查。`grow-loop verify` 依次执行全局和包级命令，按实际退出码判定。配置了可运行命令时，`record verify --passed` 需要显式加 `--allow-self-report`，证据包会标为「自报」。
- **修复与自动升级阶梯（`2 + 2`）**：
  - `tier1` 最多修 **2 轮** → 第 3 次失败自动升级到 `tier2`（`tier2_repairs = 1`）。
  - `tier2` 最多修 **2 轮** → 仍未过硬刹车 `PAUSED_FOR_HUMAN`（`BUDGET_EXCEEDED`），交给人拍板，绝不无限死循环。
- **关包审查封顶 + 严重度底线（`2`）**：
  - 默认采用**关包全量深审**，最多 **2 轮**（`review.max_rounds: 2`）。第 2 轮核对上轮阻塞项、“本轮一起修”项和修复新引入、达到阻断级别的回归。
  - `review.blocking_severities` 决定哪些级别阻塞关包，默认是 `BLOCKER` 和 `HIGH`。其余发现进入 `.loop/tech-debt.md`。退回轮标“本轮一起修”，审查通过后按原标题再报的转为待办，其余划掉并标为已修。到达审查上限后人工批准提交时，仍标为“本轮一起修”的条目在提交时转为待办。
  - 达到 2 轮上限时：若仍在 `tier1`，自动升级 `tier2` 做一次最终修复（验证通过后暂停请人确认提交，不再开第 3 轮对抗审查）；若已在 `tier2`，立即停机找人（`REVIEW_CAP_REACHED`）。
- **基础设施故障免疫（Infra Immunity）**：
  - `429` 限流（`INFRA_QUOTA`）、认证失效（`INFRA_AUTH`）、超时（`INFRA_TIMEOUT`）、CLI 崩溃（`INFRA_CLI_CRASH`）**绝不消耗** `tier1`/`tier2` 代码修复额度；默认停机通知人，不悄悄换号。

### 3. 两个开箱即用 Profile（配置模板）
不用自己从零写几十行配置，`init` 时二选一即可：
- **`standard-test`（常规项目模板）**：适合有完整单测/集成测试环境的项目，`new_tests: "optional"`，跑 `npm test` / `pytest` / `mvn test` 等测试命令验证。
- **`live-smoke`（老项目 / 重库 / 实测模板）**：适合不方便写 mock 单测、强依赖真实数据库或外部服务的老项目，`new_tests: "forbidden"`（把「禁止新增单测文件」写进给 AI 的 `task.md` 顶部红线），靠编译 + 回归检查 + 隔离端口真库实测脚本兜底验证。

### 4. 五条零托管鉴权红线（Zero-Custody Auth Red Lines）
1. **零凭据托管**：不读、不拷贝、不代理任何 OAuth token、Cookie、API Key 或 CLI 登录目录（BYO 本机已登录 CLI）。
2. **禁止静默换号**：不搞自动换号池或代理订阅账号；遇到限流默认停机由人决策。
3. **只读探活 + 零密钥回显**：`grow-loop probe` 只做带超时的本地只读探测（不花一分钱调大模型），并明确区分「CLI 就绪」与「服务端额度」；全部日志/事件/证据经 `src/redact.mjs` 脱敏。
4. **禁止无条件全放行**：审查阶段强制只读沙箱；`git push` / 合分支 / 发布 / 改生产 / 改全局配置均被 Approval Envelope 拦在人工闸门外。
5. **非侵入运行**：不修改 `~/.codex/`、`~/.claude/`、`~/.dsh/`，不静默安装全局依赖。

---

## 快速开始

### 环境要求
- Node.js `>= 18`（**零第三方依赖**，无需 `npm install`）
- Git（用于 `--from-git` 自动采集 commit 与 diff 统计）

### 1. 克隆并可选安装为全局 Skill / CLI

```bash
git clone https://github.com/Trunks820/grow-loop.git
cd grow-loop
npm test   # 运行内置 node:test 测试套件
```

作为跨宿主 Agent Skill 使用时，将本仓库软链（或 Windows Junction）到 `~/.agents/skills/grow-loop`（以及你的宿主 Skill 目录），任何支持 `SKILL.md` 的 Agent 即可自动识别。

### 2. 在目标项目中初始化

先按 [清单格式](docs/UPSTREAM-BRIDGE.md) 准备一份 `delivery.json`，把待交付的工作包按执行顺序放进 `packs`。选择对应的 profile 初始化。

```bash
# 常规项目（可跑单测）
node /path/to/grow-loop/bin/grow-loop.mjs init --repo /path/to/your-project --profile standard-test --manifest delivery.json

# 或老项目 / 重库实测模式（禁新增单测 + 实测脚本）
node /path/to/grow-loop/bin/grow-loop.mjs init --repo /path/to/your-project --profile live-smoke --manifest delivery.json

# 可选：把状态存到外部目录（如 Obsidian），不修改项目 .gitignore
node /path/to/grow-loop/bin/grow-loop.mjs init --repo /path/to/your-project --state-dir /path/to/vault/loop-state --manifest delivery.json
```

`init` 将清单导入状态目录的 `manifest.json`。首次初始化时省略 `--manifest` 会创建空清单。已有清单时，直接传 `--manifest` 会报错。要替换整份清单，请用 `init --force --manifest <文件>`。这条命令允许替换有待确认改动的旧清单，并重新初始化配置和运行状态。

### 3. 配置执行器与确认清单改动

在 `.loop/config.json` 配置本机的 `tier1`、`tier2`、`reviewer` 实例和 `verification` 命令。

`grow-loop status` 会显示手改清单后待确认的差异。用 `grow-loop manifest-ack --reason "补充退款回执的验收条件"` 确认后继续。`init --force --manifest` 也可以替换有待确认改动的整份清单。

### 4. 探活并驱动闭环

```bash
# 只读探活本机已配置的 CLI 实例（不耗模型额度）
grow-loop probe

# 查看当前状态与下一步确定性指令
grow-loop next

# 预检干跑（生成带错题注入的 task.md，不改代码、不调 API）
grow-loop dispatch --stage implement --dry-run

# 正式派发执行（外部 CLI 自动记录结果；self 模式由当前宿主执行后 record）
grow-loop dispatch --stage implement
grow-loop verify   # CLI 先跑全局命令，再跑本包命令
# 外部审查完成并返回报告路径后，CLI 自动读取报告并转移状态
grow-loop dispatch --stage review
# self 审查也从正式派发开始，交报告时可注明实际工具、模型和档位
grow-loop record review --report <report.md>
grow-loop record commit --from-git

# 当触发人工刹车门时恢复
grow-loop resume --decision "已确认走单选，批准继续" --action approve

# 全部包完成后一键产出脱敏双层证据包（.loop/evidence.md）
grow-loop evidence
```

报告读不出或格式有误时，CLI 会退出并给出报告路径和错误位置，包继续等待审查。旧的 `record review --verdict`、`--findings-file` 和 `--findings` 参数仍可用。 [审查报告格式](docs/ADAPTER-SPEC.md#closing-review-reports)

## 派发记录与续跑

`dispatch --dry-run` 将运行号、运行目录、任务书、阶段、执行实例和任务书指纹存入 `prepared_run`。同阶段同实例正式派发时复用运行目录。同一指纹直接使用原任务书，包状态、修复次数、审查轮次、确认后的清单等输入变化时在原目录重写 `task.md`。本次指定 `--task-file <path>` 时使用该文件。正式派发会清掉预演记录。

正式派发在启动执行器前写入 `inflight_run`，可用 `grow-loop status` 查看运行号、目录、阶段、执行实例、开始时间和已收到的会话号。Codex 发出 `thread.started` 后立即保存会话号。执行中断后可对同阶段同实例运行 `grow-loop dispatch --resume`，CLI 会使用当前运行或上次派发保存的匹配会话。切换执行实例会使旧档会话失效。没有匹配会话时启动新会话并提示。指定 `--resume <session-id>` 可显式使用已知会话号。外部派发结束后清掉 `inflight_run`。

`self` 档从正式派发开始计时。完成后用 `record implement --passed` 或 `record review --report <report.md>` 登记，可附 `--executor-tool`、`--executor-model` 和 `--executor-effort`。CLI 清掉 `inflight_run`，把执行者及用时写入流水账和该次运行的 `result.json`。证据包累计用时包含这些记录，每包显示最终实现者的工具和模型。

## 提交前的文件和分支检查

包开工时记录 `base_commit` 和 `base_branch`。验证、审查派发、`next` 返回 `COMMIT` 以及 `record commit` 时，CLI 对比基线与当前 HEAD，排除 loop 已登记的包提交和正在登记的提交。若外部提交改到本包 `scope_files`、`co_change_files` 或已完成包提交过的文件，CLI 会列出提交、改动文件和冲突路径，触发 `EXTERNAL_COMMIT`。核对后用 `grow-loop resume --action approve --decision "<原话>"` 从原阶段继续，基线更新为当前 HEAD，决定写入流水账。也可用 `--action abort` 终止循环。无交集的提交只提醒并记账一次。Git、仓库或 HEAD 不可用时会说明并跳过比对。

已经开工但缺少基线的包，从第一次能读取的 HEAD 开始比对。

`next` 的 `COMMIT` 输出用 `stray_files` 列出范围外的未跟踪和改动文件。图片、日志及文件名含 `report`、`summary`、`notes`、`draft` 或 `final` 的 Markdown 等会标记为疑似产物，并提示产物目录。`record commit --from-git` 也会提醒该笔提交中的范围外疑似产物。产物提醒允许流程继续。

## 验证命令与环境

在状态目录的 `config.json` 用 `verification.commands` 配置各包共用的本机检查。在 `manifest.json` 的包定义里可用 `"verify_commands": ["npm run test:checkout"]` 添加本包检查。CLI 先跑全局命令，再跑本包命令，两处至少有一条可运行命令。空白和以 `#` 开头的占位项会跳过。

- `verification.env` 是验证子进程的环境变量键值对，默认 `{}`。Windows 下默认设 `PYTHONUTF8=1` 和 `PYTHONIOENCODING=utf-8`，同名配置优先。
- `verification.path_prepend` 是按顺序加到 `PATH` 前面的目录数组，默认 `[]`。
- `verification.output_encoding` 是命令输出的解码方式，默认 `utf-8`，旧工具可按实际输出设置为 `gbk` 等编码。保存的日志使用 UTF-8。
- `verification.retry_once` 默认 `true`。每轮遇到第一条失败就停。第一轮失败后从头重跑整套命令，两轮日志分目录保存。第二轮全过时记为 `flaky`，照常进入审查，不扣修复次数、不记教训。设为 `false` 时只跑一轮。

验证失败后先查看日志。若确认是环境问题，在正式派活前运行 `grow-loop verify --mark-env "本机测试服务未启动"`。CLI 记录原因，撤销该次失败引起的预算、升档、暂停和教训，并立即重跑验证。若重跑仍失败，包留在 `VERIFY`，环境恢复后可再次运行 `grow-loop verify`。

## 教训的确认和挑选

实现失败、验证失败和阻断审查发现自动记为 `draft`（草稿）。审查给出的 `rule` 会预填。`next` 和 `status` 列出待确认的编号和摘要，派活照常。指挥的人补上“下次怎么做”，选定范围后确认。停用时保留教训和原因。

```bash
grow-loop lesson list --status draft
grow-loop lesson confirm --id L001 --rule "检查失败后先核对测试数据" --scope global
grow-loop lesson confirm --id L002 --rule "先初始化考试数据" --scope tags --tags exam
grow-loop lesson disable --id L001 --reason "检查已由验证脚本覆盖"
grow-loop record lesson --summary "缺少测试数据" --rule "先初始化考试数据" --scope tags --tags exam
```

`confirm` 必须提供 `--rule` 和 `--scope`，可选 `--root-cause`。`--scope tags` 省略 `--tags` 时沿用教训自己的功能类别，两处都为空会报错。手动 `record lesson` 同时提供规则和范围时直接记为 `confirmed`（已确认），否则记为草稿。`lesson list` 可查看 `draft`、`confirmed`、`disabled`（已停用）或全部记录。命令操作写入 `events.jsonl`。

每份任务书最多挑 8 条已确认教训，依次优先本包教训、范围与包标签有交集的教训、全局教训。同档按创建时间从新到旧。即使适用标签与来源包的标签不匹配，本包的已确认教训仍优先纳入本包任务书。

`lessons.json` 使用 `status` 保存确认状态，`scope` 保存 `global` 或 `tags`，`scope_tags` 保存适用标签。`tags` 保存所属包的功能类别，`repair_rounds` 保存两档累计修复轮次。提交时更新为最终轮次，并用 `fixed_by` 和 `closed_at` 记录修复包和时间。`lessons.md` 展示状态、范围、功能类别和轮次。旧 `OPEN` / `CLOSED` 记录按规则是否存在读作已确认或草稿，已确认时有标签按标签适用，无标签按全局适用。确认或停用时才将该条旧记录写为新状态。

## 任务书

初次实现和修复任务书依次列出「避坑提示」「要一起改的文件」「要保住的旧行为」「已经定了的」「可能要一起改的文件」「转来的发现」「产物放哪」。前三栏由指挥的人读代码后填写。任一栏为空或避坑提示未点名代码时，`next` 和 `dispatch`（含 `--dry-run`）会给出提醒，派活照常。

「已经定了的」保留方案与门禁决定的原话，有冲突时以原话为准。两轮审查都会带上这一节和「要保住的旧行为」，复审沿用上一轮问题的收尾范围。引用候选由 `git grep` 扫出并附命中词，须由指挥的人确认。

派活前会创建 `<状态目录>/artifacts/<包ID>/`，任务书会给出报告、截图和草稿的保存位置。产物需放在工作树之外时，初始化并派活时使用外置 `--state-dir`。

实现与修复任务书列出本包实际配置的验证命令。修复任务书还会给出失败命令、退出码、超时状态、两份日志路径、输出摘录，以及识别到的测试名和断言。

## 中途改动

```bash
grow-loop pack insert --file followup.json --after W01 --reason "先补迁移检查"
grow-loop pack insert --file prerequisite.json --before W02 --reason "先补测试数据"
grow-loop pack tier --id W02 --tier tier2 --reason "需要跨模块修改"
grow-loop pack scope --id W02 --add src/a.mjs,src/b.mjs --reason "本包处理权限边界" --todo T001
grow-loop forward --from W01 --to W03 --text "补查旧客户端兼容性" --reason "W03 负责客户端"
grow-loop forward --to W03 --todo T002 --reason "在兼容性包处理"
grow-loop todo add --pack W02 --text "src/c.mjs：缺少超时处理" --reason "实现时发现超范围问题"
grow-loop todo list
grow-loop todo dismiss --todo T003 --reason "已确认现有重试覆盖该场景"
```

- `pack insert` 从 UTF-8 JSON 文件读取单个包对象。`--after` 在新包未写 `depends_on` 时让它依赖锚点，并让原来依赖锚点的待开工包也依赖新包。`--before` 让锚点包依赖新包，只能用于 `PENDING` 包。遇到已开工或已完成的锚点请用 `--after`。输出和流水账会列出插入位置与依赖有变化的包。
- `pack tier` 为待开工包指定开工时采用的档位，拆包等门禁照常生效。已开工包的改档从下次派活起生效。更换执行实例时会清除旧会话，已用的修复次数照计。
- `pack scope` 去重后扩充 `scope_files`，并把 `estimated_files` 至少提高到范围文件数。可以用逗号分隔文件，也可以重复传 `--add`。修改后的范围会出现在下次生成的实现任务书里。附带 `--todo` 会把该待办标为 `expanded`。
- `forward` 接受一段文字或一条 open 待办。文字默认来自当前包，可用 `--from` 指定来源包。转待办时沿用它的来源并标为 `forwarded`。目标包的初次实现和修复任务书会列出转来的发现、来源与原因。
- Codex 实现派活结束后，标题含「超范围没改」的节中，具体列表项会转成 open 待办。有这一节却未解析出待办时，派活结果会提醒。自己执行时用 `todo add` 记录。`todo list` 显示全部待办，`status` 的 `open_todos` 显示待处理项。

写入类命令都需要非空 `--reason`。改清单的命令更新快照，并在 `events.jsonl` 写入 `manifest_changed`，其 `source` 分别为 `pack_insert`、`pack_tier`、`pack_scope`、`forward`。自动及手动新增待办写入 `todo_added`，关闭写入 `todo_dismissed`。修改包目标或验收时，先手改状态目录的 `manifest.json`，再用 `grow-loop manifest-ack --reason "说明为什么改"` 确认，由 `manifest_changed` 记录差异和原因。各命令可沿用工作区的 `--repo` 和 `--state-dir`。

---

## 目录结构

```text
grow-loop/
├── SKILL.md                  # 跨宿主 Agent Skill 协议（Codex / Antigravity / Claude / Cursor 通用）
├── package.json              # 零依赖 ESM 包定义
├── bin/
│   └── grow-loop.mjs         # CLI 入口（init/status/manifest-ack/next 等）
├── profiles/
│   ├── standard-test.json    # 开箱模板 1：常规单测项目
│   └── live-smoke.json       # 开箱模板 2：禁新单测 + 实测脚本项目
├── src/
│   ├── state.mjs             # .loop/ 原子持久化、自动 .gitignore、events.jsonl
│   ├── router.mjs            # 确定性状态机（Blast-Radius + 2+2+2 + 审查底线 + 故障免疫）
│   ├── gate.mjs              # 人工刹车门与 Approval Envelope
│   ├── lessons.mjs           # 结构化错题本（lessons.json / lessons.md / tech-debt.md）与跨包注入
│   ├── probe.mjs             # 带超时只读能力探活 + 可选 code_intel 探测
│   ├── task-builder.mjs      # 生成实现、修复和审查任务书 task.md
│   ├── ref-scan.mjs          # 用 git grep 查找可能需要联改的文件
│   ├── verify.mjs            # CLI 亲自执行验证命令、按退出码判定并留存日志
│   ├── redact.mjs            # 凭据/Token/内网 IP 脱敏与残留扫描引擎
│   ├── evidence.mjs          # 双层脱敏验收证据包生成器（人读总表 + 6 类证据）
│   └── adapters/             # 薄驱动层（self / codex / claude / dsh / custom-cmd）
├── docs/
│   ├── ADAPTER-SPEC.md       # Executor 适配器规范与 5 条零托管红线
│   └── UPSTREAM-BRIDGE.md    # manifest.json 协议与 grow-me / ai-dev-workflow 桥接指南
└── test/
    └── grow-loop.test.mjs    # Node 原生 node:test 完整单元与端到端测试
```

---

## 演进路线（Mode A → Mode C）

- **v0.1（当前，Mode A）**：由任意宿主 Agent（Codex / Antigravity / Claude Code / Cursor）驱动外置 CLI 状态机与薄适配器，先把内核底座与协议打牢。
- **v0.2（Mode C 底座升级）**：在复用同一份 `.loop/` 状态与适配器规范的前提下，增加无头驱动模式（Mode B：`grow-loop run` 后台无人值守推进，遇门停机），并在其上可选叠加只读观测面板。

## License

MIT — see [LICENSE](LICENSE).

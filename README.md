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
| 跨包进化 | 每轮重新踩坑 | 错题本（`lessons.json`）按标签自动注入下一包 `task.md` |
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
- **Verify-First**：永远先过机器验证（编译 / 单测 / 隔离实测脚本），再进关包审查。
- **修复与自动升级阶梯（`2 + 2`）**：
  - `tier1` 最多修 **2 轮** → 第 3 次失败自动升级到 `tier2`（`tier2_repairs = 1`）。
  - `tier2` 最多修 **2 轮** → 仍未过硬刹车 `PAUSED_FOR_HUMAN`（`BUDGET_EXCEEDED`），交给人拍板，绝不无限死循环。
- **关包审查封顶 + 严重度底线（`2`）**：
  - 默认采用**关包全量深审**，最多 **2 轮**（`max_review_rounds: 2`）；第 2 轮为严格收敛审（只核对上轮阻塞项是否修干净、有无新 `BLOCKER/HIGH` 回归）。
  - **仅 `BLOCKER` / `HIGH` 阻塞关包**；`MEDIUM` / `LOW` 自动记入 `.loop/tech-debt.md`，即使审查员口头判 `fail` 也会被状态机强制放行（Severity Floor）。
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

```bash
# 常规项目（可跑单测）
node /path/to/grow-loop/bin/grow-loop.mjs init --repo /path/to/your-project --profile standard-test

# 或老项目 / 重库实测模式（禁新增单测 + 实测脚本）
node /path/to/grow-loop/bin/grow-loop.mjs init --repo /path/to/your-project --profile live-smoke

# 可选：把状态存到外部目录（如 Obsidian），不修改项目 .gitignore
node /path/to/grow-loop/bin/grow-loop.mjs init --repo /path/to/your-project --state-dir /path/to/vault/loop-state
```

### 3. 编辑任务清单与执行器映射
- `.loop/manifest.json`：填入待交付的工作包 `W01..Wn`（可由 [grow-me](https://github.com/Trunks820/grow-me) / `ai-dev-workflow` 或任意 Markdown 清单转换，详见 [docs/UPSTREAM-BRIDGE.md](docs/UPSTREAM-BRIDGE.md)）。
- `.loop/config.json`：配置本机的 `tier1` / `tier2` / `reviewer` 实例与 `verification` 命令。

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
grow-loop record verify --passed --command "npm test" --summary "42/42 passed"
grow-loop record review --verdict pass --findings-file findings.json --summary "0 blocking findings"
grow-loop record commit --from-git

# 当触发人工刹车门时恢复
grow-loop resume --decision "已确认走单选，批准继续" --action approve

# 全部包完成后一键产出脱敏双层证据包（.loop/evidence.md）
grow-loop evidence
```

---

## 目录结构

```text
grow-loop/
├── SKILL.md                  # 跨宿主 Agent Skill 协议（Codex / Antigravity / Claude / Cursor 通用）
├── package.json              # 零依赖 ESM 包定义
├── bin/
│   └── grow-loop.mjs         # CLI 入口（init/probe/status/next/dispatch/record/resume/evidence）
├── profiles/
│   ├── standard-test.json    # 开箱模板 1：常规单测项目
│   └── live-smoke.json       # 开箱模板 2：禁新单测 + 实测脚本项目
├── src/
│   ├── state.mjs             # .loop/ 原子持久化、自动 .gitignore、events.jsonl
│   ├── router.mjs            # 确定性状态机（Blast-Radius + 2+2+2 + 审查底线 + 故障免疫）
│   ├── gate.mjs              # 人工刹车门与 Approval Envelope
│   ├── lessons.mjs           # 结构化错题本（lessons.json / lessons.md / tech-debt.md）与跨包注入
│   ├── probe.mjs             # 带超时只读能力探活 + 可选 code_intel 探测
│   ├── task-builder.mjs      # 生成带错题/阻塞项/单测红线的受控 task.md
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

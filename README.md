# grow-loop

[![Tests](https://github.com/Trunks820/grow-loop/actions/workflows/test.yml/badge.svg)](https://github.com/Trunks820/grow-loop/actions/workflows/test.yml)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`grow-loop` 帮助 Codex、Claude Code、DeepSeek Harness 等宿主按工作包完成代码交付。总控按 CLI 返回的动作派活，由 CLI 运行本机验证，再由审查者关包，总控登记本地提交。CLI 管理修复预算、人工门禁、教训和证据，其他宿主可以接着同一状态目录继续执行。[0.2.0 变更记录](CHANGELOG.md)

## 快速开始

需要 Node.js 18 或以上版本和 Git，无需安装第三方依赖。克隆项目后可在仓库里运行 `npm test`。Node.js 18.0.0 可用 `node test/grow-loop.test.mjs` 直接运行测试文件。

把本项目目录链接到宿主的 Skill 目录即可让宿主读取 `SKILL.md`。直接运行下面的 Node 命令，或者在已经链接 CLI 的环境中用 `grow-loop` 代替 `node /path/to/grow-loop/bin/grow-loop.mjs`。

在目标仓库执行以下两种初始化命令中的一种。已有工作区时，可按桥接指南追加交接包。[清单格式、交接导入与替换](docs/UPSTREAM-BRIDGE.md)

```sh
node /path/to/grow-loop/bin/grow-loop.mjs init --manifest delivery.json --profile standard-test
node "/path/to/grow-loop/bin/grow-loop.mjs" init --handoff task.manifest.json --profile standard-test
```

- `standard-test` 允许按需补测试，初始验证命令是 `npm test`。
- `live-smoke` 禁止新增单测，初始化后配置项目的构建、已有回归检查和隔离环境实测脚本。
- 不在目标仓库时，通过 `--repo <dir>` 指定仓库。状态默认在 `<repo>/.loop/`，初始化将它加入 `.gitignore`，可用 `--no-gitignore` 跳过。使用 `--state-dir <dir>` 或 `GROW_LOOP_STATE_DIR` 指定外置状态目录时，CLI 不改仓库的 `.gitignore`。后续命令沿用同一工作区。

按总控协议配置执行器和验证命令，补齐包范围及任务书所需的内容，再探活和读取下一步。[总控执行协议](SKILL.md#coordinator-execution-protocol-mode-a)

```sh
node /path/to/grow-loop/bin/grow-loop.mjs probe
node /path/to/grow-loop/bin/grow-loop.mjs next
```

`next` 返回本包当前动作。按总控协议依次派发实现、运行验证、完成审查、登记本地提交，再读下一步。全部包完成后生成脱敏证据。外部操作遵守 [Approval Envelope 和 Zero-Custody 红线](SKILL.md#mandatory-security--governance-red-lines)。

## 命令清单

运行 `grow-loop --help` 查看命令用法。

| 用途 | 命令 | 说明 |
| --- | --- | --- |
| 准备工作区 | `grow-loop init`、`grow-loop import`、`grow-loop manifest-ack` | [清单与交接](docs/UPSTREAM-BRIDGE.md) |
| 查看和推进 | `grow-loop probe`、`grow-loop status`、`grow-loop next`、`grow-loop dispatch`、`grow-loop verify` | [运行工作包](SKILL.md#coordinator-execution-protocol-mode-a) |
| 登记结果 | `grow-loop record implement`、`grow-loop record verify`、`grow-loop record review`、`grow-loop record commit` | [总控执行协议](SKILL.md#coordinator-execution-protocol-mode-a) |
| 中途改动 | `grow-loop pack insert`、`grow-loop pack tier`、`grow-loop pack scope`、`grow-loop forward`、`grow-loop todo add`、`grow-loop todo list`、`grow-loop todo dismiss` | [中途改动示例](#中途改动) |
| 沉淀教训 | `grow-loop lesson list`、`grow-loop lesson confirm`、`grow-loop lesson disable`、`grow-loop record lesson` | [确认草稿与选择适用范围](SKILL.md#step-5--confirm-and-scope-lesson-drafts) |
| 回填决定 | `grow-loop status --format shell`、`grow-loop answer`、`grow-loop resume` | [壳接口](docs/SHELL-API.md) |
| 导出证据 | `grow-loop evidence` | [本地提交与证据](SKILL.md#step-8--commit-locally-and-generate-evidence) |

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

写入类命令都需要非空 `--reason`。改清单的命令更新快照，并在 `events.jsonl` 写入 `manifest_changed`，其 `source` 分别为 `pack_insert`、`pack_tier`、`pack_scope`、`forward`。自动及手动新增待办写入 `todo_added`，关闭写入 `todo_dismissed`。修改包目标或验收时，走[清单确认流程](docs/UPSTREAM-BRIDGE.md#fill-the-required-fields)。各命令可沿用工作区的 `--repo` 和 `--state-dir`。

## 目录结构

```text
grow-loop/
├── SKILL.md                  # 总控执行协议和授权红线
├── CHANGELOG.md              # 版本变更记录
├── package.json              # 零依赖 ESM 包定义
├── bin/grow-loop.mjs         # CLI 入口
├── profiles/                 # standard-test 与 live-smoke
├── src/
│   ├── adapters/             # self / codex / claude / dsh / custom-cmd
│   ├── state.mjs             # 原子持久化与事件流水账
│   ├── router.mjs            # 状态流转、修复预算和审查路由
│   ├── gate.mjs              # 人工门禁
│   ├── handoff.mjs           # 交接清单导入
│   ├── task-builder.mjs      # 任务书生成
│   ├── ref-scan.mjs          # 联改引用搜索
│   ├── probe.mjs             # 本机执行器探活
│   ├── verify.mjs            # 本机验证与日志
│   ├── review-report.mjs     # Markdown 审查报告解析
│   ├── git-watch.mjs         # 外部提交与文件范围检查
│   ├── lessons.mjs           # 教训与技术债
│   ├── shell-api.mjs         # 壳状态和人工回填
│   ├── evidence.mjs          # 交付证据包
│   └── redact.mjs            # 脱敏和残留扫描
├── docs/
│   ├── UPSTREAM-BRIDGE.md    # 清单、上游转换与验证配置
│   ├── ADAPTER-SPEC.md       # 执行器、派发记录与审查格式
│   └── SHELL-API.md          # 壳状态与回填契约
└── test/grow-loop.test.mjs   # Node 原生单元与端到端测试
```

## 致谢

感谢 [LINUX DO](https://linux.do) 社区对开源项目的支持与技术交流氛围，欢迎前往社区分享使用经验与改进建议。

## License

MIT. See [LICENSE](LICENSE).

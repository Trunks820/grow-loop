# 壳接口

`grow-loop status --format shell` 输出一个 JSON 对象。`grow-loop status` 继续输出原有格式。读取状态和提交回答时，请沿用同一组 `--repo`、`--state-dir` 参数或工作区环境设置。

## 状态 `grow-loop.status/1`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schema` | 字符串 | 固定为 `grow-loop.status/1`。 |
| `loop_status` | 字符串 | 流程状态，取 `IDLE`（空工作区）、`RUNNING`、`COMPLETED` 或 `ABORTED`。 |
| `active_pack_id` | 字符串或 `null` | 当前选中的包号。 |
| `now` | 对象 | 当前停点、接下来由谁处理，以及下一条命令。 |
| `packs` | 数组 | 已确认清单中的包，按已确认的顺序排列。 |
| `pending` | 对象 | 清单待确认的改动和待处理事项计数。 |
| `question` | 对象或 `null` | 当前等待人工处理的问题。见下文。 |

### `now`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `pack_id` | 字符串或 `null` | 停点所在的包。未选中包时，使用清单中第一个未提交的包。 |
| `phase` | 字符串 | 当前阶段。开工前为 `PENDING`，后续为 `IMPLEMENT`、`VERIFY`、`REVIEW`、`COMMIT`。人工停点为 `MANIFEST_CHANGED`、`NEEDS_FILL`、`BLOCKED_DEPENDENCY` 或 `PAUSE_FOR_HUMAN`。空、完成、终止时分别为 `IDLE`、`COMPLETED`、`ABORTED`。 |
| `waiting_for` | 字符串 | 取下表中的一个值。 |
| `reason` | 字符串或 `null` | 人工停点使用 `question.kind`。外部执行器运行中为 `DISPATCH_RUNNING`，等待协调者登记 `self` 的结果为 `SELF_RUN_PENDING`，普通阶段和结束时为 `null`。 |
| `next_command` | 字符串或 `null` | 建议的下一条 CLI 命令。`<…>` 表示需要填入参数，`[…]` 表示可选参数。等待外部执行器或流程已结束时为 `null`。 |

| `waiting_for` | 含义 |
| --- | --- |
| `human` | 请处理 `question`。有选项时回填答案，缺字段或前置包未完成时按问题正文操作。 |
| `executor` | 外部派发进程仍在运行。 |
| `coordinator` | 协调者推进流程，例如派发、验证、登记自执行结果或登记本地提交。 |
| `none` | 流程已完成或终止。 |

清单待确认时优先显示 `MANIFEST_CHANGED`。状态读取展示当前已登记的停点。运行 `next` 会执行开工检查，提交阶段还会检查 Git，因此下一条命令可能发现新的门禁。

`next_command` 沿用 `next` 的建议。实现阶段先建议 `dispatch --dry-run`，已有预演后建议正式 `dispatch`。等待 `self` 时，实施成功后可运行 `record implement --passed`，自审完成后运行 `record review --report <report.md>`。`record commit --from-git` 在完成本地提交后登记。`NEEDS_FILL` 时先改清单，再运行建议的 `manifest-ack`。

### `packs[]`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id`、`title` | 字符串 | 包号和标题。 |
| `status` | 字符串 | 已登记的状态，取 `PENDING`、`IMPLEMENT`、`VERIFY`、`REVIEW`、`READY_TO_COMMIT`、`PAUSED_FOR_HUMAN`、`COMMITTED`。 |
| `tier` | 字符串或 `null` | 当前档位 `tier1` 或 `tier2`。 |
| `instance` | 字符串或 `null` | 当前实施执行实例。 |
| `tier1_repairs`、`tier2_repairs` | 整数 | 两档分别已用了几次修复机会。 |
| `review_rounds` | 整数 | 已登记的审查轮次。 |
| `needs` | 字符串数组 | 当前 `manifest.json` 里尚未补齐的交接字段，可含 `scope_files`、`risk`、`tags`。齐全时为 `[]`。 |
| `inflight_run` | 对象或 `null` | 已登记且尚未清掉的派发，`stage` 是 `implement` 或 `review`，`started_at` 是 ISO 8601 时间。旧记录缺少 `stage` 或 `started_at` 时，对应字段为 `null`。当前是否在等待外部执行器由 `now.waiting_for` 表示。 |
| `commit` | 字符串或 `null` | 登记时保存的提交号，保留完整值。 |
| `gate` | 字符串或 `null` | 已登记的门禁原因。 |

### `pending`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `manifest_change` | 对象或 `null` | 待确认的清单差异，含 `changes` 和原有的 `ack_command`。 |
| `lesson_drafts` | 整数 | 待确认的教训草稿数。 |
| `open_todos` | 整数 | 仍为 `open` 的待办数。 |
| `in_round_tech_debt` | 整数 | 工作区仍标为“本轮一起修”的技术债数。 |

`manifest_change.changes` 含新增、移除的包号数组 `added_packs`、`removed_packs`，顺序变化标记 `order_changed`，以及 `changed_packs` 和 `manifest_fields`。顺序改变时带包号数组 `old_order` 和 `new_order`。`changed_packs` 的每项含 `id` 和 `fields`。`fields` 与 `manifest_fields` 的每项含字段名 `field`、变动前后的值 `old_value` 和 `new_value`。某侧原本没有该字段时，其值为 `null`，并附 `old_missing: true` 或 `new_missing: true`。值沿用清单差异的脱敏规则。

## 中文问题

命令返回人工停点时会附上 `question`。清单待确认仍以退出码 `1` 返回 `error: "manifest_changed"`，同时附 `question`。交接包因人工停点无法派发或登记结果时，命令保留退出码 `1` 和标准错误提示，并在标准输出返回 `ok: false` 和 `question`。`next`、`dispatch`、`verify`、`record` 等命令的原有字段继续可用。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | 字符串 | 不透明的停点标识。同一工作区同一停点反复读取时保持稳定。 |
| `kind` | 字符串 | 下表中的停点类型。 |
| `title`、`body` | 字符串 | 中文标题和正文。正文可能含换行，以及原清单里的问题或 Git 文件名等原始内容。 |
| `options` | 数组 | 可提交的选项。每项含字符串 `id`、中文字符串 `label`、布尔值 `needs_text` 和中文字符串或 `null` 的 `text_hint`。 |
| `answer_command` | 字符串或 `null` | 回填命令模板，自带本问题 `id`。需要在清单中处理时为 `null`。 |

### 各停点的选项

门禁选项按本次门禁的 `allowed_resume_actions` 生成。除表中标出“必填”的选项外，`--text` 可省略。

| `kind` | 选项和回填效果 |
| --- | --- |
| `AMBIGUITY` | 正文列出需回答的问题。`approve` 按回答开工（必填），`abort` 终止流程。 |
| `EXTERNAL_EFFECT` | 正文列出有外部影响的操作。`approve` 授权列出的操作并继续，`abort` 终止。 |
| `BLAST_RADIUS_SPLIT` | `approve` 允许整包按高档执行，`abort` 终止，以便重新拆包。 |
| `BUDGET_EXCEEDED` | `repair` 给当前档一次额外修复机会，`commit` 允许进入本地提交阶段，`abort` 终止。 |
| `REVIEW_CAP_REACHED` | `repair` 给当前档一次额外修复机会，`commit` 允许进入本地提交阶段，`abort` 终止。 |
| `INFRA_BLOCKED` | `retry` 用当前实例重试，`switch_instance:<标识>` 选择一个已配置的其他实例并重新执行，`abort` 终止。每个实例各有一个选项。 |
| `EXTERNAL_COMMIT` | 正文列出外部提交及其文件、冲突文件。`approve` 以当前 Git HEAD 为基线并回到原阶段（必填），`abort` 终止。 |
| `RELEASE` | `approve` 记录批准并回到执行阶段，`abort` 终止。 |
| `MANIFEST_CHANGED` | `confirm` 确认这份清单改动并登记原因（必填）。 |
| `NEEDS_FILL` | `options` 为空。按正文补齐工作区的 `manifest.json`，确认改动后再运行 `next`。 |
| `BLOCKED_DEPENDENCY` | `options` 为空。按正文处理未提交的前置包，再运行 `next`。 |

## 回填

```sh
grow-loop answer --question <问题ID> --option <选项ID> --text "回答原话"
```

选项要求文字时，传入非空文字。壳可用参数数组传入 `--text=<原话>`，包括前后空格、换行或以 `--` 开头的文字。问题已处理、停点已换或选项无效时，命令退出码为 `1`，错误说明写入标准错误。停点变化时请重新读取 `status --format shell` 及其中的 `question`。

门禁的有效选项沿用 `resume`，把填写的文字交给 `--decision`。理由随 `gate_resumed.decision` 入账，继续执行时沿用 `resolved_gates` 或 `decisions`，写入任务书的“已经定了的”。确认清单沿用 `manifest-ack --reason`，在 `manifest_changed.details.answer_text` 保留回填原话，并在仍有当前包时写入该包的决定。现有脱敏规则照常生效。成功后的 JSON 使用对应命令的返回格式，壳可再次取状态继续。

## 版本规则

同一版本允许新增字段，壳应忽略未知字段。删除字段、改字段类型或含义、改变固定取值集合都会升级 `schema`。`question` 嵌入状态时沿用状态版本，其他命令内附带的问题使用同一结构。用 ID 选择问题和选项，显示文字可随表述改进。

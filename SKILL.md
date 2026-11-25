---
name: grow-loop
description: Harness-agnostic multi-package delivery loop with deterministic state machine, 2+2+2 repair/escalation/review brakes, live CLI probing, cross-pack lesson injection, and redacted evidence packs. Trigger when executing multi-pack feature delivery, running a controlled implement-verify-review-commit loop, or handing off delivery state across AI coding harnesses (Codex, Antigravity, Claude Code, DeepSeek Harness, Cursor).
---

# grow-loop — Harness-Agnostic Multi-Package Delivery Loop

You are the coordinator. The zero-dependency CLI owns state, limits, gates, lessons, and evidence, kept in `<repo>/.loop/` or `--state-dir`. Act on what `grow-loop next` returns. The rules behind it are in [Loop Rules](docs/LOOP-RULES.md).

## Locate the CLI

Run `node "<this-skill-dir>/bin/grow-loop.mjs" <command> [flags]`, or `grow-loop` after `npm link` (Node.js 18+, no npm packages). Pass the same `--repo` and `--state-dir` every time.

## Mandatory Security & Governance Red Lines

### 1. Approval Envelope (Never Cross Without Explicit Human Gate)

Inside the loop you may read code, edit files in the current repo or worktree, run local builds and tests, dispatch configured executors, and make **local** commits (`git add <explicit files> && git commit`). Ask the human first before:

- `git push`, PR creation, tag push, or merging or rebasing into shared branches
- Deployment, migrations against production or shared environments, or external API side effects
- Editing global or home configs (`~/.codex/`, `~/.claude/`, `~/.dsh/`, shell profiles)
- Installing unapproved system packages or changing host security or sandbox settings

### 2. Five Zero-Custody Auth Red Lines

- **Zero credential custody.** Never read, copy, proxy, or cache OAuth tokens, cookies, API keys, or CLI credential stores. The user signs in to every executor CLI.
- **No silent account rotation.** Never rotate accounts or proxy subscription pools behind the user's back. Quota, auth, and timeout failures pause for the human by default.
- **Read-only probing, no secret echo.** `grow-loop probe` runs bounded local checks, never paid model calls. Logs, events, and evidence are redacted.
- **No blind auto-approve.** Reviewers run read-only. Implementers get only the workspace write access they need.
- **Non-invasive runtime.** Never change external CLI configs or silently install tools globally.

## Human Gates

When `next` returns `PAUSE_FOR_HUMAN`, the decision belongs to the human.

1. Run `grow-loop status --format shell`, show the `question` body and options, and wait.
2. Submit the human's choice with `grow-loop answer --question <id> --option <id> --text "<the human's exact words>"`. `grow-loop resume --action <action> --decision "<the human's exact words>"` also works.
3. Never answer on your own judgment or put your own summary in `--text` or `--decision`. An executor's reply is input, not an answer.
4. If the human gave a standing authorization for this kind of gate, you may answer it. Quote the authorization verbatim and say it is a standing authorization.

A question without options asks you to fill the manifest or resolve a dependency, then run `next`. [Question contract](docs/SHELL-API.md#中文问题)

## Coordinator Execution Protocol (Mode A)

Keep production runs, paid replays, and deployment outside the loop. When such a package is done outside, run `grow-loop record external --pack <ID> --note "<what was completed outside the loop>"`.

### Step 0 — Prepare the workspace

```sh
grow-loop init --manifest delivery.json --profile standard-test   # or --handoff task.manifest.json
grow-loop import --handoff followup.json --reason "Append the approved follow-up packages"
```

In the state directory's `config.json`, map `routing.tier1`, `routing.tier2`, and `routing.reviewer` to [executors](docs/ADAPTER-SPEC.md#1-executor-instances), with a reviewer model different from the implementer's. Set the [verification commands](docs/UPSTREAM-BRIDGE.md#verification-settings). If `verification.baseline` is configured, run `grow-loop verify --record-baseline` before the first package. Run `grow-loop probe`.

### Step 1 — Read the code and complete the package brief

Read the code the package touches and fill these fields so the executor can act without reconstructing the plan.

| Task brief | Manifest field | What to write |
| --- | --- | --- |
| 避坑提示 | `pitfalls` | A specific trap and how to avoid it. Name the file, function, or existing implementation that enforces the rule. |
| 要一起改的文件 | `co_change_files` | Files that need to change together. Keep the authorized paths in `scope_files`. |
| 要保住的旧行为 | `preserve_behaviors` | Existing behavior the implementer and both review rounds must check. |

Copy approved decisions verbatim into `decisions` (grow-me handoffs carry them). `NEEDS_FILL` blocks an imported package until `scope_files`, `risk`, and `tags` are filled. Acknowledge your own edits with `grow-loop manifest-ack --reason "<what you filled>"`. A change to a package's goal, scope, or acceptance needs the human's approval first. Record their words as the reason. [Manifest fields](docs/UPSTREAM-BRIDGE.md#fill-the-required-fields)

### Step 2 — Read the next action and dispatch implementation

Run `grow-loop next` at each transition. Stop when it returns `ABORTED`, and generate evidence on `COMPLETED`.

```sh
grow-loop dispatch --stage implement --dry-run
grow-loop dispatch --stage implement
```

Check the dry-run brief before dispatching. After an interruption, check `grow-loop status` and dispatch again with `--resume`. With `self`, do the work and run `grow-loop record implement` with `--passed --summary "<summary>"`, `--failed --summary "<reason>"`, `--blocked "<reason>"`, or `--infra-error <code>`.

Gates after implementation:

- **`EXECUTOR_BLOCKED`.** Show the executor's reason. If the human resolves the blocker, choose `continue`. When that means editing files outside the scope, first run `grow-loop pack scope --id <ID> --add <file> --reason "<the human's words>"`. `retry` starts over, and `approve` is for finished code.
- **`OUT_OF_SCOPE_CHANGE`.** Show the files. `expand` adds them to the scope, `revert` follows undoing them, and `ignore` means they came from outside this package.
- **`INFRA_BLOCKED`.** Fix the environment, such as an executable moved by an app update, or switch executors.

### Step 3 — Run verification before review

Run `grow-loop verify` and read the logs before any repair. For an environment failure, run `grow-loop verify --mark-env "<reason>"` before the repair dispatch. Use `grow-loop record verify --failed --summary "<reason>"` for failures outside the commands. Use `grow-loop record verify --passed --allow-self-report` only when the human accepted a manual check.

### Step 4 — Close the package with read-only review

Run `grow-loop dispatch --stage review`. With `self`, write the report to the path in the task and run `grow-loop record review --report <report.md>`. Fix a rejected report and resubmit. On a pass, re-report unresolved in-round items under their original titles. [Report format](docs/ADAPTER-SPEC.md#closing-review-reports)

### Step 5 — Confirm and scope lesson drafts

`next` and `status` list drafts. After checking the evidence, confirm each with `grow-loop lesson confirm --id <ID> --rule "<what to do next time>" --scope global` (or `--scope tags --tags <tags>`), or drop it with `grow-loop lesson disable --id <ID> --reason "<why>"`. [Examples](docs/LOOP-RULES.md#5-lessons)

### Step 6 — Apply approved changes during the loop

After the human approves, use `grow-loop pack insert`, `grow-loop pack tier`, or `grow-loop pack scope`. Send a finding to a later package with `grow-loop forward`, and track out-of-scope work with `grow-loop todo add`. [Examples](README.md#中途改动)

### Step 7 — Check external commits before local closure

If an outside commit touches this package's files or a completed package's files, the package pauses at `EXTERNAL_COMMIT`. Show the commits and overlapping files and follow [Human Gates](#human-gates).

### Step 8 — Commit locally and generate evidence

At `COMMIT`, inspect `stray_files` and the diff, and move reports or drafts to the artifact directory in the brief. Stage the package files explicitly, commit, and run `grow-loop record commit --from-git`. If it rejects out-of-scope files, remove them from the commit and record again, or ask the human to expand the scope.

At `COMPLETED`, run `grow-loop evidence` and check that `scanHits` is empty before sharing `evidence.md`.

---
name: grow-loop
description: Harness-agnostic multi-package delivery loop with deterministic state machine, 2+2+2 repair/escalation/review brakes, live CLI probing, cross-pack lesson injection, and redacted evidence packs. Trigger when executing multi-pack feature delivery, running a controlled implement-verify-review-commit loop, or handing off delivery state across AI coding harnesses (Codex, Antigravity, Claude Code, DeepSeek Harness, Cursor).
---

# grow-loop — Harness-Agnostic Multi-Package Delivery Loop

**Core principle:** Whichever AI agent harness runs this skill IS the coordinator. All deterministic governance — state transitions, `2 + 2 + 2` repair/escalation/review limits, infra-failure immunity, approval gates, lesson injection, and redacted evidence generation — lives outside the LLM in the zero-dependency Node.js CLI (`bin/grow-loop.mjs`) and `.loop/` state directory.

> **Lossless Cross-Harness Handoff:** Because state defaults to `<repo>/.loop/` (auto-added to `.gitignore`, or overridden via `--state-dir` / `GROW_LOOP_STATE_DIR`), you can run W01–W03 in Codex and seamlessly pick up W04–W06 in Antigravity, Claude Code, or Cursor with zero context loss.

---

## Locate the CLI

Resolve `GROW_LOOP_BIN` relative to this skill directory:
- `<this-skill-dir>/bin/grow-loop.mjs`
- Run with: `node "<this-skill-dir>/bin/grow-loop.mjs" <command> [flags]`
- Or if linked globally (`npm link`): `grow-loop <command> [flags]`

Requires **Node.js >= 18** and **zero** third-party npm packages.

---

## Mandatory Security & Governance Red Lines

### 1. Approval Envelope (Never Cross Without Explicit Human Gate)
Inside the autonomous loop, you may read code, edit files inside the current repo/worktree, run local builds/tests/verification scripts, dispatch configured CLI executors, and create **local** git commits (`git add <explicit files> && git commit`).

You **MUST STOP** and ask the human before any of these actions:
- `git push`, PR creation, tag push, or branch merge/rebase into shared branches
- Deployment, migration against production/shared environments, or external API side effects
- Editing global/home configs (`~/.codex/`, `~/.claude/`, `~/.dsh/`, shell profiles)
- Installing unapproved system packages or modifying host security/sandbox settings

### 2. Five Zero-Custody Auth Red Lines
- **Zero Credential Custody:** Never read, copy, proxy, or cache OAuth tokens, cookies, API keys, or CLI credential stores (`~/.codex/auth.json`, `~/.claude/`, etc.). Every executor CLI must already be authenticated by the user locally (BYO CLI).
- **No Silent Account Rotation:** Never rotate accounts or proxy subscription pools behind the user's back. Infra failures (`429` / auth / timeout) pause for the human by default.
- **Read-Only Probing & Zero Secret Echo:** `grow-loop probe` only invokes local read-only CLI checks with bounded timeouts — never paid LLM calls. All logs/events/evidence are passed through `src/redact.mjs`.
- **No Blind Auto-Approve:** Reviewers ALWAYS run read-only; implementers run with minimum required workspace write scope.
- **Non-Invasive Runtime:** Never mutate external CLI configs or silently `npm install -g` tools.

---

## Coordinator Execution Protocol (Mode A)

Run each command in the target repo, or pass the same workspace options throughout. The examples use the linked CLI. Substitute the Node invocation under [Locate the CLI](#locate-the-cli) when running from a checkout.

Keep production runs, paid replays, and deployment outside this local code delivery loop.

### Step 0 — Prepare the workspace

Initialize with the loop's own JSON manifest or an upstream JSON handoff. To append packages to an existing workspace, use the import command and record why.

```sh
grow-loop init --manifest delivery.json --profile standard-test
grow-loop init --handoff task.manifest.json --profile standard-test
grow-loop import --handoff followup.json --reason "Append the approved follow-up packages"
```

Choose one initialization command. The [upstream bridge](docs/UPSTREAM-BRIDGE.md) covers HTML plan conversion, accepted inputs, existing workspace replacement, and workspace paths. Choose the profile described in the [quick start](README.md#快速开始).

In the state directory's `config.json`, map `routing.tier1`, `routing.tier2`, and `routing.reviewer` to configured executor instances. Choose a reviewer model different from the implementer's model and keep review read-only. The profile supplies a starting configuration. Set the actual [verification commands and environment](docs/UPSTREAM-BRIDGE.md#verification-settings) before dispatch. Run `grow-loop probe` to check local CLI readiness before using external executors. [Executor configuration](docs/ADAPTER-SPEC.md#1-executor-instances)

### Step 1 — Read the code and complete the package brief

Read the code affected by the current package and fill these three manifest fields. Write them so the next executor can act on them without reconstructing the plan.

| Task brief | Manifest field | What to write |
| --- | --- | --- |
| 避坑提示 | `pitfalls` | A specific trap and how to avoid it. Name the file, function, or existing implementation that enforces the rule. |
| 要一起改的文件 | `co_change_files` | Files that need to change together. Keep the authorized paths in `scope_files`. |
| 要保住的旧行为 | `preserve_behaviors` | Existing behavior the implementer and both review rounds must check. |

A grow-me handoff already carries the confirmed interview answers each package relies on in `decisions`. Copy any other approved decisions verbatim into `decisions` with their original question and time when known. The task brief carries them under “已经定了的”. Apply those decisions if a suggestion conflicts with them. Check “可能要一起改的文件” before approving any scope expansion. These are reference search results with the matching term. Save reports, screenshots, and drafts in the artifact directory printed in the brief.

For an imported package, `NEEDS_FILL` blocks dispatch until `scope_files`, `risk`, and `tags` are complete. After editing `manifest.json`, check the pending diff with `grow-loop status` and run `grow-loop manifest-ack --reason "Complete the package scope, risk, and brief"`. The CLI records the reason and applies the confirmed manifest. Warnings about the three brief sections are advisory. [Manifest fields and acknowledgment](docs/UPSTREAM-BRIDGE.md#fill-the-required-fields)

### Step 2 — Read the next action and dispatch implementation

Run `grow-loop next` at each transition. Follow the returned action and package. `IMPLEMENT`, `VERIFY`, `REVIEW`, and `COMMIT` each have a step below. On `COMPLETED`, generate evidence.

At `PAUSE_FOR_HUMAN` or a pending manifest change, use `grow-loop status --format shell` to read the current `question`. Present the options and wait for the human's decision. Submit the chosen option with `grow-loop answer --question <id> --option <id> --text "<verbatim answer>"`, including text when requested. If the question has no options, follow its instructions to complete the manifest or resolve the dependency, then run `grow-loop next`. The existing `grow-loop resume --action <action> --decision "<verbatim decision>"` also accepts gate decisions. [Question and answer contract](docs/SHELL-API.md#中文问题)

```sh
grow-loop dispatch --stage implement --dry-run
grow-loop dispatch --stage implement
```

Inspect the dry-run task for scope, warnings, confirmed lessons, and the test policy. Live dispatch for the same stage and instance reuses the dry-run directory and refreshes a stale generated task in place. External dispatch records the outcome. If interrupted, check `grow-loop status` and run `grow-loop dispatch --stage implement --resume` for the same stage and instance. For a resumed review, use the review stage. [Run records and session selection](docs/ADAPTER-SPEC.md#dispatch-state-and-resume)

For `self`, live dispatch starts the execution record. Perform the work within the task brief and record the result with `grow-loop record implement --passed --summary "<summary>"`, or use `grow-loop record implement --failed --summary "<reason>"` for an implementation failure. For infrastructure failures use `grow-loop record implement --infra-error <code>`.

The CLI applies the configured brakes. By default a package estimated at 25 files or more, marked cross-module, or rated high risk starts at tier 2 unless an explicit tier applies. At 50 files or more, the split gate requires a human decision. Each tier allows two repair rounds. After tier 1 runs out the CLI escalates, and after tier 2 runs out it pauses. Infrastructure failures such as quota, authentication, timeout, and CLI crash preserve repair budgets.

### Step 3 — Run verification before review

Run `grow-loop verify` at `VERIFY`. The CLI runs the global checks and then the package checks. Either list can supply the runnable commands. It records exit codes and logs, and stops each attempt at the first failure.

With the default retry, the CLI runs the whole sequence again after a failure. If the second attempt passes, it records a passing `flaky` result without charging a repair or generating a lesson. Read the logs before dispatching a repair. If the failure was environmental, run `grow-loop verify --mark-env "<reason>"` before repair dispatch. This reverses that failure's repair charge, routing change, and lesson, then reruns the checks. If verification still fails, correct the environment and run verification again from `VERIFY`. [Verification settings](docs/UPSTREAM-BRIDGE.md#verification-settings)

Use `grow-loop record verify --failed --summary "<reason>"` for a failure found outside the verification commands. With checks configured, a manually recorded pass requires `grow-loop record verify --passed --allow-self-report` and appears as `自报` in evidence. Use that override only when the human has explicitly accepted a manual check.

### Step 4 — Close the package with read-only review

Run `grow-loop dispatch --stage review`. The first round reviews the full package diff against its acceptance criteria, the original decisions, and the behaviors to preserve. The default second round checks prior blocking findings, items marked “本轮一起修”, and any new blocking regressions introduced by the repair.

The CLI reads a returned external Markdown report automatically. For `self` or an adapter that returns no report path, save the Markdown report specified in the task and submit it with `grow-loop record review --report <report.md>`. If the CLI rejects the report, correct the indicated issue and submit it again. An invalid report leaves the package in `REVIEW` without consuming a round. [Review report format](docs/ADAPTER-SPEC.md#closing-review-reports)

By default, `BLOCKER` and `HIGH` findings block closure. Other findings go in `tech-debt.md`. After a failed review they appear in the repair brief as items to fix in the round. On a passing review, re-report unresolved items under their original titles to retain them as pending debt. Omitted in-round items are marked fixed. If a human approves a commit at the review cap, remaining in-round items become pending debt.

At the default two-round cap, tier 1 escalates once for final repair and verification, then pauses for the human's commit decision. A package already at tier 2 pauses immediately. The default flow opens no third review round.

### Step 5 — Confirm and scope lesson drafts

Implementation failures, verification failures, and blocking review findings can create drafts. `next` and `status` show the pending IDs while the loop continues. After checking the evidence, write the action an executor should take next time and confirm where the rule applies.

```sh
grow-loop lesson list --status draft
grow-loop lesson confirm --id L001 --rule "Check test data before changing the query" --scope global
grow-loop lesson confirm --id L002 --rule "Initialize the exam fixture first" --scope tags --tags exam
grow-loop lesson disable --id L001 --reason "The verification script now checks the fixture"
```

Use `--root-cause` to add or revise the cause. With `--scope tags`, omitting `--tags` uses the lesson's feature tags. At least one tag is required. `grow-loop record lesson --summary "<summary>"` creates a draft, and providing both `--rule` and `--scope` records it as confirmed. Each task brief includes up to eight confirmed lessons, prioritizing the package's own rules, then matching tags, then global rules. Each group is newest first. Disabled lessons remain available in the store with the reason.

### Step 6 — Apply approved changes during the loop

Use `grow-loop pack insert` to insert work, `grow-loop pack tier` to change routing, and `grow-loop pack scope` to expand the authorized files. Use `grow-loop forward` to send a finding to a later package. Record and manage out-of-scope work with `grow-loop todo add`, `grow-loop todo list`, and `grow-loop todo dismiss`. If the package goal or acceptance changes, edit the manifest and acknowledge the diff as in Step 1. [Mid-loop command examples](README.md#中途改动)

### Step 7 — Check external commits before local closure

The CLI captures the Git branch and HEAD at package start. Verification, review dispatch, the `COMMIT` directive, and commit recording check commits since that baseline. The check excludes recorded package commits and the commit being recorded. If a commit touches the current package's scope or co-change files, or paths committed by a completed package, the CLI raises `EXTERNAL_COMMIT` with the overlap. Unrelated commits are advisory and logged once. If Git or HEAD is unavailable, the command reports that it skipped the check.

Present the overlap to the human using the gate procedure in Step 2. Approval records the decision, sets the baseline to the current HEAD, and restores the interrupted stage. Abort ends the loop.

### Step 8 — Commit locally and generate evidence

When `next` returns `COMMIT`, inspect `stray_files` and the Git diff. Move any misplaced reports or drafts to the artifact directory in the task brief. Stage the explicit package files, commit locally, and run `grow-loop record commit --from-git`. The command also warns about out-of-scope artifacts already in that commit.

Repeat `grow-loop next` until `COMPLETED`, then run `grow-loop evidence`. Check that `scanHits` is empty before sharing the redacted `evidence.md` in the state directory. The evidence includes elapsed execution time and the final implementer's tool and model for each recorded package.

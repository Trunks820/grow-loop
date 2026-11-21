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

Follow this exact deterministic loop for every work package (`W01`, `W02`, ...):

### Step 0: Initialize (Once per project/worktree)
1. For a new workspace, prepare a JSON manifest from the upstream task list, PRD, or issues. Follow the format in `docs/UPSTREAM-BRIDGE.md`.
2. Pick the profile and import the manifest during initialization.
   - **`standard-test`** (regular repo with unit/integration tests):
     ```bash
     node <GROW_LOOP_BIN> init --repo <repo> --profile standard-test --manifest <file>
     ```
   - **`live-smoke`** (legacy/DB-heavy repo where new unit tests are forbidden and real-env smoke scripts verify behavior):
     ```bash
     node <GROW_LOOP_BIN> init --repo <repo> --profile live-smoke --manifest <file>
     ```
   - Use `--state-dir <path>` only if the user wants state stored outside the repo (e.g., an Obsidian vault). Default `<repo>/.loop/` is preferred and automatically added to `<repo>/.gitignore`.
3. Adjust `.loop/config.json` for the executor instances and verification commands. Use CLI commands to update loop state.
4. Run live capability discovery before dispatching external executors:
   ```bash
   node <GROW_LOOP_BIN> probe --repo <repo>
   ```
   Remember: `probe` verifies local CLI readiness (`cli_ready`), NOT server-side quota.

### Step 1: Ask the State Machine What to Do Next

Use the commands in [中途改动](README.md#中途改动) to insert a pack, change its tier, expand its scope, forward findings, or manage out-of-scope todos. Edit the manifest and run `manifest-ack` when changing a goal or acceptance criteria.

After a manual edit to `manifest.json`, `status` shows the pending diff and commands such as `next` pause. Review the diff and run `grow-loop manifest-ack --reason "<one sentence>"` with the same workspace options. The CLI records the reason in `events.jsonl` and updates `manifest.snapshot.json` in the state directory. `init --force --manifest <file>` explicitly replaces the whole manifest and resets workspace configuration and state, even when edits are pending.

```bash
node <GROW_LOOP_BIN> next --repo <repo>
```
**Obey the returned JSON `action` strictly:**

| Returned `action` | What Coordinator Must Do |
|---|---|
| `PAUSE_FOR_HUMAN` | **STOP the loop immediately.** Present `gate.reason`, `gate.summary`, `gate.questions` (if any), and the exact `resume_hint` options to the user. Wait for human input, then call `grow-loop resume --decision "..." --action <...>`. |
| `IMPLEMENT` | Execute implementation on the assigned `tier` & `instance` (see Step 2). |
| `VERIFY` | Run `grow-loop verify`. The CLI runs global `verification.commands` followed by the pack's `verify_commands` and records the outcome from exit codes. **Verify ALWAYS runs before Review.** |
| `REVIEW` | Run a **read-only closing review**. External dispatch records the returned Markdown report automatically. For self-review, submit the Markdown with `grow-loop record review --report <report.md>`. |
| `COMMIT` | Stage explicit changed files (`git status`, no untracked junk/secrets), make a **local** commit only (never push!), then call `grow-loop record commit --from-git`. |
| `COMPLETED` | All packs are committed! Run `grow-loop evidence` to generate the redacted two-layer evidence pack and report to the user. |

### Step 2: Executing `IMPLEMENT` (External Adapter vs `self`)
- Before dispatch, the coordinator reads the relevant code and fills in the pack's `pitfalls`, `co_change_files`, and `preserve_behaviors`. Name the file or function for each pitfall. When following an existing rule, name the function that implements it. Copy the plan's `decisions` with the original question, wording, and time if known. Check `warnings` from `next` and `dispatch --dry-run`.
- Check the files listed under “可能要一起改的文件” and confirm any changes to the authorized scope. Save reports, screenshots, and drafts in the generated task brief's artifact directory. For artifacts physically outside the working tree, use an external `--state-dir`.
- **If `instance` uses an external CLI adapter (`codex`, `claude`, `dsh`, `custom-cmd`):**
  1. First run dry-run preflight:
     ```bash
     node <GROW_LOOP_BIN> dispatch --repo <repo> --stage implement --dry-run
     ```
  2. Inspect the generated `task.md` inside `run_dir` (verify scope, injected lessons, and `new_tests_policy`), then dispatch:
     ```bash
     node <GROW_LOOP_BIN> dispatch --repo <repo> --stage implement
     ```
  3. `dispatch` automatically records the outcome (including infra-failure immunity if `429`/auth/timeout occurs) and returns the next transition.
- **If `instance` is `self` (the current host harness executes directly):**
  1. Optionally run `dispatch --dry-run` to materialize `task.md` with auto-injected lessons and pending blocking findings.
  2. Implement the bounded changes directly in the repo, respecting `new_tests_policy` (`forbidden` means zero new test files!).
  3. Record completion:
     ```bash
     node <GROW_LOOP_BIN> record implement --repo <repo> --passed --summary "<concise summary>"
     ```
     (Or `--failed --summary "..."` if implementation hit a code blocker, or `--infra-error INFRA_QUOTA` if hit a rate limit.)

### Step 3: Executing `VERIFY` (Verify-First Rule)
- Run local checks through the CLI. Each attempt stops at the first failure and saves per-command logs under the pack's `runs/` directory.
  ```bash
  node <GROW_LOOP_BIN> verify --repo <repo>
  ```
  On failure the CLI reruns the whole sequence once by default. If the second attempt passes, the CLI records `flaky`, keeps both runs, and advances without using repair budget or recording a lesson. If both attempts fail, the CLI records a lesson draft and applies the `2 + 2` repair/escalation ladder.
- Read the failure logs before dispatching a repair. If the failure is environmental, run `grow-loop verify --mark-env "<reason>"` before dispatch. The CLI records the reason, undoes the repair charge and lesson, and reruns verification. If the rerun still fails, resolve the environment problem while the pack waits in `VERIFY`.
- While commands are configured, `record verify --passed` is refused. Use `record verify --failed --summary "..." --root-cause "..." --rule "..." --locator "<file:symbol>"` only for failures found outside those commands. `--allow-self-report` records an unchecked pass and is labelled `自报` in the evidence pack; use it only when the human explicitly accepts a manual check.

### Step 4: Executing `REVIEW` (2-Round Cap + Severity Floor)
- Perform **closing full review** over the full pack diff (do NOT waste turns on repeated incremental reviews mid-pack unless a huge risk emerges).
- Reviewer MUST be **read-only** (`--stage review` enforces read-only flags on adapters).
- Check each existing behavior listed in the task brief and report regressions at the applicable severity. Round 2 applies this checklist within its closure scope. The “已经定了的” section carries the original decisions for both rounds.
- Classify each finding as `BLOCKER`, `HIGH`, `MEDIUM`, or `LOW`. The blocking severities are set by `review.blocking_severities` (default `BLOCKER` and `HIGH`) and shown in `next` and the review task. A blocking finding creates a lesson draft, with any supplied `rule` prefilled.
- Findings outside the blocking severities are recorded in `.loop/tech-debt.md`. After a failed review, the repair task includes them under `顺手一起修（不阻断）`.
- For a non-divergent Round 2, check the listed prior findings and new regressions introduced by the repair that meet the configured blocking severities. Re-report unresolved non-blocking items under their original titles. On passage, those items become pending and the omitted items are marked fixed. If the package is committed after human approval at the review cap, all remaining in-round items become pending.
- External dispatch reads the returned Markdown report automatically. For self-review, run `dispatch --stage review --dry-run` to get the task, then save a Markdown report matching its Required Output Format and submit it:
  ```bash
  node <GROW_LOOP_BIN> record review --repo <repo> --report <report.md>
  ```
- If the CLI reports an invalid report, correct the indicated location and submit the report again. The package stays in `REVIEW` and the round does not advance.

### Confirm and Scope Lessons

Implementation failures, verification failures, and blocking review findings create `draft` lessons. Use the IDs and summaries in `next` and `status` to review them while the loop continues.

```bash
node <GROW_LOOP_BIN> lesson list --status draft
node <GROW_LOOP_BIN> lesson confirm --id L001 --rule "Write the next action" --scope global
node <GROW_LOOP_BIN> lesson confirm --id L002 --rule "Write the next action" --scope tags --tags exam
node <GROW_LOOP_BIN> lesson disable --id L001 --reason "Explain why the rule is retired"
```

Use `--root-cause` to add or update the cause on confirmation. For `--scope tags`, omit `--tags` to use the lesson's feature tags. At least one tag is required. A manual `record lesson` with both `--rule` and `--scope` creates a `confirmed` lesson. Otherwise it creates a draft. A disabled lesson remains in the store with `status: disabled` and a reason.

Task briefs include up to eight confirmed rules. The package's own rules come first, followed by rules whose `scope_tags` overlap the package's `tags`, then global rules. Each group is ordered newest first. `lessons.md` shows status, scope, feature tags, and `repair_rounds`. A package commit updates the repair count and records the closure in `fixed_by` and `closed_at`. Old `OPEN` and `CLOSED` entries remain readable. An old entry with a rule is treated as confirmed and scoped to its tags, or globally if it has none. An old entry without a rule is treated as a draft.

### Step 5: Built-In `2 + 2 + 2` Brakes (Enforced Automatically by CLI)
- **Blast-Radius Gate:** `estimated_files >= 25` or `cross_module: true` or `risk: "high"` → auto-starts at `tier2`; `estimated_files >= 50` → pauses with `BLAST_RADIUS_SPLIT`.
- **Repair Ladder (`2 + 2`):**
  - `tier1` gets up to `2` repair rounds (`tier1_max_repairs: 2`).
  - Failing a 3rd time auto-escalates to `tier2` (`tier2_repairs = 1`).
  - `tier2` gets up to `2` repair rounds (`tier2_max_repairs: 2`).
  - Failing again triggers `PAUSED_FOR_HUMAN` (`BUDGET_EXCEEDED`).
- **Closing Review Cap (`2`):** Max `2` closing reviews (`max_review_rounds: 2`). Hitting `2/2` on `tier1` auto-escalates once to `tier2` (after `VERIFY`, pauses for human commit sign-off without opening a 3rd review); hitting `2/2` on `tier2` pauses immediately (`REVIEW_CAP_REACHED`).
- **Infra Failure Immunity:** `INFRA_QUOTA` (`429`), `INFRA_AUTH`, `INFRA_TIMEOUT`, and `INFRA_CLI_CRASH` **NEVER** consume `tier1` or `tier2` repair budgets.

### Step 6: Commit & Generate Evidence Pack
1. When `next` returns `COMMIT`, review `git status` and `git diff --stat`, stage explicit files, commit locally (no `git push`), and record:
   ```bash
   node <GROW_LOOP_BIN> record commit --repo <repo> --from-git
   ```
2. Repeat `grow-loop next` until `action === "COMPLETED"`.
3. Generate the final redacted two-layer evidence pack:
   ```bash
   node <GROW_LOOP_BIN> evidence --repo <repo>
   ```
   Verify `scanHits` is empty (`[]`) before sharing `.loop/evidence.md`.

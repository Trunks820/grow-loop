# Loop Rules

The CLI enforces these rules itself. A coordinator follows the actions `grow-loop next` returns and does not need this page to run the loop. Read it to explain why the loop routed, paused, or charged a package the way it did. For the coordinator's steps, see the [coordinator protocol](../SKILL.md#coordinator-execution-protocol-mode-a). For question and option formats, see the [shell API](SHELL-API.md).

## 1. Package start

When `next` starts a package, the CLI records the Git branch, `HEAD`, and a snapshot of files that were already changed or untracked in the worktree. Later out-of-scope checks compare against this snapshot, so leftovers from earlier work are not charged to the package.

The starting tier comes from the manifest and the `blast_radius` settings:

- An explicit `tier` in the manifest takes priority.
- Otherwise a package estimated at 25 files or more, marked `cross_module`, or rated `high` risk starts at `tier2`.
- At 50 files or more, the `BLAST_RADIUS_SPLIT` gate asks the human to split the package or approve running it on `tier2`.
- Open questions pause at `AMBIGUITY` and declared external effects pause at `EXTERNAL_EFFECT` before implementation.

## 2. Repairs and escalation

Each tier allows two repair rounds by default (`budgets.tier1_max_repairs`, `budgets.tier2_max_repairs`). When `tier1` runs out, the CLI escalates to `tier2`. When `tier2` runs out, it pauses at `BUDGET_EXCEEDED`.

Infrastructure failures never charge a repair round or create a lesson. They include quota, authentication, timeout, CLI crash, and an executable that cannot be found. With `routing.on_infra_failure` set to `pause_for_human`, the package pauses at `INFRA_BLOCKED`.

When an executor ends its reply with a `## 没做完` section, the CLI pauses at `EXECUTOR_BLOCKED` without charging a repair. Choosing `continue` returns the package to implementation without a repair charge, whether the human expanded the scope or resolved another blocker. Unless `--resume` is given, the next implementation dispatch reuses the active executor's saved session. Without one, it starts a new session and adds a warning. The task brief opens with the blocker, the human's words, and the files added to the scope since the pause.

## 3. Verification

`grow-loop verify` runs the global `verification.commands`, then the package's `verify_commands`, then the optional full-suite `verification.baseline` command. Each attempt stops at the first failing command. Exit codes and logs are saved under the package's run directory.

- **Retry.** With `verification.retry_once` (default `true`), a failed attempt reruns the whole sequence once. A pass on the second attempt is recorded as `flaky`, with no repair charge and no lesson.
- **Environment failures.** `grow-loop verify --mark-env "<reason>"` is accepted before the repair dispatch. It reverses that failure's repair charge, routing change, and lesson, then reruns the checks.
- **Baseline.** The full-suite command is checked against `baseline.json`, recorded by `grow-loop verify --record-baseline`. Only failures outside that list fail verification. A timeout, or a nonzero exit with no recognized test names, also fails. Tests that now pass are reported under `baseline.fixed` and removed from the baseline when the package's commit is recorded, so the list only shrinks. [Baseline settings](UPSTREAM-BRIDGE.md#verification-settings)
- **Self-reported results.** With commands configured, `record verify --passed` requires `--allow-self-report` and appears as `自报` in evidence.

## 4. Closing review

Review runs read-only.

- **Round 1** reviews the full package diff against the acceptance criteria, the recorded decisions, and the behaviors to preserve.
- **Round 2** (default) checks only the prior blocking findings, the items marked “本轮一起修”, and new blocking regressions introduced by the repair.
- `BLOCKER` and `HIGH` findings block closure by default (`review.blocking_severities`). Other findings go to `tech-debt.md`. After a failed review they appear in the repair brief as items to fix in the round. On a passing review, items re-reported under their original titles stay as pending debt and omitted in-round items are marked fixed.
- At the two-round cap, a `tier1` package escalates once for a final repair and verification, then pauses at `REVIEW_CAP_REACHED` for the commit decision. A `tier2` package pauses immediately. No third review round opens by default. If the human approves the commit, remaining in-round items become pending debt.
- The CLI reads the report an external reviewer returns. A report that fails validation leaves the package in `REVIEW` without using a round. [Report format](ADAPTER-SPEC.md#closing-review-reports)

## 5. Lessons

Implementation failures, verification failures, and blocking review findings create lesson drafts. A draft is not injected until it is confirmed with a rule and a scope (`global`, or `tags` with at least one tag). Each task brief includes up to eight confirmed lessons: the package's own first, then lessons whose tags match, then global lessons, newest first within each group. Disabled lessons stay in the store with their reason.

```sh
grow-loop lesson list --status draft
grow-loop lesson confirm --id L001 --rule "Check test data before changing the query" --scope global
grow-loop lesson confirm --id L002 --rule "Initialize the exam fixture first" --scope tags --tags exam --root-cause "The fixture was created after the query ran"
grow-loop lesson disable --id L001 --reason "The verification script now checks the fixture"
grow-loop record lesson --summary "Seed data missing in the staging fixture"
```

`grow-loop record lesson` creates a draft. Adding `--rule` and `--scope` records it as confirmed.

## 6. Git checks

**External commits.** Verification, review dispatch, the `COMMIT` directive, and commit recording look at commits made since the package started, excluding recorded package commits and the commit being recorded. A commit that touches the package's scope or co-change files (glob patterns included), or paths committed by a completed package, pauses at `EXTERNAL_COMMIT`. Unrelated commits are logged once as advisory. Approving sets the baseline to the current `HEAD` and restores the interrupted stage.

**Out-of-scope changes.** When implementation finishes, when `EXECUTOR_BLOCKED` is approved for verification, and when the package reaches `COMMIT`, the CLI looks for worktree changes outside `scope_files` and `co_change_files`. Changes already present in the start snapshot with the same content are ignored, and so are files under the state directory and files approved earlier for the package. Reports, drafts, and images are listed as `stray_files` with a notice only. Any other change pauses at `OUT_OF_SCOPE_CHANGE`:

- `expand` adds the files to `scope_files` and requires the human's words.
- `revert` rechecks the worktree and continues once the changes are gone.
- `ignore` records the files' current content in the start snapshot and requires the human's words. The files stay out of scope, so a later change reports them again and a commit that includes them is still rejected.

**Commit recording.** `record commit --from-git` rejects a commit that contains unapproved out-of-scope files and leaves the package unchanged. Out-of-scope artifacts in the commit produce a notice only.

## 7. Evidence

`grow-loop evidence` writes a redacted `evidence.md` in the state directory. The summary table shows each package's final implementer, commit, repair and review rounds, and status. Further sections trace lessons, closing reviews and tech debt, human gates, dispatches and infrastructure failures, verification results, and per-package rounds, elapsed time, and token use. Check that `scanHits` is empty before sharing it.

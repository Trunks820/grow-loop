# Upstream Bridge (`manifest.json` Contract)

Use a loop manifest for a hand-authored package list, or import a JSON handoff from grow-me. See the [quick start](../README.md#快速开始) for profile selection and the [coordinator protocol](../SKILL.md#coordinator-execution-protocol-mode-a) for package execution.

---

## 1. `manifest.json` Schema

```json
{
  "project": "my-service",
  "upstream_source": "grow-me / docs/spec/task-list.md",
  "packs": [
    {
      "id": "W01",
      "title": "Database schema & repository layer",
      "goal": "Add the new table and DAO methods without altering legacy endpoints.",
      "depends_on": [],
      "risk": "low",
      "estimated_files": 8,
      "cross_module": false,
      "scope_files": [
        "src/db/schema.sql",
        "src/repo/itemRepo.js"
      ],
      "acceptance_criteria": [
        "AC-W01-01: Migration applies cleanly on a fresh database",
        "AC-W01-02: Existing repository queries pass regression checks"
      ],
      "open_questions": [],
      "pitfalls": ["Use explicit column lists in `itemRepo.js` queries."],
      "co_change_files": ["src/repo/itemRepo.js"],
      "preserve_behaviors": ["Existing queries still return records in creation order."],
      "decisions": [
        { "question": "Can existing query callers change?", "decision": "Keep the current DAO signatures.", "at": null }
      ],
      "external_effects": [],
      "tags": ["db", "repo"]
    },
    {
      "id": "W02",
      "title": "Service API & frontend integration",
      "goal": "Wire the API endpoints and UI form.",
      "depends_on": ["W01"],
      "risk": "medium",
      "estimated_files": 28,
      "cross_module": true,
      "scope_files": [],
      "acceptance_criteria": [
        "AC-W02-01: POST /api/items validates payload and persists record",
        "AC-W02-02: UI form submits and renders saved items"
      ],
      "open_questions": [
        "Should the picker allow single-select only or multi-select?"
      ],
      "external_effects": [],
      "tags": ["api", "frontend"]
    }
  ]
}
```

### Field Reference

| Field | Required | Effect in `grow-loop` |
|---|---|---|
| `id` | Yes | Unique pack ID (e.g., `W01`, `W02`). Determines dependency graph and run directories. |
| `title` | Yes | Short human-readable title shown in `status`, `task.md`, and `evidence.md`. |
| `goal` | Yes | Bounded objective injected into `task.md`. |
| `depends_on` | No | Pack IDs that must be `COMMITTED` before this pack starts. |
| `risk` | For handoffs | `"low"` \| `"medium"` \| `"high"`. `"high"` auto-starts at `tier2`. |
| `estimated_files` | No | `>= 25` auto-starts at `tier2`; `>= 50` triggers `PAUSED_FOR_HUMAN` (`BLAST_RADIUS_SPLIT`). |
| `cross_module` | No | `true` auto-starts at `tier2` (configurable via `blast_radius.escalate_tier2_cross_module`). |
| `tier` | No | `"tier1"` or `"tier2"`. Takes priority over automatic tier selection at preflight. The split and approval gates still apply. Use `pack tier` for in-progress changes. |
| `scope_files` | For handoffs | File paths or glob patterns that define the package scope and appear in `task.md`. Also used as a lower bound for `estimated_files`. Dispatch warns about directory entries here or in `co_change_files`. |
| `pitfalls` | No | Array of string warnings that name specific code using backticks, file paths, or identifiers such as `itemRepo.findById` or `findById()`. |
| `co_change_files` | No | Array of repo-relative file paths or glob patterns for files that the coordinator expects to change together. Keep authorized files in `scope_files`. |
| `preserve_behaviors` | No | Array of strings describing existing behavior. Included in implementation, repair, and both review rounds. |
| `decisions` | No | Array of objects with `question`, verbatim `decision`, and an optional `at` timestamp (ISO 8601 or `null`). Task briefs include these alongside package questions and recorded gate decisions. `init`, `import`, `manifest-ack` and other manifest writes reject an entry without a non-empty `question` and `decision`. |
| `forwarded_findings` | No | Findings added by `forward`. Each entry has `from_pack_id`, `content`, `reason`, and `at` (ISO 8601 timestamp). They appear in initial and repair implementation prompts. |
| `acceptance_criteria` | No | Observable verification criteria injected into `task.md` and checked during `VERIFY`/`REVIEW`. |
| `verify_commands` | No | Array of local verification commands. Runs after global `verification.commands` and appears in implementation and repair briefs. Dispatch warns when a command names a test file that matches no path or glob in either scope list. Command arguments that are themselves patterns are skipped. |
| `open_questions` | No | Non-empty array triggers `PAUSED_FOR_HUMAN` (`AMBIGUITY`) before `IMPLEMENT`. |
| `external_effects` | No | Non-empty array (e.g., `["prod-db-migration", "webhook-notify"]`) triggers `PAUSED_FOR_HUMAN` (`EXTERNAL_EFFECT`) before `IMPLEMENT`. |
| `tags` | For handoffs | Used to match and prioritize relevant past lessons from `lessons.json` when generating `task.md`. |

In both scope lists, patterns follow Git's `:(glob)` pathspec rules. A single `*` matches zero or more bytes within a path component and `?` matches one. A full `**/` component matches zero or more directory levels, and a trailing `/**` matches all files under that directory. Bracket expressions support ranges such as `[a-z]` and negation such as `[!a]`. Braces are literal, so `{a,b}.js` names one file. [Git pathspec documentation](https://git-scm.com/docs/gitglossary#def_pathspec)

---

## 2. Bridging from `grow-me` / `ai-dev-workflow`

`--handoff` accepts two JSON inputs.

- The `task.manifest.json` saved by `grow-me`, with `project`, `upstream_source`, and `packs`.
- The `grow-me` validator output with `valid`, `errors`, `requirements`, `criteria`, `work_entries`, `revision`, `limits`, and `packs`. Import requires `valid: true` and an empty error list. The CLI lists reported errors when it rejects a handoff.

For an `ai-dev-workflow` HTML plan, use `grow-me` to produce the JSON before importing. `grow-loop` reads JSON handoffs only.

```bash
echo [] | node <grow-me>/scripts/validate-task.mjs --handoff <页面.html> > handoff.json
```

For a new workspace, use one of the following initialization commands. The handoff command also accepts the converted `handoff.json` above. If both input flags are omitted on first initialization, the CLI creates an empty manifest.

```sh
grow-loop init --manifest delivery.json
grow-loop init --handoff task.manifest.json
```

In an existing workspace, `grow-loop import --handoff handoff.json --reason "Append the reviewed plan"` appends packages and records why. Package IDs must be new to that workspace. To replace the entire manifest and reset workspace configuration and state, use `grow-loop init --force --manifest <file>` or `grow-loop init --force --handoff <file>`. Replacement also works when there is a pending manifest diff. An explicit input to ordinary initialization is rejected when a workspace manifest already exists.

Run commands from the target repository or keep using the same `--repo` and `--state-dir` settings. See the [workspace defaults](../README.md#快速开始).

### Conversion

- The new manifest copies `project` and `upstream_source` when supplied. Validator output without those fields uses the filename stem for `project` and the filename with `revision` for `upstream_source`. On append, the workspace keeps its top-level metadata and each new package records its own source.
- Packages keep their exported order. Each keeps `id`, `title`, `goal`, `depends_on`, `acceptance_criteria`, `open_questions`, and `external_effects`. Supplied `decisions` keep their question and verbatim text; a missing `at` becomes `null`. Dependencies must refer to another package in the handoff or to an existing workspace package when appending.
- The import keeps supplied `scope_files` and `tags`; absent values become empty arrays. Fill in `risk` in the workspace. Set `estimated_files` or `cross_module` there when needed for routing.
- `upstream_ref` records the source and package ID. `handoff.needs` records the required fields missing at import.

### Fill the required fields

1. Check the import output or run `grow-loop status` to see which packages need `scope_files`, `risk`, or `tags`.
2. Set `scope_files` and `tags` to non-empty lists and `risk` to `low`, `medium`, or `high`. After editing `manifest.json`, run `grow-loop manifest-ack --reason "<reason>"` in the same workspace. To add scope files through the CLI, use `grow-loop pack scope --id <ID> --add <file> --reason "<reason>"`.
3. Run `grow-loop next`. `NEEDS_FILL` keeps the package pending and lists the remaining fields. Once the fields are complete, `next` clears `handoff.needs` and runs the regular preflight. Open questions trigger `AMBIGUITY`, and external effects trigger `EXTERNAL_EFFECT` before implementation.

After a manual edit, use `grow-loop status` to review the diff before `manifest-ack`. Acknowledgment records the diff and reason as `manifest_changed` in `events.jsonl`, updates `manifest.snapshot.json`, and syncs the pack order and active pack. Committed and removed pack records are retained.

See [how to fill the package brief](../SKILL.md#step-1--read-the-code-and-complete-the-package-brief) for the three code-reading fields and verbatim decisions.

The snapshot is created during initialization. A workspace from an older version takes its current manifest as the baseline on the first command. The comparison uses parsed JSON and reports changes to pack membership, the relative order of retained packs, and field values. Use the CLI to update loop state.

### Verification settings

Put shared checks in the state directory's `config.json` under `verification.commands`. Put package-specific checks in the pack's `verify_commands` array in `manifest.json`. The CLI runs global commands first and package commands second. At least one runnable command must be present across the two lists. The results label commands `global` or `pack`.

| Setting in `config.json` | Default | Effect |
|---|---|---|
| `verification.env` | `{}` | Environment overrides for verification subprocesses. Windows supplies `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` unless overridden. |
| `verification.path_prepend` | `[]` | Directories prepended to the subprocess `PATH` in list order. |
| `verification.output_encoding` | `utf-8` | Decodes command output using a `TextDecoder` encoding such as `gbk`. Log files are saved as UTF-8. |
| `verification.retry_once` | `true` | Reruns the sequence from the beginning after the first failed attempt. Each attempt stops at the first failing command and writes its own logs. |

Blank lines and entries that begin with `#` are skipped. See the [verification flow](../SKILL.md#step-3--run-verification-before-review) for retry outcomes and how to handle an environment failure.

---

## 3. Bridging from Plain Markdown / GitHub Issues

1. Convert the issue list or PRD into a JSON manifest such as `delivery.json` using the schema above.
2. Run `grow-loop init --manifest delivery.json --profile standard-test` (or select `live-smoke`).
3. Continue with [workspace configuration and preflight](../SKILL.md#coordinator-execution-protocol-mode-a).

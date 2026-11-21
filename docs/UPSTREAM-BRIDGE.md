# Upstream Bridge (`manifest.json` Contract)

`grow-loop` accepts work packages from planning tools, PRDs, issue trackers, and hand-written JSON. Prepare a manifest in the format below and import it with `grow-loop init --manifest <file>`. You can also convert a task list from [grow-me](https://github.com/Trunks820/grow-me) or `ai-dev-workflow`.

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
| `risk` | No | `"low"` \| `"medium"` \| `"high"`. `"high"` auto-starts at `tier2`. |
| `estimated_files` | No | `>= 25` auto-starts at `tier2`; `>= 50` triggers `PAUSED_FOR_HUMAN` (`BLAST_RADIUS_SPLIT`). |
| `cross_module` | No | `true` auto-starts at `tier2` (configurable via `blast_radius.escalate_tier2_cross_module`). |
| `scope_files` | No | Explicit file allowlist / expected touchpoints injected into `task.md`. Also used as lower bound for `estimated_files`. |
| `acceptance_criteria` | No | Observable verification criteria injected into `task.md` and checked during `VERIFY`/`REVIEW`. |
| `open_questions` | No | Non-empty array triggers `PAUSED_FOR_HUMAN` (`AMBIGUITY`) before `IMPLEMENT`. |
| `external_effects` | No | Non-empty array (e.g., `["prod-db-migration", "webhook-notify"]`) triggers `PAUSED_FOR_HUMAN` (`EXTERNAL_EFFECT`) before `IMPLEMENT`. |
| `tags` | No | Used to match and prioritize relevant past lessons from `lessons.json` when generating `task.md`. |

---

## 2. Bridging from `grow-me` / `ai-dev-workflow`

When your upstream workflow produces a requirement spec, task breakdown (`开发清单` / `tasks.md`), and acceptance test cases (`测试用例`):

1. **Map each work package / phase** (`W01`, `W02`, ...) to an entry in `manifest.json -> packs[]`.
2. **Copy `depends_on` and file scope** directly from the development checklist into `depends_on`, `scope_files`, and `estimated_files`.
3. **Copy observable test case IDs** (e.g., `TC-001` / `AC-W01-01`) into `acceptance_criteria`.
4. **Keep unresolved decisions in `open_questions`** instead of letting the coding agent guess — `grow-loop` will automatically pause at `AMBIGUITY` right before that pack begins.
5. After manually editing the workspace's `manifest.json`, review the diff with `grow-loop status` and run `grow-loop manifest-ack --reason "<one sentence>"`. Commands such as `next` pause until the edit is acknowledged. The CLI records the diff and reason as `manifest_changed` in `events.jsonl`, updates `manifest.snapshot.json` in the state directory, and syncs the pack order and active pack. Committed and removed pack records are retained. To replace the entire manifest and reset workspace configuration and state, use `grow-loop init --force --manifest <file>`.

The snapshot is created during initialization. A workspace from an older version takes its current manifest as the baseline on the first command. The comparison uses parsed JSON and reports changes to pack membership, the relative order of retained packs, and field values. Use the CLI to update loop state.

---

## 3. Bridging from Plain Markdown / GitHub Issues

1. Convert the issue list or PRD into a JSON manifest such as `delivery.json` using the schema above.
2. Run `grow-loop init --manifest delivery.json --profile standard-test` (or select `live-smoke`).
3. Run `grow-loop probe` and `grow-loop next`.

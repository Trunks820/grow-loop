# Executor Adapter Specification (`grow-loop` v0.1)

`grow-loop` separates **delivery governance** (state machine, budgets, gates, lessons, evidence) from **model execution**. Any local AI coding CLI can participate as a `tier1`, `tier2`, or `reviewer` instance by implementing a thin driver under `src/adapters/`.

---

## 1. Instance-Level Registry (Not Vendor-Level)

In `.loop/config.json`, `executors` maps **instance IDs** rather than vendor names. The same CLI binary can appear multiple times with different models, reasoning effort, sandboxes, or accounts:

```json
{
  "executors": {
    "self": { "kind": "self", "label": "Host Agent Harness" },
    "dsh-fast": {
      "kind": "dsh",
      "executable": "dsh",
      "profile": "headless",
      "timeout_sec": 3600
    },
    "codex-high": {
      "kind": "codex",
      "executable": "codex",
      "model": "gpt-5.4",
      "reasoning_effort": "high",
      "timeout_sec": 3600
    },
    "claude-review": {
      "kind": "claude",
      "executable": "claude",
      "model": "sonnet",
      "timeout_sec": 1800
    },
    "custom-local": {
      "kind": "custom-cmd",
      "executable": "my-agent-cli",
      "probe_args": ["--version"],
      "args": ["run", "--repo", "{{repo}}", "--prompt-file", "{{task_file}}"],
      "read_only_args": ["--read-only"],
      "resume_args": ["--resume", "{{session_id}}"]
    }
  }
}
```

---

## 2. Five Zero-Custody Auth Red Lines

Every built-in and community adapter **MUST** comply with these 5 red lines:

1. **Zero Credential Custody (BYO Local CLI Only)**
   - Never read, copy, import, proxy, or cache OAuth tokens, browser cookies, API keys, or CLI credential stores (`~/.codex/auth.json`, `~/.claude/`, `~/.dsh/`, keychains).
   - Users authenticate each CLI directly with its own official login flow.
2. **No Silent Account Rotation / Subscription Pool Proxying**
   - Never silently switch accounts, cycle API keys, or reverse-proxy subscription logins when quota runs out.
   - Quota exhaustion (`INFRA_QUOTA`) defaults to `on_infra_failure: "pause_for_human"`. Switching to a `fallback_instance` requires explicit user configuration (`on_infra_failure: "fallback"`).
3. **Read-Only Probing & Zero Secret Echo**
   - `probe()` MUST ONLY run local read-only commands (e.g., `--version`, `login status`) with a strict bounded timeout (default `8000ms`).
   - `probe()` MUST NEVER make paid LLM inference calls.
   - All captured stdout/stderr/metadata MUST pass through `src/redact.mjs` before touching disk or stdout.
4. **No Blind Auto-Approve (Least Privilege & Approval Envelope)**
   - When `readOnly === true` (e.g., `stage === "review"`), the driver MUST enforce the CLI's read-only/plan sandbox (`--sandbox read-only`, `--permission-mode plan`, etc.).
   - Implementers run inside workspace-scoped write sandboxes — never global/unrestricted auto-approve for external side effects (`git push`, deploy, prod DB writes).
5. **Non-Invasive Runtime**
   - Never mutate user global CLI config directories (`~/.codex/`, `~/.claude/`, `~/.dsh/`).
   - Never silently install packages or binaries at runtime.

---

## 3. Thin Driver Interface

Each driver exports an object with 5 members:

```js
export const myAdapter = {
  kind: 'my-cli',

  /**
   * Read-only capability discovery with bounded timeout.
   * Must NEVER spend LLM tokens or read credential files.
   */
  async probe(instanceId, cfg = {}, opts = {}) {
    return {
      instance_id: instanceId,
      kind: 'my-cli',
      available: true,
      cli_version: '1.2.3',
      auth_status: 'verified_by_cli', // 'verified_by_cli' | 'configured_unverified' | 'missing'
      account_hint: cfg.label || 'my-cli',
      capabilities: {
        read_only: true,
        resume: true,
        jsonl: true,
        sandbox: 'my-sandbox'
      },
      latency_ms: 42,
      error: null
    };
  },

  /**
   * Generate a dry-run receipt without mutating repo or calling LLM APIs.
   */
  async dryRun({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    return writeDryRunReceipt(runDir, {
      instance_id: instanceId,
      kind: 'my-cli',
      stage,
      read_only: Boolean(readOnly),
      executable: cfg.executable || 'my-cli',
      args: ['...'],
      task_file: taskFilePath
    }, redactor);
  },

  /**
   * Execute the CLI with stdout/stderr streamed to runDir/stdout.log & stderr.log.
   * Writes redacted runDir/result.json and returns normalized result.
   */
  async run({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, timeoutSec, redactor }) {
    return writeRunResult(runDir, {
      instance_id: instanceId,
      kind: 'my-cli',
      stage,
      read_only: Boolean(readOnly),
      status: 'completed', // 'completed' | 'failed' | 'infra_error' | 'host_action_required'
      exit_code: 0,
      elapsed_seconds: 12.3,
      session_id: 'optional-native-session-id',
      usage: { input_tokens: 0, output_tokens: 0 },
      infra_error: null   // null | 'INFRA_QUOTA' | 'INFRA_AUTH' | 'INFRA_TIMEOUT' | 'INFRA_CLI_CRASH'
    }, redactor);
  }
};
```

---

## 4. Infrastructure Error Normalization

Drivers delegate classification to `classifyInfraError(exitCode, stdoutTail, stderrTail, timedOut)` in `src/adapters/base.mjs`:

| `infra_error` | Trigger Signals | Consumes Repair Budget? |
|---|---|---|
| `INFRA_QUOTA` | HTTP `429`, `rate_limit`, `quota_exhausted`, `insufficient_quota`, `too many requests` | **NO** |
| `INFRA_AUTH` | HTTP `401`/`403`, `unauthenticated`, `not logged in`, `auth failed`, `invalid api key` | **NO** |
| `INFRA_TIMEOUT` | Process exceeded `timeout_sec` and was terminated | **NO** |
| `INFRA_CLI_CRASH` | `ENOENT`, `command not found`, Windows `0xC0000142` | **NO** |

Any normalized `infra_error` guarantees the pack's `tier1_repairs` and `tier2_repairs` counters stay untouched.

---

## 5. Built-In Adapters

| `kind` | Target CLI | Read-Only Review Mode | Session Resume |
|---|---|---|---|
| `self` | Current host harness (Codex / Antigravity / Claude / Cursor) | Coordinated by host | Host session |
| `codex` | OpenAI Codex CLI (`codex exec`) | `--sandbox read-only` | `resume <id>` |
| `claude` | Claude Code CLI (`claude -p`) | `--permission-mode plan` | `--resume <id>` |
| `dsh` | DeepSeek Harness (`dsh` or custom wrapper) | Prompt + wrapper enforced | `--resume <id>` |
| `custom-cmd` | Any custom CLI via `args` / `read_only_args` / `resume_args` | `read_only_args` | `{{session_id}}` |

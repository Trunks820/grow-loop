import fs from 'node:fs';
import path from 'node:path';
import {
  classifyInfraError,
  runAdapterProcess,
  runBoundedCommand,
  writeDryRunReceipt,
  writeRunResult
} from './base.mjs';

function resolveCodexCommand(cfg) {
  if (cfg.executable) return { cmd: cfg.executable, prefix: cfg.prefix_args || [] };
  return { cmd: 'codex', prefix: [] };
}

function parseCodexJsonl(stdoutPath) {
  if (!fs.existsSync(stdoutPath)) return { threadId: null, usage: null };
  let threadId = null;
  let usage = null;
  const lines = fs.readFileSync(stdoutPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.thread_id && !threadId) threadId = obj.thread_id;
      if (obj.usage && typeof obj.usage === 'object') usage = obj.usage;
    } catch {
      // ignore non-JSON lines
    }
  }
  return { threadId, usage };
}

/**
 * Thin driver for OpenAI Codex CLI (`codex exec`).
 * Zero-Custody: uses the user's already authenticated local Codex CLI;
 * never reads auth files or modifies ~/.codex/config.toml.
 */
export const codexAdapter = {
  kind: 'codex',

  async probe(instanceId, cfg = {}, opts = {}) {
    const { cmd, prefix } = resolveCodexCommand(cfg);
    const timeoutMs = opts.timeoutMs ?? 8000;
    const ver = await runBoundedCommand(cmd, [...prefix, '--version'], { timeoutMs });

    if (!ver.ok) {
      return {
        instance_id: instanceId,
        kind: 'codex',
        available: false,
        cli_version: null,
        auth_status: 'missing',
        account_hint: null,
        capabilities: { read_only: true, resume: true, jsonl: true, sandbox: 'codex-native' },
        latency_ms: ver.latencyMs,
        error: ver.timedOut ? 'probe_timeout' : (ver.stderr || 'codex_cli_not_found').trim().slice(0, 200)
      };
    }

    const versionStr = (ver.stdout || ver.stderr).trim().split(/\r?\n/)[0];
    // Non-invasive check: ask codex login status if supported, never echo tokens
    const login = await runBoundedCommand(cmd, [...prefix, 'login', 'status'], { timeoutMs });
    const loginOut = `${login.stdout}\n${login.stderr}`.trim();
    let authStatus = 'configured_unverified';
    let accountHint = cfg.label || cfg.model || 'codex-cli';
    if (login.ok && /logged in|authenticated|active/i.test(loginOut)) {
      authStatus = 'verified_by_cli';
    } else if (/not logged in|no credentials|unauthenticated/i.test(loginOut)) {
      authStatus = 'missing';
    }

    return {
      instance_id: instanceId,
      kind: 'codex',
      available: authStatus !== 'missing',
      cli_version: versionStr,
      auth_status: authStatus,
      account_hint: accountHint,
      capabilities: {
        read_only: true,
        resume: true,
        jsonl: true,
        sandbox: 'workspace-write|read-only'
      },
      latency_ms: ver.latencyMs + login.latencyMs,
      error: authStatus === 'missing' ? 'codex_not_logged_in' : null
    };
  },

  buildArgs(cfg, { repoDir, runDir, readOnly, resumeSessionId }) {
    const { cmd, prefix } = resolveCodexCommand(cfg);
    const finalMdPath = path.join(runDir, 'final.md');
    const args = [...prefix, 'exec'];
    if (resumeSessionId) {
      args.push('resume', resumeSessionId);
    }
    args.push('--json', '--cd', repoDir, '--output-last-message', finalMdPath);
    args.push('--sandbox', readOnly ? 'read-only' : (cfg.sandbox || 'workspace-write'));
    if (cfg.model) args.push('--model', cfg.model);
    if (cfg.reasoning_effort) {
      args.push('-c', `model_reasoning_effort="${cfg.reasoning_effort}"`);
    }
    if (Array.isArray(cfg.extra_args)) {
      args.push(...cfg.extra_args);
    }
    args.push('-'); // read prompt from stdin
    return { cmd, args, finalMdPath };
  },

  async dryRun({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    const { cmd, args } = this.buildArgs(cfg || {}, { repoDir, runDir, readOnly, resumeSessionId });
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'codex',
        stage,
        read_only: Boolean(readOnly),
        executable: cmd,
        args,
        task_file: taskFilePath
      },
      redactor
    );
  },

  async run({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, timeoutSec, redactor }) {
    const { cmd, args, finalMdPath } = this.buildArgs(cfg || {}, { repoDir, runDir, readOnly, resumeSessionId });
    const stdinText = fs.readFileSync(taskFilePath, 'utf8');
    const proc = await runAdapterProcess({
      command: cmd,
      args,
      cwd: repoDir,
      stdinText,
      runDir,
      timeoutSec: timeoutSec || cfg?.timeout_sec || 3600,
      redactor
    });

    const parsed = parseCodexJsonl(proc.stdoutPath);
    const infraError = classifyInfraError(proc.exitCode, proc.stdoutTail, proc.stderrTail, proc.timedOut);

    return writeRunResult(
      runDir,
      {
        instance_id: instanceId,
        kind: 'codex',
        stage,
        read_only: Boolean(readOnly),
        status: infraError ? 'infra_error' : (proc.exitCode === 0 ? 'completed' : 'failed'),
        exit_code: proc.exitCode,
        elapsed_seconds: proc.elapsedSeconds,
        session_id: parsed.threadId,
        usage: parsed.usage,
        final_md: fs.existsSync(finalMdPath) ? finalMdPath : null,
        infra_error: infraError
      },
      redactor
    );
  }
};

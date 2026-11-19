import fs from 'node:fs';
import {
  classifyInfraError,
  runAdapterProcess,
  runBoundedCommand,
  writeDryRunReceipt,
  writeRunResult
} from './base.mjs';

function resolveClaudeCommand(cfg) {
  if (cfg.executable) return { cmd: cfg.executable, prefix: cfg.prefix_args || [] };
  return { cmd: 'claude', prefix: [] };
}

function parseClaudeJson(stdoutPath) {
  if (!fs.existsSync(stdoutPath)) return { sessionId: null, usage: null };
  const raw = fs.readFileSync(stdoutPath, 'utf8').trim();
  let sessionId = null;
  let usage = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.session_id) sessionId = obj.session_id;
      if (obj.usage) usage = obj.usage;
    } catch {
      // ignore non-JSON
    }
  }
  return { sessionId, usage };
}

/**
 * Thin driver for Claude Code CLI (`claude -p`).
 * Zero-Custody: relies strictly on user's local authenticated Claude CLI.
 */
export const claudeAdapter = {
  kind: 'claude',

  async probe(instanceId, cfg = {}, opts = {}) {
    const { cmd, prefix } = resolveClaudeCommand(cfg);
    const timeoutMs = opts.timeoutMs ?? 8000;
    const ver = await runBoundedCommand(cmd, [...prefix, '--version'], { timeoutMs });

    if (!ver.ok) {
      return {
        instance_id: instanceId,
        kind: 'claude',
        available: false,
        cli_version: null,
        auth_status: 'missing',
        account_hint: null,
        capabilities: { read_only: true, resume: true, jsonl: true, sandbox: 'permission-mode' },
        latency_ms: ver.latencyMs,
        error: ver.timedOut ? 'probe_timeout' : (ver.stderr || 'claude_cli_not_found').trim().slice(0, 200)
      };
    }

    return {
      instance_id: instanceId,
      kind: 'claude',
      available: true,
      cli_version: (ver.stdout || ver.stderr).trim().split(/\r?\n/)[0],
      auth_status: 'configured_unverified',
      account_hint: cfg.label || cfg.model || 'claude-cli',
      capabilities: {
        read_only: true,
        resume: true,
        jsonl: true,
        sandbox: 'plan|acceptEdits'
      },
      latency_ms: ver.latencyMs,
      error: null
    };
  },

  buildArgs(cfg, { readOnly, resumeSessionId }) {
    const { cmd, prefix } = resolveClaudeCommand(cfg);
    const args = [...prefix, '-p', '--output-format', 'stream-json'];
    if (readOnly) {
      args.push('--permission-mode', 'plan');
    } else if (cfg.permission_mode) {
      args.push('--permission-mode', cfg.permission_mode);
    }
    if (cfg.model) args.push('--model', cfg.model);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args);
    return { cmd, args };
  },

  async dryRun({ instanceId, cfg, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    const { cmd, args } = this.buildArgs(cfg || {}, { readOnly, resumeSessionId });
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'claude',
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
    const { cmd, args } = this.buildArgs(cfg || {}, { readOnly, resumeSessionId });
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

    const parsed = parseClaudeJson(proc.stdoutPath);
    const infraError = classifyInfraError(proc.exitCode, proc.stdoutTail, proc.stderrTail, proc.timedOut);

    return writeRunResult(
      runDir,
      {
        instance_id: instanceId,
        kind: 'claude',
        stage,
        read_only: Boolean(readOnly),
        status: infraError ? 'infra_error' : (proc.exitCode === 0 ? 'completed' : 'failed'),
        exit_code: proc.exitCode,
        elapsed_seconds: proc.elapsedSeconds,
        session_id: parsed.sessionId,
        usage: parsed.usage,
        infra_error: infraError
      },
      redactor
    );
  }
};

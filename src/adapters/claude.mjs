import fs from 'node:fs';
import {
  classifyInfraError,
  probeExecutable,
  resolveExecutorCommand,
  runAdapterProcess,
  versionFromProbe,
  writeDryRunReceipt,
  writeFinalMarkdown,
  writeMissingExecutableResult,
  writeRunResult
} from './base.mjs';

function resolveClaudeCommand(cfg, cwd) {
  const prefix = cfg.executable ? cfg.prefix_args || [] : [];
  return { ...resolveExecutorCommand(cfg.executable, 'claude', cwd), prefix, probeArgs: [...prefix, '--version'] };
}

function parseClaudeJson(stdoutPath) {
  if (!fs.existsSync(stdoutPath)) return { sessionId: null, usage: null, finalText: null };
  const raw = fs.readFileSync(stdoutPath, 'utf8').trim();
  let sessionId = null;
  let usage = null;
  let finalText = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.session_id) sessionId = obj.session_id;
      if (obj.usage) usage = obj.usage;
      if (obj.type === 'result' && typeof obj.result === 'string') finalText = obj.result;
    } catch {
      // ignore non-JSON
    }
  }
  return { sessionId, usage, finalText };
}

/**
 * Thin driver for Claude Code CLI (`claude -p`).
 * Zero-Custody: relies strictly on user's local authenticated Claude CLI.
 */
export const claudeAdapter = {
  kind: 'claude',
  resolveCommand: resolveClaudeCommand,

  async probe(instanceId, cfg = {}, opts = {}) {
    const command = resolveClaudeCommand(cfg, opts.cwd);
    const ver = await probeExecutable(command, opts);

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
        error: command.error ?? (ver.timedOut ? 'probe_timeout' : (ver.stderr || 'claude_cli_not_found').trim().slice(0, 200))
      };
    }

    return {
      instance_id: instanceId,
      kind: 'claude',
      available: true,
      cli_version: versionFromProbe(ver),
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

  buildArgs(cfg, { readOnly, resumeSessionId }, { cmd, prefix } = resolveClaudeCommand(cfg)) {
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

  async dryRun({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    const command = resolveClaudeCommand(cfg || {}, repoDir);
    const { cmd, args } = this.buildArgs(cfg || {}, { readOnly, resumeSessionId }, command);
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'claude',
        stage,
        read_only: Boolean(readOnly),
        executable: cmd ?? command.configured,
        args,
        task_file: taskFilePath,
        ...(command.error && { warnings: [command.error] })
      },
      redactor
    );
  },

  async run({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, timeoutSec, redactor,
    resolvedCommand, executorVersion = null }) {
    const command = resolvedCommand ?? resolveClaudeCommand(cfg || {}, repoDir);
    const details = { instance_id: instanceId, kind: 'claude', stage, read_only: Boolean(readOnly) };
    if (command.error) return writeMissingExecutableResult(runDir, details, command.error, redactor);
    const { cmd, args } = this.buildArgs(cfg || {}, { readOnly, resumeSessionId }, command);
    const stdinText = fs.readFileSync(taskFilePath, 'utf8');
    const proc = await runAdapterProcess({
      command: cmd,
      exactExecutable: true,
      args,
      cwd: repoDir,
      stdinText,
      runDir,
      timeoutSec: timeoutSec || cfg?.timeout_sec || 3600,
      redactor
    });

    const parsed = parseClaudeJson(proc.stdoutPath);
    const infraError = classifyInfraError(proc.exitCode, proc.stdoutTail, proc.stderrTail, proc.timedOut);
    const finalMd = parsed.finalText === null ? null : writeFinalMarkdown(runDir, parsed.finalText, redactor);

    return writeRunResult(
      runDir,
      {
        ...details,
        executable_path: cmd,
        executor_version: executorVersion,
        status: infraError ? 'infra_error' : (proc.exitCode === 0 ? 'completed' : 'failed'),
        exit_code: proc.exitCode,
        elapsed_seconds: proc.elapsedSeconds,
        session_id: parsed.sessionId,
        usage: parsed.usage,
        final_md: finalMd,
        infra_error: infraError
      },
      redactor
    );
  }
};

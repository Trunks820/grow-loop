import fs from 'node:fs';
import {
  classifyInfraError,
  runAdapterProcess,
  runBoundedCommand,
  writeDryRunReceipt,
  writeRunResult
} from './base.mjs';

function resolveDshCommand(cfg) {
  if (cfg.executable) return { cmd: cfg.executable, prefix: cfg.prefix_args || [] };
  return { cmd: 'dsh', prefix: [] };
}

function parseDshJsonl(stdoutPath) {
  if (!fs.existsSync(stdoutPath)) return { sessionId: null, turns: 0, usage: null };
  let sessionId = null;
  let turns = 0;
  let sumIn = 0;
  let sumOut = 0;
  let sumCacheRead = 0;
  let lastTotal = 0;

  for (const line of fs.readFileSync(stdoutPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.sessionID && !sessionId) sessionId = obj.sessionID;
      if (obj.session_id && !sessionId) sessionId = obj.session_id;
      const u = (obj.message && obj.message.usage) || obj.usage;
      if (u && typeof u === 'object') {
        turns += 1;
        sumIn += Number(u.inputTokens ?? u.input ?? 0);
        sumOut += Number(u.outputTokens ?? u.output ?? 0);
        sumCacheRead += Number(u.cacheReadTokens ?? u.cacheRead ?? 0);
        if (Number(u.totalTokens || 0) > lastTotal) lastTotal = Number(u.totalTokens || 0);
      }
    } catch {
      // ignore non-JSON
    }
  }
  return {
    sessionId,
    turns,
    usage: turns > 0
      ? {
          turns,
          sum_input_tokens: sumIn,
          sum_output_tokens: sumOut,
          sum_cache_read_tokens: sumCacheRead,
          peak_turn_total_tokens: lastTotal
        }
      : null
  };
}

/**
 * Thin driver for DeepSeek Harness CLI (`dsh`) or an explicit wrapper script
 * (such as delegate-to-deepseek-harness's invoke_dsh.py when configured via executable + prefix_args).
 * Zero-Custody: never reads credential files or modifies ~/.dsh/ profiles.
 */
export const dshAdapter = {
  kind: 'dsh',

  async probe(instanceId, cfg = {}, opts = {}) {
    const { cmd, prefix } = resolveDshCommand(cfg);
    const timeoutMs = opts.timeoutMs ?? 8000;
    const probeArgs = cfg.probe_args || [...prefix, '--version'];
    const res = await runBoundedCommand(cmd, probeArgs, { timeoutMs });

    if (!res.ok) {
      return {
        instance_id: instanceId,
        kind: 'dsh',
        available: false,
        cli_version: null,
        auth_status: 'missing',
        account_hint: null,
        capabilities: { read_only: false, resume: true, jsonl: true, sandbox: 'dsh-profile' },
        latency_ms: res.latencyMs,
        error: res.timedOut ? 'probe_timeout' : (res.stderr || 'dsh_cli_not_found').trim().slice(0, 200)
      };
    }

    const combined = `${res.stdout}\n${res.stderr}`.trim();
    let authStatus = 'configured_unverified';
    if (/"ok"\s*:\s*true/i.test(combined) && !/missing_credential/i.test(combined)) {
      authStatus = 'configured_unverified';
    } else if (/missing_credential/i.test(combined)) {
      authStatus = 'missing';
    }

    return {
      instance_id: instanceId,
      kind: 'dsh',
      available: authStatus !== 'missing',
      cli_version: combined.split(/\r?\n/)[0].slice(0, 120),
      auth_status: authStatus,
      account_hint: cfg.label || cfg.profile || 'dsh-cli',
      capabilities: {
        read_only: false,
        resume: true,
        jsonl: true,
        sandbox: 'dsh-profile'
      },
      latency_ms: res.latencyMs,
      error: authStatus === 'missing' ? 'dsh_missing_credential' : null
    };
  },

  buildArgs(cfg, { repoDir, runDir, taskFilePath, resumeSessionId }) {
    const { cmd, prefix } = resolveDshCommand(cfg);
    // Optional wrapper mode (e.g., invoke_dsh.py) when cfg.wrapper_mode === 'invoke_dsh'
    if (cfg.wrapper_mode === 'invoke_dsh') {
      const args = [...prefix, '--repo', repoDir, '--task-file', taskFilePath, '--output-dir', runDir];
      if (cfg.use_desktop_config) args.push('--use-desktop-config');
      if (resumeSessionId) args.push('--resume', resumeSessionId);
      if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args);
      return { cmd, args, passStdin: false };
    }

    const args = [...prefix, '--profile', cfg.profile || 'headless'];
    if (resumeSessionId) args.push('--session-id', resumeSessionId);
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args);
    return { cmd, args, passStdin: true };
  },

  async dryRun({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    const { cmd, args } = this.buildArgs(cfg || {}, { repoDir, runDir, taskFilePath, resumeSessionId });
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'dsh',
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
    const { cmd, args, passStdin } = this.buildArgs(cfg || {}, { repoDir, runDir, taskFilePath, resumeSessionId });
    const stdinText = passStdin ? fs.readFileSync(taskFilePath, 'utf8') : undefined;
    const proc = await runAdapterProcess({
      command: cmd,
      args,
      cwd: repoDir,
      stdinText,
      runDir,
      timeoutSec: timeoutSec || cfg?.timeout_sec || 3600,
      redactor
    });

    const parsed = parseDshJsonl(proc.stdoutPath);
    const infraError = classifyInfraError(proc.exitCode, proc.stdoutTail, proc.stderrTail, proc.timedOut);

    return writeRunResult(
      runDir,
      {
        instance_id: instanceId,
        kind: 'dsh',
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

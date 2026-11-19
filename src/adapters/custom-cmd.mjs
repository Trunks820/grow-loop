import fs from 'node:fs';
import {
  classifyInfraError,
  runAdapterProcess,
  runBoundedCommand,
  writeDryRunReceipt,
  writeRunResult
} from './base.mjs';

function renderTemplateArgs(rawArgs, vars) {
  return (rawArgs || []).map((arg) =>
    String(arg)
      .replace(/\{\{repo\}\}/g, vars.repoDir)
      .replace(/\{\{task_file\}\}/g, vars.taskFilePath)
      .replace(/\{\{run_dir\}\}/g, vars.runDir)
      .replace(/\{\{session_id\}\}/g, vars.resumeSessionId || '')
  );
}

/**
 * Generic zero-code adapter for any local coding CLI (Aider, OpenCode, Gemini CLI, etc.).
 * Configure executable, args (supports {{repo}}, {{task_file}}, {{run_dir}}, {{session_id}}),
 * optional probe_args, and pass_stdin.
 */
export const customCmdAdapter = {
  kind: 'custom-cmd',

  async probe(instanceId, cfg = {}, opts = {}) {
    if (!cfg.executable) {
      return {
        instance_id: instanceId,
        kind: 'custom-cmd',
        available: false,
        cli_version: null,
        auth_status: 'missing',
        account_hint: null,
        capabilities: { read_only: Boolean(cfg.read_only_args), resume: Boolean(cfg.resume_args), jsonl: false, sandbox: 'custom' },
        latency_ms: 0,
        error: 'missing_executable_in_config'
      };
    }

    const timeoutMs = opts.timeoutMs ?? 8000;
    const res = await runBoundedCommand(cfg.executable, cfg.probe_args || ['--version'], {
      timeoutMs,
      shell: Boolean(cfg.shell)
    });

    return {
      instance_id: instanceId,
      kind: 'custom-cmd',
      available: res.ok,
      cli_version: res.ok ? (res.stdout || res.stderr).trim().split(/\r?\n/)[0].slice(0, 120) : null,
      auth_status: res.ok ? 'configured_unverified' : 'missing',
      account_hint: cfg.label || cfg.executable,
      capabilities: {
        read_only: Boolean(cfg.read_only_args),
        resume: Boolean(cfg.resume_args),
        jsonl: false,
        sandbox: 'custom'
      },
      latency_ms: res.latencyMs,
      error: res.ok ? null : (res.timedOut ? 'probe_timeout' : (res.stderr || 'probe_failed').trim().slice(0, 200))
    };
  },

  buildArgs(cfg, vars) {
    const baseArgs = renderTemplateArgs(cfg.args || [], vars);
    if (vars.readOnly && Array.isArray(cfg.read_only_args)) {
      baseArgs.push(...renderTemplateArgs(cfg.read_only_args, vars));
    }
    if (vars.resumeSessionId && Array.isArray(cfg.resume_args)) {
      baseArgs.push(...renderTemplateArgs(cfg.resume_args, vars));
    }
    return baseArgs;
  },

  async dryRun({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    const args = this.buildArgs(cfg || {}, { repoDir, runDir, taskFilePath, readOnly, resumeSessionId });
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'custom-cmd',
        stage,
        read_only: Boolean(readOnly),
        executable: cfg?.executable || '',
        args,
        task_file: taskFilePath
      },
      redactor
    );
  },

  async run({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, timeoutSec, redactor }) {
    const args = this.buildArgs(cfg || {}, { repoDir, runDir, taskFilePath, readOnly, resumeSessionId });
    const stdinText = cfg?.pass_stdin !== false ? fs.readFileSync(taskFilePath, 'utf8') : undefined;
    const proc = await runAdapterProcess({
      command: cfg.executable,
      args,
      cwd: repoDir,
      stdinText,
      runDir,
      timeoutSec: timeoutSec || cfg?.timeout_sec || 3600,
      shell: Boolean(cfg?.shell),
      redactor
    });

    const infraError = classifyInfraError(proc.exitCode, proc.stdoutTail, proc.stderrTail, proc.timedOut);

    return writeRunResult(
      runDir,
      {
        instance_id: instanceId,
        kind: 'custom-cmd',
        stage,
        read_only: Boolean(readOnly),
        status: infraError ? 'infra_error' : (proc.exitCode === 0 ? 'completed' : 'failed'),
        exit_code: proc.exitCode,
        elapsed_seconds: proc.elapsedSeconds,
        session_id: null,
        usage: null,
        infra_error: infraError
      },
      redactor
    );
  }
};

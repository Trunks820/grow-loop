import fs from 'node:fs';
import path from 'node:path';
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

function resolveCustomCommand(cfg, cwd) {
  return {
    ...resolveExecutorCommand(cfg.executable, null, cwd),
    probeArgs: cfg.probe_args || ['--version'],
    shell: Boolean(cfg.shell)
  };
}

function renderTemplateArgs(rawArgs, vars) {
  return (rawArgs || []).map((arg) =>
    String(arg).replace(/\{\{(repo|task_file|run_dir|session_id|model)\}\}/g, (_, key) => vars[key])
  );
}

function compileSessionPattern(source) {
  if (source === undefined) return null;
  if (typeof source !== 'string') throw new Error('session_id_pattern must be a regular expression string.');
  let pattern;
  try {
    pattern = new RegExp(source);
  } catch {
    throw new Error('session_id_pattern is not a valid regular expression.');
  }
  // The empty alternative always matches, so capture slots can be counted without CLI output.
  if (new RegExp(`(?:${pattern.source})|`).exec('').length !== 2) {
    throw new Error('session_id_pattern must contain exactly one capture group.');
  }
  return pattern;
}

function readFinalFile(finalFile, repoDir, runDir) {
  if (!finalFile) return null;
  const file = path.resolve(repoDir, finalFile.replace(/\{\{run_dir\}\}/g, () => runDir));
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

/**
 * Generic zero-code adapter for any local coding CLI (Aider, OpenCode, Gemini CLI, etc.).
 * Configure executable, args (supports {{repo}}, {{task_file}}, {{run_dir}}, {{session_id}}, {{model}}),
 * optional probe_args, and pass_stdin.
 */
export const customCmdAdapter = {
  kind: 'custom-cmd',
  resolveCommand: resolveCustomCommand,

  async probe(instanceId, cfg = {}, opts = {}) {
    const command = resolveCustomCommand(cfg, opts.cwd);
    const res = await probeExecutable(command, opts);

    return {
      instance_id: instanceId,
      kind: 'custom-cmd',
      available: res.ok,
      cli_version: versionFromProbe(res)?.slice(0, 120) ?? null,
      auth_status: res.ok ? 'configured_unverified' : 'missing',
      account_hint: command.error ? null : cfg.label || cfg.executable,
      capabilities: {
        read_only: Boolean(cfg.read_only_args),
        resume: Boolean(cfg.resume_args),
        jsonl: false,
        sandbox: 'custom'
      },
      latency_ms: res.latencyMs,
      error: command.error ?? (res.ok ? null : (res.timedOut ? 'probe_timeout' : (res.stderr || 'probe_failed').trim().slice(0, 200)))
    };
  },

  buildArgs(cfg, vars) {
    const templateVars = {
      repo: vars.repoDir,
      task_file: vars.taskFilePath,
      run_dir: vars.runDir,
      session_id: vars.resumeSessionId || '',
      model: cfg.model ?? ''
    };
    const baseArgs = renderTemplateArgs(cfg.args || [], templateVars);
    if (vars.readOnly && Array.isArray(cfg.read_only_args)) {
      baseArgs.push(...renderTemplateArgs(cfg.read_only_args, templateVars));
    }
    if (vars.resumeSessionId && Array.isArray(cfg.resume_args)) {
      baseArgs.push(...renderTemplateArgs(cfg.resume_args, templateVars));
    }
    return baseArgs;
  },

  async dryRun({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, redactor }) {
    const command = resolveCustomCommand(cfg || {}, repoDir);
    if (!command.error) compileSessionPattern(cfg?.session_id_pattern);
    const args = this.buildArgs(cfg || {}, { repoDir, runDir, taskFilePath, readOnly, resumeSessionId });
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'custom-cmd',
        stage,
        read_only: Boolean(readOnly),
        executable: command.cmd ?? command.configured ?? '',
        args,
        task_file: taskFilePath,
        ...(command.error && { warnings: [command.error] })
      },
      redactor
    );
  },

  async run({ instanceId, cfg, repoDir, runDir, taskFilePath, stage, readOnly, resumeSessionId, timeoutSec, redactor,
    resolvedCommand, executorVersion = null }) {
    const command = resolvedCommand ?? resolveCustomCommand(cfg || {}, repoDir);
    const details = { instance_id: instanceId, kind: 'custom-cmd', stage, read_only: Boolean(readOnly) };
    if (command.error) return writeMissingExecutableResult(runDir, details, command.error, redactor);
    const sessionPattern = compileSessionPattern(cfg?.session_id_pattern);
    const args = this.buildArgs(cfg || {}, { repoDir, runDir, taskFilePath, readOnly, resumeSessionId });
    const stdinText = cfg?.pass_stdin !== false ? fs.readFileSync(taskFilePath, 'utf8') : undefined;
    const proc = await runAdapterProcess({
      command: command.cmd,
      exactExecutable: true,
      args,
      cwd: repoDir,
      stdinText,
      runDir,
      timeoutSec: timeoutSec || cfg?.timeout_sec || 3600,
      shell: command.shell,
      redactor
    });

    const infraError = classifyInfraError(proc.exitCode, proc.stdoutTail, proc.stderrTail, proc.timedOut);
    const stdout = fs.readFileSync(proc.stdoutPath, 'utf8');
    const sessionId = sessionPattern && (sessionPattern.exec(stdout)?.[1] ||
      sessionPattern.exec(fs.readFileSync(proc.stderrPath, 'utf8'))?.[1] || null);
    const finalText = readFinalFile(cfg.final_file, repoDir, runDir) ?? stdout;
    const finalMd = writeFinalMarkdown(runDir, finalText, redactor);

    return writeRunResult(
      runDir,
      {
        ...details,
        executable_path: command.cmd,
        executor_version: executorVersion,
        status: infraError ? 'infra_error' : (proc.exitCode === 0 ? 'completed' : 'failed'),
        exit_code: proc.exitCode,
        elapsed_seconds: proc.elapsedSeconds,
        session_id: sessionId,
        usage: null,
        final_md: finalMd,
        infra_error: infraError
      },
      redactor
    );
  }
};

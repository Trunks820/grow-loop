import path from 'node:path';
import { ensureDir, writeJsonAtomic } from './state.mjs';
import { buildRedactor } from './redact.mjs';
import { runAdapterProcess } from './adapters/base.mjs';
import { recordVerifyOutcome } from './router.mjs';

/**
 * CLI-owned machine verification.
 * grow-loop runs `config.verification.commands` itself and decides pass/fail from
 * real exit codes, so a coordinator cannot record a pass it never observed.
 */

/** Configured commands minus blanks and `#` placeholders left by profiles. */
export function getVerificationCommands(config) {
  const raw = Array.isArray(config?.verification?.commands) ? config.verification.commands : [];
  return raw
    .map((cmd) => String(cmd || '').trim())
    .filter((cmd) => cmd && !cmd.startsWith('#'));
}

function failureExcerpt(proc) {
  const text = proc.stderrTail.trim() || proc.stdoutTail.trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).join(' | ').slice(-300);
}

export async function runVerification(ctx, { packId, timeoutSec } = {}) {
  const { stateDir, config, state, paths } = ctx;
  const pack = state.packs[packId || state.active_pack_id];
  if (!pack) throw new Error('No active pack found');
  if (pack.status !== 'VERIFY') {
    throw new Error(`Pack ${pack.id} is not waiting for verification (current status: ${pack.status})`);
  }

  const commands = getVerificationCommands(config);
  if (!commands.length) {
    throw new Error(`No runnable verification.commands in ${path.join(stateDir, 'config.json')}; configure them before running "grow-loop verify".`);
  }

  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const limitSec = timeoutSec || config?.verification?.timeout_sec || 1800;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(paths.runsDir, pack.id, `${stamp}-verify`);
  ensureDir(runDir);

  // Stop at the first failing command, like `cmd1 && cmd2`.
  const results = [];
  for (let i = 0; i < commands.length; i++) {
    const proc = await runAdapterProcess({
      command: commands[i],
      args: [],
      cwd: state.repo_dir,
      runDir: path.join(runDir, `cmd-${i + 1}`),
      timeoutSec: limitSec,
      shell: true,
      redactor
    });
    results.push({ command: commands[i], proc });
    if (proc.exitCode !== 0 || proc.timedOut) break;
  }

  const failed = results.find((r) => r.proc.exitCode !== 0 || r.proc.timedOut) || null;
  const passed = !failed && results.length === commands.length;
  const totalSec = results.reduce((sum, r) => sum + r.proc.elapsedSeconds, 0);
  const summary = passed
    ? `${results.length}/${commands.length} commands exited 0 (${totalSec.toFixed(1)}s)`
    : `"${failed.command}" exited ${failed.proc.exitCode}${failed.proc.timedOut ? ' (timeout)' : ''}: ${failureExcerpt(failed.proc)}`;

  const report = redactor.redactValue({
    pack_id: pack.id,
    passed,
    summary,
    commands: results.map((r) => ({
      command: r.command,
      exit_code: r.proc.exitCode,
      timed_out: r.proc.timedOut,
      elapsed_seconds: r.proc.elapsedSeconds,
      stdout_log: r.proc.stdoutPath,
      stderr_log: r.proc.stderrPath
    })),
    skipped: commands.slice(results.length)
  });
  writeJsonAtomic(path.join(runDir, 'verify-result.json'), report);

  const transition = recordVerifyOutcome(ctx, {
    packId: pack.id,
    passed,
    source: 'cli',
    command: results.map((r) => r.command).join(' && '),
    summary,
    rootCause: failed ? failureExcerpt(failed.proc) : '',
    runDir
  });

  return { run_dir: runDir, ...report, transition };
}

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ensureDir, writeJsonAtomic } from './state.mjs';
import { buildRedactor } from './redact.mjs';
import { runAdapterProcess } from './adapters/base.mjs';
import { getPackDef, markVerificationEnvironment, recordVerifyOutcome } from './router.mjs';

export function getVerificationPlan(config, packDef) {
  const commands = (value, source) => (Array.isArray(value) ? value : [])
    .filter((command) => typeof command === 'string')
    .map((command) => command.trim())
    .filter((command) => command && !command.startsWith('#'))
    .map((command) => ({ command, source }));

  return [
    ...commands(config?.verification?.commands, 'global'),
    ...commands(packDef?.verify_commands, 'pack')
  ];
}

export function getVerificationCommands(config, packDef) {
  return getVerificationPlan(config, packDef).map(({ command }) => command);
}

function verificationEnvironment(verification) {
  const windows = process.platform === 'win32';
  // Use one key per variable on Windows, where Path and PATH name the same variable.
  const env = Object.create(null);
  const keyFor = (key) => windows ? key.toUpperCase() : key;
  for (const [key, value] of Object.entries(process.env)) env[keyFor(key)] = value;
  if (windows) {
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
  }
  for (const [key, value] of Object.entries(verification.env ?? {})) env[keyFor(key)] = String(value);
  if (verification.path_prepend?.length) {
    env.PATH = [...verification.path_prepend, env.PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

async function failureDetails(commandResult, redactor) {
  const testNames = new Set();
  const assertions = new Set();
  const excerpts = [];

  for (const [label, logPath] of [
    ['stdout', commandResult.stdout_log],
    ['stderr', commandResult.stderr_log]
  ]) {
    const tail = [];
    const lines = createInterface({ input: fs.createReadStream(logPath, 'utf8'), crlfDelay: Infinity });
    for await (const raw of lines) {
      const line = redactor.redactString(raw);
      tail.push(line.slice(-6000));
      if (tail.length > 80) tail.shift();

      const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
      const name = plain.match(/^not ok(?:\s+\d+)?\s*-?\s+(.+)/)?.[1]
        ?? plain.match(/^✖\s+(?!failing tests:$)(.+?)(?: \(\d+(?:\.\d+)?ms\))?$/)?.[1]
        ?? plain.match(/^FAILED\s+(\S+::\S+)/)?.[1]
        ?? plain.match(/^(?:\[ERROR\]\s+)?Tests run:.*\b(?:Failures|Errors):\s*[1-9].*?\bin\s+(\S+)/)?.[1]
        ?? plain.match(/^\[ERROR\]\s+([\w$]+(?:\.[\w$]+)+):\d+\b/)?.[1];
      if (name && testNames.size < 80) testNames.add(name.slice(0, 1000));
      if (assertions.size < 80 && /^(?:E\s{2,}|\[ERROR\]|FAILED\s+\S+::|Tests run:|(?:error|actual):|expected\b)|assertion(?:error| failed)|ERR_ASSERTION/i.test(plain)) {
        assertions.add(plain.slice(0, 1000));
      }
    }
    while (tail.at(-1) === '') tail.pop();
    if (tail.length) excerpts.push({ label, tail });
  }

  const excerpt = excerpts.length === 1
    ? excerpts[0].tail.join('\n').slice(-6000)
    : excerpts.map(({ label, tail }) => {
      return `[${label}]\n${tail.slice(-39).join('\n').slice(-2990)}`;
    }).join('\n');

  return { ...commandResult, excerpt, test_names: [...testNames], assertion_lines: [...assertions] };
}

async function runAttempt(commands, { runDir, cwd, limitSec, env, outputEncoding, redactor }) {
  const results = [];
  let failure = null;
  let totalSec = 0;

  // Stop at the first failing command, like cmd1 && cmd2.
  for (const [index, entry] of commands.entries()) {
    const proc = await runAdapterProcess({
      command: entry.command,
      args: [],
      cwd,
      runDir: path.join(runDir, `cmd-${index + 1}`),
      timeoutSec: limitSec,
      shell: true,
      env,
      outputEncoding,
      redactor
    });
    const result = {
      ...entry,
      exit_code: proc.exitCode,
      timed_out: proc.timedOut,
      elapsed_seconds: proc.elapsedSeconds,
      stdout_log: proc.stdoutPath,
      stderr_log: proc.stderrPath
    };
    results.push(result);
    totalSec += proc.elapsedSeconds;
    if (proc.exitCode !== 0 || proc.timedOut) {
      failure = await failureDetails(result, redactor);
      break;
    }
  }

  const assertion = failure?.assertion_lines[0];
  const summary = failure
    ? `"${failure.command}" exited ${failure.exit_code}${failure.timed_out ? ' (timeout)' : ''}${assertion ? `: ${assertion}` : ''}`
    : `${results.length}/${commands.length} commands exited 0 (${totalSec.toFixed(1)}s)`;
  const report = redactor.redactValue({
    passed: !failure,
    summary,
    commands: results,
    skipped: commands.slice(results.length).map(({ command }) => command),
    failure
  });
  return report;
}

export async function runVerification(ctx, { packId, timeoutSec, markEnv } = {}) {
  const { stateDir, config, state, paths, manifest } = ctx;
  const pack = state.packs[packId || state.active_pack_id];
  if (!pack) throw new Error('No active pack found');
  if (markEnv !== undefined && (typeof markEnv !== 'string' || !markEnv.trim())) {
    throw new Error('Use grow-loop verify --mark-env "<reason>" with a non-empty reason.');
  }
  if (markEnv === undefined && pack.status !== 'VERIFY') {
    throw new Error(`Pack ${pack.id} is not waiting for verification (current status: ${pack.status})`);
  }

  const commands = getVerificationPlan(config, getPackDef(manifest, pack.id));
  if (!commands.length) {
    throw new Error(`No runnable verification.commands in ${path.join(stateDir, 'config.json')} or verify_commands for pack ${pack.id} in the manifest.`);
  }

  const verification = config?.verification ?? {};
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const limitSec = timeoutSec || verification.timeout_sec || 1800;
  const outputEncoding = verification.output_encoding ?? 'utf-8';
  try {
    new TextDecoder(outputEncoding);
  } catch {
    throw new Error('Unsupported verification.output_encoding. Use a TextDecoder encoding such as utf-8 or gbk.');
  }
  const env = verificationEnvironment(verification);
  const previousVerify = markEnv === undefined ? pack.last_verify : markVerificationEnvironment(ctx, pack.id, markEnv);
  const environmentReason = previousVerify?.environment_retry_pending ? previousVerify.environment_reason : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const packRunsDir = path.join(paths.runsDir, pack.id);
  ensureDir(packRunsDir);
  const runDirs = [];

  async function attempt(retry) {
    const runDir = fs.mkdtempSync(path.join(packRunsDir, `${stamp}-verify${retry ? '-retry' : ''}-`));
    runDirs.push(runDir);
    const report = await runAttempt(commands, { runDir, cwd: state.repo_dir, limitSec, env, outputEncoding, redactor });
    writeJsonAtomic(path.join(runDir, 'verify-result.json'), { pack_id: pack.id, ...report });
    return report;
  }

  let report = await attempt(false);
  if (!report.passed && verification.retry_once !== false) report = await attempt(true);
  const flaky = report.passed && runDirs.length === 2;
  const runDir = runDirs.at(-1);
  const transition = recordVerifyOutcome(ctx, {
    packId: pack.id,
    passed: report.passed,
    source: 'cli',
    command: report.commands.map(({ command }) => command).join(' && '),
    summary: report.summary,
    rootCause: report.failure?.excerpt,
    failure: report.failure,
    flaky,
    runDir,
    runDirs,
    previousVerifyAt: previousVerify?.at ?? null,
    environmentReason
  });

  return { pack_id: pack.id, run_dir: runDir, run_dirs: runDirs, flaky, environment_reason: environmentReason, ...report, transition };
}

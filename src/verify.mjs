import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { appendEvent, ensureDir, readVerificationBaseline, writeJsonAtomic } from './state.mjs';
import { buildRedactor } from './redact.mjs';
import { runAdapterProcess } from './adapters/base.mjs';
import { readGitPosition } from './git-watch.mjs';
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
  const commands = getVerificationPlan(config, packDef).map(({ command }) => command);
  const baseline = getBaselineConfig(config);
  if (baseline) commands.push(baseline.command);
  return commands;
}

function getBaselineConfig(config) {
  const baseline = config?.verification?.baseline;
  if (baseline === undefined) return null;
  const { command, failure_pattern: pattern } = baseline ?? {};
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('verification.baseline.command 必须是非空字符串。');
  }
  let failurePattern;
  try {
    if (typeof pattern === 'string') {
      const expression = new RegExp(pattern);
      // The empty alternative matches even if the configured expression requires input.
      if (new RegExp('(?:' + pattern + ')|').exec('').length === 2) failurePattern = expression;
    }
  } catch {
    // Report the field without echoing the invalid expression.
  }
  if (!failurePattern) {
    throw new Error('verification.baseline.failure_pattern 必须是恰好含一个捕获组的有效正则字符串。');
  }
  return { command, failurePattern };
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

async function failureDetails(commandResult, redactor, failurePattern) {
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
      if (failurePattern) {
        const captured = failurePattern.exec(raw)?.[1];
        if (captured) testNames.add(redactor.redactString(captured));
      } else if (name && testNames.size < 80) {
        testNames.add(name.slice(0, 1000));
      }
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

async function runCommand(entry, runDir, options) {
  const proc = await runAdapterProcess({
    ...options,
    command: entry.command,
    args: [],
    runDir,
    shell: true
  });
  return {
    ...entry,
    exit_code: proc.exitCode,
    timed_out: proc.timedOut,
    elapsed_seconds: proc.elapsedSeconds,
    stdout_log: proc.stdoutPath,
    stderr_log: proc.stderrPath
  };
}

async function baselineDetails(result, failurePattern, redactor) {
  const details = await failureDetails(result, redactor, failurePattern);
  details.test_names.sort();
  const crashed = result.timed_out || result.exit_code === -1
    || (result.exit_code !== 0 && details.test_names.length === 0);
  const crashSummary = crashed
    ? `全量测试跑挂了${result.timed_out ? '（超时）' : `（退出码 ${result.exit_code}）`}`
    : null;
  return { details, crashSummary };
}

async function runAttempt(commands, runDir, options, baseline) {
  const { redactor } = options;
  const results = [];
  let failure = null;
  let baselineResult;
  let baselineSummary;
  let totalSec = 0;

  // Stop at the first failing command, like cmd1 && cmd2.
  for (const [index, entry] of commands.entries()) {
    const result = await runCommand(entry, path.join(runDir, `cmd-${index + 1}`), options);
    results.push(result);
    totalSec += result.elapsed_seconds;
    if (entry.source === 'baseline') {
      const { details, crashSummary } = await baselineDetails(result, baseline.failurePattern, redactor);
      const failures = details.test_names;
      const current = new Set(failures);
      const added = failures.filter((name) => !baseline.known.has(name));
      baselineResult = {
        failures,
        fixed: crashSummary ? [] : [...baseline.known].filter((name) => !current.has(name))
      };
      if (crashSummary || added.length) {
        failure = { ...details, test_names: added };
        baselineSummary = crashSummary ?? `全量测试新增 ${added.length} 条失败`;
      }
    } else if (result.exit_code !== 0 || result.timed_out) {
      failure = await failureDetails(result, redactor);
      break;
    }
  }

  const assertion = failure?.assertion_lines[0];
  const summary = failure
    ? baselineSummary ?? `"${failure.command}" exited ${failure.exit_code}${failure.timed_out ? ' (timeout)' : ''}${assertion ? `: ${assertion}` : ''}`
    : `${results.length}/${commands.length} commands ${baselineResult ? 'passed' : 'exited 0'} (${totalSec.toFixed(1)}s)`;
  const report = redactor.redactValue({
    passed: !failure,
    summary,
    commands: results,
    skipped: commands.slice(results.length).map(({ command }) => command),
    failure
  });
  if (baselineResult) {
    // The names were redacted before comparing them with the saved baseline.
    report.baseline = baselineResult;
    if (failure) report.failure.test_names = failure.test_names;
  }
  return report;
}

function commandOptions(ctx, timeoutSec) {
  const verification = ctx.config?.verification ?? {};
  const outputEncoding = verification.output_encoding ?? 'utf-8';
  try {
    new TextDecoder(outputEncoding);
  } catch {
    throw new Error('Unsupported verification.output_encoding. Use a TextDecoder encoding such as utf-8 or gbk.');
  }
  return {
    cwd: ctx.state.repo_dir,
    timeoutSec: timeoutSec || verification.timeout_sec || 1800,
    env: verificationEnvironment(verification),
    outputEncoding,
    redactor: buildRedactor(ctx.config?.redaction?.extra_patterns || [])
  };
}

export async function recordVerificationBaseline(ctx, { timeoutSec } = {}) {
  const baseline = getBaselineConfig(ctx.config);
  if (!baseline) {
    throw new Error('请在状态目录的 config.json 中配置 verification.baseline.command 和 verification.baseline.failure_pattern。');
  }
  const options = commandOptions(ctx, timeoutSec);
  const { paths, config, stateDir } = ctx;
  const head = readGitPosition(options.cwd)?.head ?? null;
  ensureDir(paths.runsDir);
  const runDir = fs.mkdtempSync(path.join(paths.runsDir, 'record-baseline-'));
  const result = await runCommand({ command: baseline.command, source: 'baseline' }, runDir, options);
  const { details, crashSummary } = await baselineDetails(result, baseline.failurePattern, options.redactor);
  if (crashSummary) throw new Error([crashSummary, details.excerpt].filter(Boolean).join('\n'));

  const record = {
    recorded_at: new Date().toISOString(),
    head,
    command: options.redactor.redactString(baseline.command),
    exit_code: result.exit_code,
    failures: details.test_names
  };
  writeJsonAtomic(paths.baselinePath, record);
  appendEvent(stateDir, config, { type: 'baseline_recorded', ...record });
  return record;
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
  const baseline = getBaselineConfig(config);
  if (baseline) {
    const recorded = readVerificationBaseline(paths.baselinePath);
    if (!recorded) throw new Error('缺少 baseline.json，请先运行 grow-loop verify --record-baseline。');
    baseline.known = new Set(recorded.failures);
    commands.push({ command: baseline.command, source: 'baseline' });
  }
  if (!commands.length) {
    throw new Error(`No runnable verification.commands in ${path.join(stateDir, 'config.json')} or verify_commands for pack ${pack.id} in the manifest.`);
  }

  const verification = config?.verification ?? {};
  const options = commandOptions(ctx, timeoutSec);
  const previousVerify = markEnv === undefined ? pack.last_verify : markVerificationEnvironment(ctx, pack.id, markEnv);
  const environmentReason = previousVerify?.environment_retry_pending ? previousVerify.environment_reason : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const packRunsDir = path.join(paths.runsDir, pack.id);
  ensureDir(packRunsDir);
  const runDirs = [];

  async function attempt(retry) {
    const runDir = fs.mkdtempSync(path.join(packRunsDir, `${stamp}-verify${retry ? '-retry' : ''}-`));
    runDirs.push(runDir);
    const report = await runAttempt(commands, runDir, options, baseline);
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
    baseline: report.baseline,
    flaky,
    runDir,
    runDirs,
    previousVerifyAt: previousVerify?.at ?? null,
    environmentReason
  });

  return { pack_id: pack.id, run_dir: runDir, run_dirs: runDirs, flaky, environment_reason: environmentReason, ...report, transition };
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { ensureDir, writeJsonAtomic } from '../state.mjs';
import { buildRedactor } from '../redact.mjs';

/**
 * Shared utilities & Zero-Custody Guardrails for all thin executor drivers.
 *
 * Red lines enforced here:
 * 1. Zero Credential Custody: never read/copy/proxy credential files or cookies.
 * 2. No Secret Echo: stdout/stderr/result metadata are passed through redactor.
 * 3. Bounded Probe Timeouts: probes never hang the coordinator.
 * 4. Infra Failure Classification: quota (429), auth, timeout, and CLI crash
 *    are normalized so they NEVER consume code repair budgets.
 */

export function classifyInfraError(exitCode, stdoutText, stderrText, timedOut) {
  if (timedOut) return 'INFRA_TIMEOUT';
  // A clean exit means the CLI finished its turn. Its stdout then carries model and tool
  // text (source code, test output, docs) that may legitimately mention 429/401/rate limits.
  if (exitCode === 0) return null;
  const combined = `${extractCliErrorText(stdoutText)}\n${stderrText || ''}`;
  if (/\b429\b|rate[_ -]?limit|quota[_ -]?exhausted|free-usage-exhausted|insufficient_quota|too many requests/i.test(combined)) {
    return 'INFRA_QUOTA';
  }
  if (/\b401\b|\b403\b|unauthenticated|not logged in|auth(?:entication)? (?:failed|required|expired)|missing[_ -]?credential|invalid api key/i.test(combined)) {
    return 'INFRA_AUTH';
  }
  if (exitCode !== 0 && /ENOENT|not recognized as an internal or external command|command not found|0xC0000142/i.test(combined)) {
    return 'INFRA_CLI_CRASH';
  }
  return null;
}

/**
 * Keep only the stdout parts a CLI emits about its own failure: plain-text lines and
 * JSON events typed as errors. Assistant messages and tool results are dropped, so code
 * the executor read or wrote cannot masquerade as a quota/auth failure.
 */
export function extractCliErrorText(stdoutText) {
  const kept = [];
  const lines = String(stdoutText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) {
      // The first line of a truncated tail is usually the end of a JSON event.
      if (i === 0 && trimmed.endsWith('}')) continue;
      kept.push(trimmed);
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (/error|fail/i.test(`${obj.type || ''} ${obj.subtype || ''}`) || obj.error || obj.is_error === true) {
        kept.push(trimmed);
      }
    } catch {
      // ignore partial JSON lines
    }
  }
  return kept.join('\n');
}

export const EXECUTABLE_NOT_FOUND = 'INFRA_EXECUTABLE_NOT_FOUND';

const WINDOWS_COMMAND_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'];
const versionOrder = new Intl.Collator('en', { numeric: true });

function isFile(file) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function readDirectory(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function resolveExecutable(executable, cwd = process.cwd()) {
  if (!executable.includes('*')) return { path: executable, pattern: executable, candidates: [executable] };

  const { root } = path.parse(executable);
  const segments = executable.slice(root.length).split(process.platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
  let matches = [{ file: path.resolve(cwd, root), versions: [] }];
  for (const segment of segments) {
    if (!segment.includes('*')) {
      matches = matches.map(({ file, versions }) => ({ file: path.join(file, segment), versions }));
      continue;
    }

    const parts = segment.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const matcher = new RegExp(`^${parts.join('(.*)')}$`, process.platform === 'win32' ? 'is' : 's');
    matches = matches.flatMap(({ file, versions }) => readDirectory(file).flatMap((name) => {
      const match = matcher.exec(name);
      return match ? [{ file: path.join(file, name), versions: [...versions, ...match.slice(1)] }] : [];
    }));
  }

  const candidates = matches.filter(({ file }) => isFile(file)).sort((a, b) => {
    for (let i = 0; i < a.versions.length; i++) {
      const order = versionOrder.compare(b.versions[i], a.versions[i]);
      if (order) return order;
    }
    if (a.file === b.file) return 0;
    return a.file < b.file ? -1 : 1;
  }).map(({ file }) => file);
  return { path: candidates[0] ?? null, pattern: executable, candidates };
}

function findPathExecutable(command, cwd, searchDirs) {
  const windows = process.platform === 'win32';
  const dirs = searchDirs ?? (process.env.PATH ?? (windows ? '' : '/usr/bin:/bin')).split(path.delimiter);
  const extensions = windows ? WINDOWS_COMMAND_EXTENSIONS : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.resolve(cwd, dir, command + ext);
      if (!isFile(candidate)) continue;
      if (!windows) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

export function resolveExecutorCommand(executable, fallback, cwd = process.cwd()) {
  let cmd = null;
  if (executable === undefined && fallback) {
    cmd = findPathExecutable(fallback, cwd);
  } else if (typeof executable === 'string' && executable.length > 0) {
    const resolved = resolveExecutable(executable, cwd).path;
    if (resolved) {
      const absolute = path.resolve(cwd, resolved);
      if (isFile(absolute)) cmd = absolute;
    }
  }

  const configured = executable === undefined ? fallback : executable;
  const displayPath = configured === '' ? '""' : configured ?? '（未配置）';
  const error = cmd ? null
    : `找不到执行程序：配置的是 ${displayPath}，没有匹配的文件。请检查安装或改 config.json 的 executable`;
  return { cmd, configured, error };
}

export async function probeExecutable({ cmd, probeArgs, shell }, { timeoutMs, cwd } = {}) {
  if (!cmd) return { ok: false, latencyMs: 0 };
  return runBoundedCommand(cmd, probeArgs, { timeoutMs, cwd, shell, exactExecutable: true });
}

export function versionFromProbe(probe) {
  if (!probe.ok) return null;
  return (probe.stdout.trim() || probe.stderr.trim()).split(/\r?\n/, 1)[0].trim() || null;
}

function escapeCmdChars(value) {
  return value.replace(/[()%!^"&|<>\t ]/g, '^$&');
}

function quoteCmdArgument(arg) {
  const quoted = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&');
  return escapeCmdChars(`"${quoted}"`);
}

function cmdShellSpec(commandLine) {
  // /s removes just the outer quotes. Let cmd.exe parse the escaped command and arguments.
  return {
    spawnCommand: process.env.ComSpec || 'cmd.exe',
    spawnArgs: ['/d', '/s', '/c', `"${commandLine}"`],
    shell: false,
    windowsVerbatimArguments: true
  };
}

/**
 * Resolve a CLI command cleanly on Windows without triggering Node DEP0190:
 * - Direct .exe executables run with shell: false
 * - Windows .cmd/.bat shims (common for global npm CLIs like codex/claude/dsh)
 *   are invoked via cmd.exe /d /s /c with shell: false
 */
export function resolveSpawnSpec(command, args, forceShell = false, exactExecutable = false) {
  const windows = process.platform === 'win32';
  if (forceShell) {
    if (!exactExecutable) return { spawnCommand: command, spawnArgs: args, shell: true };
    if (windows) return cmdShellSpec([quoteCmdArgument(command), ...args].join(' '));
    const quoted = `'${command.replace(/'/g, "'\\''")}'`;
    return { spawnCommand: '/bin/sh', spawnArgs: ['-c', [quoted, ...args].join(' ')], shell: false };
  }
  if (!windows) {
    return { spawnCommand: command, spawnArgs: args, shell: false };
  }

  const lower = command.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return cmdShellSpec([quoteCmdArgument(path.normalize(command)), ...args.map(quoteCmdArgument)].join(' '));
  }
  if (exactExecutable || lower.endsWith('.exe') || lower.endsWith('.com')) {
    return { spawnCommand: command, spawnArgs: args, shell: false };
  }

  // If explicit path without extension or bare binary name, search PATH with .EXE before .CMD/.BAT
  const hasSep = command.includes('/') || command.includes('\\');
  const baseName = hasSep ? path.basename(command) : command;
  const dirs = hasSep ? [path.dirname(path.resolve(command))] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidate = findPathExecutable(baseName, process.cwd(), dirs);
  if (candidate) return resolveSpawnSpec(candidate, args, false, true);

  return { spawnCommand: command, spawnArgs: args, shell: false };
}

/**
 * Run a bounded read-only probe command without shell injection.
 */
export function runBoundedCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const cwd = options.cwd || process.cwd();
  const startedAt = Date.now();
  const { spawnCommand, spawnArgs, shell, windowsVerbatimArguments } = resolveSpawnSpec(
    command, args, Boolean(options.shell), options.exactExecutable
  );

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (code, error, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr: stderr || error || '',
        timedOut,
        latencyMs: Date.now() - startedAt
      });
    };

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments,
        shell,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      finish(-1, String(err.message || err));
      return;
    }

    timer = setTimeout(() => {
      finish(-1, null, true);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill error
      }
      // A descendant can keep inherited pipes open after the probe process exits.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length < 256 * 1024) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
    });

    child.on('error', (err) => finish(-1, String(err.message || err)));
    child.on('close', (code) => finish(code));

    if (options.stdinText !== undefined) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

/**
 * Execute a CLI adapter process, streaming output directly to runDir logs.
 */
export async function runAdapterProcess({
  command, args, cwd, stdinText, runDir, timeoutSec = 3600, shell = false, redactor, env, outputEncoding = 'utf-8',
  onStdoutLine, exactExecutable = false
}) {
  const stdoutDecoder = new TextDecoder(outputEncoding, { ignoreBOM: true });
  const stderrDecoder = new TextDecoder(outputEncoding, { ignoreBOM: true });
  ensureDir(runDir);
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const startedAt = Date.now();
  const { spawnCommand, spawnArgs, shell: resolvedShell, windowsVerbatimArguments } = resolveSpawnSpec(
    command, args, Boolean(shell), exactExecutable
  );

  const outStream = fs.createWriteStream(stdoutPath, { encoding: 'utf8' });
  const errStream = fs.createWriteStream(stderrPath, { encoding: 'utf8' });
  const logsFinished = Promise.all([finished(outStream), finished(errStream)]);
  const processFinished = new Promise((resolve, reject) => {
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let child;
    let partialLine = '';
    let callbackError;

    const emitLines = (text, end = false) => {
      if (!onStdoutLine || callbackError) return;
      const lines = (partialLine + text).split('\n');
      partialLine = lines.pop();
      if (end && partialLine) lines.push(partialLine);
      try {
        for (const line of lines) onStdoutLine(line.replace(/\r$/, ''));
      } catch (error) {
        callbackError = error;
        child?.kill();
      }
    };

    const finish = (code, signal, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutEnd = stdoutDecoder.decode();
      const stderrEnd = stderrDecoder.decode() + error;
      outStream.end(stdoutEnd);
      errStream.end(stderrEnd);
      emitLines(stdoutEnd, true);
      if (callbackError) {
        reject(callbackError);
        return;
      }
      const safeRedactor = redactor || buildRedactor();
      resolve({
        exitCode: code ?? -1,
        signal,
        timedOut,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        stdoutPath,
        stderrPath,
        stdoutTail: safeRedactor.redactString((stdoutTail + stdoutEnd).slice(-16384)),
        stderrTail: safeRedactor.redactString((stderrTail + stderrEnd).slice(-16384))
      });
    };

    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env,
        shell: resolvedShell,
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      finish(-1, null, String(err.message || err));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 3000);
    }, timeoutSec * 1000);

    child.stdout.on('data', (chunk) => {
      const text = stdoutDecoder.decode(chunk, { stream: true });
      outStream.write(text);
      stdoutTail = (stdoutTail + text).slice(-16384);
      emitLines(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = stderrDecoder.decode(chunk, { stream: true });
      errStream.write(text);
      stderrTail = (stderrTail + text).slice(-16384);
    });

    child.on('error', (err) => finish(-1, null, '\n' + (err.message || err)));
    child.on('close', (code, signal) => finish(code, signal));

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
  const [result] = await Promise.all([processFinished, logsFinished]);
  return result;
}

export function writeDryRunReceipt(runDir, payload, redactor) {
  ensureDir(runDir);
  const safe = (redactor || buildRedactor()).redactValue({
    status: 'dry_run',
    generated_at: new Date().toISOString(),
    ...payload
  });
  writeJsonAtomic(path.join(runDir, 'dry-run.json'), safe);
  return safe;
}

export function writeFinalMarkdown(runDir, markdown, redactor) {
  const finalMd = path.join(runDir, 'final.md');
  fs.writeFileSync(finalMd, (redactor || buildRedactor()).redactString(markdown), 'utf8');
  return finalMd;
}

export function writeRunResult(runDir, payload, redactor) {
  ensureDir(runDir);
  const safe = (redactor || buildRedactor()).redactValue({
    recorded_at: new Date().toISOString(),
    ...payload
  });
  writeJsonAtomic(path.join(runDir, 'result.json'), safe);
  return safe;
}

export function writeMissingExecutableResult(runDir, details, summary, redactor) {
  return writeRunResult(runDir, {
    ...details,
    status: 'infra_error',
    infra_error: EXECUTABLE_NOT_FOUND,
    summary,
    executable_path: null,
    executor_version: null,
    exit_code: null,
    elapsed_seconds: 0,
    session_id: null,
    usage: null,
    final_md: null
  }, redactor);
}

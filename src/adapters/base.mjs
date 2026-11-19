import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * Resolve a CLI command cleanly on Windows without triggering Node DEP0190:
 * - Direct .exe executables run with shell: false
 * - Windows .cmd/.bat shims (common for global npm CLIs like codex/claude/dsh)
 *   are invoked via cmd.exe /d /c <fullPath> <...args> with shell: false
 */
export function resolveSpawnSpec(command, args, forceShell = false) {
  if (forceShell) {
    return { spawnCommand: command, spawnArgs: args, shell: true };
  }
  if (process.platform !== 'win32') {
    return { spawnCommand: command, spawnArgs: args, shell: false };
  }

  const lower = command.toLowerCase();
  const comspec = process.env.ComSpec || 'cmd.exe';
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { spawnCommand: comspec, spawnArgs: ['/d', '/c', command, ...args], shell: false };
  }
  if (lower.endsWith('.exe') || lower.endsWith('.com')) {
    return { spawnCommand: command, spawnArgs: args, shell: false };
  }

  // If explicit path without extension or bare binary name, search PATH with .EXE before .CMD/.BAT
  const hasSep = command.includes('/') || command.includes('\\');
  const searchDirs = hasSep
    ? [path.dirname(path.resolve(command))]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const baseName = hasSep ? path.basename(command) : command;
  const exts = ['.exe', '.com', '.cmd', '.bat'];

  for (const dir of searchDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, baseName + ext);
      if (fs.existsSync(candidate)) {
        if (ext === '.cmd' || ext === '.bat') {
          return { spawnCommand: comspec, spawnArgs: ['/d', '/c', candidate, ...args], shell: false };
        }
        return { spawnCommand: candidate, spawnArgs: args, shell: false };
      }
    }
  }

  return { spawnCommand: command, spawnArgs: args, shell: false };
}

/**
 * Run a bounded read-only probe command without shell injection.
 */
export function runBoundedCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const cwd = options.cwd || process.cwd();
  const startedAt = Date.now();
  const { spawnCommand, spawnArgs, shell } = resolveSpawnSpec(command, args, Boolean(options.shell));

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        windowsHide: true,
        shell,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: String(err.message || err),
        timedOut: false,
        latencyMs: Date.now() - startedAt
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill error
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr || String(err.message || err),
        timedOut,
        latencyMs: Date.now() - startedAt
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        latencyMs: Date.now() - startedAt
      });
    });

    if (options.stdinText !== undefined) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

/**
 * Execute a CLI adapter process, streaming output directly to runDir logs.
 */
export function runAdapterProcess({ command, args, cwd, stdinText, runDir, timeoutSec = 3600, shell = false, redactor }) {
  ensureDir(runDir);
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const startedAt = Date.now();
  const { spawnCommand, spawnArgs, shell: resolvedShell } = resolveSpawnSpec(command, args, Boolean(shell));

  return new Promise((resolve) => {
    const outStream = fs.createWriteStream(stdoutPath, { encoding: 'utf8' });
    const errStream = fs.createWriteStream(stderrPath, { encoding: 'utf8' });
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        shell: resolvedShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      outStream.end();
      errStream.end();
      resolve({
        exitCode: -1,
        timedOut: false,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        stdoutPath,
        stderrPath,
        stdoutTail: '',
        stderrTail: String(err.message || err)
      });
      return;
    }

    const timer = setTimeout(() => {
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
      const text = chunk.toString('utf8');
      outStream.write(text);
      stdoutTail = (stdoutTail + text).slice(-16384);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      errStream.write(text);
      stderrTail = (stderrTail + text).slice(-16384);
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outStream.end();
      errStream.end();
      const safeRedactor = redactor || buildRedactor();
      resolve({
        exitCode: code ?? -1,
        timedOut,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        stdoutPath,
        stderrPath,
        stdoutTail: safeRedactor.redactString(stdoutTail),
        stderrTail: safeRedactor.redactString(stderrTail)
      });
    };

    child.on('error', (err) => {
      stderrTail += `\n${err.message || err}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
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

export function writeRunResult(runDir, payload, redactor) {
  ensureDir(runDir);
  const safe = (redactor || buildRedactor()).redactValue({
    recorded_at: new Date().toISOString(),
    ...payload
  });
  writeJsonAtomic(path.join(runDir, 'result.json'), safe);
  return safe;
}

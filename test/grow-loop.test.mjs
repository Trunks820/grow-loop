import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createInitialState,
  ensureGitignoreEntry,
  getStatePaths,
  loadWorkspace,
  readEvents,
  readJsonSafe,
  resolveStateDir,
  saveState,
  writeJsonAtomic,
  writeManifestWithReason
} from '../src/state.mjs';
import {
  recordCommitOutcome,
  recordImplementOutcome,
  recordReviewOutcome,
  recordVerifyOutcome,
  resumeFromGate,
  startOrAdvanceActivePack
} from '../src/router.mjs';
import { ALLOWED_GATE_REASONS, checkApprovalEnvelope } from '../src/gate.mjs';
import { addLesson } from '../src/lessons.mjs';
import { buildTaskPrompt, parseImplementBlockedReason, taskBriefWarnings } from '../src/task-builder.mjs';
import { buildRedactor } from '../src/redact.mjs';
import { generateEvidencePack } from '../src/evidence.mjs';
import { classifyInfraError } from '../src/adapters/base.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';
import { getVerificationCommands } from '../src/verify.mjs';
import { parseReviewReport } from '../src/review-report.mjs';
import { scanReferences } from '../src/ref-scan.mjs';
import { hasGlob, repoRelativePath, scopeMatcher } from '../src/scope-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PKG_ROOT, 'bin', 'grow-loop.mjs');

test('documented grow-loop commands and options exist on the CLI', () => {
  const help = execFileSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
  const commands = new Map();
  for (const [, command, subcommand, options] of help.matchAll(/^  grow-loop ([a-z][a-z-]*)(?: +([a-z][a-z-]*)(?= |$))?(.*)$/gm)) {
    commands.set(subcommand ? `${command} ${subcommand}` : command, new Set(options.match(/--[a-z-]+/g)));
  }

  // The help line for record is abbreviated. Read the options from each actual branch.
  const source = fs.readFileSync(CLI_PATH, 'utf8');
  const recordHandler = source.match(/^function cmdRecord\(sub, flags\) \{[\s\S]*?^\}/m)[0];
  for (const [, subcommand, body] of recordHandler.matchAll(/^  if \(sub === '([a-z]+)'\) \{([\s\S]*?)^  \}/gm)) {
    const command = `record ${subcommand}`;
    const options = commands.get(command) ?? new Set();
    for (const [, property, bracket, inCheck] of body.matchAll(/\bflags(?:\.([a-z-]+)\b|\['([a-z-]+)'\])|'([a-z-]+)' in flags\b/g)) {
      options.add(`--${property ?? bracket ?? inCheck}`);
    }
    commands.set(command, options);
  }
  commands.delete('record');
  if (/\bcmd === 'help'/.test(source)) commands.set('help', new Set());

  const docs = ['README.md', 'SKILL.md', ...fs.readdirSync(path.join(PKG_ROOT, 'docs'))
    .filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
  const invocation = /^\s*(?:[$&]\s+)?(?:grow-loop|node\s+(?:"[^"\r\n]*\bgrow-loop\.mjs"|'[^'\r\n]*\bgrow-loop\.mjs'|(?:[^\s"']*[\\/])?grow-loop\.mjs|<GROW_LOOP_BIN>))(?=\s|$)/;
  const globalOptions = new Set(['--repo', '--state-dir', '--help', '--h']);
  const problems = [];
  for (const doc of docs) {
    const lines = fs.readFileSync(path.join(PKG_ROOT, doc), 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const location = `${doc}:${index + 1}`;
      let line = lines[index];
      while (invocation.test(line) && /[\\`]\s*$/.test(line) && index + 1 < lines.length) {
        line = `${line.replace(/[\\`]\s*$/, '')} ${lines[++index].trimStart()}`;
      }
      const examples = [line, ...Array.from(line.matchAll(/`+([^`]+)`+/g), ([, code]) => code)];
      for (const example of examples.filter((value) => invocation.test(value))) {
        const args = example.replace(invocation, '').trim();
        const [, command, subcommand] = args.match(/^([\w-]+)(?:\s+([\w-]+))?/) ?? [];
        if (!command) continue; // Bare CLI name or a placeholder such as <command>.
        const key = ['pack', 'todo', 'lesson', 'record'].includes(command) ? `${command} ${subcommand ?? ''}`.trim() : command;
        const options = commands.get(command.startsWith('--') ? 'help' : key);
        if (!options) {
          problems.push(`${location} unknown command: grow-loop ${key}`);
          continue;
        }
        // Keep quoted values together so text such as "retry --later" is not an option.
        const tokens = args.match(/"(?:\\.|[^"\\])*"|'[^']*'|<[^>]+>|[^\s"'<>]+/g) ?? [];
        const optionNames = tokens.map((token) => token.match(/^\[?(--[^=\]]+)/)?.[1]).filter(Boolean);
        for (const option of optionNames) {
          if (!globalOptions.has(option) && !options.has(option)) {
            problems.push(`${location} unknown option for grow-loop ${key}: ${option}`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

function makeTempDir(prefix = 'grow-loop-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, cwd) {
  const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: cwd || PKG_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GROW_LOOP_STATE_DIR: '' }
  });
  return JSON.parse(stdout);
}

function runCliFailure(args, cwd) {
  try {
    execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: cwd || PKG_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GROW_LOOP_STATE_DIR: '' }
    });
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
  throw new Error(`Expected CLI failure for: ${args.join(' ')}`);
}

function shellQuote(p) {
  return JSON.stringify(p);
}

function fixtureGit(repoDir, ...args) {
  return execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args
  ], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixtureCommit(repoDir, message, ...files) {
  fixtureGit(repoDir, 'add', '--', ...files);
  fixtureGit(repoDir, 'commit', '--no-gpg-sign', '-m', message);
  return fixtureGit(repoDir, 'rev-parse', 'HEAD');
}

function setupCtx(packs, configOverrides = {}) {
  const repoDir = makeTempDir('grow-loop-repo-');
  const stateDir = resolveStateDir(repoDir);
  const baseProfile = JSON.parse(
    fs.readFileSync(path.join(PKG_ROOT, 'profiles', 'standard-test.json'), 'utf8')
  );
  const config = {
    ...baseProfile,
    ...configOverrides,
    routing: { ...baseProfile.routing, ...(configOverrides.routing || {}) },
    budgets: { ...baseProfile.budgets, ...(configOverrides.budgets || {}) },
    review: { ...baseProfile.review, ...(configOverrides.review || {}) },
    blast_radius: { ...baseProfile.blast_radius, ...(configOverrides.blast_radius || {}) },
    executors: {
      self: { kind: 'self', label: 'Host Harness' },
      'tier1-cli': { kind: 'self', label: 'Tier1 Mock', fallback_instance: 'tier1-backup' },
      'tier1-backup': { kind: 'self', label: 'Tier1 Fallback' },
      'tier2-cli': { kind: 'self', label: 'Tier2 Mock' },
      'reviewer-cli': { kind: 'self', label: 'Reviewer Mock' },
      ...(configOverrides.executors || {})
    }
  };
  if (!configOverrides.routing) {
    config.routing.tier1 = 'tier1-cli';
    config.routing.tier2 = 'tier2-cli';
    config.routing.reviewer = 'reviewer-cli';
  }
  const manifest = { project: 'unit-test-proj', packs };
  fs.mkdirSync(stateDir, { recursive: true });
  writeJsonAtomic(path.join(stateDir, 'config.json'), config);
  writeJsonAtomic(path.join(stateDir, 'manifest.json'), manifest);
  const state = createInitialState(repoDir, stateDir, config.profile, manifest);
  saveState(stateDir, state);
  return { repoDir, stateDir, ctx: loadWorkspace(repoDir, stateDir) };
}

test('state dir defaults to <repo>/.loop with auto .gitignore, while external --state-dir leaves repo untouched', () => {
  const repoDir = makeTempDir('grow-loop-gi-');
  const externalStateDir = makeTempDir('grow-loop-ext-');
  try {
    const defaultDir = resolveStateDir(repoDir);
    assert.equal(defaultDir, path.join(repoDir, '.loop'));

    const res1 = ensureGitignoreEntry(repoDir, defaultDir);
    assert.equal(res1.updated, true);
    assert.equal(res1.entry, '.loop/');
    const giContent = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8');
    assert.match(giContent, /^\.loop\/$/m);

    // Idempotent second call
    const res2 = ensureGitignoreEntry(repoDir, defaultDir);
    assert.equal(res2.updated, false);
    assert.equal(res2.reason, 'already_ignored');

    // External state dir never touches repo .gitignore
    const repo2 = makeTempDir('grow-loop-gi2-');
    const resExt = ensureGitignoreEntry(repo2, externalStateDir);
    assert.equal(resExt.updated, false);
    assert.equal(resExt.reason, 'external_state_dir');
    assert.equal(fs.existsSync(path.join(repo2, '.gitignore')), false);
    fs.rmSync(repo2, { recursive: true, force: true });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(externalStateDir, { recursive: true, force: true });
  }
});

test('init without a manifest starts empty and preserves existing files unless forced', () => {
  const repoDir = makeTempDir('grow-loop-init-');
  try {
    const importPath = path.join(repoDir, 'source.json');
    writeJsonAtomic(importPath, { packs: [{ id: 'FIRST' }, { id: 'FIRST' }] });
    const invalid = runCliFailure(['init', '--manifest', 'source.json'], repoDir);
    assert.match(invalid.stderr, /unique non-empty string id/);
    writeJsonAtomic(importPath, null);
    const invalidShape = runCliFailure(['init', '--manifest', 'source.json'], repoDir);
    assert.match(invalidShape.stderr, /manifest must be a JSON object with a packs array/i);
    assert.equal(fs.existsSync(path.join(repoDir, '.loop')), false);

    const init = runCli(['init', '--no-gitignore'], repoDir);
    const paths = getStatePaths(init.state_dir);
    assert.deepEqual(Object.keys(init).sort(), ['files', 'gitignore', 'next_steps', 'ok', 'profile', 'repo_dir', 'state_dir']);
    assert.deepEqual(init.files, { config: paths.configPath, manifest: paths.manifestPath, state: paths.statePath });
    assert.equal(init.gitignore.reason, 'skipped_by_flag');
    assert.equal(fs.existsSync(path.join(repoDir, '.gitignore')), false);
    assert.deepEqual(readJsonSafe(paths.manifestPath).packs, []);
    assert.deepEqual(readJsonSafe(paths.manifestPath), readJsonSafe(paths.manifestSnapshotPath));
    const idle = runCli(['status'], repoDir);
    assert.equal(idle.loop_status, 'IDLE');
    assert.equal(idle.active_pack_id, null);
    assert.deepEqual(idle.packs, []);

    const manifest = { project: 'real-project', packs: [{ id: 'FIRST', title: 'First work package' }] };
    writeJsonAtomic(importPath, manifest);
    const preserved = [paths.configPath, paths.manifestPath, paths.statePath, paths.manifestSnapshotPath];
    const original = preserved.map((file) => fs.readFileSync(file, 'utf8'));
    runCli(['init', '--profile', 'live-smoke'], repoDir);
    assert.deepEqual(preserved.map((file) => fs.readFileSync(file, 'utf8')), original);

    const eventsBefore = fs.readFileSync(paths.eventsPath, 'utf8');
    const conflict = runCliFailure(['init', '--manifest', 'source.json', '--profile', 'live-smoke'], repoDir);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /manifest already exists/i);
    assert.match(conflict.stderr, /init --force --manifest/);
    assert.deepEqual(preserved.map((file) => fs.readFileSync(file, 'utf8')), original);
    assert.equal(fs.readFileSync(paths.eventsPath, 'utf8'), eventsBefore);

    writeJsonAtomic(paths.manifestPath, manifest);
    runCli(['manifest-ack', '--reason', 'The first package is ready'], repoDir);
    const running = readJsonSafe(paths.statePath);
    assert.equal(running.loop_status, 'RUNNING');
    assert.equal(running.active_pack_id, 'FIRST');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('init --force --manifest replaces a pending manifest and resets the workspace', () => {
  const repoDir = makeTempDir('grow-loop-force-init-');
  try {
    const sourcePath = path.join(repoDir, 'source.json');
    writeJsonAtomic(sourcePath, { packs: [{ id: 'OLD', title: 'Original package' }] });
    const { state_dir } = runCli(['init', '--manifest', 'source.json'], repoDir);
    const paths = getStatePaths(state_dir);
    assert.equal(runCli(['next'], repoDir).pack_id, 'OLD');

    writeJsonAtomic(paths.manifestPath, { packs: [{ id: 'OLD', title: 'Pending manual edit' }] });
    const blocked = runCliFailure(['init'], repoDir);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).error, 'manifest_changed');
    const conflict = runCliFailure(['init', '--manifest', 'source.json'], repoDir);
    assert.equal(conflict.status, 1);
    assert.deepEqual(JSON.parse(conflict.stdout), {
      ...JSON.parse(blocked.stdout),
      replace_command: 'grow-loop init --force --manifest <file>'
    });
    const forceWithoutSource = runCliFailure(['init', '--force'], repoDir);
    assert.equal(forceWithoutSource.status, 1);
    assert.deepEqual(JSON.parse(forceWithoutSource.stdout), JSON.parse(blocked.stdout));

    const preserved = [paths.configPath, paths.manifestPath, paths.statePath, paths.manifestSnapshotPath, paths.eventsPath];
    const before = preserved.map((file) => fs.readFileSync(file, 'utf8'));
    const invalid = runCliFailure(['init', '--force', '--manifest', 'missing.json'], repoDir);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--manifest must point to a grow-loop JSON manifest/);
    assert.deepEqual(preserved.map((file) => fs.readFileSync(file, 'utf8')), before);

    const replacement = { project: 'replacement', packs: [{ id: 'NEW' }] };
    writeJsonAtomic(sourcePath, replacement);
    const forced = runCli(['init', '--force', '--manifest', 'source.json', '--profile', 'live-smoke'], repoDir);
    assert.equal(forced.ok, true);
    assert.deepEqual(readJsonSafe(paths.manifestPath), replacement);
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), replacement);
    assert.equal(readJsonSafe(paths.configPath).profile, 'live-smoke');
    const state = readJsonSafe(paths.statePath);
    assert.equal(state.profile, 'live-smoke');
    assert.deepEqual(Object.keys(state.packs), ['NEW']);
    assert.equal(runCli(['status'], repoDir).manifest_change_pending, undefined);
    assert.equal(runCli(['next'], repoDir).pack_id, 'NEW');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('init --handoff preserves plan order and gates preflight until required fields are acknowledged', () => {
  const repoDir = makeTempDir('grow-loop-handoff-init-');
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const sourceFile = 'task.manifest.json';
  const first = {
    id: 'W9', title: 'First package', goal: 'Prepare the changes', depends_on: [],
    acceptance_criteria: ['AC-15 · Checklist is complete'],
    open_questions: ['Which fixture should be migrated?'],
    external_effects: ['Replace the fixture data'],
    scope_files: [], tags: []
  };
  const second = {
    id: 'W2', title: 'Second package', goal: 'Verify the changes', depends_on: ['W9'],
    acceptance_criteria: [], open_questions: [], external_effects: [],
    scope_files: ['src/verify.mjs'], tags: ['verification']
  };
  const source = { project: 'test-project', upstream_source: 'test-plan', packs: [first, second] };
  const needs = ['scope_files', 'risk', 'tags'];
  try {
    writeJsonAtomic(path.join(repoDir, sourceFile), source);
    assert.match(fail('init', '--manifest', sourceFile, '--handoff', sourceFile).stderr, /Specify exactly one/);
    const init = cli('init', '--handoff', sourceFile);
    assert.deepEqual(init.imported_packs, [{ id: 'W9', needs }, { id: 'W2', needs: ['risk'] }]);
    assert.ok(init.next_steps.some((step) => step.includes('manifest-ack')));
    const paths = getStatePaths(init.state_dir);
    const manifest = readJsonSafe(paths.manifestPath);
    assert.deepEqual(manifest, {
      ...source,
      packs: [
        { ...first, upstream_ref: 'test-plan#W9', handoff: { source: 'test-plan', needs } },
        { ...second, upstream_ref: 'test-plan#W2', handoff: { source: 'test-plan', needs: ['risk'] } }
      ]
    });
    assert.deepEqual(cli('status').packs.map(({ id, needs }) => ({ id, needs })), init.imported_packs);
    const state = readJsonSafe(paths.statePath);
    assert.equal(state.packs.W9.status, 'PENDING');
    const fill = cli('next');
    assert.equal(fill.action, 'NEEDS_FILL');
    assert.equal(fill.pack_id, 'W9');
    assert.deepEqual(fill.needs, needs);
    assert.ok(fill.next_steps.some((step) => step.includes('pack scope')));
    const shell = cli('status', '--format', 'shell');
    assert.deepEqual(shell.question, fill.question);
    assert.equal(shell.now.waiting_for, 'human');
    assert.equal(shell.now.reason, 'NEEDS_FILL');
    assert.deepEqual(shell.question.options, []);
    assert.equal(shell.question.answer_command, null);
    for (const field of needs) assert.ok(shell.question.body.includes(field));
    assert.match(shell.question.body, /manifest\.json/);
    const blocked = fail('dispatch', '--dry-run');
    assert.match(blocked.stderr, /finish handoff preflight/);
    assert.deepEqual(JSON.parse(blocked.stdout).question, fill.question);
    assert.match(fail('record', 'implement', '--passed').stderr, /finish handoff preflight/);
    assert.deepEqual(readJsonSafe(paths.statePath), state);
    assert.ok(!readEvents(paths.eventsPath).some(({ type }) => type === 'preflight_evaluated'));

    cli('pack', 'scope', '--id', 'W9', '--add', 'src/fixture.mjs', '--reason', 'Fixture scope');
    assert.deepEqual(cli('next').needs, ['risk', 'tags']);
    const partial = readJsonSafe(paths.manifestPath);
    Object.assign(partial.packs[0], { risk: 'unknown', tags: ['fixtures'] });
    writeJsonAtomic(paths.manifestPath, partial);
    assert.equal(JSON.parse(fail('next').stdout).error, 'manifest_changed');
    cli('manifest-ack', '--reason', 'Classify the work');
    assert.deepEqual(cli('next').needs, ['risk']);
    partial.packs[0].risk = 'high';
    writeJsonAtomic(paths.manifestPath, partial);
    cli('manifest-ack', '--reason', 'Confirm risk');

    const ambiguity = cli('next');
    assert.equal(ambiguity.gate.reason, ALLOWED_GATE_REASONS.AMBIGUITY);
    assert.deepEqual(ambiguity.gate.questions, first.open_questions);
    assert.deepEqual(readJsonSafe(paths.manifestPath).packs[0].handoff.needs, []);
    assert.equal(cli('status').packs[0].needs, undefined);
    assert.equal(cli('status').manifest_change_pending, undefined);
    assert.match(fail('dispatch', '--dry-run').stderr, /finish handoff preflight/);
    const effect = cli('resume', '--decision', 'Use the test fixture', '--action', 'approve').next;
    assert.equal(effect.gate.reason, ALLOWED_GATE_REASONS.EXTERNAL_EFFECT);
    assert.deepEqual(effect.gate.questions, first.external_effects);
    const implementation = cli('resume', '--decision', 'Approve replacing the fixture', '--action', 'approve').next;
    assert.equal(implementation.action, 'IMPLEMENT');
    assert.equal(implementation.tier, 'tier2');
    assert.ok(implementation.warnings.some((warning) => warning.includes('避坑提示')));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('import --handoff audits appends and init --force --handoff shares the replacement rules', () => {
  const repoDir = makeTempDir('grow-loop-handoff-import-');
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const file = 'handoff.json';
  const filePath = path.join(repoDir, file);
  const importedPack = {
    id: 'W8', title: 'Review the fixture', goal: 'Review the result', depends_on: ['LOCAL'],
    acceptance_criteria: ['Fixture checks pass'], open_questions: [], external_effects: [],
    scope_files: ['src/fixture.mjs'], tags: ['fixtures']
  };
  const report = {
    valid: true, errors: [], requirements: [], criteria: [], work_entries: [],
    revision: 4, limits: {}, packs: [importedPack]
  };
  try {
    writeJsonAtomic(path.join(repoDir, 'local.json'), { project: 'local', packs: [{ id: 'LOCAL' }] });
    const { state_dir } = cli('init', '--manifest', 'local.json');
    const paths = getStatePaths(state_dir);
    const append = ['import', '--handoff', file, '--reason', 'Append planned review'];
    assert.match(fail('import', '--handoff', file).stderr, /non-empty --reason/);
    assert.match(fail('init', '--handoff', file).stderr, /init --force --handoff/);

    writeJsonAtomic(filePath, { ...report, valid: false, errors: ['Missing goal', 'Missing criterion'] });
    assert.match(fail(...append).stderr, /Missing goal[\s\S]*Missing criterion/);
    writeJsonAtomic(filePath, { ...report, errors: ['Invalid dependency'] });
    assert.match(fail(...append).stderr, /Invalid dependency/);
    writeJsonAtomic(filePath, { ...report, packs: [{ ...importedPack, depends_on: ['UNKNOWN'] }] });
    assert.match(fail(...append).stderr, /depends on unknown pack UNKNOWN/);
    assert.deepEqual(cli('status').packs.map(({ id }) => id), ['LOCAL']);

    writeJsonAtomic(filePath, report);
    assert.deepEqual(cli(...append).imported_packs, [{ id: 'W8', needs: ['risk'] }]);
    assert.match(fail(...append).stderr, /Pack W8 already exists/);
    const manifest = readJsonSafe(paths.manifestPath);
    assert.equal(manifest.project, 'local');
    assert.deepEqual(manifest.packs.map(({ id }) => id), ['LOCAL', 'W8']);
    assert.deepEqual(manifest.packs[1], {
      ...importedPack, upstream_ref: 'handoff.json (revision 4)#W8',
      handoff: { source: 'handoff.json (revision 4)', needs: ['risk'] }
    });
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), manifest);
    const writes = readEvents(paths.eventsPath).filter(({ type }) => type === 'manifest_changed');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].reason, 'Append planned review');
    assert.equal(writes[0].source, 'handoff_import');
    assert.deepEqual(writes[0].changes.added_packs, ['W8']);
    assert.equal(cli('next').action, 'IMPLEMENT');

    manifest.packs[0].title = 'Pending edit';
    writeJsonAtomic(paths.manifestPath, manifest);
    assert.equal(JSON.parse(fail(...append).stdout).error, 'manifest_changed');
    assert.equal(JSON.parse(fail('init', '--handoff', file).stdout).replace_command, 'grow-loop init --force --handoff <file>');
    assert.match(fail('init', '--force', '--handoff', file).stderr, /depends on unknown pack LOCAL/);
    assert.deepEqual(readJsonSafe(paths.manifestPath), manifest);

    writeJsonAtomic(filePath, { ...report, packs: [{ ...importedPack, depends_on: [] }] });
    cli('init', '--force', '--handoff', file, '--profile', 'live-smoke');
    const replacement = readJsonSafe(paths.manifestPath);
    assert.equal(replacement.project, 'handoff');
    assert.equal(replacement.upstream_source, 'handoff.json (revision 4)');
    assert.deepEqual(replacement.packs.map(({ id }) => id), ['W8']);
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), replacement);
    const status = cli('status');
    assert.equal(status.profile, 'live-smoke');
    assert.equal(status.active_pack_id, 'W8');
    assert.equal(status.manifest_change_pending, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('handoff decisions reach the brief verbatim and malformed decisions stop at every manifest entry', () => {
  const repoDir = makeTempDir('grow-loop-handoff-decisions-');
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const decision = '你选：邮件 通知；短信\n你的原话：  都要 `notify()`\r ';
  const pack = {
    id: 'W1', title: 'Notify', goal: 'Send the notice', depends_on: [],
    acceptance_criteria: [], open_questions: [], external_effects: [],
    decisions: [{ question: '用哪种通知？', decision }],
    scope_files: ['src/notify.mjs'], tags: ['notify']
  };
  const plan = (packs) => ({ project: 'notify', upstream_source: 'plan', packs });
  try {
    writeJsonAtomic(path.join(repoDir, 'renamed.json'), plan([{ ...pack, decisions: [{ question: '用哪种通知？', answer: decision }] }]));
    for (const flag of ['--handoff', '--manifest']) {
      assert.match(fail('init', flag, 'renamed.json').stderr, /Pack W1 decisions\[0\]\.decision must be a non-empty string with the verbatim answer\. Rename answer to decision\./);
    }
    writeJsonAtomic(path.join(repoDir, 'task.manifest.json'), plan([pack]));
    const init = cli('init', '--handoff', 'task.manifest.json');
    const paths = getStatePaths(init.state_dir);
    const manifest = readJsonSafe(paths.manifestPath);
    assert.deepEqual(manifest.packs[0].decisions, [{ question: '用哪种通知？', decision, at: null }]);

    manifest.packs[0].risk = 'low';
    manifest.packs[0].decisions.push({ question: ' ', decision: '另起一条' });
    writeJsonAtomic(paths.manifestPath, manifest);
    assert.ok(cli('status').manifest_change_pending);
    assert.match(fail('manifest-ack', '--reason', 'Fill risk').stderr, /Pack W1 decisions\[1\]\.question must be a non-empty string\./);
    manifest.packs[0].decisions.pop();
    writeJsonAtomic(paths.manifestPath, manifest);
    cli('manifest-ack', '--reason', 'Fill risk');
    assert.equal(cli('next').action, 'IMPLEMENT');
    const task = fs.readFileSync(path.join(cli('dispatch', '--dry-run').run_dir, 'task.md'), 'utf8');
    assert.ok(task.includes('- 方案问题：用哪种通知？（时间：未记录）'));
    assert.ok(task.includes('\n' + decision + '\n'));

    // An older workspace whose accepted snapshot holds a malformed entry still reads and can be repaired.
    manifest.packs[0].decisions = [{ question: '用哪种通知？', answer: '旧字段' }];
    writeJsonAtomic(paths.manifestPath, manifest);
    writeJsonAtomic(paths.manifestSnapshotPath, manifest);
    assert.equal(cli('status').manifest_change_pending, undefined);
    manifest.packs[0].decisions = [{ question: '用哪种通知？', decision: '旧字段' }];
    writeJsonAtomic(paths.manifestPath, manifest);
    cli('manifest-ack', '--reason', 'Rename the old field');
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath).packs[0].decisions, manifest.packs[0].decisions);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('the confirmed manifest replaces a removed active pack, preserves history, and reopens a completed loop', () => {
  const repoDir = makeTempDir('grow-loop-manifest-sync-');
  try {
    const manifest = {
      project: 'checkout',
      packs: [
        { id: 'REMOVED', title: 'Remove legacy checkout' },
        { id: 'DONE', title: 'Validate checkout', risk: 'low' },
        { id: 'KEEP', title: 'Update checkout docs' }
      ]
    };
    const importPath = path.join(repoDir, 'delivery.json');
    writeJsonAtomic(importPath, manifest);
    const init = runCli(['init', '--manifest', importPath], repoDir);
    const paths = getStatePaths(init.state_dir);
    assert.deepEqual(readJsonSafe(paths.manifestPath), manifest);
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), manifest);
    assert.deepEqual(runCli(['status'], repoDir).packs.map(({ id }) => id), ['REMOVED', 'DONE', 'KEEP']);

    runCli(['record', 'commit', '--pack', 'DONE', '--sha', '123456789'], repoDir);
    assert.equal(runCli(['next'], repoDir).pack_id, 'REMOVED');
    const before = readJsonSafe(paths.statePath);
    assert.equal(before.active_pack_id, 'REMOVED');

    manifest.packs = [
      { ...manifest.packs[1], title: 'Reworded title', risk: 'high' },
      { id: 'NEXT', title: 'Enable the new checkout' },
      manifest.packs[2]
    ];
    writeJsonAtomic(paths.manifestPath, manifest);
    runCli(['manifest-ack', '--reason', 'Ship the new checkout first'], repoDir);
    const after = readJsonSafe(paths.statePath);
    assert.equal(after.active_pack_id, 'NEXT');
    assert.equal(after.loop_status, 'RUNNING');
    assert.deepEqual(after.pack_order, ['DONE', 'NEXT', 'KEEP']);
    assert.deepEqual(after.packs.REMOVED, before.packs.REMOVED);
    assert.deepEqual(after.packs.DONE, before.packs.DONE);
    assert.equal(runCli(['next'], repoDir).pack_id, 'NEXT');

    runCli(['record', 'commit', '--sha', '234567891'], repoDir);
    assert.equal(runCli(['record', 'commit', '--sha', '345678912'], repoDir).loop_status, 'COMPLETED');
    manifest.packs.push({ id: 'FOLLOWUP', title: 'Verify the rollout' });
    writeJsonAtomic(paths.manifestPath, manifest);
    assert.equal(runCli(['status'], repoDir).loop_status, 'COMPLETED');
    runCli(['manifest-ack', '--reason', 'Add rollout verification'], repoDir);
    const reopened = readJsonSafe(paths.statePath);
    assert.equal(reopened.loop_status, 'RUNNING');
    assert.equal(reopened.active_pack_id, 'FOLLOWUP');
    assert.equal(runCli(['next'], repoDir).pack_id, 'FOLLOWUP');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('workspace commands block on manifest changes until a reason is recorded', () => {
  const repoDir = makeTempDir('grow-loop-manifest-ack-');
  try {
    const manifest = {
      project: 'checkout',
      packs: [
        { id: 'A', acceptance_criteria: ['Refund is recorded'], tags: ['billing'] },
        { id: 'B' },
        { id: 'C' }
      ]
    };
    const sourcePath = path.join(repoDir, 'source.json');
    writeJsonAtomic(sourcePath, manifest);
    const { state_dir } = runCli(['init', '--manifest', sourcePath], repoDir);
    const paths = getStatePaths(state_dir);
    const original = runCli(['status'], repoDir);
    const unchangedFiles = [paths.statePath, paths.manifestSnapshotPath, paths.eventsPath];
    const before = unchangedFiles.map((file) => fs.readFileSync(file, 'utf8'));
    const edited = {
      packs: [
        { id: 'B' },
        { id: 'A', acceptance_criteria: ['Refund and receipt are recorded'], access_token: 'dummy-value' },
        { id: 'D' }
      ],
      project: 'payments'
    };
    writeJsonAtomic(paths.manifestPath, edited);
    const commands = [['init', '--force'], ['probe'], ['next'], ['dispatch'], ['verify'], ['record', 'lesson'], ['resume'], ['evidence']];
    const expected = {
      added_packs: ['D'],
      removed_packs: ['C'],
      order_changed: true,
      old_order: ['A', 'B', 'C'],
      new_order: ['B', 'A', 'D'],
      changed_packs: [{
        id: 'A',
        fields: [
          { field: 'acceptance_criteria', old_value: ['Refund is recorded'], new_value: ['Refund and receipt are recorded'] },
          { field: 'tags', old_value: ['billing'], new_value: null, new_missing: true },
          { field: 'access_token', old_value: null, new_value: '[REDACTED:SECRET]', old_missing: true }
        ]
      }],
      manifest_fields: [{ field: 'project', old_value: 'checkout', new_value: 'payments' }]
    };
    const ack = 'grow-loop manifest-ack --reason "<reason>"';
    for (const args of commands) {
      const blocked = runCliFailure(args, repoDir);
      assert.equal(blocked.status, 1);
      const result = JSON.parse(blocked.stdout);
      assert.equal(result.error, 'manifest_changed');
      assert.equal(result.ack_command, ack);
      assert.deepEqual(result.changes, expected);
    }
    assert.deepEqual(runCli(['status'], repoDir), {
      ...original,
      manifest_change_pending: { changes: expected, ack_command: ack }
    });
    for (const args of [[], ['--reason'], ['--reason', ''], ['--reason', '   ']]) {
      const invalid = runCliFailure(['manifest-ack', ...args], repoDir);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /non-empty --reason/);
    }
    assert.deepEqual(unchangedFiles.map((file) => fs.readFileSync(file, 'utf8')), before);

    const reason = 'Include the receipt in refund acceptance';
    assert.deepEqual(runCli(['manifest-ack', '--reason', reason], repoDir).changes, expected);
    const event = readEvents(paths.eventsPath).at(-1);
    assert.equal(event.type, 'manifest_changed');
    assert.equal(event.source, 'manifest_ack');
    assert.equal(event.reason, reason);
    assert.deepEqual(event.changes, expected);
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), edited);
    assert.equal(runCli(['next'], repoDir).pack_id, 'A');

    // Object key order and whitespace have no effect on the comparison.
    fs.writeFileSync(paths.manifestPath, JSON.stringify({ project: edited.project, packs: edited.packs }), 'utf8');
    assert.equal(runCli(['status'], repoDir).manifest_change_pending, undefined);
    assert.match(runCli(['manifest-ack', '--reason', 'Check for edits'], repoDir).message, /no manifest changes/i);
    assert.equal(readEvents(paths.eventsPath).filter(({ type }) => type === 'manifest_changed').length, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('shell status and answer acknowledge a changed manifest, reject stale questions and resume with verbatim text', () => {
  const { repoDir, ctx } = setupCtx([
    { id: 'W1', title: '确认界面行为', open_questions: ['是否保留单选？'] },
    { id: 'W2', title: '验证界面行为', depends_on: ['W1'] }
  ]);
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const status = () => cli('status', '--format', 'shell');
  const answer = (question, option) => ['answer', '--question', question.id, '--option', option];
  try {
    const { question: gate } = cli('next');
    assert.equal(gate.kind, 'AMBIGUITY');
    assert.match(gate.body, /是否保留单选/);
    assert.deepEqual(status().question, gate);
    ctx.manifest.packs[0].acceptance_criteria = ['保留单选'];
    writeJsonAtomic(ctx.paths.manifestPath, ctx.manifest);
    const pending = status();
    assert.equal(pending.schema, 'grow-loop.status/1');
    assert.equal(pending.loop_status, 'RUNNING');
    assert.equal(pending.active_pack_id, 'W1');
    assert.deepEqual(pending.now, {
      pack_id: 'W1', phase: 'MANIFEST_CHANGED', waiting_for: 'human', reason: 'MANIFEST_CHANGED',
      next_command: pending.question.answer_command
    });
    assert.deepEqual(pending.packs, [
      { id: 'W1', title: '确认界面行为', status: 'PAUSED_FOR_HUMAN', tier: 'tier1', instance: 'tier1-cli',
        tier1_repairs: 0, tier2_repairs: 0, review_rounds: 0, needs: [], inflight_run: null, commit: null,
        completed_externally: null, gate: 'AMBIGUITY' },
      { id: 'W2', title: '验证界面行为', status: 'PENDING', tier: null, instance: null,
        tier1_repairs: 0, tier2_repairs: 0, review_rounds: 0, needs: [], inflight_run: null, commit: null,
        completed_externally: null, gate: null }
    ]);
    assert.deepEqual(pending.pending, {
      manifest_change: cli('status').manifest_change_pending, lesson_drafts: 0, open_todos: 0, in_round_tech_debt: 0
    });
    assert.deepEqual(JSON.parse(fail('next').stdout).question, pending.question);
    assert.deepEqual(status().question, pending.question);
    assert.equal(pending.question.options[0].label, '确认这些改动');
    assert.match(fail(...answer(gate, 'approve'), '--text', '同意').stderr, /重新运行 grow-loop status --format shell/);
    assert.match(fail(...answer(pending.question, 'confirm')).stderr, /非空的 --text/);

    ctx.manifest.packs[0].acceptance_criteria.push('核对键盘操作');
    writeJsonAtomic(ctx.paths.manifestPath, ctx.manifest);
    assert.match(fail(...answer(pending.question, 'confirm'), '--text', '过期回答').stderr, /已经变化/);
    const { question: latest } = status();
    assert.notEqual(latest.id, pending.question.id);
    const reason = '--补充验收\n确认键盘操作。  ';
    assert.equal(cli(...answer(latest, 'confirm'), `--text=${reason}`).ok, true);
    assert.equal(readEvents(ctx.paths.eventsPath).at(-1).details.answer_text, reason);
    assert.equal(status().pending.manifest_change, null);
    assert.match(fail(...answer(latest, 'confirm'), '--text', reason).stderr, /已经变化/);

    const reopened = status();
    assert.equal(reopened.now.reason, 'AMBIGUITY');
    assert.deepEqual(reopened.question.options.map(({ id, needs_text }) => [id, needs_text]), [['approve', true], ['abort', false]]);
    assert.match(fail(...answer(reopened.question, 'repair')).stderr, /没有该选项/);
    assert.match(fail(...answer(reopened.question, 'approve'), '--text', '   ').stderr, /非空的 --text/);
    const decision = '  按单选执行。\n键盘操作照旧。  ';
    const approval = cli(...answer(reopened.question, 'approve'), '--text', decision);
    assert.equal(approval.next.action, 'IMPLEMENT');
    assert.equal(readEvents(ctx.paths.eventsPath).find(({ type }) => type === 'gate_resumed').decision, decision);
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.W1.resolved_gates.AMBIGUITY.decision, decision);
    assert.deepEqual(status().now, {
      pack_id: 'W1', phase: 'IMPLEMENT', waiting_for: 'coordinator', reason: null, next_command: 'grow-loop dispatch --dry-run'
    });
    const taskFile = path.join(cli('dispatch', '--dry-run').run_dir, 'task.md');
    const task = fs.readFileSync(taskFile, 'utf8').split('## 已经定了的')[1];
    assert.ok(task.includes(`\n${reason}\n`) && task.includes(`\n${decision}\n`));
    assert.equal(status().now.next_command, 'grow-loop dispatch');
    assert.equal(status().question, null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('legacy workspaces seed a snapshot and internal manifest writes are audited immediately', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A' }]);
  try {
    const { paths } = ctx;
    fs.unlinkSync(paths.manifestSnapshotPath);
    const legacyManifest = { ...ctx.manifest, packs: [{ id: 'B' }] };
    writeJsonAtomic(paths.manifestPath, legacyManifest);
    assert.equal(runCli(['next'], repoDir).pack_id, 'B');
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), legacyManifest);
    assert.equal(readEvents(paths.eventsPath).some(({ type }) => type === 'manifest_changed'), false);

    const loaded = loadWorkspace(repoDir);
    const nextManifest = { ...loaded.manifest, packs: [...loaded.manifest.packs, { id: 'C' }] };
    const reason = 'Schedule a follow-up';
    const changes = writeManifestWithReason(loaded, nextManifest, reason, 'internal_test');
    assert.deepEqual(changes.added_packs, ['C']);
    assert.equal(changes.order_changed, false);
    assert.deepEqual(readJsonSafe(paths.manifestPath), nextManifest);
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), nextManifest);
    assert.deepEqual(readJsonSafe(paths.statePath).pack_order, ['B', 'C']);
    const event = readEvents(paths.eventsPath).at(-1);
    assert.equal(event.type, 'manifest_changed');
    assert.equal(event.source, 'internal_test');
    assert.equal(event.reason, reason);
    assert.deepEqual(runCli(['status'], repoDir).packs.map(({ id }) => id), ['B', 'C']);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mid-loop pack commands audit insertions, pending tier overrides, scope and forwarded findings', () => {
  const { repoDir, ctx } = setupCtx([
    { id: 'A', scope_files: ['src/a.mjs'], estimated_files: 1 },
    { id: 'B', depends_on: ['A'], risk: 'high', estimated_files: 52, open_questions: ['保留旧入口？'] },
    { id: 'C', depends_on: ['A', 'B'] }
  ]);
  const { paths } = ctx;
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const definition = path.join(repoDir, 'pack.json');
  try {
    fs.writeFileSync(definition, '\uFEFF' + JSON.stringify({ id: 'PRE', goal: '准备一份测试数据' }), 'utf8');
    const before = cli('pack', 'insert', '--file', definition, '--before', 'A', '--reason', '补前置数据');
    assert.deepEqual(before, { ok: true, pack_id: 'PRE', position: 'before', anchor_id: 'A', index: 0, updated_dependencies: ['A'] });
    assert.equal(cli('next').pack_id, 'PRE');

    writeJsonAtomic(definition, { id: 'MID', goal: '核对回执' });
    assert.match(fail('pack', 'insert', '--file', definition, '--before', 'PRE', '--reason', '前插').stderr, /Use --after PRE/);
    const after = cli('pack', 'insert', '--file', definition, '--after', 'A', '--reason', '先核对回执');
    assert.deepEqual(after, { ok: true, pack_id: 'MID', position: 'after', anchor_id: 'A', index: 2, updated_dependencies: ['B', 'C'] });

    cli('pack', 'tier', '--id', 'B', '--tier', 'tier1', '--reason', '人工确认采用一档');
    assert.equal(readJsonSafe(paths.statePath).packs.B.current_tier, null);
    cli('pack', 'scope', '--id', 'A', '--add', 'src/a.mjs,src/b.mjs', '--add', 'src/c.mjs', '--reason', '补齐授权文件');
    cli('forward', '--from', 'A', '--to', 'B', '--text', '检查旧客户端', '--reason', 'B 负责兼容性');
    const manifest = readJsonSafe(paths.manifestPath);
    assert.deepEqual(manifest.packs.map(({ id, depends_on }) => [id, depends_on]), [
      ['PRE', undefined], ['A', ['PRE']], ['MID', ['A']], ['B', ['A', 'MID']], ['C', ['A', 'B', 'MID']]
    ]);
    assert.deepEqual(manifest.packs[1].scope_files, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
    assert.equal(manifest.packs[1].estimated_files, 3);
    assert.equal(manifest.packs[3].tier, 'tier1');
    assert.deepEqual(readJsonSafe(paths.manifestSnapshotPath), manifest);
    assert.equal(cli('status').manifest_change_pending, undefined);
    const audited = readEvents(paths.eventsPath).filter(({ type }) => type === 'manifest_changed');
    assert.deepEqual(audited.map(({ source, reason }) => [source, reason]), [
      ['pack_insert', '补前置数据'], ['pack_insert', '先核对回执'], ['pack_tier', '人工确认采用一档'],
      ['pack_scope', '补齐授权文件'], ['forward', 'B 负责兼容性']
    ]);
    assert.deepEqual(audited[1].details.updated_dependencies, ['B', 'C']);
    assert.equal(audited[1].details.anchor_id, 'A');

    for (const id of ['PRE', 'A', 'MID']) {
      assert.equal(cli('next').pack_id, id);
      cli('record', 'commit', '--sha', '123456789');
    }
    assert.equal(cli('next').gate.reason, ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT);
    assert.equal(cli('resume', '--decision', '批准按现有范围继续').next.gate.reason, ALLOWED_GATE_REASONS.AMBIGUITY);
    cli('resume', '--decision', '保留旧入口');
    assert.equal(cli('next').tier, 'tier1');
    assert.match(readJsonSafe(paths.statePath).packs.B.blast_radius.reasons.join(' '), /manual tier=tier1/);

    manifest.packs[3].acceptance_criteria = ['旧客户端仍能打开'];
    writeJsonAtomic(paths.manifestPath, manifest);
    assert.equal(JSON.parse(fail('pack', 'tier', '--id', 'B', '--tier', 'tier2', '--reason', '待确认').stdout).error, 'manifest_changed');
    cli('manifest-ack', '--reason', '验收覆盖旧入口');
    const ack = readEvents(paths.eventsPath).at(-1);
    assert.equal(ack.reason, '验收覆盖旧入口');
    assert.equal(ack.changes.changed_packs[0].fields[0].field, 'acceptance_criteria');

    const task = (...args) => fs.readFileSync(path.join(cli('dispatch', '--dry-run', ...args).run_dir, 'task.md'), 'utf8');
    assert.match(task(), /## 转来的发现\n- 来源包 A。原因：B 负责兼容性\n  检查旧客户端/);
    cli('record', 'implement', '--failed');
    const repair = task();
    assert.match(repair, /REPAIR/);
    assert.match(repair, /## 转来的发现/);
    assert.match(repair, /旧客户端仍能打开/);
    assert.doesNotMatch(task('--stage', 'review'), /转来的发现|超范围没改/);

    writeJsonAtomic(definition, { id: 'LATE', depends_on: [] });
    assert.match(fail('pack', 'insert', '--file', definition, '--before', 'MID', '--reason', '前插').stderr, /Use --after MID/);
    cli('pack', 'insert', '--file', definition, '--after', 'PRE', '--reason', '记录独立后续工作');
    const updated = readJsonSafe(paths.manifestPath);
    assert.deepEqual(updated.packs.find(({ id }) => id === 'LATE').depends_on, []);
    assert.deepEqual(updated.packs.find(({ id }) => id === 'A').depends_on, ['PRE']);
    assert.equal(cli('status').active_pack_id, 'B');
    for (const args of [
      ['pack', 'tier', '--id', 'A', '--tier', 'tier2'],
      ['pack', 'scope', '--id', 'A', '--add', 'src/d.mjs'],
      ['forward', '--to', 'A', '--text', '新发现']
    ]) assert.match(fail(...args, '--reason', '尝试改已完成的包').stderr, /already committed/);
    assert.deepEqual(readJsonSafe(paths.manifestPath), updated);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('out-of-scope todos can be added, expanded, forwarded and dismissed with an audit trail', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', estimated_files: 9 }, { id: 'B' }]);
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  try {
    delete ctx.state.todos;
    saveState(ctx.stateDir, ctx.state);
    assert.deepEqual(cli('todo', 'list').todos, []);
    for (const args of [
      ['pack', 'insert', '--file', 'pack.json', '--after', 'A'],
      ['pack', 'tier', '--id', 'A', '--tier', 'tier2'],
      ['pack', 'scope', '--id', 'A', '--add', 'lib.mjs'],
      ['forward', '--to', 'B', '--text', '检查参数'],
      ['todo', 'add', '--pack', 'A', '--text', '检查参数'],
      ['todo', 'dismiss', '--todo', 'T001']
    ]) assert.match(fail(...args, '--reason', '  ').stderr, /non-empty --reason/);

    const add = (content) => cli('todo', 'add', '--pack', 'A', '--text', content, '--reason', '指挥手动记录').todo;
    const expanded = add('src/lib.mjs：补参数检查');
    const forwarded = add('src/client.mjs：补兼容性');
    const dismissed = add('src/retry.mjs：检查超时');
    assert.equal(expanded.run_id, null);
    assert.equal(expanded.pack_id, 'A');
    assert.deepEqual(cli('status').open_todos.map(({ id }) => id), [expanded.id, forwarded.id, dismissed.id]);
    assert.deepEqual(readJsonSafe(ctx.paths.manifestPath), ctx.manifest);

    assert.match(fail('forward', '--to', 'B', '--text', '检查参数', '--todo', forwarded.id, '--reason', '选一个').stderr, /exactly one/);
    cli('pack', 'scope', '--id', 'A', '--add', 'src/lib.mjs', '--todo', expanded.id, '--reason', '归到本包');
    cli('forward', '--to', 'B', '--todo', forwarded.id, '--reason', '交给 B');
    cli('todo', 'dismiss', '--todo', dismissed.id, '--reason', '现有逻辑覆盖');
    assert.match(fail('todo', 'dismiss', '--todo', expanded.id, '--reason', '重复关闭').stderr, /already expanded/);
    assert.deepEqual(cli('todo', 'list').todos.map(({ status, target_pack_id }) => [status, target_pack_id]), [
      ['expanded', 'A'], ['forwarded', 'B'], ['dismissed', undefined]
    ]);
    assert.deepEqual(cli('status').open_todos, []);
    const [a, b] = readJsonSafe(ctx.paths.manifestPath).packs;
    assert.equal(a.estimated_files, 9);
    assert.deepEqual(b.forwarded_findings[0], {
      from_pack_id: 'A', content: forwarded.content, reason: '交给 B', at: b.forwarded_findings[0].at
    });
    assert.ok(Number.isFinite(Date.parse(b.forwarded_findings[0].at)));
    const events = readEvents(ctx.paths.eventsPath);
    assert.equal(events.filter(({ type, reason }) => type === 'todo_added' && reason === '指挥手动记录').length, 3);
    assert.equal(events.find(({ source }) => source === 'pack_scope').details.todo_id, expanded.id);
    assert.equal(events.find(({ source }) => source === 'forward').details.todo_id, forwarded.id);
    assert.equal(events.at(-1).type, 'todo_dismissed');
    assert.equal(events.at(-1).reason, '现有逻辑覆盖');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('pack scope rejects directories before changing scope, state or a todo', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'] }]);
  try {
    fs.mkdirSync(path.join(repoDir, 'fixtures', 'nested'), { recursive: true });
    const { todo } = runCli(['todo', 'add', '--pack', 'A', '--text', '补测试', '--reason', '待确认范围'], repoDir);
    const { manifestPath, manifestSnapshotPath, statePath, eventsPath } = ctx.paths;
    const tracked = [manifestPath, manifestSnapshotPath, statePath, eventsPath];
    const snapshot = () => tracked.map((file) => fs.readFileSync(file, 'utf8'));
    const before = snapshot();

    for (const [directory, additions] of [
      ['tests/', ['--add', 'tests/']],
      ['missing\\', ['--add=missing\\']],
      ['fixtures\\nested', ['--add', 'fixtures\\nested']],
      ['fixtures', ['--add', 'src/good.mjs,fixtures']],
      ['fixtures', ['--add', 'src/good.mjs', '--add', 'fixtures']]
    ]) {
      const failure = runCliFailure([
        'pack', 'scope', '--id', 'A', ...additions, '--todo', todo.id, '--reason', '补具体文件'
      ], repoDir);
      assert.equal(failure.status, 1);
      assert.ok(failure.stderr.includes(`「${directory}」是目录，请列出具体文件。`), failure.stderr);
      assert.deepEqual(snapshot(), before);
    }
    assert.deepEqual(runCli(['todo', 'list'], repoDir).todos.map(({ id, status }) => [id, status]), [[todo.id, 'open']]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('running Codex dispatch keeps its task and route while final markdown produces open todos', async () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const ready = path.join(repoDir, 'executor-ready');
  const release = path.join(repoDir, 'executor-release');
  const mock = path.join(repoDir, 'mock-codex.cjs');
  const finalPath = path.join(repoDir, 'mock-response.md');
  const final = [
    '## Summary', '- Other: ignore this', '```md', '## 超范围没改', '- Fenced: ignore this', '## 没做完', '示例', '```',
    '### 超范围没改', '- src/out.mjs：抽取共享校验', '', '无效行', '- 未说明：',
    '## 超范围没改（2 项）', '1. 补异常处理', '* src/another.mjs: 补异常处理', '- [ ] 暂无。',
    '## Other', '- Outside: ignore this',
    '超范围没改的补充', '---', '- 记录跨包依赖', '- **没有**'
  ].join('\r\n');
  try {
    fs.writeFileSync(finalPath, final, 'utf8');
    fs.writeFileSync(mock, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      process.stdin.resume();
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'running-executor-session' }));
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], fs.readFileSync(${JSON.stringify(finalPath)}, 'utf8'));
        console.log(JSON.stringify({ thread_id: 'old-executor-session' }));
      }, 25);
    `);
    ctx.config.executors['tier1-cli'] = { kind: 'codex', executable: process.execPath, prefix_args: [mock] };
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');
    cli('record', 'implement', '--failed', '--session-id', 'old-executor-session');
    const running = promisify(execFile)(process.execPath, [CLI_PATH, 'dispatch', '--resume', '--timeout', '20'], {
      cwd: repoDir, encoding: 'utf8', env: { ...process.env, GROW_LOOP_STATE_DIR: '' }
    });
    // Attach before polling so a failing mock cannot cause an unhandled rejection.
    running.catch(() => {});
    try {
      for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await delay(25);
      assert.ok(fs.existsSync(ready), 'Codex fixture did not start');
      const pending = () => readJsonSafe(ctx.paths.statePath).packs.A.inflight_run?.session_id;
      for (let i = 0; i < 200 && pending() !== 'running-executor-session'; i++) await delay(25);
      assert.equal(cli('status').packs[0].inflight_run.session_id, 'running-executor-session');
      const shell = cli('status', '--format', 'shell');
      assert.equal(shell.now.waiting_for, 'executor');
      assert.equal(shell.now.next_command, null);
      assert.deepEqual(shell.packs[0].inflight_run, { stage: 'implement', started_at: readJsonSafe(ctx.paths.statePath).packs.A.inflight_run.started_at });
      cli('pack', 'tier', '--id', 'A', '--tier', 'tier2', '--reason', '切到二档接力');
      cli('pack', 'scope', '--id', 'A', '--add', 'src/b.mjs', '--reason', '补齐下一次任务的范围');
      cli('todo', 'add', '--pack', 'A', '--text', '独立待办', '--reason', '任务运行中补记');
    } finally {
      fs.writeFileSync(release, 'release');
      await running;
    }
    const run = JSON.parse((await running).stdout);
    assert.equal(run.transition.outcome, 'ready_for_verify');
    assert.equal(run.warnings.length, 3);
    const task = fs.readFileSync(path.join(run.run_dir, 'task.md'), 'utf8');
    assert.match(task, /REPAIR \(tier1 attempt 1\)/);
    assert.match(task, /`## 超范围没改`.*`- 位置：说明`/);
    assert.match(task, /`## 没做完`.*原因和还差什么/);
    assert.doesNotMatch(task, /src\/b\.mjs/);
    const persisted = readJsonSafe(ctx.paths.statePath).packs.A;
    assert.equal(persisted.current_tier, 'tier2');
    assert.equal(persisted.active_instance, 'tier2-cli');
    assert.equal(persisted.last_session_id, null);
    assert.equal(persisted.inflight_run, null);
    assert.equal(persisted.escalated, true);
    assert.match(persisted.escalation_reason, /切到二档接力/);
    assert.equal(persisted.tier1_repairs, 1);
    assert.equal(persisted.tier2_repairs, 0);

    const todos = cli('status').open_todos;
    assert.deepEqual(todos.map(({ pack_id, run_id, content, status }) => [pack_id, run_id, content, status]), [
      ['A', null, '独立待办', 'open'], ['A', run.run_id, 'src/out.mjs：抽取共享校验', 'open'],
      ['A', run.run_id, '未说明：', 'open'], ['A', run.run_id, '补异常处理', 'open'],
      ['A', run.run_id, 'src/another.mjs: 补异常处理', 'open'], ['A', run.run_id, '记录跨包依赖', 'open']
    ]);
    const completed = readEvents(ctx.paths.eventsPath).find(({ type }) => type === 'implement_completed');
    assert.equal(completed.instance, 'tier1-cli');
    assert.equal(completed.tier, 'tier1');

    cli('record', 'verify', '--failed', '--summary', '准备下一份修复任务');
    const preview = cli('dispatch', '--dry-run', '--resume');
    assert.equal(preview.dry_run.instance_id, 'tier2-cli');
    assert.match(fs.readFileSync(path.join(preview.run_dir, 'task.md'), 'utf8'), /src\/b\.mjs/);
    const review = runCliFailure(['dispatch', '--stage', 'review', '--instance', 'tier1-cli'], repoDir);
    assert.equal(review.status, 1);
    assert.equal(JSON.parse(review.stdout).transition.outcome, 'review_report_invalid');
    assert.deepEqual(cli('status').open_todos, todos);

    cli('pack', 'tier', '--id', 'A', '--tier', 'tier1', '--reason', '一档再核对一次');
    assert.equal(cli('record', 'implement', '--failed').outcome, 'repair_tier1');
    assert.equal(cli('record', 'implement', '--failed').attempt, 2);
    assert.equal(cli('status').packs[0].repairs, '2/2');
    cli('pack', 'tier', '--id', 'A', '--tier', 'tier1', '--reason', '复核原档位');
    assert.equal(cli('record', 'implement', '--failed').outcome, 'paused_budget_exceeded');
    assert.equal(cli('status').packs[0].repairs, '2/2');

    cli('resume', '--action', 'retry');
    fs.writeFileSync(finalPath, '## 没做完：无\n### 超范围没改（0 项）\n- 无\n- 没有\n- 暂无。', 'utf8');
    const emptyReport = cli('dispatch');
    assert.equal(emptyReport.transition.outcome, 'ready_for_verify');
    assert.ok(emptyReport.warnings.some((warning) => warning.includes('未解析出待办')));
    assert.deepEqual(cli('status').open_todos, todos);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('unfinished report ignores explicit empty replies and keeps empty or substantive sections blocking', () => {
  for (const word of ['无', '没有。', '暂无！']) {
    assert.equal(parseImplementBlockedReason(`## 没做完\n\n${word}\n`), null);
    assert.equal(parseImplementBlockedReason(`## 没做完：${word} ##\n`), null);
  }
  const emptyItems = '- 无\n* 没有。\n1. 暂无\n+ [x] **没有**。\n  - [ ] __暂无。__';
  assert.equal(parseImplementBlockedReason(`## 没做完\n${emptyItems}\n`), null);
  assert.equal(parseImplementBlockedReason('## 没做完：缺少验收数据\n\n## 进度\n已检查'), '缺少验收数据');
  const mixedItems = '- 无\n- [ ] **仍需验证回放**';
  assert.equal(parseImplementBlockedReason(`## 没做完\n${mixedItems}`), mixedItems);
  assert.equal(parseImplementBlockedReason('没做完: 无\n===\n'), null);
  assert.equal(parseImplementBlockedReason('## 没做完\n\n## 进度\n已检查'), '执行者没写原因');
  assert.equal(parseImplementBlockedReason('## 没做完\n暂无可用的数据文件。'), '暂无可用的数据文件。');
  assert.equal(parseImplementBlockedReason('## 没做完：无\n## 没做完\n还差测试'), '还差测试');
});

test('a Codex reply reporting unfinished implementation pauses with options and preserves scope todos', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'], co_change_files: ['src/companion.mjs'] }], {
    redaction: { extra_patterns: ['fixture-private-marker'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  const saved = () => readJsonSafe(ctx.paths.statePath).packs.A;
  const mock = path.join(repoDir, 'mock-codex.cjs');
  const replyFile = path.join(repoDir, 'reply.md');
  const argsFile = path.join(repoDir, 'executor-args.json');
  const sessionId = 'fixture-blocked-codex-session';
  const reply = [
    '# 实现进度', '## 没做完', '', '  需要确认接口 fixture-private-marker', '',
    '- 还差接入测试', '', '## 超范围没改', '- src/shared.mjs：补共享校验'
  ].join('\r\n');
  const safeReason = '需要确认接口 [REDACTED:INTERNAL]\n\n- 还差接入测试';
  try {
    fs.writeFileSync(replyFile, reply, 'utf8');
    fs.writeFileSync(mock, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.readFileSync(0, 'utf8');
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
      fs.copyFileSync(${JSON.stringify(replyFile)}, args[args.indexOf('--output-last-message') + 1]);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(sessionId)} }));
      if (args.includes('--mock-infra')) console.error('Error: 429 rate_limit_exceeded');
      if (args.includes('--mock-infra') || args.includes('--mock-failed')) process.exitCode = 1;
    `);
    const executor = { kind: 'codex', executable: process.execPath, prefix_args: [mock] };
    ctx.config.executors = { 'tier1-cli': executor, 'tier2-cli': { kind: 'self' } };
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');
    const run = cli('dispatch');
    assert.equal(run.result.exit_code, 0);
    assert.equal(run.transition.outcome, 'paused_executor_blocked');
    assert.match(fs.readFileSync(path.join(run.run_dir, 'task.md'), 'utf8'), /`## 没做完`.*原因和还差什么/);
    assert.deepEqual(cli('status').open_todos.map(({ run_id, content }) => [run_id, content]), [
      [run.run_id, 'src/shared.mjs：补共享校验']
    ]);

    const shell = cli('status', '--format', 'shell');
    assert.equal(shell.now.phase, 'PAUSE_FOR_HUMAN');
    assert.equal(shell.now.waiting_for, 'human');
    assert.equal(shell.question.kind, 'EXECUTOR_BLOCKED');
    assert.match(shell.question.title, /没做完/);
    assert.ok(shell.question.body.includes(safeReason));
    assert.match(shell.question.body, /grow-loop pack scope.*再选「接着写」/);
    assert.deepEqual(shell.question.options.map(({ id }) => id.split(':')[0]), [
      'continue', 'retry', 'approve', 'switch_instance', 'abort'
    ]);
    const options = Object.fromEntries(shell.question.options.map((option) => [option.id, option]));
    assert.equal(options.continue.label, '已扩范围或补好条件，让执行者接着写（不扣修复次数）');
    assert.equal(options.continue.needs_text, true);
    assert.equal(options.retry.label, '用当前实例从头重新执行');
    assert.equal(options.approve.label, '代码已写完，接受现有改动进入验证');
    assert.equal(shell.packs[0].tier1_repairs, 0);
    assert.equal(shell.packs[0].tier2_repairs, 0);
    assert.equal(shell.pending.lesson_drafts, 0);
    assert.equal(shell.packs[0].inflight_run, null);
    const events = readEvents(ctx.paths.eventsPath);
    const blocked = events.filter(({ type }) => type === 'implement_blocked');
    assert.deepEqual(blocked.map(({ run_id, instance, summary }) => [run_id, instance, summary]), [
      [run.run_id, 'tier1-cli', safeReason]
    ]);
    assert.ok(!events.some(({ type }) => type === 'implement_completed'));
    assert.equal(cli('dispatch').question.id, shell.question.id);
    const bypass = runCliFailure(['record', 'implement', '--passed'], repoDir);
    assert.equal(bypass.status, 1);
    assert.equal(JSON.parse(bypass.stdout).question.id, shell.question.id);
    assert.match(runCliFailure(['resume', '--action', 'commit'], repoDir).stderr, /--action continue, retry, approve, switch_instance or abort.*EXECUTOR_BLOCKED/);

    const answer = ['answer', '--question', shell.question.id, '--option', 'continue'];
    const missingText = runCliFailure(answer, repoDir);
    assert.equal(missingText.status, 1);
    assert.match(missingText.stderr, /非空的 --text/);
    const blankDecision = runCliFailure(['resume', '--action', 'continue', '--decision=  '], repoDir);
    assert.equal(blankDecision.status, 1);
    assert.match(blankDecision.stderr, /非空的 --decision/);
    assert.deepEqual(cli('status', '--format', 'shell').question, shell.question);

    cli('pack', 'scope', '--id', 'A', '--add', 'src/shared.mjs', '--reason', '允许补共享校验');
    const manifest = readJsonSafe(ctx.paths.manifestPath);
    manifest.packs[0].co_change_files.push('test/shared.test.mjs', 'src/shared.mjs');
    writeJsonAtomic(ctx.paths.manifestPath, manifest);
    cli('manifest-ack', '--reason', '补关联测试到清单');
    const decision = '可以改共享校验。\n把关联测试一起补上。';
    assert.equal(cli(...answer, '--text', decision).outcome, 'resumed_implement');
    const continued = cli('status', '--format', 'shell');
    assert.equal(continued.packs[0].status, 'IMPLEMENT');
    assert.equal(continued.packs[0].tier1_repairs, shell.packs[0].tier1_repairs);
    assert.equal(continued.packs[0].tier2_repairs, shell.packs[0].tier2_repairs);
    assert.equal(continued.pending.lesson_drafts, shell.pending.lesson_drafts);
    const pending = saved().continue_pending;
    assert.deepEqual(pending, {
      blocked_reason: safeReason, decision, at: saved().decisions.at(-1).at,
      added_scope: ['src/shared.mjs', 'test/shared.test.mjs']
    });
    assert.deepEqual(saved().decisions.at(-1), {
      gate_reason: 'EXECUTOR_BLOCKED', action: 'continue', decision, at: pending.at
    });
    assert.equal(saved().last_session_id, sessionId);
    const preview = cli('dispatch', '--dry-run');
    const task = fs.readFileSync(preview.dry_run.task_file, 'utf8');
    assert.match(task, /^# Work Package A · CONTINUE \(tier1\).*\n\n## 接着写\n/);
    const continuation = task.split('## Hard Constraints')[0];
    for (const value of [safeReason, decision, '- `src/shared.mjs`', '- `test/shared.test.mjs`', '接着把目标做完，已完成的部分不要重做']) {
      assert.ok(continuation.includes(value));
    }
    assert.doesNotMatch(continuation, /src\/(a|companion)\.mjs/);
    const resumeIndex = preview.dry_run.args.indexOf('resume');
    assert.ok(resumeIndex >= 0);
    assert.equal(preview.dry_run.args[resumeIndex + 1], sessionId);
    const override = cli('dispatch', '--dry-run', '--resume', 'explicit-fixture-session');
    assert.ok(override.dry_run.args.includes('explicit-fixture-session'));
    assert.deepEqual(saved().continue_pending, pending);

    fs.writeFileSync(replyFile, '## 没做完\n\n还差接口说明。', 'utf8');
    const stillBlocked = cli('dispatch');
    assert.equal(stillBlocked.run_id, preview.run_id);
    assert.equal(stillBlocked.transition.gate.summary, '还差接口说明。');
    const actualArgs = readJsonSafe(argsFile);
    assert.ok(actualArgs.includes('resume'));
    assert.equal(actualArgs[actualArgs.indexOf('resume') + 1], sessionId);
    assert.equal(saved().continue_pending, undefined);

    const retry = cli('resume', '--action', 'retry', '--decision', '范围已补齐');
    assert.equal(retry.outcome, 'resumed_implement');
    assert.equal(retry.active_instance, 'tier1-cli');
    assert.equal(cli('next').action, 'IMPLEMENT');

    executor.extra_args = ['--mock-failed'];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    assert.equal(cli('dispatch').transition.outcome, 'repair_tier1');
    assert.ok(!readJsonSafe(argsFile).includes('resume'));
    executor.extra_args = ['--mock-infra'];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    assert.equal(cli('dispatch').transition.question.kind, 'INFRA_BLOCKED');
    assert.equal(readEvents(ctx.paths.eventsPath).filter(({ type }) => type === 'implement_blocked').length, 2);
    cli('resume', '--action', 'retry');

    delete executor.extra_args;
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    fs.writeFileSync(replyFile, '没做完\n---\n\n~~~md\n代码示例\n~~~\n## 进度\n已检查', 'utf8');
    const second = cli('dispatch');
    assert.equal(second.transition.gate.summary, '执行者没写原因');
    assert.match(fs.readFileSync(path.join(second.run_dir, 'task.md'), 'utf8'), /src\/shared\.mjs/);
    const afterRepair = cli('status', '--format', 'shell');
    assert.equal(afterRepair.packs[0].tier1_repairs, 1);
    assert.equal(afterRepair.packs[0].tier2_repairs, 0);
    assert.equal(afterRepair.pending.lesson_drafts, 1);
    assert.equal(cli('answer', '--question', second.question.id, '--option', 'approve').outcome, 'approved');
    assert.equal(cli('next').action, 'VERIFY');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('self implementation can report a block, switch executor, or abort', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A' }], {
    redaction: { extra_patterns: ['fixture-private-marker'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  try {
    cli('next');
    const run = cli('dispatch');
    const reason = `需要 fixture-private-marker 授权。\n${'甲'.repeat(850)}原文末尾`;
    const conflicting = runCliFailure(['record', 'implement', '--passed', '--blocked', reason], repoDir);
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /--blocked.*--passed|--passed.*--blocked/);
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.inflight_run.run_id, run.run_id);

    const pause = cli('record', 'implement', '--blocked', reason);
    assert.equal(pause.outcome, 'paused_executor_blocked');
    assert.equal(pause.question.kind, 'EXECUTOR_BLOCKED');
    assert.match(pause.question.body, /需要 \[REDACTED:INTERNAL\] 授权/);
    assert.match(pause.question.body, /已截断/);
    assert.doesNotMatch(pause.question.body, /原文末尾/);
    assert.ok(pause.gate.summary.length <= 820);
    assert.equal(readJsonSafe(path.join(run.run_dir, 'result.json')).status, 'blocked');
    const event = readEvents(ctx.paths.eventsPath).find(({ type }) => type === 'implement_blocked');
    assert.equal(event.run_id, run.run_id);
    assert.equal(event.instance, 'tier1-cli');
    assert.equal(event.summary, pause.gate.summary);

    const alternate = pause.question.options.find(({ label }) => label.includes('tier1-backup'));
    const switched = cli('answer', '--question', pause.question.id, '--option', alternate.id);
    assert.equal(switched.outcome, 'switched_instance');
    assert.equal(switched.active_instance, 'tier1-backup');
    assert.equal(cli('next').action, 'IMPLEMENT');
    assert.equal(cli('dispatch').result.instance_id, 'tier1-backup');
    cli('record', 'implement', '--blocked', '仍缺少授权');
    const decision = '授权已补齐，接着做。';
    assert.equal(cli('resume', '--action', 'continue', '--decision', decision).outcome, 'resumed_implement');
    const continued = cli('dispatch');
    assert.equal(continued.result.status, 'host_action_required');
    const task = fs.readFileSync(continued.result.task_file, 'utf8');
    assert.match(task, /^# Work Package A · CONTINUE \(tier1\).*\n\n## 接着写\n/);
    assert.ok(task.includes('仍缺少授权'));
    assert.ok(task.includes(decision));
    assert.match(task, /### 新加进范围的文件\n无。/);
    cli('record', 'implement', '--blocked', '还要确认另一个条件');
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.continue_pending, undefined);
    assert.equal(cli('resume', '--action', 'abort').outcome, 'aborted');
    const shell = cli('status', '--format', 'shell');
    assert.equal(shell.loop_status, 'ABORTED');
    assert.equal(shell.question, null);
    assert.equal(shell.packs[0].tier1_repairs, 0);
    assert.equal(shell.packs[0].tier2_repairs, 0);
    assert.equal(shell.pending.lesson_drafts, 0);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('continuing without a saved executor session warns and starts a fresh session', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const mock = path.join(repoDir, 'mock-codex.cjs');
  try {
    fs.writeFileSync(mock, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args.includes('resume')) process.exit(2);
      const task = fs.readFileSync(0, 'utf8');
      const continued = task.includes('## 接着写');
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], continued ? '已完成。' : '## 没做完\\n缺少授权。');
      if (continued) console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fresh-fixture-session' }));
    `);
    ctx.config.executors['tier1-cli'] = { kind: 'codex', executable: process.execPath, prefix_args: [mock] };
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');
    const blocked = cli('dispatch');
    assert.equal(blocked.question.kind, 'EXECUTOR_BLOCKED');
    assert.equal(blocked.result.session_id, null);
    cli('answer', '--question', blocked.question.id, '--option', 'continue', '--text', '授权已补齐。');
    const continued = cli('dispatch');
    assert.ok(continued.warnings.some((warning) => warning.includes('没有可续的会话，本次会启动新会话')));
    assert.equal(continued.result.session_id, 'fresh-fixture-session');
    assert.equal(continued.transition.outcome, 'ready_for_verify');
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.continue_pending, undefined);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a stored executor block with the original actions can still be answered', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  try {
    cli('next');
    const state = readJsonSafe(ctx.paths.statePath);
    const gate = {
      reason: 'EXECUTOR_BLOCKED', summary: '等待原有决定。', questions: [], recommended_action: null,
      allowed_resume_actions: ['retry', 'approve', 'switch_instance', 'abort'], created_at: '2026-01-01T00:00:00.000Z'
    };
    Object.assign(state.packs.A, { status: 'PAUSED_FOR_HUMAN', gate });
    saveState(ctx.stateDir, state);

    const { question } = cli('status', '--format', 'shell');
    assert.equal(question.kind, 'EXECUTOR_BLOCKED');
    assert.deepEqual([...new Set(question.options.map(({ id }) => id.split(':')[0]))], gate.allowed_resume_actions);
    const rejected = runCliFailure(['resume', '--action', 'continue', '--decision', '可以。'], repoDir);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--action retry, approve, switch_instance or abort/);
    assert.deepEqual(readJsonSafe(ctx.paths.statePath).packs.A.gate, gate);
    assert.equal(cli('answer', '--question', question.id, '--option', 'approve').status, 'VERIFY');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('custom-cmd dispatch renders the model, captures full-log session IDs, and resumes with them', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'] }], {
    redaction: { extra_patterns: ['fixture-private-marker'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  const mock = path.join(repoDir, 'mock-custom.cjs');
  const stdoutSession = 'from-stdout$&';
  const reply = '# Reply\nfixture-private-marker\n\n## 超范围没改\n- src/shared.mjs：补共享校验\n';
  const padding = 'x'.repeat(17 * 1024);
  const fallback = `stdout begins here\nfixture-private-marker\n${padding}\n`;
  try {
    fs.writeFileSync(mock, `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const [model, finalFile, ...args] = process.argv.slice(2);
      fs.readFileSync(0, 'utf8');
      assert.equal(model, 'fixture-model');
      if (args.length === 0) {
        console.log(${JSON.stringify(`Session ID: ${stdoutSession}\nSession ID: later-stdout\n${padding}`)});
        console.error('Session ID: ignored-stderr');
        fs.writeFileSync(finalFile, ${JSON.stringify(reply)});
      } else {
        assert.deepEqual(args, ['--resume', ${JSON.stringify(stdoutSession)}, '--resume-model=fixture-model']);
        process.stdout.write(${JSON.stringify(fallback)});
        console.error('Session ID: from-stderr\\n' + ${JSON.stringify(padding)});
      }
    `);
    ctx.config.executors['tier1-cli'] = {
      kind: 'custom-cmd', executable: process.execPath, model: 'fixture-model',
      args: [mock, '{{model}}', '{{run_dir}}/reply.md'],
      read_only_args: ['--review-model={{model}}'],
      resume_args: ['--resume', '{{session_id}}', '--resume-model={{model}}'],
      session_id_pattern: 'Session ID: ([a-z$&-]+)',
      final_file: '{{run_dir}}/reply.md'
    };
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');

    const review = cli('dispatch', '--dry-run', '--stage', 'review', '--instance', 'tier1-cli', '--resume', 'review-session');
    assert.deepEqual(review.dry_run.args.slice(3), ['--review-model=fixture-model', '--resume', 'review-session', '--resume-model=fixture-model']);
    const preview = cli('dispatch', '--dry-run');
    assert.equal(preview.dry_run.args[1], 'fixture-model');
    assert.ok(preview.dry_run.args[2].endsWith('/reply.md'));

    const first = cli('dispatch');
    assert.equal(first.run_id, preview.run_id);
    assert.equal(first.transition.outcome, 'ready_for_verify');
    assert.equal(first.result.session_id, stdoutSession);
    assert.equal(first.result.final_md, path.join(first.run_dir, 'final.md'));
    assert.equal(fs.readFileSync(first.result.final_md, 'utf8'), reply.replace('fixture-private-marker', '[REDACTED:INTERNAL]'));
    assert.deepEqual(cli('status').open_todos.map(({ run_id, content, status }) => [run_id, content, status]), [
      [first.run_id, 'src/shared.mjs：补共享校验', 'open']
    ]);

    const resumed = cli('dispatch', '--resume');
    assert.equal(resumed.transition.outcome, 'ready_for_verify');
    assert.equal(resumed.result.session_id, 'from-stderr');
    assert.equal(resumed.result.final_md, path.join(resumed.run_dir, 'final.md'));
    assert.equal(fs.readFileSync(resumed.result.final_md, 'utf8'), fallback.replace('fixture-private-marker', '[REDACTED:INTERNAL]'));
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.last_session_id, 'from-stderr');
    const events = readEvents(ctx.paths.eventsPath);
    assert.deepEqual(events.filter(({ type }) => type === 'implement_completed')
      .map(({ executor_model, session_id }) => [executor_model, session_id]), [
      ['fixture-model', stdoutSession], ['fixture-model', 'from-stderr']
    ]);
    assert.ok(events.some(({ type, run_id, resumed_session }) =>
      type === 'dispatch_started' && run_id === resumed.run_id && resumed_session === stdoutSession));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('custom-cmd dispatch warns about model and session configuration and rejects invalid patterns', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const mock = path.join(repoDir, 'mock-custom.cjs');
  const cfg = {
    kind: 'custom-cmd', executable: process.execPath, args: [mock, '{{model}}'],
    resume_args: ['--resume={{session_id}}']
  };
  try {
    fs.writeFileSync(mock, `
      require('node:assert/strict').deepEqual(process.argv.slice(2), ['']);
      require('node:fs').readFileSync(0, 'utf8');
      console.log('Legacy stdout');
    `);
    ctx.config.executors['tier1-cli'] = cfg;
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');
    const preview = cli('dispatch', '--dry-run');
    assert.equal(preview.dry_run.args[1], '');
    const legacy = cli('dispatch');
    for (const { warnings } of [preview, legacy]) {
      assert.ok(warnings.some((warning) => warning.includes('执行记录里的模型会是空的')));
      assert.ok(warnings.some((warning) => warning.includes('拿不到会话号，--resume 会开新会话')));
    }
    assert.equal(legacy.result.status, 'completed');
    assert.equal(legacy.result.session_id, null);
    assert.equal(fs.readFileSync(legacy.result.final_md, 'utf8'), 'Legacy stdout\n');

    cfg.session_id_pattern = 'Session ID: ([a-z-]+)';
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    const missing = cli('dispatch');
    assert.equal(missing.result.session_id, null);
    assert.ok(missing.warnings.some((warning) => warning.includes('本次未匹配到会话号')));
    assert.ok(missing.warnings.every((warning) => !warning.includes('未配置 session_id_pattern')));

    for (const [pattern, flags, expected] of [
      ['(', [], /session_id_pattern.*valid regular expression/],
      ['Session ID: [a-z-]+', ['--dry-run'], /session_id_pattern.*capture group/]
    ]) {
      cfg.session_id_pattern = pattern;
      writeJsonAtomic(ctx.paths.configPath, ctx.config);
      const failure = runCliFailure(['dispatch', ...flags], repoDir);
      assert.equal(failure.status, 1);
      assert.match(failure.stderr, expected);
      assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.inflight_run, null);
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Claude dispatch uses the last string result for redacted scope todos and unfinished work', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'] }], {
    redaction: { extra_patterns: ['fixture-private-marker'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  const mock = path.join(repoDir, 'mock-claude.cjs');
  const reply = '# Last reply\nfixture-private-marker\n\n## 超范围没改\n- src/other.mjs：补测试\n';
  try {
    fs.writeFileSync(mock, `
      require('node:fs').readFileSync(0, 'utf8');
      const emit = (event) => console.log(JSON.stringify(event));
      emit({ type: 'system', session_id: 'claude-session' });
      if (!process.argv.includes('--mock-no-final')) {
        emit({ type: 'result', result: 'First reply' });
        console.log('Not JSON');
        console.log('{malformed');
        const reply = process.argv.includes('--mock-blocked')
          ? '没做完\\n===\\n还差接口定义' : ${JSON.stringify(reply)};
        emit({ type: 'result', result: reply, usage: { output_tokens: 42 } });
      }
      emit({ type: 'assistant', result: 'Ignore this string' });
      emit({ type: 'result', result: { text: 'Ignore this object' } });
    `);
    const cfg = { kind: 'claude', executable: process.execPath, prefix_args: [mock], model: 'fixture-sonnet' };
    ctx.config.executors['tier1-cli'] = cfg;
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');
    const run = cli('dispatch');
    assert.equal(run.transition.outcome, 'ready_for_verify');
    assert.equal(run.result.session_id, 'claude-session');
    assert.deepEqual(run.result.usage, { output_tokens: 42 });
    assert.equal(run.result.final_md, path.join(run.run_dir, 'final.md'));
    assert.equal(fs.readFileSync(run.result.final_md, 'utf8'), reply.replace('fixture-private-marker', '[REDACTED:INTERNAL]'));
    const todos = cli('status').open_todos;
    assert.deepEqual(todos.map(({ run_id, content, status }) => [run_id, content, status]), [
      [run.run_id, 'src/other.mjs：补测试', 'open']
    ]);

    cfg.prefix_args = [mock, '--mock-no-final'];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    const noFinal = cli('dispatch');
    assert.equal(noFinal.result.final_md, null);
    assert.equal(fs.existsSync(path.join(noFinal.run_dir, 'final.md')), false);
    assert.deepEqual(cli('status').open_todos, todos);

    cfg.prefix_args = [mock, '--mock-blocked'];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    const blocked = cli('dispatch');
    assert.equal(blocked.transition.question.kind, 'EXECUTOR_BLOCKED');
    assert.equal(blocked.transition.gate.summary, '还差接口定义');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('blast-radius gate auto-routes >=25 files / cross_module to tier2 and pauses >=50 files + chained preflight gates', () => {
  const { repoDir, ctx } = setupCtx([
    {
      id: 'W01',
      title: 'Small single-module pack',
      risk: 'low',
      estimated_files: 8,
      cross_module: false
    },
    {
      id: 'W02',
      title: 'Cross-module pack',
      depends_on: ['W01'],
      risk: 'medium',
      estimated_files: 12,
      cross_module: true
    },
    {
      id: 'W03',
      title: 'Mega pack with ambiguity and external effect',
      depends_on: ['W02'],
      risk: 'high',
      estimated_files: 65,
      open_questions: ['Single-select or multi-select?'],
      external_effects: ['alter-shared-schema']
    }
  ]);

  try {
    // W01 -> tier1
    const d1 = startOrAdvanceActivePack(ctx);
    assert.equal(d1.action, 'IMPLEMENT');
    assert.equal(d1.tier, 'tier1');
    assert.equal(d1.instance, 'tier1-cli');
    recordCommitOutcome(ctx, { sha: '111111111111', files: 4, insertions: 40, deletions: 5 });

    // W02 -> cross_module auto tier2
    const d2 = startOrAdvanceActivePack(ctx);
    assert.equal(d2.action, 'IMPLEMENT');
    assert.equal(d2.tier, 'tier2');
    assert.equal(d2.instance, 'tier2-cli');
    recordCommitOutcome(ctx, { sha: '222222222222', files: 12, insertions: 120, deletions: 10 });

    // W03 -> pauses BLAST_RADIUS_SPLIT first
    const d3 = startOrAdvanceActivePack(ctx);
    assert.equal(d3.action, 'PAUSE_FOR_HUMAN');
    assert.equal(d3.gate.reason, ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT);

    // Approve split -> next preflight gate is AMBIGUITY
    const r1 = resumeFromGate(ctx, { action: 'approve', decision: 'Proceed without split on tier2' });
    assert.equal(r1.outcome, 'paused_next_gate');
    assert.equal(r1.next.gate.reason, ALLOWED_GATE_REASONS.AMBIGUITY);

    // Approve ambiguity -> next preflight gate is EXTERNAL_EFFECT
    const r2 = resumeFromGate(ctx, { action: 'approve', decision: 'Use single-select' });
    assert.equal(r2.outcome, 'paused_next_gate');
    assert.equal(r2.next.gate.reason, ALLOWED_GATE_REASONS.EXTERNAL_EFFECT);

    // Approve external effect -> enters IMPLEMENT on tier2
    const r3 = resumeFromGate(ctx, { action: 'approve', decision: 'Schema change authorized' });
    assert.equal(r3.outcome, 'approved');
    assert.equal(r3.tier, 'tier2');
    assert.equal(r3.next.action, 'IMPLEMENT');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('2+2 repair ladder: tier1 fails 2 repairs -> auto-escalates to tier2 -> tier2 fails 2nd repair -> BUDGET_EXCEEDED', () => {
  const { repoDir, ctx } = setupCtx([
    { id: 'W01', title: 'Ladder test', risk: 'low', estimated_files: 5 }
  ]);

  try {
    const start = startOrAdvanceActivePack(ctx);
    assert.equal(start.tier, 'tier1');

    // Initial attempt -> verify fail -> tier1 repair #1
    recordImplementOutcome(ctx, { passed: true, sessionId: 'sess-t1-0' });
    const f1 = recordVerifyOutcome(ctx, { passed: false, summary: 'Compile error #1' });
    assert.equal(f1.outcome, 'repair_tier1');
    assert.equal(f1.attempt, 1);
    assert.equal(ctx.state.packs.W01.tier1_repairs, 1);

    // Tier1 repair #1 -> verify fail -> tier1 repair #2
    recordImplementOutcome(ctx, { passed: true, sessionId: 'sess-t1-1' });
    const f2 = recordVerifyOutcome(ctx, { passed: false, summary: 'Compile error #2' });
    assert.equal(f2.outcome, 'repair_tier1');
    assert.equal(f2.attempt, 2);
    assert.equal(ctx.state.packs.W01.tier1_repairs, 2);

    // Tier1 repair #2 -> verify fail -> AUTO ESCALATE TO TIER 2 (attempt 1)
    recordImplementOutcome(ctx, { passed: true, sessionId: 'sess-t1-2' });
    const f3 = recordVerifyOutcome(ctx, { passed: false, summary: 'Still failing on tier1' });
    assert.equal(f3.outcome, 'escalated_tier2');
    assert.equal(f3.tier, 'tier2');
    assert.equal(f3.instance, 'tier2-cli');
    assert.equal(f3.attempt, 1);
    assert.equal(ctx.state.packs.W01.escalated, true);
    assert.equal(ctx.state.packs.W01.last_session_id, null);

    // Tier2 attempt #1 -> verify fail -> tier2 repair #2
    recordImplementOutcome(ctx, { passed: true, sessionId: 'sess-t2-1' });
    const f4 = recordVerifyOutcome(ctx, { passed: false, summary: 'Tier2 attempt 1 failed' });
    assert.equal(f4.outcome, 'repair_tier2');
    assert.equal(f4.attempt, 2);

    // Tier2 attempt #2 -> verify fail -> PAUSED_FOR_HUMAN (BUDGET_EXCEEDED)
    recordImplementOutcome(ctx, { passed: true, sessionId: 'sess-t2-2' });
    const f5 = recordVerifyOutcome(ctx, { passed: false, summary: 'Tier2 attempt 2 failed' });
    assert.equal(f5.outcome, 'paused_budget_exceeded');
    assert.equal(ctx.state.packs.W01.status, 'PAUSED_FOR_HUMAN');
    assert.equal(ctx.state.packs.W01.gate.reason, ALLOWED_GATE_REASONS.BUDGET_EXCEEDED);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('infra failures (429/auth/timeout) NEVER consume repair budget; fallback only when explicitly enabled', () => {
  const { repoDir, ctx } = setupCtx([
    { id: 'W01', title: 'Infra immunity test', risk: 'low', estimated_files: 5 }
  ]);

  try {
    startOrAdvanceActivePack(ctx);
    const out = recordImplementOutcome(ctx, {
      passed: false,
      infraError: 'INFRA_QUOTA',
      summary: 'HTTP 429 rate limit exceeded'
    });
    assert.equal(out.outcome, 'paused_infra_blocked');
    assert.equal(out.question.kind, 'INFRA_BLOCKED');
    assert.equal(ctx.state.packs.W01.gate.reason, ALLOWED_GATE_REASONS.INFRA_BLOCKED);
    assert.equal(ctx.state.packs.W01.tier1_repairs, 0);
    assert.equal(ctx.state.packs.W01.tier2_repairs, 0);
    assert.equal(ctx.state.packs.W01.infra_failures, 1);

    // Explicit retry resumes IMPLEMENT without touching budgets
    const resumed = resumeFromGate(ctx, { action: 'retry', decision: 'Quota restored' });
    assert.equal(resumed.outcome, 'resumed_implement');
    assert.equal(ctx.state.packs.W01.tier1_repairs, 0);

    const { question } = runCli(['record', 'implement', '--infra-error', 'INFRA_AUTH'], repoDir);
    const alternate = question.options.find(({ label }) => label.includes('tier2-cli'));
    assert.ok(alternate.id.startsWith('switch_instance:'));
    const switched = runCli(['answer', '--question', question.id, '--option', alternate.id], repoDir);
    assert.equal(switched.outcome, 'switched_instance');
    assert.equal(switched.active_instance, 'tier2-cli');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // Test explicit opt-in fallback
  const fb = setupCtx(
    [{ id: 'W01', title: 'Fallback test', risk: 'low', estimated_files: 5 }],
    { routing: { tier1: 'tier1-cli', tier2: 'tier2-cli', reviewer: 'reviewer-cli', on_infra_failure: 'fallback' } }
  );
  try {
    startOrAdvanceActivePack(fb.ctx);
    const out = recordImplementOutcome(fb.ctx, {
      passed: false,
      infraError: 'INFRA_QUOTA',
      summary: '429 quota hit'
    });
    assert.equal(out.outcome, 'infra_fallback');
    assert.equal(out.active_instance, 'tier1-backup');
    assert.equal(fb.ctx.state.packs.W01.tier1_repairs, 0);
  } finally {
    fs.rmSync(fb.repoDir, { recursive: true, force: true });
  }
});

test('infra classifier ignores model/tool text on clean exits and reads only CLI error events on failures', () => {
  const assistant429 = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Added retry when amap returns 429 rate limit' } });
  const tool401 = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'expect(res.status).toBe(401)', exit_code: 1 } });
  const serverSource = "if (req.headers.origin !== allowedOrigin) throw new InputError('foreign origin', 403);";

  // Clean exit: whatever the executor read or wrote is not an infra failure
  assert.equal(classifyInfraError(0, `${assistant429}\n${tool401}`, '', false), null);
  assert.equal(classifyInfraError(0, serverSource, '', false), null);

  // Failed exit caused by code, while model text mentions 429/401: still a code failure
  assert.equal(classifyInfraError(1, `${assistant429}\n${tool401}`, '', false), null);

  // Failed exit with real CLI error events / stderr
  assert.equal(classifyInfraError(1, JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } }), '', false), 'INFRA_AUTH');
  assert.equal(classifyInfraError(1, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 429 Too Many Requests' }), '', false), 'INFRA_QUOTA');
  assert.equal(classifyInfraError(1, '', 'Error: 429 rate_limit_exceeded', false), 'INFRA_QUOTA');
  assert.equal(classifyInfraError(1, '', "'codex' is not recognized as an internal or external command", false), 'INFRA_CLI_CRASH');
  assert.equal(classifyInfraError(0, '', '', true), 'INFRA_TIMEOUT');

  // First line of a truncated tail is a JSON fragment and must not be scanned
  assert.equal(classifyInfraError(1, 'retry on 429 rate limit"}}\n', '', false), null);
});

test('grow-loop verify runs configured commands itself; self-reported passes need explicit opt-in', () => {
  const repoDir = makeTempDir('grow-loop-verify-');
  try {
    const manifestPath = path.join(repoDir, 'verify-manifest.json');
    writeJsonAtomic(manifestPath, {
      project: 'verify-demo',
      packs: [{ id: 'W01', title: 'Add a file checked by verification', acceptance_criteria: ['fixed.txt exists'] }]
    });
    runCli(['init', '--repo', repoDir, '--profile', 'standard-test', '--manifest', manifestPath]);
    const configPath = path.join(repoDir, '.loop', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(path.join(repoDir, 'check.mjs'), "import fs from 'node:fs';\nif (!fs.existsSync('fixed.txt')) { console.error('assertion failed: fixed.txt missing'); process.exit(3); }\n", 'utf8');
    cfg.verification.commands = [`${shellQuote(process.execPath)} --version`, `${shellQuote(process.execPath)} check.mjs`];
    writeJsonAtomic(configPath, cfg);

    // Placeholders are not runnable commands
    assert.deepEqual(getVerificationCommands({ verification: { commands: ['# Replace me', '  '] } }), []);

    runCli(['next', '--repo', repoDir]);
    // Not in VERIFY yet -> refuse
    const early = runCliFailure(['verify', '--repo', repoDir]);
    assert.match(early.stderr, /not waiting for verification/);

    runCli(['record', 'implement', '--repo', repoDir, '--passed', '--summary', 'first try']);

    // A coordinator cannot assert a pass while commands are configured
    const selfPass = runCliFailure(['record', 'verify', '--repo', repoDir, '--passed', '--summary', 'trust me']);
    assert.match(selfPass.stderr, /run "grow-loop verify"/);

    // CLI-run verification fails on the real exit code and schedules a repair
    const v1 = runCli(['verify', '--repo', repoDir]);
    assert.equal(v1.passed, false);
    assert.equal(v1.git_watch.status, 'skipped');
    assert.equal(v1.commands.length, 2);
    assert.equal(v1.commands[1].exit_code, 3);
    assert.match(v1.summary, /exited 3: assertion failed: fixed\.txt missing/);
    assert.equal(v1.transition.outcome, 'repair_tier1');
    assert.equal(v1.run_dirs.length, 2);
    let state = JSON.parse(fs.readFileSync(path.join(repoDir, '.loop', 'state.json'), 'utf8'));
    assert.equal(state.packs.W01.last_verify.source, 'cli');
    assert.equal(state.packs.W01.last_verify.passed, false);
    assert.equal(state.packs.W01.tier1_repairs, 1);
    assert.deepEqual(state.packs.W01.last_verify.failure.test_names, []);
    assert.match(state.packs.W01.last_verify.failure.excerpt, /fixed\.txt missing/);
    assert.ok(fs.existsSync(path.join(v1.run_dir, 'cmd-2', 'stderr.log')));
    const lessons = JSON.parse(fs.readFileSync(path.join(repoDir, '.loop', 'lessons.json'), 'utf8'));
    assert.equal(lessons.items.length, 1);
    assert.match(lessons.items[0].root_cause, /fixed\.txt missing/);

    // Repair, then the CLI observes a clean pass
    fs.writeFileSync(path.join(repoDir, 'fixed.txt'), 'ok\n', 'utf8');
    runCli(['record', 'implement', '--repo', repoDir, '--passed', '--summary', 'added fixed.txt']);
    const v2 = runCli(['verify', '--repo', repoDir]);
    assert.equal(v2.passed, true);
    assert.match(v2.summary, /^2\/2 commands exited 0/);
    assert.equal(v2.transition.outcome, 'ready_for_review');

    // Explicit opt-in still allows a manual pass, labelled as self-reported in evidence
    runCli(['record', 'review', '--repo', repoDir, '--verdict', 'fail', '--findings', JSON.stringify([{ severity: 'HIGH', title: 'Missing edge case' }])]);
    runCli(['record', 'implement', '--repo', repoDir, '--passed', '--summary', 'edge case']);
    const manual = runCli(['record', 'verify', '--repo', repoDir, '--passed', '--allow-self-report', '--summary', 'checked by hand']);
    assert.equal(manual.outcome, 'ready_for_review');
    state = JSON.parse(fs.readFileSync(path.join(repoDir, '.loop', 'state.json'), 'utf8'));
    assert.equal(state.packs.W01.last_verify.source, 'self_reported');

    const ev = runCli(['evidence', '--repo', repoDir]);
    const md = fs.readFileSync(ev.path, 'utf8');
    assert.match(md, /\| CLI 实跑 \|/);
    assert.match(md, /\| 自报 \|/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('verification reruns the whole command sequence once and records a flaky pass without a repair or lesson', () => {
  const node = shellQuote(process.execPath);
  const { repoDir, ctx } = setupCtx([{ id: 'W' }], {
    verification: { commands: [`${node} count.mjs`, `${node} flaky.mjs`, `${node} --version`] }
  });
  try {
    fs.writeFileSync(path.join(repoDir, 'count.mjs'), "import fs from 'node:fs'; fs.appendFileSync('attempts.txt', '1');");
    fs.writeFileSync(path.join(repoDir, 'flaky.mjs'), `
import fs from 'node:fs';
if (fs.readFileSync('attempts.txt', 'utf8') === '1') {
  console.error('temporary failure');
  process.exitCode = 7;
}
`);
    runCli(['next'], repoDir);
    runCli(['record', 'implement', '--passed'], repoDir);
    const verify = runCli(['verify'], repoDir);
    assert.equal(verify.transition.outcome, 'ready_for_review');
    assert.equal(verify.passed, true);
    assert.equal(verify.flaky, true);
    const [first, second] = verify.run_dirs;
    assert.notEqual(first, second);
    assert.deepEqual(readJsonSafe(path.join(first, 'verify-result.json')).commands.map((c) => c.exit_code), [0, 7]);
    assert.deepEqual(readJsonSafe(path.join(second, 'verify-result.json')).commands.map((c) => c.exit_code), [0, 0, 0]);
    assert.equal(fs.existsSync(path.join(first, 'cmd-3')), false);
    assert.match(fs.readFileSync(path.join(first, 'cmd-2', 'stderr.log'), 'utf8'), /temporary failure/);
    assert.ok(fs.existsSync(path.join(second, 'cmd-2', 'stderr.log')));
    const pack = readJsonSafe(ctx.paths.statePath).packs.W;
    assert.equal(pack.status, 'REVIEW');
    assert.deepEqual([pack.tier1_repairs, pack.tier2_repairs], [0, 0]);
    assert.equal(pack.last_verify.passed, true);
    assert.equal(pack.last_verify.flaky, true);
    assert.deepEqual(pack.last_verify.run_dirs, verify.run_dirs);
    assert.deepEqual(readJsonSafe(ctx.paths.lessonsJsonPath, { items: [] }).items, []);
    const events = readEvents(ctx.paths.eventsPath).filter((event) => event.type === 'verify_recorded');
    assert.equal(events.length, 1);
    assert.equal(events[0].flaky, true);
    assert.deepEqual(events[0].run_dirs, verify.run_dirs);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

function setupBaselineVerification({ commands, verifyCommands, retryOnce = false } = {}) {
  const command = `${shellQuote(process.execPath)} full-suite.mjs`;
  const { repoDir, ctx } = setupCtx([{ id: 'W', verify_commands: verifyCommands }], {
    verification: {
      commands, retry_once: retryOnce,
      baseline: { command, failure_pattern: '^(?:FAILED|ERROR) (\\S+)' }
    },
    review: { mode: 'none' }
  });
  fs.writeFileSync(path.join(repoDir, 'full-suite.mjs'), `
import fs from 'node:fs';
const file = 'full-suite.json';
const runs = JSON.parse(fs.readFileSync(file, 'utf8'));
const { stdout = '', stderr = '', code = 0, encoding = 'utf8' } = runs[0];
if (runs.length > 1) fs.writeFileSync(file, JSON.stringify(runs.slice(1)));
process.stdout.write(stdout, encoding);
process.stderr.write(stderr, encoding);
process.exitCode = code;
`);
  const setSuite = (...runs) => writeJsonAtomic(path.join(repoDir, 'full-suite.json'), runs);
  return { repoDir, ctx, command, setSuite };
}

test('baseline records decoded failures, reports regressions in repair tasks, and only shrinks at commit', () => {
  const { repoDir, ctx, command, setSuite } = setupBaselineVerification();
  const { baselinePath, eventsPath, statePath } = ctx.paths;
  try {
    ctx.config.verification.output_encoding = 'utf-16le';
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    const old = {
      stdout: 'FAILED old::z\nFAILED old::a\n',
      stderr: 'ERROR old::修复\nFAILED old::a\n',
      encoding: 'utf16le', code: 1
    };
    setSuite(old);
    const recorded = runCli(['verify', '--record-baseline'], repoDir);
    assert.equal(recorded.command, command);
    assert.equal(recorded.exit_code, 1);
    assert.equal(recorded.head, null);
    assert.ok(Number.isFinite(Date.parse(recorded.recorded_at)));
    assert.deepEqual(recorded.failures, ['old::a', 'old::z', 'old::修复']);
    assert.deepEqual(readJsonSafe(baselinePath), recorded);
    const [event] = readEvents(eventsPath);
    assert.deepEqual(event, { ts: event.ts, type: 'baseline_recorded', ...recorded });
    assert.equal(readJsonSafe(statePath).packs.W.status, 'PENDING');

    runCli(['next'], repoDir);
    const initial = runCli(['dispatch', '--dry-run'], repoDir);
    const initialTask = fs.readFileSync(path.join(initial.run_dir, 'task.md'), 'utf8');
    assert.match(initialTask, /## 全量测试\n\n/);
    assert.ok(initialTask.includes(command));
    assert.match(initialTask, /本来就失败的有 3 条/);
    assert.ok(initialTask.includes(baselinePath.replace(/\\/g, '/')));
    assert.match(initialTask, /只有名单外的新失败算本包的。交回前请跑一次全量命令/);
    runCli(['record', 'implement', '--passed'], repoDir);
    assert.match(runCliFailure(['record', 'verify', '--passed'], repoDir).stderr, /run "grow-loop verify"/);
    const existing = runCli(['verify'], repoDir);
    assert.equal(existing.passed, true);
    assert.deepEqual(existing.commands.map(({ source, exit_code }) => [source, exit_code]), [['baseline', 1]]);
    assert.deepEqual(existing.baseline, { failures: recorded.failures, fixed: [] });

    runCli(['record', 'implement', '--passed'], repoDir);
    setSuite({ ...old, stderr: old.stderr + 'FAILED new::case\n' });
    const regressed = runCli(['verify'], repoDir);
    assert.equal(regressed.passed, false);
    assert.equal(regressed.summary, '全量测试新增 1 条失败');
    assert.deepEqual(regressed.failure.test_names, ['new::case']);
    const repair = runCli(['dispatch', '--dry-run'], repoDir);
    const repairTask = fs.readFileSync(path.join(repair.run_dir, 'task.md'), 'utf8');
    assert.match(repairTask, /### Failed Tests\n- new::case\n\n/);
    assert.match(repairTask, /## 全量测试\n\n/);
    assert.match(repairTask, /本来就失败的有 3 条/);

    runCli(['record', 'implement', '--passed'], repoDir);
    setSuite({ ...old, stderr: '' });
    const fixed = runCli(['verify'], repoDir);
    assert.equal(fixed.passed, true);
    assert.deepEqual(fixed.baseline, { failures: ['old::a', 'old::z'], fixed: ['old::修复'] });
    assert.deepEqual(readJsonSafe(statePath).packs.W.last_verify.baseline, fixed.baseline);
    assert.deepEqual(readJsonSafe(baselinePath), recorded);

    // Simulate another package removing old::z before this package records its commit.
    writeJsonAtomic(baselinePath, { ...recorded, failures: ['old::a', 'old::修复'] });
    const commit = runCli(['record', 'commit', '--sha', '111111111111'], repoDir);
    assert.equal(commit.outcome, 'committed');
    assert.deepEqual(readJsonSafe(baselinePath), { ...recorded, failures: ['old::a'] });
    const updates = readEvents(eventsPath).filter(({ type }) => type === 'baseline_updated');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].pack_id, 'W');
    assert.deepEqual(updates[0].removed, ['old::修复']);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('baseline setup errors and crashed commands never approve or replace a baseline', () => {
  const { repoDir, ctx, setSuite } = setupBaselineVerification();
  const { baselinePath, configPath, eventsPath } = ctx.paths;
  try {
    const baseline = ctx.config.verification.baseline;
    delete ctx.config.verification.baseline;
    writeJsonAtomic(configPath, ctx.config);
    assert.match(runCliFailure(['verify', '--record-baseline'], repoDir).stderr, /config.json.*verification\.baseline\.command/);
    assert.match(runCliFailure(['verify', '--record-baseline', '--mark-env', 'example'], repoDir).stderr, /--record-baseline 和 --mark-env 不能一起用/);

    for (const failure_pattern of ['^(?:FAILED|ERROR) \\S+', '^(FAILED) (\\S+)', '(']) {
      ctx.config.verification.baseline = { ...baseline, failure_pattern };
      writeJsonAtomic(configPath, ctx.config);
      assert.match(runCliFailure(['verify', '--record-baseline'], repoDir).stderr, /verification\.baseline\.failure_pattern/);
    }
    ctx.config.verification.baseline = baseline;
    writeJsonAtomic(configPath, ctx.config);
    setSuite({ stderr: 'runner stopped before collecting tests\n', code: 2 });
    assert.match(runCliFailure(['verify', '--record-baseline'], repoDir).stderr, /全量测试跑挂了[^\n]*\nrunner stopped/);
    assert.equal(fs.existsSync(baselinePath), false);

    runCli(['next'], repoDir);
    runCli(['record', 'implement', '--passed'], repoDir);
    assert.match(runCliFailure(['verify'], repoDir).stderr, /缺少 baseline\.json.*--record-baseline/);
    setSuite({ stdout: 'FAILED old::case\n', code: 1 });
    const recorded = runCli(['verify', '--record-baseline'], repoDir);
    setSuite({ stderr: 'runner stopped before collecting tests\n', code: 2 });
    const crashed = runCli(['verify'], repoDir);
    assert.equal(crashed.passed, false);
    assert.match(crashed.summary, /全量测试跑挂了/);
    assert.match(crashed.failure.excerpt, /runner stopped/);
    assert.deepEqual(crashed.failure.test_names, []);
    assert.deepEqual(crashed.baseline.fixed, []);
    assert.match(runCliFailure(['verify', '--record-baseline'], repoDir).stderr, /全量测试跑挂了/);
    assert.deepEqual(readJsonSafe(baselinePath), recorded);
    assert.equal(readEvents(eventsPath).filter(({ type }) => type === 'baseline_recorded').length, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('baseline retries all checks after new failures and records a flaky pass', () => {
  const node = shellQuote(process.execPath);
  const { repoDir, ctx, setSuite } = setupBaselineVerification({
    commands: [`${node} --version`], verifyCommands: [`${node} --version`], retryOnce: true
  });
  try {
    setSuite({ stdout: 'all tests passed\n' });
    assert.deepEqual(runCli(['verify', '--record-baseline'], repoDir).failures, []);
    runCli(['next'], repoDir);
    runCli(['record', 'implement', '--passed'], repoDir);
    setSuite({ stdout: 'FAILED new::flaky\n', code: 1 }, { stdout: 'all tests passed\n' });
    const verified = runCli(['verify'], repoDir);
    assert.equal(verified.passed, true);
    assert.equal(verified.flaky, true);
    assert.equal(verified.run_dirs.length, 2);
    const [first, second] = verified.run_dirs.map((dir) => readJsonSafe(path.join(dir, 'verify-result.json')));
    assert.deepEqual(first.commands.map(({ source, exit_code }) => [source, exit_code]), [
      ['global', 0], ['pack', 0], ['baseline', 1]
    ]);
    assert.deepEqual(first.failure.test_names, ['new::flaky']);
    assert.deepEqual(second.commands.map(({ source, exit_code }) => [source, exit_code]), [
      ['global', 0], ['pack', 0], ['baseline', 0]
    ]);
    const pack = readJsonSafe(ctx.paths.statePath).packs.W;
    assert.equal(pack.tier1_repairs, 0);
    assert.equal(pack.last_verify.flaky, true);
    const events = readEvents(ctx.paths.eventsPath).filter(({ type }) => type === 'verify_recorded');
    assert.equal(events.length, 1);
    assert.equal(events[0].flaky, true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('mark-env undoes escalation or the budget gate, preserves unrelated lessons, and closes at dispatch', () => {
  for (const exhausted of [false, true]) {
    const { repoDir, stateDir, ctx } = setupCtx([{ id: 'W' }], {
      verification: { commands: [`${shellQuote(process.execPath)} broken.mjs`], retry_once: false },
      budgets: { tier1_max_repairs: 0, tier2_max_repairs: exhausted ? 0 : 2 }
    });
    try {
      fs.writeFileSync(path.join(repoDir, 'broken.mjs'), `
import fs from 'node:fs';
if (!fs.existsSync('service-ready')) {
  console.error('local service unavailable');
  process.exitCode = 4;
}
`);
      const earlier = addLesson(stateDir, ctx.config, { pack_id: 'W', stage: 'IMPLEMENT', summary: 'Earlier implementation lesson' });
      runCli(['next'], repoDir);
      runCli(['record', 'implement', '--passed', '--session-id', 'original-session'], repoDir);
      const failure = runCli(['verify'], repoDir);
      assert.equal(failure.transition.outcome, exhausted ? 'paused_budget_exceeded' : 'escalated_tier2');
      if (exhausted) {
        assert.deepEqual(failure.question, failure.transition.question);
        assert.deepEqual(failure.question.options.map(({ id }) => id), failure.transition.gate.allowed_resume_actions);
      }
      assert.equal(failure.run_dirs.length, 1);
      const failedPack = readJsonSafe(ctx.paths.statePath).packs.W;
      assert.equal(failedPack.current_tier, exhausted ? 'tier1' : 'tier2');
      assert.equal(failedPack.last_session_id, exhausted ? 'original-session' : null);
      assert.match(runCliFailure(['verify', '--mark-env'], repoDir).stderr, /non-empty reason/);
      assert.match(runCliFailure(['verify', '--mark-env', '   '], repoDir).stderr, /non-empty reason/);

      const reason = '本机测试服务未启动';
      if (exhausted) fs.writeFileSync(path.join(repoDir, 'service-ready'), '');
      const rerun = runCli(['verify', '--mark-env', reason], repoDir);
      assert.equal(rerun.passed, exhausted);
      assert.equal(rerun.transition.outcome, exhausted ? 'ready_for_review' : 'verify_environment_failed');
      assert.notEqual(rerun.run_dir, failure.run_dir);
      const pack = readJsonSafe(ctx.paths.statePath).packs.W;
      assert.equal(pack.status, exhausted ? 'REVIEW' : 'VERIFY');
      assert.equal(pack.current_tier, 'tier1');
      assert.equal(pack.active_instance, 'tier1-cli');
      assert.equal(pack.last_session_id, 'original-session');
      assert.equal(pack.escalated, false);
      assert.equal(pack.escalation_reason, null);
      assert.equal(pack.gate, null);
      assert.deepEqual([pack.tier1_repairs, pack.tier2_repairs], [0, 0]);
      assert.equal(pack.repair_rounds, 0);
      assert.equal(pack.last_verify.environment_reason, reason);
      assert.equal(pack.last_verify.repair_undo, undefined);
      assert.deepEqual(readJsonSafe(ctx.paths.lessonsJsonPath).items, [earlier]);
      assert.deepEqual(runCli(['lesson', 'list', '--status', 'draft'], repoDir).items.map(({ id }) => id), [earlier.id]);
      assert.doesNotMatch(fs.readFileSync(ctx.paths.lessonsMdPath, 'utf8'), /local service unavailable/);
      const marked = readEvents(ctx.paths.eventsPath).find((event) => event.type === 'verify_marked_environment');
      assert.equal(marked.reason, reason);
      assert.deepEqual(marked.run_dirs, failure.run_dirs);
      assert.equal(marked.removed_lesson_id, failedPack.last_verify.repair_undo.lesson_id);

      if (!exhausted) {
        assert.match(runCliFailure(['verify', '--mark-env', reason], repoDir).stderr, /no verification failure eligible/);
        runCli(['verify'], repoDir);
        runCli(['pack', 'tier', '--id', 'W', '--tier', 'tier2', '--reason', 'Keep the specialist executor'], repoDir);
        runCli(['verify', '--mark-env', reason], repoDir);
        const manuallyRouted = readJsonSafe(ctx.paths.statePath).packs.W;
        assert.equal(manuallyRouted.current_tier, 'tier2');
        assert.equal(manuallyRouted.active_instance, 'tier2-cli');
        assert.equal(manuallyRouted.tier2_repairs, 0);
        assert.match(manuallyRouted.escalation_reason, /Keep the specialist executor/);
        runCli(['verify'], repoDir);
        runCli(['dispatch', '--dry-run'], repoDir);
        assert.ok(readJsonSafe(ctx.paths.statePath).packs.W.last_verify.repair_undo);
        const dispatched = runCli(['dispatch'], repoDir);
        assert.equal(dispatched.result.status, 'host_action_required');
        assert.equal(readJsonSafe(ctx.paths.statePath).packs.W.last_verify.repair_undo, undefined);
        assert.match(runCliFailure(['verify', '--mark-env', reason], repoDir).stderr, /no verification failure eligible/);
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }
});

test('verification supplies environment overrides and prepends PATH while decoding split UTF-8 and GBK output', () => {
  const windows = process.platform === 'win32';
  const command = `${shellQuote(process.execPath)} print.mjs`;
  const { repoDir, ctx } = setupCtx([{ id: 'W' }], { verification: { commands: [command] } });
  try {
    const prefixes = ['first tool dir', 'second tool dir'].map((dir) => path.join(repoDir, dir));
    Object.assign(ctx.config.verification, {
      env: {
        W4_TEST_VALUE: 'configured',
        ...(windows && { pAtH: path.join(repoDir, 'configured-path'), pythonutf8: '0' })
      },
      path_prepend: prefixes
    });
    fs.writeFileSync(path.join(repoDir, 'print.mjs'), `
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const pathKeys = Object.keys(process.env).filter((key) => key.toUpperCase() === 'PATH');
console.log(JSON.stringify({
  value: process.env.W4_TEST_VALUE,
  path: process.env.PATH.split(path.delimiter),
  pathKeyCount: pathKeys.length,
  pythonUtf8: process.env.PYTHONUTF8,
  pythonIOEncoding: process.env.PYTHONIOENCODING
}));
const bytes = process.env.W4_TEST_ENCODING === 'gbk' ? Buffer.from('d6d0cec4d1e9d6a4', 'hex') : Buffer.from('中文验证');
process.stdout.write(bytes.subarray(0, 1));
await delay(40);
process.stdout.write(bytes.subarray(1));
process.stderr.write(bytes.subarray(0, 1));
await delay(40);
process.stderr.write(bytes.subarray(1));
`);
    runCli(['next'], repoDir);
    for (const encoding of [undefined, 'gbk']) {
      ctx.config.verification.output_encoding = encoding;
      ctx.config.verification.env.W4_TEST_ENCODING = encoding ?? 'utf-8';
      writeJsonAtomic(ctx.paths.configPath, ctx.config);
      runCli(['record', 'implement', '--passed'], repoDir);
      const next = runCli(['next'], repoDir);
      assert.deepEqual(next.verification.commands, [command]);
      assert.equal(next.verification.env, undefined);
      assert.equal(next.verification.path_prepend, undefined);
      const result = runCli(['verify'], repoDir);
      assert.equal(result.passed, true, result.summary);
      const [metadata, output] = fs.readFileSync(result.commands[0].stdout_log, 'utf8').split(/\r?\n/);
      const env = JSON.parse(metadata);
      assert.equal(env.value, 'configured');
      assert.deepEqual(env.path.slice(0, 2), prefixes);
      if (windows) {
        assert.equal(env.pathKeyCount, 1);
        assert.equal(env.path[2], ctx.config.verification.env.pAtH);
        assert.equal(env.pythonIOEncoding, 'utf-8');
        assert.equal(env.pythonUtf8, '0');
      }
      assert.equal(output, '中文验证');
      assert.equal(fs.readFileSync(result.commands[0].stderr_log, 'utf8'), '中文验证');
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('pack verification follows global checks, gates self-reports, and supplies repair diagnostics', () => {
  const node = shellQuote(process.execPath);
  const globalCommand = `${node} global.mjs`;
  const packCommand = `${node} pack.mjs`;
  const { repoDir, ctx } = setupCtx([{ id: 'W' }, { id: 'PACK', verify_commands: [packCommand] }], {
    verification: { commands: [globalCommand], retry_once: false }
  });
  try {
    fs.writeFileSync(path.join(repoDir, 'global.mjs'), "import fs from 'node:fs'; fs.writeFileSync('global-ran', 'ok'); console.log('global ran');");
    fs.writeFileSync(path.join(repoDir, 'pack.mjs'), `
import fs from 'node:fs';
if (!fs.existsSync('global-ran')) throw new Error('Global check should run first');
console.log('not ok 1 - tap checkout');
console.log('  AssertionError: cart count mismatch');
console.log('✖ spec checkout (2ms)');
console.log('FAILED tests/test_refund.py::test_refund - AssertionError: refund rejected');
console.error('E   assert total == 0');
console.error('[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0 -- in CheckoutTest');
console.error('[ERROR] CheckoutTest.refund:42 expected: <0> but was: <1>');
for (let i = 0; i < 100; i++) console.log('verbose output line ' + i + ': ' + 'x'.repeat(90));
process.exitCode = 5;
`);
    runCli(['next'], repoDir);
    runCli(['record', 'implement', '--pack', 'W', '--passed'], repoDir);
    const global = runCli(['verify', '--pack', 'W'], repoDir);
    assert.equal(global.passed, true);
    assert.deepEqual(global.commands.map((c) => [c.command, c.source]), [[globalCommand, 'global']]);
    fs.unlinkSync(path.join(repoDir, 'global-ran'));

    const initial = runCli(['dispatch', '--pack', 'PACK', '--dry-run'], repoDir);
    const initialTask = fs.readFileSync(path.join(initial.run_dir, 'task.md'), 'utf8');
    assert.ok(initialTask.includes('`' + globalCommand + '` (global)'));
    assert.ok(initialTask.includes('`' + packCommand + '` (pack)'));
    runCli(['record', 'implement', '--pack', 'PACK', '--passed'], repoDir);
    const combined = runCli(['verify', '--pack', 'PACK'], repoDir);
    assert.deepEqual(combined.commands.map((c) => [c.command, c.source, c.exit_code]), [
      [globalCommand, 'global', 0], [packCommand, 'pack', 5]
    ]);
    const [globalResult, packResult] = combined.commands;
    assert.match(fs.readFileSync(globalResult.stdout_log, 'utf8'), /global ran/);
    assert.notEqual(path.dirname(globalResult.stdout_log), path.dirname(packResult.stdout_log));
    const failure = readJsonSafe(ctx.paths.statePath).packs.PACK.last_verify.failure;
    assert.deepEqual(failure.test_names, [
      'tap checkout', 'spec checkout', 'tests/test_refund.py::test_refund', 'CheckoutTest', 'CheckoutTest.refund'
    ]);
    assert.match(failure.excerpt, /verbose output line 99/);
    assert.doesNotMatch(failure.excerpt, /tap checkout/);
    assert.ok(failure.excerpt.length <= 6000);
    for (const line of [
      'AssertionError: cart count mismatch',
      'E   assert total == 0',
      '[ERROR] CheckoutTest.refund:42 expected: <0> but was: <1>'
    ]) {
      assert.ok(failure.assertion_lines.includes(line), line);
    }
    const repair = runCli(['dispatch', '--pack', 'PACK', '--dry-run'], repoDir);
    const task = fs.readFileSync(path.join(repair.run_dir, 'task.md'), 'utf8');
    assert.match(task, /## Last Machine Verification Failure/);
    assert.match(task, /Exit code: 5/);
    assert.match(task, /Timed out: no/);
    for (const detail of [
      ...failure.test_names, ...failure.assertion_lines, packResult.stdout_log, packResult.stderr_log,
      '`' + globalCommand + '` (global)', '`' + packCommand + '` (pack)'
    ]) {
      assert.ok(task.includes(detail), detail);
    }

    ctx.config.verification.commands = ['# disabled', ''];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    runCli(['record', 'implement', '--pack', 'PACK', '--passed'], repoDir);
    assert.match(runCliFailure(['record', 'verify', '--pack', 'PACK', '--passed'], repoDir).stderr, /run "grow-loop verify"/);
    const packageOnly = runCli(['verify', '--pack', 'PACK'], repoDir);
    assert.deepEqual(packageOnly.commands.map((c) => [c.command, c.source]), [[packCommand, 'pack']]);
    runCli(['record', 'implement', '--pack', 'W', '--passed'], repoDir);
    assert.match(runCliFailure(['verify', '--pack', 'W'], repoDir).stderr, /No runnable verification\.commands.*or verify_commands/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

function reviewMarkdown(verdict, findings) {
  return `VERDICT: ${verdict.toUpperCase()}\n\n\`\`\`json\n${JSON.stringify({ verdict, summary: 'Review complete', findings }, null, 2)}\n\`\`\`\n`;
}

test('review reports validate the conclusion, JSON fence and findings with locations', () => {
  const pass = reviewMarkdown('pass', [{ severity: 'lOw', title: 'Clarify retry log', locator: 'src/retry.mjs' }]);
  const bold = pass.replace('VERDICT: PASS', '  **VERDICT: PASS**  ').replaceAll('\n', '\r\n');
  assert.deepEqual(parseReviewReport(bold), {
    verdict: 'PASS', summary: 'Review complete', findings: [{ severity: 'LOW', title: 'Clarify retry log', locator: 'src/retry.mjs' }]
  });

  const cases = [
    [pass.replace('VERDICT: PASS', 'Review complete'), /VERDICT line/],
    ['VERDICT: PASS\n```text\n```', /JSON block.*one fenced/],
    [`${pass}\n\`\`\`json\n{}\n\`\`\``, /Line \d+, JSON block.*only one/],
    [pass.replace(/```\n$/, ''), /Line 3, JSON block.*closing fence/],
    ['VERDICT: PASS\n```json\n{\n  "findings": [1,]\n}\n```', /Line 4, column 18, JSON block.*syntax/],
    ['VERDICT: PASS\n```json\n{\n  "findings": [],\n}\n```', /Line 5, column 1, JSON block.*syntax/],
    [pass.replace('VERDICT: PASS', 'VERDICT: FAIL'), /verdict.*disagrees with VERDICT on line 1/],
    [reviewMarkdown('pass', {}), /findings.*array/],
    ...[undefined, 'CRITICAL', 'P1', 'Medium-High'].map((severity) => [
      reviewMarkdown('pass', [{ severity: 'LOW', title: 'Valid' }, { severity, title: 'Check severity' }]), /finding 2, severity/
    ]),
    [reviewMarkdown('pass', [{ severity: 'LOW' }]), /finding 1, title/],
    [reviewMarkdown('fail', [{ severity: 'LOW', title: 'Only a low' }]), /findings.*FAIL requires/],
    [reviewMarkdown('fail', []), /findings.*FAIL requires/],
    [reviewMarkdown('pass', [{ severity: 'HIGH', title: 'Blocking' }]), /finding 1, severity.*PASS cannot include/]
  ];
  for (const [markdown, diagnostic] of cases) {
    const result = parseReviewReport(markdown);
    assert.match(result.errors?.join('\n') || '', diagnostic);
  }
});

test('dispatch records valid reviews, rejects invalid reports, and settles in-round tech debt after self-review', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W5', scope_files: ['src/retry.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const mock = path.join(repoDir, 'mock-review.cjs');
  const report = path.join(repoDir, 'review.md');
  const legacy = '# Prior tech debt\r\n\r\n- Preserve this entry exactly.\r\n';
  const findings = [
    { severity: 'HIGH', title: 'Retry skips verification', locator: 'src/retry.mjs#verify', rule: 'Verify after each retry' },
    { severity: 'low', title: 'Clarify retry log', detail: 'Include the attempt number' },
    { severity: 'MEDIUM', title: 'Forward elapsed time' }
  ];
  const readPack = () => readJsonSafe(ctx.paths.statePath).packs.W5;
  try {
    fs.writeFileSync(ctx.paths.techDebtMdPath, legacy);
    fs.writeFileSync(mock, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      process.stdin.resume();
      if (args[args.indexOf('--sandbox') + 1] !== 'read-only') throw new Error('Reviewer must be read-only');
      fs.copyFileSync(${JSON.stringify(report)}, args[args.indexOf('--output-last-message') + 1]);
      process.exitCode = args.includes('--mock-fail') ? 2 : 0;
    `);
    const reviewer = { kind: 'codex', executable: process.execPath, prefix_args: [mock], model: 'review-model' };
    ctx.config.executors['reviewer-cli'] = reviewer;
    ctx.config.executors.self.model = 'host-review-model';
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');
    cli('record', 'implement', '--passed');
    cli('record', 'verify', '--passed', '--allow-self-report');
    const awaitingReview = readPack();
    assert.equal(awaitingReview.status, 'REVIEW');

    const valid = reviewMarkdown('fail', findings);
    for (const [markdown, expected] of [
      [valid.replace('VERDICT: FAIL', 'Review complete'), /VERDICT line/],
      [valid.replace('"low"', '"CRITICAL"'), /finding 2, severity/]
    ]) {
      fs.writeFileSync(report, markdown);
      const rejected = fail('dispatch', '--stage', 'review');
      assert.equal(rejected.status, 1);
      const { result, transition } = JSON.parse(rejected.stdout);
      assert.equal(result.status, 'completed');
      assert.equal(result.read_only, true);
      assert.equal(transition.outcome, 'review_report_invalid');
      assert.equal(transition.report_path, result.final_md);
      assert.match(transition.errors.join('\n'), expected);
      assert.deepEqual(readPack(), awaitingReview);
    }
    assert.equal(fail('record', 'review', '--report', path.join(repoDir, 'missing.md')).status, 1);
    assert.deepEqual(readPack(), awaitingReview);
    const rejectedEvents = readEvents(ctx.paths.eventsPath);
    assert.equal(rejectedEvents.filter(({ type }) => type === 'review_report_invalid').length, 3);
    assert.equal(rejectedEvents.filter(({ type }) => type === 'review_recorded').length, 0);
    assert.equal(fs.existsSync(ctx.paths.techDebtJsonPath), false);

    fs.writeFileSync(report, valid);
    reviewer.prefix_args = [mock, '--mock-fail'];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    const failedRun = cli('dispatch', '--stage', 'review');
    assert.equal(failedRun.result.status, 'failed');
    assert.equal(failedRun.transition, null);
    assert.deepEqual(readPack(), awaitingReview);
    reviewer.prefix_args = [mock];
    writeJsonAtomic(ctx.paths.configPath, ctx.config);

    const run = cli('dispatch', '--stage', 'review');
    assert.equal(run.transition.outcome, 'repair_tier1');
    assert.equal(readPack().status, 'IMPLEMENT');
    assert.deepEqual(readPack().pending_blocking_findings, [findings[0]]);
    assert.equal(readPack().last_review.reviewer, 'reviewer-cli');
    assert.equal(readPack().last_review.reviewer_model, 'review-model');
    assert.deepEqual(readJsonSafe(ctx.paths.techDebtJsonPath).items.map(({ status }) => status), ['IN_ROUND', 'IN_ROUND']);
    assert.deepEqual(cli('status', '--format', 'shell').pending, { manifest_change: null, lesson_drafts: 1, open_todos: 0, in_round_tech_debt: 2 });
    const repair = cli('dispatch', '--dry-run');
    const repairTask = fs.readFileSync(path.join(repair.run_dir, 'task.md'), 'utf8');
    assert.match(repairTask, /## Blocking Findings to Fix\r?\n- .*Retry skips verification/);
    assert.match(repairTask, /## 顺手一起修（不阻断）\r?\n- .*Clarify retry log/);
    const [draft] = readJsonSafe(ctx.paths.lessonsJsonPath).items;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.rule, findings[0].rule);
    assert.doesNotMatch(repairTask, /## Injected Lessons/);

    cli('record', 'implement', '--passed');
    cli('record', 'verify', '--passed', '--allow-self-report');
    const roundTwo = cli('dispatch', '--stage', 'review', '--dry-run');
    const reviewTask = fs.readFileSync(path.join(roundTwo.run_dir, 'task.md'), 'utf8');
    assert.match(reviewTask, /Round 2\/2/);
    assert.match(reviewTask, /Verify ONLY the listed prior findings and any new `BLOCKER` or `HIGH` regressions introduced by the repair/);
    assert.match(reviewTask, /## 顺手一起修（不阻断）\s+只核对下列条目。仍未修好的按原 `title` 再报一次，已修好的省略。\s+- .*Clarify retry log/);

    fs.writeFileSync(report, reviewMarkdown('pass', [findings[2]]));
    assert.equal(cli('record', 'review', '--report', report).outcome, 'review_passed');
    assert.equal(readPack().status, 'READY_TO_COMMIT');
    assert.equal(readPack().review_rounds, 2);
    assert.equal(readPack().last_review.reviewer, 'self');
    assert.equal(readPack().last_review.reviewer_model, 'host-review-model');
    const debt = readJsonSafe(ctx.paths.techDebtJsonPath);
    assert.equal(debt.legacy_markdown, legacy);
    assert.deepEqual(debt.items.map(({ finding, status, fixed_in_pack }) => [finding.title, status, fixed_in_pack]), [
      ['Clarify retry log', 'FIXED', 'W5'], ['Forward elapsed time', 'PENDING', undefined]
    ]);
    const rendered = fs.readFileSync(ctx.paths.techDebtMdPath, 'utf8');
    assert.ok(rendered.includes(`## 旧记录\n\n${legacy}`));
    assert.match(rendered, /~~\*\*\[LOW\]\*\* Clarify retry log: Include the attempt number~~ — 已修（在 W5 修掉）/);
    assert.match(rendered, /\[MEDIUM\].*Forward elapsed time — 待办/);
    const outcomes = readEvents(ctx.paths.eventsPath).filter(({ type }) => type === 'review_recorded');
    assert.deepEqual(outcomes.map(({ reviewer: instance, reviewer_model: model, verdict }) => [instance, model, verdict]), [
      ['reviewer-cli', 'review-model', 'FAIL'], ['self', 'host-review-model', 'PASS']
    ]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('review severity floor overrides fail on MEDIUM/LOW only, and 2-round review cap stops adversarial loops', () => {
  // Case A: MEDIUM/LOW only -> overrides fail -> PASS + tech-debt.md
  const a = setupCtx([{ id: 'W01', title: 'Severity floor', risk: 'low', estimated_files: 5 }]);
  try {
    startOrAdvanceActivePack(a.ctx);
    recordImplementOutcome(a.ctx, { passed: true });
    recordVerifyOutcome(a.ctx, { passed: true, summary: 'ok' });
    const rev = recordReviewOutcome(a.ctx, {
      verdict: 'fail',
      findings: [
        { severity: 'MEDIUM', title: 'Naming nitpick', locator: 'src/a.js:foo' },
        { severity: 'LOW', title: 'Minor doc typo', locator: 'README.md' }
      ],
      summary: 'Only style notes'
    });
    assert.equal(rev.outcome, 'review_passed');
    assert.equal(rev.severity_floor_overridden, true);
    assert.equal(rev.tech_debt_recorded, 2);
    assert.equal(a.ctx.state.packs.W01.status, 'READY_TO_COMMIT');
    const debt = fs.readFileSync(a.ctx.paths.techDebtMdPath, 'utf8');
    assert.match(debt, /Naming nitpick/);
    assert.match(debt, /Minor doc typo/);
  } finally {
    fs.rmSync(a.repoDir, { recursive: true, force: true });
  }

  // Case B: tier1 hits 2/2 review cap -> escalates to tier2 -> after VERIFY pauses for commit sign-off (NO 3rd review)
  const b = setupCtx([{ id: 'W01', title: 'Review cap on tier1', risk: 'low', estimated_files: 5 }]);
  try {
    startOrAdvanceActivePack(b.ctx);
    recordImplementOutcome(b.ctx, { passed: true });
    recordVerifyOutcome(b.ctx, { passed: true, summary: 'build ok' });

    // Review R1 fails with empty findings -> synthesizes HIGH finding and schedules tier1 repair #1
    const r1 = recordReviewOutcome(b.ctx, { verdict: 'fail', findings: [], summary: 'Missing auth check' });
    assert.equal(r1.outcome, 'repair_tier1');
    assert.equal(b.ctx.state.packs.W01.pending_blocking_findings.length, 1);

    // Repair 1 -> Verify -> Review R2 fails with HIGH -> escalates to tier2
    recordImplementOutcome(b.ctx, { passed: true });
    recordVerifyOutcome(b.ctx, { passed: true, summary: 'build ok' });
    const r2 = recordReviewOutcome(b.ctx, {
      verdict: 'fail',
      findings: [
        { severity: 'HIGH', title: 'Missing transaction boundary', locator: 'Service.save' },
        { severity: 'LOW', title: 'Add transaction metrics' }
      ]
    });
    assert.equal(r2.outcome, 'escalated_tier2_on_review_cap');
    assert.equal(b.ctx.state.packs.W01.current_tier, 'tier2');

    // Tier2 fixes & passes VERIFY -> does NOT open 3rd review; pauses for human commit sign-off
    recordImplementOutcome(b.ctx, { passed: true });
    const vFinal = recordVerifyOutcome(b.ctx, { passed: true, summary: 'all checks green' });
    assert.equal(vFinal.outcome, 'paused_review_cap_verified');
    assert.deepEqual(vFinal.question.options.map(({ id }) => id), ['commit', 'repair', 'abort']);
    assert.equal(b.ctx.state.packs.W01.gate.reason, ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED);
    assert.equal(readJsonSafe(b.ctx.paths.techDebtJsonPath).items[0].status, 'IN_ROUND');
    runCli(['resume', '--action', 'commit', '--decision', 'Verification passed after the review cap'], b.repoDir);
    runCli(['record', 'commit', '--sha', '111111111111'], b.repoDir);
    assert.equal(readJsonSafe(b.ctx.paths.techDebtJsonPath).items[0].status, 'PENDING');
    assert.match(fs.readFileSync(b.ctx.paths.techDebtMdPath, 'utf8'), /Add transaction metrics — 待办/);
  } finally {
    fs.rmSync(b.repoDir, { recursive: true, force: true });
  }

  // Case C: tier2 hits 2/2 review cap -> pauses immediately
  const c = setupCtx([{ id: 'W01', title: 'Review cap on tier2', risk: 'high', estimated_files: 10 }]);
  try {
    startOrAdvanceActivePack(c.ctx);
    assert.equal(c.ctx.state.packs.W01.current_tier, 'tier2');
    recordImplementOutcome(c.ctx, { passed: true });
    recordVerifyOutcome(c.ctx, { passed: true, summary: 'ok' });
    recordReviewOutcome(c.ctx, {
      verdict: 'fail',
      findings: [{ severity: 'HIGH', title: 'Issue 1' }]
    });
    recordImplementOutcome(c.ctx, { passed: true });
    recordVerifyOutcome(c.ctx, { passed: true, summary: 'ok' });
    const r2 = recordReviewOutcome(c.ctx, {
      verdict: 'fail',
      findings: [{ severity: 'BLOCKER', title: 'Still broken' }]
    });
    assert.equal(r2.outcome, 'paused_review_cap_reached');
    assert.equal(c.ctx.state.packs.W01.gate.reason, ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED);
    resumeFromGate(c.ctx, { action: 'repair', decision: 'Allow a final repair' });
    recordImplementOutcome(c.ctx, { passed: true });
    recordVerifyOutcome(c.ctx, { passed: true });
    resumeFromGate(c.ctx, { action: 'commit', decision: 'Final repair verified' });
    recordCommitOutcome(c.ctx, { sha: '222222222222' });
    assert.equal(c.ctx.state.packs.W01.tier2_repairs, 1);
    assert.deepEqual(readJsonSafe(c.ctx.paths.lessonsJsonPath).items.map(({ repair_rounds }) => repair_rounds), [2, 2]);
  } finally {
    fs.rmSync(c.repoDir, { recursive: true, force: true });
  }
});

test('review report validation, routing and task briefs share configured blocking severities', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W', tags: ['retry'] }], {
    review: { blocking_severities: ['medium'] },
    verification: { commands: [] }
  });
  const cli = (...args) => runCli(args, repoDir);
  const report = path.join(repoDir, 'review.md');
  const medium = { severity: 'MEDIUM', title: 'Retry loses result' };
  const high = { severity: 'HIGH', title: 'Log evidence gap' };
  try {
    cli('next');
    cli('record', 'implement', '--passed');
    cli('record', 'verify', '--passed');
    assert.deepEqual(cli('next').blocking_severities, ['MEDIUM']);
    const preview = cli('dispatch', '--dry-run');
    const task = fs.readFileSync(path.join(preview.run_dir, 'task.md'), 'utf8');
    assert.match(task, /Use `FAIL` if any finding is `MEDIUM`/);
    fs.writeFileSync(report, reviewMarkdown('pass', [medium]));
    const invalid = runCliFailure(['record', 'review', '--report', report], repoDir);
    assert.match(JSON.parse(invalid.stdout).errors.join('\n'), /PASS cannot include/);
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.W.review_rounds, 0);

    fs.writeFileSync(report, reviewMarkdown('fail', [medium, high]));
    assert.equal(cli('record', 'review', '--report', report).outcome, 'repair_tier1');
    const pack = readJsonSafe(ctx.paths.statePath).packs.W;
    assert.deepEqual(pack.pending_blocking_findings, [medium]);
    const [draft] = readJsonSafe(ctx.paths.lessonsJsonPath).items;
    assert.deepEqual([draft.status, draft.severity, draft.tags, draft.repair_rounds], ['draft', 'MEDIUM', ['retry'], 0]);
    cli('record', 'implement', '--passed');
    cli('record', 'verify', '--passed');
    fs.writeFileSync(report, reviewMarkdown('pass', [high]));
    assert.equal(cli('record', 'review', '--report', report).outcome, 'review_passed');
    assert.equal(readJsonSafe(ctx.paths.techDebtJsonPath).items[0].status, 'PENDING');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('dispatch previews warn about incomplete briefs, scan references and create the external artifact directory', () => {
  const root = makeTempDir('grow-loop-brief-');
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const paths = getStatePaths(stateDir);
  const cli = (...args) => runCli([...args, '--state-dir', stateDir], repoDir);
  try {
    fs.mkdirSync(path.join(repoDir, 'src', 'a'), { recursive: true });
    const pack = { id: 'W3', scope_files: ['src\\a\\b.py', 'src/*.mjs', 'src/missing.ts'] };
    const manifestPath = path.join(root, 'delivery.json');
    writeJsonAtomic(manifestPath, { packs: [pack] });
    cli('init', '--manifest', manifestPath);
    const next = cli('next');
    assert.equal(next.action, 'IMPLEMENT');
    assert.equal(next.warnings.length, 3);

    const initial = cli('dispatch', '--dry-run');
    const task = fs.readFileSync(path.join(initial.run_dir, 'task.md'), 'utf8');
    assert.deepEqual(initial.warnings, next.warnings);
    const headings = ['避坑提示', '要一起改的文件', '要保住的旧行为', '已经定了的', '可能要一起改的文件', '转来的发现', '产物放哪'];
    assert.deepEqual([...task.matchAll(/^## (.+)$/gm)].map((match) => match[1]).filter((heading) => headings.includes(heading)), headings);
    assert.match(task, /没扫（当前目录不是 Git 仓库）/);
    const artifactsDir = path.join(paths.artifactsDir, 'W3');
    assert.ok(fs.statSync(artifactsDir).isDirectory());
    assert.ok(task.includes(artifactsDir.replace(/\\/g, '/') + '/'));
    assert.match(task, /报告、截图和草稿.*仓库/);

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    const files = {
      'src/a/b.py': 'b.py',
      'src/scoped.mjs': 'b.py',
      'together.mjs': 'b.py',
      'uses-file.md': 'See b.py',
      'uses-module.txt': 'import src.a.b',
      'uses-function.js': 'renderWidget(); preserve_widget();',
      'unrelated.js': 'renderWidgetExtra();'
    };
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repoDir, file), content);
    Object.assign(pack, {
      pitfalls: [
        '跟现有规则一致', '检查 renderWidget()', '核对 preserve_widget', '参见 `together.mjs`',
        '复用 src/together-file.mjs', '沿用 foo.bar'
      ],
      co_change_files: ['together.mjs'],
      preserve_behaviors: ['旧调用保持顺序']
    });
    writeJsonAtomic(paths.manifestPath, { packs: [pack] });
    cli('manifest-ack', '--reason', '确认任务书三栏');
    // Dispatch recreates the directory if it has been removed since the preview.
    fs.rmdirSync(artifactsDir);
    const second = cli('dispatch', '--dry-run');
    assert.equal(second.run_dir, initial.run_dir);
    assert.deepEqual(second.warnings, ['第 1 条避坑提示未点名代码：跟现有规则一致']);
    assert.deepEqual(cli('next').warnings, second.warnings);
    assert.ok(fs.statSync(artifactsDir).isDirectory());
    const updated = fs.readFileSync(path.join(second.run_dir, 'task.md'), 'utf8');
    const candidates = updated.split('## 可能要一起改的文件')[1].split('## 转来的发现')[0];
    assert.match(candidates, /可能要一起改，请确认/);
    assert.match(candidates, /uses-file\.md.*命中 `b\.py`/);
    assert.match(candidates, /uses-module\.txt.*命中 `src\.a\.b`/);
    assert.match(candidates, /uses-function\.js.*命中 `renderWidget`/);
    assert.doesNotMatch(candidates, /together\.mjs|scoped\.mjs|src\/a\/b\.py|unrelated\.js/);
    const live = cli('dispatch', '--instance', 'self');
    assert.equal(live.result.status, 'host_action_required');
    assert.deepEqual(live.warnings, second.warnings);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scope matcher uses Git glob rules and keeps literal entries exact', () => {
  const repoDir = path.resolve('fixture-repo');
  const cases = [
    ['src/*.mjs', ['src/a.mjs', 'src/.hidden.mjs'], ['src/sub/b.mjs', 'other/a.mjs']],
    ['**/x.mjs', ['x.mjs', 'a/b/x.mjs'], ['a/xx.mjs']],
    ['src/**/x.mjs', ['src/x.mjs', 'src/a/b/x.mjs'], ['other/src/x.mjs', 'src/a/xx.mjs']],
    ['tests/**', ['tests/x.test.mjs', 'tests/unit/nested/x.test.mjs'], ['tests', 'tests-extra/x.test.mjs']],
    ['src/a?b.mjs', ['src/acb.mjs'], ['src/a/b.mjs', 'src/ab.mjs', 'src/aéb.mjs']],
    ['src/[a-c].mjs', ['src/a.mjs', 'src/c.mjs'], ['src/d.mjs', 'src/ab.mjs']],
    ['src/[!a].mjs', ['src/b.mjs'], ['src/a.mjs', 'src/ab.mjs']],
    ['src/[[:digit:]].mjs', ['src/9.mjs'], ['src/a.mjs']],
    ['src/{a,b}.mjs', ['src/{a,b}.mjs'], ['src/a.mjs', 'src/b.mjs']],
    ['src', ['src'], ['src/a.mjs']]
  ];
  for (const [pattern, included, excluded] of cases) {
    const matcher = scopeMatcher(repoDir, [pattern]);
    for (const file of included) assert.equal(matcher.has(file), true, `${pattern} should match ${file}`);
    for (const file of excluded) assert.equal(matcher.has(file), false, `${pattern} should skip ${file}`);
  }
  for (const pattern of ['a*', 'a?', '[a']) assert.equal(hasGlob(pattern), true);
  for (const literal of ['a]', '{a,b}', 'src/a.mjs']) assert.equal(hasGlob(literal), false);

  const matcher = scopeMatcher(repoDir, ['.\\src\\*.mjs', path.join(repoDir, 'other', 'file.mjs'), '../outside.mjs']);
  assert.equal(matcher.has(path.join(repoDir, 'src', 'a.mjs')), true);
  assert.equal(matcher.has('other\\sub\\..\\file.mjs'), true);
  assert.equal(matcher.has('../outside.mjs'), false);
  assert.equal(scopeMatcher(repoDir, ['**']).has(path.resolve(repoDir, '..', 'outside.mjs')), false);
  assert.equal(repoRelativePath(path.join(repoDir, 'src', 'a.mjs'), repoDir), 'src/a.mjs');
  assert.equal(repoRelativePath('C:\\fixture-repo\\src\\a.mjs', 'C:\\fixture-repo'), 'src/a.mjs');
  assert.equal(repoRelativePath('Z:\\outside.mjs', 'C:\\fixture-repo'), null);
  assert.equal(repoRelativePath('src\\..\\..', repoDir), null);
  assert.equal(repoRelativePath('../outside.mjs', repoDir), null);
  assert.equal(repoRelativePath('/outside.mjs'), null);
});

test('dispatch warns about scope directories and unscoped tests named by package checks', () => {
  const pack = {
    id: 'A',
    scope_files: ['src/core.mjs', 'tests/', './checks\\allowed.test.mjs'],
    co_change_files: ['fixtures\\existing', 'later\\', 'test/test_allowed.py'],
    pitfalls: ['跟现有规则一致'],
    verify_commands: [
      'pytest test_core.py "tests/cases.py::test_create" --target="tests/test with spaces.py"::test_one',
      "node --test lib/fixture-private-marker.test.mjs lib/sample.spec.ts 'test/sample_test.go' __tests__/smoke",
      'node --test checks/allowed.test.mjs src/helper.mjs',
      'pytest .\\test\\test_allowed.py tests/cases.py::test_delete tests/generated ../tests/outside.py',
      "node --test 'elsewhere/*.test.mjs' 'elsewhere/{a,b}.test.mjs'",
      '# pytest tests/comment.py'
    ]
  };
  const { repoDir, ctx } = setupCtx([pack, {
    ...pack, id: 'GLOB', scope_files: ['src/core.mjs'], co_change_files: ['tests/**', 'later\\']
  }], {
    verification: { commands: ['pytest tests/global.py'] },
    redaction: { extra_patterns: ['fixture-private-marker'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  try {
    fs.mkdirSync(path.join(repoDir, 'fixtures', 'existing'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'tests', 'generated'), { recursive: true });
    pack.verify_commands.push(`pytest ${shellQuote(path.join(repoDir, 'test', 'test_allowed.py').replaceAll('\\', '/'))}`);
    pack.verify_commands.push(`pytest ${shellQuote(path.join(repoDir, 'tests', 'absolute.py').replaceAll('\\', '/'))}`);
    writeJsonAtomic(ctx.paths.manifestPath, { ...ctx.manifest, packs: [pack, ctx.manifest.packs[1]] });
    cli('manifest-ack', '--reason', '确认验证命令');
    const initial = cli('next');
    assert.equal(initial.action, 'IMPLEMENT');

    const oldWarnings = ['「要保住的旧行为」未填写。', '第 1 条避坑提示未点名代码：跟现有规则一致'];
    const directoryWarning = (file) => `范围里的「${file}」是目录，请列出具体文件。`;
    const testWarning = (file) => `验证命令点名的「${file}」不在本包范围，执行者改不了它；要改请用 pack scope 扩范围。`;
    const preview = cli('dispatch', '--dry-run');
    assert.deepEqual(preview.warnings, [
      ...oldWarnings,
      ...['tests/', 'fixtures\\existing', 'later\\'].map(directoryWarning),
      ...[
        'test_core.py', 'tests/cases.py', 'tests/test with spaces.py', 'lib/[REDACTED:INTERNAL].test.mjs',
        'lib/sample.spec.ts', 'test/sample_test.go', '__tests__/smoke', 'tests/absolute.py'
      ].map(testWarning)
    ]);
    assert.deepEqual(initial.warnings, preview.warnings);
    assert.deepEqual(cli('dispatch', '--dry-run', '--pack', 'GLOB').warnings, [
      ...oldWarnings,
      directoryWarning('later\\'),
      ...[
        'test_core.py', 'lib/[REDACTED:INTERNAL].test.mjs', 'lib/sample.spec.ts',
        'test/sample_test.go', '__tests__/smoke', 'checks/allowed.test.mjs', 'test/test_allowed.py'
      ].map(testWarning)
    ]);
    assert.deepEqual(taskBriefWarnings({ co_change_files: ['fixtures\\existing', 'later\\'] }, {}), [
      '「避坑提示」未填写。', '「要保住的旧行为」未填写。', directoryWarning('later\\')
    ]);
    const live = cli('dispatch');
    assert.equal(live.result.status, 'host_action_required');
    assert.deepEqual(live.warnings, preview.warnings);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('reference scan finds extensionless imports after pitfall names and skips generic or compound stems', () => {
  const repoDir = makeTempDir('grow-loop-ref-scan-');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, file), content);
  };
  const scope_files = [
    'src/services/orderService.ts', 'src/order.ts', 'src/index.ts', 'src/utils.ts',
    'src/orderService.test.ts', 'src/global.d.ts', 'pkg/route_planning.py', 'src/main/java/com/foo/OrderRepo.java',
    'src/{view}.ts'
  ];
  const co_change_files = ['generated/**/*.ts'];
  const pitfalls = ['调用 planRoute() 前先核对出发时间'];
  try {
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    for (const file of scope_files) write(file, '');
    const callers = {
      'pages/extensionless.ts': "import { place } from '../src/services/orderService';",
      'pages/esm.ts': "import { place } from '../src/services/orderService.js';",
      'pages/order-user.ts': "import { total } from '../src/order';",
      'pages/view.ts': "import '../src/{view}.ts';",
      'app/Main.java': 'import com.foo.OrderRepo;',
      'app/module.py': 'from pkg import route_planning',
      'pkg/relative.py': 'from .route_planning import plan'
    };
    for (const [file, content] of Object.entries(callers)) write(file, content);
    write('pages/generic.ts', "import a from '../src/index'; import b from '../src/utils'; import '../src/global';");
    write('pages/border.css', '.cell { border: 0; }');
    write('generated/skipped.ts', 'planRoute(start);');
    write('generated/nested/skipped.ts', 'planRoute(start);');
    const scan = () => scanReferences(repoDir, path.join(repoDir, '.loop'), { scope_files, co_change_files, pitfalls });
    assert.deepEqual(Object.fromEntries(scan().matches), {
      'pages/extensionless.ts': 'orderService',
      'pages/esm.ts': 'orderService',
      'pages/order-user.ts': 'order',
      'pages/view.ts': '{view}.ts',
      'app/Main.java': 'OrderRepo',
      'app/module.py': 'route_planning',
      'pkg/relative.py': 'route_planning'
    });

    write('calls/planner.ts', 'planRoute(start);');
    for (let index = 0; index < 30; index += 1) write(`more/caller${index}.py`, 'import route_planning');
    const capped = scan().matches;
    assert.equal(capped.size, 30);
    assert.equal(capped.get('calls/planner.ts'), 'planRoute');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('initial, repair and review briefs keep verbatim decisions after an audited acceptance change', () => {
  const question = '这里是否继续沿用单选？';
  const plan = { question: '排序规则？', decision: '保留排序；先比较日期，再比较名称。', at: null };
  const { repoDir, ctx } = setupCtx([{
    id: 'A',
    open_questions: [question],
    decisions: [plan],
    acceptance_criteria: ['旧验收'],
    preserve_behaviors: ['兼容现有单选']
  }], { redaction: { extra_patterns: ['w3private'] } });
  const cli = (...args) => runCli(args, repoDir);
  const task = (...args) => fs.readFileSync(path.join(cli('dispatch', '--dry-run', ...args).run_dir, 'task.md'), 'utf8');
  const original = '  先保留「单选」；\n第二行：照旧调用 `selectOne()`。  ';
  try {
    assert.equal(cli('next').gate.reason, ALLOWED_GATE_REASONS.AMBIGUITY);
    assert.equal(cli('resume', '--decision', original).outcome, 'approved');
    const approval = readJsonSafe(ctx.paths.statePath).packs.A.resolved_gates.AMBIGUITY;
    assert.equal(approval.decision, original);

    ctx.manifest.packs[0].acceptance_criteria = ['新的可验证条件'];
    writeJsonAtomic(ctx.paths.manifestPath, ctx.manifest);
    cli('manifest-ack', '--reason', '把验收改为可直接核对的条件');
    const event = readEvents(ctx.paths.eventsPath).find(({ type }) => type === 'manifest_changed');
    const acceptance = event.changes.changed_packs[0].fields.find(({ field }) => field === 'acceptance_criteria');
    assert.ok(acceptance);
    assert.equal(event.reason, '把验收改为可直接核对的条件');

    const initial = task();
    assert.match(initial, /INITIAL.*tier1/);
    assert.match(initial, /新的可验证条件/);

    const interrupted = cli('record', 'implement', '--infra-error', 'INFRA_TIMEOUT');
    assert.equal(interrupted.outcome, 'paused_infra_blocked');
    const repairDecision = '沿用本地入口；w3private 仅用于当前排查。';
    assert.equal(cli('resume', '--action', 'repair', '--decision', repairDecision).outcome, 'resumed_implement');
    const repair = task();
    assert.match(repair, /REPAIR.*tier1/);
    assert.match(repair, /INFRA_BLOCKED.*repair/);
    assert.ok(repair.includes('沿用本地入口；[REDACTED:INTERNAL] 仅用于当前排查。'));
    assert.doesNotMatch(repair, /w3private/);

    cli('record', 'implement', '--passed');
    cli('record', 'verify', '--passed', '--allow-self-report');
    const r1 = task();
    assert.match(r1, /Round 1\/2/);
    cli('record', 'review', '--verdict', 'fail', '--summary', '需要补验一个边界');
    cli('record', 'implement', '--passed');
    cli('record', 'verify', '--passed', '--allow-self-report');
    const r2 = task();
    assert.match(r2, /Round 2\/2/);
    assert.match(r2, /ROUND 2 NON-DIVERGENT CLOSURE RULE.*Verify ONLY/);
    assert.match(r2, /## Prior Round Blocking Findings to Verify Closed/);
    for (const content of [initial, repair, r1, r2]) {
      assert.match(content, /## 已经定了的\n与本任务书其他描述冲突时，以这里的原话为准。/);
      assert.ok(content.includes('\n' + original + '\n'));
      assert.ok(content.includes(question));
      assert.ok(content.includes(approval.approved_at));
      assert.ok(content.includes(plan.question) && content.includes('\n' + plan.decision + '\n'));
    }
    for (const content of [r1, r2]) {
      assert.match(content, /## 要保住的旧行为\n.*逐条核对/);
      assert.match(content, /兼容现有单选/);
      assert.match(content, /VERDICT: PASS.*VERDICT: FAIL/);
      assert.match(content, /```json\n\{ "verdict":/);
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resume saves nonempty decisions for repair, retry, commit and switch_instance', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A' }]);
  try {
    const pack = ctx.state.packs.A;
    const gate = { reason: ALLOWED_GATE_REASONS.BUDGET_EXCEEDED };
    const expected = [
      ['repair', 'resumed_implement', 'IMPLEMENT'],
      ['retry', 'resumed_implement', 'IMPLEMENT'],
      ['commit', 'ready_to_commit', 'READY_TO_COMMIT'],
      ['switch_instance', 'switched_instance', 'IMPLEMENT']
    ];
    for (const [action, outcome, status] of expected) {
      Object.assign(pack, { status: 'PAUSED_FOR_HUMAN', gate });
      const decision = `  已确认：${action}。  `;
      assert.equal(resumeFromGate(ctx, { action, decision, instance: 'tier1-backup' }).outcome, outcome);
      const persisted = readJsonSafe(ctx.paths.statePath).packs.A;
      assert.equal(persisted.status, status);
      assert.equal(persisted.gate, null);
      const saved = persisted.decisions.at(-1);
      assert.deepEqual({ ...saved, at: undefined }, { action, gate_reason: gate.reason, decision, at: undefined });
      assert.ok(Number.isFinite(Date.parse(saved.at)));
    }
    assert.equal(pack.active_instance, 'tier1-backup');
    Object.assign(pack, { status: 'PAUSED_FOR_HUMAN', gate });
    resumeFromGate(ctx, { action: 'retry', decision: '   ' });
    assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.decisions.length, 4);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('cross-pack lesson injection and live-smoke test policy banner in generated task.md', () => {
  const { repoDir, stateDir, ctx } = setupCtx(
    [
      { id: 'W01', title: 'Schema', tags: ['db'], estimated_files: 5 },
      { id: 'W02', title: 'Service', depends_on: ['W01'], tags: ['db', 'api'], estimated_files: 8 }
    ],
    { verification: { new_tests: 'forbidden', commands: [] } }
  );

  try {
    addLesson(stateDir, ctx.config, {
      pack_id: 'W01',
      stage: 'VERIFY',
      severity: 'HIGH',
      summary: 'Always use explicit column aliases in legacy joins',
      rule: 'Explicitly alias duplicate columns in SQL queries',
      tags: ['db'],
      scope: 'tags'
    });

    const runDir = path.join(ctx.paths.runsDir, 'W02', 'test-run');
    const taskPath = buildTaskPrompt(ctx, {
      pack: ctx.state.packs.W02,
      packDef: ctx.manifest.packs[1],
      stage: 'implement',
      runDir
    });
    const content = fs.readFileSync(taskPath, 'utf8');
    assert.match(content, /TEST POLICY \(`forbidden`\)/);
    assert.match(content, /L001/);
    assert.match(content, /Always use explicit column aliases/);
    assert.match(content, /tags \(db\)/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('verification drafts require confirmation and get the final package repair count on commit', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W1', tags: ['exam'] }, { id: 'W2', tags: ['exam'] }], {
    budgets: { tier1_max_repairs: 1 },
    review: { mode: 'none' },
    verification: { commands: [`${shellQuote(process.execPath)} check.mjs`], retry_once: false },
    redaction: { extra_patterns: ['private-marker'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  const preview = (id) => fs.readFileSync(path.join(cli('dispatch', '--dry-run', '--pack', id).run_dir, 'task.md'), 'utf8');
  const check = path.join(repoDir, 'check.mjs');
  try {
    fs.writeFileSync(check, "console.error('Missing exam fixture'); process.exitCode = 1;\n");
    cli('next');
    cli('record', 'implement', '--passed');
    assert.equal(cli('verify').transition.outcome, 'repair_tier1');
    const [draft] = cli('lesson', 'list', '--status', 'draft').items;
    assert.deepEqual([draft.stage, draft.tags, draft.repair_rounds], ['VERIFY', ['exam'], 0]);
    const next = cli('next');
    assert.deepEqual(next.injected_lessons, []);
    for (const output of [next, cli('status')]) {
      assert.equal(output.lesson_draft_notice, '有 1 条教训草稿待确认');
      assert.deepEqual(output.lesson_drafts, [{ id: draft.id, summary: draft.summary }]);
    }
    assert.doesNotMatch(preview('W2'), /L001|Injected Lessons/);

    assert.equal(cli('record', 'implement', '--failed', '--rule', 'Inspect the fixture').outcome, 'escalated_tier2');
    const implementation = cli('lesson', 'list', '--status', 'draft').items[1];
    assert.deepEqual([implementation.stage, implementation.tags, implementation.repair_rounds, implementation.rule],
      ['IMPLEMENT', ['exam'], 1, 'Inspect the fixture']);
    assert.match(runCliFailure(['lesson', 'confirm', '--id', draft.id, '--scope', 'tags'], repoDir).stderr, /--rule/);
    const confirmed = cli('lesson', 'confirm', '--id', draft.id, '--rule', 'Seed the exam fixture', '--scope', 'tags',
      '--root-cause', 'Missing fixture in private-marker');
    assert.deepEqual([confirmed.status, confirmed.scope_tags], ['confirmed', ['exam']]);
    assert.equal(confirmed.root_cause, 'Missing fixture in [REDACTED:INTERNAL]');
    assert.match(preview('W2'), /L001.*tags \(exam\).*Seed the exam fixture/);
    assert.equal(cli('next').lesson_draft_notice, '有 1 条教训草稿待确认');

    fs.writeFileSync(check, 'process.exitCode = 0;\n');
    cli('record', 'implement', '--passed');
    assert.equal(cli('verify').transition.outcome, 'ready_to_commit');
    cli('record', 'commit', '--sha', '333333333333');
    const items = readJsonSafe(ctx.paths.lessonsJsonPath).items;
    assert.deepEqual(items.map(({ status, repair_rounds, fixed_by }) => [status, repair_rounds, fixed_by]),
      [['confirmed', 2, 'W1'], ['draft', 2, 'W1']]);
    assert.ok(items.every(({ closed_at }) => Number.isFinite(Date.parse(closed_at))));
    assert.deepEqual(cli('next').injected_lessons.map(({ id }) => id), [draft.id]);
    const table = fs.readFileSync(ctx.paths.lessonsMdPath, 'utf8');
    assert.match(table, /Status \| Scope \| Feature Tags \| Repair Rounds/);
    assert.match(table, /confirmed \| tags \(exam\) \| exam \| 2/);
    const event = readEvents(ctx.paths.eventsPath).find(({ type }) => type === 'lesson_confirmed');
    assert.deepEqual([event.lesson_id, event.previous_status, event.rule, event.root_cause],
      [draft.id, 'draft', confirmed.rule, confirmed.root_cause]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('lesson scopes match feature tags, preserve origin package priority and stop injecting disabled rules', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W1', tags: ['notification'] }, { id: 'W2', tags: ['EXAM'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const preview = (id) => fs.readFileSync(path.join(cli('dispatch', '--dry-run', '--pack', id).run_dir, 'task.md'), 'utf8');
  try {
    const global = cli('record', 'lesson', '--pack', 'GLOBAL', '--summary', 'Use stable test inputs', '--rule', 'Seed the generator', '--scope', 'global');
    const draft = cli('record', 'lesson', '--pack', 'GLOBAL', '--summary', 'Use a fixed test date', '--rule', 'Pin the clock');
    assert.equal(draft.status, 'draft');
    assert.match(runCliFailure(['lesson', 'confirm', '--id', draft.id, '--rule', 'Freeze time', '--scope', 'tags'], repoDir).stderr, /requires --tags/);
    const exam = cli('lesson', 'confirm', '--id', draft.id, '--scope', 'tags', '--tags', 'exam, quiz', '--rule', 'Freeze time');
    assert.deepEqual(exam.scope_tags, ['exam', 'quiz']);
    assert.match(preview('W2'), /L002.*tags \(exam, quiz\).*Freeze time[\s\S]*L001.*global.*Seed the generator/);
    assert.match(preview('W1'), /L001.*Seed the generator/);
    assert.doesNotMatch(preview('W1'), /L002|Freeze time/);

    const own = cli('record', 'lesson', '--pack', 'W1', '--tags', 'exam', '--summary', 'Check the delivery time', '--rule', 'Use UTC', '--scope', 'tags');
    assert.equal(own.status, 'confirmed');
    assert.deepEqual(cli('next').injected_lessons.map(({ id }) => id), [own.id, global.id]);
    const disabled = cli('lesson', 'disable', '--id', global.id, '--reason', 'The generator always uses a fixed seed');
    assert.equal(disabled.disabled_reason, 'The generator always uses a fixed seed');
    assert.deepEqual(cli('lesson', 'list', '--status', 'disabled').items, [disabled]);
    const notification = preview('W1');
    assert.match(notification, /L003.*Use UTC/);
    for (const task of [preview('W2'), notification]) assert.doesNotMatch(task, /L001|Seed the generator/);
    assert.match(preview('W2'), /L002.*Freeze time/);
    const events = readEvents(ctx.paths.eventsPath);
    assert.ok(events.some(({ type, lesson_id, reason }) => type === 'lesson_disabled' && lesson_id === global.id && reason === disabled.disabled_reason));
    assert.ok(events.some(({ type, status, count }) => type === 'lesson_listed' && status === 'disabled' && count === 1));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('legacy lessons are read in place and injection is capped in priority and recency order', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W', tags: ['exam'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const legacy = (number, fields = {}) => ({
    id: `L${String(number).padStart(3, '0')}`, status: 'OPEN', pack_id: 'OLD', tags: [],
    summary: `Legacy lesson ${number}`, rule: 'Repeat this check', created_at: new Date(number * 1000).toISOString(), ...fields
  });
  try {
    const items = [legacy(1, { pack_id: 'W', tags: ['notification'] }), legacy(2, { tags: ['exam'], status: 'CLOSED' }),
      legacy(3, { rule: '' }), ...Array.from({ length: 8 }, (_, index) => legacy(index + 4))];
    writeJsonAtomic(ctx.paths.lessonsJsonPath, { next_id: 12, items });
    const original = fs.readFileSync(ctx.paths.lessonsJsonPath, 'utf8');
    const next = cli('next');
    assert.deepEqual(next.lesson_drafts, [{ id: 'L003', summary: 'Legacy lesson 3' }]);
    assert.deepEqual(next.injected_lessons.map(({ id }) => id), ['L001', 'L002', 'L011', 'L010', 'L009', 'L008', 'L007', 'L006']);
    assert.equal(fs.readFileSync(ctx.paths.lessonsJsonPath, 'utf8'), original);

    cli('lesson', 'confirm', '--id', 'L003', '--scope', 'global', '--rule', 'Recheck separately');
    cli('lesson', 'disable', '--id', 'L002', '--reason', 'Rule retired');
    const updated = readJsonSafe(ctx.paths.lessonsJsonPath).items;
    assert.deepEqual([updated[0], ...updated.slice(3)], [items[0], ...items.slice(3)]);
    assert.deepEqual([updated[2].status, updated[2].scope], ['confirmed', 'global']);
    assert.deepEqual([updated[1].status, updated[1].scope, updated[1].scope_tags], ['disabled', 'tags', ['exam']]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('redactor strips tokens, secrets, intranet IPs and custom patterns with zero scan hits in evidence', () => {
  const redactor = buildRedactor(['internal\\.corp\\.example']);
  const dirty = [
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature_part_xyz',
    'api_key=sk-1234567890abcdefghijklmnop',
    'db=postgres://admin:SuperSecret99@172.18.0.12:5432/app',
    'host=192.168.10.55 and https://internal.corp.example/api'
  ].join('\n');

  const cleaned = redactor.redactString(dirty);
  assert.doesNotMatch(cleaned, /eyJhbGci/);
  assert.doesNotMatch(cleaned, /sk-1234567890/);
  assert.doesNotMatch(cleaned, /SuperSecret99/);
  assert.doesNotMatch(cleaned, /172\.18\.0\.12/);
  assert.doesNotMatch(cleaned, /192\.168\.10\.55/);
  assert.doesNotMatch(cleaned, /internal\.corp\.example/);
  assert.equal(redactor.scanString(cleaned).length, 0);

  // Approval Envelope checks
  assert.equal(checkApprovalEnvelope({}, 'git_push').allowed, false);
  assert.equal(checkApprovalEnvelope({}, 'deploy').allowed, false);
  assert.equal(checkApprovalEnvelope({}, 'global_config_edit').allowed, false);
  assert.equal(checkApprovalEnvelope({}, 'local_commit').allowed, true);
});

test('full CLI E2E flow: init -> probe -> next -> dispatch dry-run -> record -> commit --from-git -> evidence', () => {
  const repoDir = makeTempDir('grow-loop-e2e-');
  try {
    // Initialize a real temporary git repository
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Demo\n', 'utf8');
    writeJsonAtomic(path.join(repoDir, 'package.json'), { type: 'module' });
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: repoDir, stdio: 'ignore' });

    // 1. init with two real packs and the live-smoke profile
    const manifestPath = path.join(repoDir, 'delivery.json');
    writeJsonAtomic(manifestPath, {
      project: 'demo-app',
      packs: [
        {
          id: 'W01',
          title: 'Add greeting module',
          goal: 'Implement hello helper',
          depends_on: [],
          risk: 'low',
          estimated_files: 2,
          scope_files: ['hello.js'],
          acceptance_criteria: ['AC-W01-01: hello() returns greeting'],
          tags: ['core']
        },
        {
          id: 'W02',
          title: 'Wire CLI greeting',
          goal: 'Call hello helper from index.js',
          depends_on: ['W01'],
          risk: 'low',
          estimated_files: 2,
          scope_files: ['index.js'],
          acceptance_criteria: ['AC-W02-01: index.js outputs greeting'],
          tags: ['core']
        }
      ]
    });
    const initRes = runCli(['init', '--repo', repoDir, '--profile', 'live-smoke', '--manifest', manifestPath]);
    assert.equal(initRes.ok, true);
    assert.equal(initRes.gitignore.updated, true);
    assert.equal(initRes.state_dir, path.join(repoDir, '.loop'));

    // Use the self executor for deterministic CI testing
    const configPath = path.join(repoDir, '.loop', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.executors = { self: { kind: 'self', label: 'Host Harness' } };
    cfg.routing.tier1 = 'self';
    cfg.routing.tier2 = 'self';
    cfg.routing.reviewer = 'self';
    cfg.code_intel = { tool: 'none' };
    cfg.verification.commands = [`${shellQuote(process.execPath)} --check hello.js`];
    writeJsonAtomic(configPath, cfg);

    // 2. probe
    const probeRes = runCli(['probe', '--repo', repoDir]);
    const selfProbe = probeRes.instances.find((i) => i.instance_id === 'self');
    assert.ok(selfProbe);
    assert.equal(selfProbe.available, true);

    // 3. W01 cycle
    const n1 = runCli(['next', '--repo', repoDir]);
    assert.equal(n1.action, 'IMPLEMENT');
    assert.equal(n1.pack_id, 'W01');
    assert.equal(n1.new_tests_policy, 'forbidden');

    const dry1 = runCli(['dispatch', '--repo', repoDir, '--stage', 'implement', '--dry-run']);
    assert.equal(dry1.dry_run.status, 'dry_run');

    fs.writeFileSync(path.join(repoDir, 'hello.js'), 'export const hello = (n) => `hi ${n}`;\n', 'utf8');
    runCli(['record', 'implement', '--repo', repoDir, '--passed', '--summary', 'Added hello.js']);
    const ver1 = runCli(['verify', '--repo', repoDir]);
    assert.equal(ver1.passed, true);

    const findingsFile = path.join(repoDir, '.loop', 'r1-findings.json');
    writeJsonAtomic(findingsFile, [{ severity: 'LOW', title: 'Could add JSDoc', locator: 'hello.js:hello' }]);
    const rev1 = runCli([
      'record', 'review', '--repo', repoDir,
      '--verdict', 'pass', '--findings-file', findingsFile, '--summary', '0 blocking'
    ]);
    assert.equal(rev1.outcome, 'review_passed');
    assert.equal(rev1.tech_debt_recorded, 1);

    const n1Commit = runCli(['next', '--repo', repoDir]);
    assert.equal(n1Commit.action, 'COMMIT');

    execFileSync('git', ['add', 'hello.js'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat(W01): add greeting helper'], { cwd: repoDir, stdio: 'ignore' });
    const c1 = runCli(['record', 'commit', '--repo', repoDir, '--from-git']);
    assert.equal(c1.outcome, 'committed');
    assert.equal(c1.next_pack_id, 'W02');

    // 4. W02 cycle (with 1 lesson + secret string to verify redaction end-to-end)
    runCli([
      'record', 'lesson', '--repo', repoDir,
      '--pack', 'W01', '--severity', 'HIGH',
      '--summary', 'Avoid leaking sk-secretkey123456789012345 in logs',
      '--rule', 'Always redact tokens', '--scope', 'tags', '--tags', 'core'
    ]);

    const n2 = runCli(['next', '--repo', repoDir]);
    assert.equal(n2.action, 'IMPLEMENT');
    assert.equal(n2.pack_id, 'W02');
    assert.equal(n2.injected_lessons.length, 1);
    assert.doesNotMatch(n2.injected_lessons[0].summary, /sk-secretkey/);

    fs.writeFileSync(path.join(repoDir, 'index.js'), 'import { hello } from "./hello.js";\nconsole.log(hello("world"));\n', 'utf8');
    runCli(['record', 'implement', '--repo', repoDir, '--passed', '--summary', 'Added index.js']);
    const ver2 = runCli(['verify', '--repo', repoDir]);
    assert.equal(ver2.passed, true);
    runCli(['record', 'review', '--repo', repoDir, '--verdict', 'pass', '--summary', 'clean']);

    execFileSync('git', ['add', 'index.js'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat(W02): wire index.js'], { cwd: repoDir, stdio: 'ignore' });
    const c2 = runCli(['record', 'commit', '--repo', repoDir, '--from-git']);
    assert.equal(c2.loop_status, 'COMPLETED');

    const nDone = runCli(['next', '--repo', repoDir]);
    assert.equal(nDone.action, 'COMPLETED');

    // 5. Generate evidence pack and assert redaction cleanliness
    const ev = runCli(['evidence', '--repo', repoDir]);
    assert.equal(ev.scanHits.length, 0);
    const md = fs.readFileSync(ev.path, 'utf8');
    assert.match(md, /\| \*\*W01\*\* \|/);
    assert.match(md, /\| \*\*W02\*\* \|/);
    assert.doesNotMatch(md, /sk-secretkey/);
    assert.match(md, /\[REDACTED:API_KEY\]/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Codex saves a split thread.started event before exit and resumes after interrupted dispatch', async () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W7', scope_files: ['app.js'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const mock = path.join(repoDir, 'mock-codex.cjs');
  const marker = path.join(repoDir, 'adapter-pid');
  const finish = path.join(repoDir, 'finish');
  const session = 'fixture-codex-thread';
  let running;
  let adapterPid;
  try {
    fs.writeFileSync(mock, [
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const marker = ' + JSON.stringify(marker) + ';',
      'const finish = ' + JSON.stringify(finish) + ';',
      'const id = ' + JSON.stringify(session) + ';',
      'const resuming = args.includes("resume");',
      'if (resuming && args[args.indexOf("resume") + 1] !== id) process.exit(2);',
      'if (fs.existsSync(finish) && !resuming) process.exit(3);',
      'process.stdin.resume();',
      'process.stdout.write("{\\"type\\":\\"thread.");',
      'setTimeout(() => {',
      '  process.stdout.write("started\\",\\"thread_id\\":" + JSON.stringify(id) + "}\\r\\n");',
      '  fs.writeFileSync(marker, String(process.pid));',
      '  if (!fs.existsSync(finish)) setInterval(() => {}, 500);',
      '}, 40);'
    ].join('\n'));
    ctx.config.executors['tier1-cli'] = { kind: 'codex', executable: process.execPath, prefix_args: [mock] };
    writeJsonAtomic(ctx.paths.configPath, ctx.config);
    cli('next');

    const readPack = () => readJsonSafe(ctx.paths.statePath).packs.W7;
    for (const stopCoordinator of [false, true]) {
      fs.rmSync(marker, { force: true });
      const args = stopCoordinator ? ['--resume'] : [];
      running = promisify(execFile)(process.execPath, [CLI_PATH, 'dispatch', '--timeout', '20', ...args], {
        cwd: repoDir, encoding: 'utf8', env: { ...process.env, GROW_LOOP_STATE_DIR: '' }
      });
      running.catch(() => {});
      for (let i = 0; i < 200; i++) {
        if (fs.existsSync(marker) && readPack().inflight_run?.pid === running.child.pid &&
            readPack().inflight_run?.session_id === session) break;
        await delay(25);
      }
      adapterPid = Number(fs.readFileSync(marker, 'utf8'));
      const inflight = cli('status').packs[0].inflight_run;
      assert.equal(inflight.pid, running.child.pid);
      assert.equal(inflight.session_id, session);
      assert.equal(inflight.stage, 'implement');
      assert.equal(inflight.instance, 'tier1-cli');
      assert.ok(Number.isFinite(Date.parse(inflight.started_at)));
      assert.ok(fs.existsSync(inflight.run_dir));
      assert.equal(readPack().last_session_id, session);

      if (stopCoordinator) running.child.kill('SIGKILL');
      process.kill(adapterPid, 'SIGKILL');
      adapterPid = null;
      if (stopCoordinator) {
        await assert.rejects(running);
        assert.deepEqual(readPack().inflight_run, inflight);
      } else {
        const interrupted = JSON.parse((await running).stdout);
        assert.equal(interrupted.result.status, 'interrupted');
        assert.equal(readPack().tier1_repairs, 0);
        assert.equal(readPack().inflight_run, null);
      }
      assert.equal(readPack().last_session_id, session);
    }
    fs.writeFileSync(finish, 'finish');
    const resumed = cli('dispatch', '--resume');
    assert.equal(resumed.transition.outcome, 'ready_for_verify');
    assert.equal(resumed.result.session_id, session);
    assert.equal(readPack().inflight_run, null);
    const starts = readEvents(ctx.paths.eventsPath).filter(({ type }) => type === 'dispatch_started');
    assert.deepEqual(starts.map(({ resumed_session }) => resumed_session), [null, session, session]);
  } finally {
    if (running?.child.exitCode === null && !running.child.signalCode) running.child.kill('SIGKILL');
    if (adapterPid) {
      try { process.kill(adapterPid, 'SIGKILL'); } catch {}
    }
    await running?.catch(() => {});
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('self dispatch records implementation and review time and commit checks flag a fixture screenshot', () => {
  const root = makeTempDir('grow-loop-w7-artifacts-');
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'loop');
  const paths = getStatePaths(stateDir);
  const cli = (...args) => runCli([...args, '--state-dir', stateDir], repoDir);
  try {
    fs.mkdirSync(repoDir);
    fixtureGit(repoDir, 'init');
    fs.writeFileSync(path.join(repoDir, 'app.js'), 'const value = 1;\n');
    fs.writeFileSync(path.join(repoDir, 'fixture-notes.md'), 'fixture baseline');
    fixtureCommit(repoDir, 'fixture baseline', 'app.js', 'fixture-notes.md');
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = { packs: [
      { id: 'self-pack', scope_files: ['app.js'] },
      { id: 'external-pack', scope_files: ['next.js'], co_change_files: ['approved.log'] }
    ] };
    writeJsonAtomic(manifestPath, manifest);
    cli('init', '--manifest', manifestPath);
    const cfg = readJsonSafe(paths.configPath);
    cfg.routing = { tier1: 'self', tier2: 'self', reviewer: 'self' };
    cfg.verification.commands = [shellQuote(process.execPath) + ' --check app.js'];
    writeJsonAtomic(paths.configPath, cfg);

    cli('next');
    const preview = cli('dispatch', '--dry-run');
    const taskFile = preview.dry_run.task_file;
    assert.ok(fs.readFileSync(taskFile, 'utf8').includes(path.join(paths.artifactsDir, 'self-pack').replaceAll('\\', '/')));
    assert.ok(path.relative(repoDir, paths.artifactsDir).startsWith('..' + path.sep));
    const saved = () => readJsonSafe(paths.statePath).packs['self-pack'];
    assert.equal(saved().prepared_run.task_file, taskFile);
    assert.match(saved().prepared_run.fingerprint, /^[0-9a-f]{64}$/);
    const fixedTime = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(taskFile, fixedTime, fixedTime);
    const previewTime = fs.statSync(taskFile).mtimeMs;
    const impl = cli('dispatch');
    assert.equal(impl.run_id, preview.run_id);
    assert.equal(impl.run_dir, preview.run_dir);
    assert.equal(impl.result.task_file, taskFile);
    assert.equal(fs.statSync(taskFile).mtimeMs, previewTime);
    assert.deepEqual(fs.readdirSync(path.dirname(impl.run_dir)), [impl.run_id]);
    assert.deepEqual(fs.readdirSync(impl.run_dir).filter((name) => name.endsWith('.md')), ['task.md']);
    assert.equal(saved().prepared_run, null);
    assert.equal(saved().inflight_run.run_id, impl.run_id);
    assert.equal(impl.result.elapsed_seconds, null);
    fs.appendFileSync(path.join(repoDir, 'app.js'), 'const next = 2;\n');
    fs.appendFileSync(path.join(repoDir, 'fixture-notes.md'), '\nfixture implementation notes');
    const implementation = cli('record', 'implement', '--passed', '--executor-tool', 'host-codex', '--executor-model', 'fixture-model',
      '--executor-effort', 'high');
    assert.equal(implementation.outcome, 'ready_for_verify');
    assert.ok(implementation.stray_files_notice);
    assert.deepEqual(implementation.stray_files, [{ path: 'fixture-notes.md', status: ' M', artifact: true }]);
    const implResult = readJsonSafe(path.join(impl.run_dir, 'result.json'));
    assert.equal(implResult.status, 'completed');
    assert.equal(implResult.executor_tool, 'host-codex');
    assert.equal(implResult.executor_model, 'fixture-model');
    assert.equal(implResult.executor_effort, 'high');
    assert.ok(implResult.elapsed_seconds > 0);
    assert.equal(saved().inflight_run, null);
    assert.equal(cli('verify').passed, true);

    const reviewPreview = cli('dispatch', '--stage', 'review', '--dry-run');
    manifest.packs[0].preserve_behaviors = ['保留原有输出'];
    writeJsonAtomic(paths.manifestPath, manifest);
    cli('manifest-ack', '--reason', '补录审查要核对的既有行为');
    const review = cli('dispatch', '--stage', 'review');
    assert.equal(review.run_id, reviewPreview.run_id);
    const shellReview = cli('status', '--format', 'shell');
    assert.equal(shellReview.now.waiting_for, 'coordinator');
    assert.equal(shellReview.now.next_command, 'grow-loop record review --report <report.md>');
    assert.equal(review.result.task_file, reviewPreview.dry_run.task_file);
    assert.match(fs.readFileSync(review.result.task_file, 'utf8'), /保留原有输出/);
    const reportPath = path.join(paths.artifactsDir, 'self-pack', 'review.md');
    fs.writeFileSync(reportPath, reviewMarkdown('pass', []));
    cli('record', 'review', '--report', reportPath, '--executor-tool', 'host-review',
      '--executor-model', 'review-model', '--executor-effort', 'medium');
    const reviewResult = readJsonSafe(path.join(review.run_dir, 'result.json'));
    assert.ok(reviewResult.elapsed_seconds > 0);
    assert.equal(reviewResult.executor_tool, 'host-review');
    assert.equal(reviewResult.executor_model, 'review-model');
    assert.equal(reviewResult.executor_effort, 'medium');
    assert.equal(saved().inflight_run, null);
    const events = readEvents(paths.eventsPath);
    assert.ok(events.some((event) => event.type === 'implement_completed' && event.executor_tool === 'host-codex' &&
      event.executor_model === 'fixture-model' && event.executor_effort === 'high' && event.run_id === impl.run_id));
    assert.ok(events.some((event) => event.type === 'review_recorded' && event.executor_tool === 'host-review' &&
      event.executor_model === 'review-model' && event.executor_effort === 'medium' && event.run_id === review.run_id));
    assert.equal(cli('next').action, 'COMMIT');
    fixtureCommit(repoDir, 'fixture self implementation', 'app.js');
    assert.equal(cli('record', 'commit', '--from-git').outcome, 'committed');
    const md = fs.readFileSync(cli('evidence').path, 'utf8');
    const seconds = (implResult.elapsed_seconds + reviewResult.elapsed_seconds).toFixed(2);
    assert.ok(md.includes('self · host-codex / fixture-model'));
    assert.ok(md.includes('| **self-pack** | 3 (dry-run: 2) | ' + seconds + ' |'));

    const mock = path.join(root, 'external-executor.cjs');
    const providedTask = path.join(root, 'provided-task.md');
    fs.writeFileSync(providedTask, 'fixture supplied task');
    fs.writeFileSync(mock, [
      "const fs = require('node:fs');",
      'if (fs.readFileSync(0, "utf8") !== "fixture supplied task") process.exit(5);',
      'fs.writeFileSync("next.js", "export const next = 3;");',
      'fs.writeFileSync("approved.log", "fixture scope");',
      'fs.writeFileSync("fixture screenshot.png", "fixture screenshot");',
      'fs.writeFileSync("fixture-notes.md", "fixture notes changed");',
      'fs.writeFileSync("other.txt", "fixture outside scope");'
    ].join('\n'));
    cfg.executors.external = { kind: 'codex', executable: process.execPath, prefix_args: [mock] };
    writeJsonAtomic(paths.configPath, cfg);
    cli('next');
    const { transition } = cli('dispatch', '--instance', 'external', '--task-file', providedTask);
    assert.equal(transition.outcome, 'paused_out_of_scope_change');
    assert.deepEqual(transition.gate.out_of_scope_files, [{ path: 'other.txt', status: '??' }]);
    assert.ok(transition.stray_files_notice);
    fs.unlinkSync(path.join(repoDir, 'other.txt'));
    assert.equal(cli('resume', '--action', 'revert').status, 'VERIFY');
    assert.equal(cli('verify').passed, true);
    cli('record', 'review', '--verdict', 'pass');
    const next = cli('next');
    assert.equal(next.action, 'COMMIT');
    assert.deepEqual(next.stray_files, [
      { path: 'fixture-notes.md', status: ' M', artifact: true },
      { path: 'fixture screenshot.png', status: '??', artifact: true }
    ]);
    assert.ok(next.stray_files_notice);
    assert.equal(next.artifacts_dir, path.join(paths.artifactsDir, 'external-pack'));
    fixtureCommit(repoDir, 'fixture commit containing a screenshot', 'next.js', 'approved.log', 'fixture screenshot.png');
    const recorded = cli('record', 'commit', '--from-git');
    assert.equal(recorded.outcome, 'committed');
    assert.deepEqual(recorded.stray_files, [{ path: 'fixture screenshot.png', status: 'committed', artifact: true }]);
    assert.ok(recorded.stray_files_notice);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record external clears a pending handoff stop and lets a dependent package start', () => {
  const { repoDir, ctx } = setupCtx([
    { id: 'W10', risk: 'low', tags: ['ops'], handoff: { source: 'fixture', needs: ['scope_files'] }, co_change_files: ['src'] },
    { id: 'W11', depends_on: ['W10'], scope_files: ['src/replay.mjs'] }
  ], { redaction: { extra_patterns: ['fixture-private-marker'] } });
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const record = ['record', 'external', '--pack', 'W10'];
  try {
    fs.mkdirSync(path.join(repoDir, 'src'));
    delete ctx.state.packs.W11.completed_externally; // State created before this field was added.
    saveState(ctx.stateDir, ctx.state);
    const stop = cli('next');
    assert.equal(stop.action, 'NEEDS_FILL');
    assert.deepEqual(stop.needs, ['scope_files']);
    assert.ok(stop.warnings.includes('范围里的「src」是目录，请列出具体文件。'));

    assert.match(fail('record', 'external', '--note', '已完成').stderr, /non-empty --pack/);
    assert.match(fail(...record).stderr, /non-empty --note/);
    assert.match(fail(...record, '--note', '  ').stderr, /non-empty --note/);
    assert.equal(cli('status', '--format', 'shell').question.kind, 'NEEDS_FILL');

    const result = cli(...record, '--note', '  回放已完成 | fixture-private-marker  ');
    const { at } = result.completed_externally;
    const completion = { at, note: '回放已完成 | [REDACTED:INTERNAL]' };
    assert.deepEqual(result, {
      outcome: 'completed_externally', pack_id: 'W10', completed_externally: completion,
      next_pack_id: 'W11', loop_status: 'RUNNING'
    });
    assert.equal(new Date(at).toISOString(), at);
    const saved = readJsonSafe(ctx.paths.statePath).packs.W10;
    assert.equal(saved.completed_at, at);
    assert.deepEqual(saved.completed_externally, completion);
    assert.deepEqual(readEvents(ctx.paths.eventsPath), [
      { type: 'pack_completed_externally', pack_id: 'W10', ts: at, note: completion.note }
    ]);

    const shell = cli('status', '--format', 'shell');
    assert.equal(shell.schema, 'grow-loop.status/1');
    assert.equal(shell.active_pack_id, 'W11');
    assert.equal(shell.question, null);
    for (const status of [shell, cli('status')]) {
      assert.equal(status.packs[0].status, 'COMMITTED');
      assert.equal(status.packs[0].commit, null);
      assert.deepEqual(status.packs[0].completed_externally, completion);
      assert.equal(status.packs[1].completed_externally, null);
    }
    const next = cli('next');
    assert.equal(next.action, 'IMPLEMENT');
    assert.equal(next.pack_id, 'W11');

    const evidence = cli('evidence');
    const markdown = fs.readFileSync(evidence.path, 'utf8');
    assert.ok(markdown.includes('在 loop 外完成（回放已完成 \\| [REDACTED:INTERNAL]）'));
    assert.deepEqual(evidence.scanHits, []);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('record external clears an external-effect gate and completes the final package after dispatch stops', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'W12', external_effects: ['Publish the fixture'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const record = ['record', 'external', '--pack', 'W12', '--note', '上线已完成'];
  try {
    assert.equal(cli('next').gate.reason, ALLOWED_GATE_REASONS.EXTERNAL_EFFECT);
    const state = readJsonSafe(ctx.paths.statePath);
    const pack = state.packs.W12;
    pack.inflight_run = { kind: 'custom-cmd', pid: process.pid, stage: 'implement' };
    saveState(ctx.stateDir, state);
    assert.match(runCliFailure(record, repoDir).stderr, /active dispatch/);
    pack.inflight_run = { kind: 'self', stage: 'implement' };
    saveState(ctx.stateDir, state);
    assert.match(runCliFailure(record, repoDir).stderr, /active dispatch/);
    assert.equal(cli('status', '--format', 'shell').question.kind, 'EXTERNAL_EFFECT');

    pack.inflight_run = null;
    saveState(ctx.stateDir, state);
    const result = cli(...record);
    assert.equal(result.next_pack_id, null);
    assert.equal(result.loop_status, 'COMPLETED');
    const status = cli('status', '--format', 'shell');
    assert.equal(status.now.phase, 'COMPLETED');
    assert.equal(status.active_pack_id, null);
    assert.equal(status.question, null);
    assert.equal(status.packs[0].gate, null);
    assert.equal(status.packs[0].completed_externally.note, '上线已完成');
    assert.match(runCliFailure(record, repoDir).stderr, /already committed/);
    assert.equal(readEvents(ctx.paths.eventsPath).filter(({ type }) => type === 'pack_completed_externally').length, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('record external rejects packages already in an implementation, verification, review or commit phase', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A' }]);
  try {
    for (const status of ['IMPLEMENT', 'VERIFY', 'REVIEW', 'READY_TO_COMMIT']) {
      ctx.state.packs.A.status = status;
      saveState(ctx.stateDir, ctx.state);
      const result = runCliFailure(['record', 'external', '--pack', 'A', '--note', '已完成'], repoDir);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Pack A is in ${status}.`));
      assert.match(result.stderr, /grow-loop record commit --from-git/);
      assert.match(result.stderr, /grow-loop resume/);
      assert.equal(readJsonSafe(ctx.paths.statePath).packs.A.status, status);
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Git checkpoints use globs for stray files and pause for external changes within scope', () => {
  const { repoDir } = setupCtx([{ id: 'A', scope_files: ['src/*.mjs', 'tests/**'] }], {
    verification: { commands: [shellQuote(process.execPath) + ' --check tests/x.test.mjs'] }
  });
  const cli = (...args) => runCli(args, repoDir);
  const write = (file, content = '') => fs.writeFileSync(path.join(repoDir, file), content);
  try {
    fixtureGit(repoDir, 'init', '-b', 'fixture-branch');
    ensureGitignoreEntry(repoDir, resolveStateDir(repoDir));
    fs.mkdirSync(path.join(repoDir, 'tests'));
    fs.mkdirSync(path.join(repoDir, 'src', 'sub'), { recursive: true });
    write('tests/x.test.mjs');
    fixtureCommit(repoDir, 'fixture baseline', '.gitignore', 'tests/x.test.mjs');
    assert.equal(cli('next').action, 'IMPLEMENT');
    cli('record', 'implement', '--passed');
    assert.equal(cli('verify').passed, true);
    cli('record', 'review', '--verdict', 'pass');

    write('src/a.mjs');
    write('src/sub/b.mjs');
    const next = cli('next');
    assert.equal(next.action, 'PAUSE_FOR_HUMAN');
    assert.equal(next.gate.reason, 'OUT_OF_SCOPE_CHANGE');
    assert.equal(next.gate.resume_status, 'READY_TO_COMMIT');
    assert.deepEqual(next.gate.out_of_scope_files, [{ path: 'src/sub/b.mjs', status: '??' }]);
    fs.unlinkSync(path.join(repoDir, 'src/sub/b.mjs'));
    assert.equal(cli('answer', '--question', next.question.id, '--option', 'revert').status, 'READY_TO_COMMIT');
    assert.equal(cli('next').action, 'COMMIT');

    write('tests/x.test.mjs', 'export const changed = true;\n');
    const sha = fixtureCommit(repoDir, 'fixture external test change', 'tests/x.test.mjs');
    const paused = cli('next');
    assert.equal(paused.action, 'PAUSE_FOR_HUMAN');
    assert.equal(paused.gate.reason, 'EXTERNAL_COMMIT');
    assert.deepEqual(paused.gate.conflicting_files, ['tests/x.test.mjs']);
    assert.deepEqual(paused.gate.external_commits, [{ sha, files: ['tests/x.test.mjs'] }]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('out-of-scope changes are measured from startup and expand requires a recorded decision', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'], co_change_files: ['companion.mjs'] }]);
  try {
    const cli = (...args) => runCli(args, repoDir);
    const fail = (...args) => runCliFailure(args, repoDir);
    const write = (file, content = 'fixture change') => fs.writeFileSync(path.join(repoDir, file), content);
    const remove = (file) => fs.unlinkSync(path.join(repoDir, file));
    const saved = () => readJsonSafe(ctx.paths.statePath).packs.A;

    fixtureGit(repoDir, 'init');
    const tracked = ['已有改动.mjs', 'changed later.mjs', 'deleted before.mjs', 'deleted later.mjs'];
    for (const file of tracked) write(file, 'fixture baseline');
    const base = fixtureCommit(repoDir, 'fixture baseline', ...tracked);
    write('已有改动.mjs');
    write('changed later.mjs');
    write('untracked before.mjs');
    remove('deleted before.mjs');

    assert.equal(cli('next').action, 'IMPLEMENT');
    const snapshot = saved().start_worktree;
    for (const file of ['已有改动.mjs', 'changed later.mjs', 'untracked before.mjs']) {
      assert.equal(snapshot[file], fixtureGit(repoDir, 'hash-object', '--no-filters', '--', file));
    }
    assert.equal(snapshot['deleted before.mjs'], null);
    write('changed later.mjs', 'fixture second change');
    write('extra[ab].mjs');
    write('companion.mjs');
    write('.loop/unignored-state.mjs');
    remove('deleted later.mjs');

    const paused = cli('record', 'implement', '--passed');
    assert.equal(paused.outcome, 'paused_out_of_scope_change');
    assert.equal(paused.gate.resume_status, 'VERIFY');
    const files = [
      { path: 'changed later.mjs', status: ' M' },
      { path: 'deleted later.mjs', status: ' D' },
      { path: 'extra[ab].mjs', status: '??' }
    ];
    assert.deepEqual(paused.gate.out_of_scope_files, files);
    const { status, tier1_repairs, tier2_repairs, last_verify } = saved();
    assert.deepEqual([status, tier1_repairs, tier2_repairs, last_verify], ['PAUSED_FOR_HUMAN', 0, 0, null]);
    assert.deepEqual(readJsonSafe(ctx.paths.lessonsJsonPath, { items: [] }).items, []);
    assert.deepEqual(readEvents(ctx.paths.eventsPath).find(({ type }) => type === 'out_of_scope_detected').files, files);
    assert.deepEqual(cli('status', '--format', 'shell').question, paused.question);
    assert.equal(paused.question.kind, 'OUT_OF_SCOPE_CHANGE');
    assert.match(paused.question.body, /changed later\.mjs（修改）/);
    assert.match(paused.question.body, /deleted later\.mjs（删除）/);
    assert.match(paused.question.body, /extra\[ab\]\.mjs（新增（未跟踪））/);
    assert.deepEqual(paused.question.options.map(({ id, needs_text }) => [id, needs_text]),
      [['expand', true], ['revert', false], ['ignore', true], ['abort', false]]);
    assert.equal(cli('verify').question.id, paused.question.id);
    assert.equal(cli('dispatch', '--dry-run').question.id, paused.question.id);
    assert.equal(cli('record', 'verify', '--passed').question.id, paused.question.id);
    assert.match(fail('record', 'implement', '--passed').stderr, /OUT_OF_SCOPE_CHANGE/);
    assert.match(fail('record', 'external', '--pack', 'A', '--note', '已完成').stderr, /OUT_OF_SCOPE_CHANGE/);
    assert.match(fail('resume', '--action', 'approve').stderr, /OUT_OF_SCOPE_CHANGE/);
    assert.match(fail('resume', '--action', 'expand', '--decision', '   ').stderr, /非空的 --decision/);
    const answer = ['answer', '--question', paused.question.id, '--option', 'expand'];
    assert.match(fail(...answer).stderr, /非空的 --text/);
    const decision = '  同意把修正涉及的三个文件加入本包。\n保持测试范围。  ';
    assert.equal(cli(...answer, '--text', decision).status, 'VERIFY');
    const approved = files.map(({ path: file }) => file);
    const { manifest } = loadWorkspace(repoDir);
    assert.deepEqual(manifest.packs[0].scope_files, ['app.mjs', ...approved]);
    assert.deepEqual(saved().approved_out_of_scope, approved);
    assert.equal(saved().decisions.at(-1).decision, decision);
    const scopeEvent = readEvents(ctx.paths.eventsPath).find(({ source }) => source === 'pack_scope');
    assert.equal(scopeEvent.reason, decision.trim());
    assert.deepEqual(scopeEvent.details.added_files, approved);
    assert.equal(cli('next').action, 'VERIFY');
    cli('record', 'verify', '--passed', '--allow-self-report');
    cli('record', 'review', '--verdict', 'pass');
    assert.equal(cli('next').action, 'COMMIT');

    write('extraa.mjs'); // The approved literal path contains brackets and must not grant this match.
    const bad = fixtureCommit(repoDir, 'fixture with unapproved file', ':(literal)extra[ab].mjs', 'extraa.mjs');
    const stateBefore = readJsonSafe(ctx.paths.statePath);
    for (const args of [['--from-git'], ['--sha', bad]]) {
      const rejected = fail('record', 'commit', ...args);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /- extraa\.mjs/);
      assert.match(rejected.stderr, /撤出提交后重新提交再登记.*需要人先同意扩范围/);
    }
    assert.deepEqual(readJsonSafe(ctx.paths.statePath), stateBefore);
    assert.equal(readEvents(ctx.paths.eventsPath).some(({ type }) => type === 'pack_committed'), false);

    fixtureGit(repoDir, 'reset', '--mixed', base);
    const reloaded = loadWorkspace(repoDir);
    writeManifestWithReason(reloaded, { ...manifest, packs: [{ ...manifest.packs[0], scope_files: ['app.mjs'] }] },
      '保留这次关口逐文件批准的记录', 'internal_test');
    const good = fixtureCommit(repoDir, 'fixture containing approved files only', ':(literal)extra[ab].mjs', 'deleted later.mjs');
    assert.equal(cli('record', 'commit', '--from-git').outcome, 'committed');
    assert.equal(saved().commit.sha, good);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('ignoring out-of-scope changes updates the snapshot without approving files for commit', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const fail = (...args) => runCliFailure(args, repoDir);
  const write = (file, content) => fs.writeFileSync(path.join(repoDir, file), content);
  const saved = () => readJsonSafe(ctx.paths.statePath).packs.A;
  const events = () => readEvents(ctx.paths.eventsPath);
  try {
    fixtureGit(repoDir, 'init');
    for (const file of ['app.mjs', 'personal.mjs', 'removed.mjs']) write(file, 'fixture baseline');
    fixtureCommit(repoDir, 'fixture baseline', 'app.mjs', 'personal.mjs', 'removed.mjs');
    assert.equal(cli('next').action, 'IMPLEMENT');
    write('app.mjs', 'fixture package change');
    write('personal.mjs', 'fixture outside change');
    fs.unlinkSync(path.join(repoDir, 'removed.mjs'));

    const paused = cli('record', 'implement', '--passed');
    assert.equal(paused.gate.resume_status, 'VERIFY');
    const option = paused.question.options.find(({ id }) => id === 'ignore');
    assert.equal(option.label, '这些不是本包改的，放行');
    assert.equal(option.needs_text, true);
    const answer = ['answer', '--question', paused.question.id, '--option', 'ignore'];
    const before = saved();
    assert.match(fail(...answer).stderr, /非空的 --text/);
    assert.match(fail('resume', '--action', 'ignore').stderr, /非空的 --decision/);
    assert.match(fail('resume', '--action', 'ignore', '--decision', '   ').stderr, /非空的 --decision/);

    const decision = '  这些是我在执行期间手动改的。\n请保留这些文件。  ';
    const gitDir = path.join(repoDir, '.git');
    const unavailableGitDir = path.join(repoDir, '.git-unavailable');
    fs.renameSync(gitDir, unavailableGitDir);
    try {
      assert.match(fail(...answer, '--text', decision).stderr, /无法读取当前工作区内容/);
    } finally {
      fs.renameSync(unavailableGitDir, gitDir);
    }
    assert.deepEqual(saved(), before);
    assert.equal(events().some(({ type, action }) => type === 'gate_resumed' && action === 'ignore'), false);

    write('personal.mjs', 'fixture outside change updated while paused');
    assert.equal(cli(...answer, '--text', decision).status, 'VERIFY');
    const resumed = saved();
    assert.deepEqual(resumed.start_worktree, {
      ...before.start_worktree,
      'personal.mjs': fixtureGit(repoDir, 'hash-object', 'personal.mjs'),
      'removed.mjs': null
    });
    assert.equal(resumed.gate, null);
    assert.deepEqual(resumed.approved_out_of_scope, before.approved_out_of_scope);
    assert.deepEqual(loadWorkspace(repoDir).manifest.packs[0].scope_files, ['app.mjs']);
    assert.equal(resumed.decisions.at(-1).action, 'ignore');
    assert.equal(resumed.decisions.at(-1).decision, decision);
    const event = events().find(({ type, action }) => type === 'gate_resumed' && action === 'ignore');
    assert.equal(event.decision, decision);
    assert.equal(event.gate_reason, 'OUT_OF_SCOPE_CHANGE');

    cli('record', 'verify', '--passed', '--allow-self-report');
    cli('record', 'review', '--verdict', 'pass');
    assert.equal(cli('next').action, 'COMMIT');
    write('personal.mjs', 'fixture outside change after ignore');
    const pausedAgain = cli('next');
    assert.equal(pausedAgain.gate.resume_status, 'READY_TO_COMMIT');
    assert.deepEqual(pausedAgain.gate.out_of_scope_files, [{ path: 'personal.mjs', status: ' M' }]);

    write('late.mjs', 'fixture change after the gate was opened');
    fixtureGit(repoDir, 'add', '--', 'late.mjs');
    const pending = cli('resume', '--action', 'ignore', '--decision', '这次仍然是我手动修改的。');
    assert.equal(pending.outcome, 'paused_out_of_scope_change');
    assert.equal(pending.gate.resume_status, 'READY_TO_COMMIT');
    assert.deepEqual(pending.gate.out_of_scope_files, [{ path: 'late.mjs', status: 'A ' }]);
    assert.match(pending.question.body, /late\.mjs（新增）/);
    fixtureGit(repoDir, 'rm', '-f', '--', 'late.mjs');
    assert.equal(cli('resume', '--action', 'revert').status, 'READY_TO_COMMIT');

    fixtureCommit(repoDir, 'fixture commit with ignored file', 'app.mjs', 'personal.mjs');
    const rejected = fail('record', 'commit', '--from-git');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /本次提交包含未批准的范围外文件。\s+- personal\.mjs/);
    assert.equal(saved().status, 'READY_TO_COMMIT');
    assert.equal(saved().commit, null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('executor approval pauses for out-of-scope changes and revert rechecks the worktree', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'] }]);
  try {
    const cli = (...args) => runCli(args, repoDir);
    fixtureGit(repoDir, 'init');
    fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'fixture baseline');
    fixtureCommit(repoDir, 'fixture baseline', 'app.mjs');
    cli('next');
    const stray = path.join(repoDir, 'unexpected.mjs');
    fs.writeFileSync(stray, 'fixture outside scope');

    const executor = cli('record', 'implement', '--blocked', '需要确认现有改动');
    assert.equal(executor.question.kind, 'EXECUTOR_BLOCKED');
    const paused = cli('answer', '--question', executor.question.id, '--option', 'approve');
    assert.equal(paused.question.kind, 'OUT_OF_SCOPE_CHANGE');
    assert.equal(paused.gate.resume_status, 'VERIFY');
    const revert = runCliFailure(['resume', '--action', 'revert'], repoDir);
    assert.equal(revert.status, 1);
    assert.match(revert.stderr, /仍有范围外的改动.*unexpected\.mjs/);
    assert.deepEqual(cli('status', '--format', 'shell').question, paused.question);
    assert.equal(readEvents(ctx.paths.eventsPath).some(({ type, action }) => type === 'gate_resumed' && action === 'revert'), false);

    fs.unlinkSync(stray);
    assert.equal(cli('resume', '--action', 'revert').status, 'VERIFY');
    assert.equal(cli('status', '--format', 'shell').question, null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('an existing out-of-scope gate can be answered with its original actions', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  try {
    fixtureGit(repoDir, 'init');
    fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'fixture baseline');
    fixtureCommit(repoDir, 'fixture baseline', 'app.mjs');
    cli('next');
    const stray = path.join(repoDir, 'unexpected.mjs');
    fs.writeFileSync(stray, 'fixture outside scope');
    cli('record', 'implement', '--passed');
    const state = readJsonSafe(ctx.paths.statePath);
    const gate = state.packs.A.gate;
    gate.summary = '发现本包范围外的改动。请决定扩大范围、撤掉改动或终止流程。';
    gate.allowed_resume_actions = ['expand', 'revert', 'abort'];
    gate.out_of_scope_files.push({ path: 'conflicted.mjs', status: 'UD' }, { path: 'type-changed.mjs', status: ' T' });
    saveState(ctx.stateDir, state);

    const { question } = cli('status', '--format', 'shell');
    assert.deepEqual(question.options.map(({ id }) => id), gate.allowed_resume_actions);
    assert.match(question.body, /conflicted\.mjs（冲突）/);
    assert.match(question.body, /type-changed\.mjs（ T）/);
    const denied = runCliFailure(['resume', '--action', 'ignore', '--decision', '这些是我改的。'], repoDir);
    assert.match(denied.stderr, /OUT_OF_SCOPE_CHANGE/);
    assert.deepEqual(readJsonSafe(ctx.paths.statePath).packs.A.gate, gate);

    const another = path.join(repoDir, 'another.mjs');
    fs.writeFileSync(another, 'fixture second outside change');
    const retry = runCliFailure(['answer', '--question', question.id, '--option', 'revert'], repoDir);
    assert.match(retry.stderr, /仍有范围外的改动.*another\.mjs/);
    const refreshed = cli('next');
    assert.deepEqual(refreshed.gate.allowed_resume_actions, gate.allowed_resume_actions);
    assert.equal(refreshed.gate.summary, gate.summary);
    assert.notEqual(refreshed.question.id, question.id);
    fs.unlinkSync(stray);
    fs.unlinkSync(another);
    assert.equal(cli('answer', '--question', refreshed.question.id, '--option', 'revert').status, 'VERIFY');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('out-of-scope checks handle unavailable Git and legacy baselines', () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['app.mjs'] }]);
  try {
    const cli = (...args) => runCli(args, repoDir);
    cli('next');
    const state = readJsonSafe(ctx.paths.statePath);
    assert.equal(state.packs.A.start_worktree, null);
    delete state.packs.A.start_worktree;
    saveState(ctx.stateDir, state);
    const implementation = cli('record', 'implement', '--passed');
    assert.equal(implementation.status, 'VERIFY');
    assert.match(implementation.worktree_notice, /开工时没记到工作区快照/);
    cli('record', 'verify', '--passed', '--allow-self-report');
    cli('record', 'review', '--verdict', 'pass');
    const skipped = cli('next');
    assert.equal(skipped.action, 'COMMIT');
    assert.equal(skipped.git_watch.status, 'skipped');

    fixtureGit(repoDir, 'init');
    fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'fixture baseline');
    const base = fixtureCommit(repoDir, 'fixture baseline', 'app.mjs');
    const other = path.join(repoDir, 'unexpected.mjs');
    fs.writeFileSync(other, 'fixture preexisting change');
    assert.equal(cli('next').action, 'COMMIT');
    const backfilled = readJsonSafe(ctx.paths.statePath);
    assert.equal(backfilled.packs.A.base_commit, base);
    assert.equal(backfilled.packs.A.start_worktree['unexpected.mjs'], fixtureGit(repoDir, 'hash-object', 'unexpected.mjs'));

    backfilled.packs.A.start_worktree = null;
    saveState(ctx.stateDir, backfilled);
    const fallback = cli('next');
    assert.equal(fallback.gate.reason, 'OUT_OF_SCOPE_CHANGE');
    assert.deepEqual(fallback.gate.out_of_scope_files, [{ path: 'unexpected.mjs', status: '??' }]);
    assert.match(fallback.question.body, /越界检查只按本包范围判断/);
    assert.ok(fallback.question.body.includes('这些文件里可能有开工前就改过的，不是本包改的请选「这些不是本包改的，放行」'));
    assert.equal(cli('resume', '--action', 'ignore', '--decision', '这是开工前就有的改动。').status, 'READY_TO_COMMIT');
    assert.deepEqual(readJsonSafe(ctx.paths.statePath).packs.A.start_worktree, {
      'unexpected.mjs': fixtureGit(repoDir, 'hash-object', 'unexpected.mjs')
    });
    fs.writeFileSync(other, 'fixture change after ignore');
    assert.equal(cli('next').gate.reason, 'OUT_OF_SCOPE_CHANGE');
    assert.equal(cli('resume', '--action', 'abort').outcome, 'aborted');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Git checkpoints warn once for unrelated commits and gate current and completed pack changes', () => {
  const { repoDir, ctx } = setupCtx([
    { id: 'A', scope_files: ['done[ab].js'] },
    { id: 'B', scope_files: ['active.js'], co_change_files: ['companion.js'] },
    { id: 'EXTERNAL', scope_files: ['donea.js'] }
  ], { verification: { commands: [shellQuote(process.execPath) + ' --check active.js'] } });
  const cli = (...args) => runCli(args, repoDir);
  const write = (file, content) => fs.writeFileSync(path.join(repoDir, file), content);
  const saved = () => readJsonSafe(ctx.paths.statePath).packs.B;
  try {
    fixtureGit(repoDir, 'init', '-b', 'fixture-branch');
    for (const file of ['done[ab].js', 'active.js', 'companion.js']) write(file, 'let value = 1;\n');
    fixtureCommit(repoDir, 'fixture baseline', 'done[ab].js', 'active.js', 'companion.js');
    cli('record', 'external', '--pack', 'EXTERNAL', '--note', 'Completed outside the test loop');
    cli('next');
    write('done[ab].js', 'let value = 2;\n');
    const completed = fixtureCommit(repoDir, 'fixture pack A implementation', 'done[ab].js');
    cli('record', 'commit', '--from-git');
    assert.match(runCliFailure(['record', 'external', '--pack', 'A', '--note', 'Already recorded'], repoDir).stderr, /already committed/);
    cli('next');
    assert.equal(saved().base_commit, completed);
    assert.equal(saved().base_branch, 'fixture-branch');
    cli('record', 'implement', '--passed');

    write('donea.js', 'let other = 1;\n');
    const unrelated = fixtureCommit(repoDir, 'fixture external unrelated', 'donea.js');
    const verified = cli('verify');
    assert.equal(verified.passed, true);
    assert.deepEqual(verified.git_watch.commits, [{ sha: unrelated, files: ['donea.js'] }]);
    assert.equal(cli('dispatch', '--stage', 'review', '--dry-run').git_watch, undefined);

    write('active.js', 'let value = 3;\n');
    const scoped = fixtureCommit(repoDir, 'fixture external active overlap', 'active.js');
    const reviewGate = cli('dispatch', '--stage', 'review');
    assert.equal(reviewGate.action, 'PAUSE_FOR_HUMAN');
    assert.equal(reviewGate.gate.reason, 'EXTERNAL_COMMIT');
    assert.deepEqual(reviewGate.gate.conflicting_files, ['active.js']);
    assert.ok(reviewGate.gate.external_commits.some(({ sha }) => sha === scoped));
    assert.deepEqual(reviewGate.gate.allowed_resume_actions, ['approve', 'abort']);
    assert.ok(reviewGate.question.body.includes(scoped) && reviewGate.question.body.includes('active.js'));
    assert.deepEqual(reviewGate.question, cli('status', '--format', 'shell').question);
    assert.equal(runCliFailure(['resume', '--action', 'commit'], repoDir).status, 1);
    const blockedRecord = cli('record', 'commit', '--sha', scoped);
    assert.equal(blockedRecord.action, 'PAUSE_FOR_HUMAN');
    assert.deepEqual(blockedRecord.question, reviewGate.question);
    const decision = '  对照过当前文件，允许从此处继续。\n已核对外部提交。  ';
    const answer = ['answer', '--question', reviewGate.question.id, '--option', 'approve'];
    assert.match(runCliFailure(answer, repoDir).stderr, /非空的 --text/);
    assert.equal(cli(...answer, '--text', decision).status, 'REVIEW');
    assert.equal(saved().base_commit, scoped);
    assert.equal(saved().resolved_gates.EXTERNAL_COMMIT.decision, decision);
    cli('record', 'review', '--verdict', 'pass');

    write('done[ab].js', 'let value = 4;\n');
    const later = fixtureCommit(repoDir, 'fixture external completed overlap', 'done[ab].js');
    const commitGate = cli('next');
    assert.equal(commitGate.action, 'PAUSE_FOR_HUMAN');
    assert.deepEqual(commitGate.gate.external_commits, [{ sha: later, files: ['done[ab].js'] }]);
    assert.deepEqual(commitGate.gate.conflicting_files, ['done[ab].js']);
    assert.equal(cli('resume', '--decision', '已核对完成包的改动，继续').status, 'READY_TO_COMMIT');
    assert.equal(cli('next').action, 'COMMIT');

    write('companion.js', 'let value = 5;\n');
    const companion = fixtureCommit(repoDir, 'fixture external companion overlap', 'companion.js');
    write('active.js', 'let value = 6;\n');
    const own = fixtureCommit(repoDir, 'fixture pack B implementation', 'active.js');
    const recordGate = cli('record', 'commit', '--from-git');
    assert.equal(recordGate.action, 'PAUSE_FOR_HUMAN');
    assert.deepEqual(recordGate.gate.external_commits, [{ sha: companion, files: ['companion.js'] }]);
    assert.deepEqual(recordGate.gate.conflicting_files, ['companion.js']);
    assert.equal(cli('resume', '--decision', '批准此 HEAD，保留本包提交').base_commit, own);
    assert.equal(cli('record', 'commit', '--from-git').outcome, 'committed');
    assert.equal(saved().commit.sha, own);
    const shell = cli('status', '--format', 'shell');
    assert.equal(shell.now.waiting_for, 'none');
    assert.equal(shell.now.next_command, null);
    assert.equal(shell.packs[1].commit, own);
    assert.equal(shell.packs[2].commit, null);
    const notices = readEvents(ctx.paths.eventsPath).filter(({ type }) => type === 'external_commits_noticed');
    assert.deepEqual(notices.map(({ commits }) => commits), [[{ sha: unrelated, files: ['donea.js'] }]]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('codex resume keeps --cd/--sandbox before the resume subcommand', () => {
  const cfg = { executable: 'codex', model: 'm', reasoning_effort: 'high' };
  const { args } = codexAdapter.buildArgs(cfg, { repoDir: '/repo', runDir: '/run', readOnly: false, resumeSessionId: 'abc' });
  const at = args.indexOf('resume');
  assert.ok(at > 0);
  assert.equal(args[at + 1], 'abc');
  assert.ok(args.indexOf('--cd') < at && args.indexOf('--sandbox') < at);
  assert.equal(args.at(-1), '-');
  const fresh = codexAdapter.buildArgs(cfg, { repoDir: '/repo', runDir: '/run', readOnly: true }).args;
  assert.equal(fresh.includes('resume'), false);
  assert.equal(fresh[fresh.indexOf('--sandbox') + 1], 'read-only');
});

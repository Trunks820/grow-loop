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
import { buildTaskPrompt } from '../src/task-builder.mjs';
import { buildRedactor } from '../src/redact.mjs';
import { generateEvidencePack } from '../src/evidence.mjs';
import { classifyInfraError } from '../src/adapters/base.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';
import { getVerificationCommands } from '../src/verify.mjs';
import { parseReviewReport } from '../src/review-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PKG_ROOT, 'bin', 'grow-loop.mjs');

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

test('running Codex dispatch keeps its task and route while final markdown produces open todos', async () => {
  const { repoDir, ctx } = setupCtx([{ id: 'A', scope_files: ['src/a.mjs'] }]);
  const cli = (...args) => runCli(args, repoDir);
  const ready = path.join(repoDir, 'executor-ready');
  const release = path.join(repoDir, 'executor-release');
  const mock = path.join(repoDir, 'mock-codex.cjs');
  const finalPath = path.join(repoDir, 'mock-response.md');
  const final = [
    '## Summary', '- Other: ignore this', '```md', '## 超范围没改', '- Fenced: ignore this', '```',
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
    assert.doesNotMatch(task, /src\/b\.mjs/);
    const persisted = readJsonSafe(ctx.paths.statePath).packs.A;
    assert.equal(persisted.current_tier, 'tier2');
    assert.equal(persisted.active_instance, 'tier2-cli');
    assert.equal(persisted.last_session_id, null);
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
    fs.writeFileSync(finalPath, '### 超范围没改（0 项）\n- 无\n- 没有\n- 暂无。', 'utf8');
    const emptyReport = cli('dispatch');
    assert.equal(emptyReport.transition.outcome, 'ready_for_verify');
    assert.ok(emptyReport.warnings.some((warning) => warning.includes('未解析出待办')));
    assert.deepEqual(cli('status').open_todos, todos);
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
    assert.equal(ctx.state.packs.W01.gate.reason, ALLOWED_GATE_REASONS.INFRA_BLOCKED);
    assert.equal(ctx.state.packs.W01.tier1_repairs, 0);
    assert.equal(ctx.state.packs.W01.tier2_repairs, 0);
    assert.equal(ctx.state.packs.W01.infra_failures, 1);

    // Explicit retry resumes IMPLEMENT without touching budgets
    const resumed = resumeFromGate(ctx, { action: 'retry', decision: 'Quota restored' });
    assert.equal(resumed.outcome, 'resumed_implement');
    assert.equal(ctx.state.packs.W01.tier1_repairs, 0);
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
      assert.equal(pack.last_verify.environment_reason, reason);
      assert.equal(pack.last_verify.repair_undo, undefined);
      assert.deepEqual(readJsonSafe(ctx.paths.lessonsJsonPath).items, [earlier]);
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
    { severity: 'HIGH', title: 'Retry skips verification', locator: 'src/retry.mjs#verify' },
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
    const repair = cli('dispatch', '--dry-run');
    const repairTask = fs.readFileSync(path.join(repair.run_dir, 'task.md'), 'utf8');
    assert.match(repairTask, /## Blocking Findings to Fix\r?\n- .*Retry skips verification/);
    assert.match(repairTask, /## 顺手一起修（不阻断）\r?\n- .*Clarify retry log/);

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
      findings: [{ severity: 'HIGH', title: 'Missing transaction boundary', locator: 'Service.save' }]
    });
    assert.equal(r2.outcome, 'escalated_tier2_on_review_cap');
    assert.equal(b.ctx.state.packs.W01.current_tier, 'tier2');

    // Tier2 fixes & passes VERIFY -> does NOT open 3rd review; pauses for human commit sign-off
    recordImplementOutcome(b.ctx, { passed: true });
    const vFinal = recordVerifyOutcome(b.ctx, { passed: true, summary: 'all checks green' });
    assert.equal(vFinal.outcome, 'paused_review_cap_verified');
    assert.equal(b.ctx.state.packs.W01.gate.reason, ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED);
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
  } finally {
    fs.rmSync(c.repoDir, { recursive: true, force: true });
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
      tags: ['db']
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
      '--rule', 'Always redact tokens', '--tags', 'core'
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createInitialState,
  ensureGitignoreEntry,
  loadWorkspace,
  resolveStateDir,
  saveState,
  writeJsonAtomic
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
    return { status: err.status, stderr: String(err.stderr || '') };
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
    runCli(['init', '--repo', repoDir, '--profile', 'standard-test']);
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
    let state = JSON.parse(fs.readFileSync(path.join(repoDir, '.loop', 'state.json'), 'utf8'));
    assert.equal(state.packs.W01.last_verify.source, 'cli');
    assert.equal(state.packs.W01.last_verify.passed, false);
    assert.ok(fs.existsSync(path.join(v1.run_dir, 'cmd-2', 'stderr.log')));
    const lessons = JSON.parse(fs.readFileSync(path.join(repoDir, '.loop', 'lessons.json'), 'utf8'));
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

    // 1. init with live-smoke profile
    const initRes = runCli(['init', '--repo', repoDir, '--profile', 'live-smoke', '--project', 'demo-app']);
    assert.equal(initRes.ok, true);
    assert.equal(initRes.gitignore.updated, true);
    assert.equal(initRes.state_dir, path.join(repoDir, '.loop'));

    // Replace manifest with 2 real packs and use self executor for deterministic CI testing
    const configPath = path.join(repoDir, '.loop', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.executors = { self: { kind: 'self', label: 'Host Harness' } };
    cfg.routing.tier1 = 'self';
    cfg.routing.tier2 = 'self';
    cfg.routing.reviewer = 'self';
    cfg.code_intel = { tool: 'none' };
    cfg.verification.commands = [`${shellQuote(process.execPath)} --check hello.js`];
    writeJsonAtomic(configPath, cfg);

    writeJsonAtomic(path.join(repoDir, '.loop', 'manifest.json'), {
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

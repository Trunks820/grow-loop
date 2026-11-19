#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  appendEvent,
  createInitialState,
  ensureDir,
  ensureGitignoreEntry,
  getStatePaths,
  loadWorkspace,
  readJsonSafe,
  resolveStateDir,
  saveState,
  writeJsonAtomic
} from '../src/state.mjs';
import {
  getPackDef,
  recordCommitOutcome,
  recordImplementOutcome,
  recordReviewOutcome,
  recordVerifyOutcome,
  resolveTierInstance,
  resumeFromGate,
  startOrAdvanceActivePack
} from '../src/router.mjs';
import { getAdapter } from '../src/adapters/index.mjs';
import { probeAllInstances } from '../src/probe.mjs';
import { buildTaskPrompt } from '../src/task-builder.mjs';
import { addLesson } from '../src/lessons.mjs';
import { generateEvidencePack } from '../src/evidence.mjs';
import { buildRedactor } from '../src/redact.mjs';
import { getVerificationCommands, runVerification } from '../src/verify.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

function outJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function printHelp() {
  process.stdout.write(`grow-loop v0.1.0 — Harness-agnostic multi-package delivery loop

Usage:
  grow-loop init      [--repo <dir>] [--state-dir <dir>] [--profile standard-test|live-smoke] [--project <name>] [--no-gitignore]
  grow-loop probe     [--repo <dir>] [--state-dir <dir>] [--timeout <ms>]
  grow-loop status    [--repo <dir>] [--state-dir <dir>]
  grow-loop next      [--repo <dir>] [--state-dir <dir>]
  grow-loop dispatch  [--repo <dir>] [--state-dir <dir>] [--stage implement|review] [--dry-run] [--resume] [--task-file <path>]
  grow-loop verify    [--repo <dir>] [--state-dir <dir>] [--timeout <sec>]
  grow-loop record    <implement|verify|review|commit|lesson> [flags]
  grow-loop resume    --decision "<text>" [--action approve|repair|retry|commit|switch_instance|abort] [--instance <id>]
  grow-loop evidence  [--repo <dir>] [--state-dir <dir>] [--out <path>]

Default state directory: <repo>/.loop/ (auto-added to .gitignore; override with --state-dir or GROW_LOOP_STATE_DIR)
`);
}

function cmdInit(flags) {
  const repoDir = path.resolve(flags.repo || process.cwd());
  const stateDir = resolveStateDir(repoDir, flags['state-dir']);
  const profileName = String(flags.profile || 'standard-test');
  const profilePath = path.join(PKG_ROOT, 'profiles', `${profileName}.json`);

  if (!fs.existsSync(profilePath)) {
    throw new Error(`Unknown profile "${profileName}". Available: standard-test, live-smoke`);
  }

  ensureDir(stateDir);
  const paths = getStatePaths(stateDir);
  const profileTemplate = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  if (!fs.existsSync(paths.configPath) || flags.force) {
    writeJsonAtomic(paths.configPath, profileTemplate);
  }

  let manifest = readJsonSafe(paths.manifestPath);
  if (!manifest || flags.force) {
    manifest = {
      project: flags.project || path.basename(repoDir),
      upstream_source: flags.upstream || null,
      packs: [
        {
          id: 'W01',
          title: 'Example first work package (replace with your real packs)',
          goal: 'Describe the bounded deliverable and preserved behavior for W01.',
          depends_on: [],
          risk: 'medium',
          estimated_files: 10,
          cross_module: false,
          scope_files: [],
          acceptance_criteria: ['AC-W01-01: Replace with observable verification criterion'],
          open_questions: [],
          external_effects: [],
          tags: []
        }
      ]
    };
    writeJsonAtomic(paths.manifestPath, manifest);
  }

  let state = readJsonSafe(paths.statePath);
  if (!state || flags.force) {
    state = createInitialState(repoDir, stateDir, profileName, manifest);
    saveState(stateDir, state);
  }

  const gitignoreResult = flags['no-gitignore']
    ? { updated: false, reason: 'skipped_by_flag' }
    : ensureGitignoreEntry(repoDir, stateDir);

  appendEvent(stateDir, profileTemplate, {
    type: 'loop_initialized',
    profile: profileName,
    state_dir: stateDir,
    gitignore: gitignoreResult
  });

  outJson({
    ok: true,
    repo_dir: repoDir,
    state_dir: stateDir,
    profile: profileName,
    gitignore: gitignoreResult,
    files: {
      config: paths.configPath,
      manifest: paths.manifestPath,
      state: paths.statePath
    },
    next_steps: [
      `Edit ${paths.manifestPath} with your ordered work packages (or import from grow-me / ai-dev-workflow).`,
      `Review ${paths.configPath} to map tier1 / tier2 / reviewer instances and verify commands.`,
      'Run: grow-loop probe',
      'Run: grow-loop next'
    ]
  });
}

async function cmdProbe(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const report = await probeAllInstances(ctx, {
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined
  });
  outJson(report);
}

function cmdStatus(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const summary = ctx.state.pack_order.map((id) => {
    const p = ctx.state.packs[id];
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      tier: p.current_tier,
      instance: p.active_instance,
      repairs: `${p.tier1_repairs}/${p.tier2_repairs}`,
      reviews: p.review_rounds,
      infra_failures: p.infra_failures,
      commit: p.commit?.sha?.slice(0, 9) || null,
      gate: p.gate?.reason || null
    };
  });
  outJson({
    loop_status: ctx.state.loop_status,
    profile: ctx.state.profile,
    state_dir: ctx.stateDir,
    active_pack_id: ctx.state.active_pack_id,
    packs: summary
  });
}

function cmdNext(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const directive = startOrAdvanceActivePack(ctx);
  outJson(directive);
}

async function cmdDispatch(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const packId = flags.pack || ctx.state.active_pack_id;
  const pack = ctx.state.packs[packId];
  const packDef = getPackDef(ctx.manifest, packId);
  if (!pack || !packDef) throw new Error(`Pack "${packId}" not found`);

  const stage = String(flags.stage || (pack.status === 'REVIEW' ? 'review' : 'implement')).toLowerCase();
  const readOnly = stage === 'review';
  const instanceId = flags.instance || (readOnly ? resolveTierInstance(ctx.config, 'reviewer') : pack.active_instance || resolveTierInstance(ctx.config, pack.current_tier || 'tier1'));
  const instanceCfg = ctx.config?.executors?.[instanceId] || { kind: 'self' };
  const adapter = getAdapter(instanceCfg.kind || 'self');
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${stamp}-${stage}-${instanceId}${flags['dry-run'] ? '-dryrun' : ''}`;
  const runDir = path.join(ctx.paths.runsDir, pack.id, runId);
  ensureDir(runDir);

  const taskFilePath = flags['task-file']
    ? path.resolve(flags['task-file'])
    : buildTaskPrompt(ctx, { pack, packDef, stage, runDir });

  const resumeSessionId = flags.resume ? (typeof flags.resume === 'string' ? flags.resume : pack.last_session_id) : null;

  if (flags['dry-run']) {
    const receipt = await adapter.dryRun({
      instanceId,
      cfg: instanceCfg,
      repoDir: ctx.state.repo_dir,
      runDir,
      taskFilePath,
      stage,
      readOnly,
      resumeSessionId,
      redactor
    });
    appendEvent(ctx.stateDir, ctx.config, {
      type: 'dispatch_dry_run',
      pack_id: pack.id,
      stage,
      instance: instanceId,
      run_id: runId
    });
    outJson({ run_id: runId, run_dir: runDir, dry_run: receipt });
    return;
  }

  appendEvent(ctx.stateDir, ctx.config, {
    type: 'dispatch_started',
    pack_id: pack.id,
    stage,
    instance: instanceId,
    read_only: readOnly,
    run_id: runId,
    resumed_session: resumeSessionId || null
  });

  const result = await adapter.run({
    instanceId,
    cfg: instanceCfg,
    repoDir: ctx.state.repo_dir,
    runDir,
    taskFilePath,
    stage,
    readOnly,
    resumeSessionId,
    timeoutSec: flags.timeout ? Number(flags.timeout) : undefined,
    redactor
  });

  let transition = null;
  if (stage === 'implement' && result.status !== 'host_action_required') {
    transition = recordImplementOutcome(ctx, {
      packId: pack.id,
      passed: result.status === 'completed',
      infraError: result.infra_error || null,
      sessionId: result.session_id || null,
      runId,
      summary: result.infra_error ? `Adapter ${instanceId} hit ${result.infra_error}` : `Adapter ${instanceId} exited with code ${result.exit_code}`
    });
  }

  outJson({ run_id: runId, run_dir: runDir, result, transition });
}

function readGitHeadCommit(repoDir) {
  const meta = execFileSync('git', ['-C', repoDir, 'log', '-1', '--format=%H|%s'], { encoding: 'utf8' }).trim();
  const [sha, ...msgParts] = meta.split('|');
  const stat = execFileSync('git', ['-C', repoDir, 'show', '--shortstat', '--format=', sha], { encoding: 'utf8' }).trim();
  const files = Number((stat.match(/(\d+)\s+files?\s+changed/) || [])[1] || 0);
  const insertions = Number((stat.match(/(\d+)\s+insertions?\(\+\)/) || [])[1] || 0);
  const deletions = Number((stat.match(/(\d+)\s+deletions?\(-\)/) || [])[1] || 0);
  return { sha, message: msgParts.join('|'), files, insertions, deletions };
}

function cmdRecord(sub, flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const packId = flags.pack || ctx.state.active_pack_id;

  if (sub === 'implement') {
    const res = recordImplementOutcome(ctx, {
      packId,
      passed: Boolean(flags.passed) && !flags.failed && !flags['infra-error'],
      infraError: flags['infra-error'] || null,
      sessionId: flags['session-id'] || null,
      runId: flags['run-id'] || null,
      summary: flags.summary || '',
      rule: flags.rule || ''
    });
    outJson(res);
    return;
  }

  if (sub === 'verify') {
    const claimsPass = Boolean(flags.passed) && !flags.failed;
    if (claimsPass && getVerificationCommands(ctx.config).length && !flags['allow-self-report']) {
      throw new Error('verification.commands are configured: run "grow-loop verify" so the CLI checks real exit codes, or pass --allow-self-report to record an unchecked pass.');
    }
    const res = recordVerifyOutcome(ctx, {
      packId,
      passed: Boolean(flags.passed) && !flags.failed,
      command: flags.command || null,
      summary: flags.summary || '',
      rootCause: flags['root-cause'] || '',
      rule: flags.rule || '',
      locator: flags.locator || ''
    });
    outJson(res);
    return;
  }

  if (sub === 'review') {
    let findings = [];
    if (flags['findings-file']) {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(flags['findings-file']), 'utf8'));
      findings = Array.isArray(parsed) ? parsed : (parsed.findings || []);
    } else if (flags.findings) {
      findings = JSON.parse(flags.findings);
    }
    const res = recordReviewOutcome(ctx, {
      packId,
      verdict: flags.verdict || (findings.length ? 'fail' : 'pass'),
      findings,
      summary: flags.summary || '',
      reviewer: flags.reviewer || null
    });
    outJson(res);
    return;
  }

  if (sub === 'commit') {
    const gitInfo = flags['from-git'] ? readGitHeadCommit(ctx.state.repo_dir) : null;
    const sha = flags.sha || gitInfo?.sha;
    if (!sha) throw new Error('Specify --from-git or --sha <commit-hash>');
    const res = recordCommitOutcome(ctx, {
      packId,
      sha,
      message: flags.message || gitInfo?.message || '',
      files: flags.files ?? gitInfo?.files ?? 0,
      insertions: flags.insertions ?? gitInfo?.insertions ?? 0,
      deletions: flags.deletions ?? gitInfo?.deletions ?? 0
    });
    outJson(res);
    return;
  }

  if (sub === 'lesson') {
    const entry = addLesson(ctx.stateDir, ctx.config, {
      pack_id: packId || 'GLOBAL',
      stage: flags.stage || 'MANUAL',
      severity: flags.severity || 'HIGH',
      summary: flags.summary || '',
      root_cause: flags['root-cause'] || '',
      rule: flags.rule || '',
      locator: flags.locator || '',
      tags: flags.tags ? String(flags.tags).split(',').map((s) => s.trim()).filter(Boolean) : []
    });
    outJson(entry);
    return;
  }

  throw new Error(`Unknown record subcommand "${sub}". Use: implement | verify | review | commit | lesson`);
}

async function cmdVerify(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const res = await runVerification(ctx, {
    packId: flags.pack || ctx.state.active_pack_id,
    timeoutSec: flags.timeout ? Number(flags.timeout) : undefined
  });
  outJson(res);
}

function cmdResume(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const res = resumeFromGate(ctx, {
    packId: flags.pack || ctx.state.active_pack_id,
    action: flags.action || 'approve',
    decision: flags.decision || '',
    instance: flags.instance || null
  });
  outJson(res);
}

function cmdEvidence(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const outPath = flags.out ? path.resolve(flags.out) : undefined;
  const res = generateEvidencePack(ctx, outPath);
  outJson(res);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    printHelp();
    return;
  }

  try {
    if (cmd === 'init') cmdInit(flags);
    else if (cmd === 'probe') await cmdProbe(flags);
    else if (cmd === 'status') cmdStatus(flags);
    else if (cmd === 'next') cmdNext(flags);
    else if (cmd === 'dispatch') await cmdDispatch(flags);
    else if (cmd === 'verify') await cmdVerify(flags);
    else if (cmd === 'record') cmdRecord(positionals[1], flags);
    else if (cmd === 'resume') cmdResume(flags);
    else if (cmd === 'evidence') cmdEvidence(flags);
    else throw new Error(`Unknown command "${cmd}". Run "grow-loop --help".`);
  } catch (err) {
    process.stderr.write(`[grow-loop error] ${err.message || err}\n`);
    process.exitCode = 1;
  }
}

main();

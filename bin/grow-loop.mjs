#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  addScopeTodos,
  appendEvent,
  checkManifest,
  createInitialState,
  ensureDir,
  ensureGitignoreEntry,
  getStatePaths,
  loadWorkspace,
  ManifestChangedError,
  readJsonSafe,
  readManifest,
  resolveStateDir,
  saveState,
  writeJsonAtomic,
  writeManifestWithReason
} from '../src/state.mjs';
import {
  getBudgets,
  getPackDef,
  getRepairRounds,
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
import { buildTaskPrompt, parseOutOfScopeItems, taskBriefWarnings } from '../src/task-builder.mjs';
import { addLesson, loadLessons, updateLesson } from '../src/lessons.mjs';
import { generateEvidencePack } from '../src/evidence.mjs';
import { buildRedactor } from '../src/redact.mjs';
import { getVerificationCommands, runVerification } from '../src/verify.mjs';
import { parseReviewReport } from '../src/review-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const positionals = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const equals = tok.indexOf('=');
      const key = tok.slice(2, equals === -1 ? undefined : equals);
      const next = argv[i + 1];
      let value = true;
      if (equals !== -1) {
        value = tok.slice(equals + 1);
      } else if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      }
      if (key === 'add') {
        (flags.add ??= []).push(value);
      } else {
        flags[key] = value;
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
  grow-loop init      [--repo <dir>] [--state-dir <dir>] [--profile standard-test|live-smoke] [--manifest <file>] [--project <name>] [--no-gitignore] [--force]
  grow-loop probe     [--repo <dir>] [--state-dir <dir>] [--timeout <ms>]
  grow-loop status    [--repo <dir>] [--state-dir <dir>]
  grow-loop manifest-ack --reason "<text>" [--repo <dir>] [--state-dir <dir>]
  grow-loop pack insert --file <pack.json> (--after <ID> | --before <ID>) --reason "<text>"
  grow-loop pack tier --id <ID> --tier tier1|tier2 --reason "<text>"
  grow-loop pack scope --id <ID> --add <file>[,<file>...] --reason "<text>" [--todo <ID>]
  grow-loop forward --to <ID> (--text "<text>" | --todo <ID>) --reason "<text>" [--from <ID>]
  grow-loop todo add --pack <ID> --text "<text>" --reason "<text>"
  grow-loop todo list
  grow-loop todo dismiss --todo <ID> --reason "<text>"
  grow-loop lesson confirm --id <ID> --rule "<text>" (--scope global | --scope tags [--tags a,b]) [--root-cause "<text>"]
  grow-loop lesson disable --id <ID> --reason "<text>"
  grow-loop lesson list [--status draft|confirmed|disabled]
  grow-loop next      [--repo <dir>] [--state-dir <dir>]
  grow-loop dispatch  [--repo <dir>] [--state-dir <dir>] [--stage implement|review] [--dry-run] [--resume] [--task-file <path>]
  grow-loop verify    [--repo <dir>] [--state-dir <dir>] [--pack <id>] [--timeout <sec>] [--mark-env "<reason>"]
  grow-loop record    <implement|verify|review|commit|lesson> [flags]
  grow-loop record review --report <report.md> [--reviewer <instance>]
  grow-loop record lesson --summary "<text>" [--pack <ID>] [--rule "<text>"] [--scope global|tags] [--tags a,b]
  grow-loop resume    --decision "<text>" [--action approve|repair|retry|commit|switch_instance|abort] [--instance <id>]
  grow-loop evidence  [--repo <dir>] [--state-dir <dir>] [--out <path>]

Default state directory: <repo>/.loop/ (auto-added to .gitignore; override with --state-dir or GROW_LOOP_STATE_DIR)
To replace an existing manifest and reset workspace state, use grow-loop init --force --manifest <file>.
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
  if (flags.manifest !== undefined && (typeof flags.manifest !== 'string' || !flags.manifest.trim())) {
    throw new Error('Specify a file with --manifest.');
  }

  const paths = getStatePaths(stateDir);
  const profileTemplate = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const replaceManifest = Boolean(flags.force && flags.manifest);
  let existingConfig;
  if (!replaceManifest) {
    try {
      existingConfig = readJsonSafe(paths.configPath);
    } catch (error) {
      // Preserve an existing config, even if it cannot provide redaction settings.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  let manifest = replaceManifest ? null : readManifest(paths.manifestPath);
  if (manifest) {
    const { pending } = checkManifest(paths, manifest, existingConfig || profileTemplate, { allowPendingManifest: true });
    const replaceCommand = 'grow-loop init --force --manifest <file>';
    if (pending) {
      if (flags.manifest) pending.replace_command = replaceCommand;
      throw new ManifestChangedError(pending);
    }
    if (flags.manifest) {
      throw new Error(`A workspace manifest already exists. Use "${replaceCommand}" to replace it and reset workspace state.`);
    }
  }

  const writeManifest = !manifest;
  if (writeManifest) {
    if (flags.manifest) {
      manifest = readManifest(path.resolve(flags.manifest));
      if (!manifest) throw new Error('--manifest must point to a grow-loop JSON manifest.');
    } else {
      manifest = { project: flags.project || path.basename(repoDir), upstream_source: flags.upstream || null, packs: [] };
    }
  }

  const existingState = flags.force ? null : readJsonSafe(paths.statePath);
  if (!fs.existsSync(paths.configPath) || flags.force) {
    writeJsonAtomic(paths.configPath, profileTemplate);
  }
  if (writeManifest) writeJsonAtomic(paths.manifestPath, manifest);

  if (!existingState) {
    saveState(stateDir, createInitialState(repoDir, stateDir, profileName, manifest));
  }
  if (writeManifest || !fs.existsSync(paths.manifestSnapshotPath)) {
    writeJsonAtomic(paths.manifestSnapshotPath, manifest);
  }

  const gitignoreResult = flags['no-gitignore']
    ? { updated: false, reason: 'skipped_by_flag' }
    : ensureGitignoreEntry(repoDir, stateDir);

  appendEvent(stateDir, flags.force ? profileTemplate : existingConfig || profileTemplate, {
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
      `Review ${paths.configPath} to map tier1 / tier2 / reviewer instances and verify commands.`,
      ...((manifest.packs || []).length ? [] : [
        `Add your work packages to ${paths.manifestPath}, then run: grow-loop manifest-ack --reason "<reason>"`
      ]),
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
  const ctx = loadWorkspace(flags.repo, flags['state-dir'], { allowPendingManifest: true });
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
    packs: summary,
    open_todos: (ctx.state.todos || []).filter((todo) => todo.status === 'open'),
    ...lessonDraftNotice(ctx.stateDir),
    ...(ctx.manifestChange ? { manifest_change_pending: ctx.manifestChange } : {})
  });
}

function cmdManifestAck(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir'], { allowPendingManifest: true });
  const changes = writeManifestWithReason(ctx, ctx.manifest, flags.reason, 'manifest_ack');
  outJson(changes
    ? { ok: true, message: 'Manifest changes acknowledged.', changes }
    : { ok: true, message: 'No manifest changes.' });
}

function requireText(value, flag) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Specify a non-empty --${flag}.`);
  return value.trim();
}

function chooseFlag(flags, first, second) {
  if ((flags[first] === undefined) === (flags[second] === undefined)) {
    throw new Error(`Specify exactly one of --${first} or --${second}.`);
  }
  return flags[first] === undefined ? second : first;
}

function requireUncommittedPack(ctx, value, flag) {
  const id = requireText(value, flag);
  const packDef = getPackDef(ctx.manifest, id);
  if (!packDef) throw new Error(`Pack "${id}" not found in the manifest.`);
  if (ctx.state.packs[id].status === 'COMMITTED') throw new Error(`Pack ${id} is already committed.`);
  return packDef;
}

function requireOpenTodo(ctx, value) {
  const id = requireText(value, 'todo');
  const todo = (ctx.state.todos || []).find((entry) => entry.id === id);
  if (!todo) throw new Error(`Todo "${id}" not found.`);
  if (todo.status !== 'open') throw new Error(`Todo ${id} is already ${todo.status}.`);
  return todo;
}

function updatePackDef(ctx, packDef, reason, source, details) {
  const packs = ctx.manifest.packs.map((pack) => pack.id === packDef.id ? packDef : pack);
  writeManifestWithReason(ctx, { ...ctx.manifest, packs }, reason, source, { pack_id: packDef.id, ...details });
}

function cmdPackInsert(ctx, flags, reason) {
  const position = chooseFlag(flags, 'after', 'before');
  const anchorId = requireText(flags[position], position);
  const anchorIndex = ctx.manifest.packs.findIndex((pack) => pack.id === anchorId);
  if (anchorIndex === -1) throw new Error(`Pack "${anchorId}" not found in the manifest.`);
  if (position === 'before' && ctx.state.packs[anchorId].status !== 'PENDING') {
    throw new Error(`Cannot insert before ${anchorId}: it has already started or is committed. Use --after ${anchorId}.`);
  }

  const file = requireText(flags.file, 'file');
  let newPack;
  try {
    newPack = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('--file must point to an existing pack JSON file.');
    if (error instanceof SyntaxError) throw new Error('--file must contain valid pack JSON.');
    throw error;
  }
  if (typeof newPack?.id !== 'string' || !newPack.id.trim()) {
    throw new Error('--file must contain one pack object with a non-empty id.');
  }
  if (Object.hasOwn(ctx.state.packs, newPack.id)) throw new Error(`Pack ${newPack.id} already exists.`);
  if (position === 'after' && !Object.hasOwn(newPack, 'depends_on')) newPack.depends_on = [anchorId];

  const index = anchorIndex + (position === 'after' ? 1 : 0);
  const earlierIds = new Set(ctx.manifest.packs.slice(0, index).map((pack) => pack.id));
  if (Object.hasOwn(newPack, 'depends_on') && (!Array.isArray(newPack.depends_on) || newPack.depends_on.some((id) =>
    typeof id !== 'string' || (!earlierIds.has(id) && !(Object.hasOwn(ctx.state.packs, id) && ctx.state.packs[id].status === 'COMMITTED'))
  ))) {
    throw new Error('The inserted pack may depend only on earlier or committed packs.');
  }

  const updatedDependencies = [];
  const packs = ctx.manifest.packs.map((pack, packIndex) => {
    const dependsOn = pack.depends_on || [];
    const rewired = position === 'before' ? pack.id === anchorId : dependsOn.includes(anchorId);
    if (!rewired || ctx.state.packs[pack.id].status === 'COMMITTED' || dependsOn.includes(newPack.id)) return pack;
    if (ctx.state.packs[pack.id].status !== 'PENDING' || packIndex < index) {
      throw new Error(`Cannot make ${pack.id} wait for the inserted pack. Use --after ${pack.id}.`);
    }
    updatedDependencies.push(pack.id);
    return { ...pack, depends_on: [...dependsOn, newPack.id] };
  });
  packs.splice(index, 0, newPack);
  const activeId = ctx.state.active_pack_id;
  if (ctx.state.packs[activeId]?.status === 'PENDING' && index <= ctx.state.pack_order.indexOf(activeId)) {
    ctx.state.active_pack_id = null;
  }
  const details = { pack_id: newPack.id, position, anchor_id: anchorId, index, updated_dependencies: updatedDependencies };
  writeManifestWithReason(ctx, { ...ctx.manifest, packs }, reason, 'pack_insert', details);
  outJson({ ok: true, ...details });
}

function cmdPackTier(ctx, flags, reason) {
  const packDef = requireUncommittedPack(ctx, flags.id, 'id');
  const tier = flags.tier;
  if (!['tier1', 'tier2'].includes(tier)) throw new Error('Specify --tier tier1 or --tier tier2.');
  const pack = ctx.state.packs[packDef.id];
  const started = pack.status !== 'PENDING';
  const details = { tier, previous_tier: started ? pack.current_tier : packDef.tier ?? null, effective: started ? 'next_dispatch' : 'preflight' };
  if (started) {
    const instance = resolveTierInstance(ctx.config, tier);
    details.previous_instance = pack.active_instance;
    details.active_instance = instance;
    if (instance !== pack.active_instance) pack.last_session_id = null;
    pack.current_tier = tier;
    pack.active_instance = instance;
    pack.escalated = true;
    const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
    pack.escalation_reason = redactor.redactString(`Manual tier change to ${tier}: ${reason}`);
    const undo = pack.last_verify?.repair_undo;
    if (undo) {
      // A later operator decision supersedes the route that verification can undo.
      Object.assign(undo.fields, {
        current_tier: pack.current_tier,
        active_instance: pack.active_instance,
        last_session_id: pack.last_session_id,
        escalated: pack.escalated,
        escalation_reason: pack.escalation_reason
      });
    }
  }
  updatePackDef(ctx, { ...packDef, tier }, reason, 'pack_tier', details);
  outJson({ ok: true, pack_id: packDef.id, ...details });
}

function cmdPackScope(ctx, flags, reason) {
  const packDef = requireUncommittedPack(ctx, flags.id, 'id');
  const files = (flags.add || []).flatMap((value) => requireText(value, 'add').split(',').map((file) => file.trim()));
  if (!files.length || files.some((file) => !file)) throw new Error('Specify --add with one or more non-empty file paths.');
  const todo = flags.todo === undefined ? null : requireOpenTodo(ctx, flags.todo);
  const scopeFiles = [...new Set([...(packDef.scope_files || []), ...files])];
  const priorEstimate = Number(packDef.estimated_files);
  const estimatedFiles = Math.max(Number.isFinite(priorEstimate) ? priorEstimate : 0, scopeFiles.length);
  const details = { added_files: scopeFiles.filter((file) => !packDef.scope_files?.includes(file)), estimated_files: estimatedFiles };
  if (todo) {
    todo.status = 'expanded';
    todo.target_pack_id = packDef.id;
    details.todo_id = todo.id;
    details.todo_status = todo.status;
  }
  updatePackDef(ctx, { ...packDef, scope_files: scopeFiles, estimated_files: estimatedFiles }, reason, 'pack_scope', details);
  outJson({ ok: true, pack_id: packDef.id, ...details });
}

function cmdPack(sub, flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const reason = requireText(flags.reason, 'reason');
  if (sub === 'insert') cmdPackInsert(ctx, flags, reason);
  else if (sub === 'tier') cmdPackTier(ctx, flags, reason);
  else if (sub === 'scope') cmdPackScope(ctx, flags, reason);
  else throw new Error('Unknown pack subcommand. Use: insert | tier | scope.');
}

function cmdForward(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const reason = requireText(flags.reason, 'reason');
  const target = requireUncommittedPack(ctx, flags.to, 'to');
  const input = chooseFlag(flags, 'text', 'todo');
  const todo = input === 'todo' ? requireOpenTodo(ctx, flags.todo) : null;
  const content = todo?.content ?? requireText(flags.text, 'text');
  const sourceId = flags.from === undefined ? todo?.pack_id ?? ctx.state.active_pack_id : requireText(flags.from, 'from');
  if (!Object.hasOwn(ctx.state.packs, sourceId)) throw new Error('Source pack not found. Specify --from <ID>.');
  if (todo && sourceId !== todo.pack_id) throw new Error(`Todo ${todo.id} is from pack ${todo.pack_id}.`);

  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  const finding = { from_pack_id: sourceId, content: redactor.redactString(content), reason: redactor.redactString(reason), at: new Date().toISOString() };
  const details = { from_pack_id: sourceId };
  if (todo) {
    todo.status = 'forwarded';
    todo.target_pack_id = target.id;
    details.todo_id = todo.id;
    details.todo_status = todo.status;
  }
  updatePackDef(ctx, { ...target, forwarded_findings: [...(target.forwarded_findings || []), finding] }, reason, 'forward', details);
  outJson({ ok: true, to_pack_id: target.id, ...details });
}

function cmdTodo(sub, flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  if (sub === 'list') {
    outJson({ todos: ctx.state.todos || [] });
  } else if (sub === 'add') {
    const reason = requireText(flags.reason, 'reason');
    const packId = requireText(flags.pack, 'pack');
    if (!Object.hasOwn(ctx.state.packs, packId)) throw new Error(`Pack "${packId}" not found.`);
    const [todo] = addScopeTodos(ctx, { packId, texts: [requireText(flags.text, 'text')], reason });
    outJson({ ok: true, todo });
  } else if (sub === 'dismiss') {
    const reason = requireText(flags.reason, 'reason');
    const todo = requireOpenTodo(ctx, flags.todo);
    todo.status = 'dismissed';
    saveState(ctx.stateDir, ctx.state);
    appendEvent(ctx.stateDir, ctx.config, { type: 'todo_dismissed', todo_id: todo.id, pack_id: todo.pack_id, reason });
    outJson({ ok: true, todo });
  } else {
    throw new Error('Unknown todo subcommand. Use: add | list | dismiss.');
  }
}

function cmdNext(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const directive = startOrAdvanceActivePack(ctx);
  outJson({ ...directive, ...lessonDraftNotice(ctx.stateDir) });
}

function lessonDraftNotice(stateDir) {
  const drafts = loadLessons(stateDir).items
    .filter(({ status }) => status === 'draft')
    .map(({ id, summary }) => ({ id, summary }));
  return drafts.length ? {
    lesson_draft_notice: `有 ${drafts.length} 条教训草稿待确认`,
    lesson_drafts: drafts
  } : {};
}

function parseLessonTags(value) {
  return value === undefined ? undefined : requireText(value, 'tags').split(',').map((tag) => tag.trim()).filter(Boolean);
}

function cmdLesson(sub, flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir'], { allowPendingManifest: sub === 'list' });
  if (sub === 'list') {
    const status = flags.status;
    if (status !== undefined && !['draft', 'confirmed', 'disabled'].includes(status)) {
      throw new Error('Specify --status draft, confirmed, or disabled.');
    }
    const items = loadLessons(ctx.stateDir).items.filter((item) => status === undefined || item.status === status);
    appendEvent(ctx.stateDir, ctx.config, { type: 'lesson_listed', status: status ?? null, count: items.length });
    outJson({ items });
  } else if (sub === 'confirm') {
    const id = requireText(flags.id, 'id');
    const rule = requireText(flags.rule, 'rule');
    const scope = requireText(flags.scope, 'scope');
    if (scope === 'global' && flags.tags !== undefined) throw new Error('Use --tags with --scope tags.');
    const tags = parseLessonTags(flags.tags);
    const rootCause = flags['root-cause'] === undefined ? undefined : requireText(flags['root-cause'], 'root-cause');
    outJson(updateLesson(ctx.stateDir, ctx.config, id, { status: 'confirmed', rule, scope, tags, rootCause }));
  } else if (sub === 'disable') {
    const id = requireText(flags.id, 'id');
    const reason = requireText(flags.reason, 'reason');
    outJson(updateLesson(ctx.stateDir, ctx.config, id, { status: 'disabled', reason }));
  } else {
    throw new Error('Unknown lesson subcommand. Use: confirm | disable | list.');
  }
}

function recordReviewReport(ctx, { packId, reportPath, reviewer, reviewerModel, reviewRound, runId }) {
  let markdown;
  let report;
  try {
    markdown = fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    report = { errors: [`Report file: cannot read Markdown${error.code ? ` (${error.code})` : ''}.`] };
  }
  report ??= parseReviewReport(markdown, getBudgets(ctx.config).blockingSeverities);
  if (report.errors) {
    const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
    const invalid = {
      outcome: 'review_report_invalid',
      report_path: redactor.redactString(reportPath),
      errors: report.errors
    };
    appendEvent(ctx.stateDir, ctx.config, {
      type: invalid.outcome,
      pack_id: packId,
      reviewer,
      run_id: runId || null,
      report_path: invalid.report_path,
      errors: invalid.errors
    });
    process.exitCode = 1;
    return invalid;
  }
  return recordReviewOutcome(ctx, { ...report, packId, reportPath, reviewer, reviewerModel, reviewRound });
}

async function cmdDispatch(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const packId = flags.pack || ctx.state.active_pack_id;
  const pack = ctx.state.packs[packId];
  const packDef = getPackDef(ctx.manifest, packId);
  if (!pack || !packDef) throw new Error(`Pack "${packId}" not found`);
  if (pack.status === 'COMMITTED') throw new Error(`Pack ${packId} is already committed.`);

  const stage = String(flags.stage || (pack.status === 'REVIEW' ? 'review' : 'implement')).toLowerCase();
  const readOnly = stage === 'review';
  const reviewRound = pack.review_rounds + 1;
  const instanceId = flags.instance || (readOnly ? resolveTierInstance(ctx.config, 'reviewer') : pack.active_instance || resolveTierInstance(ctx.config, pack.current_tier || 'tier1'));
  const instanceCfg = ctx.config?.executors?.[instanceId] || { kind: 'self' };
  const adapter = getAdapter(instanceCfg.kind || 'self');
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${stamp}-${stage}-${instanceId}${flags['dry-run'] ? '-dryrun' : ''}`;
  const runDir = path.join(ctx.paths.runsDir, pack.id, runId);
  ensureDir(runDir);
  ensureDir(path.join(ctx.paths.artifactsDir, pack.id));
  const warnings = taskBriefWarnings(packDef, ctx.config);

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
    outJson({ run_id: runId, run_dir: runDir, dry_run: receipt, warnings });
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
  if (stage === 'implement' && pack.last_verify?.repair_undo) {
    delete pack.last_verify.repair_undo;
    saveState(ctx.stateDir, ctx.state);
  }

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
    // An operator may have changed the route, scope, or todos while the adapter ran.
    ctx.state = readJsonSafe(ctx.paths.statePath);
    transition = recordImplementOutcome(ctx, {
      packId: pack.id,
      passed: result.status === 'completed',
      infraError: result.infra_error || null,
      sessionId: result.session_id || null,
      runId,
      dispatch: { tier: pack.current_tier || 'tier1', instance: instanceId },
      summary: result.infra_error ? `Adapter ${instanceId} hit ${result.infra_error}` : `Adapter ${instanceId} exited with code ${result.exit_code}`
    });
    if (adapter.kind === 'codex' && result.final_md) {
      let report;
      try {
        report = parseOutOfScopeItems(fs.readFileSync(result.final_md, 'utf8'), { includeSection: true });
      } catch {
        // The adapter outcome remains valid if its optional final message is unreadable.
      }
      if (report?.items.length) {
        addScopeTodos(ctx, { packId: pack.id, runId, texts: report.items, reason: 'Reported by the executor as out of scope.' });
      } else if (report?.hasSection) {
        warnings.push('执行者的最终回复含「超范围没改」一节，但未解析出待办。');
      }
    }
  } else if (readOnly && result.status === 'completed' && !result.infra_error && result.final_md) {
    ctx.state = readJsonSafe(ctx.paths.statePath);
    transition = recordReviewReport(ctx, {
      packId: pack.id,
      reportPath: result.final_md,
      reviewer: instanceId,
      reviewerModel: instanceCfg.model || null,
      reviewRound,
      runId
    });
  }

  outJson({ run_id: runId, run_dir: runDir, result, transition, warnings });
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
    if (claimsPass && getVerificationCommands(ctx.config, getPackDef(ctx.manifest, packId)).length && !flags['allow-self-report']) {
      throw new Error('Verification commands are configured: run "grow-loop verify" so the CLI checks real exit codes, or pass --allow-self-report to record an unchecked pass.');
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
    if ('report' in flags) {
      if (typeof flags.report !== 'string' || !flags.report.trim()) throw new Error('Specify --report <report.md>.');
      if (['findings-file', 'findings', 'verdict', 'summary'].some((flag) => flag in flags)) {
        throw new Error('With --report, put the verdict, summary and findings in the Markdown report.');
      }
      outJson(recordReviewReport(ctx, {
        packId,
        reportPath: path.resolve(flags.report),
        reviewer: flags.reviewer || 'self'
      }));
      return;
    }
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
    const pack = ctx.state.packs[packId];
    const entry = addLesson(ctx.stateDir, ctx.config, {
      pack_id: packId || 'GLOBAL',
      stage: flags.stage || 'MANUAL',
      severity: flags.severity || 'HIGH',
      summary: flags.summary || '',
      root_cause: flags['root-cause'] || '',
      rule: flags.rule === undefined ? '' : requireText(flags.rule, 'rule'),
      locator: flags.locator || '',
      tags: parseLessonTags(flags.tags) ?? getPackDef(ctx.manifest, packId)?.tags,
      scope: flags.scope,
      repair_rounds: pack ? getRepairRounds(pack) : 0,
      discovered_by: 'manual'
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
    timeoutSec: flags.timeout ? Number(flags.timeout) : undefined,
    markEnv: flags['mark-env']
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
    else if (cmd === 'manifest-ack') cmdManifestAck(flags);
    else if (cmd === 'pack') cmdPack(positionals[1], flags);
    else if (cmd === 'forward') cmdForward(flags);
    else if (cmd === 'todo') cmdTodo(positionals[1], flags);
    else if (cmd === 'lesson') cmdLesson(positionals[1], flags);
    else if (cmd === 'next') cmdNext(flags);
    else if (cmd === 'dispatch') await cmdDispatch(flags);
    else if (cmd === 'verify') await cmdVerify(flags);
    else if (cmd === 'record') cmdRecord(positionals[1], flags);
    else if (cmd === 'resume') cmdResume(flags);
    else if (cmd === 'evidence') cmdEvidence(flags);
    else throw new Error(`Unknown command "${cmd}". Run "grow-loop --help".`);
  } catch (err) {
    if (err instanceof ManifestChangedError) {
      outJson({ ok: false, error: 'manifest_changed', message: err.message, ...err.pending });
    } else {
      process.stderr.write(`[grow-loop error] ${err.message || err}\n`);
    }
    process.exitCode = 1;
  }
}

main();

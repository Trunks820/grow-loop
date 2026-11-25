#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  addScopeTodos,
  appendEvent,
  checkManifest,
  createInitialState,
  ensureDir,
  ensureGitignoreEntry,
  expandPackScope,
  getStatePaths,
  invalidateSession,
  loadWorkspace,
  ManifestChangedError,
  readJsonSafe,
  readManifest,
  rememberSession,
  resolveStateDir,
  saveState,
  validateDecisions,
  writeJsonAtomic,
  writeManifestWithReason,
  writePackDefinition
} from '../src/state.mjs';
import {
  buildNextDirective,
  getBudgets,
  getPackDef,
  getRepairRounds,
  recordCommitOutcome,
  recordExternalCompletion,
  recordInfraFailure,
  recordImplementOutcome,
  recordReviewOutcome,
  recordVerifyOutcome,
  requireHandoffPreflight,
  resolveTierInstance,
  resumeFromGate,
  startOrAdvanceActivePack
} from '../src/router.mjs';
import { EXECUTABLE_NOT_FOUND } from '../src/adapters/base.mjs';
import { getAdapter } from '../src/adapters/index.mjs';
import { probeAllInstances, probeDispatchVersion } from '../src/probe.mjs';
import { buildTaskPrompt, isScopeDirectory, parseImplementBlockedReason, parseOutOfScopeItems, taskBriefWarnings } from '../src/task-builder.mjs';
import { addLesson, loadLessons, updateLesson } from '../src/lessons.mjs';
import { generateEvidencePack } from '../src/evidence.mjs';
import { buildRedactor } from '../src/redact.mjs';
import { getVerificationCommands, recordVerificationBaseline, runVerification } from '../src/verify.mjs';
import { parseReviewReport } from '../src/review-report.mjs';
import { ALLOWED_GATE_REASONS } from '../src/gate.mjs';
import { checkExternalCommits, readGitHeadCommit } from '../src/git-watch.mjs';
import { handoffFillSteps, handoffNeeds, readHandoff } from '../src/handoff.mjs';
import { acknowledgeManifest, answerQuestion, buildQuestion, buildShellStatus, dispatchStillRunning } from '../src/shell-api.mjs';

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
  process.stdout.write(`grow-loop v0.2.1 — Harness-agnostic multi-package delivery loop

Usage:
  grow-loop init      [--repo <dir>] [--state-dir <dir>] [--profile standard-test|live-smoke] [--manifest <file> | --handoff <file>] [--project <name>] [--no-gitignore] [--force]
  grow-loop import    --handoff <file> --reason "<text>" [--repo <dir>] [--state-dir <dir>]
  grow-loop probe     [--repo <dir>] [--state-dir <dir>] [--timeout <ms>]
  grow-loop status    [--format shell] [--repo <dir>] [--state-dir <dir>]
  grow-loop answer    --question <id> --option <id> [--text "<text>"] [--repo <dir>] [--state-dir <dir>]
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
  grow-loop dispatch  [--repo <dir>] [--state-dir <dir>] [--stage implement|review] [--dry-run] [--resume [<session-id>]] [--task-file <path>]
  grow-loop verify    [--repo <dir>] [--state-dir <dir>] [--pack <id>] [--timeout <sec>] [--mark-env "<reason>" | --record-baseline]
  grow-loop record    <implement|verify|review|commit|external|lesson> [flags]
  grow-loop record implement (--passed | --blocked "<reason>") [--executor-tool <tool>] [--executor-model <model>] [--executor-effort <effort>]
  grow-loop record review --report <report.md> [--reviewer <instance>] [--executor-tool <tool>] [--executor-model <model>] [--executor-effort <effort>]
  grow-loop record external --pack <ID> --note "<what was completed outside the loop>"
  grow-loop record lesson --summary "<text>" [--pack <ID>] [--rule "<text>"] [--scope global|tags] [--tags a,b]
  grow-loop resume    [--decision "<text>"] [--action approve|repair|continue|retry|commit|switch_instance|expand|revert|abort] [--instance <id>]
  grow-loop evidence  [--repo <dir>] [--state-dir <dir>] [--out <path>]

Default state directory: <repo>/.loop/ (auto-added to .gitignore; override with --state-dir or GROW_LOOP_STATE_DIR)
To replace an existing manifest and reset workspace state, use grow-loop init --force with --manifest <file> or --handoff <file>.
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
  const sourceFlag = flags.handoff === undefined ? 'manifest' : chooseFlag(flags, 'manifest', 'handoff');
  const sourceFile = flags[sourceFlag];
  if (sourceFile !== undefined && (typeof sourceFile !== 'string' || !sourceFile.trim())) {
    throw new Error(`Specify a file with --${sourceFlag}.`);
  }

  const paths = getStatePaths(stateDir);
  const profileTemplate = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const replaceManifest = Boolean(flags.force && sourceFile);
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
    const replaceCommand = `grow-loop init --force --${sourceFlag} <file>`;
    if (pending) {
      if (sourceFile) pending.replace_command = replaceCommand;
      throw new ManifestChangedError(pending);
    }
    if (sourceFile) {
      throw new Error(`A workspace manifest already exists. Use "${replaceCommand}" to replace it and reset workspace state.`);
    }
  }

  const writeManifest = !manifest;
  if (writeManifest) {
    if (sourceFlag === 'handoff') {
      manifest = readHandoff(path.resolve(sourceFile));
    } else if (sourceFile) {
      manifest = readManifest(path.resolve(sourceFile));
      if (!manifest) throw new Error('--manifest must point to a grow-loop JSON manifest.');
      validateDecisions(manifest);
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

  const handoff = sourceFlag === 'handoff' ? summarizeHandoff(manifest.packs, profileTemplate) : null;
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
    ...(handoff && { imported_packs: handoff.imported_packs }),
    next_steps: [
      `Review ${paths.configPath} to map tier1 / tier2 / reviewer instances and verify commands.`,
      ...(handoff?.next_steps ?? []),
      ...((manifest.packs || []).length ? [] : [
        `Add your work packages to ${paths.manifestPath}, then run: grow-loop manifest-ack --reason "<reason>"`
      ]),
      'Run: grow-loop probe',
      'Run: grow-loop next'
    ]
  });
}

function summarizeHandoff(packs, config) {
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const importedPacks = packs.map((pack) => ({ id: redactor.redactString(pack.id), needs: handoffNeeds(pack) }));
  const needs = importedPacks.flatMap((pack) => pack.needs);
  return { imported_packs: importedPacks, next_steps: needs.length ? handoffFillSteps(needs) : [] };
}

function cmdImport(flags) {
  if (flags.manifest !== undefined) throw new Error('Use --handoff with grow-loop import.');
  const file = requireText(flags.handoff, 'handoff');
  const reason = requireText(flags.reason, 'reason');
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const existingIds = new Set(ctx.state.pack_order);
  for (const pack of Object.values(ctx.state.packs)) {
    if (pack.status === 'COMMITTED') existingIds.add(pack.id);
  }
  const imported = readHandoff(path.resolve(file), existingIds);
  const summary = summarizeHandoff(imported.packs, ctx.config);
  const duplicateIndex = imported.packs.findIndex(({ id }) => Object.hasOwn(ctx.state.packs, id));
  if (duplicateIndex !== -1) {
    throw new Error(`Pack ${summary.imported_packs[duplicateIndex].id} already exists.`);
  }
  const manifest = { ...ctx.manifest, packs: [...ctx.manifest.packs, ...imported.packs] };
  writeManifestWithReason(ctx, manifest, reason, 'handoff_import');
  outJson({ ok: true, ...summary, next_steps: [...summary.next_steps, 'Run: grow-loop next'] });
}

async function cmdProbe(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const report = await probeAllInstances(ctx, {
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined
  });
  outJson(report);
}

function cmdStatus(flags) {
  if (flags.format !== undefined && flags.format !== 'shell') throw new Error('Use --format shell, or omit --format.');
  const ctx = loadWorkspace(flags.repo, flags['state-dir'], { allowPendingManifest: true });
  if (flags.format === 'shell') {
    outJson(buildShellStatus(ctx));
    return;
  }
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  const packDefs = new Map(ctx.manifest.packs.map((pack) => [pack.id, pack]));
  const summary = ctx.state.pack_order.map((id) => {
    const p = ctx.state.packs[id];
    const needs = handoffNeeds(packDefs.get(id));
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      tier: p.current_tier,
      instance: p.active_instance,
      repairs: `${p.tier1_repairs}/${p.tier2_repairs}`,
      reviews: p.review_rounds,
      infra_failures: p.infra_failures,
      inflight_run: redactor.redactValue(p.inflight_run ?? null),
      commit: p.commit?.sha?.slice(0, 9) || null,
      completed_externally: p.completed_externally ?? null,
      gate: p.gate?.reason || null,
      ...(needs.length && { needs })
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
  outJson(acknowledgeManifest(ctx, flags.reason));
}

function cmdAnswer(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir'], { allowPendingManifest: true });
  outJson(answerQuestion(ctx, {
    id: requireText(flags.question, 'question'),
    optionId: requireText(flags.option, 'option'),
    text: flags.text
  }));
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
    if (instance !== pack.active_instance) invalidateSession(pack);
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
        last_session_route: pack.last_session_route,
        escalated: pack.escalated,
        escalation_reason: pack.escalation_reason
      });
    }
  }
  writePackDefinition(ctx, { ...packDef, tier }, reason, 'pack_tier', details);
  outJson({ ok: true, pack_id: packDef.id, ...details });
}

function cmdPackScope(ctx, flags, reason) {
  const packDef = requireUncommittedPack(ctx, flags.id, 'id');
  const files = (flags.add || []).flatMap((value) => requireText(value, 'add').split(',').map((file) => file.trim()));
  if (!files.length || files.some((file) => !file)) throw new Error('Specify --add with one or more non-empty file paths.');
  const directory = files.find((file) => isScopeDirectory(file, ctx.state.repo_dir));
  if (directory) {
    const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
    throw new Error(redactor.redactString(`范围里的「${directory}」是目录，请列出具体文件。`));
  }
  const todo = flags.todo === undefined ? null : requireOpenTodo(ctx, flags.todo);
  const details = {};
  if (todo) {
    todo.status = 'expanded';
    todo.target_pack_id = packDef.id;
    details.todo_id = todo.id;
    details.todo_status = todo.status;
  }
  const changes = expandPackScope(ctx, packDef, files, reason, details);
  outJson({ ok: true, pack_id: packDef.id, ...changes, ...details });
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
  writePackDefinition(ctx, { ...target, forwarded_findings: [...(target.forwarded_findings || []), finding] }, reason, 'forward', details);
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

function recordReviewReport(ctx, { packId, reportPath, reviewer, reviewerModel, reviewRound, runId, executor, dispatch }) {
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
  return recordReviewOutcome(ctx, { ...report, packId, reportPath, reviewer, reviewerModel, reviewRound, runId, executor, dispatch });
}

function taskFingerprint(ctx, pack, stage) {
  const { paths } = ctx;
  const inputs = {
    status: pack.status,
    tier1_repairs: pack.tier1_repairs,
    tier2_repairs: pack.tier2_repairs,
    review_rounds: pack.review_rounds,
    current_tier: pack.current_tier,
    active_instance: pack.active_instance,
    last_verify: pack.last_verify,
    findings: pack.pending_blocking_findings,
    decisions: pack.decisions,
    continue_pending: stage === 'implement' ? pack.continue_pending : undefined,
    gates: pack.resolved_gates,
    config: ctx.config
  };
  const hash = createHash('sha256').update(JSON.stringify(inputs));
  const files = [paths.manifestSnapshotPath, paths.lessonsJsonPath, paths.techDebtJsonPath];
  if (stage === 'implement' && ctx.config?.verification?.baseline) files.push(paths.baselinePath);
  for (const file of files) {
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return hash.digest('hex');
}

function prepareDispatch(ctx, pack, packDef, stage, instanceId, suppliedTask) {
  const prepared = pack.prepared_run;
  const reusable = prepared?.stage === stage && prepared.instance === instanceId;
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runsDir = path.join(ctx.paths.runsDir, pack.id);
  ensureDir(runsDir);
  const runDir = reusable ? prepared.run_dir
    : fs.mkdtempSync(path.join(runsDir, [stamp, stage, encodeURIComponent(instanceId), ''].join('-')));
  ensureDir(runDir);
  ensureDir(path.join(ctx.paths.artifactsDir, pack.id));
  const fingerprint = taskFingerprint(ctx, pack, stage);
  const generatedTask = path.join(runDir, 'task.md');
  let taskFile = suppliedTask;
  if (!taskFile) {
    taskFile = reusable && prepared.task_file === generatedTask && prepared.fingerprint === fingerprint && fs.existsSync(generatedTask)
      ? generatedTask : buildTaskPrompt(ctx, { pack, packDef, stage, runDir });
  }
  return { run_id: path.basename(runDir), run_dir: runDir, task_file: taskFile, stage, instance: instanceId, fingerprint };
}

function savedSession(pack, stage, instanceId) {
  const run = pack.inflight_run;
  if (run?.stage === stage && run.instance === instanceId && !run.route_changed &&
      run.active_instance === pack.active_instance && run.session_id) return run.session_id;
  if (!pack.last_session_id || instanceId !== pack.active_instance) return null;
  const route = pack.last_session_route;
  if (route?.id === pack.last_session_id) {
    return route.stage === stage && route.instance === instanceId ? pack.last_session_id : null;
  }
  return stage === 'implement' ? pack.last_session_id : null;
}

function observeExecutor(state, instance, { executable_path: file, executor_version: version }) {
  const seen = state.executors_seen ?? {};
  const previous = Object.hasOwn(seen, instance) ? seen[instance] : null;
  state.executors_seen = { ...seen, [instance]: { path: file, version, at: new Date().toISOString() } };
  if (!previous || (previous.path === file && previous.version === version)) return null;
  return { old_path: previous.path, old_version: previous.version, new_path: file, new_version: version };
}

async function cmdDispatch(flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const packId = flags.pack || ctx.state.active_pack_id;
  const pack = ctx.state.packs[packId];
  const packDef = getPackDef(ctx.manifest, packId);
  if (!pack || !packDef) throw new Error(`Pack "${packId}" not found`);
  if (pack.status === 'COMMITTED') throw new Error(`Pack ${packId} is already committed.`);
  if (ctx.state.loop_status === 'ABORTED') throw new Error('The loop was aborted.');
  requireHandoffPreflight(pack, packDef, ctx);

  const stage = String(flags.stage || (pack.status === 'REVIEW' ? 'review' : 'implement')).toLowerCase();
  if (!['review', 'implement'].includes(stage)) throw new Error('Use --stage implement or review.');
  const readOnly = stage === 'review';
  const reviewRound = pack.review_rounds + 1;
  const instanceId = flags.instance || (readOnly ? resolveTierInstance(ctx.config, 'reviewer', pack)
    : pack.active_instance || resolveTierInstance(ctx.config, pack.current_tier || 'tier1'));
  const instanceCfg = ctx.config?.executors?.[instanceId] || { kind: 'self' };
  const adapter = getAdapter(instanceCfg.kind || 'self');
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  const gitCheck = checkPackGit(ctx, pack, packDef, readOnly);
  if (gitCheck.action === 'PAUSE_FOR_HUMAN') {
    outJson(gitCheck);
    return;
  }
  const inflight = pack.inflight_run;
  if (!flags['dry-run'] && dispatchStillRunning(inflight)) {
    throw new Error('This pack already has a running dispatch. Check grow-loop status.');
  }
  if (!flags['dry-run'] && inflight?.kind === 'self' && !inflight.route_changed) {
    throw new Error('This pack has a self run awaiting grow-loop record ' + inflight.stage + '.');
  }
  const warnings = taskBriefWarnings(packDef, ctx.config, ctx.state.repo_dir);
  if (adapter.kind === 'custom-cmd') {
    if (!instanceCfg.model) warnings.push('custom-cmd 未配置 model，执行记录里的模型会是空的。');
    if (!instanceCfg.session_id_pattern && Array.isArray(instanceCfg.resume_args) &&
        instanceCfg.resume_args.some((arg) => String(arg).includes('{{session_id}}'))) {
      warnings.push('custom-cmd 的 resume_args 使用了 {{session_id}}，但未配置 session_id_pattern，拿不到会话号，--resume 会开新会话。');
    }
  }
  const suppliedTask = flags['task-file'] === undefined ? null : path.resolve(requireText(flags['task-file'], 'task-file'));
  if (suppliedTask && !fs.statSync(suppliedTask, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Specify a readable task file with --task-file <path>.');
  }
  let resumeSessionId = null;
  const useSavedSession = flags.resume === true || (flags.resume === undefined && stage === 'implement' && pack.continue_pending);
  if (useSavedSession) resumeSessionId = savedSession(pack, stage, instanceId);
  else if (flags.resume !== undefined) resumeSessionId = requireText(flags.resume, 'resume');
  if (useSavedSession && !resumeSessionId) warnings.push('当前阶段和执行实例没有可续的会话，本次会启动新会话。');
  const prepared = prepareDispatch(ctx, pack, packDef, stage, instanceId, suppliedTask);
  const { run_id: runId, run_dir: runDir, task_file: taskFilePath } = prepared;
  const adapterInput = {
    instanceId, cfg: instanceCfg, repoDir: ctx.state.repo_dir, runDir, taskFilePath,
    stage, readOnly, resumeSessionId, redactor
  };

  if (flags['dry-run']) {
    const receipt = await adapter.dryRun(adapterInput);
    pack.prepared_run = prepared;
    saveState(ctx.stateDir, ctx.state);
    appendEvent(ctx.stateDir, ctx.config, {
      type: 'dispatch_dry_run',
      pack_id: pack.id,
      stage,
      instance: instanceId,
      run_id: runId
    });
    outJson({ run_id: runId, run_dir: runDir, dry_run: receipt, warnings: [...warnings, ...(receipt.warnings ?? [])], ...gitCheck });
    return;
  }

  const startedAt = new Date().toISOString();
  pack.inflight_run = {
    run_id: runId, run_dir: runDir, task_file: taskFilePath, stage, instance: instanceId,
    kind: adapter.kind, tier: pack.current_tier || 'tier1', active_instance: pack.active_instance,
    started_at: startedAt, session_id: resumeSessionId, pid: process.pid
  };
  const dispatch = { tier: pack.inflight_run.tier, instance: instanceId };
  pack.prepared_run = null;
  if (stage === 'implement' && pack.last_verify?.repair_undo) delete pack.last_verify.repair_undo;
  saveState(ctx.stateDir, ctx.state);
  let result;
  let startedSessionId;
  let transition = null;
  try {
    const resolvedCommand = adapter.resolveCommand?.(instanceCfg, adapterInput.repoDir);
    const executorVersion = resolvedCommand?.cmd ? await probeDispatchVersion(ctx, resolvedCommand) : null;
    const executable = resolvedCommand && { executable_path: resolvedCommand.cmd, executor_version: executorVersion };
    let change;
    if (resolvedCommand?.cmd) {
      // The version probe can finish after another command has updated the workspace state.
      const latest = readJsonSafe(ctx.paths.statePath);
      const current = latest.packs[packId];
      if (current?.inflight_run?.run_id !== runId || current.status === 'COMMITTED' || latest.loop_status === 'ABORTED') {
        throw new Error('版本探测期间派活已取消，请查看 grow-loop status。');
      }
      change = observeExecutor(latest, instanceId, redactor.redactValue(executable));
      saveState(ctx.stateDir, latest);
    }
    appendEvent(ctx.stateDir, ctx.config, {
      type: 'dispatch_started', pack_id: pack.id, stage, instance: instanceId, read_only: readOnly,
      run_id: runId, started_at: startedAt, resumed_session: resumeSessionId || null, ...executable
    });
    if (change) {
      appendEvent(ctx.stateDir, ctx.config, {
        type: 'executor_version_changed', pack_id: pack.id, run_id: runId, stage, instance: instanceId, ...change
      });
      const oldVersion = change.old_version ?? '未知版本';
      const newVersion = change.new_version ?? '未知版本';
      warnings.push(`${redactor.redactString(instanceId)} 的程序换了：${oldVersion} → ${newVersion}`);
    }
    result = await adapter.run({
      ...adapterInput,
      resolvedCommand,
      executorVersion,
      startedAt,
      timeoutSec: flags.timeout ? Number(flags.timeout) : undefined,
      onSessionStarted(sessionId) {
        startedSessionId = sessionId;
        const latest = readJsonSafe(ctx.paths.statePath);
        const current = latest.packs[packId];
        const run = current?.inflight_run;
        if (run?.run_id !== runId || current.status === 'COMMITTED' || latest.loop_status === 'ABORTED') return;
        run.session_id = sessionId;
        if (!run.route_changed && current.active_instance === instanceId) {
          rememberSession(current, sessionId, stage, instanceId);
        }
        saveState(ctx.stateDir, latest);
      }
    });
    if (adapter.kind === 'custom-cmd' && instanceCfg.session_id_pattern && !result.session_id &&
        result.infra_error !== EXECUTABLE_NOT_FOUND) {
      warnings.push('custom-cmd 的 session_id_pattern 本次未匹配到会话号。');
    }
    if (result.status !== 'host_action_required') {
      // An operator may have changed the route, scope, or todos while the adapter ran.
      ctx.state = readJsonSafe(ctx.paths.statePath);
      ctx.manifest = readManifest(ctx.paths.manifestSnapshotPath) ?? ctx.manifest;
      const current = ctx.state.packs[packId];
      const run = current?.inflight_run;
      if (run?.run_id === runId && current.status !== 'COMMITTED' && ctx.state.loop_status !== 'ABORTED') {
        current.inflight_run = null;
        const executor = {
          executor_tool: adapter.kind, executor_model: instanceCfg.model ?? null,
          executor_effort: instanceCfg.reasoning_effort ?? null
        };
        dispatch.routeChanged = run.route_changed;
        const pendingGate = checkPackGit(ctx, current, getPackDef(ctx.manifest, packId), false);
        if (pendingGate.action === 'PAUSE_FOR_HUMAN') {
          transition = pendingGate;
        } else if (stage === 'implement' && result.status !== 'interrupted') {
          const markdown = readFinalReply(result.final_md);
          const passed = result.status === 'completed';
          const blockedReason = passed && result.exit_code === 0 && !result.infra_error && markdown !== null
            ? parseImplementBlockedReason(markdown) : null;
          transition = recordImplementOutcome(ctx, {
            packId, passed: passed && !blockedReason, blockedReason, infraError: result.infra_error || null,
            sessionId: startedSessionId || result.session_id || resumeSessionId, runId, dispatch, executor,
            summary: result.summary ?? (result.infra_error
              ? `Adapter ${instanceId} hit ${result.infra_error}` : `Adapter ${instanceId} exited with code ${result.exit_code}`)
          });
          recordOutOfScopeReport(ctx, packId, runId, markdown, warnings);
        } else if (readOnly && result.infra_error === EXECUTABLE_NOT_FOUND) {
          transition = recordInfraFailure(ctx, current, {
            instance: instanceId, infraError: result.infra_error, summary: result.summary, stage
          });
        } else if (readOnly && result.status === 'completed' && !result.infra_error && result.final_md) {
          transition = recordReviewReport(ctx, {
            packId, reportPath: result.final_md, reviewer: instanceId, reviewerModel: instanceCfg.model || null,
            reviewRound, runId, executor, dispatch
          });
        }
      }
    }
  } finally {
    if (result?.status !== 'host_action_required') {
      const latest = readJsonSafe(ctx.paths.statePath);
      const current = latest.packs[packId];
      if (current?.inflight_run?.run_id === runId) {
        current.inflight_run = null;
        saveState(ctx.stateDir, latest);
      }
    }
  }

  outJson({ run_id: runId, run_dir: runDir, result, transition, warnings, ...gitCheck,
    ...(transition?.question && { question: transition.question }) });
}

function readFinalReply(finalMd) {
  if (!finalMd) return null;
  try {
    return fs.readFileSync(finalMd, 'utf8');
  } catch {
    return null;
  }
}

function recordOutOfScopeReport(ctx, packId, runId, markdown, warnings) {
  if (markdown === null) return;
  const report = parseOutOfScopeItems(markdown, { includeSection: true });
  if (report.items.length) {
    addScopeTodos(ctx, { packId, runId, texts: report.items, reason: 'Reported by the executor as out of scope.' });
  } else if (report.hasSection) {
    warnings.push('执行者的最终回复含「超范围没改」一节，但未解析出待办。');
  }
}

function checkPackGit(ctx, pack, packDef, shouldCheck) {
  if (!pack) return {};
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT ||
      pack.gate?.reason === ALLOWED_GATE_REASONS.EXECUTOR_BLOCKED ||
      pack.gate?.infra_error === EXECUTABLE_NOT_FOUND ||
      pack.gate?.reason === ALLOWED_GATE_REASONS.OUT_OF_SCOPE_CHANGE) {
    return buildNextDirective(ctx, pack, packDef);
  }
  if (!shouldCheck || pack.status === 'COMMITTED') return {};
  const gitWatch = checkExternalCommits(ctx, pack, packDef);
  if (gitWatch?.status === 'blocked') return buildNextDirective(ctx, pack, packDef);
  return gitWatch ? { git_watch: gitWatch } : {};
}

function executorFlags(flags) {
  return Object.fromEntries(['tool', 'model', 'effort']
    .filter((field) => Object.hasOwn(flags, 'executor-' + field))
    .map((field) => ['executor_' + field, requireText(flags['executor-' + field], 'executor-' + field)]));
}

function cmdRecord(sub, flags) {
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  if (sub === 'external') {
    outJson(recordExternalCompletion(ctx, { packId: flags.pack, note: flags.note }));
    return;
  }

  const packId = flags.pack || ctx.state.active_pack_id;
  const pack = ctx.state.packs[packId];
  const packDef = getPackDef(ctx.manifest, packId);

  if (sub === 'implement') {
    if ('blocked' in flags && 'passed' in flags) {
      throw new Error('Use either --blocked "<reason>" or --passed.');
    }
    const res = recordImplementOutcome(ctx, {
      packId,
      passed: Boolean(flags.passed) && !flags.failed && !flags['infra-error'],
      blockedReason: flags.blocked === undefined ? null : requireText(flags.blocked, 'blocked'),
      infraError: flags['infra-error'] || null,
      sessionId: flags['session-id'] || null,
      runId: flags['run-id'] || null,
      executor: executorFlags(flags),
      summary: flags.summary || '',
      rule: flags.rule || ''
    });
    outJson(res);
    return;
  }

  if (sub === 'verify') {
    const gitCheck = checkPackGit(ctx, pack, packDef, pack?.status === 'VERIFY');
    if (gitCheck.action === 'PAUSE_FOR_HUMAN') {
      outJson(gitCheck);
      return;
    }
    const claimsPass = Boolean(flags.passed) && !flags.failed;
    if (claimsPass && getVerificationCommands(ctx.config, packDef).length && !flags['allow-self-report']) {
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
    outJson({ ...res, ...gitCheck });
    return;
  }

  if (sub === 'review') {
    const gitCheck = checkPackGit(ctx, pack, packDef, pack?.status === 'REVIEW');
    if (gitCheck.action === 'PAUSE_FOR_HUMAN') {
      outJson(gitCheck);
      return;
    }
    if ('report' in flags) {
      if (typeof flags.report !== 'string' || !flags.report.trim()) throw new Error('Specify --report <report.md>.');
      if (['findings-file', 'findings', 'verdict', 'summary'].some((flag) => flag in flags)) {
        throw new Error('With --report, put the verdict, summary and findings in the Markdown report.');
      }
      const reviewer = flags.reviewer || (pack?.inflight_run?.stage === 'review' && pack.inflight_run.kind === 'self'
        ? pack.inflight_run.instance : 'self');
      const res = recordReviewReport(ctx, {
        packId,
        reportPath: path.resolve(flags.report),
        reviewer,
        executor: executorFlags(flags)
      });
      outJson({ ...res, ...gitCheck });
      return;
    }
    if (Object.keys(executorFlags(flags)).length) throw new Error('Use --report to record the self-review executor.');
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
    outJson({ ...res, ...gitCheck });
    return;
  }

  if (sub === 'commit') {
    if (pack?.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) {
      outJson(buildNextDirective(ctx, pack, packDef));
      return;
    }
    const gitInfo = flags['from-git'] ? readGitHeadCommit(ctx.state.repo_dir) : null;
    if (flags['from-git'] && !gitInfo) {
      throw new Error('Unable to read the Git HEAD commit for --from-git. Use --sha <commit-hash> to record it manually.');
    }
    const sha = flags.sha || gitInfo?.sha;
    if (!sha) throw new Error('Specify --from-git or --sha <commit-hash>');
    const res = recordCommitOutcome(ctx, {
      packId,
      sha,
      message: flags.message || gitInfo?.message || '',
      files: flags.files ?? gitInfo?.files ?? 0,
      insertions: flags.insertions ?? gitInfo?.insertions ?? 0,
      deletions: flags.deletions ?? gitInfo?.deletions ?? 0,
      fromGit: Boolean(gitInfo)
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

  throw new Error(`Unknown record subcommand "${sub}". Use: implement | verify | review | commit | external | lesson`);
}

async function cmdVerify(flags) {
  const recordBaseline = 'record-baseline' in flags;
  if (recordBaseline && 'mark-env' in flags) {
    throw new Error('--record-baseline 和 --mark-env 不能一起用。');
  }
  const ctx = loadWorkspace(flags.repo, flags['state-dir']);
  const timeoutSec = flags.timeout ? Number(flags.timeout) : undefined;
  if (recordBaseline) {
    outJson(await recordVerificationBaseline(ctx, { timeoutSec }));
    return;
  }
  const packId = flags.pack || ctx.state.active_pack_id;
  const pack = ctx.state.packs[packId];
  const gitCheck = checkPackGit(ctx, pack, getPackDef(ctx.manifest, packId),
    pack?.status === 'VERIFY' || Boolean(pack?.last_verify?.repair_undo && typeof flags['mark-env'] === 'string' && flags['mark-env'].trim()));
  if (gitCheck.action === 'PAUSE_FOR_HUMAN') {
    outJson(gitCheck);
    return;
  }
  const res = await runVerification(ctx, {
    packId,
    timeoutSec,
    markEnv: flags['mark-env']
  });
  outJson({ ...res, ...gitCheck, ...(res.transition?.question && { question: res.transition.question }) });
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
    else if (cmd === 'import') cmdImport(flags);
    else if (cmd === 'probe') await cmdProbe(flags);
    else if (cmd === 'status') cmdStatus(flags);
    else if (cmd === 'answer') cmdAnswer(flags);
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
      const stateDir = resolveStateDir(flags.repo, flags['state-dir']);
      const question = buildQuestion({ stateDir, paths: getStatePaths(stateDir), manifestChange: err.pending });
      outJson({ ok: false, error: 'manifest_changed', message: err.message, ...err.pending, question });
    } else {
      if (err.question) outJson({ ok: false, question: err.question });
      process.stderr.write(`[grow-loop error] ${err.message || err}\n`);
    }
    process.exitCode = 1;
  }
}

main();

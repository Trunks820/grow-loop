import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildRedactor, defaultRedactor } from './redact.mjs';

export const DEFAULT_STATE_DIR_NAME = '.loop';

/**
 * Resolve state directory:
 * 1. Explicit --state-dir flag
 * 2. GROW_LOOP_STATE_DIR env var
 * 3. Default <repo>/.loop (colocated with repo/worktree for lossless cross-harness handoff)
 */
export function resolveStateDir(repoDir, explicitStateDir) {
  const baseRepo = path.resolve(repoDir || process.cwd());
  const raw = explicitStateDir || process.env.GROW_LOOP_STATE_DIR;
  if (raw) {
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseRepo, raw);
  }
  return path.join(baseRepo, DEFAULT_STATE_DIR_NAME);
}

export function getStatePaths(stateDir) {
  return {
    stateDir,
    configPath: path.join(stateDir, 'config.json'),
    manifestPath: path.join(stateDir, 'manifest.json'),
    manifestSnapshotPath: path.join(stateDir, 'manifest.snapshot.json'),
    statePath: path.join(stateDir, 'state.json'),
    eventsPath: path.join(stateDir, 'events.jsonl'),
    lessonsJsonPath: path.join(stateDir, 'lessons.json'),
    lessonsMdPath: path.join(stateDir, 'lessons.md'),
    techDebtJsonPath: path.join(stateDir, 'tech-debt.json'),
    techDebtMdPath: path.join(stateDir, 'tech-debt.md'),
    probeCachePath: path.join(stateDir, 'probe-cache.json'),
    runsDir: path.join(stateDir, 'runs'),
    artifactsDir: path.join(stateDir, 'artifacts'),
    evidenceMdPath: path.join(stateDir, 'evidence.md')
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Atomic JSON write (temp file + rename) to prevent partial state corruption
 * when an agent harness crashes or gets interrupted mid-turn.
 */
export function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function readJsonSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function validateManifest(manifest) {
  if (!Array.isArray(manifest?.packs)) {
    throw new Error('Manifest must be a JSON object with a packs array.');
  }
  const ids = new Set();
  for (const pack of manifest.packs) {
    if (typeof pack?.id !== 'string' || !pack.id.trim() || ids.has(pack.id)) {
      throw new Error('Each manifest pack must have a unique non-empty string id.');
    }
    ids.add(pack.id);
  }
}

/**
 * Check plan decisions on manifests entering the workspace. Stored snapshots skip this check
 * so an older entry cannot block the command that repairs it.
 */
export function validateDecisions(manifest) {
  for (const pack of manifest.packs) {
    if (pack.decisions === undefined) continue;
    const label = `Pack ${defaultRedactor.redactString(pack.id)} decisions`;
    if (!Array.isArray(pack.decisions)) throw new Error(`${label} must be an array.`);
    pack.decisions.forEach((entry, index) => {
      const item = `${label}[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${item} must be an object with question and decision.`);
      }
      if (typeof entry.question !== 'string' || !entry.question.trim()) {
        throw new Error(`${item}.question must be a non-empty string.`);
      }
      if (typeof entry.decision !== 'string' || !entry.decision.trim()) {
        const hint = Object.hasOwn(entry, 'answer') ? ' Rename answer to decision.' : '';
        throw new Error(`${item}.decision must be a non-empty string with the verbatim answer.${hint}`);
      }
      if (entry.at != null && typeof entry.at !== 'string') {
        throw new Error(`${item}.at must be a string or null.`);
      }
    });
  }
}

export function readManifest(filePath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('Manifest must contain valid JSON.');
    throw error;
  }
  validateManifest(manifest);
  return manifest;
}

export function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  return raw.map((line) => JSON.parse(line));
}

export function appendEvent(stateDir, config, event) {
  const { eventsPath } = getStatePaths(stateDir);
  ensureDir(stateDir);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const record = redactor.redactValue({
    ts: new Date().toISOString(),
    ...event
  });
  fs.appendFileSync(eventsPath, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * Ensure .loop/ is ignored in <repo>/.gitignore when stateDir resides inside <repo>.
 * Returns { updated: boolean, reason: string }.
 */
export function ensureGitignoreEntry(repoDir, stateDir) {
  const absRepo = path.resolve(repoDir);
  const absState = path.resolve(stateDir);
  const rel = path.relative(absRepo, absState).replace(/\\/g, '/');

  // External state directory (e.g., Obsidian vault): do not modify repo .gitignore
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { updated: false, reason: 'external_state_dir' };
  }

  const entry = `${rel.replace(/\/+$/, '')}/`;
  const gitignorePath = path.join(absRepo, '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ''))) {
      return { updated: false, reason: 'already_ignored', entry };
    }
  }

  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  const block = `${prefix}\n# grow-loop local state (auto-added)\n${entry}\n`;
  fs.writeFileSync(gitignorePath, content + block, 'utf8');
  return { updated: true, reason: 'added', entry, gitignorePath };
}

export function createInitialPackState(packDef) {
  return {
    id: packDef.id,
    title: packDef.title || packDef.id,
    status: 'PENDING',
    risk: packDef.risk || 'medium',
    initial_tier: null,
    current_tier: null,
    active_instance: null,
    escalated: false,
    escalation_reason: null,
    tier1_repairs: 0,
    tier2_repairs: 0,
    review_rounds: 0,
    infra_failures: 0,
    last_session_id: null,
    last_session_route: null,
    last_run_id: null,
    inflight_run: null,
    prepared_run: null,
    last_verify: null,
    last_review: null,
    pending_blocking_findings: [],
    resolved_gates: {},
    gate: null,
    blast_radius: null,
    commit: null,
    completed_externally: null,
    base_commit: null,
    base_branch: null,
    started_at: null,
    completed_at: null
  };
}

export function invalidateSession(pack) {
  pack.last_session_id = null;
  if (pack.inflight_run) pack.inflight_run.route_changed = true;
}

export function rememberSession(pack, sessionId, stage, instance) {
  pack.last_session_id = sessionId;
  pack.last_session_route = { id: sessionId, stage, instance };
}

export function createInitialState(repoDir, stateDir, profileName, manifest) {
  const packDefs = manifest.packs || [];
  const packs = Object.fromEntries(packDefs.map((pack) => [pack.id, createInitialPackState(pack)]));
  const packOrder = packDefs.map((pack) => pack.id);
  return {
    schema_version: '0.1',
    repo_dir: path.resolve(repoDir),
    state_dir: path.resolve(stateDir),
    profile: profileName,
    loop_status: packOrder.length > 0 ? 'RUNNING' : 'IDLE',
    active_pack_id: packOrder[0] || null,
    pack_order: packOrder,
    packs,
    todos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

/**
 * Sync the confirmed manifest while retaining historical pack records.
 */
export function syncManifestIntoState(state, manifest) {
  const order = [];
  for (const p of manifest.packs || []) {
    order.push(p.id);
    if (!Object.hasOwn(state.packs, p.id)) {
      Object.defineProperty(state.packs, p.id, {
        value: createInitialPackState(p), enumerable: true, writable: true, configurable: true
      });
    } else if (state.packs[p.id].status !== 'COMMITTED') {
      state.packs[p.id].title = p.title || state.packs[p.id].title;
      state.packs[p.id].risk = p.risk || state.packs[p.id].risk;
    }
  }
  state.pack_order = order;
  const firstUnfinished = order.find((id) => state.packs[id].status !== 'COMMITTED') || null;
  const restart = firstUnfinished && ['COMPLETED', 'IDLE'].includes(state.loop_status);
  if (restart || !order.includes(state.active_pack_id) || state.packs[state.active_pack_id].status === 'COMMITTED') {
    state.active_pack_id = firstUnfinished;
  }
  if (restart) state.loop_status = 'RUNNING';
  return state;
}

export function saveState(stateDir, state) {
  const { statePath } = getStatePaths(stateDir);
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
}

export function addScopeTodos(ctx, { packId, runId = null, texts, reason }) {
  if (!texts.length) return [];
  const { stateDir, config, state } = ctx;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const todos = state.todos ??= [];
  const added = [];
  for (const text of texts) {
    const todo = {
      id: `T${String(todos.length + 1).padStart(3, '0')}`,
      pack_id: packId,
      run_id: runId,
      content: redactor.redactString(text),
      status: 'open',
      created_at: new Date().toISOString()
    };
    todos.push(todo);
    added.push(todo);
  }
  saveState(stateDir, state);
  for (const todo of added) appendEvent(stateDir, config, { type: 'todo_added', ...todo, reason });
  return added;
}

function describeManifestChanges(previous, manifest, config) {
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const secretField = /^(?:api[_-]?key|app[_-]?secret|(?:(?:access|refresh|auth)[_-]?)?token|password|passwd|cookie|authorization|secret(?:[_-]?key)?)$/i;

  function redactField(field, value) {
    if (secretField.test(field)) return '[REDACTED:SECRET]';
    if (Array.isArray(value)) return value.map((item) => redactField('', item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        redactor.redactString(key), redactField(key, item)
      ]));
    }
    return redactor.redactValue(value);
  }

  function fieldChanges(before, after, excluded) {
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    fields.delete(excluded);
    return [...fields].filter((field) => !isDeepStrictEqual(before[field], after[field])).map((field) => ({
      field: redactor.redactString(field),
      old_value: Object.hasOwn(before, field) ? redactField(field, before[field]) : null,
      new_value: Object.hasOwn(after, field) ? redactField(field, after[field]) : null,
      ...(Object.hasOwn(before, field) ? {} : { old_missing: true }),
      ...(Object.hasOwn(after, field) ? {} : { new_missing: true })
    }));
  }

  const before = new Map(previous.packs.map((pack) => [pack.id, pack]));
  const after = new Map(manifest.packs.map((pack) => [pack.id, pack]));
  const oldOrder = [...before.keys()];
  const newOrder = [...after.keys()];
  const orderChanged = !isDeepStrictEqual(oldOrder.filter((id) => after.has(id)), newOrder.filter((id) => before.has(id)));
  const changedPacks = [];
  for (const [id, pack] of after) {
    if (!before.has(id)) continue;
    const fields = fieldChanges(before.get(id), pack, 'id');
    if (fields.length) changedPacks.push({ id: redactor.redactString(id), fields });
  }
  return {
    added_packs: newOrder.filter((id) => !before.has(id)).map(redactor.redactString),
    removed_packs: oldOrder.filter((id) => !after.has(id)).map(redactor.redactString),
    order_changed: orderChanged,
    ...(orderChanged ? {
      old_order: oldOrder.map(redactor.redactString),
      new_order: newOrder.map(redactor.redactString)
    } : {}),
    changed_packs: changedPacks,
    manifest_fields: fieldChanges(previous, manifest, 'packs')
  };
}

export class ManifestChangedError extends Error {
  constructor(pending) {
    super('Manifest changes are pending acknowledgment.');
    this.pending = pending;
  }
}

export function checkManifest(paths, manifest, config, { allowPendingManifest = false } = {}) {
  const snapshot = readManifest(paths.manifestSnapshotPath);
  const pending = snapshot && !isDeepStrictEqual(snapshot, manifest) ? {
    changes: describeManifestChanges(snapshot, manifest, config),
    ack_command: 'grow-loop manifest-ack --reason "<reason>"'
  } : null;
  if (pending && !allowPendingManifest) throw new ManifestChangedError(pending);
  return { snapshot, pending };
}

export function writeManifestWithReason(ctx, manifest, reason, source, details) {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('Specify a non-empty --reason.');
  }
  validateManifest(manifest);
  validateDecisions(manifest);

  const { paths, config, stateDir, state } = ctx;
  const current = readManifest(paths.manifestPath);
  if (!current) throw new Error('Workspace manifest is missing.');
  const alreadyWritten = isDeepStrictEqual(current, manifest);
  // A manual edit made after loading the workspace must stay pending.
  const { snapshot, pending } = checkManifest(paths, current, config, {
    allowPendingManifest: source === 'manifest_ack' && alreadyWritten
  });
  const previous = snapshot || current;
  const changed = !isDeepStrictEqual(previous, manifest);
  if (!changed && !details) return null;

  const changes = pending?.changes || describeManifestChanges(previous, manifest, config);
  if (!alreadyWritten) writeJsonAtomic(paths.manifestPath, manifest);
  appendEvent(stateDir, config, { type: 'manifest_changed', source, reason: reason.trim(), changes, ...(details && { details }) });
  syncManifestIntoState(state, manifest);
  saveState(stateDir, state);
  // A new snapshot marks the audited change as fully applied.
  if (changed) writeJsonAtomic(paths.manifestSnapshotPath, manifest);
  ctx.manifest = manifest;
  ctx.manifestChange = null;
  return changes;
}

export function loadWorkspace(repoDir, explicitStateDir, options) {
  const stateDir = resolveStateDir(repoDir, explicitStateDir);
  const paths = getStatePaths(stateDir);
  const config = readJsonSafe(paths.configPath);
  const manifest = readManifest(paths.manifestPath);
  const state = readJsonSafe(paths.statePath);
  if (!config || !manifest || !state) {
    throw new Error(
      `grow-loop state not initialized in "${stateDir}". Run "grow-loop init --profile <standard-test|live-smoke>" first.`
    );
  }
  const { snapshot, pending } = checkManifest(paths, manifest, config, options);
  if (!snapshot) writeJsonAtomic(paths.manifestSnapshotPath, manifest);
  syncManifestIntoState(state, snapshot || manifest);
  return { stateDir, paths, config, manifest, state, manifestChange: pending };
}

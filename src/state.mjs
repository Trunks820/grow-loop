import fs from 'node:fs';
import path from 'node:path';
import { buildRedactor } from './redact.mjs';

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
    statePath: path.join(stateDir, 'state.json'),
    eventsPath: path.join(stateDir, 'events.jsonl'),
    lessonsJsonPath: path.join(stateDir, 'lessons.json'),
    lessonsMdPath: path.join(stateDir, 'lessons.md'),
    techDebtMdPath: path.join(stateDir, 'tech-debt.md'),
    probeCachePath: path.join(stateDir, 'probe-cache.json'),
    runsDir: path.join(stateDir, 'runs'),
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
    last_run_id: null,
    last_verify: null,
    last_review: null,
    pending_blocking_findings: [],
    resolved_gates: {},
    gate: null,
    blast_radius: null,
    commit: null,
    started_at: null,
    completed_at: null
  };
}

export function createInitialState(repoDir, stateDir, profileName, manifest) {
  const packs = {};
  const packOrder = [];
  for (const p of manifest.packs || []) {
    packOrder.push(p.id);
    packs[p.id] = createInitialPackState(p);
  }
  return {
    schema_version: '0.1',
    repo_dir: path.resolve(repoDir),
    state_dir: path.resolve(stateDir),
    profile: profileName,
    loop_status: packOrder.length > 0 ? 'RUNNING' : 'IDLE',
    active_pack_id: packOrder[0] || null,
    pack_order: packOrder,
    packs,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

/**
 * Sync manifest additions into existing state without clobbering finished packs.
 */
export function syncManifestIntoState(state, manifest) {
  const order = [];
  for (const p of manifest.packs || []) {
    order.push(p.id);
    if (!state.packs[p.id]) {
      state.packs[p.id] = createInitialPackState(p);
    } else {
      state.packs[p.id].title = p.title || state.packs[p.id].title;
      state.packs[p.id].risk = p.risk || state.packs[p.id].risk;
    }
  }
  state.pack_order = order;
  if (!state.active_pack_id) {
    state.active_pack_id = order.find((id) => state.packs[id]?.status !== 'COMMITTED') || null;
  }
  return state;
}

export function saveState(stateDir, state) {
  const { statePath } = getStatePaths(stateDir);
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
}

export function loadWorkspace(repoDir, explicitStateDir) {
  const stateDir = resolveStateDir(repoDir, explicitStateDir);
  const paths = getStatePaths(stateDir);
  const config = readJsonSafe(paths.configPath);
  const manifest = readJsonSafe(paths.manifestPath);
  const state = readJsonSafe(paths.statePath);
  if (!config || !manifest || !state) {
    throw new Error(
      `grow-loop state not initialized in "${stateDir}". Run "grow-loop init --profile <standard-test|live-smoke>" first.`
    );
  }
  syncManifestIntoState(state, manifest);
  return { stateDir, paths, config, manifest, state };
}

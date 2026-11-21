import fs from 'node:fs';
import { appendEvent, getStatePaths, readJsonSafe, writeJsonAtomic, ensureDir } from './state.mjs';
import { buildRedactor } from './redact.mjs';

function readLessonStore(stateDir) {
  const { lessonsJsonPath } = getStatePaths(stateDir);
  return readJsonSafe(lessonsJsonPath, { next_id: 1, items: [] });
}

function normalizeLesson(item) {
  if (item.status !== 'OPEN' && item.status !== 'CLOSED') return item;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const hasRule = typeof item.rule === 'string' && Boolean(item.rule.trim());
  return {
    ...item,
    status: hasRule ? 'confirmed' : 'draft',
    scope: hasRule ? (tags.length ? 'tags' : 'global') : null,
    scope_tags: hasRule ? tags : []
  };
}

export function loadLessons(stateDir) {
  const store = readLessonStore(stateDir);
  return { ...store, items: store.items.map(normalizeLesson) };
}

function saveLessons(stateDir, store) {
  const { lessonsJsonPath, lessonsMdPath } = getStatePaths(stateDir);
  writeJsonAtomic(lessonsJsonPath, store);
  renderLessonsMarkdown(lessonsMdPath, store);
}

function lessonScope(scope, tags, rule) {
  if (scope !== undefined && scope !== 'global' && scope !== 'tags') {
    throw new Error('Specify --scope global or --scope tags.');
  }
  if (!rule || scope === undefined) return { scope: null, scope_tags: [] };
  if (scope === 'tags' && !tags.length) throw new Error('Tag scope requires --tags or existing lesson tags.');
  return { scope, scope_tags: scope === 'tags' ? tags : [] };
}

export function addLesson(stateDir, config, input) {
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const store = readLessonStore(stateDir);
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const rule = typeof input.rule === 'string' ? input.rule.trim() : '';
  const scope = lessonScope(input.scope, tags, rule);
  const num = store.next_id || (store.items.length + 1);
  const id = `L${String(num).padStart(3, '0')}`;
  const entry = redactor.redactValue({
    id,
    created_at: new Date().toISOString(),
    pack_id: input.pack_id || 'GLOBAL',
    stage: input.stage || 'VERIFY',
    severity: input.severity || 'HIGH',
    summary: input.summary || '',
    root_cause: input.root_cause || '',
    rule,
    locator: input.locator || '',
    tags,
    discovered_by: input.discovered_by || 'machine',
    fixed_by: input.fixed_by || null,
    repair_rounds: input.repair_rounds || 0,
    status: scope.scope ? 'confirmed' : 'draft',
    ...scope,
    verified_by: input.verified_by || null
  });

  store.items.push(entry);
  store.next_id = num + 1;
  saveLessons(stateDir, store);
  appendEvent(stateDir, config, {
    type: 'lesson_recorded', lesson_id: id, pack_id: entry.pack_id,
    stage: entry.stage, status: entry.status, scope: entry.scope, scope_tags: entry.scope_tags
  });
  return entry;
}

export function updateLesson(stateDir, config, id, change) {
  const store = readLessonStore(stateDir);
  const index = store.items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error('Lesson ID not found. Use grow-loop lesson list to find it.');
  const entry = { ...normalizeLesson(store.items[index]) };
  const previousStatus = entry.status;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  let details;

  if (change.status === 'confirmed') {
    details = redactor.redactValue({
      ...lessonScope(change.scope, change.tags ?? entry.tags ?? [], change.rule),
      rule: change.rule,
      root_cause: change.rootCause ?? entry.root_cause ?? ''
    });
    Object.assign(entry, details);
    delete entry.disabled_reason;
  } else {
    details = { reason: redactor.redactString(change.reason) };
    entry.disabled_reason = details.reason;
  }
  entry.status = change.status;
  store.items[index] = entry;
  saveLessons(stateDir, store);
  appendEvent(stateDir, config, {
    type: `lesson_${entry.status}`, lesson_id: id, pack_id: entry.pack_id, previous_status: previousStatus, ...details
  });
  return entry;
}

export function removeLesson(stateDir, id) {
  const store = readLessonStore(stateDir);
  store.items = store.items.filter((item) => item.id !== id);
  saveLessons(stateDir, store);
}

export function closeLessonsForPack(stateDir, config, packId, repairRounds, verifiedBy) {
  const store = readLessonStore(stateDir);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const closedAt = new Date().toISOString();
  const items = store.items.filter((item) => item.pack_id === packId);
  if (!items.length) return;
  for (const item of items) {
    item.repair_rounds = repairRounds;
    if (item.closed_at || item.status === 'CLOSED') continue;
    item.fixed_by ??= redactor.redactString(packId);
    if (verifiedBy) item.verified_by = redactor.redactString(verifiedBy);
    item.closed_at = closedAt;
  }
  saveLessons(stateDir, store);
}

export function selectLessonsForPack(stateDir, packDef, limit = 8) {
  const store = loadLessons(stateDir);
  const packTags = new Set((packDef.tags || []).map((t) => String(t).toLowerCase()));
  const priority = (item) => {
    if (item.pack_id === packDef.id) return 3;
    if (item.scope === 'tags' && item.scope_tags.some((tag) => packTags.has(String(tag).toLowerCase()))) return 2;
    return item.scope === 'global' ? 1 : 0;
  };

  return store.items
    .filter((item) => item.status === 'confirmed')
    .map((item) => ({ item, priority: priority(item) }))
    .filter((entry) => entry.priority > 0)
    .sort((a, b) => b.priority - a.priority || (b.item.created_at || '').localeCompare(a.item.created_at || '')
      || b.item.id.localeCompare(a.item.id, 'en', { numeric: true }))
    .slice(0, Math.max(0, Math.min(8, limit)))
    .map((entry) => entry.item);
}

export function formatLessonScope({ scope, scope_tags }) {
  return scope === 'tags' ? `tags (${scope_tags.join(', ')})` : scope || '';
}

export function renderLessonsMarkdown(lessonsMdPath, store) {
  ensureDir(lessonsMdPath.replace(/[\\/][^\\/]+$/, ''));
  const lines = [
    '# grow-loop Lessons Learned (错题本)',
    '',
    '> Auto-maintained by `grow-loop`. Confirmed rules are selected for task briefs by package and scope.',
    ''
  ];

  if (!store.items.length) {
    lines.push('_No lessons recorded yet._', '');
  } else {
    lines.push('| ID | Pack | Stage | Severity | Status | Scope | Feature Tags | Repair Rounds | Summary | Rule (Next Time) | Locator |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const raw of store.items) {
      const item = normalizeLesson(raw);
      const cells = [item.id, item.pack_id, item.stage, item.severity, item.status, formatLessonScope(item),
        Array.isArray(item.tags) ? item.tags.join(', ') : '', item.repair_rounds, item.summary, item.rule || item.root_cause, item.locator];
      const escaped = cells.map((value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
      lines.push(`| ${escaped.join(' | ')} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(lessonsMdPath, lines.join('\n'), 'utf8');
}

export function inRoundTechDebt(stateDir, packId) {
  const { techDebtJsonPath } = getStatePaths(stateDir);
  const store = readJsonSafe(techDebtJsonPath, { items: [] });
  return store.items.filter((item) => item.pack_id === packId && item.status === 'IN_ROUND')
    .map(({ finding }) => finding);
}

function renderTechDebtMarkdown(filePath, store) {
  const lines = ['# grow-loop Non-Blocking Tech Debt', ''];
  if (store.legacy_markdown) lines.push('## 旧记录', '', store.legacy_markdown, '');
  lines.push('## 审查记录', '');

  for (const item of store.items) {
    const { severity, title, locator, detail } = item.finding;
    const entry = `**[${severity}]** ${title}${locator ? ` (\`${locator}\`)` : ''}${detail ? `: ${detail}` : ''}`.replace(/[\r\n]+/g, ' ');
    const origin = `${item.pack_id} · Review Round ${item.review_round}`;
    if (item.status === 'FIXED') lines.push(`- ~~${entry}~~ — 已修（在 ${item.fixed_in_pack} 修掉） · ${origin}`);
    else lines.push(`- ${entry} — ${item.status === 'IN_ROUND' ? '本轮一起修' : '待办'} · ${origin}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

export function recordReviewTechDebt(stateDir, config, packId, reviewRound, findings, passed) {
  const { techDebtJsonPath, techDebtMdPath } = getStatePaths(stateDir);
  let store = readJsonSafe(techDebtJsonPath);
  if (!store) {
    if (!findings.length) return 0;
    const legacy = fs.existsSync(techDebtMdPath) ? fs.readFileSync(techDebtMdPath, 'utf8') : '';
    store = { legacy_markdown: legacy, items: [] };
  }

  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  // Include already written items from this round so a retry can reuse them.
  const previous = store.items.filter((item) => item.pack_id === packId &&
    (item.status === 'IN_ROUND' || item.last_reported_round === reviewRound));
  if (!previous.length && !findings.length) return 0;

  const status = passed ? 'PENDING' : 'IN_ROUND';
  const createdAt = new Date().toISOString();
  for (const raw of findings) {
    const finding = redactor.redactValue({ ...raw, title: raw.title || raw.summary || 'Unnamed item' });
    const index = previous.findIndex((item) => item.finding.title === finding.title);
    if (index === -1) {
      store.items.push({ pack_id: packId, review_round: reviewRound, last_reported_round: reviewRound, created_at: createdAt, status, finding });
    } else {
      const [item] = previous.splice(index, 1);
      Object.assign(item, { finding, status, last_reported_round: reviewRound });
      delete item.fixed_in_pack;
    }
  }
  if (passed) {
    for (const item of previous) {
      if (item.status !== 'IN_ROUND') continue;
      item.status = 'FIXED';
      item.fixed_in_pack = packId;
      item.last_reported_round = reviewRound;
    }
  }

  writeJsonAtomic(techDebtJsonPath, store);
  renderTechDebtMarkdown(techDebtMdPath, store);
  return findings.length;
}

export function deferInRoundTechDebt(stateDir, packId) {
  const { techDebtJsonPath, techDebtMdPath } = getStatePaths(stateDir);
  const store = readJsonSafe(techDebtJsonPath, { items: [] });
  const items = store.items.filter((item) => item.pack_id === packId && item.status === 'IN_ROUND');
  if (!items.length) return;
  for (const item of items) item.status = 'PENDING';
  writeJsonAtomic(techDebtJsonPath, store);
  renderTechDebtMarkdown(techDebtMdPath, store);
}

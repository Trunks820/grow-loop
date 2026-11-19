import fs from 'node:fs';
import { getStatePaths, readJsonSafe, writeJsonAtomic, ensureDir } from './state.mjs';
import { buildRedactor } from './redact.mjs';

/**
 * Structured lessons-learned store (错题本).
 * Captures every verify failure, review finding, and infra failure,
 * renders human-readable lessons.md, and auto-injects relevant lessons
 * into subsequent work-package task prompts ("grow").
 */

export function loadLessons(stateDir) {
  const { lessonsJsonPath } = getStatePaths(stateDir);
  return readJsonSafe(lessonsJsonPath, { next_id: 1, items: [] });
}

export function addLesson(stateDir, config, input) {
  const { lessonsJsonPath, lessonsMdPath } = getStatePaths(stateDir);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const store = loadLessons(stateDir);

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
    rule: input.rule || '',
    locator: input.locator || '',
    tags: Array.isArray(input.tags) ? input.tags : [],
    discovered_by: input.discovered_by || 'machine',
    fixed_by: input.fixed_by || null,
    repair_rounds: input.repair_rounds || 0,
    status: input.status || 'OPEN',
    verified_by: input.verified_by || null
  });

  store.items.push(entry);
  store.next_id = num + 1;
  writeJsonAtomic(lessonsJsonPath, store);
  renderLessonsMarkdown(lessonsMdPath, store);
  return entry;
}

export function closeLessonsForPack(stateDir, config, packId, fixedBy, verifiedBy) {
  const { lessonsJsonPath, lessonsMdPath } = getStatePaths(stateDir);
  const store = loadLessons(stateDir);
  let closedCount = 0;
  for (const item of store.items) {
    if (item.pack_id === packId && item.status === 'OPEN') {
      item.status = 'CLOSED';
      if (fixedBy && !item.fixed_by) item.fixed_by = fixedBy;
      if (verifiedBy) item.verified_by = verifiedBy;
      item.closed_at = new Date().toISOString();
      closedCount++;
    }
  }
  if (closedCount > 0) {
    writeJsonAtomic(lessonsJsonPath, store);
    renderLessonsMarkdown(lessonsMdPath, store);
  }
  return closedCount;
}

/**
 * Select high-signal lessons to inject into the next work package's task prompt.
 * Prioritizes:
 * 1. Open lessons on the same pack
 * 2. Lessons whose tags overlap pack tags/risk or are marked reusable rules
 * 3. Most recent HIGH/BLOCKER lessons (bounded to keep prompt focused)
 */
export function selectLessonsForPack(stateDir, packDef, limit = 8) {
  const store = loadLessons(stateDir);
  const packTags = new Set((packDef.tags || []).map((t) => String(t).toLowerCase()));

  const scored = store.items.map((item) => {
    let score = 0;
    if (item.pack_id === packDef.id && item.status === 'OPEN') score += 100;
    if (item.rule && item.rule.trim()) score += 20;
    if (item.severity === 'BLOCKER' || item.severity === 'HIGH') score += 15;
    for (const t of item.tags || []) {
      if (packTags.has(String(t).toLowerCase())) score += 25;
    }
    return { item, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.item.id.localeCompare(a.item.id))
    .slice(0, limit)
    .map((x) => x.item);
}

export function renderLessonsMarkdown(lessonsMdPath, store) {
  ensureDir(lessonsMdPath.replace(/[\\/][^\\/]+$/, ''));
  const lines = [
    '# grow-loop Lessons Learned (错题本)',
    '',
    '> Auto-maintained by `grow-loop`. High-signal rules are injected into subsequent work packages.',
    ''
  ];

  if (!store.items.length) {
    lines.push('_No lessons recorded yet._', '');
  } else {
    lines.push('| ID | Pack | Stage | Severity | Status | Summary | Rule (Next Time) | Locator |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const item of store.items) {
      const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(
        `| ${esc(item.id)} | ${esc(item.pack_id)} | ${esc(item.stage)} | ${esc(item.severity)} | ${esc(item.status)} | ${esc(item.summary)} | ${esc(item.rule || item.root_cause)} | ${esc(item.locator)} |`
      );
    }
    lines.push('');
  }
  fs.writeFileSync(lessonsMdPath, lines.join('\n'), 'utf8');
}

export function appendTechDebt(stateDir, config, packId, reviewRound, findings) {
  if (!findings || findings.length === 0) return 0;
  const { techDebtMdPath } = getStatePaths(stateDir);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const exists = fs.existsSync(techDebtMdPath);
  const chunks = [];
  if (!exists) {
    chunks.push('# grow-loop Non-Blocking Tech Debt (MEDIUM / LOW)\n');
    chunks.push('> Recorded automatically during closing reviews without blocking package completion.\n');
  }
  chunks.push(`\n## ${packId} · Review Round ${reviewRound} (${new Date().toISOString()})\n`);
  for (const f of findings) {
    const clean = redactor.redactValue(f);
    const loc = clean.locator ? ` (\`${clean.locator}\`)` : '';
    chunks.push(`- **[${clean.severity || 'LOW'}]** ${clean.title || clean.summary || 'Unnamed item'}${loc}${clean.detail ? `: ${clean.detail}` : ''}`);
  }
  chunks.push('');
  fs.appendFileSync(techDebtMdPath, chunks.join('\n'), 'utf8');
  return findings.length;
}

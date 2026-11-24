import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, getStatePaths } from './state.mjs';
import { formatLessonScope, inRoundTechDebt, selectLessonsForPack } from './lessons.mjs';
import { buildRedactor } from './redact.mjs';
import { getBudgets, getRepairRounds } from './router.mjs';
import { getVerificationPlan } from './verify.mjs';
import { namesCode, scanReferences } from './ref-scan.mjs';

const briefFields = {
  pitfalls: '避坑提示',
  co_change_files: '要一起改的文件',
  preserve_behaviors: '要保住的旧行为'
};

const globChars = /[*?\[\]{}]/;
const emptyReport = /^(?:无|没有|暂无)[。.!！]?$/;

function textItems(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function repoRelativePath(file, repoDir) {
  const slashes = file.replace(/\\/g, '/');
  const relative = repoDir && path.isAbsolute(slashes) ? path.relative(repoDir, slashes) : slashes;
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/'));
  return normalized === '..' || normalized.startsWith('../') || path.win32.isAbsolute(normalized) ? null : normalized;
}

export function isScopeDirectory(file, repoDir) {
  if (/[\\/]$/.test(file)) return true;
  if (!repoDir) return false;
  const relative = repoRelativePath(file, repoDir);
  if (!relative) return false;
  try {
    return fs.statSync(path.join(repoDir, relative), { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function verificationTestFiles(packDef, repoDir) {
  const files = new Set();
  for (const { command } of getVerificationPlan(undefined, packDef)) {
    // Keep quoted arguments together, including quotes after an option's '='.
    const args = command.match(/(?:[^\s"';&|<>()]+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const arg of args) {
      const file = arg.replace(/"([^"]*)"|'([^']*)'/g, '$1$2').replace(/^--[\w-]+=/, '').split('::', 1)[0];
      if (!file || file.startsWith('-') || file.includes('://') || globChars.test(file)) continue;
      const relative = repoRelativePath(file, repoDir);
      if (!relative) continue;
      const isTest = /(?:^|\/)(?:test|tests|__tests__)\/.+/.test(relative) ||
        /^(?:test_.+)|(?:_test|\.test|\.spec)\..+$/.test(path.posix.basename(relative));
      if (isTest && !isScopeDirectory(relative, repoDir)) files.add(relative);
    }
  }
  return files;
}

export function taskBriefWarnings(packDef, config, repoDir) {
  const warnings = [];
  for (const [field, heading] of Object.entries(briefFields)) {
    if (!textItems(packDef[field]).length) warnings.push(`「${heading}」未填写。`);
  }
  for (const [index, hint] of (Array.isArray(packDef.pitfalls) ? packDef.pitfalls : []).entries()) {
    if (typeof hint === 'string' && hint.trim() && !namesCode(hint)) {
      warnings.push(`第 ${index + 1} 条避坑提示未点名代码：${hint}`);
    }
  }
  const scope = new Set([...textItems(packDef.scope_files), ...textItems(packDef.co_change_files)].map((file) => file.trim()));
  for (const file of scope) {
    if (isScopeDirectory(file, repoDir)) warnings.push(`范围里的「${file}」是目录，请列出具体文件。`);
  }
  if (![...scope].some((file) => globChars.test(file))) {
    const scopedPaths = new Set([...scope].map((file) => repoRelativePath(file, repoDir)));
    for (const file of verificationTestFiles(packDef, repoDir)) {
      if (!scopedPaths.has(file)) {
        warnings.push(`验证命令点名的「${file}」不在本包范围，执行者改不了它；要改请用 pack scope 扩范围。`);
      }
    }
  }
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  return warnings.map(redactor.redactString);
}

function reportSection(markdown, matchesHeading) {
  let fence = null;
  let inSection = false;
  let section = null;
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(.+)$/;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const item = line.match(listItem)?.[1].trim();
    const atxHeading = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line);
    const setextHeading = !item && /^ {0,3}\S/.test(line) && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1] || '');
    if (atxHeading || setextHeading) {
      const heading = line.trim().replace(/^#{1,6}[ \t]+|[ \t]+#+$/g, '');
      inSection = matchesHeading(heading);
      if (inSection) section ??= [];
      if (!atxHeading) index++;
      continue;
    }
    if (inSection) section.push({ line, item });
  }
  return section;
}

export function parseOutOfScopeItems(markdown, { includeSection = false } = {}) {
  const section = reportSection(markdown, (heading) => heading.includes('超范围没改'));
  const items = [];
  for (const { item } of section ?? []) {
    const text = item?.replace(/^\[[ xX]\]\s*/, '').trim().replace(/^(\*{1,2}|_{1,2})(.+)\1$/, '$2').trim();
    if (text && !emptyReport.test(text)) items.push(item);
  }
  return includeSection ? { items, hasSection: section !== null } : items;
}

export function parseImplementBlockedReason(markdown) {
  const section = reportSection(markdown, (heading) => heading.includes('没做完') &&
    !emptyReport.test(heading.match(/没做完\s*[:：]\s*(.*)$/)?.[1] ?? ''));
  if (!section) return null;
  const reason = section.map(({ line }) => line).join('\n').trim();
  return emptyReport.test(reason) ? null : reason || '执行者没写原因';
}

function addBriefField(lines, packDef, field, guidance) {
  lines.push(`## ${briefFields[field]}`);
  if (guidance) lines.push(guidance, '');
  const items = textItems(packDef[field]);
  lines.push(...(items.length ? items.map((item) => `- ${item}`) : ['未填写。']), '');
}

function addVerbatim(lines, decision) {
  if (typeof decision !== 'string' || !decision.trim()) {
    lines.push('未记录原话。', '');
    return;
  }
  const longest = (decision.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 2);
  const fence = '`'.repeat(longest + 1);
  lines.push(`${fence}text`, decision, fence, '');
}

function addDecisions(lines, packDef, pack) {
  lines.push('## 已经定了的', '与本任务书其他描述冲突时，以这里的原话为准。', '');
  const approvals = Object.entries(pack.resolved_gates || {}).map(([gate_reason, approval]) => ({
    ...approval, gate_reason, action: 'approve', at: approval.approved_at
  }));
  const gateDecisions = [...approvals, ...(pack.decisions || [])];
  const questions = new Set([...textItems(packDef.open_questions), ...gateDecisions.flatMap((entry) => textItems(entry.questions))]);
  if (questions.size) {
    lines.push('本包提出的问题', ...[...questions].map((question) => `- ${question}`), '');
  }

  const decisions = Array.isArray(packDef.decisions) ? packDef.decisions.filter(Boolean) : [];
  for (const { question, decision, at } of decisions) {
    lines.push(`- 方案问题：${question || '未记录'}（时间：${at || '未记录'}）`, '');
    addVerbatim(lines, decision);
  }
  for (const { gate_reason, action, decision, at } of gateDecisions) {
    lines.push(`- 门禁 \`${gate_reason}\`（${action}，时间：${at || '未记录'}）`, '');
    addVerbatim(lines, decision);
  }
  if (!decisions.length && !gateDecisions.length) lines.push('暂无决定记录。', '');
}

function addArtifactDirectory(lines, stateDir, packId) {
  const artifactsDir = path.join(getStatePaths(stateDir).artifactsDir, packId);
  lines.push('## 产物放哪');
  lines.push(`报告、截图和草稿一律放到 \`${artifactsDir.replace(/\\/g, '/')}/\`。请勿把这些产物写到仓库的其他位置或加入 Git。`, '');
}

function addReviewFindings(lines, heading, findings, instruction) {
  if (!findings?.length) return;
  lines.push(`## ${heading}`);
  if (instruction) lines.push(instruction, '');
  for (const { severity, title, summary, locator, detail } of findings) {
    lines.push(`- **[${severity}]** ${title || summary}${locator ? ` (\`${locator}\`)` : ''}${detail ? `: ${detail}` : ''}`);
  }
  lines.push('');
}

/**
 * Build a bounded, self-contained UTF-8 task prompt for an executor or reviewer run.
 * Executors do NOT inherit the coordinator's chat history, so this injects only:
 * - Current work package scope & acceptance criteria
 * - Active verification / new-test policy
 * - Relevant high-signal lessons from earlier packages ("grow")
 * - Blocking findings to fix (in REPAIR mode) or Round-2 non-divergent closure scope (in REVIEW R2)
 */
export function buildTaskPrompt(ctx, { pack, packDef, stage, runDir }) {
  const { stateDir, config, state } = ctx;
  const budgets = getBudgets(config);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const lines = [];

  if (stage === 'review') {
    const nextRound = pack.review_rounds + 1;
    const isRound2Closure = nextRound >= 2 && budgets.round2NonDivergent;
    const blocking = [...budgets.blockingSeverities].map((severity) => `\`${severity}\``).join(' or ');
    lines.push(`# Closing Code Review (Round ${nextRound}/${budgets.maxReviewRounds}) · ${pack.id}: ${pack.title}`);
    lines.push('');
    lines.push('## Hard Constraints');
    lines.push('- **READ-ONLY MODE**: Do NOT edit any source files, do NOT commit/push/deploy, do NOT run destructive commands.');
    lines.push(blocking
      ? `- **Blocking Severities**: ${blocking} findings block package closure.`
      : '- **Blocking Severities**: None configured.');
    lines.push('- Findings outside the configured blocking severities go into `tech-debt.md`.');
    if (isRound2Closure) {
      const regressions = blocking ? ` and any new ${blocking} regressions introduced by the repair` : '';
      lines.push(`- **ROUND 2 NON-DIVERGENT CLOSURE RULE**: Verify ONLY the listed prior findings${regressions}.`);
    }
    lines.push('');
    lines.push('## Scope & Goal');
    lines.push(`- Package: \`${pack.id}\` — ${packDef.title || pack.id}`);
    if (packDef.goal) lines.push(`- Goal: ${packDef.goal}`);
    if (packDef.upstream_ref) lines.push(`- Upstream reference: ${packDef.upstream_ref}`);
    if (Array.isArray(packDef.scope_files) && packDef.scope_files.length) {
      lines.push(`- Authorized scope: ${packDef.scope_files.map((f) => `\`${f}\``).join(', ')}`);
    }
    lines.push('');

    addBriefField(lines, packDef, 'preserve_behaviors', isRound2Closure
      ? '在本轮收尾范围内逐条核对下列旧行为，报告修复新引入且达到本包阻断级别的回归。'
      : '逐条核对下列旧行为，未保住的按严重程度报告。');
    addDecisions(lines, packDef, pack);
    addArtifactDirectory(lines, stateDir, pack.id);

    addReviewFindings(lines, 'Prior Round Blocking Findings to Verify Closed', pack.pending_blocking_findings);
    if (nextRound >= 2) {
      addReviewFindings(lines, '顺手一起修（不阻断）', inRoundTechDebt(stateDir, pack.id),
        '只核对下列条目。仍未修好的按原 `title` 再报一次，已修好的省略。');
    }

    lines.push('## Required Output Format');
    lines.push('Output one standalone `VERDICT: PASS` or `VERDICT: FAIL` line, followed by exactly one fenced `json` block. The JSON `verdict` must agree with the line.');
    lines.push(blocking ? `Use \`FAIL\` if any finding is ${blocking}, and \`PASS\` otherwise.` : 'Use `PASS` for this configuration.');
    lines.push('Give every finding a non-empty `title` and a severity of `BLOCKER`, `HIGH`, `MEDIUM`, or `LOW`. Use `findings: []` when there are no findings.');
    lines.push('', 'VERDICT: PASS');
    lines.push('```json');
    const exampleSeverity = ['LOW', 'MEDIUM', 'HIGH', 'BLOCKER'].find((severity) => !budgets.blockingSeverities.has(severity));
    const exampleFindings = exampleSeverity
      ? [{ severity: exampleSeverity, title: '...', locator: 'File.ext#Class.method', detail: '...', rule: '...' }]
      : [];
    lines.push(`{ "verdict": "pass", "summary": "...", "findings": ${JSON.stringify(exampleFindings)} }`);
    lines.push('```');
  } else {
    const isRepair = getRepairRounds(pack) > 0;
    const repairs = pack.current_tier === 'tier2' ? pack.tier2_repairs : pack.tier1_repairs;
    const attempt = repairs > 0 ? ` attempt ${repairs}` : '';
    const modeLabel = isRepair ? `REPAIR (${pack.current_tier}${attempt})` : `INITIAL (${pack.current_tier})`;
    lines.push(`# Work Package ${pack.id} · ${modeLabel} — ${pack.title}`);
    lines.push('');
    lines.push('## Hard Constraints');
    lines.push('- Work strictly within the authorized repository and package scope below.');
    lines.push('- Do NOT `git commit`, `git push`, merge branches, deploy, send external messages, or modify global user CLI configs.');
    lines.push('- Do NOT echo credentials, tokens, passwords, or internal addresses.');

    const newTests = config?.verification?.new_tests || 'optional';
    if (newTests === 'forbidden') {
      lines.push('- **TEST POLICY (`forbidden`)**: Do NOT create new `*Test` / unit-test files. Preserve existing regression tests and rely on the configured live/smoke verification commands.');
    } else if (newTests === 'required') {
      lines.push('- **TEST POLICY (`required`)**: Add targeted automated tests covering the changed behavior and edge cases.');
    } else {
      lines.push('- **TEST POLICY (`optional`)**: Add tests only where they add concrete regression value without redundant boilerplate.');
    }
    lines.push('');

    lines.push('## Package Specification');
    if (packDef.goal) lines.push(`- **Goal**: ${packDef.goal}`);
    if (packDef.upstream_ref) lines.push(`- **Upstream Spec Anchor**: ${packDef.upstream_ref}`);
    if (Array.isArray(packDef.scope_files) && packDef.scope_files.length) {
      lines.push(`- **Allowed Scope**: ${packDef.scope_files.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (Array.isArray(packDef.acceptance_criteria) && packDef.acceptance_criteria.length) {
      lines.push('- **Acceptance Criteria**:');
      for (const ac of packDef.acceptance_criteria) {
        lines.push(`  - ${ac}`);
      }
    }
    lines.push('');

    for (const field of Object.keys(briefFields)) addBriefField(lines, packDef, field);
    addDecisions(lines, packDef, pack);

    lines.push('## 可能要一起改的文件', '', '### 可能要一起改，请确认', '授权范围以本包清单为准。');
    const references = scanReferences(state?.repo_dir || process.cwd(), stateDir, packDef);
    if (references.skipped) {
      lines.push(`没扫（${references.skipped}）。`);
    } else if (references.matches.size) {
      for (const [file, term] of references.matches) lines.push(`- \`${file}\`（命中 \`${term}\`）`);
    } else {
      lines.push('未找到范围外的引用文件。');
    }
    lines.push('');

    lines.push('## 转来的发现');
    if (packDef.forwarded_findings?.length) {
      for (const finding of packDef.forwarded_findings) {
        lines.push(`- 来源包 ${finding.from_pack_id}。原因：${finding.reason}`);
        lines.push(`  ${finding.content}`);
      }
    } else {
      lines.push('暂无。');
    }
    lines.push('');
    addArtifactDirectory(lines, stateDir, pack.id);

    if (isRepair) {
      addReviewFindings(lines, 'Blocking Findings to Fix', pack.pending_blocking_findings);
      addReviewFindings(lines, '顺手一起修（不阻断）', inRoundTechDebt(stateDir, pack.id));
    }

    if (isRepair && pack.last_verify && !pack.last_verify.passed) {
      lines.push('## Last Machine Verification Failure');
      const failure = pack.last_verify.failure;
      lines.push(`- Command: \`${failure?.command || pack.last_verify.command || 'configured verify'}\``);
      lines.push(`- Summary: ${pack.last_verify.summary}`);
      if (failure) {
        lines.push(`- Exit code: ${failure.exit_code}`);
        lines.push(`- Timed out: ${failure.timed_out ? 'yes' : 'no'}`);
        lines.push(`- stdout log: \`${failure.stdout_log}\``);
        lines.push(`- stderr log: \`${failure.stderr_log}\``);
        if (failure.test_names.length) {
          lines.push('', '### Failed Tests', ...failure.test_names.map((name) => `- ${name}`));
        }
        if (failure.assertion_lines.length) {
          lines.push('', '### Assertion Lines', ...failure.assertion_lines.map((line) => `    ${line}`));
        }
        if (failure.excerpt) {
          lines.push('', '### Output Excerpt', ...failure.excerpt.split('\n').map((line) => `    ${line}`));
        }
      }
      lines.push('');
    }

    const verificationPlan = getVerificationPlan(config, packDef);
    if (verificationPlan.length) {
      lines.push('## Verification Commands');
      for (const { command, source } of verificationPlan) {
        lines.push(`- \`${command}\` (${source})`);
      }
      lines.push('');
    }

    lines.push('## 最终回复的报告方式');
    lines.push('发现需要改动但超出授权范围时，不要动这些位置。在最终回复末尾加入标题 `## 超范围没改`，每项单独一行，格式为 `- 位置：说明`。没有这类发现时省略该节。');
    lines.push('', '因范围限制、信息不足或环境问题等原因无法完成目标时，请在最终回复末尾加入标题 `## 没做完`，如实写明原因和还差什么。完成目标时省略该节。');
  }

  const lessons = selectLessonsForPack(stateDir, packDef);
  if (lessons.length) {
    lines.push('', '## Injected Lessons from Prior Runs (Do Not Repeat)');
    for (const lesson of lessons) {
      lines.push(`- **${lesson.id}** (${lesson.pack_id}/${lesson.stage} · ${formatLessonScope(lesson)}): ${lesson.summary} → **Rule**: ${lesson.rule}`);
    }
  }

  ensureDir(runDir);
  const taskPath = path.join(runDir, 'task.md');
  const content = redactor.redactString(lines.join('\n') + '\n');
  fs.writeFileSync(taskPath, content, 'utf8');
  return taskPath;
}

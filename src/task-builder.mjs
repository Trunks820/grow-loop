import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, getStatePaths } from './state.mjs';
import { selectLessonsForPack } from './lessons.mjs';
import { buildRedactor } from './redact.mjs';
import { getBudgets } from './router.mjs';
import { getVerificationPlan } from './verify.mjs';
import { namesCode, scanReferences } from './ref-scan.mjs';

const briefFields = {
  pitfalls: '避坑提示',
  co_change_files: '要一起改的文件',
  preserve_behaviors: '要保住的旧行为'
};

function textItems(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

export function taskBriefWarnings(packDef, config) {
  const warnings = [];
  for (const [field, heading] of Object.entries(briefFields)) {
    if (!textItems(packDef[field]).length) warnings.push(`「${heading}」未填写。`);
  }
  for (const [index, hint] of (Array.isArray(packDef.pitfalls) ? packDef.pitfalls : []).entries()) {
    if (typeof hint === 'string' && hint.trim() && !namesCode(hint)) {
      warnings.push(`第 ${index + 1} 条避坑提示未点名代码：${hint}`);
    }
  }
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  return warnings.map(redactor.redactString);
}

export function parseOutOfScopeItems(markdown, { includeSection = false } = {}) {
  const items = [];
  let fence = null;
  let inSection = false;
  let hasSection = false;
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(.+)$/;
  for (const [index, line] of lines.entries()) {
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
      inSection = line.includes('超范围没改');
      hasSection ||= inSection;
      continue;
    }
    if (inSection) {
      const text = item?.replace(/^\[[ xX]\]\s*/, '').trim().replace(/^(\*{1,2}|_{1,2})(.+)\1$/, '$2').trim();
      if (text && !/^(?:无|没有|暂无)[。.!！]?$/.test(text)) items.push(item);
    }
  }
  return includeSection ? { items, hasSection } : items;
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
  const lessons = selectLessonsForPack(stateDir, packDef, 8);
  const lines = [];

  if (stage === 'review') {
    const nextRound = pack.review_rounds + 1;
    const isRound2Closure = nextRound >= 2 && budgets.round2NonDivergent;
    lines.push(`# Closing Code Review (Round ${nextRound}/${budgets.maxReviewRounds}) · ${pack.id}: ${pack.title}`);
    lines.push('');
    lines.push('## Hard Constraints');
    lines.push('- **READ-ONLY MODE**: Do NOT edit any source files, do NOT commit/push/deploy, do NOT run destructive commands.');
    lines.push(`- **Blocking Severities**: Only \`${[...budgets.blockingSeverities].join('`, `')}\` findings may block package closure.`);
    lines.push('- `MEDIUM` and `LOW` findings will be archived into `tech-debt.md` and will NOT block this package.');
    if (isRound2Closure) {
      lines.push('- **ROUND 2 NON-DIVERGENT CLOSURE RULE**: Verify ONLY whether Round 1 blocking findings are cleanly closed AND whether the repair introduced any NEW `BLOCKER` or `HIGH` regressions. Do NOT expand scope into unrelated legacy nitpicks.');
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
      ? '在本轮收尾范围内逐条核对下列旧行为，按严重程度报告修复新引入的 `BLOCKER` 或 `HIGH` 回归。'
      : '逐条核对下列旧行为，未保住的按严重程度报告。');
    addDecisions(lines, packDef, pack);
    addArtifactDirectory(lines, stateDir, pack.id);

    if (pack.pending_blocking_findings?.length) {
      lines.push('## Prior Round Blocking Findings to Verify Closed');
      for (const bf of pack.pending_blocking_findings) {
        lines.push(`- **[${bf.severity}]** ${bf.title || bf.summary}${bf.locator ? ` (\`${bf.locator}\`)` : ''}${bf.detail ? `: ${bf.detail}` : ''}`);
      }
      lines.push('');
    }

    lines.push('## Required Output Format');
    lines.push('Output a clear `VERDICT: PASS` or `VERDICT: FAIL`, followed by a JSON block matching:');
    lines.push('```json');
    lines.push('{ "verdict": "pass|fail", "summary": "...", "findings": [{ "severity": "BLOCKER|HIGH|MEDIUM|LOW", "title": "...", "locator": "File.ext#Class.method", "detail": "...", "rule": "..." }] }');
    lines.push('```');
  } else {
    const isRepair = pack.tier1_repairs > 0 || pack.tier2_repairs > 0;
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

    if (isRepair && pack.pending_blocking_findings?.length) {
      lines.push('## Blocking Findings to Fix');
      for (const bf of pack.pending_blocking_findings) {
        lines.push(`- **[${bf.severity}]** ${bf.title || bf.summary}${bf.locator ? ` (\`${bf.locator}\`)` : ''}${bf.detail ? `: ${bf.detail}` : ''}`);
      }
      lines.push('');
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

    if (lessons.length > 0) {
      lines.push('## Injected Lessons from Prior Runs (Do Not Repeat)');
      for (const l of lessons) {
        lines.push(`- **${l.id}** (${l.pack_id}/${l.stage}): ${l.summary}${l.rule ? ` → **Rule**: ${l.rule}` : ''}`);
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

    lines.push('## 超范围发现的报告方式');
    lines.push('发现需要改动但超出授权范围时，不要动这些位置。在最终回复末尾加入标题 `## 超范围没改`，每项单独一行，格式为 `- 位置：说明`。没有这类发现时省略该节。');
  }

  ensureDir(runDir);
  const taskPath = path.join(runDir, 'task.md');
  const content = redactor.redactString(lines.join('\n') + '\n');
  fs.writeFileSync(taskPath, content, 'utf8');
  return taskPath;
}

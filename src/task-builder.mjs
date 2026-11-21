import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './state.mjs';
import { selectLessonsForPack } from './lessons.mjs';
import { buildRedactor } from './redact.mjs';
import { getBudgets } from './router.mjs';

export function parseOutOfScopeItems(markdown) {
  const items = [];
  let fence = null;
  let inSection = false;
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      inSection = line.trim() === '## 超范围没改';
      continue;
    }
    if (inSection) {
      const item = line.match(/^ {0,3}-[ \t]+(.+)$/)?.[1].trim();
      if (item && /^[^：:]+[：:]\s*\S/.test(item)) items.push(item);
    }
  }
  return items;
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
  const { stateDir, config } = ctx;
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

    if (packDef.forwarded_findings?.length) {
      lines.push('## 转来的发现');
      for (const finding of packDef.forwarded_findings) {
        lines.push(`- 来源包 ${finding.from_pack_id}。原因：${finding.reason}`);
        lines.push(`  ${finding.content}`);
      }
      lines.push('');
    }

    if (isRepair && pack.pending_blocking_findings?.length) {
      lines.push('## Blocking Findings to Fix');
      for (const bf of pack.pending_blocking_findings) {
        lines.push(`- **[${bf.severity}]** ${bf.title || bf.summary}${bf.locator ? ` (\`${bf.locator}\`)` : ''}${bf.detail ? `: ${bf.detail}` : ''}`);
      }
      lines.push('');
    }

    if (isRepair && pack.last_verify && !pack.last_verify.passed) {
      lines.push('## Last Machine Verification Failure');
      lines.push(`- Command: \`${pack.last_verify.command || 'configured verify'}\``);
      lines.push(`- Summary: ${pack.last_verify.summary}`);
      lines.push('');
    }

    if (lessons.length > 0) {
      lines.push('## Injected Lessons from Prior Runs (Do Not Repeat)');
      for (const l of lessons) {
        lines.push(`- **${l.id}** (${l.pack_id}/${l.stage}): ${l.summary}${l.rule ? ` → **Rule**: ${l.rule}` : ''}`);
      }
      lines.push('');
    }

    if (Array.isArray(config?.verification?.commands) && config.verification.commands.length) {
      lines.push('## Verification Commands');
      for (const cmd of config.verification.commands) {
        lines.push(`- \`${cmd}\``);
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

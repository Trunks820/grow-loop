import fs from 'node:fs';
import path from 'node:path';
import { getStatePaths, readEvents, readJsonSafe } from './state.mjs';
import { loadLessons } from './lessons.mjs';
import { buildRedactor } from './redact.mjs';

function esc(val) {
  return String(val ?? '无记录').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function collectRunStats(runsDir, packId) {
  const packRunsDir = path.join(runsDir, packId);
  if (!fs.existsSync(packRunsDir)) return [];
  const entries = fs.readdirSync(packRunsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const out = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(packRunsDir, ent.name);
    const res = readJsonSafe(path.join(dir, 'result.json'));
    const dry = readJsonSafe(path.join(dir, 'dry-run.json'));
    out.push({
      run_id: ent.name,
      has_dry_run: Boolean(dry),
      result: res
    });
  }
  return out;
}

/**
 * Generate a sanitized two-layer delivery & retrospective evidence pack:
 * - Part 1: Human-Readable Executive Layer (one-page table + per-pack summary)
 * - Part 2: Six-Category Evidence Layer (lessons, verify/review, HITL gates,
 *           dispatch/escalation, machine verification, cost/tokens)
 */
export function generateEvidencePack(ctx, outputPath) {
  const { stateDir, config, manifest, state } = ctx;
  const paths = getStatePaths(stateDir);
  const events = readEvents(paths.eventsPath);
  const finalImplementations = new Map(events.filter(({ type }) => type === 'implement_completed')
    .map((event) => [event.pack_id, event]));
  const lessonsStore = loadLessons(stateDir);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);

  const lines = [];
  lines.push(`# ${manifest.project || 'Project'} 交付与复盘证据包 (\`grow-loop\`)`);
  lines.push('');
  lines.push(`> **生成时间**：${new Date().toISOString()}  `);
  lines.push(`> **循环状态**：\`${state.loop_status}\` · **Profile**：\`${state.profile}\`  `);
  lines.push('> **脱敏与事实口径**：本文档经 `grow-loop` 脱敏过滤器扫描，剔除密钥、令牌、密码与内网 IP；缺省数据一律标注「无记录」，不推测补填。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 第一部分：人读层（一页总表）');
  lines.push('');
  lines.push('| 包号 | 目标 | 最终执行者 | Commit | 文件数 / 增删行 | 返工轮次 (T1/T2) | 审查轮次 | 状态 |');
  lines.push('|---|---|---|---|---|---|---|---|');

  for (const id of state.pack_order) {
    const p = state.packs[id];
    const implementation = finalImplementations.get(id);
    const instance = implementation?.instance || p.active_instance || '未派发';
    const tool = implementation?.executor_tool || '无记录';
    const model = implementation?.executor_model || '无记录';
    const sha = p.commit?.sha ? `\`${p.commit.sha.slice(0, 9)}\`` : '未提交';
    const diffStat = p.commit ? `${p.commit.files} files (\`+${p.commit.insertions}/-${p.commit.deletions}\`)` : '无记录';
    const repairs = `${p.tier1_repairs} / ${p.tier2_repairs}${p.escalated ? ' (已升级T2)' : ''}`;
    lines.push(
      `| **${esc(p.id)}** | ${esc(p.title)} | ${esc(instance)} · ${esc(tool)} / ${esc(model)} | ${sha} | ${diffStat} | ${repairs} | ${p.review_rounds} | **${esc(p.status)}** |`
    );
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## 第二部分：证据层（六大类全量溯源）');
  lines.push('');

  // 1. Lessons lifecycle
  lines.push('### 1. 错题全生命周期');
  lines.push('');
  if (!lessonsStore.items.length) {
    lines.push('_本轮无新增错题记录。_');
  } else {
    lines.push('| 编号 | 包号 | 阶段 | 级别 | 状态 | 问题描述 | 修复方 | 规则沉淀 | 定位 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const item of lessonsStore.items) {
      lines.push(
        `| ${esc(item.id)} | ${esc(item.pack_id)} | ${esc(item.stage)} | ${esc(item.severity)} | ${esc(item.status)} | ${esc(item.summary)} | ${esc(item.fixed_by || '无记录')} | ${esc(item.rule || '无记录')} | ${esc(item.locator || '无记录')} |`
      );
    }
  }
  lines.push('');

  // 2. Closing review & tech debt
  lines.push('### 2. 关包审查与非阻塞技术债分流');
  lines.push('');
  const reviewEvents = events.filter((e) => e.type === 'review_recorded');
  if (!reviewEvents.length) {
    lines.push('_无独立审查事件记录（可能配置为 `review.mode = none` 或尚未到达审查阶段）。_');
  } else {
    lines.push('| 时间 | 包号 | 轮次 | 审查实例 | 结论 | 阻断项 (BLOCKER/HIGH) | 非阻断转债务 (M/L) | 摘要 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const e of reviewEvents) {
      lines.push(
        `| ${esc(e.ts)} | ${esc(e.pack_id)} | ${e.round}/${e.max_rounds} | \`${esc(e.reviewer)}\` | **${esc(e.verdict)}** | ${e.blocking_count} | ${e.non_blocking_count} | ${esc(e.summary)} |`
      );
    }
  }
  lines.push('');

  // 3. Human-in-the-loop gate records
  lines.push('### 3. 人工授权与停等打断记录');
  lines.push('');
  const gateEvents = events.filter((e) => e.type === 'gate_paused' || e.type === 'gate_resumed');
  const pauseCount = events.filter((e) => e.type === 'gate_paused').length;
  lines.push(`- **累计停等闸门触发次数**：**${pauseCount} 次**（来源：\`events.jsonl\` 精确计数）。`);
  lines.push('');
  if (gateEvents.length) {
    lines.push('| 时间 | 事件 | 包号 | 闸门原因 | 动作 / 决策摘要 |');
    lines.push('|---|---|---|---|---|');
    for (const e of gateEvents) {
      lines.push(
        `| ${esc(e.ts)} | ${esc(e.type)} | ${esc(e.pack_id)} | \`${esc(e.gate_reason)}\` | ${esc(e.decision || e.summary || e.action || '')} |`
      );
    }
  }
  lines.push('');

  // 4. Dispatch, probe, escalation & infra immunity
  lines.push('### 4. 派发、升级与基建故障免疫记录');
  lines.push('');
  const routingEvents = events.filter((e) =>
    ['preflight_evaluated', 'escalated_to_tier2', 'infra_failure', 'infra_fallback'].includes(e.type)
  );
  if (!routingEvents.length) {
    lines.push('_无派发或升级事件记录。_');
  } else {
    lines.push('| 时间 | 事件类型 | 包号 | 详情 |');
    lines.push('|---|---|---|---|');
    for (const e of routingEvents) {
      const detail =
        e.type === 'preflight_evaluated'
          ? `initial_tier=${e.initial_tier}, instance=${e.active_instance}, files=${e.blast_radius?.estimated_files ?? 0}`
          : e.type === 'escalated_to_tier2'
            ? `${e.from_instance} → ${e.to_instance} (${e.reason})`
            : `${e.error_class || e.trigger}: ${e.summary || `${e.from_instance} -> ${e.to_instance}`} (修复额度未扣减)`;
      lines.push(`| ${esc(e.ts)} | \`${esc(e.type)}\` | ${esc(e.pack_id)} | ${esc(detail)} |`);
    }
  }
  lines.push('');

  // 5. Machine verification results
  lines.push('### 5. 机器验证结果');
  lines.push('');
  lines.push(`- **单测新增策略**：\`${esc(config?.verification?.new_tests || 'optional')}\``);
  lines.push('');
  const verifyEvents = events.filter((e) => e.type === 'verify_recorded');
  if (!verifyEvents.length) {
    lines.push('_无机器验证事件记录。_');
  } else {
    lines.push('| 时间 | 包号 | 结果 | 来源 | 命令 | 摘要 |');
    lines.push('|---|---|---|---|---|---|');
    for (const e of verifyEvents) {
      const source = e.source === 'cli' ? 'CLI 实跑' : '自报';
      lines.push(`| ${esc(e.ts)} | ${esc(e.pack_id)} | ${e.passed ? 'PASS' : 'FAIL'} | ${source} | \`${esc(e.command || '无记录')}\` | ${esc(e.summary)} |`);
    }
  }
  lines.push('');

  // 6. Per-pack runs, duration & token usage
  lines.push('### 6. 每包轮次、耗时与 Token 消耗');
  lines.push('');
  lines.push('| 包号 | 运行次数 (含 Dry-Run) | 累计耗时 (秒) | Token 实录 | 金额成本 |');
  lines.push('|---|---|---|---|---|');
  for (const id of state.pack_order) {
    const runs = collectRunStats(paths.runsDir, id);
    let totalSec = 0;
    let hasSec = false;
    const usageParts = [];
    let dryCount = 0;
    for (const r of runs) {
      if (r.has_dry_run) dryCount += 1;
      if (r.result && typeof r.result.elapsed_seconds === 'number') {
        totalSec += r.result.elapsed_seconds;
        hasSec = true;
      }
      if (r.result && r.result.usage) {
        usageParts.push(`${r.run_id}: ${JSON.stringify(r.result.usage)}`);
      }
    }
    lines.push(
      `| **${esc(id)}** | ${runs.length} (dry-run: ${dryCount}) | ${hasSec ? totalSec.toFixed(2) : '无记录'} | ${esc(usageParts.length ? usageParts.join('; ') : '无记录')} | 无记录 |`
    );
  }
  lines.push('');

  const finalText = redactor.redactString(lines.join('\n'));
  const target = outputPath || paths.evidenceMdPath;
  fs.writeFileSync(target, finalText, 'utf8');
  return { path: target, bytes: Buffer.byteLength(finalText, 'utf8'), scanHits: redactor.scanString(finalText) };
}

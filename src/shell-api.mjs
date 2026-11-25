import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { handoffNeeds } from './handoff.mjs';
import { loadLessons } from './lessons.mjs';
import { buildRedactor } from './redact.mjs';
import { checkDependencies, getPackDef, resumeFromGate } from './router.mjs';
import { readJsonSafe, readManifest, syncManifestIntoState, writeManifestWithReason } from './state.mjs';

export const NEXT_COMMANDS = Object.freeze({
  next: 'grow-loop next',
  dispatch: 'grow-loop dispatch',
  dryRun: 'grow-loop dispatch --dry-run',
  verify: 'grow-loop verify',
  review: 'grow-loop dispatch --stage review',
  report: 'grow-loop record review --report <report.md>',
  commit: 'grow-loop record commit --from-git',
  manifestAck: 'grow-loop manifest-ack --reason "<原因>"'
});

const GATE_COPY = {
  AMBIGUITY: {
    title: '开工前需要你回答几个问题',
    body: '请逐项回答这些问题，执行者会按你的回答继续。',
    approve: ['按我的回答开工', '请填写每个问题的回答。']
  },
  EXTERNAL_EFFECT: {
    title: '需要你确认会影响外部的操作',
    body: '下面这些操作会影响工作区以外的系统或人员，请核对后决定是否授权。',
    approve: ['授权列出的操作并继续开工']
  },
  BLAST_RADIUS_SPLIT: {
    title: '这个包改动较多，需要你决定怎么做',
    body: '可以允许直接用高档执行，也可以先终止，再把这个包拆小。',
    approve: ['允许高档直接执行这个包']
  },
  BUDGET_EXCEEDED: {
    title: '本包可用的修复机会已用完',
    body: '请决定再给一次修复机会、允许进入本地提交阶段，还是终止。'
  },
  REVIEW_CAP_REACHED: {
    title: '审查轮次已到上限',
    body: '请核对验证和审查结果，决定继续修复、允许进入本地提交阶段，还是终止。'
  },
  INFRA_BLOCKED: {
    title: '执行工具遇到环境问题',
    body: '可以排除环境问题后用当前实例重试，也可以换一个执行实例。'
  },
  EXECUTOR_BLOCKED: {
    title: '执行者报告没做完',
    body: '请根据执行者的说明选择下一步。',
    continue: ['已扩范围或补好条件，让执行者接着写（不扣修复次数）', '请填写同意扩范围或确认条件已补齐的原话。'],
    retry: ['用当前实例从头重新执行'],
    approve: ['代码已写完，接受现有改动进入验证']
  },
  EXTERNAL_COMMIT: {
    title: '外部提交改到了需要保护的文件',
    body: '请核对以下提交和冲突文件。放行后会以当前 Git HEAD 为基线，从原来的阶段继续。',
    approve: ['接受这些外部提交并从原阶段继续', '请填写核对结果和放行理由。']
  },
  OUT_OF_SCOPE_CHANGE: {
    title: '发现本包范围外的改动',
    body: '请核对以下文件及其 Git 状态。处理后会从暂停前的阶段继续。',
    expand: ['把这些文件加进本包范围，继续', '请填写同意扩大范围的原话。'],
    revert: ['我已撤掉这些改动，继续'],
    ignore: ['这些不是本包改的，放行', '请填写确认这些改动不属于本包的原话。']
  },
  RELEASE: {
    title: '发布相关操作需要你批准',
    body: '推送、合并或部署需要你的授权。请选择是否记录批准并继续任务。',
    approve: ['记录发布批准并继续任务']
  }
};

const ACTION_LABELS = {
  approve: '确认并继续执行',
  abort: '先不做，终止整个流程',
  repair: '再给当前档一次修复机会',
  retry: '用当前实例重新执行',
  commit: '允许进入本地提交阶段'
};

const HANDOFF_FIELDS = {
  scope_files: '允许改动的文件列表（scope_files，至少填一项）',
  risk: '风险等级（risk，填写 low、medium 或 high）',
  tags: '功能标签（tags，至少填一项）'
};

function fingerprint(input) {
  const canonical = JSON.stringify(input, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function option(id, label, textHint = null) {
  return { id, label, needs_text: textHint !== null, text_hint: textHint };
}

function question(ctx, kind, identity, title, body, options) {
  const id = `q-${fingerprint([ctx.stateDir, kind, identity])}`;
  return {
    id, kind, title, body, options,
    answer_command: options.length ? `grow-loop answer --question ${id} --option <选项ID> [--text="<原话>"]` : null
  };
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function manifestQuestion(ctx) {
  const { changes } = ctx.manifestChange;
  const body = ['请核对手动修改的清单。确认后会更新包清单，并记下你填写的原因。'];
  if (changes.added_packs.length) body.push(`新增的包：${changes.added_packs.join('、')}`);
  if (changes.removed_packs.length) body.push(`移除的包：${changes.removed_packs.join('、')}`);
  if (changes.order_changed) body.push(`包顺序：${changes.old_order.join('、')} → ${changes.new_order.join('、')}`);
  for (const { id, fields } of changes.changed_packs) {
    body.push(`${id} 改动的字段：${fields.map(({ field }) => field).join('、')}`);
  }
  if (changes.manifest_fields.length) body.push(`清单改动的字段：${changes.manifest_fields.map(({ field }) => field).join('、')}`);
  const snapshotPath = ctx.paths.manifestSnapshotPath;
  const identity = [
    statSync(snapshotPath, { throwIfNoEntry: false })?.mtimeMs,
    readManifest(snapshotPath), ctx.manifest ?? readManifest(ctx.paths.manifestPath), changes
  ];
  return question(ctx, 'MANIFEST_CHANGED', identity, '确认手动改过的清单', body.join('\n'), [
    option('confirm', '确认这些改动', '请填写为什么改这份清单。')
  ]);
}

function switchOptionId(instance) {
  return `switch_instance:${fingerprint(instance)}`;
}

function gitStatusLabel(status) {
  if (status === '??') return '新增（未跟踪）';
  if (status.includes('U')) return '冲突';
  if (status.includes('D')) return '删除';
  if (status.includes('A')) return '新增';
  if (status.includes('M')) return '修改';
  return status;
}

function gateQuestion(ctx, pack) {
  const { gate } = pack;
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  const copy = GATE_COPY[gate.reason];
  const body = [`工作包 ${pack.id}。${copy.body}`];
  if (gate.reason === 'BLAST_RADIUS_SPLIT' && pack.blast_radius?.estimated_files != null) {
    body.push(`预计改动 ${pack.blast_radius.estimated_files} 个文件。`);
  }
  if (gate.reason === 'BUDGET_EXCEEDED') {
    body.push(`一档已修复 ${pack.tier1_repairs ?? 0} 次，二档已修复 ${pack.tier2_repairs ?? 0} 次。`);
  }
  if (gate.reason === 'REVIEW_CAP_REACHED') body.push(`已审查 ${pack.review_rounds ?? 0} 轮。`);
  if (gate.reason === 'EXECUTOR_BLOCKED') {
    body.push('', gate.summary);
    if (gate.allowed_resume_actions?.includes('continue')) {
      body.push('', '如果执行者因为范围外的文件停下，你同意改这些文件，请先用 grow-loop pack scope 扩范围，再选「接着写」。');
    }
  }
  if (gate.questions?.length) body.push(bullets(gate.questions));
  if (gate.reason === 'EXTERNAL_COMMIT') {
    body.push('外部提交', bullets((gate.external_commits ?? []).map(({ sha, files }) => `${sha}（${files.join('、')}）`)),
      '冲突文件', bullets(gate.conflicting_files ?? []));
  }
  if (gate.reason === 'OUT_OF_SCOPE_CHANGE') {
    body.push(bullets(gate.out_of_scope_files.map(({ path, status }) => `${path}（${gitStatusLabel(status)}）`)));
    if (gate.worktree_notice) {
      body.push(gate.worktree_notice);
      if (gate.allowed_resume_actions?.includes('ignore')) {
        body.push('这些文件里可能有开工前就改过的，不是本包改的请选「这些不是本包改的，放行」');
      }
    }
  }
  const options = (gate.allowed_resume_actions ?? []).flatMap((action) => {
    if (action === 'switch_instance') {
      return Object.keys(ctx.config?.executors ?? {}).filter((id) => id !== pack.active_instance)
        .map((id) => option(switchOptionId(id), `改用 ${redactor.redactString(id)} 并重新执行`));
    }
    if (Array.isArray(copy[action])) return [option(action, ...copy[action])];
    return Object.hasOwn(ACTION_LABELS, action) ? [option(action, ACTION_LABELS[action])] : [];
  });
  const choices = options.map(({ id, needs_text }) => [id, needs_text]);
  return question(ctx, gate.reason, [pack.id, gate, choices], copy.title, redactor.redactString(body.join('\n')), options);
}

export function buildQuestion(ctx, pack) {
  if (ctx.manifestChange) return manifestQuestion(ctx);
  if (!pack || ['ABORTED', 'COMPLETED'].includes(ctx.state.loop_status)) return null;
  if (pack.status === 'PAUSED_FOR_HUMAN' && pack.gate && Object.hasOwn(GATE_COPY, pack.gate.reason)) {
    return gateQuestion(ctx, pack);
  }
  const packDef = getPackDef(ctx.manifest, pack.id);
  if (pack.status !== 'PENDING' || !packDef) return null;
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  const packId = redactor.redactString(pack.id);
  const needs = handoffNeeds(packDef);
  if (needs.length) {
    return question(ctx, 'NEEDS_FILL', [pack.id, packDef, needs], '开工前请补齐清单字段',
      `请在工作区的 manifest.json 里找到 ${packId}，补齐以下字段。\n${bullets(needs.map((field) => HANDOFF_FIELDS[field]))}\n这些字段在清单里填写。补完后确认清单改动，再运行 grow-loop next。`, []);
  }
  const { missing } = checkDependencies(ctx.state, packDef);
  if (!missing.length) return null;
  return question(ctx, 'BLOCKED_DEPENDENCY', [pack.id, packDef, missing], '请先处理还没完成的前置包',
    `${packId} 要等以下包登记提交。请先完成这些包，或修改并确认清单里的依赖顺序，再运行 grow-loop next。\n${bullets(missing.map(redactor.redactString))}`, []);
}

export function dispatchStillRunning(run) {
  if (!run?.pid || run.kind === 'self') return false;
  try {
    process.kill(run.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function currentStop(ctx, pack, question) {
  const { loop_status: loopStatus } = ctx.state;
  if (question) {
    const isPackGate = pack?.status === 'PAUSED_FOR_HUMAN' && !ctx.manifestChange;
    return {
      phase: isPackGate ? 'PAUSE_FOR_HUMAN' : question.kind,
      waiting_for: 'human',
      reason: question.kind,
      next_command: question.answer_command ?? (question.kind === 'NEEDS_FILL' ? NEXT_COMMANDS.manifestAck : NEXT_COMMANDS.next)
    };
  }
  if (['COMPLETED', 'ABORTED'].includes(loopStatus)) {
    return { phase: loopStatus, waiting_for: 'none', reason: null, next_command: null };
  }
  if (!pack) {
    return { phase: loopStatus, waiting_for: 'coordinator', reason: null, next_command: NEXT_COMMANDS.next };
  }
  const phase = pack.status === 'READY_TO_COMMIT' ? 'COMMIT' : pack.status;
  const run = pack.inflight_run;
  if (dispatchStillRunning(run)) {
    return { phase, waiting_for: 'executor', reason: 'DISPATCH_RUNNING', next_command: null };
  }
  if (run?.kind === 'self' && !run.route_changed) {
    const command = run.stage === 'review' ? NEXT_COMMANDS.report : 'grow-loop record implement --passed';
    return { phase, waiting_for: 'coordinator', reason: 'SELF_RUN_PENDING', next_command: command };
  }
  const commands = {
    IMPLEMENT: pack.prepared_run?.stage === 'implement' ? NEXT_COMMANDS.dispatch : NEXT_COMMANDS.dryRun,
    VERIFY: NEXT_COMMANDS.verify,
    REVIEW: NEXT_COMMANDS.review,
    COMMIT: NEXT_COMMANDS.commit
  };
  return { phase, waiting_for: 'coordinator', reason: null, next_command: commands[phase] ?? NEXT_COMMANDS.next };
}

export function buildShellStatus(ctx) {
  const { state, stateDir, config, manifest, paths } = ctx;
  const activeId = state.active_pack_id ?? state.pack_order.find((id) => state.packs[id]?.status !== 'COMMITTED') ?? null;
  const activePack = state.packs[activeId];
  const question = buildQuestion(ctx, activePack);
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const packDefs = new Map(manifest.packs.map((pack) => [pack.id, pack]));
  const packs = state.pack_order.map((id) => {
    const pack = state.packs[id];
    const run = pack.inflight_run;
    return {
      id: redactor.redactString(pack.id),
      title: redactor.redactString(pack.title ?? pack.id),
      status: pack.status,
      tier: pack.current_tier ?? null,
      instance: redactor.redactString(pack.active_instance ?? null),
      tier1_repairs: pack.tier1_repairs ?? 0,
      tier2_repairs: pack.tier2_repairs ?? 0,
      review_rounds: pack.review_rounds ?? 0,
      needs: handoffNeeds(packDefs.get(id)),
      inflight_run: run ? { stage: run.stage ?? null, started_at: run.started_at ?? null } : null,
      commit: pack.commit?.sha ?? null,
      completed_externally: pack.completed_externally ?? null,
      gate: pack.gate?.reason ?? null
    };
  });
  return {
    schema: 'grow-loop.status/1',
    loop_status: state.loop_status,
    active_pack_id: redactor.redactString(state.active_pack_id ?? null),
    now: { pack_id: redactor.redactString(activeId), ...currentStop(ctx, activePack, question) },
    packs,
    pending: {
      manifest_change: ctx.manifestChange ?? null,
      lesson_drafts: loadLessons(stateDir).items.filter(({ status }) => status === 'draft').length,
      open_todos: (state.todos ?? []).filter(({ status }) => status === 'open').length,
      in_round_tech_debt: readJsonSafe(paths.techDebtJsonPath, { items: [] }).items.filter(({ status }) => status === 'IN_ROUND').length
    },
    question
  };
}

export function acknowledgeManifest(ctx, reason, details) {
  const changes = writeManifestWithReason(ctx, ctx.manifest, reason, 'manifest_ack', details);
  return changes
    ? { ok: true, message: 'Manifest changes acknowledged.', changes }
    : { ok: true, message: 'No manifest changes.' };
}

export function answerQuestion(ctx, { id, optionId, text }) {
  const { state } = ctx;
  let pack = state.packs[state.active_pack_id];
  let current = buildQuestion(ctx, pack);
  // The commands with --pack can also return a question for a non-active pack.
  if (current?.id !== id && !ctx.manifestChange) {
    pack = state.pack_order.map((packId) => state.packs[packId]).find((candidate) =>
      candidate.status === 'PAUSED_FOR_HUMAN' && buildQuestion(ctx, candidate)?.id === id);
    current = buildQuestion(ctx, pack);
  }
  if (!current || current.id !== id) {
    throw new Error('这个问题已经变化或处理完毕。请重新运行 grow-loop status --format shell。');
  }
  if (!current.options.length) throw new Error(current.body);
  const selected = current.options.find((option) => option.id === optionId);
  if (!selected) throw new Error('这个问题没有该选项。请使用 question.options 里列出的选项。');
  if ((text !== undefined && typeof text !== 'string') || (selected.needs_text && !text?.trim())) {
    throw new Error('这个选项需要填写非空的 --text。');
  }
  if (current.kind === 'MANIFEST_CHANGED') {
    syncManifestIntoState(state, ctx.manifest);
    const active = state.packs[state.active_pack_id];
    if (active) {
      const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
      (active.decisions ??= []).push({
        gate_reason: current.kind, action: optionId, decision: redactor.redactString(text), at: new Date().toISOString()
      });
    }
    return acknowledgeManifest(ctx, text, { question_id: id, answer_text: text });
  }
  const instance = Object.keys(ctx.config?.executors ?? {}).find((id) => switchOptionId(id) === optionId);
  return resumeFromGate(ctx, { packId: pack.id, action: instance ? 'switch_instance' : optionId, decision: text, instance });
}

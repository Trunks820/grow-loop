import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appendEvent, expandPackScope, invalidateSession, readJsonSafe, readVerificationBaseline, rememberSession, saveState, writeJsonAtomic, writeManifestWithReason } from './state.mjs';
import { buildRedactor } from './redact.mjs';
import { handoffFillSteps, handoffNeeds } from './handoff.mjs';
import { taskBriefWarnings } from './task-builder.mjs';
import { getVerificationCommands } from './verify.mjs';
import { ALLOWED_GATE_REASONS, createGate } from './gate.mjs';
import { addLesson, closeLessonsForPack, deferInRoundTechDebt, recordReviewTechDebt, removeLesson, selectLessonsForPack } from './lessons.mjs';
import { getBlockingReviewSeverities } from './review-report.mjs';
import { checkExternalCommits, readCommitFiles, readGitPosition, readWorktreeSnapshot, scanCommitScope, scanOutOfScopeChanges } from './git-watch.mjs';
import { EXECUTABLE_NOT_FOUND, writeRunResult } from './adapters/base.mjs';
import { buildQuestion, dispatchStillRunning, NEXT_COMMANDS } from './shell-api.mjs';

const PREFLIGHT_GATE_REASONS = new Set([
  ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT,
  ALLOWED_GATE_REASONS.AMBIGUITY,
  ALLOWED_GATE_REASONS.EXTERNAL_EFFECT
]);

export function getBudgets(config) {
  return {
    tier1MaxRepairs: config?.budgets?.tier1_max_repairs ?? 2,
    tier2MaxRepairs: config?.budgets?.tier2_max_repairs ?? 2,
    maxReviewRounds: config?.review?.max_rounds ?? 2,
    reviewMode: config?.review?.mode ?? 'closing-full',
    blockingSeverities: getBlockingReviewSeverities(config),
    round2NonDivergent: config?.review?.round2_non_divergent ?? true,
    blastRadius: {
      escalateTier2Files: config?.blast_radius?.escalate_tier2_files ?? 25,
      escalateTier2CrossModule: config?.blast_radius?.escalate_tier2_cross_module ?? true,
      pauseSplitFiles: config?.blast_radius?.pause_split_files ?? 50
    }
  };
}

export function resolveTierInstance(config, tier, pack) {
  const routing = config?.routing || {};
  if (tier === 'reviewer') {
    return pack?.review_instance || routing.reviewer || routing.tier2 || routing.tier1 || 'self';
  }
  if (tier === 'tier2') {
    return routing.tier2 || routing.tier1 || 'self';
  }
  return routing.tier1 || 'self';
}

export function getPackDef(manifest, packId) {
  return (manifest.packs || []).find((p) => p.id === packId) || null;
}

export function requireHandoffPreflight(pack, packDef, ctx) {
  if (packDef?.handoff && (pack.status === 'PENDING' || PREFLIGHT_GATE_REASONS.has(pack.gate?.reason))) {
    const error = new Error('Run "grow-loop next" and follow its directive to finish handoff preflight.');
    if (ctx) error.question = buildQuestion(ctx, pack);
    throw error;
  }
}

export function evaluateBlastRadius(config, packDef, packState = null) {
  const { blastRadius } = getBudgets(config);
  const estimatedFiles = Math.max(
    Number(packDef.estimated_files || 0),
    Array.isArray(packDef.scope_files) ? packDef.scope_files.length : 0
  );
  const crossModule = Boolean(packDef.cross_module);
  const risk = String(packDef.risk || 'medium').toLowerCase();
  const resolvedGates = packState?.resolved_gates || {};

  const shouldPauseSplit =
    !packDef.blast_radius_approved &&
    !resolvedGates[ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT] &&
    estimatedFiles >= blastRadius.pauseSplitFiles;
  const shouldStartTier2 =
    risk === 'high' ||
    estimatedFiles >= blastRadius.escalateTier2Files ||
    (blastRadius.escalateTier2CrossModule && crossModule);

  const reasons = [];
  const manualTier = ['tier1', 'tier2'].includes(packDef.tier) ? packDef.tier : null;
  if (manualTier) reasons.push(`manual tier=${manualTier}`);
  if (risk === 'high') reasons.push('risk=high');
  if (estimatedFiles >= blastRadius.escalateTier2Files) {
    reasons.push(`estimated_files=${estimatedFiles} >= ${blastRadius.escalateTier2Files}`);
  }
  if (blastRadius.escalateTier2CrossModule && crossModule) {
    reasons.push('cross_module=true');
  }

  return {
    estimated_files: estimatedFiles,
    cross_module: crossModule,
    risk,
    should_pause_split: shouldPauseSplit,
    initial_tier: manualTier || (shouldStartTier2 ? 'tier2' : 'tier1'),
    reasons
  };
}

export function checkDependencies(state, packDef) {
  const missing = [];
  for (const depId of packDef.depends_on || []) {
    const dep = state.packs[depId];
    if (!dep || dep.status !== 'COMMITTED') {
      missing.push(depId);
    }
  }
  return { satisfied: missing.length === 0, missing };
}

/**
 * Advance a PENDING pack through PREFLIGHT -> GATE_CHECK -> IMPLEMENT (or PAUSED_FOR_HUMAN).
 */
export function startOrAdvanceActivePack(ctx) {
  const { stateDir, config, manifest, state } = ctx;
  if (state.loop_status === 'ABORTED') return { action: 'ABORTED' };
  const activeId = state.active_pack_id || state.pack_order.find((id) => state.packs[id]?.status !== 'COMMITTED');
  if (!activeId) {
    state.loop_status = 'COMPLETED';
    state.active_pack_id = null;
    saveState(stateDir, state);
    return { action: 'COMPLETED', message: 'All work packages are committed. Run "grow-loop evidence" to generate the evidence pack.' };
  }

  state.active_pack_id = activeId;
  const pack = state.packs[activeId];
  let packDef = getPackDef(manifest, activeId);
  if (!packDef) {
    throw new Error(`Active pack "${activeId}" missing from manifest.json`);
  }

  if (pack.status === 'PENDING') {
    const needs = handoffNeeds(packDef);
    if (needs.length) {
      return {
        action: 'NEEDS_FILL',
        pack_id: activeId,
        needs,
        next_steps: [...handoffFillSteps(needs), `Run: ${NEXT_COMMANDS.next}`],
        question: buildQuestion(ctx, pack),
        warnings: taskBriefWarnings(packDef, config, state.repo_dir)
      };
    }
    if (packDef.handoff?.needs?.length) {
      packDef = { ...packDef, handoff: { ...packDef.handoff, needs: [] } };
      const packs = manifest.packs.map((entry) => entry.id === activeId ? packDef : entry);
      writeManifestWithReason(ctx, { ...manifest, packs }, 'Required handoff fields are complete.', 'handoff_filled');
    }

    const deps = checkDependencies(state, packDef);
    if (!deps.satisfied) {
      return {
        action: 'BLOCKED_DEPENDENCY',
        pack_id: activeId,
        missing_dependencies: deps.missing,
        question: buildQuestion(ctx, pack),
        warnings: taskBriefWarnings(packDef, config, state.repo_dir),
        message: `Pack ${activeId} waiting on uncommitted dependencies: ${deps.missing.join(', ')}`
      };
    }

    if (!pack.started_at) {
      pack.started_at = new Date().toISOString();
      const position = readGitPosition(state.repo_dir);
      pack.base_commit = position?.head ?? null;
      pack.base_branch = position?.branch ?? null;
      pack.start_worktree = readWorktreeSnapshot(state.repo_dir);
    }
    pack.resolved_gates = pack.resolved_gates || {};
    const br = evaluateBlastRadius(config, packDef, pack);
    pack.blast_radius = br;
    pack.initial_tier = br.initial_tier;
    pack.current_tier = br.initial_tier;
    pack.active_instance = resolveTierInstance(config, br.initial_tier);

    appendEvent(stateDir, config, {
      type: 'preflight_evaluated',
      pack_id: activeId,
      blast_radius: br,
      initial_tier: pack.initial_tier,
      active_instance: pack.active_instance
    });

    if (br.should_pause_split) {
      pack.status = 'PAUSED_FOR_HUMAN';
      pack.gate = createGate(
        ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT,
        `Pack ${activeId} has estimated_files=${br.estimated_files} (threshold ${getBudgets(config).blastRadius.pauseSplitFiles}). Split into smaller packs or approve running directly on tier2.`,
        {
          recommended_action: 'split_or_approve_tier2',
          allowed_resume_actions: ['approve', 'abort']
        }
      );
      appendEvent(stateDir, config, {
        type: 'gate_paused',
        pack_id: activeId,
        gate_reason: ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT,
        summary: pack.gate.summary
      });
      saveState(stateDir, state);
      return buildNextDirective(ctx, pack, packDef);
    }

    // Check open ambiguity / external effects gates before dispatching
    if (
      Array.isArray(packDef.open_questions) &&
      packDef.open_questions.length > 0 &&
      !packDef.ambiguity_resolved &&
      !pack.resolved_gates[ALLOWED_GATE_REASONS.AMBIGUITY]
    ) {
      pack.status = 'PAUSED_FOR_HUMAN';
      pack.gate = createGate(
        ALLOWED_GATE_REASONS.AMBIGUITY,
        `Pack ${activeId} has unresolved requirement questions before implementation.`,
        {
          questions: packDef.open_questions,
          recommended_action: 'answer_and_resume',
          allowed_resume_actions: ['approve', 'abort']
        }
      );
      appendEvent(stateDir, config, {
        type: 'gate_paused',
        pack_id: activeId,
        gate_reason: ALLOWED_GATE_REASONS.AMBIGUITY,
        questions: packDef.open_questions
      });
      saveState(stateDir, state);
      return buildNextDirective(ctx, pack, packDef);
    }

    if (
      Array.isArray(packDef.external_effects) &&
      packDef.external_effects.length > 0 &&
      !packDef.external_effects_approved &&
      !pack.resolved_gates[ALLOWED_GATE_REASONS.EXTERNAL_EFFECT]
    ) {
      pack.status = 'PAUSED_FOR_HUMAN';
      pack.gate = createGate(
        ALLOWED_GATE_REASONS.EXTERNAL_EFFECT,
        `Pack ${activeId} declares external side effects requiring explicit authorization: ${packDef.external_effects.join(', ')}`,
        {
          questions: packDef.external_effects,
          recommended_action: 'confirm_scope_and_resume',
          allowed_resume_actions: ['approve', 'abort']
        }
      );
      appendEvent(stateDir, config, {
        type: 'gate_paused',
        pack_id: activeId,
        gate_reason: ALLOWED_GATE_REASONS.EXTERNAL_EFFECT,
        external_effects: packDef.external_effects
      });
      saveState(stateDir, state);
      return buildNextDirective(ctx, pack, packDef);
    }

    pack.status = 'IMPLEMENT';
    saveState(stateDir, state);
  }

  return buildNextDirective(ctx, pack, packDef);
}

export function buildNextDirective(ctx, pack, packDef) {
  const { stateDir, config } = ctx;
  const budgets = getBudgets(config);
  const packInfo = {
    pack_id: pack.id,
    title: pack.title,
    warnings: taskBriefWarnings(packDef, config, ctx.state.repo_dir)
  };
  const injectedLessons = () => selectLessonsForPack(stateDir, packDef)
    .map(({ id, summary, rule, scope, scope_tags }) => ({ id, summary, rule, scope, scope_tags }));

  if (pack.status === 'PAUSED_FOR_HUMAN') {
    const gate = pack.gate?.reason === ALLOWED_GATE_REASONS.OUT_OF_SCOPE_CHANGE
      ? buildRedactor(config?.redaction?.extra_patterns || []).redactValue(pack.gate) : pack.gate;
    return {
      action: 'PAUSE_FOR_HUMAN',
      ...packInfo,
      gate,
      resume_hint: `grow-loop resume --decision "<your decision>" --action <${(pack.gate?.allowed_resume_actions || ['approve']).join('|')}>`,
      question: buildQuestion(ctx, pack)
    };
  }

  if (pack.status === 'IMPLEMENT') {
    const isRepair = getRepairRounds(pack) > 0;
    return {
      action: 'IMPLEMENT',
      mode: isRepair ? 'REPAIR' : 'INITIAL',
      ...packInfo,
      tier: pack.current_tier,
      instance: pack.active_instance,
      repair_budget: {
        tier1_used: pack.tier1_repairs,
        tier1_max: budgets.tier1MaxRepairs,
        tier2_used: pack.tier2_repairs,
        tier2_max: budgets.tier2MaxRepairs
      },
      new_tests_policy: config?.verification?.new_tests || 'optional',
      injected_lessons: injectedLessons(),
      pending_blocking_findings: pack.pending_blocking_findings || [],
      next_command: `${NEXT_COMMANDS.dryRun} (then ${NEXT_COMMANDS.dispatch})`
    };
  }

  if (pack.status === 'VERIFY') {
    const { new_tests, timeout_sec, output_encoding, retry_once, baseline } = config?.verification ?? {};
    const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
    return {
      action: 'VERIFY',
      ...packInfo,
      verification: redactor.redactValue({
        commands: getVerificationCommands(config, packDef),
        new_tests, timeout_sec, output_encoding, retry_once
      }),
      next_command: `${NEXT_COMMANDS.verify} (runs global and pack commands${baseline ? ' and checks the full suite for new failures' : ''} and records exit codes); use "grow-loop record verify --failed ..." only for failures found outside those commands`
    };
  }

  if (pack.status === 'REVIEW') {
    const nextRound = pack.review_rounds + 1;
    const reviewerInstance = resolveTierInstance(config, 'reviewer', pack);
    return {
      action: 'REVIEW',
      ...packInfo,
      review_round: nextRound,
      max_review_rounds: budgets.maxReviewRounds,
      non_divergent_closure_only: nextRound >= 2 && budgets.round2NonDivergent,
      blocking_severities: [...budgets.blockingSeverities],
      injected_lessons: injectedLessons(),
      reviewer_instance: reviewerInstance,
      read_only: true,
      previous_blocking_findings: pack.pending_blocking_findings || [],
      next_command: `${NEXT_COMMANDS.review} (self: ${NEXT_COMMANDS.report})`
    };
  }

  if (pack.status === 'READY_TO_COMMIT') {
    const gitWatch = checkExternalCommits(ctx, pack, packDef);
    if (gitWatch?.status === 'blocked') return buildNextDirective(ctx, pack, packDef);
    const scan = scanOutOfScopeChanges(ctx, pack, packDef);
    if (scan.files?.length) {
      pauseForOutOfScopeChange(ctx, pack, 'READY_TO_COMMIT', scan);
      return { ...buildNextDirective(ctx, pack, packDef), ...scan.notices, ...(gitWatch && { git_watch: gitWatch }) };
    }
    return {
      action: 'COMMIT',
      ...packInfo,
      stray_files: [],
      ...scan.notices,
      ...(gitWatch && { git_watch: gitWatch }),
      approval_note: 'Local commit ONLY (git add explicit files + git commit). NEVER git push / merge / deploy without RELEASE gate.',
      next_command: `Commit locally, then call: ${NEXT_COMMANDS.commit}`
    };
  }

  return {
    action: pack.status,
    ...packInfo
  };
}

function pauseForOutOfScopeChange(ctx, pack, resumeStatus, scan, previousGate) {
  const { stateDir, config, state } = ctx;
  const reason = ALLOWED_GATE_REASONS.OUT_OF_SCOPE_CHANGE;
  const summary = previousGate?.summary ?? '发现本包范围外的改动。请决定扩大范围、确认已撤掉改动、放行非本包改动或终止流程。';
  const actions = previousGate?.allowed_resume_actions ?? ['expand', 'revert', 'ignore', 'abort'];
  pack.gate = {
    ...createGate(reason, summary, { allowed_resume_actions: actions }),
    out_of_scope_files: scan.files,
    resume_status: resumeStatus,
    ...(scan.notices.worktree_notice && { worktree_notice: scan.notices.worktree_notice })
  };
  pack.status = 'PAUSED_FOR_HUMAN';
  saveState(stateDir, state);
  const details = { pack_id: pack.id, gate_reason: reason, summary, resume_status: resumeStatus, files: scan.files };
  appendEvent(stateDir, config, { type: 'out_of_scope_detected', ...details });
  appendEvent(stateDir, config, { type: 'gate_paused', pack_id: pack.id, gate_reason: reason, summary });
}

function outOfScopeOutcome(ctx, pack, resumeStatus, scan) {
  pauseForOutOfScopeChange(ctx, pack, resumeStatus, scan);
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  return { outcome: 'paused_out_of_scope_change', gate: redactor.redactValue(pack.gate), question: buildQuestion(ctx, pack), ...scan.notices };
}

function outOfScopeGateError(ctx, pack, message = '请先处理 OUT_OF_SCOPE_CHANGE，才能继续本包。') {
  const error = new Error(message);
  error.question = buildQuestion(ctx, pack);
  return error;
}

export function getRepairRounds(pack) {
  return pack.repair_rounds ?? ((pack.tier1_repairs ?? 0) + (pack.tier2_repairs ?? 0));
}

function countRepairRound(pack) {
  // An approved extra repair can reset the tier budget without resetting the cumulative count.
  pack.repair_rounds = getRepairRounds(pack) + 1;
}

function recordFailureLesson(ctx, pack, input) {
  return addLesson(ctx.stateDir, ctx.config, {
    ...input,
    pack_id: pack.id,
    tags: getPackDef(ctx.manifest, pack.id)?.tags,
    repair_rounds: getRepairRounds(pack)
  });
}

/**
 * Core 2+2 Repair & Auto-Escalation Ladder:
 * - Tier 1 up to tier1_max_repairs (default 2)
 * - Tier 1 exhausted -> auto-escalate if a Tier 2 repair remains
 * - Tier 2 up to tier2_max_repairs (default 2)
 * - Tier 2 exhausted -> PAUSED_FOR_HUMAN (BUDGET_EXCEEDED)
 */
export function applyRepairLadder(ctx, pack, source, reasonSummary) {
  const { stateDir, config } = ctx;
  const budgets = getBudgets(config);

  if (pack.current_tier === 'tier1' && pack.tier1_repairs < budgets.tier1MaxRepairs) {
    countRepairRound(pack);
    pack.tier1_repairs += 1;
    pack.status = 'IMPLEMENT';
    appendEvent(stateDir, config, {
      type: 'repair_scheduled',
      pack_id: pack.id,
      source,
      tier: 'tier1',
      instance: pack.active_instance,
      attempt: pack.tier1_repairs,
      max_attempts: budgets.tier1MaxRepairs,
      summary: reasonSummary
    });
    saveState(stateDir, stateFor(ctx));
    return { outcome: 'repair_tier1', tier: 'tier1', attempt: pack.tier1_repairs };
  }

  if (pack.current_tier === 'tier1' && pack.tier2_repairs < budgets.tier2MaxRepairs) {
    const prevInstance = pack.active_instance;
    const nextInstance = resolveTierInstance(config, 'tier2');
    pack.current_tier = 'tier2';
    pack.active_instance = nextInstance;
    pack.escalated = true;
    pack.escalation_reason = `Tier 1 (${prevInstance}) failed after ${pack.tier1_repairs}/${budgets.tier1MaxRepairs} repairs (${source}): ${reasonSummary}`;
    countRepairRound(pack);
    pack.tier2_repairs += 1;
    pack.status = 'IMPLEMENT';
    // Reset native session ID when switching executor instance
    invalidateSession(pack);

    appendEvent(stateDir, config, {
      type: 'escalated_to_tier2',
      pack_id: pack.id,
      source,
      from_instance: prevInstance,
      to_instance: nextInstance,
      tier1_repairs: pack.tier1_repairs,
      tier2_attempt: pack.tier2_repairs,
      reason: pack.escalation_reason
    });
    saveState(stateDir, stateFor(ctx));
    return { outcome: 'escalated_tier2', tier: 'tier2', instance: nextInstance, attempt: pack.tier2_repairs };
  }

  // Currently on Tier 2
  if (pack.current_tier !== 'tier1' && pack.tier2_repairs < budgets.tier2MaxRepairs) {
    countRepairRound(pack);
    pack.tier2_repairs += 1;
    pack.status = 'IMPLEMENT';
    appendEvent(stateDir, config, {
      type: 'repair_scheduled',
      pack_id: pack.id,
      source,
      tier: 'tier2',
      instance: pack.active_instance,
      attempt: pack.tier2_repairs,
      max_attempts: budgets.tier2MaxRepairs,
      summary: reasonSummary
    });
    saveState(stateDir, stateFor(ctx));
    return { outcome: 'repair_tier2', tier: 'tier2', attempt: pack.tier2_repairs };
  }

  // Tier 2 exhausted -> hard brake to human
  pack.status = 'PAUSED_FOR_HUMAN';
  pack.gate = createGate(
    ALLOWED_GATE_REASONS.BUDGET_EXCEEDED,
    `Pack ${pack.id} exhausted repair budget (tier1=${pack.tier1_repairs}/${budgets.tier1MaxRepairs}, tier2=${pack.tier2_repairs}/${budgets.tier2MaxRepairs}). Last failure (${source}): ${reasonSummary}`,
    {
      recommended_action: 'inspect_and_decide',
      allowed_resume_actions: ['repair', 'commit', 'abort']
    }
  );
  appendEvent(stateDir, config, {
    type: 'gate_paused',
    pack_id: pack.id,
    gate_reason: ALLOWED_GATE_REASONS.BUDGET_EXCEEDED,
    summary: pack.gate.summary
  });
  saveState(stateDir, stateFor(ctx));
  return { outcome: 'paused_budget_exceeded', gate: pack.gate, question: buildQuestion(ctx, pack) };
}

function stateFor(ctx) {
  return ctx.state;
}

function getWritablePack(ctx, packId) {
  const { state, manifest } = ctx;
  const pack = state.packs[packId || state.active_pack_id];
  if (!pack) throw new Error('No active pack found');
  if (pack.status === 'COMMITTED') throw new Error(`Pack ${pack.id} is already committed.`);
  if (state.loop_status === 'ABORTED') throw new Error('The loop was aborted.');
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.OUT_OF_SCOPE_CHANGE) throw outOfScopeGateError(ctx, pack);
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXECUTOR_BLOCKED) {
    const error = new Error('Answer the EXECUTOR_BLOCKED question before advancing this package.');
    error.question = buildQuestion(ctx, pack);
    throw error;
  }
  if (pack.gate?.infra_error === EXECUTABLE_NOT_FOUND) {
    const error = new Error(pack.gate.summary);
    error.question = buildQuestion(ctx, pack);
    throw error;
  }
  requireHandoffPreflight(pack, getPackDef(manifest, pack.id), ctx);
  return pack;
}

function completeSelfRun(ctx, pack, stage, payload, status, instance) {
  const run = pack.inflight_run;
  const cfg = ctx.config?.executors?.[instance];
  const executor = {
    executor_tool: payload.executor?.executor_tool ?? cfg?.kind ?? null,
    executor_model: payload.executor?.executor_model ?? cfg?.model ?? null,
    executor_effort: payload.executor?.executor_effort ?? cfg?.reasoning_effort ?? null
  };
  if (payload.dispatch || !run || run.kind !== 'self' || run.stage !== stage) return { executor };

  if (payload.runId && payload.runId !== run.run_id) {
    throw new Error('Pass --run-id ' + run.run_id + ' to record the dispatched self run, or omit --run-id.');
  }
  const result = readJsonSafe(path.join(run.run_dir, 'result.json'), {});
  const elapsedSeconds = result.elapsed_seconds ?? Math.max(0, (Date.now() - Date.parse(run.started_at)) / 1000);
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  for (const field of Object.keys(executor)) {
    executor[field] = payload.executor?.[field] ?? result[field] ?? executor[field];
  }
  const { note, recorded_at, ...receipt } = result;
  writeRunResult(run.run_dir, {
    ...receipt, ...executor, instance_id: run.instance, stage, kind: 'self', status,
    started_at: run.started_at, elapsed_seconds: elapsedSeconds, infra_error: payload.infraError || null
  }, redactor);
  pack.inflight_run = null;
  appendEvent(ctx.stateDir, ctx.config, {
    type: 'self_run_recorded', pack_id: pack.id, run_id: run.run_id, stage,
    instance: run.instance, status, elapsed_seconds: elapsedSeconds, ...executor
  });
  return { executor, selfRunId: run.run_id };
}

export function recordInfraFailure(ctx, pack, { instance, infraError, summary, canFallback = false, stage = 'implement' }) {
  const { stateDir, config, state } = ctx;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const reason = redactor.redactString(summary || infraError);
  const missingExecutable = infraError === EXECUTABLE_NOT_FOUND;
  pack.infra_failures = (pack.infra_failures ?? 0) + 1;
  appendEvent(stateDir, config, {
    type: 'infra_failure',
    pack_id: pack.id,
    instance,
    error_class: infraError,
    summary: reason,
    repair_budget_consumed: false
  });

  const fallback = config?.executors?.[instance]?.fallback_instance;
  if (!missingExecutable && canFallback && config?.routing?.on_infra_failure === 'fallback' && fallback && config?.executors?.[fallback]) {
    const prev = pack.active_instance;
    pack.active_instance = fallback;
    invalidateSession(pack);
    pack.status = 'IMPLEMENT';
    appendEvent(stateDir, config, {
      type: 'infra_fallback',
      pack_id: pack.id,
      from_instance: prev,
      to_instance: pack.active_instance,
      trigger: infraError
    });
    saveState(stateDir, state);
    return { outcome: 'infra_fallback', active_instance: pack.active_instance };
  }

  const gateSummary = missingExecutable ? reason
    : redactor.redactString(`Executor "${instance}" hit infrastructure failure (${infraError}): ${summary || ''}. Repair budget was NOT consumed.`);
  pack.status = 'PAUSED_FOR_HUMAN';
  pack.gate = createGate(ALLOWED_GATE_REASONS.INFRA_BLOCKED, gateSummary, {
    recommended_action: 'fix_cli_or_switch_instance',
    allowed_resume_actions: ['retry', 'switch_instance', 'abort']
  });
  if (missingExecutable) pack.gate.infra_error = infraError;
  if (stage === 'review') {
    pack.gate.resume_status = 'REVIEW';
    pack.review_instance = instance;
  }
  saveState(stateDir, state);
  return { outcome: 'paused_infra_blocked', gate: pack.gate, question: buildQuestion(ctx, pack) };
}

export function recordImplementOutcome(ctx, payload) {
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(ctx, payload.packId);
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) {
    return buildNextDirective(ctx, pack, getPackDef(ctx.manifest, pack.id));
  }
  const runTier = payload.dispatch?.tier ?? pack.current_tier;
  const selfRun = !payload.dispatch && pack.inflight_run?.kind === 'self' && pack.inflight_run.stage === 'implement'
    ? pack.inflight_run : null;
  const runInstance = payload.dispatch?.instance ?? selfRun?.instance ?? pack.active_instance;
  const canResume = runInstance === pack.active_instance && !payload.dispatch?.routeChanged && !selfRun?.route_changed;
  const runStatus = payload.infraError ? 'infra_error'
    : payload.blockedReason ? 'blocked' : (payload.passed ? 'completed' : 'failed');
  const { executor, selfRunId } = completeSelfRun(ctx, pack, 'implement', payload, runStatus, runInstance);
  delete pack.continue_pending;
  if (pack.last_verify) delete pack.last_verify.repair_undo;

  if (payload.sessionId && canResume) rememberSession(pack, payload.sessionId, 'implement', runInstance);
  const runId = payload.runId || selfRunId || null;
  if (runId) pack.last_run_id = runId;

  // Infrastructure failure immunity: NEVER consumes tier1/tier2 repair budgets
  if (payload.infraError) {
    return recordInfraFailure(ctx, pack, {
      instance: runInstance, infraError: payload.infraError, summary: payload.summary, canFallback: canResume
    });
  }

  if (payload.blockedReason) {
    const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
    const reason = redactor.redactString(payload.blockedReason);
    const characters = [...reason];
    const summary = characters.length > 800
      ? `${characters.slice(0, 800).join('').trimEnd()}…（原因已截断）`
      : reason;
    const packDef = getPackDef(ctx.manifest, pack.id);
    pack.status = 'PAUSED_FOR_HUMAN';
    pack.gate = {
      ...createGate(ALLOWED_GATE_REASONS.EXECUTOR_BLOCKED, summary, {
        allowed_resume_actions: ['continue', 'retry', 'approve', 'switch_instance', 'abort']
      }),
      scope_files: Array.isArray(packDef?.scope_files) ? [...packDef.scope_files] : [],
      co_change_files: Array.isArray(packDef?.co_change_files) ? [...packDef.co_change_files] : []
    };
    appendEvent(stateDir, config, {
      type: 'implement_blocked', pack_id: pack.id, run_id: runId,
      tier: runTier, instance: runInstance, ...executor, summary
    });
    saveState(stateDir, state);
    return { outcome: 'paused_executor_blocked', gate: pack.gate, question: buildQuestion(ctx, pack) };
  }

  if (payload.passed) {
    const scan = scanOutOfScopeChanges(ctx, pack, getPackDef(ctx.manifest, pack.id));
    appendEvent(stateDir, config, {
      type: 'implement_completed',
      pack_id: pack.id,
      tier: runTier,
      instance: runInstance,
      session_id: payload.sessionId || (canResume ? pack.last_session_id : null),
      run_id: pack.last_run_id,
      ...executor,
      summary: payload.summary || 'Implementation completed'
    });
    if (scan.files?.length) return outOfScopeOutcome(ctx, pack, 'VERIFY', scan);
    pack.status = 'VERIFY';
    saveState(stateDir, state);
    return { outcome: 'ready_for_verify', status: pack.status, ...scan.notices };
  }

  recordFailureLesson(ctx, pack, {
    stage: 'IMPLEMENT',
    severity: 'HIGH',
    summary: payload.summary || 'Implementation execution error',
    rule: payload.rule || '',
    discovered_by: 'executor'
  });
  return applyRepairLadder(ctx, pack, 'IMPLEMENT', payload.summary || 'Implementation failed');
}

const verifyRepairFields = [
  'tier1_repairs', 'tier2_repairs', 'current_tier', 'active_instance',
  'last_session_id', 'last_session_route', 'escalated', 'escalation_reason', 'gate'
];

export function markVerificationEnvironment(ctx, packId, reason) {
  const { stateDir, config, paths } = ctx;
  const state = ctx.state = readJsonSafe(paths.statePath);
  const pack = getWritablePack(ctx, packId);
  const lastVerify = pack.last_verify;
  const undo = lastVerify?.repair_undo;
  const repairPending = pack.status === 'IMPLEMENT'
    || (pack.status === 'PAUSED_FOR_HUMAN' && pack.gate?.reason === ALLOWED_GATE_REASONS.BUDGET_EXCEEDED);
  if (!repairPending || !undo || lastVerify.passed || state.loop_status === 'ABORTED') {
    throw new Error(`Pack ${pack.id} has no verification failure eligible for --mark-env. Use it before dispatching the repair.`);
  }

  removeLesson(stateDir, undo.lesson_id);

  Object.assign(pack, undo.fields, { status: 'VERIFY' });
  delete lastVerify.repair_undo;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  lastVerify.environment_reason = redactor.redactString(reason.trim());
  lastVerify.environment_retry_pending = true;
  appendEvent(stateDir, config, {
    type: 'verify_marked_environment',
    pack_id: pack.id,
    reason: lastVerify.environment_reason,
    run_dirs: lastVerify.run_dirs ?? [],
    removed_lesson_id: undo.lesson_id
  });
  saveState(stateDir, state);
  return lastVerify;
}

export function recordVerifyOutcome(ctx, payload) {
  // CLI verification runs commands asynchronously and reports into the latest state.
  if (payload.source === 'cli') ctx.state = readJsonSafe(ctx.paths.statePath);
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(ctx, payload.packId);
  const budgets = getBudgets(config);
  if (payload.source === 'cli' && 'previousVerifyAt' in payload
      && (pack.status !== 'VERIFY' || state.loop_status === 'ABORTED'
        || (pack.last_verify?.at ?? null) !== payload.previousVerifyAt)) {
    throw new Error(`Pack ${pack.id} changed during verification. The logs were saved, but the result was not recorded.`);
  }
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) {
    return buildNextDirective(ctx, pack, getPackDef(ctx.manifest, pack.id));
  }

  // 'cli' = grow-loop ran the configured commands and checked exit codes itself;
  // 'self_reported' = the coordinator asserted the outcome via `record verify`.
  const source = payload.source === 'cli' ? 'cli' : 'self_reported';

  pack.last_verify = {
    passed: Boolean(payload.passed),
    source,
    summary: payload.summary || '',
    command: payload.command || null,
    run_dir: payload.runDir || null,
    at: new Date().toISOString()
  };
  if (source === 'cli') {
    Object.assign(pack.last_verify, {
      run_dirs: payload.runDirs ?? [],
      flaky: Boolean(payload.flaky),
      failure: payload.failure ?? null,
      environment_reason: payload.environmentReason ?? null
    });
    if (payload.baseline) pack.last_verify.baseline = payload.baseline;
  }

  appendEvent(stateDir, config, {
    type: 'verify_recorded',
    pack_id: pack.id,
    passed: Boolean(payload.passed),
    source,
    summary: payload.summary || '',
    command: payload.command || null,
    ...(source === 'cli' && {
      flaky: pack.last_verify.flaky,
      run_dirs: pack.last_verify.run_dirs,
      environment_reason: pack.last_verify.environment_reason
    })
  });

  if (!payload.passed) {
    if (payload.environmentReason) {
      saveState(stateDir, state);
      return { outcome: 'verify_environment_failed', status: pack.status };
    }
    const fields = Object.fromEntries(verifyRepairFields.map((field) => [field, pack[field]]));
    fields.repair_rounds = getRepairRounds(pack);
    const lesson = recordFailureLesson(ctx, pack, {
      stage: 'VERIFY',
      severity: 'HIGH',
      summary: payload.summary || 'Machine verification failed',
      root_cause: payload.rootCause || '',
      rule: payload.rule || '',
      locator: payload.locator || '',
      discovered_by: 'machine_verify'
    });
    pack.last_verify.repair_undo = { fields, lesson_id: lesson.id };
    return applyRepairLadder(ctx, pack, 'VERIFY', payload.summary || 'Verification failed');
  }

  // Verify passed! Decide whether to run closing review or commit.
  if (payload.baseline) pack.last_passed_baseline_failures = payload.baseline.failures;
  else delete pack.last_passed_baseline_failures;
  if (budgets.reviewMode === 'none') {
    pack.status = 'READY_TO_COMMIT';
    saveState(stateDir, state);
    return { outcome: 'ready_to_commit', review_skipped: true };
  }

  // If closing review rounds already hit the cap (e.g., final Tier2 repair after round-2 review),
  // do NOT open a 3rd adversarial review; pause cleanly for quick human sign-off to commit.
  if (pack.review_rounds >= budgets.maxReviewRounds) {
    pack.status = 'PAUSED_FOR_HUMAN';
    pack.gate = createGate(
      ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED,
      `Pack ${pack.id} passed machine verification after final repair, and closing review cap (${pack.review_rounds}/${budgets.maxReviewRounds}) is already reached. Approve commit or request manual review.`,
      {
        recommended_action: 'commit',
        allowed_resume_actions: ['commit', 'repair', 'abort']
      }
    );
    appendEvent(stateDir, config, {
      type: 'gate_paused',
      pack_id: pack.id,
      gate_reason: ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED,
      summary: pack.gate.summary
    });
    saveState(stateDir, state);
    return { outcome: 'paused_review_cap_verified', gate: pack.gate, question: buildQuestion(ctx, pack) };
  }

  pack.status = 'REVIEW';
  saveState(stateDir, state);
  return { outcome: 'ready_for_review', next_review_round: pack.review_rounds + 1 };
}

export function recordReviewOutcome(ctx, payload) {
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(ctx, payload.packId);
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) {
    return buildNextDirective(ctx, pack, getPackDef(ctx.manifest, pack.id));
  }
  const budgets = getBudgets(config);
  if (payload.reportPath && (pack.status !== 'REVIEW' ||
    (payload.reviewRound !== undefined && payload.reviewRound !== pack.review_rounds + 1))) {
    throw new Error(`Pack ${pack.id} is no longer awaiting this review. Check "grow-loop next" before recording a report.`);
  }
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const { blockingSeverities } = budgets;
  const selfReviewer = pack.inflight_run?.kind === 'self' && pack.inflight_run.stage === 'review'
    ? pack.inflight_run.instance : null;
  const reviewer = payload.reviewer || selfReviewer || resolveTierInstance(config, 'reviewer');
  const { executor, selfRunId } = completeSelfRun(ctx, pack, 'review', payload, 'completed', selfReviewer || reviewer);
  const reviewerModel = payload.reviewerModel === undefined ? executor.executor_model : payload.reviewerModel;
  const summary = redactor.redactString(payload.summary || '');

  delete pack.review_instance;
  pack.review_rounds += 1;
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const blocking = [];
  const nonBlocking = [];

  for (const f of findings) {
    const sev = String(f.severity || 'LOW').toUpperCase();
    if (blockingSeverities.has(sev)) {
      blocking.push({ ...redactor.redactValue(f), severity: sev });
    } else {
      nonBlocking.push({ ...f, severity: sev });
    }
  }

  // A legacy --verdict fail without findings still needs a configured blocking severity.
  const rawVerdictLower = String(payload.verdict || '').toLowerCase();
  if (rawVerdictLower === 'fail' && findings.length === 0 && blockingSeverities.size) {
    blocking.push({
      severity: blockingSeverities.has('HIGH') ? 'HIGH' : blockingSeverities.values().next().value,
      title: summary || `Review round ${pack.review_rounds} failed without structured findings`,
      detail: summary
    });
  }

  const effectivePass = blocking.length === 0;
  const verdictNormalized = effectivePass ? 'PASS' : 'FAIL';
  const debtCount = recordReviewTechDebt(stateDir, config, pack.id, pack.review_rounds, nonBlocking, effectivePass);

  pack.last_review = {
    round: pack.review_rounds,
    reviewer: redactor.redactString(reviewer),
    reviewer_model: redactor.redactString(reviewerModel || null),
    verdict: verdictNormalized,
    raw_verdict: String(payload.verdict || '').toUpperCase(),
    blocking_count: blocking.length,
    non_blocking_count: nonBlocking.length,
    summary,
    at: new Date().toISOString()
  };

  appendEvent(stateDir, config, {
    type: 'review_recorded',
    pack_id: pack.id,
    round: pack.review_rounds,
    max_rounds: budgets.maxReviewRounds,
    reviewer: pack.last_review.reviewer,
    reviewer_model: pack.last_review.reviewer_model,
    run_id: payload.runId || selfRunId || null,
    ...executor,
    verdict: verdictNormalized,
    blocking_count: blocking.length,
    non_blocking_count: nonBlocking.length,
    tech_debt_recorded: debtCount,
    summary
  });

  if (effectivePass) {
    pack.pending_blocking_findings = [];
    pack.status = 'READY_TO_COMMIT';
    saveState(stateDir, state);
    return {
      outcome: 'review_passed',
      tech_debt_recorded: debtCount,
      severity_floor_overridden: rawVerdictLower === 'fail'
    };
  }

  pack.pending_blocking_findings = blocking;
  for (const bf of blocking) {
    recordFailureLesson(ctx, pack, {
      stage: `REVIEW_R${pack.review_rounds}`,
      severity: bf.severity,
      summary: bf.title || bf.summary || 'Blocking review finding',
      root_cause: bf.detail || '',
      rule: bf.rule || '',
      locator: bf.locator || '',
      discovered_by: `review:${pack.last_review.reviewer}`
    });
  }

  // Review round cap reached (2/2)!
  if (pack.review_rounds >= budgets.maxReviewRounds) {
    // Allow a remaining tier2 repair after tier1 without scheduling a third review.
    if (pack.current_tier === 'tier1' && pack.tier2_repairs < budgets.tier2MaxRepairs) {
      const prev = pack.active_instance;
      const next = resolveTierInstance(config, 'tier2');
      pack.current_tier = 'tier2';
      pack.active_instance = next;
      pack.escalated = true;
      pack.escalation_reason = `Review cap (${pack.review_rounds}/${budgets.maxReviewRounds}) hit on tier1 with ${blocking.length} blocking findings`;
      countRepairRound(pack);
      pack.tier2_repairs += 1;
      invalidateSession(pack);
      pack.status = 'IMPLEMENT';
      appendEvent(stateDir, config, {
        type: 'escalated_to_tier2',
        pack_id: pack.id,
        source: 'REVIEW_CAP',
        from_instance: prev,
        to_instance: next,
        blocking_count: blocking.length,
        reason: pack.escalation_reason
      });
      saveState(stateDir, state);
      return { outcome: 'escalated_tier2_on_review_cap', blocking_count: blocking.length };
    }

    pack.status = 'PAUSED_FOR_HUMAN';
    pack.gate = createGate(
      ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED,
      `Pack ${pack.id} hit closing review cap (${pack.review_rounds}/${budgets.maxReviewRounds}) on ${pack.current_tier} with ${blocking.length} blocking finding(s).`,
      {
        recommended_action: 'inspect_blocking_findings',
        allowed_resume_actions: ['repair', 'commit', 'abort']
      }
    );
    appendEvent(stateDir, config, {
      type: 'gate_paused',
      pack_id: pack.id,
      gate_reason: ALLOWED_GATE_REASONS.REVIEW_CAP_REACHED,
      blocking_count: blocking.length,
      summary: pack.gate.summary
    });
    saveState(stateDir, state);
    return { outcome: 'paused_review_cap_reached', blocking_count: blocking.length, gate: pack.gate, question: buildQuestion(ctx, pack) };
  }

  // Review round 1 failed -> enter standard 2+2 repair ladder
  return applyRepairLadder(
    ctx,
    pack,
    `REVIEW_R${pack.review_rounds}`,
    summary || `${blocking.length} blocking finding(s) in review round ${pack.review_rounds}`
  );
}

function advanceAfterCompletion({ state, stateDir }) {
  const nextId = state.pack_order.find((id) => state.packs[id]?.status !== 'COMMITTED') || null;
  state.active_pack_id = nextId;
  state.loop_status = nextId ? 'RUNNING' : 'COMPLETED';
  saveState(stateDir, state);
  return nextId;
}

function updateVerificationBaseline(ctx, pack) {
  const { stateDir, config, paths } = ctx;
  if (!config?.verification?.baseline || !pack.last_passed_baseline_failures) return;
  const baseline = readVerificationBaseline(paths.baselinePath);
  if (!baseline) return;
  const remaining = new Set(pack.last_passed_baseline_failures);
  const removed = baseline.failures.filter((name) => !remaining.has(name));
  if (!removed.length) return;
  const failures = baseline.failures.filter((name) => remaining.has(name));
  writeJsonAtomic(paths.baselinePath, { ...baseline, failures });
  appendEvent(stateDir, config, { type: 'baseline_updated', pack_id: pack.id, removed });
}

export function recordCommitOutcome(ctx, payload) {
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(ctx, payload.packId);
  const packDef = getPackDef(ctx.manifest, pack.id);
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) return buildNextDirective(ctx, pack, packDef);
  const changedFiles = readCommitFiles(state.repo_dir, payload.sha);
  if (payload.fromGit && changedFiles === null) throw new Error('Git 无法列出本次提交改动的文件。请恢复 Git 检查后重新登记。');
  const scope = scanCommitScope(ctx, pack, packDef, changedFiles);
  if (scope.files.length) {
    const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
    const files = scope.files.map((file) => `- ${redactor.redactString(file)}`).join('\n');
    throw new Error(`本次提交包含未批准的范围外文件。\n${files}\n把这些文件撤出提交后重新提交再登记。要保留它们，需要人先同意扩范围。`);
  }
  const gitWatch = checkExternalCommits(ctx, pack, packDef, payload.sha);
  if (gitWatch?.status === 'blocked') return buildNextDirective(ctx, pack, packDef);

  updateVerificationBaseline(ctx, pack);
  pack.commit = {
    sha: payload.sha,
    message: payload.message || '',
    files: Number(payload.files || 0),
    insertions: Number(payload.insertions || 0),
    deletions: Number(payload.deletions || 0),
    ...(changedFiles && { changed_files: changedFiles }),
    pushed: false,
    committed_at: new Date().toISOString()
  };
  pack.status = 'COMMITTED';
  pack.completed_at = new Date().toISOString();
  pack.gate = null;

  closeLessonsForPack(
    stateDir,
    config,
    pack.id,
    getRepairRounds(pack),
    pack.last_verify?.summary || `commit:${payload.sha?.slice(0, 9)}`
  );
  deferInRoundTechDebt(stateDir, pack.id);

  appendEvent(stateDir, config, {
    type: 'pack_committed',
    pack_id: pack.id,
    tier: pack.current_tier,
    instance: pack.active_instance,
    commit: pack.commit
  });

  const nextId = advanceAfterCompletion(ctx);

  return {
    outcome: 'committed',
    committed_pack: pack.id,
    next_pack_id: nextId,
    loop_status: state.loop_status,
    ...(gitWatch && { git_watch: gitWatch }),
    ...(payload.fromGit && scope.notices)
  };
}

export function recordExternalCompletion(ctx, { packId, note }) {
  const { stateDir, config, state } = ctx;
  if (typeof packId !== 'string' || !packId.trim()) throw new Error('Specify a non-empty --pack.');
  const reason = typeof note === 'string' ? note.trim() : '';
  if (!reason) throw new Error('Specify a non-empty --note.');
  if (!state.pack_order.includes(packId)) throw new Error('Work package not found. Check --pack.');
  const pack = state.packs[packId];
  if (pack.status === 'COMMITTED') throw new Error(`Pack ${pack.id} is already committed.`);
  if (state.loop_status === 'ABORTED') throw new Error('The loop was aborted.');
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.OUT_OF_SCOPE_CHANGE) throw outOfScopeGateError(ctx, pack);
  if (!['PENDING', 'PAUSED_FOR_HUMAN'].includes(pack.status)) {
    throw new Error(`Pack ${pack.id} is in ${pack.status}. Continue the normal workflow to "grow-loop record commit --from-git", or use "grow-loop resume" if the pack pauses.`);
  }
  const run = pack.inflight_run;
  if (dispatchStillRunning(run) || (run?.kind === 'self' && !run.route_changed)) {
    throw new Error(`Pack ${pack.id} has an active dispatch. Finish the dispatch before recording external completion.`);
  }

  const at = new Date().toISOString();
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  pack.completed_externally = { note: redactor.redactString(reason), at };
  pack.status = 'COMMITTED';
  pack.completed_at = at;
  pack.commit = null;
  pack.gate = null;
  pack.inflight_run = null;
  pack.prepared_run = null;
  appendEvent(stateDir, config, { type: 'pack_completed_externally', pack_id: pack.id, note: reason, ts: at });

  const nextId = advanceAfterCompletion(ctx);
  return {
    outcome: 'completed_externally',
    pack_id: pack.id,
    completed_externally: pack.completed_externally,
    next_pack_id: nextId,
    loop_status: state.loop_status
  };
}

function recordGateResume(ctx, pack, action, decision, instance) {
  appendEvent(ctx.stateDir, ctx.config, {
    type: 'gate_resumed', pack_id: pack.id, gate_reason: pack.gate?.reason || 'UNKNOWN',
    action, decision: decision || '', switch_instance: instance || null
  });
}

function resumeOutOfScopeChange(ctx, pack, packDef, action, decision) {
  const { stateDir, config, state } = ctx;
  const gate = pack.gate;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  let previousIgnore;
  if (action === 'expand') {
    if (typeof decision !== 'string' || !decision.trim()) {
      throw outOfScopeGateError(ctx, pack, '扩大范围需要填写非空的 --decision 原话。');
    }
    const files = gate.out_of_scope_files.map(({ path: file }) => file);
    const previousApproval = { approved_out_of_scope: pack.approved_out_of_scope, decisions: pack.decisions };
    pack.approved_out_of_scope = [...new Set([...(previousApproval.approved_out_of_scope ?? []), ...files])];
    pack.decisions = [...(previousApproval.decisions ?? []), {
      gate_reason: gate.reason, action, decision: redactor.redactString(decision), at: new Date().toISOString()
    }];
    try {
      expandPackScope(ctx, packDef, files, decision, { gate_reason: gate.reason });
    } catch (error) {
      Object.assign(pack, previousApproval);
      throw error;
    }
  } else if (action === 'ignore') {
    if (typeof decision !== 'string' || !decision.trim()) {
      throw outOfScopeGateError(ctx, pack, '放行非本包改动需要填写非空的 --decision 原话。');
    }
    const snapshot = readWorktreeSnapshot(state.repo_dir, gate.out_of_scope_files.map(({ path: file }) => file));
    if (snapshot === null) throw outOfScopeGateError(ctx, pack, 'Git 无法读取当前工作区内容，无法放行这些改动。');
    previousIgnore = { start_worktree: pack.start_worktree, decisions: pack.decisions, gate, status: pack.status };
    pack.start_worktree = { ...pack.start_worktree, ...snapshot };
    pack.decisions = [...(pack.decisions ?? []), {
      gate_reason: gate.reason, action, decision: redactor.redactString(decision), at: new Date().toISOString()
    }];
  }

  try {
    const scan = scanOutOfScopeChanges(ctx, pack, getPackDef(ctx.manifest, pack.id));
    if (action === 'ignore' && scan.notices.worktree_notice) {
      throw outOfScopeGateError(ctx, pack, 'Git 无法复查当前工作区内容，无法放行这些改动。');
    }
    if (action === 'revert') {
      if (scan.files === null) throw outOfScopeGateError(ctx, pack, 'Git 无法读取当前工作区，无法确认越界改动已撤掉。');
      if (scan.files.length) {
        if (!isDeepStrictEqual(scan.files, gate.out_of_scope_files)) {
          pauseForOutOfScopeChange(ctx, pack, gate.resume_status, scan, gate);
        }
        const files = scan.files.map(({ path: file }) => redactor.redactString(file)).join('、');
        throw outOfScopeGateError(ctx, pack, `仍有范围外的改动。请撤掉这些改动后再继续：${files}`);
      }
    }

    recordGateResume(ctx, pack, action, decision);
    if (scan.files?.length) return outOfScopeOutcome(ctx, pack, gate.resume_status, scan);
    pack.gate = null;
    pack.status = gate.resume_status;
    saveState(stateDir, state);
    const outcome = pack.status === 'VERIFY' ? 'ready_for_verify' : 'ready_to_commit';
    return { outcome, pack_id: pack.id, status: pack.status, ...scan.notices };
  } catch (error) {
    if (previousIgnore) Object.assign(pack, previousIgnore);
    throw error;
  }
}

export function resumeFromGate(ctx, { packId, action, decision, instance }) {
  const { stateDir, config, manifest, state } = ctx;
  const pack = state.packs[packId || state.active_pack_id];
  if (!pack) throw new Error('No active pack found');
  if (pack.status !== 'PAUSED_FOR_HUMAN') {
    throw new Error(`Pack ${pack.id} is not paused (current status: ${pack.status})`);
  }

  const prevGate = pack.gate;
  const packDef = getPackDef(manifest, pack.id);
  const act = String(action || 'approve').toLowerCase();
  const gateReason = prevGate?.reason || 'UNKNOWN';
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const at = new Date().toISOString();
  const questions = prevGate?.questions?.length ? { questions: redactor.redactValue(prevGate.questions) } : {};
  let approvedPosition = null;
  if (gateReason === ALLOWED_GATE_REASONS.OUT_OF_SCOPE_CHANGE) {
    if (!prevGate.allowed_resume_actions.includes(act)) {
      throw outOfScopeGateError(ctx, pack, `请为 OUT_OF_SCOPE_CHANGE 选择 --action ${prevGate.allowed_resume_actions.join('、')} 中的一项。`);
    }
    if (act !== 'abort') return resumeOutOfScopeChange(ctx, pack, packDef, act, decision);
  } else if (['expand', 'revert', 'ignore'].includes(act)) {
    throw new Error('expand、revert 和 ignore 适用于 OUT_OF_SCOPE_CHANGE 关口。');
  }
  if (gateReason === ALLOWED_GATE_REASONS.EXECUTOR_BLOCKED) {
    if (!prevGate.allowed_resume_actions.includes(act)) {
      const continueAction = prevGate.allowed_resume_actions.includes('continue') ? 'continue, ' : '';
      throw new Error(`Use --action ${continueAction}retry, approve, switch_instance or abort for an EXECUTOR_BLOCKED gate.`);
    }
    if (act === 'continue' && (typeof decision !== 'string' || !decision.trim())) {
      throw new Error('接着写需要填写非空的 --decision 原话。');
    }
    if (act === 'switch_instance' && (instance === pack.active_instance || !Object.hasOwn(config?.executors ?? {}, instance))) {
      throw new Error('Choose a different configured executor with --instance.');
    }
  } else if (act === 'continue') {
    throw new Error('Use --action continue for an EXECUTOR_BLOCKED gate.');
  }
  const retryReview = gateReason === ALLOWED_GATE_REASONS.INFRA_BLOCKED && prevGate.resume_status === 'REVIEW';
  if (prevGate?.infra_error === EXECUTABLE_NOT_FOUND) {
    if (!prevGate.allowed_resume_actions.includes(act)) {
      throw new Error('Use --action retry, switch_instance or abort for an INFRA_BLOCKED gate.');
    }
    const failedInstance = retryReview ? pack.review_instance : pack.active_instance;
    if (act === 'switch_instance' && (instance === failedInstance || !Object.hasOwn(config?.executors ?? {}, instance))) {
      throw new Error('Choose a different configured executor with --instance.');
    }
  }
  if (gateReason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) {
    if (!prevGate.allowed_resume_actions.includes(act)) {
      throw new Error('Use --action approve or abort for an EXTERNAL_COMMIT gate.');
    }
    if (act === 'approve') {
      if (typeof decision !== 'string' || !decision.trim()) {
        throw new Error('Specify a non-empty --decision to approve the external commits.');
      }
      approvedPosition = readGitPosition(state.repo_dir);
      if (!approvedPosition) throw new Error('Git HEAD is unavailable. Restore access to Git before approving the external commits.');
    }
  }

  recordGateResume(ctx, pack, act, decision, instance);

  if (act === 'switch_instance' && (!instance || !config?.executors?.[instance])) {
    throw new Error(`Unknown executor instance "${instance}" in config.executors`);
  }
  if (['continue', 'repair', 'retry', 'commit', 'switch_instance'].includes(act) && typeof decision === 'string' && decision.trim()) {
    (pack.decisions ??= []).push({
      gate_reason: gateReason,
      action: act,
      decision: redactor.redactString(decision),
      at,
      ...questions
    });
  }

  if (act === 'abort') {
    state.loop_status = 'ABORTED';
    pack.gate = null;
    saveState(stateDir, state);
    return { outcome: 'aborted', pack_id: pack.id };
  }

  if (act === 'commit') {
    pack.gate = null;
    pack.status = 'READY_TO_COMMIT';
    saveState(stateDir, state);
    return { outcome: 'ready_to_commit', pack_id: pack.id };
  }

  if (retryReview && (act === 'retry' || act === 'switch_instance')) {
    if (act === 'switch_instance') pack.review_instance = instance;
    pack.gate = null;
    pack.status = 'REVIEW';
    saveState(stateDir, state);
    return {
      outcome: act === 'retry' ? 'resumed_review' : 'switched_instance',
      pack_id: pack.id,
      reviewer_instance: redactor.redactString(pack.review_instance)
    };
  }

  if (act === 'switch_instance') {
    pack.active_instance = instance;
    invalidateSession(pack);
    pack.gate = null;
    pack.status = 'IMPLEMENT';
    saveState(stateDir, state);
    return { outcome: 'switched_instance', pack_id: pack.id, active_instance: instance };
  }

  if (act === 'continue' || act === 'repair' || act === 'retry') {
    pack.gate = null;
    if (act === 'continue') {
      const previousScope = new Set([...(prevGate.scope_files ?? []), ...(prevGate.co_change_files ?? [])]);
      const currentScope = new Set([packDef?.scope_files, packDef?.co_change_files]
        .flatMap((files) => Array.isArray(files) ? files : []));
      pack.continue_pending = {
        blocked_reason: prevGate.summary,
        decision: pack.decisions.at(-1).decision,
        at,
        added_scope: [...currentScope].filter((file) => !previousScope.has(file))
      };
    }
    if (act === 'repair') {
      // Explicit human authorization grants one extra repair round on current tier
      countRepairRound(pack);
      if (pack.current_tier === 'tier2') {
        pack.tier2_repairs = Math.max(0, getBudgets(config).tier2MaxRepairs - 1);
      } else {
        pack.tier1_repairs = Math.max(0, getBudgets(config).tier1MaxRepairs - 1);
      }
    }
    pack.status = 'IMPLEMENT';
    saveState(stateDir, state);
    return { outcome: 'resumed_implement', pack_id: pack.id, active_instance: pack.active_instance };
  }

  // Default: approve
  pack.resolved_gates = pack.resolved_gates || {};
  if (prevGate?.reason) {
    pack.resolved_gates[prevGate.reason] = {
      approved_at: at,
      decision: redactor.redactString(decision || ''),
      ...(approvedPosition && { base_commit: approvedPosition.head, base_branch: approvedPosition.branch }),
      ...questions
    };
  }
  if (prevGate?.reason === ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT) {
    pack.current_tier = 'tier2';
    pack.active_instance = resolveTierInstance(config, 'tier2');
  }
  pack.gate = null;

  if (gateReason === ALLOWED_GATE_REASONS.EXECUTOR_BLOCKED) {
    const scan = scanOutOfScopeChanges(ctx, pack, packDef);
    if (scan.files?.length) return outOfScopeOutcome(ctx, pack, 'VERIFY', scan);
    pack.status = 'VERIFY';
    saveState(stateDir, state);
    return { outcome: 'approved', pack_id: pack.id, status: pack.status, ...scan.notices };
  }

  if (approvedPosition) {
    pack.base_commit = approvedPosition.head;
    pack.base_branch = approvedPosition.branch;
    pack.status = prevGate.resume_status;
    pack.gate = prevGate.prior_gate ?? null;
    saveState(stateDir, state);
    return {
      outcome: 'approved', pack_id: pack.id, status: pack.status, base_commit: pack.base_commit,
      ...(pack.status === 'PAUSED_FOR_HUMAN' && { question: buildQuestion(ctx, pack) })
    };
  }

  // If resuming a preflight gate, re-check any remaining preflight gates (AMBIGUITY / EXTERNAL_EFFECT)
  if (PREFLIGHT_GATE_REASONS.has(prevGate?.reason) && packDef) {
    pack.status = 'PENDING';
    saveState(stateDir, state);
    const nextDirective = startOrAdvanceActivePack(ctx);
    return {
      outcome: nextDirective.action === 'PAUSE_FOR_HUMAN' ? 'paused_next_gate' : 'approved',
      pack_id: pack.id,
      tier: pack.current_tier,
      active_instance: pack.active_instance,
      next: nextDirective,
      ...(nextDirective.question && { question: nextDirective.question })
    };
  }

  pack.status = 'IMPLEMENT';
  saveState(stateDir, state);
  return { outcome: 'approved', pack_id: pack.id, tier: pack.current_tier, active_instance: pack.active_instance };
}

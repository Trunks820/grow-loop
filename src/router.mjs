import path from 'node:path';
import { appendEvent, invalidateSession, readJsonSafe, rememberSession, saveState } from './state.mjs';
import { buildRedactor } from './redact.mjs';
import { taskBriefWarnings } from './task-builder.mjs';
import { getVerificationCommands } from './verify.mjs';
import { ALLOWED_GATE_REASONS, createGate } from './gate.mjs';
import { addLesson, closeLessonsForPack, deferInRoundTechDebt, recordReviewTechDebt, removeLesson, selectLessonsForPack } from './lessons.mjs';
import { getBlockingReviewSeverities } from './review-report.mjs';
import { checkExternalCommits, readCommitFiles, readGitPosition, scanStrayFiles } from './git-watch.mjs';
import { writeRunResult } from './adapters/base.mjs';

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

export function resolveTierInstance(config, tier) {
  const routing = config?.routing || {};
  if (tier === 'reviewer') {
    return routing.reviewer || routing.tier2 || routing.tier1 || 'self';
  }
  if (tier === 'tier2') {
    return routing.tier2 || routing.tier1 || 'self';
  }
  return routing.tier1 || 'self';
}

export function getPackDef(manifest, packId) {
  return (manifest.packs || []).find((p) => p.id === packId) || null;
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
  const packDef = getPackDef(manifest, activeId);
  if (!packDef) {
    throw new Error(`Active pack "${activeId}" missing from manifest.json`);
  }

  if (pack.status === 'PENDING') {
    const deps = checkDependencies(state, packDef);
    if (!deps.satisfied) {
      return {
        action: 'BLOCKED_DEPENDENCY',
        pack_id: activeId,
        missing_dependencies: deps.missing,
        warnings: taskBriefWarnings(packDef, config),
        message: `Pack ${activeId} waiting on uncommitted dependencies: ${deps.missing.join(', ')}`
      };
    }

    if (!pack.started_at) {
      pack.started_at = new Date().toISOString();
      const position = readGitPosition(state.repo_dir);
      pack.base_commit = position?.head ?? null;
      pack.base_branch = position?.branch ?? null;
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
    warnings: taskBriefWarnings(packDef, config)
  };
  const injectedLessons = () => selectLessonsForPack(stateDir, packDef)
    .map(({ id, summary, rule, scope, scope_tags }) => ({ id, summary, rule, scope, scope_tags }));

  if (pack.status === 'PAUSED_FOR_HUMAN') {
    return {
      action: 'PAUSE_FOR_HUMAN',
      ...packInfo,
      gate: pack.gate,
      resume_hint: `grow-loop resume --decision "<your decision>" --action <${(pack.gate?.allowed_resume_actions || ['approve']).join('|')}>`
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
      next_command: `grow-loop dispatch --dry-run (then grow-loop dispatch)`
    };
  }

  if (pack.status === 'VERIFY') {
    const { new_tests, timeout_sec, output_encoding, retry_once } = config?.verification ?? {};
    const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
    return {
      action: 'VERIFY',
      ...packInfo,
      verification: redactor.redactValue({
        commands: getVerificationCommands(config, packDef),
        new_tests, timeout_sec, output_encoding, retry_once
      }),
      next_command: 'grow-loop verify (runs global and pack commands and records exit codes); use "grow-loop record verify --failed ..." only for failures found outside those commands'
    };
  }

  if (pack.status === 'REVIEW') {
    const nextRound = pack.review_rounds + 1;
    const reviewerInstance = resolveTierInstance(config, 'reviewer');
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
      next_command: 'grow-loop dispatch --stage review (self: grow-loop record review --report <report.md>)'
    };
  }

  if (pack.status === 'READY_TO_COMMIT') {
    const gitWatch = checkExternalCommits(ctx, pack, packDef);
    if (gitWatch?.status === 'blocked') return buildNextDirective(ctx, pack, packDef);
    return {
      action: 'COMMIT',
      ...packInfo,
      ...scanStrayFiles(ctx, pack, packDef),
      ...(gitWatch && { git_watch: gitWatch }),
      approval_note: 'Local commit ONLY (git add explicit files + git commit). NEVER git push / merge / deploy without RELEASE gate.',
      next_command: `Commit locally, then call: grow-loop record commit --from-git`
    };
  }

  return {
    action: pack.status,
    ...packInfo
  };
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
  return { outcome: 'paused_budget_exceeded', gate: pack.gate };
}

function stateFor(ctx) {
  return ctx.state;
}

function getWritablePack(state, packId) {
  const pack = state.packs[packId || state.active_pack_id];
  if (!pack) throw new Error('No active pack found');
  if (pack.status === 'COMMITTED') throw new Error(`Pack ${pack.id} is already committed.`);
  if (state.loop_status === 'ABORTED') throw new Error('The loop was aborted.');
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

export function recordImplementOutcome(ctx, payload) {
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(state, payload.packId);
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) {
    return buildNextDirective(ctx, pack, getPackDef(ctx.manifest, pack.id));
  }
  const runTier = payload.dispatch?.tier ?? pack.current_tier;
  const selfRun = !payload.dispatch && pack.inflight_run?.kind === 'self' && pack.inflight_run.stage === 'implement'
    ? pack.inflight_run : null;
  const runInstance = payload.dispatch?.instance ?? selfRun?.instance ?? pack.active_instance;
  const canResume = runInstance === pack.active_instance && !payload.dispatch?.routeChanged && !selfRun?.route_changed;
  const { executor, selfRunId } = completeSelfRun(ctx, pack, 'implement', payload,
    payload.infraError ? 'infra_error' : (payload.passed ? 'completed' : 'failed'), runInstance);
  if (pack.last_verify) delete pack.last_verify.repair_undo;

  if (payload.sessionId && canResume) rememberSession(pack, payload.sessionId, 'implement', runInstance);
  if (payload.runId || selfRunId) pack.last_run_id = payload.runId || selfRunId;

  // Infrastructure failure immunity: NEVER consumes tier1/tier2 repair budgets
  if (payload.infraError) {
    pack.infra_failures += 1;
    appendEvent(stateDir, config, {
      type: 'infra_failure',
      pack_id: pack.id,
      instance: runInstance,
      error_class: payload.infraError,
      summary: payload.summary || payload.infraError,
      repair_budget_consumed: false
    });

    const instanceCfg = config?.executors?.[runInstance] || {};
    const onInfra = config?.routing?.on_infra_failure || 'pause_for_human';
    if (canResume && onInfra === 'fallback' && instanceCfg.fallback_instance && config?.executors?.[instanceCfg.fallback_instance]) {
      const prev = pack.active_instance;
      pack.active_instance = instanceCfg.fallback_instance;
      invalidateSession(pack);
      pack.status = 'IMPLEMENT';
      appendEvent(stateDir, config, {
        type: 'infra_fallback',
        pack_id: pack.id,
        from_instance: prev,
        to_instance: pack.active_instance,
        trigger: payload.infraError
      });
      saveState(stateDir, state);
      return { outcome: 'infra_fallback', active_instance: pack.active_instance };
    }

    pack.status = 'PAUSED_FOR_HUMAN';
    pack.gate = createGate(
      ALLOWED_GATE_REASONS.INFRA_BLOCKED,
      `Executor "${runInstance}" hit infrastructure failure (${payload.infraError}): ${payload.summary || ''}. Repair budget was NOT consumed.`,
      {
        recommended_action: 'fix_cli_or_switch_instance',
        allowed_resume_actions: ['retry', 'switch_instance', 'abort']
      }
    );
    saveState(stateDir, state);
    return { outcome: 'paused_infra_blocked', gate: pack.gate };
  }

  if (payload.passed) {
    pack.status = 'VERIFY';
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
    saveState(stateDir, state);
    return { outcome: 'ready_for_verify', status: pack.status };
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
  const pack = getWritablePack(state, packId);
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
  const pack = getWritablePack(state, payload.packId);
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
    return { outcome: 'paused_review_cap_verified', gate: pack.gate };
  }

  pack.status = 'REVIEW';
  saveState(stateDir, state);
  return { outcome: 'ready_for_review', next_review_round: pack.review_rounds + 1 };
}

export function recordReviewOutcome(ctx, payload) {
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(state, payload.packId);
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
    return { outcome: 'paused_review_cap_reached', blocking_count: blocking.length, gate: pack.gate };
  }

  // Review round 1 failed -> enter standard 2+2 repair ladder
  return applyRepairLadder(
    ctx,
    pack,
    `REVIEW_R${pack.review_rounds}`,
    summary || `${blocking.length} blocking finding(s) in review round ${pack.review_rounds}`
  );
}

export function recordCommitOutcome(ctx, payload) {
  const { stateDir, config, state } = ctx;
  const pack = getWritablePack(state, payload.packId);
  const packDef = getPackDef(ctx.manifest, pack.id);
  const gitWatch = checkExternalCommits(ctx, pack, packDef, payload.sha);
  if (gitWatch?.status === 'blocked') return buildNextDirective(ctx, pack, packDef);
  const changedFiles = readCommitFiles(state.repo_dir, payload.sha);

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

  // Advance to next unfinished pack
  const nextId = state.pack_order.find((id) => state.packs[id]?.status !== 'COMMITTED') || null;
  state.active_pack_id = nextId;
  state.loop_status = nextId ? 'RUNNING' : 'COMPLETED';
  saveState(stateDir, state);

  return {
    outcome: 'committed',
    committed_pack: pack.id,
    next_pack_id: nextId,
    loop_status: state.loop_status,
    ...(gitWatch && { git_watch: gitWatch }),
    ...(payload.fromGit && scanStrayFiles(ctx, pack, packDef, changedFiles))
  };
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

  appendEvent(stateDir, config, {
    type: 'gate_resumed',
    pack_id: pack.id,
    gate_reason: gateReason,
    action: act,
    decision: decision || '',
    switch_instance: instance || null
  });

  if (act === 'switch_instance' && (!instance || !config?.executors?.[instance])) {
    throw new Error(`Unknown executor instance "${instance}" in config.executors`);
  }
  if (['repair', 'retry', 'commit', 'switch_instance'].includes(act) && typeof decision === 'string' && decision.trim()) {
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

  if (act === 'switch_instance') {
    pack.active_instance = instance;
    invalidateSession(pack);
    pack.gate = null;
    pack.status = 'IMPLEMENT';
    saveState(stateDir, state);
    return { outcome: 'switched_instance', pack_id: pack.id, active_instance: instance };
  }

  if (act === 'repair' || act === 'retry') {
    pack.gate = null;
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

  if (approvedPosition) {
    pack.base_commit = approvedPosition.head;
    pack.base_branch = approvedPosition.branch;
    pack.status = prevGate.resume_status;
    pack.gate = prevGate.prior_gate ?? null;
    saveState(stateDir, state);
    return { outcome: 'approved', pack_id: pack.id, status: pack.status, base_commit: pack.base_commit };
  }

  // If resuming a preflight gate, re-check any remaining preflight gates (AMBIGUITY / EXTERNAL_EFFECT)
  const preflightGateReasons = new Set([
    ALLOWED_GATE_REASONS.BLAST_RADIUS_SPLIT,
    ALLOWED_GATE_REASONS.AMBIGUITY,
    ALLOWED_GATE_REASONS.EXTERNAL_EFFECT
  ]);
  if (prevGate?.reason && preflightGateReasons.has(prevGate.reason) && packDef) {
    pack.status = 'PENDING';
    saveState(stateDir, state);
    const nextDirective = startOrAdvanceActivePack(ctx);
    return {
      outcome: nextDirective.action === 'PAUSE_FOR_HUMAN' ? 'paused_next_gate' : 'approved',
      pack_id: pack.id,
      tier: pack.current_tier,
      active_instance: pack.active_instance,
      next: nextDirective
    };
  }

  pack.status = 'IMPLEMENT';
  saveState(stateDir, state);
  return { outcome: 'approved', pack_id: pack.id, tier: pack.current_tier, active_instance: pack.active_instance };
}

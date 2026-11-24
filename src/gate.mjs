/**
 * Human-in-the-loop Gate definitions & Approval Envelope enforcement.
 *
 * Core principle: strictly minimize human interruptions.
 * The loop may ONLY pause for human input on allowlisted gate reasons.
 */

export const ALLOWED_GATE_REASONS = Object.freeze({
  AMBIGUITY: 'AMBIGUITY',               // Unresolved requirement or contract ambiguity
  EXTERNAL_EFFECT: 'EXTERNAL_EFFECT',   // Real external message, production write, billing side-effect
  EXTERNAL_COMMIT: 'EXTERNAL_COMMIT',   // External commit touched current or completed pack files
  BLAST_RADIUS_SPLIT: 'BLAST_RADIUS_SPLIT', // Pack exceeds safe size threshold; human decides split vs approve
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',   // Tier 1 (2) + Tier 2 (2) repairs exhausted
  REVIEW_CAP_REACHED: 'REVIEW_CAP_REACHED', // 2 closing review rounds failed with BLOCKER/HIGH
  INFRA_BLOCKED: 'INFRA_BLOCKED',       // Quota exhausted (429), auth expired, missing CLI
  EXECUTOR_BLOCKED: 'EXECUTOR_BLOCKED', // Executor reported that the package goal is unfinished
  RELEASE: 'RELEASE'                    // Push, merge to main branch, deploy
});

export function isAllowedGateReason(reason) {
  return Boolean(reason && ALLOWED_GATE_REASONS[reason]);
}

export function createGate(reason, summary, options = {}) {
  if (!isAllowedGateReason(reason)) {
    throw new Error(
      `Disallowed human pause reason "${reason}". Allowed gates: ${Object.keys(ALLOWED_GATE_REASONS).join(', ')}`
    );
  }
  return {
    reason,
    summary,
    questions: options.questions || [],
    recommended_action: options.recommended_action || null,
    allowed_resume_actions: options.allowed_resume_actions || ['approve', 'abort'],
    created_at: new Date().toISOString()
  };
}

/**
 * Check whether an explicit external action is forbidden by the Approval Envelope.
 */
export function checkApprovalEnvelope(config, actionType) {
  const envelope = config?.approval_envelope || {};
  const forbidden = new Set(envelope.require_human_for || [
    'git_push',
    'branch_merge',
    'deploy',
    'external_message',
    'production_write',
    'global_config_edit'
  ]);
  if (forbidden.has(actionType)) {
    return {
      allowed: false,
      gate_reason: actionType === 'git_push' || actionType === 'branch_merge' || actionType === 'deploy'
        ? ALLOWED_GATE_REASONS.RELEASE
        : ALLOWED_GATE_REASONS.EXTERNAL_EFFECT,
      message: `Action "${actionType}" is blocked by the Approval Envelope and requires explicit human authorization.`
    };
  }
  return { allowed: true };
}

import path from 'node:path';
import { writeDryRunReceipt, writeRunResult } from './base.mjs';

/**
 * Built-in "self" adapter: the active host harness (Codex, Antigravity,
 * Claude Code, Cursor, DSH, etc.) executes the task directly without
 * spawning a nested CLI. Zero external dependencies; always available.
 */
export const selfAdapter = {
  kind: 'self',

  async probe(instanceId) {
    return {
      instance_id: instanceId,
      kind: 'self',
      available: true,
      cli_version: 'host-harness',
      auth_status: 'not_applicable',
      account_hint: 'active_host_session',
      capabilities: {
        read_only: true,
        resume: true,
        jsonl: false,
        sandbox: 'host-native'
      },
      latency_ms: 0,
      error: null
    };
  },

  async dryRun({ instanceId, runDir, taskFilePath, stage, readOnly, redactor }) {
    return writeDryRunReceipt(
      runDir,
      {
        instance_id: instanceId,
        kind: 'self',
        stage,
        read_only: Boolean(readOnly),
        task_file: taskFilePath,
        note: 'Host harness executes task directly; no subprocess spawned.'
      },
      redactor
    );
  },

  async run({ instanceId, cfg, runDir, taskFilePath, stage, readOnly, redactor, startedAt }) {
    return writeRunResult(
      runDir,
      {
        instance_id: instanceId,
        kind: 'self',
        stage,
        read_only: Boolean(readOnly),
        status: 'host_action_required',
        task_file: path.resolve(taskFilePath),
        started_at: startedAt,
        elapsed_seconds: null,
        executor_tool: 'self',
        executor_model: cfg?.model ?? null,
        executor_effort: cfg?.reasoning_effort ?? null,
        infra_error: null,
        note: `Host harness should execute instructions in ${taskFilePath}, then call "grow-loop record ${stage === 'review' ? 'review' : 'implement'} ...".`
      },
      redactor
    );
  }
};

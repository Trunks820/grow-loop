import { getAdapter } from './adapters/index.mjs';
import { runBoundedCommand } from './adapters/base.mjs';
import { appendEvent, getStatePaths, writeJsonAtomic } from './state.mjs';
import { buildRedactor } from './redact.mjs';

/**
 * Instance-level capability discovery via bounded read-only probes.
 * Inspired by T3 Code's probe-first discovery, strictly enforcing Zero-Custody Auth:
 * never reads credential files, never executes paid LLM turns during probe.
 */
export async function probeAllInstances(ctx, options = {}) {
  const { stateDir, config } = ctx;
  const timeoutMs = options.timeoutMs ?? config?.probe?.timeout_ms ?? 8000;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const executors = config?.executors || { self: { kind: 'self' } };

  const results = [];
  for (const [instanceId, instanceCfg] of Object.entries(executors)) {
    const adapter = getAdapter(instanceCfg?.kind || 'self');
    const raw = await adapter.probe(instanceId, instanceCfg || {}, { timeoutMs });
    results.push(redactor.redactValue(raw));
  }

  // Optional code intelligence hook probe (e.g., codegraph or gitnexus)
  let codeIntel = { tool: 'none', available: false, status: 'disabled' };
  const intelCfg = config?.code_intel || { tool: 'none' };
  if (intelCfg.tool && intelCfg.tool !== 'none') {
    const cmd = intelCfg.executable || intelCfg.tool;
    const probeRes = await runBoundedCommand(cmd, intelCfg.probe_args || ['--version'], {
      timeoutMs
    });
    codeIntel = redactor.redactValue({
      tool: intelCfg.tool,
      available: probeRes.ok,
      status: probeRes.ok ? 'ready' : 'unavailable_graceful_skip',
      version: probeRes.ok ? (probeRes.stdout || probeRes.stderr).trim().split(/\r?\n/)[0].slice(0, 120) : null,
      error: probeRes.ok ? null : (probeRes.timedOut ? 'probe_timeout' : 'not_installed')
    });
  }

  const report = {
    probed_at: new Date().toISOString(),
    zero_custody_notice: 'Probes inspect local CLI presence/status only. No credential files read; no paid LLM calls made. Probe OK does not guarantee server quota.',
    instances: results,
    code_intel: codeIntel
  };

  const { probeCachePath } = getStatePaths(stateDir);
  writeJsonAtomic(probeCachePath, report);
  appendEvent(stateDir, config, {
    type: 'probe_completed',
    available_instances: results.filter((r) => r.available).map((r) => r.instance_id),
    unavailable_instances: results.filter((r) => !r.available).map((r) => ({ id: r.instance_id, error: r.error })),
    code_intel: codeIntel
  });

  return report;
}

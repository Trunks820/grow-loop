import { selfAdapter } from './self.mjs';
import { codexAdapter } from './codex.mjs';
import { claudeAdapter } from './claude.mjs';
import { dshAdapter } from './dsh.mjs';
import { customCmdAdapter } from './custom-cmd.mjs';

const REGISTRY = new Map([
  ['self', selfAdapter],
  ['codex', codexAdapter],
  ['claude', claudeAdapter],
  ['dsh', dshAdapter],
  ['custom-cmd', customCmdAdapter]
]);

export function getAdapter(kind) {
  const adapter = REGISTRY.get(String(kind || 'self').toLowerCase());
  if (!adapter) {
    throw new Error(`Unsupported executor adapter kind "${kind}". Supported: ${[...REGISTRY.keys()].join(', ')}`);
  }
  return adapter;
}

export function listAdapterKinds() {
  return [...REGISTRY.keys()];
}

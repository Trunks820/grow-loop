import fs from 'node:fs';
import path from 'node:path';
import { defaultRedactor } from './redact.mjs';
import { validateManifest } from './state.mjs';

const REPORT_FIELDS = ['valid', 'errors', 'requirements', 'criteria', 'work_entries', 'revision', 'limits'];
const PACK_ARRAYS = ['depends_on', 'acceptance_criteria', 'open_questions', 'external_effects', 'scope_files', 'tags'];

export function readHandoff(filePath, existingIds = []) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('--handoff must point to an existing JSON file.');
    if (error instanceof SyntaxError) throw new Error('--handoff must contain valid JSON. Convert an HTML plan with grow-me first.');
    throw error;
  }

  const isReport = input && REPORT_FIELDS.some((field) => Object.hasOwn(input, field));
  if (isReport) {
    const errors = input.errors ?? [];
    if (!Array.isArray(errors)) throw new Error('Handoff validation output must have an errors array.');
    if (input.valid !== true || errors.length) {
      const messages = errors.map((error) => typeof error === 'string'
        ? defaultRedactor.redactString(error)
        : JSON.stringify(defaultRedactor.redactValue(error)));
      throw new Error(`Handoff validation failed:\n- ${messages.join('\n- ') || 'Expected valid: true.'}`);
    }
  } else if (!input || !Object.hasOwn(input, 'project') || !Object.hasOwn(input, 'upstream_source')) {
    throw new Error('--handoff requires a grow-me task.manifest.json or validate-task.mjs --handoff output.');
  }
  validateManifest(input);

  const knownIds = new Set([...existingIds, ...input.packs.map(({ id }) => id)]);

  const fileName = path.basename(filePath);
  const fallbackSource = input.revision == null ? fileName : `${fileName} (revision ${input.revision})`;
  const { project = path.parse(fileName).name, upstream_source = fallbackSource } = input;
  const source = upstream_source ?? fallbackSource;
  const sourceRef = typeof source === 'string' ? source : JSON.stringify(source);
  const packs = input.packs.map((entry) => {
    const { id, title, goal } = entry;
    const label = `Pack ${defaultRedactor.redactString(id)}`;
    const fields = Object.fromEntries(PACK_ARRAYS.map((field) => {
      const value = ['scope_files', 'tags'].includes(field) ? entry[field] ?? [] : entry[field];
      if (value != null && !Array.isArray(value)) throw new Error(`${label} must have an array for ${field}.`);
      return [field, value];
    }));
    for (const dep of fields.depends_on ?? []) {
      if (typeof dep !== 'string') throw new Error(`${label} must list pack IDs in depends_on.`);
      if (!knownIds.has(dep)) throw new Error(`${label} depends on unknown pack ${defaultRedactor.redactString(dep)}.`);
    }
    const pack = { id, title, goal, ...fields, upstream_ref: `${sourceRef}#${id}`, handoff: { source } };
    pack.handoff.needs = handoffNeeds(pack);
    return pack;
  });
  const manifest = { project, upstream_source, packs };
  validateManifest(manifest);
  return manifest;
}

function hasTextEntries(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
}

export function handoffNeeds(pack) {
  const needs = [];
  if (!pack?.handoff) return needs;
  if (!hasTextEntries(pack.scope_files)) needs.push('scope_files');
  if (!['low', 'medium', 'high'].includes(pack.risk)) needs.push('risk');
  if (!hasTextEntries(pack.tags)) needs.push('tags');
  return needs;
}

export function handoffFillSteps(needs) {
  return [
    'Edit the listed fields in the workspace manifest.json. Set risk to low, medium, or high and use non-empty arrays for scope_files and tags.',
    'Run: grow-loop manifest-ack --reason "<reason>"',
    ...(needs.includes('scope_files') ? ['To add scope files via the CLI, run: grow-loop pack scope --id <ID> --add <file> --reason "<reason>"'] : [])
  ];
}

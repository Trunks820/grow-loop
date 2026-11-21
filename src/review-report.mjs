export const BLOCKING_REVIEW_SEVERITIES = ['BLOCKER', 'HIGH'];
const REVIEW_SEVERITIES = [...BLOCKING_REVIEW_SEVERITIES, 'MEDIUM', 'LOW'];

// Some V8 SyntaxErrors omit the offset and include excerpts of the input.
// Scan the JSON grammar in that case so diagnostics can give a location without echoing the report.
function locateInvalidJson(json) {
  const whitespace = /[ \t\r\n]*/y;
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/y;
  const primitive = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const pending = ['end', 'value'];
  let offset = 0;

  while (pending.length) {
    whitespace.lastIndex = offset;
    whitespace.exec(json);
    offset = whitespace.lastIndex;
    const expected = pending.pop();
    const char = json[offset];

    if (expected === 'value' && (char === '[' || char === '{')) {
      offset++;
      pending.push(char === '[' ? 'array start' : 'object start');
    } else if (expected === 'value' || expected === 'key') {
      const pattern = expected === 'key' || char === '"' ? string : primitive;
      pattern.lastIndex = offset;
      if (!pattern.exec(json)) return offset;
      offset = pattern.lastIndex;
    } else if (expected === ':' && char === ':') {
      offset++;
    } else if (expected === 'end') {
      return offset;
    } else if (expected === 'array start' || expected === 'array rest') {
      if (char === ']') offset++;
      else {
        if (expected === 'array rest' && json[offset++] !== ',') return offset - 1;
        pending.push('array rest', 'value');
      }
    } else if (expected === 'object start' || expected === 'object rest') {
      if (char === '}') offset++;
      else {
        if (expected === 'object rest' && json[offset++] !== ',') return offset - 1;
        pending.push('object rest', 'value', ':', 'key');
      }
    } else {
      return offset;
    }
  }
  return offset;
}

/** Parse the Markdown format emitted by the closing review task. */
export function parseReviewReport(markdown) {
  const lines = markdown.split(/\r\n|\n|\r/);
  const verdictLines = [];
  const jsonBlocks = [];
  let fence = null;

  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*?)\s*$/);
    if (fence) {
      if (marker && !marker[2] && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length) {
        fence.end = index;
        fence = null;
      }
    } else if (marker) {
      fence = { marker: marker[1], start: index };
      if (marker[2].trim().toLowerCase() === 'json') jsonBlocks.push(fence);
    } else if (/^\s*(?:\*\*)?VERDICT\s*:/.test(line)) {
      const match = line.match(/^\s*(\*\*)?VERDICT\s*:\s*(PASS|FAIL)\1\s*$/);
      verdictLines.push({ line: index + 1, verdict: match?.[2] });
    }
  }

  const errors = [];
  if (!verdictLines.length) errors.push('VERDICT line: expected a standalone VERDICT: PASS or VERDICT: FAIL.');
  for (const [index, entry] of verdictLines.entries()) {
    if (index > 0) errors.push(`Line ${entry.line}, VERDICT: duplicate conclusion.`);
    if (!entry.verdict) errors.push(`Line ${entry.line}, VERDICT: expected VERDICT: PASS or VERDICT: FAIL.`);
  }

  if (!jsonBlocks.length) return { errors: [...errors, 'JSON block: expected one fenced json code block.'] };
  for (const block of jsonBlocks.slice(1)) errors.push(`Line ${block.start + 1}, JSON block: only one block is allowed.`);
  const { start, end } = jsonBlocks[0];
  if (end === undefined) return { errors: [...errors, `Line ${start + 1}, JSON block: missing closing fence.`] };
  const conclusion = verdictLines[0];
  if (conclusion && conclusion.line > start + 1) {
    errors.push(`Line ${conclusion.line}, VERDICT: place the conclusion before the JSON block.`);
  }

  const json = lines.slice(start + 1, end).join('\n');
  let data;
  try {
    data = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const position = error.message.match(/\bat position (\d+)(?: \(line \d+ column \d+\))?$/);
    const offset = position ? Number(position[1]) : locateInvalidJson(json);
    const preceding = json.slice(0, offset).split('\n');
    return { errors: [...errors, `Line ${start + 1 + preceding.length}, column ${preceding.at(-1).length + 1}, JSON block: invalid JSON syntax.`] };
  }

  const location = `JSON block at line ${start + 1}`;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: [...errors, `${location}: expected a JSON object.`] };
  }
  const verdict = typeof data.verdict === 'string' ? data.verdict.toUpperCase() : null;
  if (verdict !== 'PASS' && verdict !== 'FAIL') {
    errors.push(`${location}, verdict: expected "pass" or "fail".`);
  } else if (conclusion?.verdict && conclusion.verdict !== verdict) {
    errors.push(`${location}, verdict: disagrees with VERDICT on line ${conclusion.line}.`);
  }
  if (data.summary !== undefined && typeof data.summary !== 'string') errors.push(`${location}, summary: expected a string.`);
  if (!Array.isArray(data.findings)) return { errors: [...errors, `${location}, findings: expected an array.`] };

  const findings = data.findings.map((finding, index) => {
    const fieldLocation = `${location}, finding ${index + 1}`;
    const severity = typeof finding?.severity === 'string' ? finding.severity.toUpperCase() : null;
    const title = typeof finding?.title === 'string' ? finding.title.trim() : '';
    if (!REVIEW_SEVERITIES.includes(severity)) errors.push(`${fieldLocation}, severity: expected BLOCKER, HIGH, MEDIUM, or LOW.`);
    if (!title) errors.push(`${fieldLocation}, title: expected a non-empty string.`);
    const normalized = { severity, title };
    for (const field of ['locator', 'detail', 'rule']) {
      if (finding?.[field] === undefined) continue;
      if (typeof finding[field] === 'string') normalized[field] = finding[field];
      else errors.push(`${fieldLocation}, ${field}: expected a string.`);
    }
    return normalized;
  });

  const blockingIndex = findings.findIndex(({ severity }) => BLOCKING_REVIEW_SEVERITIES.includes(severity));
  if (verdict === 'FAIL' && blockingIndex === -1) errors.push(`${location}, findings: FAIL requires at least one BLOCKER or HIGH finding.`);
  if (verdict === 'PASS' && blockingIndex !== -1) errors.push(`${location}, finding ${blockingIndex + 1}, severity: PASS cannot include BLOCKER or HIGH findings.`);
  return errors.length ? { errors } : { verdict, summary: data.summary ?? '', findings };
}

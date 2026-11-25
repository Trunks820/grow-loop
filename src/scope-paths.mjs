import path from 'node:path';

export function repoRelativePath(file, repoDir) {
  const slashes = file.replaceAll('\\', '/');
  let relative = slashes;
  if (repoDir && path.isAbsolute(slashes)) {
    relative = path.relative(repoDir, slashes);
  } else if (repoDir && path.win32.isAbsolute(repoDir) && path.win32.isAbsolute(slashes)) {
    relative = path.win32.relative(repoDir, slashes);
  }
  const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
  return normalized === '..' || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) ? null : normalized;
}

export function hasGlob(file) {
  return /[*?\[]/.test(file);
}

const namedClasses = new Map(Object.entries({
  alnum: '0-9A-Za-z', alpha: 'A-Za-z', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9', graph: '!-~', lower: 'a-z', print: ' -~', punct: '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e',
  space: ' \\t-\\r', upper: 'A-Z', xdigit: '0-9A-Fa-f'
}));

function classByte(char) {
  return '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0');
}

function characterClass(pattern, start) {
  const negated = pattern[start] === '!' || pattern[start] === '^';
  let end = negated ? start + 1 : start;
  let contents = '';
  let previous = '';
  // The first closing bracket can itself be a member, as in []a].
  do {
    const char = pattern[end];
    if (char === undefined) return null;
    const named = char === '[' && /^\[:([^\]]*):\]/.exec(pattern.slice(end));
    if (named) {
      const range = namedClasses.get(named[1]);
      if (!range) return null;
      contents += range;
      end += named[0].length;
      previous = '';
    } else if (char === '-' && previous && pattern[end + 1] && pattern[end + 1] !== ']') {
      const upper = pattern[end + 1];
      if (previous <= upper) contents += classByte(previous) + '-' + classByte(upper);
      end += 2;
      previous = '';
    } else {
      contents += classByte(char);
      end++;
      previous = char;
    }
  } while (pattern[end] !== ']');
  return { source: `(?!/)[${negated ? '^' : ''}${contents}]`, end };
}

// Git wildmatch applies '?' and bracket expressions to individual UTF-8 bytes.
const utf8Bytes = (value) => Buffer.from(value, 'utf8').toString('latin1');

function globExpression(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      let end = index + 1;
      while (pattern[end] === '*') end++;
      const recursive = end - index >= 2 && (index === 0 || pattern[index - 1] === '/')
        && (end === pattern.length || pattern[end] === '/');
      if (recursive && pattern[end] === '/') {
        source += '(?:[^/]+/)*';
        end++;
      } else {
        source += recursive ? '[\\s\\S]*' : '[^/]*';
      }
      index = end - 1;
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const bracket = characterClass(pattern, index + 1);
      if (!bracket) return null;
      source += bracket.source;
      index = bracket.end;
    } else {
      source += /[.+^$(){}|\]]/.test(char) ? '\\' + char : char;
    }
  }
  return new RegExp(source + '$');
}

export function scopeMatcher(repoDir, files) {
  const literals = new Set();
  const globs = [];
  for (const file of files) {
    if (typeof file !== 'string' || !file.trim()) continue;
    const relative = repoRelativePath(file, repoDir);
    if (relative === null) continue;
    if (hasGlob(relative)) {
      const pattern = utf8Bytes(relative);
      // Git also accepts a glob pathspec as a literal path or directory prefix.
      const prefix = pattern.endsWith('/') ? pattern : pattern + '/';
      globs.push({ pattern, prefix, expression: globExpression(pattern) });
    } else {
      literals.add(relative);
    }
  }
  return {
    has(file) {
      const relative = repoRelativePath(file, repoDir);
      if (relative === null) return false;
      if (literals.has(relative)) return true;
      if (!globs.length) return false;
      const bytes = utf8Bytes(relative);
      return globs.some(({ pattern, prefix, expression }) =>
        bytes === pattern || bytes.startsWith(prefix) || expression?.test(bytes));
    }
  };
}

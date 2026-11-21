import { execFileSync } from 'node:child_process';
import path from 'node:path';

const globChars = /[*?\[\]{}]/;
const inlineCode = /`([^`\r\n]+)`/g;
const namedIdentifier = /(?<![\w$])[A-Za-z_$][\w$]*(?:[a-z0-9][A-Z]|_[A-Za-z0-9])[\w$]*/;
const call = /(?<![\w$])([A-Za-z_$][\w$]*)\(/;
const qualifiedName = /(?<![\w$])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/;
const commonNames = new Set(['main', 'init', 'test', 'setup']);

export function namesCode(hint) {
  return [...hint.matchAll(inlineCode)].some((match) => match[1].trim()) ||
    qualifiedName.test(hint) || /[\w/-]+\.[A-Za-z0-9]+\b/.test(hint) ||
    namedIdentifier.test(hint) || call.test(hint);
}

function functionNames(hint) {
  const names = Array.from(hint.matchAll(new RegExp(call, 'g')), (match) => match[1]);
  const prose = hint.replace(inlineCode, (_, code) => {
    const symbol = code.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(symbol)) names.push(symbol);
    else if (/^[\w$.]+$/.test(symbol) && namedIdentifier.test(symbol.split('.').at(-1))) {
      names.push(symbol.split('.').at(-1));
    }
    return ' ';
  });
  // Ignore file references before looking for unquoted camelCase and snake_case names.
  const text = prose.replace(/[\w./\\-]+\.[A-Za-z0-9]+\b/g, ' ');
  names.push(...Array.from(text.matchAll(new RegExp(namedIdentifier, 'g')), (match) => match[0]));
  return names.filter((name) => name.length >= 4 && !commonNames.has(name));
}

function repoPath(repoDir, file) {
  const normalized = path.posix.normalize((path.isAbsolute(file) ? path.relative(repoDir, file) : file).replace(/\\/g, '/'));
  return normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized) ? null : normalized;
}

export function scanReferences(repoDir, stateDir, { scope_files = [], co_change_files = [], pitfalls = [] }) {
  const normalizeFiles = (files) => (Array.isArray(files) ? files : [])
    .filter((file) => typeof file === 'string' && file.trim())
    .map((file) => repoPath(repoDir, file))
    .filter(Boolean);
  const scope = normalizeFiles(scope_files);
  const coChange = normalizeFiles(co_change_files);
  const terms = new Map();
  for (const file of scope) {
    if (globChars.test(file)) continue;
    const basename = path.posix.basename(file);
    const extension = path.posix.extname(basename);
    if (extension && basename.length >= 4) terms.set(basename, false);
    if (extension === '.py') {
      const module = file.slice(0, -extension.length).replaceAll('/', '.');
      if (module.length >= 4) terms.set(module, false);
    }
  }
  for (const hint of Array.isArray(pitfalls) ? pitfalls : []) {
    if (typeof hint !== 'string') continue;
    for (const name of functionNames(hint)) {
      if (!terms.has(name)) terms.set(name, true);
    }
  }

  const statePath = repoPath(repoDir, path.resolve(stateDir));
  const exclusions = [...new Set([...scope, ...coChange])].map((file) =>
    globChars.test(file) ? `:(exclude,glob)${file}` : `:(exclude,literal)${file}`
  );
  if (statePath && statePath !== '.') exclusions.push(`:(exclude,literal)${statePath.replace(/\/$/, '')}/`);

  const options = {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5000
  };
  const matches = new Map();
  try {
    const insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], options).trim();
    if (insideWorkTree !== 'true') return { skipped: '当前目录不是 Git 工作树' };
    for (const [term, wholeWord] of terms) {
      const args = ['grep', '--untracked', '--exclude-standard', '-l', '-z', '-F', '-I'];
      if (wholeWord) args.push('-w');
      let output;
      try {
        output = execFileSync('git', [...args, '-e', term, '--', '.', ...exclusions], options);
      } catch (error) {
        if (error.status === 1) continue;
        throw error;
      }
      for (const file of output.split('\0')) {
        if (!file) continue;
        const normalized = file.replace(/\\/g, '/');
        if (!matches.has(normalized)) matches.set(normalized, term);
        if (matches.size === 30) return { matches };
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { skipped: 'Git 不可用' };
    if (error.code === 'ETIMEDOUT') return { skipped: 'Git 扫描超时' };
    if (error.code === 'ENOBUFS') return { skipped: 'Git 扫描输出超出缓冲区' };
    if (String(error.stderr).includes('not a git repository')) return { skipped: '当前目录不是 Git 仓库' };
    return { skipped: 'Git 无法读取仓库或完成引用扫描' };
  }
  return { matches };
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { ALLOWED_GATE_REASONS, createGate } from './gate.mjs';
import { buildRedactor } from './redact.mjs';
import { scopeMatcher } from './scope-paths.mjs';
import { appendEvent, readEvents, saveState } from './state.mjs';

function git(cwd, args, input) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true
    });
  } catch {
    return null;
  }
}

const gitPaths = (output) => [...new Set(output.split('\0').filter(Boolean))];

function readWorktreeChanges(repoDir) {
  const output = git(repoDir, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (output === null) return null;

  // A staged deletion and an untracked replacement can have the same path.
  const entries = new Map(gitPaths(output).map((line) => [line.slice(3).replace(/\/$/, ''), line.slice(0, 2)]));
  return [...entries].map(([file, status]) => ({ path: file, status }));
}

function hashWorktreeChanges(repoDir, changes) {
  const snapshot = Object.fromEntries(changes.map(({ path: file }) => [file, null]));
  const files = [];
  try {
    for (const { path: file, status } of changes) {
      if (status.includes('D') && !status.includes('U')) continue;
      const fullPath = path.join(repoDir, file);
      const stat = lstatSync(fullPath, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isFile()) {
        files.push(file);
      } else if (stat.isSymbolicLink()) {
        // A Git symlink stores the link target's name. Leave the referenced file unread.
        snapshot[file] = createHash('sha256').update(readlinkSync(fullPath, { encoding: 'buffer' })).digest('hex');
      } else if (stat.isDirectory()) {
        // Gitlinks store the nested repository's commit ID.
        const head = git(fullPath, ['rev-parse', '--verify', 'HEAD'])?.trim();
        if (!head) return null;
        snapshot[file] = head;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  if (!files.length) return snapshot;

  // --stdin-paths accepts C-quoted names, including paths with embedded newlines.
  const input = files.map((file) => '"' + file.replace(/["\\\x00-\x1f]/g,
    (char) => '\\' + char.charCodeAt(0).toString(8).padStart(3, '0')) + '"').join('\n') + '\n';
  const hashes = git(repoDir, ['hash-object', '--no-filters', '--stdin-paths'], input)?.trim().split(/\r?\n/);
  if (hashes?.length !== files.length) return null;
  for (const [index, file] of files.entries()) snapshot[file] = hashes[index];
  return snapshot;
}

export function readWorktreeSnapshot(repoDir) {
  const changes = readWorktreeChanges(repoDir);
  return changes === null ? null : hashWorktreeChanges(repoDir, changes);
}

export function readGitPosition(repoDir) {
  const head = git(repoDir, ['rev-parse', '--verify', 'HEAD'])?.trim();
  if (!head) return null;
  const branch = git(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() || null;
  return { head, branch };
}

function commitFiles(repoDir, sha) {
  const output = git(repoDir, ['diff-tree', '--root', '--first-parent', '-m', '-r', '--no-renames', '--name-only',
    '--no-commit-id', '-z', sha, '--']);
  return output === null ? null : gitPaths(output);
}

function resolveCommit(repoDir, sha) {
  return git(repoDir, ['rev-parse', '--verify', '--end-of-options', sha + '^{commit}'])?.trim() || null;
}

function scopeFiles(repoDir, packDef, pack) {
  return scopeMatcher(repoDir, [packDef?.scope_files, packDef?.co_change_files]
    .flatMap((files) => Array.isArray(files) ? files : []), pack.approved_out_of_scope);
}

function isArtifact(file) {
  const name = path.posix.basename(file);
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|heic|log)$/i.test(name)
    || (/\.md$/i.test(name) && /report|summary|notes|draft|final/i.test(name));
}

function describeStrayArtifacts(ctx, pack, artifacts, committed) {
  if (!artifacts.length) return { stray_files: [] };
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  return redactor.redactValue({
    stray_files: artifacts.map((change) => ({ ...change, artifact: true })),
    stray_files_notice: committed
      ? '本次提交包含范围外的疑似产物。请核对是否应放到产物目录。'
      : '发现范围外的疑似产物。请在提交前移到产物目录，只暂存本包文件。',
    artifacts_dir: path.join(ctx.paths.artifactsDir, pack.id)
  });
}

function isStatePath(ctx, file) {
  const relative = path.relative(ctx.stateDir, path.resolve(ctx.state.repo_dir, file));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

export function scanOutOfScopeChanges(ctx, pack, packDef) {
  const repoDir = ctx.state.repo_dir;
  const changes = readWorktreeChanges(repoDir);
  const start = pack.start_worktree;
  let notice = start == null ? '开工时没记到工作区快照。' : '';
  if (changes === null) {
    return { files: null, notices: { worktree_notice: notice + '当前无法读取 Git 工作区，已跳过越界检查。' } };
  }

  const scope = scopeFiles(repoDir, packDef, pack);
  const stray = changes.filter(({ path: file }) => !scope.has(file) && !isStatePath(ctx, file));
  const candidates = stray.filter(({ path: file }) => !isArtifact(file));
  const current = start == null ? null : hashWorktreeChanges(repoDir,
    candidates.filter(({ path: file }) => Object.hasOwn(start, file)));
  if (current === null) {
    notice = (notice || '当前无法读取工作区内容哈希。') + '越界检查只按本包范围判断。';
  }
  const files = current === null ? candidates : candidates.filter(({ path: file }) =>
    !Object.hasOwn(start, file) || start[file] !== current[file]);
  const artifacts = stray.filter(({ path: file }) => isArtifact(file));
  return {
    files,
    notices: {
      ...(notice && { worktree_notice: notice }),
      ...(artifacts.length && describeStrayArtifacts(ctx, pack, artifacts, false))
    }
  };
}

export function scanCommitScope(ctx, pack, packDef, changedFiles) {
  const scope = scopeFiles(ctx.state.repo_dir, packDef, pack);
  const stray = (changedFiles ?? []).filter((file) => !scope.has(file));
  const files = stray.filter((file) => !isArtifact(file));
  const artifacts = stray.filter(isArtifact).map((file) => ({ path: file, status: 'committed' }));
  return { files, notices: describeStrayArtifacts(ctx, pack, artifacts, true) };
}

export function readGitHeadCommit(repoDir) {
  const position = readGitPosition(repoDir);
  if (!position) return null;
  const { head: sha } = position;
  const message = git(repoDir, ['show', '-s', '--format=%s', sha])?.trim();
  const stat = git(repoDir, ['show', '--shortstat', '--format=', sha]);
  if (message === undefined || stat === null) return null;
  return {
    sha, message,
    files: Number(stat.match(/(\d+)\s+files?\s+changed/)?.[1] || 0),
    insertions: Number(stat.match(/(\d+)\s+insertions?\(\+\)/)?.[1] || 0),
    deletions: Number(stat.match(/(\d+)\s+deletions?\(-\)/)?.[1] || 0)
  };
}

export function readCommitFiles(repoDir, sha) {
  const fullSha = /^[a-f0-9]{40,64}$/i.test(sha) ? sha : resolveCommit(repoDir, sha);
  return fullSha ? commitFiles(repoDir, fullSha) : null;
}

function skipped(message) {
  return { status: 'skipped', message };
}

export function checkExternalCommits(ctx, pack, packDef, recordingSha) {
  if (pack.gate?.reason === ALLOWED_GATE_REASONS.EXTERNAL_COMMIT) return { status: 'blocked' };
  const { state, stateDir, config, paths } = ctx;
  const repoDir = state.repo_dir;
  const position = readGitPosition(repoDir);
  if (!position) return skipped('跳过 Git 检查。Git 不可用、当前目录不是 Git 仓库，或仓库还没有 HEAD。');
  const { head, branch } = position;
  if (!pack.base_commit) {
    if (pack.started_at) {
      pack.base_commit = head;
      pack.base_branch = branch;
      pack.start_worktree ??= readWorktreeSnapshot(repoDir);
      saveState(stateDir, state);
    }
    return skipped('包开工时没有可用的 Git 基线。后续检查从当前 HEAD 起算。');
  }

  const range = git(repoDir, ['rev-list', '--reverse', pack.base_commit + '..' + head, '--']);
  if (range === null) return skipped('Git 无法读取包的基线到 HEAD 之间的提交。已跳过本次检查。');
  const completedCommits = Object.values(state.packs)
    .filter((item) => item.status === 'COMMITTED' && item.commit?.sha)
    .map(({ commit }) => commit);
  const known = new Set([...completedCommits.map(({ sha }) => sha), recordingSha].filter(Boolean)
    .map((sha) => /^[a-f0-9]{40,64}$/i.test(sha) ? sha.toLowerCase() : resolveCommit(repoDir, sha)));
  const external = range.trim().split(/\s+/).filter((sha) => sha && !known.has(sha));
  const branchChanged = pack.base_branch !== undefined && pack.base_branch !== branch;
  if (!external.length && !branchChanged) return null;
  const redactor = buildRedactor(config?.redaction?.extra_patterns || []);
  const details = redactor.redactValue({ base_commit: pack.base_commit, head, base_branch: pack.base_branch, branch });
  if (!external.length) return { status: 'notice', message: '当前分支与开工分支不同。', ...details };

  const commits = external.map((sha) => ({ sha, files: commitFiles(repoDir, sha) }));
  if (commits.some(({ files }) => files === null)) {
    return skipped('Git 无法列出外部提交改动的文件。已跳过本次检查。');
  }

  const protectedFiles = scopeFiles(repoDir, packDef, pack);
  const completedFiles = new Set();
  for (const commit of completedCommits) {
    const files = commit.changed_files ?? readCommitFiles(repoDir, commit.sha);
    for (const file of files ?? []) completedFiles.add(file);
  }
  const conflictingFiles = [...new Set(commits.flatMap(({ files }) =>
    files.filter((file) => protectedFiles.has(file) || completedFiles.has(file))))];
  if (conflictingFiles.length) {
    pack.gate = {
      ...createGate(ALLOWED_GATE_REASONS.EXTERNAL_COMMIT, '外部提交改动了本包范围或已完成包的文件。请核对后选择放行或终止。'),
      ...details,
      external_commits: redactor.redactValue(commits),
      conflicting_files: redactor.redactValue(conflictingFiles),
      resume_status: pack.status,
      ...(pack.gate && { prior_gate: pack.gate })
    };
    pack.status = 'PAUSED_FOR_HUMAN';
    saveState(stateDir, state);
    appendEvent(stateDir, config, {
      type: 'gate_paused', pack_id: pack.id, gate_reason: pack.gate.reason, summary: pack.gate.summary,
      ...details, external_commits: commits, conflicting_files: conflictingFiles
    });
    return { status: 'blocked' };
  }

  const warned = new Set(readEvents(paths.eventsPath).filter(({ type }) => type === 'external_commits_noticed')
    .flatMap((event) => event.commits.map(({ sha }) => sha)));
  const fresh = commits.filter(({ sha }) => !warned.has(sha));
  if (!fresh.length) return null;
  const notice = { status: 'notice', message: '发现外部提交，改动范围与本包及已完成包无交集，继续执行。',
    ...details, commits: redactor.redactValue(fresh) };
  appendEvent(stateDir, config, { type: 'external_commits_noticed', pack_id: pack.id, ...notice });
  return notice;
}

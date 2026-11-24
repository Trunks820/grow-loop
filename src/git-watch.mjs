import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ALLOWED_GATE_REASONS, createGate } from './gate.mjs';
import { buildRedactor } from './redact.mjs';
import { appendEvent, readEvents, saveState } from './state.mjs';

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
  } catch {
    return null;
  }
}

const gitPaths = (output) => [...new Set(output.split('\0').filter(Boolean))];

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

function scopeFiles(repoDir, packDef) {
  return new Set([packDef?.scope_files, packDef?.co_change_files]
    .flatMap((files) => Array.isArray(files) ? files : [])
    .filter((file) => typeof file === 'string' && file.trim())
    .map((file) => path.posix.normalize((path.isAbsolute(file) ? path.relative(repoDir, file) : file).replace(/\\/g, '/'))));
}

function isArtifact(file) {
  const name = path.posix.basename(file);
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|heic|log)$/i.test(name)
    || (/\.md$/i.test(name) && /report|summary|notes|draft|final/i.test(name));
}

export function scanStrayFiles(ctx, pack, packDef, committedFiles) {
  const repoDir = ctx.state.repo_dir;
  const scope = scopeFiles(repoDir, packDef);
  const committed = committedFiles !== undefined;
  const output = committed ? committedFiles : git(repoDir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (output === null) return { stray_files: [] };

  const changes = committed ? output.map((file) => ({ path: file, status: 'committed' }))
    : gitPaths(output).map((line) => ({ path: line.slice(3), status: line.slice(0, 2) }));
  const stray = changes.filter(({ path: file }) => !scope.has(file))
    .map((change) => ({ ...change, artifact: isArtifact(change.path) }))
    .filter(({ artifact }) => !committed || artifact);
  const redactor = buildRedactor(ctx.config?.redaction?.extra_patterns || []);
  return redactor.redactValue({
    stray_files: stray,
    ...(stray.some(({ artifact }) => artifact) && {
      stray_files_notice: committed
        ? '本次提交包含范围外的疑似产物。请核对是否应放到产物目录。'
        : '发现范围外的疑似产物。请在提交前移到产物目录，只暂存本包文件。',
      artifacts_dir: path.join(ctx.paths.artifactsDir, pack.id)
    })
  });
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

  const protectedFiles = scopeFiles(repoDir, packDef);
  for (const commit of completedCommits) {
    const files = commit.changed_files ?? readCommitFiles(repoDir, commit.sha);
    for (const file of files ?? []) protectedFiles.add(file);
  }
  const conflictingFiles = [...new Set(commits.flatMap(({ files }) => files.filter((file) => protectedFiles.has(file))))];
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

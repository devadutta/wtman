import path from 'node:path';
import { WtmanError, isCommandNotFound, isExitStatus } from './errors.js';

function trimTrailingNewline(value) {
  return value.replace(/\r?\n$/, '');
}

export async function gitOutput(runtime, args, { cwd = runtime.cwd } = {}) {
  try {
    const result = await runtime.git(args, { cwd });
    return trimTrailingNewline(result.stdout);
  } catch (error) {
    if (isCommandNotFound(error)) {
      throw new WtmanError('git is required but was not found on PATH');
    }

    throw error;
  }
}

export async function discoverRepo(runtime) {
  let currentRoot;

  try {
    currentRoot = await gitOutput(runtime, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if (isExitStatus(error, 128)) {
      throw new WtmanError('run wtman from inside a Git repository');
    }

    throw error;
  }

  const worktrees = await listWorktrees(runtime, { cwd: currentRoot });
  const primaryWorktree = worktrees[0]?.path || currentRoot;
  const repoName = path.basename(primaryWorktree);

  return {
    currentRoot,
    primaryWorktree,
    repoName,
    worktrees
  };
}

export async function listWorktrees(runtime, { cwd = runtime.cwd } = {}) {
  const output = await gitOutput(runtime, ['worktree', 'list', '--porcelain'], { cwd });
  return parseWorktreePorcelain(output);
}

export async function getWorktreeStatusEntries(runtime, worktreePath) {
  const output = await gitOutput(runtime, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath });
  return parseStatusPorcelain(output);
}

export async function getPullRequestsByBranch(runtime, repoRoot) {
  if (typeof runtime.gh !== 'function') {
    return new Map();
  }

  try {
    const result = await runtime.gh(
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '500',
        '--json',
        'number,url,state,mergedAt,closedAt,headRefName'
      ],
      { cwd: repoRoot }
    );

    return pullRequestsByBranch(parsePullRequests(result.stdout || '[]'));
  } catch {
    return new Map();
  }
}

export function parseWorktreePorcelain(output) {
  if (!output.trim()) {
    return [];
  }

  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const entry = {
        path: '',
        head: '',
        branch: '',
        detached: false,
        bare: false
      };

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          entry.path = line.slice('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          entry.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          const ref = line.slice('branch '.length);
          entry.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        } else if (line === 'detached') {
          entry.detached = true;
        } else if (line === 'bare') {
          entry.bare = true;
        }
      }

      return entry;
    })
    .filter((entry) => entry.path);
}

export function parseStatusPorcelain(output) {
  if (!output) {
    return [];
  }

  if (!output.includes('\0')) {
    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2),
        path: line.slice(3).replace(/^(.+) -> (.+)$/, '$2')
      }));
  }

  const fields = output.split('\0').filter(Boolean);
  const entries = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const status = field.slice(0, 2);

    entries.push({
      status,
      path: field.slice(3)
    });

    if (status[0] === 'R' || status[0] === 'C') {
      index += 1;
    }
  }

  return entries;
}

export function parsePullRequests(output) {
  const pullRequests = JSON.parse(output || '[]');

  if (!Array.isArray(pullRequests)) {
    return [];
  }

  return pullRequests
    .map((pullRequest) => {
      const branch = pullRequest.headRefName || '';

      if (!branch) {
        return null;
      }

      const state = pullRequest.mergedAt
        ? 'merged'
        : String(pullRequest.state || '').toLowerCase();

      return {
        branch,
        number: pullRequest.number,
        url: pullRequest.url || '',
        state,
        mergedAt: pullRequest.mergedAt || '',
        closedAt: pullRequest.closedAt || ''
      };
    })
    .filter(Boolean);
}

export function pullRequestsByBranch(pullRequests) {
  const byBranch = new Map();

  for (const pullRequest of pullRequests) {
    if (!byBranch.has(pullRequest.branch)) {
      byBranch.set(pullRequest.branch, pullRequest);
    }
  }

  return byBranch;
}

export async function branchExists(runtime, repoRoot, branchName) {
  try {
    await runtime.git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoRoot });
    return true;
  } catch (error) {
    if (isExitStatus(error, 1)) {
      return false;
    }

    throw error;
  }
}

export async function addWorktree(runtime, repoRoot, targetPath, branchName) {
  if (await branchExists(runtime, repoRoot, branchName)) {
    await runtime.git(['worktree', 'add', targetPath, branchName], { cwd: repoRoot });
    return;
  }

  await runtime.git(['worktree', 'add', '-b', branchName, targetPath, 'HEAD'], { cwd: repoRoot });
}

export function isDirtyWorktreeRemoveError(error) {
  const output = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n');
  return /contains modified or untracked files/i.test(output) && /--force/.test(output);
}

export async function removeWorktree(runtime, repoRoot, worktreePath, { force = false } = {}) {
  const args = ['worktree', 'remove'];

  if (force) {
    args.push('--force');
  }

  args.push(worktreePath);
  await runtime.git(args, { cwd: repoRoot });
  await runtime.fs.rm(worktreePath, { recursive: true, force: true });
}

export function isSamePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

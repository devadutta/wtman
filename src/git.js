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

export async function removeWorktree(runtime, repoRoot, worktreePath) {
  await runtime.git(['worktree', 'remove', worktreePath], { cwd: repoRoot });
}

export function isSamePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

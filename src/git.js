import path from 'node:path';
import { projectConfigDir } from './config.js';
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
  const output = await gitOutput(runtime, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], { cwd: worktreePath });
  return parseStatusPorcelain(output);
}

function pullRequestCachePath(runtime, repoName) {
  return path.join(projectConfigDir(runtime, repoName), 'pull-requests.json');
}

function normalizeCachedPullRequests(value) {
  const pullRequests = Array.isArray(value) ? value : value?.pullRequests;

  if (!Array.isArray(pullRequests)) {
    return null;
  }

  return pullRequests
    .map((pullRequest) => {
      const branch = pullRequest?.branch || '';

      if (!branch) {
        return null;
      }

      return {
        branch,
        number: pullRequest.number,
        url: pullRequest.url || '',
        state: pullRequest.state || '',
        mergedAt: pullRequest.mergedAt || '',
        closedAt: pullRequest.closedAt || ''
      };
    })
    .filter(Boolean);
}

async function readPullRequestCache(runtime, repoName) {
  if (!repoName) {
    return null;
  }

  try {
    const raw = await runtime.fs.readFile(pullRequestCachePath(runtime, repoName), 'utf8');
    return normalizeCachedPullRequests(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writePullRequestCache(runtime, repoName, pullRequests) {
  if (!repoName) {
    return;
  }

  try {
    const filePath = pullRequestCachePath(runtime, repoName);
    await runtime.fs.mkdir(path.dirname(filePath), { recursive: true });
    await runtime.fs.writeFile(filePath, `${JSON.stringify({ pullRequests }, null, 2)}\n`, 'utf8');
  } catch {
    // PR metadata is optional; cache write failures should not block worktree commands.
  }
}

async function fetchPullRequests(runtime, repoRoot) {
  if (typeof runtime.gh !== 'function') {
    return [];
  }

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

  return parsePullRequests(result.stdout || '[]');
}

export async function getPullRequestsByBranch(runtime, repoRoot, {
  repoName,
  refresh = false,
  useCacheOnRefreshFailure = true
} = {}) {
  const cachedPullRequests = await readPullRequestCache(runtime, repoName);

  if (!refresh && cachedPullRequests) {
    return pullRequestsByBranch(cachedPullRequests);
  }

  try {
    const pullRequests = await fetchPullRequests(runtime, repoRoot);
    await writePullRequestCache(runtime, repoName, pullRequests);
    return pullRequestsByBranch(pullRequests);
  } catch {
    if (refresh && useCacheOnRefreshFailure && cachedPullRequests) {
      return pullRequestsByBranch(cachedPullRequests);
    }

    if (!cachedPullRequests) {
      await writePullRequestCache(runtime, repoName, []);
    }

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

export async function latestHeadStartPoint(runtime, repoRoot) {
  let upstreamRef;

  try {
    upstreamRef = await gitOutput(runtime, ['rev-parse', '--symbolic-full-name', '@{upstream}'], { cwd: repoRoot });
  } catch (error) {
    if (isExitStatus(error, 128)) {
      return 'HEAD';
    }

    throw error;
  }

  if (!upstreamRef) {
    return 'HEAD';
  }

  if (upstreamRef.startsWith('refs/remotes/')) {
    await runtime.git(['fetch', '--prune'], { cwd: repoRoot });
  }

  return upstreamRef;
}

export async function addWorktree(runtime, repoRoot, targetPath, branchName, { useLatestHead = false } = {}) {
  if (await branchExists(runtime, repoRoot, branchName)) {
    await runtime.git(['worktree', 'add', targetPath, branchName], { cwd: repoRoot });
    return;
  }

  const startPoint = useLatestHead ? await latestHeadStartPoint(runtime, repoRoot) : 'HEAD';
  await runtime.git(['worktree', 'add', '-b', branchName, targetPath, startPoint], { cwd: repoRoot });
}

export function isDirtyWorktreeRemoveError(error) {
  const output = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n');
  return /contains modified or untracked files/i.test(output) && /--force/.test(output);
}

const DELETE_CONCURRENCY = 32;

async function mapWithConcurrency(items, limit, task) {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await task(item);
    }
  });

  await Promise.all(workers);
}

async function collectWorktreeEntries(runtime, worktreePath) {
  let pendingDirectories = [{ path: worktreePath, depth: 0 }];
  const files = [];
  const directories = [];
  let rootExists = true;

  while (pendingDirectories.length > 0) {
    const nextDirectories = [];

    await mapWithConcurrency(pendingDirectories, DELETE_CONCURRENCY, async (directory) => {
      let entries;

      try {
        entries = await runtime.fs.readdir(directory.path, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') {
          if (directory.depth === 0) {
            rootExists = false;
          }
          return;
        }

        throw error;
      }

      for (const entry of entries) {
        if (directory.depth === 0 && entry.name === '.git') {
          continue;
        }

        const entryPath = path.join(directory.path, entry.name);

        if (entry.isDirectory()) {
          const childDirectory = {
            path: entryPath,
            depth: directory.depth + 1
          };
          directories.push(childDirectory);
          nextDirectories.push(childDirectory);
        } else {
          files.push(entryPath);
        }
      }
    });

    pendingDirectories = nextDirectories;
  }

  return {
    rootExists,
    files,
    directories
  };
}

async function deleteEntries(runtime, entries, remove, onDeleted) {
  let firstError;

  await mapWithConcurrency(entries, DELETE_CONCURRENCY, async (entry) => {
    try {
      await remove(entry);
    } catch (error) {
      if (error.code !== 'ENOENT' && !firstError) {
        firstError = error;
      }
    } finally {
      onDeleted();
    }
  });

  if (firstError) {
    throw firstError;
  }
}

async function deleteWorktreeContents(runtime, inventory, onProgress) {
  const total = inventory.files.length + inventory.directories.length;
  let completed = 0;

  function report() {
    onProgress?.({ phase: 'deleting', completed, total });
  }

  report();
  await deleteEntries(
    runtime,
    inventory.files,
    (filePath) => runtime.fs.rm(filePath, { force: true }),
    () => {
      completed += 1;
      report();
    }
  );

  const directoriesByDepth = new Map();

  for (const directory of inventory.directories) {
    const atDepth = directoriesByDepth.get(directory.depth) || [];
    atDepth.push(directory);
    directoriesByDepth.set(directory.depth, atDepth);
  }

  const depths = [...directoriesByDepth.keys()].toSorted((left, right) => right - left);

  for (const depth of depths) {
    await deleteEntries(
      runtime,
      directoriesByDepth.get(depth),
      (directory) => runtime.fs.rmdir(directory.path),
      () => {
        completed += 1;
        report();
      }
    );
  }
}

export async function removeWorktree(runtime, repoRoot, worktreePath, { force = false, onProgress } = {}) {
  if (!force) {
    const statusEntries = await getWorktreeStatusEntries(runtime, worktreePath);

    if (statusEntries.length > 0) {
      const message = `'${worktreePath}' contains modified or untracked files, use --force to delete it`;
      const error = new Error(message);
      error.exitCode = 128;
      error.stderr = `fatal: ${message}\n`;
      throw error;
    }
  }

  onProgress?.({ phase: 'scanning', completed: 0, total: 0 });
  const inventory = await collectWorktreeEntries(runtime, worktreePath);

  if (inventory.rootExists) {
    try {
      await deleteWorktreeContents(runtime, inventory, onProgress);
    } catch {
      // Git's recursive removal remains the fallback for permissions and files
      // that appear while the worktree is being deleted.
    }
  }

  const total = inventory.files.length + inventory.directories.length;
  onProgress?.({ phase: 'metadata', completed: total, total });
  const args = ['worktree', 'remove'];

  if (force || inventory.rootExists) {
    args.push('--force');
  }

  args.push(worktreePath);
  await runtime.git(args, { cwd: repoRoot });
  await runtime.fs.rm(worktreePath, { recursive: true, force: true });
  onProgress?.({ phase: 'complete', completed: total, total });
}

export function isSamePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

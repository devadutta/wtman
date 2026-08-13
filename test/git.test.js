import assert from 'node:assert/strict';
import { afterAll, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePullRequests, parseStatusPorcelain, parseWorktreePorcelain, pullRequestsByBranch, removeWorktree } from '../src/git.js';

const cleanupDirectories = [];

afterAll(async () => {
  await Promise.all(cleanupDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test('parseWorktreePorcelain parses primary, branch, and detached entries', () => {
  const output = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /home/me/.worktrees/repo/feature
HEAD def456
branch refs/heads/feature

worktree /home/me/.worktrees/repo/detached
HEAD 000000
detached
`;

  assert.deepEqual(parseWorktreePorcelain(output), [
    {
      path: '/repo',
      head: 'abc123',
      branch: 'main',
      detached: false,
      bare: false
    },
    {
      path: '/home/me/.worktrees/repo/feature',
      head: 'def456',
      branch: 'feature',
      detached: false,
      bare: false
    },
    {
      path: '/home/me/.worktrees/repo/detached',
      head: '000000',
      branch: '',
      detached: true,
      bare: false
    }
  ]);
});

test('parseStatusPorcelain parses changed, untracked, and renamed entries', () => {
  const output = ` M package.json\0?? scratch.txt\0R  new-name.js\0old-name.js\0`;

  assert.deepEqual(parseStatusPorcelain(output), [
    {
      status: ' M',
      path: 'package.json'
    },
    {
      status: '??',
      path: 'scratch.txt'
    },
    {
      status: 'R ',
      path: 'new-name.js'
    }
  ]);
});

test('parsePullRequests normalizes open, closed, and merged states', () => {
  const pullRequests = parsePullRequests(JSON.stringify([
    {
      number: 1,
      url: 'https://example.test/1',
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      headRefName: 'feature'
    },
    {
      number: 2,
      url: 'https://example.test/2',
      state: 'CLOSED',
      mergedAt: null,
      closedAt: '2026-06-01T00:00:00Z',
      headRefName: 'closed'
    },
    {
      number: 3,
      url: 'https://example.test/3',
      state: 'CLOSED',
      mergedAt: '2026-06-01T00:00:00Z',
      closedAt: '2026-06-01T00:00:00Z',
      headRefName: 'merged'
    }
  ]));

  assert.deepEqual(pullRequests.map((pullRequest) => pullRequest.state), ['open', 'closed', 'merged']);
  assert.equal(pullRequestsByBranch(pullRequests).get('feature').number, 1);
});

test('removeWorktree deletes the worktree directory after git removes it', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wtman-git-test-'));
  cleanupDirectories.push(tempDir);

  const repoRoot = path.join(tempDir, 'repo');
  const worktreePath = path.join(tempDir, 'worktrees', 'feature');
  await fs.mkdir(path.join(worktreePath, 'nested'), { recursive: true });
  await fs.writeFile(path.join(worktreePath, '.git'), 'gitdir: /tmp/example\n');
  await fs.writeFile(path.join(worktreePath, 'nested', 'file.txt'), 'leftover\n');

  const gitCalls = [];
  const progress = [];
  const runtime = {
    fs,
    async git(args, options = {}) {
      gitCalls.push({ args, cwd: options.cwd });

      if (args[0] === 'status') {
        return { stdout: '', stderr: '' };
      }

      await fs.stat(path.join(worktreePath, '.git'));
      await assert.rejects(() => fs.stat(path.join(worktreePath, 'nested')), { code: 'ENOENT' });
      return { stdout: '', stderr: '' };
    }
  };

  await removeWorktree(runtime, repoRoot, worktreePath, {
    onProgress(update) {
      progress.push(update);
    }
  });

  assert.deepEqual(gitCalls, [
    {
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      cwd: worktreePath
    },
    {
      args: ['worktree', 'remove', '--force', worktreePath],
      cwd: repoRoot
    }
  ]);
  assert.deepEqual([...new Set(progress.map((update) => update.phase))], [
    'scanning',
    'deleting',
    'metadata',
    'complete'
  ]);
  assert.deepEqual(progress.findLast((update) => update.phase === 'deleting'), {
    phase: 'deleting',
    completed: 2,
    total: 2
  });
  await assert.rejects(() => fs.stat(worktreePath), { code: 'ENOENT' });
});

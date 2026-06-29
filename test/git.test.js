import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorktreePorcelain, removeWorktree } from '../src/git.js';

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

test('removeWorktree deletes the worktree directory after git removes it', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wtman-git-test-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const repoRoot = path.join(tempDir, 'repo');
  const worktreePath = path.join(tempDir, 'worktrees', 'feature');
  await fs.mkdir(path.join(worktreePath, 'nested'), { recursive: true });
  await fs.writeFile(path.join(worktreePath, 'nested', 'file.txt'), 'leftover\n');

  const gitCalls = [];
  const runtime = {
    fs,
    async git(args, options = {}) {
      gitCalls.push({ args, cwd: options.cwd });
      return { stdout: '', stderr: '' };
    }
  };

  await removeWorktree(runtime, repoRoot, worktreePath);

  assert.deepEqual(gitCalls, [
    {
      args: ['worktree', 'remove', worktreePath],
      cwd: repoRoot
    }
  ]);
  await assert.rejects(() => fs.stat(worktreePath), { code: 'ENOENT' });
});

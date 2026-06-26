import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorktreePorcelain } from '../src/git.js';

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

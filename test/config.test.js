import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { defaultConfig, projectConfigPath, normalizeConfig, resolveWorktreeDir } from '../src/config.js';

test('default config uses repo-specific worktree directory', () => {
  assert.deepEqual(defaultConfig('app'), {
    worktreeDir: '~/.worktrees/app',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });
});

test('project config path is under config home and repo name', () => {
  const runtime = { configHome: '/tmp/config' };
  assert.equal(projectConfigPath(runtime, 'app'), path.join('/tmp/config', 'wtman', 'app', 'config.json'));
});

test('normalize config fills missing hook commands', () => {
  assert.deepEqual(normalizeConfig({ worktreeDir: '/worktrees' }, 'app'), {
    worktreeDir: '/worktrees',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });
});

test('resolveWorktreeDir expands home directory paths', () => {
  const runtime = { cwd: '/repo', homeDir: '/home/me' };
  assert.equal(resolveWorktreeDir(runtime, { worktreeDir: '~/.worktrees/app' }), path.join('/home/me', '.worktrees', 'app'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';
import { createWorktree, generateWorktreeName, removeProjectWorktree, startProjectWorktree, switchProjectWorktree } from '../src/commands.js';
import { readConfig, writeConfig } from '../src/config.js';

const PRIMARY_LIST = `worktree /repo
HEAD abc123
branch refs/heads/main
`;

const FEATURE_LIST = `${PRIMARY_LIST}
worktree /home/me/.worktrees/repo/feature
HEAD def456
branch refs/heads/feature
`;

async function makeTempRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wtman-test-'));
  let stdout = '';
  let stderr = '';
  const gitCalls = [];
  const shellCalls = [];
  const openShellCalls = [];
  const confirmCalls = [];
  const gitResponses = [...(options.gitResponses || [])];
  const promptAnswers = [...(options.promptAnswers || [])];
  const selectedValues = [...(options.selectedValues || [])];
  const confirmAnswers = [...(options.confirmAnswers || [])];

  const runtime = {
    cwd: options.cwd || '/repo',
    homeDir: options.homeDir || path.join(tempDir, 'home'),
    configHome: options.configHome || path.join(tempDir, 'config'),
    fs,
    env: { SHELL: '/bin/sh' },
    stdin: process.stdin,
    stdout: {
      write(chunk) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderr += String(chunk);
        return true;
      }
    },
    prompts: {
      async ask(label, { defaultValue = '', validate } = {}) {
        const next = promptAnswers.shift();
        const value = next === undefined || next === '' ? defaultValue : next;
        return validate ? validate(value) : value;
      },
      async confirm(label) {
        confirmCalls.push(label);
        return confirmAnswers.shift() || false;
      },
      async select(label, choices) {
        const next = selectedValues.shift();
        if (next !== undefined) {
          return next;
        }

        return choices[0].value;
      }
    },
    async git(args, options = {}) {
      gitCalls.push({ args, cwd: options.cwd });
      const next = gitResponses.shift();
      assert.ok(next, `unexpected git call: ${args.join(' ')}`);
      assert.deepEqual(args, next.args);

      if (next.cwd) {
        assert.equal(options.cwd, next.cwd);
      }

      if (next.error) {
        throw Object.assign(new Error(next.error.message || 'git failed'), next.error);
      }

      return {
        stdout: next.stdout || '',
        stderr: next.stderr || ''
      };
    },
    async shell(command, options = {}) {
      shellCalls.push({ command, cwd: options.cwd });
    },
    async openShell(options = {}) {
      openShellCalls.push({ cwd: options.cwd });
    }
  };

  return {
    runtime,
    tempDir,
    gitCalls,
    shellCalls,
    openShellCalls,
    confirmCalls,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    }
  };
}

test('help command writes usage without requiring git', async () => {
  const context = await makeTempRuntime();

  await run(['--help'], context.runtime);

  assert.match(context.stdout, /Usage:/);
  assert.match(context.stdout, /wtman new/);
  assert.match(context.stdout, /wtman switch/);
  assert.match(context.stdout, /wtman shell-init/);
  assert.equal(context.gitCalls.length, 0);
});

test('shell-init prints a shell function that wraps switch', async () => {
  const context = await makeTempRuntime();

  await run(['shell-init'], context.runtime);

  assert.match(context.stdout, /wtman\(\) \{/);
  assert.match(context.stdout, /command wtman --default-print-path/);
  assert.match(context.stdout, /command wtman switch --print-path/);
  assert.match(context.stdout, /command wtman new --write-path "\$wtman_target_file"/);
  assert.match(context.stdout, /cd "\$wtman_target"/);
  assert.equal(context.gitCalls.length, 0);
});

test('default command creates config on first run', async () => {
  const context = await makeTempRuntime({
    promptAnswers: ['~/.custom-worktrees/repo', 'npm install', 'npm run dev', 'npm run clean'],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: PRIMARY_LIST }
    ]
  });

  await run([], context.runtime);

  const saved = await readConfig(context.runtime, 'repo');
  assert.equal(saved.exists, true);
  assert.deepEqual(saved.config, {
    worktreeDir: '~/.custom-worktrees/repo',
    setupCommand: 'npm install',
    startCommand: 'npm run dev',
    cleanupCommand: 'npm run clean'
  });
  assert.match(context.stdout, /No wtman config found for repo/);
  assert.match(context.stdout, /Saved config for repo/);
});

test('default command switches worktrees after config exists', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await run([], context.runtime);

  assert.match(context.stdout, /Selected worktree: \/repo/);
  assert.match(context.stderr, /wtman shell-init/);
});

test('default print path outputs selected path when config exists', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await run(['--default-print-path'], context.runtime);

  assert.equal(context.stdout, '/repo\n');
});

test('default print path does not run setup when config is missing', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });

  await run(['--default-print-path'], context.runtime);

  assert.equal(context.stdout, '');
});

test('config command edits existing config', async () => {
  const context = await makeTempRuntime({
    promptAnswers: ['~/.edited/repo', '', 'npm start', ''],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: PRIMARY_LIST }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: 'npm install',
    startCommand: '',
    cleanupCommand: 'npm run clean'
  });

  await run(['config'], context.runtime);

  const saved = await readConfig(context.runtime, 'repo');
  assert.deepEqual(saved.config, {
    worktreeDir: '~/.edited/repo',
    setupCommand: 'npm install',
    startCommand: 'npm start',
    cleanupCommand: 'npm run clean'
  });
  assert.match(context.stdout, /Config:/);
  assert.match(context.stdout, /Saved config for repo/);
});

test('createWorktree creates a branch when it does not exist and runs setup command', async () => {
  const homeDir = path.join(os.tmpdir(), 'wtman-test-home');
  const context = await makeTempRuntime({
    homeDir,
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: PRIMARY_LIST },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/1-wt-repo'],
        cwd: '/repo',
        error: { exitCode: 1 }
      },
      {
        args: ['worktree', 'add', '-b', '1-wt-repo', path.join(homeDir, '.worktrees', 'repo', '1-wt-repo'), 'HEAD'],
        cwd: '/repo'
      }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: 'npm install',
    startCommand: '',
    cleanupCommand: ''
  });

  await createWorktree(context.runtime);

  assert.deepEqual(context.shellCalls, [
    {
      command: 'npm install',
      cwd: path.join(homeDir, '.worktrees', 'repo', '1-wt-repo')
    }
  ]);
  assert.match(context.stdout, /Using worktree name: 1-wt-repo/);
  assert.match(context.stdout, /Using branch name: 1-wt-repo/);
  assert.match(context.stdout, /Created worktree:/);
});

test('createWorktree reuses an existing branch', async () => {
  const homeDir = path.join(os.tmpdir(), 'wtman-test-home');
  const context = await makeTempRuntime({
    homeDir,
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: PRIMARY_LIST },
      { args: ['show-ref', '--verify', '--quiet', 'refs/heads/1-wt-repo'], cwd: '/repo' },
      {
        args: ['worktree', 'add', path.join(homeDir, '.worktrees', 'repo', '1-wt-repo'), '1-wt-repo'],
        cwd: '/repo'
      }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await createWorktree(context.runtime);

  assert.equal(context.shellCalls.length, 0);
  assert.match(context.stdout, /Created worktree:/);
});

test('createWorktree uses a requested name for both worktree and branch', async () => {
  const homeDir = path.join(os.tmpdir(), 'wtman-test-home');
  const context = await makeTempRuntime({
    homeDir,
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: PRIMARY_LIST },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/my-feature'],
        cwd: '/repo',
        error: { exitCode: 1 }
      },
      {
        args: ['worktree', 'add', '-b', 'my-feature', path.join(homeDir, '.worktrees', 'repo', 'my-feature'), 'HEAD'],
        cwd: '/repo'
      }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await createWorktree(context.runtime, { requestedName: 'my-feature' });

  assert.match(context.stdout, /Using worktree name: my-feature/);
  assert.match(context.stdout, /Using branch name: my-feature/);
});

test('new command can write created worktree path for shell integration', async () => {
  const homeDir = path.join(os.tmpdir(), 'wtman-test-home');
  const context = await makeTempRuntime({
    homeDir,
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: PRIMARY_LIST },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/my-feature'],
        cwd: '/repo',
        error: { exitCode: 1 }
      },
      {
        args: ['worktree', 'add', '-b', 'my-feature', path.join(homeDir, '.worktrees', 'repo', 'my-feature'), 'HEAD'],
        cwd: '/repo'
      }
    ]
  });
  const switchPathFile = path.join(context.tempDir, 'switch-path');
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await run(['new', '--write-path', switchPathFile, 'my-feature'], context.runtime);

  assert.equal(await fs.readFile(switchPathFile, 'utf8'), `${path.join(homeDir, '.worktrees', 'repo', 'my-feature')}\n`);
  assert.match(context.stdout, /Created worktree:/);
});

test('new command rejects more than one name argument', async () => {
  const context = await makeTempRuntime();

  await assert.rejects(
    () => run(['new', 'one', 'two'], context.runtime),
    /usage: wtman new \[name\]/
  );
  assert.equal(context.gitCalls.length, 0);
});

test('generateWorktreeName increments from matching worktree paths and branches', () => {
  assert.equal(
    generateWorktreeName('repo', [
      { path: '/repo', branch: 'main' },
      { path: '/home/me/.worktrees/repo/1-wt-repo', branch: '1-wt-repo' },
      { path: '/home/me/.worktrees/repo/2-wt-repo', branch: 'feature' }
    ]),
    '3-wt-repo'
  );
});

test('removeProjectWorktree runs cleanup command before removing selected worktree', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      {
        args: ['worktree', 'remove', '/home/me/.worktrees/repo/feature'],
        cwd: '/repo'
      }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: 'npm run clean'
  });

  await removeProjectWorktree(context.runtime);

  assert.deepEqual(context.shellCalls, [
    {
      command: 'npm run clean',
      cwd: '/home/me/.worktrees/repo/feature'
    }
  ]);
  assert.match(context.stdout, /Removed worktree:/);
});

test('removeProjectWorktree asks before force-removing a dirty worktree', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      {
        args: ['worktree', 'remove', '/home/me/.worktrees/repo/feature'],
        cwd: '/repo',
        error: {
          exitCode: 128,
          stderr: "fatal: '/home/me/.worktrees/repo/feature' contains modified or untracked files, use --force to delete it\n"
        }
      },
      {
        args: ['worktree', 'remove', '--force', '/home/me/.worktrees/repo/feature'],
        cwd: '/repo'
      }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await removeProjectWorktree(context.runtime);

  assert.deepEqual(context.confirmCalls, [
    'Worktree contains modified or untracked files. Force remove /home/me/.worktrees/repo/feature?'
  ]);
  assert.match(context.stdout, /Removed worktree:/);
});

test('removeProjectWorktree cancels when dirty worktree force removal is declined', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [false],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      {
        args: ['worktree', 'remove', '/home/me/.worktrees/repo/feature'],
        cwd: '/repo',
        error: {
          exitCode: 128,
          stderr: "fatal: '/home/me/.worktrees/repo/feature' contains modified or untracked files, use --force to delete it\n"
        }
      }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await removeProjectWorktree(context.runtime);

  assert.equal(context.gitCalls.length, 3);
  assert.match(context.stdout, /Removal cancelled\./);
});

test('startProjectWorktree runs configured start command in selected worktree', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: 'npm run dev',
    cleanupCommand: ''
  });

  await startProjectWorktree(context.runtime);

  assert.deepEqual(context.shellCalls, [
    {
      command: 'npm run dev',
      cwd: '/home/me/.worktrees/repo/feature'
    }
  ]);
});

test('switchProjectWorktree prints the selected worktree path', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });

  await switchProjectWorktree(context.runtime);

  assert.equal(context.openShellCalls.length, 0);
  assert.match(context.stdout, /Selected worktree: \/repo/);
  assert.match(context.stderr, /wtman shell-init/);
});

test('switch --print-path prints only the selected path to stdout', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });

  await run(['switch', '--print-path'], context.runtime);

  assert.equal(context.stdout, '/repo\n');
  assert.equal(context.openShellCalls.length, 0);
});

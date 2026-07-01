import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { run } from '../src/cli.js';
import { createWorktree, generateWorktreeName, removeProjectWorktree, startProjectWorktree, switchProjectWorktree } from '../src/commands.js';
import { readConfig, writeConfig } from '../src/config.js';

const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
const PR_LIST_ARGS = ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,url,state,mergedAt,closedAt,headRefName'];

const PRIMARY_LIST = `worktree /repo
HEAD abc123
branch refs/heads/main
`;

const FEATURE_LIST = `${PRIMARY_LIST}
worktree /home/me/.worktrees/repo/feature
HEAD def456
branch refs/heads/feature
`;

const MULTI_LIST = `${PRIMARY_LIST}
worktree /home/me/.worktrees/repo/old
HEAD 000001
branch refs/heads/old

worktree /home/me/.worktrees/repo/new
HEAD 000002
branch refs/heads/new
`;

async function makeTempRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wtman-test-'));
  let stdout = '';
  let stderr = '';
  const gitCalls = [];
  const ghCalls = [];
  const shellCalls = [];
  const openShellCalls = [];
  const confirmCalls = [];
  const selectCalls = [];
  const menuCalls = [];
  const gitResponses = [...(options.gitResponses || [])];
  const ghResponses = [...(options.ghResponses || [])];
  const promptAnswers = [...(options.promptAnswers || [])];
  const selectedValues = [...(options.selectedValues || [])];
  const menuResults = [...(options.menuResults || [])];
  const confirmAnswers = [...(options.confirmAnswers || [])];
  const statTimes = options.statTimes || {};

  function matchesGitResponse(response, args, cwd) {
    return response && isDeepStrictEqual(args, response.args) && (!response.cwd || response.cwd === cwd);
  }

  function defaultGitResponse(args) {
    if (isDeepStrictEqual(args, STATUS_ARGS)) {
      return {
        args: STATUS_ARGS,
        stdout: ''
      };
    }

    return null;
  }

  function defaultGhResponse(args) {
    if (isDeepStrictEqual(args, PR_LIST_ARGS)) {
      return {
        args: PR_LIST_ARGS,
        stdout: '[]'
      };
    }

    return null;
  }

  const runtimeFs = Object.assign(Object.create(fs), {
    async stat(filePath) {
      if (Object.hasOwn(statTimes, filePath)) {
        return {
          mtimeMs: statTimes[filePath]
        };
      }

      return fs.stat(filePath);
    }
  });

  const runtime = {
    cwd: options.cwd || '/repo',
    homeDir: options.homeDir || path.join(tempDir, 'home'),
    configHome: options.configHome || path.join(tempDir, 'config'),
    fs: runtimeFs,
    env: { SHELL: '/bin/sh', ...(options.env || {}) },
    now: options.now,
    stdin: process.stdin,
    stdout: {
      isTTY: options.stdoutIsTTY || false,
      write(chunk) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      isTTY: options.stderrIsTTY || false,
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
      async select(label, choices, options = {}) {
        selectCalls.push({ label, choices, options });
        const next = selectedValues.shift();
        if (next !== undefined) {
          return next;
        }

        return choices[0].value;
      },
      async worktreeMenu(label, choices, options = {}) {
        menuCalls.push({ label, choices, options });
        const next = menuResults.shift();
        if (next !== undefined) {
          return typeof next === 'function' ? next(choices) : next;
        }

        return { action: 'switch', value: choices[0].value };
      }
    },
    async git(args, options = {}) {
      gitCalls.push({ args, cwd: options.cwd });
      const next = matchesGitResponse(gitResponses[0], args, options.cwd) ? gitResponses.shift() : defaultGitResponse(args);
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
    async gh(args, options = {}) {
      ghCalls.push({ args, cwd: options.cwd });
      const next = matchesGitResponse(ghResponses[0], args, options.cwd) ? ghResponses.shift() : defaultGhResponse(args);
      assert.ok(next, `unexpected gh call: ${args.join(' ')}`);
      assert.deepEqual(args, next.args);

      if (next.cwd) {
        assert.equal(options.cwd, next.cwd);
      }

      if (next.error) {
        throw Object.assign(new Error(next.error.message || 'gh failed'), next.error);
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
    ghCalls,
    shellCalls,
    openShellCalls,
    confirmCalls,
    selectCalls,
    menuCalls,
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

test('default command can create a new worktree from the menu shortcut', async () => {
  const homeDir = path.join(os.tmpdir(), 'wtman-test-home');
  const context = await makeTempRuntime({
    homeDir,
    menuResults: [{ action: 'new' }],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
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
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await run([], context.runtime);

  assert.equal(context.menuCalls.length, 1);
  assert.match(context.stdout, /Created worktree:/);
});

test('default print path writes only the created worktree path for the new shortcut', async () => {
  const homeDir = path.join(os.tmpdir(), 'wtman-test-home');
  const targetPath = path.join(homeDir, '.worktrees', 'repo', '1-wt-repo');
  const context = await makeTempRuntime({
    homeDir,
    menuResults: [{ action: 'new' }],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      {
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/1-wt-repo'],
        cwd: '/repo',
        error: { exitCode: 1 }
      },
      {
        args: ['worktree', 'add', '-b', '1-wt-repo', targetPath, 'HEAD'],
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

  await run(['--default-print-path'], context.runtime);

  assert.equal(context.stdout, `${targetPath}\n`);
  assert.match(context.stderr, /Created worktree:/);
});

test('default print path keeps remove shortcut messages off stdout', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true],
    menuResults: [
      (choices) => ({ action: 'remove', value: choices[1].value })
    ],
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
    cleanupCommand: ''
  });

  await run(['--default-print-path'], context.runtime);

  assert.equal(context.stdout, '/repo\n');
  assert.match(context.stderr, /Removed worktree:/);
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

test('list command renders worktrees as a table', async () => {
  const context = await makeTempRuntime({
    homeDir: '/home/me',
    stdoutIsTTY: true,
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST },
      { args: STATUS_ARGS, cwd: '/repo', stdout: '' },
      { args: STATUS_ARGS, cwd: '/home/me/.worktrees/repo/feature', stdout: ' M package.json\0?? scratch.txt\0' }
    ]
  });

  await run(['list'], context.runtime);

  const lines = context.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^Modified\s+Folder\s+ Branch\s+PR\s+State\s+Changes$/);
  assert.match(lines[1], /^\?\s+repo\s+ main\s+0$/);
  assert.match(lines[2], /^\?\s+feature\s+ feature\s+\x1b\[31m2\x1b\[39m$/);
  assert.doesNotMatch(context.stdout, /\/home\/me|\.worktrees|\[primary\]||/);
});

test('list command renders linked pull request and state columns', async () => {
  const context = await makeTempRuntime({
    stdoutIsTTY: true,
    ghResponses: [
      {
        args: PR_LIST_ARGS,
        cwd: '/repo',
        stdout: JSON.stringify([
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            state: 'OPEN',
            mergedAt: null,
            closedAt: null,
            headRefName: 'feature'
          }
        ])
      }
    ],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });

  await run(['list'], context.runtime);

  assert.match(context.stdout, /#42/);
  assert.match(context.stdout, /open/);
  assert.match(context.stdout, /\x1b]8;;https:\/\/github\.com\/owner\/repo\/pull\/42/);
});

test('list command keeps main first and sorts branches by modified time', async () => {
  const now = new Date('2026-06-29T12:00:00Z');
  const context = await makeTempRuntime({
    homeDir: '/home/me',
    now: () => now,
    statTimes: {
      '/repo': now.getTime() - 7 * 24 * 60 * 60 * 1000,
      '/home/me/.worktrees/repo/old': now.getTime() - 24 * 60 * 60 * 1000,
      '/home/me/.worktrees/repo/new': now.getTime() - 60 * 60 * 1000
    },
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: MULTI_LIST }
    ]
  });

  await run(['list'], context.runtime);

  const lines = context.stdout.trimEnd().split('\n');
  assert.match(lines[1], /^7d ago\s+repo\s+ main\s+0$/);
  assert.match(lines[2], /^1h ago\s+new\s+ new\s+0$/);
  assert.match(lines[3], /^1d ago\s+old\s+ old\s+0$/);
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
    confirmAnswers: [true],
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
  assert.equal(context.selectCalls[0].label, 'Select a worktree to remove:');
  assert.match(context.selectCalls[0].options.header, /^Modified\s+Folder\s+ Branch\s+PR\s+State\s+Changes$/);
  assert.match(context.selectCalls[0].choices[0].label, /^\?\s+feature\s+ feature\s+0$/);
  assert.deepEqual(context.confirmCalls, [
    'Remove worktree /home/me/.worktrees/repo/feature?'
  ]);
  assert.match(context.stdout, /Removed worktree:/);
});

test('remove command removes a worktree by folder name without prompting for selection', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true],
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
    cleanupCommand: ''
  });

  await run(['remove', 'feature'], context.runtime);

  assert.equal(context.selectCalls.length, 0);
  assert.deepEqual(context.confirmCalls, [
    'Remove worktree /home/me/.worktrees/repo/feature?'
  ]);
  assert.match(context.stdout, /Removed worktree:/);
});

test('removeProjectWorktree asks before force-removing a dirty worktree', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true, true],
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
    'Remove worktree /home/me/.worktrees/repo/feature?',
    'Worktree contains modified or untracked files. Force remove /home/me/.worktrees/repo/feature?'
  ]);
  assert.match(context.stdout, /Removed worktree:/);
});

test('removeProjectWorktree cancels when dirty worktree force removal is declined', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true, false],
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

  assert.equal(context.gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove').length, 1);
  assert.match(context.stdout, /Removal cancelled\./);
});

test('clean command removes closed PR worktrees after confirmation', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true],
    ghResponses: [
      {
        args: PR_LIST_ARGS,
        cwd: '/repo',
        stdout: JSON.stringify([
          {
            number: 10,
            url: 'https://github.com/owner/repo/pull/10',
            state: 'MERGED',
            mergedAt: '2026-06-01T00:00:00Z',
            closedAt: '2026-06-01T00:00:00Z',
            headRefName: 'old'
          },
          {
            number: 11,
            url: 'https://github.com/owner/repo/pull/11',
            state: 'OPEN',
            mergedAt: null,
            closedAt: null,
            headRefName: 'new'
          }
        ])
      }
    ],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: MULTI_LIST },
      {
        args: ['worktree', 'remove', '/home/me/.worktrees/repo/old'],
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

  await run(['clean'], context.runtime);

  assert.match(context.confirmCalls[0], /old/);
  assert.doesNotMatch(context.confirmCalls[0], /new/);
  assert.deepEqual(context.shellCalls, [
    {
      command: 'npm run clean',
      cwd: '/home/me/.worktrees/repo/old'
    }
  ]);
  assert.match(context.stdout, /Removed worktree: \/home\/me\/\.worktrees\/repo\/old/);
  assert.match(context.stdout, /Cleaned 1 worktree\(s\)\./);
});

test('clean command skips dirty closed PR worktrees', async () => {
  const context = await makeTempRuntime({
    confirmAnswers: [true],
    ghResponses: [
      {
        args: PR_LIST_ARGS,
        cwd: '/repo',
        stdout: JSON.stringify([
          {
            number: 10,
            url: 'https://github.com/owner/repo/pull/10',
            state: 'CLOSED',
            mergedAt: null,
            closedAt: '2026-06-01T00:00:00Z',
            headRefName: 'old'
          }
        ])
      }
    ],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: MULTI_LIST },
      {
        args: ['worktree', 'remove', '/home/me/.worktrees/repo/old'],
        cwd: '/repo',
        error: {
          exitCode: 128,
          stderr: "fatal: '/home/me/.worktrees/repo/old' contains modified or untracked files, use --force to delete it\n"
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

  await run(['clean'], context.runtime);

  assert.equal(context.gitCalls.filter((call) => call.args.includes('--force')).length, 0);
  assert.match(context.stdout, /Skipped dirty worktree: \/home\/me\/\.worktrees\/repo\/old/);
  assert.match(context.stdout, /Cleaned 0 worktree\(s\)\./);
  assert.match(context.stdout, /Skipped 1 dirty worktree\(s\)/);
});

test('clean command skips the current worktree when its PR is closed', async () => {
  const context = await makeTempRuntime({
    cwd: '/home/me/.worktrees/repo/old',
    confirmAnswers: [true],
    ghResponses: [
      {
        args: PR_LIST_ARGS,
        cwd: '/home/me/.worktrees/repo/old',
        stdout: JSON.stringify([
          {
            number: 10,
            url: 'https://github.com/owner/repo/pull/10',
            state: 'CLOSED',
            mergedAt: null,
            closedAt: '2026-06-01T00:00:00Z',
            headRefName: 'old'
          }
        ])
      }
    ],
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/home/me/.worktrees/repo/old\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/home/me/.worktrees/repo/old', stdout: MULTI_LIST }
    ]
  });
  await writeConfig(context.runtime, 'repo', {
    worktreeDir: '~/.worktrees/repo',
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  });

  await run(['clean'], context.runtime);

  assert.equal(context.gitCalls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove').length, 0);
  assert.match(context.stdout, /Skipped current worktree: \/home\/me\/\.worktrees\/repo\/old/);
  assert.match(context.stdout, /Skipped 1 current worktree\(s\)/);
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

test('start command starts a worktree by branch name without prompting for selection', async () => {
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

  await run(['start', 'feature'], context.runtime);

  assert.equal(context.selectCalls.length, 0);
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

test('switchProjectWorktree uses aligned table rows for prompt choices', async () => {
  const context = await makeTempRuntime({
    homeDir: '/home/me',
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });

  await switchProjectWorktree(context.runtime);

  assert.equal(context.selectCalls.length, 1);
  assert.equal(context.selectCalls[0].label, 'Select a worktree to switch to:');
  assert.match(context.selectCalls[0].options.header, /^Modified\s+Folder\s+ Branch\s+PR\s+State\s+Changes$/);

  const labels = context.selectCalls[0].choices.map((choice) => choice.label);
  assert.match(labels[0], /^\?\s+repo\s+ main\s+0$/);
  assert.match(labels[1], /^\?\s+feature\s+ feature\s+0$/);
  assert.doesNotMatch(labels.join('\n'), /\/home\/me|\.worktrees||/);
  assert.equal(labels[0].indexOf(' main'), labels[1].indexOf(' feature'));
  assert.equal(labels[0].lastIndexOf('0'), labels[1].lastIndexOf('0'));
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

test('switch command prints a worktree path by branch name without prompting for selection', async () => {
  const context = await makeTempRuntime({
    gitResponses: [
      { args: ['rev-parse', '--show-toplevel'], stdout: '/repo\n' },
      { args: ['worktree', 'list', '--porcelain'], cwd: '/repo', stdout: FEATURE_LIST }
    ]
  });

  await run(['switch', '--print-path', 'feature'], context.runtime);

  assert.equal(context.selectCalls.length, 0);
  assert.equal(context.stdout, '/home/me/.worktrees/repo/feature\n');
});

import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createPromptAdapter } from '../src/prompts.js';

function makeTtyRuntime() {
  const stdin = new PassThrough();
  let stdout = '';
  let stderr = '';

  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
  };

  const output = new Writable({
    write(chunk, encoding, callback) {
      stdout += chunk.toString();
      callback();
    }
  });
  output.isTTY = true;

  const errorOutput = new Writable({
    write(chunk, encoding, callback) {
      stderr += chunk.toString();
      callback();
    }
  });
  errorOutput.isTTY = true;

  return {
    runtime: {
      stdin,
      stdout: output,
      stderr: errorOutput
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    }
  };
}

async function waitForPromptRender() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('select uses arrow keys in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select('Pick one:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  context.runtime.stdin.write('\x1B[B');
  context.runtime.stdin.write('\r');

  assert.equal(await selection, 'second');
  assert.equal(context.stdout, '');
  assert.match(context.stderr, /Pick one:/);
  assert.match(context.stderr, /Second/);
  assert.match(context.stderr, /\x1b\[7m/);
  assert.match(context.stderr, /\x1b\[27m/);
  assert.equal(context.runtime.stdin.isRaw, false);
  assert.equal(context.runtime.stdin.isPaused(), true);
});

test('select renders a non-selectable header in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select(
    'Pick one:',
    [
      { label: 'First', value: 'first' },
      { label: 'Second', value: 'second' }
    ],
    { header: 'Modified  Folder  Branch  Changes' }
  );

  await waitForPromptRender();
  context.runtime.stdin.write('\r');

  assert.equal(await selection, 'first');
  assert.match(context.stderr, /Modified  Folder  Branch  Changes/);
  assert.match(context.stderr, /First/);
});

test('worktreeMenu switches with enter and arrow keys in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.worktreeMenu(
    'Select a worktree:',
    [
      { label: 'First', value: 'first' },
      { label: 'Second', value: 'second' }
    ],
    { header: 'Modified  Folder  Branch  PR  State  Changes' }
  );

  await waitForPromptRender();
  context.runtime.stdin.write('\x1B[B');
  context.runtime.stdin.write('\r');

  assert.deepEqual(await selection, { action: 'switch', value: 'second' });
  assert.match(context.stderr, /Enter switch  f refresh  n new  r remove  c config/);
  assert.match(context.stderr, /Modified  Folder  Branch  PR  State  Changes/);
  assert.equal(context.runtime.stdin.isRaw, false);
  assert.equal(context.runtime.stdin.isPaused(), true);
});

test('worktreeMenu applies asynchronous row updates without moving the selection', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const first = { path: '/repo/first' };
  const second = { path: '/repo/second' };
  let resolveUpdate;
  const updatePromise = new Promise((resolve) => {
    resolveUpdate = resolve;
  });
  const selection = prompts.worktreeMenu(
    'Select a worktree:',
    [
      { label: 'Cached first', value: first },
      { label: 'Cached second', value: second }
    ],
    {
      header: 'Cached header',
      updatePromise
    }
  );

  await waitForPromptRender();
  context.runtime.stdin.write('\x1B[B');
  assert.match(context.stderr, /refreshing PRs/);

  const freshFirst = { path: '/repo/first' };
  const freshSecond = { path: '/repo/second' };
  resolveUpdate({
    header: 'Fresh header',
    choices: [
      { label: 'Fresh first', value: freshFirst },
      { label: 'Fresh second', value: freshSecond }
    ]
  });
  await waitForPromptRender();
  context.runtime.stdin.write('\r');

  assert.deepEqual(await selection, { action: 'switch', value: freshSecond });
  assert.match(context.stderr, /Fresh header/);
  assert.match(context.stderr, /\x1b\[7mFresh second/);
});

test('worktreeMenu does not build an asynchronous update after quitting', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  let resolveUpdate;
  let mapUpdateCalls = 0;
  const updatePromise = new Promise((resolve) => {
    resolveUpdate = resolve;
  });
  const selection = prompts.worktreeMenu(
    'Select:',
    [{ label: 'Cached', value: 'cached' }],
    {
      updatePromise,
      async mapUpdate() {
        mapUpdateCalls += 1;
        return { choices: [{ label: 'Fresh', value: 'fresh' }] };
      }
    }
  );

  await waitForPromptRender();
  context.runtime.stdin.write('q');
  assert.deepEqual(await selection, { action: 'quit' });

  resolveUpdate('fresh');
  await waitForPromptRender();
  assert.equal(mapUpdateCalls, 0);
});

test('worktreeMenu supports refresh new remove and config shortcuts in a TTY', async () => {
  const refreshContext = makeTtyRuntime();
  const refreshPrompts = createPromptAdapter(refreshContext.runtime);
  const refreshSelection = refreshPrompts.worktreeMenu('Select:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  refreshContext.runtime.stdin.write('f');

  assert.deepEqual(await refreshSelection, { action: 'refresh' });

  const newContext = makeTtyRuntime();
  const newPrompts = createPromptAdapter(newContext.runtime);
  const newSelection = newPrompts.worktreeMenu('Select:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  newContext.runtime.stdin.write('n');

  assert.deepEqual(await newSelection, { action: 'new' });

  const removeContext = makeTtyRuntime();
  const removePrompts = createPromptAdapter(removeContext.runtime);
  const removeSelection = removePrompts.worktreeMenu('Select:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  removeContext.runtime.stdin.write('\x1B[B');
  removeContext.runtime.stdin.write('r');

  assert.deepEqual(await removeSelection, { action: 'remove', value: 'second' });

  const configContext = makeTtyRuntime();
  const configPrompts = createPromptAdapter(configContext.runtime);
  const configSelection = configPrompts.worktreeMenu('Select:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  configContext.runtime.stdin.write('c');

  assert.deepEqual(await configSelection, { action: 'config' });
});

test('worktreeMenu quits with q or Escape without cancellation', async () => {
  const qContext = makeTtyRuntime();
  const qPrompts = createPromptAdapter(qContext.runtime);
  const qSelection = qPrompts.worktreeMenu('Select:', [
    { label: 'First', value: 'first' }
  ]);

  await waitForPromptRender();
  qContext.runtime.stdin.write('q');

  assert.deepEqual(await qSelection, { action: 'quit' });
  assert.match(qContext.stderr, /q\/Esc quit/);

  const escapeContext = makeTtyRuntime();
  const escapePrompts = createPromptAdapter(escapeContext.runtime);
  const escapeSelection = escapePrompts.worktreeMenu('Select:', [
    { label: 'First', value: 'first' }
  ]);

  await waitForPromptRender();
  const startedAt = Date.now();
  escapeContext.runtime.stdin.write('\x1b');

  assert.deepEqual(await Promise.race([
    escapeSelection,
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 250))
  ]), { action: 'quit' });
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(escapeContext.runtime.stdin.isRaw, false);
});

test('select cancels on ctrl-c in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select('Pick one:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  context.runtime.stdin.write('\x03');

  await assert.rejects(selection, {
    name: 'SelectionCancelledError',
    exitCode: 130,
    cancelled: true
  });
  assert.equal(context.runtime.stdin.isRaw, false);
  assert.equal(context.runtime.stdin.isPaused(), true);
});

test('select cancels on escape in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select('Pick one:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  context.runtime.stdin.emit('keypress', undefined, {
    name: 'escape',
    ctrl: false
  });

  await assert.rejects(selection, {
    name: 'SelectionCancelledError',
    exitCode: 130,
    cancelled: true
  });
  assert.equal(context.runtime.stdin.isRaw, false);
  assert.equal(context.runtime.stdin.isPaused(), true);
});

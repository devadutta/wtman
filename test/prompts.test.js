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
  assert.match(context.stderr, /Enter switch  n new  r remove  c config/);
  assert.match(context.stderr, /Modified  Folder  Branch  PR  State  Changes/);
  assert.equal(context.runtime.stdin.isRaw, false);
  assert.equal(context.runtime.stdin.isPaused(), true);
});

test('worktreeMenu supports new remove and config shortcuts in a TTY', async () => {
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

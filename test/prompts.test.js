import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'bun:test';
import { createPromptAdapter } from '../src/prompts.jsx';

function makeTtyRuntime({ columns = 80 } = {}) {
  const stdin = new PassThrough();
  let stdout = '';
  let stderr = '';

  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.ref = () => {};
  stdin.unref = () => {};
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
  output.columns = columns;
  output.rows = 24;

  const errorOutput = new Writable({
    write(chunk, encoding, callback) {
      stderr += chunk.toString();
      callback();
    }
  });
  errorOutput.isTTY = true;
  errorOutput.columns = columns;
  errorOutput.rows = 24;

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

test('ask supports cursor-safe editing and returns the latest input', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const answer = prompts.ask('Worktree name', { defaultValue: 'old-name' });

  await waitForPromptRender();
  context.runtime.stdin.write('\x15');
  await waitForPromptRender();
  context.runtime.stdin.write('new-name');
  await waitForPromptRender();
  context.runtime.stdin.write('\r');

  assert.equal(await answer, 'new-name');
  assert.match(context.stderr, /Worktree name/);
  assert.equal(context.runtime.stdin.isRaw, false);
});

test('confirm supports keyboard selection before enter', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const answer = prompts.confirm('Remove this worktree?');

  await waitForPromptRender();
  context.runtime.stdin.write('\x1B[C');
  context.runtime.stdin.write('\r');

  assert.equal(await answer, true);
  assert.match(context.stderr, /Remove this worktree/);
});

test('progress rendering is owned by Ink', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const progress = prompts.createProgress(context.runtime.stdout, '/tmp/feature');

  await waitForPromptRender();
  progress.update({ phase: 'deleting', completed: 5, total: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  progress.update({ phase: 'metadata', completed: 10, total: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  progress.update({ phase: 'complete', completed: 10, total: 10 });
  await progress.stop();

  assert.match(context.stdout, /Indexing feature/);
  assert.match(context.stdout, /Deleting feature/);
  assert.match(context.stdout, /50%/);
  assert.match(context.stdout, /Finalizing feature/);
});

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
  assert.match(context.stderr, /Pick one/);
  assert.match(context.stderr, /Second/);
  assert.match(context.stderr, /› First/);
  assert.equal(context.runtime.stdin.isRaw, false);
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

test('select uses compact worktree rows in a narrow terminal', async () => {
  const context = makeTtyRuntime({ columns: 40 });
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select(
    'Pick one:',
    [{
      label: 'now  feature-folder  feature/very-long-branch  #12  open  3',
      compactLabel: 'feature-folder · feature/very-long-branch · 3 changed · #12 open',
      value: 'feature'
    }],
    { header: 'Modified  Folder  Branch  PR  State  Changes' }
  );

  await waitForPromptRender();
  context.runtime.stdin.write('\r');

  assert.equal(await selection, 'feature');
  assert.match(context.stderr, /Folder · Branch · Changes/);
  assert.match(context.stderr, /feature-folder · feature/);
  assert.doesNotMatch(context.stderr, /now  feature-folder/);
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
  assert.match(context.stderr, /enter switch  f refresh  n new  r remove  c config/);
  assert.match(context.stderr, /Modified  Folder  Branch  PR  State  Changes/);
  assert.equal(context.runtime.stdin.isRaw, false);
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
  assert.match(context.stderr, /syncing PRs/);

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
  assert.match(context.stderr, /› Fresh second/);
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
  assert.match(qContext.stderr, /q \/ esc quit/);

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
});

test('select cancels on escape in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select('Pick one:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  await waitForPromptRender();
  context.runtime.stdin.write('\x1b');

  await assert.rejects(selection, {
    name: 'SelectionCancelledError',
    exitCode: 130,
    cancelled: true
  });
  assert.equal(context.runtime.stdin.isRaw, false);
});

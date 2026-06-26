import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createPromptAdapter } from '../src/prompts.js';

function makeTtyRuntime() {
  const stdin = new PassThrough();
  let stdout = '';

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

  return {
    runtime: {
      stdin,
      stdout: output,
      stderr: output
    },
    get stdout() {
      return stdout;
    }
  };
}

test('select uses arrow keys in a TTY', async () => {
  const context = makeTtyRuntime();
  const prompts = createPromptAdapter(context.runtime);
  const selection = prompts.select('Pick one:', [
    { label: 'First', value: 'first' },
    { label: 'Second', value: 'second' }
  ]);

  context.runtime.stdin.write('\x1B[B');
  context.runtime.stdin.write('\r');

  assert.equal(await selection, 'second');
  assert.match(context.stdout, /> Second/);
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

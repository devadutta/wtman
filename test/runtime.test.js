import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createRuntime } from '../src/runtime.js';

test('runtime respects XDG_CONFIG_HOME', () => {
  const runtime = createRuntime({
    env: {
      XDG_CONFIG_HOME: '/tmp/wtman-config'
    },
    homeDir: '/home/example'
  });

  assert.equal(runtime.configHome, '/tmp/wtman-config');
});

#!/usr/bin/env node

import { run } from '../src/cli.js';

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (error?.cancelled) {
    process.exitCode = error.exitCode || 130;
    process.exit();
  }

  const message = error?.message || String(error);
  console.error(`wtman: ${message}`);
  process.exitCode = error?.exitCode || 1;
}

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPromptAdapter } from './prompts.js';

function execFilePromise(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = error.code;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function runShellCommand(command, { cwd, env, stdin, stdout, stderr }) {
  return new Promise((resolve, reject) => {
    const shell = env.SHELL || process.env.SHELL || '/bin/sh';
    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: { ...env, PWD: cwd },
      stdio: [stdin, stdout, stderr]
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(`command failed with exit code ${code}: ${command}`);
      error.exitCode = code;
      reject(error);
    });
  });
}

function openInteractiveShell({ cwd, env, stdin, stdout, stderr }) {
  return new Promise((resolve, reject) => {
    const shell = env.SHELL || process.env.SHELL || '/bin/sh';
    const child = spawn(shell, [], {
      cwd,
      env: { ...env, PWD: cwd },
      stdio: [stdin, stdout, stderr]
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(`shell exited with code ${code}`);
      error.exitCode = code;
      reject(error);
    });
  });
}

export function createRuntime(overrides = {}) {
  const env = overrides.env || process.env;
  const homeDir = overrides.homeDir || os.homedir();
  const runtime = {
    cwd: overrides.cwd || process.cwd(),
    env,
    fs: overrides.fs || fs,
    homeDir,
    configHome: overrides.configHome || path.join(homeDir, '.config'),
    stdin: overrides.stdin || process.stdin,
    stdout: overrides.stdout || process.stdout,
    stderr: overrides.stderr || process.stderr,
    async git(args, options = {}) {
      return execFilePromise('git', args, {
        cwd: options.cwd || runtime.cwd,
        env: runtime.env
      });
    },
    async shell(command, options = {}) {
      return runShellCommand(command, {
        cwd: options.cwd || runtime.cwd,
        env: runtime.env,
        stdin: runtime.stdin,
        stdout: runtime.stdout,
        stderr: runtime.stderr
      });
    },
    async openShell(options = {}) {
      return openInteractiveShell({
        cwd: options.cwd || runtime.cwd,
        env: runtime.env,
        stdin: runtime.stdin,
        stdout: runtime.stdout,
        stderr: runtime.stderr
      });
    }
  };

  runtime.prompts = overrides.prompts || createPromptAdapter(runtime);

  return {
    ...runtime,
    ...overrides
  };
}

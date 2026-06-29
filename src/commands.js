import path from 'node:path';
import { defaultConfig, readConfig, resolveWorktreeDir, writeConfig } from './config.js';
import { addWorktree, discoverRepo, isDirtyWorktreeRemoveError, isSamePath, removeWorktree } from './git.js';
import { assertSafeWorktreeName, displayPath } from './path-utils.js';
import { WtmanError } from './errors.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function worktreeLabel(runtime, worktree, repo) {
  const branch = worktree.branch || (worktree.detached ? 'detached' : 'unknown');
  const marker = isSamePath(worktree.path, repo.primaryWorktree) ? ' [primary]' : '';
  return `${displayPath(worktree.path, runtime.homeDir)}  ${branch}${marker}`;
}

export function generateWorktreeName(repoName, worktrees) {
  const pattern = new RegExp(`^(\\d+)-wt-${escapeRegExp(repoName)}$`);
  const usedIndexes = worktrees
    .flatMap((worktree) => [path.basename(worktree.path), worktree.branch])
    .map((name) => pattern.exec(name || ''))
    .filter(Boolean)
    .map((match) => Number.parseInt(match[1], 10))
    .filter(Number.isInteger);

  const nextIndex = usedIndexes.length === 0 ? 1 : Math.max(...usedIndexes) + 1;
  return `${nextIndex}-wt-${repoName}`;
}

function selectableWorktrees(repo, { includePrimary = false, includeCurrent = false } = {}) {
  return repo.worktrees.filter((worktree) => {
    if (!includePrimary && isSamePath(worktree.path, repo.primaryWorktree)) {
      return false;
    }

    if (!includeCurrent && isSamePath(worktree.path, repo.currentRoot)) {
      return false;
    }

    return true;
  });
}

async function promptConfig(runtime, repoName, currentConfig = defaultConfig(repoName)) {
  return {
    worktreeDir: await runtime.prompts.ask('Worktree directory', {
      defaultValue: currentConfig.worktreeDir
    }),
    setupCommand: await runtime.prompts.ask('Setup command', {
      defaultValue: currentConfig.setupCommand
    }),
    startCommand: await runtime.prompts.ask('Start command', {
      defaultValue: currentConfig.startCommand
    }),
    cleanupCommand: await runtime.prompts.ask('Cleanup command', {
      defaultValue: currentConfig.cleanupCommand
    })
  };
}

export async function configureProject(runtime, { forceEdit = false } = {}) {
  const repo = await discoverRepo(runtime);
  const existing = await readConfig(runtime, repo.repoName);

  runtime.stdout.write(`Config: ${existing.filePath}\n`);

  if (existing.exists && !forceEdit) {
    runtime.stdout.write(`Worktree directory: ${existing.config.worktreeDir}\n`);
    runtime.stdout.write(`Setup command: ${existing.config.setupCommand || '(none)'}\n`);
    runtime.stdout.write(`Start command: ${existing.config.startCommand || '(none)'}\n`);
    runtime.stdout.write(`Cleanup command: ${existing.config.cleanupCommand || '(none)'}\n`);
    return existing.config;
  }

  const nextConfig = await promptConfig(runtime, repo.repoName, existing.config);
  await writeConfig(runtime, repo.repoName, nextConfig);
  runtime.stdout.write(`Saved config for ${repo.repoName}.\n`);
  return nextConfig;
}

export async function defaultProjectCommand(runtime) {
  const repo = await discoverRepo(runtime);
  const existing = await readConfig(runtime, repo.repoName);

  if (!existing.exists) {
    runtime.stdout.write(`No wtman config found for ${repo.repoName}. Starting setup.\n`);
    const nextConfig = await promptConfig(runtime, repo.repoName, existing.config);
    await writeConfig(runtime, repo.repoName, nextConfig);
    runtime.stdout.write(`Saved config for ${repo.repoName}.\n`);
    return;
  }

  await switchProjectWorktree(runtime, { repo });
}

export async function defaultProjectSwitchPath(runtime) {
  const repo = await discoverRepo(runtime);
  const existing = await readConfig(runtime, repo.repoName);

  if (!existing.exists) {
    return;
  }

  await switchProjectWorktree(runtime, { printPath: true, repo });
}

async function ensureProjectConfig(runtime, repo) {
  const existing = await readConfig(runtime, repo.repoName);

  if (existing.exists) {
    return existing.config;
  }

  runtime.stdout.write(`No wtman config found for ${repo.repoName}. Starting setup.\n`);
  const nextConfig = await promptConfig(runtime, repo.repoName, existing.config);
  await writeConfig(runtime, repo.repoName, nextConfig);
  runtime.stdout.write(`Saved config for ${repo.repoName}.\n`);
  return nextConfig;
}

export async function createWorktree(runtime, { requestedName, writePath } = {}) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);
  const name = requestedName ? assertSafeWorktreeName(requestedName) : generateWorktreeName(repo.repoName, repo.worktrees);
  const branch = name;
  const baseDir = resolveWorktreeDir(runtime, config);
  const targetPath = path.join(baseDir, name);

  runtime.stdout.write(`Using worktree name: ${name}\n`);
  runtime.stdout.write(`Using branch name: ${branch}\n`);
  await runtime.fs.mkdir(baseDir, { recursive: true });
  await addWorktree(runtime, repo.currentRoot, targetPath, branch);

  if (config.setupCommand) {
    runtime.stdout.write(`Running setup command in ${targetPath}\n`);
    await runtime.shell(config.setupCommand, { cwd: targetPath });
  }

  runtime.stdout.write(`Created worktree: ${targetPath}\n`);
  if (writePath) {
    await runtime.fs.writeFile(writePath, `${targetPath}\n`, 'utf8');
  }

  return targetPath;
}

export async function listProjectWorktrees(runtime) {
  const repo = await discoverRepo(runtime);

  if (repo.worktrees.length === 0) {
    runtime.stdout.write('No worktrees found.\n');
    return;
  }

  for (const worktree of repo.worktrees) {
    runtime.stdout.write(`${worktreeLabel(runtime, worktree, repo)}\n`);
  }
}

export async function removeProjectWorktree(runtime) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);
  const candidates = selectableWorktrees(repo);

  if (candidates.length === 0) {
    throw new WtmanError('no removable worktrees found for this repository');
  }

  const selected = await runtime.prompts.select(
    'Select a worktree to remove:',
    candidates.map((worktree) => ({
      label: worktreeLabel(runtime, worktree, repo),
      value: worktree
    }))
  );

  if (config.cleanupCommand) {
    runtime.stdout.write(`Running cleanup command in ${selected.path}\n`);
    await runtime.shell(config.cleanupCommand, { cwd: selected.path });
  }

  try {
    await removeWorktree(runtime, repo.currentRoot, selected.path);
  } catch (error) {
    if (!isDirtyWorktreeRemoveError(error)) {
      throw error;
    }

    const shouldForce = await runtime.prompts.confirm(
      `Worktree contains modified or untracked files. Force remove ${displayPath(selected.path, runtime.homeDir)}?`
    );

    if (!shouldForce) {
      runtime.stdout.write('Removal cancelled.\n');
      return;
    }

    await removeWorktree(runtime, repo.currentRoot, selected.path, { force: true });
  }

  runtime.stdout.write(`Removed worktree: ${selected.path}\n`);
}

export async function startProjectWorktree(runtime) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);

  if (!config.startCommand) {
    throw new WtmanError('no start command configured for this repository');
  }

  const candidates = selectableWorktrees(repo, { includeCurrent: true });

  if (candidates.length === 0) {
    throw new WtmanError('no worktrees found to start');
  }

  const selected = await runtime.prompts.select(
    'Select a worktree to start:',
    candidates.map((worktree) => ({
      label: worktreeLabel(runtime, worktree, repo),
      value: worktree
    }))
  );

  await runtime.shell(config.startCommand, { cwd: selected.path });
}

export async function switchProjectWorktree(runtime, { printPath = false, repo: discoveredRepo } = {}) {
  const repo = discoveredRepo || (await discoverRepo(runtime));

  if (repo.worktrees.length === 0) {
    throw new WtmanError('no worktrees found to switch to');
  }

  const selected = await runtime.prompts.select(
    'Select a worktree to switch to:',
    repo.worktrees.map((worktree) => ({
      label: worktreeLabel(runtime, worktree, repo),
      value: worktree
    }))
  );

  if (printPath) {
    runtime.stdout.write(`${selected.path}\n`);
    return;
  }

  runtime.stdout.write(`Selected worktree: ${selected.path}\n`);
  runtime.stderr.write('To cd directly with `wtman switch`, run `eval "$(wtman shell-init)"` in your shell startup file.\n');
}

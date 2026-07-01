import path from 'node:path';
import stringWidth from 'fast-string-width';
import { defaultConfig, readConfig, resolveWorktreeDir, writeConfig } from './config.js';
import { addWorktree, discoverRepo, getPullRequestsByBranch, getWorktreeStatusEntries, isDirtyWorktreeRemoveError, isSamePath, removeWorktree } from './git.js';
import { assertSafeWorktreeName, displayPath } from './path-utils.js';
import { WtmanError } from './errors.js';

const ICONS = {
  branch: ''
};

const ANSI_RED = '\x1b[31m';
const ANSI_DEFAULT_FOREGROUND = '\x1b[39m';
const OSC_8_END = '\x1b]8;;\x1b\\';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canUseColor(runtime) {
  if (runtime.env?.FORCE_COLOR) {
    return true;
  }

  if (runtime.env?.NO_COLOR) {
    return false;
  }

  return Boolean(runtime.stdout?.isTTY || runtime.stderr?.isTTY);
}

function red(value, { color = false } = {}) {
  return color ? `${ANSI_RED}${value}${ANSI_DEFAULT_FOREGROUND}` : value;
}

function canUseHyperlinks(output) {
  return Boolean(output?.isTTY);
}

async function worktreeChoices(runtime, repo, worktrees) {
  const rows = await buildWorktreeTableRows(runtime, repo, worktrees, {
    color: canUseColor(runtime),
    links: canUseHyperlinks(runtime.stderr || runtime.stdout)
  });
  const [header, ...labels] = formatWorktreeRows(rows, { header: true }).split('\n');

  return {
    header,
    choices: rows.map((row, index) => ({
      label: labels[index],
      value: row.worktree
    }))
  };
}

function worktreeBranch(worktree) {
  return worktree.branch || (worktree.detached ? 'detached' : 'unknown');
}

function worktreePullRequest(worktree, pullRequestsByBranch) {
  return pullRequestsByBranch.get(worktreeBranch(worktree));
}

function runtimeNow(runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : runtime.now;

  if (now instanceof Date) {
    return now;
  }

  if (now !== undefined) {
    return new Date(now);
  }

  return new Date();
}

function formatModifiedTime(modifiedAt, now) {
  if (!Number.isFinite(modifiedAt)) {
    return '?';
  }

  const elapsedMs = Math.max(0, now.getTime() - modifiedAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) {
    return 'now';
  }

  if (elapsedMs < hourMs) {
    return `${Math.floor(elapsedMs / minuteMs)}m ago`;
  }

  if (elapsedMs < dayMs) {
    return `${Math.floor(elapsedMs / hourMs)}h ago`;
  }

  if (elapsedMs < 30 * dayMs) {
    return `${Math.floor(elapsedMs / dayMs)}d ago`;
  }

  const modifiedDate = new Date(modifiedAt);

  if (modifiedDate.getFullYear() === now.getFullYear()) {
    return modifiedDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  }

  return modifiedDate.toISOString().slice(0, 10);
}

async function statMtime(runtime, filePath) {
  try {
    const stats = await runtime.fs.stat(filePath);
    return stats.mtimeMs;
  } catch {
    return Number.NaN;
  }
}

function worktreeMainRank(worktree, repo) {
  if (worktreeBranch(worktree) === 'main') {
    return 0;
  }

  if (isSamePath(worktree.path, repo.primaryWorktree)) {
    return 1;
  }

  return 2;
}

function compareWorktreeRows(left, right) {
  if (left.mainRank !== right.mainRank) {
    return left.mainRank - right.mainRank;
  }

  if (left.sortModifiedAt !== right.sortModifiedAt) {
    return left.sortModifiedAt > right.sortModifiedAt ? -1 : 1;
  }

  const nameOrder = left.name.localeCompare(right.name);

  if (nameOrder !== 0) {
    return nameOrder;
  }

  return worktreeBranch(left.worktree).localeCompare(worktreeBranch(right.worktree));
}

function formatChanges(changes, options) {
  if (changes === '?') {
    return changes;
  }

  const value = String(changes);
  return changes > 0 ? red(value, options) : value;
}

function formatPullRequest(pullRequest, { links = false } = {}) {
  if (!pullRequest?.number) {
    return '';
  }

  const label = `#${pullRequest.number}`;

  if (!links || !pullRequest.url) {
    return label;
  }

  return `\x1b]8;;${pullRequest.url}\x1b\\${label}${OSC_8_END}`;
}

async function worktreeTableRow(runtime, repo, worktree, now, options = {}) {
  let statusEntries;

  try {
    statusEntries = await getWorktreeStatusEntries(runtime, worktree.path);
  } catch {
    statusEntries = null;
  }

  const changedPaths = (statusEntries || [])
    .map((entry) => entry.path)
    .filter(Boolean)
    .map((entryPath) => path.join(worktree.path, entryPath));
  const modifiedTimes = await Promise.all([
    statMtime(runtime, worktree.path),
    ...changedPaths.map((entryPath) => statMtime(runtime, entryPath))
  ]);
  const modifiedAt = Math.max(...modifiedTimes.filter(Number.isFinite));
  const changes = statusEntries ? statusEntries.length : '?';
  const sortModifiedAt = Number.isFinite(modifiedAt) ? modifiedAt : Number.NEGATIVE_INFINITY;
  const pullRequest = worktreePullRequest(worktree, options.pullRequestsByBranch);

  return {
    worktree,
    pullRequest,
    mainRank: worktreeMainRank(worktree, repo),
    sortModifiedAt,
    modified: formatModifiedTime(modifiedAt, now),
    name: path.basename(worktree.path),
    branch: `${ICONS.branch} ${worktreeBranch(worktree)}`,
    pr: formatPullRequest(pullRequest, options),
    state: pullRequest?.state || '',
    changes: formatChanges(changes, options)
  };
}

async function buildWorktreeTableRows(runtime, repo, worktrees, options = {}) {
  const now = runtimeNow(runtime);
  const pullRequestsByBranch = options.pullRequestsByBranch ?? (await getPullRequestsByBranch(runtime, repo.currentRoot));
  const rows = await Promise.all(worktrees.map((worktree) => worktreeTableRow(runtime, repo, worktree, now, { ...options, pullRequestsByBranch })));
  return rows.toSorted(compareWorktreeRows);
}

function padEndCell(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}

function formatWorktreeRows(rows, { header = true } = {}) {
  const columns = [
    { key: 'modified', label: 'Modified' },
    { key: 'name', label: 'Folder' },
    { key: 'branch', label: `${ICONS.branch} Branch` },
    { key: 'pr', label: 'PR' },
    { key: 'state', label: 'State' },
    { key: 'changes', label: 'Changes' }
  ];
  const widths = columns.map((column) =>
    Math.max(
      stringWidth(column.label),
      ...rows.map((row) => stringWidth(row[column.key]))
    )
  );
  const formatRow = (row) =>
    columns
      .map((column, index) => {
        const value = row[column.key];

        if (index === columns.length - 1) {
          return value;
        }

        return padEndCell(value, widths[index]);
      })
      .join('  ')
      .trimEnd();
  const lines = [];

  if (header) {
    lines.push(formatRow(Object.fromEntries(columns.map((column) => [column.key, column.label]))));
  }

  lines.push(...rows.map(formatRow));
  return lines.join('\n');
}

async function formatWorktreeTable(runtime, repo, worktrees) {
  return formatWorktreeRows(await buildWorktreeTableRows(runtime, repo, worktrees, {
    color: canUseColor(runtime),
    links: canUseHyperlinks(runtime.stdout)
  }));
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

function isRemovableWorktree(repo, worktree) {
  return selectableWorktrees(repo).some((candidate) => isSamePath(candidate.path, worktree.path));
}

function worktreeReferenceMatches(worktree, reference) {
  return path.basename(worktree.path) === reference || worktree.branch === reference;
}

function resolveWorktreeReference(worktrees, reference) {
  if (!reference) {
    return null;
  }

  const matches = worktrees.filter((worktree) => worktreeReferenceMatches(worktree, reference));

  if (matches.length === 0) {
    throw new WtmanError(`no worktree matches: ${reference}`);
  }

  if (matches.length > 1) {
    throw new WtmanError(`worktree reference is ambiguous: ${reference}`);
  }

  return matches[0];
}

async function removeSelectedWorktree(runtime, repo, config, selected, {
  output = runtime.stdout,
  confirm = true,
  promptForDirty = true
} = {}) {
  if (confirm) {
    const shouldRemove = await runtime.prompts.confirm(
      `Remove worktree ${displayPath(selected.path, runtime.homeDir)}?`
    );

    if (!shouldRemove) {
      output.write('Removal cancelled.\n');
      return 'cancelled';
    }
  }

  if (config.cleanupCommand) {
    output.write(`Running cleanup command in ${selected.path}\n`);
    await runtime.shell(config.cleanupCommand, {
      cwd: selected.path,
      stdout: output,
      stderr: runtime.stderr
    });
  }

  try {
    await removeWorktree(runtime, repo.currentRoot, selected.path);
  } catch (error) {
    if (!isDirtyWorktreeRemoveError(error)) {
      throw error;
    }

    if (!promptForDirty) {
      output.write(`Skipped dirty worktree: ${selected.path}\n`);
      return 'dirty';
    }

    const shouldForce = await runtime.prompts.confirm(
      `Worktree contains modified or untracked files. Force remove ${displayPath(selected.path, runtime.homeDir)}?`
    );

    if (!shouldForce) {
      output.write('Removal cancelled.\n');
      return 'cancelled';
    }

    await removeWorktree(runtime, repo.currentRoot, selected.path, { force: true });
  }

  output.write(`Removed worktree: ${selected.path}\n`);
  return 'removed';
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

export async function configureProject(runtime, { forceEdit = false, output = runtime.stdout } = {}) {
  const repo = await discoverRepo(runtime);
  const existing = await readConfig(runtime, repo.repoName);

  output.write(`Config: ${existing.filePath}\n`);

  if (existing.exists && !forceEdit) {
    output.write(`Worktree directory: ${existing.config.worktreeDir}\n`);
    output.write(`Setup command: ${existing.config.setupCommand || '(none)'}\n`);
    output.write(`Start command: ${existing.config.startCommand || '(none)'}\n`);
    output.write(`Cleanup command: ${existing.config.cleanupCommand || '(none)'}\n`);
    return existing.config;
  }

  const nextConfig = await promptConfig(runtime, repo.repoName, existing.config);
  await writeConfig(runtime, repo.repoName, nextConfig);
  output.write(`Saved config for ${repo.repoName}.\n`);
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

  await defaultProjectMenu(runtime, { repo });
}

export async function defaultProjectSwitchPath(runtime) {
  const repo = await discoverRepo(runtime);
  const existing = await readConfig(runtime, repo.repoName);

  if (!existing.exists) {
    return;
  }

  await defaultProjectMenu(runtime, { printPath: true, repo });
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

async function selectWorktree(runtime, repo, worktrees, label) {
  const worktreeSelect = await worktreeChoices(runtime, repo, worktrees);
  return runtime.prompts.select(label, worktreeSelect.choices, { header: worktreeSelect.header });
}

function writeSelectedWorktree(runtime, selected, { printPath = false } = {}) {
  if (printPath) {
    runtime.stdout.write(`${selected.path}\n`);
    return;
  }

  runtime.stdout.write(`Selected worktree: ${selected.path}\n`);
  runtime.stderr.write('To cd directly with `wtman switch`, run `eval "$(wtman shell-init)"` in your shell startup file.\n');
}

async function defaultProjectMenu(runtime, { printPath = false, repo } = {}) {
  if (repo.worktrees.length === 0) {
    throw new WtmanError('no worktrees found to switch to');
  }

  const output = printPath ? runtime.stderr : runtime.stdout;
  const worktreeSelect = await worktreeChoices(runtime, repo, repo.worktrees);
  const menuResult = typeof runtime.prompts.worktreeMenu === 'function'
    ? await runtime.prompts.worktreeMenu(
      'Select a worktree:',
      worktreeSelect.choices,
      { header: worktreeSelect.header }
    )
    : {
      action: 'switch',
      value: await runtime.prompts.select(
        'Select a worktree to switch to:',
        worktreeSelect.choices,
        { header: worktreeSelect.header }
      )
    };

  if (menuResult.action === 'switch') {
    writeSelectedWorktree(runtime, menuResult.value, { printPath });
    return;
  }

  if (menuResult.action === 'new') {
    const targetPath = await createWorktree(runtime, {
      output,
      commandOutput: output
    });

    if (printPath) {
      runtime.stdout.write(`${targetPath}\n`);
    }

    return;
  }

  if (menuResult.action === 'remove') {
    if (!isRemovableWorktree(repo, menuResult.value)) {
      output.write(`Selected worktree cannot be removed: ${displayPath(menuResult.value.path, runtime.homeDir)}\n`);
      if (printPath) {
        runtime.stdout.write(`${runtime.cwd}\n`);
      }
      return;
    }

    const config = await ensureProjectConfig(runtime, repo);
    await removeSelectedWorktree(runtime, repo, config, menuResult.value, { output });

    if (printPath) {
      runtime.stdout.write(`${runtime.cwd}\n`);
    }

    return;
  }

  if (menuResult.action === 'config') {
    await configureProject(runtime, { forceEdit: true, output });

    if (printPath) {
      runtime.stdout.write(`${runtime.cwd}\n`);
    }

    return;
  }

  throw new WtmanError(`unknown menu action: ${menuResult.action}`);
}

export async function createWorktree(runtime, {
  requestedName,
  writePath,
  output = runtime.stdout,
  commandOutput = runtime.stdout
} = {}) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);
  const name = requestedName ? assertSafeWorktreeName(requestedName) : generateWorktreeName(repo.repoName, repo.worktrees);
  const branch = name;
  const baseDir = resolveWorktreeDir(runtime, config);
  const targetPath = path.join(baseDir, name);

  output.write(`Using worktree name: ${name}\n`);
  output.write(`Using branch name: ${branch}\n`);
  await runtime.fs.mkdir(baseDir, { recursive: true });
  await addWorktree(runtime, repo.currentRoot, targetPath, branch);

  if (config.setupCommand) {
    output.write(`Running setup command in ${targetPath}\n`);
    await runtime.shell(config.setupCommand, {
      cwd: targetPath,
      stdout: commandOutput,
      stderr: runtime.stderr
    });
  }

  output.write(`Created worktree: ${targetPath}\n`);
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

  runtime.stdout.write(`${await formatWorktreeTable(runtime, repo, repo.worktrees)}\n`);
}

export async function cleanProjectWorktrees(runtime) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);
  const pullRequestsByBranch = await getPullRequestsByBranch(runtime, repo.currentRoot);
  const candidates = selectableWorktrees(repo, { includeCurrent: true })
    .map((worktree) => ({
      worktree,
      pullRequest: worktreePullRequest(worktree, pullRequestsByBranch)
    }))
    .filter(({ pullRequest }) => pullRequest?.state === 'closed' || pullRequest?.state === 'merged');

  if (candidates.length === 0) {
    runtime.stdout.write('No closed PR worktrees found.\n');
    return;
  }

  const candidateList = candidates
    .map(({ worktree, pullRequest }) => `- ${displayPath(worktree.path, runtime.homeDir)} (${worktreeBranch(worktree)}, #${pullRequest.number} ${pullRequest.state})`)
    .join('\n');
  const shouldClean = await runtime.prompts.confirm(
    `Remove ${candidates.length} closed PR worktree(s)?\n${candidateList}`
  );

  if (!shouldClean) {
    runtime.stdout.write('Clean cancelled.\n');
    return;
  }

  const results = [];

  for (const { worktree } of candidates) {
    if (isSamePath(worktree.path, repo.currentRoot)) {
      runtime.stdout.write(`Skipped current worktree: ${worktree.path}\n`);
      results.push('current');
      continue;
    }

    results.push(await removeSelectedWorktree(runtime, repo, config, worktree, {
      confirm: false,
      promptForDirty: false
    }));
  }

  const removedCount = results.filter((result) => result === 'removed').length;
  const dirtyCount = results.filter((result) => result === 'dirty').length;
  const currentCount = results.filter((result) => result === 'current').length;

  runtime.stdout.write(`Cleaned ${removedCount} worktree(s).\n`);

  if (dirtyCount > 0) {
    runtime.stdout.write(`Skipped ${dirtyCount} dirty worktree(s). Use wtman remove <name> to review and remove manually.\n`);
  }

  if (currentCount > 0) {
    runtime.stdout.write(`Skipped ${currentCount} current worktree(s). Run wtman clean from another worktree to remove them.\n`);
  }
}

export async function removeProjectWorktree(runtime, { requestedName } = {}) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);
  const candidates = selectableWorktrees(repo);

  if (candidates.length === 0) {
    throw new WtmanError('no removable worktrees found for this repository');
  }

  const selected = requestedName
    ? resolveWorktreeReference(candidates, requestedName)
    : await selectWorktree(runtime, repo, candidates, 'Select a worktree to remove:');

  await removeSelectedWorktree(runtime, repo, config, selected);
}

export async function startProjectWorktree(runtime, { requestedName } = {}) {
  const repo = await discoverRepo(runtime);
  const config = await ensureProjectConfig(runtime, repo);

  if (!config.startCommand) {
    throw new WtmanError('no start command configured for this repository');
  }

  const candidates = selectableWorktrees(repo, { includeCurrent: true });

  if (candidates.length === 0) {
    throw new WtmanError('no worktrees found to start');
  }

  const selected = requestedName
    ? resolveWorktreeReference(candidates, requestedName)
    : await selectWorktree(runtime, repo, candidates, 'Select a worktree to start:');

  await runtime.shell(config.startCommand, { cwd: selected.path });
}

export async function switchProjectWorktree(runtime, { printPath = false, repo: discoveredRepo, requestedName } = {}) {
  const repo = discoveredRepo || (await discoverRepo(runtime));

  if (repo.worktrees.length === 0) {
    throw new WtmanError('no worktrees found to switch to');
  }

  const selected = requestedName
    ? resolveWorktreeReference(repo.worktrees, requestedName)
    : await selectWorktree(runtime, repo, repo.worktrees, 'Select a worktree to switch to:');

  writeSelectedWorktree(runtime, selected, { printPath });
}

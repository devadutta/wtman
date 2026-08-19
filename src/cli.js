import { cleanProjectWorktrees, configureProject, createWorktree, defaultProjectCommand, listProjectWorktrees, removeProjectWorktree, startProjectWorktree, switchProjectWorktree } from './commands.js';
import { createRuntime } from './runtime.js';
import { WtmanError } from './errors.js';
import { extractShellTarget, SHELL_INIT, SHELL_TARGET_OPTION, writeShellTarget } from './shell-integration.js';

const HELP = `wtman

Usage:
  wtman --shell-target-file <file> [switch|new] [name]
                  Write a directory-changing result for shell integration
  wtman            Set up config on first run, then switch worktrees
  wtman config     Create or edit config for the current Git repository
  wtman new [name] Create a new worktree
  wtman list       List worktrees for the current repository
  wtman remove [name]
                  Select and remove a worktree, or remove by folder/branch
  wtman switch [name]
                  Select a worktree, or switch by folder/branch
  wtman start [name]
                  Select a worktree, or start by folder/branch
  wtman clean      Remove closed PR worktrees after confirmation
  wtman shell-init Print shell integration for directory switching
  wtman help       Show this help
`;

function defaultResultPath(runtime, result) {
  if (result?.action === 'switch') {
    return result.path;
  }

  if (result?.action === 'quit') {
    return runtime.cwd;
  }

  return '';
}

function reportSelectedWorktree(runtime, targetPath) {
  runtime.stdout.write(`Selected worktree: ${targetPath}\n`);
  runtime.stderr.write('To cd directly with `wtman switch`, run `eval "$(command wtman shell-init)"` in your shell startup file.\n');
}

export async function run(argv = [], runtime = createRuntime()) {
  const { args: commandArgs, targetFile: shellTargetFile } = extractShellTarget(argv);
  const [command, ...args] = commandArgs;

  if (shellTargetFile && command && command !== 'switch' && command !== 'new') {
    throw new WtmanError(`${SHELL_TARGET_OPTION} only supports the default, switch, and new commands`, { exitCode: 2 });
  }

  if (!command) {
    const result = await defaultProjectCommand(runtime, { configureMissing: !shellTargetFile });
    const targetPath = defaultResultPath(runtime, result);

    if (shellTargetFile) {
      await writeShellTarget(runtime, shellTargetFile, targetPath);
    } else if (result?.action === 'switch') {
      reportSelectedWorktree(runtime, targetPath);
    }

    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    runtime.stdout.write(HELP);
    return;
  }

  if (command === '--default-print-path') {
    const result = await defaultProjectCommand(runtime, {
      configureMissing: false,
      output: runtime.stderr
    });
    const targetPath = defaultResultPath(runtime, result);

    if (targetPath) {
      runtime.stdout.write(`${targetPath}\n`);
    }

    return;
  }

  if (command === '--default-write-path') {
    if (args.length !== 1) {
      throw new WtmanError('usage: wtman', { exitCode: 2 });
    }

    const result = await defaultProjectCommand(runtime, { configureMissing: false });
    await writeShellTarget(runtime, args[0], defaultResultPath(runtime, result));
    return;
  }

  if (command === 'shell-init') {
    runtime.stdout.write(SHELL_INIT);
    return;
  }

  if (command === 'new') {
    let legacyTargetFile = '';
    let requestedName = args[0];

    if (args[0] === '--write-path') {
      if (!args[1]) {
        throw new WtmanError('usage: wtman new [name]', { exitCode: 2 });
      }

      legacyTargetFile = args[1];
      requestedName = args[2];

      if (args.length > 3) {
        throw new WtmanError('usage: wtman new [name]', { exitCode: 2 });
      }
    } else if (args.length > 1) {
      throw new WtmanError('usage: wtman new [name]', { exitCode: 2 });
    }

    if (shellTargetFile && legacyTargetFile) {
      throw new WtmanError(`cannot combine ${SHELL_TARGET_OPTION} with --write-path`, { exitCode: 2 });
    }

    const targetPath = await createWorktree(runtime, { requestedName });
    await writeShellTarget(runtime, shellTargetFile || legacyTargetFile, targetPath);
    return;
  }

  if (command === 'config') {
    await configureProject(runtime, { forceEdit: true });
    return;
  }

  if (command === 'list') {
    await listProjectWorktrees(runtime);
    return;
  }

  if (command === 'remove') {
    if (args.length > 1) {
      throw new WtmanError('usage: wtman remove [name]', { exitCode: 2 });
    }

    await removeProjectWorktree(runtime, { requestedName: args[0] });
    return;
  }

  if (command === 'clean') {
    if (args.length > 0) {
      throw new WtmanError('usage: wtman clean', { exitCode: 2 });
    }

    await cleanProjectWorktrees(runtime);
    return;
  }

  if (command === 'switch') {
    let printPath = false;
    let legacyTargetFile = '';
    let requestedName;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];

      if (arg === '--print-path') {
        printPath = true;
      } else if (arg === '--write-path') {
        legacyTargetFile = args[index + 1] || '';
        index += 1;

        if (!legacyTargetFile) {
          throw new WtmanError('usage: wtman switch [name]', { exitCode: 2 });
        }
      } else if (!requestedName) {
        requestedName = arg;
      } else {
        throw new WtmanError('usage: wtman switch [--print-path] [name]', { exitCode: 2 });
      }
    }

    if ((shellTargetFile && legacyTargetFile) || (printPath && (shellTargetFile || legacyTargetFile))) {
      throw new WtmanError('usage: wtman switch [name]', { exitCode: 2 });
    }

    const targetPath = await switchProjectWorktree(runtime, {
      output: printPath ? runtime.stderr : runtime.stdout,
      requestedName
    });

    if (printPath) {
      runtime.stdout.write(`${targetPath}\n`);
    } else if (shellTargetFile || legacyTargetFile) {
      await writeShellTarget(runtime, shellTargetFile || legacyTargetFile, targetPath);
    } else {
      reportSelectedWorktree(runtime, targetPath);
    }

    return;
  }

  if (command === 'start') {
    if (args.length > 1) {
      throw new WtmanError('usage: wtman start [name]', { exitCode: 2 });
    }

    await startProjectWorktree(runtime, { requestedName: args[0] });
    return;
  }

  throw new WtmanError(`unknown command: ${command}\n\n${HELP}`, { exitCode: 2 });
}

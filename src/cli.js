import { cleanProjectWorktrees, configureProject, createWorktree, defaultProjectCommand, defaultProjectSwitchPath, listProjectWorktrees, removeProjectWorktree, startProjectWorktree, switchProjectWorktree } from './commands.js';
import { createRuntime } from './runtime.js';
import { WtmanError } from './errors.js';

const HELP = `wtman

Usage:
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

const SHELL_INIT = `wtman() {
  if [ "$#" -eq 0 ]; then
    local wtman_target
    wtman_target="$(command wtman --default-print-path)" || return $?
    if [ -n "$wtman_target" ]; then
      cd "$wtman_target"
    else
      command wtman
    fi
  elif [ "$1" = "switch" ]; then
    shift
    local wtman_target
    wtman_target="$(command wtman switch --print-path "$@")" || return $?
    if [ -n "$wtman_target" ]; then
      cd "$wtman_target"
    fi
  elif [ "$1" = "new" ]; then
    shift
    local wtman_target_file
    local wtman_target
    local wtman_status
    wtman_target_file="$(mktemp -t wtman-new.XXXXXX)" || return $?
    command wtman new --write-path "$wtman_target_file" "$@"
    wtman_status=$?
    if [ "$wtman_status" -eq 0 ] && [ -s "$wtman_target_file" ]; then
      wtman_target="$(cat "$wtman_target_file")"
      rm -f "$wtman_target_file"
      if [ -n "$wtman_target" ]; then
        cd "$wtman_target" || return $?
      fi
    else
      rm -f "$wtman_target_file"
    fi
    return "$wtman_status"
  else
    command wtman "$@"
  fi
}
`;

export async function run(argv = [], runtime = createRuntime()) {
  const [command, ...args] = argv;

  if (!command) {
    await defaultProjectCommand(runtime);
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    runtime.stdout.write(HELP);
    return;
  }

  if (command === '--default-print-path') {
    await defaultProjectSwitchPath(runtime);
    return;
  }

  if (command === 'shell-init') {
    runtime.stdout.write(SHELL_INIT);
    return;
  }

  if (command === 'new') {
    let writePath = '';
    let requestedName = args[0];

    if (args[0] === '--write-path') {
      if (!args[1]) {
        throw new WtmanError('usage: wtman new [name]', { exitCode: 2 });
      }

      writePath = args[1];
      requestedName = args[2];

      if (args.length > 3) {
        throw new WtmanError('usage: wtman new [name]', { exitCode: 2 });
      }
    } else if (args.length > 1) {
      throw new WtmanError('usage: wtman new [name]', { exitCode: 2 });
    }

    await createWorktree(runtime, { requestedName, writePath });
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
    let requestedName;

    for (const arg of args) {
      if (arg === '--print-path') {
        printPath = true;
      } else if (!requestedName) {
        requestedName = arg;
      } else {
        throw new WtmanError('usage: wtman switch [--print-path] [name]', { exitCode: 2 });
      }
    }

    await switchProjectWorktree(runtime, { printPath, requestedName });
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

import { WtmanError } from './errors.js';

export const SHELL_TARGET_OPTION = '--shell-target-file';

export const SHELL_INIT = `wtman() {
  if [ "$#" -eq 0 ]; then
    local wtman_target_file
    local wtman_target
    local wtman_status
    wtman_target_file="$(mktemp -t wtman-target.XXXXXX)" || return $?
    command wtman --shell-target-file "$wtman_target_file"
    wtman_status=$?
    if [ "$wtman_status" -eq 0 ] && [ -s "$wtman_target_file" ]; then
      wtman_target="$(cat "$wtman_target_file")"
      rm -f "$wtman_target_file"
      if [ -n "$wtman_target" ]; then
        cd "$wtman_target" || return $?
      fi
    else
      rm -f "$wtman_target_file"
      if [ "$wtman_status" -eq 0 ]; then
        command wtman
        return $?
      fi
    fi
    return "$wtman_status"
  elif [ "$1" = "switch" ] || [ "$1" = "new" ]; then
    local wtman_subcommand="$1"
    shift
    local wtman_target_file
    local wtman_target
    local wtman_status
    wtman_target_file="$(mktemp -t wtman-target.XXXXXX)" || return $?
    command wtman --shell-target-file "$wtman_target_file" "$wtman_subcommand" "$@"
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

export function extractShellTarget(argv) {
  const args = [];
  let targetFile = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg !== SHELL_TARGET_OPTION) {
      args.push(arg);
      continue;
    }

    if (targetFile || !argv[index + 1]) {
      throw new WtmanError(`usage: wtman ${SHELL_TARGET_OPTION} <file> [switch|new] [name]`, { exitCode: 2 });
    }

    targetFile = argv[index + 1];
    index += 1;
  }

  return { args, targetFile };
}

export async function writeShellTarget(runtime, targetFile, targetPath) {
  if (!targetFile || !targetPath) {
    return false;
  }

  await runtime.fs.writeFile(targetFile, `${targetPath}\n`, 'utf8');
  return true;
}

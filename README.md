# wtman

`wtman` is a small Git worktree manager for creating, selecting, starting, and removing repository worktrees from the terminal.

It stores per-repository config, creates new worktrees with predictable branch names, and includes optional shell integration so `wtman`, `wtman switch`, and `wtman new` can change your current shell directory.

## Requirements

- Bun 1.3 or newer
- Git

## Installation

From this checkout:

```sh
bun install
bun link
```

Then verify the CLI is available:

```sh
wtman --help
```

## Quick Start

Run `wtman` inside a Git repository:

```sh
wtman
```

On first run for a repository, `wtman` creates a config file and prompts for:

- Worktree directory
- Setup command
- Start command
- Cleanup command

After config exists, running `wtman` opens an interactive worktree menu.

## Shell Integration

A CLI process cannot change the working directory of its parent shell on its own. To make `wtman`, `wtman switch`, and `wtman new` actually `cd` your current shell, add the shell integration to your startup file:

```sh
eval "$(wtman shell-init)"
```

For zsh, that usually means `~/.zshrc`. After reloading your shell:

- `wtman` selects a worktree and changes into it.
- `wtman switch` selects a worktree and changes into it.
- `wtman switch <name>` changes into a worktree by exact folder or branch name.
- `wtman new` creates a worktree, runs setup if configured, and changes into the new worktree.

After installing or updating `wtman`, reload the integration in any shell that is already open:

```sh
eval "$(command wtman shell-init)"
```

The `command` prefix bypasses the currently loaded `wtman` shell function and reads the latest integration directly from the CLI. If `command wtman` behaves correctly but plain `wtman` does not, the shell is still using an older copy of the function; run the command above or start a new shell. No build is required.

The generated wrapper uses the global `--shell-target-file <file>` option for commands that change directories. The interactive interface remains attached to the terminal while only the resulting directory is written to that file, so shell integration cannot alter Ink's TTY detection or color rendering. The option works with the default command, `switch`, and `new`; it is primarily plumbing for `wtman shell-init` rather than something you need to invoke manually.

## Commands

```sh
wtman
wtman config
wtman new
wtman new my-feature
wtman list
wtman remove
wtman remove my-feature
wtman switch
wtman switch my-feature
wtman start
wtman start my-feature
wtman clean
wtman shell-init
wtman help
```

| Command | Description |
| --- | --- |
| `wtman` | Set up config on first run, then select a worktree. |
| `wtman config` | Create or edit config for the current Git repository. |
| `wtman new [name]` | Create a new worktree and branch. With shell integration, switch into it after creation. |
| `wtman list` | List worktrees for the current repository, including linked PR and state when available. |
| `wtman remove [name]` | Select and remove a worktree, or remove one by exact folder or branch name. Confirms before deleting and runs `cleanupCommand` first if configured. |
| `wtman switch [name]` | Select a worktree, or switch by exact folder or branch name. With shell integration, switch into it. |
| `wtman start [name]` | Select a worktree, or start one by exact folder or branch name, and run the configured `startCommand`. |
| `wtman clean` | Delete worktrees whose linked PR is closed or merged after confirmation. Dirty worktrees and the current worktree are skipped. |
| `wtman shell-init` | Print the shell function used for directory switching. |
| `wtman help` | Show CLI help. |

When `wtman new` creates a branch, it uses the primary worktree as the base. If that worktree has an upstream remote branch, `wtman` fetches first and branches from the updated remote-tracking ref; repositories without an upstream fall back to the primary worktree `HEAD`.

The interactive browser is built with React and Ink. It runs in the terminal's alternate screen, so refreshing data or opening a nested prompt does not leave partial frames in scrollback.

Interactive worktree menus use arrow keys (or `j`/`k`) and these keys:

| Key | Action |
| --- | --- |
| `Enter` | Switch to the highlighted worktree. |
| `f` | Refresh cached PR status. |
| `n` | Create a new worktree, prompting for a name; leave it blank to generate one automatically. |
| `r` | Remove the highlighted worktree after confirmation. |
| `c` | Edit config. |
| `q`, `Esc` | Close the menu. |

`Home`, `End`, `Page Up`, and `Page Down` work in longer lists. The menu stays open after refresh, create, remove, and config actions. Press `Enter` to switch to the highlighted worktree, or `q`/`Esc` to close it. Worktree removal shows an Ink-rendered progress view in interactive terminals.

If the GitHub CLI (`gh`) is installed and authenticated, `wtman` shows linked PR numbers and states (`open`, `closed`, or `merged`) for matching worktree branches. PR numbers are terminal hyperlinks in supported TTYs. The interactive menu renders cached PR status immediately, refreshes it in the background on startup, and redraws changed rows in place. Press `f` for another manual refresh, or run `wtman clean` to refresh before cleanup. If `gh` is unavailable or PR lookup fails, worktree commands continue with cached PR metadata when available.

## Worktree Naming

By default, new worktrees are created under:

```text
~/.worktrees/<repo-name>
```

`wtman new` automatically names worktrees and branches as:

```text
<integer>-wt-<repo-name>
```

For example, the first worktree for a repo named `app` is:

```text
1-wt-app
```

Pass a name to override the generated value:

```sh
wtman new my-feature
```

That creates a worktree directory named `my-feature` and uses `my-feature` as the branch name.

## Config

Project config is stored at:

```text
~/.config/wtman/<repo-name>/config.json
```

If `XDG_CONFIG_HOME` is set, `wtman` stores config beneath that directory instead.

Example:

```json
{
  "worktreeDir": "~/.worktrees/app",
  "setupCommand": "bun install",
  "startCommand": "bun run dev",
  "cleanupCommand": "bun run clean"
}
```

Config fields:

| Field | Description |
| --- | --- |
| `worktreeDir` | Directory where new worktrees are created. |
| `setupCommand` | Optional command run inside a newly created worktree. |
| `startCommand` | Optional command run by `wtman start`. |
| `cleanupCommand` | Optional command run before removing a selected worktree. |

Commands run from the selected worktree directory.

## Development

Run the test suite:

```sh
bun test
```

Run a basic CLI smoke check:

```sh
bun run smoke
```

## License

MIT

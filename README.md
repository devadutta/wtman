# wtman

`wtman` is a small Git worktree manager for creating, selecting, starting, and removing repository worktrees from the terminal.

It stores per-repository config, creates new worktrees with predictable branch names, and includes optional shell integration so `wtman`, `wtman switch`, and `wtman new` can change your current shell directory.

## Requirements

- Node.js 20 or newer
- Git

## Installation

From this checkout:

```sh
npm install -g .
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

After config exists, running `wtman` opens an interactive worktree picker.

## Shell Integration

A CLI process cannot change the working directory of its parent shell on its own. To make `wtman`, `wtman switch`, and `wtman new` actually `cd` your current shell, add the shell integration to your startup file:

```sh
eval "$(wtman shell-init)"
```

For zsh, that usually means `~/.zshrc`. After reloading your shell:

- `wtman` selects a worktree and changes into it.
- `wtman switch` selects a worktree and changes into it.
- `wtman new` creates a worktree, runs setup if configured, and changes into the new worktree.

## Commands

```sh
wtman
wtman config
wtman new
wtman new my-feature
wtman list
wtman remove
wtman switch
wtman start
wtman shell-init
wtman help
```

| Command | Description |
| --- | --- |
| `wtman` | Set up config on first run, then select a worktree. |
| `wtman config` | Create or edit config for the current Git repository. |
| `wtman new [name]` | Create a new worktree and branch. With shell integration, switch into it after creation. |
| `wtman list` | List worktrees for the current repository. |
| `wtman remove` | Select and remove a worktree. Runs `cleanupCommand` first if configured. |
| `wtman switch` | Select a worktree. With shell integration, switch into it. |
| `wtman start` | Select a worktree and run the configured `startCommand`. |
| `wtman shell-init` | Print the shell function used for directory switching. |
| `wtman help` | Show CLI help. |

Interactive worktree menus use arrow keys and Enter.

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

Example:

```json
{
  "worktreeDir": "~/.worktrees/app",
  "setupCommand": "npm install",
  "startCommand": "npm run dev",
  "cleanupCommand": "npm run clean"
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
npm test
```

Run a basic CLI smoke check:

```sh
npm run smoke
```

## License

MIT

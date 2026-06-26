import path from 'node:path';

export function expandHome(inputPath, homeDir) {
  if (inputPath === '~') {
    return homeDir;
  }

  if (inputPath.startsWith('~/')) {
    return path.join(homeDir, inputPath.slice(2));
  }

  return inputPath;
}

export function displayPath(inputPath, homeDir) {
  if (inputPath === homeDir) {
    return '~';
  }

  const prefix = `${homeDir}${path.sep}`;
  if (inputPath.startsWith(prefix)) {
    return `~/${inputPath.slice(prefix.length)}`;
  }

  return inputPath;
}

export function assertSafeWorktreeName(name) {
  if (!name || !name.trim()) {
    throw new Error('worktree name is required');
  }

  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error('worktree name must be a simple directory name');
  }

  return name.trim();
}

export function assertBranchName(name) {
  if (!name || !name.trim()) {
    throw new Error('branch name is required');
  }

  if (name.includes('\0')) {
    throw new Error('branch name is invalid');
  }

  return name.trim();
}

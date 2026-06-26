import path from 'node:path';
import { expandHome } from './path-utils.js';

export function defaultConfig(repoName) {
  return {
    worktreeDir: `~/.worktrees/${repoName}`,
    setupCommand: '',
    startCommand: '',
    cleanupCommand: ''
  };
}

export function projectConfigDir(runtime, repoName) {
  return path.join(runtime.configHome, 'wtman', repoName);
}

export function projectConfigPath(runtime, repoName) {
  return path.join(projectConfigDir(runtime, repoName), 'config.json');
}

export async function readConfig(runtime, repoName) {
  const filePath = projectConfigPath(runtime, repoName);

  try {
    const raw = await runtime.fs.readFile(filePath, 'utf8');
    return {
      config: normalizeConfig(JSON.parse(raw), repoName),
      filePath,
      exists: true
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        config: defaultConfig(repoName),
        filePath,
        exists: false
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`config is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export async function writeConfig(runtime, repoName, config) {
  const dirPath = projectConfigDir(runtime, repoName);
  const filePath = projectConfigPath(runtime, repoName);
  await runtime.fs.mkdir(dirPath, { recursive: true });
  await runtime.fs.writeFile(filePath, `${JSON.stringify(normalizeConfig(config, repoName), null, 2)}\n`, 'utf8');
  return filePath;
}

export function normalizeConfig(config, repoName) {
  const defaults = defaultConfig(repoName);
  return {
    worktreeDir: config.worktreeDir || defaults.worktreeDir,
    setupCommand: config.setupCommand || '',
    startCommand: config.startCommand || '',
    cleanupCommand: config.cleanupCommand || ''
  };
}

export function resolveWorktreeDir(runtime, config) {
  return path.resolve(runtime.cwd, expandHome(config.worktreeDir, runtime.homeDir));
}

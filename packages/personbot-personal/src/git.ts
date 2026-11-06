import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function localGit(path: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const { stdout } = await run('git', ['-c', `core.hooksPath=${devNull}`, '-C', path, ...args], {
    encoding: 'utf8', maxBuffer: 65_536, timeout: 30_000, env,
  });
  return stdout.trim();
}

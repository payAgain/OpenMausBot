import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectRecord, TaskWorkspace } from '../../personbot-protocol/src/index.ts';
import { localGit as git } from './git.ts';

export type { TaskWorkspace } from '../../personbot-protocol/src/index.ts';

interface WorkspaceManifest {
  version: 1;
  workspace: TaskWorkspace;
  commit?: string;
  state: 'planned' | 'ready';
}

const pending = new Map<string, { workspace: TaskWorkspace; operation: Promise<string> }>();

function validIdentity(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function directory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Workspace directory is missing or incompatible: ${path}`);
  return realpath(path);
}

async function writeManifest(path: string, manifest: WorkspaceManifest, exclusive: boolean): Promise<void> {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(manifest));
    await file.sync();
  } finally { await file.close(); }
  if (!exclusive) await rename(target, path);
}

export function planTaskWorkspace(home: string, taskId: string, project: ProjectRecord): TaskWorkspace {
  if (!isAbsolute(home) || !validIdentity(taskId) || !validIdentity(project.id) || !isAbsolute(project.path) ||
    !['directory', 'git'].includes(project.kind)) throw new TypeError('Invalid task workspace plan');
  return {
    kind: project.kind === 'git' ? 'git-worktree' : 'directory',
    path: join(resolve(home), 'workspaces', 'tasks', taskId),
    sourcePath: project.path,
    projectId: project.id,
  };
}

export function prepareTaskWorkspace(workspace: TaskWorkspace): Promise<string> {
  const previous = pending.get(workspace.path);
  if (previous) {
    const plan = previous.workspace;
    if (workspace.kind !== plan.kind || workspace.sourcePath !== plan.sourcePath || workspace.projectId !== plan.projectId) {
      return Promise.reject(new Error('Task workspace is already bound to another project'));
    }
    return previous.operation;
  }
  const binding = { ...workspace };
  const operation = prepare(binding);
  pending.set(workspace.path, { workspace: binding, operation });
  void operation.finally(() => {
    if (pending.get(binding.path)?.operation === operation) pending.delete(binding.path);
  }).catch(() => {});
  return operation;
}

async function prepare(workspace: TaskWorkspace): Promise<string> {
  const taskId = basename(workspace.path);
  const home = dirname(dirname(dirname(workspace.path)));
  if (!validIdentity(taskId) || !validIdentity(workspace.projectId) || !isAbsolute(workspace.path) ||
    !isAbsolute(workspace.sourcePath) || !['directory', 'git-worktree'].includes(workspace.kind) ||
    join(home, 'workspaces', 'tasks', taskId) !== workspace.path) throw new TypeError('Invalid task workspace binding');
  const root = await realpath(home);
  const source = await realpath(workspace.sourcePath);
  if (source !== workspace.sourcePath) throw new Error('Task workspace source no longer matches its canonical project path');
  await directory(source);
  const targetParent = dirname(workspace.path);
  const manifestParent = join(home, 'runtime', 'task-workspaces');
  await mkdir(targetParent, { recursive: true, mode: 0o700 });
  await mkdir(manifestParent, { recursive: true, mode: 0o700 });
  if (await realpath(targetParent) !== join(root, 'workspaces', 'tasks') ||
    await realpath(manifestParent) !== join(root, 'runtime', 'task-workspaces')) throw new Error('Task workspace storage contains an incompatible symlink');
  const manifestPath = join(manifestParent, `${taskId}.json`);
  let manifest: WorkspaceManifest;
  if (await exists(manifestPath)) {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error('Task workspace manifest is incompatible');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkspaceManifest;
    if (manifest.version !== 1 || !['planned', 'ready'].includes(manifest.state) ||
      manifest.workspace?.kind !== workspace.kind || manifest.workspace.path !== workspace.path ||
      manifest.workspace.sourcePath !== source || manifest.workspace.projectId !== workspace.projectId ||
      (workspace.kind === 'git-worktree' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit ?? ''))) {
      throw new Error('Task workspace manifest does not match its project binding');
    }
  } else {
    if (await exists(workspace.path)) throw new Error('Task workspace exists without its ownership manifest');
    manifest = {
      version: 1, workspace: { ...workspace }, state: 'planned',
      ...(workspace.kind === 'git-worktree' ? { commit: await git(source, 'rev-parse', '--verify', 'HEAD') } : {}),
    };
    await writeManifest(manifestPath, manifest, true);
  }
  const present = await exists(workspace.path);
  if (!present && manifest.state === 'ready') throw new Error('Materialized task workspace is missing; refusing to replace its files');
  if (!present) {
    if (workspace.kind === 'git-worktree') await git(source, 'worktree', 'add', '--detach', '--', workspace.path, manifest.commit!);
    else await mkdir(workspace.path, { mode: 0o700 });
  }
  const canonical = await directory(workspace.path);
  if (canonical !== join(root, 'workspaces', 'tasks', taskId)) throw new Error('Task workspace path no longer matches its binding');
  if (workspace.kind === 'git-worktree') {
    const top = await realpath(await git(workspace.path, 'rev-parse', '--show-toplevel'));
    const sourceCommon = await realpath(resolve(source, await git(source, 'rev-parse', '--git-common-dir')));
    const targetCommon = await realpath(resolve(workspace.path, await git(workspace.path, 'rev-parse', '--git-common-dir')));
    if (top !== canonical || sourceCommon !== targetCommon) throw new Error('Task Git worktree belongs to another repository');
    if (manifest.state === 'planned' && await git(workspace.path, 'rev-parse', '--verify', 'HEAD') !== manifest.commit) {
      throw new Error('Partially materialized task worktree does not match its planned commit');
    }
  }
  if (manifest.state !== 'ready') await writeManifest(manifestPath, { ...manifest, state: 'ready' }, false);
  return workspace.path;
}

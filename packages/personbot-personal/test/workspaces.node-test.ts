import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { ProjectRecord } from '../../personbot-protocol/src/index.ts';
import { planTaskWorkspace, prepareTaskWorkspace } from '../src/index.ts';
import { localGit } from '../src/git.ts';

const run = promisify(execFile);

async function fixture(t: TestContext, kind: 'directory' | 'git' = 'directory') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'personbot-task-workspaces-')));
  const home = join(root, 'home');
  const source = join(root, 'source');
  await mkdir(home);
  await mkdir(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const project: ProjectRecord = {
    id: 'project', name: 'Project', kind, path: source, revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (kind === 'git') {
    await localGit(source, 'init');
    await writeFile(join(source, 'tracked.txt'), 'Original committed content\n');
    await localGit(source, 'add', 'tracked.txt');
    await localGit(source, '-c', 'user.name=Personbot Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture initial commit');
  }
  return { root, home, source, project };
}

test('directory tasks get stable independent output directories without copying source files', async t => {
  const { home, source, project } = await fixture(t);
  await writeFile(join(source, 'source-only.txt'), 'Reference only');
  const first = planTaskWorkspace(home, 'task-one', project);
  const second = planTaskWorkspace(home, 'task-two', project);
  const paths = await Promise.all([prepareTaskWorkspace(first), prepareTaskWorkspace(second), prepareTaskWorkspace(first)]);
  assert.equal(paths[0], paths[2]);
  assert.notEqual(paths[0], paths[1]);
  await assert.rejects(readFile(join(first.path, 'source-only.txt')), { code: 'ENOENT' });
  await writeFile(join(first.path, 'result.txt'), 'First result');
  await writeFile(join(second.path, 'result.txt'), 'Second result');
  assert.equal(await prepareTaskWorkspace(JSON.parse(JSON.stringify(first))), first.path);
  assert.equal(await readFile(join(first.path, 'result.txt'), 'utf8'), 'First result');
  assert.equal(await readFile(join(second.path, 'result.txt'), 'utf8'), 'Second result');
});

test('materialized directory workspaces cannot silently disappear, change binding or become symlinks', async t => {
  const { home, source, project } = await fixture(t);
  const workspace = planTaskWorkspace(home, 'task-one', project);
  await prepareTaskWorkspace(workspace);
  await assert.rejects(prepareTaskWorkspace({ ...workspace, projectId: 'other' }), /does not match/);
  await rm(workspace.path, { recursive: true });
  await assert.rejects(prepareTaskWorkspace(workspace), /refusing to replace/);
  await symlink(source, workspace.path);
  await assert.rejects(prepareTaskWorkspace(workspace), /missing or incompatible/);
});

test('unowned existing directories are never adopted or reset', async t => {
  const { home, project } = await fixture(t);
  const workspace = planTaskWorkspace(home, 'task-one', project);
  await mkdir(workspace.path, { recursive: true });
  await writeFile(join(workspace.path, 'existing.txt'), 'Keep this');
  await assert.rejects(prepareTaskWorkspace(workspace), /without its ownership manifest/);
  assert.equal(await readFile(join(workspace.path, 'existing.txt'), 'utf8'), 'Keep this');
  assert.throws(() => planTaskWorkspace(home, '../escape', project), /Invalid task workspace plan/);
});

test('two real Git task worktrees use detached committed content and preserve their changes after restart', async t => {
  const { home, source, project } = await fixture(t, 'git');
  const commit = await localGit(source, 'rev-parse', 'HEAD');
  await writeFile(join(source, 'tracked.txt'), 'Uncommitted source edit\n');
  await writeFile(join(source, 'untracked.txt'), 'Do not copy');
  const one = planTaskWorkspace(home, 'task-one', project);
  const two = planTaskWorkspace(home, 'task-two', project);
  await Promise.all([prepareTaskWorkspace(one), prepareTaskWorkspace(two)]);
  for (const workspace of [one, two]) {
    assert.equal(await readFile(join(workspace.path, 'tracked.txt'), 'utf8'), 'Original committed content\n');
    await assert.rejects(readFile(join(workspace.path, 'untracked.txt')), { code: 'ENOENT' });
    assert.equal(await localGit(workspace.path, 'rev-parse', 'HEAD'), commit);
    await assert.rejects(localGit(workspace.path, 'symbolic-ref', '--quiet', 'HEAD'));
  }
  await writeFile(join(one.path, 'tracked.txt'), 'First task changes\n');
  await writeFile(join(two.path, 'tracked.txt'), 'Second task changes\n');
  await localGit(one.path, 'add', 'tracked.txt');
  await localGit(one.path, '-c', 'user.name=Personbot Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'First task commit');
  const changedHead = await localGit(one.path, 'rev-parse', 'HEAD');
  assert.notEqual(changedHead, commit);
  await localGit(source, 'add', 'tracked.txt');
  await localGit(source, '-c', 'user.name=Personbot Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Source moved');
  const moduleUrl = new URL('../src/workspaces.ts', import.meta.url).href;
  const script = `import { prepareTaskWorkspace } from ${JSON.stringify(moduleUrl)}; for (const workspace of JSON.parse(process.argv[1])) await prepareTaskWorkspace(workspace);`;
  await run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, JSON.stringify([one, two])], {
    cwd: home, env: { ...process.env, HOME: home, DSH_HOME: join(home, 'dsh') }, timeout: 10_000,
  });
  assert.equal(await prepareTaskWorkspace(JSON.parse(JSON.stringify(one))), one.path);
  assert.equal(await localGit(one.path, 'rev-parse', 'HEAD'), changedHead);
  assert.equal(await prepareTaskWorkspace(two), two.path);
  assert.equal(await readFile(join(two.path, 'tracked.txt'), 'utf8'), 'Second task changes\n');
  const manifest = JSON.parse(await readFile(join(home, 'runtime', 'task-workspaces', 'task-one.json'), 'utf8')) as { commit: string; state: string };
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.state, 'ready');
  const worktrees = await localGit(source, 'worktree', 'list', '--porcelain');
  assert.ok(worktrees.includes(one.path) && worktrees.includes(two.path));
});

test('missing Git worktrees and swapped repositories are rejected without creating empty replacements', async t => {
  const { home, project } = await fixture(t, 'git');
  const workspace = planTaskWorkspace(home, 'task-one', project);
  await prepareTaskWorkspace(workspace);
  await rm(workspace.path, { recursive: true });
  await assert.rejects(prepareTaskWorkspace(workspace), /refusing to replace/);
  await mkdir(workspace.path);
  await localGit(workspace.path, 'init');
  await assert.rejects(prepareTaskWorkspace(workspace), /belongs to another repository/);
});

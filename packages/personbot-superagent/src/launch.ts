import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ChildConfiguration {
  home: string;
  workspace: string;
  bindingId: string;
  provider: string;
  model: string;
  fixture?: boolean;
  instructions?: string;
  approvalMode?: string;
  stopBeforeRecovery?: boolean;
  stoppedRequestIds?: string[];
  fencedRequestIds?: string[];
  stoppedTicketIds?: string[];
  requestAuthorizations?: Array<{ requestId: string; sourceMessageId?: string; authorizationVersion: number }>;
}

export async function prepareLaunch(config: ChildConfiguration) {
  const dshHome = join(config.home, 'dsh');
  const profile = join(dshHome, 'profiles', 'omb-superagent');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const dshPackage = require.resolve('@deepseek-ai/dsh/package.json');
  if ((JSON.parse(await readFile(dshPackage, 'utf8')) as { version: string }).version !== '0.2.2-rc.1') throw new Error('Super Agent requires locked DSH 0.2.2-rc.1');
  const plugin = pathToFileURL(fileURLToPath(new URL('./plugin.ts', import.meta.url))).href;
  const fixture = pathToFileURL(fileURLToPath(new URL('../test/fixture-plugin.ts', import.meta.url))).href;
  const upstream = await readFile(new URL('../upstream/cordis.patch.yml', import.meta.url), 'utf8');
  const presetRows = upstream.slice(upstream.indexOf('    # The agent preset'));
  const disabled = ['sdk-jsonrpc-server', 'hmr', 'tool-plugin-manager', 'tool-cordis', 'schedule', 'tool-schedule', 'goal-round-driver', 'tool-goal', 'command-goal', 'session-title-llm'];
  const patch = [
    ...disabled.map(id => `- id: ${id}\n  disabled: true`),
    '- id: sdk-app-startup\n  config:\n    profile: omb-superagent',
    '- insert:',
    '    - id: omb-agent-preset-registry\n      name: "@deepseek-ai/dsh-agent-preset-registry"\n      config:\n        default: standard',
    '    - id: omb-standard-preset\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: standard\n        name: Standard\n        plugins: []',
    '    - id: omb-session-controller\n      name: "@deepseek-ai/dsh-api-session-controller"\n      config:\n        nativeOpen: false',
    presetRows,
    `    - id: omb-superagent\n      name: ${JSON.stringify(plugin)}\n      inject: [sdkAppStartup, loader]\n      config: ${JSON.stringify(config)}`,
    ...(config.fixture ? [`    - id: omb-superagent-fixture\n      name: ${JSON.stringify(fixture)}`] : []),
    '',
  ].join('\n');
  const manifest = { name: 'dsh-profile-omb-superagent', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } } };
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 });
  return {
    command: process.execPath,
    args: ['--import', fileURLToPath(new URL('./runtime-loader.mjs', import.meta.url)), join(dirname(dshPackage), 'lib/bin.js'), '--profile', 'omb-superagent'],
    cwd: config.workspace,
    env: { ...process.env, DSH_HOME: dshHome, DSH_PRIMARY_RUNTIME: '', DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', DSH_MAX_TOKENS_AS_SUCCESS: 'false' },
  };
}

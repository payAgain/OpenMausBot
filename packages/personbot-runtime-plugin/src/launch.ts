import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DSH_VERSION = '0.2.2-rc.1'
export const DSH_COMMIT = 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159'

export interface LaunchOptions {
  home: string
  workspace: string
  provider?: string
  model?: string
  fixture?: boolean
}

/** Prepare a personbot-owned home and launch the locked dsh CLI without using the user's dsh profile. */
export async function prepareRuntime(options: LaunchOptions) {
  if (!isAbsolute(options.home) || !isAbsolute(options.workspace)) {
    throw new Error('personbot home and workspace must be absolute paths')
  }
  const home = resolve(options.home)
  const workspace = resolve(options.workspace)
  const dshHome = join(home, 'dsh')
  const profile = join(dshHome, 'profiles', 'personbot')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await mkdir(join(home, 'runtime'), { recursive: true, mode: 0o700 })
  const manifest = {
    name: 'dsh-profile-personbot',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
  }
  const plugin = pathToFileURL(fileURLToPath(new URL('./index.ts', import.meta.url))).href
  const fixture = pathToFileURL(fileURLToPath(new URL('../test/fixture-plugin.ts', import.meta.url))).href
  const patch = [
    ...['sdk-jsonrpc-server', 'hmr', 'tool-plugin-manager', 'tool-cordis', 'schedule', 'tool-schedule', 'goal-round-driver', 'tool-goal', 'command-goal']
      .map(id => `- id: ${id}\n  disabled: true`),
    '- id: sdk-app-startup\n  config:\n    profile: personbot',
    '- id: session-title-llm\n  disabled: true',
    '- insert:',
    `    - id: personbot-protocol\n      name: ${JSON.stringify(plugin)}\n      inject: [sdkAppStartup, loader]\n      config:\n        home: ${JSON.stringify(home)}\n        workspace: ${JSON.stringify(workspace)}\n        provider: ${JSON.stringify(options.provider ?? 'deepseek-official')}\n        model: ${JSON.stringify(options.model ?? 'deepseek-flash')}`,
    ...(options.fixture ? [`    - id: personbot-fixture\n      name: ${JSON.stringify(fixture)}`] : []),
    '',
  ].join('\n')
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 })
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
  const installed = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string }
  if (installed.version !== DSH_VERSION) throw new Error(`Expected dsh ${DSH_VERSION}, found ${installed.version}`)
  return {
    command: process.execPath,
    args: [join(dirname(packagePath), 'lib', 'bin.js'), '--profile', 'personbot'],
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PRIMARY_RUNTIME: '',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_MAX_TOKENS_AS_SUCCESS: 'false',
    },
  }
}

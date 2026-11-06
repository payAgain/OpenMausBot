import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transform } from 'sucrase';

// Upstream is distributed as TypeScript source here. Node's strip-only loader
// rejects its constructor parameter properties; transform only this package.
const packageRoot = new URL('../', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(packageRoot) && url.endsWith('.ts')) {
      const filePath = fileURLToPath(url);
      return {
        format: 'module',
        shortCircuit: true,
        source: transform(readFileSync(filePath, 'utf8'), {
          transforms: ['typescript'],
          filePath,
          preserveDynamicImport: true,
        }).code,
      };
    }
    return nextLoad(url, context);
  },
});

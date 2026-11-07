// Lets Node run the game's own TypeScript modules from tools/: their relative imports omit the
// `.ts` extension, and name a folder for its `index.ts` (the bundler resolves both), which
// Node's resolution requires.
import { register } from 'node:module';

const hooks = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.')) throw error;
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return next(specifier + '.ts', context);
    if (error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return next(specifier + '/index.ts', context);
    throw error;
  }
}`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);

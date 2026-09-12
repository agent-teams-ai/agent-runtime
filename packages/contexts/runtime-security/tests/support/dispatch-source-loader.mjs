import { registerHooks } from 'node:module';
const custody = new URL('../../../../platform/filesystem-custody/src/', import.meta.url).href;
const root = new URL('../../', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@agent-teams/filesystem-custody') {return nextResolve(`${custody}index.ts`, context);}
  if (specifier === '@agent-teams/filesystem-custody/composition') {return nextResolve(`${custody}composition.ts`, context);}
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const url = new URL(specifier, context.parentURL).href;
    if (url.startsWith(`${root}dist/`) || url.startsWith(`${root}src/`) || url.startsWith(custody)) {
      return nextResolve(url.replace(`${root}dist/`, `${root}src/`).replace(/\.js$/u, '.ts'), context);
    }
  }
  return nextResolve(specifier, context);
} });

import {registerHooks} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
// Focused source-only checks when workspace builds are unavailable. No dependency stubs.
const root = new URL('../../../../../../', import.meta.url);
registerHooks({resolve(specifier, context, next) {
  try {return next(specifier, context);} catch (error) {
    let url;
    if (specifier.startsWith(root.href)) {url = new URL(specifier);}
    if (specifier.startsWith('.') && context.parentURL) {url = new URL(specifier, context.parentURL);}
    if (specifier.startsWith('@agent-teams/')) {
      const [name, ...subpath] = specifier.slice('@agent-teams/'.length).split('/');
      const directory = new URL(`packages/${name === 'filesystem-custody' ? 'platform' : name === 'embedded-runtime' ? 'apps' : 'contexts'}/${name}/`, root);
      const manifest = new URL('package.json', directory);
      if (existsSync(manifest)) {
        const entry = JSON.parse(readFileSync(manifest, 'utf8')).exports[subpath.length ? './' + subpath.join('/') : '.'];
        if (entry?.import) {url = new URL(entry.import, directory);}
      }
    }
    if (url) {url.pathname = url.pathname.replace('/dist/', '/src/').replace(/\.js$/, '.ts'); if (existsSync(url)) {return {url: url.href, shortCircuit: true};}}
    throw error;
  }
}});

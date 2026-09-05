import { open } from 'node:fs/promises';
import { withStableDirectoryProcessLock } from '../dist/stable-directory-process-lock.js';

const directory = await open(process.argv[2], 'r');
try {
  await withStableDirectoryProcessLock(directory, async () => {
    await new Promise((resolve, reject) => {
      process.once('message', message => message === 'release' ? resolve() : reject(new Error('invalid release')));
      process.send('locked');
    });
  }, { onContention: () => { process.send('contended'); } });
} finally {
  await directory.close();
  process.disconnect();
}

import {createHash} from 'node:crypto';
import {constants, openSync, closeSync, fstatSync, lstatSync, readSync, opendirSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {decodeContainedTurnArtifactManifest} from '../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-artifact-manifest.js';
import {parseResultPublicationRecord} from '../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-result-publication.js';
import {parseWorkspaceSealRecord} from '../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/filesystem/contained-turn-workspace-state.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireEvidence = condition => {if (!condition) {throw new Error('Invalid or incomplete live artifact evidence');}};
const same = (a, b) => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => a[key] === b[key]);

// Linux descriptor-relative walks pin every ancestor. Only the deliberate /proc
// descriptor bridge is followed; no directory entry supplied by the store is.
function reader(root) {
  const handles = [], bindings = [], directories = new Map();
  let bytesRead = 0, entriesRead = 0;
  const child = (fd, name) => `/proc/self/fd/${fd}/${name}`;
  function directory(path, parent) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(fd);
    const stat = fstatSync(fd, {bigint: true});
    requireEvidence(stat.isDirectory() && (!parent || stat.dev === parent.dev));
    bindings.push({path, fd, stat});
    return fd;
  }
  function dir(relative) {
    if (directories.has(relative)) {return directories.get(relative);}
    let fd = directories.get(''), path = '';
    for (const part of relative.split('/')) {
      requireEvidence(/^[a-z0-9-]+$/u.test(part));
      path = path ? `${path}/${part}` : part;
      if (!directories.has(path)) {
        directories.set(path, directory(child(fd, part), fstatSync(fd, {bigint: true})));
      }
      fd = directories.get(path);
    }
    return fd;
  }
  try {
    requireEvidence(process.platform === 'linux' && isAbsolute(root) && resolve(root) === root && root !== '/' &&
      root.length <= 4096 && root.split('/').length <= 64);
    let fd = directory('/');
    for (const part of root.slice(1).split('/')) {fd = directory(child(fd, part));}
    directories.set('', fd);
  } catch (error) {for (const fd of handles.reverse()) {closeSync(fd);} throw error;}
  return {
    names(relative, pattern, limit) {
      const fd = dir(relative), stream = opendirSync(`/proc/self/fd/${fd}`), names = [];
      try {
        for (let entry; (entry = stream.readSync()) !== null;) {
          requireEvidence(++entriesRead <= 8192 && names.length < limit && pattern.test(entry.name));
          names.push(entry.name);
        }
      } finally {stream.closeSync();}
      return names.sort();
    },
    read(relative, maxBytes) {
      const parts = relative.split('/'), name = parts.pop();
      requireEvidence(/^[a-z0-9.-]+$/u.test(name));
      const path = child(dir(parts.join('/')), name);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd, {bigint: true});
        requireEvidence(before.isFile() && before.nlink === 1n && before.size <= BigInt(maxBytes) &&
          before.dev === fstatSync(dir(parts.join('/')), {bigint: true}).dev);
        const size = Number(before.size);
        bytesRead += size;
        requireEvidence(bytesRead <= 64 * 1024 * 1024);
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const count = readSync(fd, bytes, offset, size - offset, offset);
          requireEvidence(count > 0); offset += count;
        }
        requireEvidence(readSync(fd, Buffer.alloc(1), 0, 1, size) === 0);
        requireEvidence(same(before, fstatSync(fd, {bigint: true})) && same(before, lstatSync(path, {bigint: true})));
        bindings.push({path, stat: before});
        return bytes;
      } finally {closeSync(fd);}
    },
    verify() {
      for (const {path, fd, stat} of bindings) {
        requireEvidence(same(stat, lstatSync(path, {bigint: true})));
        if (fd !== undefined) {requireEvidence(same(stat, fstatSync(fd, {bigint: true})));}
      }
    },
    close() {for (const fd of handles.reverse()) {closeSync(fd);}},
  };
}

function verifyManifest(fs, manifestDigest, operationId, approval, turn, records) {
  const relativePath = `artifacts/manifests/${manifestDigest.slice(0, 2)}/${manifestDigest}`;
  const encoded = fs.read(relativePath, 32 * 1024 * 1024);
  requireEvidence(digest(encoded) === manifestDigest);
  const manifest = decodeContainedTurnArtifactManifest(encoded);
  if (manifest.operationId !== operationId) {return false;}
  const blobs = new Map();
  let projectedBytes = encoded.length;
  for (const item of [...manifest.entries.filter(item => item.kind === 'file'), ...manifest.output]) {
    projectedBytes += item.size;
    requireEvidence(item.size <= 8 * 1024 * 1024 && projectedBytes <= 32 * 1024 * 1024);
    if (!blobs.has(item.digest)) {
      const bytes = fs.read(`artifacts/blobs/${item.digest.slice(0, 2)}/${item.digest}`, item.size);
      requireEvidence(bytes.length === item.size && digest(bytes) === item.digest);
      blobs.set(item.digest, bytes);
      records.push({kind: 'artifact-blob', value: {
        relativePath: `artifacts/blobs/${item.digest.slice(0, 2)}/${item.digest}`,
        sha256: item.digest, bytes: bytes.length, operationId, manifestDigest,
      }});
    }
    requireEvidence(blobs.get(item.digest).length === item.size);
  }
  const workspaceName = `operation-${digest(JSON.stringify([manifest.tenantId, manifest.projectId, operationId]))}`;
  const resultRef = `urn:agent-runtime:contained-turn-result:${manifestDigest}`;
  const publication = parseResultPublicationRecord(fs.read(`artifacts/results/${workspaceName}.json`, 65536));
  const seal = parseWorkspaceSealRecord(fs.read(`workspaces/seals/${workspaceName}.json`, 65536));
  for (const record of [publication, seal]) {
    requireEvidence(record.operationId === operationId && record.workspaceName === workspaceName &&
      record.manifestDigest === manifestDigest && record.treeDigest === manifest.treeDigest &&
      record.scope.tenantId === manifest.tenantId && record.scope.projectId === manifest.projectId);
  }
  requireEvidence(publication.resultRef === resultRef &&
    publication.manifestReceiptRef === `urn:agent-runtime:artifact-manifest-sealed:${manifestDigest}` &&
    publication.resultReceiptRef === `urn:agent-runtime:result-published:${manifestDigest}`);
  records.push({kind: 'artifact-receipt', value: {relativePath, manifestDigest, record: manifest}},
    {kind: 'artifact-receipt', value: {relativePath: `artifacts/results/${workspaceName}.json`, record: publication}},
    {kind: 'artifact-receipt', value: {relativePath: `workspaces/seals/${workspaceName}.json`, record: seal}});
  const file = manifest.entries.find(item => item.kind === 'file' && item.path === approval.markerFile);
  const fileMatches = !!file && blobs.get(file.digest).equals(Buffer.from(`${approval.marker}\n`));
  // The Codex adapter emits canonical assistant text only at terminal turn
  // completion. Match the entire sealed output against the retained public view,
  // then require the entire assistant response, never tool/diagnostic substrings.
  const linked = turn?.status === 'succeeded' && turn.provider === 'codex' && turn.resultRef === resultRef &&
    turn.artifactManifestRef === `urn:agent-runtime:artifact-manifest:${manifestDigest}`;
  const outputMatches = linked && Array.isArray(turn.output) && turn.output.length === manifest.output.length &&
    manifest.output.every((item, index) => {
      const actual = turn.output[index];
      return actual?.cursor === item.cursor && actual.kind === item.kind && typeof actual.text === 'string' && actual.text.length <= item.size &&
        blobs.get(item.digest).equals(Buffer.from(actual.text));
    });
  const assistant = manifest.output.filter(item => item.kind === 'assistant');
  const finalMatches = outputMatches && assistant.length > 0 &&
    Buffer.concat(assistant.map(item => blobs.get(item.digest))).equals(Buffer.from(approval.marker));
  records.push({kind: 'marker-evidence', value: {operationId, manifestDigest, markerFile: approval.markerFile,
    fileMatches, finalMatches: !!finalMatches}});
  return fileMatches && !!finalMatches;
}

/** Synchronous, read-only collection; the lifecycle owner retains observations,
 * reports these records, and owns cleanup. Failure never promotes partial proof. */
export function collectLinuxCodexLiveEvidence({root, approval, operationId, observations}) {
  const records = [];
  let fs;
  try {
    requireEvidence(typeof operationId === 'string' && operationId.length > 0 && operationId.length <= 1024 &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.txt$/u.test(approval?.markerFile) &&
      /^[A-Za-z0-9_-]{1,128}$/u.test(approval?.marker) && Array.isArray(observations) && observations.length <= 4096);
    let turn;
    for (const value of observations) {
      if (value?.status !== 'observed' || value.turn?.operationId !== operationId) {continue;}
      requireEvidence(Number.isSafeInteger(value.turn.revision) && value.turn.revision >= 0);
      if (!turn || value.turn.revision >= turn.revision) {turn = value.turn;}
    }
    fs = reader(root);
    let markerObserved = false;
    for (const shard of fs.names('artifacts/manifests', /^[a-f0-9]{2}$/u, 256)) {
      for (const name of fs.names(`artifacts/manifests/${shard}`, /^[a-f0-9]{64}$/u, 4096)) {
        requireEvidence(name.startsWith(shard));
        markerObserved = verifyManifest(fs, name, operationId, approval, turn, records) || markerObserved;
      }
    }
    fs.verify();
    return {markerObserved, records};
  } catch {
    return {markerObserved: false, records: [...records, {kind: 'evidence-incomplete', value: {stage: 'artifact-verification'}}]};
  } finally {fs?.close();}
}

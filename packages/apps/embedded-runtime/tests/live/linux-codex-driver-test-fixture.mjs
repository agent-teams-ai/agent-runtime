import {join} from 'node:path';
export const SOURCE = '1'.repeat(40); // Explicit synthetic approved revision, never a runtime pin.

export const bytes = {encoding: 'base64', data: 'e30='};
export const config = root => ({ownerApproved: true, disposableDatabase: true, disposableTestParent: true,
  databaseUrl: 'postgresql://test@127.0.0.1:5432/ar69_pa_test_driver',
  evidenceDirectory: join(root, 'evidence'), approval: {commandId: 'command:driver', testId: 'driver', marker: 'hello', markerFile: 'marker.txt'},
  hostPins: {sourceRevision: SOURCE, testParent: join(root, 'project'), native: {catalogSource: bytes}, certificateAuthorities: [bytes]}});

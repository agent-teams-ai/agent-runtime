import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDarwinSingletonCustodyOwner } from '../../../src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-singleton-custody-owner.ts';

// Test-owned trusted boundary. No OS policy qualification or native effects.
function fixture() {
  const binding = { operation: 'op', attempt: 'attempt', custody: 'custody',
    hostGeneration: 'host-1', helper: 'helper-pin', profile: 'restricted-profile',
    policy: 'policy-pin', ipcPolicy: 'ipc-pin', imageChain: ['launcher-pin', 'provider-pin'] };
  const birth = { pid: 321, seconds: 42, micros: 13 };
  const admission = { binding: structuredClone(binding), birth: { ...birth },
    ordering: 'policy-and-observer-before-untrusted-exec',
    descendants: 'all-creation-denied-across-exec',
    delegation: 'mach-xpc-launch-services-and-capability-transfer-denied',
    inheritedAuthority: 'only-owned-stdio-and-bounded-model-http',
    imageEnforcement: 'exact-chain-enforced-through-exit' };
  const terminal = { binding: structuredClone(binding), birth: { ...birth },
    imageChain: [...binding.imageChain], exit: 'exact-birth-exited', launch: 'settled',
    stdout: 'sealed', stderr: 'sealed', ownerFlights: 'settled' };
  const calls = { reserve: 0, admission: 0, close: 0, terminal: 0 };
  const control = { admission: { kind: 'authenticated', evidence: admission },
    terminal: { kind: 'authenticated', evidence: terminal }, close: 'closed' };
  const bridge = { reserve(captured) {
    calls.reserve++;
    assert.ok(Object.isFrozen(captured));
    assert.ok(Object.isFrozen(captured.imageChain));
    return {
      readAdmission() { calls.admission++; return control.admission; },
      closeAdmission() { calls.close++; return control.close; },
      readTerminal() { calls.terminal++; return control.terminal; },
    };
  } };
  const owner = createDarwinSingletonCustodyOwner('host-1', bridge);
  const reservation = owner.reserve(binding);
  const ready = () => {
    const custody = owner.admit(reservation);
    assert.ok(custody);
    assert.equal(owner.closeAdmission(reservation), true);
    return custody;
  };
  return { binding, admission, terminal, control, calls, bridge, owner, reservation, ready };
}
test('authenticated sequence closes synchronously, consumes once, and has no duplicate terminal reads', () => {
  const f = fixture();
  const c = f.ready();
  assert.equal(f.calls.close, 1);
  const proof = f.owner.settle(f.reservation, c);
  assert.ok(proof);
  assert.equal(f.owner.settle(f.reservation, c), undefined);
  assert.equal(f.owner.closeAdmission(f.reservation), false);
  assert.equal(f.owner.consume(f.reservation, proof), true);
  assert.equal(f.owner.consume(f.reservation, proof), false);
  assert.equal(f.calls.terminal, 1);
});
test('no native dependency, stale generation, malformed binding and duplicate reservation fail closed', () => {
  const f = fixture();
  assert.equal(createDarwinSingletonCustodyOwner('host-1').reserve(f.binding), undefined);
  for (const bad of [{ ...f.binding, hostGeneration: 'old' }, { ...f.binding, policy: '' },
    { ...f.binding, imageChain: [] }, { ...f.binding, imageChain: Array(2) }, f.binding]) {
    assert.equal(f.owner.reserve(bad), undefined);
  }
  assert.equal(f.calls.reserve, 1);
});
const copies = (token) => [{}, { ...token }, JSON.parse(JSON.stringify(token)),
  Object.create(Object.getPrototypeOf(token)), Object.create(token),
  Object.defineProperties({}, Object.getOwnPropertyDescriptors(token))];
test('plain, copied, JSON, prototype, descriptor and foreign reservations make zero boundary calls', () => {
  const f = fixture();
  const foreign = fixture();
  for (const token of [...copies(f.reservation), foreign.reservation, null, 7]) {
    const before = { ...f.calls };
    assert.equal(f.owner.admit(token), undefined);
    assert.equal(f.owner.closeAdmission(token), false);
    f.owner.cutoff(token);
    assert.equal(f.owner.settle(token, {}), undefined);
    assert.equal(f.owner.consume(token, {}), false);
    assert.deepEqual(f.calls, before);
  }
});
test('custody and closure cannot transfer, copy or replay across owners or reservations', () => {
  const f = fixture();
  const foreign = fixture();
  const c = f.ready();
  const foreignCustody = foreign.ready();
  const other = f.owner.reserve({ ...f.binding, attempt: 'other' });
  for (const bad of [...copies(c), foreignCustody, f.reservation]) {
    const before = { ...f.calls };
    assert.equal(f.owner.settle(f.reservation, bad), undefined);
    assert.deepEqual(f.calls, before);
  }
  assert.equal(f.owner.settle(other, c), undefined);
  const proof = f.owner.settle(f.reservation, c);
  for (const bad of [...copies(proof), foreign.owner.settle(foreign.reservation, foreignCustody)]) {
    assert.equal(f.owner.consume(f.reservation, bad), false);
  }
  assert.equal(f.owner.consume(other, proof), false);
  assert.equal(foreign.owner.consume(foreign.reservation, proof), false);
  assert.equal(f.owner.consume(f.reservation, proof), true);
  assert.equal(f.owner.admit(f.reservation), undefined);
});
for (const phase of ['admission', 'terminal']) {
  for (const key of ['operation', 'attempt', 'custody', 'hostGeneration', 'helper', 'profile', 'policy', 'ipcPolicy', 'imageChain']) {
    test(`${phase}: exact ${key} mismatch is permanently uncertain`, () => {
      const f = fixture();
      const c = phase === 'terminal' ? f.ready() : undefined;
      const record = f[phase].binding;
      const original = record[key];
      record[key] = key === 'imageChain' ? ['forbidden'] : 'wrong';
      assert.equal(phase === 'admission' ? f.owner.admit(f.reservation) : f.owner.settle(f.reservation, c), undefined);
      record[key] = original;
      const before = { ...f.calls };
      assert.equal(phase === 'admission' ? f.owner.admit(f.reservation) : f.owner.settle(f.reservation, c), undefined);
      assert.deepEqual(f.calls, before);
    });
  }
}
for (const key of ['ordering', 'descendants', 'delegation', 'inheritedAuthority', 'imageEnforcement']) {
  test(`reject missing or invalid policy obligation: ${key}`, () => {
    for (const value of [undefined, 'allowed', true]) {
      const f = fixture();
      f.admission[key] = value;
      assert.equal(f.owner.admit(f.reservation), undefined);
      assert.equal(f.calls.terminal, 0);
      f.owner.cutoff(f.reservation);
      assert.equal(f.calls.close, 1);
    }
  });
}
for (const key of ['pid', 'seconds', 'micros']) {
  test(`invalid admission birth and mismatched terminal ${key}`, () => {
    const f = fixture();
    f.admission.birth[key] = -1;
    assert.equal(f.owner.admit(f.reservation), undefined);
    const g = fixture();
    const c = g.ready();
    g.terminal.birth[key]++;
    assert.equal(g.owner.settle(g.reservation, c), undefined);
  });
}
for (const key of ['launch', 'stdout', 'stderr', 'ownerFlights', 'exit', 'imageChain']) {
  test(`partial terminal ${key} cannot close or later recover`, () => {
    const f = fixture();
    const c = f.ready();
    const original = f.terminal[key];
    f.terminal[key] = key === 'imageChain' ? ['launcher-pin', 'shell'] : 'pending';
    assert.equal(f.owner.settle(f.reservation, c), undefined);
    f.terminal[key] = original;
    assert.equal(f.owner.settle(f.reservation, c), undefined);
    assert.equal(f.calls.terminal, 1);
  });
}
test('pending acknowledgment may settle before closure, late acknowledgment never admits', () => {
  const f = fixture();
  f.control.admission = { kind: 'pending' };
  assert.equal(f.owner.admit(f.reservation), undefined);
  f.control.admission = { kind: 'authenticated', evidence: f.admission };
  assert.ok(f.owner.admit(f.reservation));
  for (const action of ['closeAdmission', 'cutoff']) {
    const g = fixture();
    g.control.admission = { kind: 'pending' };
    g.owner.admit(g.reservation);
    g.owner[action](g.reservation);
    g.control.admission = { kind: 'authenticated', evidence: g.admission };
    assert.equal(g.owner.admit(g.reservation), undefined);
    assert.equal(g.calls.close, 1);
  }
});
test('pending terminal waits; cutoff before settlement remains unknown', () => {
  for (const cutoff of [false, true]) {
    const f = fixture();
    const c = f.ready();
    assert.equal(f.owner.settle(f.reservation, {}), undefined);
    f.control.terminal = { kind: 'pending' };
    assert.equal(f.owner.settle(f.reservation, c), undefined);
    if (cutoff) {f.owner.cutoff(f.reservation);}
    f.control.terminal = { kind: 'authenticated', evidence: f.terminal };
    assert.equal(!!f.owner.settle(f.reservation, c), !cutoff);
  }
});
test('unknown, absent, throwing and promise acknowledgments are never proof', () => {
  for (const value of [{ kind: 'unknown' }, undefined, {}, Promise.resolve({ kind: 'pending' }),
    { get kind() { throw Error('native failure'); } }]) {
    const f = fixture();
    f.control.admission = value;
    assert.equal(f.owner.admit(f.reservation), undefined);
    f.control.admission = { kind: 'authenticated', evidence: f.admission };
    assert.equal(f.owner.admit(f.reservation), undefined);
    const g = fixture();
    const c = g.ready();
    g.control.terminal = value;
    assert.equal(g.owner.settle(g.reservation, c), undefined);
  }
});
test('unknown or asynchronous admission closure cannot authorize terminal', () => {
  for (const value of ['unknown', undefined, Promise.resolve('closed')]) {
    const f = fixture();
    const c = f.owner.admit(f.reservation);
    f.control.close = value;
    assert.equal(f.owner.closeAdmission(f.reservation), false);
    assert.equal(f.owner.settle(f.reservation, c), undefined);
    assert.equal(f.calls.terminal, 0);
  }
});
test('binding and birth snapshots survive caller mutation; retired Host invalidates proof', () => {
  const f = fixture();
  const c = f.ready();
  f.binding.policy = 'changed';
  f.binding.imageChain.push('shell');
  f.admission.birth.pid++;
  const proof = f.owner.settle(f.reservation, c);
  assert.ok(proof);
  f.owner.cutoff(f.reservation); // Already closed is not retroactively uncertain.
  f.owner.retire();
  const before = { ...f.calls };
  assert.equal(f.owner.consume(f.reservation, proof), false);
  assert.equal(f.owner.reserve(f.binding), undefined);
  assert.equal(f.owner.admit(f.reservation), undefined);
  assert.deepEqual(f.calls, before);
});
test('terminal cannot be observed until synchronous admission closure', () => {
  const f = fixture();
  const c = f.owner.admit(f.reservation);
  assert.equal(f.owner.settle(f.reservation, c), undefined);
  assert.equal(f.calls.terminal, 0);
  assert.equal(f.owner.closeAdmission(f.reservation), true);
  assert.ok(f.owner.settle(f.reservation, c));
});
test('reentrant cutoff during native reads cannot resurrect custody', () => {
  for (const phase of ['admission', 'terminal']) {
    const f = fixture();
    const c = phase === 'terminal' ? f.ready() : undefined;
    Object.defineProperty(f.control, phase, { get() {
      f.owner.cutoff(f.reservation);
      return { kind: 'authenticated', evidence: f[phase] };
    } });
    assert.equal(phase === 'admission' ? f.owner.admit(f.reservation) : f.owner.settle(f.reservation, c), undefined);
    assert.equal(f.owner.admit(f.reservation), undefined);
    assert.equal(f.owner.settle(f.reservation, c), undefined);
  }
});
test('reentrant cutoff during native admission closure cannot reopen settlement', () => {
  const f = fixture();
  const c = f.owner.admit(f.reservation);
  Object.defineProperty(f.control, 'close', { get() {
    f.owner.cutoff(f.reservation);
    return 'closed';
  } });
  assert.equal(f.owner.closeAdmission(f.reservation), false);
  assert.equal(f.owner.settle(f.reservation, c), undefined);
  assert.equal(f.calls.terminal, 0);
});
test('failed native reservation is never retried under the same identity', () => {
  const f = fixture();
  for (const result of [undefined, 'throw']) {
    let calls = 0;
    const owner = createDarwinSingletonCustodyOwner('host-1', { reserve() {
      calls++;
      if (result === 'throw') { throw Error('unknown launch outcome'); }
      return;
    } });
    assert.equal(owner.reserve(f.binding), undefined);
    assert.equal(owner.reserve(f.binding), undefined);
    assert.equal(calls, 1);
  }
});

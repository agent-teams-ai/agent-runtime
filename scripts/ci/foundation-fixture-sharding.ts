// Private registration/report mechanism for this one reviewed Foundation suite.
import nodeTest from 'node:test';
import type { TestFn, EventData } from 'node:test';
import type { TestEvent } from 'node:test/reporters';

export const protocol = 'foundation-fixtures/1';
export const suite = 'installed Foundation adapter boundary checks';
const marker = 'foundation-fixture-registration ';
// Order is the original registration order. Each leaf belongs to index % 3.
const names = [
  'the named negative suite runs exactly once through every Foundation gate',
  'contained-turn domain and application remain dependency-free core',
  'Filesystem Custody source collector keeps policy inside its scoped tooling boundary',
  'Node compatibility CI owns its APIs without granting PostgreSQL or future CI files those imports',
  'the real parser observes every retained Node import in composition and TLS support',
  'Node permissions do not follow imports moved into core or undeclared adapter locations',
  'Embedded Runtime Node utility permission belongs to exact Host composition and ordinary adapter paths',
  'transitional boundaries and adapter permissions remain exact',
  'Docker custody uses only the engine port and explicit residue construction entrypoint',
  'installed Foundation parser detects a nonliteral runtime reference',
  'a forbidden boundary cannot import a legal target entrypoint',
  'existing Host and SDK capabilities retain their exact ownership',
  'Darwin retained-owner consumers use the narrow workspace entrypoint',
  'Codex evidence utilities do not grant spawn or network ownership',
  'Claude may import only narrow provider-delegation and private-directory ports',
  'Docker custody may import the port and construction boundary, but not engine internals',
  'Docker JSON remains neutral and cannot import its engine consumer',
  'V4 listener composition uses one Docker entrypoint; Host still cannot import it',
  'Docker process composition uses its narrow entrypoint and a type-only Host projection',
  'native abort subscriptions stay in physical adapters, never core or outer composition',
  'Get Modular belongs only to Embedded Runtime composition, including type imports',
  'Host custody cannot import the filesystem workspace owner backwards',
  'Darwin native launch consumers use declared custody and Codex entrypoints',
  'source v3 rejects includeRootPackage as an unknown public field',
  'production Docker implementation cannot import its development-only fake',
] as const;

export function fixtureRegistration(env: Readonly<Record<string, string | undefined>>) {
  const values = [env.FOUNDATION_FIXTURE_PROTOCOL, env.FOUNDATION_FIXTURE_INDEX, env.FOUNDATION_FIXTURE_COUNT];
  const active = values.some(value => value !== undefined);
  if (active && (values[0] !== protocol || !/^[012]$/u.test(values[1] ?? '') || values[2] !== '3')) {
    throw new Error('invalid Foundation fixture protocol/index/count; require foundation-fixtures/1, 0..2, 3 together');
  }
  const index = active ? Number(values[1]) : null;
  const encountered: string[] = [], registered: string[] = [], excluded: string[] = [];
  let closed = false;
  return {
    test(name: string, fn: TestFn): Promise<void> {
      if (closed || encountered.includes(name) || name !== names[encountered.length]) {
        throw new Error(`Foundation fixture registration drift/duplicate: ${name}`);
      }
      const position = encountered.length;
      encountered.push(name);
      if (index !== null && position % 3 !== index) {
        excluded.push(name); // No Node registration, skip, or body invocation.
        return Promise.resolve();
      }
      registered.push(name);
      return nodeTest(name, fn);
    },
    finish(): string | undefined {
      if (closed || encountered.length !== names.length || registered.length === 0) {
        throw new Error('incomplete/empty Foundation fixture registration');
      }
      closed = true;
      return active ? marker + JSON.stringify({ protocol, index, count: 3, encountered, registered, excluded }) : undefined;
    },
  };
}

// Node's public reporter stream observes completion separately from registration.
// A report is evidence even on failure; the aggregate decides whether it passed.
export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let stdout = '';
  const events: { name: string; nesting: number; status: string; skip: boolean; todo: boolean; type: string; error?: string }[] = [];
  const summaries: EventData.TestSummary[] = [];
  for await (const event of source) {
    if (event.type === 'test:stdout') {stdout += event.data.message;}
    if (event.type === 'test:summary') {summaries.push(event.data);}
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      events.push({ name: event.data.name, nesting: event.data.nesting,
        status: event.type === 'test:pass' ? 'passed' : 'failed',
        skip: Boolean(event.data.skip), todo: Boolean(event.data.todo), type: event.data.details.type ?? 'test',
        ...(event.type === 'test:fail' ? { error: String(event.data.details.error) } : {}) });
    }
  }
  const registrations: unknown[] = stdout.split('\n').filter(line => line.startsWith(marker))
    .map(line => JSON.parse(line.slice(marker.length)) as unknown);
  yield JSON.stringify({ protocol, registrations, events, summaries }) + '\n';
}

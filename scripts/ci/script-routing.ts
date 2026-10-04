import assert from 'node:assert/strict';

export type Scripts = Readonly<Record<string, string>>;
export interface Command { readonly script: string; readonly command: string }
const alias = /^pnpm (?:run )?([\w:-]+)$/u;
const routing = /^pnpm [\w:-]+(?: && pnpm [\w:-]+)*$/u;

// A deliberately bounded package-script grammar, not a shell interpreter.
// Foundation 1.7.2 exposes no public script-reachability contract; policy stays here.
export function commandInventory(scripts: Scripts, name: string, stack: readonly string[] = []): Command[] {
  assert.ok(!stack.includes(name), `script cycle: ${[...stack, name].join(' -> ')}`);
  const source = scripts[name];
  assert.ok(typeof source === 'string', `missing script: ${name}`);
  const commands = source.split(' && ');
  return commands.flatMap(command => {
    const child = alias.exec(command)?.[1];
    if (child) { return commandInventory(scripts, child, [...stack, name]); }
    assert.match(command, /^(?:node |agent-teams-[\w-]+ |oxlint |tsc |pnpm --filter )/u,
      `nonblocking or unsupported command: ${name}`);
    assert.ok(!/[;|#\n\r]/u.test(command), `nonblocking command: ${name}`);
    return [{ script: name, command }];
  });
}

// Retain each reviewed terminal script identity for existing adoption assertions.
export function routedScripts(scripts: Scripts, name: string): string[] {
  commandInventory(scripts, name);
  const source = scripts[name];
  assert.ok(source);
  if (!routing.test(source)) { return [`pnpm ${name}`]; }
  return source.split(' && ').flatMap(command => {
    const child = alias.exec(command)?.[1];
    assert.ok(child);
    return routedScripts(scripts, child);
  });
}

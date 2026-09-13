// Invented RPC peer only. Never loads an auth session or calls a provider.
import {createInterface} from 'node:readline';
const scenario = process.argv[2]; let tokens = 0, accounts = 0;
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line); if (request.method === 'initialized') {return;}
  if (scenario === 'hang') {return;}
  let result = {};
  switch (request.method) {
    case 'initialize': break;
    case 'account/read': result = {account: {type: scenario === 'wrongmode' ? 'apiKey' : 'chatgpt', email: ++accounts === 2 && scenario === 'modechanged' ? 'changed@example.invalid' : 'invented@example.invalid'}, requiresOpenaiAuth: true}; break;
    case 'getAuthStatus': result = {authMethod: scenario === 'external' ? 'chatgptAuthTokens' : 'chatgpt', authToken: ++tokens === 2 && scenario === 'tokenchange' ? 'invented-other' : 'invented-secret', requiresOpenaiAuth: true}; break;
    case 'account/rateLimits/read': result = scenario === 'missingaccount' ? {} : {accountId: scenario === 'nullaccount' ? null : 'invented-account'}; break;
    default: process.exit(9);
  }
  if (scenario === 'totalbuffer') {process.stderr.write('x'.repeat(262145)); return;}
  if (scenario === 'oversize') {process.stdout.write('x'.repeat(65537)); return;}
  if (scenario === 'parser') {process.stdout.write('{bad\n'); return;}
  if (scenario === 'duplicatekey') {process.stdout.write('{"id":"1","id":"1","result":{}}\n'); return;}
  if (scenario === 'rawerror') {process.stderr.write('invented-secret'); process.stdout.write(JSON.stringify({id: request.id, error: {code: 1, message: 'invented-secret'}})+'\n'); return;}
  process.stdout.write(JSON.stringify({id: request.id, result})+'\n');
}).on('close', () => {if (scenario === 'exitdelay') {setTimeout(() => process.exit(0), 120);} else if (scenario === 'badexit') {process.exit(3);}});

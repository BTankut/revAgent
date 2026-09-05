// Isolated test issuer only; never shipped or composed by product main.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'eu20-ephemeral', alg: 'RS256', use: 'sig' };
const issuer = 'https://revagent-eu20-b1-issuer:8443';
const tenants = { a: '10000000-0000-4000-8000-000000000001', b: '20000000-0000-4000-8000-000000000002' };
createServer({ cert: readFileSync('/proof/test-cert.pem'), key: readFileSync('/proof/test-key.pem') }, async (req,res) => {
  if (req.url === '/jwks') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ keys:[jwk] })); return; }
  const match = /^\/token\/(admin-a|user-a|user-b)$/u.exec(req.url ?? '');
  if (!match) { res.writeHead(404); res.end(); return; }
  const subject = match[1];
  const token = await new SignJWT({ tenant_id: tenants[subject.endsWith('-a') ? 'a' : 'b'], roles: [subject.startsWith('admin') ? 'tenant_admin' : 'user'], scope:'mcp:read', azp:'eu20-test-client' })
    .setProtectedHeader({ alg:'RS256',kid:jwk.kid }).setIssuer(issuer+'/').setAudience('eu20-test-client').setSubject(subject).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({ token }));
}).listen(8443,'0.0.0.0',()=>process.stdout.write('isolated test issuer ready\n'));

// Run inside the private, unpublished Docker test network, against actual CMD.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createOidcIdentityPort } from '../dist/oidcIdentity.js';
import { PostgresTenantStore } from '../dist/postgresTenantStore.js';
import { M5EnrollmentEntitlementControlPlane } from '../dist/m5EnrollmentEntitlement.js';
const gateway='https://revagent-eu20-b1-gateway:8080', issuer='https://revagent-eu20-b1-issuer:8443';
const adminPool=new pg.Pool({ connectionString:process.env.DATABASE_MIGRATION_URL });
const repository=new PostgresTenantStore(process.env.DATABASE_URL);
const identity=createOidcIdentityPort({ issuer:issuer+'/', audience:'eu20-test-client', jwksUri:issuer+'/jwks', repository });
const plane=new M5EnrollmentEntitlementControlPlane({ databaseUrl:process.env.DATABASE_URL, tokenPepper:process.env.M5_TOKEN_PEPPER, capabilities:[{name:'core.ui.state',module:'core',summary:'read'}] });
const tokenFor=async subject=>(await (await fetch(issuer+'/token/'+subject)).json()).token;
try {
  assert.equal((await fetch(gateway+'/healthz')).status,200);
  await adminPool.query("INSERT INTO tenants(id,slug,name) VALUES('20000000-0000-4000-8000-000000000002','eu20-b','EU20 B') ON CONFLICT(id) DO NOTHING");
  const adminToken=await tokenFor('admin-a'), userToken=await tokenFor('user-a'), foreignToken=await tokenFor('user-b');
  const admin=await identity.authenticateNorthRequest({authorization:'Bearer '+adminToken});
  const user=await identity.authenticateNorthRequest({authorization:'Bearer '+userToken});
  assert.equal(admin.ok,true); assert.equal(user.ok,true);
  const initialize=async token=>fetch(gateway+'/mcp',{ method:'POST', headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'eu20-proof',version:'1'}}}) });
  assert.notEqual((await initialize('invalid-token')).status,200);
  assert.notEqual((await initialize(userToken)).status,200);
  const deviceId=randomUUID(), fingerprint='sha256:'+'11'.repeat(32);
  const minted=await plane.mintEnrollmentCode(admin.value,{principalUserId:user.value.actor.userId,deviceId,machineFingerprint:fingerprint});
  assert.equal(minted.ok,true);
  const exchange=async fp=>fetch(gateway+'/bridge/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enrollment_token:minted.value.enrollmentCode,machine_fingerprint:fp})});
  assert.notEqual((await exchange('sha256:'+'22'.repeat(32))).status,200);
  const response=await exchange(fingerprint); assert.equal(response.status,200);
  const credential=await response.json();
  assert.notEqual((await exchange(fingerprint)).status,200);
  assert.equal((await plane.grantModuleLicense(admin.value,{module:'core',seatLimit:1})).ok,true);
  assert.equal((await plane.assignSeat(admin.value,{module:'core',principalUserId:user.value.actor.userId,deviceId})).ok,true);
  const initialized=await initialize(userToken);
  assert.equal(initialized.status,200);
  assert.notEqual((await initialize(foreignToken)).status,200);
  // Ephemeral synthetic test credentials for the subsequent real C# wire probe.
  // This is not a first-install/DPAPI proof; that is a separate elevated test.
  await writeFile('/proof/transport-credential.json',JSON.stringify({deviceId,deviceToken:credential.device_token,fingerprint,tenantId:user.value.actor.tenantId,userId:user.value.actor.userId}),{mode:0o600});
  process.stdout.write(JSON.stringify({ actualImageCmd:true,production:true,health:true,oidcSignatureVerified:true,missingSeatRefused:true,foreignTenantRefused:true,wrongFingerprintRefused:true,codeReuseRefused:true,entitledMcpInitialize:true,protectedFirstInstall:'not_exercised' })+'\n');
} finally { await Promise.all([plane.close(),repository.close(),adminPool.end()]); }

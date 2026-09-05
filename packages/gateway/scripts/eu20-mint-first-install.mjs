// Private integration fixture: stdout is a secret handoff pipe, never a log.
// Receives ONLY the public fingerprint produced by the genuine C# process.
import { randomUUID } from 'node:crypto';
import { createOidcIdentityPort } from '../dist/oidcIdentity.js';
import { PostgresTenantStore } from '../dist/postgresTenantStore.js';
import { M5EnrollmentEntitlementControlPlane } from '../dist/m5EnrollmentEntitlement.js';
const fingerprint=process.argv[2];
if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint??'')) throw new Error('public fingerprint required');
const issuer='https://revagent-eu20-b1-issuer:8443';
const repository=new PostgresTenantStore(process.env.DATABASE_URL);
const identity=createOidcIdentityPort({issuer:issuer+'/',audience:'eu20-test-client',jwksUri:issuer+'/jwks',repository});
const plane=new M5EnrollmentEntitlementControlPlane({databaseUrl:process.env.DATABASE_URL,tokenPepper:process.env.M5_TOKEN_PEPPER,capabilities:[{name:'core.ui.state',module:'core',summary:'read'}]});
try {
  const authenticate=async subject=>identity.authenticateNorthRequest({authorization:'Bearer '+(await (await fetch(issuer+'/token/'+subject)).json()).token});
  const admin=await authenticate('admin-a'),user=await authenticate('user-a');
  if (!admin.ok||!user.ok) throw new Error('OIDC test identity refused');
  const deviceId=randomUUID();
  const minted=await plane.mintEnrollmentCode(admin.value,{principalUserId:user.value.actor.userId,deviceId,machineFingerprint:fingerprint});
  if (!minted.ok) throw new Error('bound enrollment mint refused');
  // Assignment requires an enrolled credential, so the driver uses the
  // separate entitlement completion command after C# consumes/exchanges.
  if (!(await plane.grantModuleLicense(admin.value,{module:'core',seatLimit:1})).ok) throw new Error('test license refused');
  process.stdout.write(JSON.stringify({artifact:{contractVersion:'revagent.m4-enrollment-artifact/v1',enrollmentToken:minted.value.enrollmentCode,expiresAtMs:minted.value.expiresAtMs},deviceId,principalUserId:user.value.actor.userId}));
} catch {process.stderr.write('genuine first-install mint handoff failed\n');process.exitCode=1;}
finally {await Promise.all([plane.close(),repository.close()]);}

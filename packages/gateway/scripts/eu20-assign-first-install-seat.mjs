import { createOidcIdentityPort } from '../dist/oidcIdentity.js';
import { PostgresTenantStore } from '../dist/postgresTenantStore.js';
import { M5EnrollmentEntitlementControlPlane } from '../dist/m5EnrollmentEntitlement.js';
const issuer='https://revagent-eu20-b1-issuer:8443';
const repository=new PostgresTenantStore(process.env.DATABASE_URL);
const identity=createOidcIdentityPort({issuer:issuer+'/',audience:'eu20-test-client',jwksUri:issuer+'/jwks',repository});
const plane=new M5EnrollmentEntitlementControlPlane({databaseUrl:process.env.DATABASE_URL,tokenPepper:process.env.M5_TOKEN_PEPPER,capabilities:[{name:'core.ui.state',module:'core',summary:'read'}]});
try {
  const token=(await (await fetch(issuer+'/token/admin-a')).json()).token;
  const actor=await identity.authenticateNorthRequest({authorization:'Bearer '+token});
  if (!actor.ok) throw new Error('test OIDC refused');
  const result=await plane.assignSeat(actor.value,{module:'core',principalUserId:process.argv[2],deviceId:process.argv[3]});
  if(!result.ok) throw new Error('test seat assignment refused');
  process.stdout.write('{"assigned":true}\n');
} finally {await Promise.all([plane.close(),repository.close()]);}

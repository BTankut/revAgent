import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import pg from 'pg';
const issuer='https://revagent-eu20-b1-issuer:8443';
const {token}=await (await fetch(issuer+'/token/user-a')).json();
const client=new Client({name:'eu20-actual-image-csharp-proof',version:'1'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('https://revagent-eu20-b1-gateway:8080/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));
  const result=await client.callTool({name:'core.ui.state',arguments:{}});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.ok(JSON.stringify(result).includes('eu20-real-csharp'),JSON.stringify(result));
  // A previously initialized client must lose entitlement on its next request.
  // Only this isolated fixture's runtime role/data are used for the transition.
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const connection=await pool.connect();
  const licenseState=async status=>{
    await connection.query('BEGIN');await connection.query('SET LOCAL ROLE revagent_app');
    await connection.query("SELECT set_config('app.tenant_id','10000000-0000-4000-8000-000000000001',true)");
    await connection.query("UPDATE module_licenses SET status=$1 WHERE module_name='core'",[status]);
    await connection.query('COMMIT');
  };
  let revokedLicenseRefused=false;
  try {
    await licenseState('revoked');
    const denied=await fetch('https://revagent-eu20-b1-gateway:8080/mcp',{
      method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:'revoked-license',method:'tools/call',params:{name:'core.ui.state',arguments:{}}})});
    assert.equal(denied.status,403);
    assert.equal((await denied.json()).error,'entitlement_denied');
    revokedLicenseRefused=true;
    assert.equal(revokedLicenseRefused,true);
  } finally {await licenseState('active');connection.release();await pool.end();}
  process.stdout.write(JSON.stringify({actualImageCmd:true,authenticatedEntitledRead:true,revokedLicenseRefused,tool:'core.ui.state',result})+'\n');
} finally {await client.close();}

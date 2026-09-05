// Coordinator-only isolated proof. Docker ports stay unpublished. The relay
// binds numeric loopback and forwards opaque TLS bytes through docker exec.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { resolve, join } from 'node:path';
import { AddinLoopbackFixture } from '../../addin-loopback-fixture/dist/index.js';
const [root, proofRoot, binding='wss', mode='transport']=process.argv.slice(2);
const genuine=mode==='genuine'||mode==='genuine-restart';
const restart=mode==='genuine-restart';
assert.ok(['transport','genuine','genuine-restart'].includes(mode));
assert.ok(root && proofRoot && ['wss','streamable_http_sse'].includes(binding));
const credential=genuine?null:JSON.parse(await readFile(join(proofRoot,'transport-credential.json'),'utf8'));
const certificate=new X509Certificate(await readFile(join(proofRoot,'test-cert.pem')));
const pin=certificate.fingerprint256.replaceAll(':','').toLowerCase();
const fixture=new AddinLoopbackFixture();
fixture.registerHandler('get_ui_state','read_only',()=>({status:'completed',result:{source:'eu20-real-csharp',activeView:{id:'1001'}}}));
const address=await fixture.start();
const sockets=new Set(), relays=new Set();
const relay=createServer(socket=>{
  sockets.add(socket);
  const process=spawn('docker',['exec','-i','revagent-eu20-b1-gateway','node','-e',"const s=require('net').connect(8080,'127.0.0.1',()=>process.stdin.pipe(s));s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('end',()=>process.exit(0));process.stdin.on('end',()=>s.end());"],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  relays.add(process); socket.pipe(process.stdin); process.stdout.pipe(socket);
  process.stdin.on('error',()=>socket.destroy());
  process.on('exit',()=>{relays.delete(process);socket.destroy();});
  socket.on('error',()=>{}); socket.on('close',()=>{sockets.delete(socket);process.kill();});
});
await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(0,'127.0.0.1',resolve);});
const port=relay.address().port;
const state=restart?JSON.parse(await readFile(join(proofRoot,'genuine-state-root.json'),'utf8')).state:join(proofRoot,'csharp-'+binding+'-'+Date.now()); await mkdir(state,{recursive:true});
const worker=spawn('dotnet',[resolve(root,'packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/bin/Debug/net8.0/RevAgent.Bridge.RealWorkerHost.dll'),
 '--gateway-uri',`${binding==='wss'?'wss':'https'}://localhost:${port}/bridge/v1`, '--addin-port',String(address.port),'--fixture-pid',String(process.pid),
 '--install-root',join(state,'install'),'--state-root',join(state,'state'),
 ...(genuine?[restart?'--genuine-enrolled-restart':'--genuine-first-install','true']:['--device-id',credential.deviceId,'--device-token',credential.deviceToken,'--fingerprint',credential.fingerprint]),
 '--certificate-sha256',pin,'--binding',binding,'--test-heartbeat-interval-ms','1000'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
worker.stdin.on('error',()=>{});
let stdout='',stderr=''; worker.stdout.on('data',chunk=>{stdout+=String(chunk);});worker.stderr.on('data',chunk=>{stderr+=String(chunk);});
let workerExit=null;worker.once('exit',code=>{workerExit=code;});
try {
  if(genuine&&!restart){
    const deadline=Date.now()+20_000;
    while(!stdout.includes('enrollment_handoff_ready')&&workerExit===null&&Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    if(workerExit===77) {process.stdout.write('{"genuineFirstInstall":"unproven","reason":"requires_elevated_fixture_process"}\n');process.exitCode=77;throw new Error('genuine first-install proof requires an existing elevated fixture runner');}
    assert.equal(workerExit,null,`genuine C# preparation exited ${workerExit} before fingerprint readiness; see csharp-${mode}-${binding}-worker.log`);
    const ready=stdout.split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.action==='enrollment_handoff_ready');
    assert.ok(ready?.genuineFirstInstall && /^sha256:[0-9a-f]{64}$/u.test(ready.machineFingerprint),'genuine C# fingerprint readiness was absent or invalid before its deadline');
    const runPrivate=scriptArgs=>new Promise((resolve,reject)=>{
      const child=spawn('docker',['run','--rm','--network','revagent-eu20-b1-private','--env-file',join(proofRoot,'gateway.env'),'-v',`${proofRoot}:/proof:ro`,'-v',`${join(root,'packages/gateway/scripts')}:/app/packages/gateway/scripts:ro`,'revagent-eu20-b1-gateway:local','node',...scriptArgs],{windowsHide:true});
      let output='';child.stdout.on('data',c=>{output+=String(c);});child.stderr.resume();
      child.once('exit',code=>code===0?resolve(output):reject(new Error('private fixture handoff failed')));child.once('error',reject);
    });
    const issued=JSON.parse(await runPrivate(['packages/gateway/scripts/eu20-mint-first-install.mjs',ready.machineFingerprint]));
    const destination=join(state,'state','credentials','enrollment.json');
    const temporary=destination+'.handoff';
    await writeFile(temporary,JSON.stringify(issued.artifact),{flag:'wx',mode:0o600});await rename(temporary,destination);
    worker.stdin.write('{"action":"enrollment_artifact_ready"}\n');
    const enrolledDeadline=Date.now()+40_000;
    while(!stdout.includes('"firstInstallEnrolled":true')&&workerExit===null&&Date.now()<enrolledDeadline) await new Promise(r=>setTimeout(r,100));
    assert.ok(stdout.includes('"firstInstallEnrolled":true'),'genuine C# artifact exchange/persistence was not proved');
    await runPrivate(['packages/gateway/scripts/eu20-assign-first-install-seat.mjs',issued.principalUserId,issued.deviceId]);
    worker.stdin.write('{"action":"entitlement_ready"}\n');
    await writeFile(join(proofRoot,'genuine-state-root.json'),JSON.stringify({state}));
  }
  const deadline=Date.now()+35_000;
  while(fixture.getMethodExecutionCount('get_document_context')<1 && Date.now()<deadline && workerExit===null) await new Promise(r=>setTimeout(r,250));
  assert.equal(workerExit,null,`worker exited ${workerExit}`);
  assert.ok(fixture.getMethodExecutionCount('get_document_context')>=1,'real C# document discovery did not reach fixture');
  // The C# catalog poll precedes the session/document-context delivery.
  await new Promise(r=>setTimeout(r,1500));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('docker',['run','--rm','--network','revagent-eu20-b1-private','--env-file',join(proofRoot,'gateway.env'),'-v',`${proofRoot}:/proof:ro`,'-v',`${join(root,'packages/gateway/scripts')}:/app/packages/gateway/scripts:ro`,'revagent-eu20-b1-gateway:local','node','packages/gateway/scripts/eu20-image-read.mjs'],{windowsHide:true});
    let output='';child.stdout.on('data',c=>{output+=String(c);});child.stderr.on('data',c=>{output+=String(c);});
    const timeout=setTimeout(()=>child.kill(),40_000);
    child.once('exit',code=>{clearTimeout(timeout);if(code===0)resolve(output);else reject(new Error(output));});child.once('error',reject);
  });
  assert.equal(fixture.getMethodExecutionCount('get_ui_state'),1);
  await writeFile(join(proofRoot,`csharp-${mode}-${binding}-read.json`),result);
  process.stdout.write(JSON.stringify({binding,actualCSharpProcess:true,actualImageCmd:true,entitledRead:true,addinFixtureExecutions:1,protectedFirstInstall:genuine?'passed':'not_exercised'})+'\n');
} finally {
  if(genuine&&workerExit===null&&stdout.includes('"ready":true')){
    worker.stdin.write(JSON.stringify({controlVersion:1,id:'eu20-final-observation',action:'read_recovery_observations'})+'\n');
    const observationDeadline=Date.now()+2000;
    while(!stdout.includes('"id":"eu20-final-observation"')&&workerExit===null&&Date.now()<observationDeadline) await new Promise(r=>setTimeout(r,50));
  }
  worker.stdin.write(JSON.stringify({controlVersion:1,id:'stop',action:'shutdown'})+'\n');
  await new Promise(resolve=>{if(workerExit!==null){resolve();return;} const timer=setTimeout(()=>{worker.kill();resolve();},10_000);worker.once('exit',()=>{clearTimeout(timer);resolve();});});
  // Value-free worker observations only; the existing harness never prints credentials.
  await writeFile(join(proofRoot,`csharp-${mode}-${binding}-worker.log`),stdout+'\n'+stderr);
  for(const socket of sockets)socket.destroy();for(const child of relays)child.kill();
  await new Promise(resolve=>relay.close(resolve));await fixture.stop();
}

import{McpServer as Ng}from"@modelcontextprotocol/sdk/server/mcp.js";import{StdioServerTransport as Mg}from"@modelcontextprotocol/sdk/server/stdio.js";import{z as ft}from"zod";import*as qa from"net";function dt(...e){for(let t of e){let n=process.env[t];if(n!=null&&String(n).trim()!=="")return n}}var cr=32*1024*1024,ur=class{host;port;socket;logErrors;isConnected=!1;responseCallbacks=new Map;buffer=Buffer.alloc(0);framingMode=dt("REVAGENT_FRAMING","REVIT_MCP_FRAMING")==="legacy"?"legacy":"length-prefixed";constructor(t,n,r={}){this.host=t,this.port=n,this.logErrors=r.logErrors!==!1,this.socket=new qa.Socket,this.setupSocketListeners()}setupSocketListeners(){this.socket.on("connect",()=>{this.isConnected=!0}),this.socket.on("data",t=>{this.buffer=Buffer.concat([this.buffer,t]),this.processBuffer()}),this.socket.on("close",()=>{this.isConnected=!1}),this.socket.on("error",t=>{this.logErrors&&console.error("RevitClientConnection error:",t),this.isConnected=!1})}processBuffer(){for(;this.buffer.length>0;){if(this.buffer.length>cr){this.rejectPending(new Error(`revAgent response exceeded ${cr} bytes`)),this.buffer=Buffer.alloc(0);return}if(this.isLikelyLegacyJson(this.buffer)){if(!this.processLegacyJsonBuffer())return;continue}if(!this.isLikelyLengthPrefixed(this.buffer)||!this.processLengthPrefixedBuffer())return}}isLikelyLegacyJson(t){let n=0;for(;n<t.length&&[32,9,10,13].includes(t[n]);)n++;return n<t.length&&t[n]===123}isLikelyLengthPrefixed(t){if(t.length<4)return!0;let n=t.readUInt32BE(0);return n>0&&n<=cr}processLegacyJsonBuffer(){try{let t=this.buffer.toString("utf8"),n=this.extractFirstJsonObject(t);if(!n)return!1;let r=JSON.parse(n.json);return this.handleResponseObject(r,n.json),this.buffer=Buffer.from(n.remaining,"utf8"),!0}catch{return!1}}extractFirstJsonObject(t){let n=0,r=!1,o=!1,a=!1,i=0;for(let s=0;s<t.length;s++){let l=t[s];if(!a){if(/\s/.test(l))continue;if(l!=="{")return null;a=!0,i=s,n=1;continue}if(o){o=!1;continue}if(l==="\\"){o=!0;continue}if(l==='"'){r=!r;continue}if(!r){if(l==="{")n++;else if(l==="}"&&(n--,n===0))return{json:t.slice(i,s+1),remaining:t.slice(s+1)}}}return null}processLengthPrefixedBuffer(){if(this.buffer.length<4)return!1;let t=this.buffer.readUInt32BE(0);if(t<=0||t>cr)return this.rejectPending(new Error(`Invalid revAgent response frame length: ${t}`)),this.buffer=Buffer.alloc(0),!1;if(this.buffer.length<4+t)return!1;let r=this.buffer.subarray(4,4+t).toString("utf8");try{let o=JSON.parse(r);this.handleResponseObject(o,r)}catch(o){this.rejectPending(new Error(`Failed to parse revAgent response: ${o instanceof Error?o.message:String(o)}`))}return this.buffer=this.buffer.subarray(4+t),!0}handleResponseObject(t,n){let o=t&&t.id!==void 0&&t.id!==null?String(t.id):"default",a=this.responseCallbacks.get(o);if(a){a(n),this.responseCallbacks.delete(o);return}if(t&&t.error&&this.responseCallbacks.size===1){let i=this.responseCallbacks.entries().next().value;if(i){let[s,l]=i;l(n),this.responseCallbacks.delete(s)}return}if(t&&t.error&&this.responseCallbacks.size>1)for(let[i,s]of this.responseCallbacks.entries())s(n),this.responseCallbacks.delete(i)}rejectPending(t){for(let[n,r]of this.responseCallbacks.entries())r(JSON.stringify({jsonrpc:"2.0",id:n,error:{code:-32e3,message:t instanceof Error?t.message:String(t)}})),this.responseCallbacks.delete(n)}connect(){if(this.isConnected)return!0;try{return this.socket.connect(this.port,this.host),!0}catch(t){return console.error("Failed to connect:",t),!1}}disconnect(){this.socket.end(),this.isConnected=!1}generateRequestId(){return Date.now().toString()+Math.random().toString().substring(2,8)}async sendCommand(t,n={},r={}){return t!=="mcp_status"&&r.statusPreflight!==!1&&await this.ensureReadyForCommand(t,r),await this.sendCommandRequest(t,n,r)}async ensureReadyForCommand(t,n={}){let r=n.statusTimeoutMs||Math.min(n.timeoutMs||3e3,3e3),o=await this.sendCommandRequest("mcp_status",{},{timeoutMs:r,statusPreflight:!1}),a=o&&typeof o=="object"?o.activeTask:null;if(!a)return;let i=a.taskName||a.method||"revAgent task",s=typeof a.elapsedMs=="number"?`, elapsed ${this.formatElapsed(a.elapsedMs)}`:"";throw new Error(`revAgent is busy with "${i}"${s}. Wait for it to finish before sending "${t}".`)}formatElapsed(t){let n=Math.max(0,Math.floor(t/1e3)),r=Math.floor(n/3600),o=Math.floor(n%3600/60),a=n%60;return[r,o,a].map(i=>String(i).padStart(2,"0")).join(":")}async sendCommandRequest(t,n={},r={}){let o=r.framing||this.framingMode;try{return await this.sendCommandRequestOnce(t,n,{...r,framing:o})}catch(a){if(o==="length-prefixed"&&r.allowLegacyFallback!==!1&&this.isFramingFallbackError(a))return this.framingMode="legacy",await this.sendCommandRequestOnce(t,n,{...r,framing:"legacy"});throw a}}isFramingFallbackError(t){let n=t instanceof Error?t.message:String(t);return/Invalid JSON|Invalid JSON-RPC request|Invalid (?:Revit MCP|revAgent) response frame length/i.test(n)}sendCommandRequestOnce(t,n={},r={}){return new Promise((o,a)=>{let i;try{this.isConnected||this.connect();let s=this.generateRequestId(),l={jsonrpc:"2.0",method:t,params:n,id:s};this.responseCallbacks.set(s,m=>{clearTimeout(i);try{let p=JSON.parse(m);p.error?a(new Error(p.error.message||"Unknown error from Revit")):o(p.result)}catch(p){p instanceof Error?a(new Error(`Failed to parse response: ${p.message}`)):a(new Error(`Failed to parse response: ${String(p)}`))}}),this.writeCommand(l,r.framing||this.framingMode);let u=r.timeoutMs||12e4;i=setTimeout(()=>{this.responseCallbacks.has(s)&&(this.responseCallbacks.delete(s),a(new Error(`Command timed out after ${this.formatElapsed(u)}: ${t}`)))},u),typeof i.unref=="function"&&i.unref()}catch(s){clearTimeout(i),a(s)}})}writeCommand(t,n){let r=Buffer.from(JSON.stringify(t),"utf8");if(n==="length-prefixed"){let o=Buffer.alloc(4);o.writeUInt32BE(r.length,0),this.socket.write(Buffer.concat([o,r]));return}this.socket.write(r)}};import*as Ne from"fs";import*as dr from"os";import*as wt from"path";var bc=dt("REVAGENT_HOST","REVIT_MCP_HOST","REVIT_HOST")||"localhost",Ua=xt(dt("REVAGENT_PORT","REVIT_MCP_PORT","REVIT_PORT"),8080),wc=Rc([dt("REVAGENT_INSTANCE_REGISTRY"),wt.join(dr.tmpdir(),"revAgent-instances.json"),dt("REVIT_MCP_INSTANCE_REGISTRY"),wt.join(dr.tmpdir(),"revit-mcp-instances.json")]),Wa=wt.join(dr.tmpdir(),"revit-mcp-command-locks"),Ha=8e3,xc=600*1e3,vc=250;function _c(e){return new Promise(t=>setTimeout(t,e))}function xt(e,t){if(e==null||e===""){if(t!==void 0)return t;throw new Error("Invalid revAgent port: empty value")}let n=Number.parseInt(String(e),10);if(!Number.isFinite(n)||n<1||n>65535)throw new Error(`Invalid revAgent port: ${e}`);return n}function za(e){return e?(Array.isArray(e)?e:String(e).split(",")).map(n=>String(n).trim()).filter(Boolean).map(n=>xt(n)):[]}function Ot(e){return e?String(e).trim():bc}function Cc(e){return String(e).replace(/[^a-zA-Z0-9_.-]/g,"_")}function Rc(e){let t=new Set,n=[];for(let r of e){if(!r||!String(r).trim())continue;let o=wt.resolve(String(r)),a=o.toLowerCase();t.has(a)||(t.add(a),n.push(o))}return n}function Tc(e){return wt.join(Wa,`${Cc(e.host)}-${e.port}.lock`)}function Ga(e){return e&&typeof e=="object"&&"code"in e?String(e.code):null}function Ic(e){let t=new Set,n=[];for(let r of e){let o=Ot(r.host),a=xt(r.port),i=`${o}:${a}`;t.has(i)||(t.add(i),n.push({...r,host:o,port:a}))}return n}function Ja(){let e=[];for(let t of wc)try{if(!Ne.existsSync(t))continue;let n=JSON.parse(Ne.readFileSync(t,"utf8"));if(Array.isArray(n)){e.push(...n);continue}if(n&&Array.isArray(n.instances)){e.push(...n.instances);continue}n&&n.targets&&typeof n.targets=="object"&&e.push(...Object.entries(n.targets).map(([r,o])=>({...typeof o=="object"&&o?o:{},name:r})))}catch{continue}return e}function Ec(e,t){let n=String(t).toLowerCase();return[e.name,e.id,e.target,e.pid,e.title,e.documentTitle,e.path,e.pathName].filter(o=>o!=null).some(o=>String(o).toLowerCase()===n)}function Nc(e){let t=Ja().find(n=>Ec(n,e));return t?{name:t.name||t.id||String(e),host:Ot(t.host),port:xt(t.port),source:"registry",metadata:t}:null}function Mc(e,t){let n=String(e||"").trim();if(!n)return null;if(/^\d+$/.test(n))return{host:Ot(t),port:xt(n),source:"target-port"};let r=n.match(/^(.+):(\d+)$/);return r?{host:Ot(r[1]),port:xt(r[2]),source:"target-host-port"}:null}function Ac(e={}){let t=Ot(e.host),n=e.port!==void 0&&e.port!==null?xt(e.port):null;if(n)return{host:t,port:n,source:"explicit"};let r=e.target||dt("REVAGENT_TARGET","REVIT_MCP_TARGET");if(r){let o=Mc(r,t);if(o)return o;let a=Nc(r);if(a)return a;throw new Error(`Unknown revAgent target '${r}'. Use a port number, host:port, or a registered instance name.`)}return{host:t,port:Ua,source:"default"}}function $a(e={}){let t=Ot(e.host),n=[];if(e.includeRegistry!==!1)for(let i of Ja())i.port&&n.push({name:i.name||i.id||i.title||i.documentTitle,host:Ot(i.host),port:xt(i.port),source:"registry",metadata:i});let r=za(e.ports),o=za(dt("REVAGENT_PORTS","REVIT_MCP_PORTS")),a=o.length>0?o:[Ua,8081,8082,8083,8084,8085];for(let i of r.length>0?r:a)n.push({host:t,port:i,source:r.length>0?"explicit":"scan"});return Ic(n)}function kc(e){try{let t=Ne.statSync(e);Date.now()-t.mtimeMs>xc&&Ne.rmSync(e,{recursive:!0,force:!0})}catch(t){if(!t||Ga(t)==="ENOENT")return}}async function Oc(e,t=Ha){let n=Tc(e),r=Date.now();for(Ne.mkdirSync(Wa,{recursive:!0});;)try{return Ne.mkdirSync(n,{recursive:!1}),Ne.writeFileSync(wt.join(n,"owner.json"),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),target:e},null,2)),()=>{try{Ne.rmSync(n,{recursive:!0,force:!0})}catch{}}}catch(o){if(!o||Ga(o)!=="EEXIST")throw o;if(kc(n),Date.now()-r>=t)throw new Error(`revAgent target ${e.host}:${e.port} is busy; a previous Revit command is still running. Refusing to send another request.`);await _c(vc)}}async function Je(e,t={}){let n=Ac(t),r=t.skipLock===!0?()=>{}:await Oc(n,t.lockWaitMs||Ha),o=new ur(n.host,n.port,{logErrors:t.logSocketErrors!==!1});try{return o.isConnected||await new Promise((a,i)=>{let s,l=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),a()},u=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),i(new Error(`connect to revAgent target ${n.host}:${n.port} failed`))};o.socket.on("connect",l),o.socket.on("error",u),o.connect(),s=setTimeout(()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),i(new Error(`connect to revAgent target ${n.host}:${n.port} timed out`))},t.connectTimeoutMs||5e3),typeof s.unref=="function"&&s.unref()}),await e(o,n)}finally{o.disconnect(),r()}}import No from"node:crypto";import Mo from"node:os";import on from"node:path";var Pc=[{name:"Parameter.Set",pattern:/\.Set\s*\(/i},{name:"Parameter.SetValueString",pattern:/\.SetValueString\s*\(/i},{name:"Parameter.ClearValue",pattern:/\.ClearValue\s*\(/i},{name:"Schedule.SetCellText",pattern:/\.\s*SetCellText\s*\(/i},{name:"Schedule table edit",pattern:/\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(/i},{name:"Document.Delete",pattern:/\.\s*Delete\s*\(/i},{name:"ElementTransformUtils",pattern:/ElementTransformUtils/i},{name:"Location.Move",pattern:/\.Move\s*\(/i},{name:"Element.ChangeTypeId",pattern:/\.ChangeTypeId\s*\(/i},{name:"Connector.ConnectTo",pattern:/\.ConnectTo\s*\(/i},{name:"Connector.DisconnectFrom",pattern:/\.DisconnectFrom\s*\(/i},{name:"FamilySymbol.Activate",pattern:/\.Activate\s*\(/i},{name:"NewFamilyInstance",pattern:/NewFamilyInstance/i},{name:"Create API",pattern:/\.(Create|New[A-Z]\w*)\s*\(/},{name:"View visibility/overrides",pattern:/\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/i},{name:"Geometry join/cut",pattern:/(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/i},{name:"Parameter binding edit",pattern:/\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/i},{name:"Revit property assignment",pattern:/\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.\s*(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/i},{name:"Manual Transaction",pattern:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/i}];function An(e){return Pc.filter(t=>t.pattern.test(e)).map(t=>t.name)}import wo from"node:fs";import Be from"node:path";import{fileURLToPath as Lc}from"node:url";function rn(e){return/^(1|true|yes|on)$/i.test(String(e||"").trim())}function vt(e){try{return!e||!wo.existsSync(e)?null:JSON.parse(wo.readFileSync(e,"utf8").replace(/^\uFEFF/,""))}catch{return null}}function Pt(){let e=Lc(import.meta.url),t=Be.dirname(e),n=[Be.resolve(t,"..",".."),Be.resolve(t,"..")];for(let r of n)if(wo.existsSync(Be.join(r,"package.json")))return r;return n[0]}function mr(){let e=Pt(),t=Be.dirname(e);return t&&t!==e?t:e}function kn(){return process.env.ProgramData||process.env.PROGRAMDATA||"C:\\ProgramData"}function Xa(){let e=mr(),t=[process.env.REVAGENT_UPDATER_CONFIG,Be.join(e,"updater","updater-config.json"),Be.join(kn(),"DPE","revAgent","updater","updater-config.json"),Be.join(kn(),"DPE","RevitMCP","updater","updater-config.json")].filter(Boolean);for(let n of t){let r=vt(n);if(r)return r}return null}function On(e=[]){let t=mr(),n=[Be.join(t,"updater","installed.json"),...e,Be.join(kn(),"DPE","revAgent","updater","installed.json"),Be.join(kn(),"DPE","RevitMCP","updater","installed.json")];for(let r of n){let o=vt(r);if(o)return o}return null}function Pn(e){let t=String(e||"").match(/-([0-9a-f]{7,40})$/i);return t?t[1]:null}function Ka(){return Be.join(kn(),"DPE","revAgent","state","telemetry")}function Lt(e){return(String(e||"").trim()||"unknown-machine").toUpperCase()}function pr(e,t="unknown"){let n=String(e||"").trim();return n&&n.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g,"_").replace(/_+/g,"_").replace(/^[._-]+|[._-]+$/g,"")||t}import gr from"node:fs";import Ya from"node:path";var hr=new Map,fr=new Map,Ln=0,xo=0;async function Qa(e,t){await gr.promises.mkdir(Ya.dirname(e),{recursive:!0}),await gr.promises.writeFile(e,`${JSON.stringify(t,null,2)}
`,"utf8")}async function vo(e,t){await gr.promises.mkdir(Ya.dirname(e),{recursive:!0}),await gr.promises.appendFile(e,`${JSON.stringify(t)}
`,"utf8")}function Za(e,t){let r=(hr.get(e)||Promise.resolve()).catch(()=>{}).then(()=>vo(e,t));return hr.set(e,r),r.finally(()=>{hr.get(e)===r&&hr.delete(e)}).catch(()=>{}),r}function _o(e,t,n){if(n.disabled())return!1;if(Ln>=n.maxInFlight())return xo++,!1;Ln++;let o=(fr.get(e)||Promise.resolve()).catch(()=>{}).then(()=>t(e));return fr.set(e,o),o.catch(()=>{xo++}).finally(()=>{fr.get(e)===o&&fr.delete(e),Ln=Math.max(0,Ln-1)}),!0}function ei(e){return{inFlight:Ln,dropped:xo,maxInFlight:e}}var Vc=new Set(["completed","failed","guarded"]);function Vn(e,t,n){return e?.[n]!==void 0&&e?.[n]!==null?e[n]:t?.[n]??null}function yr(e,t){return e??t??null}function Dn(e){return String(e?.state||"").toLowerCase()}function Ro(e){return Vc.has(String(e||"").toLowerCase())}function ti(e){return e!=null&&e!==""}function ni(e){let t=Date.parse(String(e?.finishedAtUtc||e?.startedAtUtc||""));return Number.isFinite(t)?t:0}function Dc(e,t){let n=Ro(t?.state),r=Ro(e?.state);return n?t||null:r?e||null:t||e||null}function Fc(e,t){return Dn(t)==="failed"?t||null:Dn(e)==="failed"&&e||null}function Co(e,t,n,r){let o=String(e||"").toLowerCase(),a=Dn(n)===o,i=Dn(t)===o;return a&&i?Vn(n,t,r):a?Vn(n,null,r):i?Vn(t,null,r):null}function jc(e,t=""){if(!e||typeof e!="object")return t;if(ti(e.requestId))return`request:${e.requestId}`;if(ti(e.id))return`id:${e.id}`;let n=e.method||"",r=e.taskName||"",o=e.startedAtUtc||"";return n||r||o?`task:${n}|${r}|${o}`:t}function Bc(e,t){let n=Dc(e,t),r={...e||{},...t||{}};for(let o of["id","requestId","method","wrapperAction","logicalToolName","taskName","parentTaskName","parentTaskId","startedAtUtc","requestBytes","responseBytes","port"])r[o]=Vn(t,e,o);return r.state=yr(n?.state,Vn(t,e,"state")),Ro(r.state)?(r.finishedAtUtc=yr(Co(r.state,e,t,"finishedAtUtc"),n?.finishedAtUtc),r.elapsedMs=yr(Co(r.state,e,t,"elapsedMs"),n?.elapsedMs)):(r.finishedAtUtc=null,r.elapsedMs=null),Dn(r)==="failed"?r.error=yr(Co(r.state,e,t,"error"),Fc(e,t)?.error):r.error=null,r}function qc(e,t,n=100){let r=Math.max(1,Math.min(200,Number(n)||100)),o=new Map,a=(i,s)=>{for(let[l,u]of(Array.isArray(i)?i:[]).entries()){if(!u||typeof u!="object")continue;let m=jc(u,`${s}:${l}`),p=o.get(m);o.set(m,p?Bc(p,u):u)}};return a(t,"cached"),a(e,"current"),[...o.values()].sort((i,s)=>ni(s)-ni(i)).slice(0,r)}function ri(e,t){let n=e&&typeof e=="object"?e:null,r=t&&typeof t=="object"?t:null;if(!n&&!r)return null;let o=n?.recentHistoryCapacity??r?.recentHistoryCapacity??100,a=qc(n?.recentTasks,r?.recentTasks,o),i=Math.max(Number(n?.recentHistoryCount)||0,Number(r?.recentHistoryCount)||0,a.length);return{...r||{},...n||{},activeTask:n?.activeTask||null,recentTasks:a,recentHistoryCount:i,recentHistoryCapacity:o}}var zc="revagent.telemetry.v1",Uc="revagent.live.status.v1",li="revagent.live.activity.v1",Tr=No.randomUUID(),ci=new Date().toISOString(),Wc=new Set(["capture_spatial_snapshot","extract_spatial_snapshot","get_spatial_change_state","inspect_levels"]),Hc=new Set(["running","in_progress","completed","guarded","failed"]),Gc=new Set(["capture_spatial_snapshot","extract_spatial_snapshot","get_spatial_change_state","inspect_levels"]),Jc=new Set(["current","stale","unknown","staging"]),$c=new Set(["needs_scope","max_elapsed","read_failed","invalid_request","invalid_cursor","invalid_work_cursor","invalid_cursor_sort_position","cursor_scope_mismatch","cursor_revision_mismatch","cursor_hash_mismatch","capture_interrupted_by_change","capture_has_no_source_bindings","capture_source_binding_fingerprint_changed","capture_source_binding_read_failed","capture_candidate_identity_changed","candidate_inventory_limit_exceeded","prepared_capture_byte_limit_exceeded","invalid_capture_work_phase","expired_capture_session","capture_session_expired","change_tracker_unavailable","phase1a_native_contract_required","invalid_spatial_page_contract","invalid_spatial_work_contract","spatial_rtree_unavailable","spatial_sqlite_native_binding_unavailable","spatial_store_migration_failed","spatial_store_recovery_failed","spatial_store_network_path_rejected","spatial_store_managed_path_rejected","spatial_store_artifact_path_rejected","spatial_store_unavailable","runtime_exception","invalid_response_kind"]),Xc=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),Kc=new Set(["complete","incomplete_omissions","incomplete_budget"]),Yc=new Set(["discover","filter","extract","finalize"]),Qc=0,Fn=new Map,Dt=[],ui=null,Sr=null,oi=null;function Ao(){return rn(process.env.REVAGENT_TELEMETRY_DISABLED)}function Zc(e){return No.createHash("sha256").update(String(e||""),"utf8").digest("hex")}function an(e){return Zc(e).slice(0,16)}function br(e,t=400){let n=String(e||"");return n.length<=t?{text:n,truncated:!1}:{text:`${n.slice(0,t)}...[truncated ${n.length-t} chars]`,truncated:!0}}function eu(e){return String(e||"").split(/\r\n|\r|\n/).length}function Ft(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function tu(){return Ft(process.env.REVAGENT_TELEMETRY_TEXT_CHARS,1e3,0,1e4)}function nu(){return Ft(process.env.REVAGENT_TELEMETRY_CODE_CHARS,4e3,0,1e5)}function jt(){return Ao()||rn(process.env.REVAGENT_LIVE_STATUS_DISABLED)}function ko(){return Ft(process.env.REVAGENT_LIVE_STATUS_RECENT,50,5,200)}function Oo(){return Ft(process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT,32,1,64)}function di(){return Ft(process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS,5e3,0,6e4)}function Po(e){return Wc.has(String(e??"").trim().toLowerCase())}function Ir(e={}){let t=e.params||{};return[e.toolName,e.commandName,e.logicalToolName,t.logicalToolName,t.wrapperAction].some(Po)}function wr(e={},t){let n=i=>Array.isArray(i)?i.length:0,r=i=>{let s=Number.parseInt(String(i??""),10);return Number.isFinite(s)?s:null},o=["hostOnly","linkedOnly","hostAndLinked"].includes(String(e.sourceScope||""))?e.sourceScope:null,a={privacyBoundary:"spatial_extraction",levelSelectorCount:n(e.levelIds)+n(e.levelNames),levelIdCount:n(e.levelIds),levelNameCount:n(e.levelNames),nameQueryPresent:typeof e.nameQuery=="string"&&e.nameQuery.length>0,linkInstanceSelectorCount:n(e.linkInstanceIds)+n(e.linkInstanceUniqueIds),linkedSourceLevelSelectorCount:n(e.linkedSourceLevels)+n(e.linkedSourceLevelNames),sourceRevisionCount:n(e.sourceRevisions)+n(e.expectedSourceRevisions),sourceScope:o,cursorPresent:typeof e.cursor=="string"&&e.cursor.length>0,pageTargetBytes:r(e.pageTargetBytes),maxElements:r(e.maxElements),maxResults:r(e.maxResults),maxElapsedMs:r(e.maxElapsedMs),timeoutMs:r(e.timeoutMs)};return String(t??"").trim().toLowerCase()!=="inspect_levels"&&(a.includeHostMep=e.includeHostMep!==!1,a.includeRoomsSpaces=e.includeRoomsSpaces!==!1,a.includeLinkedObstructions=e.includeLinkedObstructions!==!1),a}function ru(e,t){let n=String(e||""),r={hash:an(n),length:n.length,present:n.length>0};if(t>0){let o=br(n,t);r.text=o.text,r.textTruncated=o.truncated}return r}function ou(e){let t=String(e||""),n={hash:an(t),length:t.length,lineCount:eu(t),writePatternCount:An(t).length,writePatterns:An(t).slice(0,12),hasManualTransaction:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(t)},r=nu();if(r>0){let o=br(t,r);n.preview=o.text,n.previewTruncated=o.truncated}return n}function au(e,t){let n=new Set(["transactionMode","responseMode","planMode","planCandidateMode","targetVisualStyle","intent","imageFormat","cameraOrientation","viewType","category","discipline","cropBasis","searchBudget","linkScope","reason","scanStoppedReason"]);if(typeof t=="boolean"||typeof t=="number")return t;if(typeof t=="string")return n.has(e)?t:ru(t,tu())}function xr(e={}){let t={keys:[]};if(!e||typeof e!="object")return t;let n=Object.keys(e).sort();t.keys=n.filter(r=>r!=="code"&&r!=="parameters");for(let r of n){let o=e[r];if(r==="code"){t.code=ou(o);continue}if(r==="parameters"){t.parameters={count:Array.isArray(o)?o.length:o==null?0:1};continue}if(/elementIds$/i.test(r)&&Array.isArray(o)){t[r]={count:o.length};continue}if(Array.isArray(o)){t[r]={count:o.length};continue}if(o&&typeof o=="object"){t[r]={keys:Object.keys(o).sort()};continue}let a=au(r,o);a!==void 0&&(t[r]=a)}return t}function Lo(e){if(e&&typeof e=="object"){if(mt(e,["success","Success"])===!1)return e;if("result"in e&&e.result!==null&&e.result!==void 0)return e.result;if("result"in e)return e}return e&&typeof e=="object"&&"result"in e?e.result:e}function mt(e,t){if(!e||typeof e!="object")return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let[r,o]of n)if(t.some(a=>r.toLowerCase()===a.toLowerCase()))return o}function mi(e){let t=String(e||"").trim().toLowerCase();return t==="runtime"||t==="client"?t:null}function jn(e,t=null){if(t)return{success:!1,errorMessage:br(t instanceof Error?t.message:String(t)).text,errorType:t instanceof Error?t.name:"Error"};let n=Lo(e),r=n&&typeof n=="object"&&!Array.isArray(n),o=r?mt(n,["success","Success"]):void 0,a=r?mt(n,["state","State"]):void 0,i=r?mt(n,["action","Action"]):void 0,s=r?mt(n,["error","Error","errorMessage","ErrorMessage"]):void 0,l=r?mt(n,["message","Message"]):void 0,u=r?mt(n,["guardSource","GuardSource"]):void 0,m=typeof n=="string"?n:"",p=/^\s*ERROR\s*:/i.test(m)?m:"",g=String(a||"").toLowerCase()==="guarded"||mt(n,["guarded","blocked","focusBlocked"])===!0||/blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(s||l||m||""));return{success:typeof o=="boolean"?o:!s&&!p,guarded:g,guardSource:g?mi(u)||"runtime":null,state:a||null,action:i||null,responseKind:Array.isArray(n)?"array":n===null?"null":typeof n,responseKeys:r?Object.keys(n).sort().slice(0,40):[],errorMessage:s||p?br(s||p).text:null,messageHash:l?an(l):null}}function ai(e,t=null){if(t)return jn(null,t);try{let n=e?.content?.find?.(r=>r?.type==="text")?.text;if(typeof n=="string"&&n.trim().startsWith("{"))return jn(JSON.parse(n))}catch{}return{success:!0,guarded:!1,responseKind:e===null?"null":typeof e,responseKeys:e&&typeof e=="object"?Object.keys(e).sort().slice(0,40):[]}}function iu(){return Ft(process.env.REVAGENT_TELEMETRY_CONTEXT_ELEMENTS,12,0,100)}function pi(e){if(typeof e!="string")return e;let t=e.trim();if(!t.startsWith("{")&&!t.startsWith("[")&&!t.startsWith('"'))return e;try{let n=JSON.parse(t);return typeof n=="string"?pi(n):n}catch{return e}}function hi(e){try{let t=e?.content?.find?.(n=>n?.type==="text")?.text;if(typeof t=="string")return pi(t)}catch{}return e}function Vt(e,t){let n=String(e??"").trim().toLowerCase();return t.has(n)?n:null}function vr(e,t=null){if(t)return{success:!1,guarded:!1,state:"failed",reason:"runtime_exception",privacyBoundary:"spatial_extraction"};let n=e?.content?hi(e):e,r=Lo(n),o=$e(r);if(!o)return{success:!1,guarded:!1,state:"failed",reason:"invalid_response_kind",privacyBoundary:"spatial_extraction"};let a=$e(E(o,["page","Page"])),i=$e(E(o,["preparation","Preparation"])),s=E(o,["nodes","Nodes"]),l=E(o,["omissions","Omissions"]),u=E(o,["sourceRevisions","SourceRevisions"]),m=E(o,["sourceStates","SourceStates"]),p=E(o,["success","Success"]),g=E(o,["guarded","Guarded"])===!0,h=me(E(a,["ordinal","Ordinal","pageOrdinal","PageOrdinal"]))??me(E(o,["pageOrdinal","PageOrdinal"])),w=me(E(a,["recordCount","RecordCount","rowCount","RowCount"]))??me(E(o,["returnedCount","ReturnedCount"]))??(Array.isArray(s)?s.length:null),_=me(E(a,["omissionCount","OmissionCount"]))??(Array.isArray(l)?l.length:null),L=me(E(a,["payloadBytes","PayloadBytes"]))??me(E(o,["payloadBytes","PayloadBytes"])),R=E(o,["nextCursor","NextCursor"])??E(a,["nextCursor","NextCursor"]),T=String(E(o,["continuationKind","ContinuationKind"])??"").trim().toLowerCase()==="work"?"work":null;return{success:typeof p=="boolean"?p:!g,guarded:g,state:Vt(E(o,["state","State"]),Hc)||(g?"guarded":"completed"),action:Vt(E(o,["action","Action"]),Gc),reason:Vt(E(o,["reason","Reason"]),$c),scanStoppedReason:Vt(E(o,["scanStoppedReason","ScanStoppedReason"]),Xc),coverageStatus:Vt(E(o,["coverageStatus","CoverageStatus"]),Kc),partial:E(o,["partial","Partial"])===!0,continuationKind:T,preparationPhase:Vt(E(i,["phase","Phase"]),Yc),preparationStepOrdinal:me(E(i,["stepOrdinal","StepOrdinal"])),preparationProcessed:me(E(i,["processed","Processed"])),preparationTotal:me(E(i,["total","Total"])),pageOrdinal:h,recordCount:w,omissionCount:_,sourceRevisionCount:Array.isArray(u)?u.length:null,sourceStateCount:Array.isArray(m)?m.length:null,liveness:Vt(E(o,["liveness","Liveness"]),Jc),payloadBytes:L,hasMore:E(a,["hasMore","HasMore"])===!0,nextCursorPresent:typeof R=="string"&&R.length>0,workCursorPresent:T==="work"&&typeof R=="string"&&R.length>0,privacyBoundary:"spatial_extraction"}}function $e(e){return e&&typeof e=="object"&&!Array.isArray(e)?e:null}function E(e,t){return mt(e,t)}function K(e,t,n=5){if(n<0||e===null||e===void 0)return;if(Array.isArray(e)){for(let a of e.slice(0,50)){let i=K(a,t,n-1);if(i!=null&&i!=="")return i}return}let r=$e(e);if(!r)return;let o=E(r,t);if(o!=null&&o!=="")return o;for(let a of Object.values(r)){let i=K(a,t,n-1);if(i!=null&&i!=="")return i}}function _r(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let a of e.slice(0,50))_r(a,t,n-1,r);return r}let o=$e(e);if(!o)return r;for(let[a,i]of Object.entries(o))t.some(s=>a.toLowerCase()===s.toLowerCase())&&Array.isArray(i)&&r.push(i),_r(i,t,n-1,r);return r}function Io(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let a of e.slice(0,50))Io(a,t,n-1,r);return r}let o=$e(e);if(!o)return r;for(let[a,i]of Object.entries(o))t.some(s=>a.toLowerCase()===s.toLowerCase())&&$e(i)&&r.push(i),Io(i,t,n-1,r);return r}function ne(e){return e==null?null:typeof e=="string"?e:typeof e=="number"||typeof e=="boolean"?String(e):null}function me(e){return typeof e=="number"&&Number.isFinite(e)?e:typeof e=="string"&&/^-?\d+$/.test(e.trim())?Number.parseInt(e.trim(),10):null}function fi(e,t=25){return[...new Set((Array.isArray(e)?e:[]).map(n=>me(n)).filter(n=>Number.isFinite(n)))].slice(0,t)}function su(e={}){let t=[];e.elementId!==void 0&&t.push(e.elementId),e.viewId!==void 0&&t.push(e.viewId);for(let[n,r]of Object.entries(e||{}))/elementIds$/i.test(n)&&Array.isArray(r)&&t.push(...r);return fi(t,50)}function ii(e){let t=$e(e);if(!t)return null;let n=me(E(t,["id","Id","elementId","ElementId"])),r=ne(E(t,["name","Name"])),o=ne(E(t,["category","Category","categoryName","CategoryName"])),a=ne(E(t,["typeName","TypeName","familyName","FamilyName"])),i=ne(E(t,["levelName","LevelName","level","Level"])),s=ne(E(t,["roomName","RoomName","room","Room"])),l=ne(E(t,["roomNumber","RoomNumber"])),u=ne(E(t,["spaceName","SpaceName","space","Space"])),m=ne(E(t,["spaceNumber","SpaceNumber"]));return!n&&!r&&!o&&!a&&!i&&!s&&!u?null:{id:n,name:r,category:o,typeName:a,levelName:i,roomName:s,roomNumber:l,spaceName:u,spaceNumber:m}}function lu(e){let t=new Set;return e.filter(n=>{if(!n)return!1;let r=n.id?`id:${n.id}`:JSON.stringify(n);return t.has(r)?!1:(t.add(r),!0)})}function cu(e,t){let n=_r(e,["elements","Elements","selectionElements","SelectionElements"]),r=Io(e,["chosenElement","ChosenElement","targetElement","TargetElement"]),o=[];for(let a of r)o.push(ii(a));for(let a of n)for(let i of a.slice(0,t))o.push(ii(i));return lu(o).slice(0,t)}function uu(e){let t=K(e,["selectionIds","SelectionIds"],4);return Array.isArray(t)?fi(t,50):[]}function du(e){let t=_r(e,["files","Files"],4),n=[];for(let r of t)for(let o of r.slice(0,12)){let a=$e(o);a&&n.push({path:ne(E(a,["path","Path"])),fileName:ne(E(a,["fileName","FileName"])),bytes:me(E(a,["bytes","Bytes"])),width:me(E(a,["width","Width"])),height:me(E(a,["height","Height"])),finalPixelSizeMatchesRequest:E(a,["finalPixelSizeMatchesRequest","FinalPixelSizeMatchesRequest"])})}return n.filter(r=>r.path||r.fileName)}function To(e,t){let n=K(e,t,4);return $e(n)?{id:me(E(n,["id","Id","viewId","ViewId"])),name:ne(E(n,["name","Name","viewName","ViewName"])),type:ne(E(n,["type","Type","viewType","ViewType"]))}:null}function mu(e,t=20){return[...new Set(e.filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim()))].slice(0,t)}function pu(e=[],t="",n="",r=""){let o=`${e.join(" ")} ${t} ${n} ${r}`.toLowerCase();return/\bm\d{2,}[a-z]?\b/i.test(o)?"mechanical_hvac":/\bp\d{2,}[a-z]?\b/i.test(o)?"mechanical_piping":/\be\d{2,}[a-z]?\b/i.test(o)?"electrical":/\bs\d{2,}[a-z]?\b/i.test(o)?"structural":/\ba\d{2,}[a-z]?\b/i.test(o)?"architectural":/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(o)?"mechanical_hvac":/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)/i.test(o)?"mechanical_piping":/(electrical|cable|lighting|elektrik)/i.test(o)?"electrical":/(structural|beam|column|framing|statik|kiris|kolon)/i.test(o)?"structural":/(wall|door|window|room|space|architect|mimari)/i.test(o)?"architectural":/(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)/i.test(o)?"schedule_documentation":null}function hu(e,t){let n=e||t||"";return n?an(n):null}function fu(e={},t=[]){for(let n of t){let r=e?.[n];if(typeof r=="string"&&r.trim())return r.trim()}return null}function gu(e={},t=[]){return t.map(n=>e?.[n]).filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim())}function yu(e={},t="",n=null,r=null,o=null,a={}){return[t,a.toolName,a.commandName,a.logicalToolName,...gu(e,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery","planNameContains","category","discipline"]),...Array.isArray(e.rowTextQueries)?e.rowTextQueries:[],...Array.isArray(e.categoryNames)?e.categoryNames:[],n?.name,r?.name,o?.name].filter(s=>typeof s=="string"&&s.trim()).join(" ")}function Su(...e){let t=e.filter(a=>typeof a=="string"&&a.trim()).join(" ");if(!t)return null;let n=t.match(/\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b/i);if(n)return`Level ${n[1].padStart(2,"0")}`;let r=t.match(/\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b/i);if(r)return`Level ${r[1].padStart(2,"0")}`;let o=t.match(/\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b/i);return o?`Basement ${o[1].padStart(2,"0")}`:null}function bu(e={}){if(Ir(e))return null;let t=e.sourceEventType==="mcp.tool"?hi(e.response):Lo(e.response),n=$e(t),r=e.params||{},o=e.taskName||r.taskName||e.options?.taskName||e.logicalToolName||e.toolName||e.commandName||null,a=e.responseSummary||jn(e.response,e.error),i=iu(),s=i>0?cu(t,i):[],l=mu([...Array.isArray(r.categoryNames)?r.categoryNames.map(String):[],ne(r.category),...s.map(x=>x.category)]),u=K(t,["document","Document"],3),m=ne(K(t,["documentTitle","DocumentTitle"],5))||ne(E(u,["title","Title","name","Name"])),p=ne(K(t,["documentPath","DocumentPath"],5))||ne(E(u,["path","Path","modelPath","ModelPath"])),g=To(t,["activeView","ActiveView","view","View"]),h=To(t,["beforeView","BeforeView","activeViewBefore","ActiveViewBefore"]),w=To(t,["afterView","AfterView"]),_=su(r),L=uu(t),R=du(t),A=ne(K(t,["levelName","LevelName","activePlanLevelName","ActivePlanLevelName"],5)),T=me(K(t,["levelId","LevelId","activePlanLevelId","ActivePlanLevelId"],5)),j=ne(K(t,["roomName","RoomName"],5)),z=ne(K(t,["roomNumber","RoomNumber"],5)),J=ne(K(t,["spaceName","SpaceName"],5)),y=ne(K(t,["spaceNumber","SpaceNumber"],5)),B=fu(r,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery"]),W=typeof r.outputDir=="string"?r.outputDir:ne(K(t,["outputDir","OutputDir"],4)),se=typeof r.filePrefix=="string"?r.filePrefix:ne(K(t,["filePrefix","FilePrefix"],4)),de=yu(r,o||"",g,h,w,e),Re=A||Su(de),Ee=K(t,["inferredScope","InferredScope"],5),He=K(t,["effectiveScope","EffectiveScope"],5),he=K(t,["riskPolicy","RiskPolicy","searchRiskPolicy","SearchRiskPolicy"],5),Ae=K(t,["scanPolicy","ScanPolicy"],5),bt=K(t,["partial","Partial"],4),rt=ne(K(t,["scanStoppedReason","ScanStoppedReason"],4)),Ge=me(K(t,["scannedElementCount","ScannedElementCount"],4));return!(o||m||p||g||h||w||_.length||L.length||s.length||R.length||Re||j||J||B||W)?null:{eventType:"production.context",contextSchemaVersion:"revagent.production.context.v1",related:{sourceEventType:e.sourceEventType,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null},runId:e.taskId||r.taskId||e.options?.taskId||an(`${Tr}|${e.sourceEventType||""}|${e.toolName||""}|${e.commandName||""}|${e.startedAtMs||""}|${o||""}`),operation:{taskName:o,query:B,action:a.action||ne(K(t,["action","Action"],3)),durationMs:e.durationMs,success:a.success,guarded:a.guarded,state:a.state,errorMessage:a.errorMessage},project:{projectId:hu(p,m),documentTitle:m,documentPath:p,isFamilyDocument:K(t,["isFamilyDocument","IsFamilyDocument"],4),isReadOnly:K(t,["isReadOnly","IsReadOnly"],4),isModifiable:K(t,["isModifiable","IsModifiable"],4)},view:{active:g,before:h,after:w,activeViewChanged:K(t,["activeViewChanged","ActiveViewChanged"],4)},location:{levelId:T,levelName:Re,roomName:j,roomNumber:z,spaceName:J,spaceNumber:y},elements:{targetElementIds:_,selectionIds:L,selectionCount:me(K(t,["selectionCount","SelectionCount"],4)),categories:l,disciplineHint:pu(l,o||"",de,e.toolName||e.logicalToolName||e.commandName||""),samples:s,samplesTruncated:i>0&&s.length>=i},outputs:{outputDir:W,filePrefix:se,files:R},search:{query:B,inferredScope:Ee,effectiveScope:He,riskPolicy:he,riskLevel:E(he,["riskLevel","RiskLevel"])||null,recommendedFirstScope:E(he,["recommendedFirstScope","RecommendedFirstScope"])||null,requiresUserControl:E(he,["requiresUserControl","RequiresUserControl"])===!0,scanPolicy:Ae,searchBudget:r.searchBudget||E(Ae,["searchBudget","SearchBudget"])||null,linkScope:r.linkScope||E(He,["linkScope","LinkScope"])||null,planCandidateMode:r.planCandidateMode||E(Ae,["planCandidateMode","PlanCandidateMode"])||null,allowExpensiveSearch:r.allowExpensiveSearch===!0||E(Ae,["allowExpensiveSearch","AllowExpensiveSearch"])===!0,scannedElementCount:Ge,partial:bt===!0,scanStoppedReason:rt,needsScope:a.guarded&&a.state==="guarded"&&(E(n,["reason","Reason"])==="needs_scope"||rt==="needs_scope")},response:{responseKeys:a.responseKeys||(n?Object.keys(n).sort().slice(0,40):[])}}}function Eo(e={}){let t=bu(e);t&&Bn(t)}function gi(){let e=Xa();return{disabled:Ao(),localOnly:rn(process.env.REVAGENT_TELEMETRY_LOCAL_ONLY),localRoot:process.env.REVAGENT_TELEMETRY_ROOT||Ka(),reportsRoot:process.env.REVAGENT_REPORTS_ROOT||e?.reportsRoot||""}}function yi(e){let t=e.getUTCFullYear().toString(),n=String(e.getUTCMonth()+1).padStart(2,"0"),r=String(e.getUTCDate()).padStart(2,"0");return{year:t,month:n,day:r,ymd:`${t}-${n}-${r}`}}function wu(e){let t=gi();if(t.disabled)return[];let n=new Date(e.timestampUtc||Date.now()),r=yi(n),o=pr(Lt(e.machineName),"unknown-machine"),i=[{kind:"local",path:on.join(t.localRoot,"events",`${r.ymd}.ndjson`)}];return!t.localOnly&&t.reportsRoot&&i.push({kind:"remote",path:on.join(t.reportsRoot,"events",r.year,r.month,r.day,o,`${e.sessionId}.ndjson`)}),i}function xu(){let e=gi();return{disabled:jt(),localOnly:e.localOnly||rn(process.env.REVAGENT_LIVE_STATUS_LOCAL_ONLY),localRoot:process.env.REVAGENT_LIVE_STATUS_LOCAL_ROOT||on.join(e.localRoot,"live"),reportsRoot:process.env.REVAGENT_LIVE_STATUS_ROOT||(e.reportsRoot?on.join(e.reportsRoot,"live"):"")}}function Si(e=[]){let t=xu();if(t.disabled)return[];let r=["machines",pr(Lt(process.env.COMPUTERNAME||Mo.hostname()),"unknown-machine"),...e],o=[{kind:"local",path:on.join(t.localRoot,...r)}];return!t.localOnly&&t.reportsRoot&&o.push({kind:"remote",path:on.join(t.reportsRoot,...r)}),o}function bi(e){return!e||typeof e!="object"||Array.isArray(e)?null:{success:typeof e.success=="boolean"?e.success:null,guarded:e.guarded===!0,guardSource:e.guardSource||null,state:e.state||null,action:e.action||null,errorMessage:e.errorMessage||null,messageHash:e.messageHash||null}}function Cr(e,t="summary"){if(!e)return null;let n={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,taskIdPresent:!!e.taskId,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,state:e.state,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:t==="full"?e.result||null:bi(e.result)};return t!=="full"&&!n.result&&delete n.result,n}function si(e){if(!e||typeof e!="object")return null;let t=e.commandName||e.method||null,n=e.wrapperAction||e.logicalToolName||e.toolName||t,r=[t,n,e.wrapperAction,e.logicalToolName].some(Po);return{id:e.id||null,requestId:e.requestId||null,method:n||null,toolName:n||null,commandName:t,wrapperAction:e.wrapperAction||null,logicalToolName:e.logicalToolName||null,taskName:r?null:e.taskName||null,parentTaskName:r?null:e.parentTaskName||null,parentTaskIdPresent:r?!1:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,elapsedMs:e.elapsedMs??null,requestBytes:e.requestBytes??null,responseBytes:e.responseBytes??null,port:e.port||null,error:r?null:e.error||null}}function vu(e,t){if(t==="full")return e;let n=bi(e.result),r={timestampUtc:e.timestampUtc||e.finishedAtUtc||e.startedAtUtc||null,phase:e.phase,state:e.state||e.phase||null,scope:e.scope||null,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),guardSource:e.guardSource||n?.guardSource||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null};return n&&(r.success=n.success,r.guarded=n.guarded,r.action=n.action,r.errorMessage=n.errorMessage,r.messageHash=n.messageHash),Object.fromEntries(Object.entries(r).filter(([,o])=>o!=null))}function wi(e=10,t="summary"){let n=Ft(e,10,0,100),r=t==="full"?"full":"summary",a=(r==="full"?Dt:Dt.filter(i=>i.phase!=="started")).slice(0,n).map(i=>vu(i,r));return{mode:r,activeTask:Cr(xi(),r),activeTasks:[...Fn.values()].map(i=>Cr(i,r)),recentActivity:a,recentActivityCount:a.length,recentActivityStoredCount:Dt.length,recentActivityCapacity:ko()}}function _u(e){if(!e||typeof e!="object")return null;let t=e.result&&typeof e.result=="object"?e.result:e;return{capturedAtUtc:new Date().toISOString(),activeTask:si(t.activeTask),recentTasks:(Array.isArray(t.recentTasks)?t.recentTasks:[]).map(si).filter(Boolean).slice(0,100),recentHistoryCount:t.recentHistoryCount??null,recentHistoryCapacity:t.recentHistoryCapacity??null}}function Er(e){if(jt())return;let t=_u(e);t&&(ui=t,Rr("revit.status"))}function xi(){let e=[...Fn.values()];return e.length===0?null:e.sort((t,n)=>{let r=a=>a.scope==="revit.command"?2:1,o=r(n)-r(t);return o!==0?o:String(n.startedAtUtc||"").localeCompare(String(t.startedAtUtc||""))})[0]}function Cu(e="activity"){let n=On()?.version||null,r=new Date().toISOString();return oi=r,{schemaVersion:Uc,generatedAtUtc:r,lastHeartbeatUtc:oi,reason:e,machineName:Lt(process.env.COMPUTERNAME||Mo.hostname()),userName:process.env.USERNAME||process.env.USER||"",sessionId:Tr,runtime:{version:n,buildHash:Pn(n)},process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:ci},activeTask:Cr(xi(),"full"),activeTasks:[...Fn.values()].map(o=>Cr(o,"full")),recentActivity:Dt.slice(0,ko()),revitStatus:ui,writeHealth:ei(Oo())}}function Ru(e){let t=Array.isArray(e?.revitStatus?.recentTasks)?e.revitStatus.recentTasks:[],n=Array.isArray(e?.activeTasks)?e.activeTasks:[],r=Array.isArray(e?.recentActivity)?e.recentActivity:[];return!!(e?.activeTask||n.length>0||r.length>0||e?.revitStatus?.activeTask||t.length>0)}function Tu(e){let t=Date.parse(String(e?.generatedAtUtc||e?.lastHeartbeatUtc||""));return Number.isFinite(t)?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY}function Iu(e,t){let n=vt(e);if(!n||Lt(n.machineName)!==Lt(t.machineName))return t;let r=Math.max(600*1e3,di()*6);return!Ru(n)||Tu(n)>r?t:{...t,recentActivity:Array.isArray(t.recentActivity)&&t.recentActivity.length>0?t.recentActivity:Array.isArray(n.recentActivity)?n.recentActivity:[],revitStatus:ri(t.revitStatus,n.revitStatus)}}function Rr(e="activity"){let t=Cu(e);for(let n of Si(["status.json"]))_o(n.path,r=>Qa(r,Iu(r,t)),{disabled:jt,maxInFlight:Oo})}function Eu(e){let t={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName,commandName:e.commandName,logicalToolName:e.logicalToolName,executionKind:e.executionKind,taskName:e.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,guardSource:e.guardSource,state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,durationMs:e.durationMs,result:e.result};e.phase==="started"?Fn.set(e.liveTaskId,t):Fn.delete(e.liveTaskId),Dt.unshift({timestampUtc:e.timestampUtc,phase:e.phase,state:e.state,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:e.result||null});let n=ko();Dt.length>n&&Dt.splice(n)}function vi(e){Eu(e);let t=yi(new Date(e.timestampUtc||Date.now()));for(let n of Si(["activity",`${t.ymd}.ndjson`]))_o(n.path,r=>vo(r,e),{disabled:jt,maxInFlight:Oo});Rr(e.phase)}function Nu(e={},t){return e.taskId?String(e.taskId):an([Tr,e.scope||"",e.toolName||"",e.commandName||"",e.logicalToolName||"",t||Date.now(),e.taskName||""].join("|"))}function sn(e={}){if(jt())return null;let t=Ir(e),n=t?{...e,taskName:null,taskId:null,parentTaskName:null,parentTaskId:null}:e,r=n.startedAtMs||Date.now(),o=new Date(r).toISOString(),a=Nu(n,r),i=Vo({schemaVersion:li,eventType:"live.activity",phase:"started",state:"running",liveTaskId:a,scope:n.scope||"runtime",toolName:n.toolName||null,commandName:n.commandName||null,logicalToolName:n.logicalToolName||null,executionKind:n.executionKind||null,taskName:n.taskName||null,taskId:n.taskId||null,taskIdPresent:!!n.taskId,parentTaskName:n.parentTaskName||null,parentTaskId:n.parentTaskId||null,parentTaskIdPresent:!!n.parentTaskId,startedAtUtc:o,params:t?wr(n.params,n.toolName||n.logicalToolName||n.commandName):xr(n.params)});return vi(i),{liveTaskId:a,scope:i.scope,toolName:i.toolName,commandName:i.commandName,logicalToolName:i.logicalToolName,executionKind:i.executionKind,taskName:i.taskName,taskId:i.taskId,parentTaskName:i.parentTaskName,parentTaskId:i.parentTaskId,guardSource:i.guardSource,startedAtMs:r,startedAtUtc:o}}function Xe(e,t={}){if(!e||jt())return;let n=Date.now(),r=t.durationMs??Math.max(0,n-(e.startedAtMs||n)),a=Ir({...t,...e})?vr(t.response,t.error):t.responseSummary||jn(t.response,t.error),i=a.guarded?"guarded":a.success===!1?"failed":"completed",s=a.guarded?mi(t.guardSource||e.guardSource||a.guardSource)||"runtime":null,l=Vo({schemaVersion:li,eventType:"live.activity",phase:i,state:i,liveTaskId:e.liveTaskId,scope:e.scope||t.scope||"runtime",toolName:e.toolName||t.toolName||null,commandName:e.commandName||t.commandName||null,logicalToolName:e.logicalToolName||t.logicalToolName||null,executionKind:e.executionKind||t.executionKind||null,taskName:e.taskName||t.taskName||null,taskId:e.taskId||t.taskId||null,taskIdPresent:!!(e.taskId||t.taskId),parentTaskName:e.parentTaskName||t.parentTaskName||null,parentTaskId:e.parentTaskId||t.parentTaskId||null,parentTaskIdPresent:!!(e.parentTaskId||t.parentTaskId),guardSource:s,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:new Date(n).toISOString(),durationMs:r,result:a});vi(l)}function Mu(){if(Sr||jt())return;let e=di();e<=0||(Rr("session.start"),Sr=setInterval(()=>{Rr("heartbeat")},e),typeof Sr.unref=="function"&&Sr.unref())}function Vo(e={}){let n=On()?.version||null;return{schemaVersion:zc,eventId:No.randomUUID(),eventType:e.eventType||"runtime.event",timestampUtc:e.timestampUtc||new Date().toISOString(),sessionId:Tr,sequence:++Qc,source:"runtime-mcp-server",process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:ci},machineName:Lt(process.env.COMPUTERNAME||Mo.hostname()),userName:process.env.USERNAME||process.env.USER||"",runtime:{version:n,buildHash:Pn(n)},...e}}async function Bn(e={}){if(Ao())return;let t=Vo(e),n=wu(t);await Promise.allSettled(n.map(r=>Za(r.path,t)))}function _i(){Mu(),Bn({eventType:"runtime.session.start"})}function pt(e={}){let t=Math.max(0,Date.now()-(e.startedAtMs||Date.now())),n=Ir(e),r=n?vr(e.response,e.error):jn(e.response,e.error);Bn({eventType:"revit.command",commandName:e.commandName,logicalToolName:e.logicalToolName||e.commandName,executionKind:e.executionKind||"bridgeCommand",taskName:n?null:e.params?.taskName||e.options?.taskName||null,taskIdPresent:n?!1:!!(e.params?.taskId||e.options?.taskId),parentTaskName:n?null:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskIdPresent:n?!1:!!(e.params?.parentTaskId||e.options?.parentTaskId),transactionMode:n?null:e.params?.transactionMode||e.options?.transactionMode||null,connection:n?void 0:{targetPresent:!!e.options?.target,hostPresent:!!e.options?.host,port:e.options?.port||null},durationMs:t,params:n?wr(e.params,e.logicalToolName||e.commandName):xr(e.params),result:r}),Eo({...e,sourceEventType:"revit.command",durationMs:t,responseSummary:r,taskName:e.params?.taskName||e.options?.taskName||null,taskId:e.params?.taskId||e.options?.taskId||null,parentTaskName:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskId:e.params?.parentTaskId||e.options?.parentTaskId||null})}function Au(e){return!(e==="get_revit_mcp_status"&&!rn(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS))}function Ci(e){return{...e,tool(t,n,r,o){let a=n,i=r,s=o;typeof n=="object"&&(s=r,i=n,a="");let l=async(u,m)=>{let p=Date.now(),g=Au(t),h=Po(t),w=g?sn({scope:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,startedAtMs:p}):null;try{let _=await s(u,m);if(g){let L=Math.max(0,Date.now()-p),R=h?vr(_):ai(_);Bn({eventType:"mcp.tool",toolName:t,taskName:h?null:u?.taskName||null,taskIdPresent:h?!1:!!u?.taskId,parentTaskName:h?null:u?.parentTaskName||null,parentTaskIdPresent:h?!1:!!u?.parentTaskId,durationMs:L,params:h?wr(u,t):xr(u),result:R}),Eo({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,response:_,durationMs:L,startedAtMs:p,responseSummary:R}),Xe(w,{response:_,responseSummary:R,durationMs:L})}return _}catch(_){if(g){let L=Math.max(0,Date.now()-p),R=h?vr(null,_):ai(null,_);Bn({eventType:"mcp.tool",toolName:t,taskName:h?null:u?.taskName||null,taskIdPresent:h?!1:!!u?.taskId,parentTaskName:h?null:u?.parentTaskName||null,parentTaskIdPresent:h?!1:!!u?.parentTaskId,durationMs:L,params:h?wr(u,t):xr(u),result:R}),Eo({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,error:_,durationMs:L,startedAtMs:p,responseSummary:R}),Xe(w,{error:_,responseSummary:R,durationMs:L})}throw _}};return e.tool(t,a,i,l)}}}var ku=2;function I(e){return{target:e.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVAGENT_TARGET, then legacy REVIT_MCP_TARGET, then REVAGENT_PORT/8080."),host:e.string().optional().describe("Optional Revit socket host. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),port:e.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVAGENT_PORT, then legacy REVIT_MCP_PORT, then 8080.")}}function N(e){return{taskName:e.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),taskId:e.string().optional().describe("Optional client task identifier forwarded to Revit status history."),parentTaskName:e.string().optional().describe("Optional parent workflow display name. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task."),parentTaskId:e.string().optional().describe("Optional parent workflow identifier. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task id.")}}function d(e,t,n){if(!e||typeof e!="object")return;let r=n??t.charAt(0).toLowerCase()+t.slice(1);return e[t]??e[r]}function Se(e={}){return{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs}}function ke(e={},t){return{taskName:e.taskName||t,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId}}function V(e={},t){return{...Se(e),...ke(e,t)}}function Ti(e,t){let n=t.parentTaskName||(t.taskName&&e.taskName&&e.taskName!==t.taskName?t.taskName:void 0),r=t.parentTaskId||(t.taskId&&e.taskName&&e.taskName!==t.taskName?t.taskId:void 0);n&&!e.parentTaskName&&(e.parentTaskName=n),r&&!e.parentTaskId&&(e.parentTaskId=r)}function Ii(e,t,n){let r=n.toolName||t;r&&!e.logicalToolName&&(e.logicalToolName=r),n.toolName&&n.toolName!==t&&!e.wrapperAction&&(e.wrapperAction=n.toolName)}function Nr(e){let t=[["Success","success"],["SUCCESS","success"],["Guarded","guarded"],["State","state"],["Action","action"],["Message","message"],["Error","error"],["ResultContractVersion","resultContractVersion"]],n=r=>{if(Array.isArray(r))return r.map(a=>n(a));if(!r||typeof r!="object")return r;let o={};for(let[a,i]of Object.entries(r))o[a]=n(i);for(let[a,i]of t)Object.prototype.hasOwnProperty.call(o,a)&&(Object.prototype.hasOwnProperty.call(o,i)||(o[i]=o[a]),delete o[a]);return o};return n(e)}function f(e){let t=Nr(e);return{content:[{type:"text",text:JSON.stringify(t,null,2)}]}}function qn(e,t=0){if(typeof e!="string")return e;let n=e.trim();if(!n.startsWith("{")&&!n.startsWith("[")&&!n.startsWith('"'))return e;try{let r=JSON.parse(n);return t<2&&typeof r=="string"?qn(r,t+1):r}catch{return e}}function Mr(e){if(Array.isArray(e))return e.map(n=>Mr(n));if(!e||typeof e!="object")return e;let t={};for(let[n,r]of Object.entries(e)){let o=n==="result"||n==="Result"?qn(r):r;t[n]=Mr(o)}return t}function Ou(e){if(!e||typeof e!="object"||Array.isArray(e))return null;let t=e.resultContractVersion??e.ResultContractVersion,n=Number.parseInt(String(t??""),10);return Number.isFinite(n)?n:null}function Pu(e){let t=Ou(e);return t!==null&&t>=ku}function ht(e,t={}){let n=qn(e);if(Pu(n))return t.parseResultStrings===!0?Nr(Mr(n)):n;if(n&&typeof n=="object"&&!Array.isArray(n)){let r=n;return t.parseResultStrings===!0?r=Mr(r):("result"in r||"Result"in r)&&(r={...r},"result"in r?r.result=qn(r.result):r.Result=qn(r.Result)),Nr(r)}return Nr(n)}function Ei(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function qt(e,t={}){let n=t.verboseCandidates===!0,r=Ei(t.maxPlanCandidates,3,0,100);if(n)return e;let o=a=>{if(Array.isArray(a))return a.map(s=>o(s));if(!a||typeof a!="object")return a;let i={};for(let[s,l]of Object.entries(a)){if((s==="PlanCandidates"||s==="planCandidates")&&Array.isArray(l)){let u=s==="PlanCandidates"?"PlanCandidatesTotal":"planCandidatesTotal",m=s==="PlanCandidates"?"PlanCandidatesTruncated":"planCandidatesTruncated";i[u]=l.length,i[m]=l.length>r,i[s]=l.slice(0,r).map(p=>o(p));continue}i[s]=o(l)}return i};return o(e)}function Ri(e,t){if(!e||typeof e!="object")return e;let n=e.commandName||e.method,r=e.wrapperAction||e.logicalToolName||e.toolName||n,o={id:e.id,requestId:e.requestId,method:r,toolName:r,commandName:n,wrapperAction:e.wrapperAction,logicalToolName:e.logicalToolName,taskName:e.taskName,parentTaskName:e.parentTaskName,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,elapsedMs:e.elapsedMs,port:e.port,error:e.error};return t&&(o.framing=e.framing,o.requestBytes=e.requestBytes,o.receiveMs=e.receiveMs,o.parseMs=e.parseMs,o.executeMs=e.executeMs,o.responseBytes=e.responseBytes),o}function zn(e,t={}){let n=t.includeRecentTasks!==!1,r=t.includeDiagnostics===!0,o=Ei(t.recentLimit,3,0,100),a=e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e;if(!a||typeof a!="object")return e;let i={...a};return i.activeTask=Ri(a.activeTask,r),Array.isArray(a.recentTasks)&&(i.recentHistoryCount=a.recentHistoryCount??a.recentTasks.length,i.recentHistoryCapacity=a.recentHistoryCapacity??100,delete i.recentTasksTotal,n?(i.recentTasks=a.recentTasks.slice(0,o).map(s=>Ri(s,r)),i.recentTasksTruncated=a.recentTasks.length>o):(delete i.recentTasks,i.recentTasksIncluded=!1)),e&&typeof e=="object"&&e.result&&typeof e.result=="object"?{...e,result:i}:i}async function ce(e,t={}){let n={code:e,parameters:t.parameters||[],transactionMode:t.transactionMode||"none",taskName:t.taskName||"Run Revit code"};t.taskId&&(n.taskId=t.taskId),Ii(n,"send_code_to_revit",t),Ti(n,t);let r=Date.now(),o=sn({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",taskName:n.taskName,taskId:n.taskId,parentTaskName:n.parentTaskName,parentTaskId:n.parentTaskId,params:n,startedAtMs:r});try{let a=await Je(async l=>await l.sendCommand("send_code_to_revit",n,t),t),i=t.parseJsonResult===!1?a:ht(a,{parseResultStrings:!0}),s=Math.max(0,Date.now()-r);return pt({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,response:i,startedAtMs:r}),Xe(o,{response:i,durationMs:s}),Bt(t),i}catch(a){let i=Math.max(0,Date.now()-r);throw pt({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,error:a,startedAtMs:r}),Xe(o,{error:a,durationMs:i}),Bt(t),a}}async function Bt(e={}){let t=Math.max(250,Math.min(5e3,Number(e.statusRefreshTimeoutMs||1500)));try{let n=await Je(async r=>await r.sendCommand("mcp_status",{},{timeoutMs:t}),{...e,skipLock:!0,connectTimeoutMs:t,timeoutMs:t,logSocketErrors:!1});return Er(n),n}catch{return null}}async function D(e,t={},n={}){let r={...t};r.taskName||(r.taskName=n.taskName||e),Ti(r,n),n.taskId&&!r.taskId&&(r.taskId=n.taskId),Ii(r,e,n);let o=Date.now(),a=sn({scope:"revit.command",commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:o});try{let i=await Je(async u=>await u.sendCommand(e,r,n),n),s=ht(i),l=Math.max(0,Date.now()-o);return pt({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,response:s,startedAtMs:o}),Xe(a,{response:s,durationMs:l}),Bt(n),s}catch(i){let s=Math.max(0,Date.now()-o);throw pt({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,error:i,startedAtMs:o}),Xe(a,{error:i,durationMs:s}),Bt(n),i}}function F(e){return e==null?"null":`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n")}"`}function Ke(e){return`new string[] { ${(Array.isArray(e)?e:[]).map(F).join(", ")} }`}function Ar(e){return`new int[] { ${(Array.isArray(e)?e:[]).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function Ni(e,t){let n=Number(t||0);return!n||typeof e!="string"||e.length<=n?{text:e,truncated:!1}:{text:`${e.slice(0,n)}
...[truncated ${e.length-n} chars]`,truncated:!0}}function Lu(e){let t=new Set,n=(r,o="")=>{if(r!=null){if(typeof r=="number"&&/(^id$|elementid|elementids)/i.test(o)){t.add(r);return}if(typeof r=="string"&&/^-?\d+$/.test(r)&&/(^id$|elementid|elementids)/i.test(o)){t.add(Number.parseInt(r,10));return}if(Array.isArray(r)){for(let a of r)n(a,o);return}if(typeof r=="object")for(let[a,i]of Object.entries(r))n(i,a)}};return n(e),[...t].filter(r=>Number.isFinite(r)&&r>0)}async function ln(e=100,t={}){let n=await D("get_selected_elements",{limit:e},t);return Lu(n).slice(0,e)}var Vu=new Set(["success","guarded","state","action","error","reason","warnings","notices"]);function Mi(e){let t=String(e||"").trim();return t.length>0?t:void 0}function Ai(e){if(!Array.isArray(e))return;let t=e.map(n=>String(n||"").trim()).filter(n=>n.length>0);return t.length>0?t:void 0}function Du(e){return e?Object.fromEntries(Object.entries(e).filter(([t])=>!Vu.has(t))):{}}function Do(e,t){let n={...Du(t.extra),...e,action:t.action},r=Mi(t.error),o=Mi(t.reason),a=Ai(t.warnings),i=Ai(t.notices);return r&&(n.error=r),o&&(n.reason=o),a&&(n.warnings=a),i&&(n.notices=i),n}function ki(e){return Do({success:!0,guarded:!1,state:"completed",action:e.action},e)}function ot(e){return Do({success:!1,guarded:!0,state:"guarded",action:e.action},e)}function qe(e){return Do({success:!1,guarded:!1,state:"failed",action:e.action},e)}function Fu(e){let t=String(e||"");return t.match(/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\b(?:class|struct|interface|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*/m)?{reason:"dynamic_snippet_type_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). C# type declarations such as class/struct/interface/enum/record cannot be declared inside that method body. Use local functions, built-in collections, or add a native runtime tool when reusable helper types are needed."}:t.match(/^\s*namespace\s+[A-Za-z_][A-Za-z0-9_.]*/m)?{reason:"dynamic_snippet_namespace_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). namespace declarations cannot be declared inside that method body. Use method-body C# only."}:null}function ju(e){let t=ht(e);if(t&&typeof t=="object"&&t.success===!1)return t.error||t.errorMessage||t.message||"Revit code returned success=false.";let n=t&&typeof t=="object"&&"result"in t?t.result:t;return typeof n=="string"&&/^\s*ERROR\s*:/i.test(n)?n.trim():n&&typeof n=="object"&&n.success===!1?n.error||n.message||"Revit code returned success=false.":null}function Oi(e){e.tool("send_code_to_revit","Send C# code to Revit for execution. The code will be inserted into a template with access to the Revit Document and parameters. Your code should be written to work within the Execute method of the template.",{...I(ft),...N(ft),code:ft.string().describe("The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."),parameters:ft.array(ft.any()).optional().describe("Optional execution parameters that will be passed to your code"),transactionMode:ft.enum(["auto","none"]).optional().describe("Transaction handling mode forwarded to the Revit wrapper. In the bundled plugin build, snippets should not open their own Transaction unless that exact build has been verified."),timeoutMs:ft.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),reportErrorResultAsFailure:ft.boolean().optional().describe("When true, ERROR: string results or { success:false } objects are reported as failed tool calls. Defaults true. This cannot roll back a write if the snippet swallowed its own exception."),parseJsonResult:ft.boolean().optional().describe("When true, parse JSON-looking result strings, including double-encoded JSON strings. Defaults true. Set false to inspect the raw wire result.")},async(t,n)=>{let r={code:t.code,parameters:t.parameters||[],transactionMode:t.transactionMode||"auto",taskName:t.taskName||"Run Revit code"};t.taskId&&(r.taskId=t.taskId),t.parentTaskName&&(r.parentTaskName=t.parentTaskName),t.parentTaskId&&(r.parentTaskId=t.parentTaskId),r.logicalToolName="send_code_to_revit";let o=Se(t),a=Date.now(),i=sn({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:a}),s=Fu(t.code);if(s){let l=Math.max(0,Date.now()-a),u=ot({action:"dynamic_snippet_preflight",reason:s.reason,error:s.message});return pt({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:a}),Xe(i,{response:u,durationMs:l}),{content:[{type:"text",text:`Code execution guarded: ${s.message}`}]}}try{let l=await Je(async g=>await g.sendCommand("send_code_to_revit",r,o),o),u=t.parseJsonResult===!1?l:ht(l,{parseResultStrings:!0}),m=Math.max(0,Date.now()-a);pt({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:a}),Xe(i,{response:u,durationMs:m}),Bt(o);let p=t.parseJsonResult===!1||t.reportErrorResultAsFailure===!1?null:ju(u);return p?{content:[{type:"text",text:`Code execution failed: ${p}`}]}:{content:[{type:"text",text:`Code execution successful!
Result: ${JSON.stringify(u,null,2)}`}]}}catch(l){let u=Math.max(0,Date.now()-a);return pt({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,error:l,startedAtMs:a}),Xe(i,{error:l,durationMs:u}),Bt(o),{content:[{type:"text",text:`Code execution failed: ${l instanceof Error?l.message:String(l)}`}]}}})}import{z as Oe}from"zod";function Fo(e,t,n){return f(ot({action:"send_code_to_revit_safe_preflight",error:e,reason:n,extra:{safetyReason:n,writePatterns:t}}))}function Pi(e){e.tool("send_code_to_revit_safe","Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.",{...I(Oe),...N(Oe),code:Oe.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),parameters:Oe.array(Oe.union([Oe.string(),Oe.number(),Oe.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),transactionMode:Oe.enum(["auto","none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),intent:Oe.enum(["read","writePreview","writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),timeoutMs:Oe.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),maxReturnedChars:Oe.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),parseJsonResult:Oe.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true.")},async t=>{let n=t.intent||"read",r=An(t.code);if(n==="writeCommit")return Fo("send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",r,"safe_wrapper_write_commit_not_supported");if(t.transactionMode==="auto")return Fo("send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",r,"safe_wrapper_requires_transactionMode_none");if(r.length>0)return Fo(`Rejected write-looking code for intent '${n}'.`,r,"safe_wrapper_rejected_write_looking_code");try{let a=await ce(t.code,{...Se(t),...ke(t,"Run safe Revit read"),parameters:t.parameters||[],transactionMode:"none",parseJsonResult:t.parseJsonResult!==!1}),i=ki({action:"send_code_to_revit_safe",extra:{intent:n,response:a}}),s=JSON.stringify(i,null,2),l=Ni(s,t.maxReturnedChars);return l.truncated?{content:[{type:"text",text:l.text}]}:f(i)}catch(o){return f(qe({action:"send_code_to_revit_safe",error:o instanceof Error?o.message:String(o)}))}})}import{z as cn}from"zod";function Bu(e){return e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e}function qu(e){let t=String(e.detailLevel||"minimal").toLowerCase(),n=e.includeCategoryCounts===!0||t==="counts"||t==="full"?"true":"false",r=e.includeLinks!==!1?"true":"false",o=e.includeLinks===!0&&t==="full"||t==="full"?"true":"false";return`
bool includeCounts = ${n};
bool includeLinkSummary = ${r};
bool includeLinkDetails = ${o};
string detailLevel = "${t}";
try
{
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.Dictionary<string, int> counts = new System.Collections.Generic.Dictionary<string, int>();
    int linkInstances = 0;
    int loadedLinks = 0;
    int linkedRooms = 0;
    int linkedSpaces = 0;

    if (includeCounts)
    {
        System.Collections.Generic.Dictionary<string, BuiltInCategory> categories =
            new System.Collections.Generic.Dictionary<string, BuiltInCategory>();
        categories["ducts"] = BuiltInCategory.OST_DuctCurves;
        categories["flexDucts"] = BuiltInCategory.OST_FlexDuctCurves;
        categories["ductFittings"] = BuiltInCategory.OST_DuctFitting;
        categories["ductAccessories"] = BuiltInCategory.OST_DuctAccessory;
        categories["airTerminals"] = BuiltInCategory.OST_DuctTerminal;
        categories["mechanicalEquipment"] = BuiltInCategory.OST_MechanicalEquipment;
        categories["pipes"] = BuiltInCategory.OST_PipeCurves;
        categories["flexPipes"] = BuiltInCategory.OST_FlexPipeCurves;
        categories["pipeFittings"] = BuiltInCategory.OST_PipeFitting;
        categories["pipeAccessories"] = BuiltInCategory.OST_PipeAccessory;
        categories["plumbingFixtures"] = BuiltInCategory.OST_PlumbingFixtures;
        categories["sprinklers"] = BuiltInCategory.OST_Sprinklers;
        categories["hostRooms"] = BuiltInCategory.OST_Rooms;
        categories["hostMepSpaces"] = BuiltInCategory.OST_MEPSpaces;

        foreach (System.Collections.Generic.KeyValuePair<string, BuiltInCategory> kv in categories)
        {
            try
            {
                using (FilteredElementCollector collector = new FilteredElementCollector(document))
                {
                    counts[kv.Key] = collector
                        .OfCategory(kv.Value)
                        .WhereElementIsNotElementType()
                        .GetElementCount();
                }
            }
            catch (Exception ex)
            {
                counts[kv.Key] = -1;
                warnings.Add("Count failed for " + kv.Key + ": " + ex.Message);
            }
        }
    }

    if (includeLinkSummary)
    {
        using (FilteredElementCollector linkCollector = new FilteredElementCollector(document))
        {
            foreach (RevitLinkInstance link in linkCollector
                .OfClass(typeof(RevitLinkInstance))
                .WhereElementIsNotElementType()
                .OfType<RevitLinkInstance>())
            {
                linkInstances++;
                Document linkDoc = link.GetLinkDocument();
                if (linkDoc == null) continue;
                loadedLinks++;
                if (includeLinkDetails)
                {
                    try
                    {
                        using (FilteredElementCollector linkedRoomCollector = new FilteredElementCollector(linkDoc))
                        {
                            linkedRooms += linkedRoomCollector
                                .OfCategory(BuiltInCategory.OST_Rooms)
                                .WhereElementIsNotElementType()
                                .GetElementCount();
                        }
                    }
                    catch {}
                    try
                    {
                        using (FilteredElementCollector linkedSpaceCollector = new FilteredElementCollector(linkDoc))
                        {
                            linkedSpaces += linkedSpaceCollector
                                .OfCategory(BuiltInCategory.OST_MEPSpaces)
                                .WhereElementIsNotElementType()
                                .GetElementCount();
                        }
                    }
                    catch {}
                }
            }
        }
    }

    View activeView = document.ActiveView;
    return new {
        success = true,
        revit = new {
            version = document.Application.VersionNumber,
            build = document.Application.VersionBuild,
            culture = System.Globalization.CultureInfo.CurrentCulture.Name,
            decimalSeparator = System.Globalization.CultureInfo.CurrentCulture.NumberFormat.NumberDecimalSeparator
        },
        document = new {
            title = document.Title,
            isWorkshared = document.IsWorkshared,
            isReadOnly = document.IsReadOnly
        },
        apiProbeState = new {
            sampledInsideReadOnlyTool = true,
            documentIsModifiableDuringProbe = document.IsModifiable,
            meaning = "Internal Revit API state sampled while this read-only tool is executing. This is not the idle UI editability state.",
            currentUiStateSource = "Use get_ui_state.document.isModifiable for the current idle UI document state."
        },
        activeView = new {
            id = activeView.Id.IntegerValue,
            name = activeView.Name,
            viewType = activeView.ViewType.ToString(),
            scale = activeView.Scale,
            isTemplate = activeView.IsTemplate
        },
        detailLevel = detailLevel,
        counts = counts,
        links = new {
            instances = linkInstances,
            loaded = loadedLinks,
            linkedRooms = includeLinkDetails ? (int?)linkedRooms : null,
            linkedSpaces = includeLinkDetails ? (int?)linkedSpaces : null,
            detailsIncluded = includeLinkDetails
        },
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`}function Li(e){e.tool("get_revit_session_context","Read-only Revit session summary. Defaults to detailLevel=minimal so large-model document checks do not perform heavy MEP category or linked room/space counts. Use detailLevel=counts/full only when those expensive counts are explicitly needed.",{...I(cn),...N(cn),detailLevel:cn.enum(["minimal","counts","full"]).optional().describe("Context detail level. minimal is default and avoids category counts and linked room/space scans; counts adds host MEP category counts; full also scans linked room/space counts."),includeCategoryCounts:cn.boolean().optional().describe("Compatibility flag. true includes known MEP category counts; default false unless detailLevel is counts/full."),includeLinks:cn.boolean().optional().describe("Include cheap Revit link instance summary. Defaults true; linked room/space counts require detailLevel=full."),includeSelection:cn.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true.")},async t=>{let n=Se(t);try{let r=await ce(qu(t),{...n,...ke(t,"Read Revit session context"),transactionMode:"none"}),o=Bu(r);if(t.includeSelection!==!1&&o&&typeof o=="object"){let a=await ln(100,{...n,taskName:t.taskName?`${t.taskName}: selection`:"Read Revit selection",taskId:t.taskId});o.selection={count:a.length,elementIds:a}}return f(o)}catch(r){return f({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as _t}from"zod";function zu(e){let t=e.includeSheetViewports!==!1?"true":"false",n=e.includeSheetScheduleInstances!==!1?"true":"false",r=e.includeModelElements===!0?"true":"false",o=Number.isFinite(e.limit)?Math.max(1,Math.min(500,e.limit)):100,a=Ke(e.modelCategoryList||[]);return`
bool includeSheetViewports = ${t};
bool includeSheetScheduleInstances = ${n};
bool includeModelElements = ${r};
int limit = ${o};
string[] modelCategoryNames = ${a};

System.Func<XYZ, object> XyzSummary = delegate(XYZ point)
{
    if (point == null) return null;
    return new {
        x = point.X,
        y = point.Y,
        z = point.Z
    };
};

System.Func<BoundingBoxXYZ, object> BoundingBoxSummary = delegate(BoundingBoxXYZ box)
{
    if (box == null) return null;
    return new {
        min = XyzSummary(box.Min),
        max = XyzSummary(box.Max)
    };
};

System.Func<Element, object> ElementSummary = delegate(Element elem)
{
    string categoryName = elem.Category != null ? elem.Category.Name : "";
    string typeName = "";
    Element typeElem = document.GetElement(elem.GetTypeId());
    if (typeElem != null) typeName = typeElem.Name;
    return new {
        id = elem.Id.IntegerValue,
        uniqueId = elem.UniqueId,
        name = elem.Name,
        category = categoryName,
        className = elem.GetType().FullName,
        typeName = typeName
    };
};

try
{
    View view = document.ActiveView;
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<object> viewports = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> scheduleSheetInstances = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<object> modelElements = new System.Collections.Generic.List<object>();

    if (view.ViewType == ViewType.DrawingSheet)
    {
        if (includeSheetViewports)
        {
            FilteredElementCollector vpCollector = new FilteredElementCollector(document, view.Id)
                .OfClass(typeof(Viewport))
                .WhereElementIsNotElementType();
            foreach (Element vpElem in vpCollector.ToElements())
            {
                Viewport vp = vpElem as Viewport;
                if (vp == null) continue;
                View placedView = document.GetElement(vp.ViewId) as View;
                viewports.Add(new {
                    viewportId = vp.Id.IntegerValue,
                    viewId = vp.ViewId.IntegerValue,
                    viewName = placedView != null ? placedView.Name : "",
                    viewType = placedView != null ? placedView.ViewType.ToString() : "",
                    scale = placedView != null ? placedView.Scale : 0
                });
            }
        }
        if (includeSheetScheduleInstances)
        {
            FilteredElementCollector scheduleCollector = new FilteredElementCollector(document, view.Id)
                .OfClass(typeof(ScheduleSheetInstance))
                .WhereElementIsNotElementType();
            foreach (Element scheduleInstanceElem in scheduleCollector.ToElements())
            {
                ScheduleSheetInstance scheduleInstance = scheduleInstanceElem as ScheduleSheetInstance;
                if (scheduleInstance == null) continue;
                ViewSchedule schedule = document.GetElement(scheduleInstance.ScheduleId) as ViewSchedule;
                BoundingBoxXYZ box = null;
                XYZ point = null;
                bool? isTitleblockRevisionSchedule = null;
                try { box = scheduleInstance.get_BoundingBox(view); } catch {}
                try
                {
                    var pointProperty = scheduleInstance.GetType().GetProperty("Point");
                    if (pointProperty != null) point = pointProperty.GetValue(scheduleInstance, null) as XYZ;
                }
                catch {}
                try
                {
                    var revisionProperty = scheduleInstance.GetType().GetProperty("IsTitleblockRevisionSchedule");
                    if (revisionProperty != null)
                    {
                        object revisionValue = revisionProperty.GetValue(scheduleInstance, null);
                        if (revisionValue is bool) isTitleblockRevisionSchedule = (bool)revisionValue;
                    }
                }
                catch {}

                scheduleSheetInstances.Add(new {
                    instanceId = scheduleInstance.Id.IntegerValue,
                    uniqueId = scheduleInstance.UniqueId,
                    scheduleId = scheduleInstance.ScheduleId.IntegerValue,
                    scheduleName = schedule != null ? schedule.Name : "",
                    isTitleblockRevisionSchedule = isTitleblockRevisionSchedule,
                    point = XyzSummary(point),
                    box = BoundingBoxSummary(box)
                });
            }
        }
        if (includeModelElements)
        {
            warnings.Add("Active view is a DrawingSheet; model elements are not collected directly from the sheet. Choose a placed view first.");
        }
    }
    else if (includeModelElements)
    {
        int added = 0;
        if (modelCategoryNames.Length == 0)
        {
            warnings.Add("includeModelElements was true but no modelCategoryList was supplied.");
        }
        foreach (string categoryName in modelCategoryNames)
        {
            if (added >= limit) break;
            try
            {
                BuiltInCategory bic = (BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), categoryName);
                FilteredElementCollector col = new FilteredElementCollector(document, view.Id)
                    .OfCategory(bic)
                    .WhereElementIsNotElementType();
                foreach (Element elem in col.ToElements())
                {
                    if (added >= limit) break;
                    modelElements.Add(ElementSummary(elem));
                    added++;
                }
            }
            catch (Exception ex)
            {
                warnings.Add("Could not collect category " + categoryName + ": " + ex.Message);
            }
        }
    }

    return new {
        success = true,
        activeView = new {
            id = view.Id.IntegerValue,
            name = view.Name,
            viewType = view.ViewType.ToString(),
            scale = view.Scale,
            isTemplate = view.IsTemplate
        },
        sheet = new {
            isSheet = view.ViewType == ViewType.DrawingSheet,
            viewports = viewports.ToArray(),
            scheduleSheetInstances = scheduleSheetInstances.ToArray()
        },
        modelElements = modelElements.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`}function Vi(e){e.tool("get_active_view_context","Read-only active view context. Handles model views and DrawingSheet views; sheets return placed viewport/view data plus scheduleSheetInstances instead of pretending MEP model elements are directly visible.",{...I(_t),...N(_t),includeSheetViewports:_t.boolean().optional().describe("When active view is a sheet, include placed viewports. Defaults true."),includeSheetScheduleInstances:_t.boolean().optional().describe("When active view is a sheet, include placed ScheduleSheetInstance entries with schedule ids, names, point, and box data. Defaults true."),includeModelElements:_t.boolean().optional().describe("When active view is a model view, collect limited model elements from modelCategoryList. Defaults false."),modelCategoryList:_t.array(_t.string()).optional().describe("BuiltInCategory names such as OST_DuctCurves or OST_DuctTerminal."),limit:_t.number().int().positive().max(500).optional().describe("Maximum model elements to return. Defaults 100.")},async t=>{try{let n=await ce(zu(t),{...V(t,"Read active Revit view context"),transactionMode:"none"});return f(n&&n.result?n.result:n)}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Di}from"zod";var Uu=["dryRun","DryRun","deleted","Deleted","confirmDelete","ConfirmDelete","targetIsReviewView","TargetIsReviewView","reviewSignals","ReviewSignals","deletedElementCount","DeletedElementCount"],Wu=["closed","Closed"];function un(e,t={}){if(!e||typeof e!="object"||Array.isArray(e))return e;let n={...e};for(let r of Uu)delete n[r];if(t.stripCloseOnlyFields)for(let r of Wu)delete n[r];return n}function Fi(e){e.tool("list_open_views","List Revit UI view tabs currently open in the active document.",{...I(Di),...N(Di)},async t=>{try{let n=await D("list_open_views",{},{...V(t,"List open Revit views")});return f(un(n&&n.result?n.result:n))}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as zt}from"zod";function ji(e){e.tool("activate_view","Activate an existing Revit view tab by id or unique name without opening a transaction. Supports plans, 3D views, sheets, schedules, legends, drafting views, sections, and elevations.",{...I(zt),...N(zt),viewId:zt.number().int().positive().optional().describe("ElementId of the Revit view to activate."),viewName:zt.string().optional().describe("Name of the Revit view to activate. Must match one view unless viewType is also supplied."),viewType:zt.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:zt.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:zt.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation verification. Defaults 15000.")},async t=>{try{let n=await D("activate_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...V(t,"Activate Revit view")});return f(un(n&&n.result?n.result:n,{stripCloseOnlyFields:!0}))}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Ut}from"zod";function Bi(e){e.tool("close_view","Close an open Revit UI view tab by id or unique name without opening a transaction. If the target is active, another open view is activated first.",{...I(Ut),...N(Ut),viewId:Ut.number().int().positive().optional().describe("ElementId of the Revit view to close."),viewName:Ut.string().optional().describe("Name of the Revit view to close. Must match one view unless viewType is also supplied."),viewType:Ut.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:Ut.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:Ut.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI close verification. Defaults 15000.")},async t=>{try{let n=await D("close_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...V(t,"Close Revit view")});return f(un(n&&n.result?n.result:n))}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as jo}from"zod";function qi(e){e.tool("clear_selection","[LIVE_UI_SELECTION_CLEANUP] Clear the current Revit UI selection. This does not open a transaction and does not modify model elements or view data. Use after focus/testing workflows when the operator wants Revit left with no selected elements.",{...I(jo),...N(jo),timeoutMs:jo.number().int().positive().max(3e4).optional().describe("Timeout for the selection clear command. Defaults 10000.")},async t=>{try{let n=await D("clear_selection",{timeoutMs:t.timeoutMs},{...V(t,"Clear Revit selection")});return f(n&&n.result?n.result:n)}catch(n){return f({success:!1,action:"clear_selection",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as at}from"zod";function Hu(e){return!e||typeof e!="object"?null:{id:d(e,"Id","id")??d(e,"ViewId","viewId")??null,name:d(e,"Name","name")??d(e,"ViewName","viewName")??null,type:d(e,"Type","type")??d(e,"ViewType","viewType")??null}}function Gu(e,t={}){let n=t.responseMode||"compact";if(!e||typeof e!="object"||n==="full")return{...e,responseMode:n};let r=Hu(d(e,"TargetView","targetView")),o={mode:d(e,"Mode","mode")??t.mode??"dryRun",dryRun:d(e,"DryRun","dryRun")??null,changed:d(e,"Changed","changed")??null,deleted:d(e,"Deleted","deleted")??null,deletedElementCount:d(e,"DeletedElementCount","deletedElementCount")??null,confirmed:(d(e,"ConfirmDelete","confirmDelete")??t.confirmDelete)===!0,targetIsReviewView:d(e,"TargetIsReviewView","targetIsReviewView")??null,reviewSignals:d(e,"ReviewSignals","reviewSignals")??[]};return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded"),state:d(e,"State","state"),action:d(e,"Action","action")||"delete_review_view",responseMode:"compact",reason:d(e,"Reason","reason"),error:d(e,"Error","error"),message:d(e,"Message","message"),targetView:r,cleanup:o,suggestedNextScopes:d(e,"SuggestedNextScopes","suggestedNextScopes")??[],notices:[...Array.isArray(d(e,"Notices","notices"))?d(e,"Notices","notices"):[],'Compact response groups cleanup-specific fields under cleanup. Use responseMode="full" for raw delete_review_view diagnostics.']}}function zi(e){e.tool("delete_review_view",'[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode="commit" and confirmDelete=true.',{...I(at),...N(at),viewId:at.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),viewName:at.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),viewType:at.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),exactName:at.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),mode:at.enum(["dryRun","commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),confirmDelete:at.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),responseMode:at.enum(["compact","full"]).optional().describe("Response shape. compact is the default and groups cleanup-specific fields under cleanup; full returns the raw native cleanup contract."),timeoutMs:at.number().int().positive().max(12e4).optional().describe("Timeout for review view cleanup. Defaults 15000.")},async t=>{try{let n=await D("delete_review_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,mode:t.mode,confirmDelete:t.confirmDelete,timeoutMs:t.timeoutMs},{...V(t,"Delete Revit review view")});return f(Gu(n&&n.result?n.result:n,t))}catch(n){return f({success:!1,action:"delete_review_view",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as kr}from"zod";function Ui(e){e.tool("get_ui_state","Read the current Revit UI state: active view, open views, selected element ids/summaries, and document modifiable/read-only status.",{...I(kr),...N(kr),selectionLimit:kr.number().int().min(0).max(1e3).optional().describe("Maximum selected elements to summarize. Defaults 100."),timeoutMs:kr.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=await D("get_ui_state",{selectionLimit:t.selectionLimit},{...V(t,"Read Revit UI state")});return f(n&&n.result?n.result:n)}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as O}from"zod";var Ju="fast",$u={fast:{name:"fast",maxElementsScanned:5e3,maxElapsedMs:4500,socketTimeoutMs:12e3},balanced:{name:"balanced",maxElementsScanned:25e3,maxElapsedMs:18e3,socketTimeoutMs:3e4},deep:{name:"deep",maxElementsScanned:15e4,maxElapsedMs:9e4,socketTimeoutMs:12e4}},Xu=[{concept:"fan_coil",terms:["fan coil","fancoil","fcu"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"air_handling_unit",terms:["ahu","air handling unit","klima santrali"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"pump",terms:["pump","pompa"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"valve",terms:["valve","vana"],categories:["Pipe Accessories","Pipe Fittings"],preserveQueryWhenFullyStripped:!0},{concept:"damper",terms:["damper"],categories:["Duct Accessories","Mechanical Equipment"]},{concept:"air_terminal",terms:["diffuser","grille","air terminal","difuzor","menfez"],categories:["Air Terminals"]},{concept:"duct",terms:["duct","kanal"],categories:["Ducts","Duct Fittings","Duct Accessories"]},{concept:"pipe",terms:["pipe","boru"],categories:["Pipes","Pipe Fittings","Pipe Accessories"]},{concept:"sprinkler",terms:["sprinkler"],categories:["Sprinklers"]},{concept:"plumbing_fixture",terms:["plumbing fixture","sanitary fixture","sihhi tesisat armat\xFCr","armat\xFCr"],categories:["Plumbing Fixtures"]}],Ku=/^[\p{L}\p{N}_\- ]{1,24}$/u;function Wi(e){return String(e||"").normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase().replace(/\s+/g," ").trim()}function Yu(e){return e.normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase()}function Hi(e){let t=[],n=[];for(let r=0;r<e.length;){let o=e.codePointAt(r);if(o===void 0)break;let a=String.fromCodePoint(o),i=r+a.length,s=Yu(a);for(let l of s)t.push(l),n.push([r,i]);r=i}return{text:t.join(""),sourceRanges:n}}function qo(e){let t=new Set,n=[];for(let r of e){let o=String(r||"").trim();if(!o)continue;let a=o.toLowerCase();t.has(a)||(t.add(a),n.push(o))}return n}function Qu(e){let t=String(e||"").toLowerCase();return t==="balanced"||t==="deep"||t==="fast"?t:Ju}function Bo(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Zu(e,t){let n=Hi(e),r=new Array(e.length).fill(!1);for(let a of t.sort((i,s)=>s.length-i.length)){let i=Hi(a).text;if(!i)continue;let s=i.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+"),l=new RegExp(`(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`,"gu"),u;for(;(u=l.exec(n.text))!==null;)for(let m=u.index;m<l.lastIndex;m++){let p=n.sourceRanges[m];if(p)for(let g=p[0];g<p[1];g++)r[g]=!0}}let o="";for(let a=0;a<e.length;a++)o+=r[a]?" ":e[a];return o.replace(/\s+/g," ").trim()}function ed(e){let t=Wi(e),n=[],r=[],o=[],a=!1;for(let s of Xu){let l=s.terms.filter(u=>t.includes(Wi(u)));l.length!==0&&(n.push({concept:s.concept,terms:l,categories:s.categories,preserveQueryWhenFullyStripped:s.preserveQueryWhenFullyStripped===!0}),r.push(...l),o.push(...s.categories),a=a||s.preserveQueryWhenFullyStripped===!0)}let i=Zu(e,r);return{matchedConcepts:n,matchedTerms:r,categories:qo(o),effectiveQuery:i||(a?e.trim():"")}}function td(e={}){let t=["levelNames","activeViewOnly","familyName","typeName","systemName"];return!e.sheetQuery&&!Array.isArray(e.sheetIds)&&t.push("sheetQuery"),!e.nameQuery&&!Array.isArray(e.scheduleIds)&&t.push("scheduleIds/nameQuery"),t.push("allowExpensiveSearch","searchBudget=deep"),t}function Or(e,t){for(let n of e)if(!(!n||typeof n!="object"))for(let r of t){let o=n[r],a=Number.parseInt(String(o??""),10);if(Number.isFinite(a))return a}return null}function nd(e,t){let n=[];return t.length>0&&n.push(`categoryNames=${t.join("|")}`),Array.isArray(e.levelNames)&&e.levelNames.length>0&&n.push("levelNames"),(e.activeViewOnly===!0||e.viewId)&&n.push("activeViewOnly/viewId"),e.familyName&&n.push("familyName"),e.typeName&&n.push("typeName"),e.systemName&&n.push("systemName"),n.length>0?n:["categoryNames","levelNames","activeViewOnly","familyName/typeName","systemName"]}function rd(e={},t=[]){return!!(t.length>0||e.activeViewOnly===!0||e.viewId||Array.isArray(e.levelIds)&&e.levelIds.length>0||Array.isArray(e.levelNames)&&e.levelNames.length>0||e.familyName||e.typeName||e.systemName||Array.isArray(e.worksetIds)&&e.worksetIds.length>0||Array.isArray(e.worksetNames)&&e.worksetNames.length>0||Array.isArray(e.elementIds)&&e.elementIds.length>0||Array.isArray(e.uniqueIds)&&e.uniqueIds.length>0)}function Ct(e){return Array.isArray(e)&&e.some(t=>String(t??"").trim())}function od(e,t,n,r){return t!=="hostOnly"&&Ct(e.uniqueIds)&&!Ct(e.elementIds)&&!n&&r.length===0&&e.activeViewOnly!==!0&&!e.viewId&&!Ct(e.levelIds)&&!Ct(e.levelNames)&&!e.familyName&&!e.typeName&&!e.systemName&&!Ct(e.worksetIds)&&!Ct(e.worksetNames)}function ad(e){let t=String(e||"").trim();return!!(t&&Ku.test(t))}function id(e,t){let n=[],r=0,o=[e.largeModelRisk,e.modelRisk,e.modelSignals,e.sessionSummary].filter(Boolean),a=Or(o,["linkCount","linkInstances","loadedLinks","loadedLinkCount"]),i=Or(o,["worksetCount","worksets"]),s=Or(o,["sheetCount","sheets"]),l=Or(o,["scheduleCount","schedules"]);a!==null&&a>=25?(r+=2,n.push("high_link_count")):a!==null&&a>=10&&(r+=1,n.push("moderate_link_count")),i!==null&&i>=40?(r+=2,n.push("high_workset_count")):i!==null&&i>=20&&(r+=1,n.push("moderate_workset_count")),s!==null&&s>=1e3&&(r+=1,n.push("large_sheet_set")),l!==null&&l>=500&&(r+=1,n.push("large_schedule_set")),!t.boundedScope&&ad(t.originalQuery)&&(r+=3,n.push("generic_unscoped_query")),!t.boundedScope&&!t.originalQuery&&(r+=3,n.push("missing_search_scope")),t.broadLinkedSearch&&(r+=2,n.push("linked_search_without_expensive_approval")),t.verifiedBroadSearch&&(r+=2,n.push("verified_plan_candidates_without_bounded_scope")),t.verifiedVisibilityExpensive&&(r+=2,n.push("verified_visibility_expensive")),(t.searchBudget==="deep"||t.allowExpensiveSearch)&&n.push("operator_approved_expensive_search"),t.boundedScope&&n.length===0&&n.push("bounded_first_pass_scope");let u=r>=4?"high":r>=2?"medium":r>=1||t.boundedScope?"low":"unknown",m=!t.allowExpensiveSearch&&(t.broadLinkedSearch||t.verifiedBroadSearch||t.verifiedVisibilityExpensive||!t.boundedScope&&r>=2);return{riskLevel:u,reasons:n,recommendedFirstScope:nd(e,t.effectiveCategoryNames),requiresUserControl:m}}function Gi(e={}){let t=String(e.query||"").trim(),n=qo(Array.isArray(e.categoryNames)?e.categoryNames:[]),r=ed(t),o=n.length>0,a=o?n:qo(r.categories),i=r.effectiveQuery||(a.length>n.length?"":t),s=Qu(e.searchBudget),l=$u[s],u=e.timeoutMs?Bo(e.timeoutMs,l.socketTimeoutMs,1e3,12e4):l.socketTimeoutMs,m=Math.max(u,Math.min(12e4,l.maxElapsedMs+2500)),p=Bo(e.maxElementsScanned,l.maxElementsScanned,1,5e5),g=Math.min(l.maxElapsedMs,Math.max(1e3,m-2500)),h=Bo(e.maxElapsedMs,g,500,Math.max(500,m-1e3)),w=rd(e,a),_=String(e.linkScope||"hostOnly"),L=e.allowExpensiveSearch===!0||s==="deep",R=od(e,_,t,a),A=_!=="hostOnly"&&!L&&!R,T=String(e.planCandidateMode||(e.includePlanCandidates===!0?"verified":"none")).toLowerCase(),j=e.includePlanCandidates===!0&&T==="verified",z=Ct(e.elementIds)||Ct(e.uniqueIds),J=j&&!w,y=j&&!z,B=id(e,{originalQuery:t,boundedScope:w,effectiveCategoryNames:a,linkScope:_,allowExpensiveSearch:L,broadLinkedSearch:A,verifiedBroadSearch:J,verifiedVisibilityExpensive:y,searchBudget:s}),W=B.requiresUserControl,se=[];return r.matchedConcepts.length>0&&n.length===0&&se.push("search_scope_inferred_from_mep_terms"),r.matchedConcepts.length>0&&o&&r.categories.some(de=>!a.includes(de))&&se.push("explicit_category_scope_preserved_no_inferred_expansion"),A&&se.push("linked_model_search_requires_allowExpensiveSearch"),J&&se.push("verified_plan_candidates_require_bounded_scope"),y&&se.push("verified_visibility_requires_exact_targets_or_approval"),B.requiresUserControl&&se.push("search_requires_user_scope_control"),{originalQuery:t,effectiveQuery:i,inferredScope:{source:"runtime_search_policy",concepts:r.matchedConcepts,strippedTerms:r.matchedTerms,categoryNames:r.categories,residualQuery:i},effectiveCategoryNames:a,riskPolicy:B,linkScope:_,searchBudget:s,maxElementsScanned:p,maxElapsedMs:h,timeoutMs:m,allowExpensiveSearch:L,guarded:W,reason:W?"needs_scope":void 0,message:W?"This search would scan a broad model surface. Narrow by category, level, active view, system, family/type, sheet/schedule, or explicitly allow an expensive search.":void 0,warnings:se,suggestedNextScopes:td(e)}}function Ji(e){return{success:!0,guarded:!0,state:"guarded",action:"find_elements",reason:"needs_scope",message:e.message,originalQuery:e.originalQuery,query:e.effectiveQuery,inferredScope:e.inferredScope,effectiveScope:{categoryNames:e.effectiveCategoryNames,searchBudget:e.searchBudget,linkScope:e.linkScope},riskPolicy:e.riskPolicy,scanPolicy:{searchBudget:e.searchBudget,maxElementsScanned:e.maxElementsScanned,maxElapsedMs:e.maxElapsedMs,timeoutMs:e.timeoutMs,allowExpensiveSearch:e.allowExpensiveSearch},suggestedNextScopes:e.suggestedNextScopes,warnings:e.warnings}}import{z as sd}from"zod";var Rt=sd.enum(["compact","full","debug"]).optional().default("compact").describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");function Tt(e){return e==="full"||e==="debug"}function Ye(e,t,n){let r=Number.parseInt(String(e??""),10);return!Number.isFinite(r)||r<=0?t:Math.max(1,Math.min(n,r))}function Pe(e,t){let n=Array.isArray(e)?e.filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)):[],r=new Set,o=[],a=t.key||Un;for(let s of n){let l=a(s);r.has(l)||(r.add(l),o.push(s))}let i=o.slice(0,Math.max(0,t.limit));return{rows:i,totalCount:n.length,uniqueCount:o.length,returnedCount:i.length,duplicateCount:n.length-o.length,omittedCount:Math.max(0,o.length-i.length)}}function Un(e){return zo(e)}function zo(e){if(e==null)return String(e);if(Array.isArray(e))return`[${e.map(zo).join(",")}]`;if(typeof e=="object"){let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${zo(t[n])}`).join(",")}}`}return JSON.stringify(e)}var ld=25,cd=25;function $i(e,t,n){let r=e[t];if(Array.isArray(r)){r.includes(n)||r.push(n);return}if(typeof r=="string"&&r.trim()){e[t]=r===n?[r]:[r,n];return}e[t]=[n]}function Xi(e){if(!e||typeof e!="object"||d(e,"Success","success")===!1)return e;let n=Array.isArray(e.elements)?e.elements:Array.isArray(e.Elements)?e.Elements:null,r=e.count??e.Count,o=r==null||r===""?Number.NaN:Number(r),a=Number.isFinite(o)?o:n?.length??0,i=!!(e.truncated??e.Truncated),s=!!(e.ambiguous??e.Ambiguous),l=String(e.topConfidence??e.TopConfidence??""),u=!!(l&&l.toLowerCase()!=="high"),m=s||i||a!==1||u,p=m?"broad_or_ambiguous_discovery_result":"discovery_tool_result_not_parameter_write_evidence",g="find_elements is discovery-only. Never commit parameter writes from find_elements rows alone; broad, ambiguous, truncated, or non-high-confidence results are especially unsafe. Before writing, narrow to one exact elementId or uniqueId, verify it with inspect_elements, run inspect_parameter_schema for the target parameter, then run set_element_parameter in dryRun before commit. Do not write from a visible/display parameter name alone.",h="find_elements result is broad or ambiguous for write purposes; do not use it as parameter-write evidence. Narrow to one exact element and run inspect_parameter_schema before set_element_parameter.";return e.writeSafetyWarning=g,e.writeSafety={sufficientForWrite:!1,discoveryEvidenceOnly:!0,writeBlockedUntil:"exact_element_and_parameter_schema_preflight",requiresExactElementIdentity:!0,requiresParameterSchemaPreflight:!0,requiredPreflightTools:["inspect_elements","inspect_parameter_schema","set_element_parameter"],requiredBeforeParameterWrite:["narrow_to_exact_element_id_or_unique_id","inspect_elements_exact_target","inspect_parameter_schema_exact_target_parameter","set_element_parameter_dry_run_with_expected_current_value","commit_only_after_dry_run_verification"],parameterWritePolicy:"Never commit set_element_parameter from find_elements rows alone. Use find_elements only to discover candidates, then prove exact element and parameter identity before a dry-run or commit.",parameterIdentityRule:"Use builtInParameterId when available; otherwise confirm source/shared/storage/readOnly identity. Display name alone is not a write target.",resultRisk:{count:a,truncated:i,ambiguous:s,topConfidence:l,broadOrAmbiguous:m,confidenceRisk:u,unsafeForParameterWriteReason:p}},$i(e,"warnings",m?h:g),$i(e,"notices","find_elements_discovery_only_parameter_write_preflight_required"),typeof e.SelectionHint=="string"&&!e.SelectionHint.includes("find_elements is discovery-only")&&(e.SelectionHint=`${e.SelectionHint} ${g}`),typeof e.selectionHint=="string"&&!e.selectionHint.includes("find_elements is discovery-only")&&(e.selectionHint=`${e.selectionHint} ${g}`),e}function ud(e){let t=e.id??e.Id??e.uniqueId??e.UniqueId??e.elementId??e.ElementId;return t!=null&&t!==""?String(t):Un(e)}function dd(e){return Array.isArray(e.planCandidates)?"planCandidates":Array.isArray(e.PlanCandidates)?"PlanCandidates":null}function ze(e,...t){for(let n of t)if(e[n]!==void 0&&e[n]!==null&&e[n]!=="")return e[n]}function md(e){return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0))}function pd(e){let t=ze(e,"id","Id","viewId","ViewId","elementId","ElementId");if(t!==void 0)return String(t);let n=ze(e,"name","Name","viewName","ViewName"),r=ze(e,"levelId","LevelId","levelName","LevelName");return n!==void 0||r!==void 0?`${String(n??"")}|${String(r??"")}`:Un(e)}function hd(e,t){return md({ref:t,id:ze(e,"id","Id","viewId","ViewId","elementId","ElementId"),name:ze(e,"name","Name","viewName","ViewName"),viewType:ze(e,"viewType","ViewType"),levelId:ze(e,"levelId","LevelId"),levelName:ze(e,"levelName","LevelName"),score:ze(e,"score","Score","rankScore","RankScore"),rank:ze(e,"rank","Rank"),elementVisibleInView:ze(e,"elementVisibleInView","ElementVisibleInView"),reason:ze(e,"reason","Reason","matchReason","MatchReason")})}function fd(e,t){return{ref:t}}function gd(e,t,n){let r=dd(e);if(!r)return{element:e,totalCandidateRows:0,omittedCandidateRows:0};let o=e[r].filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)),a=[];for(let s of o){let l=pd(s);n.has(l)||n.set(l,hd(s,l)),a.length<t&&a.push(fd(s,l))}let i={...e};return delete i.planCandidates,delete i.PlanCandidates,i.planCandidateRefs=a,i.planCandidateCount=o.length,i.returnedPlanCandidateRefCount=a.length,i.omittedPlanCandidateRefCount=Math.max(0,o.length-a.length),{element:i,totalCandidateRows:o.length,omittedCandidateRows:Math.max(0,o.length-a.length)}}function yd(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||Tt(n))return{...e,responseMode:n};let r=Array.isArray(e.elements)?"elements":Array.isArray(e.Elements)?"Elements":null;if(!r)return{...e,responseMode:"compact"};let o=Ye(t.maxResultRows??t.limit,ld,200),a=Ye(t.maxPlanCandidates,3,25),i=Ye(t.maxPlanCandidateSummaryRows,Math.max(cd,a),100),s=Pe(e[r],{limit:o,key:ud}),l=new Map,u=0,m=0,p=s.rows.map(h=>{let w=gd(h,a,l);return u+=w.totalCandidateRows,m+=w.omittedCandidateRows,w.element}),g=Pe(Array.from(l.values()),{limit:i,key:h=>String(h.ref??Un(h))});return{...e,responseMode:"compact",[r]:p,planCandidateSummary:{compactResponse:!0,candidateRowCount:u,uniqueCandidateCount:l.size,returnedCandidateCount:g.returnedCount,omittedCandidateCount:g.omittedCount,duplicateCandidateRowCount:Math.max(0,u-l.size),omittedElementCandidateRefCount:m,candidates:g.rows},summary:{...e.summary||e.Summary||{},compactResponse:!0,elementRowCount:s.totalCount,returnedElementRowCount:s.returnedCount,omittedElementRowCount:s.omittedCount,duplicateElementRowCount:s.duplicateCount,planCandidateRowCount:u,uniquePlanCandidateCount:l.size,returnedPlanCandidateCount:g.returnedCount,omittedPlanCandidateCount:g.omittedCount},notices:[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds element rows and deduplicates plan candidates into planCandidateSummary. Use responseMode="full" for per-element plan candidate details.']}}function Ki(e){e.tool("find_elements","Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters plus safe in-memory level filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep before broad, linked, or verified visibility scans. Default responseMode=compact bounds element rows and deduplicates plan candidates into planCandidateSummary; use responseMode=full for per-element plan candidate details. Discovery-only: never use broad or ambiguous find_elements rows as write evidence; before writes, narrow to one exact element, inspect it, inspect the parameter schema, then use set_element_parameter dryRun before commit.",{...I(O),...N(O),query:O.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),categoryNames:O.array(O.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals. If omitted, common MEP terms such as fan coil/FCU, valve, damper, duct, pipe, sprinkler, pump, and AHU are inferred into a bounded category scope."),elementIds:O.array(O.union([O.number(),O.string()])).optional().describe("Exact element ids to inspect first when known."),uniqueIds:O.array(O.string()).optional().describe("Exact Revit unique ids to inspect first when known."),levelNames:O.array(O.string()).optional().describe("Restrict results to matching element level names, e.g. Level 08."),levelIds:O.array(O.union([O.number(),O.string()])).optional().describe("Restrict results to exact Revit level element ids."),activeViewOnly:O.boolean().optional().describe("Search only elements visible/owned in the active view when true. Preferred for large models when the user is already looking at the target area."),viewId:O.union([O.number(),O.string()]).optional().describe("Search only elements visible/owned in this view id."),familyName:O.string().optional().describe("Optional family-name filter applied before text scoring."),typeName:O.string().optional().describe("Optional type-name filter applied before text scoring."),systemName:O.string().optional().describe("Optional MEP system-name filter applied before text scoring when available."),worksetNames:O.array(O.string()).optional().describe("Optional workset-name filters for workshared production models."),worksetIds:O.array(O.union([O.number(),O.string()])).optional().describe("Optional exact workset ids for workshared production models."),linkScope:O.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Host model is searched by default. Linked model search is explicit and may require allowExpensiveSearch/searchBudget=deep on broad requests."),modelSignals:O.object({linkCount:O.number().int().nonnegative().optional(),linkInstances:O.number().int().nonnegative().optional(),loadedLinks:O.number().int().nonnegative().optional(),worksetCount:O.number().int().nonnegative().optional(),sheetCount:O.number().int().nonnegative().optional(),scheduleCount:O.number().int().nonnegative().optional()}).optional().describe("Optional cheap large-model signals from prior context. This never triggers new category counts; it only lets the risk policy use already-known link/workset/sheet/schedule counts."),searchBudget:O.enum(["fast","balanced","deep"]).optional().describe("Preset scan/elapsed budget. fast is default for first-pass discovery; balanced/deep intentionally allow larger scans."),allowExpensiveSearch:O.boolean().optional().describe("Explicit operator approval for broad, linked, all-model, or verified searches that may take longer."),maxElementsScanned:O.number().int().positive().max(5e5).optional().describe("Advanced override for the Revit-side scan cap. Prefer searchBudget for ordinary LLM use."),maxElapsedMs:O.number().int().positive().max(119e3).optional().describe("Advanced override for the Revit-side elapsed budget. This is clamped below socket timeout so partial results can return before transport timeout."),includePlanCandidates:O.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),planCandidateMode:O.enum(["none","metadata","verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms visibility in plan views and is allowed only for exact element targets or explicit expensive-search approval."),maxPlanCandidates:O.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),planNameContains:O.string().optional().describe("Optional plan name preference used when ranking plan candidates."),limit:O.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),responseMode:Rt,maxResultRows:O.number().int().positive().max(200).optional().describe("Compact-mode cap for returned element rows. Defaults to limit or 25; full/debug returns all native rows within limit."),maxPlanCandidateSummaryRows:O.number().int().positive().max(100).optional().describe("Compact-mode cap for the deduplicated top-level planCandidateSummary rows. Defaults 25 so global plan candidates are not capped by the per-element maxPlanCandidates limit."),timeoutMs:O.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{try{let n=Gi(t);if(n.guarded)return f(Xi(Ji(n)));let r=await D("find_elements",{originalQuery:n.originalQuery,query:n.effectiveQuery,categoryNames:n.effectiveCategoryNames,inferredScope:n.inferredScope,elementIds:t.elementIds,uniqueIds:t.uniqueIds,levelNames:t.levelNames,levelIds:t.levelIds,activeViewOnly:t.activeViewOnly===!0,viewId:t.viewId,familyName:t.familyName,typeName:t.typeName,systemName:t.systemName,worksetNames:t.worksetNames,worksetIds:t.worksetIds,linkScope:n.linkScope,searchBudget:n.searchBudget,allowExpensiveSearch:n.allowExpensiveSearch,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,includePlanCandidates:t.includePlanCandidates===!0,planCandidateMode:t.planCandidateMode||(t.includePlanCandidates===!0?"verified":"none"),maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.limit,timeoutMs:n.timeoutMs},{...V({...t,timeoutMs:n.timeoutMs},"Find Revit elements")}),o=r&&r.result?r.result:r;return o&&typeof o=="object"&&(o.inferredScope=o.inferredScope||n.inferredScope,o.effectiveScope=o.effectiveScope||{categoryNames:n.effectiveCategoryNames,linkScope:n.linkScope},o.riskPolicy=o.riskPolicy||n.riskPolicy,o.scanPolicy=o.scanPolicy||{searchBudget:n.searchBudget,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,timeoutMs:n.timeoutMs,allowExpensiveSearch:n.allowExpensiveSearch},o.suggestedNextScopes=o.suggestedNextScopes||n.suggestedNextScopes,o.warnings=[...new Set([...Array.isArray(o.warnings)?o.warnings:[],...n.warnings])]),f(yd(Xi(o),t))}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as fe}from"zod";var Sd=fe.union([fe.number().int().positive(),fe.string().regex(/^\d+$/)]);function Pr(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),ViewType:d(e,"ViewType","viewType"),Scale:d(e,"Scale","scale")}}function bd(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),ClassName:d(e,"ClassName","className"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),HasBoundingBox:d(e,"HasBoundingBox","hasBoundingBox")}}function wd(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Action:d(e,"Action","action"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),ResponseMode:"compact",PlanMode:d(e,"PlanMode","planMode"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),FallbackUsed:d(e,"FallbackUsed","fallbackUsed"),VerifiedCandidateCount:d(e,"VerifiedCandidateCount","verifiedCandidateCount"),RejectedCandidateCount:d(e,"RejectedCandidateCount","rejectedCandidateCount"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),FocusBlocked:d(e,"FocusBlocked","focusBlocked"),FocusBlockReason:d(e,"FocusBlockReason","focusBlockReason"),FocusSuggestion:d(e,"FocusSuggestion","focusSuggestion"),TargetView:Pr(d(e,"TargetView","targetView")),SelectedPlan:Pr(d(e,"SelectedPlan","selectedPlan")),SuggestedView:Pr(d(e,"SuggestedView","suggestedView")),ActiveView:Pr(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),Element:bd(d(e,"ElementInfo","elementInfo")),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function Yi(e){e.tool("open_existing_plan_for_element_level","Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.",{...I(fe),...N(fe),elementId:Sd.describe("ElementId to locate in an existing plan view."),planMode:fe.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing plan on the element level. activePlan keeps the current active plan and does not switch to the element level. Defaults elementLevel."),planCandidateMode:fe.enum(["metadataFirst","verified"]).optional().describe("Plan selection strategy for elementLevel mode. metadataFirst is the default and ranks same-level plans without scanning every candidate view, then verifies a small number of ranked candidates. verified scans all candidate views before selecting and is slower."),fallbackToVerified:fe.boolean().optional().describe("When metadataFirst cannot find a visible element within the limited ranked-candidate check, run the slower verified scan before failing. Defaults true."),maxMetadataVerifyCandidates:fe.number().int().min(1).max(25).optional().describe("Maximum ranked metadata candidates verified before fallback. Defaults 5."),planNameContains:fe.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:fe.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:fe.boolean().optional().describe("Select the element after activating the plan. Defaults true."),zoom:fe.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),fitToScreen:fe.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),verboseCandidates:fe.boolean().optional().describe("Return full PlanCandidates arrays. Defaults false; routine responses return only the top candidates."),maxPlanCandidates:fe.number().int().min(0).max(50).optional().describe("Maximum PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:fe.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns the raw tool result."),timeoutMs:fe.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000.")},async t=>{try{let n=await D("open_existing_plan_for_element_level",{elementId:t.elementId,planMode:t.planMode,planCandidateMode:t.planCandidateMode,fallbackToVerified:t.fallbackToVerified,maxMetadataVerifyCandidates:t.maxMetadataVerifyCandidates,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs},{...V(t,"Open existing plan for element level")}),r=n&&n.result?n.result:n,o=qt(r,{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"?f(o):f(wd(o))}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as xe}from"zod";var xd=xe.union([xe.number().int().positive(),xe.string().regex(/^\d+$/)]);function Qi(e){e.tool("focus_elements","Select and zoom to Revit elements in the active view or in a requested view tab. This is a UI operation and does not open a Revit transaction.",{...I(xe),...N(xe),elementIds:xe.array(xd).min(1).describe("ElementId values to select and show."),viewId:xe.number().int().positive().optional().describe("Optional ElementId of the Revit view to activate before focusing elements."),viewName:xe.string().optional().describe("Optional name of the Revit view to activate before focusing elements."),viewType:xe.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, Section, Elevation, DrawingSheet, or Schedule."),exactName:xe.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),select:xe.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:xe.boolean().optional().describe("Zoom/show the supplied elements in the active UI view. Defaults true."),fitToScreen:xe.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active view. Defaults false."),allowClosedViewSearch:xe.boolean().optional().describe("Allow Revit ShowElements to open its modal closed-view search when elements are not visible in the target view. Defaults false to avoid blocking automation."),allowPartial:xe.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:xe.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation/focus verification. Defaults 5000; pass a larger value for slow view activation.")},async t=>{try{let n=await D("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:t.allowClosedViewSearch,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...V(t,"Focus Revit elements")});return f(n&&n.result?n.result:n)}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Te}from"zod";var vd=Te.union([Te.number().int().positive(),Te.string().regex(/^\d+$/)]);function Zi(e){e.tool("section_box_elements","Apply a 3D section box around Revit elements, optionally select them, and zoom to them. Requires a 3D view; if viewId/viewName is supplied, that view is activated first.",{...I(Te),...N(Te),elementIds:Te.array(vd).min(1).describe("ElementId values to include in the section box."),viewId:Te.number().int().positive().optional().describe("Optional ElementId of the 3D Revit view to activate and modify."),viewName:Te.string().optional().describe("Optional name of the 3D Revit view to activate and modify."),viewType:Te.string().optional().describe("Optional Revit ViewType filter. For this tool the resolved view must be ThreeD."),exactName:Te.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),paddingMm:Te.number().min(0).max(1e5).optional().describe("Extra space around the element bounding box in millimeters. Defaults 500."),select:Te.boolean().optional().describe("Select the supplied elements after applying the section box. Defaults true."),zoom:Te.boolean().optional().describe("Zoom/show the supplied elements after applying the section box. Defaults true."),allowPartial:Te.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:Te.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous 3D view activation and section box application. Defaults 15000.")},async t=>{try{let n=await D("section_box_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,paddingMm:t.paddingMm,select:t.select,zoom:t.zoom,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...V(t,"Section box Revit elements")});return f(n&&n.result?n.result:n)}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as pe}from"zod";var _d=pe.union([pe.number().int().positive(),pe.string().regex(/^\d+$/)]);function es(e){e.tool("create_3d_view_for_elements","[LIVE_VIEW_NAVIGATION_PRIMITIVE] Create or reuse a 3D Revit view for elements, optionally apply or clear a section box, activate the view, and focus/select the elements. Use this when the user wants to see, open, zoom to, or inspect elements live inside Revit. This can modify the document because views and section boxes are project data.",{...I(pe),...N(pe),elementIds:pe.array(_d).min(1).describe("ElementId values to show in the 3D view."),viewName:pe.string().optional().describe("Desired 3D view name. If omitted, a name is generated from the first element id."),reuseExisting:pe.boolean().optional().describe("Reuse an existing non-template 3D view with the same name when viewName is supplied. Defaults true."),createIfMissing:pe.boolean().optional().describe("Create the 3D view when no reusable view is found. Defaults true."),sectionBox:pe.boolean().optional().describe("When true, apply a section box around the elements. When false, any active section box on the target view is cleared. Defaults false."),paddingMm:pe.number().min(0).max(1e5).optional().describe("Extra section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:pe.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction to apply using the aggregate element bounding box. Defaults unchanged."),framingPaddingMm:pe.number().min(0).max(1e5).optional().describe("Extra padding in millimeters for camera orientation/framing when cameraOrientation is not unchanged. Defaults to paddingMm or 500."),activate:pe.boolean().optional().describe("Activate the target 3D view. Defaults true."),select:pe.boolean().optional().describe("Select the supplied elements after activation. Defaults true."),zoom:pe.boolean().optional().describe("Zoom/show the supplied elements after activation. Defaults true."),fitToScreen:pe.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active 3D view. Defaults false."),allowPartial:pe.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:pe.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous view creation/activation/focus. Defaults 20000.")},async t=>{try{let n=await D("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName,reuseExisting:t.reuseExisting,createIfMissing:t.createIfMissing,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:t.activate,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...V(t,"Create 3D view for elements")});return f(n&&n.result?n.result:n)}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import Cd from"node:os";import ts from"node:path";import{z as Y}from"zod";var Rd=Y.enum(["raw_evidence","coordination_overlay","system_focus","clash_clearance"]),Td=Y.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Id=Y.enum(["72","150","300","600"]),Ed=Y.enum(["horizontal","vertical"]),Nd=Y.enum(["auto","qa_high_contrast","technical_report","outline_only","raw"]),Md={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Ad={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},kd={horizontal:"Horizontal",vertical:"Vertical"};function Od(){return ts.join(Cd.tmpdir(),"revAgent-image-export")}function Pd(e){return(e&&e.trim()?e.trim():`revit-coordination-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function Ld(e){let t=e||[],n=[],r=[];for(let o of t){if(typeof o=="number"){Number.isSafeInteger(o)&&o>0?n.push(o):r.push(o);continue}let a=String(o).trim();if(/^\d+$/.test(a)){let i=Number(a);if(Number.isSafeInteger(i)&&i>0){n.push(i);continue}}r.push(o)}return{ids:n,invalid:r,suppliedCount:t.length}}function Vd(e){return`new List<int> { ${e.map(n=>Math.trunc(n)).join(", ")} }`}function Dd(e){return e==="raw_evidence"?"raw":e==="coordination_overlay"?"outline_only":"technical_report"}function ns(e){e.tool("export_revit_coordination_image","[VISUAL_ARTIFACT_EXPORT_ONLY] Create or reuse a visual QA 3D view, optionally section-box target elements, apply a selectable target visual style, and export an image artifact. Auto style is report-friendly and never selects qa_high_contrast by itself. Use qa_high_contrast explicitly for debug/LLM evidence, technical_report or outline_only for report-style evidence, and raw when the target must keep native appearance. Use this when the user asks for PNG/JPEG/report/LLM visual evidence. If elementIds are provided but none are found, it returns guarded no_requested_elements_found unless allowFullViewFallback=true is explicit. Do not use this as the primary tool for live view navigation, selected-element zoom, or opening an element in a Revit view; for that workflow use create_3d_view_for_elements or show_element_in_plan_and_3d, then optionally export the active view with export_revit_view_image. It only writes review view settings; it does not create or modify MEP model elements. Set cleanupAfterExport=true when a newly created review view should be deleted after the image file is produced.",{...I(Y),intent:Rd.optional().default("coordination_overlay"),targetVisualStyle:Nd.optional().default("auto").describe("Target override style. auto is report-friendly: raw_evidence -> raw, coordination_overlay -> outline_only, system_focus/clash_clearance -> technical_report. qa_high_contrast is used only when explicitly requested. raw applies no target override."),elementIds:Y.array(Y.union([Y.number(),Y.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),viewName:Y.string().optional().default("DPE Visual QA - Coordination Export"),marginMm:Y.number().min(0).max(2e4).optional().default(2e3),singleElementMarginMm:Y.number().min(0).max(2e4).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),contextTransparency:Y.number().int().min(0).max(90).optional().default(65),pixelSize:Y.number().int().min(200).max(1e4).optional().default(4e3).describe("Final image size for the requested fit direction after crop/downsample. For coordination crops, Revit may export a higher-resolution source first."),preExportPixelSize:Y.number().int().min(0).max(2e4).optional().default(0).describe("Optional Revit source export size before crop/downsample. Use 0 or omit for automatic high-resolution source export on single-target model-projection crops."),maxAutoPreExportPixelSize:Y.number().int().min(1e3).max(2e4).optional().default(1e4).describe("Upper bound for automatic high-resolution source exports used before single-target model-projection crops."),allowFinalUpscale:Y.boolean().optional().default(!1).describe("When false, model-projection crops are widened instead of enlarging a tiny source crop to the final pixelSize. This preserves image quality even when targetMinFillRatio cannot be reached within Revit's source export limit."),enforcePixelSize:Y.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the final requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),cropToTargetHighlight:Y.boolean().optional().default(!0).describe("When true, tightens the Revit 3D view crop box from model bbox/camera projection. Raster highlight pixels are QA metrics only unless Revit model crop-box framing is unavailable."),targetMinFillRatio:Y.number().min(.1).max(.9).optional().default(.4).describe("Minimum target occupancy used when sizing model-bounding-box projection crops. Raster highlight fill, when detected, is reported separately as QA."),highlightCropPaddingPx:Y.number().int().min(0).max(2e3).optional().default(24).describe("Debug fallback padding for highlight-pixel crops when model projection is not available."),allowFullViewFallback:Y.boolean().optional().default(!1).describe("When elementIds are provided but none are found, allow exporting the full review 3D view instead of returning guarded. Defaults false to avoid misleading element evidence."),dpi:Id.optional().default("300"),fitDirection:Ed.optional().default("horizontal"),format:Td.optional().default("png"),outputDir:Y.string().optional(),filePrefix:Y.string().optional(),cleanupAfterExport:Y.boolean().optional().default(!1).describe("When true, a review view created by this call is deleted after export. Existing reused review views are never deleted automatically."),...N(Y),timeoutMs:Y.number().int().positive().optional()},async t=>{let n=Ld(t.elementIds);if(n.invalid.length>0)return f(ot({action:"export_revit_coordination_image",reason:"invalid_element_ids",error:"elementIds must be positive integer Revit ElementId values. UniqueId strings or other non-numeric ids are not valid target evidence ids.",extra:{revitWriteAction:"none",requestedElementCount:n.suppliedCount,validElementCount:n.ids.length,invalidElementIds:n.invalid}}));let r=ts.resolve(t.outputDir||Od()),o=Pd(t.filePrefix),a=t.intent||"coordination_overlay",i=t.targetVisualStyle||"auto",s=i==="auto"?Dd(a):i,l=Md[t.format||"png"],u=Ad[String(t.dpi||"150")],m=kd[t.fitDirection||"horizontal"],p=Math.trunc(t.pixelSize||4e3),g=Number.isFinite(Number(t.preExportPixelSize))?Math.max(0,Math.trunc(Number(t.preExportPixelSize))):0,h=Number.isFinite(Number(t.maxAutoPreExportPixelSize))?Math.max(1e3,Math.min(2e4,Math.trunc(Number(t.maxAutoPreExportPixelSize)))):1e4,w=t.allowFinalUpscale===!0,_=Number.isFinite(Number(t.marginMm))?Number(t.marginMm):2e3,L=Number.isFinite(Number(t.singleElementMarginMm))?Number(t.singleElementMarginMm):300,R=t.enforcePixelSize!==!1,A=t.cropToTargetHighlight!==!1,T=Number.isFinite(Number(t.targetMinFillRatio))?Math.max(.1,Math.min(.9,Number(t.targetMinFillRatio))):.4,j=Number.isFinite(Number(t.highlightCropPaddingPx))?Math.trunc(t.highlightCropPaddingPx):24,z=t.allowFullViewFallback===!0,J=Math.trunc(t.contextTransparency??65),y=t.cleanupAfterExport===!0,B=`
var warnings = new List<string>();
var notices = new List<string>();
string outputDir = ${F(r)};
string filePrefix = ${F(o)};
string desiredViewName = ${F(t.viewName||"DPE Visual QA - Coordination Export")};
string intent = ${F(a)};
string targetVisualStyle = ${F(s)};
var requestedElementIds = ${Vd(n.ids)};
double marginFeet = ${_} / 304.8;
double singleElementMarginFeet = ${L} / 304.8;
int contextTransparency = ${J};
int requestedPixelSize = ${p};
int requestedPreExportPixelSize = ${g};
int maxAutoPreExportPixelSize = ${h};
int revitExportPixelSize = requestedPixelSize;
bool autoPreExportPixelSize = requestedPreExportPixelSize <= 0;
string preExportPixelSizeReason = "same_as_final_pixel_size";
string requestedFitDirection = ${F(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${R?"true":"false"};
bool cropToTargetHighlight = ${A?"true":"false"};
bool allowFinalUpscale = ${w?"true":"false"};
double targetMinFillRatio = ${T};
int highlightCropPaddingPx = ${j};
bool allowFullViewFallback = ${z?"true":"false"};
bool cleanupAfterExport = ${y?"true":"false"};

System.IO.Directory.CreateDirectory(outputDir);

Func<string, string> sanitize = (value) => {
  if (String.IsNullOrWhiteSpace(value)) return "revit-coordination-image";
  var invalid = System.IO.Path.GetInvalidFileNameChars();
  var chars = value.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray();
  return new string(chars);
};

var viewFamilyType = new FilteredElementCollector(document)
  .OfClass(typeof(ViewFamilyType))
  .Cast<ViewFamilyType>()
  .FirstOrDefault(vft => vft.ViewFamily == ViewFamily.ThreeDimensional);
if (viewFamilyType == null) {
  return new { success = false, guarded = false, state = "failed", action = "export_revit_coordination_image", error = "three_dimensional_view_family_type_not_found" };
}

var targetElements = new List<Element>();
var missingIds = new List<int>();
foreach (int rawId in requestedElementIds) {
  var element = document.GetElement(new ElementId(rawId));
  if (element == null) missingIds.Add(rawId);
  else targetElements.Add(element);
}
if (missingIds.Count > 0) warnings.Add("coordination_element_ids_not_found:" + String.Join(",", missingIds));
if (requestedElementIds.Count > 0 && targetElements.Count == 0 && !allowFullViewFallback) {
  return new {
    success = false,
    guarded = true,
    state = "guarded",
    action = "export_revit_coordination_image",
    reason = "no_requested_elements_found",
    error = "All requested element ids were missing. Refusing to export a full 3D fallback image unless allowFullViewFallback=true.",
    revitWriteAction = "none",
    requestedElementCount = requestedElementIds.Count,
    foundElementCount = targetElements.Count,
    missingElementIds = missingIds,
    outputDir = outputDir,
    filePrefix = filePrefix,
    warnings = warnings,
    notices = notices
  };
}
if (targetElements.Count == 0) warnings.Add("coordination_no_element_scope_full_3d_view_exported");

View3D reviewView = new FilteredElementCollector(document)
  .OfClass(typeof(View3D))
  .Cast<View3D>()
  .FirstOrDefault(v => !v.IsTemplate && String.Equals(v.Name, desiredViewName, System.StringComparison.OrdinalIgnoreCase));

bool createdView = false;
if (reviewView == null) {
  reviewView = View3D.CreateIsometric(document, viewFamilyType.Id);
  createdView = true;
  try { reviewView.Name = desiredViewName; }
  catch { reviewView.Name = desiredViewName + " " + reviewView.Id.IntegerValue.ToString(); }
}

reviewView.DetailLevel = ViewDetailLevel.Fine;
reviewView.DisplayStyle = DisplayStyle.ShadingWithEdges;

BoundingBoxXYZ merged = null;
foreach (var element in targetElements) {
  var box = element.get_BoundingBox(null);
  if (box == null) continue;
  if (merged == null) {
    merged = new BoundingBoxXYZ();
    merged.Min = box.Min;
    merged.Max = box.Max;
  }
  else {
    merged.Min = new XYZ(Math.Min(merged.Min.X, box.Min.X), Math.Min(merged.Min.Y, box.Min.Y), Math.Min(merged.Min.Z, box.Min.Z));
    merged.Max = new XYZ(Math.Max(merged.Max.X, box.Max.X), Math.Max(merged.Max.Y, box.Max.Y), Math.Max(merged.Max.Z, box.Max.Z));
  }
}

bool sectionBoxApplied = false;
bool cameraFramedToTargets = false;
double framingDistanceFeet = 0.0;
string framingMode = "full_3d_view";
bool targetCropEstimateAvailable = false;
double targetCropCenterXRatio = 0.5;
double targetCropCenterYRatio = 0.5;
double targetCropFillRatioEstimate = 0.0;
bool modelCropBoxApplied = false;
double modelCropBoxTargetFillRatio = 0.0;

Func<BoundingBoxXYZ, XYZ, double> projectedExtentOnAxis = (box, axis) => {
  if (box == null || axis == null) return 0.0;
  var points = new List<XYZ> {
    new XYZ(box.Min.X, box.Min.Y, box.Min.Z),
    new XYZ(box.Min.X, box.Min.Y, box.Max.Z),
    new XYZ(box.Min.X, box.Max.Y, box.Min.Z),
    new XYZ(box.Min.X, box.Max.Y, box.Max.Z),
    new XYZ(box.Max.X, box.Min.Y, box.Min.Z),
    new XYZ(box.Max.X, box.Min.Y, box.Max.Z),
    new XYZ(box.Max.X, box.Max.Y, box.Min.Z),
    new XYZ(box.Max.X, box.Max.Y, box.Max.Z)
  };
  double min = Double.MaxValue;
  double max = Double.MinValue;
  foreach (var point in points) {
    double value = point.DotProduct(axis);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max < min) return 0.0;
  return max - min;
};

if (merged != null) {
  double effectiveMarginFeet = targetElements.Count == 1 ? Math.Min(marginFeet, singleElementMarginFeet) : marginFeet;
  var section = new BoundingBoxXYZ();
  section.Min = new XYZ(merged.Min.X - effectiveMarginFeet, merged.Min.Y - effectiveMarginFeet, merged.Min.Z - effectiveMarginFeet);
  section.Max = new XYZ(merged.Max.X + effectiveMarginFeet, merged.Max.Y + effectiveMarginFeet, merged.Max.Z + effectiveMarginFeet);
  reviewView.IsSectionBoxActive = true;
  reviewView.SetSectionBox(section);
  sectionBoxApplied = true;
  framingMode = "section_box_and_camera";

  try {
    XYZ center = new XYZ(
      (section.Min.X + section.Max.X) / 2.0,
      (section.Min.Y + section.Max.Y) / 2.0,
      (section.Min.Z + section.Max.Z) / 2.0);
    double dx = Math.Max(0.1, section.Max.X - section.Min.X);
    double dy = Math.Max(0.1, section.Max.Y - section.Min.Y);
    double dz = Math.Max(0.1, section.Max.Z - section.Min.Z);
    double diagonal = Math.Sqrt((dx * dx) + (dy * dy) + (dz * dz));
    XYZ forward = new XYZ(-0.60, -0.60, -0.50).Normalize();
    XYZ right = XYZ.BasisZ.CrossProduct(forward);
    if (right.GetLength() < 0.000001) right = XYZ.BasisX;
    right = right.Normalize();
    XYZ up = forward.CrossProduct(right).Normalize();

    framingDistanceFeet = Math.Max(diagonal * 2.25, 10.0);
    XYZ eye = center.Subtract(forward.Multiply(framingDistanceFeet));
    reviewView.SetOrientation(new ViewOrientation3D(eye, up, forward));
    try { reviewView.CropBoxActive = true; } catch {}
    try { reviewView.CropBoxVisible = false; } catch {}
    try {
      var viewCrop = reviewView.CropBox;
      if (viewCrop != null && viewCrop.Transform != null) {
        var inverseCropTransform = viewCrop.Transform.Inverse;
        var targetPoints = new List<XYZ> {
          new XYZ(merged.Min.X, merged.Min.Y, merged.Min.Z),
          new XYZ(merged.Min.X, merged.Min.Y, merged.Max.Z),
          new XYZ(merged.Min.X, merged.Max.Y, merged.Min.Z),
          new XYZ(merged.Min.X, merged.Max.Y, merged.Max.Z),
          new XYZ(merged.Max.X, merged.Min.Y, merged.Min.Z),
          new XYZ(merged.Max.X, merged.Min.Y, merged.Max.Z),
          new XYZ(merged.Max.X, merged.Max.Y, merged.Min.Z),
          new XYZ(merged.Max.X, merged.Max.Y, merged.Max.Z)
        };
        double minLocalX = Double.MaxValue;
        double maxLocalX = Double.MinValue;
        double minLocalY = Double.MaxValue;
        double maxLocalY = Double.MinValue;
        foreach (var point in targetPoints) {
          var local = inverseCropTransform.OfPoint(point);
          if (local.X < minLocalX) minLocalX = local.X;
          if (local.X > maxLocalX) maxLocalX = local.X;
          if (local.Y < minLocalY) minLocalY = local.Y;
          if (local.Y > maxLocalY) maxLocalY = local.Y;
        }
        if (cropToTargetHighlight && targetElements.Count == 1) {
          try {
            double safeFillRatioForViewCrop = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
            double targetLocalSpanX = Math.Max(0.000001, maxLocalX - minLocalX);
            double targetLocalSpanY = Math.Max(0.000001, maxLocalY - minLocalY);
            double desiredLocalSpan = Math.Max(targetLocalSpanX, targetLocalSpanY) / safeFillRatioForViewCrop;
            double centerLocalXForCrop = (minLocalX + maxLocalX) / 2.0;
            double centerLocalYForCrop = (minLocalY + maxLocalY) / 2.0;
            var tightenedCrop = new BoundingBoxXYZ();
            tightenedCrop.Transform = viewCrop.Transform;
            tightenedCrop.Min = new XYZ(
              centerLocalXForCrop - (desiredLocalSpan / 2.0),
              centerLocalYForCrop - (desiredLocalSpan / 2.0),
              viewCrop.Min.Z);
            tightenedCrop.Max = new XYZ(
              centerLocalXForCrop + (desiredLocalSpan / 2.0),
              centerLocalYForCrop + (desiredLocalSpan / 2.0),
              viewCrop.Max.Z);
            reviewView.CropBox = tightenedCrop;
            modelCropBoxApplied = true;
            viewCrop = reviewView.CropBox;
            inverseCropTransform = viewCrop.Transform.Inverse;
            minLocalX = Double.MaxValue;
            maxLocalX = Double.MinValue;
            minLocalY = Double.MaxValue;
            maxLocalY = Double.MinValue;
            foreach (var point in targetPoints) {
              var local = inverseCropTransform.OfPoint(point);
              if (local.X < minLocalX) minLocalX = local.X;
              if (local.X > maxLocalX) maxLocalX = local.X;
              if (local.Y < minLocalY) minLocalY = local.Y;
              if (local.Y > maxLocalY) maxLocalY = local.Y;
            }
          }
          catch (Exception ex) {
            warnings.Add("coordination_model_crop_box_tighten_failed:" + ex.Message);
          }
        }
        double cropSpanX = Math.Max(0.000001, viewCrop.Max.X - viewCrop.Min.X);
        double cropSpanY = Math.Max(0.000001, viewCrop.Max.Y - viewCrop.Min.Y);
        double centerLocalX = (minLocalX + maxLocalX) / 2.0;
        double centerLocalY = (minLocalY + maxLocalY) / 2.0;
        targetCropCenterXRatio = Math.Max(0.02, Math.Min(0.98, (centerLocalX - viewCrop.Min.X) / cropSpanX));
        targetCropCenterYRatio = Math.Max(0.02, Math.Min(0.98, 1.0 - ((centerLocalY - viewCrop.Min.Y) / cropSpanY)));
        targetCropFillRatioEstimate = Math.Max((maxLocalX - minLocalX) / cropSpanX, (maxLocalY - minLocalY) / cropSpanY);
        modelCropBoxTargetFillRatio = targetCropFillRatioEstimate;
        targetCropEstimateAvailable = targetCropFillRatioEstimate > 0.0;
      }
    }
    catch (Exception ex) {
      warnings.Add("coordination_bbox_crop_estimate_failed:" + ex.Message);
    }
    cameraFramedToTargets = true;
  }
  catch (Exception ex) {
    warnings.Add("coordination_camera_frame_failed:" + ex.Message);
  }
}

bool targetOverrideApplied = false;
string targetOverrideMode = targetVisualStyle;
int targetOverrideResetCount = 0;
foreach (var element in targetElements) {
  try {
    reviewView.SetElementOverrides(element.Id, new OverrideGraphicSettings());
    targetOverrideResetCount++;
  }
  catch { warnings.Add("coordination_element_override_reset_failed:" + element.Id.IntegerValue.ToString()); }
}

if (!String.Equals(targetVisualStyle, "raw", System.StringComparison.OrdinalIgnoreCase)) {
  var targetGraphics = new OverrideGraphicSettings();
  bool isQaHighContrast = String.Equals(targetVisualStyle, "qa_high_contrast", System.StringComparison.OrdinalIgnoreCase);
  bool isTechnicalReport = String.Equals(targetVisualStyle, "technical_report", System.StringComparison.OrdinalIgnoreCase);
  bool isOutlineOnly = String.Equals(targetVisualStyle, "outline_only", System.StringComparison.OrdinalIgnoreCase);
  var targetColor = isQaHighContrast
    ? new Color(0, 255, 128)
    : new Color(0, 170, 255);
  int lineWeight = isQaHighContrast ? 12 : 1;
  int surfaceTransparency = isQaHighContrast ? 1 : (isOutlineOnly ? 100 : 85);
  bool applySurfaceFill =
    isQaHighContrast ||
    isTechnicalReport;

  targetGraphics.SetProjectionLineColor(targetColor);
  targetGraphics.SetCutLineColor(targetColor);
  targetGraphics.SetProjectionLineWeight(lineWeight);
  targetGraphics.SetCutLineWeight(lineWeight);
  try { targetGraphics.SetHalftone(false); } catch {}
  try { targetGraphics.SetSurfaceTransparency(surfaceTransparency); } catch {}
  if (applySurfaceFill) {
    try {
      var solidFill = new FilteredElementCollector(document)
        .OfClass(typeof(FillPatternElement))
        .Cast<FillPatternElement>()
        .FirstOrDefault(fp => fp.GetFillPattern() != null && fp.GetFillPattern().IsSolidFill);
      if (solidFill != null) {
        targetGraphics.SetSurfaceForegroundPatternId(solidFill.Id);
        targetGraphics.SetSurfaceForegroundPatternColor(targetColor);
        targetGraphics.SetSurfaceForegroundPatternVisible(true);
        targetGraphics.SetCutForegroundPatternId(solidFill.Id);
        targetGraphics.SetCutForegroundPatternColor(targetColor);
        targetGraphics.SetCutForegroundPatternVisible(true);
      }
    }
    catch (Exception ex) {
      warnings.Add("coordination_target_surface_override_failed:" + ex.Message);
    }
  }

  foreach (var element in targetElements) {
    try {
      reviewView.SetElementOverrides(element.Id, targetGraphics);
      targetOverrideApplied = true;
    }
    catch { warnings.Add("coordination_element_override_failed:" + element.Id.IntegerValue.ToString()); }
  }
}

var contextGraphics = new OverrideGraphicSettings();
contextGraphics.SetSurfaceTransparency(contextTransparency);
contextGraphics.SetHalftone(true);

var contextCategories = new List<BuiltInCategory> {
  BuiltInCategory.OST_Walls,
  BuiltInCategory.OST_Floors,
  BuiltInCategory.OST_Ceilings,
  BuiltInCategory.OST_StructuralColumns,
  BuiltInCategory.OST_StructuralFraming,
  BuiltInCategory.OST_Roofs
};
foreach (var bic in contextCategories) {
  var category = Category.GetCategory(document, bic);
  if (category == null) continue;
  try { reviewView.SetCategoryOverrides(category.Id, contextGraphics); }
  catch { warnings.Add("coordination_category_override_failed:" + bic.ToString()); }
}

var before = new HashSet<string>(System.IO.Directory.GetFiles(outputDir).Select(f => System.IO.Path.GetFullPath(f)), System.StringComparer.OrdinalIgnoreCase);

if (requestedPreExportPixelSize > 0) {
  revitExportPixelSize = Math.Max(200, Math.Min(20000, requestedPreExportPixelSize));
  preExportPixelSizeReason = "explicit_pre_export_pixel_size";
}
else if (cropToTargetHighlight && targetElements.Count == 1 && targetCropEstimateAvailable && targetCropFillRatioEstimate > 0.000001) {
  double safeFillRatioForSource = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
  int neededSourceSize = (int)Math.Ceiling((double)requestedPixelSize * safeFillRatioForSource / Math.Max(0.000001, targetCropFillRatioEstimate));
  revitExportPixelSize = Math.Max(requestedPixelSize, Math.Min(maxAutoPreExportPixelSize, neededSourceSize));
  preExportPixelSizeReason = revitExportPixelSize > requestedPixelSize
    ? "auto_model_bbox_projection_source_resolution"
    : "auto_same_as_final_pixel_size";
}

var options = new ImageExportOptions();
options.FilePath = System.IO.Path.Combine(outputDir, sanitize(filePrefix));
options.ExportRange = ExportRange.SetOfViews;
options.ZoomType = ZoomFitType.FitToPage;
options.PixelSize = revitExportPixelSize;
options.FitDirection = FitDirectionType.${m};
options.ImageResolution = ImageResolution.${u};
options.HLRandWFViewsFileType = ImageFileType.${l};
options.ShadowViewsFileType = ImageFileType.${l};
options.ShouldCreateWebSite = false;
options.SetViewsAndSheets(new List<ElementId> { reviewView.Id });
document.ExportImage(options);

Func<byte[], int, int> readInt32BigEndian = (bytes, offset) =>
  (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
Func<byte[], int, int> readInt16BigEndian = (bytes, offset) =>
  (bytes[offset] << 8) | bytes[offset + 1];
Func<byte[], int, int> readInt16LittleEndian = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8);
Func<byte[], int, int> readInt32LittleEndian = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
Func<string, int[]> readImageSize = (f) => {
  byte[] bytes = System.IO.File.ReadAllBytes(f);
  if (bytes.Length >= 24 &&
      bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
    return new int[] { readInt32BigEndian(bytes, 16), readInt32BigEndian(bytes, 20) };
  }
  if (bytes.Length >= 26 && bytes[0] == 0x42 && bytes[1] == 0x4D) {
    return new int[] { readInt32LittleEndian(bytes, 18), Math.Abs(readInt32LittleEndian(bytes, 22)) };
  }
  if (bytes.Length >= 18) {
    string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
    if (extension == ".tga" || extension == ".targa") {
      int tgaWidth = readInt16LittleEndian(bytes, 12);
      int tgaHeight = readInt16LittleEndian(bytes, 14);
      if (tgaWidth > 0 && tgaHeight > 0) return new int[] { tgaWidth, tgaHeight };
    }
  }
  if (bytes.Length >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8) {
    int offset = 2;
    while (offset + 9 < bytes.Length) {
      if (bytes[offset] != 0xFF) { offset++; continue; }
      byte marker = bytes[offset + 1];
      if (marker == 0xD8 || marker == 0xD9) { offset += 2; continue; }
      int segmentLength = readInt16BigEndian(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.Length) break;
      bool isSof = (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC);
      if (isSof && offset + 8 < bytes.Length) {
        return new int[] { readInt16BigEndian(bytes, offset + 7), readInt16BigEndian(bytes, offset + 5) };
      }
      offset += 2 + segmentLength;
    }
  }
  if (bytes.Length >= 16 &&
      ((bytes[0] == 0x49 && bytes[1] == 0x49) || (bytes[0] == 0x4D && bytes[1] == 0x4D))) {
    bool little = bytes[0] == 0x49;
    Func<int, int> read16 = (offset) => little ? readInt16LittleEndian(bytes, offset) : readInt16BigEndian(bytes, offset);
    Func<int, int> read32 = (offset) => little ? readInt32LittleEndian(bytes, offset) : readInt32BigEndian(bytes, offset);
    int ifdOffset = read32(4);
    if (ifdOffset > 0 && ifdOffset + 2 < bytes.Length) {
      int entries = read16(ifdOffset);
      int width = 0;
      int height = 0;
      for (int i = 0; i < entries; i++) {
        int entryOffset = ifdOffset + 2 + (i * 12);
        if (entryOffset + 12 > bytes.Length) break;
        int tag = read16(entryOffset);
        int value = read32(entryOffset + 8);
        if (tag == 256) width = value;
        if (tag == 257) height = value;
      }
      if (width > 0 && height > 0) return new int[] { width, height };
    }
  }
  return null;
};

Func<string, int[], bool> resizeImageToRequestedPixelSize = (f, size) => {
  if (!enforcePixelSize || requestedPixelSize <= 0 || size == null || size.Length != 2) return false;
  int originalWidth = size[0];
  int originalHeight = size[1];
  if (originalWidth <= 0 || originalHeight <= 0) return false;

  int targetWidth = originalWidth;
  int targetHeight = originalHeight;
  if (String.Equals(requestedFitDirection, "vertical", System.StringComparison.OrdinalIgnoreCase)) {
    targetHeight = requestedPixelSize;
    targetWidth = Math.Max(1, (int)Math.Round((double)originalWidth * (double)targetHeight / (double)originalHeight));
  }
  else {
    targetWidth = requestedPixelSize;
    targetHeight = Math.Max(1, (int)Math.Round((double)originalHeight * (double)targetWidth / (double)originalWidth));
  }

  if (targetWidth == originalWidth && targetHeight == originalHeight) return false;

  string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
  Func<System.Windows.Media.Imaging.BitmapEncoder> createEncoder = null;
  if (extension == ".png") createEncoder = () => new System.Windows.Media.Imaging.PngBitmapEncoder();
  else if (extension == ".jpg" || extension == ".jpeg") createEncoder = () => new System.Windows.Media.Imaging.JpegBitmapEncoder();
  else if (extension == ".bmp") createEncoder = () => new System.Windows.Media.Imaging.BmpBitmapEncoder();
  else if (extension == ".tif" || extension == ".tiff") createEncoder = () => new System.Windows.Media.Imaging.TiffBitmapEncoder();
  else {
    warnings.Add("image_resize_unsupported_format:" + System.IO.Path.GetFileName(f));
    return false;
  }

  string tempFile = f + ".resize-tmp";
  try {
    var source = new System.Windows.Media.Imaging.BitmapImage();
    source.BeginInit();
    source.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
    source.CreateOptions = System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreImageCache;
    source.UriSource = new Uri(f, UriKind.Absolute);
    source.EndInit();
    source.Freeze();

    double scaleX = (double)targetWidth / (double)source.PixelWidth;
    double scaleY = (double)targetHeight / (double)source.PixelHeight;
    var resized = new System.Windows.Media.Imaging.TransformedBitmap(source, new System.Windows.Media.ScaleTransform(scaleX, scaleY));
    resized.Freeze();

    var encoder = createEncoder();
    encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(resized));
    using (var stream = new System.IO.FileStream(tempFile, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
      encoder.Save(stream);
    }
    System.IO.File.Delete(f);
    System.IO.File.Move(tempFile, f);
    return true;
  }
  catch (Exception ex) {
    try { if (System.IO.File.Exists(tempFile)) System.IO.File.Delete(tempFile); } catch {}
    warnings.Add("image_resize_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
    return false;
  }
};

Func<string, object[]> analyzeCoordinationImageQuality = (f) => {
  if (!cropToTargetHighlight || targetElements.Count == 0) {
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0, "none", 0.0, false };
  }

  string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
  Func<System.Windows.Media.Imaging.BitmapEncoder> createEncoder = null;
  if (extension == ".png") createEncoder = () => new System.Windows.Media.Imaging.PngBitmapEncoder();
  else if (extension == ".jpg" || extension == ".jpeg") createEncoder = () => new System.Windows.Media.Imaging.JpegBitmapEncoder();
  else if (extension == ".bmp") createEncoder = () => new System.Windows.Media.Imaging.BmpBitmapEncoder();
  else if (extension == ".tif" || extension == ".tiff") createEncoder = () => new System.Windows.Media.Imaging.TiffBitmapEncoder();
  else {
    warnings.Add("image_highlight_crop_unsupported_format:" + System.IO.Path.GetFileName(f));
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0, "none", 0.0, false };
  }

  string tempFile = f + ".crop-tmp";
  try {
    var source = new System.Windows.Media.Imaging.BitmapImage();
    source.BeginInit();
    source.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
    source.CreateOptions = System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreImageCache;
    source.UriSource = new Uri(f, UriKind.Absolute);
    source.EndInit();
    source.Freeze();

    var converted = new System.Windows.Media.Imaging.FormatConvertedBitmap(source, System.Windows.Media.PixelFormats.Bgra32, null, 0);
    converted.Freeze();
    int width = converted.PixelWidth;
    int height = converted.PixelHeight;
    int stride = width * 4;
    byte[] pixels = new byte[stride * height];
    converted.CopyPixels(pixels, stride, 0);

    int minX = width;
    int minY = height;
    int maxX = -1;
    int maxY = -1;
    int highlightCount = 0;
    for (int y = 0; y < height; y++) {
      int row = y * stride;
      for (int x = 0; x < width; x++) {
        int offset = row + (x * 4);
        int b = pixels[offset];
        int g = pixels[offset + 1];
        int r = pixels[offset + 2];
        bool isTargetGreen =
          (g >= 135 && g > r + 45 && g > b + 25 && r <= 150 && b <= 190) ||
          (g >= 105 && g > r + 25 && g > b + 10 && r <= 190 && b <= 220);
        bool isTargetYellow =
          (r >= 135 && g >= 110 && b <= 190 && r > b + 35 && g > b + 25);
        bool isTargetCyan =
          (g >= 115 && b >= 95 && r <= 180 && g > r + 20 && b > r + 10);
        int maxChannel = Math.Max(r, Math.Max(g, b));
        int minChannel = Math.Min(r, Math.Min(g, b));
        bool isTargetHighChroma =
          (maxChannel >= 140 && (maxChannel - minChannel) >= 80 && g >= 95 && r <= 245 && b <= 245);
        bool isTargetHighlight = isTargetGreen || isTargetYellow || isTargetCyan || isTargetHighChroma;
        if (!isTargetHighlight) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        highlightCount++;
      }
    }

    bool highlightPixelsDetected = highlightCount >= 8 && maxX >= minX && maxY >= minY;
    if (!highlightPixelsDetected) {
      if (String.Equals(targetVisualStyle, "raw", System.StringComparison.OrdinalIgnoreCase) ||
          String.Equals(targetVisualStyle, "outline_only", System.StringComparison.OrdinalIgnoreCase)) {
        notices.Add("target_highlight_pixels_not_detected_visual_style_expected:" + targetVisualStyle + ":" + System.IO.Path.GetFileName(f));
      }
      else {
        warnings.Add("target_highlight_pixels_not_detected:" + System.IO.Path.GetFileName(f));
      }
    }

    bool modelProjectionAvailable = targetCropEstimateAvailable && targetElements.Count == 1;
    bool allowPostProcessCrop = !modelCropBoxApplied;
    int cropX = 0;
    int cropY = 0;
    int cropWidth = width;
    int cropHeight = height;
    int estimatedMaxTargetDimension = 0;
    double estimatedTargetFillRatio = 0.0;
    string cropBasis = "none";

    if (modelProjectionAvailable && allowPostProcessCrop) {
      double safeFillRatio = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
      int minImageSide = Math.Max(1, Math.Min(width, height));
      estimatedMaxTargetDimension = Math.Max(8, (int)Math.Round(Math.Max(0.01, Math.Min(1.0, targetCropFillRatioEstimate)) * (double)minImageSide));
      int projectionDesiredSide = Math.Max(24, (int)Math.Ceiling((double)estimatedMaxTargetDimension / safeFillRatio));
      int contextGuardSide = Math.Max(24, (int)Math.Round((double)minImageSide * Math.Max(0.02, Math.Min(0.18, 0.04 / safeFillRatio))));
      int desiredSide = Math.Min(minImageSide, Math.Max(24, Math.Min(projectionDesiredSide, contextGuardSide)));
      cropWidth = Math.Min(width, desiredSide);
      cropHeight = Math.Min(height, desiredSide);
      if (enforcePixelSize && !allowFinalUpscale) {
        int minimumSourceCropSide = Math.Min(minImageSide, Math.Max(1, requestedPixelSize));
        if (cropWidth < minimumSourceCropSide || cropHeight < minimumSourceCropSide) {
          cropWidth = Math.Min(width, Math.Max(cropWidth, minimumSourceCropSide));
          cropHeight = Math.Min(height, Math.Max(cropHeight, minimumSourceCropSide));
          if (projectionDesiredSide < minimumSourceCropSide) {
            warnings.Add("target_fill_limited_by_source_resolution:" + System.IO.Path.GetFileName(f));
          }
        }
      }
      double centerX = Math.Max(0.0, Math.Min(1.0, targetCropCenterXRatio)) * (double)width;
      double centerY = Math.Max(0.0, Math.Min(1.0, targetCropCenterYRatio)) * (double)height;
      cropX = (int)Math.Round(centerX - ((double)cropWidth / 2.0));
      cropY = (int)Math.Round(centerY - ((double)cropHeight / 2.0));
      if (cropX < 0) cropX = 0;
      if (cropY < 0) cropY = 0;
      if (cropX + cropWidth > width) cropX = Math.Max(0, width - cropWidth);
      if (cropY + cropHeight > height) cropY = Math.Max(0, height - cropHeight);
      estimatedTargetFillRatio = (double)estimatedMaxTargetDimension / (double)Math.Max(cropWidth, cropHeight);
      cropBasis = "model_bbox_projection_post_crop";
    }
    else if (!modelProjectionAvailable && allowPostProcessCrop && highlightPixelsDetected) {
      int highlightWidth = Math.Max(1, maxX - minX + 1);
      int highlightHeight = Math.Max(1, maxY - minY + 1);
      int maxHighlightDimensionForCrop = Math.Max(highlightWidth, highlightHeight);
      double safeFillRatio = Math.Max(0.1, Math.Min(0.9, targetMinFillRatio));
      int ratioLimitedSide = Math.Max(maxHighlightDimensionForCrop, (int)Math.Ceiling((double)maxHighlightDimensionForCrop / safeFillRatio));
      int paddedSide = maxHighlightDimensionForCrop + (2 * Math.Max(0, highlightCropPaddingPx));
      int desiredSide = Math.Max(maxHighlightDimensionForCrop + 2, Math.Min(ratioLimitedSide, paddedSide));
      cropWidth = Math.Min(width, desiredSide);
      cropHeight = Math.Min(height, desiredSide);
      if (cropWidth < highlightWidth) cropWidth = Math.Min(width, highlightWidth);
      if (cropHeight < highlightHeight) cropHeight = Math.Min(height, highlightHeight);
      double centerX = ((double)minX + (double)maxX) / 2.0;
      double centerY = ((double)minY + (double)maxY) / 2.0;
      cropX = (int)Math.Round(centerX - ((double)cropWidth / 2.0));
      cropY = (int)Math.Round(centerY - ((double)cropHeight / 2.0));
      if (cropX < 0) cropX = 0;
      if (cropY < 0) cropY = 0;
      if (cropX + cropWidth > width) cropX = Math.Max(0, width - cropWidth);
      if (cropY + cropHeight > height) cropY = Math.Max(0, height - cropHeight);
      cropBasis = "highlight_pixels_post_crop_fallback";
    }
    else if (modelProjectionAvailable) {
      int fullImageHighlightDimension = 0;
      double fullImageHighlightFillRatio = 0.0;
      if (highlightPixelsDetected) {
        int highlightWidth = Math.Max(1, maxX - minX + 1);
        int highlightHeight = Math.Max(1, maxY - minY + 1);
        fullImageHighlightDimension = Math.Max(highlightWidth, highlightHeight);
        fullImageHighlightFillRatio = (double)fullImageHighlightDimension / (double)Math.Max(width, height);
      }
      return new object[] { false, width, height, 0, 0, width, height, 0, highlightCount, fullImageHighlightDimension, targetMinFillRatio, fullImageHighlightFillRatio, "model_bbox_projection", targetCropFillRatioEstimate, highlightPixelsDetected };
    }

    if (cropWidth <= 0 || cropHeight <= 0 ||
        (cropWidth >= width * 0.98 && cropHeight >= height * 0.98)) {
      int fullImageHighlightDimension = 0;
      double fullImageHighlightFillRatio = 0.0;
      if (highlightPixelsDetected) {
        int highlightWidth = Math.Max(1, maxX - minX + 1);
        int highlightHeight = Math.Max(1, maxY - minY + 1);
        fullImageHighlightDimension = Math.Max(highlightWidth, highlightHeight);
        fullImageHighlightFillRatio = (double)fullImageHighlightDimension / (double)Math.Max(width, height);
      }
      string nonRasterCropBasis = modelProjectionAvailable ? "model_bbox_projection" : "none";
      return new object[] { false, width, height, cropX, cropY, cropWidth, cropHeight, 0, highlightCount, fullImageHighlightDimension, targetMinFillRatio, fullImageHighlightFillRatio, nonRasterCropBasis, estimatedTargetFillRatio, highlightPixelsDetected };
    }

    int maxHighlightDimension = 0;
    double actualHighlightFillRatio = 0.0;
    if (highlightPixelsDetected) {
      int overlapMinX = Math.Max(minX, cropX);
      int overlapMinY = Math.Max(minY, cropY);
      int overlapMaxX = Math.Min(maxX, cropX + cropWidth - 1);
      int overlapMaxY = Math.Min(maxY, cropY + cropHeight - 1);
      if (overlapMaxX >= overlapMinX && overlapMaxY >= overlapMinY) {
        int overlapWidth = overlapMaxX - overlapMinX + 1;
        int overlapHeight = overlapMaxY - overlapMinY + 1;
        maxHighlightDimension = Math.Max(overlapWidth, overlapHeight);
        actualHighlightFillRatio = (double)maxHighlightDimension / (double)Math.Max(cropWidth, cropHeight);
        if (cropBasis.StartsWith("model_bbox_projection") && actualHighlightFillRatio < targetMinFillRatio) {
          warnings.Add("target_highlight_pixels_below_requested_fill:" + System.IO.Path.GetFileName(f));
        }
      }
      else {
        warnings.Add("target_highlight_pixels_outside_model_crop:" + System.IO.Path.GetFileName(f));
      }
    }

    var cropped = new System.Windows.Media.Imaging.CroppedBitmap(converted, new System.Windows.Int32Rect(cropX, cropY, cropWidth, cropHeight));
    cropped.Freeze();
    var encoder = createEncoder();
    encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(cropped));
    using (var stream = new System.IO.FileStream(tempFile, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
      encoder.Save(stream);
    }
    System.IO.File.Delete(f);
    System.IO.File.Move(tempFile, f);
    return new object[] { true, width, height, cropX, cropY, cropWidth, cropHeight, 0, highlightCount, maxHighlightDimension, targetMinFillRatio, actualHighlightFillRatio, cropBasis, estimatedTargetFillRatio, highlightPixelsDetected };
  }
  catch (Exception ex) {
    try { if (System.IO.File.Exists(tempFile)) System.IO.File.Delete(tempFile); } catch {}
    warnings.Add("image_coordination_quality_analysis_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
    return new object[] { false, 0, 0, 0, 0, 0, 0, 0, 0, 0, targetMinFillRatio, 0.0, "none", 0.0, false };
  }
};

Func<string, object> buildFileSummary = (f) => {
  int? width = null;
  int? height = null;
  bool resizedToRequestedPixelSize = false;
  bool croppedToTargetHighlight = false;
  int highlightPixelCount = 0;
  bool highlightPixelsDetected = false;
  double actualHighlightFillRatio = 0.0;
  double estimatedTargetFillRatio = 0.0;
  bool sourceCropUpscaledToFinal = false;
  bool postProcessedCropApplied = false;
  bool rasterPostCropApplied = false;
  string cropBasis = "none";
  object highlightCrop = null;
  try {
    object[] crop = analyzeCoordinationImageQuality(f);
    if (crop != null && crop.Length >= 12) {
      croppedToTargetHighlight = crop[0] is bool && (bool)crop[0];
      postProcessedCropApplied = croppedToTargetHighlight;
      highlightPixelCount = Convert.ToInt32(crop[8]);
      actualHighlightFillRatio = Convert.ToDouble(crop[11], System.Globalization.CultureInfo.InvariantCulture);
      if (crop.Length >= 13 && crop[12] != null) cropBasis = crop[12].ToString();
      rasterPostCropApplied = croppedToTargetHighlight && cropBasis.StartsWith("highlight_pixels");
      if (crop.Length >= 14 && crop[13] != null) estimatedTargetFillRatio = Convert.ToDouble(crop[13], System.Globalization.CultureInfo.InvariantCulture);
      if (crop.Length >= 15 && crop[14] != null) highlightPixelsDetected = Convert.ToBoolean(crop[14]);
      if (croppedToTargetHighlight) {
        int sourceCropWidth = Convert.ToInt32(crop[5]);
        int sourceCropHeight = Convert.ToInt32(crop[6]);
        int sourceFitDimension = String.Equals(requestedFitDirection, "vertical", System.StringComparison.OrdinalIgnoreCase)
          ? sourceCropHeight
          : sourceCropWidth;
        sourceCropUpscaledToFinal = enforcePixelSize && sourceFitDimension > 0 && sourceFitDimension < requestedPixelSize;
        if (sourceCropUpscaledToFinal) {
          warnings.Add("image_source_crop_below_final_pixel_size:" + System.IO.Path.GetFileName(f));
        }
        highlightCrop = new {
          originalWidth = Convert.ToInt32(crop[1]),
          originalHeight = Convert.ToInt32(crop[2]),
          x = Convert.ToInt32(crop[3]),
          y = Convert.ToInt32(crop[4]),
          width = sourceCropWidth,
          height = sourceCropHeight,
          maxHighlightDimension = Convert.ToInt32(crop[9]),
          targetMinFillRatio = Convert.ToDouble(crop[10], System.Globalization.CultureInfo.InvariantCulture),
          actualHighlightFillRatio = actualHighlightFillRatio,
          estimatedTargetFillRatio = estimatedTargetFillRatio,
          sourceCropUpscaledToFinal = sourceCropUpscaledToFinal,
          cropBasis = cropBasis
        };
      }
    }
    int[] size = readImageSize(f);
    resizedToRequestedPixelSize = resizeImageToRequestedPixelSize(f, size);
    if (resizedToRequestedPixelSize) size = readImageSize(f);
    if (size != null && size.Length == 2) {
      width = size[0];
      height = size[1];
    }
  }
  catch (Exception ex) {
    warnings.Add("image_dimension_probe_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
  }

  return new {
    path = f,
    fileName = System.IO.Path.GetFileName(f),
    bytes = new System.IO.FileInfo(f).Length,
    width = width,
    height = height,
    requestedPixelSize = requestedPixelSize,
    preExportPixelSize = revitExportPixelSize,
    requestedPreExportPixelSize = requestedPreExportPixelSize,
    autoPreExportPixelSize = autoPreExportPixelSize,
    preExportPixelSizeReason = preExportPixelSizeReason,
    resizedToRequestedPixelSize = resizedToRequestedPixelSize,
    sourceCropUpscaledToFinal = sourceCropUpscaledToFinal,
    croppedToTargetHighlight = croppedToTargetHighlight,
    postProcessedCropApplied = postProcessedCropApplied,
    rasterPostCropApplied = rasterPostCropApplied,
    croppedToModelProjection = cropBasis.StartsWith("model_bbox_projection"),
    highlightPixelCount = highlightPixelCount,
    highlightPixelsDetected = highlightPixelsDetected,
    targetMinFillRatio = targetMinFillRatio,
    actualHighlightFillRatio = actualHighlightFillRatio,
    estimatedTargetFillRatio = estimatedTargetFillRatio,
    cropBasis = cropBasis,
    highlightCrop = highlightCrop
  };
};

var files = System.IO.Directory.GetFiles(outputDir)
  .Select(f => System.IO.Path.GetFullPath(f))
  .Where(f => !before.Contains(f))
  .OrderBy(f => f)
  .Select(f => buildFileSummary(f))
  .ToList();

double effectiveMarginMm = targetElements.Count == 1 ? Math.Min(${_}, ${L}) : ${_};
int reviewViewIdForReport = reviewView.Id.IntegerValue;
string reviewViewNameForReport = reviewView.Name;
bool reviewViewSectionBoxActiveForReport = reviewView.IsSectionBoxActive;
bool cleanupAfterExportApplied = false;
bool cleanupDeletedCreatedView = false;
string cleanupNote = createdView
  ? "A reusable review view was created and kept for audit/reuse. Delete it manually only if this QA view is no longer needed."
  : "Existing reusable review view was updated and kept.";

if (cleanupAfterExport) {
  if (createdView) {
    try {
      document.Delete(reviewView.Id);
      document.Regenerate();
      cleanupAfterExportApplied = document.GetElement(new ElementId(reviewViewIdForReport)) == null;
      cleanupDeletedCreatedView = cleanupAfterExportApplied;
      cleanupNote = cleanupAfterExportApplied
        ? "The review view created by this export was deleted after the image file was produced."
        : "cleanupAfterExport was requested, but the created review view still appears to exist. Check warnings.";
      if (!cleanupAfterExportApplied) warnings.Add("coordination_cleanup_created_view_not_confirmed");
    }
    catch (Exception ex) {
      cleanupNote = "cleanupAfterExport was requested, but deleting the created review view failed.";
      warnings.Add("coordination_cleanup_created_view_failed:" + ex.Message);
    }
  }
  else {
    cleanupNote = "cleanupAfterExport was requested, but the review view already existed and was kept to avoid deleting operator-owned project data.";
    notices.Add("coordination_cleanup_skipped_existing_review_view");
  }
}

bool documentIsModifiedAtReturn = document.IsModified;
string modelStateNote = cleanupDeletedCreatedView
  ? "cleanupAfterExport deleted the review view created by this export, but Revit may still mark the document modified because temporary view data was created/deleted inside a transaction."
  : "The export can leave Revit view data modified because it creates, reuses, or updates a coordination review view. It never modifies physical MEP model elements.";

return new {
  success = files.Count > 0,
  guarded = false,
  state = files.Count > 0 ? "completed" : "failed",
  action = "export_revit_coordination_image",
  tool = "export_revit_coordination_image",
  revitWriteAction = cleanupDeletedCreatedView ? "temporary_review_view_export" : "review_view_only",
  intent = intent,
  targetVisualStyle = targetVisualStyle,
  targetOverrideApplied = targetOverrideApplied,
  targetOverrideMode = targetOverrideMode,
  targetOverrideResetCount = targetOverrideResetCount,
  view = new { id = reviewViewIdForReport, name = reviewViewNameForReport, created = createdView, sectionBoxActive = reviewViewSectionBoxActiveForReport, deletedAfterExport = cleanupDeletedCreatedView },
  createdViews = createdView
    ? new object[] { new { id = reviewViewIdForReport, name = reviewViewNameForReport, purpose = "coordination_image_review_view", deletedAfterExport = cleanupDeletedCreatedView } }
    : new object[] {},
  cleanup = new {
    cleanupAfterExportRequested = cleanupAfterExport,
    cleanupAfterExportApplied = cleanupAfterExportApplied,
    deletedCreatedView = cleanupDeletedCreatedView,
    documentMayRemainModified = true,
    documentIsModifiedAtReturn = documentIsModifiedAtReturn,
    note = cleanupNote
  },
  modelState = new {
    persistentPhysicalElementChanges = false,
    documentMayRemainModified = true,
    documentIsModifiedAtReturn = documentIsModifiedAtReturn,
    dirtyFlagNote = modelStateNote
  },
  framing = new {
    mode = framingMode,
    sectionBoxApplied = sectionBoxApplied,
    cameraFramedToTargets = cameraFramedToTargets,
    modelCropBoxApplied = modelCropBoxApplied,
    modelCropBoxTargetFillRatio = modelCropBoxTargetFillRatio,
    framingDistanceFeet = framingDistanceFeet
  },
  requestedElementCount = requestedElementIds.Count,
  foundElementCount = targetElements.Count,
  missingElementIds = missingIds,
  outputDir = outputDir,
  filePrefix = filePrefix,
  format = ${F(t.format||"png")},
  pixelSize = ${p},
  requestedPixelSize = ${p},
  preExportPixelSize = revitExportPixelSize,
  requestedPreExportPixelSize = requestedPreExportPixelSize,
  maxAutoPreExportPixelSize = maxAutoPreExportPixelSize,
  autoPreExportPixelSize = autoPreExportPixelSize,
  preExportPixelSizeReason = preExportPixelSizeReason,
  enforcePixelSize = enforcePixelSize,
  cropToTargetHighlight = cropToTargetHighlight,
  allowFinalUpscale = allowFinalUpscale,
  targetMinFillRatio = targetMinFillRatio,
  highlightCropPaddingPx = highlightCropPaddingPx,
  pixelSizeNote = enforcePixelSize
    ? "For coordination crops, Revit may export a higher-resolution source first, crop that source, then downsample to requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the final request, and preExportPixelSize is the Revit source export request. Check files[].width and files[].height for actual output dimensions.",
  marginMm = ${_},
  singleElementMarginMm = ${L},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${F(String(t.dpi||"300"))},
  fitDirection = ${F(t.fitDirection||"horizontal")},
  files = files,
  warnings = warnings,
  notices = notices
};`;try{let W=await ce(B,{...V(t,"Export Revit coordination image"),taskType:"export_revit_coordination_image",transactionMode:"auto"});return f(W?.result??W)}catch(W){return f(qe({action:"export_revit_coordination_image",error:W instanceof Error?W.message:String(W),extra:{tool:"export_revit_coordination_image"}}))}})}import Fd from"node:os";import rs from"node:path";import{z as ge}from"zod";var jd=ge.enum(["current_view","visible_region","set_of_views"]),Bd=ge.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),qd=ge.enum(["72","150","300","600"]),zd=ge.enum(["horizontal","vertical"]),Ud={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Wd={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Hd={horizontal:"Horizontal",vertical:"Vertical"};function Gd(){return rs.join(Fd.tmpdir(),"revAgent-image-export")}function Jd(e){return(e&&e.trim()?e.trim():`revit-view-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function $d(e){if(e==null||e==="")return"null";let t=Number(e);return Number.isFinite(t)?String(Math.trunc(t)):"null"}function os(e){e.tool("export_revit_view_image","[VISUAL_ARTIFACT_EXPORT] Export the active Revit view, DrawingSheet, Schedule view, or a selected view/sheet to PNG/JPEG/TIFF/BMP/TARGA using Document.ExportImage. Use this when the user asks for a raw image file, report/evidence screenshot, schedule/sheet export, or LLM visual artifact from an existing view. Ordinary view/sheet exports do not modify Revit. Direct schedule export creates a temporary sheet, exports it, and deletes that sheet before the wrapper transaction commits.",{...I(ge),viewId:ge.union([ge.number(),ge.string()]).optional().describe("Optional Revit view id. When supplied, export uses set_of_views because Revit cannot export a non-active visible region."),viewName:ge.string().optional().describe("Optional exact or partial view name. When supplied, export uses set_of_views unless range is explicitly current/visible."),exactName:ge.boolean().optional().default(!0),range:jd.optional().describe("current_view and visible_region use the active UI view. set_of_views can export viewId/viewName without switching the UI."),format:Bd.optional().default("png"),pixelSize:ge.number().int().min(200).max(1e4).optional().default(6e3),enforcePixelSize:ge.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),zoom:ge.number().int().min(1).max(1e3).optional().default(100),dpi:qd.optional().default("300"),fitDirection:zd.optional().default("horizontal"),outputDir:ge.string().optional(),filePrefix:ge.string().optional(),allowTemporaryScheduleSheet:ge.boolean().optional().default(!0).describe("When true, standalone Schedule views are exported through a temporary sheet that is deleted before the wrapper transaction commits. When false, schedule views return guidance with containing sheet candidates."),...N(ge),timeoutMs:ge.number().int().positive().optional()},async t=>{let n=t.viewId!==void 0||!!t.viewName,r=t.range??(n?"set_of_views":"current_view"),o=rs.resolve(t.outputDir||Gd()),a=Jd(t.filePrefix),i=Ud[t.format||"png"],s=Wd[String(t.dpi||"150")],l=Hd[t.fitDirection||"horizontal"],u=Math.trunc(t.pixelSize||6e3),m=t.enforcePixelSize!==!1,p=Math.trunc(t.zoom||100),g=t.allowTemporaryScheduleSheet!==!1,h=`
var warnings = new List<string>();
var notices = new List<string>();
string requestedRange = ${F(r)};
string outputDir = ${F(o)};
string filePrefix = ${F(a)};
string viewNameInput = ${F(t.viewName||"")};
int? viewIdInput = ${$d(t.viewId)};
bool exactName = ${t.exactName===!1?"false":"true"};
bool selectorProvided = viewIdInput.HasValue || !String.IsNullOrWhiteSpace(viewNameInput);
int requestedPixelSize = ${u};
string requestedFitDirection = ${F(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${m?"true":"false"};
bool allowTemporaryScheduleSheet = ${g?"true":"false"};

System.IO.Directory.CreateDirectory(outputDir);

Func<string, string> sanitize = (value) => {
  if (String.IsNullOrWhiteSpace(value)) return "revit-view-image";
  var invalid = System.IO.Path.GetInvalidFileNameChars();
  var chars = value.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray();
  return new string(chars);
};

View activeView = document.ActiveView;
View selectedView = activeView;
View sourceView = null;
View exportView = null;
bool scheduleExportUsedTemporarySheet = false;
bool temporaryScheduleSheetDeletedBeforeCommit = false;
object temporaryScheduleSheetReport = null;
var placedOnSheets = new List<object>();

if (requestedRange == "set_of_views" && viewIdInput.HasValue) {
  selectedView = document.GetElement(new ElementId(viewIdInput.Value)) as View;
}
else if (requestedRange == "set_of_views" && !String.IsNullOrWhiteSpace(viewNameInput)) {
  var views = new FilteredElementCollector(document)
    .OfClass(typeof(View))
    .Cast<View>()
    .Where(v => !v.IsTemplate)
    .Where(v => exactName
      ? String.Equals(v.Name, viewNameInput, System.StringComparison.OrdinalIgnoreCase)
      : v.Name.IndexOf(viewNameInput, System.StringComparison.OrdinalIgnoreCase) >= 0)
    .OrderBy(v => v.Name)
    .ToList();
  selectedView = views.FirstOrDefault();
  if (views.Count > 1) warnings.Add("view_name_matched_multiple_views:first_match_used");
}
else if (selectorProvided) {
  warnings.Add("view_selector_ignored_for_active_view_range:use_set_of_views_for_viewId_or_viewName");
}

if (selectedView == null) {
  return new { success = false, guarded = false, state = "failed", action = "export_revit_view_image", error = "view_not_found", viewId = viewIdInput, viewName = viewNameInput };
}
sourceView = selectedView;
exportView = selectedView;
if (selectedView is ViewSchedule) {
  var selectedSchedule = selectedView as ViewSchedule;
  try {
    var scheduleInstances = new FilteredElementCollector(document)
      .OfClass(typeof(ScheduleSheetInstance))
      .WhereElementIsNotElementType()
      .Cast<ScheduleSheetInstance>()
      .Where(instance => instance.ScheduleId.IntegerValue == selectedSchedule.Id.IntegerValue)
      .ToList();
    foreach (var instance in scheduleInstances) {
      var ownerSheet = document.GetElement(instance.OwnerViewId) as ViewSheet;
      placedOnSheets.Add(new {
        instanceId = instance.Id.IntegerValue,
        sheetId = ownerSheet != null ? (int?)ownerSheet.Id.IntegerValue : null,
        sheetName = ownerSheet != null ? ownerSheet.Name : "",
        sheetNumber = ownerSheet != null ? ownerSheet.SheetNumber : ""
      });
    }
  }
  catch (Exception ex) {
    warnings.Add("schedule_sheet_instance_lookup_failed:" + ex.Message);
  }
  if (!allowTemporaryScheduleSheet) {
    return new {
      success = false,
      guarded = true,
      state = "guarded",
      action = "export_revit_view_image",
      error = "unsupported_view_type_for_image_export",
      reason = "schedule_views_cannot_be_exported_directly_with_document_export_image_without_temporary_sheet",
      guidance = "Enable allowTemporaryScheduleSheet, or export a DrawingSheet that contains this schedule. Use get_active_view_context on the sheet to inspect scheduleSheetInstances before choosing the sheet.",
      viewId = selectedView.Id.IntegerValue,
      viewName = selectedView.Name,
      viewType = selectedView.ViewType.ToString(),
      placedOnSheets = placedOnSheets.ToArray(),
      warnings = warnings,
      notices = notices
    };
  }

  var existingNumbers = new HashSet<string>(
    new FilteredElementCollector(document)
      .OfClass(typeof(ViewSheet))
      .Cast<ViewSheet>()
      .Select(sheet => sheet.SheetNumber),
    System.StringComparer.OrdinalIgnoreCase);
  string baseSheetNumber = "REVAGENT-SCH-" + selectedSchedule.Id.IntegerValue.ToString();
  string temporarySheetNumber = baseSheetNumber;
  int suffix = 1;
  while (existingNumbers.Contains(temporarySheetNumber)) {
    temporarySheetNumber = baseSheetNumber + "-" + (suffix++).ToString();
  }

  ViewSheet temporarySheet = ViewSheet.Create(document, ElementId.InvalidElementId);
  temporarySheet.SheetNumber = temporarySheetNumber;
  temporarySheet.Name = "revAgent Temporary Schedule Export " + selectedSchedule.Id.IntegerValue.ToString();
  ScheduleSheetInstance temporaryScheduleInstance = ScheduleSheetInstance.Create(document, temporarySheet.Id, selectedSchedule.Id, new XYZ(0, 0, 0));
  document.Regenerate();

  exportView = temporarySheet;
  scheduleExportUsedTemporarySheet = true;
  temporaryScheduleSheetReport = new {
    sheetId = temporarySheet.Id.IntegerValue,
    sheetName = temporarySheet.Name,
    sheetNumber = temporarySheet.SheetNumber,
    scheduleInstanceId = temporaryScheduleInstance.Id.IntegerValue,
    deletedBeforeCommit = false
  };
  notices.Add("schedule_export_used_temporary_sheet");
}
if ((requestedRange == "current_view" || requestedRange == "visible_region") && activeView == null) {
  return new { success = false, guarded = false, state = "failed", action = "export_revit_view_image", error = "active_view_not_available" };
}

var before = new HashSet<string>(System.IO.Directory.GetFiles(outputDir).Select(f => System.IO.Path.GetFullPath(f)), System.StringComparer.OrdinalIgnoreCase);

var options = new ImageExportOptions();
options.FilePath = System.IO.Path.Combine(outputDir, sanitize(filePrefix));
options.HLRandWFViewsFileType = ImageFileType.${i};
options.ShadowViewsFileType = ImageFileType.${i};
options.ImageResolution = ImageResolution.${s};
options.PixelSize = ${u};
options.Zoom = ${p};
options.FitDirection = FitDirectionType.${l};
options.ShouldCreateWebSite = false;

if (scheduleExportUsedTemporarySheet) {
  options.ExportRange = ExportRange.SetOfViews;
  options.ZoomType = ZoomFitType.FitToPage;
  var ids = new List<ElementId> { exportView.Id };
  options.SetViewsAndSheets(ids);
}
else if (requestedRange == "visible_region") {
  options.ExportRange = ExportRange.VisibleRegionOfCurrentView;
  options.ZoomType = ZoomFitType.Zoom;
}
else if (requestedRange == "set_of_views") {
  options.ExportRange = ExportRange.SetOfViews;
  options.ZoomType = ZoomFitType.FitToPage;
  var ids = new List<ElementId> { exportView.Id };
  options.SetViewsAndSheets(ids);
}
else {
  options.ExportRange = ExportRange.CurrentView;
  options.ZoomType = ZoomFitType.FitToPage;
}

document.ExportImage(options);

if (scheduleExportUsedTemporarySheet && exportView != null) {
  int tempSheetIdForReport = exportView.Id.IntegerValue;
  string tempSheetNameForReport = exportView.Name;
  string tempSheetNumberForReport = (exportView as ViewSheet) != null ? (exportView as ViewSheet).SheetNumber : "";
  int? tempScheduleInstanceIdForReport = null;
  try {
    var tempScheduleInstance = new FilteredElementCollector(document, exportView.Id)
      .OfClass(typeof(ScheduleSheetInstance))
      .WhereElementIsNotElementType()
      .Cast<ScheduleSheetInstance>()
      .FirstOrDefault();
    if (tempScheduleInstance != null) tempScheduleInstanceIdForReport = tempScheduleInstance.Id.IntegerValue;
  }
  catch {}
  try {
    document.Delete(exportView.Id);
    document.Regenerate();
    temporaryScheduleSheetDeletedBeforeCommit = document.GetElement(new ElementId(tempSheetIdForReport)) == null;
    temporaryScheduleSheetReport = new {
      sheetId = tempSheetIdForReport,
      sheetName = tempSheetNameForReport,
      sheetNumber = tempSheetNumberForReport,
      scheduleInstanceId = tempScheduleInstanceIdForReport,
      deletedBeforeCommit = temporaryScheduleSheetDeletedBeforeCommit
    };
  }
  catch (Exception ex) {
    warnings.Add("temporary_schedule_sheet_cleanup_failed:" + ex.Message);
    temporaryScheduleSheetReport = new {
      sheetId = tempSheetIdForReport,
      sheetName = tempSheetNameForReport,
      sheetNumber = tempSheetNumberForReport,
      scheduleInstanceId = tempScheduleInstanceIdForReport,
      deletedBeforeCommit = false
    };
  }
}

Func<byte[], int, int> readInt32BigEndian = (bytes, offset) =>
  (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
Func<byte[], int, int> readInt16BigEndian = (bytes, offset) =>
  (bytes[offset] << 8) | bytes[offset + 1];
Func<byte[], int, int> readInt16LittleEndian = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8);
Func<byte[], int, int> readInt32LittleEndian = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
Func<string, int[]> readImageSize = (f) => {
  byte[] bytes = System.IO.File.ReadAllBytes(f);
  if (bytes.Length >= 24 &&
      bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) {
    return new int[] { readInt32BigEndian(bytes, 16), readInt32BigEndian(bytes, 20) };
  }
  if (bytes.Length >= 26 && bytes[0] == 0x42 && bytes[1] == 0x4D) {
    return new int[] { readInt32LittleEndian(bytes, 18), Math.Abs(readInt32LittleEndian(bytes, 22)) };
  }
  if (bytes.Length >= 18) {
    string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
    if (extension == ".tga" || extension == ".targa") {
      int tgaWidth = readInt16LittleEndian(bytes, 12);
      int tgaHeight = readInt16LittleEndian(bytes, 14);
      if (tgaWidth > 0 && tgaHeight > 0) return new int[] { tgaWidth, tgaHeight };
    }
  }
  if (bytes.Length >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8) {
    int offset = 2;
    while (offset + 9 < bytes.Length) {
      if (bytes[offset] != 0xFF) { offset++; continue; }
      byte marker = bytes[offset + 1];
      if (marker == 0xD8 || marker == 0xD9) { offset += 2; continue; }
      int segmentLength = readInt16BigEndian(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.Length) break;
      bool isSof = (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC);
      if (isSof && offset + 8 < bytes.Length) {
        return new int[] { readInt16BigEndian(bytes, offset + 7), readInt16BigEndian(bytes, offset + 5) };
      }
      offset += 2 + segmentLength;
    }
  }
  if (bytes.Length >= 16 &&
      ((bytes[0] == 0x49 && bytes[1] == 0x49) || (bytes[0] == 0x4D && bytes[1] == 0x4D))) {
    bool little = bytes[0] == 0x49;
    Func<int, int> read16 = (offset) => little ? readInt16LittleEndian(bytes, offset) : readInt16BigEndian(bytes, offset);
    Func<int, int> read32 = (offset) => little ? readInt32LittleEndian(bytes, offset) : readInt32BigEndian(bytes, offset);
    int ifdOffset = read32(4);
    if (ifdOffset > 0 && ifdOffset + 2 < bytes.Length) {
      int entries = read16(ifdOffset);
      int width = 0;
      int height = 0;
      for (int i = 0; i < entries; i++) {
        int entryOffset = ifdOffset + 2 + (i * 12);
        if (entryOffset + 12 > bytes.Length) break;
        int tag = read16(entryOffset);
        int value = read32(entryOffset + 8);
        if (tag == 256) width = value;
        if (tag == 257) height = value;
      }
      if (width > 0 && height > 0) return new int[] { width, height };
    }
  }
  return null;
};

Func<string, int[], bool> resizeImageToRequestedPixelSize = (f, size) => {
  if (!enforcePixelSize || requestedPixelSize <= 0 || size == null || size.Length != 2) return false;
  int originalWidth = size[0];
  int originalHeight = size[1];
  if (originalWidth <= 0 || originalHeight <= 0) return false;

  int targetWidth = originalWidth;
  int targetHeight = originalHeight;
  if (String.Equals(requestedFitDirection, "vertical", System.StringComparison.OrdinalIgnoreCase)) {
    targetHeight = requestedPixelSize;
    targetWidth = Math.Max(1, (int)Math.Round((double)originalWidth * (double)targetHeight / (double)originalHeight));
  }
  else {
    targetWidth = requestedPixelSize;
    targetHeight = Math.Max(1, (int)Math.Round((double)originalHeight * (double)targetWidth / (double)originalWidth));
  }

  if (targetWidth == originalWidth && targetHeight == originalHeight) return false;

  string extension = System.IO.Path.GetExtension(f).ToLowerInvariant();
  Func<System.Windows.Media.Imaging.BitmapEncoder> createEncoder = null;
  if (extension == ".png") createEncoder = () => new System.Windows.Media.Imaging.PngBitmapEncoder();
  else if (extension == ".jpg" || extension == ".jpeg") createEncoder = () => new System.Windows.Media.Imaging.JpegBitmapEncoder();
  else if (extension == ".bmp") createEncoder = () => new System.Windows.Media.Imaging.BmpBitmapEncoder();
  else if (extension == ".tif" || extension == ".tiff") createEncoder = () => new System.Windows.Media.Imaging.TiffBitmapEncoder();
  else {
    warnings.Add("image_resize_unsupported_format:" + System.IO.Path.GetFileName(f));
    return false;
  }

  string tempFile = f + ".resize-tmp";
  try {
    var source = new System.Windows.Media.Imaging.BitmapImage();
    source.BeginInit();
    source.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
    source.UriSource = new Uri(f, UriKind.Absolute);
    source.EndInit();
    source.Freeze();

    double scaleX = (double)targetWidth / (double)source.PixelWidth;
    double scaleY = (double)targetHeight / (double)source.PixelHeight;
    var resized = new System.Windows.Media.Imaging.TransformedBitmap(source, new System.Windows.Media.ScaleTransform(scaleX, scaleY));
    resized.Freeze();

    var encoder = createEncoder();
    encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(resized));
    using (var stream = new System.IO.FileStream(tempFile, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
      encoder.Save(stream);
    }
    System.IO.File.Delete(f);
    System.IO.File.Move(tempFile, f);
    return true;
  }
  catch (Exception ex) {
    try { if (System.IO.File.Exists(tempFile)) System.IO.File.Delete(tempFile); } catch {}
    warnings.Add("image_resize_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
    return false;
  }
};

Func<string, object> buildFileSummary = (f) => {
  int? width = null;
  int? height = null;
  bool resizedToRequestedPixelSize = false;
  bool finalPixelSizeMatchesRequest = false;
  try {
    int[] size = readImageSize(f);
    resizedToRequestedPixelSize = resizeImageToRequestedPixelSize(f, size);
    if (resizedToRequestedPixelSize) size = readImageSize(f);
    if (size != null && size.Length == 2) {
      width = size[0];
      height = size[1];
      int finalFitDirectionPixels = String.Equals(requestedFitDirection, "vertical", System.StringComparison.OrdinalIgnoreCase)
        ? height.Value
        : width.Value;
      finalPixelSizeMatchesRequest = requestedPixelSize > 0 && finalFitDirectionPixels == requestedPixelSize;
    }
  }
  catch (Exception ex) {
    warnings.Add("image_dimension_probe_failed:" + System.IO.Path.GetFileName(f) + ":" + ex.Message);
  }

  return new {
    path = f,
    fileName = System.IO.Path.GetFileName(f),
    bytes = new System.IO.FileInfo(f).Length,
    width = width,
    height = height,
    requestedPixelSize = requestedPixelSize,
    resizedToRequestedPixelSize = resizedToRequestedPixelSize,
    finalPixelSizeMatchesRequest = finalPixelSizeMatchesRequest
  };
};

var files = System.IO.Directory.GetFiles(outputDir)
  .Select(f => System.IO.Path.GetFullPath(f))
  .Where(f => !before.Contains(f))
  .OrderBy(f => f)
  .Select(f => buildFileSummary(f))
  .ToList();

return new {
  success = files.Count > 0,
  guarded = false,
  state = files.Count > 0 ? "completed" : "failed",
  action = "export_revit_view_image",
  tool = "export_revit_view_image",
  revitWriteAction = scheduleExportUsedTemporarySheet ? "temporary_schedule_sheet_export" : "none",
  exportRange = scheduleExportUsedTemporarySheet ? "set_of_views" : requestedRange,
  format = ${F(t.format||"png")},
  pixelSize = ${u},
  requestedPixelSize = ${u},
  enforcePixelSize = enforcePixelSize,
  pixelSizeNote = enforcePixelSize
    ? "PNG/JPEG/BMP/TIFF output is post-processed so the requested fit-direction dimension equals requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the Revit export request. Check files[].width and files[].height for actual output dimensions.",
  dpi = ${F(String(t.dpi||"300"))},
  fitDirection = ${F(t.fitDirection||"horizontal")},
  view = new {
    id = scheduleExportUsedTemporarySheet ? sourceView.Id.IntegerValue : selectedView.Id.IntegerValue,
    name = scheduleExportUsedTemporarySheet ? sourceView.Name : selectedView.Name,
    type = scheduleExportUsedTemporarySheet ? sourceView.ViewType.ToString() : selectedView.ViewType.ToString()
  },
  sourceView = sourceView == null ? null : new { id = sourceView.Id.IntegerValue, name = sourceView.Name, type = sourceView.ViewType.ToString() },
  activeView = activeView == null ? null : new { id = activeView.Id.IntegerValue, name = activeView.Name, type = activeView.ViewType.ToString() },
  scheduleExport = scheduleExportUsedTemporarySheet
    ? new {
        mode = "temporary_sheet",
        temporarySheet = temporaryScheduleSheetReport,
        temporaryScheduleSheetDeletedBeforeCommit = temporaryScheduleSheetDeletedBeforeCommit,
        placedOnSheets = placedOnSheets.ToArray(),
        note = temporaryScheduleSheetDeletedBeforeCommit
          ? "The Schedule view was exported through a temporary sheet that was deleted before the wrapper transaction committed."
          : "The Schedule view was exported through a temporary sheet, but cleanup did not fully confirm deletion. Check warnings."
      }
    : null,
  outputDir = outputDir,
  filePrefix = filePrefix,
  files = files,
  warnings = warnings,
  notices = notices
};`;try{let w=await ce(h,{...V(t,"Export Revit view image"),taskType:"export_revit_view_image",transactionMode:g?"auto":"none"});return f(w?.result??w)}catch(w){return f(qe({action:"export_revit_view_image",error:w instanceof Error?w.message:String(w),extra:{tool:"export_revit_view_image"}}))}})}import{z as Q}from"zod";var Xd=Q.union([Q.number().int().positive(),Q.string().regex(/^\d+$/)]);function Uo(e){return e&&e.result?e.result:e}function Wo(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function Kd(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Yd(e,t){return`3D - Focus ${t&&(t.FamilyName||t.TypeName||t.Name)?String(t.FamilyName||t.TypeName||t.Name):"Element"} ${e}`.replace(/[{}[\];<>?`~]/g,"").slice(0,90)}function Qd(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),MatchScore:d(e,"MatchScore","matchScore"),MatchConfidence:d(e,"MatchConfidence","matchConfidence")}}function Wn(e){return!e||typeof e!="object"?e:{Id:e.Id??e.id,Name:e.Name??e.name,ViewType:e.ViewType??e.viewType,Scale:e.Scale??e.scale}}function Zd(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Count:d(e,"Count","count"),Truncated:d(e,"Truncated","truncated"),Ambiguous:d(e,"Ambiguous","ambiguous"),TopScore:d(e,"TopScore","topScore"),TopConfidence:d(e,"TopConfidence","topConfidence"),TopScoreTiedCount:d(e,"TopScoreTiedCount","topScoreTiedCount"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),SelectionHint:d(e,"SelectionHint","selectionHint")}}function em(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),PlanMode:d(e,"PlanMode","planMode"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),SelectedPlan:Wn(d(e,"SelectedPlan","selectedPlan")),TargetView:Wn(d(e,"TargetView","targetView")),ActiveView:Wn(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function tm(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),TargetView:Wn(d(e,"TargetView","targetView")),ActiveView:Wn(d(e,"ActiveView","activeView")),CreatedView:d(e,"CreatedView","createdView"),ReusedView:d(e,"ReusedView","reusedView"),SectionBoxApplied:d(e,"SectionBoxApplied","sectionBoxApplied"),SectionBoxState:d(e,"SectionBoxState","sectionBoxState"),CameraOrientation:d(e,"CameraOrientation","cameraOrientation"),CameraApplied:d(e,"CameraApplied","cameraApplied"),CameraWarning:d(e,"CameraWarning","cameraWarning"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed")}}function nm(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function gt(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"show_element_in_plan_and_3d",message:e.message,error:e.error,resultContractVersion:nm(e.find,e.plan,e.threeD),chosenElementId:e.chosenElementId,chosenElement:e.chosenElement,find:e.find,plan:e.plan,threeD:e.threeD,ambiguous:e.ambiguous,candidates:e.candidates}}function as(e){e.tool("show_element_in_plan_and_3d","[LIVE_VIEW_WORKFLOW_WRAPPER] Safely find or use one Revit element, show it in an existing plan, then optionally call create_3d_view_for_elements to create/reuse a focused 3D view. Use this when the user wants a combined plan plus 3D live Revit view workflow. Ambiguous search results are rejected by default for large-project safety.",{...I(Q),...N(Q),elementId:Xd.optional().describe("Known ElementId. When supplied, search is skipped."),query:Q.string().optional().describe("Text query used when elementId is not supplied."),categoryNames:Q.array(Q.string()).optional().describe("Category name filters for the search, e.g. Mechanical Equipment."),searchLimit:Q.number().int().positive().max(200).optional().describe("Maximum search candidates to inspect. Defaults 20."),allowAmbiguous:Q.boolean().optional().describe("Allow the top search result to be used even when multiple plausible matches exist. Defaults false."),planMode:Q.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing same-level plan. activePlan keeps the current active plan. Defaults elementLevel."),planNameContains:Q.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:Q.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),includeSearchPlanCandidates:Q.boolean().optional().describe("Include plan candidates during the initial search. Defaults false; the plan-open step computes focused candidates separately."),verboseCandidates:Q.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:Q.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:Q.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),select:Q.boolean().optional().describe("Select the element in plan/3D. Defaults true."),zoom:Q.boolean().optional().describe("Show/zoom the element in plan/3D. Defaults true."),fitToScreen:Q.boolean().optional().describe("Run Revit UI ZoomToFit after focusing views. Defaults false."),create3d:Q.boolean().optional().describe("Create or reuse a focused 3D view after the plan step. Defaults true."),viewName:Q.string().optional().describe("Desired 3D view name. If omitted, one is generated from the selected element."),reuseExisting3d:Q.boolean().optional().describe("Reuse an existing 3D view with the same name. Defaults true."),sectionBox:Q.boolean().optional().describe("Apply a 3D section box around the element. Defaults false."),paddingMm:Q.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:Q.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction. Defaults unchanged."),framingPaddingMm:Q.number().min(0).max(1e5).optional().describe("Padding in millimeters for camera orientation/framing. Defaults to paddingMm or 500."),timeoutMs:Q.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=V(t,"Show element in plan and 3D"),r=t.elementId,o=null,a=null;if(!r){if(!t.query&&(!t.categoryNames||t.categoryNames.length===0))return f(gt({success:!1,guarded:!0,error:"Pass elementId, or pass query/categoryNames for a safe search."}));if(a=Uo(await D("find_elements",{query:t.query,categoryNames:t.categoryNames,includePlanCandidates:t.includeSearchPlanCandidates===!0,maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.searchLimit||20,timeoutMs:t.timeoutMs,taskName:"Find element for plan and 3D presentation"},n)),!a||!Wo(a))return f(gt({success:!1,error:d(a,"Error","error")||"Element search failed.",find:a}));let m=Array.isArray(d(a,"Elements","elements"))?d(a,"Elements","elements"):[];if(m.length===0)return f(gt({success:!1,guarded:!0,error:"No matching elements were found.",find:a}));if(d(a,"Ambiguous","ambiguous")&&t.allowAmbiguous!==!0)return f(gt({success:!1,guarded:!0,error:"Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",ambiguous:!0,find:a,candidates:m}));if(o=m[0]||null,!o)return f(gt({success:!1,guarded:!0,error:"No usable element candidate was returned.",find:a}));r=d(o,"Id","id")}if(r==null)return f(gt({success:!1,guarded:!0,error:"No element id was resolved.",find:a}));let i=Uo(await D("open_existing_plan_for_element_level",{elementId:r,planMode:t.planMode,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3,responseMode:"full",timeoutMs:t.timeoutMs,taskName:"Show element in existing plan"},n));if(!i||!Wo(i))return f(gt({success:!1,guarded:Kd(i),error:d(i,"Error","error")||"Plan presentation failed.",chosenElementId:r,chosenElement:o,find:a,plan:i}));let s=null;t.create3d!==!1&&(s=Uo(await D("create_3d_view_for_elements",{elementIds:[r],viewName:t.viewName||Yd(r,o),reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Show element in focused 3D view"},n)));let l=t.create3d===!1||Wo(s),u=qt(gt({success:l,message:t.create3d===!1?"Element was shown in an existing plan.":l?"Element was shown in an existing plan and focused in 3D.":"Element was shown in plan, but the 3D step failed.",chosenElementId:r,chosenElement:o,find:a,plan:i,threeD:s}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"||!l?f(u):f({success:d(u,"Success","success"),guarded:d(u,"Guarded","guarded")===!0,state:d(u,"State","state"),action:d(u,"Action","action"),message:d(u,"Message","message"),error:d(u,"Error","error"),resultContractVersion:d(u,"ResultContractVersion","resultContractVersion"),responseMode:"compact",chosenElementId:r,chosenElement:Qd(o),findSummary:Zd(a),planSummary:em(i),threeDSummary:tm(s)})}catch(n){return f(gt({success:!1,error:n instanceof Error?n.message:String(n)}))}})}import{z as Z}from"zod";var rm=Z.union([Z.number().int().positive(),Z.string().regex(/^\d+$/)]);function Lr(e){return e&&e.result?e.result:e}function Vr(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function is(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Dr(e){return!e||typeof e!="object"?e||null:{id:e.Id??e.id,name:e.Name??e.name,viewType:e.ViewType??e.viewType,isActive:e.IsActive??e.isActive,isOpen:e.IsOpen??e.isOpen,isSectionBoxActive:e.IsSectionBoxActive??e.isSectionBoxActive}}function Ho(e){if(!e||typeof e!="object")return e||null;let t=e.PlanCandidates??e.planCandidates;return{success:d(e,"Success","success"),message:d(e,"Message","message"),error:d(e,"Error","error"),focusBlocked:e.FocusBlocked??e.focusBlocked,focusBlockReason:e.FocusBlockReason??e.focusBlockReason,focusSuggestion:e.FocusSuggestion??e.focusSuggestion,changed:e.Changed??e.changed,selected:e.Selected??e.selected,zoomed:e.Zoomed??e.zoomed,activeViewChanged:e.ActiveViewChanged??e.activeViewChanged,planOpenMode:e.PlanOpenMode??e.planOpenMode,levelName:e.LevelName??e.levelName,activeView:Dr(e.ActiveView??e.activeView),targetView:Dr(e.TargetView??e.targetView),selectedPlan:Dr(e.SelectedPlan??e.selectedPlan),suggestedView:Dr(e.SuggestedView??e.suggestedView),planCandidatesTotal:Array.isArray(t)?t.length:e.PlanCandidatesTotal??e.planCandidatesTotal,planCandidatesTruncated:e.PlanCandidatesTruncated??e.planCandidatesTruncated,createdView:e.CreatedView??e.createdView,reusedView:e.ReusedView??e.reusedView,sectionBoxApplied:e.SectionBoxApplied??e.sectionBoxApplied,cameraOrientation:e.CameraOrientation??e.cameraOrientation,cameraApplied:e.CameraApplied??e.cameraApplied}}function ss(e){return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded")===!0,state:d(e,"State","state"),action:d(e,"Action","action"),message:d(e,"Message","message"),error:d(e,"Error","error"),resultContractVersion:d(e,"ResultContractVersion","resultContractVersion"),responseMode:"compact",mode:e.mode??e.Mode,usedStep:e.usedStep??e.UsedStep,focusSummary:Ho(e.focus??e.Focus),planSummary:Ho(e.plan??e.Plan),threeDSummary:Ho(e.threeD??e.ThreeD)}}function om(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function Hn(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"smart_focus_elements",message:e.message,error:e.error,resultContractVersion:om(e.focus,e.plan,e.threeD),mode:e.mode,usedStep:e.usedStep,focus:e.focus,plan:e.plan,threeD:e.threeD}}function ls(e){e.tool("smart_focus_elements","[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. When create3d=true, the 3D step runs after whichever live focus step succeeds. Use this for live Revit focus/navigation, not image artifact export.",{...I(Z),...N(Z),elementIds:Z.array(rm).min(1).describe("ElementId values to select and show."),mode:Z.enum(["activeOnly","activeThenElementLevelPlan","elementLevelPlan"]).optional().describe("activeOnly only tries the active/requested view. activeThenElementLevelPlan falls back to an existing same-level plan. elementLevelPlan skips the active view and opens the same-level plan. Defaults activeThenElementLevelPlan."),viewId:Z.number().int().positive().optional().describe("Optional target view id for the first focus attempt."),viewName:Z.string().optional().describe("Optional target view name for the first focus attempt."),viewType:Z.string().optional().describe("Optional Revit ViewType filter for the first focus attempt."),exactName:Z.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),planNameContains:Z.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level for same-level fallback."),preferMechanical:Z.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:Z.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:Z.boolean().optional().describe("Zoom/show the supplied elements. Defaults true."),fitToScreen:Z.boolean().optional().describe("Run Revit UI ZoomToFit after focus. Defaults false."),create3d:Z.boolean().optional().describe("After the successful active/requested-view or plan focus step, create/reuse a focused 3D view for all supplied elements. Defaults false."),viewName3d:Z.string().optional().describe("Desired 3D view name when create3d=true."),reuseExisting3d:Z.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),sectionBox:Z.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),cameraOrientation:Z.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),framingPaddingMm:Z.number().min(0).max(1e5).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),paddingMm:Z.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),allowPartial:Z.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),verboseCandidates:Z.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:Z.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:Z.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),timeoutMs:Z.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=V(t,"Smart focus Revit elements"),r=t.mode||"activeThenElementLevelPlan",o=null,a=null,i=null;if(r!=="elementLevelPlan"){if(o=Lr(await D("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:!1,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Try focus elements in active/requested view"},n)),o&&Vr(o)){t.create3d===!0&&(i=Lr(await D("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view after active/requested focus"},n)));let m=t.create3d===!0?!!(i&&Vr(i)):!0,p=qt(Hn({success:m,message:t.create3d===!0?m?"Elements were focused in the active/requested view and focused in 3D.":"Elements were focused in the active/requested view, but the 3D step failed.":"Elements were focused in the active/requested view.",mode:r,usedStep:t.create3d===!0?"activeOrRequestedViewThen3D":"activeOrRequestedView",focus:o,threeD:i}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return f(t.responseMode==="full"||!m?p:ss(p))}let u=is(o);if(r==="activeOnly"||!o||!u)return f(Hn({success:!1,guarded:u,mode:r,error:d(o,"Error","error")||"Active/requested view focus failed.",focus:o}))}if(a=Lr(await D("open_existing_plan_for_element_level",{elementId:t.elementIds[0],planMode:"elementLevel",planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Smart focus fallback to same-level existing plan"},n)),!a||!Vr(a))return f(Hn({success:!1,guarded:is(a),mode:r,error:d(a,"Error","error")||"Same-level existing plan focus failed.",focus:o,plan:a}));t.create3d===!0&&(i=Lr(await D("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view"},n)));let s=t.create3d===!0?!!(i&&Vr(i)):!0,l=qt(Hn({success:s,message:t.create3d===!0?s?"Elements were focused in a same-level plan and focused in 3D.":"Elements were focused in a same-level plan, but the 3D step failed.":"Elements were focused in a same-level plan.",mode:r,usedStep:t.create3d===!0?"elementLevelPlanThen3D":"elementLevelPlan",focus:o,plan:a,threeD:i}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return f(t.responseMode==="full"||!s?l:ss(l))}catch(n){return f(Hn({success:!1,mode:t.mode||"unknown",error:n instanceof Error?n.message:String(n)}))}})}import{z as Le}from"zod";async function am(e,t){let r=(Array.isArray(e.elementIds)?e.elementIds:[]).map(o=>Number.parseInt(String(o),10)).filter(o=>Number.isFinite(o)&&o>0);return e.useSelection&&(r=r.concat(await ln(e.limit||20,t))),[...new Set(r)].slice(0,e.limit||20)}function im(e,t){let n=Ar(e),r=t.includeParameters!==!1?"true":"false",o=t.includeTypeParameters===!0?"true":"false",a=t.includeConnectors!==!1?"true":"false",i=Ke(t.parameterNames||[]);return`
int[] elementIds = ${n};
bool includeParameters = ${r};
bool includeTypeParameters = ${o};
bool includeConnectors = ${a};
string[] requestedParameterNames = ${i};

System.Collections.Generic.List<string> DefaultParameterNames()
{
    System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
    names.Add("System Name");
    names.Add("System Type");
    names.Add("System Classification");
    names.Add("Size");
    names.Add("Length");
    names.Add("Diameter");
    names.Add("Width");
    names.Add("Height");
    names.Add("Flow");
    names.Add("Mark");
    names.Add("Comments");
    return names;
}

string RawValue(Parameter p)
{
    if (p == null || !p.HasValue) return "";
    try
    {
        if (p.StorageType == StorageType.String) return p.AsString();
        if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.Double) return p.AsDouble().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.ElementId) return p.AsElementId().IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    catch {}
    return "";
}

object ParameterSummary(Parameter p, string source)
{
    if (p == null) return null;
    string valueString = "";
    try { valueString = p.AsValueString(); } catch {}
    return new {
        source = source,
        name = p.Definition != null ? p.Definition.Name : "",
        storageType = p.StorageType.ToString(),
        hasValue = p.HasValue,
        isReadOnly = p.IsReadOnly,
        raw = RawValue(p),
        valueString = valueString
    };
}

string LevelName(Element elem)
{
    try
    {
        Autodesk.Revit.DB.Mechanical.Duct duct = elem as Autodesk.Revit.DB.Mechanical.Duct;
        if (duct != null && duct.ReferenceLevel != null) return duct.ReferenceLevel.Name;
        Autodesk.Revit.DB.Plumbing.Pipe pipe = elem as Autodesk.Revit.DB.Plumbing.Pipe;
        if (pipe != null && pipe.ReferenceLevel != null) return pipe.ReferenceLevel.Name;
        FamilyInstance fi = elem as FamilyInstance;
        if (fi != null && fi.LevelId != null && fi.LevelId != ElementId.InvalidElementId)
        {
            Element level = document.GetElement(fi.LevelId);
            if (level != null) return level.Name;
        }
        Parameter levelP = elem.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
        if (levelP != null && levelP.HasValue)
        {
            Element level = document.GetElement(levelP.AsElementId());
            if (level != null) return level.Name;
            string text = levelP.AsValueString();
            if (!string.IsNullOrEmpty(text)) return text;
        }
    }
    catch {}
    return "N/A";
}

ConnectorSet ConnectorSetFor(Element elem)
{
    Autodesk.Revit.DB.MEPCurve curve = elem as Autodesk.Revit.DB.MEPCurve;
    if (curve != null && curve.ConnectorManager != null) return curve.ConnectorManager.Connectors;
    FamilyInstance fi = elem as FamilyInstance;
    if (fi != null && fi.MEPModel != null && fi.MEPModel.ConnectorManager != null)
        return fi.MEPModel.ConnectorManager.Connectors;
    return null;
}

try
{
    System.Collections.Generic.List<object> elements = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<string> names = requestedParameterNames.Length > 0
        ? new System.Collections.Generic.List<string>(requestedParameterNames)
        : DefaultParameterNames();

    foreach (int id in elementIds)
    {
        Element elem = document.GetElement(new ElementId(id));
        if (elem == null)
        {
            warnings.Add("Element not found: " + id.ToString());
            continue;
        }

        string categoryName = elem.Category != null ? elem.Category.Name : "";
        string categoryId = elem.Category != null ? elem.Category.Id.IntegerValue.ToString() : "";
        string familyName = "";
        string typeName = "";
        Element typeElem = document.GetElement(elem.GetTypeId());
        if (typeElem != null) typeName = typeElem.Name;
        FamilyInstance fi = elem as FamilyInstance;
        if (fi != null && fi.Symbol != null)
        {
            typeName = fi.Symbol.Name;
            if (fi.Symbol.Family != null) familyName = fi.Symbol.Family.Name;
        }

        int? connectorCount = null;
        int? openConnectorCount = null;
        if (includeConnectors)
        {
            int countedConnectors = 0;
            int countedOpenConnectors = 0;
            ConnectorSet connectors = ConnectorSetFor(elem);
            if (connectors != null)
            {
                foreach (Connector c in connectors)
                {
                    countedConnectors++;
                    if (!c.IsConnected) countedOpenConnectors++;
                }
            }
            connectorCount = countedConnectors;
            openConnectorCount = countedOpenConnectors;
        }

        System.Collections.Generic.List<object> parameterSummaries = new System.Collections.Generic.List<object>();
        if (includeParameters)
        {
            foreach (string parameterName in names)
            {
                Parameter p = elem.LookupParameter(parameterName);
                object summary = ParameterSummary(p, "instance");
                if (summary != null) parameterSummaries.Add(summary);
                if (includeTypeParameters && typeElem != null)
                {
                    Parameter tp = typeElem.LookupParameter(parameterName);
                    object typeSummary = ParameterSummary(tp, "type");
                    if (typeSummary != null) parameterSummaries.Add(typeSummary);
                }
            }
        }

        elements.Add(new {
            id = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            name = elem.Name,
            category = categoryName,
            categoryId = categoryId,
            className = elem.GetType().FullName,
            familyName = familyName,
            typeName = typeName,
            levelName = LevelName(elem),
            connectorsIncluded = includeConnectors,
            connectorCount = connectorCount,
            openConnectorCount = openConnectorCount,
            parameters = parameterSummaries.ToArray()
        });
    }

    return new {
        success = true,
        elements = elements.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`}function cs(e){e.tool("inspect_elements","Read-only inspection for selected or targeted Revit elements: class/category/type/level/key parameters/connector summary.",{...I(Le),...N(Le),elementIds:Le.array(Le.union([Le.number(),Le.string()])).optional().describe("Element ids to inspect."),useSelection:Le.boolean().optional().describe("When true, inspect the current Revit selection."),limit:Le.number().int().positive().max(100).optional().describe("Maximum elements to inspect. Defaults 20."),includeParameters:Le.boolean().optional().describe("Include key or requested parameter summaries. Defaults true."),includeTypeParameters:Le.boolean().optional().describe("Also inspect matching type parameters. Defaults false."),includeConnectors:Le.boolean().optional().describe("Include connector counts when available. Defaults true. When false, connectorCount/openConnectorCount are null and connectorsIncluded=false."),parameterNames:Le.array(Le.string()).optional().describe("Optional targeted parameter names.")},async t=>{let n=Se(t);try{let r=await am(t,n);if(r.length===0)return f({success:!0,elements:[],warnings:["No element ids supplied and no selected elements found."]});let o=await ce(im(r,t),{...n,...ke(t,"Inspect Revit elements"),transactionMode:"none"});return f(o&&o.result?o.result:o)}catch(r){return f({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as De}from"zod";var sm=["completed","max_elapsed","max_rows","max_columns","max_cells","max_items","max_bytes","read_failed","needs_scope"],lm=["lastReadSection","lastReadRow","lastReadColumn","lastReadSheetId","lastReadViewId","lastReadViewportId","lastReadItemId"],cm=new Set(sm),um={done:"completed",success:"completed",timeout:"max_elapsed",timed_out:"max_elapsed",socket_timeout:"max_elapsed",max_schedules:"max_items",max_sheets:"max_items",max_text_notes:"max_items",max_tags:"max_items",max_viewports:"max_items",max_scanned:"max_items",max_schedule_instances:"max_items",max_schedule_cells:"max_cells",max_cells_scanned:"max_cells",rows_truncated:"max_rows",columns_truncated:"max_columns"};function Gn(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function mn(e){return String(e??"").trim()}function dn(e){return Array.isArray(e)?e.map(t=>mn(t)).filter(t=>t.length>0):[]}function c(e,t){if(!Gn(e))return;let n=t.charAt(0).toUpperCase()+t.slice(1);if(Object.prototype.hasOwnProperty.call(e,t))return e[t];if(Object.prototype.hasOwnProperty.call(e,n))return e[n];let r=t.toLowerCase(),o=Object.keys(e).find(a=>a.toLowerCase()===r);return o?e[o]:void 0}function k(e,t){let n=c(e,t);return Array.isArray(n)?n.filter(r=>Gn(r)):[]}function pn(e,t){let n=c(e,t);return Gn(n)?n:null}function us(e,t=!1){if(typeof e=="boolean")return e;if(typeof e=="string"){let n=e.trim().toLowerCase();if(n==="true")return!0;if(n==="false")return!1}return t}function ds(e){if(e==null)return null;if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function Jn(e,t="completed"){let n=mn(e).toLowerCase();return n?cm.has(n)?n:um[n]||t:t}function dm(e,t,n,r){return n?"needs_scope":r==="failed"?"read_failed":t?"max_items":"completed"}function Go(e,t,n){return typeof e=="function"?e(t):e??n}function be(e,t){let n=Gn(e)?{...e}:{value:e},r=mn(c(n,"state")),o=mn(c(n,"error")),a=us(c(n,"guarded"),!1),i=c(n,"success"),s=typeof i=="boolean"?!!i:o.length===0,l=r||(a?"guarded":s?"completed":"failed"),u=t.partial??us(c(n,"partial"),!1),m=mn(t.scanStoppedReason??c(n,"scanStoppedReason")),p=dm(n,u,a,l),g=Jn(m,p);n.success=s,n.guarded=a,n.state=l,n.action=t.action,n.partial=u,n.scanStoppedReason=g,m&&m!==g&&n.rawScanStoppedReason===void 0&&(n.rawScanStoppedReason=m);let h=pn(n,"scanPolicy");n.scanPolicy=h||t.scanPolicy||{};let w=dn(c(n,"suggestedNextScopes"));n.suggestedNextScopes=w.length>0?w:dn(t.suggestedNextScopes),n.elapsedMs=ds(c(n,"elapsedMs"))??ds(t.elapsedMs),n.warnings=dn(c(n,"warnings")).concat(dn(t.warnings)),n.notices=dn(c(n,"notices")).concat(dn(t.notices));let _=Go(t.evidenceRows,n,[]),L=k(n,"evidenceRows");n.evidenceRows=L.length>0?L:Array.isArray(_)?_:[];let R=Go(t.summary,n,{}),A=pn(n,"summary");n.summary=A||(Gn(R)?R:{});let T=Go(t.lastRead,n,{});for(let j of lm){let z=c(n,j);n[j]=z!==void 0?z:T[j]??null}return n}function Ve(e){let t=mn(e.reason)||"needs_scope";return be({...e.extra||{},success:!0,guarded:!0,state:"guarded",action:e.action,reason:t,message:e.message,partial:!1,scanStoppedReason:t},{...e,partial:!1,scanStoppedReason:t,summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}function Me(e){return be({...e.extra||{},success:!1,guarded:!1,state:"failed",action:e.action,error:e.error,partial:!1,scanStoppedReason:"read_failed"},{...e,partial:!1,scanStoppedReason:"read_failed",summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}var mm=500,ps=5e3,pm=3e4;function ms(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function hm(e){return[...new Set((Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t??""),10)).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n)}function fm(e){return[...new Set((Array.isArray(e)?e:[]).map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0)}function gm(e){let t=String(e??"");return["hostOnly","linkedOnly","hostAndLinked"].includes(t)?t:"hostAndLinked"}function ym(e){return String(e??"")==="exact"?"exact":"contains"}function hs(e){return{sourceScope:gm(e.sourceScope),linkInstanceIds:hm(e.linkInstanceIds),linkInstanceUniqueIds:fm(e.linkInstanceUniqueIds),nameQuery:String(e.nameQuery??"").trim(),nameMatchMode:ym(e.nameMatchMode),maxResults:ms(e.maxResults,mm,1,ps),timeoutMs:ms(e.timeoutMs,pm,2e3,6e4),taskName:e.taskName||"Inspect Revit levels",taskId:e.taskId}}function fs(e){let t=hs(e);return{sourceScope:t.sourceScope,linkInstanceSelectorMode:"exact_id_or_unique_id",nameMatchMode:t.nameMatchMode,maxResults:t.maxResults,deterministicSortBasis:["sourceKind(host_before_link)","linkInstanceUniqueId(ordinal)","linkInstanceId","sourceProjectElevationMm","name(ordinal)","levelUniqueId(ordinal)","levelId"],maxResultsAppliedAfterDeterministicSort:!0}}function Sm(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function bm(e){return Sm(e)?{linkInstanceUniqueId:c(e,"linkInstanceUniqueId")??null,levelId:c(e,"levelId")??null,levelUniqueId:c(e,"levelUniqueId")??null,levelName:c(e,"levelName")??null}:null}function wm(e){return{sourceKind:c(e,"sourceKind")??null,documentKey:c(e,"documentKey")??null,documentSessionId:c(e,"documentSessionId")??null,levelId:c(e,"levelId")??null,levelUniqueId:c(e,"levelUniqueId")??null,name:c(e,"name")??null,sourceProjectElevationMm:c(e,"sourceProjectElevationMm")??null,sourceProjectElevationFrame:c(e,"sourceProjectElevationFrame")??null,hostElevationMm:c(e,"hostElevationMm")??null,hostElevationFrame:c(e,"hostElevationFrame")??null,hostElevationTransformBasis:c(e,"hostElevationTransformBasis")??null,linkInstanceId:c(e,"linkInstanceId")??null,linkInstanceUniqueId:c(e,"linkInstanceUniqueId")??null,linkedSourceLevelSelector:bm(c(e,"linkedSourceLevelSelector"))}}function gs(e){return k(e,"levels").map(wm)}function Jo(e){let t=Number(c(e,"unavailableSourceCount")??0);return Number.isFinite(t)&&t>0?Math.trunc(t):0}function $o(e){return Jo(e)>0||c(e,"partial")===!0||c(e,"truncated")===!0}function ys(e){return Jo(e)>0?"read_failed":c(e,"truncated")===!0?"max_items":String(c(e,"scanStoppedReason")??($o(e)?"max_items":"completed"))}function xm(e){let t=gs(e);return{sourceScope:c(e,"sourceScope")??null,nameQuery:c(e,"nameQuery")??null,nameMatchMode:c(e,"nameMatchMode")??null,effectiveSourceCount:c(e,"effectiveSourceCount")??null,selectedLinkCount:c(e,"selectedLinkCount")??null,loadedSelectedLinkCount:c(e,"loadedSelectedLinkCount")??null,unavailableSourceCount:Jo(e),scannedLevelCount:c(e,"scannedLevelCount")??null,matchedLevelCount:c(e,"matchedLevelCount")??null,returnedCount:c(e,"returnedCount")??t.length,partial:$o(e),scanStoppedReason:ys(e)}}function vm(e,t,n){let r=gs(e),o=r.length>0?r[r.length-1]:null,a=be(e,{action:"inspect_levels",elapsedMs:n,partial:$o(e),scanStoppedReason:ys(e),scanPolicy:fs(t),suggestedNextScopes:["sourceScope","linkInstanceIds","linkInstanceUniqueIds","nameQuery","nameMatchMode","maxResults"],summary:xm,evidenceRows:r,lastRead:{lastReadItemId:o?.levelId??null}});return a.levels=r,delete a.Levels,a}function Ss(e){e.tool("inspect_levels","[LEVEL_INSPECTION_READ_ONLY] List deterministic host and loaded-linked Revit Level evidence without modifying the model. Use sourceScope plus exact linkInstanceIds/linkInstanceUniqueIds to discover linked source level names and transformed host elevations before capture_spatial_snapshot or other level-scoped reads. Optional nameQuery supports exact or contains matching. sourceProjectElevationMm uses the shared Level.ProjectElevation-compatible resolver. Linked hostElevationMm is based on RevitLinkInstance.GetTransform applied to the source-origin point (0,0,project elevation), and each linked row includes a copy-ready linkedSourceLevelSelector. maxResults is applied only after deterministic sorting and reports partial/max_items when truncated. Missing, unloaded, or unreadable selected links report unavailableSourceCount and partial/read_failed instead of a complete inventory. Prefer this tool over custom C# level/link loops.",{...I(De),...N(De),sourceScope:De.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),linkInstanceIds:De.array(De.union([De.number().int().positive(),De.string()])).max(100).optional().describe("Optional exact RevitLinkInstance element ids. Selectors restrict linked sources and are ignored for hostOnly."),linkInstanceUniqueIds:De.array(De.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance UniqueIds. Selectors restrict linked sources and are ignored for hostOnly."),nameQuery:De.string().optional().describe("Optional Level name filter. Empty returns all levels in the selected sources."),nameMatchMode:De.enum(["exact","contains"]).optional().describe("Level-name matching policy. Defaults contains; matching is ordinal case-insensitive natively."),maxResults:De.number().int().positive().max(ps).optional().describe("Maximum deterministically sorted Level rows returned. Defaults 500; truncation reports partial/max_items."),timeoutMs:De.number().int().min(2e3).max(6e4).optional().describe("Socket timeout in milliseconds. Defaults 30000.")},async t=>{let n=Date.now(),r=hs(t);try{let o=await D("inspect_levels",r,{...V(t,"Inspect Revit levels"),toolName:"inspect_levels",timeoutMs:r.timeoutMs});return f(vm(o&&o.result?o.result:o,t,Date.now()-n))}catch(o){return f(Me({action:"inspect_levels",error:o instanceof Error?o.message:String(o),elapsedMs:Date.now()-n,scanPolicy:fs(t),suggestedNextScopes:["sourceScope","linkInstanceIds","linkInstanceUniqueIds","nameQuery","nameMatchMode","maxResults"],extra:{sourceScope:r.sourceScope,nameQuery:r.nameQuery,nameMatchMode:r.nameMatchMode,lengthUnit:"mm",hostCoordinateFrame:"host_internal_mm",maxResults:r.maxResults,unavailableSourceCount:0,levels:[]}}))}})}import{z as H}from"zod";var _m={fast:{maxElapsedMs:4500,timeoutMs:12e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4},deep:{maxElapsedMs:45e3,timeoutMs:6e4}};function Cm(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=_m[t],r=Number.parseInt(String(e.maxElapsedMs??""),10),o=Number.isFinite(r)?Math.max(1,Math.min(119e3,r)):n.maxElapsedMs,a=Number.parseInt(String(e.timeoutMs??""),10),i=Number.isFinite(a)?Math.max(1e3,Math.min(12e4,a)):Math.max(n.timeoutMs,Math.min(12e4,o+5e3));return{searchBudget:t,maxElapsedMs:Math.min(o,Math.max(1,i-1e3)),timeoutMs:i}}function Rm(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||e.query||"").trim())}function Tm(e,t){return Ve({action:"inspect_sheet_text",reason:"needs_scope",message:"Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"],scanPolicy:{searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,allowExpensiveSearch:!1,textQuery:!!String(e.textQuery||"").trim(),includeViewportTextNotes:e.includeViewportTextNotes===!0,includeViewportTags:e.includeViewportTags===!0,scanScheduleCells:e.scanScheduleCells===!0,maxTags:e.maxTags??e.maxTagsScanned,maxViewports:e.maxViewports??e.maxViewportsPerSheet},summary:{sheetQuery:e.sheetQuery??e.query??null,textQuery:e.textQuery??null,returnedCount:0,matchCount:0}})}function Im(e,t){return{query:e.query,sheetQuery:e.sheetQuery??e.query,textQuery:e.textQuery,sheetIds:e.sheetIds,includeTextNotes:e.includeTextNotes,includeScheduleInstances:e.includeScheduleInstances,scanScheduleCells:e.scanScheduleCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,includeViewportTextNotes:e.includeViewportTextNotes,includeViewportTags:e.includeViewportTags,viewNameQuery:e.viewNameQuery,maxSheets:e.maxSheets,maxTextNotesPerSheet:e.maxTextNotesPerSheet,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxTextChars:e.maxTextChars,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxViewportTextNotesPerView:e.maxViewportTextNotesPerView,maxViewportTagsPerView:e.maxViewportTagsPerView,maxTags:e.maxTags,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit sheet annotations",taskId:e.taskId}}function Xo(e){let t=String(c(e,"kind")||c(e,"sourceType")||"");return t==="scheduleCell"?"placedScheduleCell":t==="scheduleInstance"?"placedScheduleInstance":t||"sheetTextNote"}function hn(e){return String(c(e,"textQuery")??"").trim().length>0}function Ko(e,t=!0){if(!t)return!1;let n=c(e,"matchedTextQuery"),r=c(e,"inventoryOnly");return!(r===!0||String(r).trim().toLowerCase()==="true"||n===!1||String(n).trim().toLowerCase()==="false")}function Fr(e){let t=k(e,"evidenceRows"),n=t.length>0?t:k(e,"matches"),r=hn(e);return n.filter(o=>!!o&&typeof o=="object"&&!Array.isArray(o)).filter(o=>Ko(o,r)).map(o=>({...o,sourceType:Xo(o)}))}function bs(e){let t=k(e,"inventoryRows"),n=k(e,"evidenceRows"),r=hn(e),o=[...n,...k(e,"matches")].filter(i=>!!i&&typeof i=="object"&&!Array.isArray(i)).filter(i=>!Ko(i,r)),a=new Set;return[...t,...o].filter(i=>!!i&&typeof i=="object"&&!Array.isArray(i)).map(i=>({...i,sourceType:Xo(i),matchedTextQuery:!1,inventoryOnly:!0})).filter(i=>{let s=[c(i,"sourceType")??"",c(i,"sheetId")??"",c(i,"instanceId")??c(i,"elementId")??c(i,"id")??"",c(i,"scheduleId")??""].join("|");return a.has(s)?!1:(a.add(s),!0)})}function Yo(e,t){let n={};for(let[r,o]of Object.entries(e))t.has(r)||(n[r]=o);return n}function Em(e,t){let n=t&&Ko(e,t);return{...Yo(e,new Set(["MatchedTextQuery","InventoryOnly","matchedTextQuery","inventoryOnly"])),sourceType:Xo({...e,kind:c(e,"kind")??"scheduleInstance"}),MatchedTextQuery:n,InventoryOnly:!n,matchedTextQuery:n,inventoryOnly:!n}}function Nm(e){let t=hn(e);return k(e,"sheets").map(n=>{let r=Yo(n,new Set(["ScheduleInstances"])),o=k(n,"scheduleInstances");return{...r,scheduleInstances:o.map(a=>Em(a,t))}})}function Mm(e){let t=c(e,"scan");return!t||typeof t!="object"||Array.isArray(t)||hn(e)?t:{...t,TotalTextNoteMatches:0,totalTextNoteMatches:0,TotalViewportTextNoteMatches:0,totalViewportTextNoteMatches:0,TotalViewportTagMatches:0,totalViewportTagMatches:0,TotalScheduleCellMatches:0,totalScheduleCellMatches:0,TotalScheduleInstanceMatches:0,totalScheduleInstanceMatches:0}}function ws(e){let t=Jn(c(e,"scanStoppedReason")),n=String(c(e,"rawScanStoppedReason")??c(e,"scanStoppedReason")??t).trim()||t;return{canonicalReason:t,nativeReason:n,nativeLimitField:{max_sheets:"maxSheets",max_text_notes:"maxTextNotesScanned",max_viewports:"maxViewports",max_scanned:"maxScheduleInstancesScanned",max_schedule_instances:"maxScheduleInstancesScanned",max_schedule_cells:"maxScheduleCellsScanned",max_tags:"maxTagsScanned"}[n]??null}}function Am(e){let t=Fr(e),n=bs(e),r=k(e,"sheets");return{sheetQuery:c(e,"sheetQuery")??null,textQuery:c(e,"textQuery")??null,totalSheets:c(e,"totalSheets")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!hn(e),matchCount:t.length,inventoryRowCount:n.length,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed",rawScanStoppedReason:c(e,"rawScanStoppedReason")??null,scanStopDetail:ws(e),scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null}}function km(e){let t=k(e,"evidenceRows").length>0?k(e,"evidenceRows"):Fr(e),n=t.length>0?t[t.length-1]:null,r=k(e,"sheets"),o=r.length>0?r[r.length-1]:null;return{lastReadSection:n?c(n,"section")??null:null,lastReadRow:n?c(n,"row")??null:null,lastReadColumn:n?c(n,"column")??null:null,lastReadSheetId:n?c(n,"sheetId")??c(o,"id")??null:c(o,"id")??null,lastReadViewId:n?c(n,"viewId")??null:null,lastReadViewportId:n?c(n,"viewportId")??null:null,lastReadItemId:n?c(n,"elementId")??c(n,"tagId")??c(n,"instanceId")??c(n,"id")??null:null}}function Om(e,t){let n=be(e,{action:"inspect_sheet_text",elapsedMs:t,summary:Am,evidenceRows:Fr,lastRead:km,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}),r=bs(n),o=hn(n),a=Mm(n),i=new Set(["Sheets"]);return o||(i.add("Matches"),i.add("EvidenceRows")),{...Yo(n,i),evidenceRows:o?Fr(n):[],inventoryRows:r,matches:o?k(n,"matches"):[],scan:a,sheets:Nm(n),summary:{...n.summary||{},inventoryRowCount:r.length,scanStopDetail:ws(n)}}}function xs(e){e.tool("inspect_sheet_text","[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet text and annotation inspection for DrawingSheet text notes, titleblock/title block notes, revision schedule instances, placed schedule cells, viewport-linked text notes, viewport plan annotations, and viewport tags. Prefer this dedicated tool over generic send_code_to_revit for sheet text lookup, drawing note searches, plan note searches, titleblock/revision evidence, placed schedule text evidence, and large-project sheet or viewport annotation searches. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true. When a user asks where a schedule value appears on sheets, search placed schedule cells here before writing custom C# sheet loops; use set_schedule_cells or set_schedule_cells_by_text for accepted follow-up writes.",{...I(H),...N(H),query:H.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),sheetQuery:H.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text or viewport annotation search."),textQuery:H.string().optional().describe("Optional text to search in sheet text notes, viewport text notes, or placed schedule cells."),sheetIds:H.array(H.union([H.number(),H.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),includeTextNotes:H.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),includeScheduleInstances:H.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),scanScheduleCells:H.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),allowExpensiveSearch:H.boolean().optional().describe("Explicit approval for project-wide sheet, viewport, tag, or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),searchBudget:H.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:H.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),includeViewportTextNotes:H.boolean().optional().describe("Include bounded TextNote results from views placed on matching sheets. Defaults false."),includeViewportTags:H.boolean().optional().describe("Include bounded IndependentTag evidence from views placed on matching sheets. Defaults false."),viewNameQuery:H.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),maxSheets:H.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),maxTextNotesPerSheet:H.number().int().min(0).max(1e3).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),maxScheduleInstancesPerSheet:H.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),maxRowsPerSchedule:H.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),maxColumnsPerSchedule:H.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),maxTextChars:H.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned text value. Defaults 240."),maxViewportsPerSheet:H.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:H.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet. Maximum placed viewports inspected per sheet."),maxViewportTextNotesPerView:H.number().int().min(0).max(1e3).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),maxViewportTagsPerView:H.number().int().min(0).max(500).optional().describe("Maximum matching viewport tags returned per placed view. Defaults 100."),maxTextNotesScanned:H.number().int().positive().max(2e5).optional().describe("Global native cap across sheet and viewport text notes."),maxTags:H.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:H.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxScheduleInstancesScanned:H.number().int().positive().max(1e5).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:H.number().int().positive().max(5e5).optional().describe("Global native cap across placed schedule body cells."),maxResponseBytes:H.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:H.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=Cm(t),o=Rm(t),a=!!String(t.textQuery||"").trim()&&!o,i=t.includeViewportTextNotes===!0&&!o,s=t.scanScheduleCells===!0&&!o,l=t.includeViewportTags===!0&&!o;if((a||i||s||l)&&t.allowExpensiveSearch!==!0)return f(Tm(t,r));let u=await D("inspect_sheet_text",Im(t,r),{...V({...t,timeoutMs:r.timeoutMs},"Inspect Revit sheet annotations"),toolName:"inspect_sheet_text"});return f(Om(u&&u.result?u.result:u,Date.now()-n))}catch(r){return f(Me({action:"inspect_sheet_text",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}))}})}import{z as te}from"zod";var Pm=25,Lm=50;function ve(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function vs(e){let t=Array.isArray(e)&&e.length>0?e:["header","body"];return[...new Set(t.map(n=>String(n||"").toLowerCase()))].filter(n=>["header","body","footer"].includes(n))}var Vm={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxCells:5e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxCells:25e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxCells:1e5}};function _s(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Vm[t],r=ve(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=ve(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxCells:ve(e.maxCells,n.maxCells,1,5e5)}}function Dm(e){return(Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t),10)).filter(t=>Number.isFinite(t)&&t>0)}function Fm(e,t){let n=Dm(e.scheduleIds),r=vs(e.sections);return{query:e.query,nameQuery:e.nameQuery??e.query,cellQuery:e.cellQuery,scheduleIds:n,sections:r,includeCells:e.includeCells,scanCells:e.scanCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSchedules:ve(e.maxSchedules,50,1,200),maxRowsPerSection:ve(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:ve(e.maxColumnsPerSection,30,0,200),startRow:ve(e.startRow,0,0,1e5),startColumn:ve(e.startColumn,0,0,1e4),maxCellTextChars:ve(e.maxCellTextChars,180,20,1e3),maxCells:t.maxCells,maxResponseBytes:ve(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit schedules",taskId:e.taskId}}function Wt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function jm(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function jr(e){return k(e,"schedules").filter(Wt).flatMap(n=>k(n,"sections").map(o=>({schedule:n,section:o})))}function fn(e){return String(c(e,"cellQuery")??"").trim().length>0}function Zo(e){return String(c(e,"nameQuery")??c(e,"query")??"").trim().length>0}function ea(e){return fn(e)?jr(e).flatMap(({schedule:t,section:n})=>k(n,"matches").filter(Wt).map(o=>({sourceType:"scheduleCell",scheduleId:c(t,"id"),scheduleName:c(t,"name"),section:c(o,"section")??c(n,"section"),row:c(o,"row"),column:c(o,"column"),text:c(o,"text")}))):[]}function ta(e){return c(e,"partial")===!0||c(e,"truncated")===!0?!0:jr(e).some(({section:t})=>c(t,"rowsTruncated")===!0||c(t,"columnsTruncated")===!0)}function Bm(e){if(c(e,"success")===!1||String(c(e,"state")||"").toLowerCase()==="failed"||c(e,"error"))return"read_failed";if(!ta(e))return"completed";if(c(e,"truncated")===!0)return"max_items";for(let{section:t}of jr(e)){if(c(t,"rowsTruncated")===!0)return"max_rows";if(c(t,"columnsTruncated")===!0)return"max_columns"}return"max_cells"}function Cs(e){let t=Bm(e),n=c(e,"scanStoppedReason");return!n||n==="completed"&&t!=="completed"?t:n}function qm(e){let t=Rs(e),n=Wt(t)?t:{},r=k(e,"schedules"),o=k(e,"evidenceRows").length>0?k(e,"evidenceRows"):ea(e);return{query:c(e,"query")??null,nameQuery:c(e,"nameQuery")??null,cellQuery:c(e,"cellQuery")??null,totalSchedules:c(e,"totalSchedules")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!Zo(e)&&!fn(e),matchCount:o.length,totalCellMatches:c(n,"totalCellMatches")??o.length,scannedScheduleCount:c(n,"scannedScheduleCount")??null,partial:ta(e),scanStoppedReason:Cs(e)}}function zm(e){let t=k(e,"evidenceRows").length>0?k(e,"evidenceRows"):ea(e),n=t.length>0?t[t.length-1]:null,r=jr(e),o=r.length>0?r[r.length-1].section:null,a=k(e,"schedules"),i=r.length>0?r[r.length-1].schedule:a.length>0?a[a.length-1]:null,s=Number(c(o,"returnedRows")??c(o,"scannedRows")??0),l=Number(c(o,"returnedColumns")??c(o,"scannedColumns")??0),u=Number(c(o,"startRow")??0),m=Number(c(o,"startColumn")??0);return{lastReadSection:c(n,"section")??c(o,"section")??null,lastReadRow:c(n,"row")??c(o,"lastReadRow")??(s>0?u+s-1:null),lastReadColumn:c(n,"column")??c(o,"lastReadColumn")??(l>0?m+l-1:null),lastReadSheetId:null,lastReadViewId:null,lastReadViewportId:null,lastReadItemId:c(n,"scheduleId")??c(i,"id")??null}}function Qo(e){let t=_s(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,includeCells:e.includeCells===!0,scanCells:e.scanCells===!0||!!e.cellQuery,sections:vs(e.sections),maxElapsedMs:t.maxElapsedMs,maxSchedules:ve(e.maxSchedules,50,1,200),maxRowsPerSection:ve(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:ve(e.maxColumnsPerSection,30,0,200),startRow:ve(e.startRow,0,0,1e5),startColumn:ve(e.startColumn,0,0,1e4),maxCells:t.maxCells,maxResponseBytes:ve(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs}}function Um(e,t=!0){let{matches:n,Matches:r,...o}=e;return{...o,section:c(e,"section"),rowCount:c(e,"rowCount"),columnCount:c(e,"columnCount"),startRow:c(e,"startRow"),startColumn:c(e,"startColumn"),returnedRows:c(e,"returnedRows"),returnedColumns:c(e,"returnedColumns"),rowsTruncated:c(e,"rowsTruncated"),columnsTruncated:c(e,"columnsTruncated"),scannedRows:c(e,"scannedRows"),scannedColumns:c(e,"scannedColumns"),scannedCells:c(e,"scannedCells"),lastReadRow:c(e,"lastReadRow"),lastReadColumn:c(e,"lastReadColumn"),matches:t?k(e,"matches").filter(Wt).map(a=>({...a,section:c(a,"section"),row:c(a,"row"),column:c(a,"column"),text:c(a,"text")})):[],cells:k(e,"cells").map(a=>({...a,row:c(a,"row"),cells:k(a,"cells").map(i=>({...i,column:c(i,"column"),text:c(i,"text")}))})),readFailed:c(e,"readFailed"),readError:c(e,"readError")}}function Wm(e){let t=!Zo(e)&&!fn(e),n=fn(e);return k(e,"schedules").filter(Wt).map(r=>{let{nameMatched:o,NameMatched:a,cellMatchCount:i,CellMatchCount:s,sections:l,Sections:u,...m}=r;return{...m,id:c(r,"id"),uniqueId:c(r,"uniqueId"),name:c(r,"name"),viewType:c(r,"viewType"),isTemplate:c(r,"isTemplate"),nameMatched:t?!1:c(r,"nameMatched"),cellMatchCount:n?c(r,"cellMatchCount"):0,sections:k(r,"sections").filter(Wt).map(p=>Um(p,n))}})}function Hm(e,t){for(let[n,r]of Object.entries(t)){let o=n.charAt(0).toUpperCase()+n.slice(1);e[n]=r,e[o]=r}return e}function Rs(e){let t=c(e,"scan");if(!t||typeof t!="object"||Array.isArray(t))return t;let n={...t},r={};return Zo(e)||(r.scheduleNameMatchedCount=0),fn(e)||(r.cellMatchedScheduleCount=0,r.totalCellMatches=0),Hm(n,r)}function Gm(e){for(let t of["query","nameQuery","cellQuery","totalSchedules","candidateCount","returnedCount","truncated","maxSchedules","scan","matches"]){let n=c(e,t);n!==void 0&&e[t]===void 0&&(e[t]=n)}return e.scan=Rs(e),e.schedules=Wm(e),fn(e)||(e.matches=[],delete e.Matches),e}function Jm(e){return String(c(e,"id")??c(e,"uniqueId")??c(e,"name")??"")}function $m(e,t){let n=k(e,"cells"),r=Pe(k(e,"matches"),{limit:t}),{cells:o,Cells:a,matches:i,Matches:s,...l}=e;return{...l,matches:r.rows,matchCount:r.totalCount,returnedMatchCount:r.returnedCount,omittedMatchCount:r.omittedCount,duplicateMatchCount:r.duplicateCount,cellsOmitted:n.length>0,cellRowCount:n.length,fullResponseHint:n.length>0?'Use responseMode="full" when downstream schedule adapters need section.cells/body rows.':void 0}}function Xm(e,t){let n=t.responseMode||"compact";if(Tt(n))return{...e,responseMode:n};let r=Ye(t.maxResultRows,Pm,200),o=Ye(t.maxEvidenceRows,Lm,1e3),a=Pe(k(e,"schedules"),{limit:r,key:Jm}),i=Pe(k(e,"evidenceRows"),{limit:o});return{...e,responseMode:"compact",schedules:a.rows.map(s=>({...s,sections:k(s,"sections").filter(Wt).map(l=>$m(l,o))})),evidenceRows:i.rows,summary:{...e.summary||{},compactResponse:!0,scheduleRowCount:a.totalCount,returnedScheduleRowCount:a.returnedCount,omittedScheduleRowCount:a.omittedCount,duplicateScheduleRowCount:a.duplicateCount,evidenceRowCount:i.totalCount,returnedEvidenceRowCount:i.returnedCount,omittedEvidenceRowCount:i.omittedCount},notices:[...jm(e.notices),'Compact response omits section.cells and bounds evidence rows. Use responseMode="full" for full schedule cell bodies.']}}function na(e,t,n){let r=ta(e);return Xm(Gm(be(e,{action:"inspect_schedules",elapsedMs:n,partial:r,scanStoppedReason:Cs(e),scanPolicy:Qo(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],summary:qm,evidenceRows:ea,lastRead:zm})),t)}function Ts(e){e.tool("inspect_schedules","[SCHEDULE_INSPECTION_READ_ONLY] Read-only native Revit schedule discovery and bounded cell inspection with partial-result continuation state. Prefer this over generic send_code_to_revit when finding schedules, reading schedule cells, exporting schedule text to a local TSV/CSV/Excel-style report, or preparing exact row/column coordinates for set_schedule_cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true. Default responseMode=compact omits bulky section.cells; use responseMode=full when the next step needs raw schedule body rows, such as reconcile_schedule_excel schedule adaptation or a local TSV conversion. Do not use raw C# only to dump schedule cells.",{...I(te),...N(te),query:te.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),nameQuery:te.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),cellQuery:te.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),scheduleIds:te.array(te.union([te.number(),te.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),sections:te.array(te.enum(["header","body","footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),includeCells:te.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),scanCells:te.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),allowExpensiveSearch:te.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),searchBudget:te.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:te.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial schedule results can return before transport timeout."),maxSchedules:te.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),maxRowsPerSection:te.number().int().min(0).max(1e3).optional().describe("Maximum rows per section to read/scan. Defaults 80."),maxColumnsPerSection:te.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),startRow:te.number().int().min(0).max(1e5).optional().describe("Zero-based first schedule row to read in each requested section. Defaults 0."),startColumn:te.number().int().min(0).max(1e4).optional().describe("Zero-based first schedule column to read in each requested section. Defaults 0."),maxCells:te.number().int().positive().max(5e5).optional().describe("Global native cap across schedule cells read or scanned. Defaults by searchBudget."),maxResponseBytes:te.number().int().min(4096).max(16*1024*1024).optional().describe("Approximate native response-size cap. Defaults 4 MB."),maxCellTextChars:te.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),responseMode:Rt,maxResultRows:te.number().int().positive().max(200).optional().describe("Compact-mode cap for returned schedule entries. Defaults 25; full/debug returns all native rows within maxSchedules."),maxEvidenceRows:te.number().int().positive().max(1e3).optional().describe("Compact-mode cap for evidenceRows and per-section matches. Defaults 50."),timeoutMs:te.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{let n=Date.now();try{let r=!!(Array.isArray(t.scheduleIds)&&t.scheduleIds.length>0||String(t.nameQuery||t.query||"").trim());if(!!(t.includeCells===!0||t.scanCells===!0||String(t.cellQuery||"").trim())&&!r&&t.allowExpensiveSearch!==!0)return f(Ve({action:"inspect_schedules",reason:"needs_scope",message:"Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],scanPolicy:Qo(t),elapsedMs:Date.now()-n,summary:{nameQuery:t.nameQuery??t.query??null,cellQuery:t.cellQuery??null,returnedCount:0,matchCount:0}}));let a=_s(t),i=await D("inspect_schedules",Fm(t,a),{...V(t,"Inspect Revit schedules"),toolName:"inspect_schedules",timeoutMs:a.timeoutMs});return f(na(i&&i.result?i.result:i,t,Date.now()-n))}catch(r){return f(Me({action:"inspect_schedules",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,scanPolicy:Qo(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"]}))}})}import{z as pa}from"zod";import*as op from"node:fs";import Es from"node:fs/promises";import ap from"node:path";import{performance as ra}from"node:perf_hooks";import*as Gt from"@e965/xlsx";import{parse as ip}from"csv-parse/sync";import{z as M}from"zod";var Br=["identity","comparisonText"],qr=["identity","comparisonText","code","description","quantity","unit","system","discipline","notes"],zr={identity:["identity","id","key","name","item","row","code","type","mark","tag","poz","kod","ad","isim"],comparisonText:["comparisontext","comparison text","description","desc","aciklama","text","name","item","type","mark","tag","ad","isim"],code:["code","kod","type code","mark","tag","poz"],description:["description","desc","text","aciklama"],quantity:["quantity","qty","count","adet","miktar"],unit:["unit","units","birim"],system:["system","sistem"],discipline:["discipline","disiplin"],notes:["notes","note","remarks","remark","not"]},Km={\u0410:"A",\u0430:"A",\u0412:"B",\u0432:"B",\u0415:"E",\u0435:"E",\u041A:"K",\u043A:"K",\u041C:"M",\u043C:"M",\u041D:"H",\u043D:"H",\u041E:"O",\u043E:"O",\u0420:"P",\u0440:"P",\u0421:"C",\u0441:"C",\u0422:"T",\u0442:"T",\u0423:"Y",\u0443:"Y",\u0425:"X",\u0445:"X"},Ym={\u00C7:"C",\u00E7:"C",\u011E:"G",\u011F:"G",\u00D6:"O",\u00F6:"O",\u015E:"S",\u015F:"S",\u00DC:"U",\u00FC:"U"},gn=new Set(["DN","MM","CM","M","KW","KCALH","LPS","M3H"]);function ee(e){return String(e??"").replace(/\s+/g," ").trim()}function Qe(e){return ee(e).replace(/\u0131/g,"i").replace(/\u0130/g,"I").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}function Xn(e){return Qe(e).replace(/\s+/g,"")}function yn(e){let t=String(e??"");return t=t.replace(/[\u0000-\u001f\u007f-\u009f]/g," "),t=t.normalize("NFKC"),t=t.replace(/\u0131/g,"i").replace(/\u0130/g,"I"),t=t.replace(/[\u0400-\u04ff]/g,n=>Km[n]||n),t=t.replace(/[\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/g,n=>Ym[n]||n),t=t.toUpperCase(),t=t.replace(/[\u00d8\u00f8\u2205\u2300\u0424\u0444]/g," DN "),t=t.replace(/\b(?:DIAMETER|DIA)\b/g," DN "),t=ep(t),t=t.replace(/(\d),(\d)/g,"$1.$2"),t=t.replace(/(\d)\.(\d)/g,"$1DECIMALDOT$2"),t=t.replace(/[^A-Z0-9]+/g," "),t=t.replace(/(\d)DECIMALDOT(\d)/g,"$1.$2"),t=t.replace(/\bM\s*3\s*H\b/g,"M3H"),t.replace(/\s+/g," ").trim()}function Qm(e){return e.map(n=>yn(n)).filter((n,r,o)=>n.length>0&&o.indexOf(n)===r).join(" | ")}function Sn(e){let t=Qm(e);return{profileVersion:1,normalizedKey:t,tokens:Zm(t)}}function Zm(e){let t=yn(e),n=t.length>0?t.split(" "):[],r=[];for(let o=0;o<n.length;o++){let a=n[o],i=n[o+1];if($n(a)&&i&&gn.has(i)){r.push({type:"dimension",value:`${a}${i}`}),o++;continue}if(gn.has(a)&&i&&$n(i)){r.push({type:"dimension",value:`${a}${i}`}),o++;continue}let s=rp(a);if(s){r.push({type:"dimension",value:s});continue}if(gn.has(a)){r.push({type:"unit",value:a});continue}if($n(a)){r.push({type:"number",value:a});continue}let l=n[o+2]||"",u=gn.has(l)&&$n(n[o+3]||""),m=gn.has(l)&&!u;if(tp(a)&&i&&$n(i)&&!gn.has(a)&&!m){r.push({type:"code",value:`${a}${i}`}),o++;continue}if(np(a)){r.push({type:"code",value:a});continue}r.push({type:"word",value:a})}return r}function ep(e){return e.replace(/\bM\s*(?:3|\^3)\s*\/\s*H\b/g," M3H ").replace(/\bM3H\b/g," M3H ").replace(/\b(?:L|LT)\s*\/\s*S\b/g," LPS ").replace(/\bLPS\b/g," LPS ").replace(/\bKCAL\s*\/\s*H\b/g," KCALH ").replace(/\bKCALH\b/g," KCALH ").replace(/\bKW\b/g," KW ").replace(/\bMM\b/g," MM ").replace(/\bCM\b/g," CM ").replace(/\bDN\b/g," DN ")}function $n(e){return/^\d+(?:\.\d+)?$/.test(e)}function tp(e){return/^[A-Z]+$/.test(e)}function np(e){return/[A-Z]/.test(e)&&/\d/.test(e)}function rp(e){let t=e.match(/^(\d+(?:\.\d+)?)(DN|MM|CM|M|KW|KCALH|LPS|M3H)$/);if(t)return`${t[1]}${t[2]}`;let n=e.match(/^(DN)(\d+(?:\.\d+)?)$/);return n?`${n[1]}${n[2]}`:null}Gt.set_fs(op);var Kn="reconcile_schedule_excel",Jr="excel_ingestion",bn={maxWorkbookBytes:25*1024*1024,maxSheets:20,maxRows:5e3,maxColumns:100,maxCells:25e4,maxElapsedMs:5e3},wn={maxWorkbookBytes:100*1024*1024,maxSheets:200,maxRows:5e4,maxColumns:300,maxCells:1e6,maxElapsedMs:119e3},Ur=Br,Wr=qr,sp=zr,lp=M.object({sheetName:M.string().min(1).optional(),sheetIndex:M.number().int().positive().optional(),range:M.string().min(1).optional(),headerRow:M.number().int().positive().optional(),dataStartRow:M.number().int().positive().optional()}).strict(),Ns=M.object({identity:M.union([M.string().min(1),M.number().int().positive()]).optional(),comparisonText:M.union([M.string().min(1),M.number().int().positive()]).optional(),code:M.union([M.string().min(1),M.number().int().positive()]).optional(),description:M.union([M.string().min(1),M.number().int().positive()]).optional(),quantity:M.union([M.string().min(1),M.number().int().positive()]).optional(),unit:M.union([M.string().min(1),M.number().int().positive()]).optional(),system:M.union([M.string().min(1),M.number().int().positive()]).optional(),discipline:M.union([M.string().min(1),M.number().int().positive()]).optional(),notes:M.union([M.string().min(1),M.number().int().positive()]).optional()}).strict(),Ms=M.object({maxWorkbookBytes:M.number().int().positive().optional(),maxSheets:M.number().int().positive().optional(),maxRows:M.number().int().nonnegative().optional(),maxColumns:M.number().int().positive().optional(),maxCells:M.number().int().positive().optional(),maxElapsedMs:M.number().int().positive().optional()}).strict(),cp=M.object({kind:M.literal("file"),path:M.string().min(1),format:M.enum(["xlsx","csv","tsv","xls"]).optional(),selection:lp.optional(),columnMapping:Ns.optional(),budgets:Ms.optional()}).strict(),up=M.object({kind:M.literal("rows"),sheetName:M.string().min(1).optional(),rows:M.array(M.record(M.unknown())),selection:M.object({headerRow:M.number().int().positive().optional(),dataStartRow:M.number().int().positive().optional()}).strict().optional(),columnMapping:Ns.optional(),budgets:Ms.optional()}).strict(),aa=M.discriminatedUnion("kind",[cp,up]);function yt(e){return ee(e)}function Hr(e){return Qe(e)}function Is(e){return Xn(e)}function dp(e){return{maxWorkbookBytes:xn(e?.maxWorkbookBytes,bn.maxWorkbookBytes,wn.maxWorkbookBytes),maxSheets:xn(e?.maxSheets,bn.maxSheets,wn.maxSheets),maxRows:xn(e?.maxRows,bn.maxRows,wn.maxRows),maxColumns:xn(e?.maxColumns,bn.maxColumns,wn.maxColumns),maxCells:xn(e?.maxCells,bn.maxCells,wn.maxCells),maxElapsedMs:xn(e?.maxElapsedMs,bn.maxElapsedMs,wn.maxElapsedMs)}}function xn(e,t,n){return typeof e!="number"||!Number.isFinite(e)?t:Math.max(0,Math.min(Math.floor(e),n))}function As(e,t){let n=(t||ap.extname(e).replace(/^\./,"")).trim().toLowerCase();return n==="xlsx"||n==="csv"||n==="tsv"||n==="xls"?n:"unsupported"}function Ht(e,t,n={}){let{warnings:r=[],notices:o=[],suggestedNextScopes:a=[],...i}=n;return Ve({action:Kn,reason:e,message:t,extra:{stage:Jr,ingestionContractVersion:1,...i},summary:n.summary||{},evidenceRows:[],scanPolicy:n.scanPolicy||{},suggestedNextScopes:a,warnings:r,notices:o})}function mp(e,t={}){let{warnings:n=[],notices:r=[],...o}=t;return Me({action:Kn,error:e,extra:{stage:Jr,ingestionContractVersion:1,...o},summary:t.summary||{},evidenceRows:[],scanPolicy:t.scanPolicy||{},warnings:n,notices:r})}function pp(e){let t=e.table.warnings.concat(e.mappingWarnings),n=e.table.notices.concat(e.mappingNotices),r=e.table.partial,o=e.table.scanStoppedReason,a=e.records.map(i=>({sourceType:"excelRecord",excelRowId:i.excelRowId,sheetName:i.sheetName,rowNumber:i.rowNumber,identityText:i.identityText,comparisonText:i.comparisonText,normalizedKey:i.normalizedKey}));return be({success:!0,guarded:!1,state:"completed",action:Kn,stage:Jr,ingestionContractVersion:1,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,excelRecords:e.records,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs},{action:Kn,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs,scanPolicy:{budgets:e.budgets,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerRow:e.table.headerRow,dataStartRow:e.table.dataStartRow,columnMapping:hp(e.mapping,e.table)},summary:{sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerCount:e.table.headers.length,scannedRows:e.table.rows.length,scannedCells:e.table.scannedCells,excelRows:e.records.length,excelRecordCount:e.records.length,emptyExcelRows:e.table.rows.length-e.records.length,formulaCachedValueCount:e.table.formulaCachedValueCount,formulaWithoutCachedValueCount:e.table.formulaWithoutCachedValueCount,partial:r,scanStoppedReason:o},evidenceRows:a,warnings:t,notices:n,lastRead:{lastReadRow:e.table.lastReadRow,lastReadColumn:e.table.lastReadColumn,lastReadItemId:e.records.length>0?e.records[e.records.length-1].excelRowId:null}})}function hp(e,t){let n={};for(let r of Wr){let o=e[r];typeof o=="number"&&(n[r]=t.headers[o]||St(t.startColumn+o))}return n}function St(e){let t=Math.max(1,Math.floor(e)),n="";for(;t>0;){let r=(t-1)%26;n=String.fromCharCode(65+r)+n,t=Math.floor((t-1)/26)}return n}function oa(e){let t=e.trim().toUpperCase();if(!/^[A-Z]+$/.test(t))return null;let n=0;for(let r of t)n=n*26+(r.charCodeAt(0)-64);return n}function ks(e,t){if(!e)return t;let n=e.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/);if(!n)return null;let r=oa(n[1]),o=Number(n[2]),a=n[3]?oa(n[3]):r,i=n[4]?Number(n[4]):o;return!r||!a||o<1||i<o||a<r?null:{startRow:o,startColumn:r,endRow:i,endColumn:a}}function fp(e,t,n,r){return`${St(t)}${e}:${St(r)}${n}`}function gp(e){return yt(e).length===0}function yp(e){return e.every(t=>gp(t.text))}function Sp(e,t){let n=new Map;return e.map((r,o)=>{let a=`Column ${St(t+o)}`,i=yt(r.text)||a,s=Hr(i)||Hr(a),l=n.get(s)||0;return n.set(s,l+1),l===0?i:`${i} ${l+1}`})}function Gr(e){if(e==null)return"";if(e instanceof Date)return Number.isNaN(e.getTime())?"":e.toISOString();if(typeof e=="object"){let t=e;return Array.isArray(t.richText)?yt(t.richText.map(n=>String(n.text??"")).join("")):t.text!==void 0?yt(t.text):t.result!==void 0?Gr(t.result):""}return yt(e)}function bp(e,t,n,r){let o=Gt.utils.encode_cell({r:t-1,c:n-1}),a=`${r}!${o}`,i=e[o];if(!i)return{value:"",text:"",address:a};if(typeof i.f=="string"&&i.f.length>0)return i.v!==void 0&&i.v!==null&&!(typeof i.v=="string"&&i.v.length===0&&(i.w===void 0||i.w===""))?{value:i.v,text:Gr(i.v)||yt(i.w),address:a,formulaWithCachedValue:!0}:{value:"",text:"",address:a,formulaWithoutCachedValue:!0};let l=i.v??"";return{value:l,text:Gr(l)||yt(i.w),address:a}}function wp(e,t,n,r){return{value:e,text:Gr(e),address:`${r}!${St(n)}${t}`}}function xp(e,t){return ra.now()-e>t.maxElapsedMs}function vp(e,t,n){let r=[],o=[],a={},i=new Set,s=new Set;for(let u of Wr){let m=n?.[u];if(m!==void 0){let p=Tp(m,e,t);if(p===null)return{error:{role:u,reason:"unresolved_column_ref",value:m}};a[u]=p,i.add(p),s.add(u)}}for(let u of Wr){if(a[u]!==void 0)continue;let m=Os(u,e);if(m.length===0)continue;let p=Rp(m,i);if(p.kind==="ambiguous")return{error:{role:u,reason:"ambiguous_alias",candidates:p.candidates}};p.kind==="resolved"&&(a[u]=p.match.index,i.add(p.match.index))}for(let u of Ur)if(a[u]===void 0)return{error:{role:u,reason:"missing_required_role"}};let l=Ur.filter(u=>!s.has(u));if(l.length>0){let u=l.map(m=>`${m}=${e[a[m]]||St(t+a[m])}`).join(", ");o.push(`column_mapping_inferred_from_headers: ${u}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`)}return{mapping:a,warnings:r,notices:o}}function _p(e,t){let n={},r={},o=new Set;for(let a of Ur){let i=Os(a,e).filter(s=>!o.has(s.index)).sort((s,l)=>s.priority-l.priority||s.index-l.index);n[a]=i.map(s=>({header:s.header,column:St(t+s.index),priority:s.priority})),i.length>0&&(r[a]=i[0].header,o.add(i[0].index))}return{requiredRoles:Ur,candidates:n,suggestedColumnMapping:r}}function Cp(e,t){let n=Is(t),r=sp[e];for(let o=0;o<r.length;o++)if(Is(r[o])===n)return o;return Number.POSITIVE_INFINITY}function Os(e,t){return t.map((n,r)=>({header:n,index:r,priority:Cp(e,n)})).filter(n=>Number.isFinite(n.priority))}function Rp(e,t){let n=e.filter(i=>!t.has(i.index)),r=n.length>0?n:e,o=Math.min(...r.map(i=>i.priority)),a=r.filter(i=>i.priority===o);return a.length===1?{kind:"resolved",match:a[0]}:{kind:"ambiguous",candidates:a.map(i=>i.header)}}function Tp(e,t,n){if(typeof e=="number"){let s=e-1;return s>=0&&s<t.length?s:null}let r=e.trim(),o=Hr(r),a=t.map((s,l)=>({header:s,index:l})).filter(s=>Hr(s.header)===o);if(a.length===1)return a[0].index;let i=oa(r);if(i!==null){let s=i-n;return s>=0&&s<t.length?s:null}return null}function Ip(e,t){let n=[];for(let r of e.rows){if(yp(r.cells))continue;let o={};for(let[p,g]of e.headers.entries())o[g]=r.cells[p]?.text??"";let a={};for(let p of Wr){let g=t[p];typeof g=="number"&&(a[p]=r.cells[g]?.text??"")}let i=yt(a.identity),s=yt(a.comparisonText),l=Sn([i,s]),u=l.normalizedKey,m=`${e.sheetName}!${r.rowNumber}`;n.push({excelRowId:m,sheetName:e.sheetName,rowNumber:r.rowNumber,sourceRange:e.sourceRange,rawValues:o,mappedValues:a,identityText:i,comparisonText:s,normalizedKey:u,tokenProfile:l})}return n}async function Ep(e,t,n){let r=Gt.readFile(e.path,{cellDates:!0,cellFormula:!0,cellText:!0,nodim:!0}),o=r.SheetNames.map(m=>({name:m,worksheet:r.Sheets[m]||{}})),a=e.selection||{},i=!!(a.sheetName||a.sheetIndex),s=o.filter(m=>Ap(m.worksheet));if(!i&&o.length>t.maxSheets&&s.length!==1)return Ht("max_items","Workbook sheet count exceeds maxSheets and cannot be auto-scoped to one non-empty sheet. Provide sheetName or sheetIndex.",{partial:!0,scanStoppedReason:"max_items",summary:{workbookSheets:o.length,nonEmptySheets:s.length,maxSheets:t.maxSheets},scanPolicy:{budgets:t},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex","excel.budgets.maxSheets"]});let l=Np(r,a,s);if(!l)return Ht("excel_sheet_selection_required","Select a worksheet with sheetName or 1-based sheetIndex.",{summary:{workbookSheets:o.length,sheetNames:o.map(m=>m.name)},scanPolicy:{budgets:t,selection:a},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex"]});let u=Mp(l,a,t,n);return!i&&s.length===1&&u.notices.push("Selected the only non-empty worksheet."),u}function Np(e,t,n){if(t.sheetName){let r=e.Sheets[t.sheetName];return r?{name:t.sheetName,worksheet:r}:null}if(t.sheetIndex){let r=e.SheetNames[t.sheetIndex-1];return r&&e.Sheets[r]?{name:r,worksheet:e.Sheets[r]}:null}return n.length===1?n[0]:null}function Mp(e,t,n,r){let o=kp(e.worksheet);return Ls({sheetName:e.name,fallbackRange:o,selection:t,budgets:n,startedAt:r,readCell:(a,i)=>bp(e.worksheet,a,i,e.name)})}function Ap(e){return Object.keys(e).some(t=>!t.startsWith("!"))}function kp(e){let t=Number.POSITIVE_INFINITY,n=Number.POSITIVE_INFINITY,r=1,o=1;for(let a of Object.keys(e))if(!a.startsWith("!"))try{let i=Gt.utils.decode_cell(a);t=Math.min(t,i.r+1),n=Math.min(n,i.c+1),r=Math.max(r,i.r+1),o=Math.max(o,i.c+1)}catch{continue}return!Number.isFinite(t)||!Number.isFinite(n)?{startRow:1,startColumn:1,endRow:1,endColumn:1}:{startRow:t,startColumn:n,endRow:r,endColumn:o}}async function Op(e,t,n,r){let o=await Es.readFile(e.path,"utf8"),a=Pp(e.selection||{},t),i=ip(o,{bom:!0,delimiter:r==="tsv"?"	":",",relax_column_count:!0,skip_empty_lines:!1,to:a.recordLimit+1}),s=i.length>a.recordLimit?{partial:!0,scanStoppedReason:a.scanStoppedReason}:void 0,l=s?i.slice(0,a.recordLimit):i,u=e.selection?.sheetName||(r==="tsv"?"TSV":"CSV");return Ps(l,u,e.selection||{},t,n,s)}function Pp(e,t){let r=ks(e.range,{startRow:1,startColumn:1,endRow:1,endColumn:1})?.startRow||1,o=e.headerRow||r,a=e.dataStartRow||o+1;return{recordLimit:Math.max(r,o,a+t.maxRows-1),scanStoppedReason:"max_rows"}}function Lp(e,t,n){let r=e.sheetName||"Rows",o=Vp(e.rows),a=e.selection?.headerRow||1,i=e.selection?.dataStartRow||a+1,s=[];for(;s.length<a-1;)s.push([]);for(s.push(o);s.length<i-1;)s.push([]);for(let l of e.rows)s.push(o.map(u=>l[u]));return Ps(s,r,{headerRow:a,dataStartRow:i},t,n)}function Vp(e){let t=[],n=new Set;for(let r of e)for(let o of Object.keys(r))n.has(o)||(n.add(o),t.push(o));return t}function Ps(e,t,n,r,o,a){let i=e.reduce((l,u)=>Math.max(l,u.length),1),s={startRow:1,startColumn:1,endRow:Math.max(e.length,1),endColumn:Math.max(i,1)};return Ls({sheetName:t,fallbackRange:s,selection:n,budgets:r,startedAt:o,prelimited:a,readCell:(l,u)=>wp(e[l-1]?.[u-1],l,u,t)})}function Ls(e){let t=ks(e.selection.range,e.fallbackRange);if(!t)throw new Error(`Invalid range selection: ${e.selection.range}`);let n=e.selection.headerRow||t.startRow,r=e.selection.dataStartRow||n+1;if(r<=n)throw new Error("dataStartRow must be greater than headerRow.");let o=t.endColumn,a=e.prelimited?.partial||!1,i=e.prelimited?.scanStoppedReason||"completed";o-t.startColumn+1>e.budgets.maxColumns&&(o=t.startColumn+e.budgets.maxColumns-1,a=!0,i="max_columns");let s=[],l=0,u=0,m=0,p=[],g=[];for(let A=t.startColumn;A<=o;A++){let T=e.readCell(n,A);s.push(T),l++,T.formulaWithCachedValue&&u++,T.formulaWithoutCachedValue&&(m++,p.push(`Formula cell ${T.address||`${e.sheetName}!${St(A)}${n}`} has no cached value and was read as blank.`))}let h=Sp(s,t.startColumn),w=[],_=null,L=null,R=Math.max(r,t.startRow);for(let A=R;A<=t.endRow;A++){if(w.length>=e.budgets.maxRows){a=!0,i=i==="completed"?"max_rows":i;break}if(xp(e.startedAt,e.budgets)){a=!0,i="max_elapsed";break}if(l+h.length>e.budgets.maxCells){a=!0,i=i==="completed"?"max_cells":i;break}let T=[];for(let j=t.startColumn;j<=o;j++){let z=e.readCell(A,j);T.push(z),l++,_=A,L=j,z.formulaWithCachedValue&&u++,z.formulaWithoutCachedValue&&(m++,p.push(`Formula cell ${z.address||`${e.sheetName}!${St(j)}${A}`} has no cached value and was read as blank.`))}w.push({rowNumber:A,cells:T})}return{sheetName:e.sheetName,sourceRange:fp(t.startRow,t.startColumn,t.endRow,o),headerRow:n,dataStartRow:r,startColumn:t.startColumn,headers:h,rows:w,notices:g,warnings:p,formulaCachedValueCount:u,formulaWithoutCachedValueCount:m,scannedCells:l,partial:a,scanStoppedReason:i,lastReadRow:_,lastReadColumn:L}}function Dp(e){return!!(e&&typeof e=="object"&&e.action===Kn&&e.stage===Jr)}async function Vs(e){let t=ra.now(),n=aa.safeParse(e);if(!n.success)return Ht("needs_scope","Excel ingestion input failed schema validation.",{validationIssues:n.error.issues.map(a=>`${a.path.join(".")||"<root>"}: ${a.message}`),suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"]});let r=n.data,o=dp(r.budgets);try{let a=await Fp(r,o,t);if(Dp(a))return a;let i=a,s=vp(i.headers,i.startColumn,r.columnMapping);if("error"in s)return Ht("excel_column_mapping_required","Resolve identity and comparisonText column mapping before ingestion.",{mappingError:s.error,mappingSuggestion:_p(i.headers,i.startColumn),summary:{sheetName:i.sheetName,headers:i.headers},scanPolicy:{budgets:o},suggestedNextScopes:["excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:i.warnings,notices:i.notices});let l=Ip(i,s.mapping);return pp({sourceKind:r.kind,format:r.kind==="file"?As(r.path,r.format):"rows",table:i,records:l,budgets:o,mapping:s.mapping,mappingNotices:s.notices,mappingWarnings:s.warnings,elapsedMs:ra.now()-t})}catch(a){return mp(a instanceof Error?a.message:String(a),{scanPolicy:{budgets:o}})}}async function Fp(e,t,n){if(e.kind==="rows")return Lp(e,t,n);let r=As(e.path,e.format);if(r==="xls")return Ht("unsupported_excel_format",".xls is not supported. Save the workbook as .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});if(r==="unsupported")return Ht("unsupported_excel_format","Unsupported spreadsheet format. Use .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});let o=await Es.stat(e.path);return o.size>t.maxWorkbookBytes?Ht("max_bytes","Workbook exceeds maxWorkbookBytes.",{format:r,partial:!0,scanStoppedReason:"max_bytes",summary:{workbookBytes:o.size,maxWorkbookBytes:t.maxWorkbookBytes},scanPolicy:{budgets:t},suggestedNextScopes:["excel.budgets.maxWorkbookBytes","excel.selection.sheetName","excel.selection.range"]}):r==="xlsx"?Ep(e,t,n):Op(e,t,n,r)}import{z as v}from"zod";var $r="reconcile_schedule_records",sa="schedule_record_adapter",It="displayedScheduleCells",jp=["body"],ia=qr,Bs=Br,Bp=zr,qp=v.object({column:v.number().int().nonnegative(),header:v.string().min(1)}).strict(),qs=v.union([v.array(v.string()),v.array(qp),v.record(v.union([v.string().min(1),v.number().int().nonnegative()]))]),zs=v.enum(["auto","always","never"]),Us=v.object({identity:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),comparisonText:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),code:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),description:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),quantity:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),unit:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),system:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),discipline:v.union([v.string().min(1),v.number().int().nonnegative()]).optional(),notes:v.union([v.string().min(1),v.number().int().nonnegative()]).optional()}).strict(),zp=v.object({kind:v.literal("inspect_schedules_result"),result:v.record(v.unknown()),columnMapping:Us.optional(),columnHeaders:qs.optional(),sections:v.array(v.enum(["header","body","footer"])).optional(),headerDataMode:zs.optional()}).strict(),Up=v.object({kind:v.literal("revit_schedule"),scheduleIds:v.array(v.union([v.number().int().positive(),v.string().min(1)])).optional(),nameQuery:v.string().min(1).optional(),sections:v.array(v.enum(["header","body","footer"])).optional(),columnMapping:Us.optional(),columnHeaders:qs.optional(),headerDataMode:zs.optional(),target:v.string().optional(),host:v.string().optional(),port:v.number().int().positive().max(65535).optional(),taskName:v.string().optional(),taskId:v.string().optional(),parentTaskName:v.string().optional(),parentTaskId:v.string().optional(),allowExpensiveSearch:v.boolean().optional(),searchBudget:v.enum(["fast","balanced","deep"]).optional(),maxElapsedMs:v.number().int().positive().max(119e3).optional(),maxSchedules:v.number().int().positive().max(200).optional(),maxRowsPerSection:v.number().int().min(0).max(1e3).optional(),maxColumnsPerSection:v.number().int().min(0).max(200).optional(),startRow:v.number().int().min(0).max(1e5).optional(),startColumn:v.number().int().min(0).max(1e4).optional(),maxCells:v.number().int().positive().max(5e5).optional(),maxResponseBytes:v.number().int().min(4096).max(16*1024*1024).optional(),maxCellTextChars:v.number().int().min(20).max(1e3).optional(),timeoutMs:v.number().int().positive().max(12e4).optional()}).strict(),la=v.discriminatedUnion("kind",[zp,Up]);async function Ws(e,t={}){let n=Date.now(),r=la.safeParse(e);return r.success?r.data.kind==="revit_schedule"?Wp(r.data,n,t):Hs(r.data,Date.now()-n):Xr("needs_scope","Schedule adapter input failed schema validation.",{validationIssues:r.error.issues.map(o=>`${o.path.join(".")||"<root>"}: ${o.message}`),elapsedMs:Date.now()-n,suggestedNextScopes:["schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]})}async function Wp(e,t,n){if(!!!(Array.isArray(e.scheduleIds)&&e.scheduleIds.length>0||String(e.nameQuery||"").trim())&&e.allowExpensiveSearch!==!0)return Xr("needs_scope","Direct live schedule reconciliation requires scheduleIds or nameQuery. Set allowExpensiveSearch=true only when a broad schedule scan is intentional.",{sourceKind:e.kind,elapsedMs:Date.now()-t,suggestedNextScopes:["schedule.scheduleIds","schedule.nameQuery","schedule.allowExpensiveSearch=true"],scanPolicy:{sourceKind:e.kind,bridgeExecution:"inspect_schedules",scheduleIds:[],nameQuery:null,allowExpensiveSearch:!1,visibilityBasis:It}});let a=["header",...Js(e.sections).filter(g=>g!=="header")],i={query:e.nameQuery,nameQuery:e.nameQuery,scheduleIds:e.scheduleIds,sections:a,includeCells:!0,scanCells:!1,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:e.searchBudget,maxElapsedMs:e.maxElapsedMs,maxSchedules:e.maxSchedules,maxRowsPerSection:e.maxRowsPerSection,maxColumnsPerSection:e.maxColumnsPerSection,startRow:e.startRow,startColumn:e.startColumn,maxCells:e.maxCells,maxResponseBytes:e.maxResponseBytes,maxCellTextChars:e.maxCellTextChars,responseMode:"full",timeoutMs:e.timeoutMs,taskName:e.taskName||"Inspect live Revit schedule for reconciliation",taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId},l=await(n.sendCommand||D)("inspect_schedules",i,{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs,taskName:i.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,toolName:"reconcile_schedule_excel"}),u=Date.now()-t,m=na(l&&l.result?l.result:l,i,u),p=Hs({kind:"inspect_schedules_result",result:m,columnMapping:e.columnMapping,columnHeaders:e.columnHeaders,sections:e.sections,headerDataMode:e.headerDataMode},u);return p.sourceKind="revit_schedule",p.bridgeSourceKind="inspect_schedules_result",p.scanPolicy={...p.scanPolicy||{},sourceKind:"revit_schedule",bridgeExecution:"inspect_schedules",inspectSections:a,scheduleIds:e.scheduleIds||[],nameQuery:e.nameQuery||null,allowExpensiveSearch:e.allowExpensiveSearch===!0},p.notices=[...Jt(p,"notices"),"Live Revit schedule input was read through bounded inspect_schedules before reconciliation."],p}function Hs(e,t){let n=e.result,r=ee(c(n,"state")).toLowerCase();if(c(n,"success")===!1||r==="failed"||c(n,"error"))return th(ee(c(n,"error"))||"inspect_schedules_result failed before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:Jt(n,"warnings"),notices:Jt(n,"notices")});if(c(n,"guarded")===!0)return Xr(ee(c(n,"reason"))||"needs_scope","inspect_schedules_result was guarded before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:Jt(n,"warnings"),notices:Jt(n,"notices"),summary:c(n,"summary")||{},suggestedNextScopes:['inspect_schedules responseMode="full"',"schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let o=Js(e.sections),a=Array.isArray(e.sections)&&e.sections.length>0,i=$s(e.headerDataMode),s=k(n,"schedules"),l=Jt(n,"warnings"),u=Jt(n,"notices"),m=[],p=0,g=0,h=0,w=0,_=0;for(let T of s){let j=ua(c(T,"id"));if(!j){l.push("Skipped a schedule without id while adapting schedule records.");continue}let z=Yr(c(T,"name")),J=$p(T,e.columnHeaders),y=Yp(J,e.columnMapping);if("error"in y)return Xr("schedule_column_mapping_required","Resolve identity and comparisonText schedule column mapping before adaptation.",{sourceKind:e.kind,scheduleId:j,scheduleName:z,mappingError:y.error,summary:{scheduleId:j,scheduleName:z,headers:J.map(W=>({column:W.column,header:W.header}))},scanPolicy:js(e,o),suggestedNextScopes:["schedule.columnMapping.identity","schedule.columnMapping.comparisonText",'inspect_schedules responseMode="full"'],warnings:l,notices:u});let B=Jp(T,o,a,i);B.headerAsData&&w++;for(let W of k(T,"sections")){let se=Kr(c(W,"section"));if(!B.sections.includes(se))continue;let de=se==="header"&&B.headerAsData;for(let Re of ca(W,j,z,se)){if(p++,g+=Re.cells.length,de&&Hp(Re,z)){h++;continue}if(se==="body"&&Ds(Re,y.mapping,J,{matchSameColumnHeader:!0})){h++;continue}if(de&&Ds(Re,y.mapping,J,{matchSameColumnHeader:!1})){h++;continue}let Ee=Gp(Re,y.mapping);Ee&&(de&&_++,m.push(Ee))}}}let L=c(n,"partial")===!0,R=Jn(c(n,"scanStoppedReason"),L?"max_items":"completed"),A=m.length>0?m[m.length-1]:null;return be({success:!0,guarded:!1,state:"completed",action:$r,stage:sa,adapterContractVersion:1,sourceKind:e.kind,visibilityBasis:It,scheduleRecords:m,partial:L,scanStoppedReason:R,elapsedMs:t},{action:$r,partial:L,scanStoppedReason:R,elapsedMs:t,scanPolicy:js(e,o),summary:{sourceKind:e.kind,scheduleCount:s.length,scannedRows:p,scannedCells:g,skippedHeaderLikeRows:h,headerAsDataScheduleCount:w,headerAsDataRows:_,scheduleRecordCount:m.length,visibilityBasis:It,partial:L,scanStoppedReason:R},evidenceRows:m.map(T=>({sourceType:"scheduleRecord",scheduleRowId:T.scheduleRowId,scheduleId:T.scheduleId,scheduleName:T.scheduleName,section:T.section,row:T.row,identityText:T.identityText,comparisonText:T.comparisonText,normalizedKey:T.normalizedKey,visibilityBasis:It})),warnings:l,notices:[...u,...w>0?[`Read Header section rows as schedule data for ${w} schedule(s).`]:[],...h>0?[`Skipped ${h} header-like schedule row(s) during schedule adaptation.`]:[]],lastRead:{lastReadSection:c(n,"lastReadSection")??A?.section??null,lastReadRow:c(n,"lastReadRow")??A?.row??null,lastReadColumn:c(n,"lastReadColumn")??null,lastReadItemId:c(n,"lastReadItemId")??A?.scheduleRowId??null}})}function Ds(e,t,n,r){let o=new Map;for(let s of e.cells)o.set(s.column,s.text);let a=Bs.filter(s=>typeof t[s]=="number");if(a.length===0)return!1;let i=new Map;for(let s of a){let l=t[s];typeof l=="number"&&i.set(l,[...i.get(l)||[],s])}return[...i.entries()].every(([s,l])=>{let u=ee(o.get(s));if(!u)return!1;let m=Qe(u);return r.matchSameColumnHeader&&n.some(g=>g.column===s&&Qe(g.header)===m)?!0:l.some(g=>Number.isFinite(Gs(g,u))||g==="identity"&&["number","no","numara"].includes(m)?!0:g==="comparisonText"&&["name","description","desc","text","aciklama"].includes(m))})}function Hp(e,t){let n=Qe(t||"");if(!n)return!1;let r=e.cells.map(o=>Qe(o.text)).filter(o=>o.length>0);return r.length===1&&r[0]===n}function Gp(e,t){let n=new Map;for(let s of e.cells)n.set(s.column,s.text);let r={};for(let s of ia){let l=t[s];typeof l=="number"&&(r[s]=ee(n.get(l)))}let o=ee(r.identity),a=ee(r.comparisonText);if(!o&&!a)return null;let i=Sn([o,a]);return{scheduleRowId:`${e.scheduleId}:${e.section}:${e.row}`,scheduleId:e.scheduleId,scheduleName:e.scheduleName,section:e.section,row:e.row,rawCells:e.cells.map(s=>({column:s.column,text:s.text})),mappedValues:r,identityText:o,comparisonText:a,normalizedKey:i.normalizedKey,tokenProfile:i,visibilityBasis:It}}function ca(e,t,n,r){let o=k(e,"rows"),a=k(e,"cells");return(o.length>0?o:a).flatMap(s=>{let l=Yn(c(s,"row"));if(l===null)return[];let u=k(s,"cells").map(m=>({column:Yn(c(m,"column")),text:ee(c(m,"text"))})).filter(m=>m.column!==null);return[{scheduleId:t,scheduleName:n,section:r,row:l,cells:u}]})}function Jp(e,t,n,r){return t.includes("header")?{sections:t,headerAsData:!0}:r==="never"?{sections:t,headerAsData:!1}:Fs(e,["header"])?r==="always"?{sections:[...t,"header"],headerAsData:!0}:!n&&!Fs(e,t)?{sections:[...t,"header"],headerAsData:!0}:{sections:t,headerAsData:!1}:{sections:t,headerAsData:!1}}function Fs(e,t){let n=ua(c(e,"id"))||"unknown",r=Yr(c(e,"name"));for(let o of k(e,"sections")){let a=Kr(c(o,"section"));if(t.includes(a)&&ca(o,n,r,a).some(i=>i.cells.length>0))return!0}return!1}function $p(e,t){let n=[],r=new Set,o=(a,i)=>{let s=ee(i);if(s.length===0)return;let l=`${a}:${Qe(s)}`;r.has(l)||(r.add(l),n.push({column:a,header:s}))};for(let a of Xp(e))o(a.column,a.header);for(let a of k(e,"sections"))if(Kr(c(a,"section"))==="header")for(let i of ca(a,ua(c(e,"id"))||"unknown",Yr(c(e,"name")),"header"))for(let s of i.cells)o(s.column,s.text);for(let a of Kp(t))o(a.column,a.header);return n.sort((a,i)=>a.column-i.column)}function Xp(e){let t=[],n=(r,o)=>{if(r===null)return;let a=ee(o);a.length>0&&t.push({column:r,header:a})};for(let r of k(e,"fields")){if(c(r,"isHidden")===!0)continue;let o=Yn(c(r,"column"))??Yn(c(r,"visibleColumn"));n(o,c(r,"columnHeading")),n(o,c(r,"heading")),n(o,c(r,"label")),n(o,c(r,"name")),n(o,c(r,"fieldName")),n(o,c(r,"parameterName"))}return t}function Kp(e){if(!e)return[];if(Array.isArray(e))return e.map((n,r)=>typeof n=="string"?{column:r,header:ee(n)}:{column:n.column,header:ee(n.header)}).filter(n=>n.header.length>0);let t=[];for(let[n,r]of Object.entries(e)){let o=Yn(n);if(o!==null&&typeof r=="string"){let a=ee(r);a.length>0&&t.push({column:o,header:a});continue}if(typeof r=="number"){let a=ee(n);a.length>0&&t.push({column:r,header:a})}}return t.sort((n,r)=>n.column-r.column)}function Yp(e,t){let n=[],r=[],o={},a=new Set;for(let i of ia){let s=t?.[i];if(s!==void 0){let l=Qp(s,e);if(l===null)return{error:{role:i,reason:"unresolved_column_ref",value:s}};o[i]=l,a.add(l)}}for(let i of ia){if(o[i]!==void 0)continue;let s=Zp(i,e);if(s.length===0)continue;let l=eh(s,a);if(l.kind==="ambiguous")return{error:{role:i,reason:"ambiguous_alias",candidates:l.candidates}};o[i]=l.match.column,a.add(l.match.column)}for(let i of Bs)if(o[i]===void 0)return{error:{role:i,reason:"missing_required_role"}};return{mapping:o,warnings:n,notices:r}}function Qp(e,t){if(typeof e=="number")return t.length>0&&!t.some(a=>a.column===e)?null:e;let n=e.trim(),r=Qe(n),o=t.filter(a=>Qe(a.header)===r);return o.length===1?o[0].column:null}function Gs(e,t){let n=Xn(t),r=Bp[e];for(let o=0;o<r.length;o++)if(Xn(r[o])===n)return o;return Number.POSITIVE_INFINITY}function Zp(e,t){return t.map(n=>({header:n.header,column:n.column,priority:Gs(e,n.header)})).filter(n=>Number.isFinite(n.priority))}function eh(e,t){let n=e.filter(s=>!t.has(s.column)),r=n.length>0?n:e,o=Math.min(...r.map(s=>s.priority)),a=r.filter(s=>s.priority===o);return a.length===1?{kind:"resolved",match:a[0]}:[...new Set(a.map(s=>s.column))].length===1?{kind:"resolved",match:a[0]}:{kind:"ambiguous",candidates:a.map(s=>s.header)}}function js(e,t){return{sourceKind:e.kind,sections:t,headerDataMode:$s(e.headerDataMode),columnMapping:e.columnMapping||null,numericColumnBase:"zero_based_revit_schedule_column",visibilityBasis:It}}function Xr(e,t,n={}){let{warnings:r=[],notices:o=[],elapsedMs:a,scanPolicy:i,summary:s,suggestedNextScopes:l=[],...u}=n;return Ve({action:$r,reason:e,message:t,elapsedMs:a,extra:{stage:sa,adapterContractVersion:1,visibilityBasis:It,...u},summary:s||{},evidenceRows:[],scanPolicy:i||{},suggestedNextScopes:l,warnings:r,notices:o})}function th(e,t={}){let{warnings:n=[],notices:r=[],elapsedMs:o,scanPolicy:a,summary:i,...s}=t;return Me({action:$r,error:e,elapsedMs:o,extra:{stage:sa,adapterContractVersion:1,visibilityBasis:It,...s},summary:i||{},evidenceRows:[],scanPolicy:a||{},warnings:n,notices:r})}function Js(e){let t=Array.isArray(e)&&e.length>0?e:jp;return[...new Set(t.map(Kr))].filter(n=>["header","body","footer"].includes(n))}function $s(e){return e==="always"||e==="never"?e:"auto"}function Kr(e){let t=ee(e).toLowerCase();return["header","body","footer"].includes(t)?t:"body"}function Jt(e,t){let n=c(e,t);return Array.isArray(n)?n.map(ee).filter(r=>r.length>0):[]}function Yn(e){if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function ua(e){return Yr(e)}function Yr(e){let t=ee(e);return t.length>0?t:null}import{z as U}from"zod";var Qn={score:{exact:100,diceTokenOverlap:35,code:20,dimension:20,order:15,context:10},thresholds:{highConfidenceMin:86,highConfidenceMax:99,candidateMin:65,possibleRenameMin:72,possibleRenameMax:85,ambiguousMin:65,ambiguousMax:71,candidateGap:8,tieGap:8},caps:{conflictingCode:64,conflictingDimension:60,unitMismatch:79},candidateGeneration:{minSharedSignificantWordTokens:2},contextFields:["system","unit","quantity","discipline"]},nh=U.object({exact:U.number().min(0).max(100).optional(),diceTokenOverlap:U.number().min(0).max(100).optional(),code:U.number().min(0).max(100).optional(),dimension:U.number().min(0).max(100).optional(),order:U.number().min(0).max(100).optional(),context:U.number().min(0).max(100).optional()}).strict(),rh=U.object({highConfidenceMin:U.number().min(0).max(100).optional(),highConfidenceMax:U.number().min(0).max(100).optional(),candidateMin:U.number().min(0).max(100).optional(),possibleRenameMin:U.number().min(0).max(100).optional(),possibleRenameMax:U.number().min(0).max(100).optional(),ambiguousMin:U.number().min(0).max(100).optional(),ambiguousMax:U.number().min(0).max(100).optional(),candidateGap:U.number().min(0).max(100).optional(),tieGap:U.number().min(0).max(100).optional()}).strict(),oh=U.object({conflictingCode:U.number().min(0).max(100).optional(),conflictingDimension:U.number().min(0).max(100).optional(),unitMismatch:U.number().min(0).max(100).optional()}).strict(),ah=U.object({minSharedSignificantWordTokens:U.number().int().min(0).max(20).optional()}).strict(),Zr=U.object({score:nh.optional(),thresholds:rh.optional(),caps:oh.optional(),candidateGeneration:ah.optional(),contextFields:U.array(U.string().min(1)).optional()}).strict(),ih=U.object({excelRecords:U.array(U.record(U.unknown())).optional(),scheduleRecords:U.array(U.record(U.unknown())).optional(),excelResult:U.record(U.unknown()).optional(),scheduleResult:U.record(U.unknown()).optional(),config:Zr.optional()}).strict();function el(e){let t=Date.now(),n=ih.safeParse(e);if(!n.success)return be({success:!0,guarded:!0,state:"guarded",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,reason:"reconciliation_input_required",message:"Provide excelRecords and scheduleRecords, or normalized ingestion result envelopes containing those arrays.",validationIssues:n.error.issues.map(l=>l.message),partial:!1,scanStoppedReason:"needs_scope"},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"needs_scope",elapsedMs:Date.now()-t,summary:{},evidenceRows:[]});let r=yh(n.data.config),o=Xs("excel",n.data.excelRecords??Ks(n.data.excelResult,"excelRecords")),a=Xs("schedule",n.data.scheduleRecords??Ks(n.data.scheduleResult,"scheduleRecords")),i=sh(o,a,r),s=Sh(o,a,i);return be({success:!0,guarded:!1,state:"review_ready",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,partial:!1,scanStoppedReason:"completed",reviewRows:i,reviewTable:bh(i),suggestedNextActions:["review_ambiguous","accept_match","create_schedule_row","remove_or_ignore_schedule_row","rename_excel_or_schedule_text"],scoringConfig:r},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"completed",elapsedMs:Date.now()-t,summary:s,evidenceRows:i.map(l=>({sourceType:"reconciliationReviewRow",bucket:l.bucket,score:l.score,excelRowId:l.excelRow?.excelRowId??l.excelRow?.recordId??null,scheduleRowId:l.scheduleRow?.scheduleRowId??l.scheduleRow?.recordId??null,reason:l.reason}))})}function sh(e,t,n){let r=[],o=new Set,a=new Set,i=Zs(e),s=Zs(t);for(let l of e){let u=ch(l,t,n),m=l.normalizedKey.length>0&&(i.has(l.normalizedKey)||s.has(l.normalizedKey)),p=u[0]||null;if(m&&u.some(h=>h.score===n.score.exact||h.schedule.normalizedKey===l.normalizedKey)){let h=u.filter(w=>w.schedule.normalizedKey===l.normalizedKey||w.score>=n.thresholds.candidateMin).slice(0,5);r.push(da("ambiguousMatches",h[0]||null,l,null,h,"duplicate_exact_key","review_ambiguous")),o.add(l.id),h.forEach(w=>a.add(w.schedule.id));continue}if(!p||p.score<n.thresholds.candidateMin&&p.hardConflicts.length===0){r.push(ph(l)),o.add(l.id);continue}if(a.has(p.schedule.id)){r.push(da("ambiguousMatches",p,l,p.schedule,u.slice(0,5),"schedule_row_already_claimed","review_ambiguous")),o.add(l.id);continue}let g=lh(p,u[1]||null,n);r.push(da(g.bucket,p,l,p.schedule,u.slice(0,5),g.reason,g.action)),o.add(l.id),a.add(p.schedule.id),g.bucket==="ambiguousMatches"&&u.filter(h=>h.score>=n.thresholds.candidateMin).slice(0,5).forEach(h=>a.add(h.schedule.id))}for(let l of t)a.has(l.id)||r.push(hh(l));return r.sort(Th)}function lh(e,t,n){let r=t?e.score-t.score:Number.POSITIVE_INFINITY,o=t!==null&&e.score===t.score;if(o||r<n.thresholds.tieGap||e.score>=n.thresholds.ambiguousMin&&e.score<=n.thresholds.ambiguousMax)return{bucket:"ambiguousMatches",reason:o?"best_score_tie":r<n.thresholds.tieGap?"candidate_gap_below_threshold":"ambiguous_score_band",action:"review_ambiguous"};if(e.components.exact>0&&e.hardConflicts.length===0&&e.score===n.score.exact)return{bucket:"exactMatches",reason:"exact_normalized_key",action:"accept_match"};let a=(e.sharedCodeTokens.length>0||e.sharedDimensionTokens.length>0)&&e.descriptiveTokensDiffer;return!e.hardConflicts.length&&e.score>=n.thresholds.highConfidenceMin&&a?{bucket:"possibleRenames",reason:"shared_key_tokens_with_description_change",action:"rename_excel_or_schedule_text"}:e.score>=n.thresholds.highConfidenceMin&&e.score<=n.thresholds.highConfidenceMax&&!e.capped&&r>=n.thresholds.candidateGap?{bucket:"highConfidenceMatches",reason:"high_confidence_score_and_gap",action:"accept_match"}:!e.hardConflicts.length&&(e.score>=n.thresholds.highConfidenceMin&&a||e.score>=n.thresholds.possibleRenameMin&&e.score<=n.thresholds.possibleRenameMax)?{bucket:"possibleRenames",reason:a?"shared_key_tokens_with_description_change":"possible_rename_score_band",action:"rename_excel_or_schedule_text"}:{bucket:"ambiguousMatches",reason:e.hardConflicts.length>0?"hard_conflict_requires_review":"requires_review",action:"review_ambiguous"}}function ch(e,t,n){return t.filter(r=>uh(e,r,n)).map(r=>({...dh(e,r,n),excel:e,schedule:r})).sort(Rh)}function uh(e,t,n){return e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey||Ze(ae(e,"code"),ae(t,"code")).length>0||Ze(ae(e,"dimension"),ae(t,"dimension")).length>0?!0:Ze(ae(e,"word"),ae(t,"word")).length>=n.candidateGeneration.minSharedSignificantWordTokens}function dh(e,t,n){let r=e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey,o=vn(e.tokenProfile.tokens.map(w=>w.value)),a=vn(t.tokenProfile.tokens.map(w=>w.value)),i=Ze(o,a),s=vn(o.concat(a).filter(w=>!i.includes(w))),l=Ze(ae(e,"code"),ae(t,"code")),u=Ze(ae(e,"dimension"),ae(t,"dimension")),m=mh(e,t),p={exact:r?n.score.exact:0,dice:r?0:Qr(xh(o,a)*n.score.diceTokenOverlap),code:r?0:Qs(ae(e,"code"),ae(t,"code"),n.score.code),dimension:r?0:Qs(ae(e,"dimension"),ae(t,"dimension"),n.score.dimension),order:r?0:Qr(vh(o,a)*n.score.order),context:r?0:wh(e,t,n)},g=r?n.score.exact:ma(p.dice+p.code+p.dimension+p.order+p.context),h=g;for(let w of m)w==="conflicting_code"&&(h=Math.min(h,n.caps.conflictingCode)),w==="conflicting_dimension"&&(h=Math.min(h,n.caps.conflictingDimension)),w==="unit_mismatch"&&(h=Math.min(h,n.caps.unitMismatch));return{score:ma(h),rawScore:ma(g),components:p,matchedTokens:i,differingTokens:s,hardConflicts:m,sharedCodeTokens:l,sharedDimensionTokens:u,descriptiveTokensDiffer:Ch(e,t),capped:h<g}}function mh(e,t){let n=[],r=ae(e,"code"),o=ae(t,"code");r.length>0&&o.length>0&&Ze(r,o).length===0&&n.push("conflicting_code");let a=ae(e,"dimension"),i=ae(t,"dimension");a.length>0&&i.length>0&&Ze(a,i).length===0&&n.push("conflicting_dimension");let s=Ys(e),l=Ys(t);return s.length>0&&l.length>0&&Ze(s,l).length===0&&n.push("unit_mismatch"),n}function da(e,t,n,r,o,a,i){return{bucket:e,score:t?.score??0,rawScore:t?.rawScore??0,reason:a,matchedTokens:t?.matchedTokens??[],differingTokens:t?.differingTokens??[],hardConflicts:t?.hardConflicts??[],scoreComponents:t?.components??null,excelRow:n?Zn(n):null,scheduleRow:r?Zn(r):null,candidateRows:o.map(s=>({score:s.score,rawScore:s.rawScore,scheduleRow:Zn(s.schedule),matchedTokens:s.matchedTokens,hardConflicts:s.hardConflicts})),recommendedNextAction:i}}function ph(e){return{bucket:"missingInSchedule",score:0,rawScore:0,reason:"no_schedule_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:Zn(e),scheduleRow:null,candidateRows:[],recommendedNextAction:"create_schedule_row"}}function hh(e){return{bucket:"missingInExcel",score:0,rawScore:0,reason:"no_excel_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:null,scheduleRow:Zn(e),candidateRows:[],recommendedNextAction:"remove_or_ignore_schedule_row"}}function Zn(e){return{...e.raw,recordId:e.id,normalizedKey:e.normalizedKey,tokenProfile:e.tokenProfile}}function Xs(e,t){return Array.isArray(t)?t.filter(n=>!!n&&typeof n=="object"&&!Array.isArray(n)).map((n,r)=>fh(e,n,r)):[]}function fh(e,t,n=0){let r=e==="excel"?ee(t.excelRowId||t.recordId||t.id):ee(t.scheduleRowId||t.recordId||t.id),o=er(t.mappedValues)?t.mappedValues:{},a=gh(t,[t.identityText,t.comparisonText]);return{side:e,id:r||`${e}:${a.normalizedKey||"row"}:${n}`,normalizedKey:ee(t.normalizedKey)||a.normalizedKey,tokenProfile:a,raw:t,mappedValues:o}}function gh(e,t){let n=er(e.tokenProfile)?e.tokenProfile:null;return n&&Array.isArray(n.tokens)&&typeof n.normalizedKey=="string"?{profileVersion:1,normalizedKey:ee(n.normalizedKey),tokens:n.tokens.filter(r=>er(r)&&typeof r.type=="string"&&typeof r.value=="string").map(r=>({type:r.type,value:ee(r.value)})).filter(r=>r.value.length>0)}:Sn(t)}function Ks(e,t){return er(e)&&Array.isArray(e[t])?e[t].filter(n=>er(n)):[]}function yh(e){let t=Zr.safeParse(e||{}),n=t.success?t.data:{};return{score:{...Qn.score,...n.score||{}},thresholds:{...Qn.thresholds,...n.thresholds||{}},caps:{...Qn.caps,...n.caps||{}},candidateGeneration:{...Qn.candidateGeneration,...n.candidateGeneration||{}},contextFields:n.contextFields||Qn.contextFields}}function Sh(e,t,n){let r=Object.fromEntries(["exactMatches","highConfidenceMatches","possibleRenames","ambiguousMatches","missingInSchedule","missingInExcel"].map(o=>[o,0]));for(let o of n)r[o.bucket]=(r[o.bucket]||0)+1;return{excelRows:e.length,scheduleRows:t.length,...r,reviewRowCount:n.length}}function bh(e){return{columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}],rows:e.map(n=>({bucket:n.bucket,score:n.score,reason:n.reason,excelRowId:n.excelRow?.excelRowId??n.excelRow?.recordId??"",scheduleRowId:n.scheduleRow?.scheduleRowId??n.scheduleRow?.recordId??"",excelText:n.excelRow?[n.excelRow.identityText,n.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:n.scheduleRow?[n.scheduleRow.identityText,n.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:(n.hardConflicts||[]).join(", "),recommendedNextAction:n.recommendedNextAction}))}}function ae(e,t){return vn(e.tokenProfile.tokens.filter(n=>n.type===t).map(n=>n.value))}function Ys(e){let t=ae(e,"unit");for(let r of ae(e,"dimension")){let o=r.match(/^[A-Z]+|[A-Z]+$/)?.[0];o&&t.push(o)}let n=yn(e.mappedValues.unit);return n&&t.push(n),vn(t)}function Qs(e,t,n){if(e.length===0||t.length===0)return 0;let r=Ze(e,t).length,o=Math.max(e.length,t.length);return Qr(r/o*n)}function wh(e,t,n){let r=n.contextFields.map(a=>[yn(e.mappedValues[a]),yn(t.mappedValues[a])]).filter(([a,i])=>a.length>0&&i.length>0);if(r.length===0)return 0;let o=r.filter(([a,i])=>a===i).length;return Qr(o/r.length*n.score.context)}function xh(e,t){return e.length===0&&t.length===0?1:e.length===0||t.length===0?0:2*Ze(e,t).length/(e.length+t.length)}function vh(e,t){let n=Math.min(e.length,t.length);return n===0?0:_h(e,t)/n}function _h(e,t){let n=Array.from({length:e.length+1},()=>Array(t.length+1).fill(0));for(let r=1;r<=e.length;r++)for(let o=1;o<=t.length;o++)n[r][o]=e[r-1]===t[o-1]?n[r-1][o-1]+1:Math.max(n[r-1][o],n[r][o-1]);return n[e.length][t.length]}function Ch(e,t){let n=ae(e,"word"),r=ae(t,"word");return n.length>0&&r.length>0&&!Ih(n,r)}function Zs(e){let t=new Map;for(let n of e)n.normalizedKey.length>0&&t.set(n.normalizedKey,(t.get(n.normalizedKey)||0)+1);return new Set([...t.entries()].filter(([,n])=>n>1).map(([n])=>n))}function Rh(e,t){return t.score!==e.score?t.score-e.score:e.schedule.id.localeCompare(t.schedule.id)}function Th(e,t){let n={exactMatches:0,highConfidenceMatches:1,possibleRenames:2,ambiguousMatches:3,missingInSchedule:4,missingInExcel:5},r=n[e.bucket]??99,o=n[t.bucket]??99;if(r!==o)return r-o;if((t.score||0)!==(e.score||0))return(t.score||0)-(e.score||0);let a=e.excelRow?.recordId||e.scheduleRow?.recordId||"",i=t.excelRow?.recordId||t.scheduleRow?.recordId||"";return String(a).localeCompare(String(i))}function Ze(e,t){let n=new Set(t);return vn(e.filter(r=>n.has(r)))}function vn(e){return[...new Set(e.filter(t=>ee(t).length>0))]}function Ih(e,t){let n=new Set(e),r=new Set(t);return n.size!==r.size?!1:[...n].every(o=>r.has(o))}function Qr(e){return Math.round(e)}function ma(e){return Math.max(0,Math.min(100,Math.round(e)))}function er(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var rl="reconcile_schedule_excel",Eh=50,$t=pa.object({excel:aa.describe('Excel/CSV source. Use kind:"file" for .xlsx/.csv/.tsv or kind:"rows" for deterministic CI/dry-run records.'),schedule:la.describe('Schedule source. Use kind:"inspect_schedules_result" with a normalized inspect_schedules result, or kind:"revit_schedule" to read bounded live Revit schedule rows through inspect_schedules before reconciliation.'),config:Zr.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),responseMode:Rt,maxReviewRows:pa.number().int().positive().max(1e3).optional().describe("Compact-mode cap for returned reviewTable/evidenceRows rows. Defaults 50; full/debug returns all reviewRows."),maxCandidateRows:pa.number().int().positive().max(10).optional().describe("Compatibility input for older callers. Compact mode omits nested candidateRows; full/debug returns all candidates.")}).strict();function ha(e,t,n,r={}){let{warnings:o=[],notices:a=[],scanPolicy:i={},summary:s={},suggestedNextScopes:l=[],...u}=r;return Ve({action:rl,reason:t,message:n,extra:{stage:e,reconciliationContractVersion:1,...u},summary:s,evidenceRows:[],scanPolicy:i,suggestedNextScopes:l,warnings:o,notices:a})}function fa(e,t,n={}){let{warnings:r=[],notices:o=[],scanPolicy:a={},summary:i={},suggestedNextScopes:s=[],...l}=n;return Me({action:rl,error:t,extra:{stage:e,reconciliationContractVersion:1,...l},summary:i,evidenceRows:[],scanPolicy:a,suggestedNextScopes:s,warnings:r,notices:o})}function tl(e){return e.guarded===!0||e.state==="guarded"}function nl(e){return e.success===!1||e.state==="failed"||!!e.error}function Xt(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Nh(...e){for(let t of e){let n=String(t.scanStoppedReason||"").trim();if(n&&n!=="completed")return n}return null}var Mh={requiredRoles:["identity","comparisonText"],optionalRoles:["code","description","quantity","unit","system","discipline","notes"]},Ah={rowsSource:{excel:{kind:"rows",sheetName:"Items",rows:[{Identity:"FCU-101",Description:"Fan coil supply DN100",Unit:"PCS"}],columnMapping:{identity:"Identity",comparisonText:"Description",unit:"Unit"}},schedule:{kind:"inspect_schedules_result",result:{success:!0,schedules:[{id:7001,name:"Mechanical Equipment Schedule",sections:[{section:"header",rows:[{row:0,cells:[{column:0,text:"Identity"},{column:1,text:"Description"}]}]},{section:"body",rows:[{row:1,cells:[{column:0,text:"FCU-101"},{column:1,text:"Fan coil supply DN100"}]}]}]}]}},responseMode:"compact"},fileSource:{excel:{kind:"file",path:"C:\\path\\items.xlsx",format:"xlsx",selection:{sheetName:"Items",headerRow:1,dataStartRow:2},columnMapping:{identity:"Identity",comparisonText:"Description"}},schedule:{kind:"inspect_schedules_result",result:'inspect_schedules result with responseMode="full" when schedule body cells are needed'}}};function kh(e){return[e.bucket,e.reason,e.score,e.excelRow?.excelRowId??e.excelRow?.recordId??"",e.scheduleRow?.scheduleRowId??e.scheduleRow?.recordId??""].join("|")}function Oh(e,t){let n=Array.isArray(t.columns)?t.columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}];return{...t,columns:n,rows:e.map(r=>({bucket:r.bucket,score:r.score,reason:r.reason,excelRowId:r.excelRow?.excelRowId??r.excelRow?.recordId??"",scheduleRowId:r.scheduleRow?.scheduleRowId??r.scheduleRow?.recordId??"",excelText:r.excelRow?[r.excelRow.identityText,r.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:r.scheduleRow?[r.scheduleRow.identityText,r.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:Array.isArray(r.hardConflicts)?r.hardConflicts.join(", "):"",recommendedNextAction:r.recommendedNextAction}))}}function Ph(e,t){let n=t.responseMode||"compact";if(Tt(n))return{...e,responseMode:n};let r=Ye(t.maxReviewRows,Eh,1e3),o=Pe(e.reviewRows,{limit:r,key:kh}),a=Pe(e.evidenceRows,{limit:r}),{reviewRows:i,reviewTable:s,scoringConfig:l,sourceSummary:u,...m}=e;return{...m,responseMode:"compact",reviewTable:Oh(o.rows,e.reviewTable||{}),evidenceRows:a.rows,summary:{...e.summary||{},compactResponse:!0,reviewRowCount:o.totalCount,returnedReviewRowCount:o.returnedCount,omittedReviewRowCount:o.omittedCount,duplicateReviewRowCount:o.duplicateCount,evidenceRowCount:a.totalCount,returnedEvidenceRowCount:a.returnedCount,omittedEvidenceRowCount:a.omittedCount},notices:[...Xt(e.notices),'Compact response returns summary, reviewTable, evidenceRows, and count metadata only. Use responseMode="full" for reviewRows, token profiles, raw cells, and nested candidates.']}}async function Lh(e,t={}){let n=$t.safeParse(e);if(!n.success)return ha("input_validation","reconciliation_input_required","Provide excel and schedule sources before reconciliation.",{validationIssues:n.error.issues.map(l=>`${l.path.join(".")||"<root>"}: ${l.message}`),requiredColumnMapping:Mh,schemaExamples:Ah,suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText","schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let r=await Vs(n.data.excel);if(tl(r))return ha("excel_ingestion",r.reason||"excel_ingestion_guarded",r.message||"Excel ingestion was guarded before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});if(nl(r))return fa("excel_ingestion",r.error||"Excel ingestion failed before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});let o=await Ws(n.data.schedule,t.scheduleAdapter);if(tl(o))return ha("schedule_record_adapter",o.reason||"schedule_adapter_guarded",o.message||"Schedule adaptation was guarded before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});if(nl(o))return fa("schedule_record_adapter",o.error||"Schedule adaptation failed before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});let a=el({excelResult:r,scheduleResult:o,config:n.data.config}),i=r.partial===!0||o.partial===!0,s=i&&Nh(o,r)||a.scanStoppedReason;return Ph({...a,partial:a.partial===!0||i,scanStoppedReason:s,scanPolicy:{...a.scanPolicy||{},excel:r.scanPolicy||{},schedule:o.scanPolicy||{}},warnings:[...Xt(a.warnings),...Xt(r.warnings),...Xt(o.warnings)],notices:[...Xt(a.notices),...Xt(r.notices),...Xt(o.notices)],sourceSummary:{excel:r.summary||{},schedule:o.summary||{}},sourceResults:{excel:{sourceKind:r.sourceKind,format:r.format,sheetName:r.sheetName,partial:r.partial,scanStoppedReason:r.scanStoppedReason,recordCount:Array.isArray(r.excelRecords)?r.excelRecords.length:0},schedule:{sourceKind:o.sourceKind,visibilityBasis:o.visibilityBasis,partial:o.partial,scanStoppedReason:o.scanStoppedReason,recordCount:Array.isArray(o.scheduleRecords)?o.scheduleRecords.length:0}}},n.data)}function ol(e){e.tool("reconcile_schedule_excel",'[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus either normalized inspect_schedules output or bounded live revit_schedule input, normalizes rows, scores deterministic matches, and returns compact review tables by default. excel.kind="rows" expects an object with rows:[...] plus columnMapping.identity and columnMapping.comparisonText; file sources use path/format/selection with the same required mapping. schedule.kind="revit_schedule" requires scheduleIds or nameQuery unless allowExpensiveSearch=true. schedule.columnHeaders can be an index-ordered string array, an array of {column, header} objects, or a header/index map; explicit headers override native header labels for string columnMapping resolution. If Body has no readable rows, headerDataMode="auto" reads Header section rows as schedule data and reports that fallback; use headerDataMode="never" to disable or "always" to force it. Default responseMode=compact returns summary, reviewTable, evidenceRows, and count metadata only; use responseMode=full/debug for reviewRows, token profiles, raw cells, and nested candidateRows. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.',{excel:$t.shape.excel,schedule:$t.shape.schedule,config:$t.shape.config,responseMode:$t.shape.responseMode,maxReviewRows:$t.shape.maxReviewRows,maxCandidateRows:$t.shape.maxCandidateRows},async(t={})=>{try{return f(await Lh(t))}catch(n){return f(fa("runtime_failure",n instanceof Error?n.message:String(n)))}})}import{z as q}from"zod";var Vh={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxMatches:1e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxMatches:5e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxMatches:2e4}},to=["sheetQuery","sheetIds","viewNameQuery","sources","profiles","countMode","groupBy","maxSheets","maxViewports","maxMatches","maxResponseBytes","allowExpensiveSearch"];function _e(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function al(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Vh[t],r=_e(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=_e(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxMatches:_e(e.maxMatches,n.maxMatches,1,2e5)}}function Dh(e){let t=String(e??"").trim();return/^sheet_?text_?notes?$/i.test(t)||/^sheetTextNotes?$/i.test(t)?"sheet_text_notes":/^viewport_?tags?$/i.test(t)||/^viewportTags?$/i.test(t)?"viewport_tags":/^viewport_?text_?notes?$/i.test(t)||/^viewportTextNotes?$/i.test(t)||/^view_?text_?notes?$/i.test(t)||/^viewTextNotes?$/i.test(t)?"viewport_text_notes":/^placed_?schedule_?cells?$/i.test(t)||/^placedScheduleCells?$/i.test(t)||/^schedule_?cells?$/i.test(t)||/^scheduleCells?$/i.test(t)?"placed_schedule_cells":t}function Kt(e){let t=String(e??"").trim();return/^unique_?text$/i.test(t)?"uniqueText":/^unique_?tag$/i.test(t)?"uniqueTag":/^unique_?tagged_?element$/i.test(t)?"uniqueTaggedElement":"occurrence"}function il(e){return e==="uniqueTag"||e==="uniqueTaggedElement"}function eo(e,t,n,r){return e==="deep"?r:e==="balanced"?n:t}function ga(e){let t=Kt(e.countMode),n=Array.isArray(e.sources)?e.sources:[],r=[...new Set(n.map(Dh).filter(o=>o.length>0))];return r.length>0?r:il(t)?["viewport_tags"]:["sheet_text_notes","viewport_text_notes","placed_schedule_cells","viewport_tags"]}function Fh(e){return Array.isArray(e.sources)&&e.sources.length>0}function sl(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||"").trim())}function ya(e){let t=al(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,sources:ga(e),countMode:Kt(e.countMode),groupBy:Array.isArray(e.groupBy)?e.groupBy:[],maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,maxSheets:_e(e.maxSheets,30,1,200),maxViewportsPerSheet:_e(e.maxViewportsPerSheet??e.maxViewports,20,0,200),maxTextNotesScanned:_e(e.maxTextNotesScanned,eo(t.searchBudget,1e3,5e3,2e4),1,2e5),maxTagsScanned:_e(e.maxTagsScanned??e.maxTags,eo(t.searchBudget,500,2500,1e4),1,1e5),maxScheduleInstancesPerSheet:_e(e.maxScheduleInstancesPerSheet,20,0,200),maxRowsPerSchedule:_e(e.maxRowsPerSchedule,250,1,2e3),maxColumnsPerSchedule:_e(e.maxColumnsPerSchedule,20,1,200),maxScheduleInstancesScanned:_e(e.maxScheduleInstancesScanned,eo(t.searchBudget,200,1e3,5e3),1,2e4),maxScheduleCellsScanned:_e(e.maxScheduleCellsScanned,eo(t.searchBudget,1e3,5e3,2e4),1,2e5),maxMatches:t.maxMatches,maxTextChars:_e(e.maxTextChars,240,1,1e3),maxRegexPatternLength:_e(e.maxRegexPatternLength,240,1,1e3),regexTimeoutMs:_e(e.regexTimeoutMs,25,1,250),maxResponseBytes:_e(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),sheetScoped:sl(e)}}function jh(e,t){return{query:e.query,regex:e.regex,normalizedRegex:e.normalizedRegex,matchMode:e.matchMode,sheetQuery:e.sheetQuery,sheetIds:e.sheetIds,viewNameQuery:e.viewNameQuery,sources:ga(e),profiles:e.profiles,profileName:e.profileName,countMode:Kt(e.countMode),groupBy:e.groupBy,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSheets:e.maxSheets,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxTags:e.maxTags,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxMatches:t.maxMatches,maxTextChars:e.maxTextChars,maxRegexPatternLength:e.maxRegexPatternLength,regexTimeoutMs:e.regexTimeoutMs,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Count Revit annotations",taskId:e.taskId}}function no(e){let t=String(c(e,"sourceType")||""),n=String(c(e,"kind")||""),r=[t,n];return r.some(o=>o==="viewportTag"||o==="viewport_tags")?"viewportTag":r.some(o=>o==="viewportTextNote"||o==="viewport_text_notes")?"viewportTextNote":r.some(o=>o==="sheetTextNote"||o==="sheet_text_notes")?"sheetTextNote":r.some(o=>o==="placedScheduleCell"||o==="placed_schedule_cells"||o==="scheduleCell")?"placedScheduleCell":t||n||"annotation"}function ro(e){let t=k(e,"evidenceRows");return(t.length>0?t:k(e,"matches")).map(r=>({...r,sourceType:no(r)}))}function Bh(e){let t=String(e??"").trim();return/^source_?type$/i.test(t)?"sourceType":/^(profile|profileName)$/i.test(t)?"profile":/^(pattern|patternName)$/i.test(t)?"pattern":/^(matchedCode|matchedText|uniqueText)$/i.test(t)?"matchedText":/^tagFamilyType$/i.test(t)?"tagFamilyType":/^(taggedElement|taggedElementId)$/i.test(t)?"taggedElement":/^view$/i.test(t)?"view":/^sheet$/i.test(t)?"sheet":t}function qh(e,t){let n={};if(t.length===0)return n.group="all",n;for(let r of t){let o=Bh(r);o==="sheet"?(n.sheetId=c(e,"sheetId")??null,n.sheetNumber=c(e,"sheetNumber")??null):o==="view"?(n.viewId=c(e,"viewId")??null,n.viewName=c(e,"viewName")??null):o==="sourceType"?n.sourceType=no(e):o==="profile"?n.profileName=c(e,"profileName")??null:o==="pattern"?n.patternName=c(e,"patternName")??null:o==="matchedText"?n.matchedTextNormalized=c(e,"matchedTextNormalized")??null:o==="tagFamilyType"?(n.tagFamilyName=c(e,"tagFamilyName")??null,n.tagTypeName=c(e,"tagTypeName")??null):o==="taggedElement"&&(n.taggedElementId=c(e,"taggedElementId")??null)}return Object.keys(n).length===0&&(n.group="all"),n}function zh(e){return Object.keys(e).sort().map(t=>`${t}=${String(e[t]??"")}`).join("|")}function Uh(e,t){let n=no(e);if(t==="occurrence")return"";if(t==="uniqueText")return`profile:${String(c(e,"profileName")??"").trim()}|text:${String(c(e,"matchedTextNormalized")??c(e,"textNormalized")??"").trim()}`;if(t==="uniqueTag"){if(n!=="viewportTag")return"";let r=String(c(e,"tagId")??"").trim();return r?`tag:${r}`:""}if(t==="uniqueTaggedElement"){if(n!=="viewportTag")return"";let r=c(e,"taggedElementResolved"),o=String(c(e,"taggedElementId")??"").trim();return!r||!o?"":`taggedElement:${o}`}return""}function ll(e,t,n){let r=new Map,o=new Set,a=0,i=0,s=e.map(l=>{let u={...l,sourceType:no(l)},m=qh(u,n),p=zh(m),g=r.get(p);g||(g={groupKey:p,...m,count:0,occurrenceCount:0,evidenceRowCount:0},r.set(p,g)),g.occurrenceCount+=1,g.evidenceRowCount+=1;let h=t==="occurrence"?`occurrence:${i++}`:Uh(u,t),w=!!h&&!o.has(`${p}||${h}`);return w&&(o.add(`${p}||${h}`),g.count+=1,a+=1),{...u,groupKey:p,countKey:h,counted:w,countMode:t}});return{count:a,evidenceRows:s,groups:[...r.values()].sort((l,u)=>String(l.groupKey).localeCompare(String(u.groupKey)))}}function cl(e,t){let n=pn(e,"scanPolicy"),r=c(n,"groupBy")??c(e,"groupBy")??t?.groupBy;return Array.isArray(r)?r.map(String):[]}function ul(e,t){return Kt(c(e,"countMode")??c(pn(e,"summary"),"countMode")??t?.countMode)}function dl(e,t){let n=ro(e),r=ul(e,t),o=ll(n,r,cl(e,t));return{count:c(e,"count")??o.count,countMode:r,occurrenceCount:c(e,"matchedOccurrenceCount")??o.evidenceRows.length,matchCount:o.evidenceRows.length,evidenceRowCount:o.evidenceRows.length,groupCount:k(e,"groups").length||o.groups.length,scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed"}}function Wh(e){let t=ro(e),n=t.length>0?t[t.length-1]:null;return{lastReadSection:c(e,"lastReadSection")??null,lastReadRow:c(e,"lastReadRow")??null,lastReadColumn:c(e,"lastReadColumn")??null,lastReadSheetId:c(n,"sheetId")??c(e,"lastReadSheetId")??null,lastReadViewId:c(n,"viewId")??c(e,"lastReadViewId")??null,lastReadViewportId:c(n,"viewportId")??c(e,"lastReadViewportId")??null,lastReadItemId:c(n,"tagId")??c(n,"elementId")??c(n,"scheduleInstanceId")??c(n,"scheduleId")??c(n,"id")??c(e,"lastReadItemId")??null}}function Hh(e,t){let n=ul(e,t),r=ll(ro(e),n,cl(e,t)),o=k(e,"groups");return e.countMode=n,e.evidenceRows=r.evidenceRows,e.matches=k(e,"matches").length>0?k(e,"matches"):e.evidenceRows,e.groups=o.length>0?o:r.groups,e.count=c(e,"count")??c(e.summary,"count")??r.count,e.summary={...dl(e,t),...pn(e,"summary")||{},count:c(e.summary,"count")??e.count,countMode:n,matchCount:c(e.summary,"matchCount")??e.evidenceRows.length,groupCount:c(e.summary,"groupCount")??e.groups.length},e}function Gh(e,t={},n){return Hh(be(e,{action:"count_annotations",elapsedMs:n,scanPolicy:ya(t),summary:r=>dl(r,t),evidenceRows:ro,lastRead:Wh,suggestedNextScopes:to}),t)}function Jh(e,t){return Ve({action:"count_annotations",reason:"needs_scope",message:"Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:to,scanPolicy:ya({...e,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs}),summary:{count:0,countMode:Kt(e.countMode),matchCount:0,groupCount:0}})}function $h(e){return Ve({action:"count_annotations",reason:"invalid_count_mode_for_sources",message:"uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",suggestedNextScopes:to,scanPolicy:ya(e),summary:{count:0,countMode:Kt(e.countMode),matchCount:0,groupCount:0}})}function ml(e){e.tool("count_annotations","[ANNOTATION_COUNT_READ_ONLY] Read-only native Revit annotation inventory/count for DrawingSheet text notes, viewport text notes, placed schedule cells, and viewport tag evidence. Use sheetQuery/sheetIds first; project-wide annotation counts require allowExpensiveSearch=true. Supports occurrence, uniqueText, uniqueTag, and uniqueTaggedElement count modes with bounded regex profiles.",{...I(q),...N(q),query:q.string().optional().describe("Anonymous text query. Defaults to contains matching unless matchMode is supplied."),regex:q.string().optional().describe("Anonymous raw regex pattern. Regex matching is bounded by maxRegexPatternLength and regexTimeoutMs."),normalizedRegex:q.string().optional().describe("Anonymous regex pattern evaluated against normalized annotation text."),matchMode:q.enum(["exact","contains","startsWith","regex","normalizedRegex"]).optional().describe("Match mode for query when using the anonymous profile."),profileName:q.string().optional().describe("Optional anonymous profile name when query/regex is used without profiles."),profiles:q.array(q.any()).optional().describe("Explicit profile objects with profileName/name and patterns. Patterns support exact, contains, startsWith, regex, and normalizedRegex."),sheetQuery:q.string().optional().describe("Sheet number/name scope. Use this first in large projects."),sheetIds:q.array(q.union([q.number(),q.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),viewNameQuery:q.string().optional().describe("Optional placed-view name filter before viewport tag inspection."),sources:q.array(q.enum(["sheet_text_notes","viewport_text_notes","viewport_text_note","placed_schedule_cells","placed_schedule_cell","viewport_tags","sheetTextNotes","viewportTextNotes","viewportTextNote","view_text_notes","viewTextNotes","placedScheduleCells","placedScheduleCell","schedule_cells","schedule_cell","scheduleCells","scheduleCell","viewportTags"])).optional().describe("Annotation sources. Defaults to sheet_text_notes + viewport_text_notes + placed_schedule_cells + viewport_tags except tag-specific count modes, which default to viewport_tags."),countMode:q.enum(["occurrence","uniqueText","uniqueTag","uniqueTaggedElement"]).optional().describe("Count semantics. Tag-specific modes require viewport_tags as the only explicit source."),groupBy:q.array(q.enum(["sheet","view","sourceType","profile","profileName","pattern","patternName","matchedText","matchedCode","tagFamilyType","taggedElement","taggedElementId"])).optional().describe("Optional grouping dimensions for count rows."),allowExpensiveSearch:q.boolean().optional().describe("Explicit approval for project-wide sheet and placed-view annotation counting without sheetIds/sheetQuery. Defaults false."),searchBudget:q.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:q.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),maxSheets:q.number().int().positive().max(200).optional().describe("Maximum matching sheets to inspect. Defaults 30."),maxViewportsPerSheet:q.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:q.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet."),maxTextNotesScanned:q.number().int().positive().max(2e5).optional().describe("Global native cap across sheet text notes."),maxScheduleInstancesPerSheet:q.number().int().min(0).max(200).optional().describe("Maximum placed schedule instances inspected per sheet. Defaults 20."),maxRowsPerSchedule:q.number().int().positive().max(2e3).optional().describe("Maximum body rows scanned per placed schedule. Defaults 250."),maxColumnsPerSchedule:q.number().int().positive().max(200).optional().describe("Maximum body columns scanned per placed schedule. Defaults 20."),maxScheduleInstancesScanned:q.number().int().positive().max(2e4).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:q.number().int().positive().max(2e5).optional().describe("Global native cap across placed schedule body cells before scanStoppedReason=max_cells."),maxTags:q.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:q.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxMatches:q.number().int().positive().max(2e5).optional().describe("Maximum returned matching evidence rows before scanStoppedReason=max_items."),maxTextChars:q.number().int().min(1).max(1e3).optional().describe("Maximum characters retained and matched per annotation candidate. Defaults 240."),maxRegexPatternLength:q.number().int().min(1).max(1e3).optional().describe("Maximum regex pattern length. Defaults 240."),regexTimeoutMs:q.number().int().min(1).max(250).optional().describe("Per-candidate regex timeout in milliseconds. Defaults 25."),maxResponseBytes:q.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:q.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=al(t),o=ga(t),a=Kt(t.countMode);if(il(a)&&Fh(t)&&o.some(s=>s!=="viewport_tags"))return f($h(t));if(!sl(t)&&t.allowExpensiveSearch!==!0)return f(Jh(t,r));let i=await D("count_annotations",jh(t,r),{...V({...t,timeoutMs:r.timeoutMs},"Count Revit annotations"),toolName:"count_annotations"});return f(Gh(i&&i.result?i.result:i,t,Date.now()-n))}catch(r){return f(Me({action:"count_annotations",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:to}))}})}import{z as Ue}from"zod";function Xh(e){let t=Ar(e.elementIds||[]),n=F(e.category||""),r=Number.isFinite(e.sampleLimit)?Math.max(1,Math.min(25,e.sampleLimit)):5,o=e.includeTypeParameters===!0?"true":"false",a=Ke(e.parameterNameFilter||[]),i=e.parameterNameMatchMode==="exact"?"exact":"contains";return`
int[] explicitElementIds = ${t};
string categoryName = ${n};
int sampleLimit = ${r};
bool includeTypeParameters = ${o};
string[] parameterNameFilter = ${a};
string parameterNameMatchMode = "${i}";

bool ParameterNameMatches(string parameterName, string filter)
{
    if (parameterNameMatchMode == "exact")
        return string.Equals(parameterName, filter, StringComparison.OrdinalIgnoreCase);
    return parameterName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0;
}

bool IncludeParameter(Parameter p)
{
    if (p == null || p.Definition == null) return false;
    if (parameterNameFilter.Length == 0) return true;
    foreach (string filter in parameterNameFilter)
    {
        if (ParameterNameMatches(p.Definition.Name, filter)) return true;
    }
    return false;
}

string RawValue(Parameter p)
{
    if (p == null || !p.HasValue) return "";
    try
    {
        if (p.StorageType == StorageType.String) return p.AsString();
        if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.Double) return p.AsDouble().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.ElementId) return p.AsElementId().IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    catch {}
    return "";
}

string SharedGuid(Parameter p)
{
    try
    {
        if (!p.IsShared) return "";
        ExternalDefinition externalDefinition = p.Definition as ExternalDefinition;
        if (externalDefinition != null) return externalDefinition.GUID.ToString();
    }
    catch {}
    return "";
}

int? ReflectedParameterElementId(Parameter p)
{
    try
    {
        System.Reflection.PropertyInfo prop = p.GetType().GetProperty("Id");
        if (prop == null) return null;
        ElementId id = prop.GetValue(p, null) as ElementId;
        if (id == null || id == ElementId.InvalidElementId) return null;
        return id.IntegerValue;
    }
    catch { return null; }
}

bool TryResolveHideWhenNoValue(Document doc, Parameter p, out bool hideWhenNoValue)
{
    hideWhenNoValue = false;
    ExternalDefinition externalDefinition = p.Definition as ExternalDefinition;
    if (externalDefinition != null)
    {
        hideWhenNoValue = externalDefinition.HideWhenNoValue;
        return true;
    }

    int? parameterElementId = ReflectedParameterElementId(p);
    if (parameterElementId.HasValue)
    {
        SharedParameterElement sharedElement = doc.GetElement(new ElementId(parameterElementId.Value)) as SharedParameterElement;
        if (sharedElement != null)
        {
            hideWhenNoValue = sharedElement.ShouldHideWhenNoValue();
            return true;
        }
    }

    string sharedGuid = SharedGuid(p);
    if (!string.IsNullOrWhiteSpace(sharedGuid))
    {
        Guid guid;
        if (Guid.TryParse(sharedGuid, out guid))
        {
            SharedParameterElement sharedElement = SharedParameterElement.Lookup(doc, guid);
            if (sharedElement != null)
            {
                hideWhenNoValue = sharedElement.ShouldHideWhenNoValue();
                return true;
            }
        }
    }

    return false;
}

bool CanAttemptTrueNoValueClear(Document doc, Parameter p, out string unsupportedReason, out bool? hideWhenNoValue)
{
    unsupportedReason = "";
    hideWhenNoValue = null;
    if (p.IsReadOnly)
    {
        unsupportedReason = "read_only_parameter_blocked";
        return false;
    }
    if (!p.IsShared)
    {
        unsupportedReason = "clear_value_requires_shared_parameter";
        return false;
    }

    bool resolvedHideWhenNoValue;
    if (!TryResolveHideWhenNoValue(doc, p, out resolvedHideWhenNoValue))
    {
        unsupportedReason = "clear_value_hide_when_no_value_unverified";
        return false;
    }

    hideWhenNoValue = resolvedHideWhenNoValue;
    if (!resolvedHideWhenNoValue)
    {
        unsupportedReason = "clear_value_requires_hide_when_no_value";
        return false;
    }

    return true;
}

object ParameterSchema(Parameter p, string source)
{
    string builtIn = "";
    int? builtInParameterId = null;
    string displayBuiltInParameter = "";
    string builtInParameterNote = "";
    bool isShared = false;
    string dataType = "";
    string unitType = "";
    string valueString = "";
    try
    {
        InternalDefinition idef = p.Definition as InternalDefinition;
        if (idef != null)
        {
            builtIn = idef.BuiltInParameter.ToString();
            builtInParameterId = (int)idef.BuiltInParameter;
            displayBuiltInParameter = builtIn;
        }
    }
    catch {}
    string parameterName = p.Definition != null ? p.Definition.Name : "";
    if (!string.IsNullOrWhiteSpace(builtIn))
    {
        if (string.Equals(parameterName, "Mark", StringComparison.OrdinalIgnoreCase))
        {
            displayBuiltInParameter = "ALL_MODEL_MARK";
        }
        else if (string.Equals(parameterName, "Type Mark", StringComparison.OrdinalIgnoreCase))
        {
            displayBuiltInParameter = "ALL_MODEL_TYPE_MARK";
        }

        string normalizedName = parameterName.Replace(" ", "_");
        if (!string.Equals(displayBuiltInParameter, builtIn, StringComparison.OrdinalIgnoreCase) ||
            (!string.IsNullOrWhiteSpace(normalizedName) &&
             builtIn.IndexOf(normalizedName, StringComparison.OrdinalIgnoreCase) < 0 &&
             displayBuiltInParameter.IndexOf(normalizedName, StringComparison.OrdinalIgnoreCase) < 0))
        {
            builtInParameterNote = "Revit BuiltInParameter enum names may stringify as aliases. Use builtInParameterId for exact API identity and displayBuiltInParameter for human review.";
        }
    }
    try { isShared = p.IsShared; } catch {}
    try { dataType = p.Definition.GetDataType().TypeId; } catch {}
    try { unitType = p.GetUnitTypeId().TypeId; } catch {}
    try { valueString = p.AsValueString(); } catch {}
    string raw = RawValue(p);
    string noValueState = !p.HasValue
        ? "true_no_value"
        : p.StorageType == StorageType.String && string.IsNullOrEmpty(raw)
            ? "visible_empty_has_value"
            : "has_value";
    string trueNoValueUnsupportedReason = "";
    bool? hideWhenNoValue = null;
    bool trueNoValueClearSupported = CanAttemptTrueNoValueClear(document, p, out trueNoValueUnsupportedReason, out hideWhenNoValue);

    return new {
        source = source,
        name = parameterName,
        displayBuiltInParameter = displayBuiltInParameter,
        builtInParameter = displayBuiltInParameter,
        builtInParameterId = builtInParameterId,
        rawBuiltInParameterAlias = builtIn,
        builtInParameterNote = builtInParameterNote,
        storageType = p.StorageType.ToString(),
        hasValue = p.HasValue,
        isReadOnly = p.IsReadOnly,
        isShared = isShared,
        sharedGuid = SharedGuid(p),
        parameterElementId = ReflectedParameterElementId(p),
        dataType = dataType,
        unitType = unitType,
        raw = raw,
        valueString = valueString,
        noValueState = noValueState,
        effectiveVisibleEmpty = p.StorageType == StorageType.String && string.IsNullOrEmpty(raw),
        clearability = new {
            clearApi = "Parameter.ClearValue",
            trueNoValueClearSupported = trueNoValueClearSupported,
            trueNoValueUnsupportedReason = trueNoValueClearSupported ? "" : trueNoValueUnsupportedReason,
            hideWhenNoValue = hideWhenNoValue,
            hideWhenNoValueVerified = hideWhenNoValue.HasValue,
            visibleEmptyClearSupported = p.StorageType == StorageType.String && !p.IsReadOnly,
            visibleEmptyClearOperation = "clearVisibleValue",
            visibleEmptyClearLeavesHasValueTrue = p.StorageType == StorageType.String
        }
    };
}

void AddParameterSchemas(Element elem, string source, System.Collections.Generic.List<object> output)
{
    foreach (Parameter p in elem.Parameters)
    {
        if (!IncludeParameter(p)) continue;
        output.Add(ParameterSchema(p, source));
    }
}

try
{
    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    System.Collections.Generic.List<Element> samples = new System.Collections.Generic.List<Element>();

    foreach (int id in explicitElementIds)
    {
        if (samples.Count >= sampleLimit) break;
        Element elem = document.GetElement(new ElementId(id));
        if (elem != null) samples.Add(elem);
        else warnings.Add("Element not found: " + id.ToString());
    }

    if (samples.Count == 0 && !string.IsNullOrEmpty(categoryName))
    {
        try
        {
            BuiltInCategory bic = (BuiltInCategory)System.Enum.Parse(typeof(BuiltInCategory), categoryName);
            FilteredElementCollector col = new FilteredElementCollector(document)
                .OfCategory(bic)
                .WhereElementIsNotElementType();
            foreach (Element elem in col.ToElements())
            {
                if (samples.Count >= sampleLimit) break;
                samples.Add(elem);
            }
        }
        catch (Exception ex)
        {
            warnings.Add("Could not collect category " + categoryName + ": " + ex.Message);
        }
    }

    System.Collections.Generic.List<object> elements = new System.Collections.Generic.List<object>();
    foreach (Element elem in samples)
    {
        string category = elem.Category != null ? elem.Category.Name : "";
        string typeName = "";
        Element typeElem = document.GetElement(elem.GetTypeId());
        if (typeElem != null) typeName = typeElem.Name;

        System.Collections.Generic.List<object> parameterSchemas = new System.Collections.Generic.List<object>();
        AddParameterSchemas(elem, "instance", parameterSchemas);
        if (includeTypeParameters && typeElem != null)
        {
            AddParameterSchemas(typeElem, "type", parameterSchemas);
        }

        elements.Add(new {
            id = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            category = category,
            className = elem.GetType().FullName,
            typeName = typeName,
            parameters = parameterSchemas.ToArray()
        });
    }

    return new {
        success = true,
        matchMode = parameterNameMatchMode,
        sampleCount = samples.Count,
        elements = elements.ToArray(),
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`}function Kh(e){return!e||typeof e!="object"?{}:{source:e.source,displayBuiltInParameter:e.displayBuiltInParameter,builtInParameterId:e.builtInParameterId,rawBuiltInParameterAlias:e.rawBuiltInParameterAlias,storageType:e.storageType,isShared:e.isShared,isReadOnly:e.isReadOnly,dataType:e.dataType,unitType:e.unitType,noValueState:e.noValueState,clearability:e.clearability}}function Yh(e,t){if(t.parameterNameMatchMode!=="exact"||!e||typeof e!="object"||!Array.isArray(e.elements))return e;let n=[],r=Array.isArray(e.warnings)?[...e.warnings]:[];for(let o of e.elements){let a=Array.isArray(o?.parameters)?o.parameters:[],i=new Map;for(let s of a){let l=typeof s?.name=="string"?s.name.trim():"";if(!l)continue;let u=l.toLocaleLowerCase("en-US");i.has(u)||i.set(u,{name:l,matches:[]}),i.get(u)?.matches.push(s)}for(let s of i.values()){if(s.matches.length<2)continue;let l={elementId:o?.id,parameterName:s.name,count:s.matches.length,severity:"write_preflight_warning",message:`Duplicate display name '${s.name}' matched ${s.matches.length} parameters on element ${o?.id}. Display name alone is ambiguous for write-back; choose by source, builtInParameterId, shared flag, storage type, or read-only state.`,matches:s.matches.map(Kh)};n.push(l),r.push(`duplicate_display_name: elementId=${o?.id}; parameterName=${s.name}; count=${s.matches.length}; display name alone is ambiguous for write-back.`)}}return n.length===0?e:{...e,warnings:r,duplicateDisplayNameWarnings:n}}function pl(e){e.tool("inspect_parameter_schema","Read-only parameter schema inspection for selected ids or a category sample: user-facing BIP display label/id, raw enum alias, storage type, unit type, shared/read-only flags, raw/display values, no-value state, and clearability metadata.",{...I(Ue),...N(Ue),elementIds:Ue.array(Ue.union([Ue.number(),Ue.string()])).optional().describe("Element ids to inspect."),category:Ue.string().optional().describe("BuiltInCategory name such as OST_DuctCurves or OST_DuctTerminal."),sampleLimit:Ue.number().int().positive().max(25).optional().describe("Maximum sample elements. Defaults 5."),includeTypeParameters:Ue.boolean().optional().describe("Include type parameters. Defaults false."),parameterNameFilter:Ue.array(Ue.string()).optional().describe("Optional parameter name filters."),parameterNameMatchMode:Ue.enum(["contains","exact"]).optional().describe("Filter matching mode. contains is discovery mode and default; exact is write-preflight mode.")},async t=>{if((!t.elementIds||t.elementIds.length===0)&&!t.category)return f({success:!0,matchMode:t.parameterNameMatchMode==="exact"?"exact":"contains",sampleCount:0,elements:[],warnings:["Provide elementIds or category."]});try{let n=await ce(Xh(t),{...V(t,"Inspect Revit parameter schema"),transactionMode:"none"}),r=n&&n.result?n.result:n;return f(Yh(r,t))}catch(n){return f({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as oe}from"zod";function fl(e){return e==="clear"?"clear":e==="clearVisibleValue"?"clearVisibleValue":"set"}function hl(e){return typeof e=="boolean"?e?"true":"false":String(e??"")}async function Qh(e,t){if(e.elementId!==void 0&&e.elementId!==null&&String(e.elementId).trim()!==""){let n=Number.parseInt(String(e.elementId),10);return Number.isFinite(n)&&n>0?n:null}if(e.useSelection===!0){let n=await ln(2,t);return n.length===1?n[0]:{...ot({action:"set_element_parameter",reason:"single_selection_required",error:n.length===0?"No selected Revit element was found. Provide elementId or select exactly one element.":"Multiple selected elements were found. Provide one explicit elementId for a production parameter write."}),tool:"set_element_parameter",guardReason:"single_selection_required",selectedElementIds:n}}return null}function Zh(e,t){let n=fl(e.operation),r=F(e.parameterName||""),o=F(e.parameterSource||"instance"),a=F(n==="clearVisibleValue"?"":hl(e.value)),i=F(e.valueMode||"raw"),s=F(e.mode==="commit"?"commit":"dryRun"),l=F(n),u=e.value===void 0||e.value===null?"false":"true",m=Number.isInteger(e.builtInParameterId)?String(e.builtInParameterId):"null",p=F(e.expectedStorageType||""),g=F(e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"":hl(e.expectedCurrentRaw)),h=e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"false":"true",w=e.allowTypeParameterWrite===!0?"true":"false";return`
int elementId = ${t};
string parameterName = ${r};
string parameterSource = ${o};
string requestedValueText = ${a};
string valueMode = ${i};
string mode = ${s};
string operation = ${l};
int? expectedBuiltInParameterId = ${m};
string expectedStorageType = ${p};
bool hasExpectedCurrentRaw = ${h};
string expectedCurrentRaw = ${g};
bool allowTypeParameterWrite = ${w};
bool hasRequestedValue = ${u};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool clearOperation = string.Equals(operation, "clear", StringComparison.OrdinalIgnoreCase);
bool clearVisibleOperation = string.Equals(operation, "clearVisibleValue", StringComparison.OrdinalIgnoreCase);

string RawValue(Parameter p)
{
    if (p == null || !p.HasValue) return "";
    try
    {
        if (p.StorageType == StorageType.String) return p.AsString() ?? "";
        if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.Double) return p.AsDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        if (p.StorageType == StorageType.ElementId) return p.AsElementId().IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    catch {}
    return "";
}

string ValueString(Parameter p)
{
    try { return p.AsValueString() ?? ""; } catch { return ""; }
}

int? BuiltInId(Parameter p)
{
    try
    {
        InternalDefinition idef = p.Definition as InternalDefinition;
        if (idef == null) return null;
        int id = (int)idef.BuiltInParameter;
        return id == -1 ? (int?)null : id;
    }
    catch { return null; }
}

string SharedGuid(Parameter p)
{
    try
    {
        if (!p.IsShared) return "";
        ExternalDefinition externalDefinition = p.Definition as ExternalDefinition;
        if (externalDefinition != null) return externalDefinition.GUID.ToString();
    }
    catch {}
    return "";
}

int? ReflectedParameterElementId(Parameter p)
{
    try
    {
        System.Reflection.PropertyInfo prop = p.GetType().GetProperty("Id");
        if (prop == null) return null;
        ElementId id = prop.GetValue(p, null) as ElementId;
        if (id == null || id == ElementId.InvalidElementId) return null;
        return id.IntegerValue;
    }
    catch { return null; }
}

object ParameterIdentity(Parameter p, string source)
{
    string name = p.Definition != null ? p.Definition.Name : "";
    string raw = RawValue(p);
    string valueString = ValueString(p);
    string dataType = "";
    string unitType = "";
    bool isShared = false;
    try { dataType = p.Definition.GetDataType().TypeId; } catch {}
    try { unitType = p.GetUnitTypeId().TypeId; } catch {}
    try { isShared = p.IsShared; } catch {}
    int? builtInId = BuiltInId(p);
    string noValueState = !p.HasValue
        ? "true_no_value"
        : p.StorageType == StorageType.String && string.IsNullOrEmpty(raw)
            ? "visible_empty_has_value"
            : "has_value";
    string trueNoValueUnsupportedReason = "";
    bool? hideWhenNoValue = null;
    bool trueNoValueClearSupported = CanAttemptTrueNoValueClear(document, p, out trueNoValueUnsupportedReason, out hideWhenNoValue);
    return new {
        source = source,
        name = name,
        storageType = p.StorageType.ToString(),
        isReadOnly = p.IsReadOnly,
        isShared = isShared,
        sharedGuid = SharedGuid(p),
        builtInParameterId = builtInId,
        parameterElementId = ReflectedParameterElementId(p),
        dataType = dataType,
        unitType = unitType,
        hasValue = p.HasValue,
        raw = raw,
        valueString = valueString,
        noValueState = noValueState,
        effectiveVisibleEmpty = p.StorageType == StorageType.String && string.IsNullOrEmpty(raw),
        clearability = new {
            clearApi = "Parameter.ClearValue",
            trueNoValueClearSupported = trueNoValueClearSupported,
            trueNoValueUnsupportedReason = trueNoValueClearSupported ? "" : trueNoValueUnsupportedReason,
            hideWhenNoValue = hideWhenNoValue,
            hideWhenNoValueVerified = hideWhenNoValue.HasValue,
            visibleEmptyClearSupported = p.StorageType == StorageType.String && !p.IsReadOnly,
            visibleEmptyClearOperation = "clearVisibleValue",
            visibleEmptyClearLeavesHasValueTrue = p.StorageType == StorageType.String
        }
    };
}

System.Collections.Generic.List<Parameter> ExactDisplayNameMatches(Element owner)
{
    System.Collections.Generic.List<Parameter> matches = new System.Collections.Generic.List<Parameter>();
    foreach (Parameter p in owner.Parameters)
    {
        if (p == null || p.Definition == null) continue;
        if (string.Equals(p.Definition.Name, parameterName, StringComparison.OrdinalIgnoreCase))
        {
            matches.Add(p);
        }
    }
    return matches;
}

bool TryParseInteger(string text, out int value)
{
    if (string.Equals(text, "true", StringComparison.OrdinalIgnoreCase))
    {
        value = 1;
        return true;
    }
    if (string.Equals(text, "false", StringComparison.OrdinalIgnoreCase))
    {
        value = 0;
        return true;
    }
    return int.TryParse(text, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out value);
}

string ExpectedRawAfterSet(Parameter p)
{
    if (p.StorageType == StorageType.String) return requestedValueText;
    if (p.StorageType == StorageType.Integer)
    {
        int intValue;
        if (!TryParseInteger(requestedValueText, out intValue))
            throw new Exception("Requested value cannot be parsed as an integer parameter value.");
        return intValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    if (p.StorageType == StorageType.Double)
    {
        if (string.Equals(valueMode, "valueString", StringComparison.OrdinalIgnoreCase))
            return null;
        double doubleValue;
        if (!double.TryParse(requestedValueText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out doubleValue))
            throw new Exception("Requested value cannot be parsed as a raw internal Revit double.");
        return doubleValue.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
    }
    if (p.StorageType == StorageType.ElementId)
    {
        int idValue;
        if (!TryParseInteger(requestedValueText, out idValue))
            throw new Exception("Requested value cannot be parsed as an ElementId integer.");
        return idValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    throw new Exception("Unsupported parameter storage type: " + p.StorageType.ToString());
}

bool SetParameterValue(Parameter p)
{
    if (p.StorageType == StorageType.String)
    {
        return p.Set(requestedValueText);
    }
    if (p.StorageType == StorageType.Integer)
    {
        int intValue;
        if (!TryParseInteger(requestedValueText, out intValue))
            throw new Exception("Requested value cannot be parsed as an integer parameter value.");
        return p.Set(intValue);
    }
    if (p.StorageType == StorageType.Double)
    {
        if (string.Equals(valueMode, "valueString", StringComparison.OrdinalIgnoreCase))
        {
            return p.SetValueString(requestedValueText);
        }
        double doubleValue;
        if (!double.TryParse(requestedValueText, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out doubleValue))
            throw new Exception("Requested value cannot be parsed as a raw internal Revit double.");
        return p.Set(doubleValue);
    }
    if (p.StorageType == StorageType.ElementId)
    {
        int idValue;
        if (!TryParseInteger(requestedValueText, out idValue))
            throw new Exception("Requested value cannot be parsed as an ElementId integer.");
        return p.Set(new ElementId(idValue));
    }
    throw new Exception("Unsupported parameter storage type: " + p.StorageType.ToString());
}

bool TryClearParameterValue(Parameter p, out string clearError)
{
    clearError = "";
    try
    {
        System.Reflection.MethodInfo method = p.GetType().GetMethod("ClearValue", System.Type.EmptyTypes);
        if (method == null)
        {
            method = typeof(Parameter).GetMethod("ClearValue", System.Type.EmptyTypes);
        }
        if (method == null)
        {
            clearError = "Parameter.ClearValue is not available in this Revit API version.";
            return false;
        }

        object result = method.Invoke(p, null);
        if (result is bool)
        {
            return (bool)result;
        }
        return true;
    }
    catch (System.Reflection.TargetInvocationException ex)
    {
        clearError = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
        return false;
    }
    catch (Exception ex)
    {
        clearError = ex.Message;
        return false;
    }
}

bool TryResolveHideWhenNoValue(Document doc, Parameter p, out bool hideWhenNoValue)
{
    hideWhenNoValue = false;
    ExternalDefinition externalDefinition = p.Definition as ExternalDefinition;
    if (externalDefinition != null)
    {
        hideWhenNoValue = externalDefinition.HideWhenNoValue;
        return true;
    }

    int? parameterElementId = ReflectedParameterElementId(p);
    if (parameterElementId.HasValue)
    {
        SharedParameterElement sharedElement = doc.GetElement(new ElementId(parameterElementId.Value)) as SharedParameterElement;
        if (sharedElement != null)
        {
            hideWhenNoValue = sharedElement.ShouldHideWhenNoValue();
            return true;
        }
    }

    string sharedGuid = SharedGuid(p);
    if (!string.IsNullOrWhiteSpace(sharedGuid))
    {
        Guid guid;
        if (Guid.TryParse(sharedGuid, out guid))
        {
            SharedParameterElement sharedElement = SharedParameterElement.Lookup(doc, guid);
            if (sharedElement != null)
            {
                hideWhenNoValue = sharedElement.ShouldHideWhenNoValue();
                return true;
            }
        }
    }

    return false;
}

bool CanAttemptTrueNoValueClear(Document doc, Parameter p, out string unsupportedReason, out bool? hideWhenNoValue)
{
    unsupportedReason = "";
    hideWhenNoValue = null;
    if (p.IsReadOnly)
    {
        unsupportedReason = "read_only_parameter_blocked";
        return false;
    }
    if (!p.IsShared)
    {
        unsupportedReason = "clear_value_requires_shared_parameter";
        return false;
    }

    bool resolvedHideWhenNoValue;
    if (!TryResolveHideWhenNoValue(doc, p, out resolvedHideWhenNoValue))
    {
        unsupportedReason = "clear_value_hide_when_no_value_unverified";
        return false;
    }

    hideWhenNoValue = resolvedHideWhenNoValue;
    if (!resolvedHideWhenNoValue)
    {
        unsupportedReason = "clear_value_requires_hide_when_no_value";
        return false;
    }

    return true;
}

object Blocked(string reason, string message, object extra = null)
{
    return new {
        success = false,
        state = "guarded",
        guarded = true,
        action = "set_element_parameter",
        guardReason = reason,
        error = message,
        tool = "set_element_parameter",
        mode = mode,
        operation = operation,
        preflight = new {
            requiredPreflight = "inspect_parameter_schema exact identity resolution",
            blockedBeforeWrite = true
        },
        details = extra
    };
}

try
{
    if (string.IsNullOrWhiteSpace(parameterName))
    {
        return Blocked("parameter_name_required", "parameterName is required for exact schema preflight.");
    }
    if (!clearOperation && !clearVisibleOperation && !hasRequestedValue)
    {
        return Blocked("value_required", "value is required when operation=set. Use operation=clear only when you intentionally want to restore a true no-value state, or operation=clearVisibleValue when a visible empty string is acceptable.");
    }
    if (expectedBuiltInParameterId.HasValue && expectedBuiltInParameterId.Value == -1)
    {
        return Blocked("invalid_builtin_parameter_id", "builtInParameterId=-1 is not a stable write identity.");
    }

    Element elem = document.GetElement(new ElementId(elementId));
    if (elem == null)
    {
        return Blocked("element_not_found", "Element was not found: " + elementId.ToString());
    }

    string normalizedSource = string.Equals(parameterSource, "type", StringComparison.OrdinalIgnoreCase) ? "type" : "instance";
    Element owner = elem;
    if (normalizedSource == "type")
    {
        owner = document.GetElement(elem.GetTypeId());
        if (owner == null)
        {
            return Blocked("type_element_not_found", "The element does not have a writable type element.");
        }
        if (!dryRun && !allowTypeParameterWrite)
        {
            return Blocked(
                "type_parameter_write_requires_allowTypeParameterWrite",
                "Type parameter writes can affect every instance using this type. Set allowTypeParameterWrite=true to commit intentionally.",
                new { elementId = elementId, typeId = owner.Id.IntegerValue });
        }
    }

    System.Collections.Generic.List<Parameter> displayMatches = ExactDisplayNameMatches(owner);
    if (displayMatches.Count == 0)
    {
        return Blocked("parameter_not_found", "No exact parameter display-name match was found on the selected " + normalizedSource + " owner.");
    }
    if (displayMatches.Count > 1)
    {
        return Blocked(
            "duplicate_display_name_blocked",
            "Duplicate parameter display names were found. Display name alone is ambiguous and this tool will not write until the schema is made unambiguous.",
            new {
                elementId = elementId,
                ownerId = owner.Id.IntegerValue,
                parameterName = parameterName,
                matches = displayMatches.Select(p => ParameterIdentity(p, normalizedSource)).ToArray()
            });
    }

    Parameter target = displayMatches[0];
    int? targetBuiltInId = BuiltInId(target);
    if (expectedBuiltInParameterId.HasValue && targetBuiltInId != expectedBuiltInParameterId.Value)
    {
        return Blocked(
            "builtin_parameter_identity_mismatch",
            "The exact display-name match does not have the requested builtInParameterId.",
            new { requestedBuiltInParameterId = expectedBuiltInParameterId.Value, actualBuiltInParameterId = targetBuiltInId });
    }

    if (!string.IsNullOrWhiteSpace(expectedStorageType) &&
        !string.Equals(target.StorageType.ToString(), expectedStorageType, StringComparison.OrdinalIgnoreCase))
    {
        return Blocked(
            "storage_type_mismatch",
            "The resolved parameter storage type does not match expectedStorageType.",
            new { expectedStorageType = expectedStorageType, actualStorageType = target.StorageType.ToString() });
    }

    object before = ParameterIdentity(target, normalizedSource);
    string beforeRaw = RawValue(target);
    string beforeValueString = ValueString(target);
    bool beforeHasValue = target.HasValue;
    bool rollbackTrueNoValueMayBeUnsupported = !clearOperation && !beforeHasValue && !target.IsShared;
    string rollbackWarning = "prior_no_value_state_may_not_be_restorable_for_non_shared_parameter";
    object rollbackSafety = new {
        priorHasValue = beforeHasValue,
        trueNoValueRestoreMayBeUnsupported = rollbackTrueNoValueMayBeUnsupported,
        restoreOperation = "clear",
        clearApi = "Parameter.ClearValue",
        warning = rollbackTrueNoValueMayBeUnsupported ? rollbackWarning : null
    };

    if (hasExpectedCurrentRaw && !string.Equals(beforeRaw, expectedCurrentRaw, StringComparison.Ordinal))
    {
        return Blocked(
            "expected_current_raw_mismatch",
            "The current raw parameter value does not match expectedCurrentRaw. Re-inspect before writing.",
            new { expectedCurrentRaw = expectedCurrentRaw, actualCurrentRaw = beforeRaw });
    }

    if (target.IsReadOnly)
    {
        return Blocked(
            "read_only_parameter_blocked",
            "The resolved parameter is read-only and cannot be written.",
            new { parameter = before });
    }

    string clearUnsupportedReason = "";
    bool? hideWhenNoValue = null;
    if (clearOperation && !CanAttemptTrueNoValueClear(document, target, out clearUnsupportedReason, out hideWhenNoValue))
    {
        return Blocked(
            clearUnsupportedReason,
            "Revit Parameter.ClearValue can restore HasValue=false only for shared parameters whose definition has HideWhenNoValue=true. This parameter cannot be restored to a true no-value state through a safe Revit API path, and the tool did not write an empty string fallback.",
            new {
                parameter = before,
                clearApi = "Parameter.ClearValue",
                canRestoreTrueNoValue = false,
                attemptedClearValue = false,
                parameterWasShared = target.IsShared,
                hideWhenNoValue = hideWhenNoValue,
                hideWhenNoValueVerified = hideWhenNoValue.HasValue,
                visibleEmptyAlternative = "Use operation=clearVisibleValue only if a visible empty value is acceptable. Revit may keep HasValue=true."
            });
    }
    if (clearVisibleOperation && target.StorageType != StorageType.String)
    {
        return Blocked(
            "visible_clear_requires_string_parameter",
            "operation=clearVisibleValue writes an empty string and is only valid for String parameters. Use operation=clear for true no-value restore when the parameter supports Parameter.ClearValue.",
            new { parameter = before });
    }

    string expectedRaw = clearOperation ? null : ExpectedRawAfterSet(target);
    string valueSetApi = clearOperation
        ? "ClearValue"
        : clearVisibleOperation
            ? "Set(empty string)"
        : target.StorageType == StorageType.Double && string.Equals(valueMode, "valueString", StringComparison.OrdinalIgnoreCase)
            ? "SetValueString"
            : "Set";

    if (dryRun)
    {
        System.Collections.Generic.List<string> dryRunWarnings = new System.Collections.Generic.List<string>();
        if (clearOperation)
        {
            dryRunWarnings.Add("clear_value_support_depends_on_revit_parameter_kind");
        }
        if (!clearOperation && target.StorageType == StorageType.String && requestedValueText.Length == 0)
        {
            dryRunWarnings.Add("empty_string_set_does_not_guarantee_revit_has_value_false_use_operation_clear_when_supported");
        }
        if (clearVisibleOperation)
        {
            dryRunWarnings.Add("clear_visible_value_sets_empty_string_and_does_not_restore_revit_has_value_false");
        }
        if (rollbackTrueNoValueMayBeUnsupported)
        {
            dryRunWarnings.Add(rollbackWarning);
        }

        return new {
            success = true,
            guarded = false,
            state = "dry_run",
            action = "set_element_parameter",
            committed = false,
            tool = "set_element_parameter",
            revitWriteAction = "element_parameter",
            mode = mode,
            operation = operation,
            element = new {
                id = elem.Id.IntegerValue,
                uniqueId = elem.UniqueId,
                category = elem.Category != null ? elem.Category.Name : "",
                name = elem.Name
            },
            owner = new {
                source = normalizedSource,
                id = owner.Id.IntegerValue,
                name = owner.Name
            },
            preflight = new {
                requiredPreflight = "inspect_parameter_schema exact identity resolution",
                exactDisplayNameMatchCount = displayMatches.Count,
                duplicateDisplayNamesBlocked = false,
                readOnlyBlocked = false
            },
            parameter = before,
            requested = new {
                value = clearOperation || clearVisibleOperation ? null : requestedValueText,
                valueMode = valueMode,
                expectedRawAfterSet = expectedRaw,
                expectedHasValueAfterClear = clearOperation ? false : (bool?)null,
                expectedNoValueState = clearOperation ? "true_no_value" : null,
                expectedRawAfterVisibleClear = clearVisibleOperation ? "" : null,
                hasValueAfterVisibleClear = clearVisibleOperation ? "not_guaranteed_may_remain_true" : null,
                valueSetApi = valueSetApi,
                clearValueSupport = clearOperation ? "will_attempt_clear_value_on_commit" : clearVisibleOperation ? "not_applicable_visible_clear_uses_empty_string_set" : null
            },
            before = before,
            verification = new {
                wouldVerifyAfterWrite = true,
                verificationMode = clearOperation ? "hasValue false after ClearValue" : clearVisibleOperation ? "visible empty raw readback; HasValue may remain true" : expectedRaw == null ? "SetValueString readback" : "raw readback"
            },
            rollbackSafety = rollbackSafety,
            warnings = dryRunWarnings.ToArray()
        };
    }

    bool setSucceeded = false;
    string clearError = "";
    if (clearOperation)
    {
        setSucceeded = TryClearParameterValue(target, out clearError);
        if (!setSucceeded)
        {
            return Blocked(
                "clear_value_not_supported",
                "Revit rejected Parameter.ClearValue for this parameter. The tool did not write an empty string fallback because that would leave a different internal parameter state.",
                new {
                    parameter = before,
                    clearApi = "Parameter.ClearValue",
                    clearError = clearError,
                    attemptedClearValue = true,
                    parameterWasShared = target.IsShared,
                    visibleEmptyAlternative = "Use operation=clearVisibleValue only if a visible empty value is acceptable. Revit may keep HasValue=true."
                });
        }
    }
    else
    {
        setSucceeded = SetParameterValue(target);
    }
    document.Regenerate();
    string afterRaw = RawValue(target);
    string afterValueString = ValueString(target);
    object after = ParameterIdentity(target, normalizedSource);
    bool rawVerified = clearOperation
        ? setSucceeded && target.HasValue == false
        : expectedRaw == null
        ? setSucceeded && (!string.Equals(beforeRaw, afterRaw, StringComparison.Ordinal) || string.Equals(beforeValueString, afterValueString, StringComparison.OrdinalIgnoreCase))
        : string.Equals(afterRaw, expectedRaw, StringComparison.Ordinal);
    if (!rawVerified)
    {
        if (clearOperation)
        {
            throw new Exception("Parameter clear verification failed. Expected HasValue=false after ClearValue but read back HasValue=" + (target.HasValue ? "true" : "false") + ".");
        }
        throw new Exception("Parameter write verification failed. Expected raw value '" + (expectedRaw ?? requestedValueText) + "' but read back raw value '" + afterRaw + "'.");
    }

    System.Collections.Generic.List<string> warnings = new System.Collections.Generic.List<string>();
    if (!clearOperation && target.StorageType == StorageType.String && requestedValueText.Length == 0)
    {
        warnings.Add("empty_string_set_does_not_guarantee_revit_has_value_false_use_operation_clear_when_supported");
    }
    if (clearVisibleOperation)
    {
        warnings.Add("clear_visible_value_sets_empty_string_and_does_not_restore_revit_has_value_false");
    }
    if (rollbackTrueNoValueMayBeUnsupported)
    {
        warnings.Add(rollbackWarning);
    }

    return new {
        success = true,
        guarded = false,
        state = "committed",
        action = "set_element_parameter",
        committed = true,
        tool = "set_element_parameter",
        revitWriteAction = "element_parameter",
        mode = mode,
        operation = operation,
        element = new {
            id = elem.Id.IntegerValue,
            uniqueId = elem.UniqueId,
            category = elem.Category != null ? elem.Category.Name : "",
            name = elem.Name
        },
        owner = new {
            source = normalizedSource,
            id = owner.Id.IntegerValue,
            name = owner.Name
        },
        preflight = new {
            requiredPreflight = "inspect_parameter_schema exact identity resolution",
            exactDisplayNameMatchCount = displayMatches.Count,
            duplicateDisplayNamesBlocked = false,
            readOnlyBlocked = false
        },
        requested = new {
            value = clearOperation || clearVisibleOperation ? null : requestedValueText,
            valueMode = valueMode,
            expectedRawAfterSet = expectedRaw,
            expectedHasValueAfterClear = clearOperation ? false : (bool?)null,
            expectedNoValueState = clearOperation ? "true_no_value" : null,
            expectedRawAfterVisibleClear = clearVisibleOperation ? "" : null,
            hasValueAfterVisibleClear = clearVisibleOperation ? "not_guaranteed_may_remain_true" : null,
            valueSetApi = valueSetApi
        },
        before = before,
        after = after,
        changed = clearOperation || clearVisibleOperation
            ? beforeHasValue != target.HasValue || !string.Equals(beforeRaw, afterRaw, StringComparison.Ordinal) || !string.Equals(beforeValueString, afterValueString, StringComparison.Ordinal)
            : !string.Equals(beforeRaw, afterRaw, StringComparison.Ordinal) || !string.Equals(beforeValueString, afterValueString, StringComparison.Ordinal),
        verification = new {
            verified = rawVerified,
            verificationMode = clearOperation ? "hasValue false after ClearValue" : clearVisibleOperation ? "visible empty raw readback; HasValue may remain true" : expectedRaw == null ? "SetValueString readback" : "raw readback",
            setApiReturned = setSucceeded
        },
        rollbackSafety = rollbackSafety,
        warnings = warnings.ToArray()
    };
}
catch (Exception ex)
{
    return new {
        success = false,
        state = "failed",
        guarded = false,
        action = "set_element_parameter",
        tool = "set_element_parameter",
        mode = mode,
        operation = operation,
        error = ex.Message
    };
}`}function gl(e){e.tool("set_element_parameter","[PRODUCTION_PARAMETER_WRITE] Safely set, true-clear, or visibly clear one Revit element parameter after exact inspect_parameter_schema-style identity resolution. Never writes by visible display name alone: duplicate display names, read-only parameters, identity mismatch, unsupported clear/no-value attempts, and unapproved type-parameter writes are guarded. operation=clear uses Revit Parameter.ClearValue only for parameter kinds that can restore a true no-value state and never fakes no-value restore by writing an empty string. operation=clearVisibleValue is an explicit string-only visible cleanup path that writes an empty string and reports that Revit may keep HasValue=true. Defaults to dryRun; use mode=commit only for an explicitly confirmed write, then the tool reads the parameter back for verification.",{...I(oe),...N(oe),elementId:oe.union([oe.number(),oe.string()]).optional().describe("Target Revit ElementId. Preferred for production writes."),useSelection:oe.boolean().optional().describe("When true, use the current Revit selection only if exactly one element is selected. Defaults false."),parameterName:oe.string().describe("Exact visible parameter name used only for schema preflight. The tool enumerates matching parameters and blocks duplicates; it does not use LookupParameter as a direct write shortcut."),parameterSource:oe.enum(["instance","type"]).optional().default("instance").describe("Write an instance parameter by default. Type parameters require allowTypeParameterWrite=true in commit mode."),builtInParameterId:oe.number().int().optional().describe("Optional stable BuiltInParameter integer from inspect_parameter_schema. If supplied, it must match the exact display-name result."),expectedStorageType:oe.enum(["String","Integer","Double","ElementId"]).optional().describe("Optional storage-type guard from inspect_parameter_schema."),expectedCurrentRaw:oe.union([oe.string(),oe.number(),oe.boolean()]).optional().describe("Optional compare-and-set guard. Commit is blocked if the current raw value differs."),operation:oe.enum(["set","clear","clearVisibleValue"]).optional().default("set").describe("set writes the supplied value. clear uses Revit Parameter.ClearValue only when the parameter kind supports true no-value restore and never falls back to writing an empty string. clearVisibleValue explicitly writes an empty string to a String parameter and may leave HasValue=true."),value:oe.union([oe.string(),oe.number(),oe.boolean()]).optional().describe("Requested value for operation=set. String writes use the text as-is; Integer accepts number/true/false; Double defaults to raw Revit internal units; ElementId accepts an integer id."),valueMode:oe.enum(["raw","valueString"]).optional().default("raw").describe("For Double parameters, raw writes internal Revit units. valueString uses Parameter.SetValueString with project units."),mode:oe.enum(["dryRun","commit"]).optional().default("dryRun").describe("dryRun performs schema/convertibility checks only. commit writes inside the wrapper transaction and verifies readback."),allowTypeParameterWrite:oe.boolean().optional().default(!1).describe("Required to commit a type-parameter write because it can affect all instances of that type."),timeoutMs:oe.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults to the runtime default.")},async t=>{let n=Se(t);try{let r=await Qh(t,n);if(!r||typeof r=="object")return f(r||{...ot({action:"set_element_parameter",reason:"element_id_required",error:"Provide elementId or set useSelection=true with exactly one selected element."}),guardReason:"element_id_required",tool:"set_element_parameter"});let o=t.mode==="commit"?"commit":"dryRun",a=fl(t.operation);if(a==="set"&&(t.value===void 0||t.value===null))return f({...ot({action:"set_element_parameter",reason:"value_required",error:"value is required when operation=set. Use operation=clear only when you intentionally want to restore a true no-value state, or operation=clearVisibleValue when a visible empty string is acceptable."}),guardReason:"value_required",tool:"set_element_parameter",mode:o,operation:a});let i=await ce(Zh(t,r),{...n,...ke(t,o==="commit"?a==="clear"?"Clear Revit element parameter":a==="clearVisibleValue"?"Visibly clear Revit element parameter":"Set Revit element parameter":a==="clear"?"Dry-run Revit element parameter clear":a==="clearVisibleValue"?"Dry-run visible Revit element parameter clear":"Dry-run Revit element parameter write"),transactionMode:o==="commit"?"auto":"none"});return f(i&&i.result?i.result:i)}catch(r){return f(qe({action:"set_element_parameter",error:r instanceof Error?r.message:String(r),extra:{tool:"set_element_parameter"}}))}})}import{z as Ie}from"zod";function yl(e){return`new int[] { ${e.map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function ef(e){return`new bool[] { ${e.map(t=>t?"true":"false").join(", ")} }`}function tf(e){return(Array.isArray(e.cells)?e.cells:[]).slice(0,200).map(n=>({row:Math.max(0,Number.parseInt(String(n.row),10)||0),column:Math.max(0,Number.parseInt(String(n.column),10)||0),value:String(n.value??""),hasExpectedCurrentText:n.expectedCurrentText!==void 0&&n.expectedCurrentText!==null,expectedCurrentText:String(n.expectedCurrentText??"")}))}function nf(e){let t=Number.parseInt(String(e.scheduleId),10),n=tf(e),r=F(e.section),o=F(e.mode==="commit"?"commit":"dryRun"),a=e.allowCurrentMismatch===!0?"true":"false";return`
int scheduleId = ${Number.isFinite(t)?t:0};
string requestedSection = ${r};
string mode = ${o};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowCurrentMismatch = ${a};
int[] rows = ${yl(n.map(i=>i.row))};
int[] columns = ${yl(n.map(i=>i.column))};
string[] requestedValues = ${Ke(n.map(i=>i.value))};
bool[] hasExpectedCurrentTexts = ${ef(n.map(i=>i.hasExpectedCurrentText))};
string[] expectedCurrentTexts = ${Ke(n.map(i=>i.expectedCurrentText))};

SectionType SectionTypeForName(string sectionName)
{
    string normalized = (sectionName ?? "").ToLowerInvariant();
    if (normalized == "footer") return SectionType.Footer;
    if (normalized == "body") return SectionType.Body;
    return SectionType.Header;
}

string ReadCell(ViewSchedule schedule, SectionType sectionType, int row, int column, out bool readable, out string error)
{
    readable = false;
    error = "";
    try
    {
        string value = schedule.GetCellText(sectionType, row, column) ?? "";
        readable = true;
        return value;
    }
    catch (Exception ex)
    {
        error = ex.Message;
        return "";
    }
}

bool IsStandardScheduleBodyCellWriteForbidden(ViewSchedule schedule, SectionType sectionType)
{
    if (sectionType != SectionType.Body) return false;
    try
    {
        ScheduleDefinition definition = schedule.Definition;
        if (definition != null && definition.IsKeySchedule) return false;
    }
    catch
    {
    }
    return true;
}

object CellResult(int index, int row, int column, string requestedValue, string beforeValue, string afterValue, string actualAfterValue, string projectedAfterValue, bool readable, bool changed, bool wouldChange, string actualAfterBasis, string projectedAfterBasis, bool verified, bool blocked, string reason, string error)
{
    return new {
        index = index,
        row = row,
        column = column,
        requestedValue = requestedValue,
        before = beforeValue,
        after = afterValue,
        actualAfter = actualAfterValue,
        projectedAfter = projectedAfterValue,
        readable = readable,
        changed = changed,
        wouldChange = wouldChange,
        afterBasis = actualAfterBasis,
        actualAfterBasis = actualAfterBasis,
        projectedAfterBasis = projectedAfterBasis,
        verified = verified,
        blocked = blocked,
        reason = reason,
        error = error
    };
}

object ChangeFieldContract()
{
    return new {
        version = "2",
        preferredFields = new string[] { "actualAfter", "projectedAfter", "wouldChange" },
        deprecatedLegacyFields = new string[] { "after", "changed" },
        after = "Legacy actual-value field; an empty string may also mean the cell was unreadable. Use actualAfter with actualAfterBasis.",
        changed = "Legacy before-versus-requested comparison. It does not prove a committed write and may be true on a blocked preflight row. Use wouldChange."
    };
}

try
{
    System.Collections.Generic.List<object> planned = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<string> errors = new System.Collections.Generic.List<string>();
    System.Collections.Generic.HashSet<string> seenCells = new System.Collections.Generic.HashSet<string>();
    int wouldChangeCount = 0;

    ViewSchedule schedule = document.GetElement(new ElementId(scheduleId)) as ViewSchedule;
    if (schedule == null || schedule.IsTemplate)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells",
            reason = "schedule_not_found",
            error = "Schedule not found or schedule id points to a template.",
            scheduleId = scheduleId,
            committed = false
        };
    }

    SectionType sectionType = SectionTypeForName(requestedSection);
    TableSectionData sectionData = schedule.GetTableData().GetSectionData(sectionType);
    int rowCount = sectionData.NumberOfRows;
    int columnCount = sectionData.NumberOfColumns;
    bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden(schedule, sectionType);

    if (rows.Length == 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells",
            reason = "no_cells",
            error = "Provide at least one schedule cell.",
            scheduleId = scheduleId,
            scheduleName = schedule.Name,
            committed = false
        };
    }

    for (int i = 0; i < rows.Length; i++)
    {
        int row = rows[i];
        int column = columns[i];
        string requestedValue = requestedValues[i] ?? "";
        bool blocked = false;
        string reason = "";
        string error = "";
        bool readable = false;
        string before = "";
        string key = row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + column.ToString(System.Globalization.CultureInfo.InvariantCulture);

        if (seenCells.Contains(key))
        {
            blocked = true;
            reason = "duplicate_cell";
            error = "The same schedule cell was requested more than once.";
        }
        seenCells.Add(key);

        if (!blocked && (row < 0 || row >= rowCount || column < 0 || column >= columnCount))
        {
            blocked = true;
            reason = "cell_out_of_range";
            error = "Requested cell is outside the selected schedule section.";
        }

        if (!blocked)
        {
            before = ReadCell(schedule, sectionType, row, column, out readable, out error);
            if (!readable)
            {
                blocked = true;
                reason = "cell_not_readable";
            }
        }

        bool cellWouldChange = readable && !string.Equals(before, requestedValue, StringComparison.Ordinal);
        if (!blocked && hasExpectedCurrentTexts[i] && !allowCurrentMismatch && !string.Equals(before, expectedCurrentTexts[i] ?? "", StringComparison.Ordinal))
        {
            blocked = true;
            reason = "current_value_mismatch";
            error = "Current cell text does not match expectedCurrentText.";
        }

        if (!blocked && cellWouldChange && standardScheduleBodyCellWriteForbidden)
        {
            blocked = true;
            reason = "non_writable_standard_body_cell";
            error = "Revit forbids SetCellText on standard schedule body sections. Write the underlying element parameter, or target a key schedule/header/footer cell.";
        }

        if (blocked)
        {
            errors.Add(reason + " at row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + error);
        }

        string actualAfter = readable ? before : null;
        string projectedAfter = !blocked && readable ? requestedValue : null;
        bool wouldChange = !blocked && cellWouldChange;
        string actualAfterBasis = readable ? "current_observed_no_write" : "unavailable_not_readable";
        string projectedAfterBasis = projectedAfter == null ? "unavailable_preflight_blocked" : "requested_value_after_successful_preflight";

        if (wouldChange) wouldChangeCount++;
        planned.Add(CellResult(i, row, column, requestedValue, before, before, actualAfter, projectedAfter, readable, cellWouldChange, wouldChange, actualAfterBasis, projectedAfterBasis, false, blocked, reason, error));
    }

    if (errors.Count > 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells",
            reason = "schedule_cell_preflight_failed",
            error = "One or more requested schedule cells failed preflight.",
            scheduleId = schedule.Id.IntegerValue,
            scheduleName = schedule.Name,
            section = requestedSection,
            rowCount = rowCount,
            columnCount = columnCount,
            committed = false,
            dryRun = dryRun,
            changeFieldContract = ChangeFieldContract(),
            changes = planned.ToArray(),
            errors = errors.ToArray()
        };
    }

    if (dryRun)
    {
        return new {
            success = true,
            guarded = false,
            state = "dry_run",
            action = "set_schedule_cells",
            scheduleId = schedule.Id.IntegerValue,
            scheduleName = schedule.Name,
            section = requestedSection,
            rowCount = rowCount,
            columnCount = columnCount,
            committed = false,
            dryRun = true,
            requestedCellCount = rows.Length,
            wouldChangeCount = wouldChangeCount,
            changeFieldContract = ChangeFieldContract(),
            changes = planned.ToArray(),
            warnings = new string[] { "Dry run only. Re-run with mode=commit to write schedule cell text." }
        };
    }

    System.Collections.Generic.List<object> committedChanges = new System.Collections.Generic.List<object>();
    int changedCount = 0;
    int verifiedCount = 0;
    for (int i = 0; i < rows.Length; i++)
    {
        int row = rows[i];
        int column = columns[i];
        string requestedValue = requestedValues[i] ?? "";
        bool readableBefore = false;
        string readError = "";
        string before = ReadCell(schedule, sectionType, row, column, out readableBefore, out readError);
        bool changed = !string.Equals(before, requestedValue, StringComparison.Ordinal);
        string after = before;
        bool verified = !changed;
        string writeError = "";
        try
        {
            if (changed)
            {
                sectionData.SetCellText(row, column, requestedValue);
                changedCount++;
                bool readableAfter = false;
                string afterReadError = "";
                after = ReadCell(schedule, sectionType, row, column, out readableAfter, out afterReadError);
                verified = readableAfter && string.Equals(after, requestedValue, StringComparison.Ordinal);
                if (!verified) writeError = afterReadError;
            }
        }
        catch (Exception ex)
        {
            throw new Exception("Schedule cell write failed at row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + ex.Message, ex);
        }
        if (!verified)
        {
            throw new Exception("Schedule cell verification failed at row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": requested value was not observed after write.");
        }
        if (verified) verifiedCount++;
        string actualAfterBasis = changed ? "post_commit_readback" : "current_observed_no_write_needed";
        committedChanges.Add(CellResult(i, row, column, requestedValue, before, after, after, requestedValue, readableBefore, changed, changed, actualAfterBasis, "requested_value_committed_target", verified, !verified, verified ? "" : "verification_failed", writeError));
    }

    bool success = verifiedCount == rows.Length;
    return new {
        success = success,
        guarded = !success,
        state = success ? "committed" : "guarded",
        action = "set_schedule_cells",
        reason = success ? null : "schedule_cell_verification_failed",
        scheduleId = schedule.Id.IntegerValue,
        scheduleName = schedule.Name,
        section = requestedSection,
        rowCount = rowCount,
        columnCount = columnCount,
        committed = true,
        dryRun = false,
        requestedCellCount = rows.Length,
        changedCount = changedCount,
        verifiedCount = verifiedCount,
        changeFieldContract = ChangeFieldContract(),
        changes = committedChanges.ToArray()
    };
}
catch (Exception ex)
{
    if (!dryRun)
    {
        throw;
    }
    return new {
        success = false,
        guarded = true,
        state = "guarded",
        action = "set_schedule_cells",
        reason = "set_schedule_cells_exception",
        error = ex.ToString(),
        scheduleId = scheduleId,
        committed = false
    };
}`}function Sl(e){e.tool("set_schedule_cells","[PRODUCTION_SCHEDULE_CELL_WRITE] Writes exact Revit schedule cells by scheduleId, section, row, and column. Defaults to dryRun, blocks mismatched expectedCurrentText, guards non-writable standard schedule body cells as non_writable_standard_body_cell, and verifies committed values. Change rows expose actualAfter (observed value), projectedAfter (requested target), and wouldChange; legacy after/changed fields remain for compatibility and are marked deprecated by changeFieldContract. Schedule cell text writes are not a raw-code reason: use this after inspect_schedules has found exact row/column coordinates for renumbering, title/spec/mark edits, key schedule/header/footer cells, or other direct cell text updates. Do not use this for visual schedule formatting such as borders, merges, colors, row heights, column widths, or placed schedule movement.",{...I(Ie),...N(Ie),scheduleId:Ie.union([Ie.number(),Ie.string()]).describe("Exact ViewSchedule element id. Schedule names are not accepted for writes."),section:Ie.enum(["header","body","footer"]).describe("Exact schedule section containing the target cells."),cells:Ie.array(Ie.object({row:Ie.number().int().min(0).describe("Zero-based row index in the selected schedule section."),column:Ie.number().int().min(0).describe("Zero-based column index in the selected schedule section."),value:Ie.string().describe("Target cell text."),expectedCurrentText:Ie.string().optional().describe("Optional exact preflight value. Commit is blocked if current text differs unless allowCurrentMismatch=true.")})).min(1).max(200).describe("Exact cells to update. Use inspect_schedules first to discover row/column coordinates."),mode:Ie.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes schedule cell text in one Revit transaction."),allowCurrentMismatch:Ie.boolean().optional().describe("Defaults false. Keep false for production writes so stale row/column targets are blocked."),timeoutMs:Ie.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=await ce(nf(t),{...Se(t),...ke(t,n==="commit"?"Set Revit schedule cells":"Preview Revit schedule cell changes"),toolName:"set_schedule_cells",transactionMode:n==="commit"?"auto":"none"});return f(r&&r.result?r.result:r)}catch(n){return f(qe({action:"set_schedule_cells",reason:"set_schedule_cells_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as $}from"zod";var rf=25;function bl(e,t=100){return(Array.isArray(e)?e:[]).slice(0,t).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n))}function wl(e){return`new int[] { ${e.join(", ")} }`}function of(e){let t=[];if(typeof e.rowTextQuery=="string"&&e.rowTextQuery.trim()&&t.push(e.rowTextQuery.trim()),Array.isArray(e.rowTextQueries))for(let n of e.rowTextQueries){let r=String(n??"").trim();r&&t.push(r)}return[...new Set(t)].slice(0,20)}function af(e,t){let n=Array.isArray(e)?[...new Set(e.map(r=>String(r??"").trim()).filter(r=>r.length>0))]:[];return{rows:n.slice(0,t),totalCount:Array.isArray(e)?e.length:0,uniqueCount:n.length,returnedCount:Math.min(n.length,t),omittedCount:Math.max(0,n.length-t)}}function sf(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||Tt(n))return{...e,responseMode:n};let r=Ye(t.maxResultRows,rf,500),o=Pe(e.matches,{limit:r}),a=Pe(e.changes,{limit:r}),i=af(e.errors,r),s={...e,responseMode:"compact",compactResponse:!0,maxReturnedRows:r};return Array.isArray(e.matches)&&(s.matches=o.rows,s.returnedMatchCount=o.returnedCount,s.omittedMatchCount=o.omittedCount,s.duplicateMatchCount=o.duplicateCount),Array.isArray(e.changes)&&(s.changes=a.rows,s.returnedChangeCount=a.returnedCount,s.omittedChangeCount=a.omittedCount,s.duplicateChangeCount=a.duplicateCount),Array.isArray(e.errors)&&(s.errors=i.rows,s.returnedErrorCount=i.returnedCount,s.omittedErrorCount=i.omittedCount),s.notices=[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds matches/changes/errors. Use responseMode="full" for all row details.'],s}function lf(e){let t=bl(e.scheduleIds,200),n=bl(e.sheetIds,200),r=of(e),o=Number.parseInt(String(e.targetColumn),10),a=Math.max(1,Math.min(Number.parseInt(String(e.maxSchedules??20),10)||20,200)),i=Math.max(1,Math.min(Number.parseInt(String(e.maxRowsPerSchedule??250),10)||250,2e3)),s=Math.max(1,Math.min(Number.parseInt(String(e.maxColumnsPerSchedule??80),10)||80,300)),l=Math.max(1,Math.min(Number.parseInt(String(e.maxMatches??50),10)||50,500)),u=e.mode==="commit"?"commit":"dryRun",m=e.section||"body",p=e.rowMatchMode==="any"?"any":"all",g=e.allowMultipleMatches===!0?"true":"false",h=e.allowCurrentMismatch===!0?"true":"false",w=e.expectedCurrentText!==void 0&&e.expectedCurrentText!==null?"true":"false",_=F(e.expectedCurrentText??"");return`
int[] exactScheduleIds = ${wl(t)};
int[] exactSheetIds = ${wl(n)};
string scheduleNameQuery = ${F(e.scheduleNameQuery||e.scheduleQuery||"")};
string sheetQuery = ${F(e.sheetQuery||"")};
string requestedSection = ${F(m)};
string[] rowTextQueries = ${Ke(r)};
string rowMatchMode = ${F(p)};
int targetColumn = ${Number.isFinite(o)?o:-1};
string requestedValue = ${F(e.value??"")};
string mode = ${F(u)};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowMultipleMatches = ${g};
bool allowCurrentMismatch = ${h};
bool hasExpectedCurrentText = ${w};
string expectedCurrentText = ${_};
int maxSchedules = ${a};
int maxRowsPerSchedule = ${i};
int maxColumnsPerSchedule = ${s};
int maxMatches = ${l};

SectionType SectionTypeForName(string sectionName)
{
    string normalized = (sectionName ?? "").ToLowerInvariant();
    if (normalized == "footer") return SectionType.Footer;
    if (normalized == "header") return SectionType.Header;
    return SectionType.Body;
}

string NormalizeText(string value)
{
    string text = value ?? "";
    text = text.Replace("\\r", " ").Replace("\\n", " ").Replace("\\t", " ");
    text = text.Replace("\\u0130", "I").Replace("\\u0131", "i");
    string decomposed = text.Normalize(System.Text.NormalizationForm.FormD);
    System.Text.StringBuilder builder = new System.Text.StringBuilder();
    for (int i = 0; i < decomposed.Length; i++)
    {
        char ch = decomposed[i];
        System.Globalization.UnicodeCategory category = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch);
        if (category != System.Globalization.UnicodeCategory.NonSpacingMark)
        {
            builder.Append(ch);
        }
    }
    return builder.ToString().Normalize(System.Text.NormalizationForm.FormC).ToLowerInvariant();
}

bool ContainsNormalized(string haystack, string needle)
{
    string normalizedNeedle = NormalizeText(needle);
    if (string.IsNullOrWhiteSpace(normalizedNeedle)) return true;
    return NormalizeText(haystack).Contains(normalizedNeedle);
}

bool MatchesAllQueries(string rowText)
{
    if (rowTextQueries.Length == 0) return false;
    bool any = string.Equals(rowMatchMode, "any", StringComparison.OrdinalIgnoreCase);
    bool matchedAny = false;
    for (int i = 0; i < rowTextQueries.Length; i++)
    {
        bool matched = ContainsNormalized(rowText, rowTextQueries[i]);
        if (any && matched) return true;
        if (!any && !matched) return false;
        if (matched) matchedAny = true;
    }
    return any ? matchedAny : true;
}

bool IdArrayContains(int[] ids, int id)
{
    for (int i = 0; i < ids.Length; i++)
    {
        if (ids[i] == id) return true;
    }
    return false;
}

string ReadCell(ViewSchedule schedule, SectionType sectionType, int row, int column, out bool readable, out string error)
{
    readable = false;
    error = "";
    try
    {
        string value = schedule.GetCellText(sectionType, row, column) ?? "";
        readable = true;
        return value;
    }
    catch (Exception ex)
    {
        error = ex.Message;
        return "";
    }
}

bool IsStandardScheduleBodyCellWriteForbidden(ViewSchedule schedule, SectionType sectionType)
{
    if (sectionType != SectionType.Body) return false;
    try
    {
        ScheduleDefinition definition = schedule.Definition;
        if (definition != null && definition.IsKeySchedule) return false;
    }
    catch
    {
    }
    return true;
}

object MatchResult(ViewSchedule schedule, string sheetNumber, string sheetName, SectionType sectionType, int row, int column, string rowText, string before, bool readable, bool wouldChange, bool blocked, string reason, string error)
{
    return new {
        scheduleId = schedule.Id.IntegerValue,
        scheduleName = schedule.Name,
        sheetNumber = sheetNumber,
        sheetName = sheetName,
        section = requestedSection,
        row = row,
        column = column,
        rowText = rowText,
        before = before,
        requestedValue = requestedValue,
        readable = readable,
        wouldChange = wouldChange,
        blocked = blocked,
        reason = reason,
        error = error
    };
}

try
{
    bool hasScheduleScope = exactScheduleIds.Length > 0 || !string.IsNullOrWhiteSpace(scheduleNameQuery);
    bool hasSheetScope = exactSheetIds.Length > 0 || !string.IsNullOrWhiteSpace(sheetQuery);
    if (!hasScheduleScope && !hasSheetScope)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "missing_bounded_scope",
            error = "Provide scheduleIds, scheduleNameQuery, sheetIds, or sheetQuery before searching schedule rows.",
            committed = false
        };
    }
    if (rowTextQueries.Length == 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "missing_row_text_query",
            error = "Provide rowTextQuery or rowTextQueries before writing by row match.",
            committed = false
        };
    }
    if (targetColumn < 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "invalid_target_column",
            error = "targetColumn must be a zero-based column index.",
            committed = false
        };
    }

    System.Collections.Generic.Dictionary<int, string> scheduleSheetLabels = new System.Collections.Generic.Dictionary<int, string>();
    System.Collections.Generic.Dictionary<int, string> scheduleSheetNames = new System.Collections.Generic.Dictionary<int, string>();
    System.Collections.Generic.HashSet<int> candidateScheduleIds = new System.Collections.Generic.HashSet<int>();

    foreach (int id in exactScheduleIds) candidateScheduleIds.Add(id);

    if (hasSheetScope)
    {
        System.Collections.Generic.List<ViewSheet> sheets = new FilteredElementCollector(document)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsTemplate)
            .OrderBy(s => s.SheetNumber)
            .ToList();

        foreach (ViewSheet sheet in sheets)
        {
            bool match = exactSheetIds.Length == 0 && string.IsNullOrWhiteSpace(sheetQuery);
            if (!match && exactSheetIds.Length > 0 && IdArrayContains(exactSheetIds, sheet.Id.IntegerValue)) match = true;
            if (!match && !string.IsNullOrWhiteSpace(sheetQuery))
            {
                match = ContainsNormalized(sheet.SheetNumber, sheetQuery) || ContainsNormalized(sheet.Name, sheetQuery);
            }
            if (!match) continue;

            System.Collections.Generic.List<ScheduleSheetInstance> placements = new FilteredElementCollector(document, sheet.Id)
                .OfClass(typeof(ScheduleSheetInstance))
                .Cast<ScheduleSheetInstance>()
                .ToList();
            foreach (ScheduleSheetInstance placement in placements)
            {
                int scheduleId = placement.ScheduleId.IntegerValue;
                candidateScheduleIds.Add(scheduleId);
                if (!scheduleSheetLabels.ContainsKey(scheduleId)) scheduleSheetLabels[scheduleId] = sheet.SheetNumber;
                if (!scheduleSheetNames.ContainsKey(scheduleId)) scheduleSheetNames[scheduleId] = sheet.Name;
            }
        }
    }

    if (!string.IsNullOrWhiteSpace(scheduleNameQuery))
    {
        System.Collections.Generic.List<ViewSchedule> namedSchedules = new FilteredElementCollector(document)
            .OfClass(typeof(ViewSchedule))
            .Cast<ViewSchedule>()
            .Where(s => !s.IsTemplate && ContainsNormalized(s.Name, scheduleNameQuery))
            .OrderBy(s => s.Name)
            .ToList();
        foreach (ViewSchedule schedule in namedSchedules)
        {
            candidateScheduleIds.Add(schedule.Id.IntegerValue);
        }
    }

    System.Collections.Generic.List<ViewSchedule> schedules = new System.Collections.Generic.List<ViewSchedule>();
    foreach (int id in candidateScheduleIds)
    {
        ViewSchedule schedule = document.GetElement(new ElementId(id)) as ViewSchedule;
        if (schedule == null || schedule.IsTemplate) continue;
        if (!string.IsNullOrWhiteSpace(scheduleNameQuery) && !ContainsNormalized(schedule.Name, scheduleNameQuery)) continue;
        schedules.Add(schedule);
    }
    schedules = schedules
        .GroupBy(s => s.Id.IntegerValue)
        .Select(g => g.First())
        .OrderBy(s => s.Name)
        .Take(maxSchedules)
        .ToList();

    SectionType sectionType = SectionTypeForName(requestedSection);
    System.Collections.Generic.List<object> matches = new System.Collections.Generic.List<object>();
    System.Collections.Generic.List<string> errors = new System.Collections.Generic.List<string>();
    int scannedRowCount = 0;

    foreach (ViewSchedule schedule in schedules)
    {
        TableSectionData sectionData = schedule.GetTableData().GetSectionData(sectionType);
        bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden(schedule, sectionType);
        int firstRow = sectionData.FirstRowNumber;
        int lastRow = sectionData.LastRowNumber;
        int firstColumn = sectionData.FirstColumnNumber;
        int lastColumn = sectionData.LastColumnNumber;
        int effectiveLastColumn = Math.Min(lastColumn, firstColumn + maxColumnsPerSchedule - 1);
        int scannedRowsForSchedule = 0;

        for (int row = firstRow; row <= lastRow; row++)
        {
            if (scannedRowsForSchedule >= maxRowsPerSchedule) break;
            scannedRowsForSchedule++;
            scannedRowCount++;

            System.Collections.Generic.List<string> cells = new System.Collections.Generic.List<string>();
            for (int column = firstColumn; column <= effectiveLastColumn; column++)
            {
                bool readableCell = false;
                string cellError = "";
                cells.Add(ReadCell(schedule, sectionType, row, column, out readableCell, out cellError));
            }
            string rowText = string.Join(" | ", cells);
            if (!MatchesAllQueries(rowText)) continue;

            bool blocked = false;
            string reason = "";
            string error = "";
            bool readable = false;
            string before = "";
            if (targetColumn < firstColumn || targetColumn > lastColumn)
            {
                blocked = true;
                reason = "target_column_out_of_range";
                error = "targetColumn is outside the selected schedule section.";
            }
            else
            {
                before = ReadCell(schedule, sectionType, targetColumn < 0 ? row : row, targetColumn, out readable, out error);
                if (!readable)
                {
                    blocked = true;
                    reason = "target_cell_not_readable";
                }
                bool wouldWrite = readable && !string.Equals(before, requestedValue, StringComparison.Ordinal);
                if (!blocked && hasExpectedCurrentText && !allowCurrentMismatch && !string.Equals(before, expectedCurrentText, StringComparison.Ordinal))
                {
                    blocked = true;
                    reason = "current_value_mismatch";
                    error = "Current cell text does not match expectedCurrentText.";
                }
                if (!blocked && wouldWrite && standardScheduleBodyCellWriteForbidden)
                {
                    blocked = true;
                    reason = "non_writable_standard_body_cell";
                    error = "Revit forbids SetCellText on standard schedule body sections. Write the underlying element parameter, or target a key schedule/header/footer cell.";
                }
            }

            if (blocked) errors.Add(schedule.Name + " row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + targetColumn.ToString(System.Globalization.CultureInfo.InvariantCulture) + ": " + reason);
            bool wouldChange = readable && !string.Equals(before, requestedValue, StringComparison.Ordinal);
            string sheetNumber = scheduleSheetLabels.ContainsKey(schedule.Id.IntegerValue) ? scheduleSheetLabels[schedule.Id.IntegerValue] : "";
            string sheetName = scheduleSheetNames.ContainsKey(schedule.Id.IntegerValue) ? scheduleSheetNames[schedule.Id.IntegerValue] : "";
            matches.Add(MatchResult(schedule, sheetNumber, sheetName, sectionType, row, targetColumn, rowText, before, readable, wouldChange, blocked, reason, error));
            if (matches.Count >= maxMatches) break;
        }
        if (matches.Count >= maxMatches) break;
    }

    if (matches.Count == 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "no_matching_rows",
            error = "No schedule rows matched the requested row text queries.",
            committed = false,
            dryRun = dryRun,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount
        };
    }
    if (matches.Count > 1 && !allowMultipleMatches)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "multiple_matching_rows",
            error = "Multiple rows matched. Set allowMultipleMatches=true only after reviewing the dry-run output.",
            committed = false,
            dryRun = dryRun,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount,
            matchCount = matches.Count,
            matches = matches.ToArray()
        };
    }
    if (errors.Count > 0)
    {
        return new {
            success = false,
            guarded = true,
            state = "guarded",
            action = "set_schedule_cells_by_text",
            reason = "matched_cell_preflight_failed",
            error = "One or more matched cells failed preflight.",
            committed = false,
            dryRun = dryRun,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount,
            matchCount = matches.Count,
            matches = matches.ToArray(),
            errors = errors.ToArray()
        };
    }

    int wouldChangeCount = 0;
    foreach (object item in matches)
    {
        object value = item.GetType().GetProperty("wouldChange").GetValue(item, null);
        if (value is bool && (bool)value) wouldChangeCount++;
    }

    if (dryRun)
    {
        return new {
            success = true,
            guarded = false,
            state = "dry_run",
            action = "set_schedule_cells_by_text",
            committed = false,
            dryRun = true,
            scheduleCount = schedules.Count,
            scannedRowCount = scannedRowCount,
            matchCount = matches.Count,
            wouldChangeCount = wouldChangeCount,
            matches = matches.ToArray(),
            warnings = new string[] { "Dry run only. Re-run with mode=commit to write matched schedule cells." }
        };
    }

    System.Collections.Generic.List<object> committed = new System.Collections.Generic.List<object>();
    int changedCount = 0;
    int verifiedCount = 0;
    foreach (object match in matches)
    {
        int scheduleId = (int)match.GetType().GetProperty("scheduleId").GetValue(match, null);
        int row = (int)match.GetType().GetProperty("row").GetValue(match, null);
        int column = (int)match.GetType().GetProperty("column").GetValue(match, null);
        ViewSchedule schedule = document.GetElement(new ElementId(scheduleId)) as ViewSchedule;
        TableSectionData sectionData = schedule.GetTableData().GetSectionData(sectionType);
        bool readableBefore = false;
        string readError = "";
        string before = ReadCell(schedule, sectionType, row, column, out readableBefore, out readError);
        bool changed = !string.Equals(before, requestedValue, StringComparison.Ordinal);
        string after = before;
        bool verified = !changed;
        if (changed)
        {
            sectionData.SetCellText(row, column, requestedValue);
            changedCount++;
            bool readableAfter = false;
            string afterError = "";
            after = ReadCell(schedule, sectionType, row, column, out readableAfter, out afterError);
            verified = readableAfter && string.Equals(after, requestedValue, StringComparison.Ordinal);
            if (!verified)
            {
                throw new Exception("Schedule cell verification failed for schedule " + schedule.Name + ", row " + row.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", column " + column.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".");
            }
        }
        if (verified) verifiedCount++;
        committed.Add(new {
            scheduleId = schedule.Id.IntegerValue,
            scheduleName = schedule.Name,
            row = row,
            column = column,
            before = before,
            after = after,
            changed = changed,
            verified = verified
        });
    }

    return new {
        success = true,
        guarded = false,
        state = "committed",
        action = "set_schedule_cells_by_text",
        committed = true,
        dryRun = false,
        scheduleCount = schedules.Count,
        scannedRowCount = scannedRowCount,
        matchCount = matches.Count,
        changedCount = changedCount,
        verifiedCount = verifiedCount,
        changes = committed.ToArray()
    };
}
catch (Exception ex)
{
    if (!dryRun)
    {
        throw;
    }
    return new {
        success = false,
        guarded = true,
        state = "guarded",
        action = "set_schedule_cells_by_text",
        reason = "set_schedule_cells_by_text_exception",
        error = ex.ToString(),
        committed = false
    };
}`}function xl(e){e.tool("set_schedule_cells_by_text","[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT] Finds bounded schedule rows by sheet/schedule filters and row text, then previews or commits a target column update with readback verification. Guards non-writable standard schedule body cells as non_writable_standard_body_cell. Prefer this over generic send_code_to_revit for repeated schedule row text writes. Schedule cell text writes are not a raw-code reason: use this when the user identifies the target row by visible row text, item code, equipment tag, or schedule line label and the requested change is a direct cell text value. Keep allowMultipleMatches=false unless every matched row is intended; use dryRun first to resolve ambiguity.",{...I($),...N($),scheduleIds:$.array($.union([$.number(),$.string()])).optional().describe("Exact ViewSchedule ids to inspect. Preferred when known."),scheduleNameQuery:$.string().optional().describe("Bounded schedule name filter. Use this before broad row text matching."),scheduleQuery:$.string().optional().describe("Alias for scheduleNameQuery."),sheetIds:$.array($.union([$.number(),$.string()])).optional().describe("Exact ViewSheet ids whose placed schedules should be inspected."),sheetQuery:$.string().optional().describe("Sheet number/name filter whose placed schedules should be inspected."),section:$.enum(["header","body","footer"]).optional().describe("Schedule section to search and write. Defaults to body."),rowTextQuery:$.string().optional().describe("Text that must appear in the row. Combine with rowTextQueries for safer matching."),rowTextQueries:$.array($.string()).optional().describe("All row text terms to match by default. Use rowMatchMode=any to match any term."),rowMatchMode:$.enum(["all","any"]).optional().describe("Defaults to all. all requires every rowTextQuery term to match the row text."),targetColumn:$.number().int().min(0).describe("Zero-based target column to write in each matched row."),value:$.string().describe("Target cell text."),expectedCurrentText:$.string().optional().describe("Optional compare-and-set guard for the target cell text."),allowCurrentMismatch:$.boolean().optional().describe("Defaults false. Keep false for production writes so stale target cells are blocked."),allowMultipleMatches:$.boolean().optional().describe("Defaults false. Required when more than one row match should be updated."),mode:$.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes all matched cells in one wrapper transaction."),maxSchedules:$.number().int().positive().max(200).optional().describe("Maximum candidate schedules to inspect. Defaults 20."),maxRowsPerSchedule:$.number().int().positive().max(2e3).optional().describe("Maximum rows scanned per schedule. Defaults 250."),maxColumnsPerSchedule:$.number().int().positive().max(300).optional().describe("Maximum columns read when matching row text. Defaults 80."),maxMatches:$.number().int().positive().max(500).optional().describe("Maximum matching rows returned or written. Defaults 50."),responseMode:Rt,maxResultRows:$.number().int().positive().max(500).optional().describe("Compact-mode cap for matches/changes/errors returned to the client. Defaults 25; full/debug returns all rows within maxMatches."),timeoutMs:$.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=t.scheduleNameQuery||t.scheduleQuery,o=await ce(lf({...t,scheduleNameQuery:r}),{...Se(t),...ke(t,n==="commit"?"Set Revit schedule cells by text":"Preview Revit schedule row text changes"),toolName:"set_schedule_cells_by_text",transactionMode:n==="commit"?"auto":"none"});return f(sf(o&&o.result?o.result:o,t))}catch(n){return f(qe({action:"set_schedule_cells_by_text",reason:"set_schedule_cells_by_text_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as Et}from"zod";var cf=`
try
{
    System.Diagnostics.Process proc = System.Diagnostics.Process.GetCurrentProcess();
    View activeView = document.ActiveView;
    return new {
        success = true,
        process = new {
            id = proc.Id,
            startTime = proc.StartTime.ToString("o")
        },
        document = new {
            title = document.Title,
            pathName = document.PathName,
            isWorkshared = document.IsWorkshared,
            isReadOnly = document.IsReadOnly
        },
        apiProbeState = new {
            sampledInsideReadOnlyTool = true,
            documentIsModifiableDuringProbe = document.IsModifiable,
            meaning = "Internal Revit API state sampled while this read-only instance probe is executing. This is not the idle UI editability state.",
            currentUiStateSource = "Use get_ui_state.document.isModifiable on the target instance for the current idle UI document state."
        },
        activeView = new {
            id = activeView.Id.IntegerValue,
            name = activeView.Name,
            viewType = activeView.ViewType.ToString(),
            scale = activeView.Scale
        },
        revit = new {
            version = document.Application.VersionNumber,
            build = document.Application.VersionBuild
        }
    };
}
catch (Exception ex)
{
    return new { success = false, error = ex.ToString() };
}`;function uf(e){let t=ht(e);return t&&typeof t=="object"&&t.result?t.result:t}async function df(e,t){let n=null;try{n=await Je(async o=>await o.sendCommand("mcp_status",{},{timeoutMs:t,statusPreflight:!1}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(t,500),logSocketErrors:!1,skipLock:!0})}catch(o){return{reachable:!1,target:{name:e.name,host:e.host,port:e.port,source:e.source},error:o instanceof Error?o.message:String(o)}}let r=Math.max(t,1e4);try{let o=await Je(async(a,i)=>await a.sendCommand("send_code_to_revit",{code:cf,parameters:[`${i.host}:${i.port}`],transactionMode:"none",taskName:"Probe Revit instance"},{timeoutMs:r}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(r,500),logSocketErrors:!1});return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:zn(n,{recentLimit:3,includeDiagnostics:!1}),info:uf(o)}}catch(o){return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:zn(n,{recentLimit:3,includeDiagnostics:!1}),info:null,infoError:o instanceof Error?o.message:String(o)}}}function vl(e){e.tool("list_revit_instances","Discover reachable revAgent Revit bridge instances by probing configured ports. Use this before targeting a specific Revit instance.",{host:Et.string().optional().describe("Host to scan. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),ports:Et.array(Et.union([Et.number(),Et.string()])).optional().describe("Ports to scan. Defaults to REVAGENT_PORTS, then legacy REVIT_MCP_PORTS, or 8080-8085."),includeRegistry:Et.boolean().optional().describe("Include targets from the revAgent instance registry file. Defaults true."),includeUnreachable:Et.boolean().optional().describe("Include unreachable ports in the result. Defaults false."),timeoutMs:Et.number().int().positive().max(15e3).optional().describe("Per-port connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.timeoutMs||3e3,r=$a({host:t.host,ports:t.ports,includeRegistry:t.includeRegistry}),o=[];for(let a of r){let i=await df(a,n);(i.reachable||t.includeUnreachable)&&o.push(i)}return f({success:!0,count:o.filter(a=>a.reachable).length,scanned:r.length,instances:o})})}import Dl from"node:path";import{z as Mt}from"zod";import wa from"better-sqlite3";import{copyFileSync as mf,existsSync as co,mkdirSync as Cl,readdirSync as pf,rmSync as _n,statSync as ao}from"node:fs";import{homedir as hf}from"node:os";import{spawnSync as ff}from"node:child_process";import{basename as gf,dirname as _a,isAbsolute as yf,join as io,parse as Nl,relative as Sf,resolve as Nt}from"node:path";function _l(e){let t=e.linkInstanceUniqueId?.trim()||"host";return`${e.documentKey}::${t}`}var bf=1,wf=1,xf=30,vf=20,_f="REVAGENT_SPATIAL_RETENTION_DAYS",Cf="REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS",Rf="REVAGENT_SPATIAL_RETENTION_DISABLED",Tf=900*1e3,If=1440*60*1e3,Ef=0,Nf=`
  CREATE TABLE spatial_store_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE spatial_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    document_key TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    committed_at_ms INTEGER NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    revision_fingerprint TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
    coverage_status TEXT,
    scan_stopped_reason TEXT NOT NULL,
    suggested_next_scopes_json TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    page_count INTEGER NOT NULL CHECK (page_count > 0),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0)
  );

  CREATE INDEX spatial_snapshots_document_time
    ON spatial_snapshots(document_key, captured_at_ms DESC, snapshot_id);

  CREATE TABLE spatial_snapshot_sources (
    snapshot_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    document_key TEXT NOT NULL,
    document_session_id TEXT NOT NULL,
    loaded_version TEXT NOT NULL,
    change_sequence INTEGER NOT NULL CHECK (change_sequence >= 0),
    oldest_retained_sequence INTEGER CHECK (oldest_retained_sequence >= 0),
    link_instance_unique_id TEXT,
    source_to_host_transform_json TEXT NOT NULL,
    external_link_update_available INTEGER NOT NULL DEFAULT 0
      CHECK (external_link_update_available IN (0, 1)),
    PRIMARY KEY (snapshot_id, source_key),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE INDEX spatial_snapshot_sources_document
    ON spatial_snapshot_sources(document_key, snapshot_id);

  CREATE TABLE spatial_nodes (
    node_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    node_kind TEXT NOT NULL,
    element_unique_id TEXT,
    link_instance_unique_id TEXT,
    min_x REAL,
    max_x REAL,
    min_y REAL,
    max_y REAL,
    min_z REAL,
    max_z REAL,
    payload_json TEXT NOT NULL,
    UNIQUE (snapshot_id, node_id),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE,
    CHECK (
      (min_x IS NULL AND max_x IS NULL AND min_y IS NULL AND max_y IS NULL AND min_z IS NULL AND max_z IS NULL)
      OR
      (min_x IS NOT NULL AND max_x IS NOT NULL AND min_y IS NOT NULL AND max_y IS NOT NULL AND min_z IS NOT NULL AND max_z IS NOT NULL
       AND min_x <= max_x AND min_y <= max_y AND min_z <= max_z)
    )
  );

  CREATE INDEX spatial_nodes_snapshot ON spatial_nodes(snapshot_id, node_id);
  CREATE INDEX spatial_nodes_document ON spatial_nodes(document_key, snapshot_id);

  CREATE VIRTUAL TABLE spatial_node_rtree USING rtree(
    node_rowid,
    min_x, max_x,
    min_y, max_y,
    min_z, max_z
  );

  CREATE TRIGGER spatial_nodes_rtree_insert
  AFTER INSERT ON spatial_nodes
  WHEN NEW.min_x IS NOT NULL
  BEGIN
    INSERT INTO spatial_node_rtree(
      node_rowid, min_x, max_x, min_y, max_y, min_z, max_z
    ) VALUES (
      NEW.node_rowid, NEW.min_x, NEW.max_x, NEW.min_y, NEW.max_y, NEW.min_z, NEW.max_z
    );
  END;

  CREATE TRIGGER spatial_nodes_rtree_delete
  AFTER DELETE ON spatial_nodes
  BEGIN
    DELETE FROM spatial_node_rtree WHERE node_rowid = OLD.node_rowid;
  END;

  CREATE TABLE spatial_omissions (
    omission_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_identity TEXT,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE INDEX spatial_omissions_snapshot ON spatial_omissions(snapshot_id, reason);
  CREATE INDEX spatial_omissions_document ON spatial_omissions(document_key, snapshot_id);

  CREATE TABLE spatial_snapshot_artifacts (
    snapshot_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, artifact_path),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );

  CREATE TABLE spatial_capture_staging (
    capture_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL UNIQUE,
    document_key TEXT NOT NULL,
    scope_fingerprint TEXT NOT NULL,
    revision_fingerprint TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE INDEX spatial_capture_staging_expiry
    ON spatial_capture_staging(expires_at_ms, capture_id);

  CREATE TABLE spatial_staging_pages (
    capture_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
    prior_page_hash TEXT,
    page_hash TEXT NOT NULL,
    has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    omission_count INTEGER NOT NULL CHECK (omission_count >= 0),
    PRIMARY KEY (capture_id, page_ordinal),
    FOREIGN KEY (capture_id) REFERENCES spatial_capture_staging(capture_id) ON DELETE CASCADE
  );

  CREATE TABLE spatial_staging_nodes (
    staging_node_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    document_key TEXT NOT NULL,
    node_kind TEXT NOT NULL,
    element_unique_id TEXT,
    link_instance_unique_id TEXT,
    min_x REAL,
    max_x REAL,
    min_y REAL,
    max_y REAL,
    min_z REAL,
    max_z REAL,
    payload_json TEXT NOT NULL,
    UNIQUE (capture_id, node_id),
    FOREIGN KEY (capture_id, page_ordinal)
      REFERENCES spatial_staging_pages(capture_id, page_ordinal) ON DELETE CASCADE
  );

  CREATE TABLE spatial_staging_omissions (
    staging_omission_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    page_ordinal INTEGER NOT NULL,
    document_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_identity TEXT,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (capture_id, page_ordinal)
      REFERENCES spatial_staging_pages(capture_id, page_ordinal) ON DELETE CASCADE
  );

  CREATE TABLE spatial_staging_artifacts (
    capture_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    PRIMARY KEY (capture_id, artifact_path),
    FOREIGN KEY (capture_id) REFERENCES spatial_capture_staging(capture_id) ON DELETE CASCADE
  );
`,Mf=`
  ALTER TABLE spatial_capture_staging ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE spatial_capture_staging ADD COLUMN declared_counts_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN effective_source_policy_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN coverage_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN transform_validation_json TEXT;
  ALTER TABLE spatial_capture_staging ADD COLUMN capture_metadata_json TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE spatial_snapshots ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE spatial_snapshots ADD COLUMN declared_counts_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN effective_source_policy_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN coverage_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN transform_validation_json TEXT;
  ALTER TABLE spatial_snapshots ADD COLUMN capture_metadata_json TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE spatial_snapshot_sources ADD COLUMN tracker_session_id TEXT;
  ALTER TABLE spatial_snapshot_sources ADD COLUMN change_sequence_state TEXT;
  ALTER TABLE spatial_snapshot_sources ADD COLUMN journal_entry_count INTEGER
    CHECK (journal_entry_count IS NULL OR journal_entry_count >= 0);
  ALTER TABLE spatial_snapshot_sources ADD COLUMN journal_capacity INTEGER
    CHECK (journal_capacity IS NULL OR journal_capacity >= 0);
  ALTER TABLE spatial_snapshot_sources ADD COLUMN journal_truncated INTEGER NOT NULL DEFAULT 0
    CHECK (journal_truncated IN (0, 1));
  ALTER TABLE spatial_snapshot_sources ADD COLUMN document_key_resolution_json TEXT;
  ALTER TABLE spatial_snapshot_sources ADD COLUMN source_revision_json TEXT NOT NULL DEFAULT '{}';
`,so=class extends Error{backupPath;constructor(t,n,r){super(t,r),this.name="SpatialStoreMigrationError",this.backupPath=n}},et=class extends Error{constructor(t,n){super(t,n),this.name="SpatialStoreIntegrityError"}},tr=class extends Error{constructor(t,n){super(t,n),this.name="SpatialRTreeUnavailableError"}},st=class extends Error{reason;constructor(t,n){super(n),this.name="SpatialStorePathError",this.reason=t}};function Af(e){return/^(1|true|yes|on)$/i.test(String(e??"").trim())}function kf(e){let t=e.trim();if(/^(?:\\\\|\/\/)/.test(t)||/^[a-z][a-z0-9+.-]*:\/\//i.test(t))return!0;let n=Nl(Nt(t)).root;return/^(?:\\\\|\/\/)/.test(n)}var Rl=new Map;function Of(e){let t=e.toUpperCase(),n=Rl.get(t);if(n!==void 0)return n;let r=["$rootPath = [Environment]::GetEnvironmentVariable('REVAGENT_SPATIAL_DRIVE_ROOT')","try { $drive = [System.IO.DriveInfo]::new($rootPath); if (-not $drive.IsReady) { exit 3 }; [Console]::Out.Write([int]$drive.DriveType); exit 0 } catch { exit 2 }"].join("; "),o=ff("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-Command",r],{encoding:"utf8",timeout:2e3,windowsHide:!0,env:{...process.env,REVAGENT_SPATIAL_DRIVE_ROOT:e}});if(o.error||o.status!==0)return null;let a=Number.parseInt(String(o.stdout??"").trim(),10);return!Number.isSafeInteger(a)||a<0||a>6?null:(Rl.set(t,a),a)}function xa(e,t,n){if(kf(e))throw new st("network_path",`${t} must remain on a local filesystem; network/UNC paths are not allowed.`);let r=Nt(e);if(process.platform==="win32"||n!==void 0){let a=Nl(r).root,i=a?(n??Of)(a):null;if(i===4)throw new st("network_path",`${t} must remain on a local filesystem; mapped network drives are not allowed.`);if(i===null||![2,3,6].includes(i))throw new st("network_path",`${t} drive readiness/type is unavailable or not an allowed local writable drive; storage is rejected fail-closed.`)}if([...new Set([Pt(),mr()].map(a=>Nt(a)))].some(a=>nr(a,r)))throw new st("managed_package_path",`${t} may not be stored inside the managed revAgent runtime/package directory.`);return r}function Pf(e,t){let n=e?.trim()||process.env.REVAGENT_SPATIAL_DB_PATH?.trim();if(n)return xa(n,"Spatial database",t);let r=process.env.LOCALAPPDATA?.trim()||io(hf(),"AppData","Local");return xa(io(r,"revAgent","spatial","spatial.db"),"Spatial database",t)}function Lf(e,t,n){let r=t?.trim()||io(_a(e),"artifacts"),o=xa(r,"Spatial artifact root",n);if(o===Nt(e)||nr(o,e)||nr(e,o))throw new st("artifact_path","The spatial artifact root must be a dedicated sibling location and may not contain the database.");return o}function Vf(){if(Af(process.env[Rf]))return!1;let e=r=>{let o=process.env[r]?.trim();if(!o)return;let a=Number(o);if(!Number.isSafeInteger(a)||a<0)throw new RangeError(`${r} must be a non-negative integer.`);return a},t=e(_f),n=e(Cf);return t===void 0&&n===void 0?void 0:{retentionDays:t,minCompleteSnapshots:n}}function le(e,t){let n=e.trim();if(!n)throw new TypeError(`${t} must be a non-empty string.`);return n}function ye(e,t){if(!Number.isSafeInteger(e)||e<0)throw new RangeError(`${t} must be a non-negative safe integer.`);return e}function we(e,t){let n=JSON.stringify(e);if(n===void 0)throw new TypeError(`${t} must be JSON serializable.`);return n}function it(e,t){if(e===null)return null;try{return JSON.parse(e)}catch(n){throw new et(`Stored ${t} JSON is invalid.`,{cause:n})}}function Tl(e){if(!e)return[null,null,null,null,null,null];if([...e.minMm,...e.maxMm].some(n=>!Number.isFinite(n)))throw new RangeError("Spatial AABB coordinates must be finite numbers.");for(let n=0;n<3;n+=1)if(e.minMm[n]>e.maxMm[n])throw new RangeError(`Spatial AABB min exceeds max on axis ${n}.`);return[e.minMm[0],e.maxMm[0],e.minMm[1],e.maxMm[1],e.minMm[2],e.maxMm[2]]}function va(e){return e.major*1e3+e.minor}function Sa(e,t){return va(e)-va(t)}function Df(e,t){return e.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.found===1}function Ml(e){if(!Df(e,"spatial_store_metadata"))return{major:0,minor:0};let t=e.prepare("SELECT key, value FROM spatial_store_metadata WHERE key IN ('schema_major', 'schema_minor')").all(),n=new Map(t.map(a=>[a.key,a.value])),r=Number.parseInt(n.get("schema_major")??"",10),o=Number.parseInt(n.get("schema_minor")??"",10);if(!Number.isSafeInteger(r)||r<0||!Number.isSafeInteger(o)||o<0)throw new et("Spatial store schema metadata is missing or invalid.");return{major:r,minor:o}}function lo(e){let n=e.pragma("quick_check").flatMap(r=>Object.values(r).map(String));if(n.length!==1||n[0].toLowerCase()!=="ok")throw new et(`SQLite quick_check failed: ${n.join("; ")||"no result"}`)}function Ca(e){let t=_a(e),n=`${gf(e)}.migration-backup-`;return co(t)?pf(t).filter(r=>r.startsWith(n)).map(r=>io(t,r)).filter(r=>{try{return ao(r).isFile()}catch{return!1}}).sort((r,o)=>ao(o).mtimeMs-ao(r).mtimeMs):[]}function Ff(e){_n(`${e}-wal`,{force:!0}),_n(`${e}-shm`,{force:!0})}function Al(e,t){Ff(e),mf(t,e)}function kl(e,t,n){let r=`${n}-${process.pid}-${Ef++}`,o=`${t}.migration-backup-${r}`,a=o.replaceAll("'","''");e.exec(`VACUUM INTO '${a}'`);let i=null;try{i=new wa(o,{readonly:!0,fileMustExist:!0}),lo(i)}catch(s){try{i?.close()}catch{}throw _n(o,{force:!0}),new et(`New spatial recovery backup failed SQLite quick_check: ${o}`,{cause:s})}return i.close(),o}function jf(e,t=3){for(let n of Ca(e).slice(t))_n(n,{force:!0})}function Il(e){e.pragma("foreign_keys = ON"),e.pragma("busy_timeout = 5000"),e.pragma("journal_mode = WAL"),e.pragma("synchronous = FULL")}function Bf(e){let t=null;try{return t=new wa(e),lo(t),Il(t),{database:t,recoveredFromBackupPath:null}}catch(n){try{t?.close()}catch{}let r=Ca(e)[0];if(!r)throw new et("Spatial store failed SQLite quick_check and no migration backup is available.",{cause:n});Al(e,r);let o=null;try{return o=new wa(e),lo(o),Il(o),{database:o,recoveredFromBackupPath:r}}catch(a){try{o?.close()}catch{}throw new et(`Spatial store recovery from ${r} failed.`,{cause:a})}}}function El(e,t){let n=e.prepare("INSERT OR REPLACE INTO spatial_store_metadata(key, value) VALUES (?, ?)");n.run("schema_major",String(t.major)),n.run("schema_minor",String(t.minor)),n.run("schema_version",`${t.major}.${t.minor}`),e.pragma(`user_version = ${va(t)}`)}function qf(e,t,n,r,o){let a=Ml(e),i={major:bf,minor:wf};if(Sa(a,i)>0)throw new so(`Spatial store schema ${a.major}.${a.minor} is newer than supported ${i.major}.${i.minor}.`,null);if(Sa(a,i)===0)return;let s=n&&co(t)&&ao(t).size>0?kl(e,t,r):null;try{e.transaction(()=>{let l=a;if(a.major===0&&a.minor===0&&(e.exec(Nf),l={major:1,minor:0},El(e,l)),l.major===1&&l.minor===0&&(e.exec(Mf),l={major:1,minor:1},El(e,l)),Sa(l,i)!==0)throw new Error(`No migration path from ${l.major}.${l.minor}.`);o?.beforeMigrationCommit?.(a,i)})(),lo(e),jf(t)}catch(l){try{e.close()}finally{s&&Al(t,s)}throw new so(`Spatial store migration ${a.major}.${a.minor} -> ${i.major}.${i.minor} failed${s?" and the pre-migration backup was restored":""}.`,s,{cause:l})}}function oo(e){try{e.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get()}catch(t){throw new tr("SQLite R*Tree support is unavailable; spatial indexing cannot fall back to a full table scan.",{cause:t})}}function nr(e,t){let n=Sf(Nt(e),Nt(t));return n===""||!n.startsWith("..")&&!yf(n)}function ba(e,t){let n=0,r=[];for(let o of[...new Set(e)]){let a=Nt(o);if(a===t||!nr(t,a)){r.push(`Refused to remove an artifact outside the dedicated spatial artifact root: ${a}`);continue}try{co(a)&&(_n(a,{recursive:!0,force:!0}),n+=1)}catch(i){r.push(`Failed to remove registered spatial artifact ${a}: ${String(i)}`)}}return{removed:n,warnings:r}}var Cn=class{databasePath;artifactRoot;recoveredFromBackupPath;now;testHooks;configuredRetentionPolicy;database;closed=!1;constructor(t={}){let n=t.testHooks?.readWindowsDriveType;this.databasePath=Pf(t.databasePath,n),this.artifactRoot=Lf(this.databasePath,t.artifactRoot,n),this.now=t.now??Date.now,this.testHooks=t.testHooks??{};let r=t.retentionPolicy===void 0?Vf():void 0,o=t.retentionPolicy!==void 0?t.retentionPolicy:r;this.configuredRetentionPolicy=o===!1?!1:{...o??{}},Cl(_a(this.databasePath),{recursive:!0}),Cl(this.artifactRoot,{recursive:!0});let a=co(this.databasePath),i=Bf(this.databasePath);this.database=i.database,this.recoveredFromBackupPath=i.recoveredFromBackupPath;try{qf(this.database,this.databasePath,a,this.now(),t.testHooks),oo(this.database),t.cleanupExpiredStagingOnOpen!==!1&&this.cleanupExpiredStaging(this.now()),this.applyConfiguredRetention()}catch(s){try{this.database.close()}catch{}throw this.closed=!0,s}}close(){this.closed||(this.database.pragma("wal_checkpoint(TRUNCATE)"),this.database.close(),this.closed=!0)}getSchemaVersion(){return this.assertOpen(),Ml(this.database)}isRTreeAvailable(){return this.assertOpen(),oo(this.database),!0}beginCapture(t){this.assertOpen();let n=ye(this.now(),"current time"),r=ye(t.capturedAtMs??n,"capturedAtMs"),o=ye(t.expiresAtMs??n+Tf,"expiresAtMs");if(o<=n)throw new RangeError("expiresAtMs must be in the future when a capture begins.");let a=(t.artifactPaths??[]).map(i=>{let s=Nt(le(i,"artifactPath"));if(s===this.artifactRoot||!nr(this.artifactRoot,s))throw new st("artifact_path",`A spatial artifact must be a child of the dedicated artifact root ${this.artifactRoot}: ${s}`);return s});this.database.transaction(()=>{this.database.prepare(`
        INSERT INTO spatial_capture_staging(
          capture_id, snapshot_id, document_key, scope_fingerprint,
          revision_fingerprint, schema_version, extractor_version,
          scope_json, declared_counts_json, effective_source_policy_json,
          coverage_json, transform_validation_json, capture_metadata_json,
          captured_at_ms, created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(le(t.captureId,"captureId"),le(t.snapshotId,"snapshotId"),le(t.documentKey,"documentKey"),le(t.scopeFingerprint,"scopeFingerprint"),le(t.revisionFingerprint,"revisionFingerprint"),le(t.schemaVersion,"schemaVersion"),le(t.extractorVersion,"extractorVersion"),we(t.scope,"scope"),t.counts===void 0?null:we(t.counts,"counts"),t.effectiveSourcePolicy===void 0?null:we(t.effectiveSourcePolicy,"effectiveSourcePolicy"),t.coverage===void 0?null:we(t.coverage,"coverage"),t.transformValidation===void 0?null:we(t.transformValidation,"transformValidation"),we(t.captureMetadata??{},"captureMetadata"),r,n,n,o);let i=this.database.prepare("INSERT INTO spatial_staging_artifacts(capture_id, artifact_path) VALUES (?, ?)");for(let s of new Set(a))i.run(t.captureId,s)})()}stagePage(t){this.assertOpen();let n=ye(t.ordinal,"page ordinal"),r=ye(t.payloadBytes,"payloadBytes"),o=t.omissions??[];this.database.transaction(()=>{let a=this.database.prepare("SELECT * FROM spatial_capture_staging WHERE capture_id = ?").get(t.captureId);if(!a)throw new Error(`Unknown spatial capture: ${t.captureId}`);if(a.expires_at_ms<=this.now())throw new Error(`Spatial capture lease expired: ${t.captureId}`);let i=this.database.prepare(`
        SELECT page_ordinal, page_hash, has_more
        FROM spatial_staging_pages
        WHERE capture_id = ?
        ORDER BY page_ordinal DESC
        LIMIT 1
      `).get(t.captureId),s=i?i.page_ordinal+1:0;if(n!==s)throw new Error(`Expected spatial page ordinal ${s}, received ${n}.`);if(i&&i.has_more!==1)throw new Error("Cannot append a page after a terminal spatial page.");let l=t.priorPageHash?.trim()||null;if(i&&l!==i.page_hash)throw new Error("Spatial page priorPageHash does not match the staged page chain.");if(!i&&l!==null)throw new Error("The first spatial page must not declare a priorPageHash.");this.database.prepare(`
        INSERT INTO spatial_staging_pages(
          capture_id, page_ordinal, prior_page_hash, page_hash, has_more,
          payload_bytes, record_count, omission_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.captureId,n,l,le(t.pageHash,"pageHash"),t.hasMore?1:0,r,t.nodes.length,o.length);let u=this.database.prepare(`
        INSERT INTO spatial_staging_nodes(
          capture_id, page_ordinal, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let p of t.nodes){let g=Tl(p.aabb);u.run(t.captureId,n,le(p.nodeId,"nodeId"),le(p.documentKey,"node.documentKey"),le(p.nodeKind,"nodeKind"),p.elementUniqueId?.trim()||null,p.linkInstanceUniqueId?.trim()||null,...g,we(p.payload,"node.payload"))}let m=this.database.prepare(`
        INSERT INTO spatial_staging_omissions(
          capture_id, page_ordinal, document_key, reason, source_identity, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);for(let p of o)m.run(t.captureId,n,le(p.documentKey,"omission.documentKey"),le(p.reason,"omission.reason"),p.sourceIdentity?.trim()||null,we(p.payload,"omission.payload"));this.database.prepare("UPDATE spatial_capture_staging SET updated_at_ms = ? WHERE capture_id = ?").run(this.now(),t.captureId)})()}commitCapture(t){if(this.assertOpen(),t.sourceRevisions.length===0)throw new Error("An atomic spatial snapshot requires at least one source revision.");if(!t.partial&&t.coverageStatus&&t.coverageStatus!=="complete")throw new Error("A non-partial spatial snapshot cannot have incomplete coverageStatus.");let n=ye(t.expectedPageCount,"expectedPageCount"),r=ye(t.expectedPayloadBytes,"expectedPayloadBytes"),o=ye(t.expectedNodeCount,"expectedNodeCount"),a=ye(t.expectedOmissionCount,"expectedOmissionCount");if(n<1)throw new RangeError("expectedPageCount must be greater than zero.");let i=Object.fromEntries(Object.entries(t.expectedNodesByKind).map(([h,w])=>[le(h,"expected node kind"),ye(w,`expectedNodesByKind.${h}`)]));if(Object.values(i).reduce((h,w)=>h+w,0)!==o)throw new et("Expected node-kind counts do not sum to expectedNodeCount.");let s=we(t.counts,"final counts"),l=t.effectiveSourcePolicy===void 0?null:we(t.effectiveSourcePolicy,"final effectiveSourcePolicy"),u=we(t.coverage,"final coverage"),m=t.transformValidation===void 0?null:we(t.transformValidation,"final transformValidation"),p=this.database.transaction(()=>{let h=this.database.prepare("SELECT * FROM spatial_capture_staging WHERE capture_id = ?").get(t.captureId);if(!h)throw new Error(`Unknown spatial capture: ${t.captureId}`);if(h.expires_at_ms<=this.now())throw new Error(`Spatial capture lease expired: ${t.captureId}`);if(!t.sourceRevisions.some(y=>y.documentKey===h.document_key))throw new Error("Spatial source revisions do not include the capture host documentKey.");let w=this.database.prepare(`
        SELECT page_ordinal, page_hash, has_more
        FROM spatial_staging_pages
        WHERE capture_id = ?
        ORDER BY page_ordinal
      `).all(t.captureId);if(w.length===0||w.at(-1)?.has_more!==0)throw new Error("Atomic spatial capture cannot commit before its terminal page is staged.");w.forEach((y,B)=>{if(y.page_ordinal!==B)throw new Error("Atomic spatial capture contains a non-contiguous page sequence.")});let _=this.database.prepare(`
        SELECT
          COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
          COALESCE(SUM(record_count), 0) AS node_count,
          COALESCE(SUM(omission_count), 0) AS omission_count
        FROM spatial_staging_pages
        WHERE capture_id = ?
      `).get(t.captureId),L=this.database.prepare(`
        SELECT node_kind, count(*) AS count
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        GROUP BY node_kind
        ORDER BY node_kind
      `).all(t.captureId),R=this.database.prepare(`
        SELECT reason, count(*) AS count
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        GROUP BY reason
        ORDER BY reason
      `).all(t.captureId),A=Object.fromEntries(L.map(y=>[y.node_kind,y.count])),T=[];w.length!==n&&T.push(`pages expected ${n}, staged ${w.length}`),_.payload_bytes!==r&&T.push(`payloadBytes expected ${r}, staged ${_.payload_bytes}`),_.node_count!==o&&T.push(`nodes expected ${o}, staged ${_.node_count}`),_.omission_count!==a&&T.push(`omissions expected ${a}, staged ${_.omission_count}`);for(let y of new Set([...Object.keys(i),...Object.keys(A)])){let B=i[y]??0,W=A[y]??0;B!==W&&T.push(`${y} nodes expected ${B}, staged ${W}`)}if(T.length>0)throw new et(`Atomic spatial capture count reconciliation failed: ${T.join("; ")}.`);let j=we({totalNodes:_.node_count,nodesByKind:Object.fromEntries(L.map(y=>[y.node_kind,y.count])),omittedSupportedNodes:_.omission_count,omissionsByReason:Object.fromEntries(R.map(y=>[y.reason,y.count]))},"snapshot counts");this.database.prepare(`
        INSERT INTO spatial_snapshots(
          snapshot_id, document_key, captured_at_ms, committed_at_ms,
          scope_fingerprint, revision_fingerprint, schema_version, extractor_version,
          scope_json, declared_counts_json, effective_source_policy_json,
          coverage_json, transform_validation_json, capture_metadata_json,
          complete, partial, coverage_status, scan_stopped_reason,
          suggested_next_scopes_json, counts_json, page_count, payload_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(h.snapshot_id,h.document_key,h.captured_at_ms,this.now(),h.scope_fingerprint,h.revision_fingerprint,h.schema_version,h.extractor_version,h.scope_json,s,l,u,m,h.capture_metadata_json,t.partial?0:1,t.partial?1:0,t.coverageStatus??null,le(t.scanStoppedReason,"scanStoppedReason"),we(t.suggestedNextScopes??[],"suggestedNextScopes"),j,w.length,_.payload_bytes);let z=this.database.prepare(`
        INSERT INTO spatial_snapshot_sources(
          snapshot_id, source_key, document_key, document_session_id,
          tracker_session_id, loaded_version, change_sequence, change_sequence_state,
          oldest_retained_sequence, journal_entry_count, journal_capacity,
          journal_truncated, link_instance_unique_id, source_to_host_transform_json,
          document_key_resolution_json, external_link_update_available,
          source_revision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),J=new Set;for(let y of t.sourceRevisions){if(ye(y.changeSequence,"source changeSequence"),y.oldestRetainedSequence!==void 0&&y.oldestRetainedSequence!==null&&ye(y.oldestRetainedSequence,"source oldestRetainedSequence"),y.journalEntryCount!==void 0&&y.journalEntryCount!==null&&ye(y.journalEntryCount,"source journalEntryCount"),y.journalCapacity!==void 0&&y.journalCapacity!==null&&(ye(y.journalCapacity,"source journalCapacity"),y.journalCapacity===0))throw new RangeError("source journalCapacity must be greater than zero.");if(y.journalEntryCount!==void 0&&y.journalEntryCount!==null&&y.journalCapacity!==void 0&&y.journalCapacity!==null&&y.journalEntryCount>y.journalCapacity)throw new RangeError("source journalEntryCount cannot exceed journalCapacity.");let B=_l(y);if(J.has(B))throw new Error(`Duplicate spatial source revision: ${B}`);J.add(B),z.run(h.snapshot_id,B,le(y.documentKey,"source.documentKey"),le(y.documentSessionId,"source.documentSessionId"),y.trackerSessionId?.trim()||null,le(y.loadedVersion,"source.loadedVersion"),y.changeSequence,y.changeSequenceState?.trim()||null,y.oldestRetainedSequence??null,y.journalEntryCount??null,y.journalCapacity??null,y.journalTruncated?1:0,y.linkInstanceUniqueId?.trim()||null,we(y.sourceToHostTransform,"source.sourceToHostTransform"),y.documentKeyResolution===void 0?null:we(y.documentKeyResolution,"source.documentKeyResolution"),y.externalLinkUpdateAvailable?1:0,we(y,"source revision"))}return this.database.prepare(`
        INSERT INTO spatial_nodes(
          snapshot_id, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json
        )
        SELECT ?, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_node_rowid
      `).run(h.snapshot_id,t.captureId),this.database.prepare(`
        INSERT INTO spatial_omissions(
          snapshot_id, document_key, reason, source_identity, payload_json
        )
        SELECT ?, document_key, reason, source_identity, payload_json
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_omission_rowid
      `).run(h.snapshot_id,t.captureId),this.database.prepare(`
        INSERT INTO spatial_snapshot_artifacts(snapshot_id, artifact_path)
        SELECT ?, artifact_path
        FROM spatial_staging_artifacts
        WHERE capture_id = ?
      `).run(h.snapshot_id,t.captureId),this.database.prepare("DELETE FROM spatial_capture_staging WHERE capture_id = ?").run(t.captureId),h.snapshot_id})(),g=this.getSnapshot(p);if(!g)throw new et(`Committed spatial snapshot ${p} is not readable.`);return g}getSnapshot(t){this.assertOpen();let n=this.database.prepare(`
      SELECT
        s.snapshot_id AS snapshotId,
        s.document_key AS documentKey,
        s.captured_at_ms AS capturedAtMs,
        s.committed_at_ms AS committedAtMs,
        s.scope_fingerprint AS scopeFingerprint,
        s.revision_fingerprint AS revisionFingerprint,
        s.schema_version AS schemaVersion,
        s.extractor_version AS extractorVersion,
        s.complete AS complete,
        s.partial AS partial,
        s.coverage_status AS coverageStatus,
        s.scan_stopped_reason AS scanStoppedReason,
        s.page_count AS pageCount,
        s.payload_bytes AS payloadBytes,
        (SELECT count(*) FROM spatial_snapshot_sources x WHERE x.snapshot_id = s.snapshot_id) AS sourceCount,
        (SELECT count(*) FROM spatial_nodes n WHERE n.snapshot_id = s.snapshot_id) AS nodeCount,
        (SELECT count(*) FROM spatial_omissions o WHERE o.snapshot_id = s.snapshot_id) AS omissionCount
      FROM spatial_snapshots s
      WHERE s.snapshot_id = ?
    `).get(t);return n?{...n,complete:n.complete===1,partial:n.partial===1}:null}getSnapshotSources(t){return this.assertOpen(),this.database.prepare(`
      SELECT
        document_key, document_session_id, tracker_session_id, loaded_version,
        change_sequence, change_sequence_state, oldest_retained_sequence,
        journal_entry_count, journal_capacity, journal_truncated,
        link_instance_unique_id, source_to_host_transform_json,
        document_key_resolution_json, external_link_update_available,
        source_revision_json
      FROM spatial_snapshot_sources
      WHERE snapshot_id = ?
      ORDER BY source_key
    `).all(t).map(r=>{let o=it(r.source_revision_json,"source revision");return{...o&&typeof o=="object"&&!Array.isArray(o)?o:{},documentKey:r.document_key,documentSessionId:r.document_session_id,trackerSessionId:r.tracker_session_id,loadedVersion:r.loaded_version,changeSequence:r.change_sequence,changeSequenceState:r.change_sequence_state,oldestRetainedSequence:r.oldest_retained_sequence,journalEntryCount:r.journal_entry_count,journalCapacity:r.journal_capacity,journalTruncated:r.journal_truncated===1,linkInstanceUniqueId:r.link_instance_unique_id,sourceToHostTransform:it(r.source_to_host_transform_json,"source-to-host transform"),documentKeyResolution:it(r.document_key_resolution_json,"document-key resolution"),externalLinkUpdateAvailable:r.external_link_update_available===1}})}getSnapshotRecord(t){this.assertOpen();let n=this.getSnapshot(t);if(!n)return null;let r=this.database.prepare(`
      SELECT scope_json, declared_counts_json, counts_json,
        effective_source_policy_json, coverage_json,
        transform_validation_json, capture_metadata_json
      FROM spatial_snapshots
      WHERE snapshot_id = ?
    `).get(t);return{...n,scope:it(r.scope_json,"snapshot scope"),declaredCounts:it(r.declared_counts_json,"declared snapshot counts"),derivedCounts:it(r.counts_json,"derived snapshot counts"),effectiveSourcePolicy:it(r.effective_source_policy_json,"effective source policy"),coverage:it(r.coverage_json,"snapshot coverage"),transformValidation:it(r.transform_validation_json,"transform validation"),captureMetadata:it(r.capture_metadata_json,"capture metadata"),sourceRevisions:this.getSnapshotSources(t)}}listSnapshots(t){return this.assertOpen(),(t?this.database.prepare(`
          SELECT snapshot_id FROM spatial_snapshots
          WHERE document_key = ? ORDER BY captured_at_ms DESC, snapshot_id
        `).all(t):this.database.prepare(`
          SELECT snapshot_id FROM spatial_snapshots
          ORDER BY document_key, captured_at_ms DESC, snapshot_id
        `).all()).map(r=>this.getSnapshot(r.snapshot_id)).filter(r=>r!==null)}queryIntersectingAabbs(t,n){this.assertOpen(),oo(this.database);let r=Tl(t),o=[r[1],r[0],r[3],r[2],r[5],r[4]];return this.database.prepare(`
      SELECT n.snapshot_id, n.node_id, n.document_key, n.node_kind,
        n.min_x, n.max_x, n.min_y, n.max_y, n.min_z, n.max_z
      FROM spatial_node_rtree r
      JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
      WHERE r.min_x <= ? AND r.max_x >= ?
        AND r.min_y <= ? AND r.max_y >= ?
        AND r.min_z <= ? AND r.max_z >= ?
        ${n?"AND n.snapshot_id = ?":""}
      ORDER BY n.snapshot_id, n.node_id
    `).all(...o,...n?[n]:[]).map(i=>({snapshotId:i.snapshot_id,nodeId:i.node_id,documentKey:i.document_key,nodeKind:i.node_kind,aabb:{minMm:[i.min_x,i.min_y,i.min_z],maxMm:[i.max_x,i.max_y,i.max_z]}}))}countRTreeEntries(t){return this.assertOpen(),oo(this.database),(t?this.database.prepare(`
          SELECT count(*) AS count
          FROM spatial_node_rtree r
          JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
          WHERE n.snapshot_id = ?
        `).get(t):this.database.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get()).count}getStagingCaptureCount(){return this.assertOpen(),this.database.prepare("SELECT count(*) AS count FROM spatial_capture_staging").get().count}abandonCapture(t){this.assertOpen();let n=this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts WHERE capture_id = ?
    `).all(t),r=this.database.prepare("DELETE FROM spatial_capture_staging WHERE capture_id = ?").run(t),o=ba(n.map(a=>a.artifact_path),this.artifactRoot);return{purgedSnapshotCount:0,purgedStagingCaptureCount:r.changes,removedArtifactCount:o.removed,artifactWarnings:o.warnings}}cleanupExpiredStaging(t=this.now()){this.assertOpen(),ye(t,"nowMs");let n=this.database.prepare(`
      SELECT capture_id FROM spatial_capture_staging WHERE expires_at_ms <= ?
    `).all(t);if(n.length===0)return{purgedSnapshotCount:0,purgedStagingCaptureCount:0,removedArtifactCount:0,artifactWarnings:[]};let r=n.map(()=>"?").join(", "),o=n.map(l=>l.capture_id),a=this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts
      WHERE capture_id IN (${r})
    `).all(...o),i=this.database.prepare(`
      DELETE FROM spatial_capture_staging WHERE capture_id IN (${r})
    `).run(...o),s=ba(a.map(l=>l.artifact_path),this.artifactRoot);return{purgedSnapshotCount:0,purgedStagingCaptureCount:i.changes,removedArtifactCount:s.removed,artifactWarnings:s.warnings}}applyRetention(t={}){this.assertOpen();let n=ye(t.nowMs??this.now(),"retention nowMs"),r=ye(t.retentionDays??xf,"retentionDays"),o=ye(t.minCompleteSnapshots??vf,"minCompleteSnapshots"),a=n-r*If,i=this.database.prepare(`
      SELECT snapshot_id, document_key, captured_at_ms, complete
      FROM spatial_snapshots
      ORDER BY document_key, captured_at_ms DESC, snapshot_id DESC
    `).all(),s=new Map,l=[];for(let u of i){let m=s.get(u.document_key)??0;u.complete===1&&(m+=1,s.set(u.document_key,m));let p=u.captured_at_ms>=a,g=u.complete===1&&m<=o;!p&&!g&&l.push(u.snapshot_id)}return l.length===0?{purgedSnapshotCount:0,purgedStagingCaptureCount:0,removedArtifactCount:0,artifactWarnings:[]}:this.purge({snapshotIds:l})}applyConfiguredRetention(){return this.assertOpen(),this.configuredRetentionPolicy===!1?{purgedSnapshotCount:0,purgedStagingCaptureCount:0,removedArtifactCount:0,artifactWarnings:[]}:this.applyRetention({...this.configuredRetentionPolicy,nowMs:this.now()})}previewPurge(t){this.assertOpen();let n=this.resolvePurgeTargets(t);return{snapshotIds:[...n.snapshotIds],stagingCaptureIds:[...n.stagingCaptureIds],snapshotCount:n.snapshotIds.length,stagingCaptureCount:n.stagingCaptureIds.length}}purge(t){this.assertOpen();let{snapshotIds:n,stagingCaptureIds:r}=this.resolvePurgeTargets(t),o=this.artifactsForIds("spatial_snapshot_artifacts","snapshot_id",n),a=this.artifactsForIds("spatial_staging_artifacts","capture_id",r),i=this.database.transaction(()=>{let u=this.deleteByIds("spatial_snapshots","snapshot_id",n),m=this.deleteByIds("spatial_capture_staging","capture_id",r);return{snapshotCount:u,stagingCount:m}})(),s=ba([...o,...a],this.artifactRoot),l=i.snapshotCount>0?this.refreshRecoveryBackupAfterPurge():[];return{purgedSnapshotCount:i.snapshotCount,purgedStagingCaptureCount:i.stagingCount,removedArtifactCount:s.removed,artifactWarnings:[...s.warnings,...l]}}resolvePurgeTargets(t){if(+(t.all===!0)+ +!!t.documentKey+ +!!t.snapshotIds!==1)throw new Error("Spatial purge requires exactly one explicit selector: all, documentKey, or snapshotIds.");let r,o=[];if(t.all)r=this.database.prepare("SELECT snapshot_id FROM spatial_snapshots ORDER BY snapshot_id").all().map(a=>a.snapshot_id),o=this.database.prepare("SELECT capture_id FROM spatial_capture_staging ORDER BY capture_id").all().map(a=>a.capture_id);else if(t.documentKey){let a=le(t.documentKey,"purge documentKey");r=this.database.prepare("SELECT snapshot_id FROM spatial_snapshots WHERE document_key = ? ORDER BY snapshot_id").all(a).map(i=>i.snapshot_id),o=this.database.prepare("SELECT capture_id FROM spatial_capture_staging WHERE document_key = ? ORDER BY capture_id").all(a).map(i=>i.capture_id)}else{let a=[...new Set((t.snapshotIds??[]).map(s=>le(s,"snapshotId")))];if(a.length===0)throw new Error("Spatial purge snapshotIds selector requires at least one snapshotId.");let i=a.map(()=>"?").join(", ");r=this.database.prepare(`
        SELECT snapshot_id FROM spatial_snapshots
        WHERE snapshot_id IN (${i})
        ORDER BY snapshot_id
      `).all(...a).map(s=>s.snapshot_id)}return{snapshotIds:r,stagingCaptureIds:o}}artifactsForIds(t,n,r){if(r.length===0)return[];let o=r.map(()=>"?").join(", ");return this.database.prepare(`
      SELECT artifact_path FROM ${t} WHERE ${n} IN (${o})
    `).all(...r).map(a=>a.artifact_path)}deleteByIds(t,n,r){if(r.length===0)return 0;let o=r.map(()=>"?").join(", ");return this.database.prepare(`
      DELETE FROM ${t} WHERE ${n} IN (${o})
    `).run(...r).changes}refreshRecoveryBackupAfterPurge(){let t=[],n;try{this.testHooks.beforeRecoveryBackupCreate?.(),n=kl(this.database,this.databasePath,this.now())}catch(r){return t.push(`Failed to create and verify a post-purge spatial recovery backup; previous backups were preserved: ${String(r)}`),t}for(let r of Ca(this.databasePath))if(r!==n)try{this.testHooks.beforeRecoveryBackupDelete?.(r),_n(r,{force:!0})}catch(o){t.push(`Failed to remove a pre-purge spatial recovery backup that may retain purged data ${r}: ${String(o)}`)}return t}assertOpen(){if(this.closed)throw new Error("Spatial store is closed.")}};var rr=class extends Error{reason;constructor(t,n,r){super(n,r),this.name="SpatialStoreCapabilityError",this.reason=t}},Qt=null,Yt={available:!1,state:"not_initialized",reason:null,schemaVersion:null,rtreeAvailable:!1},Ol=!1;function zf(e){if(e instanceof tr)return"spatial_rtree_unavailable";if(e instanceof st)return e.reason==="network_path"?"spatial_store_network_path_rejected":e.reason==="managed_package_path"?"spatial_store_managed_path_rejected":"spatial_store_artifact_path_rejected";let t=e instanceof Error?e.message:String(e);return/better_sqlite3|bindings file|native module/i.test(t)?"spatial_sqlite_native_binding_unavailable":/migration/i.test(t)?"spatial_store_migration_failed":/integrity|quick_check|malformed|corrupt/i.test(t)?"spatial_store_recovery_failed":"spatial_store_unavailable"}function Pl(){try{Qt?.close()}catch{}Qt=null}function Ra(){if(Yt.state!=="not_initialized")return{...Yt};try{Qt=new Cn;let e=Qt.getSchemaVersion(),t=Qt.isRTreeAvailable();Yt={available:!0,state:"ready",reason:null,schemaVersion:e,rtreeAvailable:t},Ol||(process.once("exit",Pl),Ol=!0)}catch(e){Pl(),Yt={available:!1,state:"guarded",reason:zf(e),schemaVersion:null,rtreeAvailable:!1}}return{...Yt}}function uo(){return Yt.state==="not_initialized"?Ra():{...Yt}}function Ll(){let e=uo();if(!e.available||!Qt)throw new rr(e.reason||"spatial_store_unavailable","The durable spatial store is unavailable. Capture was guarded before any snapshot became visible.");return Qt}var Uf=new Date().toISOString(),Wf="revit-mcp-status.v3",Hf="revit-mcp-runtime-tools.42";function Gf(){let e=vt(Dl.join(Pt(),"package.json"));return{packageName:e?.name||"revagent-runtime",packageVersion:e?.version||"unknown"}}function Vl(){let e=Gf(),t=On([Dl.join(process.cwd(),"..","updater","installed.json")]),n=t?.version||e.packageVersion;return{runtimeVersion:n,schemaVersion:Wf,toolSurfaceVersion:Hf,processStartedAtUtc:Uf,buildTimestampUtc:t?.installedAtUtc||null,buildHash:Pn(n),packageName:e.packageName,packageVersion:e.packageVersion,nodeVersion:process.version}}function Fl(e){e.tool("get_revit_mcp_status","Read the revAgent task status without waiting behind the active Revit command lock. Includes runtime identity, the durable spatial-store/R*Tree capability state, bridge resultContractVersion when available, and summary runtimeActivity for revAgent-side/client-side guarded operations that may not reach Revit.",{...I(Mt),includeRecentTasks:Mt.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),recentLimit:Mt.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),includeRuntimeActivity:Mt.boolean().optional().describe("Include MCP-side/client-side active and recent activity. Defaults true so guard-only tasks that did not reach Revit remain auditable."),runtimeActivityLimit:Mt.number().int().min(0).max(100).optional().describe("Maximum runtimeActivity.recentActivity rows to return. Defaults 10."),runtimeActivityMode:Mt.enum(["summary","full"]).optional().describe("runtimeActivity shape. summary is the default and collapses started/completed pairs into latest completed/guarded/failed rows without responseKeys. full includes started rows and full result summaries."),includeDiagnostics:Mt.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),timeoutMs:Mt.number().int().positive().max(1e4).optional().describe("Connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.includeRuntimeActivity===!1?void 0:wi(t.runtimeActivityLimit??10,t.runtimeActivityMode||"summary");try{let r=t.timeoutMs||3e3,o=await Je(async s=>await s.sendCommand("mcp_status",{},{timeoutMs:r}),{...Se(t),skipLock:!0,connectTimeoutMs:r}),a=zn(ht(o),{includeRecentTasks:t.includeRecentTasks,recentLimit:t.recentLimit,includeDiagnostics:t.includeDiagnostics});Er(o);let i=a&&typeof a=="object"&&!Array.isArray(a)?a:{status:a};return f({...i,...n?{runtimeActivity:n}:{},spatialStore:uo(),runtimeIdentity:Vl()})}catch(r){return f({success:!1,error:r instanceof Error?r.message:String(r),...n?{runtimeActivity:n}:{},spatialStore:uo(),runtimeIdentity:Vl()})}})}import{z as G}from"zod";import Jf from"node:crypto";import jl from"node:path";import{Ajv2020 as $f}from"ajv/dist/2020.js";import Xf from"ajv-formats";var Ea={"0.1":"https://schemas.revagent.app/spatial/v0.1/extraction-page.schema.json","0.2":"https://schemas.revagent.app/spatial/v0.2/extraction-page.schema.json"},bw=Ea["0.2"],Ta="https://schemas.revagent.app/spatial/v0.2/work-continuation.schema.json",zl=["element-ref.schema.json","node-ref.schema.json","source-revision.schema.json","cursor-envelope.schema.json","spatial-snapshot.schema.json","extraction-page.schema.json"],Kf=[...zl,"work-cursor-envelope.schema.json","work-continuation.schema.json"];function tt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function Rn(e){if(typeof e=="number"&&!Number.isFinite(e))throw new Error("Spatial canonical JSON rejects non-finite numbers.");return Array.isArray(e)?`[${e.map(Rn).join(",")}]`:tt(e)?`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${Rn(e[t])}`).join(",")}}`:JSON.stringify(e)}function mo(e){if(e===null)return"null";if(typeof e=="number"){if(!Number.isFinite(e))throw new Error("Semantic spatial JSON cannot contain a non-finite number.");let t=Object.is(e,-0)?0:e,n=new ArrayBuffer(8),r=new DataView(n);return r.setFloat64(0,t,!1),JSON.stringify(`n:${r.getBigUint64(0,!1).toString(16).padStart(16,"0")}`)}return typeof e=="string"?JSON.stringify(`s:${e}`):typeof e!="object"?JSON.stringify(e):Array.isArray(e)?`[${e.map(mo).join(",")}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${mo(e[t])}`).join(",")}}`}function Yf(e){return`sha256:${Jf.createHash("sha256").update(mo(e),"utf8").digest("hex")}`}function Bl(e){let t=jl.join(Pt(),"schemas","spatial",`v${e}`),r=(e==="0.2"?Kf:zl).map(l=>{let u=vt(jl.join(t,l));if(!u)throw new Error(`Missing required spatial schema: ${l}`);return u}),o=new $f({allErrors:!0,strict:!0,strictRequired:!1,allowUnionTypes:!0});Xf(o);for(let l of r)o.addSchema(l);let a=Ea[e],i=o.getSchema(a);if(!i)throw new Error(`Spatial extraction page schema was not compiled: ${a}`);let s=e==="0.2"?o.getSchema(Ta):null;if(e==="0.2"&&!s)throw new Error(`Spatial work continuation schema was not compiled: ${Ta}`);return{extractionPageValidator:i,workContinuationValidator:s}}var Ia={"0.1":Bl("0.1"),"0.2":Bl("0.2")},Qf={"0.1":Ia["0.1"].extractionPageValidator,"0.2":Ia["0.2"].extractionPageValidator},ql=Ia["0.2"].workContinuationValidator;function Ul(e){return(e||[]).slice(0,100).map(t=>{let n=t.instancePath||"/",r=t.keyword==="additionalProperties"&&t.params?.additionalProperty?` unexpected property ${String(t.params.additionalProperty)}`:"";return`${n} ${String(t.message||t.keyword)}${r}`.trim()})}function Zf(e){let t=[],n=tt(e.page)?e.page:{},r=Array.isArray(e.nodes)?e.nodes:[],o=Array.isArray(e.omissions)?e.omissions:[];if(e.snapshotId!==e.captureId&&t.push("/snapshotId must equal captureId for the Phase 0 native page"),n.recordCount!==void 0&&n.recordCount!==r.length&&t.push("/page/recordCount must equal nodes.length"),n.nodeCount!==void 0&&n.nodeCount!==r.length&&t.push("/page/nodeCount must equal nodes.length"),n.omissionCount!==o.length&&t.push("/page/omissionCount must equal omissions.length"),n.rowCount!==void 0&&n.rowCount!==r.length+o.length&&t.push("/page/rowCount must equal nodes.length + omissions.length"),n.pageHash!==n.pageSha256&&t.push("/page/pageHash must equal pageSha256"),n.priorPageHash!==n.priorPageSha256&&t.push("/page/priorPageHash must equal priorPageSha256"),n.nextCursor!==e.nextCursor&&t.push("/page/nextCursor must equal top-level nextCursor"),n.ordinal===0&&n.priorPageHash!==null&&t.push("/page/priorPageHash must be null on page 0"),n.ordinal>0&&typeof n.priorPageHash!="string"&&t.push("/page/priorPageHash is required after page 0"),e.pageCount<n.ordinal+1&&t.push("/pageCount cannot be smaller than page.ordinal + 1"),tt(e.coverage)){e.coverage.pageNodeCount!==r.length&&t.push("/coverage/pageNodeCount must equal nodes.length"),e.coverage.pageOmissionCount!==o.length&&t.push("/coverage/pageOmissionCount must equal omissions.length");let i=Array.isArray(e.sourceRevisions)?e.sourceRevisions:[];e.coverage.sourceCount!==i.length&&t.push("/coverage/sourceCount must equal sourceRevisions.length"),tt(e.effectiveSourcePolicy)&&e.coverage.effectiveScope!==e.effectiveSourcePolicy.hasEffectiveExtractionPolicy&&t.push("/coverage/effectiveScope must equal effectiveSourcePolicy.hasEffectiveExtractionPolicy")}if(tt(e.effectiveSourcePolicy)){let i=Array.isArray(e.effectiveSourcePolicy.effectiveSources)?e.effectiveSourcePolicy.effectiveSources:[];e.effectiveSourcePolicy.effectiveSourceCount!==i.length&&t.push("/effectiveSourcePolicy/effectiveSourceCount must equal effectiveSources.length")}let a=Array.isArray(n.rows)?n.rows:null;if(a){let i=a.filter(m=>tt(m)&&m.node!==void 0).map(m=>m.node),s=a.filter(m=>tt(m)&&m.omission!==void 0).map(m=>m.omission);a.length!==r.length+o.length&&t.push("/page/rows length must equal nodes.length + omissions.length"),Rn(i)!==Rn(r)&&t.push("/page/rows node records must exactly reproduce top-level nodes"),Rn(s)!==Rn(o)&&t.push("/page/rows omission records must exactly reproduce top-level omissions");let l=Buffer.byteLength(mo(a),"utf8");n.payloadBytes!==l&&t.push("/page/payloadBytes must equal UTF-8 canonical IEEE-754 page.rows bytes");let u=Yf({captureId:e.captureId,pageOrdinal:n.ordinal,priorPageHash:n.priorPageHash,rows:a});n.pageHash!==u&&t.push("/page/pageHash must equal the canonical extraction-row envelope hash")}return t}function eg(e){let t=[],n=tt(e.preparation)?e.preparation:{};return e.snapshotId!==e.captureId&&t.push("/snapshotId must equal captureId for a Phase 1a work continuation"),n.nextCursor!==e.nextCursor&&t.push("/preparation/nextCursor must equal top-level nextCursor"),typeof n.total=="number"&&n.processed>n.total&&t.push("/preparation/processed cannot exceed preparation.total"),t}function Wl(e){let t=tt(e)&&typeof e.schemaVersion=="string"?e.schemaVersion:"",n=t==="0.1"||t==="0.2"?t:null,r=n?Qf[n]:null;if(!n||!r)return{valid:!1,errors:[`Unsupported spatial extraction schemaVersion: ${t||"<missing>"}`],schemaId:null};let o=r(e),a=Ul(r.errors);return o&&tt(e)&&a.push(...Zf(e)),{valid:a.length===0,errors:a,schemaId:Ea[n]}}function Hl(e){let t=ql(e),n=Ul(ql.errors);return t&&tt(e)&&n.push(...eg(e)),{valid:n.length===0,errors:n,schemaId:Ta}}var Gl="0.2",tg="host_internal_mm";var ng=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),Xl=new Set(["complete","incomplete_omissions","incomplete_budget"]);function At(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function S(e,...t){if(!At(e))return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let r of t){let o=n.find(([a])=>a.toLowerCase()===r.toLowerCase());if(o)return o[1]}}function ue(e){if(typeof e=="number"&&Number.isInteger(e)&&Number.isFinite(e))return e;if(typeof e=="string"&&/^-?\d+$/.test(e.trim())){let t=Number.parseInt(e,10);return Number.isSafeInteger(t)?t:null}return null}function Jl(e){if(typeof e=="number"&&Number.isFinite(e))return e;if(typeof e=="string"&&e.trim()){let t=Number(e);return Number.isFinite(t)?t:null}return null}function Na(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function rg(e,t,n){let r=String(e??"").trim().toLowerCase();return ng.has(r)?r:n?t?"max_items":"completed":"read_failed"}function $l(e,t){let n=String(S(e,"coverageStatus")??"").trim().toLowerCase();if(Xl.has(n))return n;if(t==="max_elapsed"||t==="max_items")return"incomplete_budget";let r=S(e,"counts"),o=S(e,"coverage"),a=ue(S(r,"omittedSupportedNodes"))??0,i=ue(S(o,"sourceAvailabilityOmissionCount"))??0;return a+i>0?"incomplete_omissions":"complete"}function po(e){return typeof e=="string"&&/^sha256:[a-f0-9]{64}$/i.test(e)}function or(e){return typeof e=="string"&&e.trim().length>0}function Kl(e,t){let n=At(e)?e:{},r=String(S(n,"schemaVersion")??""),o=S(n,"page"),a=At(o)?o:{},i=S(n,"nodes"),s=S(n,"omissions"),l=Array.isArray(i)?i:[],u=Array.isArray(s)?s:[],m=S(n,"success"),p=typeof m=="boolean"?m:!0,g=S(n,"guarded")===!0,h=String(S(n,"state")||(g?"guarded":p?"completed":"failed")),w=S(n,"nextCursor")??S(a,"nextCursor"),_=typeof w=="string"&&w.length>0?w:null,L=S(a,"hasMore"),R=typeof L=="boolean"?L:_!==null,A=ue(S(a,"ordinal","pageOrdinal")??S(n,"pageOrdinal")),T=ue(S(a,"targetBytes")),j=ue(S(a,"payloadBytes")),z=ue(S(n,"payloadBytes")),J=ue(S(a,"recordCount")),y=ue(S(a,"omissionCount")),B=ue(S(a,"nodeCount"))??J??l.length,W=ue(S(a,"rowCount"))??B+(y??u.length),se=S(a,"pageSha256","pageHash")??S(n,"pageHash"),de=S(a,"priorPageSha256","priorPageHash")??S(n,"priorPageHash"),Re=typeof de=="string"&&de.trim().length>0?de:null,Ee=S(n,"partial"),He=typeof Ee=="boolean"?Ee:R,he=rg(S(n,"scanStoppedReason"),R,p),Ae=p&&!g?$l(n,he):null,bt=Jl(S(n,"elapsedMs"))??Jl(t),rt=Na(S(n,"suggestedNextScopes"));R&&!rt.includes("cursor")&&rt.push("cursor");let Ge={...a,ordinal:A,targetBytes:T,payloadBytes:j,recordCount:J??B,rowCount:W,nodeCount:B,omissionCount:y??u.length,hasMore:R,pageSha256:se??null,priorPageSha256:Re,nextCursor:_},Fe={...n,success:p,guarded:g,state:h,action:"capture_spatial_snapshot",warnings:Na(S(n,"warnings")),notices:Na(S(n,"notices")),nodes:l,omissions:u,page:Ge,pageOrdinal:A,rowCount:W,nodeCount:B,omissionCount:y??u.length,payloadBytes:z,pagePayloadBytes:j,pageHash:se??null,priorPageHash:Re,nextCursor:_,partial:He,coverageStatus:Ae,scanStoppedReason:he,suggestedNextScopes:rt,elapsedMs:bt};if(Fe.snapshot={snapshotId:S(n,"snapshotId")??S(n,"captureId"),capturedAt:S(n,"capturedAt"),sourceRevisions:S(n,"sourceRevisions"),scope:S(n,"scope"),scopeFingerprint:S(n,"scopeFingerprint"),revisionFingerprint:S(n,"revisionFingerprint"),coordinateFrame:S(n,"coordinateFrame"),lengthUnit:S(n,"lengthUnit"),schemaVersion:S(n,"schemaVersion"),extractorVersion:S(n,"extractorVersion"),counts:S(n,"counts"),partial:He,coverageStatus:Ae,scanStoppedReason:he,suggestedNextScopes:Fe.suggestedNextScopes,pageCount:ue(S(n,"pageCount")),payloadBytes:ue(S(n,"payloadBytes"))},!p||g)return{payload:Fe,valid:!0,errors:[]};let x=Wl(n),P=[...x.errors];r!=="0.1"&&r!==Gl&&P.push(`schemaVersion must be 0.1 or ${Gl}`),S(n,"coordinateFrame")!==tg&&P.push("coordinateFrame must be host_internal_mm"),S(n,"lengthUnit")!=="mm"&&P.push("lengthUnit must be mm"),or(S(n,"extractorVersion"))||P.push("extractorVersion is required"),or(S(n,"captureId"))||P.push("captureId is required"),or(S(n,"snapshotId")??S(n,"captureId"))||P.push("snapshotId is required"),or(S(n,"capturedAt"))||P.push("capturedAt is required"),At(S(n,"scope"))||P.push("scope must be an object"),po(S(n,"scopeFingerprint"))||P.push("scopeFingerprint must use sha256:<64 hex>"),po(S(n,"revisionFingerprint"))||P.push("revisionFingerprint must use sha256:<64 hex>"),Array.isArray(S(n,"sourceRevisions"))||P.push("sourceRevisions must be an array"),At(S(n,"counts"))||P.push("counts must be an object");let je=ue(S(n,"pageCount"));(je===null||je<1)&&P.push("pageCount must be a positive integer");let Zt=ue(S(n,"payloadBytes"));(Zt===null||Zt<0)&&P.push("payloadBytes must be a non-negative integer"),r==="0.1"?(S(n,"liveness")!=="unknown"&&P.push("Phase 0 liveness must be unknown"),S(n,"atomic")!==!1&&P.push("Phase 0 atomic must be false")):r==="0.2"&&(S(n,"liveness")!=="staging"&&P.push("Phase 1a native transport page liveness must be staging"),S(n,"atomic")!==!1&&P.push("A Phase 1a native transport page is not the atomic store commit"),S(n,"captureConsistency")!=="document_change_sequence_bound"&&P.push("Phase 1a native transport page must be document_change_sequence_bound")),or(S(n,"revisionBasisCaveat"))||P.push("revisionBasisCaveat is required"),Array.isArray(i)||P.push("nodes must be an array"),At(o)||P.push("page must be an object"),(A===null||A<0)&&P.push("page.ordinal must be a non-negative integer"),(T===null||T<=0)&&P.push("page.targetBytes must be a positive integer"),(j===null||j<0)&&P.push("page.payloadBytes must be a non-negative integer"),(z===null||z<0)&&P.push("payloadBytes must be a non-negative logical capture total"),(B<0||B!==l.length)&&P.push("page.nodeCount/recordCount must equal nodes.length"),(y===null||y<0||y!==u.length)&&P.push("page.omissionCount must equal omissions.length"),(W<0||W!==l.length+u.length)&&P.push("page.rowCount must equal nodes.length + omissions.length"),po(se)||P.push("page.pageSha256 must use sha256:<64 hex>"),(A??0)>0&&!po(Re)&&P.push("page.priorPageSha256 must use sha256:<64 hex> after page 0"),R&&_===null&&P.push("page.nextCursor is required when page.hasMore is true"),!R&&_!==null&&P.push("page.nextCursor must be null when page.hasMore is false"),R&&!He&&P.push("partial must be true while page.hasMore is true");let kt=S(n,"coverageStatus");return kt!==void 0&&!Xl.has(String(kt).trim().toLowerCase())&&P.push("coverageStatus must be complete, incomplete_omissions, or incomplete_budget"),kt!==void 0&&String(kt).trim().toLowerCase()!==$l({...n,coverageStatus:void 0},he)&&P.push("coverageStatus conflicts with total omission/budget evidence"),he==="read_failed"&&Ae==="complete"&&P.push("read_failed requires omission coverage evidence"),He!==(R||Ae!=="complete")&&P.push("partial conflicts with pagination/coverage state"),(Ae==="incomplete_budget"?new Set(["max_elapsed","max_items"]):R?new Set(["max_bytes"]):Ae==="incomplete_omissions"?new Set(["read_failed"]):new Set(["completed"])).has(he)||P.push("scanStoppedReason conflicts with pagination/coverage state"),Fe.contractValidation={version:`spatial-extraction-page.v${r||"unknown"}`,schemaId:x.schemaId,valid:P.length===0,errors:P},Fe.pageEvidence=og(Fe),{payload:Fe,valid:P.length===0,errors:P}}function og(e){let t=At(e)?e:{},n=At(S(t,"page"))?S(t,"page"):{},r=S(t,"captureId"),o=S(t,"nextCursor")??S(n,"nextCursor");return{captureId:typeof r=="string"?r:null,pageOrdinal:ue(S(n,"ordinal")??S(t,"pageOrdinal")),pageHash:S(n,"pageSha256")??S(t,"pageHash")??null,priorPageHash:S(n,"priorPageSha256")??S(t,"priorPageHash")??null,rowCount:ue(S(n,"rowCount")??S(t,"rowCount")),nodeCount:ue(S(n,"nodeCount","recordCount")??S(t,"nodeCount")),omissionCount:ue(S(n,"omissionCount")),pagePayloadBytes:ue(S(n,"payloadBytes")??S(t,"pagePayloadBytes")),payloadBytes:ue(S(t,"payloadBytes")),hasMore:S(n,"hasMore")===!0,nextCursorPresent:typeof o=="string"&&o.length>0}}var ag="0.2",ka=45e3,go=12e4,ig=2,Yl=1e4,Ql=1e4,Zl={discover:0,filter:1,extract:2,finalize:3};function ie(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function b(e,...t){if(ie(e)){for(let n of t)if(Object.prototype.hasOwnProperty.call(e,n))return e[n];for(let[n,r]of Object.entries(e))if(t.some(o=>n.toLowerCase()===o.toLowerCase()))return r}}function C(e){return typeof e=="string"?e.trim():""}function X(e){if(typeof e=="number"&&Number.isSafeInteger(e))return e;if(typeof e=="string"&&/^-?\d+$/.test(e.trim())){let t=Number.parseInt(e,10);return Number.isSafeInteger(t)?t:null}return null}function Ma(e){if(e==null||e==="")return null;let t=typeof e=="number"?e:Number(e);return Number.isFinite(t)?t:null}function We(e){if(e===null||typeof e!="object")return JSON.stringify(e);if(Array.isArray(e))return`[${e.map(We).join(",")}]`;let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${We(t[n])}`).join(",")}}`}function sg(e,t){let n=Date.parse(C(e));return Number.isFinite(n)&&n>=0?n:t}function ec(e){if(!Array.isArray(e)||e.length!==3)return null;let t=e.map(Ma);return t.every(n=>n!==null)?[t[0],t[1],t[2]]:null}function lg(e){let t=b(e,"geometry"),n=b(t,"aabb"),r=ec(b(n,"min","minMm")),o=ec(b(n,"max","maxMm"));return!r||!o||r.some((a,i)=>a>o[i])?null:{minMm:r,maxMm:o}}function cg(e){let t=ie(e)?e:{},n=ie(b(t,"nodeRef"))?b(t,"nodeRef"):t,r=ie(b(t,"elementRef"))?b(t,"elementRef"):ie(b(n,"elementRef"))?b(n,"elementRef"):{},o=Array.isArray(b(t,"sourceRefs"))?b(t,"sourceRefs"):b(n,"sourceRefs"),a=Array.isArray(o)&&ie(o[0])?o[0]:{},i=C(b(r,"documentKey"))||C(b(a,"documentKey"));return{nodeId:C(b(t,"nodeId"))||C(b(n,"nodeId")),documentKey:i,nodeKind:C(b(t,"nodeKind"))||C(b(n,"nodeKind")),elementUniqueId:C(b(r,"elementUniqueId"))||null,linkInstanceUniqueId:C(b(r,"linkInstanceUniqueId"))||C(b(a,"linkInstanceUniqueId"))||null,aabb:lg(t),payload:t}}function ug(e){let t=ie(e)?e:{},n=b(t,"elementRef"),r=b(t,"sessionEvidence"),o=ie(n)?n:ie(r)?r:{};return{documentKey:C(b(t,"documentKey"))||C(b(o,"documentKey"))||"unknown",reason:C(b(t,"classification","reason"))||"unclassified",sourceIdentity:C(b(o,"elementUniqueId"))||C(b(t,"linkInstanceUniqueId"))||null,payload:t}}function dg(e){let t=ie(e)?e:{};return{documentKey:C(b(t,"documentKey")),documentSessionId:C(b(t,"documentSessionId")),trackerSessionId:C(b(t,"trackerSessionId"))||null,loadedVersion:C(b(t,"loadedVersion")),changeSequence:X(b(t,"changeSequence"))??0,changeSequenceState:C(b(t,"changeSequenceState"))||null,oldestRetainedSequence:X(b(t,"oldestRetainedSequence")),journalEntryCount:X(b(t,"journalEntryCount")),journalCapacity:X(b(t,"journalCapacity")),journalTruncated:b(t,"journalTruncated")===!0,linkInstanceUniqueId:C(b(t,"linkInstanceUniqueId"))||null,sourceToHostTransform:b(t,"sourceToHostTransform"),documentKeyResolution:b(t,"documentKeyResolution"),externalLinkUpdateAvailable:b(t,"externalLinkUpdateAvailable")===!0,metadata:t}}function mg(e){let t=C(b(e,"reason"));return t==="capture_interrupted_by_change"||t==="cursor_revision_mismatch"||t==="expired_capture_session"||t==="capture_session_expired"}function pg(e){return C(b(e,"continuationKind"))==="work"||C(b(e,"state"))==="in_progress"}function tc(e){return{captureId:C(e.captureId),snapshotId:C(e.snapshotId),capturedAt:C(e.capturedAt),schemaVersion:C(e.schemaVersion),extractorVersion:C(e.extractorVersion),coordinateFrame:C(e.coordinateFrame),lengthUnit:C(e.lengthUnit),captureConsistency:C(e.captureConsistency),revisionBasisCaveat:C(e.revisionBasisCaveat),scopeFingerprint:C(e.scopeFingerprint),sourceBindingFingerprint:C(e.sourceBindingFingerprint),scope:e.scope,effectiveSourcePolicy:e.effectiveSourcePolicy,scanPolicy:e.scanPolicy}}function Aa(e){if(e.length===0)return 0;let t=[...e].sort((n,r)=>n-r);return t[Math.max(0,Math.ceil(t.length*.95)-1)]}function ho(e){return{count:e.length,p95Ms:Aa(e),maxMs:e.length>0?Math.max(...e):0,totalMs:e.reduce((t,n)=>t+n,0)}}function Ce(e,t){return{liveness:"unknown",unknownReasons:[e],staleSourceKeys:[],warnings:[],evaluatedAt:new Date(t()).toISOString()}}function hg(e){let t=ie(e)?e:{};for(let n=0;n<3&&!(b(t,"success")!==void 0||!ie(b(t,"result")));n+=1)t=b(t,"result");return t}function fg(e,t,n=Date.now){if(t.length===0)return Ce("stored_source_revisions_missing",n);if(t.some(R=>R.changeSequenceState!=="tracked"||!C(R.trackerSessionId)))return Ce("stored_tracker_binding_incomplete",n);let r=new Set(t.map(R=>C(R.trackerSessionId)));if(r.size!==1)return Ce("stored_tracker_binding_inconsistent",n);let o=hg(e);if(b(o,"success")!==!0||b(o,"guarded")===!0||C(b(o,"state")).toLowerCase()!=="completed"||b(o,"trackerSubscribed")!==!0||C(b(o,"trackerSessionId"))!==[...r][0])return Ce("live_liveness_probe_failed",n);let a=b(o,"sourceStates");if(!Array.isArray(a)||a.length!==t.length||X(b(o,"expectedSourceRevisionCount"))!==t.length)return Ce("live_liveness_probe_incomplete",n);let i=[],s=[],l=[],u=new Set,m=0;for(let R of a){let A=ie(R)?R:{},T=X(b(A,"inputOrdinal"));if(T===null||T<0||T>=t.length||u.has(T))return Ce("live_liveness_probe_incomplete",n);u.add(T);let j=t[T],z=C(j.linkInstanceUniqueId)||null,J=C(b(A,"linkInstanceUniqueId"))||null;if(C(b(A,"documentKey"))!==j.documentKey||J!==z)return Ce("live_liveness_probe_source_mismatch",n);let y=C(b(A,"liveness")).toLowerCase(),B=b(A,"externalLinkUpdateAvailable");if(typeof B!="boolean")return Ce("live_liveness_probe_external_observation_incomplete",n);if(B&&(m+=1),y!=="current"&&y!=="stale"&&y!=="unknown")return Ce("live_liveness_probe_invalid_state",n);if((y==="current"||y==="stale")&&b(A,"sourceResolved")!==!0)return Ce("live_liveness_probe_source_mismatch",n);i.push(y);let W=`${j.documentKey}::${z||"host"}`;y==="unknown"?s.push(C(b(A,"reason"))||"unknown_source_state"):y==="stale"&&l.push(W)}let p=i.includes("unknown")?"unknown":i.includes("stale")?"stale":"current",g=C(b(o,"liveness")).toLowerCase(),h=i.filter(R=>R==="current").length,w=i.filter(R=>R==="stale").length,_=i.filter(R=>R==="unknown").length,L=a.filter(R=>ie(R)&&b(R,"sourceResolved")===!0).length;return X(b(o,"externalLinkUpdateAvailableCount"))!==m?Ce("live_liveness_probe_external_observation_mismatch",n):g!==p||X(b(o,"currentSourceCount"))!==h||X(b(o,"staleSourceCount"))!==w||X(b(o,"unknownSourceCount"))!==_||X(b(o,"resolvedSourceCount"))!==L?Ce("live_liveness_probe_aggregate_mismatch",n):{liveness:p,unknownReasons:[...new Set(s)],staleSourceKeys:[...new Set(l)],warnings:m>0?["external_link_update_available: Newer linked-model source data is available; currently loaded Revit geometry remains authoritative until reload."]:[],evaluatedAt:new Date(n()).toISOString()}}async function gg(e,t,n,r=Date.now){let o;try{o=e.getSnapshotSources(t)}catch{return Ce("stored_source_revisions_unreadable",r)}if(!n)return Ce("live_liveness_probe_not_configured",r);try{let a=await n(o);return fg(a,o,r)}catch{return Ce("live_liveness_probe_failed",r)}}function Tn(e){if(!ie(e))return null;let t={};for(let[n,r]of Object.entries(e)){let o=X(r);if(!n.trim()||o===null||o<1)return null;t[n]=o}return t}function fo(e){return Object.values(e).reduce((t,n)=>t+n,0)}function yg(e){let t=ie(e.counts)?e.counts:{},n=ie(e.coverage)?e.coverage:{},r=b(t,"nodesByKind");if(!ie(r))return null;let o={};for(let[y,B]of Object.entries(r)){let W=X(B);if(!y.trim()||W===null||W<0)return null;o[y]=W}let a=X(b(t,"totalNodes")),i=X(b(t,"extractedSupportedNodes")),s=X(b(t,"omittedSupportedNodes")),l=X(b(t,"expectedSupportedNodes")),u=X(b(n,"sourceAvailabilityOmissionCount")),m=X(b(n,"totalOrderedRowCount")),p=X(b(n,"classifiedOmissionCount")),g=X(b(n,"unmaterializedOmissionCount")),h=X(b(e,"payloadBytes")),w=Tn(b(t,"omissionsByReason")),_=Tn(b(t,"connectorOmissionsByReason")),L=Tn(b(n,"omittedByClassification")),R=Tn(b(n,"connectorOmittedByClassification")),A=Tn(b(n,"unmaterializedOmissionsByClassification")),T=Tn(b(n,"sourceOmittedByClassification"));if([a,i,s,l,u,m,p,g,h].some(y=>y===null||y<0)||!w||!_||!L||!R||!A||!T)return null;let j=fo(w)+fo(_),z=fo(T),J=m-a;return J<0||i!==a||l!==i+s||g>s||fo(A)!==g||s+u-g!==J||j!==s||z!==u||p!==s+u||We(w)!==We(L)||We(_)!==We(R)||Object.values(o).reduce((y,B)=>y+B,0)!==a?null:{expectedNodeCount:a,expectedOmissionCount:J,expectedPayloadBytes:h,expectedNodesByKind:o}}function lt(e,t,n,r){return{success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"invalid_spatial_page_contract",error:e,contractValidation:t,partial:!1,scanStoppedReason:"read_failed",scanPolicy:n,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:r}}function In(e,t,n,r){return{...lt(e,t,n,r),reason:"invalid_spatial_work_contract"}}async function nc(e,t){let n=t.now??Date.now,r=t.normalizePage??Kl,o=Math.max(0,Math.min(2,t.maxRetries??ig)),a=Math.max(1,Math.min(Yl,t.maxPages??Yl)),i=Math.max(1,Math.min(Ql,t.maxWorkSteps??Ql)),s=Math.max(1e3,Math.min(go,e.maxCaptureElapsedMs??ka)),l=n();try{t.store.applyConfiguredRetention()}catch{}let u=null;for(let m=0;m<=o;m+=1){let p=n(),g,h="",w=null,_=null,L=null,R=null,A=null,T=null,j=null,z=0,J=0,y=!1,B=!1,W=new Set,se=[],de=[],Re=[],Ee=[],He=[];try{for(let he=0;he<a+i;he+=1){if(z>=a)return h&&y&&t.store.abandonCapture(h),lt("Spatial capture exceeded the hard page-count bound.",{maxPages:a},e.scanPolicy,n()-l);if(n()-p>s)return h&&t.store.abandonCapture(h),{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"max_elapsed",message:"Atomic spatial capture exceeded its total bounded capture time; staging was discarded.",attempts:m+1,committed:!1,partial:!1,scanStoppedReason:"max_elapsed",scanPolicy:{...e.scanPolicy,maxCaptureElapsedMs:s},suggestedNextScopes:["narrow the explicit level/link/category scope"],warnings:[],notices:[],elapsedMs:n()-l};let Ae=n(),bt=await t.sendPage({...e.nativeParams,cursor:g}),rt=Math.max(0,n()-Ae),Ge=ie(bt)&&ie(bt.result)?bt.result:bt;if(pg(Ge)){let ut=Hl(Ge);if(!ut.valid||!ie(Ge))return h&&y&&t.store.abandonCapture(h),In("The native extract_spatial_snapshot progress response did not satisfy the strict Phase 1a work-continuation contract.",ut.errors,e.scanPolicy,n()-l);if(y||z>0)return t.store.abandonCapture(h),In("Spatial preparation resumed after data-page staging had already started.",{expectedOrdinal:z,workStepCount:J},e.scanPolicy,n()-l);let en=Ge.preparation,Mn=tc(Ge);if(_&&We(Mn)!==We(_))return In("Spatial preparation capture/scope/source-binding metadata changed inside one capture.",{expectedCaptureId:_.captureId,receivedCaptureId:Mn.captureId,expectedSourceBindingFingerprint:_.sourceBindingFingerprint,receivedSourceBindingFingerprint:Mn.sourceBindingFingerprint},e.scanPolicy,n()-l);_=_||Mn,h=h||Mn.captureId;let tn=C(en.phase),Fa=X(en.stepOrdinal),lr=X(en.processed),So=en.total===null?null:X(en.total),nn=C(en.nextCursor),ja=Zl[tn],Ba=A===null?-1:Zl[A],gc=Fa!==J+1,yc=ja===void 0||Ba===void 0||ja<Ba,Sc=A===tn&&(lr===null||T===null||lr<T||So!==j);if(gc||yc||Sc||!nn||nn===R)return In("Spatial preparation cursor, phase, or progress monotonicity failed.",{expectedStepOrdinal:J+1,receivedStepOrdinal:Fa,previousPhase:A,receivedPhase:tn,previousProcessed:T,receivedProcessed:lr,previousTotal:j,receivedTotal:So,cursorAdvanced:!!(nn&&nn!==R)},e.scanPolicy,n()-l);if(J>=i)return In("Spatial preparation exceeded the hard work-continuation bound.",{maxWorkSteps:i},e.scanPolicy,n()-l);J+=1,Re.push(rt);let bo=Ma(Ge.elapsedMs);bo!==null&&bo>=0&&Ee.push(bo),He.includes(tn)||He.push(tn),R=nn,A=tn,T=lr,j=So,g=nn;continue}se.push(rt);let Fe=r(Ge,rt),x=Fe.payload,P=Ma(b(x,"elapsedMs"));if(P!==null&&P>=0&&de.push(P),x.guarded===!0){if(h&&t.store.abandonCapture(h),mg(x)){u=x,B=!0;break}return{...x,action:"capture_spatial_snapshot",attempts:m+1,committed:!1,elapsedMs:n()-l}}if(!Fe.valid)return h&&t.store.abandonCapture(h),lt("The native extract_spatial_snapshot response did not satisfy the strict versioned extraction-page contract.",x.contractValidation||Fe.errors,e.scanPolicy,n()-l);if(C(x.schemaVersion)!==ag)return h&&t.store.abandonCapture(h),{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"phase1a_native_contract_required",message:"The connected Revit add-in exposes the Phase 0 transport contract. Install the matching Phase 1a DLL before durable capture.",committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:e.scanPolicy,suggestedNextScopes:[],warnings:[],notices:[],elapsedMs:n()-l};let je=ie(x.page)?x.page:{},Zt=X(je.ordinal),kt=C(je.pageSha256||je.pageHash),ir=C(je.priorPageSha256||je.priorPageHash)||null,sr=C(x.captureId),Pa=tc(x);if(h&&sr!==h||_&&We(Pa)!==We(_))return h&&y&&t.store.abandonCapture(h),In("The first spatial data page did not preserve the prepared capture/source-binding invariant.",{expectedCaptureId:h||_?.captureId||null,receivedCaptureId:sr,expectedSourceBindingFingerprint:_?.sourceBindingFingerprint||null,receivedSourceBindingFingerprint:Pa.sourceBindingFingerprint},e.scanPolicy,n()-l);if(h=h||sr,Zt!==z||ir!==L)return t.store.abandonCapture(h),lt("Spatial page order/hash continuity failed before staging commit.",{expectedOrdinal:z,ordinal:Zt,expectedPriorPageHash:L,priorPageHash:ir},e.scanPolicy,n()-l);let ct={captureId:C(x.captureId),snapshotId:C(x.snapshotId||x.captureId),capturedAt:C(x.capturedAt),schemaVersion:C(x.schemaVersion),extractorVersion:C(x.extractorVersion),coordinateFrame:C(x.coordinateFrame),lengthUnit:C(x.lengthUnit),captureConsistency:C(x.captureConsistency),scopeFingerprint:C(x.scopeFingerprint),sourceBindingFingerprint:C(x.sourceBindingFingerprint),revisionFingerprint:C(x.revisionFingerprint),scope:x.scope,effectiveSourcePolicy:x.effectiveSourcePolicy,sourceRevisions:x.sourceRevisions,counts:x.counts,pageCount:X(x.pageCount),payloadBytes:X(x.payloadBytes)};if(w&&We(ct)!==We(w))return t.store.abandonCapture(h),lt("Spatial page revision/scope metadata changed inside one capture.",{expectedFingerprint:w.revisionFingerprint,receivedFingerprint:ct.revisionFingerprint},e.scanPolicy,n()-l);w=w||ct,y||(t.store.beginCapture({captureId:h,snapshotId:ct.snapshotId,documentKey:C(b(x.scope,"hostDocumentKey")),scopeFingerprint:ct.scopeFingerprint,revisionFingerprint:ct.revisionFingerprint,schemaVersion:ct.schemaVersion,extractorVersion:ct.extractorVersion,scope:x.scope,counts:x.counts,effectiveSourcePolicy:x.effectiveSourcePolicy,coverage:x.coverage,transformValidation:x.transformValidation,captureMetadata:{coordinateFrame:x.coordinateFrame,lengthUnit:x.lengthUnit,captureConsistency:x.captureConsistency,sourceBindingFingerprint:ct.sourceBindingFingerprint},capturedAtMs:sg(x.capturedAt,n())}),y=!0);let La=(Array.isArray(x.nodes)?x.nodes:[]).map(cg);for(let ut of La){if(!ut.nodeId||!ut.documentKey||!ut.nodeKind||W.has(ut.nodeId))return t.store.abandonCapture(h),lt("Spatial page contains a missing or duplicate composite node identity.",{nodeId:ut.nodeId||null},e.scanPolicy,n()-l);W.add(ut.nodeId)}let hc=(Array.isArray(x.omissions)?x.omissions:[]).map(ug);if(t.store.stagePage({captureId:h,ordinal:Zt,priorPageHash:ir,pageHash:kt,hasMore:je.hasMore===!0,payloadBytes:X(je.payloadBytes)??0,nodes:La,omissions:hc}),L=kt,z+=1,je.hasMore===!0){if(g=C(je.nextCursor||x.nextCursor),!g)return t.store.abandonCapture(h),lt("A paginated spatial page did not provide its opaque next cursor.",{},e.scanPolicy,n()-l);continue}let yo=X(x.pageCount);if(yo!==z)return t.store.abandonCapture(h),lt("Final spatial page count does not match the staged chain.",{declaredPageCount:yo,stagedPageCount:z},e.scanPolicy,n()-l);let En=yg(x);if(!En)return t.store.abandonCapture(h),lt("Final spatial counts/coverage could not be reconciled into atomic commit expectations.",{counts:x.counts,coverage:x.coverage,payloadBytes:x.payloadBytes},e.scanPolicy,n()-l);let Va=(Array.isArray(x.sourceRevisions)?x.sourceRevisions:[]).map(dg),re=t.store.commitCapture({captureId:h,sourceRevisions:Va,counts:x.counts,effectiveSourcePolicy:x.effectiveSourcePolicy,coverage:x.coverage,transformValidation:x.transformValidation,expectedPageCount:yo,expectedPayloadBytes:En.expectedPayloadBytes,expectedNodeCount:En.expectedNodeCount,expectedOmissionCount:En.expectedOmissionCount,expectedNodesByKind:En.expectedNodesByKind,partial:x.partial===!0,coverageStatus:x.coverageStatus||null,scanStoppedReason:C(x.scanStoppedReason)||"completed",suggestedNextScopes:Array.isArray(x.suggestedNextScopes)?x.suggestedNextScopes.map(String):[]}),Nn=await gg(t.store,re.snapshotId,t.probeLiveness,n),fc=new Date(re.committedAtMs).toISOString(),Da={snapshotId:re.snapshotId,capturedAt:new Date(re.capturedAtMs).toISOString(),sourceRevisions:x.sourceRevisions,scope:x.scope,scopeFingerprint:re.scopeFingerprint,sourceBindingFingerprint:C(x.sourceBindingFingerprint),revisionFingerprint:re.revisionFingerprint,coordinateFrame:x.coordinateFrame,lengthUnit:x.lengthUnit,schemaVersion:re.schemaVersion,extractorVersion:re.extractorVersion,atomic:!0,liveness:Nn.liveness,livenessBinding:{basis:"document_change_sequence",evaluatedAt:Nn.evaluatedAt||new Date(n()).toISOString(),sourceCount:Va.length,unknownReasons:[...new Set(Nn.unknownReasons||[])]},committedAt:fc,counts:x.counts,partial:re.partial,coverageStatus:re.coverageStatus,scanStoppedReason:re.scanStoppedReason,suggestedNextScopes:Array.isArray(x.suggestedNextScopes)?x.suggestedNextScopes:[],pageCount:re.pageCount,payloadBytes:re.payloadBytes};return{success:!0,guarded:!1,state:"completed",action:"capture_spatial_snapshot",message:re.partial?"A revision-consistent partial spatial snapshot was atomically committed with explicit coverage limits.":"A complete revision-consistent spatial snapshot was atomically committed to the durable local store.",committed:!0,atomic:!0,liveness:Nn.liveness,snapshot:Da,snapshotId:re.snapshotId,scopeFingerprint:re.scopeFingerprint,sourceBindingFingerprint:C(x.sourceBindingFingerprint),revisionFingerprint:re.revisionFingerprint,counts:{...x.counts,persistedNodes:re.nodeCount,persistedOmissions:re.omissionCount},coverage:x.coverage,transformValidation:x.transformValidation,pageCount:re.pageCount,payloadBytes:re.payloadBytes,partial:re.partial,coverageStatus:re.coverageStatus,scanStoppedReason:re.scanStoppedReason,scanPolicy:{...e.scanPolicy,maxCaptureElapsedMs:s,maxRetries:o,maxWorkSteps:i},suggestedNextScopes:Da.suggestedNextScopes,attempts:m+1,pagePerformance:{roundTrip:ho(se),nativeUiOccupancy:{...ho(de),p95Within2000Ms:de.length>0&&Aa(de)<=2e3,maxWithin5000Ms:de.length>0&&Math.max(...de)<=5e3}},preparationPerformance:{continuationCount:J,phases:He,lastStepOrdinal:J>0?J:null,lastPhase:A,lastProcessed:T,lastTotal:j,roundTrip:ho(Re),nativeUiOccupancy:{...ho(Ee),p95Within2000Ms:Ee.length>0&&Aa(Ee)<=2e3,maxWithin5000Ms:Ee.length>0&&Math.max(...Ee)<=5e3}},warnings:[...new Set([...Array.isArray(x.warnings)?x.warnings.map(String):[],...Nn.warnings||[]])],notices:Array.isArray(x.notices)?x.notices:[],nextCursor:null,elapsedMs:n()-l}}if(B){if(m<o)continue;break}return h&&t.store.abandonCapture(h),lt("Spatial capture exceeded the hard page-count bound.",{maxPages:a},e.scanPolicy,n()-l)}catch(he){if(h&&y)try{t.store.abandonCapture(h)}catch{}return{success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"read_failed",error:he instanceof Error?he.message:String(he),committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:e.scanPolicy,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:n()-l}}}return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"capture_interrupted_by_change",message:"The model revision changed during all three bounded capture attempts; no mixed-revision snapshot was committed.",attempts:o+1,committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:e.scanPolicy,suggestedNextScopes:["wait for model edits to settle, then recapture the same explicit scope"],warnings:[],notices:[],nextCursor:null,elapsedMs:n()-l}}var Sg=4*1024*1024,oc=64*1024,ac=8*1024*1024,bg=5e3,ic=25e3,wg=1800,sc=5e3,xg=12e3,lc=6e4;function ar(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Oa(e){return Array.isArray(e)?[...new Set(e.map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0):[]}function rc(e){return Array.isArray(e)?[...new Set(e.map(t=>/^\d+$/.test(String(t??"").trim())?Number.parseInt(String(t).trim(),10):Number.NaN).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n):[]}function vg(e){if(!Array.isArray(e))return[];let t=e.flatMap(n=>{if(!n||typeof n!="object"||Array.isArray(n))return[];let r=n,o=String(r.linkInstanceUniqueId??"").trim(),a=String(r.levelId??"").trim(),i=/^\d+$/.test(a)&&Number.parseInt(a,10)>0?Number.parseInt(a,10):null,s=String(r.levelUniqueId??"").trim(),l=String(r.levelName??"").trim();return!o||i===null&&!s&&!l?[]:[{linkInstanceUniqueId:o,levelId:i,levelUniqueId:s||null,levelName:l||null}]});return[...new Map(t.map(n=>[`${n.linkInstanceUniqueId}${n.levelId??""}${n.levelUniqueId??""}${(n.levelName??"").toUpperCase()}`,n])).values()].sort((n,r)=>{let o=`${n.linkInstanceUniqueId}${n.levelId??""}${n.levelUniqueId??""}${n.levelName??""}`,a=`${r.linkInstanceUniqueId}${r.levelId??""}${r.levelUniqueId??""}${r.levelName??""}`;return o<a?-1:o>a?1:0})}function cc(e={}){let t=ar(e.pageTargetBytes,Sg,oc,ac),n=ar(e.maxElements,bg,1,ic),r=ar(e.maxElapsedMs,wg,250,sc),o=ar(e.timeoutMs,Math.max(xg,r+15e3),Math.max(1e3,r+1e3),lc);return{pageTargetBytes:t,maxElements:n,maxElapsedMs:r,timeoutMs:o,maxCaptureElapsedMs:ar(e.maxCaptureElapsedMs,ka,1e3,go)}}function _g(e,t=cc(e)){return{levelIds:rc(e.levelIds),levelNames:Oa(e.levelNames),sourceScope:e.sourceScope||"hostAndLinked",linkInstanceIds:rc(e.linkInstanceIds),linkInstanceUniqueIds:Oa(e.linkInstanceUniqueIds),linkedSourceLevels:vg(e.linkedSourceLevels),linkedSourceLevelNames:Oa(e.linkedSourceLevelNames),includeHostMep:e.includeHostMep!==!1,includeRoomsSpaces:e.includeRoomsSpaces!==!1,includeLinkedObstructions:e.includeLinkedObstructions!==!1,belowLevelMm:e.belowLevelMm,aboveLevelMm:e.aboveLevelMm,pageTargetBytes:t.pageTargetBytes,maxElements:t.maxElements,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,suppressTaskStatusWindow:!0,taskName:"Capture spatial snapshot page",taskId:void 0}}function Cg(e){return e.levelIds.length>0||e.levelNames.length>0}function Rg(e){return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"needs_scope",message:"capture_spatial_snapshot requires an explicit level scope. Pass levelIds and/or levelNames; broad whole-model extraction is not available.",partial:!1,scanStoppedReason:"needs_scope",scanPolicy:e,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:["No Revit command was sent."],nextCursor:null}}function uc(e){e.tool("capture_spatial_snapshot","[SPATIAL_CAPTURE_READ_ONLY] Capture one explicit host-level scope as a durable SpatialSnapshot v0.2. The runtime owns opaque native paging, validates the revision/hash chain, stages every page in the user-local spatial store, and exposes the snapshot only after one atomic commit. A DocumentChanged sequence interruption discards staging and retries at most twice; mixed revisions never commit. The host scope remains a physical host-Z band. Use placement-qualified linkedSourceLevels when linked Room/Space rows must match an exact source Level; linked obstructions remain physical band-overlap evidence. Returns current/stale/unknown liveness, explicit coverage, counts, page totals, and bounded performance evidence. This tool never writes the Revit model.",{...I(G),...N(G),levelIds:G.array(G.union([G.number().int().positive(),G.string()])).max(20).optional().describe("Explicit host Revit level ids. At least one levelIds or levelNames entry is required."),levelNames:G.array(G.string().min(1)).max(20).optional().describe("Explicit host Revit level names. At least one levelIds or levelNames entry is required."),sourceScope:G.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),linkInstanceIds:G.array(G.union([G.number().int().positive(),G.string()])).max(100).optional().describe("Optional exact RevitLinkInstance ids inside the explicit level scope."),linkInstanceUniqueIds:G.array(G.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance unique ids inside the explicit level scope."),linkedSourceLevels:G.array(G.object({linkInstanceUniqueId:G.string().min(1),levelId:G.union([G.number().int().positive(),G.string().regex(/^[1-9]\d*$/)]).optional(),levelUniqueId:G.string().min(1).optional(),levelName:G.string().min(1).optional()}).refine(t=>t.levelId!==void 0||t.levelUniqueId!==void 0||t.levelName!==void 0,"Each linked source level selector requires levelId, levelUniqueId, and/or levelName.")).max(100).optional().describe("Optional placement-qualified exact linked source Level selectors for linked Room/Space rows. Use inspect_levels to obtain linkInstanceUniqueId plus level id/unique id/name. Applied in addition to the required host-Z level band; linked obstructions remain physical band-overlap evidence."),linkedSourceLevelNames:G.array(G.string().min(1)).max(100).optional().describe("Optional exact source Level names for linked Room/Space rows, matched case-insensitively across selected links. Applied in addition to the required host-Z level band; use placement-qualified linkedSourceLevels for unambiguous audit identity."),includeHostMep:G.boolean().optional().describe("Include supported host-model MEP evidence. Defaults true."),includeRoomsSpaces:G.boolean().optional().describe("Include supported Room/Space evidence from the selected source scope. Defaults true."),includeLinkedObstructions:G.boolean().optional().describe("Include supported linked structural/architectural obstruction evidence. Defaults true."),belowLevelMm:G.number().min(0).max(1e4).optional().describe("Optional bounded extent below each selected level, in millimetres. Defaults 1000; native cap 10000."),aboveLevelMm:G.number().min(100).max(3e4).optional().describe("Optional bounded extent above each selected level, in millimetres. Defaults 6000; native cap 30000."),pageTargetBytes:G.number().int().min(oc).max(ac).optional().describe("Native page target in bytes. Defaults 4 MiB; hard-capped at 8 MiB below the 32 MiB bridge ceiling."),maxElements:G.number().int().positive().max(ic).optional().describe("Maximum source elements considered by this native page call. Defaults 5000; hard-capped at 25000."),maxElapsedMs:G.number().int().min(250).max(sc).optional().describe("Maximum Revit UI occupancy target for one native page/chunk. Defaults 1800 ms; hard-capped at 5000 ms."),maxCaptureElapsedMs:G.number().int().min(1e3).max(go).optional().describe("Total bound for one full staged capture attempt. Defaults 45000 ms; hard-capped at 120000 ms."),timeoutMs:G.number().int().min(2e3).max(lc).optional().describe("Socket timeout for this one page. Defaults to at least 12000 ms with 15000 ms headroom above maxElapsedMs; hard-capped at 60000 ms.")},async t=>{let n=cc(t),r=_g(t,n);if(!Cg(r))return f(Rg(n));try{let o=Ll(),a=await nc({nativeParams:r,scanPolicy:n,maxCaptureElapsedMs:n.maxCaptureElapsedMs},{store:o,sendPage:async i=>await D("extract_spatial_snapshot",i,{...V({target:t.target,host:t.host,port:t.port,timeoutMs:n.timeoutMs,taskName:"Capture spatial snapshot page"},"Capture spatial snapshot page"),toolName:"capture_spatial_snapshot",timeoutMs:n.timeoutMs}),probeLiveness:async i=>{let s=i.map(u=>u.metadata||u),l=await D("get_spatial_change_state",{sourceRevisions:s,expectedTrackerSessionId:i.find(u=>u.trackerSessionId)?.trackerSessionId,timeoutMs:Math.min(n.timeoutMs,1e4),suppressTaskStatusWindow:!0,taskName:"Read spatial change state"},{...V({target:t.target,host:t.host,port:t.port,timeoutMs:Math.min(n.timeoutMs,1e4),taskName:"Read spatial change state"},"Read spatial change state"),toolName:"capture_spatial_snapshot",timeoutMs:Math.min(n.timeoutMs,1e4)});return l&&l.result?l.result:l}});return f(a)}catch(o){let a=o instanceof rr;return f({success:a,guarded:a,state:a?"guarded":"failed",action:"capture_spatial_snapshot",reason:a?o.reason:"read_failed",error:o instanceof Error?o.message:String(o),committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:n,suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null})}})}async function dc(e){let t=Ci(e);vl(t),Fl(t),Oi(t),Pi(t),Li(t),Vi(t),Fi(t),ji(t),Bi(t),qi(t),zi(t),Ui(t),Ki(t),Yi(t),Qi(t),Zi(t),es(t),os(t),ns(t),as(t),ls(t),cs(t),Ss(t),xs(t),Ts(t),ol(t),ml(t),pl(t),gl(t),Sl(t),xl(t),uc(t),console.error("Registered 32 revAgent tools")}var nt=class extends Error{constructor(t){super(t),this.name="SpatialStoreCliUsageError"}};function mc(e,t,n){let r=e[t+1];if(typeof r!="string"||r.trim().length===0||r.startsWith("--"))throw new nt(`${n} requires one non-empty value.`);return r.trim()}function Tg(e){let t=e[0];if(t!=="preview"&&t!=="purge")throw new nt("Expected command preview or purge.");let n=!1,r=null,o=[],a=!1;for(let l=1;l<e.length;l+=1){let u=e[l];if(u==="--all"){if(n)throw new nt("--all may be specified only once.");n=!0;continue}if(u==="--confirm"){if(a)throw new nt("--confirm may be specified only once.");a=!0;continue}if(u==="--document-key"){if(r!==null)throw new nt("--document-key may be specified only once.");r=mc(e,l,u),l+=1;continue}if(u==="--snapshot-id"){o.push(mc(e,l,u)),l+=1;continue}throw new nt(`Unknown spatial-store argument: ${u}`)}if(t==="preview"&&a)throw new nt("--confirm is valid only with purge.");if(Number(n)+ +(r!==null)+ +(o.length>0)!==1)throw new nt("Exactly one selector is required: --all, --document-key <key>, or one or more --snapshot-id <id>.");if(n)return{command:t,selector:{all:!0},selectorSummary:{kind:"all"},confirm:a};if(r!==null)return{command:t,selector:{documentKey:r},selectorSummary:{kind:"document_key",documentKey:r},confirm:a};let s=[...new Set(o)];return{command:t,selector:{snapshotIds:s},selectorSummary:{kind:"snapshot_ids",snapshotIds:s},confirm:a}}function Ig(e){process.stdout.write(`${JSON.stringify(e,null,2)}
`)}function Eg(e,t){return{contractVersion:"spatial-store-cli.v1",success:!0,guarded:!1,state:"completed",action:"spatial_store_preview",mutated:!1,selector:e.selectorSummary,preview:t}}function pc(e,t=Ig,n={}){let r=null;try{let o=Tg(e);r=n.createStore?.()??new Cn({retentionPolicy:!1,cleanupExpiredStagingOnOpen:!1});let a=r.previewPurge(o.selector);if(o.command==="preview")return t(Eg(o,a)),0;if(!o.confirm)return t({contractVersion:"spatial-store-cli.v1",success:!0,guarded:!0,state:"guarded",action:"spatial_store_purge",reason:"confirmation_required",message:"No data was changed. Re-run the same explicit selector with --confirm to purge.",mutated:!1,selector:o.selectorSummary,preview:a}),2;let i=r.purge(o.selector);return i.artifactWarnings.length>0?(t({contractVersion:"spatial-store-cli.v1",success:!1,guarded:!1,state:"failed",action:"spatial_store_purge",reason:"purge_cleanup_incomplete",message:"Database rows were purged, but one or more artifact or recovery-backup cleanup steps did not complete.",mutated:i.purgedSnapshotCount>0||i.purgedStagingCaptureCount>0,partial:!0,selector:o.selectorSummary,previewBefore:a,purge:i}),3):(t({contractVersion:"spatial-store-cli.v1",success:!0,guarded:!1,state:"completed",action:"spatial_store_purge",mutated:i.purgedSnapshotCount>0||i.purgedStagingCaptureCount>0,partial:!1,selector:o.selectorSummary,previewBefore:a,purge:i}),0)}catch(o){let a=o instanceof nt;return t({contractVersion:"spatial-store-cli.v1",success:!1,guarded:!1,state:"failed",action:"spatial_store_maintenance",reason:a?"invalid_arguments":"spatial_store_unavailable",message:o instanceof Error?o.message:String(o),mutated:!1}),a?2:1}finally{try{r?.close()}catch{}}}async function Ag(){if(process.argv[2]==="spatial-store"){process.exitCode=pc(process.argv.slice(3));return}let e=new Ng({name:"revAgent",version:"1.0.0"});await dc(e);let t=Ra(),n=new Mg;await e.connect(n),_i(),console.error(`revAgent spatial store ${t.available?"ready":`guarded:${t.reason}`}`),console.error("revAgent runtime start success")}Ag().catch(e=>{console.error("Error starting revAgent runtime:",e),process.exit(1)});

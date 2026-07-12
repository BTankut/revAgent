import{McpServer as _b}from"@modelcontextprotocol/sdk/server/mcp.js";import{StdioServerTransport as xb}from"@modelcontextprotocol/sdk/server/stdio.js";import{z as Bt}from"zod";import*as ss from"net";function Lt(...e){for(let t of e){let n=process.env[t];if(n!=null&&String(n).trim()!=="")return n}}var Yo=32*1024*1024,Qo=class{host;port;socket;logErrors;isConnected=!1;responseCallbacks=new Map;buffer=Buffer.alloc(0);framingMode=Lt("REVAGENT_FRAMING","REVIT_MCP_FRAMING")==="legacy"?"legacy":"length-prefixed";constructor(t,n,o={}){this.host=t,this.port=n,this.logErrors=o.logErrors!==!1,this.socket=new ss.Socket,this.setupSocketListeners()}setupSocketListeners(){this.socket.on("connect",()=>{this.isConnected=!0}),this.socket.on("data",t=>{this.buffer=Buffer.concat([this.buffer,t]),this.processBuffer()}),this.socket.on("close",()=>{this.isConnected=!1}),this.socket.on("error",t=>{this.logErrors&&console.error("RevitClientConnection error:",t),this.isConnected=!1})}processBuffer(){for(;this.buffer.length>0;){if(this.buffer.length>Yo){this.rejectPending(new Error(`revAgent response exceeded ${Yo} bytes`)),this.buffer=Buffer.alloc(0);return}if(this.isLikelyLegacyJson(this.buffer)){if(!this.processLegacyJsonBuffer())return;continue}if(!this.isLikelyLengthPrefixed(this.buffer)||!this.processLengthPrefixedBuffer())return}}isLikelyLegacyJson(t){let n=0;for(;n<t.length&&[32,9,10,13].includes(t[n]);)n++;return n<t.length&&t[n]===123}isLikelyLengthPrefixed(t){if(t.length<4)return!0;let n=t.readUInt32BE(0);return n>0&&n<=Yo}processLegacyJsonBuffer(){try{let t=this.buffer.toString("utf8"),n=this.extractFirstJsonObject(t);if(!n)return!1;let o=JSON.parse(n.json);return this.handleResponseObject(o,n.json),this.buffer=Buffer.from(n.remaining,"utf8"),!0}catch{return!1}}extractFirstJsonObject(t){let n=0,o=!1,r=!1,a=!1,i=0;for(let s=0;s<t.length;s++){let l=t[s];if(!a){if(/\s/.test(l))continue;if(l!=="{")return null;a=!0,i=s,n=1;continue}if(r){r=!1;continue}if(l==="\\"){r=!0;continue}if(l==='"'){o=!o;continue}if(!o){if(l==="{")n++;else if(l==="}"&&(n--,n===0))return{json:t.slice(i,s+1),remaining:t.slice(s+1)}}}return null}processLengthPrefixedBuffer(){if(this.buffer.length<4)return!1;let t=this.buffer.readUInt32BE(0);if(t<=0||t>Yo)return this.rejectPending(new Error(`Invalid revAgent response frame length: ${t}`)),this.buffer=Buffer.alloc(0),!1;if(this.buffer.length<4+t)return!1;let o=this.buffer.subarray(4,4+t).toString("utf8");try{let r=JSON.parse(o);this.handleResponseObject(r,o)}catch(r){this.rejectPending(new Error(`Failed to parse revAgent response: ${r instanceof Error?r.message:String(r)}`))}return this.buffer=this.buffer.subarray(4+t),!0}handleResponseObject(t,n){let r=t&&t.id!==void 0&&t.id!==null?String(t.id):"default",a=this.responseCallbacks.get(r);if(a){a(n),this.responseCallbacks.delete(r);return}if(t&&t.error&&this.responseCallbacks.size===1){let i=this.responseCallbacks.entries().next().value;if(i){let[s,l]=i;l(n),this.responseCallbacks.delete(s)}return}if(t&&t.error&&this.responseCallbacks.size>1)for(let[i,s]of this.responseCallbacks.entries())s(n),this.responseCallbacks.delete(i)}rejectPending(t){for(let[n,o]of this.responseCallbacks.entries())o(JSON.stringify({jsonrpc:"2.0",id:n,error:{code:-32e3,message:t instanceof Error?t.message:String(t)}})),this.responseCallbacks.delete(n)}connect(){if(this.isConnected)return!0;try{return this.socket.connect(this.port,this.host),!0}catch(t){return console.error("Failed to connect:",t),!1}}disconnect(){this.socket.end(),this.isConnected=!1}generateRequestId(){return Date.now().toString()+Math.random().toString().substring(2,8)}async sendCommand(t,n={},o={}){return t!=="mcp_status"&&o.statusPreflight!==!1&&await this.ensureReadyForCommand(t,o),await this.sendCommandRequest(t,n,o)}async ensureReadyForCommand(t,n={}){let o=n.statusTimeoutMs||Math.min(n.timeoutMs||3e3,3e3),r=await this.sendCommandRequest("mcp_status",{},{timeoutMs:o,statusPreflight:!1}),a=r&&typeof r=="object"?r.activeTask:null;if(!a)return;let i=a.taskName||a.method||"revAgent task",s=typeof a.elapsedMs=="number"?`, elapsed ${this.formatElapsed(a.elapsedMs)}`:"";throw new Error(`revAgent is busy with "${i}"${s}. Wait for it to finish before sending "${t}".`)}formatElapsed(t){let n=Math.max(0,Math.floor(t/1e3)),o=Math.floor(n/3600),r=Math.floor(n%3600/60),a=n%60;return[o,r,a].map(i=>String(i).padStart(2,"0")).join(":")}async sendCommandRequest(t,n={},o={}){let r=o.framing||this.framingMode;try{return await this.sendCommandRequestOnce(t,n,{...o,framing:r})}catch(a){if(r==="length-prefixed"&&o.allowLegacyFallback!==!1&&this.isFramingFallbackError(a))return this.framingMode="legacy",await this.sendCommandRequestOnce(t,n,{...o,framing:"legacy"});throw a}}isFramingFallbackError(t){let n=t instanceof Error?t.message:String(t);return/Invalid JSON|Invalid JSON-RPC request|Invalid (?:Revit MCP|revAgent) response frame length/i.test(n)}sendCommandRequestOnce(t,n={},o={}){return new Promise((r,a)=>{let i;try{this.isConnected||this.connect();let s=this.generateRequestId(),l={jsonrpc:"2.0",method:t,params:n,id:s};this.responseCallbacks.set(s,u=>{clearTimeout(i);try{let m=JSON.parse(u);m.error?a(new Error(m.error.message||"Unknown error from Revit")):r(m.result)}catch(m){m instanceof Error?a(new Error(`Failed to parse response: ${m.message}`)):a(new Error(`Failed to parse response: ${String(m)}`))}}),this.writeCommand(l,o.framing||this.framingMode);let c=o.timeoutMs||12e4;i=setTimeout(()=>{this.responseCallbacks.has(s)&&(this.responseCallbacks.delete(s),a(new Error(`Command timed out after ${this.formatElapsed(c)}: ${t}`)))},c),typeof i.unref=="function"&&i.unref()}catch(s){clearTimeout(i),a(s)}})}writeCommand(t,n){let o=Buffer.from(JSON.stringify(t),"utf8");if(n==="length-prefixed"){let r=Buffer.alloc(4);r.writeUInt32BE(o.length,0),this.socket.write(Buffer.concat([r,o]));return}this.socket.write(o)}};import*as Ke from"fs";import*as Zo from"os";import*as Kt from"path";var xd=Lt("REVAGENT_HOST","REVIT_MCP_HOST","REVIT_HOST")||"localhost",cs=Xt(Lt("REVAGENT_PORT","REVIT_MCP_PORT","REVIT_PORT"),8080),vd=Td([Lt("REVAGENT_INSTANCE_REGISTRY"),Kt.join(Zo.tmpdir(),"revAgent-instances.json"),Lt("REVIT_MCP_INSTANCE_REGISTRY"),Kt.join(Zo.tmpdir(),"revit-mcp-instances.json")]),us=Kt.join(Zo.tmpdir(),"revit-mcp-command-locks"),ds=8e3,wd=600*1e3,Cd=250;function Id(e){return new Promise(t=>setTimeout(t,e))}function Xt(e,t){if(e==null||e===""){if(t!==void 0)return t;throw new Error("Invalid revAgent port: empty value")}let n=Number.parseInt(String(e),10);if(!Number.isFinite(n)||n<1||n>65535)throw new Error(`Invalid revAgent port: ${e}`);return n}function ls(e){return e?(Array.isArray(e)?e:String(e).split(",")).map(n=>String(n).trim()).filter(Boolean).map(n=>Xt(n)):[]}function mn(e){return e?String(e).trim():xd}function Rd(e){return String(e).replace(/[^a-zA-Z0-9_.-]/g,"_")}function Td(e){let t=new Set,n=[];for(let o of e){if(!o||!String(o).trim())continue;let r=Kt.resolve(String(o)),a=r.toLowerCase();t.has(a)||(t.add(a),n.push(r))}return n}function Ed(e){return Kt.join(us,`${Rd(e.host)}-${e.port}.lock`)}function ms(e){return e&&typeof e=="object"&&"code"in e?String(e.code):null}function Nd(e){let t=new Set,n=[];for(let o of e){let r=mn(o.host),a=Xt(o.port),i=`${r}:${a}`;t.has(i)||(t.add(i),n.push({...o,host:r,port:a}))}return n}function ps(){let e=[];for(let t of vd)try{if(!Ke.existsSync(t))continue;let n=JSON.parse(Ke.readFileSync(t,"utf8"));if(Array.isArray(n)){e.push(...n);continue}if(n&&Array.isArray(n.instances)){e.push(...n.instances);continue}n&&n.targets&&typeof n.targets=="object"&&e.push(...Object.entries(n.targets).map(([o,r])=>({...typeof r=="object"&&r?r:{},name:o})))}catch{continue}return e}function Md(e,t){let n=String(t).toLowerCase();return[e.name,e.id,e.target,e.pid,e.title,e.documentTitle,e.path,e.pathName].filter(r=>r!=null).some(r=>String(r).toLowerCase()===n)}function Ad(e){let t=ps().find(n=>Md(n,e));return t?{name:t.name||t.id||String(e),host:mn(t.host),port:Xt(t.port),source:"registry",metadata:t}:null}function kd(e,t){let n=String(e||"").trim();if(!n)return null;if(/^\d+$/.test(n))return{host:mn(t),port:Xt(n),source:"target-port"};let o=n.match(/^(.+):(\d+)$/);return o?{host:mn(o[1]),port:Xt(o[2]),source:"target-host-port"}:null}function Od(e={}){let t=mn(e.host),n=e.port!==void 0&&e.port!==null?Xt(e.port):null;if(n)return{host:t,port:n,source:"explicit"};let o=e.target||Lt("REVAGENT_TARGET","REVIT_MCP_TARGET");if(o){let r=kd(o,t);if(r)return r;let a=Ad(o);if(a)return a;throw new Error(`Unknown revAgent target '${o}'. Use a port number, host:port, or a registered instance name.`)}return{host:t,port:cs,source:"default"}}function gs(e={}){let t=mn(e.host),n=[];if(e.includeRegistry!==!1)for(let i of ps())i.port&&n.push({name:i.name||i.id||i.title||i.documentTitle,host:mn(i.host),port:Xt(i.port),source:"registry",metadata:i});let o=ls(e.ports),r=ls(Lt("REVAGENT_PORTS","REVIT_MCP_PORTS")),a=r.length>0?r:[cs,8081,8082,8083,8084,8085];for(let i of o.length>0?o:a)n.push({host:t,port:i,source:o.length>0?"explicit":"scan"});return Nd(n)}function Pd(e){try{let t=Ke.statSync(e);Date.now()-t.mtimeMs>wd&&Ke.rmSync(e,{recursive:!0,force:!0})}catch(t){if(!t||ms(t)==="ENOENT")return}}async function Ld(e,t=ds){let n=Ed(e),o=Date.now();for(Ke.mkdirSync(us,{recursive:!0});;)try{return Ke.mkdirSync(n,{recursive:!1}),Ke.writeFileSync(Kt.join(n,"owner.json"),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),target:e},null,2)),()=>{try{Ke.rmSync(n,{recursive:!0,force:!0})}catch{}}}catch(r){if(!r||ms(r)!=="EEXIST")throw r;if(Pd(n),Date.now()-o>=t)throw new Error(`revAgent target ${e.host}:${e.port} is busy; a previous Revit command is still running. Refusing to send another request.`);await Id(Cd)}}async function ht(e,t={}){let n=Od(t),o=t.skipLock===!0?()=>{}:await Ld(n,t.lockWaitMs||ds),r=new Qo(n.host,n.port,{logErrors:t.logSocketErrors!==!1});try{return r.isConnected||await new Promise((a,i)=>{let s,l=()=>{r.socket.removeListener("connect",l),r.socket.removeListener("error",c),clearTimeout(s),a()},c=()=>{r.socket.removeListener("connect",l),r.socket.removeListener("error",c),clearTimeout(s),i(new Error(`connect to revAgent target ${n.host}:${n.port} failed`))};r.socket.on("connect",l),r.socket.on("error",c),r.connect(),s=setTimeout(()=>{r.socket.removeListener("connect",l),r.socket.removeListener("error",c),i(new Error(`connect to revAgent target ${n.host}:${n.port} timed out`))},t.connectTimeoutMs||5e3),typeof s.unref=="function"&&s.unref()}),await e(r,n)}finally{r.disconnect(),o()}}import ka from"node:crypto";import Oa from"node:os";import Fn from"node:path";var Vd=[{name:"Parameter.Set",pattern:/\.Set\s*\(/i},{name:"Parameter.SetValueString",pattern:/\.SetValueString\s*\(/i},{name:"Parameter.ClearValue",pattern:/\.ClearValue\s*\(/i},{name:"Schedule.SetCellText",pattern:/\.\s*SetCellText\s*\(/i},{name:"Schedule table edit",pattern:/\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(/i},{name:"Document.Delete",pattern:/\.\s*Delete\s*\(/i},{name:"ElementTransformUtils",pattern:/ElementTransformUtils/i},{name:"Location.Move",pattern:/\.Move\s*\(/i},{name:"Element.ChangeTypeId",pattern:/\.ChangeTypeId\s*\(/i},{name:"Connector.ConnectTo",pattern:/\.ConnectTo\s*\(/i},{name:"Connector.DisconnectFrom",pattern:/\.DisconnectFrom\s*\(/i},{name:"FamilySymbol.Activate",pattern:/\.Activate\s*\(/i},{name:"NewFamilyInstance",pattern:/NewFamilyInstance/i},{name:"Create API",pattern:/\.(Create|New[A-Z]\w*)\s*\(/},{name:"View visibility/overrides",pattern:/\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/i},{name:"Geometry join/cut",pattern:/(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/i},{name:"Parameter binding edit",pattern:/\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/i},{name:"Revit property assignment",pattern:/\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.\s*(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/i},{name:"Manual Transaction",pattern:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/i}];function So(e){return Vd.filter(t=>t.pattern.test(e)).map(t=>t.name)}import wa from"node:fs";import lt from"node:path";import{fileURLToPath as Dd}from"node:url";function Dn(e){return/^(1|true|yes|on)$/i.test(String(e||"").trim())}function Vt(e){try{return!e||!wa.existsSync(e)?null:JSON.parse(wa.readFileSync(e,"utf8").replace(/^\uFEFF/,""))}catch{return null}}function Yt(){let e=Dd(import.meta.url),t=lt.dirname(e),n=[lt.resolve(t,"..",".."),lt.resolve(t,"..")];for(let o of n)if(wa.existsSync(lt.join(o,"package.json")))return o;return n[0]}function er(){let e=Yt(),t=lt.dirname(e);return t&&t!==e?t:e}function bo(){return process.env.ProgramData||process.env.PROGRAMDATA||"C:\\ProgramData"}function hs(){let e=er(),t=[process.env.REVAGENT_UPDATER_CONFIG,lt.join(e,"updater","updater-config.json"),lt.join(bo(),"DPE","revAgent","updater","updater-config.json"),lt.join(bo(),"DPE","RevitMCP","updater","updater-config.json")].filter(Boolean);for(let n of t){let o=Vt(n);if(o)return o}return null}function _o(e=[]){let t=er(),n=[lt.join(t,"updater","installed.json"),...e,lt.join(bo(),"DPE","revAgent","updater","installed.json"),lt.join(bo(),"DPE","RevitMCP","updater","installed.json")];for(let o of n){let r=Vt(o);if(r)return r}return null}function xo(e){let t=String(e||"").match(/-([0-9a-f]{7,40})$/i);return t?t[1]:null}function fs(){return lt.join(bo(),"DPE","revAgent","state","telemetry")}function pn(e){return(String(e||"").trim()||"unknown-machine").toUpperCase()}function tr(e,t="unknown"){let n=String(e||"").trim();return n&&n.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g,"_").replace(/_+/g,"_").replace(/^[._-]+|[._-]+$/g,"")||t}import rr from"node:fs";import ys from"node:path";var nr=new Map,or=new Map,vo=0,Ca=0;async function Ss(e,t){await rr.promises.mkdir(ys.dirname(e),{recursive:!0}),await rr.promises.writeFile(e,`${JSON.stringify(t,null,2)}
`,"utf8")}async function Ia(e,t){await rr.promises.mkdir(ys.dirname(e),{recursive:!0}),await rr.promises.appendFile(e,`${JSON.stringify(t)}
`,"utf8")}function bs(e,t){let o=(nr.get(e)||Promise.resolve()).catch(()=>{}).then(()=>Ia(e,t));return nr.set(e,o),o.finally(()=>{nr.get(e)===o&&nr.delete(e)}).catch(()=>{}),o}function Ra(e,t,n){if(n.disabled())return!1;if(vo>=n.maxInFlight())return Ca++,!1;vo++;let r=(or.get(e)||Promise.resolve()).catch(()=>{}).then(()=>t(e));return or.set(e,r),r.catch(()=>{Ca++}).finally(()=>{or.get(e)===r&&or.delete(e),vo=Math.max(0,vo-1)}),!0}function _s(e){return{inFlight:vo,dropped:Ca,maxInFlight:e}}var Fd=new Set(["completed","failed","guarded"]);function wo(e,t,n){return e?.[n]!==void 0&&e?.[n]!==null?e[n]:t?.[n]??null}function ar(e,t){return e??t??null}function Co(e){return String(e?.state||"").toLowerCase()}function Ea(e){return Fd.has(String(e||"").toLowerCase())}function xs(e){return e!=null&&e!==""}function vs(e){let t=Date.parse(String(e?.finishedAtUtc||e?.startedAtUtc||""));return Number.isFinite(t)?t:0}function jd(e,t){let n=Ea(t?.state),o=Ea(e?.state);return n?t||null:o?e||null:t||e||null}function Bd(e,t){return Co(t)==="failed"?t||null:Co(e)==="failed"&&e||null}function Ta(e,t,n,o){let r=String(e||"").toLowerCase(),a=Co(n)===r,i=Co(t)===r;return a&&i?wo(n,t,o):a?wo(n,null,o):i?wo(t,null,o):null}function qd(e,t=""){if(!e||typeof e!="object")return t;if(xs(e.requestId))return`request:${e.requestId}`;if(xs(e.id))return`id:${e.id}`;let n=e.method||"",o=e.taskName||"",r=e.startedAtUtc||"";return n||o||r?`task:${n}|${o}|${r}`:t}function zd(e,t){let n=jd(e,t),o={...e||{},...t||{}};for(let r of["id","requestId","method","wrapperAction","logicalToolName","taskName","parentTaskName","parentTaskId","startedAtUtc","requestBytes","responseBytes","port"])o[r]=wo(t,e,r);return o.state=ar(n?.state,wo(t,e,"state")),Ea(o.state)?(o.finishedAtUtc=ar(Ta(o.state,e,t,"finishedAtUtc"),n?.finishedAtUtc),o.elapsedMs=ar(Ta(o.state,e,t,"elapsedMs"),n?.elapsedMs)):(o.finishedAtUtc=null,o.elapsedMs=null),Co(o)==="failed"?o.error=ar(Ta(o.state,e,t,"error"),Bd(e,t)?.error):o.error=null,o}function Ud(e,t,n=100){let o=Math.max(1,Math.min(200,Number(n)||100)),r=new Map,a=(i,s)=>{for(let[l,c]of(Array.isArray(i)?i:[]).entries()){if(!c||typeof c!="object")continue;let u=qd(c,`${s}:${l}`),m=r.get(u);r.set(u,m?zd(m,c):c)}};return a(t,"cached"),a(e,"current"),[...r.values()].sort((i,s)=>vs(s)-vs(i)).slice(0,o)}function ws(e,t){let n=e&&typeof e=="object"?e:null,o=t&&typeof t=="object"?t:null;if(!n&&!o)return null;let r=n?.recentHistoryCapacity??o?.recentHistoryCapacity??100,a=Ud(n?.recentTasks,o?.recentTasks,r),i=Math.max(Number(n?.recentHistoryCount)||0,Number(o?.recentHistoryCount)||0,a.length);return{...o||{},...n||{},activeTask:n?.activeTask||null,recentTasks:a,recentHistoryCount:i,recentHistoryCapacity:r}}var Wd="revagent.telemetry.v1",$d="revagent.live.status.v1",Es="revagent.live.activity.v1",gr=ka.randomUUID(),Ns=new Date().toISOString(),Hd=new Set(["capture_spatial_snapshot","extract_spatial_snapshot","get_spatial_change_state","inspect_levels","query_spatial_context","compare_spatial_snapshots","summarize_spatial_state"]),Gd=new Set(["running","in_progress","completed","guarded","failed"]),Jd=new Set(["capture_spatial_snapshot","extract_spatial_snapshot","get_spatial_change_state","inspect_levels","query_spatial_context","compare_spatial_snapshots","summarize_spatial_state"]),Kd=new Set(["current","stale","unknown","staging"]),Xd=new Set(["needs_scope","max_elapsed","read_failed","invalid_request","invalid_cursor","invalid_work_cursor","invalid_cursor_sort_position","cursor_scope_mismatch","cursor_revision_mismatch","cursor_hash_mismatch","capture_interrupted_by_change","capture_has_no_source_bindings","capture_source_binding_fingerprint_changed","capture_source_binding_read_failed","capture_candidate_identity_changed","candidate_inventory_limit_exceeded","prepared_capture_byte_limit_exceeded","invalid_capture_work_phase","expired_capture_session","capture_session_expired","change_tracker_unavailable","phase1a_native_contract_required","phase1b_native_contract_required","invalid_spatial_page_contract","invalid_spatial_work_contract","snapshot_not_found","snapshot_incomplete","incomplete_snapshot","snapshot_not_current","unsupported_snapshot_schema","unsupported_snapshot_capability","snapshot_capability_mismatch","incomparable_scopes","schema_compatibility_adapter_required","session_only_cross_session_incomparable","invalid_operation","invalid_query_cursor","invalid_cursor","cursor_session_expired","cursor_query_mismatch","cursor_snapshot_mismatch","topology_data_unavailable","incomplete_topology_coverage","internal_topology_unsupported","analytic_geometry_unsupported","unsupported_geometry","node_not_found","node_not_found_or_geometry_unsupported","invalid_filter","unsupported_operation","store_integrity_error","max_items","max_bytes","spatial_rtree_unavailable","spatial_sqlite_native_binding_unavailable","spatial_store_migration_failed","spatial_store_recovery_failed","spatial_store_network_path_rejected","spatial_store_managed_path_rejected","spatial_store_artifact_path_rejected","spatial_store_unavailable","runtime_exception","invalid_response_kind"]),Yd=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),Qd=new Set(["complete","incomplete_omissions","incomplete_budget"]),Zd=new Set(["discover","filter","extract","finalize"]),em=0,Io=new Map,hn=[],Ms=null,ir=null,Cs=null;function Pa(){return Dn(process.env.REVAGENT_TELEMETRY_DISABLED)}function tm(e){return ka.createHash("sha256").update(String(e||""),"utf8").digest("hex")}function jn(e){return tm(e).slice(0,16)}function sr(e,t=400){let n=String(e||"");return n.length<=t?{text:n,truncated:!1}:{text:`${n.slice(0,t)}...[truncated ${n.length-t} chars]`,truncated:!0}}function nm(e){return String(e||"").split(/\r\n|\r|\n/).length}function fn(e,t,n,o){let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function om(){return fn(process.env.REVAGENT_TELEMETRY_TEXT_CHARS,1e3,0,1e4)}function rm(){return fn(process.env.REVAGENT_TELEMETRY_CODE_CHARS,4e3,0,1e5)}function yn(){return Pa()||Dn(process.env.REVAGENT_LIVE_STATUS_DISABLED)}function La(){return fn(process.env.REVAGENT_LIVE_STATUS_RECENT,50,5,200)}function Va(){return fn(process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT,32,1,64)}function As(){return fn(process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS,5e3,0,6e4)}function Da(e){return Hd.has(String(e??"").trim().toLowerCase())}function hr(e={}){let t=e.params||{};return[e.toolName,e.commandName,e.logicalToolName,t.logicalToolName,t.wrapperAction].some(Da)}function lr(e={},t){let n=g=>Array.isArray(g)?g.length:0,o=g=>{let p=Number.parseInt(String(g??""),10);return Number.isFinite(p)?p:null},r=["hostOnly","linkedOnly","hostAndLinked"].includes(String(e.sourceScope||""))?e.sourceScope:null,a=["retrieve","operation"].includes(String(e.mode||""))?e.mode:null,i=e.operation&&typeof e.operation=="object"&&!Array.isArray(e.operation)?e.operation:{},s=["relation_between","nearest_elements","elements_within","clearance_between","trace_connectivity","locate_in_space","above_below"].includes(String(e.operationName||i.name||""))?e.operationName||i.name:null,l=["require_current","allow_historical"].includes(String(e.livenessPolicy||""))?e.livenessPolicy:null,c=[e.nodeIds,e.nodeKinds,e.categories,e.categoryRoles,e.systemNames,e.levelNames,e.levelUniqueIds,e.startNodeIds,e.changeTypes,e.filters?.nodeIds,e.filters?.withinSpaceNodeIds,i.spaceNodeIds],u={privacyBoundary:"spatial_extraction",levelSelectorCount:n(e.levelIds)+n(e.levelNames),levelIdCount:n(e.levelIds),levelNameCount:n(e.levelNames),nameQueryPresent:typeof e.nameQuery=="string"&&e.nameQuery.length>0,linkInstanceSelectorCount:n(e.linkInstanceIds)+n(e.linkInstanceUniqueIds),linkedSourceLevelSelectorCount:n(e.linkedSourceLevels)+n(e.linkedSourceLevelNames),sourceRevisionCount:n(e.sourceRevisions)+n(e.expectedSourceRevisions),snapshotSelectorCount:[e.snapshotId,e.baseSnapshotId,e.headSnapshotId].filter(g=>typeof g=="string"&&g.length>0).length,selectorCount:c.reduce((g,p)=>g+n(p),0),sourceScope:r,mode:a,operationName:s,livenessPolicy:l,cursorPresent:typeof e.cursor=="string"&&e.cursor.length>0,pageTargetBytes:o(e.pageTargetBytes),maxElements:o(e.maxElements),maxResults:o(e.maxResults),maxItems:o(e.maxItems),maxResponseBytes:o(e.maxResponseBytes),maxDepth:o(e.maxDepth??i.maxDepth),maxElapsedMs:o(e.maxElapsedMs),timeoutMs:o(e.timeoutMs)},m=String(t??"").trim().toLowerCase();return m!=="inspect_levels"&&m!=="query_spatial_context"&&m!=="compare_spatial_snapshots"&&m!=="summarize_spatial_state"&&(u.includeHostMep=e.includeHostMep!==!1,u.includeRoomsSpaces=e.includeRoomsSpaces!==!1,u.includeLinkedObstructions=e.includeLinkedObstructions!==!1),u}function am(e,t){let n=String(e||""),o={hash:jn(n),length:n.length,present:n.length>0};if(t>0){let r=sr(n,t);o.text=r.text,o.textTruncated=r.truncated}return o}function im(e){let t=String(e||""),n={hash:jn(t),length:t.length,lineCount:nm(t),writePatternCount:So(t).length,writePatterns:So(t).slice(0,12),hasManualTransaction:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(t)},o=rm();if(o>0){let r=sr(t,o);n.preview=r.text,n.previewTruncated=r.truncated}return n}function sm(e,t){let n=new Set(["transactionMode","responseMode","planMode","planCandidateMode","targetVisualStyle","intent","imageFormat","cameraOrientation","viewType","category","discipline","cropBasis","searchBudget","linkScope","reason","scanStoppedReason"]);if(typeof t=="boolean"||typeof t=="number")return t;if(typeof t=="string")return n.has(e)?t:am(t,om())}function cr(e={}){let t={keys:[]};if(!e||typeof e!="object")return t;let n=Object.keys(e).sort();t.keys=n.filter(o=>o!=="code"&&o!=="parameters");for(let o of n){let r=e[o];if(o==="code"){t.code=im(r);continue}if(o==="parameters"){t.parameters={count:Array.isArray(r)?r.length:r==null?0:1};continue}if(/elementIds$/i.test(o)&&Array.isArray(r)){t[o]={count:r.length};continue}if(Array.isArray(r)){t[o]={count:r.length};continue}if(r&&typeof r=="object"){t[o]={keys:Object.keys(r).sort()};continue}let a=sm(o,r);a!==void 0&&(t[o]=a)}return t}function Fa(e){if(e&&typeof e=="object"){if(Dt(e,["success","Success"])===!1)return e;if("result"in e&&e.result!==null&&e.result!==void 0)return e.result;if("result"in e)return e}return e&&typeof e=="object"&&"result"in e?e.result:e}function Dt(e,t){if(!e||typeof e!="object")return;for(let o of t)if(Object.prototype.hasOwnProperty.call(e,o))return e[o];let n=Object.entries(e);for(let[o,r]of n)if(t.some(a=>o.toLowerCase()===a.toLowerCase()))return r}function ks(e){let t=String(e||"").trim().toLowerCase();return t==="runtime"||t==="client"?t:null}function Ro(e,t=null){if(t)return{success:!1,errorMessage:sr(t instanceof Error?t.message:String(t)).text,errorType:t instanceof Error?t.name:"Error"};let n=Fa(e),o=n&&typeof n=="object"&&!Array.isArray(n),r=o?Dt(n,["success","Success"]):void 0,a=o?Dt(n,["state","State"]):void 0,i=o?Dt(n,["action","Action"]):void 0,s=o?Dt(n,["error","Error","errorMessage","ErrorMessage"]):void 0,l=o?Dt(n,["message","Message"]):void 0,c=o?Dt(n,["guardSource","GuardSource"]):void 0,u=typeof n=="string"?n:"",m=/^\s*ERROR\s*:/i.test(u)?u:"",g=String(a||"").toLowerCase()==="guarded"||Dt(n,["guarded","blocked","focusBlocked"])===!0||/blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(s||l||u||""));return{success:typeof r=="boolean"?r:!s&&!m,guarded:g,guardSource:g?ks(c)||"runtime":null,state:a||null,action:i||null,responseKind:Array.isArray(n)?"array":n===null?"null":typeof n,responseKeys:o?Object.keys(n).sort().slice(0,40):[],errorMessage:s||m?sr(s||m).text:null,messageHash:l?jn(l):null}}function Is(e,t=null){if(t)return Ro(null,t);try{let n=e?.content?.find?.(o=>o?.type==="text")?.text;if(typeof n=="string"&&n.trim().startsWith("{"))return Ro(JSON.parse(n))}catch{}return{success:!0,guarded:!1,responseKind:e===null?"null":typeof e,responseKeys:e&&typeof e=="object"?Object.keys(e).sort().slice(0,40):[]}}function lm(){return fn(process.env.REVAGENT_TELEMETRY_CONTEXT_ELEMENTS,12,0,100)}function Os(e){if(typeof e!="string")return e;let t=e.trim();if(!t.startsWith("{")&&!t.startsWith("[")&&!t.startsWith('"'))return e;try{let n=JSON.parse(t);return typeof n=="string"?Os(n):n}catch{return e}}function Ps(e){try{let t=e?.content?.find?.(n=>n?.type==="text")?.text;if(typeof t=="string")return Os(t)}catch{}return e}function gn(e,t){let n=String(e??"").trim().toLowerCase();return t.has(n)?n:null}function ur(e,t=null){if(t)return{success:!1,guarded:!1,state:"failed",reason:"runtime_exception",privacyBoundary:"spatial_extraction"};let n=e?.content?Ps(e):e,o=Fa(n),r=ft(o);if(!r)return{success:!1,guarded:!1,state:"failed",reason:"invalid_response_kind",privacyBoundary:"spatial_extraction"};let a=ft(V(r,["page","Page"])),i=ft(V(r,["preparation","Preparation"])),s=V(r,["nodes","Nodes"]),l=V(r,["edges","Edges"]),c=V(r,["omissions","Omissions"]),u=V(r,["sourceRevisions","SourceRevisions"]),m=V(r,["sourceStates","SourceStates"]),g=V(r,["success","Success"]),p=V(r,["guarded","Guarded"])===!0,y=Re(V(a,["ordinal","Ordinal","pageOrdinal","PageOrdinal"]))??Re(V(r,["pageOrdinal","PageOrdinal"])),f=Re(V(a,["recordCount","RecordCount","rowCount","RowCount"]))??Re(V(r,["returnedCount","ReturnedCount"]))??(Array.isArray(s)?s.length:null),w=Re(V(a,["omissionCount","OmissionCount"]))??(Array.isArray(c)?c.length:null),T=Re(V(a,["payloadBytes","PayloadBytes"]))??Re(V(r,["payloadBytes","PayloadBytes"])),I=V(r,["nextCursor","NextCursor"])??V(a,["nextCursor","NextCursor"]),A=String(V(r,["continuationKind","ContinuationKind"])??"").trim().toLowerCase()==="work"?"work":null,R=(...k)=>{let q=V(r,k);return Array.isArray(q)?q.length:null},S=["added","removed","sourceAvailabilityChanges","transformChanges","moved","geometryChanges","propertyChanges","connectorChanges","connectivityChanges","proximityChanges"].reduce((k,q)=>{let X=V(r,[q]);return k+(Array.isArray(X)?X.length:0)},0);return{success:typeof g=="boolean"?g:!p,guarded:p,state:gn(V(r,["state","State"]),Gd)||(p?"guarded":"completed"),action:gn(V(r,["action","Action"]),Jd),reason:gn(V(r,["reason","Reason"]),Xd),scanStoppedReason:gn(V(r,["scanStoppedReason","ScanStoppedReason"]),Yd),coverageStatus:gn(V(r,["coverageStatus","CoverageStatus"]),Qd),partial:V(r,["partial","Partial"])===!0,continuationKind:A,preparationPhase:gn(V(i,["phase","Phase"]),Zd),preparationStepOrdinal:Re(V(i,["stepOrdinal","StepOrdinal"])),preparationProcessed:Re(V(i,["processed","Processed"])),preparationTotal:Re(V(i,["total","Total"])),pageOrdinal:y,recordCount:f,edgeCount:Array.isArray(l)?l.length:null,omissionCount:w,levelSummaryCount:R("levelSummaries","LevelSummaries"),capabilityGapCount:R("capabilityGaps","CapabilityGaps"),returnedChangeCount:S,sourceRevisionCount:Array.isArray(u)?u.length:null,sourceStateCount:Array.isArray(m)?m.length:null,liveness:gn(V(r,["liveness","Liveness"]),Kd),payloadBytes:T,hasMore:V(a,["hasMore","HasMore"])===!0,nextCursorPresent:typeof I=="string"&&I.length>0,workCursorPresent:A==="work"&&typeof I=="string"&&I.length>0,privacyBoundary:"spatial_extraction"}}function ft(e){return e&&typeof e=="object"&&!Array.isArray(e)?e:null}function V(e,t){return Dt(e,t)}function le(e,t,n=5){if(n<0||e===null||e===void 0)return;if(Array.isArray(e)){for(let a of e.slice(0,50)){let i=le(a,t,n-1);if(i!=null&&i!=="")return i}return}let o=ft(e);if(!o)return;let r=V(o,t);if(r!=null&&r!=="")return r;for(let a of Object.values(o)){let i=le(a,t,n-1);if(i!=null&&i!=="")return i}}function dr(e,t,n=5,o=[]){if(n<0||e===null||e===void 0||o.length>=20)return o;if(Array.isArray(e)){for(let a of e.slice(0,50))dr(a,t,n-1,o);return o}let r=ft(e);if(!r)return o;for(let[a,i]of Object.entries(r))t.some(s=>a.toLowerCase()===s.toLowerCase())&&Array.isArray(i)&&o.push(i),dr(i,t,n-1,o);return o}function Ma(e,t,n=5,o=[]){if(n<0||e===null||e===void 0||o.length>=20)return o;if(Array.isArray(e)){for(let a of e.slice(0,50))Ma(a,t,n-1,o);return o}let r=ft(e);if(!r)return o;for(let[a,i]of Object.entries(r))t.some(s=>a.toLowerCase()===s.toLowerCase())&&ft(i)&&o.push(i),Ma(i,t,n-1,o);return o}function ye(e){return e==null?null:typeof e=="string"?e:typeof e=="number"||typeof e=="boolean"?String(e):null}function Re(e){return typeof e=="number"&&Number.isFinite(e)?e:typeof e=="string"&&/^-?\d+$/.test(e.trim())?Number.parseInt(e.trim(),10):null}function Ls(e,t=25){return[...new Set((Array.isArray(e)?e:[]).map(n=>Re(n)).filter(n=>Number.isFinite(n)))].slice(0,t)}function cm(e={}){let t=[];e.elementId!==void 0&&t.push(e.elementId),e.viewId!==void 0&&t.push(e.viewId);for(let[n,o]of Object.entries(e||{}))/elementIds$/i.test(n)&&Array.isArray(o)&&t.push(...o);return Ls(t,50)}function Rs(e){let t=ft(e);if(!t)return null;let n=Re(V(t,["id","Id","elementId","ElementId"])),o=ye(V(t,["name","Name"])),r=ye(V(t,["category","Category","categoryName","CategoryName"])),a=ye(V(t,["typeName","TypeName","familyName","FamilyName"])),i=ye(V(t,["levelName","LevelName","level","Level"])),s=ye(V(t,["roomName","RoomName","room","Room"])),l=ye(V(t,["roomNumber","RoomNumber"])),c=ye(V(t,["spaceName","SpaceName","space","Space"])),u=ye(V(t,["spaceNumber","SpaceNumber"]));return!n&&!o&&!r&&!a&&!i&&!s&&!c?null:{id:n,name:o,category:r,typeName:a,levelName:i,roomName:s,roomNumber:l,spaceName:c,spaceNumber:u}}function um(e){let t=new Set;return e.filter(n=>{if(!n)return!1;let o=n.id?`id:${n.id}`:JSON.stringify(n);return t.has(o)?!1:(t.add(o),!0)})}function dm(e,t){let n=dr(e,["elements","Elements","selectionElements","SelectionElements"]),o=Ma(e,["chosenElement","ChosenElement","targetElement","TargetElement"]),r=[];for(let a of o)r.push(Rs(a));for(let a of n)for(let i of a.slice(0,t))r.push(Rs(i));return um(r).slice(0,t)}function mm(e){let t=le(e,["selectionIds","SelectionIds"],4);return Array.isArray(t)?Ls(t,50):[]}function pm(e){let t=dr(e,["files","Files"],4),n=[];for(let o of t)for(let r of o.slice(0,12)){let a=ft(r);a&&n.push({path:ye(V(a,["path","Path"])),fileName:ye(V(a,["fileName","FileName"])),bytes:Re(V(a,["bytes","Bytes"])),width:Re(V(a,["width","Width"])),height:Re(V(a,["height","Height"])),finalPixelSizeMatchesRequest:V(a,["finalPixelSizeMatchesRequest","FinalPixelSizeMatchesRequest"])})}return n.filter(o=>o.path||o.fileName)}function Na(e,t){let n=le(e,t,4);return ft(n)?{id:Re(V(n,["id","Id","viewId","ViewId"])),name:ye(V(n,["name","Name","viewName","ViewName"])),type:ye(V(n,["type","Type","viewType","ViewType"]))}:null}function gm(e,t=20){return[...new Set(e.filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim()))].slice(0,t)}function hm(e=[],t="",n="",o=""){let r=`${e.join(" ")} ${t} ${n} ${o}`.toLowerCase();return/\bm\d{2,}[a-z]?\b/i.test(r)?"mechanical_hvac":/\bp\d{2,}[a-z]?\b/i.test(r)?"mechanical_piping":/\be\d{2,}[a-z]?\b/i.test(r)?"electrical":/\bs\d{2,}[a-z]?\b/i.test(r)?"structural":/\ba\d{2,}[a-z]?\b/i.test(r)?"architectural":/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(r)?"mechanical_hvac":/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)/i.test(r)?"mechanical_piping":/(electrical|cable|lighting|elektrik)/i.test(r)?"electrical":/(structural|beam|column|framing|statik|kiris|kolon)/i.test(r)?"structural":/(wall|door|window|room|space|architect|mimari)/i.test(r)?"architectural":/(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)/i.test(r)?"schedule_documentation":null}function fm(e,t){let n=e||t||"";return n?jn(n):null}function ym(e={},t=[]){for(let n of t){let o=e?.[n];if(typeof o=="string"&&o.trim())return o.trim()}return null}function Sm(e={},t=[]){return t.map(n=>e?.[n]).filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim())}function bm(e={},t="",n=null,o=null,r=null,a={}){return[t,a.toolName,a.commandName,a.logicalToolName,...Sm(e,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery","planNameContains","category","discipline"]),...Array.isArray(e.rowTextQueries)?e.rowTextQueries:[],...Array.isArray(e.categoryNames)?e.categoryNames:[],n?.name,o?.name,r?.name].filter(s=>typeof s=="string"&&s.trim()).join(" ")}function _m(...e){let t=e.filter(a=>typeof a=="string"&&a.trim()).join(" ");if(!t)return null;let n=t.match(/\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b/i);if(n)return`Level ${n[1].padStart(2,"0")}`;let o=t.match(/\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b/i);if(o)return`Level ${o[1].padStart(2,"0")}`;let r=t.match(/\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b/i);return r?`Basement ${r[1].padStart(2,"0")}`:null}function xm(e={}){if(hr(e))return null;let t=e.sourceEventType==="mcp.tool"?Ps(e.response):Fa(e.response),n=ft(t),o=e.params||{},r=e.taskName||o.taskName||e.options?.taskName||e.logicalToolName||e.toolName||e.commandName||null,a=e.responseSummary||Ro(e.response,e.error),i=lm(),s=i>0?dm(t,i):[],l=gm([...Array.isArray(o.categoryNames)?o.categoryNames.map(String):[],ye(o.category),...s.map(x=>x.category)]),c=le(t,["document","Document"],3),u=ye(le(t,["documentTitle","DocumentTitle"],5))||ye(V(c,["title","Title","name","Name"])),m=ye(le(t,["documentPath","DocumentPath"],5))||ye(V(c,["path","Path","modelPath","ModelPath"])),g=Na(t,["activeView","ActiveView","view","View"]),p=Na(t,["beforeView","BeforeView","activeViewBefore","ActiveViewBefore"]),y=Na(t,["afterView","AfterView"]),f=cm(o),w=mm(t),T=pm(t),I=ye(le(t,["levelName","LevelName","activePlanLevelName","ActivePlanLevelName"],5)),_=Re(le(t,["levelId","LevelId","activePlanLevelId","ActivePlanLevelId"],5)),A=ye(le(t,["roomName","RoomName"],5)),R=ye(le(t,["roomNumber","RoomNumber"],5)),E=ye(le(t,["spaceName","SpaceName"],5)),S=ye(le(t,["spaceNumber","SpaceNumber"],5)),k=ym(o,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery"]),q=typeof o.outputDir=="string"?o.outputDir:ye(le(t,["outputDir","OutputDir"],4)),X=typeof o.filePrefix=="string"?o.filePrefix:ye(le(t,["filePrefix","FilePrefix"],4)),re=bm(o,r||"",g,p,y,e),Z=I||_m(re),pe=le(t,["inferredScope","InferredScope"],5),Oe=le(t,["effectiveScope","EffectiveScope"],5),be=le(t,["riskPolicy","RiskPolicy","searchRiskPolicy","SearchRiskPolicy"],5),De=le(t,["scanPolicy","ScanPolicy"],5),Rt=le(t,["partial","Partial"],4),Je=ye(le(t,["scanStoppedReason","ScanStoppedReason"],4)),Ne=Re(le(t,["scannedElementCount","ScannedElementCount"],4));return!(r||u||m||g||p||y||f.length||w.length||s.length||T.length||Z||A||E||k||q)?null:{eventType:"production.context",contextSchemaVersion:"revagent.production.context.v1",related:{sourceEventType:e.sourceEventType,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null},runId:e.taskId||o.taskId||e.options?.taskId||jn(`${gr}|${e.sourceEventType||""}|${e.toolName||""}|${e.commandName||""}|${e.startedAtMs||""}|${r||""}`),operation:{taskName:r,query:k,action:a.action||ye(le(t,["action","Action"],3)),durationMs:e.durationMs,success:a.success,guarded:a.guarded,state:a.state,errorMessage:a.errorMessage},project:{projectId:fm(m,u),documentTitle:u,documentPath:m,isFamilyDocument:le(t,["isFamilyDocument","IsFamilyDocument"],4),isReadOnly:le(t,["isReadOnly","IsReadOnly"],4),isModifiable:le(t,["isModifiable","IsModifiable"],4)},view:{active:g,before:p,after:y,activeViewChanged:le(t,["activeViewChanged","ActiveViewChanged"],4)},location:{levelId:_,levelName:Z,roomName:A,roomNumber:R,spaceName:E,spaceNumber:S},elements:{targetElementIds:f,selectionIds:w,selectionCount:Re(le(t,["selectionCount","SelectionCount"],4)),categories:l,disciplineHint:hm(l,r||"",re,e.toolName||e.logicalToolName||e.commandName||""),samples:s,samplesTruncated:i>0&&s.length>=i},outputs:{outputDir:q,filePrefix:X,files:T},search:{query:k,inferredScope:pe,effectiveScope:Oe,riskPolicy:be,riskLevel:V(be,["riskLevel","RiskLevel"])||null,recommendedFirstScope:V(be,["recommendedFirstScope","RecommendedFirstScope"])||null,requiresUserControl:V(be,["requiresUserControl","RequiresUserControl"])===!0,scanPolicy:De,searchBudget:o.searchBudget||V(De,["searchBudget","SearchBudget"])||null,linkScope:o.linkScope||V(Oe,["linkScope","LinkScope"])||null,planCandidateMode:o.planCandidateMode||V(De,["planCandidateMode","PlanCandidateMode"])||null,allowExpensiveSearch:o.allowExpensiveSearch===!0||V(De,["allowExpensiveSearch","AllowExpensiveSearch"])===!0,scannedElementCount:Ne,partial:Rt===!0,scanStoppedReason:Je,needsScope:a.guarded&&a.state==="guarded"&&(V(n,["reason","Reason"])==="needs_scope"||Je==="needs_scope")},response:{responseKeys:a.responseKeys||(n?Object.keys(n).sort().slice(0,40):[])}}}function Aa(e={}){let t=xm(e);t&&To(t)}function Vs(){let e=hs();return{disabled:Pa(),localOnly:Dn(process.env.REVAGENT_TELEMETRY_LOCAL_ONLY),localRoot:process.env.REVAGENT_TELEMETRY_ROOT||fs(),reportsRoot:process.env.REVAGENT_REPORTS_ROOT||e?.reportsRoot||""}}function Ds(e){let t=e.getUTCFullYear().toString(),n=String(e.getUTCMonth()+1).padStart(2,"0"),o=String(e.getUTCDate()).padStart(2,"0");return{year:t,month:n,day:o,ymd:`${t}-${n}-${o}`}}function vm(e){let t=Vs();if(t.disabled)return[];let n=new Date(e.timestampUtc||Date.now()),o=Ds(n),r=tr(pn(e.machineName),"unknown-machine"),i=[{kind:"local",path:Fn.join(t.localRoot,"events",`${o.ymd}.ndjson`)}];return!t.localOnly&&t.reportsRoot&&i.push({kind:"remote",path:Fn.join(t.reportsRoot,"events",o.year,o.month,o.day,r,`${e.sessionId}.ndjson`)}),i}function wm(){let e=Vs();return{disabled:yn(),localOnly:e.localOnly||Dn(process.env.REVAGENT_LIVE_STATUS_LOCAL_ONLY),localRoot:process.env.REVAGENT_LIVE_STATUS_LOCAL_ROOT||Fn.join(e.localRoot,"live"),reportsRoot:process.env.REVAGENT_LIVE_STATUS_ROOT||(e.reportsRoot?Fn.join(e.reportsRoot,"live"):"")}}function Fs(e=[]){let t=wm();if(t.disabled)return[];let o=["machines",tr(pn(process.env.COMPUTERNAME||Oa.hostname()),"unknown-machine"),...e],r=[{kind:"local",path:Fn.join(t.localRoot,...o)}];return!t.localOnly&&t.reportsRoot&&r.push({kind:"remote",path:Fn.join(t.reportsRoot,...o)}),r}function js(e){return!e||typeof e!="object"||Array.isArray(e)?null:{success:typeof e.success=="boolean"?e.success:null,guarded:e.guarded===!0,guardSource:e.guardSource||null,state:e.state||null,action:e.action||null,errorMessage:e.errorMessage||null,messageHash:e.messageHash||null}}function mr(e,t="summary"){if(!e)return null;let n={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,taskIdPresent:!!e.taskId,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,state:e.state,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:t==="full"?e.result||null:js(e.result)};return t!=="full"&&!n.result&&delete n.result,n}function Ts(e){if(!e||typeof e!="object")return null;let t=e.commandName||e.method||null,n=e.wrapperAction||e.logicalToolName||e.toolName||t,o=[t,n,e.wrapperAction,e.logicalToolName].some(Da);return{id:e.id||null,requestId:e.requestId||null,method:n||null,toolName:n||null,commandName:t,wrapperAction:e.wrapperAction||null,logicalToolName:e.logicalToolName||null,taskName:o?null:e.taskName||null,parentTaskName:o?null:e.parentTaskName||null,parentTaskIdPresent:o?!1:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,elapsedMs:e.elapsedMs??null,requestBytes:e.requestBytes??null,responseBytes:e.responseBytes??null,port:e.port||null,error:o?null:e.error||null}}function Cm(e,t){if(t==="full")return e;let n=js(e.result),o={timestampUtc:e.timestampUtc||e.finishedAtUtc||e.startedAtUtc||null,phase:e.phase,state:e.state||e.phase||null,scope:e.scope||null,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),guardSource:e.guardSource||n?.guardSource||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null};return n&&(o.success=n.success,o.guarded=n.guarded,o.action=n.action,o.errorMessage=n.errorMessage,o.messageHash=n.messageHash),Object.fromEntries(Object.entries(o).filter(([,r])=>r!=null))}function Bs(e=10,t="summary"){let n=fn(e,10,0,100),o=t==="full"?"full":"summary",a=(o==="full"?hn:hn.filter(i=>i.phase!=="started")).slice(0,n).map(i=>Cm(i,o));return{mode:o,activeTask:mr(qs(),o),activeTasks:[...Io.values()].map(i=>mr(i,o)),recentActivity:a,recentActivityCount:a.length,recentActivityStoredCount:hn.length,recentActivityCapacity:La()}}function Im(e){if(!e||typeof e!="object")return null;let t=e.result&&typeof e.result=="object"?e.result:e;return{capturedAtUtc:new Date().toISOString(),activeTask:Ts(t.activeTask),recentTasks:(Array.isArray(t.recentTasks)?t.recentTasks:[]).map(Ts).filter(Boolean).slice(0,100),recentHistoryCount:t.recentHistoryCount??null,recentHistoryCapacity:t.recentHistoryCapacity??null}}function fr(e){if(yn())return;let t=Im(e);t&&(Ms=t,pr("revit.status"))}function qs(){let e=[...Io.values()];return e.length===0?null:e.sort((t,n)=>{let o=a=>a.scope==="revit.command"?2:1,r=o(n)-o(t);return r!==0?r:String(n.startedAtUtc||"").localeCompare(String(t.startedAtUtc||""))})[0]}function Rm(e="activity"){let n=_o()?.version||null,o=new Date().toISOString();return Cs=o,{schemaVersion:$d,generatedAtUtc:o,lastHeartbeatUtc:Cs,reason:e,machineName:pn(process.env.COMPUTERNAME||Oa.hostname()),userName:process.env.USERNAME||process.env.USER||"",sessionId:gr,runtime:{version:n,buildHash:xo(n)},process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:Ns},activeTask:mr(qs(),"full"),activeTasks:[...Io.values()].map(r=>mr(r,"full")),recentActivity:hn.slice(0,La()),revitStatus:Ms,writeHealth:_s(Va())}}function Tm(e){let t=Array.isArray(e?.revitStatus?.recentTasks)?e.revitStatus.recentTasks:[],n=Array.isArray(e?.activeTasks)?e.activeTasks:[],o=Array.isArray(e?.recentActivity)?e.recentActivity:[];return!!(e?.activeTask||n.length>0||o.length>0||e?.revitStatus?.activeTask||t.length>0)}function Em(e){let t=Date.parse(String(e?.generatedAtUtc||e?.lastHeartbeatUtc||""));return Number.isFinite(t)?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY}function Nm(e,t){let n=Vt(e);if(!n||pn(n.machineName)!==pn(t.machineName))return t;let o=Math.max(600*1e3,As()*6);return!Tm(n)||Em(n)>o?t:{...t,recentActivity:Array.isArray(t.recentActivity)&&t.recentActivity.length>0?t.recentActivity:Array.isArray(n.recentActivity)?n.recentActivity:[],revitStatus:ws(t.revitStatus,n.revitStatus)}}function pr(e="activity"){let t=Rm(e);for(let n of Fs(["status.json"]))Ra(n.path,o=>Ss(o,Nm(o,t)),{disabled:yn,maxInFlight:Va})}function Mm(e){let t={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName,commandName:e.commandName,logicalToolName:e.logicalToolName,executionKind:e.executionKind,taskName:e.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,guardSource:e.guardSource,state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,durationMs:e.durationMs,result:e.result};e.phase==="started"?Io.set(e.liveTaskId,t):Io.delete(e.liveTaskId),hn.unshift({timestampUtc:e.timestampUtc,phase:e.phase,state:e.state,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:e.result||null});let n=La();hn.length>n&&hn.splice(n)}function zs(e){Mm(e);let t=Ds(new Date(e.timestampUtc||Date.now()));for(let n of Fs(["activity",`${t.ymd}.ndjson`]))Ra(n.path,o=>Ia(o,e),{disabled:yn,maxInFlight:Va});pr(e.phase)}function Am(e={},t){return e.taskId?String(e.taskId):jn([gr,e.scope||"",e.toolName||"",e.commandName||"",e.logicalToolName||"",t||Date.now(),e.taskName||""].join("|"))}function Bn(e={}){if(yn())return null;let t=hr(e),n=t?{...e,taskName:null,taskId:null,parentTaskName:null,parentTaskId:null}:e,o=n.startedAtMs||Date.now(),r=new Date(o).toISOString(),a=Am(n,o),i=ja({schemaVersion:Es,eventType:"live.activity",phase:"started",state:"running",liveTaskId:a,scope:n.scope||"runtime",toolName:n.toolName||null,commandName:n.commandName||null,logicalToolName:n.logicalToolName||null,executionKind:n.executionKind||null,taskName:n.taskName||null,taskId:n.taskId||null,taskIdPresent:!!n.taskId,parentTaskName:n.parentTaskName||null,parentTaskId:n.parentTaskId||null,parentTaskIdPresent:!!n.parentTaskId,startedAtUtc:r,params:t?lr(n.params,n.toolName||n.logicalToolName||n.commandName):cr(n.params)});return zs(i),{liveTaskId:a,scope:i.scope,toolName:i.toolName,commandName:i.commandName,logicalToolName:i.logicalToolName,executionKind:i.executionKind,taskName:i.taskName,taskId:i.taskId,parentTaskName:i.parentTaskName,parentTaskId:i.parentTaskId,guardSource:i.guardSource,startedAtMs:o,startedAtUtc:r}}function yt(e,t={}){if(!e||yn())return;let n=Date.now(),o=t.durationMs??Math.max(0,n-(e.startedAtMs||n)),a=hr({...t,...e})?ur(t.response,t.error):t.responseSummary||Ro(t.response,t.error),i=a.guarded?"guarded":a.success===!1?"failed":"completed",s=a.guarded?ks(t.guardSource||e.guardSource||a.guardSource)||"runtime":null,l=ja({schemaVersion:Es,eventType:"live.activity",phase:i,state:i,liveTaskId:e.liveTaskId,scope:e.scope||t.scope||"runtime",toolName:e.toolName||t.toolName||null,commandName:e.commandName||t.commandName||null,logicalToolName:e.logicalToolName||t.logicalToolName||null,executionKind:e.executionKind||t.executionKind||null,taskName:e.taskName||t.taskName||null,taskId:e.taskId||t.taskId||null,taskIdPresent:!!(e.taskId||t.taskId),parentTaskName:e.parentTaskName||t.parentTaskName||null,parentTaskId:e.parentTaskId||t.parentTaskId||null,parentTaskIdPresent:!!(e.parentTaskId||t.parentTaskId),guardSource:s,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:new Date(n).toISOString(),durationMs:o,result:a});zs(l)}function km(){if(ir||yn())return;let e=As();e<=0||(pr("session.start"),ir=setInterval(()=>{pr("heartbeat")},e),typeof ir.unref=="function"&&ir.unref())}function ja(e={}){let n=_o()?.version||null;return{schemaVersion:Wd,eventId:ka.randomUUID(),eventType:e.eventType||"runtime.event",timestampUtc:e.timestampUtc||new Date().toISOString(),sessionId:gr,sequence:++em,source:"runtime-mcp-server",process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:Ns},machineName:pn(process.env.COMPUTERNAME||Oa.hostname()),userName:process.env.USERNAME||process.env.USER||"",runtime:{version:n,buildHash:xo(n)},...e}}async function To(e={}){if(Pa())return;let t=ja(e),n=vm(t);await Promise.allSettled(n.map(o=>bs(o.path,t)))}function Us(){km(),To({eventType:"runtime.session.start"})}function Ft(e={}){let t=Math.max(0,Date.now()-(e.startedAtMs||Date.now())),n=hr(e),o=n?ur(e.response,e.error):Ro(e.response,e.error);To({eventType:"revit.command",commandName:e.commandName,logicalToolName:e.logicalToolName||e.commandName,executionKind:e.executionKind||"bridgeCommand",taskName:n?null:e.params?.taskName||e.options?.taskName||null,taskIdPresent:n?!1:!!(e.params?.taskId||e.options?.taskId),parentTaskName:n?null:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskIdPresent:n?!1:!!(e.params?.parentTaskId||e.options?.parentTaskId),transactionMode:n?null:e.params?.transactionMode||e.options?.transactionMode||null,connection:n?void 0:{targetPresent:!!e.options?.target,hostPresent:!!e.options?.host,port:e.options?.port||null},durationMs:t,params:n?lr(e.params,e.logicalToolName||e.commandName):cr(e.params),result:o}),Aa({...e,sourceEventType:"revit.command",durationMs:t,responseSummary:o,taskName:e.params?.taskName||e.options?.taskName||null,taskId:e.params?.taskId||e.options?.taskId||null,parentTaskName:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskId:e.params?.parentTaskId||e.options?.parentTaskId||null})}function Om(e){return!(e==="get_revit_mcp_status"&&!Dn(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS))}function Ws(e){return{...e,tool(t,n,o,r){let a=n,i=o,s=r;typeof n=="object"&&(s=o,i=n,a="");let l=async(c,u)=>{let m=Date.now(),g=Om(t),p=Da(t),y=g?Bn({scope:"mcp.tool",toolName:t,taskName:c?.taskName||null,taskId:c?.taskId||null,parentTaskName:c?.parentTaskName||null,parentTaskId:c?.parentTaskId||null,params:c,startedAtMs:m}):null;try{let f=await s(c,u);if(g){let w=Math.max(0,Date.now()-m),T=p?ur(f):Is(f);To({eventType:"mcp.tool",toolName:t,taskName:p?null:c?.taskName||null,taskIdPresent:p?!1:!!c?.taskId,parentTaskName:p?null:c?.parentTaskName||null,parentTaskIdPresent:p?!1:!!c?.parentTaskId,durationMs:w,params:p?lr(c,t):cr(c),result:T}),Aa({sourceEventType:"mcp.tool",toolName:t,taskName:c?.taskName||null,taskId:c?.taskId||null,parentTaskName:c?.parentTaskName||null,parentTaskId:c?.parentTaskId||null,params:c,response:f,durationMs:w,startedAtMs:m,responseSummary:T}),yt(y,{response:f,responseSummary:T,durationMs:w})}return f}catch(f){if(g){let w=Math.max(0,Date.now()-m),T=p?ur(null,f):Is(null,f);To({eventType:"mcp.tool",toolName:t,taskName:p?null:c?.taskName||null,taskIdPresent:p?!1:!!c?.taskId,parentTaskName:p?null:c?.parentTaskName||null,parentTaskIdPresent:p?!1:!!c?.parentTaskId,durationMs:w,params:p?lr(c,t):cr(c),result:T}),Aa({sourceEventType:"mcp.tool",toolName:t,taskName:c?.taskName||null,taskId:c?.taskId||null,parentTaskName:c?.parentTaskName||null,parentTaskId:c?.parentTaskId||null,params:c,error:f,durationMs:w,startedAtMs:m,responseSummary:T}),yt(y,{error:f,responseSummary:T,durationMs:w})}throw f}};return e.tool(t,a,i,l)}}}var Pm=2;function P(e){return{target:e.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVAGENT_TARGET, then legacy REVIT_MCP_TARGET, then REVAGENT_PORT/8080."),host:e.string().optional().describe("Optional Revit socket host. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),port:e.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVAGENT_PORT, then legacy REVIT_MCP_PORT, then 8080.")}}function L(e){return{taskName:e.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),taskId:e.string().optional().describe("Optional client task identifier forwarded to Revit status history."),parentTaskName:e.string().optional().describe("Optional parent workflow display name. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task."),parentTaskId:e.string().optional().describe("Optional parent workflow identifier. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task id.")}}function h(e,t,n){if(!e||typeof e!="object")return;let o=n??t.charAt(0).toLowerCase()+t.slice(1);return e[t]??e[o]}function Pe(e={}){return{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs}}function et(e={},t){return{taskName:e.taskName||t,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId}}function z(e={},t){return{...Pe(e),...et(e,t)}}function Hs(e,t){let n=t.parentTaskName||(t.taskName&&e.taskName&&e.taskName!==t.taskName?t.taskName:void 0),o=t.parentTaskId||(t.taskId&&e.taskName&&e.taskName!==t.taskName?t.taskId:void 0);n&&!e.parentTaskName&&(e.parentTaskName=n),o&&!e.parentTaskId&&(e.parentTaskId=o)}function Gs(e,t,n){let o=n.toolName||t;o&&!e.logicalToolName&&(e.logicalToolName=o),n.toolName&&n.toolName!==t&&!e.wrapperAction&&(e.wrapperAction=n.toolName)}function yr(e){let t=[["Success","success"],["SUCCESS","success"],["Guarded","guarded"],["State","state"],["Action","action"],["Message","message"],["Error","error"],["ResultContractVersion","resultContractVersion"]],n=o=>{if(Array.isArray(o))return o.map(a=>n(a));if(!o||typeof o!="object")return o;let r={};for(let[a,i]of Object.entries(o))r[a]=n(i);for(let[a,i]of t)Object.prototype.hasOwnProperty.call(r,a)&&(Object.prototype.hasOwnProperty.call(r,i)||(r[i]=r[a]),delete r[a]);return r};return n(e)}function b(e){let t=yr(e);return{content:[{type:"text",text:JSON.stringify(t,null,2)}]}}function Eo(e,t=0){if(typeof e!="string")return e;let n=e.trim();if(!n.startsWith("{")&&!n.startsWith("[")&&!n.startsWith('"'))return e;try{let o=JSON.parse(n);return t<2&&typeof o=="string"?Eo(o,t+1):o}catch{return e}}function Sr(e){if(Array.isArray(e))return e.map(n=>Sr(n));if(!e||typeof e!="object")return e;let t={};for(let[n,o]of Object.entries(e)){let r=n==="result"||n==="Result"?Eo(o):o;t[n]=Sr(r)}return t}function Lm(e){if(!e||typeof e!="object"||Array.isArray(e))return null;let t=e.resultContractVersion??e.ResultContractVersion,n=Number.parseInt(String(t??""),10);return Number.isFinite(n)?n:null}function Vm(e){let t=Lm(e);return t!==null&&t>=Pm}function jt(e,t={}){let n=Eo(e);if(Vm(n))return t.parseResultStrings===!0?yr(Sr(n)):n;if(n&&typeof n=="object"&&!Array.isArray(n)){let o=n;return t.parseResultStrings===!0?o=Sr(o):("result"in o||"Result"in o)&&(o={...o},"result"in o?o.result=Eo(o.result):o.Result=Eo(o.Result)),yr(o)}return yr(n)}function Js(e,t,n,o){let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function Sn(e,t={}){let n=t.verboseCandidates===!0,o=Js(t.maxPlanCandidates,3,0,100);if(n)return e;let r=a=>{if(Array.isArray(a))return a.map(s=>r(s));if(!a||typeof a!="object")return a;let i={};for(let[s,l]of Object.entries(a)){if((s==="PlanCandidates"||s==="planCandidates")&&Array.isArray(l)){let c=s==="PlanCandidates"?"PlanCandidatesTotal":"planCandidatesTotal",u=s==="PlanCandidates"?"PlanCandidatesTruncated":"planCandidatesTruncated";i[c]=l.length,i[u]=l.length>o,i[s]=l.slice(0,o).map(m=>r(m));continue}i[s]=r(l)}return i};return r(e)}function $s(e,t){if(!e||typeof e!="object")return e;let n=e.commandName||e.method,o=e.wrapperAction||e.logicalToolName||e.toolName||n,r={id:e.id,requestId:e.requestId,method:o,toolName:o,commandName:n,wrapperAction:e.wrapperAction,logicalToolName:e.logicalToolName,taskName:e.taskName,parentTaskName:e.parentTaskName,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,elapsedMs:e.elapsedMs,port:e.port,error:e.error};return t&&(r.framing=e.framing,r.requestBytes=e.requestBytes,r.receiveMs=e.receiveMs,r.parseMs=e.parseMs,r.executeMs=e.executeMs,r.responseBytes=e.responseBytes),r}function No(e,t={}){let n=t.includeRecentTasks!==!1,o=t.includeDiagnostics===!0,r=Js(t.recentLimit,3,0,100),a=e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e;if(!a||typeof a!="object")return e;let i={...a};return i.activeTask=$s(a.activeTask,o),Array.isArray(a.recentTasks)&&(i.recentHistoryCount=a.recentHistoryCount??a.recentTasks.length,i.recentHistoryCapacity=a.recentHistoryCapacity??100,delete i.recentTasksTotal,n?(i.recentTasks=a.recentTasks.slice(0,r).map(s=>$s(s,o)),i.recentTasksTruncated=a.recentTasks.length>r):(delete i.recentTasks,i.recentTasksIncluded=!1)),e&&typeof e=="object"&&e.result&&typeof e.result=="object"?{...e,result:i}:i}async function Ce(e,t={}){let n={code:e,parameters:t.parameters||[],transactionMode:t.transactionMode||"none",taskName:t.taskName||"Run Revit code"};t.taskId&&(n.taskId=t.taskId),Gs(n,"send_code_to_revit",t),Hs(n,t);let o=Date.now(),r=Bn({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",taskName:n.taskName,taskId:n.taskId,parentTaskName:n.parentTaskName,parentTaskId:n.parentTaskId,params:n,startedAtMs:o});try{let a=await ht(async l=>await l.sendCommand("send_code_to_revit",n,t),t),i=t.parseJsonResult===!1?a:jt(a,{parseResultStrings:!0}),s=Math.max(0,Date.now()-o);return Ft({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,response:i,startedAtMs:o}),yt(r,{response:i,durationMs:s}),br(t),i}catch(a){let i=Math.max(0,Date.now()-o);throw Ft({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,error:a,startedAtMs:o}),yt(r,{error:a,durationMs:i}),br(t),a}}function Dm(e={}){return e.refreshStatusAfterCommand!==!1}function br(e={}){Dm(e)&&_r(e)}async function _r(e={}){let t=Math.max(250,Math.min(5e3,Number(e.statusRefreshTimeoutMs||1500)));try{let n=await ht(async o=>await o.sendCommand("mcp_status",{},{timeoutMs:t}),{...e,skipLock:!0,connectTimeoutMs:t,timeoutMs:t,logSocketErrors:!1});return fr(n),n}catch{return null}}async function U(e,t={},n={}){let o={...t};o.taskName||(o.taskName=n.taskName||e),Hs(o,n),n.taskId&&!o.taskId&&(o.taskId=n.taskId),Gs(o,e,n);let r=Date.now(),a=Bn({scope:"revit.command",commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",taskName:o.taskName,taskId:o.taskId,parentTaskName:o.parentTaskName,parentTaskId:o.parentTaskId,params:o,startedAtMs:r});try{let i=await ht(async c=>await c.sendCommand(e,o,n),n),s=jt(i),l=Math.max(0,Date.now()-r);return Ft({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:o,options:n,response:s,startedAtMs:r}),yt(a,{response:s,durationMs:l}),br(n),s}catch(i){let s=Math.max(0,Date.now()-r);throw Ft({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:o,options:n,error:i,startedAtMs:r}),yt(a,{error:i,durationMs:s}),br(n),i}}function G(e){return e==null?"null":`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n")}"`}function St(e){return`new string[] { ${(Array.isArray(e)?e:[]).map(G).join(", ")} }`}function xr(e){return`new int[] { ${(Array.isArray(e)?e:[]).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function Ks(e,t){let n=Number(t||0);return!n||typeof e!="string"||e.length<=n?{text:e,truncated:!1}:{text:`${e.slice(0,n)}
...[truncated ${e.length-n} chars]`,truncated:!0}}function Fm(e){let t=new Set,n=(o,r="")=>{if(o!=null){if(typeof o=="number"&&/(^id$|elementid|elementids)/i.test(r)){t.add(o);return}if(typeof o=="string"&&/^-?\d+$/.test(o)&&/(^id$|elementid|elementids)/i.test(r)){t.add(Number.parseInt(o,10));return}if(Array.isArray(o)){for(let a of o)n(a,r);return}if(typeof o=="object")for(let[a,i]of Object.entries(o))n(i,a)}};return n(e),[...t].filter(o=>Number.isFinite(o)&&o>0)}async function qn(e=100,t={}){let n=await U("get_selected_elements",{limit:e},t);return Fm(n).slice(0,e)}var jm=new Set(["success","guarded","state","action","error","reason","warnings","notices"]);function Xs(e){let t=String(e||"").trim();return t.length>0?t:void 0}function Ys(e){if(!Array.isArray(e))return;let t=e.map(n=>String(n||"").trim()).filter(n=>n.length>0);return t.length>0?t:void 0}function Bm(e){return e?Object.fromEntries(Object.entries(e).filter(([t])=>!jm.has(t))):{}}function Ba(e,t){let n={...Bm(t.extra),...e,action:t.action},o=Xs(t.error),r=Xs(t.reason),a=Ys(t.warnings),i=Ys(t.notices);return o&&(n.error=o),r&&(n.reason=r),a&&(n.warnings=a),i&&(n.notices=i),n}function Qs(e){return Ba({success:!0,guarded:!1,state:"completed",action:e.action},e)}function Et(e){return Ba({success:!1,guarded:!0,state:"guarded",action:e.action},e)}function ct(e){return Ba({success:!1,guarded:!1,state:"failed",action:e.action},e)}function qm(e){let t=String(e||"");return t.match(/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\b(?:class|struct|interface|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*/m)?{reason:"dynamic_snippet_type_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). C# type declarations such as class/struct/interface/enum/record cannot be declared inside that method body. Use local functions, built-in collections, or add a native runtime tool when reusable helper types are needed."}:t.match(/^\s*namespace\s+[A-Za-z_][A-Za-z0-9_.]*/m)?{reason:"dynamic_snippet_namespace_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). namespace declarations cannot be declared inside that method body. Use method-body C# only."}:null}function zm(e){let t=jt(e);if(t&&typeof t=="object"&&t.success===!1)return t.error||t.errorMessage||t.message||"Revit code returned success=false.";let n=t&&typeof t=="object"&&"result"in t?t.result:t;return typeof n=="string"&&/^\s*ERROR\s*:/i.test(n)?n.trim():n&&typeof n=="object"&&n.success===!1?n.error||n.message||"Revit code returned success=false.":null}function Zs(e){e.tool("send_code_to_revit","Send C# code to Revit for execution. The code will be inserted into a template with access to the Revit Document and parameters. Your code should be written to work within the Execute method of the template.",{...P(Bt),...L(Bt),code:Bt.string().describe("The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."),parameters:Bt.array(Bt.any()).optional().describe("Optional execution parameters that will be passed to your code"),transactionMode:Bt.enum(["auto","none"]).optional().describe("Transaction handling mode forwarded to the Revit wrapper. In the bundled plugin build, snippets should not open their own Transaction unless that exact build has been verified."),timeoutMs:Bt.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),reportErrorResultAsFailure:Bt.boolean().optional().describe("When true, ERROR: string results or { success:false } objects are reported as failed tool calls. Defaults true. This cannot roll back a write if the snippet swallowed its own exception."),parseJsonResult:Bt.boolean().optional().describe("When true, parse JSON-looking result strings, including double-encoded JSON strings. Defaults true. Set false to inspect the raw wire result.")},async(t,n)=>{let o={code:t.code,parameters:t.parameters||[],transactionMode:t.transactionMode||"auto",taskName:t.taskName||"Run Revit code"};t.taskId&&(o.taskId=t.taskId),t.parentTaskName&&(o.parentTaskName=t.parentTaskName),t.parentTaskId&&(o.parentTaskId=t.parentTaskId),o.logicalToolName="send_code_to_revit";let r=Pe(t),a=Date.now(),i=Bn({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",taskName:o.taskName,taskId:o.taskId,parentTaskName:o.parentTaskName,parentTaskId:o.parentTaskId,params:o,startedAtMs:a}),s=qm(t.code);if(s){let l=Math.max(0,Date.now()-a),c=Et({action:"dynamic_snippet_preflight",reason:s.reason,error:s.message});return Ft({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:o,options:r,response:c,startedAtMs:a}),yt(i,{response:c,durationMs:l}),{content:[{type:"text",text:`Code execution guarded: ${s.message}`}]}}try{let l=await ht(async g=>await g.sendCommand("send_code_to_revit",o,r),r),c=t.parseJsonResult===!1?l:jt(l,{parseResultStrings:!0}),u=Math.max(0,Date.now()-a);Ft({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:o,options:r,response:c,startedAtMs:a}),yt(i,{response:c,durationMs:u}),_r(r);let m=t.parseJsonResult===!1||t.reportErrorResultAsFailure===!1?null:zm(c);return m?{content:[{type:"text",text:`Code execution failed: ${m}`}]}:{content:[{type:"text",text:`Code execution successful!
Result: ${JSON.stringify(c,null,2)}`}]}}catch(l){let c=Math.max(0,Date.now()-a);return Ft({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:o,options:r,error:l,startedAtMs:a}),yt(i,{error:l,durationMs:c}),_r(r),{content:[{type:"text",text:`Code execution failed: ${l instanceof Error?l.message:String(l)}`}]}}})}import{z as tt}from"zod";function qa(e,t,n){return b(Et({action:"send_code_to_revit_safe_preflight",error:e,reason:n,extra:{safetyReason:n,writePatterns:t}}))}function el(e){e.tool("send_code_to_revit_safe","Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.",{...P(tt),...L(tt),code:tt.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),parameters:tt.array(tt.union([tt.string(),tt.number(),tt.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),transactionMode:tt.enum(["auto","none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),intent:tt.enum(["read","writePreview","writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),timeoutMs:tt.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),maxReturnedChars:tt.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),parseJsonResult:tt.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true.")},async t=>{let n=t.intent||"read",o=So(t.code);if(n==="writeCommit")return qa("send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",o,"safe_wrapper_write_commit_not_supported");if(t.transactionMode==="auto")return qa("send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",o,"safe_wrapper_requires_transactionMode_none");if(o.length>0)return qa(`Rejected write-looking code for intent '${n}'.`,o,"safe_wrapper_rejected_write_looking_code");try{let a=await Ce(t.code,{...Pe(t),...et(t,"Run safe Revit read"),parameters:t.parameters||[],transactionMode:"none",parseJsonResult:t.parseJsonResult!==!1}),i=Qs({action:"send_code_to_revit_safe",extra:{intent:n,response:a}}),s=JSON.stringify(i,null,2),l=Ks(s,t.maxReturnedChars);return l.truncated?{content:[{type:"text",text:l.text}]}:b(i)}catch(r){return b(ct({action:"send_code_to_revit_safe",error:r instanceof Error?r.message:String(r)}))}})}import{z as zn}from"zod";function Um(e){return e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e}function Wm(e){let t=String(e.detailLevel||"minimal").toLowerCase(),n=e.includeCategoryCounts===!0||t==="counts"||t==="full"?"true":"false",o=e.includeLinks!==!1?"true":"false",r=e.includeLinks===!0&&t==="full"||t==="full"?"true":"false";return`
bool includeCounts = ${n};
bool includeLinkSummary = ${o};
bool includeLinkDetails = ${r};
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
}`}function tl(e){e.tool("get_revit_session_context","Read-only Revit session summary. Defaults to detailLevel=minimal so large-model document checks do not perform heavy MEP category or linked room/space counts. Use detailLevel=counts/full only when those expensive counts are explicitly needed.",{...P(zn),...L(zn),detailLevel:zn.enum(["minimal","counts","full"]).optional().describe("Context detail level. minimal is default and avoids category counts and linked room/space scans; counts adds host MEP category counts; full also scans linked room/space counts."),includeCategoryCounts:zn.boolean().optional().describe("Compatibility flag. true includes known MEP category counts; default false unless detailLevel is counts/full."),includeLinks:zn.boolean().optional().describe("Include cheap Revit link instance summary. Defaults true; linked room/space counts require detailLevel=full."),includeSelection:zn.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true.")},async t=>{let n=Pe(t);try{let o=await Ce(Wm(t),{...n,...et(t,"Read Revit session context"),transactionMode:"none"}),r=Um(o);if(t.includeSelection!==!1&&r&&typeof r=="object"){let a=await qn(100,{...n,taskName:t.taskName?`${t.taskName}: selection`:"Read Revit selection",taskId:t.taskId});r.selection={count:a.length,elementIds:a}}return b(r)}catch(o){return b({success:!1,error:o instanceof Error?o.message:String(o)})}})}import{z as Qt}from"zod";function $m(e){let t=e.includeSheetViewports!==!1?"true":"false",n=e.includeSheetScheduleInstances!==!1?"true":"false",o=e.includeModelElements===!0?"true":"false",r=Number.isFinite(e.limit)?Math.max(1,Math.min(500,e.limit)):100,a=St(e.modelCategoryList||[]);return`
bool includeSheetViewports = ${t};
bool includeSheetScheduleInstances = ${n};
bool includeModelElements = ${o};
int limit = ${r};
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
}`}function nl(e){e.tool("get_active_view_context","Read-only active view context. Handles model views and DrawingSheet views; sheets return placed viewport/view data plus scheduleSheetInstances instead of pretending MEP model elements are directly visible.",{...P(Qt),...L(Qt),includeSheetViewports:Qt.boolean().optional().describe("When active view is a sheet, include placed viewports. Defaults true."),includeSheetScheduleInstances:Qt.boolean().optional().describe("When active view is a sheet, include placed ScheduleSheetInstance entries with schedule ids, names, point, and box data. Defaults true."),includeModelElements:Qt.boolean().optional().describe("When active view is a model view, collect limited model elements from modelCategoryList. Defaults false."),modelCategoryList:Qt.array(Qt.string()).optional().describe("BuiltInCategory names such as OST_DuctCurves or OST_DuctTerminal."),limit:Qt.number().int().positive().max(500).optional().describe("Maximum model elements to return. Defaults 100.")},async t=>{try{let n=await Ce($m(t),{...z(t,"Read active Revit view context"),transactionMode:"none"});return b(n&&n.result?n.result:n)}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ol}from"zod";var Hm=["dryRun","DryRun","deleted","Deleted","confirmDelete","ConfirmDelete","targetIsReviewView","TargetIsReviewView","reviewSignals","ReviewSignals","deletedElementCount","DeletedElementCount"],Gm=["closed","Closed"];function Un(e,t={}){if(!e||typeof e!="object"||Array.isArray(e))return e;let n={...e};for(let o of Hm)delete n[o];if(t.stripCloseOnlyFields)for(let o of Gm)delete n[o];return n}function rl(e){e.tool("list_open_views","List Revit UI view tabs currently open in the active document.",{...P(ol),...L(ol)},async t=>{try{let n=await U("list_open_views",{},{...z(t,"List open Revit views")});return b(Un(n&&n.result?n.result:n))}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as bn}from"zod";function al(e){e.tool("activate_view","Activate an existing Revit view tab by id or unique name without opening a transaction. Supports plans, 3D views, sheets, schedules, legends, drafting views, sections, and elevations.",{...P(bn),...L(bn),viewId:bn.number().int().positive().optional().describe("ElementId of the Revit view to activate."),viewName:bn.string().optional().describe("Name of the Revit view to activate. Must match one view unless viewType is also supplied."),viewType:bn.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:bn.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:bn.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation verification. Defaults 15000.")},async t=>{try{let n=await U("activate_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...z(t,"Activate Revit view")});return b(Un(n&&n.result?n.result:n,{stripCloseOnlyFields:!0}))}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as _n}from"zod";function il(e){e.tool("close_view","Close an open Revit UI view tab by id or unique name without opening a transaction. If the target is active, another open view is activated first.",{...P(_n),...L(_n),viewId:_n.number().int().positive().optional().describe("ElementId of the Revit view to close."),viewName:_n.string().optional().describe("Name of the Revit view to close. Must match one view unless viewType is also supplied."),viewType:_n.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:_n.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:_n.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI close verification. Defaults 15000.")},async t=>{try{let n=await U("close_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...z(t,"Close Revit view")});return b(Un(n&&n.result?n.result:n))}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as za}from"zod";function sl(e){e.tool("clear_selection","[LIVE_UI_SELECTION_CLEANUP] Clear the current Revit UI selection. This does not open a transaction and does not modify model elements or view data. Use after focus/testing workflows when the operator wants Revit left with no selected elements.",{...P(za),...L(za),timeoutMs:za.number().int().positive().max(3e4).optional().describe("Timeout for the selection clear command. Defaults 10000.")},async t=>{try{let n=await U("clear_selection",{timeoutMs:t.timeoutMs},{...z(t,"Clear Revit selection")});return b(n&&n.result?n.result:n)}catch(n){return b({success:!1,action:"clear_selection",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as Nt}from"zod";function Jm(e){return!e||typeof e!="object"?null:{id:h(e,"Id","id")??h(e,"ViewId","viewId")??null,name:h(e,"Name","name")??h(e,"ViewName","viewName")??null,type:h(e,"Type","type")??h(e,"ViewType","viewType")??null}}function Km(e,t={}){let n=t.responseMode||"compact";if(!e||typeof e!="object"||n==="full")return{...e,responseMode:n};let o=Jm(h(e,"TargetView","targetView")),r={mode:h(e,"Mode","mode")??t.mode??"dryRun",dryRun:h(e,"DryRun","dryRun")??null,changed:h(e,"Changed","changed")??null,deleted:h(e,"Deleted","deleted")??null,deletedElementCount:h(e,"DeletedElementCount","deletedElementCount")??null,confirmed:(h(e,"ConfirmDelete","confirmDelete")??t.confirmDelete)===!0,targetIsReviewView:h(e,"TargetIsReviewView","targetIsReviewView")??null,reviewSignals:h(e,"ReviewSignals","reviewSignals")??[]};return{success:h(e,"Success","success"),guarded:h(e,"Guarded","guarded"),state:h(e,"State","state"),action:h(e,"Action","action")||"delete_review_view",responseMode:"compact",reason:h(e,"Reason","reason"),error:h(e,"Error","error"),message:h(e,"Message","message"),targetView:o,cleanup:r,suggestedNextScopes:h(e,"SuggestedNextScopes","suggestedNextScopes")??[],notices:[...Array.isArray(h(e,"Notices","notices"))?h(e,"Notices","notices"):[],'Compact response groups cleanup-specific fields under cleanup. Use responseMode="full" for raw delete_review_view diagnostics.']}}function ll(e){e.tool("delete_review_view",'[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode="commit" and confirmDelete=true.',{...P(Nt),...L(Nt),viewId:Nt.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),viewName:Nt.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),viewType:Nt.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),exactName:Nt.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),mode:Nt.enum(["dryRun","commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),confirmDelete:Nt.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),responseMode:Nt.enum(["compact","full"]).optional().describe("Response shape. compact is the default and groups cleanup-specific fields under cleanup; full returns the raw native cleanup contract."),timeoutMs:Nt.number().int().positive().max(12e4).optional().describe("Timeout for review view cleanup. Defaults 15000.")},async t=>{try{let n=await U("delete_review_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,mode:t.mode,confirmDelete:t.confirmDelete,timeoutMs:t.timeoutMs},{...z(t,"Delete Revit review view")});return b(Km(n&&n.result?n.result:n,t))}catch(n){return b({success:!1,action:"delete_review_view",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as vr}from"zod";function cl(e){e.tool("get_ui_state","Read the current Revit UI state: active view, open views, selected element ids/summaries, and document modifiable/read-only status.",{...P(vr),...L(vr),selectionLimit:vr.number().int().min(0).max(1e3).optional().describe("Maximum selected elements to summarize. Defaults 100."),timeoutMs:vr.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=await U("get_ui_state",{selectionLimit:t.selectionLimit},{...z(t,"Read Revit UI state")});return b(n&&n.result?n.result:n)}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as B}from"zod";var Xm="fast",Ym={fast:{name:"fast",maxElementsScanned:5e3,maxElapsedMs:4500,socketTimeoutMs:12e3},balanced:{name:"balanced",maxElementsScanned:25e3,maxElapsedMs:18e3,socketTimeoutMs:3e4},deep:{name:"deep",maxElementsScanned:15e4,maxElapsedMs:9e4,socketTimeoutMs:12e4}},Qm=[{concept:"fan_coil",terms:["fan coil","fancoil","fcu"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"air_handling_unit",terms:["ahu","air handling unit","klima santrali"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"pump",terms:["pump","pompa"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"valve",terms:["valve","vana"],categories:["Pipe Accessories","Pipe Fittings"],preserveQueryWhenFullyStripped:!0},{concept:"damper",terms:["damper"],categories:["Duct Accessories","Mechanical Equipment"]},{concept:"air_terminal",terms:["diffuser","grille","air terminal","difuzor","menfez"],categories:["Air Terminals"]},{concept:"duct",terms:["duct","kanal"],categories:["Ducts","Duct Fittings","Duct Accessories"]},{concept:"pipe",terms:["pipe","boru"],categories:["Pipes","Pipe Fittings","Pipe Accessories"]},{concept:"sprinkler",terms:["sprinkler"],categories:["Sprinklers"]},{concept:"plumbing_fixture",terms:["plumbing fixture","sanitary fixture","sihhi tesisat armat\xFCr","armat\xFCr"],categories:["Plumbing Fixtures"]}],Zm=/^[\p{L}\p{N}_\- ]{1,24}$/u;function ul(e){return String(e||"").normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase().replace(/\s+/g," ").trim()}function ep(e){return e.normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase()}function dl(e){let t=[],n=[];for(let o=0;o<e.length;){let r=e.codePointAt(o);if(r===void 0)break;let a=String.fromCodePoint(r),i=o+a.length,s=ep(a);for(let l of s)t.push(l),n.push([o,i]);o=i}return{text:t.join(""),sourceRanges:n}}function Wa(e){let t=new Set,n=[];for(let o of e){let r=String(o||"").trim();if(!r)continue;let a=r.toLowerCase();t.has(a)||(t.add(a),n.push(r))}return n}function tp(e){let t=String(e||"").toLowerCase();return t==="balanced"||t==="deep"||t==="fast"?t:Xm}function Ua(e,t,n,o){let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function np(e,t){let n=dl(e),o=new Array(e.length).fill(!1);for(let a of t.sort((i,s)=>s.length-i.length)){let i=dl(a).text;if(!i)continue;let s=i.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+"),l=new RegExp(`(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`,"gu"),c;for(;(c=l.exec(n.text))!==null;)for(let u=c.index;u<l.lastIndex;u++){let m=n.sourceRanges[u];if(m)for(let g=m[0];g<m[1];g++)o[g]=!0}}let r="";for(let a=0;a<e.length;a++)r+=o[a]?" ":e[a];return r.replace(/\s+/g," ").trim()}function op(e){let t=ul(e),n=[],o=[],r=[],a=!1;for(let s of Qm){let l=s.terms.filter(c=>t.includes(ul(c)));l.length!==0&&(n.push({concept:s.concept,terms:l,categories:s.categories,preserveQueryWhenFullyStripped:s.preserveQueryWhenFullyStripped===!0}),o.push(...l),r.push(...s.categories),a=a||s.preserveQueryWhenFullyStripped===!0)}let i=np(e,o);return{matchedConcepts:n,matchedTerms:o,categories:Wa(r),effectiveQuery:i||(a?e.trim():"")}}function rp(e={}){let t=["levelNames","activeViewOnly","familyName","typeName","systemName"];return!e.sheetQuery&&!Array.isArray(e.sheetIds)&&t.push("sheetQuery"),!e.nameQuery&&!Array.isArray(e.scheduleIds)&&t.push("scheduleIds/nameQuery"),t.push("allowExpensiveSearch","searchBudget=deep"),t}function wr(e,t){for(let n of e)if(!(!n||typeof n!="object"))for(let o of t){let r=n[o],a=Number.parseInt(String(r??""),10);if(Number.isFinite(a))return a}return null}function ap(e,t){let n=[];return t.length>0&&n.push(`categoryNames=${t.join("|")}`),Array.isArray(e.levelNames)&&e.levelNames.length>0&&n.push("levelNames"),(e.activeViewOnly===!0||e.viewId)&&n.push("activeViewOnly/viewId"),e.familyName&&n.push("familyName"),e.typeName&&n.push("typeName"),e.systemName&&n.push("systemName"),n.length>0?n:["categoryNames","levelNames","activeViewOnly","familyName/typeName","systemName"]}function ip(e={},t=[]){return!!(t.length>0||e.activeViewOnly===!0||e.viewId||Array.isArray(e.levelIds)&&e.levelIds.length>0||Array.isArray(e.levelNames)&&e.levelNames.length>0||e.familyName||e.typeName||e.systemName||Array.isArray(e.worksetIds)&&e.worksetIds.length>0||Array.isArray(e.worksetNames)&&e.worksetNames.length>0||Array.isArray(e.elementIds)&&e.elementIds.length>0||Array.isArray(e.uniqueIds)&&e.uniqueIds.length>0)}function Zt(e){return Array.isArray(e)&&e.some(t=>String(t??"").trim())}function sp(e,t,n,o){return t!=="hostOnly"&&Zt(e.uniqueIds)&&!Zt(e.elementIds)&&!n&&o.length===0&&e.activeViewOnly!==!0&&!e.viewId&&!Zt(e.levelIds)&&!Zt(e.levelNames)&&!e.familyName&&!e.typeName&&!e.systemName&&!Zt(e.worksetIds)&&!Zt(e.worksetNames)}function lp(e){let t=String(e||"").trim();return!!(t&&Zm.test(t))}function cp(e,t){let n=[],o=0,r=[e.largeModelRisk,e.modelRisk,e.modelSignals,e.sessionSummary].filter(Boolean),a=wr(r,["linkCount","linkInstances","loadedLinks","loadedLinkCount"]),i=wr(r,["worksetCount","worksets"]),s=wr(r,["sheetCount","sheets"]),l=wr(r,["scheduleCount","schedules"]);a!==null&&a>=25?(o+=2,n.push("high_link_count")):a!==null&&a>=10&&(o+=1,n.push("moderate_link_count")),i!==null&&i>=40?(o+=2,n.push("high_workset_count")):i!==null&&i>=20&&(o+=1,n.push("moderate_workset_count")),s!==null&&s>=1e3&&(o+=1,n.push("large_sheet_set")),l!==null&&l>=500&&(o+=1,n.push("large_schedule_set")),!t.boundedScope&&lp(t.originalQuery)&&(o+=3,n.push("generic_unscoped_query")),!t.boundedScope&&!t.originalQuery&&(o+=3,n.push("missing_search_scope")),t.broadLinkedSearch&&(o+=2,n.push("linked_search_without_expensive_approval")),t.verifiedBroadSearch&&(o+=2,n.push("verified_plan_candidates_without_bounded_scope")),t.verifiedVisibilityExpensive&&(o+=2,n.push("verified_visibility_expensive")),(t.searchBudget==="deep"||t.allowExpensiveSearch)&&n.push("operator_approved_expensive_search"),t.boundedScope&&n.length===0&&n.push("bounded_first_pass_scope");let c=o>=4?"high":o>=2?"medium":o>=1||t.boundedScope?"low":"unknown",u=!t.allowExpensiveSearch&&(t.broadLinkedSearch||t.verifiedBroadSearch||t.verifiedVisibilityExpensive||!t.boundedScope&&o>=2);return{riskLevel:c,reasons:n,recommendedFirstScope:ap(e,t.effectiveCategoryNames),requiresUserControl:u}}function ml(e={}){let t=String(e.query||"").trim(),n=Wa(Array.isArray(e.categoryNames)?e.categoryNames:[]),o=op(t),r=n.length>0,a=r?n:Wa(o.categories),i=o.effectiveQuery||(a.length>n.length?"":t),s=tp(e.searchBudget),l=Ym[s],c=e.timeoutMs?Ua(e.timeoutMs,l.socketTimeoutMs,1e3,12e4):l.socketTimeoutMs,u=Math.max(c,Math.min(12e4,l.maxElapsedMs+2500)),m=Ua(e.maxElementsScanned,l.maxElementsScanned,1,5e5),g=Math.min(l.maxElapsedMs,Math.max(1e3,u-2500)),p=Ua(e.maxElapsedMs,g,500,Math.max(500,u-1e3)),y=ip(e,a),f=String(e.linkScope||"hostOnly"),w=e.allowExpensiveSearch===!0||s==="deep",T=sp(e,f,t,a),I=f!=="hostOnly"&&!w&&!T,_=String(e.planCandidateMode||(e.includePlanCandidates===!0?"verified":"none")).toLowerCase(),A=e.includePlanCandidates===!0&&_==="verified",R=Zt(e.elementIds)||Zt(e.uniqueIds),E=A&&!y,S=A&&!R,k=cp(e,{originalQuery:t,boundedScope:y,effectiveCategoryNames:a,linkScope:f,allowExpensiveSearch:w,broadLinkedSearch:I,verifiedBroadSearch:E,verifiedVisibilityExpensive:S,searchBudget:s}),q=k.requiresUserControl,X=[];return o.matchedConcepts.length>0&&n.length===0&&X.push("search_scope_inferred_from_mep_terms"),o.matchedConcepts.length>0&&r&&o.categories.some(re=>!a.includes(re))&&X.push("explicit_category_scope_preserved_no_inferred_expansion"),I&&X.push("linked_model_search_requires_allowExpensiveSearch"),E&&X.push("verified_plan_candidates_require_bounded_scope"),S&&X.push("verified_visibility_requires_exact_targets_or_approval"),k.requiresUserControl&&X.push("search_requires_user_scope_control"),{originalQuery:t,effectiveQuery:i,inferredScope:{source:"runtime_search_policy",concepts:o.matchedConcepts,strippedTerms:o.matchedTerms,categoryNames:o.categories,residualQuery:i},effectiveCategoryNames:a,riskPolicy:k,linkScope:f,searchBudget:s,maxElementsScanned:m,maxElapsedMs:p,timeoutMs:u,allowExpensiveSearch:w,guarded:q,reason:q?"needs_scope":void 0,message:q?"This search would scan a broad model surface. Narrow by category, level, active view, system, family/type, sheet/schedule, or explicitly allow an expensive search.":void 0,warnings:X,suggestedNextScopes:rp(e)}}function pl(e){return{success:!0,guarded:!0,state:"guarded",action:"find_elements",reason:"needs_scope",message:e.message,originalQuery:e.originalQuery,query:e.effectiveQuery,inferredScope:e.inferredScope,effectiveScope:{categoryNames:e.effectiveCategoryNames,searchBudget:e.searchBudget,linkScope:e.linkScope},riskPolicy:e.riskPolicy,scanPolicy:{searchBudget:e.searchBudget,maxElementsScanned:e.maxElementsScanned,maxElapsedMs:e.maxElapsedMs,timeoutMs:e.timeoutMs,allowExpensiveSearch:e.allowExpensiveSearch},suggestedNextScopes:e.suggestedNextScopes,warnings:e.warnings}}import{z as up}from"zod";var en=up.enum(["compact","full","debug"]).optional().default("compact").describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");function tn(e){return e==="full"||e==="debug"}function bt(e,t,n){let o=Number.parseInt(String(e??""),10);return!Number.isFinite(o)||o<=0?t:Math.max(1,Math.min(n,o))}function nt(e,t){let n=Array.isArray(e)?e.filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)):[],o=new Set,r=[],a=t.key||Mo;for(let s of n){let l=a(s);o.has(l)||(o.add(l),r.push(s))}let i=r.slice(0,Math.max(0,t.limit));return{rows:i,totalCount:n.length,uniqueCount:r.length,returnedCount:i.length,duplicateCount:n.length-r.length,omittedCount:Math.max(0,r.length-i.length)}}function Mo(e){return $a(e)}function $a(e){if(e==null)return String(e);if(Array.isArray(e))return`[${e.map($a).join(",")}]`;if(typeof e=="object"){let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${$a(t[n])}`).join(",")}}`}return JSON.stringify(e)}var dp=25,mp=25;function gl(e,t,n){let o=e[t];if(Array.isArray(o)){o.includes(n)||o.push(n);return}if(typeof o=="string"&&o.trim()){e[t]=o===n?[o]:[o,n];return}e[t]=[n]}function hl(e){if(!e||typeof e!="object"||h(e,"Success","success")===!1)return e;let n=Array.isArray(e.elements)?e.elements:Array.isArray(e.Elements)?e.Elements:null,o=e.count??e.Count,r=o==null||o===""?Number.NaN:Number(o),a=Number.isFinite(r)?r:n?.length??0,i=!!(e.truncated??e.Truncated),s=!!(e.ambiguous??e.Ambiguous),l=String(e.topConfidence??e.TopConfidence??""),c=!!(l&&l.toLowerCase()!=="high"),u=s||i||a!==1||c,m=u?"broad_or_ambiguous_discovery_result":"discovery_tool_result_not_parameter_write_evidence",g="find_elements is discovery-only. Never commit parameter writes from find_elements rows alone; broad, ambiguous, truncated, or non-high-confidence results are especially unsafe. Before writing, narrow to one exact elementId or uniqueId, verify it with inspect_elements, run inspect_parameter_schema for the target parameter, then run set_element_parameter in dryRun before commit. Do not write from a visible/display parameter name alone.",p="find_elements result is broad or ambiguous for write purposes; do not use it as parameter-write evidence. Narrow to one exact element and run inspect_parameter_schema before set_element_parameter.";return e.writeSafetyWarning=g,e.writeSafety={sufficientForWrite:!1,discoveryEvidenceOnly:!0,writeBlockedUntil:"exact_element_and_parameter_schema_preflight",requiresExactElementIdentity:!0,requiresParameterSchemaPreflight:!0,requiredPreflightTools:["inspect_elements","inspect_parameter_schema","set_element_parameter"],requiredBeforeParameterWrite:["narrow_to_exact_element_id_or_unique_id","inspect_elements_exact_target","inspect_parameter_schema_exact_target_parameter","set_element_parameter_dry_run_with_expected_current_value","commit_only_after_dry_run_verification"],parameterWritePolicy:"Never commit set_element_parameter from find_elements rows alone. Use find_elements only to discover candidates, then prove exact element and parameter identity before a dry-run or commit.",parameterIdentityRule:"Use builtInParameterId when available; otherwise confirm source/shared/storage/readOnly identity. Display name alone is not a write target.",resultRisk:{count:a,truncated:i,ambiguous:s,topConfidence:l,broadOrAmbiguous:u,confidenceRisk:c,unsafeForParameterWriteReason:m}},gl(e,"warnings",u?p:g),gl(e,"notices","find_elements_discovery_only_parameter_write_preflight_required"),typeof e.SelectionHint=="string"&&!e.SelectionHint.includes("find_elements is discovery-only")&&(e.SelectionHint=`${e.SelectionHint} ${g}`),typeof e.selectionHint=="string"&&!e.selectionHint.includes("find_elements is discovery-only")&&(e.selectionHint=`${e.selectionHint} ${g}`),e}function pp(e){let t=e.id??e.Id??e.uniqueId??e.UniqueId??e.elementId??e.ElementId;return t!=null&&t!==""?String(t):Mo(e)}function gp(e){return Array.isArray(e.planCandidates)?"planCandidates":Array.isArray(e.PlanCandidates)?"PlanCandidates":null}function ut(e,...t){for(let n of t)if(e[n]!==void 0&&e[n]!==null&&e[n]!=="")return e[n]}function hp(e){return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0))}function fp(e){let t=ut(e,"id","Id","viewId","ViewId","elementId","ElementId");if(t!==void 0)return String(t);let n=ut(e,"name","Name","viewName","ViewName"),o=ut(e,"levelId","LevelId","levelName","LevelName");return n!==void 0||o!==void 0?`${String(n??"")}|${String(o??"")}`:Mo(e)}function yp(e,t){return hp({ref:t,id:ut(e,"id","Id","viewId","ViewId","elementId","ElementId"),name:ut(e,"name","Name","viewName","ViewName"),viewType:ut(e,"viewType","ViewType"),levelId:ut(e,"levelId","LevelId"),levelName:ut(e,"levelName","LevelName"),score:ut(e,"score","Score","rankScore","RankScore"),rank:ut(e,"rank","Rank"),elementVisibleInView:ut(e,"elementVisibleInView","ElementVisibleInView"),reason:ut(e,"reason","Reason","matchReason","MatchReason")})}function Sp(e,t){return{ref:t}}function bp(e,t,n){let o=gp(e);if(!o)return{element:e,totalCandidateRows:0,omittedCandidateRows:0};let r=e[o].filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)),a=[];for(let s of r){let l=fp(s);n.has(l)||n.set(l,yp(s,l)),a.length<t&&a.push(Sp(s,l))}let i={...e};return delete i.planCandidates,delete i.PlanCandidates,i.planCandidateRefs=a,i.planCandidateCount=r.length,i.returnedPlanCandidateRefCount=a.length,i.omittedPlanCandidateRefCount=Math.max(0,r.length-a.length),{element:i,totalCandidateRows:r.length,omittedCandidateRows:Math.max(0,r.length-a.length)}}function _p(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||tn(n))return{...e,responseMode:n};let o=Array.isArray(e.elements)?"elements":Array.isArray(e.Elements)?"Elements":null;if(!o)return{...e,responseMode:"compact"};let r=bt(t.maxResultRows??t.limit,dp,200),a=bt(t.maxPlanCandidates,3,25),i=bt(t.maxPlanCandidateSummaryRows,Math.max(mp,a),100),s=nt(e[o],{limit:r,key:pp}),l=new Map,c=0,u=0,m=s.rows.map(p=>{let y=bp(p,a,l);return c+=y.totalCandidateRows,u+=y.omittedCandidateRows,y.element}),g=nt(Array.from(l.values()),{limit:i,key:p=>String(p.ref??Mo(p))});return{...e,responseMode:"compact",[o]:m,planCandidateSummary:{compactResponse:!0,candidateRowCount:c,uniqueCandidateCount:l.size,returnedCandidateCount:g.returnedCount,omittedCandidateCount:g.omittedCount,duplicateCandidateRowCount:Math.max(0,c-l.size),omittedElementCandidateRefCount:u,candidates:g.rows},summary:{...e.summary||e.Summary||{},compactResponse:!0,elementRowCount:s.totalCount,returnedElementRowCount:s.returnedCount,omittedElementRowCount:s.omittedCount,duplicateElementRowCount:s.duplicateCount,planCandidateRowCount:c,uniquePlanCandidateCount:l.size,returnedPlanCandidateCount:g.returnedCount,omittedPlanCandidateCount:g.omittedCount},notices:[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds element rows and deduplicates plan candidates into planCandidateSummary. Use responseMode="full" for per-element plan candidate details.']}}function fl(e){e.tool("find_elements","Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters plus safe in-memory level filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep before broad, linked, or verified visibility scans. Default responseMode=compact bounds element rows and deduplicates plan candidates into planCandidateSummary; use responseMode=full for per-element plan candidate details. Discovery-only: never use broad or ambiguous find_elements rows as write evidence; before writes, narrow to one exact element, inspect it, inspect the parameter schema, then use set_element_parameter dryRun before commit.",{...P(B),...L(B),query:B.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),categoryNames:B.array(B.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals. If omitted, common MEP terms such as fan coil/FCU, valve, damper, duct, pipe, sprinkler, pump, and AHU are inferred into a bounded category scope."),elementIds:B.array(B.union([B.number(),B.string()])).optional().describe("Exact element ids to inspect first when known."),uniqueIds:B.array(B.string()).optional().describe("Exact Revit unique ids to inspect first when known."),levelNames:B.array(B.string()).optional().describe("Restrict results to matching element level names, e.g. Level 08."),levelIds:B.array(B.union([B.number(),B.string()])).optional().describe("Restrict results to exact Revit level element ids."),activeViewOnly:B.boolean().optional().describe("Search only elements visible/owned in the active view when true. Preferred for large models when the user is already looking at the target area."),viewId:B.union([B.number(),B.string()]).optional().describe("Search only elements visible/owned in this view id."),familyName:B.string().optional().describe("Optional family-name filter applied before text scoring."),typeName:B.string().optional().describe("Optional type-name filter applied before text scoring."),systemName:B.string().optional().describe("Optional MEP system-name filter applied before text scoring when available."),worksetNames:B.array(B.string()).optional().describe("Optional workset-name filters for workshared production models."),worksetIds:B.array(B.union([B.number(),B.string()])).optional().describe("Optional exact workset ids for workshared production models."),linkScope:B.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Host model is searched by default. Linked model search is explicit and may require allowExpensiveSearch/searchBudget=deep on broad requests."),modelSignals:B.object({linkCount:B.number().int().nonnegative().optional(),linkInstances:B.number().int().nonnegative().optional(),loadedLinks:B.number().int().nonnegative().optional(),worksetCount:B.number().int().nonnegative().optional(),sheetCount:B.number().int().nonnegative().optional(),scheduleCount:B.number().int().nonnegative().optional()}).optional().describe("Optional cheap large-model signals from prior context. This never triggers new category counts; it only lets the risk policy use already-known link/workset/sheet/schedule counts."),searchBudget:B.enum(["fast","balanced","deep"]).optional().describe("Preset scan/elapsed budget. fast is default for first-pass discovery; balanced/deep intentionally allow larger scans."),allowExpensiveSearch:B.boolean().optional().describe("Explicit operator approval for broad, linked, all-model, or verified searches that may take longer."),maxElementsScanned:B.number().int().positive().max(5e5).optional().describe("Advanced override for the Revit-side scan cap. Prefer searchBudget for ordinary LLM use."),maxElapsedMs:B.number().int().positive().max(119e3).optional().describe("Advanced override for the Revit-side elapsed budget. This is clamped below socket timeout so partial results can return before transport timeout."),includePlanCandidates:B.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),planCandidateMode:B.enum(["none","metadata","verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms visibility in plan views and is allowed only for exact element targets or explicit expensive-search approval."),maxPlanCandidates:B.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),planNameContains:B.string().optional().describe("Optional plan name preference used when ranking plan candidates."),limit:B.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),responseMode:en,maxResultRows:B.number().int().positive().max(200).optional().describe("Compact-mode cap for returned element rows. Defaults to limit or 25; full/debug returns all native rows within limit."),maxPlanCandidateSummaryRows:B.number().int().positive().max(100).optional().describe("Compact-mode cap for the deduplicated top-level planCandidateSummary rows. Defaults 25 so global plan candidates are not capped by the per-element maxPlanCandidates limit."),timeoutMs:B.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{try{let n=ml(t);if(n.guarded)return b(hl(pl(n)));let o=await U("find_elements",{originalQuery:n.originalQuery,query:n.effectiveQuery,categoryNames:n.effectiveCategoryNames,inferredScope:n.inferredScope,elementIds:t.elementIds,uniqueIds:t.uniqueIds,levelNames:t.levelNames,levelIds:t.levelIds,activeViewOnly:t.activeViewOnly===!0,viewId:t.viewId,familyName:t.familyName,typeName:t.typeName,systemName:t.systemName,worksetNames:t.worksetNames,worksetIds:t.worksetIds,linkScope:n.linkScope,searchBudget:n.searchBudget,allowExpensiveSearch:n.allowExpensiveSearch,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,includePlanCandidates:t.includePlanCandidates===!0,planCandidateMode:t.planCandidateMode||(t.includePlanCandidates===!0?"verified":"none"),maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.limit,timeoutMs:n.timeoutMs},{...z({...t,timeoutMs:n.timeoutMs},"Find Revit elements")}),r=o&&o.result?o.result:o;return r&&typeof r=="object"&&(r.inferredScope=r.inferredScope||n.inferredScope,r.effectiveScope=r.effectiveScope||{categoryNames:n.effectiveCategoryNames,linkScope:n.linkScope},r.riskPolicy=r.riskPolicy||n.riskPolicy,r.scanPolicy=r.scanPolicy||{searchBudget:n.searchBudget,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,timeoutMs:n.timeoutMs,allowExpensiveSearch:n.allowExpensiveSearch},r.suggestedNextScopes=r.suggestedNextScopes||n.suggestedNextScopes,r.warnings=[...new Set([...Array.isArray(r.warnings)?r.warnings:[],...n.warnings])]),b(_p(hl(r),t))}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Me}from"zod";var xp=Me.union([Me.number().int().positive(),Me.string().regex(/^\d+$/)]);function Cr(e){return!e||typeof e!="object"?e:{Id:h(e,"Id","id"),Name:h(e,"Name","name"),ViewType:h(e,"ViewType","viewType"),Scale:h(e,"Scale","scale")}}function vp(e){return!e||typeof e!="object"?e:{Id:h(e,"Id","id"),Name:h(e,"Name","name"),Category:h(e,"Category","category"),ClassName:h(e,"ClassName","className"),FamilyName:h(e,"FamilyName","familyName"),TypeName:h(e,"TypeName","typeName"),LevelId:h(e,"LevelId","levelId"),LevelName:h(e,"LevelName","levelName"),Mark:h(e,"Mark","mark"),HasBoundingBox:h(e,"HasBoundingBox","hasBoundingBox")}}function wp(e){return!e||typeof e!="object"?e:{Success:h(e,"Success","success"),Action:h(e,"Action","action"),Message:h(e,"Message","message"),Error:h(e,"Error","error"),ResponseMode:"compact",PlanMode:h(e,"PlanMode","planMode"),PlanCandidateMode:h(e,"PlanCandidateMode","planCandidateMode"),FallbackUsed:h(e,"FallbackUsed","fallbackUsed"),VerifiedCandidateCount:h(e,"VerifiedCandidateCount","verifiedCandidateCount"),RejectedCandidateCount:h(e,"RejectedCandidateCount","rejectedCandidateCount"),PlanOpenMode:h(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:h(e,"PlanOpenNote","planOpenNote"),FocusBlocked:h(e,"FocusBlocked","focusBlocked"),FocusBlockReason:h(e,"FocusBlockReason","focusBlockReason"),FocusSuggestion:h(e,"FocusSuggestion","focusSuggestion"),TargetView:Cr(h(e,"TargetView","targetView")),SelectedPlan:Cr(h(e,"SelectedPlan","selectedPlan")),SuggestedView:Cr(h(e,"SuggestedView","suggestedView")),ActiveView:Cr(h(e,"ActiveView","activeView")),ActiveViewChanged:h(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:h(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),LevelId:h(e,"LevelId","levelId"),LevelName:h(e,"LevelName","levelName"),PlanSelectionReason:h(e,"PlanSelectionReason","planSelectionReason"),Selected:h(e,"Selected","selected"),Zoomed:h(e,"Zoomed","zoomed"),ZoomMethod:h(e,"ZoomMethod","zoomMethod"),FitToScreen:h(e,"FitToScreen","fitToScreen"),FitToScreenWarning:h(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:h(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:h(e,"FocusWarning","focusWarning"),Element:vp(h(e,"ElementInfo","elementInfo")),PlanCandidatesTotal:h(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:h(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function yl(e){e.tool("open_existing_plan_for_element_level","Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.",{...P(Me),...L(Me),elementId:xp.describe("ElementId to locate in an existing plan view."),planMode:Me.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing plan on the element level. activePlan keeps the current active plan and does not switch to the element level. Defaults elementLevel."),planCandidateMode:Me.enum(["metadataFirst","verified"]).optional().describe("Plan selection strategy for elementLevel mode. metadataFirst is the default and ranks same-level plans without scanning every candidate view, then verifies a small number of ranked candidates. verified scans all candidate views before selecting and is slower."),fallbackToVerified:Me.boolean().optional().describe("When metadataFirst cannot find a visible element within the limited ranked-candidate check, run the slower verified scan before failing. Defaults true."),maxMetadataVerifyCandidates:Me.number().int().min(1).max(25).optional().describe("Maximum ranked metadata candidates verified before fallback. Defaults 5."),planNameContains:Me.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:Me.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:Me.boolean().optional().describe("Select the element after activating the plan. Defaults true."),zoom:Me.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),fitToScreen:Me.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),verboseCandidates:Me.boolean().optional().describe("Return full PlanCandidates arrays. Defaults false; routine responses return only the top candidates."),maxPlanCandidates:Me.number().int().min(0).max(50).optional().describe("Maximum PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:Me.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns the raw tool result."),timeoutMs:Me.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000.")},async t=>{try{let n=await U("open_existing_plan_for_element_level",{elementId:t.elementId,planMode:t.planMode,planCandidateMode:t.planCandidateMode,fallbackToVerified:t.fallbackToVerified,maxMetadataVerifyCandidates:t.maxMetadataVerifyCandidates,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs},{...z(t,"Open existing plan for element level")}),o=n&&n.result?n.result:n,r=Sn(o,{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"?b(r):b(wp(r))}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as je}from"zod";var Cp=je.union([je.number().int().positive(),je.string().regex(/^\d+$/)]);function Sl(e){e.tool("focus_elements","Select and zoom to Revit elements in the active view or in a requested view tab. This is a UI operation and does not open a Revit transaction.",{...P(je),...L(je),elementIds:je.array(Cp).min(1).describe("ElementId values to select and show."),viewId:je.number().int().positive().optional().describe("Optional ElementId of the Revit view to activate before focusing elements."),viewName:je.string().optional().describe("Optional name of the Revit view to activate before focusing elements."),viewType:je.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, Section, Elevation, DrawingSheet, or Schedule."),exactName:je.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),select:je.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:je.boolean().optional().describe("Zoom/show the supplied elements in the active UI view. Defaults true."),fitToScreen:je.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active view. Defaults false."),allowClosedViewSearch:je.boolean().optional().describe("Allow Revit ShowElements to open its modal closed-view search when elements are not visible in the target view. Defaults false to avoid blocking automation."),allowPartial:je.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:je.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation/focus verification. Defaults 5000; pass a larger value for slow view activation.")},async t=>{try{let n=await U("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:t.allowClosedViewSearch,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...z(t,"Focus Revit elements")});return b(n&&n.result?n.result:n)}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as $e}from"zod";var Ip=$e.union([$e.number().int().positive(),$e.string().regex(/^\d+$/)]);function bl(e){e.tool("section_box_elements","Apply a 3D section box around Revit elements, optionally select them, and zoom to them. Requires a 3D view; if viewId/viewName is supplied, that view is activated first.",{...P($e),...L($e),elementIds:$e.array(Ip).min(1).describe("ElementId values to include in the section box."),viewId:$e.number().int().positive().optional().describe("Optional ElementId of the 3D Revit view to activate and modify."),viewName:$e.string().optional().describe("Optional name of the 3D Revit view to activate and modify."),viewType:$e.string().optional().describe("Optional Revit ViewType filter. For this tool the resolved view must be ThreeD."),exactName:$e.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),paddingMm:$e.number().min(0).max(1e5).optional().describe("Extra space around the element bounding box in millimeters. Defaults 500."),select:$e.boolean().optional().describe("Select the supplied elements after applying the section box. Defaults true."),zoom:$e.boolean().optional().describe("Zoom/show the supplied elements after applying the section box. Defaults true."),allowPartial:$e.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:$e.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous 3D view activation and section box application. Defaults 15000.")},async t=>{try{let n=await U("section_box_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,paddingMm:t.paddingMm,select:t.select,zoom:t.zoom,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...z(t,"Section box Revit elements")});return b(n&&n.result?n.result:n)}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Te}from"zod";var Rp=Te.union([Te.number().int().positive(),Te.string().regex(/^\d+$/)]);function _l(e){e.tool("create_3d_view_for_elements","[LIVE_VIEW_NAVIGATION_PRIMITIVE] Create or reuse a 3D Revit view for elements, optionally apply or clear a section box, activate the view, and focus/select the elements. Use this when the user wants to see, open, zoom to, or inspect elements live inside Revit. This can modify the document because views and section boxes are project data.",{...P(Te),...L(Te),elementIds:Te.array(Rp).min(1).describe("ElementId values to show in the 3D view."),viewName:Te.string().optional().describe("Desired 3D view name. If omitted, a name is generated from the first element id."),reuseExisting:Te.boolean().optional().describe("Reuse an existing non-template 3D view with the same name when viewName is supplied. Defaults true."),createIfMissing:Te.boolean().optional().describe("Create the 3D view when no reusable view is found. Defaults true."),sectionBox:Te.boolean().optional().describe("When true, apply a section box around the elements. When false, any active section box on the target view is cleared. Defaults false."),paddingMm:Te.number().min(0).max(1e5).optional().describe("Extra section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:Te.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction to apply using the aggregate element bounding box. Defaults unchanged."),framingPaddingMm:Te.number().min(0).max(1e5).optional().describe("Extra padding in millimeters for camera orientation/framing when cameraOrientation is not unchanged. Defaults to paddingMm or 500."),activate:Te.boolean().optional().describe("Activate the target 3D view. Defaults true."),select:Te.boolean().optional().describe("Select the supplied elements after activation. Defaults true."),zoom:Te.boolean().optional().describe("Zoom/show the supplied elements after activation. Defaults true."),fitToScreen:Te.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active 3D view. Defaults false."),allowPartial:Te.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:Te.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous view creation/activation/focus. Defaults 20000.")},async t=>{try{let n=await U("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName,reuseExisting:t.reuseExisting,createIfMissing:t.createIfMissing,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:t.activate,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...z(t,"Create 3D view for elements")});return b(n&&n.result?n.result:n)}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import Tp from"node:os";import xl from"node:path";import{z as ce}from"zod";var Ep=ce.enum(["raw_evidence","coordination_overlay","system_focus","clash_clearance"]),Np=ce.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Mp=ce.enum(["72","150","300","600"]),Ap=ce.enum(["horizontal","vertical"]),kp=ce.enum(["auto","qa_high_contrast","technical_report","outline_only","raw"]),Op={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Pp={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Lp={horizontal:"Horizontal",vertical:"Vertical"};function Vp(){return xl.join(Tp.tmpdir(),"revAgent-image-export")}function Dp(e){return(e&&e.trim()?e.trim():`revit-coordination-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function Fp(e){let t=e||[],n=[],o=[];for(let r of t){if(typeof r=="number"){Number.isSafeInteger(r)&&r>0?n.push(r):o.push(r);continue}let a=String(r).trim();if(/^\d+$/.test(a)){let i=Number(a);if(Number.isSafeInteger(i)&&i>0){n.push(i);continue}}o.push(r)}return{ids:n,invalid:o,suppliedCount:t.length}}function jp(e){return`new List<int> { ${e.map(n=>Math.trunc(n)).join(", ")} }`}function Bp(e){return e==="raw_evidence"?"raw":e==="coordination_overlay"?"outline_only":"technical_report"}function vl(e){e.tool("export_revit_coordination_image","[VISUAL_ARTIFACT_EXPORT_ONLY] Create or reuse a visual QA 3D view, optionally section-box target elements, apply a selectable target visual style, and export an image artifact. Auto style is report-friendly and never selects qa_high_contrast by itself. Use qa_high_contrast explicitly for debug/LLM evidence, technical_report or outline_only for report-style evidence, and raw when the target must keep native appearance. Use this when the user asks for PNG/JPEG/report/LLM visual evidence. If elementIds are provided but none are found, it returns guarded no_requested_elements_found unless allowFullViewFallback=true is explicit. Do not use this as the primary tool for live view navigation, selected-element zoom, or opening an element in a Revit view; for that workflow use create_3d_view_for_elements or show_element_in_plan_and_3d, then optionally export the active view with export_revit_view_image. It only writes review view settings; it does not create or modify MEP model elements. Set cleanupAfterExport=true when a newly created review view should be deleted after the image file is produced.",{...P(ce),intent:Ep.optional().default("coordination_overlay"),targetVisualStyle:kp.optional().default("auto").describe("Target override style. auto is report-friendly: raw_evidence -> raw, coordination_overlay -> outline_only, system_focus/clash_clearance -> technical_report. qa_high_contrast is used only when explicitly requested. raw applies no target override."),elementIds:ce.array(ce.union([ce.number(),ce.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),viewName:ce.string().optional().default("DPE Visual QA - Coordination Export"),marginMm:ce.number().min(0).max(2e4).optional().default(2e3),singleElementMarginMm:ce.number().min(0).max(2e4).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),contextTransparency:ce.number().int().min(0).max(90).optional().default(65),pixelSize:ce.number().int().min(200).max(1e4).optional().default(4e3).describe("Final image size for the requested fit direction after crop/downsample. For coordination crops, Revit may export a higher-resolution source first."),preExportPixelSize:ce.number().int().min(0).max(2e4).optional().default(0).describe("Optional Revit source export size before crop/downsample. Use 0 or omit for automatic high-resolution source export on single-target model-projection crops."),maxAutoPreExportPixelSize:ce.number().int().min(1e3).max(2e4).optional().default(1e4).describe("Upper bound for automatic high-resolution source exports used before single-target model-projection crops."),allowFinalUpscale:ce.boolean().optional().default(!1).describe("When false, model-projection crops are widened instead of enlarging a tiny source crop to the final pixelSize. This preserves image quality even when targetMinFillRatio cannot be reached within Revit's source export limit."),enforcePixelSize:ce.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the final requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),cropToTargetHighlight:ce.boolean().optional().default(!0).describe("When true, tightens the Revit 3D view crop box from model bbox/camera projection. Raster highlight pixels are QA metrics only unless Revit model crop-box framing is unavailable."),targetMinFillRatio:ce.number().min(.1).max(.9).optional().default(.4).describe("Minimum target occupancy used when sizing model-bounding-box projection crops. Raster highlight fill, when detected, is reported separately as QA."),highlightCropPaddingPx:ce.number().int().min(0).max(2e3).optional().default(24).describe("Debug fallback padding for highlight-pixel crops when model projection is not available."),allowFullViewFallback:ce.boolean().optional().default(!1).describe("When elementIds are provided but none are found, allow exporting the full review 3D view instead of returning guarded. Defaults false to avoid misleading element evidence."),dpi:Mp.optional().default("300"),fitDirection:Ap.optional().default("horizontal"),format:Np.optional().default("png"),outputDir:ce.string().optional(),filePrefix:ce.string().optional(),cleanupAfterExport:ce.boolean().optional().default(!1).describe("When true, a review view created by this call is deleted after export. Existing reused review views are never deleted automatically."),...L(ce),timeoutMs:ce.number().int().positive().optional()},async t=>{let n=Fp(t.elementIds);if(n.invalid.length>0)return b(Et({action:"export_revit_coordination_image",reason:"invalid_element_ids",error:"elementIds must be positive integer Revit ElementId values. UniqueId strings or other non-numeric ids are not valid target evidence ids.",extra:{revitWriteAction:"none",requestedElementCount:n.suppliedCount,validElementCount:n.ids.length,invalidElementIds:n.invalid}}));let o=xl.resolve(t.outputDir||Vp()),r=Dp(t.filePrefix),a=t.intent||"coordination_overlay",i=t.targetVisualStyle||"auto",s=i==="auto"?Bp(a):i,l=Op[t.format||"png"],c=Pp[String(t.dpi||"150")],u=Lp[t.fitDirection||"horizontal"],m=Math.trunc(t.pixelSize||4e3),g=Number.isFinite(Number(t.preExportPixelSize))?Math.max(0,Math.trunc(Number(t.preExportPixelSize))):0,p=Number.isFinite(Number(t.maxAutoPreExportPixelSize))?Math.max(1e3,Math.min(2e4,Math.trunc(Number(t.maxAutoPreExportPixelSize)))):1e4,y=t.allowFinalUpscale===!0,f=Number.isFinite(Number(t.marginMm))?Number(t.marginMm):2e3,w=Number.isFinite(Number(t.singleElementMarginMm))?Number(t.singleElementMarginMm):300,T=t.enforcePixelSize!==!1,I=t.cropToTargetHighlight!==!1,_=Number.isFinite(Number(t.targetMinFillRatio))?Math.max(.1,Math.min(.9,Number(t.targetMinFillRatio))):.4,A=Number.isFinite(Number(t.highlightCropPaddingPx))?Math.trunc(t.highlightCropPaddingPx):24,R=t.allowFullViewFallback===!0,E=Math.trunc(t.contextTransparency??65),S=t.cleanupAfterExport===!0,k=`
var warnings = new List<string>();
var notices = new List<string>();
string outputDir = ${G(o)};
string filePrefix = ${G(r)};
string desiredViewName = ${G(t.viewName||"DPE Visual QA - Coordination Export")};
string intent = ${G(a)};
string targetVisualStyle = ${G(s)};
var requestedElementIds = ${jp(n.ids)};
double marginFeet = ${f} / 304.8;
double singleElementMarginFeet = ${w} / 304.8;
int contextTransparency = ${E};
int requestedPixelSize = ${m};
int requestedPreExportPixelSize = ${g};
int maxAutoPreExportPixelSize = ${p};
int revitExportPixelSize = requestedPixelSize;
bool autoPreExportPixelSize = requestedPreExportPixelSize <= 0;
string preExportPixelSizeReason = "same_as_final_pixel_size";
string requestedFitDirection = ${G(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${T?"true":"false"};
bool cropToTargetHighlight = ${I?"true":"false"};
bool allowFinalUpscale = ${y?"true":"false"};
double targetMinFillRatio = ${_};
int highlightCropPaddingPx = ${A};
bool allowFullViewFallback = ${R?"true":"false"};
bool cleanupAfterExport = ${S?"true":"false"};

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
options.FitDirection = FitDirectionType.${u};
options.ImageResolution = ImageResolution.${c};
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

double effectiveMarginMm = targetElements.Count == 1 ? Math.Min(${f}, ${w}) : ${f};
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
  format = ${G(t.format||"png")},
  pixelSize = ${m},
  requestedPixelSize = ${m},
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
  marginMm = ${f},
  singleElementMarginMm = ${w},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${G(String(t.dpi||"300"))},
  fitDirection = ${G(t.fitDirection||"horizontal")},
  files = files,
  warnings = warnings,
  notices = notices
};`;try{let q=await Ce(k,{...z(t,"Export Revit coordination image"),taskType:"export_revit_coordination_image",transactionMode:"auto"});return b(q?.result??q)}catch(q){return b(ct({action:"export_revit_coordination_image",error:q instanceof Error?q.message:String(q),extra:{tool:"export_revit_coordination_image"}}))}})}import qp from"node:os";import wl from"node:path";import{z as Ae}from"zod";var zp=Ae.enum(["current_view","visible_region","set_of_views"]),Up=Ae.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Wp=Ae.enum(["72","150","300","600"]),$p=Ae.enum(["horizontal","vertical"]),Hp={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Gp={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Jp={horizontal:"Horizontal",vertical:"Vertical"};function Kp(){return wl.join(qp.tmpdir(),"revAgent-image-export")}function Xp(e){return(e&&e.trim()?e.trim():`revit-view-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function Yp(e){if(e==null||e==="")return"null";let t=Number(e);return Number.isFinite(t)?String(Math.trunc(t)):"null"}function Cl(e){e.tool("export_revit_view_image","[VISUAL_ARTIFACT_EXPORT] Export the active Revit view, DrawingSheet, Schedule view, or a selected view/sheet to PNG/JPEG/TIFF/BMP/TARGA using Document.ExportImage. Use this when the user asks for a raw image file, report/evidence screenshot, schedule/sheet export, or LLM visual artifact from an existing view. Ordinary view/sheet exports do not modify Revit. Direct schedule export creates a temporary sheet, exports it, and deletes that sheet before the wrapper transaction commits.",{...P(Ae),viewId:Ae.union([Ae.number(),Ae.string()]).optional().describe("Optional Revit view id. When supplied, export uses set_of_views because Revit cannot export a non-active visible region."),viewName:Ae.string().optional().describe("Optional exact or partial view name. When supplied, export uses set_of_views unless range is explicitly current/visible."),exactName:Ae.boolean().optional().default(!0),range:zp.optional().describe("current_view and visible_region use the active UI view. set_of_views can export viewId/viewName without switching the UI."),format:Up.optional().default("png"),pixelSize:Ae.number().int().min(200).max(1e4).optional().default(6e3),enforcePixelSize:Ae.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),zoom:Ae.number().int().min(1).max(1e3).optional().default(100),dpi:Wp.optional().default("300"),fitDirection:$p.optional().default("horizontal"),outputDir:Ae.string().optional(),filePrefix:Ae.string().optional(),allowTemporaryScheduleSheet:Ae.boolean().optional().default(!0).describe("When true, standalone Schedule views are exported through a temporary sheet that is deleted before the wrapper transaction commits. When false, schedule views return guidance with containing sheet candidates."),...L(Ae),timeoutMs:Ae.number().int().positive().optional()},async t=>{let n=t.viewId!==void 0||!!t.viewName,o=t.range??(n?"set_of_views":"current_view"),r=wl.resolve(t.outputDir||Kp()),a=Xp(t.filePrefix),i=Hp[t.format||"png"],s=Gp[String(t.dpi||"150")],l=Jp[t.fitDirection||"horizontal"],c=Math.trunc(t.pixelSize||6e3),u=t.enforcePixelSize!==!1,m=Math.trunc(t.zoom||100),g=t.allowTemporaryScheduleSheet!==!1,p=`
var warnings = new List<string>();
var notices = new List<string>();
string requestedRange = ${G(o)};
string outputDir = ${G(r)};
string filePrefix = ${G(a)};
string viewNameInput = ${G(t.viewName||"")};
int? viewIdInput = ${Yp(t.viewId)};
bool exactName = ${t.exactName===!1?"false":"true"};
bool selectorProvided = viewIdInput.HasValue || !String.IsNullOrWhiteSpace(viewNameInput);
int requestedPixelSize = ${c};
string requestedFitDirection = ${G(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${u?"true":"false"};
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
options.PixelSize = ${c};
options.Zoom = ${m};
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
  format = ${G(t.format||"png")},
  pixelSize = ${c},
  requestedPixelSize = ${c},
  enforcePixelSize = enforcePixelSize,
  pixelSizeNote = enforcePixelSize
    ? "PNG/JPEG/BMP/TIFF output is post-processed so the requested fit-direction dimension equals requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the Revit export request. Check files[].width and files[].height for actual output dimensions.",
  dpi = ${G(String(t.dpi||"300"))},
  fitDirection = ${G(t.fitDirection||"horizontal")},
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
};`;try{let y=await Ce(p,{...z(t,"Export Revit view image"),taskType:"export_revit_view_image",transactionMode:g?"auto":"none"});return b(y?.result??y)}catch(y){return b(ct({action:"export_revit_view_image",error:y instanceof Error?y.message:String(y),extra:{tool:"export_revit_view_image"}}))}})}import{z as ue}from"zod";var Qp=ue.union([ue.number().int().positive(),ue.string().regex(/^\d+$/)]);function Ha(e){return e&&e.result?e.result:e}function Ga(e){return!e||typeof e!="object"?!1:h(e,"Success","success")!==!1}function Zp(e){return!e||typeof e!="object"?!1:h(e,"Guarded","guarded")===!0||h(e,"State","state")==="guarded"||h(e,"FocusBlocked","focusBlocked")===!0}function eg(e,t){return`3D - Focus ${t&&(t.FamilyName||t.TypeName||t.Name)?String(t.FamilyName||t.TypeName||t.Name):"Element"} ${e}`.replace(/[{}[\];<>?`~]/g,"").slice(0,90)}function tg(e){return!e||typeof e!="object"?e:{Id:h(e,"Id","id"),Name:h(e,"Name","name"),Category:h(e,"Category","category"),FamilyName:h(e,"FamilyName","familyName"),TypeName:h(e,"TypeName","typeName"),LevelId:h(e,"LevelId","levelId"),LevelName:h(e,"LevelName","levelName"),Mark:h(e,"Mark","mark"),MatchScore:h(e,"MatchScore","matchScore"),MatchConfidence:h(e,"MatchConfidence","matchConfidence")}}function Ao(e){return!e||typeof e!="object"?e:{Id:e.Id??e.id,Name:e.Name??e.name,ViewType:e.ViewType??e.viewType,Scale:e.Scale??e.scale}}function ng(e){return!e||typeof e!="object"?e:{Success:h(e,"Success","success"),Count:h(e,"Count","count"),Truncated:h(e,"Truncated","truncated"),Ambiguous:h(e,"Ambiguous","ambiguous"),TopScore:h(e,"TopScore","topScore"),TopConfidence:h(e,"TopConfidence","topConfidence"),TopScoreTiedCount:h(e,"TopScoreTiedCount","topScoreTiedCount"),PlanCandidateMode:h(e,"PlanCandidateMode","planCandidateMode"),SelectionHint:h(e,"SelectionHint","selectionHint")}}function og(e){return!e||typeof e!="object"?e:{Success:h(e,"Success","success"),Message:h(e,"Message","message"),Error:h(e,"Error","error"),PlanMode:h(e,"PlanMode","planMode"),PlanOpenMode:h(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:h(e,"PlanOpenNote","planOpenNote"),SelectedPlan:Ao(h(e,"SelectedPlan","selectedPlan")),TargetView:Ao(h(e,"TargetView","targetView")),ActiveView:Ao(h(e,"ActiveView","activeView")),ActiveViewChanged:h(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:h(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),PlanSelectionReason:h(e,"PlanSelectionReason","planSelectionReason"),ZoomMethod:h(e,"ZoomMethod","zoomMethod"),Selected:h(e,"Selected","selected"),Zoomed:h(e,"Zoomed","zoomed"),FitToScreen:h(e,"FitToScreen","fitToScreen"),FitToScreenWarning:h(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:h(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:h(e,"FocusWarning","focusWarning"),PlanCandidatesTotal:h(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:h(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function rg(e){return!e||typeof e!="object"?e:{Success:h(e,"Success","success"),Message:h(e,"Message","message"),Error:h(e,"Error","error"),TargetView:Ao(h(e,"TargetView","targetView")),ActiveView:Ao(h(e,"ActiveView","activeView")),CreatedView:h(e,"CreatedView","createdView"),ReusedView:h(e,"ReusedView","reusedView"),SectionBoxApplied:h(e,"SectionBoxApplied","sectionBoxApplied"),SectionBoxState:h(e,"SectionBoxState","sectionBoxState"),CameraOrientation:h(e,"CameraOrientation","cameraOrientation"),CameraApplied:h(e,"CameraApplied","cameraApplied"),CameraWarning:h(e,"CameraWarning","cameraWarning"),ZoomMethod:h(e,"ZoomMethod","zoomMethod"),Selected:h(e,"Selected","selected"),Zoomed:h(e,"Zoomed","zoomed")}}function ag(...e){for(let t of e){let n=h(t,"ResultContractVersion","resultContractVersion"),o=Number.parseInt(String(n??""),10);if(Number.isFinite(o))return o}return null}function qt(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"show_element_in_plan_and_3d",message:e.message,error:e.error,resultContractVersion:ag(e.find,e.plan,e.threeD),chosenElementId:e.chosenElementId,chosenElement:e.chosenElement,find:e.find,plan:e.plan,threeD:e.threeD,ambiguous:e.ambiguous,candidates:e.candidates}}function Il(e){e.tool("show_element_in_plan_and_3d","[LIVE_VIEW_WORKFLOW_WRAPPER] Safely find or use one Revit element, show it in an existing plan, then optionally call create_3d_view_for_elements to create/reuse a focused 3D view. Use this when the user wants a combined plan plus 3D live Revit view workflow. Ambiguous search results are rejected by default for large-project safety.",{...P(ue),...L(ue),elementId:Qp.optional().describe("Known ElementId. When supplied, search is skipped."),query:ue.string().optional().describe("Text query used when elementId is not supplied."),categoryNames:ue.array(ue.string()).optional().describe("Category name filters for the search, e.g. Mechanical Equipment."),searchLimit:ue.number().int().positive().max(200).optional().describe("Maximum search candidates to inspect. Defaults 20."),allowAmbiguous:ue.boolean().optional().describe("Allow the top search result to be used even when multiple plausible matches exist. Defaults false."),planMode:ue.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing same-level plan. activePlan keeps the current active plan. Defaults elementLevel."),planNameContains:ue.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:ue.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),includeSearchPlanCandidates:ue.boolean().optional().describe("Include plan candidates during the initial search. Defaults false; the plan-open step computes focused candidates separately."),verboseCandidates:ue.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:ue.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:ue.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),select:ue.boolean().optional().describe("Select the element in plan/3D. Defaults true."),zoom:ue.boolean().optional().describe("Show/zoom the element in plan/3D. Defaults true."),fitToScreen:ue.boolean().optional().describe("Run Revit UI ZoomToFit after focusing views. Defaults false."),create3d:ue.boolean().optional().describe("Create or reuse a focused 3D view after the plan step. Defaults true."),viewName:ue.string().optional().describe("Desired 3D view name. If omitted, one is generated from the selected element."),reuseExisting3d:ue.boolean().optional().describe("Reuse an existing 3D view with the same name. Defaults true."),sectionBox:ue.boolean().optional().describe("Apply a 3D section box around the element. Defaults false."),paddingMm:ue.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:ue.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction. Defaults unchanged."),framingPaddingMm:ue.number().min(0).max(1e5).optional().describe("Padding in millimeters for camera orientation/framing. Defaults to paddingMm or 500."),timeoutMs:ue.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=z(t,"Show element in plan and 3D"),o=t.elementId,r=null,a=null;if(!o){if(!t.query&&(!t.categoryNames||t.categoryNames.length===0))return b(qt({success:!1,guarded:!0,error:"Pass elementId, or pass query/categoryNames for a safe search."}));if(a=Ha(await U("find_elements",{query:t.query,categoryNames:t.categoryNames,includePlanCandidates:t.includeSearchPlanCandidates===!0,maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.searchLimit||20,timeoutMs:t.timeoutMs,taskName:"Find element for plan and 3D presentation"},n)),!a||!Ga(a))return b(qt({success:!1,error:h(a,"Error","error")||"Element search failed.",find:a}));let u=Array.isArray(h(a,"Elements","elements"))?h(a,"Elements","elements"):[];if(u.length===0)return b(qt({success:!1,guarded:!0,error:"No matching elements were found.",find:a}));if(h(a,"Ambiguous","ambiguous")&&t.allowAmbiguous!==!0)return b(qt({success:!1,guarded:!0,error:"Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",ambiguous:!0,find:a,candidates:u}));if(r=u[0]||null,!r)return b(qt({success:!1,guarded:!0,error:"No usable element candidate was returned.",find:a}));o=h(r,"Id","id")}if(o==null)return b(qt({success:!1,guarded:!0,error:"No element id was resolved.",find:a}));let i=Ha(await U("open_existing_plan_for_element_level",{elementId:o,planMode:t.planMode,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3,responseMode:"full",timeoutMs:t.timeoutMs,taskName:"Show element in existing plan"},n));if(!i||!Ga(i))return b(qt({success:!1,guarded:Zp(i),error:h(i,"Error","error")||"Plan presentation failed.",chosenElementId:o,chosenElement:r,find:a,plan:i}));let s=null;t.create3d!==!1&&(s=Ha(await U("create_3d_view_for_elements",{elementIds:[o],viewName:t.viewName||eg(o,r),reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Show element in focused 3D view"},n)));let l=t.create3d===!1||Ga(s),c=Sn(qt({success:l,message:t.create3d===!1?"Element was shown in an existing plan.":l?"Element was shown in an existing plan and focused in 3D.":"Element was shown in plan, but the 3D step failed.",chosenElementId:o,chosenElement:r,find:a,plan:i,threeD:s}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"||!l?b(c):b({success:h(c,"Success","success"),guarded:h(c,"Guarded","guarded")===!0,state:h(c,"State","state"),action:h(c,"Action","action"),message:h(c,"Message","message"),error:h(c,"Error","error"),resultContractVersion:h(c,"ResultContractVersion","resultContractVersion"),responseMode:"compact",chosenElementId:o,chosenElement:tg(r),findSummary:ng(a),planSummary:og(i),threeDSummary:rg(s)})}catch(n){return b(qt({success:!1,error:n instanceof Error?n.message:String(n)}))}})}import{z as de}from"zod";var ig=de.union([de.number().int().positive(),de.string().regex(/^\d+$/)]);function Ir(e){return e&&e.result?e.result:e}function Rr(e){return!e||typeof e!="object"?!1:h(e,"Success","success")!==!1}function Rl(e){return!e||typeof e!="object"?!1:h(e,"Guarded","guarded")===!0||h(e,"State","state")==="guarded"||h(e,"FocusBlocked","focusBlocked")===!0}function Tr(e){return!e||typeof e!="object"?e||null:{id:e.Id??e.id,name:e.Name??e.name,viewType:e.ViewType??e.viewType,isActive:e.IsActive??e.isActive,isOpen:e.IsOpen??e.isOpen,isSectionBoxActive:e.IsSectionBoxActive??e.isSectionBoxActive}}function Ja(e){if(!e||typeof e!="object")return e||null;let t=e.PlanCandidates??e.planCandidates;return{success:h(e,"Success","success"),message:h(e,"Message","message"),error:h(e,"Error","error"),focusBlocked:e.FocusBlocked??e.focusBlocked,focusBlockReason:e.FocusBlockReason??e.focusBlockReason,focusSuggestion:e.FocusSuggestion??e.focusSuggestion,changed:e.Changed??e.changed,selected:e.Selected??e.selected,zoomed:e.Zoomed??e.zoomed,activeViewChanged:e.ActiveViewChanged??e.activeViewChanged,planOpenMode:e.PlanOpenMode??e.planOpenMode,levelName:e.LevelName??e.levelName,activeView:Tr(e.ActiveView??e.activeView),targetView:Tr(e.TargetView??e.targetView),selectedPlan:Tr(e.SelectedPlan??e.selectedPlan),suggestedView:Tr(e.SuggestedView??e.suggestedView),planCandidatesTotal:Array.isArray(t)?t.length:e.PlanCandidatesTotal??e.planCandidatesTotal,planCandidatesTruncated:e.PlanCandidatesTruncated??e.planCandidatesTruncated,createdView:e.CreatedView??e.createdView,reusedView:e.ReusedView??e.reusedView,sectionBoxApplied:e.SectionBoxApplied??e.sectionBoxApplied,cameraOrientation:e.CameraOrientation??e.cameraOrientation,cameraApplied:e.CameraApplied??e.cameraApplied}}function Tl(e){return{success:h(e,"Success","success"),guarded:h(e,"Guarded","guarded")===!0,state:h(e,"State","state"),action:h(e,"Action","action"),message:h(e,"Message","message"),error:h(e,"Error","error"),resultContractVersion:h(e,"ResultContractVersion","resultContractVersion"),responseMode:"compact",mode:e.mode??e.Mode,usedStep:e.usedStep??e.UsedStep,focusSummary:Ja(e.focus??e.Focus),planSummary:Ja(e.plan??e.Plan),threeDSummary:Ja(e.threeD??e.ThreeD)}}function sg(...e){for(let t of e){let n=h(t,"ResultContractVersion","resultContractVersion"),o=Number.parseInt(String(n??""),10);if(Number.isFinite(o))return o}return null}function ko(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"smart_focus_elements",message:e.message,error:e.error,resultContractVersion:sg(e.focus,e.plan,e.threeD),mode:e.mode,usedStep:e.usedStep,focus:e.focus,plan:e.plan,threeD:e.threeD}}function El(e){e.tool("smart_focus_elements","[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. When create3d=true, the 3D step runs after whichever live focus step succeeds. Use this for live Revit focus/navigation, not image artifact export.",{...P(de),...L(de),elementIds:de.array(ig).min(1).describe("ElementId values to select and show."),mode:de.enum(["activeOnly","activeThenElementLevelPlan","elementLevelPlan"]).optional().describe("activeOnly only tries the active/requested view. activeThenElementLevelPlan falls back to an existing same-level plan. elementLevelPlan skips the active view and opens the same-level plan. Defaults activeThenElementLevelPlan."),viewId:de.number().int().positive().optional().describe("Optional target view id for the first focus attempt."),viewName:de.string().optional().describe("Optional target view name for the first focus attempt."),viewType:de.string().optional().describe("Optional Revit ViewType filter for the first focus attempt."),exactName:de.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),planNameContains:de.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level for same-level fallback."),preferMechanical:de.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:de.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:de.boolean().optional().describe("Zoom/show the supplied elements. Defaults true."),fitToScreen:de.boolean().optional().describe("Run Revit UI ZoomToFit after focus. Defaults false."),create3d:de.boolean().optional().describe("After the successful active/requested-view or plan focus step, create/reuse a focused 3D view for all supplied elements. Defaults false."),viewName3d:de.string().optional().describe("Desired 3D view name when create3d=true."),reuseExisting3d:de.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),sectionBox:de.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),cameraOrientation:de.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),framingPaddingMm:de.number().min(0).max(1e5).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),paddingMm:de.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),allowPartial:de.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),verboseCandidates:de.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:de.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:de.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),timeoutMs:de.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=z(t,"Smart focus Revit elements"),o=t.mode||"activeThenElementLevelPlan",r=null,a=null,i=null;if(o!=="elementLevelPlan"){if(r=Ir(await U("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:!1,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Try focus elements in active/requested view"},n)),r&&Rr(r)){t.create3d===!0&&(i=Ir(await U("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view after active/requested focus"},n)));let u=t.create3d===!0?!!(i&&Rr(i)):!0,m=Sn(ko({success:u,message:t.create3d===!0?u?"Elements were focused in the active/requested view and focused in 3D.":"Elements were focused in the active/requested view, but the 3D step failed.":"Elements were focused in the active/requested view.",mode:o,usedStep:t.create3d===!0?"activeOrRequestedViewThen3D":"activeOrRequestedView",focus:r,threeD:i}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return b(t.responseMode==="full"||!u?m:Tl(m))}let c=Rl(r);if(o==="activeOnly"||!r||!c)return b(ko({success:!1,guarded:c,mode:o,error:h(r,"Error","error")||"Active/requested view focus failed.",focus:r}))}if(a=Ir(await U("open_existing_plan_for_element_level",{elementId:t.elementIds[0],planMode:"elementLevel",planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Smart focus fallback to same-level existing plan"},n)),!a||!Rr(a))return b(ko({success:!1,guarded:Rl(a),mode:o,error:h(a,"Error","error")||"Same-level existing plan focus failed.",focus:r,plan:a}));t.create3d===!0&&(i=Ir(await U("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view"},n)));let s=t.create3d===!0?!!(i&&Rr(i)):!0,l=Sn(ko({success:s,message:t.create3d===!0?s?"Elements were focused in a same-level plan and focused in 3D.":"Elements were focused in a same-level plan, but the 3D step failed.":"Elements were focused in a same-level plan.",mode:o,usedStep:t.create3d===!0?"elementLevelPlanThen3D":"elementLevelPlan",focus:r,plan:a,threeD:i}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return b(t.responseMode==="full"||!s?l:Tl(l))}catch(n){return b(ko({success:!1,mode:t.mode||"unknown",error:n instanceof Error?n.message:String(n)}))}})}import{z as ot}from"zod";async function lg(e,t){let o=(Array.isArray(e.elementIds)?e.elementIds:[]).map(r=>Number.parseInt(String(r),10)).filter(r=>Number.isFinite(r)&&r>0);return e.useSelection&&(o=o.concat(await qn(e.limit||20,t))),[...new Set(o)].slice(0,e.limit||20)}function cg(e,t){let n=xr(e),o=t.includeParameters!==!1?"true":"false",r=t.includeTypeParameters===!0?"true":"false",a=t.includeConnectors!==!1?"true":"false",i=St(t.parameterNames||[]);return`
int[] elementIds = ${n};
bool includeParameters = ${o};
bool includeTypeParameters = ${r};
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
}`}function Nl(e){e.tool("inspect_elements","Read-only inspection for selected or targeted Revit elements: class/category/type/level/key parameters/connector summary.",{...P(ot),...L(ot),elementIds:ot.array(ot.union([ot.number(),ot.string()])).optional().describe("Element ids to inspect."),useSelection:ot.boolean().optional().describe("When true, inspect the current Revit selection."),limit:ot.number().int().positive().max(100).optional().describe("Maximum elements to inspect. Defaults 20."),includeParameters:ot.boolean().optional().describe("Include key or requested parameter summaries. Defaults true."),includeTypeParameters:ot.boolean().optional().describe("Also inspect matching type parameters. Defaults false."),includeConnectors:ot.boolean().optional().describe("Include connector counts when available. Defaults true. When false, connectorCount/openConnectorCount are null and connectorsIncluded=false."),parameterNames:ot.array(ot.string()).optional().describe("Optional targeted parameter names.")},async t=>{let n=Pe(t);try{let o=await lg(t,n);if(o.length===0)return b({success:!0,elements:[],warnings:["No element ids supplied and no selected elements found."]});let r=await Ce(cg(o,t),{...n,...et(t,"Inspect Revit elements"),transactionMode:"none"});return b(r&&r.result?r.result:r)}catch(o){return b({success:!1,error:o instanceof Error?o.message:String(o)})}})}import{z as at}from"zod";var ug=["completed","max_elapsed","max_rows","max_columns","max_cells","max_items","max_bytes","read_failed","needs_scope"],dg=["lastReadSection","lastReadRow","lastReadColumn","lastReadSheetId","lastReadViewId","lastReadViewportId","lastReadItemId"],mg=new Set(ug),pg={done:"completed",success:"completed",timeout:"max_elapsed",timed_out:"max_elapsed",socket_timeout:"max_elapsed",max_schedules:"max_items",max_sheets:"max_items",max_text_notes:"max_items",max_tags:"max_items",max_viewports:"max_items",max_scanned:"max_items",max_schedule_instances:"max_items",max_schedule_cells:"max_cells",max_cells_scanned:"max_cells",rows_truncated:"max_rows",columns_truncated:"max_columns"};function Oo(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function $n(e){return String(e??"").trim()}function Wn(e){return Array.isArray(e)?e.map(t=>$n(t)).filter(t=>t.length>0):[]}function d(e,t){if(!Oo(e))return;let n=t.charAt(0).toUpperCase()+t.slice(1);if(Object.prototype.hasOwnProperty.call(e,t))return e[t];if(Object.prototype.hasOwnProperty.call(e,n))return e[n];let o=t.toLowerCase(),r=Object.keys(e).find(a=>a.toLowerCase()===o);return r?e[r]:void 0}function F(e,t){let n=d(e,t);return Array.isArray(n)?n.filter(o=>Oo(o)):[]}function Hn(e,t){let n=d(e,t);return Oo(n)?n:null}function Ml(e,t=!1){if(typeof e=="boolean")return e;if(typeof e=="string"){let n=e.trim().toLowerCase();if(n==="true")return!0;if(n==="false")return!1}return t}function Al(e){if(e==null)return null;if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function Po(e,t="completed"){let n=$n(e).toLowerCase();return n?mg.has(n)?n:pg[n]||t:t}function gg(e,t,n,o){return n?"needs_scope":o==="failed"?"read_failed":t?"max_items":"completed"}function Ka(e,t,n){return typeof e=="function"?e(t):e??n}function Le(e,t){let n=Oo(e)?{...e}:{value:e},o=$n(d(n,"state")),r=$n(d(n,"error")),a=Ml(d(n,"guarded"),!1),i=d(n,"success"),s=typeof i=="boolean"?!!i:r.length===0,l=o||(a?"guarded":s?"completed":"failed"),c=t.partial??Ml(d(n,"partial"),!1),u=$n(t.scanStoppedReason??d(n,"scanStoppedReason")),m=gg(n,c,a,l),g=Po(u,m);n.success=s,n.guarded=a,n.state=l,n.action=t.action,n.partial=c,n.scanStoppedReason=g,u&&u!==g&&n.rawScanStoppedReason===void 0&&(n.rawScanStoppedReason=u);let p=Hn(n,"scanPolicy");n.scanPolicy=p||t.scanPolicy||{};let y=Wn(d(n,"suggestedNextScopes"));n.suggestedNextScopes=y.length>0?y:Wn(t.suggestedNextScopes),n.elapsedMs=Al(d(n,"elapsedMs"))??Al(t.elapsedMs),n.warnings=Wn(d(n,"warnings")).concat(Wn(t.warnings)),n.notices=Wn(d(n,"notices")).concat(Wn(t.notices));let f=Ka(t.evidenceRows,n,[]),w=F(n,"evidenceRows");n.evidenceRows=w.length>0?w:Array.isArray(f)?f:[];let T=Ka(t.summary,n,{}),I=Hn(n,"summary");n.summary=I||(Oo(T)?T:{});let _=Ka(t.lastRead,n,{});for(let A of dg){let R=d(n,A);n[A]=R!==void 0?R:_[A]??null}return n}function rt(e){let t=$n(e.reason)||"needs_scope";return Le({...e.extra||{},success:!0,guarded:!0,state:"guarded",action:e.action,reason:t,message:e.message,partial:!1,scanStoppedReason:t},{...e,partial:!1,scanStoppedReason:t,summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}function Xe(e){return Le({...e.extra||{},success:!1,guarded:!1,state:"failed",action:e.action,error:e.error,partial:!1,scanStoppedReason:"read_failed"},{...e,partial:!1,scanStoppedReason:"read_failed",summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}var hg=500,Ol=5e3,fg=3e4;function kl(e,t,n,o){let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function yg(e){return[...new Set((Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t??""),10)).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n)}function Sg(e){return[...new Set((Array.isArray(e)?e:[]).map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0)}function bg(e){let t=String(e??"");return["hostOnly","linkedOnly","hostAndLinked"].includes(t)?t:"hostAndLinked"}function _g(e){return String(e??"")==="exact"?"exact":"contains"}function Pl(e){return{sourceScope:bg(e.sourceScope),linkInstanceIds:yg(e.linkInstanceIds),linkInstanceUniqueIds:Sg(e.linkInstanceUniqueIds),nameQuery:String(e.nameQuery??"").trim(),nameMatchMode:_g(e.nameMatchMode),maxResults:kl(e.maxResults,hg,1,Ol),timeoutMs:kl(e.timeoutMs,fg,2e3,6e4),taskName:e.taskName||"Inspect Revit levels",taskId:e.taskId}}function Ll(e){let t=Pl(e);return{sourceScope:t.sourceScope,linkInstanceSelectorMode:"exact_id_or_unique_id",nameMatchMode:t.nameMatchMode,maxResults:t.maxResults,deterministicSortBasis:["sourceKind(host_before_link)","linkInstanceUniqueId(ordinal)","linkInstanceId","sourceProjectElevationMm","name(ordinal)","levelUniqueId(ordinal)","levelId"],maxResultsAppliedAfterDeterministicSort:!0}}function xg(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function vg(e){return xg(e)?{linkInstanceUniqueId:d(e,"linkInstanceUniqueId")??null,levelId:d(e,"levelId")??null,levelUniqueId:d(e,"levelUniqueId")??null,levelName:d(e,"levelName")??null}:null}function wg(e){return{sourceKind:d(e,"sourceKind")??null,documentKey:d(e,"documentKey")??null,documentSessionId:d(e,"documentSessionId")??null,levelId:d(e,"levelId")??null,levelUniqueId:d(e,"levelUniqueId")??null,name:d(e,"name")??null,sourceProjectElevationMm:d(e,"sourceProjectElevationMm")??null,sourceProjectElevationFrame:d(e,"sourceProjectElevationFrame")??null,hostElevationMm:d(e,"hostElevationMm")??null,hostElevationFrame:d(e,"hostElevationFrame")??null,hostElevationTransformBasis:d(e,"hostElevationTransformBasis")??null,linkInstanceId:d(e,"linkInstanceId")??null,linkInstanceUniqueId:d(e,"linkInstanceUniqueId")??null,linkedSourceLevelSelector:vg(d(e,"linkedSourceLevelSelector"))}}function Vl(e){return F(e,"levels").map(wg)}function Xa(e){let t=Number(d(e,"unavailableSourceCount")??0);return Number.isFinite(t)&&t>0?Math.trunc(t):0}function Ya(e){return Xa(e)>0||d(e,"partial")===!0||d(e,"truncated")===!0}function Dl(e){return Xa(e)>0?"read_failed":d(e,"truncated")===!0?"max_items":String(d(e,"scanStoppedReason")??(Ya(e)?"max_items":"completed"))}function Cg(e){let t=Vl(e);return{sourceScope:d(e,"sourceScope")??null,nameQuery:d(e,"nameQuery")??null,nameMatchMode:d(e,"nameMatchMode")??null,effectiveSourceCount:d(e,"effectiveSourceCount")??null,selectedLinkCount:d(e,"selectedLinkCount")??null,loadedSelectedLinkCount:d(e,"loadedSelectedLinkCount")??null,unavailableSourceCount:Xa(e),scannedLevelCount:d(e,"scannedLevelCount")??null,matchedLevelCount:d(e,"matchedLevelCount")??null,returnedCount:d(e,"returnedCount")??t.length,partial:Ya(e),scanStoppedReason:Dl(e)}}function Ig(e,t,n){let o=Vl(e),r=o.length>0?o[o.length-1]:null,a=Le(e,{action:"inspect_levels",elapsedMs:n,partial:Ya(e),scanStoppedReason:Dl(e),scanPolicy:Ll(t),suggestedNextScopes:["sourceScope","linkInstanceIds","linkInstanceUniqueIds","nameQuery","nameMatchMode","maxResults"],summary:Cg,evidenceRows:o,lastRead:{lastReadItemId:r?.levelId??null}});return a.levels=o,delete a.Levels,a}function Fl(e){e.tool("inspect_levels","[LEVEL_INSPECTION_READ_ONLY] List deterministic host and loaded-linked Revit Level evidence without modifying the model. Use sourceScope plus exact linkInstanceIds/linkInstanceUniqueIds to discover linked source level names and transformed host elevations before capture_spatial_snapshot or other level-scoped reads. Optional nameQuery supports exact or contains matching. sourceProjectElevationMm uses the shared Level.ProjectElevation-compatible resolver. Linked hostElevationMm is based on RevitLinkInstance.GetTransform applied to the source-origin point (0,0,project elevation), and each linked row includes a copy-ready linkedSourceLevelSelector. maxResults is applied only after deterministic sorting and reports partial/max_items when truncated. Missing, unloaded, or unreadable selected links report unavailableSourceCount and partial/read_failed instead of a complete inventory. Prefer this tool over custom C# level/link loops.",{...P(at),...L(at),sourceScope:at.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),linkInstanceIds:at.array(at.union([at.number().int().positive(),at.string()])).max(100).optional().describe("Optional exact RevitLinkInstance element ids. Selectors restrict linked sources and are ignored for hostOnly."),linkInstanceUniqueIds:at.array(at.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance UniqueIds. Selectors restrict linked sources and are ignored for hostOnly."),nameQuery:at.string().optional().describe("Optional Level name filter. Empty returns all levels in the selected sources."),nameMatchMode:at.enum(["exact","contains"]).optional().describe("Level-name matching policy. Defaults contains; matching is ordinal case-insensitive natively."),maxResults:at.number().int().positive().max(Ol).optional().describe("Maximum deterministically sorted Level rows returned. Defaults 500; truncation reports partial/max_items."),timeoutMs:at.number().int().min(2e3).max(6e4).optional().describe("Socket timeout in milliseconds. Defaults 30000.")},async t=>{let n=Date.now(),o=Pl(t);try{let r=await U("inspect_levels",o,{...z(t,"Inspect Revit levels"),toolName:"inspect_levels",timeoutMs:o.timeoutMs});return b(Ig(r&&r.result?r.result:r,t,Date.now()-n))}catch(r){return b(Xe({action:"inspect_levels",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,scanPolicy:Ll(t),suggestedNextScopes:["sourceScope","linkInstanceIds","linkInstanceUniqueIds","nameQuery","nameMatchMode","maxResults"],extra:{sourceScope:o.sourceScope,nameQuery:o.nameQuery,nameMatchMode:o.nameMatchMode,lengthUnit:"mm",hostCoordinateFrame:"host_internal_mm",maxResults:o.maxResults,unavailableSourceCount:0,levels:[]}}))}})}import{z as ee}from"zod";var Rg={fast:{maxElapsedMs:4500,timeoutMs:12e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4},deep:{maxElapsedMs:45e3,timeoutMs:6e4}};function Tg(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Rg[t],o=Number.parseInt(String(e.maxElapsedMs??""),10),r=Number.isFinite(o)?Math.max(1,Math.min(119e3,o)):n.maxElapsedMs,a=Number.parseInt(String(e.timeoutMs??""),10),i=Number.isFinite(a)?Math.max(1e3,Math.min(12e4,a)):Math.max(n.timeoutMs,Math.min(12e4,r+5e3));return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,i-1e3)),timeoutMs:i}}function Eg(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||e.query||"").trim())}function Ng(e,t){return rt({action:"inspect_sheet_text",reason:"needs_scope",message:"Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"],scanPolicy:{searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,allowExpensiveSearch:!1,textQuery:!!String(e.textQuery||"").trim(),includeViewportTextNotes:e.includeViewportTextNotes===!0,includeViewportTags:e.includeViewportTags===!0,scanScheduleCells:e.scanScheduleCells===!0,maxTags:e.maxTags??e.maxTagsScanned,maxViewports:e.maxViewports??e.maxViewportsPerSheet},summary:{sheetQuery:e.sheetQuery??e.query??null,textQuery:e.textQuery??null,returnedCount:0,matchCount:0}})}function Mg(e,t){return{query:e.query,sheetQuery:e.sheetQuery??e.query,textQuery:e.textQuery,sheetIds:e.sheetIds,includeTextNotes:e.includeTextNotes,includeScheduleInstances:e.includeScheduleInstances,scanScheduleCells:e.scanScheduleCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,includeViewportTextNotes:e.includeViewportTextNotes,includeViewportTags:e.includeViewportTags,viewNameQuery:e.viewNameQuery,maxSheets:e.maxSheets,maxTextNotesPerSheet:e.maxTextNotesPerSheet,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxTextChars:e.maxTextChars,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxViewportTextNotesPerView:e.maxViewportTextNotesPerView,maxViewportTagsPerView:e.maxViewportTagsPerView,maxTags:e.maxTags,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit sheet annotations",taskId:e.taskId}}function Qa(e){let t=String(d(e,"kind")||d(e,"sourceType")||"");return t==="scheduleCell"?"placedScheduleCell":t==="scheduleInstance"?"placedScheduleInstance":t||"sheetTextNote"}function Gn(e){return String(d(e,"textQuery")??"").trim().length>0}function Za(e,t=!0){if(!t)return!1;let n=d(e,"matchedTextQuery"),o=d(e,"inventoryOnly");return!(o===!0||String(o).trim().toLowerCase()==="true"||n===!1||String(n).trim().toLowerCase()==="false")}function Er(e){let t=F(e,"evidenceRows"),n=t.length>0?t:F(e,"matches"),o=Gn(e);return n.filter(r=>!!r&&typeof r=="object"&&!Array.isArray(r)).filter(r=>Za(r,o)).map(r=>({...r,sourceType:Qa(r)}))}function jl(e){let t=F(e,"inventoryRows"),n=F(e,"evidenceRows"),o=Gn(e),r=[...n,...F(e,"matches")].filter(i=>!!i&&typeof i=="object"&&!Array.isArray(i)).filter(i=>!Za(i,o)),a=new Set;return[...t,...r].filter(i=>!!i&&typeof i=="object"&&!Array.isArray(i)).map(i=>({...i,sourceType:Qa(i),matchedTextQuery:!1,inventoryOnly:!0})).filter(i=>{let s=[d(i,"sourceType")??"",d(i,"sheetId")??"",d(i,"instanceId")??d(i,"elementId")??d(i,"id")??"",d(i,"scheduleId")??""].join("|");return a.has(s)?!1:(a.add(s),!0)})}function ei(e,t){let n={};for(let[o,r]of Object.entries(e))t.has(o)||(n[o]=r);return n}function Ag(e,t){let n=t&&Za(e,t);return{...ei(e,new Set(["MatchedTextQuery","InventoryOnly","matchedTextQuery","inventoryOnly"])),sourceType:Qa({...e,kind:d(e,"kind")??"scheduleInstance"}),MatchedTextQuery:n,InventoryOnly:!n,matchedTextQuery:n,inventoryOnly:!n}}function kg(e){let t=Gn(e);return F(e,"sheets").map(n=>{let o=ei(n,new Set(["ScheduleInstances"])),r=F(n,"scheduleInstances");return{...o,scheduleInstances:r.map(a=>Ag(a,t))}})}function Og(e){let t=d(e,"scan");return!t||typeof t!="object"||Array.isArray(t)||Gn(e)?t:{...t,TotalTextNoteMatches:0,totalTextNoteMatches:0,TotalViewportTextNoteMatches:0,totalViewportTextNoteMatches:0,TotalViewportTagMatches:0,totalViewportTagMatches:0,TotalScheduleCellMatches:0,totalScheduleCellMatches:0,TotalScheduleInstanceMatches:0,totalScheduleInstanceMatches:0}}function Bl(e){let t=Po(d(e,"scanStoppedReason")),n=String(d(e,"rawScanStoppedReason")??d(e,"scanStoppedReason")??t).trim()||t;return{canonicalReason:t,nativeReason:n,nativeLimitField:{max_sheets:"maxSheets",max_text_notes:"maxTextNotesScanned",max_viewports:"maxViewports",max_scanned:"maxScheduleInstancesScanned",max_schedule_instances:"maxScheduleInstancesScanned",max_schedule_cells:"maxScheduleCellsScanned",max_tags:"maxTagsScanned"}[n]??null}}function Pg(e){let t=Er(e),n=jl(e),o=F(e,"sheets");return{sheetQuery:d(e,"sheetQuery")??null,textQuery:d(e,"textQuery")??null,totalSheets:d(e,"totalSheets")??null,candidateCount:d(e,"candidateCount")??null,returnedCount:d(e,"returnedCount")??(o.length>0?o.length:null),inventoryMode:!Gn(e),matchCount:t.length,inventoryRowCount:n.length,partial:d(e,"partial")===!0,scanStoppedReason:d(e,"scanStoppedReason")??"completed",rawScanStoppedReason:d(e,"rawScanStoppedReason")??null,scanStopDetail:Bl(e),scannedSheetCount:d(e,"scannedSheetCount")??null,scannedViewportCount:d(e,"scannedViewportCount")??null,scannedTextNoteCount:d(e,"scannedTextNoteCount")??null,scannedTagCount:d(e,"scannedTagCount")??null,scannedScheduleInstanceCount:d(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:d(e,"scannedScheduleCellCount")??null}}function Lg(e){let t=F(e,"evidenceRows").length>0?F(e,"evidenceRows"):Er(e),n=t.length>0?t[t.length-1]:null,o=F(e,"sheets"),r=o.length>0?o[o.length-1]:null;return{lastReadSection:n?d(n,"section")??null:null,lastReadRow:n?d(n,"row")??null:null,lastReadColumn:n?d(n,"column")??null:null,lastReadSheetId:n?d(n,"sheetId")??d(r,"id")??null:d(r,"id")??null,lastReadViewId:n?d(n,"viewId")??null:null,lastReadViewportId:n?d(n,"viewportId")??null:null,lastReadItemId:n?d(n,"elementId")??d(n,"tagId")??d(n,"instanceId")??d(n,"id")??null:null}}function Vg(e,t){let n=Le(e,{action:"inspect_sheet_text",elapsedMs:t,summary:Pg,evidenceRows:Er,lastRead:Lg,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}),o=jl(n),r=Gn(n),a=Og(n),i=new Set(["Sheets"]);return r||(i.add("Matches"),i.add("EvidenceRows")),{...ei(n,i),evidenceRows:r?Er(n):[],inventoryRows:o,matches:r?F(n,"matches"):[],scan:a,sheets:kg(n),summary:{...n.summary||{},inventoryRowCount:o.length,scanStopDetail:Bl(n)}}}function ql(e){e.tool("inspect_sheet_text","[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet text and annotation inspection for DrawingSheet text notes, titleblock/title block notes, revision schedule instances, placed schedule cells, viewport-linked text notes, viewport plan annotations, and viewport tags. Prefer this dedicated tool over generic send_code_to_revit for sheet text lookup, drawing note searches, plan note searches, titleblock/revision evidence, placed schedule text evidence, and large-project sheet or viewport annotation searches. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true. When a user asks where a schedule value appears on sheets, search placed schedule cells here before writing custom C# sheet loops; use set_schedule_cells or set_schedule_cells_by_text for accepted follow-up writes.",{...P(ee),...L(ee),query:ee.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),sheetQuery:ee.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text or viewport annotation search."),textQuery:ee.string().optional().describe("Optional text to search in sheet text notes, viewport text notes, or placed schedule cells."),sheetIds:ee.array(ee.union([ee.number(),ee.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),includeTextNotes:ee.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),includeScheduleInstances:ee.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),scanScheduleCells:ee.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),allowExpensiveSearch:ee.boolean().optional().describe("Explicit approval for project-wide sheet, viewport, tag, or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),searchBudget:ee.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:ee.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),includeViewportTextNotes:ee.boolean().optional().describe("Include bounded TextNote results from views placed on matching sheets. Defaults false."),includeViewportTags:ee.boolean().optional().describe("Include bounded IndependentTag evidence from views placed on matching sheets. Defaults false."),viewNameQuery:ee.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),maxSheets:ee.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),maxTextNotesPerSheet:ee.number().int().min(0).max(1e3).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),maxScheduleInstancesPerSheet:ee.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),maxRowsPerSchedule:ee.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),maxColumnsPerSchedule:ee.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),maxTextChars:ee.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned text value. Defaults 240."),maxViewportsPerSheet:ee.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:ee.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet. Maximum placed viewports inspected per sheet."),maxViewportTextNotesPerView:ee.number().int().min(0).max(1e3).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),maxViewportTagsPerView:ee.number().int().min(0).max(500).optional().describe("Maximum matching viewport tags returned per placed view. Defaults 100."),maxTextNotesScanned:ee.number().int().positive().max(2e5).optional().describe("Global native cap across sheet and viewport text notes."),maxTags:ee.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:ee.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxScheduleInstancesScanned:ee.number().int().positive().max(1e5).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:ee.number().int().positive().max(5e5).optional().describe("Global native cap across placed schedule body cells."),maxResponseBytes:ee.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:ee.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let o=Tg(t),r=Eg(t),a=!!String(t.textQuery||"").trim()&&!r,i=t.includeViewportTextNotes===!0&&!r,s=t.scanScheduleCells===!0&&!r,l=t.includeViewportTags===!0&&!r;if((a||i||s||l)&&t.allowExpensiveSearch!==!0)return b(Ng(t,o));let c=await U("inspect_sheet_text",Mg(t,o),{...z({...t,timeoutMs:o.timeoutMs},"Inspect Revit sheet annotations"),toolName:"inspect_sheet_text"});return b(Vg(c&&c.result?c.result:c,Date.now()-n))}catch(o){return b(Xe({action:"inspect_sheet_text",error:o instanceof Error?o.message:String(o),elapsedMs:Date.now()-n,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}))}})}import{z as he}from"zod";var Dg=25,Fg=50;function Be(e,t,n,o){if(e==null||e==="")return t;let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function zl(e){let t=Array.isArray(e)&&e.length>0?e:["header","body"];return[...new Set(t.map(n=>String(n||"").toLowerCase()))].filter(n=>["header","body","footer"].includes(n))}var jg={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxCells:5e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxCells:25e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxCells:1e5}};function Ul(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=jg[t],o=Be(e.maxElapsedMs,n.maxElapsedMs,1,119e3),r=Be(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,o+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(o,Math.max(1,r-1e3)),timeoutMs:r,maxCells:Be(e.maxCells,n.maxCells,1,5e5)}}function Bg(e){return(Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t),10)).filter(t=>Number.isFinite(t)&&t>0)}function qg(e,t){let n=Bg(e.scheduleIds),o=zl(e.sections);return{query:e.query,nameQuery:e.nameQuery??e.query,cellQuery:e.cellQuery,scheduleIds:n,sections:o,includeCells:e.includeCells,scanCells:e.scanCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSchedules:Be(e.maxSchedules,50,1,200),maxRowsPerSection:Be(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:Be(e.maxColumnsPerSection,30,0,200),startRow:Be(e.startRow,0,0,1e5),startColumn:Be(e.startColumn,0,0,1e4),maxCellTextChars:Be(e.maxCellTextChars,180,20,1e3),maxCells:t.maxCells,maxResponseBytes:Be(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit schedules",taskId:e.taskId}}function xn(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function zg(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Nr(e){return F(e,"schedules").filter(xn).flatMap(n=>F(n,"sections").map(r=>({schedule:n,section:r})))}function Jn(e){return String(d(e,"cellQuery")??"").trim().length>0}function ni(e){return String(d(e,"nameQuery")??d(e,"query")??"").trim().length>0}function oi(e){return Jn(e)?Nr(e).flatMap(({schedule:t,section:n})=>F(n,"matches").filter(xn).map(r=>({sourceType:"scheduleCell",scheduleId:d(t,"id"),scheduleName:d(t,"name"),section:d(r,"section")??d(n,"section"),row:d(r,"row"),column:d(r,"column"),text:d(r,"text")}))):[]}function ri(e){return d(e,"partial")===!0||d(e,"truncated")===!0?!0:Nr(e).some(({section:t})=>d(t,"rowsTruncated")===!0||d(t,"columnsTruncated")===!0)}function Ug(e){if(d(e,"success")===!1||String(d(e,"state")||"").toLowerCase()==="failed"||d(e,"error"))return"read_failed";if(!ri(e))return"completed";if(d(e,"truncated")===!0)return"max_items";for(let{section:t}of Nr(e)){if(d(t,"rowsTruncated")===!0)return"max_rows";if(d(t,"columnsTruncated")===!0)return"max_columns"}return"max_cells"}function Wl(e){let t=Ug(e),n=d(e,"scanStoppedReason");return!n||n==="completed"&&t!=="completed"?t:n}function Wg(e){let t=$l(e),n=xn(t)?t:{},o=F(e,"schedules"),r=F(e,"evidenceRows").length>0?F(e,"evidenceRows"):oi(e);return{query:d(e,"query")??null,nameQuery:d(e,"nameQuery")??null,cellQuery:d(e,"cellQuery")??null,totalSchedules:d(e,"totalSchedules")??null,candidateCount:d(e,"candidateCount")??null,returnedCount:d(e,"returnedCount")??(o.length>0?o.length:null),inventoryMode:!ni(e)&&!Jn(e),matchCount:r.length,totalCellMatches:d(n,"totalCellMatches")??r.length,scannedScheduleCount:d(n,"scannedScheduleCount")??null,partial:ri(e),scanStoppedReason:Wl(e)}}function $g(e){let t=F(e,"evidenceRows").length>0?F(e,"evidenceRows"):oi(e),n=t.length>0?t[t.length-1]:null,o=Nr(e),r=o.length>0?o[o.length-1].section:null,a=F(e,"schedules"),i=o.length>0?o[o.length-1].schedule:a.length>0?a[a.length-1]:null,s=Number(d(r,"returnedRows")??d(r,"scannedRows")??0),l=Number(d(r,"returnedColumns")??d(r,"scannedColumns")??0),c=Number(d(r,"startRow")??0),u=Number(d(r,"startColumn")??0);return{lastReadSection:d(n,"section")??d(r,"section")??null,lastReadRow:d(n,"row")??d(r,"lastReadRow")??(s>0?c+s-1:null),lastReadColumn:d(n,"column")??d(r,"lastReadColumn")??(l>0?u+l-1:null),lastReadSheetId:null,lastReadViewId:null,lastReadViewportId:null,lastReadItemId:d(n,"scheduleId")??d(i,"id")??null}}function ti(e){let t=Ul(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,includeCells:e.includeCells===!0,scanCells:e.scanCells===!0||!!e.cellQuery,sections:zl(e.sections),maxElapsedMs:t.maxElapsedMs,maxSchedules:Be(e.maxSchedules,50,1,200),maxRowsPerSection:Be(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:Be(e.maxColumnsPerSection,30,0,200),startRow:Be(e.startRow,0,0,1e5),startColumn:Be(e.startColumn,0,0,1e4),maxCells:t.maxCells,maxResponseBytes:Be(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs}}function Hg(e,t=!0){let{matches:n,Matches:o,...r}=e;return{...r,section:d(e,"section"),rowCount:d(e,"rowCount"),columnCount:d(e,"columnCount"),startRow:d(e,"startRow"),startColumn:d(e,"startColumn"),returnedRows:d(e,"returnedRows"),returnedColumns:d(e,"returnedColumns"),rowsTruncated:d(e,"rowsTruncated"),columnsTruncated:d(e,"columnsTruncated"),scannedRows:d(e,"scannedRows"),scannedColumns:d(e,"scannedColumns"),scannedCells:d(e,"scannedCells"),lastReadRow:d(e,"lastReadRow"),lastReadColumn:d(e,"lastReadColumn"),matches:t?F(e,"matches").filter(xn).map(a=>({...a,section:d(a,"section"),row:d(a,"row"),column:d(a,"column"),text:d(a,"text")})):[],cells:F(e,"cells").map(a=>({...a,row:d(a,"row"),cells:F(a,"cells").map(i=>({...i,column:d(i,"column"),text:d(i,"text")}))})),readFailed:d(e,"readFailed"),readError:d(e,"readError")}}function Gg(e){let t=!ni(e)&&!Jn(e),n=Jn(e);return F(e,"schedules").filter(xn).map(o=>{let{nameMatched:r,NameMatched:a,cellMatchCount:i,CellMatchCount:s,sections:l,Sections:c,...u}=o;return{...u,id:d(o,"id"),uniqueId:d(o,"uniqueId"),name:d(o,"name"),viewType:d(o,"viewType"),isTemplate:d(o,"isTemplate"),nameMatched:t?!1:d(o,"nameMatched"),cellMatchCount:n?d(o,"cellMatchCount"):0,sections:F(o,"sections").filter(xn).map(m=>Hg(m,n))}})}function Jg(e,t){for(let[n,o]of Object.entries(t)){let r=n.charAt(0).toUpperCase()+n.slice(1);e[n]=o,e[r]=o}return e}function $l(e){let t=d(e,"scan");if(!t||typeof t!="object"||Array.isArray(t))return t;let n={...t},o={};return ni(e)||(o.scheduleNameMatchedCount=0),Jn(e)||(o.cellMatchedScheduleCount=0,o.totalCellMatches=0),Jg(n,o)}function Kg(e){for(let t of["query","nameQuery","cellQuery","totalSchedules","candidateCount","returnedCount","truncated","maxSchedules","scan","matches"]){let n=d(e,t);n!==void 0&&e[t]===void 0&&(e[t]=n)}return e.scan=$l(e),e.schedules=Gg(e),Jn(e)||(e.matches=[],delete e.Matches),e}function Xg(e){return String(d(e,"id")??d(e,"uniqueId")??d(e,"name")??"")}function Yg(e,t){let n=F(e,"cells"),o=nt(F(e,"matches"),{limit:t}),{cells:r,Cells:a,matches:i,Matches:s,...l}=e;return{...l,matches:o.rows,matchCount:o.totalCount,returnedMatchCount:o.returnedCount,omittedMatchCount:o.omittedCount,duplicateMatchCount:o.duplicateCount,cellsOmitted:n.length>0,cellRowCount:n.length,fullResponseHint:n.length>0?'Use responseMode="full" when downstream schedule adapters need section.cells/body rows.':void 0}}function Qg(e,t){let n=t.responseMode||"compact";if(tn(n))return{...e,responseMode:n};let o=bt(t.maxResultRows,Dg,200),r=bt(t.maxEvidenceRows,Fg,1e3),a=nt(F(e,"schedules"),{limit:o,key:Xg}),i=nt(F(e,"evidenceRows"),{limit:r});return{...e,responseMode:"compact",schedules:a.rows.map(s=>({...s,sections:F(s,"sections").filter(xn).map(l=>Yg(l,r))})),evidenceRows:i.rows,summary:{...e.summary||{},compactResponse:!0,scheduleRowCount:a.totalCount,returnedScheduleRowCount:a.returnedCount,omittedScheduleRowCount:a.omittedCount,duplicateScheduleRowCount:a.duplicateCount,evidenceRowCount:i.totalCount,returnedEvidenceRowCount:i.returnedCount,omittedEvidenceRowCount:i.omittedCount},notices:[...zg(e.notices),'Compact response omits section.cells and bounds evidence rows. Use responseMode="full" for full schedule cell bodies.']}}function ai(e,t,n){let o=ri(e);return Qg(Kg(Le(e,{action:"inspect_schedules",elapsedMs:n,partial:o,scanStoppedReason:Wl(e),scanPolicy:ti(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],summary:Wg,evidenceRows:oi,lastRead:$g})),t)}function Hl(e){e.tool("inspect_schedules","[SCHEDULE_INSPECTION_READ_ONLY] Read-only native Revit schedule discovery and bounded cell inspection with partial-result continuation state. Prefer this over generic send_code_to_revit when finding schedules, reading schedule cells, exporting schedule text to a local TSV/CSV/Excel-style report, or preparing exact row/column coordinates for set_schedule_cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true. Default responseMode=compact omits bulky section.cells; use responseMode=full when the next step needs raw schedule body rows, such as reconcile_schedule_excel schedule adaptation or a local TSV conversion. Do not use raw C# only to dump schedule cells.",{...P(he),...L(he),query:he.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),nameQuery:he.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),cellQuery:he.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),scheduleIds:he.array(he.union([he.number(),he.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),sections:he.array(he.enum(["header","body","footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),includeCells:he.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),scanCells:he.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),allowExpensiveSearch:he.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),searchBudget:he.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:he.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial schedule results can return before transport timeout."),maxSchedules:he.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),maxRowsPerSection:he.number().int().min(0).max(1e3).optional().describe("Maximum rows per section to read/scan. Defaults 80."),maxColumnsPerSection:he.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),startRow:he.number().int().min(0).max(1e5).optional().describe("Zero-based first schedule row to read in each requested section. Defaults 0."),startColumn:he.number().int().min(0).max(1e4).optional().describe("Zero-based first schedule column to read in each requested section. Defaults 0."),maxCells:he.number().int().positive().max(5e5).optional().describe("Global native cap across schedule cells read or scanned. Defaults by searchBudget."),maxResponseBytes:he.number().int().min(4096).max(16*1024*1024).optional().describe("Approximate native response-size cap. Defaults 4 MB."),maxCellTextChars:he.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),responseMode:en,maxResultRows:he.number().int().positive().max(200).optional().describe("Compact-mode cap for returned schedule entries. Defaults 25; full/debug returns all native rows within maxSchedules."),maxEvidenceRows:he.number().int().positive().max(1e3).optional().describe("Compact-mode cap for evidenceRows and per-section matches. Defaults 50."),timeoutMs:he.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{let n=Date.now();try{let o=!!(Array.isArray(t.scheduleIds)&&t.scheduleIds.length>0||String(t.nameQuery||t.query||"").trim());if(!!(t.includeCells===!0||t.scanCells===!0||String(t.cellQuery||"").trim())&&!o&&t.allowExpensiveSearch!==!0)return b(rt({action:"inspect_schedules",reason:"needs_scope",message:"Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],scanPolicy:ti(t),elapsedMs:Date.now()-n,summary:{nameQuery:t.nameQuery??t.query??null,cellQuery:t.cellQuery??null,returnedCount:0,matchCount:0}}));let a=Ul(t),i=await U("inspect_schedules",qg(t,a),{...z(t,"Inspect Revit schedules"),toolName:"inspect_schedules",timeoutMs:a.timeoutMs});return b(ai(i&&i.result?i.result:i,t,Date.now()-n))}catch(o){return b(Xe({action:"inspect_schedules",error:o instanceof Error?o.message:String(o),elapsedMs:Date.now()-n,scanPolicy:ti(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"]}))}})}import{z as fi}from"zod";import*as sh from"node:fs";import Jl from"node:fs/promises";import lh from"node:path";import{performance as ii}from"node:perf_hooks";import*as wn from"@e965/xlsx";import{parse as ch}from"csv-parse/sync";import{z as D}from"zod";var Mr=["identity","comparisonText"],Ar=["identity","comparisonText","code","description","quantity","unit","system","discipline","notes"],kr={identity:["identity","id","key","name","item","row","code","type","mark","tag","poz","kod","ad","isim"],comparisonText:["comparisontext","comparison text","description","desc","aciklama","text","name","item","type","mark","tag","ad","isim"],code:["code","kod","type code","mark","tag","poz"],description:["description","desc","text","aciklama"],quantity:["quantity","qty","count","adet","miktar"],unit:["unit","units","birim"],system:["system","sistem"],discipline:["discipline","disiplin"],notes:["notes","note","remarks","remark","not"]},Zg={\u0410:"A",\u0430:"A",\u0412:"B",\u0432:"B",\u0415:"E",\u0435:"E",\u041A:"K",\u043A:"K",\u041C:"M",\u043C:"M",\u041D:"H",\u043D:"H",\u041E:"O",\u043E:"O",\u0420:"P",\u0440:"P",\u0421:"C",\u0441:"C",\u0422:"T",\u0442:"T",\u0423:"Y",\u0443:"Y",\u0425:"X",\u0445:"X"},eh={\u00C7:"C",\u00E7:"C",\u011E:"G",\u011F:"G",\u00D6:"O",\u00F6:"O",\u015E:"S",\u015F:"S",\u00DC:"U",\u00FC:"U"},Kn=new Set(["DN","MM","CM","M","KW","KCALH","LPS","M3H"]);function me(e){return String(e??"").replace(/\s+/g," ").trim()}function _t(e){return me(e).replace(/\u0131/g,"i").replace(/\u0130/g,"I").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}function Vo(e){return _t(e).replace(/\s+/g,"")}function Xn(e){let t=String(e??"");return t=t.replace(/[\u0000-\u001f\u007f-\u009f]/g," "),t=t.normalize("NFKC"),t=t.replace(/\u0131/g,"i").replace(/\u0130/g,"I"),t=t.replace(/[\u0400-\u04ff]/g,n=>Zg[n]||n),t=t.replace(/[\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/g,n=>eh[n]||n),t=t.toUpperCase(),t=t.replace(/[\u00d8\u00f8\u2205\u2300\u0424\u0444]/g," DN "),t=t.replace(/\b(?:DIAMETER|DIA)\b/g," DN "),t=oh(t),t=t.replace(/(\d),(\d)/g,"$1.$2"),t=t.replace(/(\d)\.(\d)/g,"$1DECIMALDOT$2"),t=t.replace(/[^A-Z0-9]+/g," "),t=t.replace(/(\d)DECIMALDOT(\d)/g,"$1.$2"),t=t.replace(/\bM\s*3\s*H\b/g,"M3H"),t.replace(/\s+/g," ").trim()}function th(e){return e.map(n=>Xn(n)).filter((n,o,r)=>n.length>0&&r.indexOf(n)===o).join(" | ")}function Yn(e){let t=th(e);return{profileVersion:1,normalizedKey:t,tokens:nh(t)}}function nh(e){let t=Xn(e),n=t.length>0?t.split(" "):[],o=[];for(let r=0;r<n.length;r++){let a=n[r],i=n[r+1];if(Lo(a)&&i&&Kn.has(i)){o.push({type:"dimension",value:`${a}${i}`}),r++;continue}if(Kn.has(a)&&i&&Lo(i)){o.push({type:"dimension",value:`${a}${i}`}),r++;continue}let s=ih(a);if(s){o.push({type:"dimension",value:s});continue}if(Kn.has(a)){o.push({type:"unit",value:a});continue}if(Lo(a)){o.push({type:"number",value:a});continue}let l=n[r+2]||"",c=Kn.has(l)&&Lo(n[r+3]||""),u=Kn.has(l)&&!c;if(rh(a)&&i&&Lo(i)&&!Kn.has(a)&&!u){o.push({type:"code",value:`${a}${i}`}),r++;continue}if(ah(a)){o.push({type:"code",value:a});continue}o.push({type:"word",value:a})}return o}function oh(e){return e.replace(/\bM\s*(?:3|\^3)\s*\/\s*H\b/g," M3H ").replace(/\bM3H\b/g," M3H ").replace(/\b(?:L|LT)\s*\/\s*S\b/g," LPS ").replace(/\bLPS\b/g," LPS ").replace(/\bKCAL\s*\/\s*H\b/g," KCALH ").replace(/\bKCALH\b/g," KCALH ").replace(/\bKW\b/g," KW ").replace(/\bMM\b/g," MM ").replace(/\bCM\b/g," CM ").replace(/\bDN\b/g," DN ")}function Lo(e){return/^\d+(?:\.\d+)?$/.test(e)}function rh(e){return/^[A-Z]+$/.test(e)}function ah(e){return/[A-Z]/.test(e)&&/\d/.test(e)}function ih(e){let t=e.match(/^(\d+(?:\.\d+)?)(DN|MM|CM|M|KW|KCALH|LPS|M3H)$/);if(t)return`${t[1]}${t[2]}`;let n=e.match(/^(DN)(\d+(?:\.\d+)?)$/);return n?`${n[1]}${n[2]}`:null}wn.set_fs(sh);var Do="reconcile_schedule_excel",Dr="excel_ingestion",Qn={maxWorkbookBytes:25*1024*1024,maxSheets:20,maxRows:5e3,maxColumns:100,maxCells:25e4,maxElapsedMs:5e3},Zn={maxWorkbookBytes:100*1024*1024,maxSheets:200,maxRows:5e4,maxColumns:300,maxCells:1e6,maxElapsedMs:119e3},Or=Mr,Pr=Ar,uh=kr,dh=D.object({sheetName:D.string().min(1).optional(),sheetIndex:D.number().int().positive().optional(),range:D.string().min(1).optional(),headerRow:D.number().int().positive().optional(),dataStartRow:D.number().int().positive().optional()}).strict(),Kl=D.object({identity:D.union([D.string().min(1),D.number().int().positive()]).optional(),comparisonText:D.union([D.string().min(1),D.number().int().positive()]).optional(),code:D.union([D.string().min(1),D.number().int().positive()]).optional(),description:D.union([D.string().min(1),D.number().int().positive()]).optional(),quantity:D.union([D.string().min(1),D.number().int().positive()]).optional(),unit:D.union([D.string().min(1),D.number().int().positive()]).optional(),system:D.union([D.string().min(1),D.number().int().positive()]).optional(),discipline:D.union([D.string().min(1),D.number().int().positive()]).optional(),notes:D.union([D.string().min(1),D.number().int().positive()]).optional()}).strict(),Xl=D.object({maxWorkbookBytes:D.number().int().positive().optional(),maxSheets:D.number().int().positive().optional(),maxRows:D.number().int().nonnegative().optional(),maxColumns:D.number().int().positive().optional(),maxCells:D.number().int().positive().optional(),maxElapsedMs:D.number().int().positive().optional()}).strict(),mh=D.object({kind:D.literal("file"),path:D.string().min(1),format:D.enum(["xlsx","csv","tsv","xls"]).optional(),selection:dh.optional(),columnMapping:Kl.optional(),budgets:Xl.optional()}).strict(),ph=D.object({kind:D.literal("rows"),sheetName:D.string().min(1).optional(),rows:D.array(D.record(D.unknown())),selection:D.object({headerRow:D.number().int().positive().optional(),dataStartRow:D.number().int().positive().optional()}).strict().optional(),columnMapping:Kl.optional(),budgets:Xl.optional()}).strict(),li=D.discriminatedUnion("kind",[mh,ph]);function zt(e){return me(e)}function Lr(e){return _t(e)}function Gl(e){return Vo(e)}function gh(e){return{maxWorkbookBytes:eo(e?.maxWorkbookBytes,Qn.maxWorkbookBytes,Zn.maxWorkbookBytes),maxSheets:eo(e?.maxSheets,Qn.maxSheets,Zn.maxSheets),maxRows:eo(e?.maxRows,Qn.maxRows,Zn.maxRows),maxColumns:eo(e?.maxColumns,Qn.maxColumns,Zn.maxColumns),maxCells:eo(e?.maxCells,Qn.maxCells,Zn.maxCells),maxElapsedMs:eo(e?.maxElapsedMs,Qn.maxElapsedMs,Zn.maxElapsedMs)}}function eo(e,t,n){return typeof e!="number"||!Number.isFinite(e)?t:Math.max(0,Math.min(Math.floor(e),n))}function Yl(e,t){let n=(t||lh.extname(e).replace(/^\./,"")).trim().toLowerCase();return n==="xlsx"||n==="csv"||n==="tsv"||n==="xls"?n:"unsupported"}function vn(e,t,n={}){let{warnings:o=[],notices:r=[],suggestedNextScopes:a=[],...i}=n;return rt({action:Do,reason:e,message:t,extra:{stage:Dr,ingestionContractVersion:1,...i},summary:n.summary||{},evidenceRows:[],scanPolicy:n.scanPolicy||{},suggestedNextScopes:a,warnings:o,notices:r})}function hh(e,t={}){let{warnings:n=[],notices:o=[],...r}=t;return Xe({action:Do,error:e,extra:{stage:Dr,ingestionContractVersion:1,...r},summary:t.summary||{},evidenceRows:[],scanPolicy:t.scanPolicy||{},warnings:n,notices:o})}function fh(e){let t=e.table.warnings.concat(e.mappingWarnings),n=e.table.notices.concat(e.mappingNotices),o=e.table.partial,r=e.table.scanStoppedReason,a=e.records.map(i=>({sourceType:"excelRecord",excelRowId:i.excelRowId,sheetName:i.sheetName,rowNumber:i.rowNumber,identityText:i.identityText,comparisonText:i.comparisonText,normalizedKey:i.normalizedKey}));return Le({success:!0,guarded:!1,state:"completed",action:Do,stage:Dr,ingestionContractVersion:1,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,excelRecords:e.records,partial:o,scanStoppedReason:r,elapsedMs:e.elapsedMs},{action:Do,partial:o,scanStoppedReason:r,elapsedMs:e.elapsedMs,scanPolicy:{budgets:e.budgets,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerRow:e.table.headerRow,dataStartRow:e.table.dataStartRow,columnMapping:yh(e.mapping,e.table)},summary:{sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerCount:e.table.headers.length,scannedRows:e.table.rows.length,scannedCells:e.table.scannedCells,excelRows:e.records.length,excelRecordCount:e.records.length,emptyExcelRows:e.table.rows.length-e.records.length,formulaCachedValueCount:e.table.formulaCachedValueCount,formulaWithoutCachedValueCount:e.table.formulaWithoutCachedValueCount,partial:o,scanStoppedReason:r},evidenceRows:a,warnings:t,notices:n,lastRead:{lastReadRow:e.table.lastReadRow,lastReadColumn:e.table.lastReadColumn,lastReadItemId:e.records.length>0?e.records[e.records.length-1].excelRowId:null}})}function yh(e,t){let n={};for(let o of Pr){let r=e[o];typeof r=="number"&&(n[o]=t.headers[r]||Ut(t.startColumn+r))}return n}function Ut(e){let t=Math.max(1,Math.floor(e)),n="";for(;t>0;){let o=(t-1)%26;n=String.fromCharCode(65+o)+n,t=Math.floor((t-1)/26)}return n}function si(e){let t=e.trim().toUpperCase();if(!/^[A-Z]+$/.test(t))return null;let n=0;for(let o of t)n=n*26+(o.charCodeAt(0)-64);return n}function Ql(e,t){if(!e)return t;let n=e.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/);if(!n)return null;let o=si(n[1]),r=Number(n[2]),a=n[3]?si(n[3]):o,i=n[4]?Number(n[4]):r;return!o||!a||r<1||i<r||a<o?null:{startRow:r,startColumn:o,endRow:i,endColumn:a}}function Sh(e,t,n,o){return`${Ut(t)}${e}:${Ut(o)}${n}`}function bh(e){return zt(e).length===0}function _h(e){return e.every(t=>bh(t.text))}function xh(e,t){let n=new Map;return e.map((o,r)=>{let a=`Column ${Ut(t+r)}`,i=zt(o.text)||a,s=Lr(i)||Lr(a),l=n.get(s)||0;return n.set(s,l+1),l===0?i:`${i} ${l+1}`})}function Vr(e){if(e==null)return"";if(e instanceof Date)return Number.isNaN(e.getTime())?"":e.toISOString();if(typeof e=="object"){let t=e;return Array.isArray(t.richText)?zt(t.richText.map(n=>String(n.text??"")).join("")):t.text!==void 0?zt(t.text):t.result!==void 0?Vr(t.result):""}return zt(e)}function vh(e,t,n,o){let r=wn.utils.encode_cell({r:t-1,c:n-1}),a=`${o}!${r}`,i=e[r];if(!i)return{value:"",text:"",address:a};if(typeof i.f=="string"&&i.f.length>0)return i.v!==void 0&&i.v!==null&&!(typeof i.v=="string"&&i.v.length===0&&(i.w===void 0||i.w===""))?{value:i.v,text:Vr(i.v)||zt(i.w),address:a,formulaWithCachedValue:!0}:{value:"",text:"",address:a,formulaWithoutCachedValue:!0};let l=i.v??"";return{value:l,text:Vr(l)||zt(i.w),address:a}}function wh(e,t,n,o){return{value:e,text:Vr(e),address:`${o}!${Ut(n)}${t}`}}function Ch(e,t){return ii.now()-e>t.maxElapsedMs}function Ih(e,t,n){let o=[],r=[],a={},i=new Set,s=new Set;for(let c of Pr){let u=n?.[c];if(u!==void 0){let m=Nh(u,e,t);if(m===null)return{error:{role:c,reason:"unresolved_column_ref",value:u}};a[c]=m,i.add(m),s.add(c)}}for(let c of Pr){if(a[c]!==void 0)continue;let u=Zl(c,e);if(u.length===0)continue;let m=Eh(u,i);if(m.kind==="ambiguous")return{error:{role:c,reason:"ambiguous_alias",candidates:m.candidates}};m.kind==="resolved"&&(a[c]=m.match.index,i.add(m.match.index))}for(let c of Or)if(a[c]===void 0)return{error:{role:c,reason:"missing_required_role"}};let l=Or.filter(c=>!s.has(c));if(l.length>0){let c=l.map(u=>`${u}=${e[a[u]]||Ut(t+a[u])}`).join(", ");r.push(`column_mapping_inferred_from_headers: ${c}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`)}return{mapping:a,warnings:o,notices:r}}function Rh(e,t){let n={},o={},r=new Set;for(let a of Or){let i=Zl(a,e).filter(s=>!r.has(s.index)).sort((s,l)=>s.priority-l.priority||s.index-l.index);n[a]=i.map(s=>({header:s.header,column:Ut(t+s.index),priority:s.priority})),i.length>0&&(o[a]=i[0].header,r.add(i[0].index))}return{requiredRoles:Or,candidates:n,suggestedColumnMapping:o}}function Th(e,t){let n=Gl(t),o=uh[e];for(let r=0;r<o.length;r++)if(Gl(o[r])===n)return r;return Number.POSITIVE_INFINITY}function Zl(e,t){return t.map((n,o)=>({header:n,index:o,priority:Th(e,n)})).filter(n=>Number.isFinite(n.priority))}function Eh(e,t){let n=e.filter(i=>!t.has(i.index)),o=n.length>0?n:e,r=Math.min(...o.map(i=>i.priority)),a=o.filter(i=>i.priority===r);return a.length===1?{kind:"resolved",match:a[0]}:{kind:"ambiguous",candidates:a.map(i=>i.header)}}function Nh(e,t,n){if(typeof e=="number"){let s=e-1;return s>=0&&s<t.length?s:null}let o=e.trim(),r=Lr(o),a=t.map((s,l)=>({header:s,index:l})).filter(s=>Lr(s.header)===r);if(a.length===1)return a[0].index;let i=si(o);if(i!==null){let s=i-n;return s>=0&&s<t.length?s:null}return null}function Mh(e,t){let n=[];for(let o of e.rows){if(_h(o.cells))continue;let r={};for(let[m,g]of e.headers.entries())r[g]=o.cells[m]?.text??"";let a={};for(let m of Pr){let g=t[m];typeof g=="number"&&(a[m]=o.cells[g]?.text??"")}let i=zt(a.identity),s=zt(a.comparisonText),l=Yn([i,s]),c=l.normalizedKey,u=`${e.sheetName}!${o.rowNumber}`;n.push({excelRowId:u,sheetName:e.sheetName,rowNumber:o.rowNumber,sourceRange:e.sourceRange,rawValues:r,mappedValues:a,identityText:i,comparisonText:s,normalizedKey:c,tokenProfile:l})}return n}async function Ah(e,t,n){let o=wn.readFile(e.path,{cellDates:!0,cellFormula:!0,cellText:!0,nodim:!0}),r=o.SheetNames.map(u=>({name:u,worksheet:o.Sheets[u]||{}})),a=e.selection||{},i=!!(a.sheetName||a.sheetIndex),s=r.filter(u=>Ph(u.worksheet));if(!i&&r.length>t.maxSheets&&s.length!==1)return vn("max_items","Workbook sheet count exceeds maxSheets and cannot be auto-scoped to one non-empty sheet. Provide sheetName or sheetIndex.",{partial:!0,scanStoppedReason:"max_items",summary:{workbookSheets:r.length,nonEmptySheets:s.length,maxSheets:t.maxSheets},scanPolicy:{budgets:t},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex","excel.budgets.maxSheets"]});let l=kh(o,a,s);if(!l)return vn("excel_sheet_selection_required","Select a worksheet with sheetName or 1-based sheetIndex.",{summary:{workbookSheets:r.length,sheetNames:r.map(u=>u.name)},scanPolicy:{budgets:t,selection:a},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex"]});let c=Oh(l,a,t,n);return!i&&s.length===1&&c.notices.push("Selected the only non-empty worksheet."),c}function kh(e,t,n){if(t.sheetName){let o=e.Sheets[t.sheetName];return o?{name:t.sheetName,worksheet:o}:null}if(t.sheetIndex){let o=e.SheetNames[t.sheetIndex-1];return o&&e.Sheets[o]?{name:o,worksheet:e.Sheets[o]}:null}return n.length===1?n[0]:null}function Oh(e,t,n,o){let r=Lh(e.worksheet);return tc({sheetName:e.name,fallbackRange:r,selection:t,budgets:n,startedAt:o,readCell:(a,i)=>vh(e.worksheet,a,i,e.name)})}function Ph(e){return Object.keys(e).some(t=>!t.startsWith("!"))}function Lh(e){let t=Number.POSITIVE_INFINITY,n=Number.POSITIVE_INFINITY,o=1,r=1;for(let a of Object.keys(e))if(!a.startsWith("!"))try{let i=wn.utils.decode_cell(a);t=Math.min(t,i.r+1),n=Math.min(n,i.c+1),o=Math.max(o,i.r+1),r=Math.max(r,i.c+1)}catch{continue}return!Number.isFinite(t)||!Number.isFinite(n)?{startRow:1,startColumn:1,endRow:1,endColumn:1}:{startRow:t,startColumn:n,endRow:o,endColumn:r}}async function Vh(e,t,n,o){let r=await Jl.readFile(e.path,"utf8"),a=Dh(e.selection||{},t),i=ch(r,{bom:!0,delimiter:o==="tsv"?"	":",",relax_column_count:!0,skip_empty_lines:!1,to:a.recordLimit+1}),s=i.length>a.recordLimit?{partial:!0,scanStoppedReason:a.scanStoppedReason}:void 0,l=s?i.slice(0,a.recordLimit):i,c=e.selection?.sheetName||(o==="tsv"?"TSV":"CSV");return ec(l,c,e.selection||{},t,n,s)}function Dh(e,t){let o=Ql(e.range,{startRow:1,startColumn:1,endRow:1,endColumn:1})?.startRow||1,r=e.headerRow||o,a=e.dataStartRow||r+1;return{recordLimit:Math.max(o,r,a+t.maxRows-1),scanStoppedReason:"max_rows"}}function Fh(e,t,n){let o=e.sheetName||"Rows",r=jh(e.rows),a=e.selection?.headerRow||1,i=e.selection?.dataStartRow||a+1,s=[];for(;s.length<a-1;)s.push([]);for(s.push(r);s.length<i-1;)s.push([]);for(let l of e.rows)s.push(r.map(c=>l[c]));return ec(s,o,{headerRow:a,dataStartRow:i},t,n)}function jh(e){let t=[],n=new Set;for(let o of e)for(let r of Object.keys(o))n.has(r)||(n.add(r),t.push(r));return t}function ec(e,t,n,o,r,a){let i=e.reduce((l,c)=>Math.max(l,c.length),1),s={startRow:1,startColumn:1,endRow:Math.max(e.length,1),endColumn:Math.max(i,1)};return tc({sheetName:t,fallbackRange:s,selection:n,budgets:o,startedAt:r,prelimited:a,readCell:(l,c)=>wh(e[l-1]?.[c-1],l,c,t)})}function tc(e){let t=Ql(e.selection.range,e.fallbackRange);if(!t)throw new Error(`Invalid range selection: ${e.selection.range}`);let n=e.selection.headerRow||t.startRow,o=e.selection.dataStartRow||n+1;if(o<=n)throw new Error("dataStartRow must be greater than headerRow.");let r=t.endColumn,a=e.prelimited?.partial||!1,i=e.prelimited?.scanStoppedReason||"completed";r-t.startColumn+1>e.budgets.maxColumns&&(r=t.startColumn+e.budgets.maxColumns-1,a=!0,i="max_columns");let s=[],l=0,c=0,u=0,m=[],g=[];for(let I=t.startColumn;I<=r;I++){let _=e.readCell(n,I);s.push(_),l++,_.formulaWithCachedValue&&c++,_.formulaWithoutCachedValue&&(u++,m.push(`Formula cell ${_.address||`${e.sheetName}!${Ut(I)}${n}`} has no cached value and was read as blank.`))}let p=xh(s,t.startColumn),y=[],f=null,w=null,T=Math.max(o,t.startRow);for(let I=T;I<=t.endRow;I++){if(y.length>=e.budgets.maxRows){a=!0,i=i==="completed"?"max_rows":i;break}if(Ch(e.startedAt,e.budgets)){a=!0,i="max_elapsed";break}if(l+p.length>e.budgets.maxCells){a=!0,i=i==="completed"?"max_cells":i;break}let _=[];for(let A=t.startColumn;A<=r;A++){let R=e.readCell(I,A);_.push(R),l++,f=I,w=A,R.formulaWithCachedValue&&c++,R.formulaWithoutCachedValue&&(u++,m.push(`Formula cell ${R.address||`${e.sheetName}!${Ut(A)}${I}`} has no cached value and was read as blank.`))}y.push({rowNumber:I,cells:_})}return{sheetName:e.sheetName,sourceRange:Sh(t.startRow,t.startColumn,t.endRow,r),headerRow:n,dataStartRow:o,startColumn:t.startColumn,headers:p,rows:y,notices:g,warnings:m,formulaCachedValueCount:c,formulaWithoutCachedValueCount:u,scannedCells:l,partial:a,scanStoppedReason:i,lastReadRow:f,lastReadColumn:w}}function Bh(e){return!!(e&&typeof e=="object"&&e.action===Do&&e.stage===Dr)}async function nc(e){let t=ii.now(),n=li.safeParse(e);if(!n.success)return vn("needs_scope","Excel ingestion input failed schema validation.",{validationIssues:n.error.issues.map(a=>`${a.path.join(".")||"<root>"}: ${a.message}`),suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"]});let o=n.data,r=gh(o.budgets);try{let a=await qh(o,r,t);if(Bh(a))return a;let i=a,s=Ih(i.headers,i.startColumn,o.columnMapping);if("error"in s)return vn("excel_column_mapping_required","Resolve identity and comparisonText column mapping before ingestion.",{mappingError:s.error,mappingSuggestion:Rh(i.headers,i.startColumn),summary:{sheetName:i.sheetName,headers:i.headers},scanPolicy:{budgets:r},suggestedNextScopes:["excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:i.warnings,notices:i.notices});let l=Mh(i,s.mapping);return fh({sourceKind:o.kind,format:o.kind==="file"?Yl(o.path,o.format):"rows",table:i,records:l,budgets:r,mapping:s.mapping,mappingNotices:s.notices,mappingWarnings:s.warnings,elapsedMs:ii.now()-t})}catch(a){return hh(a instanceof Error?a.message:String(a),{scanPolicy:{budgets:r}})}}async function qh(e,t,n){if(e.kind==="rows")return Fh(e,t,n);let o=Yl(e.path,e.format);if(o==="xls")return vn("unsupported_excel_format",".xls is not supported. Save the workbook as .xlsx, .csv, or .tsv.",{format:o,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});if(o==="unsupported")return vn("unsupported_excel_format","Unsupported spreadsheet format. Use .xlsx, .csv, or .tsv.",{format:o,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});let r=await Jl.stat(e.path);return r.size>t.maxWorkbookBytes?vn("max_bytes","Workbook exceeds maxWorkbookBytes.",{format:o,partial:!0,scanStoppedReason:"max_bytes",summary:{workbookBytes:r.size,maxWorkbookBytes:t.maxWorkbookBytes},scanPolicy:{budgets:t},suggestedNextScopes:["excel.budgets.maxWorkbookBytes","excel.selection.sheetName","excel.selection.range"]}):o==="xlsx"?Ah(e,t,n):Vh(e,t,n,o)}import{z as M}from"zod";var Fr="reconcile_schedule_records",ui="schedule_record_adapter",nn="displayedScheduleCells",zh=["body"],ci=Ar,ic=Mr,Uh=kr,Wh=M.object({column:M.number().int().nonnegative(),header:M.string().min(1)}).strict(),sc=M.union([M.array(M.string()),M.array(Wh),M.record(M.union([M.string().min(1),M.number().int().nonnegative()]))]),lc=M.enum(["auto","always","never"]),cc=M.object({identity:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),comparisonText:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),code:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),description:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),quantity:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),unit:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),system:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),discipline:M.union([M.string().min(1),M.number().int().nonnegative()]).optional(),notes:M.union([M.string().min(1),M.number().int().nonnegative()]).optional()}).strict(),$h=M.object({kind:M.literal("inspect_schedules_result"),result:M.record(M.unknown()),columnMapping:cc.optional(),columnHeaders:sc.optional(),sections:M.array(M.enum(["header","body","footer"])).optional(),headerDataMode:lc.optional()}).strict(),Hh=M.object({kind:M.literal("revit_schedule"),scheduleIds:M.array(M.union([M.number().int().positive(),M.string().min(1)])).optional(),nameQuery:M.string().min(1).optional(),sections:M.array(M.enum(["header","body","footer"])).optional(),columnMapping:cc.optional(),columnHeaders:sc.optional(),headerDataMode:lc.optional(),target:M.string().optional(),host:M.string().optional(),port:M.number().int().positive().max(65535).optional(),taskName:M.string().optional(),taskId:M.string().optional(),parentTaskName:M.string().optional(),parentTaskId:M.string().optional(),allowExpensiveSearch:M.boolean().optional(),searchBudget:M.enum(["fast","balanced","deep"]).optional(),maxElapsedMs:M.number().int().positive().max(119e3).optional(),maxSchedules:M.number().int().positive().max(200).optional(),maxRowsPerSection:M.number().int().min(0).max(1e3).optional(),maxColumnsPerSection:M.number().int().min(0).max(200).optional(),startRow:M.number().int().min(0).max(1e5).optional(),startColumn:M.number().int().min(0).max(1e4).optional(),maxCells:M.number().int().positive().max(5e5).optional(),maxResponseBytes:M.number().int().min(4096).max(16*1024*1024).optional(),maxCellTextChars:M.number().int().min(20).max(1e3).optional(),timeoutMs:M.number().int().positive().max(12e4).optional()}).strict(),di=M.discriminatedUnion("kind",[$h,Hh]);async function uc(e,t={}){let n=Date.now(),o=di.safeParse(e);return o.success?o.data.kind==="revit_schedule"?Gh(o.data,n,t):dc(o.data,Date.now()-n):jr("needs_scope","Schedule adapter input failed schema validation.",{validationIssues:o.error.issues.map(r=>`${r.path.join(".")||"<root>"}: ${r.message}`),elapsedMs:Date.now()-n,suggestedNextScopes:["schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]})}async function Gh(e,t,n){if(!!!(Array.isArray(e.scheduleIds)&&e.scheduleIds.length>0||String(e.nameQuery||"").trim())&&e.allowExpensiveSearch!==!0)return jr("needs_scope","Direct live schedule reconciliation requires scheduleIds or nameQuery. Set allowExpensiveSearch=true only when a broad schedule scan is intentional.",{sourceKind:e.kind,elapsedMs:Date.now()-t,suggestedNextScopes:["schedule.scheduleIds","schedule.nameQuery","schedule.allowExpensiveSearch=true"],scanPolicy:{sourceKind:e.kind,bridgeExecution:"inspect_schedules",scheduleIds:[],nameQuery:null,allowExpensiveSearch:!1,visibilityBasis:nn}});let a=["header",...pc(e.sections).filter(g=>g!=="header")],i={query:e.nameQuery,nameQuery:e.nameQuery,scheduleIds:e.scheduleIds,sections:a,includeCells:!0,scanCells:!1,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:e.searchBudget,maxElapsedMs:e.maxElapsedMs,maxSchedules:e.maxSchedules,maxRowsPerSection:e.maxRowsPerSection,maxColumnsPerSection:e.maxColumnsPerSection,startRow:e.startRow,startColumn:e.startColumn,maxCells:e.maxCells,maxResponseBytes:e.maxResponseBytes,maxCellTextChars:e.maxCellTextChars,responseMode:"full",timeoutMs:e.timeoutMs,taskName:e.taskName||"Inspect live Revit schedule for reconciliation",taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId},l=await(n.sendCommand||U)("inspect_schedules",i,{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs,taskName:i.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,toolName:"reconcile_schedule_excel"}),c=Date.now()-t,u=ai(l&&l.result?l.result:l,i,c),m=dc({kind:"inspect_schedules_result",result:u,columnMapping:e.columnMapping,columnHeaders:e.columnHeaders,sections:e.sections,headerDataMode:e.headerDataMode},c);return m.sourceKind="revit_schedule",m.bridgeSourceKind="inspect_schedules_result",m.scanPolicy={...m.scanPolicy||{},sourceKind:"revit_schedule",bridgeExecution:"inspect_schedules",inspectSections:a,scheduleIds:e.scheduleIds||[],nameQuery:e.nameQuery||null,allowExpensiveSearch:e.allowExpensiveSearch===!0},m.notices=[...Cn(m,"notices"),"Live Revit schedule input was read through bounded inspect_schedules before reconciliation."],m}function dc(e,t){let n=e.result,o=me(d(n,"state")).toLowerCase();if(d(n,"success")===!1||o==="failed"||d(n,"error"))return rf(me(d(n,"error"))||"inspect_schedules_result failed before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:Cn(n,"warnings"),notices:Cn(n,"notices")});if(d(n,"guarded")===!0)return jr(me(d(n,"reason"))||"needs_scope","inspect_schedules_result was guarded before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:Cn(n,"warnings"),notices:Cn(n,"notices"),summary:d(n,"summary")||{},suggestedNextScopes:['inspect_schedules responseMode="full"',"schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let r=pc(e.sections),a=Array.isArray(e.sections)&&e.sections.length>0,i=gc(e.headerDataMode),s=F(n,"schedules"),l=Cn(n,"warnings"),c=Cn(n,"notices"),u=[],m=0,g=0,p=0,y=0,f=0;for(let _ of s){let A=pi(d(_,"id"));if(!A){l.push("Skipped a schedule without id while adapting schedule records.");continue}let R=qr(d(_,"name")),E=Yh(_,e.columnHeaders),S=ef(E,e.columnMapping);if("error"in S)return jr("schedule_column_mapping_required","Resolve identity and comparisonText schedule column mapping before adaptation.",{sourceKind:e.kind,scheduleId:A,scheduleName:R,mappingError:S.error,summary:{scheduleId:A,scheduleName:R,headers:E.map(q=>({column:q.column,header:q.header}))},scanPolicy:ac(e,r),suggestedNextScopes:["schedule.columnMapping.identity","schedule.columnMapping.comparisonText",'inspect_schedules responseMode="full"'],warnings:l,notices:c});let k=Xh(_,r,a,i);k.headerAsData&&y++;for(let q of F(_,"sections")){let X=Br(d(q,"section"));if(!k.sections.includes(X))continue;let re=X==="header"&&k.headerAsData;for(let Z of mi(q,A,R,X)){if(m++,g+=Z.cells.length,re&&Jh(Z,R)){p++;continue}if(X==="body"&&oc(Z,S.mapping,E,{matchSameColumnHeader:!0})){p++;continue}if(re&&oc(Z,S.mapping,E,{matchSameColumnHeader:!1})){p++;continue}let pe=Kh(Z,S.mapping);pe&&(re&&f++,u.push(pe))}}}let w=d(n,"partial")===!0,T=Po(d(n,"scanStoppedReason"),w?"max_items":"completed"),I=u.length>0?u[u.length-1]:null;return Le({success:!0,guarded:!1,state:"completed",action:Fr,stage:ui,adapterContractVersion:1,sourceKind:e.kind,visibilityBasis:nn,scheduleRecords:u,partial:w,scanStoppedReason:T,elapsedMs:t},{action:Fr,partial:w,scanStoppedReason:T,elapsedMs:t,scanPolicy:ac(e,r),summary:{sourceKind:e.kind,scheduleCount:s.length,scannedRows:m,scannedCells:g,skippedHeaderLikeRows:p,headerAsDataScheduleCount:y,headerAsDataRows:f,scheduleRecordCount:u.length,visibilityBasis:nn,partial:w,scanStoppedReason:T},evidenceRows:u.map(_=>({sourceType:"scheduleRecord",scheduleRowId:_.scheduleRowId,scheduleId:_.scheduleId,scheduleName:_.scheduleName,section:_.section,row:_.row,identityText:_.identityText,comparisonText:_.comparisonText,normalizedKey:_.normalizedKey,visibilityBasis:nn})),warnings:l,notices:[...c,...y>0?[`Read Header section rows as schedule data for ${y} schedule(s).`]:[],...p>0?[`Skipped ${p} header-like schedule row(s) during schedule adaptation.`]:[]],lastRead:{lastReadSection:d(n,"lastReadSection")??I?.section??null,lastReadRow:d(n,"lastReadRow")??I?.row??null,lastReadColumn:d(n,"lastReadColumn")??null,lastReadItemId:d(n,"lastReadItemId")??I?.scheduleRowId??null}})}function oc(e,t,n,o){let r=new Map;for(let s of e.cells)r.set(s.column,s.text);let a=ic.filter(s=>typeof t[s]=="number");if(a.length===0)return!1;let i=new Map;for(let s of a){let l=t[s];typeof l=="number"&&i.set(l,[...i.get(l)||[],s])}return[...i.entries()].every(([s,l])=>{let c=me(r.get(s));if(!c)return!1;let u=_t(c);return o.matchSameColumnHeader&&n.some(g=>g.column===s&&_t(g.header)===u)?!0:l.some(g=>Number.isFinite(mc(g,c))||g==="identity"&&["number","no","numara"].includes(u)?!0:g==="comparisonText"&&["name","description","desc","text","aciklama"].includes(u))})}function Jh(e,t){let n=_t(t||"");if(!n)return!1;let o=e.cells.map(r=>_t(r.text)).filter(r=>r.length>0);return o.length===1&&o[0]===n}function Kh(e,t){let n=new Map;for(let s of e.cells)n.set(s.column,s.text);let o={};for(let s of ci){let l=t[s];typeof l=="number"&&(o[s]=me(n.get(l)))}let r=me(o.identity),a=me(o.comparisonText);if(!r&&!a)return null;let i=Yn([r,a]);return{scheduleRowId:`${e.scheduleId}:${e.section}:${e.row}`,scheduleId:e.scheduleId,scheduleName:e.scheduleName,section:e.section,row:e.row,rawCells:e.cells.map(s=>({column:s.column,text:s.text})),mappedValues:o,identityText:r,comparisonText:a,normalizedKey:i.normalizedKey,tokenProfile:i,visibilityBasis:nn}}function mi(e,t,n,o){let r=F(e,"rows"),a=F(e,"cells");return(r.length>0?r:a).flatMap(s=>{let l=Fo(d(s,"row"));if(l===null)return[];let c=F(s,"cells").map(u=>({column:Fo(d(u,"column")),text:me(d(u,"text"))})).filter(u=>u.column!==null);return[{scheduleId:t,scheduleName:n,section:o,row:l,cells:c}]})}function Xh(e,t,n,o){return t.includes("header")?{sections:t,headerAsData:!0}:o==="never"?{sections:t,headerAsData:!1}:rc(e,["header"])?o==="always"?{sections:[...t,"header"],headerAsData:!0}:!n&&!rc(e,t)?{sections:[...t,"header"],headerAsData:!0}:{sections:t,headerAsData:!1}:{sections:t,headerAsData:!1}}function rc(e,t){let n=pi(d(e,"id"))||"unknown",o=qr(d(e,"name"));for(let r of F(e,"sections")){let a=Br(d(r,"section"));if(t.includes(a)&&mi(r,n,o,a).some(i=>i.cells.length>0))return!0}return!1}function Yh(e,t){let n=[],o=new Set,r=(a,i)=>{let s=me(i);if(s.length===0)return;let l=`${a}:${_t(s)}`;o.has(l)||(o.add(l),n.push({column:a,header:s}))};for(let a of Qh(e))r(a.column,a.header);for(let a of F(e,"sections"))if(Br(d(a,"section"))==="header")for(let i of mi(a,pi(d(e,"id"))||"unknown",qr(d(e,"name")),"header"))for(let s of i.cells)r(s.column,s.text);for(let a of Zh(t))r(a.column,a.header);return n.sort((a,i)=>a.column-i.column)}function Qh(e){let t=[],n=(o,r)=>{if(o===null)return;let a=me(r);a.length>0&&t.push({column:o,header:a})};for(let o of F(e,"fields")){if(d(o,"isHidden")===!0)continue;let r=Fo(d(o,"column"))??Fo(d(o,"visibleColumn"));n(r,d(o,"columnHeading")),n(r,d(o,"heading")),n(r,d(o,"label")),n(r,d(o,"name")),n(r,d(o,"fieldName")),n(r,d(o,"parameterName"))}return t}function Zh(e){if(!e)return[];if(Array.isArray(e))return e.map((n,o)=>typeof n=="string"?{column:o,header:me(n)}:{column:n.column,header:me(n.header)}).filter(n=>n.header.length>0);let t=[];for(let[n,o]of Object.entries(e)){let r=Fo(n);if(r!==null&&typeof o=="string"){let a=me(o);a.length>0&&t.push({column:r,header:a});continue}if(typeof o=="number"){let a=me(n);a.length>0&&t.push({column:o,header:a})}}return t.sort((n,o)=>n.column-o.column)}function ef(e,t){let n=[],o=[],r={},a=new Set;for(let i of ci){let s=t?.[i];if(s!==void 0){let l=tf(s,e);if(l===null)return{error:{role:i,reason:"unresolved_column_ref",value:s}};r[i]=l,a.add(l)}}for(let i of ci){if(r[i]!==void 0)continue;let s=nf(i,e);if(s.length===0)continue;let l=of(s,a);if(l.kind==="ambiguous")return{error:{role:i,reason:"ambiguous_alias",candidates:l.candidates}};r[i]=l.match.column,a.add(l.match.column)}for(let i of ic)if(r[i]===void 0)return{error:{role:i,reason:"missing_required_role"}};return{mapping:r,warnings:n,notices:o}}function tf(e,t){if(typeof e=="number")return t.length>0&&!t.some(a=>a.column===e)?null:e;let n=e.trim(),o=_t(n),r=t.filter(a=>_t(a.header)===o);return r.length===1?r[0].column:null}function mc(e,t){let n=Vo(t),o=Uh[e];for(let r=0;r<o.length;r++)if(Vo(o[r])===n)return r;return Number.POSITIVE_INFINITY}function nf(e,t){return t.map(n=>({header:n.header,column:n.column,priority:mc(e,n.header)})).filter(n=>Number.isFinite(n.priority))}function of(e,t){let n=e.filter(s=>!t.has(s.column)),o=n.length>0?n:e,r=Math.min(...o.map(s=>s.priority)),a=o.filter(s=>s.priority===r);return a.length===1?{kind:"resolved",match:a[0]}:[...new Set(a.map(s=>s.column))].length===1?{kind:"resolved",match:a[0]}:{kind:"ambiguous",candidates:a.map(s=>s.header)}}function ac(e,t){return{sourceKind:e.kind,sections:t,headerDataMode:gc(e.headerDataMode),columnMapping:e.columnMapping||null,numericColumnBase:"zero_based_revit_schedule_column",visibilityBasis:nn}}function jr(e,t,n={}){let{warnings:o=[],notices:r=[],elapsedMs:a,scanPolicy:i,summary:s,suggestedNextScopes:l=[],...c}=n;return rt({action:Fr,reason:e,message:t,elapsedMs:a,extra:{stage:ui,adapterContractVersion:1,visibilityBasis:nn,...c},summary:s||{},evidenceRows:[],scanPolicy:i||{},suggestedNextScopes:l,warnings:o,notices:r})}function rf(e,t={}){let{warnings:n=[],notices:o=[],elapsedMs:r,scanPolicy:a,summary:i,...s}=t;return Xe({action:Fr,error:e,elapsedMs:r,extra:{stage:ui,adapterContractVersion:1,visibilityBasis:nn,...s},summary:i||{},evidenceRows:[],scanPolicy:a||{},warnings:n,notices:o})}function pc(e){let t=Array.isArray(e)&&e.length>0?e:zh;return[...new Set(t.map(Br))].filter(n=>["header","body","footer"].includes(n))}function gc(e){return e==="always"||e==="never"?e:"auto"}function Br(e){let t=me(e).toLowerCase();return["header","body","footer"].includes(t)?t:"body"}function Cn(e,t){let n=d(e,t);return Array.isArray(n)?n.map(me).filter(o=>o.length>0):[]}function Fo(e){if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function pi(e){return qr(e)}function qr(e){let t=me(e);return t.length>0?t:null}import{z as Q}from"zod";var jo={score:{exact:100,diceTokenOverlap:35,code:20,dimension:20,order:15,context:10},thresholds:{highConfidenceMin:86,highConfidenceMax:99,candidateMin:65,possibleRenameMin:72,possibleRenameMax:85,ambiguousMin:65,ambiguousMax:71,candidateGap:8,tieGap:8},caps:{conflictingCode:64,conflictingDimension:60,unitMismatch:79},candidateGeneration:{minSharedSignificantWordTokens:2},contextFields:["system","unit","quantity","discipline"]},af=Q.object({exact:Q.number().min(0).max(100).optional(),diceTokenOverlap:Q.number().min(0).max(100).optional(),code:Q.number().min(0).max(100).optional(),dimension:Q.number().min(0).max(100).optional(),order:Q.number().min(0).max(100).optional(),context:Q.number().min(0).max(100).optional()}).strict(),sf=Q.object({highConfidenceMin:Q.number().min(0).max(100).optional(),highConfidenceMax:Q.number().min(0).max(100).optional(),candidateMin:Q.number().min(0).max(100).optional(),possibleRenameMin:Q.number().min(0).max(100).optional(),possibleRenameMax:Q.number().min(0).max(100).optional(),ambiguousMin:Q.number().min(0).max(100).optional(),ambiguousMax:Q.number().min(0).max(100).optional(),candidateGap:Q.number().min(0).max(100).optional(),tieGap:Q.number().min(0).max(100).optional()}).strict(),lf=Q.object({conflictingCode:Q.number().min(0).max(100).optional(),conflictingDimension:Q.number().min(0).max(100).optional(),unitMismatch:Q.number().min(0).max(100).optional()}).strict(),cf=Q.object({minSharedSignificantWordTokens:Q.number().int().min(0).max(20).optional()}).strict(),Ur=Q.object({score:af.optional(),thresholds:sf.optional(),caps:lf.optional(),candidateGeneration:cf.optional(),contextFields:Q.array(Q.string().min(1)).optional()}).strict(),uf=Q.object({excelRecords:Q.array(Q.record(Q.unknown())).optional(),scheduleRecords:Q.array(Q.record(Q.unknown())).optional(),excelResult:Q.record(Q.unknown()).optional(),scheduleResult:Q.record(Q.unknown()).optional(),config:Ur.optional()}).strict();function _c(e){let t=Date.now(),n=uf.safeParse(e);if(!n.success)return Le({success:!0,guarded:!0,state:"guarded",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,reason:"reconciliation_input_required",message:"Provide excelRecords and scheduleRecords, or normalized ingestion result envelopes containing those arrays.",validationIssues:n.error.issues.map(l=>l.message),partial:!1,scanStoppedReason:"needs_scope"},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"needs_scope",elapsedMs:Date.now()-t,summary:{},evidenceRows:[]});let o=xf(n.data.config),r=hc("excel",n.data.excelRecords??fc(n.data.excelResult,"excelRecords")),a=hc("schedule",n.data.scheduleRecords??fc(n.data.scheduleResult,"scheduleRecords")),i=df(r,a,o),s=vf(r,a,i);return Le({success:!0,guarded:!1,state:"review_ready",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,partial:!1,scanStoppedReason:"completed",reviewRows:i,reviewTable:wf(i),suggestedNextActions:["review_ambiguous","accept_match","create_schedule_row","remove_or_ignore_schedule_row","rename_excel_or_schedule_text"],scoringConfig:o},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"completed",elapsedMs:Date.now()-t,summary:s,evidenceRows:i.map(l=>({sourceType:"reconciliationReviewRow",bucket:l.bucket,score:l.score,excelRowId:l.excelRow?.excelRowId??l.excelRow?.recordId??null,scheduleRowId:l.scheduleRow?.scheduleRowId??l.scheduleRow?.recordId??null,reason:l.reason}))})}function df(e,t,n){let o=[],r=new Set,a=new Set,i=bc(e),s=bc(t);for(let l of e){let c=pf(l,t,n),u=l.normalizedKey.length>0&&(i.has(l.normalizedKey)||s.has(l.normalizedKey)),m=c[0]||null;if(u&&c.some(p=>p.score===n.score.exact||p.schedule.normalizedKey===l.normalizedKey)){let p=c.filter(y=>y.schedule.normalizedKey===l.normalizedKey||y.score>=n.thresholds.candidateMin).slice(0,5);o.push(gi("ambiguousMatches",p[0]||null,l,null,p,"duplicate_exact_key","review_ambiguous")),r.add(l.id),p.forEach(y=>a.add(y.schedule.id));continue}if(!m||m.score<n.thresholds.candidateMin&&m.hardConflicts.length===0){o.push(yf(l)),r.add(l.id);continue}if(a.has(m.schedule.id)){o.push(gi("ambiguousMatches",m,l,m.schedule,c.slice(0,5),"schedule_row_already_claimed","review_ambiguous")),r.add(l.id);continue}let g=mf(m,c[1]||null,n);o.push(gi(g.bucket,m,l,m.schedule,c.slice(0,5),g.reason,g.action)),r.add(l.id),a.add(m.schedule.id),g.bucket==="ambiguousMatches"&&c.filter(p=>p.score>=n.thresholds.candidateMin).slice(0,5).forEach(p=>a.add(p.schedule.id))}for(let l of t)a.has(l.id)||o.push(Sf(l));return o.sort(Mf)}function mf(e,t,n){let o=t?e.score-t.score:Number.POSITIVE_INFINITY,r=t!==null&&e.score===t.score;if(r||o<n.thresholds.tieGap||e.score>=n.thresholds.ambiguousMin&&e.score<=n.thresholds.ambiguousMax)return{bucket:"ambiguousMatches",reason:r?"best_score_tie":o<n.thresholds.tieGap?"candidate_gap_below_threshold":"ambiguous_score_band",action:"review_ambiguous"};if(e.components.exact>0&&e.hardConflicts.length===0&&e.score===n.score.exact)return{bucket:"exactMatches",reason:"exact_normalized_key",action:"accept_match"};let a=(e.sharedCodeTokens.length>0||e.sharedDimensionTokens.length>0)&&e.descriptiveTokensDiffer;return!e.hardConflicts.length&&e.score>=n.thresholds.highConfidenceMin&&a?{bucket:"possibleRenames",reason:"shared_key_tokens_with_description_change",action:"rename_excel_or_schedule_text"}:e.score>=n.thresholds.highConfidenceMin&&e.score<=n.thresholds.highConfidenceMax&&!e.capped&&o>=n.thresholds.candidateGap?{bucket:"highConfidenceMatches",reason:"high_confidence_score_and_gap",action:"accept_match"}:!e.hardConflicts.length&&(e.score>=n.thresholds.highConfidenceMin&&a||e.score>=n.thresholds.possibleRenameMin&&e.score<=n.thresholds.possibleRenameMax)?{bucket:"possibleRenames",reason:a?"shared_key_tokens_with_description_change":"possible_rename_score_band",action:"rename_excel_or_schedule_text"}:{bucket:"ambiguousMatches",reason:e.hardConflicts.length>0?"hard_conflict_requires_review":"requires_review",action:"review_ambiguous"}}function pf(e,t,n){return t.filter(o=>gf(e,o,n)).map(o=>({...hf(e,o,n),excel:e,schedule:o})).sort(Nf)}function gf(e,t,n){return e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey||xt(ve(e,"code"),ve(t,"code")).length>0||xt(ve(e,"dimension"),ve(t,"dimension")).length>0?!0:xt(ve(e,"word"),ve(t,"word")).length>=n.candidateGeneration.minSharedSignificantWordTokens}function hf(e,t,n){let o=e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey,r=to(e.tokenProfile.tokens.map(y=>y.value)),a=to(t.tokenProfile.tokens.map(y=>y.value)),i=xt(r,a),s=to(r.concat(a).filter(y=>!i.includes(y))),l=xt(ve(e,"code"),ve(t,"code")),c=xt(ve(e,"dimension"),ve(t,"dimension")),u=ff(e,t),m={exact:o?n.score.exact:0,dice:o?0:zr(If(r,a)*n.score.diceTokenOverlap),code:o?0:Sc(ve(e,"code"),ve(t,"code"),n.score.code),dimension:o?0:Sc(ve(e,"dimension"),ve(t,"dimension"),n.score.dimension),order:o?0:zr(Rf(r,a)*n.score.order),context:o?0:Cf(e,t,n)},g=o?n.score.exact:hi(m.dice+m.code+m.dimension+m.order+m.context),p=g;for(let y of u)y==="conflicting_code"&&(p=Math.min(p,n.caps.conflictingCode)),y==="conflicting_dimension"&&(p=Math.min(p,n.caps.conflictingDimension)),y==="unit_mismatch"&&(p=Math.min(p,n.caps.unitMismatch));return{score:hi(p),rawScore:hi(g),components:m,matchedTokens:i,differingTokens:s,hardConflicts:u,sharedCodeTokens:l,sharedDimensionTokens:c,descriptiveTokensDiffer:Ef(e,t),capped:p<g}}function ff(e,t){let n=[],o=ve(e,"code"),r=ve(t,"code");o.length>0&&r.length>0&&xt(o,r).length===0&&n.push("conflicting_code");let a=ve(e,"dimension"),i=ve(t,"dimension");a.length>0&&i.length>0&&xt(a,i).length===0&&n.push("conflicting_dimension");let s=yc(e),l=yc(t);return s.length>0&&l.length>0&&xt(s,l).length===0&&n.push("unit_mismatch"),n}function gi(e,t,n,o,r,a,i){return{bucket:e,score:t?.score??0,rawScore:t?.rawScore??0,reason:a,matchedTokens:t?.matchedTokens??[],differingTokens:t?.differingTokens??[],hardConflicts:t?.hardConflicts??[],scoreComponents:t?.components??null,excelRow:n?Bo(n):null,scheduleRow:o?Bo(o):null,candidateRows:r.map(s=>({score:s.score,rawScore:s.rawScore,scheduleRow:Bo(s.schedule),matchedTokens:s.matchedTokens,hardConflicts:s.hardConflicts})),recommendedNextAction:i}}function yf(e){return{bucket:"missingInSchedule",score:0,rawScore:0,reason:"no_schedule_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:Bo(e),scheduleRow:null,candidateRows:[],recommendedNextAction:"create_schedule_row"}}function Sf(e){return{bucket:"missingInExcel",score:0,rawScore:0,reason:"no_excel_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:null,scheduleRow:Bo(e),candidateRows:[],recommendedNextAction:"remove_or_ignore_schedule_row"}}function Bo(e){return{...e.raw,recordId:e.id,normalizedKey:e.normalizedKey,tokenProfile:e.tokenProfile}}function hc(e,t){return Array.isArray(t)?t.filter(n=>!!n&&typeof n=="object"&&!Array.isArray(n)).map((n,o)=>bf(e,n,o)):[]}function bf(e,t,n=0){let o=e==="excel"?me(t.excelRowId||t.recordId||t.id):me(t.scheduleRowId||t.recordId||t.id),r=qo(t.mappedValues)?t.mappedValues:{},a=_f(t,[t.identityText,t.comparisonText]);return{side:e,id:o||`${e}:${a.normalizedKey||"row"}:${n}`,normalizedKey:me(t.normalizedKey)||a.normalizedKey,tokenProfile:a,raw:t,mappedValues:r}}function _f(e,t){let n=qo(e.tokenProfile)?e.tokenProfile:null;return n&&Array.isArray(n.tokens)&&typeof n.normalizedKey=="string"?{profileVersion:1,normalizedKey:me(n.normalizedKey),tokens:n.tokens.filter(o=>qo(o)&&typeof o.type=="string"&&typeof o.value=="string").map(o=>({type:o.type,value:me(o.value)})).filter(o=>o.value.length>0)}:Yn(t)}function fc(e,t){return qo(e)&&Array.isArray(e[t])?e[t].filter(n=>qo(n)):[]}function xf(e){let t=Ur.safeParse(e||{}),n=t.success?t.data:{};return{score:{...jo.score,...n.score||{}},thresholds:{...jo.thresholds,...n.thresholds||{}},caps:{...jo.caps,...n.caps||{}},candidateGeneration:{...jo.candidateGeneration,...n.candidateGeneration||{}},contextFields:n.contextFields||jo.contextFields}}function vf(e,t,n){let o=Object.fromEntries(["exactMatches","highConfidenceMatches","possibleRenames","ambiguousMatches","missingInSchedule","missingInExcel"].map(r=>[r,0]));for(let r of n)o[r.bucket]=(o[r.bucket]||0)+1;return{excelRows:e.length,scheduleRows:t.length,...o,reviewRowCount:n.length}}function wf(e){return{columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}],rows:e.map(n=>({bucket:n.bucket,score:n.score,reason:n.reason,excelRowId:n.excelRow?.excelRowId??n.excelRow?.recordId??"",scheduleRowId:n.scheduleRow?.scheduleRowId??n.scheduleRow?.recordId??"",excelText:n.excelRow?[n.excelRow.identityText,n.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:n.scheduleRow?[n.scheduleRow.identityText,n.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:(n.hardConflicts||[]).join(", "),recommendedNextAction:n.recommendedNextAction}))}}function ve(e,t){return to(e.tokenProfile.tokens.filter(n=>n.type===t).map(n=>n.value))}function yc(e){let t=ve(e,"unit");for(let o of ve(e,"dimension")){let r=o.match(/^[A-Z]+|[A-Z]+$/)?.[0];r&&t.push(r)}let n=Xn(e.mappedValues.unit);return n&&t.push(n),to(t)}function Sc(e,t,n){if(e.length===0||t.length===0)return 0;let o=xt(e,t).length,r=Math.max(e.length,t.length);return zr(o/r*n)}function Cf(e,t,n){let o=n.contextFields.map(a=>[Xn(e.mappedValues[a]),Xn(t.mappedValues[a])]).filter(([a,i])=>a.length>0&&i.length>0);if(o.length===0)return 0;let r=o.filter(([a,i])=>a===i).length;return zr(r/o.length*n.score.context)}function If(e,t){return e.length===0&&t.length===0?1:e.length===0||t.length===0?0:2*xt(e,t).length/(e.length+t.length)}function Rf(e,t){let n=Math.min(e.length,t.length);return n===0?0:Tf(e,t)/n}function Tf(e,t){let n=Array.from({length:e.length+1},()=>Array(t.length+1).fill(0));for(let o=1;o<=e.length;o++)for(let r=1;r<=t.length;r++)n[o][r]=e[o-1]===t[r-1]?n[o-1][r-1]+1:Math.max(n[o-1][r],n[o][r-1]);return n[e.length][t.length]}function Ef(e,t){let n=ve(e,"word"),o=ve(t,"word");return n.length>0&&o.length>0&&!Af(n,o)}function bc(e){let t=new Map;for(let n of e)n.normalizedKey.length>0&&t.set(n.normalizedKey,(t.get(n.normalizedKey)||0)+1);return new Set([...t.entries()].filter(([,n])=>n>1).map(([n])=>n))}function Nf(e,t){return t.score!==e.score?t.score-e.score:e.schedule.id.localeCompare(t.schedule.id)}function Mf(e,t){let n={exactMatches:0,highConfidenceMatches:1,possibleRenames:2,ambiguousMatches:3,missingInSchedule:4,missingInExcel:5},o=n[e.bucket]??99,r=n[t.bucket]??99;if(o!==r)return o-r;if((t.score||0)!==(e.score||0))return(t.score||0)-(e.score||0);let a=e.excelRow?.recordId||e.scheduleRow?.recordId||"",i=t.excelRow?.recordId||t.scheduleRow?.recordId||"";return String(a).localeCompare(String(i))}function xt(e,t){let n=new Set(t);return to(e.filter(o=>n.has(o)))}function to(e){return[...new Set(e.filter(t=>me(t).length>0))]}function Af(e,t){let n=new Set(e),o=new Set(t);return n.size!==o.size?!1:[...n].every(r=>o.has(r))}function zr(e){return Math.round(e)}function hi(e){return Math.max(0,Math.min(100,Math.round(e)))}function qo(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var wc="reconcile_schedule_excel",kf=50,In=fi.object({excel:li.describe('Excel/CSV source. Use kind:"file" for .xlsx/.csv/.tsv or kind:"rows" for deterministic CI/dry-run records.'),schedule:di.describe('Schedule source. Use kind:"inspect_schedules_result" with a normalized inspect_schedules result, or kind:"revit_schedule" to read bounded live Revit schedule rows through inspect_schedules before reconciliation.'),config:Ur.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),responseMode:en,maxReviewRows:fi.number().int().positive().max(1e3).optional().describe("Compact-mode cap for returned reviewTable/evidenceRows rows. Defaults 50; full/debug returns all reviewRows."),maxCandidateRows:fi.number().int().positive().max(10).optional().describe("Compatibility input for older callers. Compact mode omits nested candidateRows; full/debug returns all candidates.")}).strict();function yi(e,t,n,o={}){let{warnings:r=[],notices:a=[],scanPolicy:i={},summary:s={},suggestedNextScopes:l=[],...c}=o;return rt({action:wc,reason:t,message:n,extra:{stage:e,reconciliationContractVersion:1,...c},summary:s,evidenceRows:[],scanPolicy:i,suggestedNextScopes:l,warnings:r,notices:a})}function Si(e,t,n={}){let{warnings:o=[],notices:r=[],scanPolicy:a={},summary:i={},suggestedNextScopes:s=[],...l}=n;return Xe({action:wc,error:t,extra:{stage:e,reconciliationContractVersion:1,...l},summary:i,evidenceRows:[],scanPolicy:a,suggestedNextScopes:s,warnings:o,notices:r})}function xc(e){return e.guarded===!0||e.state==="guarded"}function vc(e){return e.success===!1||e.state==="failed"||!!e.error}function Rn(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Of(...e){for(let t of e){let n=String(t.scanStoppedReason||"").trim();if(n&&n!=="completed")return n}return null}var Pf={requiredRoles:["identity","comparisonText"],optionalRoles:["code","description","quantity","unit","system","discipline","notes"]},Lf={rowsSource:{excel:{kind:"rows",sheetName:"Items",rows:[{Identity:"FCU-101",Description:"Fan coil supply DN100",Unit:"PCS"}],columnMapping:{identity:"Identity",comparisonText:"Description",unit:"Unit"}},schedule:{kind:"inspect_schedules_result",result:{success:!0,schedules:[{id:7001,name:"Mechanical Equipment Schedule",sections:[{section:"header",rows:[{row:0,cells:[{column:0,text:"Identity"},{column:1,text:"Description"}]}]},{section:"body",rows:[{row:1,cells:[{column:0,text:"FCU-101"},{column:1,text:"Fan coil supply DN100"}]}]}]}]}},responseMode:"compact"},fileSource:{excel:{kind:"file",path:"C:\\path\\items.xlsx",format:"xlsx",selection:{sheetName:"Items",headerRow:1,dataStartRow:2},columnMapping:{identity:"Identity",comparisonText:"Description"}},schedule:{kind:"inspect_schedules_result",result:'inspect_schedules result with responseMode="full" when schedule body cells are needed'}}};function Vf(e){return[e.bucket,e.reason,e.score,e.excelRow?.excelRowId??e.excelRow?.recordId??"",e.scheduleRow?.scheduleRowId??e.scheduleRow?.recordId??""].join("|")}function Df(e,t){let n=Array.isArray(t.columns)?t.columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}];return{...t,columns:n,rows:e.map(o=>({bucket:o.bucket,score:o.score,reason:o.reason,excelRowId:o.excelRow?.excelRowId??o.excelRow?.recordId??"",scheduleRowId:o.scheduleRow?.scheduleRowId??o.scheduleRow?.recordId??"",excelText:o.excelRow?[o.excelRow.identityText,o.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:o.scheduleRow?[o.scheduleRow.identityText,o.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:Array.isArray(o.hardConflicts)?o.hardConflicts.join(", "):"",recommendedNextAction:o.recommendedNextAction}))}}function Ff(e,t){let n=t.responseMode||"compact";if(tn(n))return{...e,responseMode:n};let o=bt(t.maxReviewRows,kf,1e3),r=nt(e.reviewRows,{limit:o,key:Vf}),a=nt(e.evidenceRows,{limit:o}),{reviewRows:i,reviewTable:s,scoringConfig:l,sourceSummary:c,...u}=e;return{...u,responseMode:"compact",reviewTable:Df(r.rows,e.reviewTable||{}),evidenceRows:a.rows,summary:{...e.summary||{},compactResponse:!0,reviewRowCount:r.totalCount,returnedReviewRowCount:r.returnedCount,omittedReviewRowCount:r.omittedCount,duplicateReviewRowCount:r.duplicateCount,evidenceRowCount:a.totalCount,returnedEvidenceRowCount:a.returnedCount,omittedEvidenceRowCount:a.omittedCount},notices:[...Rn(e.notices),'Compact response returns summary, reviewTable, evidenceRows, and count metadata only. Use responseMode="full" for reviewRows, token profiles, raw cells, and nested candidates.']}}async function jf(e,t={}){let n=In.safeParse(e);if(!n.success)return yi("input_validation","reconciliation_input_required","Provide excel and schedule sources before reconciliation.",{validationIssues:n.error.issues.map(l=>`${l.path.join(".")||"<root>"}: ${l.message}`),requiredColumnMapping:Pf,schemaExamples:Lf,suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText","schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let o=await nc(n.data.excel);if(xc(o))return yi("excel_ingestion",o.reason||"excel_ingestion_guarded",o.message||"Excel ingestion was guarded before reconciliation.",{excelResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});if(vc(o))return Si("excel_ingestion",o.error||"Excel ingestion failed before reconciliation.",{excelResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});let r=await uc(n.data.schedule,t.scheduleAdapter);if(xc(r))return yi("schedule_record_adapter",r.reason||"schedule_adapter_guarded",r.message||"Schedule adaptation was guarded before reconciliation.",{scheduleResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});if(vc(r))return Si("schedule_record_adapter",r.error||"Schedule adaptation failed before reconciliation.",{scheduleResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});let a=_c({excelResult:o,scheduleResult:r,config:n.data.config}),i=o.partial===!0||r.partial===!0,s=i&&Of(r,o)||a.scanStoppedReason;return Ff({...a,partial:a.partial===!0||i,scanStoppedReason:s,scanPolicy:{...a.scanPolicy||{},excel:o.scanPolicy||{},schedule:r.scanPolicy||{}},warnings:[...Rn(a.warnings),...Rn(o.warnings),...Rn(r.warnings)],notices:[...Rn(a.notices),...Rn(o.notices),...Rn(r.notices)],sourceSummary:{excel:o.summary||{},schedule:r.summary||{}},sourceResults:{excel:{sourceKind:o.sourceKind,format:o.format,sheetName:o.sheetName,partial:o.partial,scanStoppedReason:o.scanStoppedReason,recordCount:Array.isArray(o.excelRecords)?o.excelRecords.length:0},schedule:{sourceKind:r.sourceKind,visibilityBasis:r.visibilityBasis,partial:r.partial,scanStoppedReason:r.scanStoppedReason,recordCount:Array.isArray(r.scheduleRecords)?r.scheduleRecords.length:0}}},n.data)}function Cc(e){e.tool("reconcile_schedule_excel",'[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus either normalized inspect_schedules output or bounded live revit_schedule input, normalizes rows, scores deterministic matches, and returns compact review tables by default. excel.kind="rows" expects an object with rows:[...] plus columnMapping.identity and columnMapping.comparisonText; file sources use path/format/selection with the same required mapping. schedule.kind="revit_schedule" requires scheduleIds or nameQuery unless allowExpensiveSearch=true. schedule.columnHeaders can be an index-ordered string array, an array of {column, header} objects, or a header/index map; explicit headers override native header labels for string columnMapping resolution. If Body has no readable rows, headerDataMode="auto" reads Header section rows as schedule data and reports that fallback; use headerDataMode="never" to disable or "always" to force it. Default responseMode=compact returns summary, reviewTable, evidenceRows, and count metadata only; use responseMode=full/debug for reviewRows, token profiles, raw cells, and nested candidateRows. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.',{excel:In.shape.excel,schedule:In.shape.schedule,config:In.shape.config,responseMode:In.shape.responseMode,maxReviewRows:In.shape.maxReviewRows,maxCandidateRows:In.shape.maxCandidateRows},async(t={})=>{try{return b(await jf(t))}catch(n){return b(Si("runtime_failure",n instanceof Error?n.message:String(n)))}})}import{z as J}from"zod";var Bf={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxMatches:1e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxMatches:5e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxMatches:2e4}},$r=["sheetQuery","sheetIds","viewNameQuery","sources","profiles","countMode","groupBy","maxSheets","maxViewports","maxMatches","maxResponseBytes","allowExpensiveSearch"];function qe(e,t,n,o){if(e==null||e==="")return t;let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function Ic(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Bf[t],o=qe(e.maxElapsedMs,n.maxElapsedMs,1,119e3),r=qe(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,o+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(o,Math.max(1,r-1e3)),timeoutMs:r,maxMatches:qe(e.maxMatches,n.maxMatches,1,2e5)}}function qf(e){let t=String(e??"").trim();return/^sheet_?text_?notes?$/i.test(t)||/^sheetTextNotes?$/i.test(t)?"sheet_text_notes":/^viewport_?tags?$/i.test(t)||/^viewportTags?$/i.test(t)?"viewport_tags":/^viewport_?text_?notes?$/i.test(t)||/^viewportTextNotes?$/i.test(t)||/^view_?text_?notes?$/i.test(t)||/^viewTextNotes?$/i.test(t)?"viewport_text_notes":/^placed_?schedule_?cells?$/i.test(t)||/^placedScheduleCells?$/i.test(t)||/^schedule_?cells?$/i.test(t)||/^scheduleCells?$/i.test(t)?"placed_schedule_cells":t}function Tn(e){let t=String(e??"").trim();return/^unique_?text$/i.test(t)?"uniqueText":/^unique_?tag$/i.test(t)?"uniqueTag":/^unique_?tagged_?element$/i.test(t)?"uniqueTaggedElement":"occurrence"}function Rc(e){return e==="uniqueTag"||e==="uniqueTaggedElement"}function Wr(e,t,n,o){return e==="deep"?o:e==="balanced"?n:t}function bi(e){let t=Tn(e.countMode),n=Array.isArray(e.sources)?e.sources:[],o=[...new Set(n.map(qf).filter(r=>r.length>0))];return o.length>0?o:Rc(t)?["viewport_tags"]:["sheet_text_notes","viewport_text_notes","placed_schedule_cells","viewport_tags"]}function zf(e){return Array.isArray(e.sources)&&e.sources.length>0}function Tc(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||"").trim())}function _i(e){let t=Ic(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,sources:bi(e),countMode:Tn(e.countMode),groupBy:Array.isArray(e.groupBy)?e.groupBy:[],maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,maxSheets:qe(e.maxSheets,30,1,200),maxViewportsPerSheet:qe(e.maxViewportsPerSheet??e.maxViewports,20,0,200),maxTextNotesScanned:qe(e.maxTextNotesScanned,Wr(t.searchBudget,1e3,5e3,2e4),1,2e5),maxTagsScanned:qe(e.maxTagsScanned??e.maxTags,Wr(t.searchBudget,500,2500,1e4),1,1e5),maxScheduleInstancesPerSheet:qe(e.maxScheduleInstancesPerSheet,20,0,200),maxRowsPerSchedule:qe(e.maxRowsPerSchedule,250,1,2e3),maxColumnsPerSchedule:qe(e.maxColumnsPerSchedule,20,1,200),maxScheduleInstancesScanned:qe(e.maxScheduleInstancesScanned,Wr(t.searchBudget,200,1e3,5e3),1,2e4),maxScheduleCellsScanned:qe(e.maxScheduleCellsScanned,Wr(t.searchBudget,1e3,5e3,2e4),1,2e5),maxMatches:t.maxMatches,maxTextChars:qe(e.maxTextChars,240,1,1e3),maxRegexPatternLength:qe(e.maxRegexPatternLength,240,1,1e3),regexTimeoutMs:qe(e.regexTimeoutMs,25,1,250),maxResponseBytes:qe(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),sheetScoped:Tc(e)}}function Uf(e,t){return{query:e.query,regex:e.regex,normalizedRegex:e.normalizedRegex,matchMode:e.matchMode,sheetQuery:e.sheetQuery,sheetIds:e.sheetIds,viewNameQuery:e.viewNameQuery,sources:bi(e),profiles:e.profiles,profileName:e.profileName,countMode:Tn(e.countMode),groupBy:e.groupBy,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSheets:e.maxSheets,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxTags:e.maxTags,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxMatches:t.maxMatches,maxTextChars:e.maxTextChars,maxRegexPatternLength:e.maxRegexPatternLength,regexTimeoutMs:e.regexTimeoutMs,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Count Revit annotations",taskId:e.taskId}}function Hr(e){let t=String(d(e,"sourceType")||""),n=String(d(e,"kind")||""),o=[t,n];return o.some(r=>r==="viewportTag"||r==="viewport_tags")?"viewportTag":o.some(r=>r==="viewportTextNote"||r==="viewport_text_notes")?"viewportTextNote":o.some(r=>r==="sheetTextNote"||r==="sheet_text_notes")?"sheetTextNote":o.some(r=>r==="placedScheduleCell"||r==="placed_schedule_cells"||r==="scheduleCell")?"placedScheduleCell":t||n||"annotation"}function Gr(e){let t=F(e,"evidenceRows");return(t.length>0?t:F(e,"matches")).map(o=>({...o,sourceType:Hr(o)}))}function Wf(e){let t=String(e??"").trim();return/^source_?type$/i.test(t)?"sourceType":/^(profile|profileName)$/i.test(t)?"profile":/^(pattern|patternName)$/i.test(t)?"pattern":/^(matchedCode|matchedText|uniqueText)$/i.test(t)?"matchedText":/^tagFamilyType$/i.test(t)?"tagFamilyType":/^(taggedElement|taggedElementId)$/i.test(t)?"taggedElement":/^view$/i.test(t)?"view":/^sheet$/i.test(t)?"sheet":t}function $f(e,t){let n={};if(t.length===0)return n.group="all",n;for(let o of t){let r=Wf(o);r==="sheet"?(n.sheetId=d(e,"sheetId")??null,n.sheetNumber=d(e,"sheetNumber")??null):r==="view"?(n.viewId=d(e,"viewId")??null,n.viewName=d(e,"viewName")??null):r==="sourceType"?n.sourceType=Hr(e):r==="profile"?n.profileName=d(e,"profileName")??null:r==="pattern"?n.patternName=d(e,"patternName")??null:r==="matchedText"?n.matchedTextNormalized=d(e,"matchedTextNormalized")??null:r==="tagFamilyType"?(n.tagFamilyName=d(e,"tagFamilyName")??null,n.tagTypeName=d(e,"tagTypeName")??null):r==="taggedElement"&&(n.taggedElementId=d(e,"taggedElementId")??null)}return Object.keys(n).length===0&&(n.group="all"),n}function Hf(e){return Object.keys(e).sort().map(t=>`${t}=${String(e[t]??"")}`).join("|")}function Gf(e,t){let n=Hr(e);if(t==="occurrence")return"";if(t==="uniqueText")return`profile:${String(d(e,"profileName")??"").trim()}|text:${String(d(e,"matchedTextNormalized")??d(e,"textNormalized")??"").trim()}`;if(t==="uniqueTag"){if(n!=="viewportTag")return"";let o=String(d(e,"tagId")??"").trim();return o?`tag:${o}`:""}if(t==="uniqueTaggedElement"){if(n!=="viewportTag")return"";let o=d(e,"taggedElementResolved"),r=String(d(e,"taggedElementId")??"").trim();return!o||!r?"":`taggedElement:${r}`}return""}function Ec(e,t,n){let o=new Map,r=new Set,a=0,i=0,s=e.map(l=>{let c={...l,sourceType:Hr(l)},u=$f(c,n),m=Hf(u),g=o.get(m);g||(g={groupKey:m,...u,count:0,occurrenceCount:0,evidenceRowCount:0},o.set(m,g)),g.occurrenceCount+=1,g.evidenceRowCount+=1;let p=t==="occurrence"?`occurrence:${i++}`:Gf(c,t),y=!!p&&!r.has(`${m}||${p}`);return y&&(r.add(`${m}||${p}`),g.count+=1,a+=1),{...c,groupKey:m,countKey:p,counted:y,countMode:t}});return{count:a,evidenceRows:s,groups:[...o.values()].sort((l,c)=>String(l.groupKey).localeCompare(String(c.groupKey)))}}function Nc(e,t){let n=Hn(e,"scanPolicy"),o=d(n,"groupBy")??d(e,"groupBy")??t?.groupBy;return Array.isArray(o)?o.map(String):[]}function Mc(e,t){return Tn(d(e,"countMode")??d(Hn(e,"summary"),"countMode")??t?.countMode)}function Ac(e,t){let n=Gr(e),o=Mc(e,t),r=Ec(n,o,Nc(e,t));return{count:d(e,"count")??r.count,countMode:o,occurrenceCount:d(e,"matchedOccurrenceCount")??r.evidenceRows.length,matchCount:r.evidenceRows.length,evidenceRowCount:r.evidenceRows.length,groupCount:F(e,"groups").length||r.groups.length,scannedSheetCount:d(e,"scannedSheetCount")??null,scannedViewportCount:d(e,"scannedViewportCount")??null,scannedTextNoteCount:d(e,"scannedTextNoteCount")??null,scannedTagCount:d(e,"scannedTagCount")??null,scannedScheduleInstanceCount:d(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:d(e,"scannedScheduleCellCount")??null,partial:d(e,"partial")===!0,scanStoppedReason:d(e,"scanStoppedReason")??"completed"}}function Jf(e){let t=Gr(e),n=t.length>0?t[t.length-1]:null;return{lastReadSection:d(e,"lastReadSection")??null,lastReadRow:d(e,"lastReadRow")??null,lastReadColumn:d(e,"lastReadColumn")??null,lastReadSheetId:d(n,"sheetId")??d(e,"lastReadSheetId")??null,lastReadViewId:d(n,"viewId")??d(e,"lastReadViewId")??null,lastReadViewportId:d(n,"viewportId")??d(e,"lastReadViewportId")??null,lastReadItemId:d(n,"tagId")??d(n,"elementId")??d(n,"scheduleInstanceId")??d(n,"scheduleId")??d(n,"id")??d(e,"lastReadItemId")??null}}function Kf(e,t){let n=Mc(e,t),o=Ec(Gr(e),n,Nc(e,t)),r=F(e,"groups");return e.countMode=n,e.evidenceRows=o.evidenceRows,e.matches=F(e,"matches").length>0?F(e,"matches"):e.evidenceRows,e.groups=r.length>0?r:o.groups,e.count=d(e,"count")??d(e.summary,"count")??o.count,e.summary={...Ac(e,t),...Hn(e,"summary")||{},count:d(e.summary,"count")??e.count,countMode:n,matchCount:d(e.summary,"matchCount")??e.evidenceRows.length,groupCount:d(e.summary,"groupCount")??e.groups.length},e}function Xf(e,t={},n){return Kf(Le(e,{action:"count_annotations",elapsedMs:n,scanPolicy:_i(t),summary:o=>Ac(o,t),evidenceRows:Gr,lastRead:Jf,suggestedNextScopes:$r}),t)}function Yf(e,t){return rt({action:"count_annotations",reason:"needs_scope",message:"Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:$r,scanPolicy:_i({...e,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs}),summary:{count:0,countMode:Tn(e.countMode),matchCount:0,groupCount:0}})}function Qf(e){return rt({action:"count_annotations",reason:"invalid_count_mode_for_sources",message:"uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",suggestedNextScopes:$r,scanPolicy:_i(e),summary:{count:0,countMode:Tn(e.countMode),matchCount:0,groupCount:0}})}function kc(e){e.tool("count_annotations","[ANNOTATION_COUNT_READ_ONLY] Read-only native Revit annotation inventory/count for DrawingSheet text notes, viewport text notes, placed schedule cells, and viewport tag evidence. Use sheetQuery/sheetIds first; project-wide annotation counts require allowExpensiveSearch=true. Supports occurrence, uniqueText, uniqueTag, and uniqueTaggedElement count modes with bounded regex profiles.",{...P(J),...L(J),query:J.string().optional().describe("Anonymous text query. Defaults to contains matching unless matchMode is supplied."),regex:J.string().optional().describe("Anonymous raw regex pattern. Regex matching is bounded by maxRegexPatternLength and regexTimeoutMs."),normalizedRegex:J.string().optional().describe("Anonymous regex pattern evaluated against normalized annotation text."),matchMode:J.enum(["exact","contains","startsWith","regex","normalizedRegex"]).optional().describe("Match mode for query when using the anonymous profile."),profileName:J.string().optional().describe("Optional anonymous profile name when query/regex is used without profiles."),profiles:J.array(J.any()).optional().describe("Explicit profile objects with profileName/name and patterns. Patterns support exact, contains, startsWith, regex, and normalizedRegex."),sheetQuery:J.string().optional().describe("Sheet number/name scope. Use this first in large projects."),sheetIds:J.array(J.union([J.number(),J.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),viewNameQuery:J.string().optional().describe("Optional placed-view name filter before viewport tag inspection."),sources:J.array(J.enum(["sheet_text_notes","viewport_text_notes","viewport_text_note","placed_schedule_cells","placed_schedule_cell","viewport_tags","sheetTextNotes","viewportTextNotes","viewportTextNote","view_text_notes","viewTextNotes","placedScheduleCells","placedScheduleCell","schedule_cells","schedule_cell","scheduleCells","scheduleCell","viewportTags"])).optional().describe("Annotation sources. Defaults to sheet_text_notes + viewport_text_notes + placed_schedule_cells + viewport_tags except tag-specific count modes, which default to viewport_tags."),countMode:J.enum(["occurrence","uniqueText","uniqueTag","uniqueTaggedElement"]).optional().describe("Count semantics. Tag-specific modes require viewport_tags as the only explicit source."),groupBy:J.array(J.enum(["sheet","view","sourceType","profile","profileName","pattern","patternName","matchedText","matchedCode","tagFamilyType","taggedElement","taggedElementId"])).optional().describe("Optional grouping dimensions for count rows."),allowExpensiveSearch:J.boolean().optional().describe("Explicit approval for project-wide sheet and placed-view annotation counting without sheetIds/sheetQuery. Defaults false."),searchBudget:J.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:J.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),maxSheets:J.number().int().positive().max(200).optional().describe("Maximum matching sheets to inspect. Defaults 30."),maxViewportsPerSheet:J.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:J.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet."),maxTextNotesScanned:J.number().int().positive().max(2e5).optional().describe("Global native cap across sheet text notes."),maxScheduleInstancesPerSheet:J.number().int().min(0).max(200).optional().describe("Maximum placed schedule instances inspected per sheet. Defaults 20."),maxRowsPerSchedule:J.number().int().positive().max(2e3).optional().describe("Maximum body rows scanned per placed schedule. Defaults 250."),maxColumnsPerSchedule:J.number().int().positive().max(200).optional().describe("Maximum body columns scanned per placed schedule. Defaults 20."),maxScheduleInstancesScanned:J.number().int().positive().max(2e4).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:J.number().int().positive().max(2e5).optional().describe("Global native cap across placed schedule body cells before scanStoppedReason=max_cells."),maxTags:J.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:J.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxMatches:J.number().int().positive().max(2e5).optional().describe("Maximum returned matching evidence rows before scanStoppedReason=max_items."),maxTextChars:J.number().int().min(1).max(1e3).optional().describe("Maximum characters retained and matched per annotation candidate. Defaults 240."),maxRegexPatternLength:J.number().int().min(1).max(1e3).optional().describe("Maximum regex pattern length. Defaults 240."),regexTimeoutMs:J.number().int().min(1).max(250).optional().describe("Per-candidate regex timeout in milliseconds. Defaults 25."),maxResponseBytes:J.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:J.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let o=Ic(t),r=bi(t),a=Tn(t.countMode);if(Rc(a)&&zf(t)&&r.some(s=>s!=="viewport_tags"))return b(Qf(t));if(!Tc(t)&&t.allowExpensiveSearch!==!0)return b(Yf(t,o));let i=await U("count_annotations",Uf(t,o),{...z({...t,timeoutMs:o.timeoutMs},"Count Revit annotations"),toolName:"count_annotations"});return b(Xf(i&&i.result?i.result:i,t,Date.now()-n))}catch(o){return b(Xe({action:"count_annotations",error:o instanceof Error?o.message:String(o),elapsedMs:Date.now()-n,suggestedNextScopes:$r}))}})}import{z as dt}from"zod";function Zf(e){let t=xr(e.elementIds||[]),n=G(e.category||""),o=Number.isFinite(e.sampleLimit)?Math.max(1,Math.min(25,e.sampleLimit)):5,r=e.includeTypeParameters===!0?"true":"false",a=St(e.parameterNameFilter||[]),i=e.parameterNameMatchMode==="exact"?"exact":"contains";return`
int[] explicitElementIds = ${t};
string categoryName = ${n};
int sampleLimit = ${o};
bool includeTypeParameters = ${r};
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
}`}function ey(e){return!e||typeof e!="object"?{}:{source:e.source,displayBuiltInParameter:e.displayBuiltInParameter,builtInParameterId:e.builtInParameterId,rawBuiltInParameterAlias:e.rawBuiltInParameterAlias,storageType:e.storageType,isShared:e.isShared,isReadOnly:e.isReadOnly,dataType:e.dataType,unitType:e.unitType,noValueState:e.noValueState,clearability:e.clearability}}function ty(e,t){if(t.parameterNameMatchMode!=="exact"||!e||typeof e!="object"||!Array.isArray(e.elements))return e;let n=[],o=Array.isArray(e.warnings)?[...e.warnings]:[];for(let r of e.elements){let a=Array.isArray(r?.parameters)?r.parameters:[],i=new Map;for(let s of a){let l=typeof s?.name=="string"?s.name.trim():"";if(!l)continue;let c=l.toLocaleLowerCase("en-US");i.has(c)||i.set(c,{name:l,matches:[]}),i.get(c)?.matches.push(s)}for(let s of i.values()){if(s.matches.length<2)continue;let l={elementId:r?.id,parameterName:s.name,count:s.matches.length,severity:"write_preflight_warning",message:`Duplicate display name '${s.name}' matched ${s.matches.length} parameters on element ${r?.id}. Display name alone is ambiguous for write-back; choose by source, builtInParameterId, shared flag, storage type, or read-only state.`,matches:s.matches.map(ey)};n.push(l),o.push(`duplicate_display_name: elementId=${r?.id}; parameterName=${s.name}; count=${s.matches.length}; display name alone is ambiguous for write-back.`)}}return n.length===0?e:{...e,warnings:o,duplicateDisplayNameWarnings:n}}function Oc(e){e.tool("inspect_parameter_schema","Read-only parameter schema inspection for selected ids or a category sample: user-facing BIP display label/id, raw enum alias, storage type, unit type, shared/read-only flags, raw/display values, no-value state, and clearability metadata.",{...P(dt),...L(dt),elementIds:dt.array(dt.union([dt.number(),dt.string()])).optional().describe("Element ids to inspect."),category:dt.string().optional().describe("BuiltInCategory name such as OST_DuctCurves or OST_DuctTerminal."),sampleLimit:dt.number().int().positive().max(25).optional().describe("Maximum sample elements. Defaults 5."),includeTypeParameters:dt.boolean().optional().describe("Include type parameters. Defaults false."),parameterNameFilter:dt.array(dt.string()).optional().describe("Optional parameter name filters."),parameterNameMatchMode:dt.enum(["contains","exact"]).optional().describe("Filter matching mode. contains is discovery mode and default; exact is write-preflight mode.")},async t=>{if((!t.elementIds||t.elementIds.length===0)&&!t.category)return b({success:!0,matchMode:t.parameterNameMatchMode==="exact"?"exact":"contains",sampleCount:0,elements:[],warnings:["Provide elementIds or category."]});try{let n=await Ce(Zf(t),{...z(t,"Inspect Revit parameter schema"),transactionMode:"none"}),o=n&&n.result?n.result:n;return b(ty(o,t))}catch(n){return b({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as _e}from"zod";function Lc(e){return e==="clear"?"clear":e==="clearVisibleValue"?"clearVisibleValue":"set"}function Pc(e){return typeof e=="boolean"?e?"true":"false":String(e??"")}async function ny(e,t){if(e.elementId!==void 0&&e.elementId!==null&&String(e.elementId).trim()!==""){let n=Number.parseInt(String(e.elementId),10);return Number.isFinite(n)&&n>0?n:null}if(e.useSelection===!0){let n=await qn(2,t);return n.length===1?n[0]:{...Et({action:"set_element_parameter",reason:"single_selection_required",error:n.length===0?"No selected Revit element was found. Provide elementId or select exactly one element.":"Multiple selected elements were found. Provide one explicit elementId for a production parameter write."}),tool:"set_element_parameter",guardReason:"single_selection_required",selectedElementIds:n}}return null}function oy(e,t){let n=Lc(e.operation),o=G(e.parameterName||""),r=G(e.parameterSource||"instance"),a=G(n==="clearVisibleValue"?"":Pc(e.value)),i=G(e.valueMode||"raw"),s=G(e.mode==="commit"?"commit":"dryRun"),l=G(n),c=e.value===void 0||e.value===null?"false":"true",u=Number.isInteger(e.builtInParameterId)?String(e.builtInParameterId):"null",m=G(e.expectedStorageType||""),g=G(e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"":Pc(e.expectedCurrentRaw)),p=e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"false":"true",y=e.allowTypeParameterWrite===!0?"true":"false";return`
int elementId = ${t};
string parameterName = ${o};
string parameterSource = ${r};
string requestedValueText = ${a};
string valueMode = ${i};
string mode = ${s};
string operation = ${l};
int? expectedBuiltInParameterId = ${u};
string expectedStorageType = ${m};
bool hasExpectedCurrentRaw = ${p};
string expectedCurrentRaw = ${g};
bool allowTypeParameterWrite = ${y};
bool hasRequestedValue = ${c};
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
}`}function Vc(e){e.tool("set_element_parameter","[PRODUCTION_PARAMETER_WRITE] Safely set, true-clear, or visibly clear one Revit element parameter after exact inspect_parameter_schema-style identity resolution. Never writes by visible display name alone: duplicate display names, read-only parameters, identity mismatch, unsupported clear/no-value attempts, and unapproved type-parameter writes are guarded. operation=clear uses Revit Parameter.ClearValue only for parameter kinds that can restore a true no-value state and never fakes no-value restore by writing an empty string. operation=clearVisibleValue is an explicit string-only visible cleanup path that writes an empty string and reports that Revit may keep HasValue=true. Defaults to dryRun; use mode=commit only for an explicitly confirmed write, then the tool reads the parameter back for verification.",{...P(_e),...L(_e),elementId:_e.union([_e.number(),_e.string()]).optional().describe("Target Revit ElementId. Preferred for production writes."),useSelection:_e.boolean().optional().describe("When true, use the current Revit selection only if exactly one element is selected. Defaults false."),parameterName:_e.string().describe("Exact visible parameter name used only for schema preflight. The tool enumerates matching parameters and blocks duplicates; it does not use LookupParameter as a direct write shortcut."),parameterSource:_e.enum(["instance","type"]).optional().default("instance").describe("Write an instance parameter by default. Type parameters require allowTypeParameterWrite=true in commit mode."),builtInParameterId:_e.number().int().optional().describe("Optional stable BuiltInParameter integer from inspect_parameter_schema. If supplied, it must match the exact display-name result."),expectedStorageType:_e.enum(["String","Integer","Double","ElementId"]).optional().describe("Optional storage-type guard from inspect_parameter_schema."),expectedCurrentRaw:_e.union([_e.string(),_e.number(),_e.boolean()]).optional().describe("Optional compare-and-set guard. Commit is blocked if the current raw value differs."),operation:_e.enum(["set","clear","clearVisibleValue"]).optional().default("set").describe("set writes the supplied value. clear uses Revit Parameter.ClearValue only when the parameter kind supports true no-value restore and never falls back to writing an empty string. clearVisibleValue explicitly writes an empty string to a String parameter and may leave HasValue=true."),value:_e.union([_e.string(),_e.number(),_e.boolean()]).optional().describe("Requested value for operation=set. String writes use the text as-is; Integer accepts number/true/false; Double defaults to raw Revit internal units; ElementId accepts an integer id."),valueMode:_e.enum(["raw","valueString"]).optional().default("raw").describe("For Double parameters, raw writes internal Revit units. valueString uses Parameter.SetValueString with project units."),mode:_e.enum(["dryRun","commit"]).optional().default("dryRun").describe("dryRun performs schema/convertibility checks only. commit writes inside the wrapper transaction and verifies readback."),allowTypeParameterWrite:_e.boolean().optional().default(!1).describe("Required to commit a type-parameter write because it can affect all instances of that type."),timeoutMs:_e.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults to the runtime default.")},async t=>{let n=Pe(t);try{let o=await ny(t,n);if(!o||typeof o=="object")return b(o||{...Et({action:"set_element_parameter",reason:"element_id_required",error:"Provide elementId or set useSelection=true with exactly one selected element."}),guardReason:"element_id_required",tool:"set_element_parameter"});let r=t.mode==="commit"?"commit":"dryRun",a=Lc(t.operation);if(a==="set"&&(t.value===void 0||t.value===null))return b({...Et({action:"set_element_parameter",reason:"value_required",error:"value is required when operation=set. Use operation=clear only when you intentionally want to restore a true no-value state, or operation=clearVisibleValue when a visible empty string is acceptable."}),guardReason:"value_required",tool:"set_element_parameter",mode:r,operation:a});let i=await Ce(oy(t,o),{...n,...et(t,r==="commit"?a==="clear"?"Clear Revit element parameter":a==="clearVisibleValue"?"Visibly clear Revit element parameter":"Set Revit element parameter":a==="clear"?"Dry-run Revit element parameter clear":a==="clearVisibleValue"?"Dry-run visible Revit element parameter clear":"Dry-run Revit element parameter write"),transactionMode:r==="commit"?"auto":"none"});return b(i&&i.result?i.result:i)}catch(o){return b(ct({action:"set_element_parameter",error:o instanceof Error?o.message:String(o),extra:{tool:"set_element_parameter"}}))}})}import{z as He}from"zod";function Dc(e){return`new int[] { ${e.map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function ry(e){return`new bool[] { ${e.map(t=>t?"true":"false").join(", ")} }`}function ay(e){return(Array.isArray(e.cells)?e.cells:[]).slice(0,200).map(n=>({row:Math.max(0,Number.parseInt(String(n.row),10)||0),column:Math.max(0,Number.parseInt(String(n.column),10)||0),value:String(n.value??""),hasExpectedCurrentText:n.expectedCurrentText!==void 0&&n.expectedCurrentText!==null,expectedCurrentText:String(n.expectedCurrentText??"")}))}function iy(e){let t=Number.parseInt(String(e.scheduleId),10),n=ay(e),o=G(e.section),r=G(e.mode==="commit"?"commit":"dryRun"),a=e.allowCurrentMismatch===!0?"true":"false";return`
int scheduleId = ${Number.isFinite(t)?t:0};
string requestedSection = ${o};
string mode = ${r};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowCurrentMismatch = ${a};
int[] rows = ${Dc(n.map(i=>i.row))};
int[] columns = ${Dc(n.map(i=>i.column))};
string[] requestedValues = ${St(n.map(i=>i.value))};
bool[] hasExpectedCurrentTexts = ${ry(n.map(i=>i.hasExpectedCurrentText))};
string[] expectedCurrentTexts = ${St(n.map(i=>i.expectedCurrentText))};

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
}`}function Fc(e){e.tool("set_schedule_cells","[PRODUCTION_SCHEDULE_CELL_WRITE] Writes exact Revit schedule cells by scheduleId, section, row, and column. Defaults to dryRun, blocks mismatched expectedCurrentText, guards non-writable standard schedule body cells as non_writable_standard_body_cell, and verifies committed values. Change rows expose actualAfter (observed value), projectedAfter (requested target), and wouldChange; legacy after/changed fields remain for compatibility and are marked deprecated by changeFieldContract. Schedule cell text writes are not a raw-code reason: use this after inspect_schedules has found exact row/column coordinates for renumbering, title/spec/mark edits, key schedule/header/footer cells, or other direct cell text updates. Do not use this for visual schedule formatting such as borders, merges, colors, row heights, column widths, or placed schedule movement.",{...P(He),...L(He),scheduleId:He.union([He.number(),He.string()]).describe("Exact ViewSchedule element id. Schedule names are not accepted for writes."),section:He.enum(["header","body","footer"]).describe("Exact schedule section containing the target cells."),cells:He.array(He.object({row:He.number().int().min(0).describe("Zero-based row index in the selected schedule section."),column:He.number().int().min(0).describe("Zero-based column index in the selected schedule section."),value:He.string().describe("Target cell text."),expectedCurrentText:He.string().optional().describe("Optional exact preflight value. Commit is blocked if current text differs unless allowCurrentMismatch=true.")})).min(1).max(200).describe("Exact cells to update. Use inspect_schedules first to discover row/column coordinates."),mode:He.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes schedule cell text in one Revit transaction."),allowCurrentMismatch:He.boolean().optional().describe("Defaults false. Keep false for production writes so stale row/column targets are blocked."),timeoutMs:He.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",o=await Ce(iy(t),{...Pe(t),...et(t,n==="commit"?"Set Revit schedule cells":"Preview Revit schedule cell changes"),toolName:"set_schedule_cells",transactionMode:n==="commit"?"auto":"none"});return b(o&&o.result?o.result:o)}catch(n){return b(ct({action:"set_schedule_cells",reason:"set_schedule_cells_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as ae}from"zod";var sy=25;function jc(e,t=100){return(Array.isArray(e)?e:[]).slice(0,t).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n))}function Bc(e){return`new int[] { ${e.join(", ")} }`}function ly(e){let t=[];if(typeof e.rowTextQuery=="string"&&e.rowTextQuery.trim()&&t.push(e.rowTextQuery.trim()),Array.isArray(e.rowTextQueries))for(let n of e.rowTextQueries){let o=String(n??"").trim();o&&t.push(o)}return[...new Set(t)].slice(0,20)}function cy(e,t){let n=Array.isArray(e)?[...new Set(e.map(o=>String(o??"").trim()).filter(o=>o.length>0))]:[];return{rows:n.slice(0,t),totalCount:Array.isArray(e)?e.length:0,uniqueCount:n.length,returnedCount:Math.min(n.length,t),omittedCount:Math.max(0,n.length-t)}}function uy(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||tn(n))return{...e,responseMode:n};let o=bt(t.maxResultRows,sy,500),r=nt(e.matches,{limit:o}),a=nt(e.changes,{limit:o}),i=cy(e.errors,o),s={...e,responseMode:"compact",compactResponse:!0,maxReturnedRows:o};return Array.isArray(e.matches)&&(s.matches=r.rows,s.returnedMatchCount=r.returnedCount,s.omittedMatchCount=r.omittedCount,s.duplicateMatchCount=r.duplicateCount),Array.isArray(e.changes)&&(s.changes=a.rows,s.returnedChangeCount=a.returnedCount,s.omittedChangeCount=a.omittedCount,s.duplicateChangeCount=a.duplicateCount),Array.isArray(e.errors)&&(s.errors=i.rows,s.returnedErrorCount=i.returnedCount,s.omittedErrorCount=i.omittedCount),s.notices=[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds matches/changes/errors. Use responseMode="full" for all row details.'],s}function dy(e){let t=jc(e.scheduleIds,200),n=jc(e.sheetIds,200),o=ly(e),r=Number.parseInt(String(e.targetColumn),10),a=Math.max(1,Math.min(Number.parseInt(String(e.maxSchedules??20),10)||20,200)),i=Math.max(1,Math.min(Number.parseInt(String(e.maxRowsPerSchedule??250),10)||250,2e3)),s=Math.max(1,Math.min(Number.parseInt(String(e.maxColumnsPerSchedule??80),10)||80,300)),l=Math.max(1,Math.min(Number.parseInt(String(e.maxMatches??50),10)||50,500)),c=e.mode==="commit"?"commit":"dryRun",u=e.section||"body",m=e.rowMatchMode==="any"?"any":"all",g=e.allowMultipleMatches===!0?"true":"false",p=e.allowCurrentMismatch===!0?"true":"false",y=e.expectedCurrentText!==void 0&&e.expectedCurrentText!==null?"true":"false",f=G(e.expectedCurrentText??"");return`
int[] exactScheduleIds = ${Bc(t)};
int[] exactSheetIds = ${Bc(n)};
string scheduleNameQuery = ${G(e.scheduleNameQuery||e.scheduleQuery||"")};
string sheetQuery = ${G(e.sheetQuery||"")};
string requestedSection = ${G(u)};
string[] rowTextQueries = ${St(o)};
string rowMatchMode = ${G(m)};
int targetColumn = ${Number.isFinite(r)?r:-1};
string requestedValue = ${G(e.value??"")};
string mode = ${G(c)};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowMultipleMatches = ${g};
bool allowCurrentMismatch = ${p};
bool hasExpectedCurrentText = ${y};
string expectedCurrentText = ${f};
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
}`}function qc(e){e.tool("set_schedule_cells_by_text","[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT] Finds bounded schedule rows by sheet/schedule filters and row text, then previews or commits a target column update with readback verification. Guards non-writable standard schedule body cells as non_writable_standard_body_cell. Prefer this over generic send_code_to_revit for repeated schedule row text writes. Schedule cell text writes are not a raw-code reason: use this when the user identifies the target row by visible row text, item code, equipment tag, or schedule line label and the requested change is a direct cell text value. Keep allowMultipleMatches=false unless every matched row is intended; use dryRun first to resolve ambiguity.",{...P(ae),...L(ae),scheduleIds:ae.array(ae.union([ae.number(),ae.string()])).optional().describe("Exact ViewSchedule ids to inspect. Preferred when known."),scheduleNameQuery:ae.string().optional().describe("Bounded schedule name filter. Use this before broad row text matching."),scheduleQuery:ae.string().optional().describe("Alias for scheduleNameQuery."),sheetIds:ae.array(ae.union([ae.number(),ae.string()])).optional().describe("Exact ViewSheet ids whose placed schedules should be inspected."),sheetQuery:ae.string().optional().describe("Sheet number/name filter whose placed schedules should be inspected."),section:ae.enum(["header","body","footer"]).optional().describe("Schedule section to search and write. Defaults to body."),rowTextQuery:ae.string().optional().describe("Text that must appear in the row. Combine with rowTextQueries for safer matching."),rowTextQueries:ae.array(ae.string()).optional().describe("All row text terms to match by default. Use rowMatchMode=any to match any term."),rowMatchMode:ae.enum(["all","any"]).optional().describe("Defaults to all. all requires every rowTextQuery term to match the row text."),targetColumn:ae.number().int().min(0).describe("Zero-based target column to write in each matched row."),value:ae.string().describe("Target cell text."),expectedCurrentText:ae.string().optional().describe("Optional compare-and-set guard for the target cell text."),allowCurrentMismatch:ae.boolean().optional().describe("Defaults false. Keep false for production writes so stale target cells are blocked."),allowMultipleMatches:ae.boolean().optional().describe("Defaults false. Required when more than one row match should be updated."),mode:ae.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes all matched cells in one wrapper transaction."),maxSchedules:ae.number().int().positive().max(200).optional().describe("Maximum candidate schedules to inspect. Defaults 20."),maxRowsPerSchedule:ae.number().int().positive().max(2e3).optional().describe("Maximum rows scanned per schedule. Defaults 250."),maxColumnsPerSchedule:ae.number().int().positive().max(300).optional().describe("Maximum columns read when matching row text. Defaults 80."),maxMatches:ae.number().int().positive().max(500).optional().describe("Maximum matching rows returned or written. Defaults 50."),responseMode:en,maxResultRows:ae.number().int().positive().max(500).optional().describe("Compact-mode cap for matches/changes/errors returned to the client. Defaults 25; full/debug returns all rows within maxMatches."),timeoutMs:ae.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",o=t.scheduleNameQuery||t.scheduleQuery,r=await Ce(dy({...t,scheduleNameQuery:o}),{...Pe(t),...et(t,n==="commit"?"Set Revit schedule cells by text":"Preview Revit schedule row text changes"),toolName:"set_schedule_cells_by_text",transactionMode:n==="commit"?"auto":"none"});return b(uy(r&&r.result?r.result:r,t))}catch(n){return b(ct({action:"set_schedule_cells_by_text",reason:"set_schedule_cells_by_text_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as on}from"zod";var my=`
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
}`;function py(e){let t=jt(e);return t&&typeof t=="object"&&t.result?t.result:t}async function gy(e,t){let n=null;try{n=await ht(async r=>await r.sendCommand("mcp_status",{},{timeoutMs:t,statusPreflight:!1}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(t,500),logSocketErrors:!1,skipLock:!0})}catch(r){return{reachable:!1,target:{name:e.name,host:e.host,port:e.port,source:e.source},error:r instanceof Error?r.message:String(r)}}let o=Math.max(t,1e4);try{let r=await ht(async(a,i)=>await a.sendCommand("send_code_to_revit",{code:my,parameters:[`${i.host}:${i.port}`],transactionMode:"none",taskName:"Probe Revit instance"},{timeoutMs:o}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(o,500),logSocketErrors:!1});return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:No(n,{recentLimit:3,includeDiagnostics:!1}),info:py(r)}}catch(r){return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:No(n,{recentLimit:3,includeDiagnostics:!1}),info:null,infoError:r instanceof Error?r.message:String(r)}}}function zc(e){e.tool("list_revit_instances","Discover reachable revAgent Revit bridge instances by probing configured ports. Use this before targeting a specific Revit instance.",{host:on.string().optional().describe("Host to scan. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),ports:on.array(on.union([on.number(),on.string()])).optional().describe("Ports to scan. Defaults to REVAGENT_PORTS, then legacy REVIT_MCP_PORTS, or 8080-8085."),includeRegistry:on.boolean().optional().describe("Include targets from the revAgent instance registry file. Defaults true."),includeUnreachable:on.boolean().optional().describe("Include unreachable ports in the result. Defaults false."),timeoutMs:on.number().int().positive().max(15e3).optional().describe("Per-port connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.timeoutMs||3e3,o=gs({host:t.host,ports:t.ports,includeRegistry:t.includeRegistry}),r=[];for(let a of o){let i=await gy(a,n);(i.reachable||t.includeUnreachable)&&r.push(i)}return b({success:!0,count:r.filter(a=>a.reachable).length,scanned:o.length,instances:r})})}import nu from"node:path";import{z as sn}from"zod";import Ti from"better-sqlite3";import{copyFileSync as fy,existsSync as oa,mkdirSync as Wc,readdirSync as yy,rmSync as ao,statSync as Qr}from"node:fs";import{homedir as Sy}from"node:os";import{spawnSync as by}from"node:child_process";import{basename as _y,dirname as ki,isAbsolute as xy,join as Zr,parse as Kc,relative as vy,resolve as rn}from"node:path";function Jr(e){let t=e.linkInstanceUniqueId?.trim()||"host";return`${e.documentKey}::${t}`}import Uc from"node:crypto";function Ge(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}function xe(e){if(e===null)return"null";if(typeof e=="number"){if(!Number.isFinite(e))throw new TypeError("Spatial canonical JSON rejects non-finite numbers.");return JSON.stringify(Object.is(e,-0)?0:e)}return typeof e=="string"||typeof e=="boolean"?JSON.stringify(e):typeof e>"u"?"null":Array.isArray(e)?`[${e.map(xe).join(",")}]`:Ge(e)?`{${Object.keys(e).sort(fe).map(t=>`${JSON.stringify(t)}:${xe(e[t])}`).join(",")}}`:JSON.stringify(String(e))}function vt(e){return`sha256:${Uc.createHash("sha256").update(xe(e),"utf8").digest("hex")}`}function Wt(e){return`${e}:${Uc.randomUUID()}`}function fe(e,t){return e<t?-1:e>t?1:0}function K(e){let t=typeof e=="string"?e.trim():"";return t.length>0?t:null}function ze(e){if(typeof e!="number"&&(typeof e!="string"||e.trim().length===0))return null;let t=typeof e=="number"?e:Number(e.trim());return Number.isFinite(t)?t:null}function no(e){let t=ze(e);return t!==null&&Number.isSafeInteger(t)?t:null}function hy(e,...t){let n=e;for(let o of t){if(!Ge(n))return;n=n[o]}return n}function te(e,t){for(let n of t){let o=hy(e,...n);if(o!=null)return o}}function $t(e,t=1e4){return Array.isArray(e)?[...new Set(e.slice(0,t).map(K).filter(n=>n!==null))].sort(fe):[]}function ke(e,t,n,o){let r=no(e);return Math.max(n,Math.min(o,r??t))}var wy=1,Cy=2,Iy=30,Ry=20,Ty="REVAGENT_SPATIAL_RETENTION_DAYS",Ey="REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS",Ny="REVAGENT_SPATIAL_RETENTION_DISABLED",My=900*1e3,Ay=1440*60*1e3,ky=0,Oy=`
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
`,Py=`
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
`,Ly=`
  CREATE TABLE spatial_edges (
    edge_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    relation_policy_version TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    bidirectional INTEGER NOT NULL DEFAULT 0 CHECK (bidirectional IN (0, 1)),
    payload_json TEXT NOT NULL,
    UNIQUE (snapshot_id, source_node_id, target_node_id, relation_type),
    UNIQUE (snapshot_id, edge_id),
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );
  CREATE INDEX spatial_edges_source
    ON spatial_edges(snapshot_id, source_node_id, relation_type, target_node_id);
  CREATE INDEX spatial_edges_target
    ON spatial_edges(snapshot_id, target_node_id, relation_type, source_node_id);
  CREATE INDEX spatial_edges_relation
    ON spatial_edges(snapshot_id, relation_type, edge_id);

`,Vy=`
  CREATE TABLE IF NOT EXISTS spatial_snapshot_topology (
    snapshot_id TEXT PRIMARY KEY,
    connector_count INTEGER NOT NULL CHECK (connector_count >= 0),
    declared_peer_reference_count INTEGER NOT NULL CHECK (declared_peer_reference_count >= 0),
    resolved_peer_reference_count INTEGER NOT NULL CHECK (resolved_peer_reference_count >= 0),
    unresolved_peer_reference_count INTEGER NOT NULL CHECK (unresolved_peer_reference_count >= 0),
    ambiguous_connector_count INTEGER NOT NULL CHECK (ambiguous_connector_count >= 0),
    read_complete INTEGER NOT NULL CHECK (read_complete IN (0, 1)),
    target_membership_validated INTEGER NOT NULL CHECK (target_membership_validated IN (0, 1)),
    payload_json TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES spatial_snapshots(snapshot_id) ON DELETE CASCADE
  );
`,Dy=["category","built_in_category","category_role","level_unique_id","level_name","owner_node_id","system_key","geometry_fingerprint","placement_fingerprint","shape_fingerprint","property_fingerprint","topology_fingerprint"],ea=class extends Error{backupPath;constructor(t,n,o){super(t,o),this.name="SpatialStoreMigrationError",this.backupPath=n}},it=class extends Error{constructor(t,n){super(t,n),this.name="SpatialStoreIntegrityError"}},zo=class extends Error{constructor(t,n){super(t,n),this.name="SpatialRTreeUnavailableError"}},Mt=class extends Error{reason;constructor(t,n){super(n),this.name="SpatialStorePathError",this.reason=t}};function Fy(e){return/^(1|true|yes|on)$/i.test(String(e??"").trim())}function jy(e){let t=e.trim();if(/^(?:\\\\|\/\/)/.test(t)||/^[a-z][a-z0-9+.-]*:\/\//i.test(t))return!0;let n=Kc(rn(t)).root;return/^(?:\\\\|\/\/)/.test(n)}var $c=new Map;function By(e){let t=e.toUpperCase(),n=$c.get(t);if(n!==void 0)return n;let o=["$rootPath = [Environment]::GetEnvironmentVariable('REVAGENT_SPATIAL_DRIVE_ROOT')","try { $drive = [System.IO.DriveInfo]::new($rootPath); if (-not $drive.IsReady) { exit 3 }; [Console]::Out.Write([int]$drive.DriveType); exit 0 } catch { exit 2 }"].join("; "),r=by("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-Command",o],{encoding:"utf8",timeout:2e3,windowsHide:!0,env:{...process.env,REVAGENT_SPATIAL_DRIVE_ROOT:e}});if(r.error||r.status!==0)return null;let a=Number.parseInt(String(r.stdout??"").trim(),10);return!Number.isSafeInteger(a)||a<0||a>6?null:($c.set(t,a),a)}function Ei(e,t,n){if(jy(e))throw new Mt("network_path",`${t} must remain on a local filesystem; network/UNC paths are not allowed.`);let o=rn(e);if(process.platform==="win32"||n!==void 0){let a=Kc(o).root,i=a?(n??By)(a):null;if(i===4)throw new Mt("network_path",`${t} must remain on a local filesystem; mapped network drives are not allowed.`);if(i===null||![2,3,6].includes(i))throw new Mt("network_path",`${t} drive readiness/type is unavailable or not an allowed local writable drive; storage is rejected fail-closed.`)}if([...new Set([Yt(),er()].map(a=>rn(a)))].some(a=>Uo(a,o)))throw new Mt("managed_package_path",`${t} may not be stored inside the managed revAgent runtime/package directory.`);return o}function qy(e,t){let n=e?.trim()||process.env.REVAGENT_SPATIAL_DB_PATH?.trim();if(n)return Ei(n,"Spatial database",t);let o=process.env.LOCALAPPDATA?.trim()||Zr(Sy(),"AppData","Local");return Ei(Zr(o,"revAgent","spatial","spatial.db"),"Spatial database",t)}function zy(e,t,n){let o=t?.trim()||Zr(ki(e),"artifacts"),r=Ei(o,"Spatial artifact root",n);if(r===rn(e)||Uo(r,e)||Uo(e,r))throw new Mt("artifact_path","The spatial artifact root must be a dedicated sibling location and may not contain the database.");return r}function Uy(){if(Fy(process.env[Ny]))return!1;let e=o=>{let r=process.env[o]?.trim();if(!r)return;let a=Number(r);if(!Number.isSafeInteger(a)||a<0)throw new RangeError(`${o} must be a non-negative integer.`);return a},t=e(Ty),n=e(Ey);return t===void 0&&n===void 0?void 0:{retentionDays:t,minCompleteSnapshots:n}}function se(e,t){let n=e.trim();if(!n)throw new TypeError(`${t} must be a non-empty string.`);return n}function Ee(e,t){if(!Number.isSafeInteger(e)||e<0)throw new RangeError(`${t} must be a non-negative safe integer.`);return e}function Ve(e,t){let n=JSON.stringify(e);if(n===void 0)throw new TypeError(`${t} must be JSON serializable.`);return n}function wt(e,t){if(e===null)return null;try{return JSON.parse(e)}catch(n){throw new it(`Stored ${t} JSON is invalid.`,{cause:n})}}function mt(e,t){return K(te(e,t))}function Ni(e){return{category:mt(e,[["category"]]),builtInCategory:mt(e,[["builtInCategory"]]),categoryRole:mt(e,[["categoryRole"]]),levelUniqueId:mt(e,[["levelRef","sourceLevelUniqueId"],["level","uniqueId"],["levelUniqueId"]]),levelName:mt(e,[["levelRef","sourceLevelName"],["level","name"],["levelName"]]),ownerNodeId:mt(e,[["ownerNodeId"],["connectorRef","ownerNodeId"],["nodeRef","connectorRef","ownerNodeId"]]),systemKey:mt(e,[["spatialProperties","systemKey"],["system","systemKey"],["system","uniqueId"],["systemKey"],["systemName"]]),geometryFingerprint:mt(e,[["fingerprints","geometry"],["geometry","geometryFingerprint"]]),placementFingerprint:mt(e,[["fingerprints","placement"]]),shapeFingerprint:mt(e,[["fingerprints","shape"]]),propertyFingerprint:mt(e,[["fingerprints","property"]]),topologyFingerprint:mt(e,[["fingerprints","topology"]])}}function Mi(e){if(!Array.isArray(e)||e.length!==3)return null;let t=e.map(ze);return t.every(n=>n!==null)?t:null}function Wy(e){let t=K(te(e,[["profile","shape"]]))?.toLowerCase()??null,n=ze(te(e,[["profile","diameterMm"]])),o=ze(te(e,[["profile","insulationThicknessMm"]])),r=K(te(e,[["geometry","centerline","curveType"]]))?.toLowerCase()??null,a=te(e,[["geometry","centerline","points"]]);if(t!=="round"||n===null||n<0||o===null||o<0||r!=="line"||!Array.isArray(a)||a.length!==2)return null;let i=a.map(Mi);if(i.some(l=>l===null))return null;let s=n/2+o;return{minMm:[0,1,2].map(l=>Math.min(...i.map(c=>c[l]))-s),maxMm:[0,1,2].map(l=>Math.max(...i.map(c=>c[l]))+s)}}function $y(e,t){let n=Wy(e);if(!n)return;let o=Mi(te(e,[["geometry","aabb","min"]])),r=Mi(te(e,[["geometry","aabb","max"]])),a=.01;if(!o||!r||[0,1,2].some(i=>o[i]>n.minMm[i]+a||r[i]<n.maxMm[i]-a))throw new it(`Spatial v0.3 exact analytic profile AABB does not contain its diameter plus insulation envelope: ${t}`)}function ro(e,t){let n=wt(e,t);if(!Ge(n))throw new it(`${t} is not a JSON object.`);return n}function Kr(e,t,n){if(e===void 0)return t;if(!Number.isSafeInteger(e)||e<=0)throw new RangeError("Spatial query limit must be a positive integer.");return Math.min(e,n)}function Xr(e,t=2e3){if(e&&e.length>t)throw new RangeError(`Spatial query accepts at most ${t} values for one filter.`);return $t(e??[],t)}function oo(e){return new Array(e).fill("?").join(", ")}function Hy(e){let t=te(e,[["connectedToNodeIds"],["peerNodeIds"],["topology","connectedToNodeIds"],["topology","peerNodeIds"],["connectorTopology","connectedToNodeIds"]]),n=Array.isArray(t)?$t(t):[],o=te(e,[["connectionRefs"]]),r=Array.isArray(o)?$t(o.map(i=>Ge(i)&&i.resolved===!0?i.targetConnectorNodeId:null)):[];if(n.length>0||r.length>0)return $t([...n,...r]);let a=te(e,[["connections"],["topology","connections"]]);return Array.isArray(a)?$t(a.map(i=>Ge(i)?i.targetNodeId??i.peerNodeId??i.nodeId:i)):[]}function Gy(e){let t=te(e,[["topologyCoverage"],["topology","coverage"],["connectorTopology","coverage"]]),n=Ge(t)?t:{},o=$t(n.reasons),r=no(n.ambiguousConnectorCount??n.ambiguousReferenceCount??te(e,[["topology","ambiguousReferenceCount"]]))??(n.ambiguous===!0||o.some(w=>w.includes("ambiguous"))?1:0),a=Math.max(0,no(n.unresolvedConnectorCount??n.unresolvedPeerReferenceCount??n.unresolvedReferenceCount)??0),i=te(e,[["isConnected"]])===!0,s=Hy(e),l=o.includes("connected_without_all_refs")||i&&s.length===0&&a===0,c=no(n.referencedConnectorCount),u=no(n.resolvedConnectorNodeCount),m=Math.max(0,c??s.length+a),g=Math.max(0,u??s.length),p=c===null||u===null?0:Math.abs(g-s.length)+Math.abs(m-g-a),y=a+(l?1:0)+p,f=n.complete===!0&&n.isConnectedRead===!0&&n.allRefsRead===!0&&y===0&&r===0;return{peers:s,ambiguousCount:Math.max(0,r),declaredUnresolvedCount:Math.max(0,y),referencedConnectorCount:m,resolvedConnectorNodeCount:g,countMismatchCount:p,readComplete:f,isConnected:i,reasons:o}}function Hc(e,t,n){return`edge:${e}:${vt([t,n]).slice(7)}`}var xi=`
  n.snapshot_id, n.node_id, n.document_key, n.node_kind,
  n.element_unique_id, n.link_instance_unique_id,
  n.min_x, n.max_x, n.min_y, n.max_y, n.min_z, n.max_z,
  n.payload_json, n.category, n.built_in_category, n.category_role,
  n.level_unique_id, n.level_name, n.owner_node_id, n.system_key,
  n.geometry_fingerprint, n.placement_fingerprint, n.shape_fingerprint,
  n.property_fingerprint, n.topology_fingerprint
`;function vi(e){let t=ro(e.payload_json,"spatial node payload"),n=Ni(t),o=[e.min_x,e.max_x,e.min_y,e.max_y,e.min_z,e.max_z].every(r=>typeof r=="number"&&Number.isFinite(r));return{snapshotId:e.snapshot_id,nodeId:e.node_id,documentKey:e.document_key,nodeKind:e.node_kind,elementUniqueId:e.element_unique_id,linkInstanceUniqueId:e.link_instance_unique_id,aabb:o?{minMm:[e.min_x,e.min_y,e.min_z],maxMm:[e.max_x,e.max_y,e.max_z]}:null,category:e.category??n.category,builtInCategory:e.built_in_category??n.builtInCategory,categoryRole:e.category_role??n.categoryRole,levelUniqueId:e.level_unique_id??n.levelUniqueId,levelName:e.level_name??n.levelName,ownerNodeId:e.owner_node_id??n.ownerNodeId,systemKey:e.system_key??n.systemKey,geometryFingerprint:e.geometry_fingerprint??n.geometryFingerprint,placementFingerprint:e.placement_fingerprint??n.placementFingerprint,shapeFingerprint:e.shape_fingerprint??n.shapeFingerprint,propertyFingerprint:e.property_fingerprint??n.propertyFingerprint,topologyFingerprint:e.topology_fingerprint??n.topologyFingerprint,payload:t}}function Jy(e){return{snapshotId:e.snapshot_id,edgeId:e.edge_id,sourceNodeId:e.source_node_id,targetNodeId:e.target_node_id,relationType:e.relation_type,relationPolicyVersion:e.relation_policy_version,fingerprint:e.fingerprint,bidirectional:e.bidirectional===1,payload:ro(e.payload_json,"spatial edge payload")}}function wi(e){if(!e)return[null,null,null,null,null,null];if([...e.minMm,...e.maxMm].some(n=>!Number.isFinite(n)))throw new RangeError("Spatial AABB coordinates must be finite numbers.");for(let n=0;n<3;n+=1)if(e.minMm[n]>e.maxMm[n])throw new RangeError(`Spatial AABB min exceeds max on axis ${n}.`);return[e.minMm[0],e.maxMm[0],e.minMm[1],e.maxMm[1],e.minMm[2],e.maxMm[2]]}function Ai(e){return e.major*1e3+e.minor}function Ci(e,t){return Ai(e)-Ai(t)}function ta(e,t){return e.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.found===1}function Gc(e,t){if(!ta(e,t))return new Set;let n=e.pragma(`table_info('${t.replaceAll("'","''")}')`);return new Set(n.map(o=>o.name))}function Ky(e){for(let o of["spatial_nodes","spatial_staging_nodes"]){if(!ta(e,o))continue;let r=Gc(e,o);for(let a of Dy)r.has(a)||e.exec(`ALTER TABLE ${o} ADD COLUMN ${a} TEXT`)}let t=Gc(e,"spatial_nodes"),n=(o,r)=>{r.every(a=>t.has(a))&&e.exec(`CREATE INDEX IF NOT EXISTS ${o} ON spatial_nodes(${r.join(", ")})`)};n("spatial_nodes_kind",["snapshot_id","node_kind","node_id"]),n("spatial_nodes_category",["snapshot_id","category","node_id"]),n("spatial_nodes_built_in_category",["snapshot_id","built_in_category","node_id"]),n("spatial_nodes_role",["snapshot_id","category_role","node_id"]),n("spatial_nodes_level_name",["snapshot_id","level_name","node_id"]),n("spatial_nodes_level_unique_id",["snapshot_id","level_unique_id","node_id"]),n("spatial_nodes_system",["snapshot_id","system_key","node_id"]),n("spatial_nodes_owner",["snapshot_id","owner_node_id","node_id"]),n("spatial_nodes_z_band",["snapshot_id","min_z","max_z","node_id"]),ta(e,"spatial_edges")||e.exec(Ly),e.exec(Vy)}function Xc(e){if(!ta(e,"spatial_store_metadata"))return{major:0,minor:0};let t=e.prepare("SELECT key, value FROM spatial_store_metadata WHERE key IN ('schema_major', 'schema_minor')").all(),n=new Map(t.map(a=>[a.key,a.value])),o=Number.parseInt(n.get("schema_major")??"",10),r=Number.parseInt(n.get("schema_minor")??"",10);if(!Number.isSafeInteger(o)||o<0||!Number.isSafeInteger(r)||r<0)throw new it("Spatial store schema metadata is missing or invalid.");return{major:o,minor:r}}function na(e){let n=e.pragma("quick_check").flatMap(o=>Object.values(o).map(String));if(n.length!==1||n[0].toLowerCase()!=="ok")throw new it(`SQLite quick_check failed: ${n.join("; ")||"no result"}`)}function Oi(e){let t=ki(e),n=`${_y(e)}.migration-backup-`;return oa(t)?yy(t).filter(o=>o.startsWith(n)).map(o=>Zr(t,o)).filter(o=>{try{return Qr(o).isFile()}catch{return!1}}).sort((o,r)=>{let a=Qr(r).mtimeMs-Qr(o).mtimeMs;return a!==0?a:r<o?-1:r>o?1:0}):[]}function Xy(e){ao(`${e}-wal`,{force:!0}),ao(`${e}-shm`,{force:!0})}function Yc(e,t){Xy(e),fy(t,e)}function Qc(e,t,n){let o=`${n}-${process.pid}-${ky++}`,r=`${t}.migration-backup-${o}`,a=r.replaceAll("'","''");e.exec(`VACUUM INTO '${a}'`);let i=null;try{i=new Ti(r,{readonly:!0,fileMustExist:!0}),na(i)}catch(s){try{i?.close()}catch{}throw ao(r,{force:!0}),new it(`New spatial recovery backup failed SQLite quick_check: ${r}`,{cause:s})}return i.close(),r}function Yy(e,t=3){for(let n of Oi(e).slice(t))ao(n,{force:!0})}function Jc(e){e.pragma("foreign_keys = ON"),e.pragma("busy_timeout = 5000"),e.pragma("journal_mode = WAL"),e.pragma("synchronous = FULL")}function Qy(e){let t=null;try{return t=new Ti(e),na(t),Jc(t),{database:t,recoveredFromBackupPath:null}}catch(n){try{t?.close()}catch{}let o=Oi(e)[0];if(!o)throw new it("Spatial store failed SQLite quick_check and no migration backup is available.",{cause:n});Yc(e,o);let r=null;try{return r=new Ti(e),na(r),Jc(r),{database:r,recoveredFromBackupPath:o}}catch(a){try{r?.close()}catch{}throw new it(`Spatial store recovery from ${o} failed.`,{cause:a})}}}function Ii(e,t){let n=e.prepare("INSERT OR REPLACE INTO spatial_store_metadata(key, value) VALUES (?, ?)");n.run("schema_major",String(t.major)),n.run("schema_minor",String(t.minor)),n.run("schema_version",`${t.major}.${t.minor}`),e.pragma(`user_version = ${Ai(t)}`)}function Zy(e,t,n,o,r){let a=Xc(e),i={major:wy,minor:Cy};if(Ci(a,i)>0)throw new ea(`Spatial store schema ${a.major}.${a.minor} is newer than supported ${i.major}.${i.minor}.`,null);if(Ci(a,i)===0)return;let s=n&&oa(t)&&Qr(t).size>0?Qc(e,t,o):null;try{e.transaction(()=>{let l=a;if(a.major===0&&a.minor===0&&(e.exec(Oy),l={major:1,minor:0},Ii(e,l)),l.major===1&&l.minor===0&&(e.exec(Py),l={major:1,minor:1},Ii(e,l)),l.major===1&&l.minor===1&&(Ky(e),l={major:1,minor:2},Ii(e,l)),Ci(l,i)!==0)throw new Error(`No migration path from ${l.major}.${l.minor}.`);r?.beforeMigrationCommit?.(a,i)})(),na(e),Yy(t)}catch(l){try{e.close()}finally{s&&Yc(t,s)}throw new ea(`Spatial store migration ${a.major}.${a.minor} -> ${i.major}.${i.minor} failed${s?" and the pre-migration backup was restored":""}.`,s,{cause:l})}}function Yr(e){try{e.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get()}catch(t){throw new zo("SQLite R*Tree support is unavailable; spatial indexing cannot fall back to a full table scan.",{cause:t})}}function Uo(e,t){let n=vy(rn(e),rn(t));return n===""||!n.startsWith("..")&&!xy(n)}function Ri(e,t){let n=0,o=[];for(let r of[...new Set(e)]){let a=rn(r);if(a===t||!Uo(t,a)){o.push(`Refused to remove an artifact outside the dedicated spatial artifact root: ${a}`);continue}try{oa(a)&&(ao(a,{recursive:!0,force:!0}),n+=1)}catch(i){o.push(`Failed to remove registered spatial artifact ${a}: ${String(i)}`)}}return{removed:n,warnings:o}}var io=class{databasePath;artifactRoot;recoveredFromBackupPath;now;testHooks;configuredRetentionPolicy;database;closed=!1;constructor(t={}){let n=t.testHooks?.readWindowsDriveType;this.databasePath=qy(t.databasePath,n),this.artifactRoot=zy(this.databasePath,t.artifactRoot,n),this.now=t.now??Date.now,this.testHooks=t.testHooks??{};let o=t.retentionPolicy===void 0?Uy():void 0,r=t.retentionPolicy!==void 0?t.retentionPolicy:o;this.configuredRetentionPolicy=r===!1?!1:{...r??{}},Wc(ki(this.databasePath),{recursive:!0}),Wc(this.artifactRoot,{recursive:!0});let a=oa(this.databasePath),i=Qy(this.databasePath);this.database=i.database,this.recoveredFromBackupPath=i.recoveredFromBackupPath;try{Zy(this.database,this.databasePath,a,this.now(),t.testHooks),Yr(this.database),t.cleanupExpiredStagingOnOpen!==!1&&this.cleanupExpiredStaging(this.now()),this.applyConfiguredRetention()}catch(s){try{this.database.close()}catch{}throw this.closed=!0,s}}close(){this.closed||(this.database.pragma("wal_checkpoint(TRUNCATE)"),this.database.close(),this.closed=!0)}getSchemaVersion(){return this.assertOpen(),Xc(this.database)}isRTreeAvailable(){return this.assertOpen(),Yr(this.database),!0}beginCapture(t){this.assertOpen();let n=Ee(this.now(),"current time"),o=Ee(t.capturedAtMs??n,"capturedAtMs"),r=Ee(t.expiresAtMs??n+My,"expiresAtMs");if(r<=n)throw new RangeError("expiresAtMs must be in the future when a capture begins.");let a=(t.artifactPaths??[]).map(i=>{let s=rn(se(i,"artifactPath"));if(s===this.artifactRoot||!Uo(this.artifactRoot,s))throw new Mt("artifact_path",`A spatial artifact must be a child of the dedicated artifact root ${this.artifactRoot}: ${s}`);return s});this.database.transaction(()=>{this.database.prepare(`
        INSERT INTO spatial_capture_staging(
          capture_id, snapshot_id, document_key, scope_fingerprint,
          revision_fingerprint, schema_version, extractor_version,
          scope_json, declared_counts_json, effective_source_policy_json,
          coverage_json, transform_validation_json, capture_metadata_json,
          captured_at_ms, created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(se(t.captureId,"captureId"),se(t.snapshotId,"snapshotId"),se(t.documentKey,"documentKey"),se(t.scopeFingerprint,"scopeFingerprint"),se(t.revisionFingerprint,"revisionFingerprint"),se(t.schemaVersion,"schemaVersion"),se(t.extractorVersion,"extractorVersion"),Ve(t.scope,"scope"),t.counts===void 0?null:Ve(t.counts,"counts"),t.effectiveSourcePolicy===void 0?null:Ve(t.effectiveSourcePolicy,"effectiveSourcePolicy"),t.coverage===void 0?null:Ve(t.coverage,"coverage"),t.transformValidation===void 0?null:Ve(t.transformValidation,"transformValidation"),Ve(t.captureMetadata??{},"captureMetadata"),o,n,n,r);let i=this.database.prepare("INSERT INTO spatial_staging_artifacts(capture_id, artifact_path) VALUES (?, ?)");for(let s of new Set(a))i.run(t.captureId,s)})()}stagePage(t){this.assertOpen();let n=Ee(t.ordinal,"page ordinal"),o=Ee(t.payloadBytes,"payloadBytes"),r=t.omissions??[];this.database.transaction(()=>{let a=this.database.prepare("SELECT * FROM spatial_capture_staging WHERE capture_id = ?").get(t.captureId);if(!a)throw new Error(`Unknown spatial capture: ${t.captureId}`);if(a.expires_at_ms<=this.now())throw new Error(`Spatial capture lease expired: ${t.captureId}`);let i=this.database.prepare(`
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
      `).run(t.captureId,n,l,se(t.pageHash,"pageHash"),t.hasMore?1:0,o,t.nodes.length,r.length);let c=this.database.prepare(`
        INSERT INTO spatial_staging_nodes(
          capture_id, page_ordinal, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json,
          category, built_in_category, category_role,
          level_unique_id, level_name, owner_node_id, system_key,
          geometry_fingerprint, placement_fingerprint, shape_fingerprint,
          property_fingerprint, topology_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let m of t.nodes){let g=wi(m.aabb),p=Ni(m.payload);c.run(t.captureId,n,se(m.nodeId,"nodeId"),se(m.documentKey,"node.documentKey"),se(m.nodeKind,"nodeKind"),m.elementUniqueId?.trim()||null,m.linkInstanceUniqueId?.trim()||null,...g,Ve(m.payload,"node.payload"),p.category,p.builtInCategory,p.categoryRole,p.levelUniqueId,p.levelName,p.ownerNodeId,p.systemKey,p.geometryFingerprint,p.placementFingerprint,p.shapeFingerprint,p.propertyFingerprint,p.topologyFingerprint)}let u=this.database.prepare(`
        INSERT INTO spatial_staging_omissions(
          capture_id, page_ordinal, document_key, reason, source_identity, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);for(let m of r)u.run(t.captureId,n,se(m.documentKey,"omission.documentKey"),se(m.reason,"omission.reason"),m.sourceIdentity?.trim()||null,Ve(m.payload,"omission.payload"));this.database.prepare("UPDATE spatial_capture_staging SET updated_at_ms = ? WHERE capture_id = ?").run(this.now(),t.captureId)})()}commitCapture(t){if(this.assertOpen(),t.sourceRevisions.length===0)throw new Error("An atomic spatial snapshot requires at least one source revision.");if(!t.partial&&t.coverageStatus&&t.coverageStatus!=="complete")throw new Error("A non-partial spatial snapshot cannot have incomplete coverageStatus.");let n=Ee(t.expectedPageCount,"expectedPageCount"),o=Ee(t.expectedPayloadBytes,"expectedPayloadBytes"),r=Ee(t.expectedNodeCount,"expectedNodeCount"),a=Ee(t.expectedOmissionCount,"expectedOmissionCount");if(n<1)throw new RangeError("expectedPageCount must be greater than zero.");let i=Object.fromEntries(Object.entries(t.expectedNodesByKind).map(([p,y])=>[se(p,"expected node kind"),Ee(y,`expectedNodesByKind.${p}`)]));if(Object.values(i).reduce((p,y)=>p+y,0)!==r)throw new it("Expected node-kind counts do not sum to expectedNodeCount.");let s=Ve(t.counts,"final counts"),l=t.effectiveSourcePolicy===void 0?null:Ve(t.effectiveSourcePolicy,"final effectiveSourcePolicy"),c=Ve(t.coverage,"final coverage"),u=t.transformValidation===void 0?null:Ve(t.transformValidation,"final transformValidation"),m=this.database.transaction(()=>{let p=this.database.prepare("SELECT * FROM spatial_capture_staging WHERE capture_id = ?").get(t.captureId);if(!p)throw new Error(`Unknown spatial capture: ${t.captureId}`);if(p.expires_at_ms<=this.now())throw new Error(`Spatial capture lease expired: ${t.captureId}`);if(!t.sourceRevisions.some(S=>S.documentKey===p.document_key))throw new Error("Spatial source revisions do not include the capture host documentKey.");let y=this.database.prepare(`
        SELECT page_ordinal, page_hash, has_more
        FROM spatial_staging_pages
        WHERE capture_id = ?
        ORDER BY page_ordinal
      `).all(t.captureId);if(y.length===0||y.at(-1)?.has_more!==0)throw new Error("Atomic spatial capture cannot commit before its terminal page is staged.");y.forEach((S,k)=>{if(S.page_ordinal!==k)throw new Error("Atomic spatial capture contains a non-contiguous page sequence.")});let f=this.database.prepare(`
        SELECT
          COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
          COALESCE(SUM(record_count), 0) AS node_count,
          COALESCE(SUM(omission_count), 0) AS omission_count
        FROM spatial_staging_pages
        WHERE capture_id = ?
      `).get(t.captureId),w=this.database.prepare(`
        SELECT node_kind, count(*) AS count
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        GROUP BY node_kind
        ORDER BY node_kind
      `).all(t.captureId),T=this.database.prepare(`
        SELECT reason, count(*) AS count
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        GROUP BY reason
        ORDER BY reason
      `).all(t.captureId),I=Object.fromEntries(w.map(S=>[S.node_kind,S.count])),_=[];y.length!==n&&_.push(`pages expected ${n}, staged ${y.length}`),f.payload_bytes!==o&&_.push(`payloadBytes expected ${o}, staged ${f.payload_bytes}`),f.node_count!==r&&_.push(`nodes expected ${r}, staged ${f.node_count}`),f.omission_count!==a&&_.push(`omissions expected ${a}, staged ${f.omission_count}`);for(let S of new Set([...Object.keys(i),...Object.keys(I)])){let k=i[S]??0,q=I[S]??0;k!==q&&_.push(`${S} nodes expected ${k}, staged ${q}`)}if(_.length>0)throw new it(`Atomic spatial capture count reconciliation failed: ${_.join("; ")}.`);let A=Ve({totalNodes:f.node_count,nodesByKind:Object.fromEntries(w.map(S=>[S.node_kind,S.count])),omittedSupportedNodes:f.omission_count,omissionsByReason:Object.fromEntries(T.map(S=>[S.reason,S.count]))},"snapshot counts");this.database.prepare(`
        INSERT INTO spatial_snapshots(
          snapshot_id, document_key, captured_at_ms, committed_at_ms,
          scope_fingerprint, revision_fingerprint, schema_version, extractor_version,
          scope_json, declared_counts_json, effective_source_policy_json,
          coverage_json, transform_validation_json, capture_metadata_json,
          complete, partial, coverage_status, scan_stopped_reason,
          suggested_next_scopes_json, counts_json, page_count, payload_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.snapshot_id,p.document_key,p.captured_at_ms,this.now(),p.scope_fingerprint,p.revision_fingerprint,p.schema_version,p.extractor_version,p.scope_json,s,l,c,u,p.capture_metadata_json,t.partial?0:1,t.partial?1:0,t.coverageStatus??null,se(t.scanStoppedReason,"scanStoppedReason"),Ve(t.suggestedNextScopes??[],"suggestedNextScopes"),A,y.length,f.payload_bytes);let R=this.database.prepare(`
        INSERT INTO spatial_snapshot_sources(
          snapshot_id, source_key, document_key, document_session_id,
          tracker_session_id, loaded_version, change_sequence, change_sequence_state,
          oldest_retained_sequence, journal_entry_count, journal_capacity,
          journal_truncated, link_instance_unique_id, source_to_host_transform_json,
          document_key_resolution_json, external_link_update_available,
          source_revision_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),E=new Set;for(let S of t.sourceRevisions){if(Ee(S.changeSequence,"source changeSequence"),S.oldestRetainedSequence!==void 0&&S.oldestRetainedSequence!==null&&Ee(S.oldestRetainedSequence,"source oldestRetainedSequence"),S.journalEntryCount!==void 0&&S.journalEntryCount!==null&&Ee(S.journalEntryCount,"source journalEntryCount"),S.journalCapacity!==void 0&&S.journalCapacity!==null&&(Ee(S.journalCapacity,"source journalCapacity"),S.journalCapacity===0))throw new RangeError("source journalCapacity must be greater than zero.");if(S.journalEntryCount!==void 0&&S.journalEntryCount!==null&&S.journalCapacity!==void 0&&S.journalCapacity!==null&&S.journalEntryCount>S.journalCapacity)throw new RangeError("source journalEntryCount cannot exceed journalCapacity.");let k=Jr(S);if(E.has(k))throw new Error(`Duplicate spatial source revision: ${k}`);E.add(k),R.run(p.snapshot_id,k,se(S.documentKey,"source.documentKey"),se(S.documentSessionId,"source.documentSessionId"),S.trackerSessionId?.trim()||null,se(S.loadedVersion,"source.loadedVersion"),S.changeSequence,S.changeSequenceState?.trim()||null,S.oldestRetainedSequence??null,S.journalEntryCount??null,S.journalCapacity??null,S.journalTruncated?1:0,S.linkInstanceUniqueId?.trim()||null,Ve(S.sourceToHostTransform,"source.sourceToHostTransform"),S.documentKeyResolution===void 0?null:Ve(S.documentKeyResolution,"source.documentKeyResolution"),S.externalLinkUpdateAvailable?1:0,Ve(S,"source revision"))}return this.database.prepare(`
        INSERT INTO spatial_nodes(
          snapshot_id, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json,
          category, built_in_category, category_role,
          level_unique_id, level_name, owner_node_id, system_key,
          geometry_fingerprint, placement_fingerprint, shape_fingerprint,
          property_fingerprint, topology_fingerprint
        )
        SELECT ?, node_id, document_key, node_kind,
          element_unique_id, link_instance_unique_id,
          min_x, max_x, min_y, max_y, min_z, max_z, payload_json,
          category, built_in_category, category_role,
          level_unique_id, level_name, owner_node_id, system_key,
          geometry_fingerprint, placement_fingerprint, shape_fingerprint,
          property_fingerprint, topology_fingerprint
        FROM spatial_staging_nodes
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_node_rowid
      `).run(p.snapshot_id,t.captureId),this.rebuildSnapshotEdges(p.snapshot_id),this.database.prepare(`
        INSERT INTO spatial_omissions(
          snapshot_id, document_key, reason, source_identity, payload_json
        )
        SELECT ?, document_key, reason, source_identity, payload_json
        FROM spatial_staging_omissions
        WHERE capture_id = ?
        ORDER BY page_ordinal, staging_omission_rowid
      `).run(p.snapshot_id,t.captureId),this.database.prepare(`
        INSERT INTO spatial_snapshot_artifacts(snapshot_id, artifact_path)
        SELECT ?, artifact_path
        FROM spatial_staging_artifacts
        WHERE capture_id = ?
      `).run(p.snapshot_id,t.captureId),this.database.prepare("DELETE FROM spatial_capture_staging WHERE capture_id = ?").run(t.captureId),p.snapshot_id})(),g=this.getSnapshot(m);if(!g)throw new it(`Committed spatial snapshot ${m} is not readable.`);return g}rebuildSnapshotEdges(t){let o=this.database.prepare(`
      SELECT schema_version AS schemaVersion
      FROM spatial_snapshots WHERE snapshot_id = ?
    `).get(t)?.schemaVersion??"",r=this.database.prepare(`
      SELECT node_id, node_kind, owner_node_id, payload_json
      FROM spatial_nodes
      WHERE snapshot_id = ?
      ORDER BY node_id
    `).all(t),a=new Map(r.map(R=>[R.node_id,R.node_kind])),i=0,s=0,l=0,c=0,u=0,m=0,g=o==="0.3",p=new Set,y=this.database.prepare(`
      INSERT OR IGNORE INTO spatial_edges(
        snapshot_id, edge_id, source_node_id, target_node_id,
        relation_type, relation_policy_version, fingerprint,
        bidirectional, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),f="phase1b-topology/1",w=r.filter(R=>R.node_kind==="connector").map(R=>{let E=ro(R.payload_json,"spatial connector payload");return{row:R,payload:E,topologyEvidence:Gy(E),ownerNodeId:R.owner_node_id??Ni(E).ownerNodeId}});if(o==="0.3")for(let R of r)$y(ro(R.payload_json,`spatial node ${R.node_id} payload`),R.node_id);let T=new Map(w.map(R=>[R.row.node_id,R.topologyEvidence]));i=w.length;for(let{row:R,topologyEvidence:E,ownerNodeId:S}of w){if(g=g&&E.readComplete,m+=E.ambiguousCount,c+=E.declaredUnresolvedCount,s+=E.referencedConnectorCount,S&&a.get(S)==="revit_element"){let k={basis:"connector_owner_identity",precisionClass:"measured",verdictCapability:"context_only"};y.run(t,Hc("owns_connector",S,R.node_id),S,R.node_id,"owns_connector",f,vt({ownerNodeId:S,connectorNodeId:R.node_id,policyVersion:f}),0,xe(k))}else u+=1,p.add(S??`<missing_owner:${R.node_id}>`);for(let k of E.peers){let X=T.get(k)?.peers.includes(R.node_id)===!0;if(k===R.node_id||a.get(k)!=="connector"||!X){u+=1,p.add(!X&&a.get(k)==="connector"?`<nonreciprocal:${R.node_id}->${k}>`:k);continue}l+=1;let[re,Z]=R.node_id<k?[R.node_id,k]:[k,R.node_id],pe={basis:"revit_connector_all_refs",precisionClass:"measured",verdictCapability:"context_only",targetMembershipValidated:!0};y.run(t,Hc("connected_to",re,Z),re,Z,"connected_to",f,vt({sourceNodeId:re,targetNodeId:Z,policyVersion:f}),1,xe(pe))}}let I=c+u,_=g&&m===0&&I===0,A={basis:"committed_snapshot_connector_membership",connectorCount:i,declaredPeerReferenceCount:s,resolvedPeerReferenceCount:l,unresolvedPeerReferenceCount:I,ambiguousConnectorCount:m,readComplete:g,targetMembershipValidated:_,unresolvedPeerNodeIds:[...p].sort().slice(0,1e3)};this.database.prepare(`
      INSERT OR REPLACE INTO spatial_snapshot_topology(
        snapshot_id, connector_count, declared_peer_reference_count,
        resolved_peer_reference_count, unresolved_peer_reference_count,
        ambiguous_connector_count, read_complete,
        target_membership_validated, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t,i,s,l,I,m,g?1:0,_?1:0,xe(A))}getSnapshot(t){this.assertOpen();let n=this.database.prepare(`
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
    `).all(t).map(o=>{let r=wt(o.source_revision_json,"source revision");return{...r&&typeof r=="object"&&!Array.isArray(r)?r:{},documentKey:o.document_key,documentSessionId:o.document_session_id,trackerSessionId:o.tracker_session_id,loadedVersion:o.loaded_version,changeSequence:o.change_sequence,changeSequenceState:o.change_sequence_state,oldestRetainedSequence:o.oldest_retained_sequence,journalEntryCount:o.journal_entry_count,journalCapacity:o.journal_capacity,journalTruncated:o.journal_truncated===1,linkInstanceUniqueId:o.link_instance_unique_id,sourceToHostTransform:wt(o.source_to_host_transform_json,"source-to-host transform"),documentKeyResolution:wt(o.document_key_resolution_json,"document-key resolution"),externalLinkUpdateAvailable:o.external_link_update_available===1}})}getSnapshotTopologyCapability(t){this.assertOpen();let n=this.database.prepare(`
      SELECT snapshot_id, connector_count, declared_peer_reference_count,
        resolved_peer_reference_count, unresolved_peer_reference_count,
        ambiguous_connector_count, read_complete,
        target_membership_validated, payload_json
      FROM spatial_snapshot_topology
      WHERE snapshot_id = ?
    `).get(se(t,"snapshotId"));if(!n)return null;let o=ro(n.payload_json,"spatial topology capability payload");return{snapshotId:n.snapshot_id,connectorCount:n.connector_count,declaredPeerReferenceCount:n.declared_peer_reference_count,resolvedPeerReferenceCount:n.resolved_peer_reference_count,unresolvedPeerReferenceCount:n.unresolved_peer_reference_count,ambiguousConnectorCount:n.ambiguous_connector_count,readComplete:n.read_complete===1,targetMembershipValidated:n.target_membership_validated===1,unresolvedPeerNodeIds:$t(o.unresolvedPeerNodeIds)}}getSnapshotRecord(t){this.assertOpen();let n=this.getSnapshot(t);if(!n)return null;let o=this.database.prepare(`
      SELECT scope_json, declared_counts_json, counts_json,
        effective_source_policy_json, coverage_json,
        transform_validation_json, capture_metadata_json
      FROM spatial_snapshots
      WHERE snapshot_id = ?
    `).get(t);return{...n,scope:wt(o.scope_json,"snapshot scope"),declaredCounts:wt(o.declared_counts_json,"declared snapshot counts"),derivedCounts:wt(o.counts_json,"derived snapshot counts"),effectiveSourcePolicy:wt(o.effective_source_policy_json,"effective source policy"),coverage:wt(o.coverage_json,"snapshot coverage"),transformValidation:wt(o.transform_validation_json,"transform validation"),captureMetadata:wt(o.capture_metadata_json,"capture metadata"),sourceRevisions:this.getSnapshotSources(t)}}listSnapshots(t){return this.assertOpen(),(t?this.database.prepare(`
          SELECT snapshot_id FROM spatial_snapshots
          WHERE document_key = ? ORDER BY captured_at_ms DESC, snapshot_id
        `).all(t):this.database.prepare(`
          SELECT snapshot_id FROM spatial_snapshots
          ORDER BY document_key, captured_at_ms DESC, snapshot_id
        `).all()).map(o=>this.getSnapshot(o.snapshot_id)).filter(o=>o!==null)}getStoredNode(t,n){this.assertOpen();let o=this.database.prepare(`
      SELECT ${xi}
      FROM spatial_nodes n
      WHERE n.snapshot_id = ? AND n.node_id = ?
    `).get(se(t,"snapshotId"),se(n,"nodeId"));return o?vi(o):null}getStoredNodesByIds(t,n){if(this.assertOpen(),n.length>1e5)throw new RangeError("Spatial node identity lookup is bounded to 100000 ids.");let o=$t(n,1e5);if(o.length===0)return[];let r=se(t,"snapshotId"),a=[];for(let i=0;i<o.length;i+=900){let s=o.slice(i,i+900);a.push(...this.database.prepare(`
        SELECT ${xi}
        FROM spatial_nodes n
        WHERE n.snapshot_id = ? AND n.node_id IN (${oo(s.length)})
        ORDER BY n.node_id
      `).all(r,...s))}return a.sort((i,s)=>fe(i.node_id,s.node_id)).map(vi)}queryStoredNodes(t){this.assertOpen();let n=se(t.snapshotId,"snapshotId"),o=Kr(t.limit,100,1e3),r=["n.snapshot_id = ?"],a=[n],i=(g,p)=>{let y=Xr(p);y.length!==0&&(r.push(`${g} IN (${oo(y.length)})`),a.push(...y))};i("n.node_id",t.nodeIds),i("n.node_kind",t.nodeKinds),i("n.category",t.categories),i("n.built_in_category",t.builtInCategories),i("n.category_role",t.categoryRoles),i("n.level_name",t.levelNames),i("n.level_unique_id",t.levelUniqueIds),i("n.system_key",t.systemKeys),i("n.owner_node_id",t.ownerNodeIds);let s=K(t.afterNodeId);s&&(r.push("n.node_id > ?"),a.push(s));let l="";if(t.aabb){let g=wi(t.aabb);if(g.some(p=>p===null))throw new RangeError("Spatial node query AABB must contain finite min/max coordinates.");l="JOIN spatial_node_rtree r ON r.node_rowid = n.node_rowid",r.push("r.min_x <= ? AND r.max_x >= ?","r.min_y <= ? AND r.max_y >= ?","r.min_z <= ? AND r.max_z >= ?"),a.push(g[1],g[0],g[3],g[2],g[5],g[4])}if(t.elevationBandMm){let g=ze(t.elevationBandMm.minZ),p=ze(t.elevationBandMm.maxZ);if(g===null||p===null||g>p)throw new RangeError("Spatial elevationBandMm requires finite minZ <= maxZ.");l||(l="JOIN spatial_node_rtree r ON r.node_rowid = n.node_rowid"),r.push("r.min_z <= ? AND r.max_z >= ?"),a.push(p,g)}let c=this.database.prepare(`
      SELECT ${xi}
      FROM spatial_nodes n
      ${l}
      WHERE ${r.join(" AND ")}
      ORDER BY n.node_id
      LIMIT ?
    `).all(...a,o+1),u=c.length>o,m=u?c.slice(0,o):c;return{nodes:m.map(vi),hasMore:u,nextNodeId:u&&m.length>0?m[m.length-1].node_id:null}}getStoredOmissions(t){this.assertOpen();let n=se(t.snapshotId,"snapshotId"),o=Kr(t.limit,100,1e3),r=["snapshot_id = ?"],a=[n],i=Xr(t.reasons);i.length>0&&(r.push(`reason IN (${oo(i.length)})`),a.push(...i)),t.afterRowId!==void 0&&t.afterRowId!==null&&(Ee(t.afterRowId,"afterRowId"),r.push("omission_rowid > ?"),a.push(t.afterRowId));let s=this.database.prepare(`
      SELECT omission_rowid, snapshot_id, document_key, reason, source_identity, payload_json
      FROM spatial_omissions
      WHERE ${r.join(" AND ")}
      ORDER BY omission_rowid
      LIMIT ?
    `).all(...a,o+1),l=s.length>o,c=l?s.slice(0,o):s;return{omissions:c.map(u=>({snapshotId:u.snapshot_id,documentKey:u.document_key,reason:u.reason,sourceIdentity:u.source_identity,payload:ro(u.payload_json,"spatial omission payload")})),hasMore:l,nextRowId:l&&c.length>0?c[c.length-1].omission_rowid:null}}queryStoredEdges(t){this.assertOpen();let n=se(t.snapshotId,"snapshotId"),o=Kr(t.limit,200,2e3),r=["snapshot_id = ?"],a=[n],i=(g,p)=>{let y=Xr(p);y.length!==0&&(r.push(`${g} IN (${oo(y.length)})`),a.push(...y))};i("relation_type",t.relationTypes),i("source_node_id",t.sourceNodeIds),i("target_node_id",t.targetNodeIds);let s=Xr(t.incidentNodeIds);s.length>0&&(r.push(`(source_node_id IN (${oo(s.length)}) OR target_node_id IN (${oo(s.length)}))`),a.push(...s,...s));let l=K(t.afterEdgeId);l&&(r.push("edge_id > ?"),a.push(l));let c=this.database.prepare(`
      SELECT snapshot_id, edge_id, source_node_id, target_node_id,
        relation_type, relation_policy_version, fingerprint, bidirectional, payload_json
      FROM spatial_edges
      WHERE ${r.join(" AND ")}
      ORDER BY edge_id
      LIMIT ?
    `).all(...a,o+1),u=c.length>o,m=u?c.slice(0,o):c;return{edges:m.map(Jy),hasMore:u,nextEdgeId:u&&m.length>0?m[m.length-1].edge_id:null}}getAdjacentStoredEdges(t,n,o={}){return this.queryStoredEdges({snapshotId:t,incidentNodeIds:[se(n,"nodeId")],relationTypes:o.relationTypes,limit:Kr(o.limit,500,2e3)}).edges}queryIntersectingAabbs(t,n){this.assertOpen(),Yr(this.database);let o=wi(t),r=[o[1],o[0],o[3],o[2],o[5],o[4]];return this.database.prepare(`
      SELECT n.snapshot_id, n.node_id, n.document_key, n.node_kind,
        n.min_x, n.max_x, n.min_y, n.max_y, n.min_z, n.max_z
      FROM spatial_node_rtree r
      JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
      WHERE r.min_x <= ? AND r.max_x >= ?
        AND r.min_y <= ? AND r.max_y >= ?
        AND r.min_z <= ? AND r.max_z >= ?
        ${n?"AND n.snapshot_id = ?":""}
      ORDER BY n.snapshot_id, n.node_id
    `).all(...r,...n?[n]:[]).map(i=>({snapshotId:i.snapshot_id,nodeId:i.node_id,documentKey:i.document_key,nodeKind:i.node_kind,aabb:{minMm:[i.min_x,i.min_y,i.min_z],maxMm:[i.max_x,i.max_y,i.max_z]}}))}countRTreeEntries(t){return this.assertOpen(),Yr(this.database),(t?this.database.prepare(`
          SELECT count(*) AS count
          FROM spatial_node_rtree r
          JOIN spatial_nodes n ON n.node_rowid = r.node_rowid
          WHERE n.snapshot_id = ?
        `).get(t):this.database.prepare("SELECT count(*) AS count FROM spatial_node_rtree").get()).count}getStagingCaptureCount(){return this.assertOpen(),this.database.prepare("SELECT count(*) AS count FROM spatial_capture_staging").get().count}abandonCapture(t){this.assertOpen();let n=this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts WHERE capture_id = ?
    `).all(t),o=this.database.prepare("DELETE FROM spatial_capture_staging WHERE capture_id = ?").run(t),r=Ri(n.map(a=>a.artifact_path),this.artifactRoot);return{purgedSnapshotCount:0,purgedStagingCaptureCount:o.changes,removedArtifactCount:r.removed,artifactWarnings:r.warnings}}cleanupExpiredStaging(t=this.now()){this.assertOpen(),Ee(t,"nowMs");let n=this.database.prepare(`
      SELECT capture_id FROM spatial_capture_staging WHERE expires_at_ms <= ?
    `).all(t);if(n.length===0)return{purgedSnapshotCount:0,purgedStagingCaptureCount:0,removedArtifactCount:0,artifactWarnings:[]};let o=n.map(()=>"?").join(", "),r=n.map(l=>l.capture_id),a=this.database.prepare(`
      SELECT artifact_path FROM spatial_staging_artifacts
      WHERE capture_id IN (${o})
    `).all(...r),i=this.database.prepare(`
      DELETE FROM spatial_capture_staging WHERE capture_id IN (${o})
    `).run(...r),s=Ri(a.map(l=>l.artifact_path),this.artifactRoot);return{purgedSnapshotCount:0,purgedStagingCaptureCount:i.changes,removedArtifactCount:s.removed,artifactWarnings:s.warnings}}applyRetention(t={}){this.assertOpen();let n=Ee(t.nowMs??this.now(),"retention nowMs"),o=Ee(t.retentionDays??Iy,"retentionDays"),r=Ee(t.minCompleteSnapshots??Ry,"minCompleteSnapshots"),a=n-o*Ay,i=this.database.prepare(`
      SELECT snapshot_id, document_key, captured_at_ms, complete
      FROM spatial_snapshots
      ORDER BY document_key, captured_at_ms DESC, snapshot_id DESC
    `).all(),s=new Map,l=[];for(let c of i){let u=s.get(c.document_key)??0;c.complete===1&&(u+=1,s.set(c.document_key,u));let m=c.captured_at_ms>=a,g=c.complete===1&&u<=r;!m&&!g&&l.push(c.snapshot_id)}return l.length===0?{purgedSnapshotCount:0,purgedStagingCaptureCount:0,removedArtifactCount:0,artifactWarnings:[]}:this.purge({snapshotIds:l})}applyConfiguredRetention(){return this.assertOpen(),this.configuredRetentionPolicy===!1?{purgedSnapshotCount:0,purgedStagingCaptureCount:0,removedArtifactCount:0,artifactWarnings:[]}:this.applyRetention({...this.configuredRetentionPolicy,nowMs:this.now()})}previewPurge(t){this.assertOpen();let n=this.resolvePurgeTargets(t);return{snapshotIds:[...n.snapshotIds],stagingCaptureIds:[...n.stagingCaptureIds],snapshotCount:n.snapshotIds.length,stagingCaptureCount:n.stagingCaptureIds.length}}purge(t){this.assertOpen();let{snapshotIds:n,stagingCaptureIds:o}=this.resolvePurgeTargets(t),r=this.artifactsForIds("spatial_snapshot_artifacts","snapshot_id",n),a=this.artifactsForIds("spatial_staging_artifacts","capture_id",o),i=this.database.transaction(()=>{let c=this.deleteByIds("spatial_snapshots","snapshot_id",n),u=this.deleteByIds("spatial_capture_staging","capture_id",o);return{snapshotCount:c,stagingCount:u}})(),s=Ri([...r,...a],this.artifactRoot),l=i.snapshotCount>0?this.refreshRecoveryBackupAfterPurge():[];return{purgedSnapshotCount:i.snapshotCount,purgedStagingCaptureCount:i.stagingCount,removedArtifactCount:s.removed,artifactWarnings:[...s.warnings,...l]}}resolvePurgeTargets(t){if(+(t.all===!0)+ +!!t.documentKey+ +!!t.snapshotIds!==1)throw new Error("Spatial purge requires exactly one explicit selector: all, documentKey, or snapshotIds.");let o,r=[];if(t.all)o=this.database.prepare("SELECT snapshot_id FROM spatial_snapshots ORDER BY snapshot_id").all().map(a=>a.snapshot_id),r=this.database.prepare("SELECT capture_id FROM spatial_capture_staging ORDER BY capture_id").all().map(a=>a.capture_id);else if(t.documentKey){let a=se(t.documentKey,"purge documentKey");o=this.database.prepare("SELECT snapshot_id FROM spatial_snapshots WHERE document_key = ? ORDER BY snapshot_id").all(a).map(i=>i.snapshot_id),r=this.database.prepare("SELECT capture_id FROM spatial_capture_staging WHERE document_key = ? ORDER BY capture_id").all(a).map(i=>i.capture_id)}else{let a=[...new Set((t.snapshotIds??[]).map(s=>se(s,"snapshotId")))];if(a.length===0)throw new Error("Spatial purge snapshotIds selector requires at least one snapshotId.");let i=a.map(()=>"?").join(", ");o=this.database.prepare(`
        SELECT snapshot_id FROM spatial_snapshots
        WHERE snapshot_id IN (${i})
        ORDER BY snapshot_id
      `).all(...a).map(s=>s.snapshot_id)}return{snapshotIds:o,stagingCaptureIds:r}}artifactsForIds(t,n,o){if(o.length===0)return[];let r=o.map(()=>"?").join(", ");return this.database.prepare(`
      SELECT artifact_path FROM ${t} WHERE ${n} IN (${r})
    `).all(...o).map(a=>a.artifact_path)}deleteByIds(t,n,o){if(o.length===0)return 0;let r=o.map(()=>"?").join(", ");return this.database.prepare(`
      DELETE FROM ${t} WHERE ${n} IN (${r})
    `).run(...o).changes}refreshRecoveryBackupAfterPurge(){let t=[],n;try{this.testHooks.beforeRecoveryBackupCreate?.(),n=Qc(this.database,this.databasePath,this.now())}catch(o){return t.push(`Failed to create and verify a post-purge spatial recovery backup; previous backups were preserved: ${String(o)}`),t}for(let o of Oi(this.databasePath))if(o!==n)try{this.testHooks.beforeRecoveryBackupDelete?.(o),ao(o,{force:!0})}catch(r){t.push(`Failed to remove a pre-purge spatial recovery backup that may retain purged data ${o}: ${String(r)}`)}return t}assertOpen(){if(this.closed)throw new Error("Spatial store is closed.")}};var Ct=class extends Error{reason;constructor(t,n,o){super(n,o),this.name="SpatialStoreCapabilityError",this.reason=t}},Nn=null,En={available:!1,state:"not_initialized",reason:null,schemaVersion:null,rtreeAvailable:!1},Zc=!1;function eS(e){if(e instanceof zo)return"spatial_rtree_unavailable";if(e instanceof Mt)return e.reason==="network_path"?"spatial_store_network_path_rejected":e.reason==="managed_package_path"?"spatial_store_managed_path_rejected":"spatial_store_artifact_path_rejected";let t=e instanceof Error?e.message:String(e);return/better_sqlite3|bindings file|native module/i.test(t)?"spatial_sqlite_native_binding_unavailable":/migration/i.test(t)?"spatial_store_migration_failed":/integrity|quick_check|malformed|corrupt/i.test(t)?"spatial_store_recovery_failed":"spatial_store_unavailable"}function eu(){try{Nn?.close()}catch{}Nn=null}function Pi(){if(En.state!=="not_initialized")return{...En};try{Nn=new io;let e=Nn.getSchemaVersion(),t=Nn.isRTreeAvailable();En={available:!0,state:"ready",reason:null,schemaVersion:e,rtreeAvailable:t},Zc||(process.once("exit",eu),Zc=!0)}catch(e){eu(),En={available:!1,state:"guarded",reason:eS(e),schemaVersion:null,rtreeAvailable:!1}}return{...En}}function ra(){return En.state==="not_initialized"?Pi():{...En}}function an(){let e=ra();if(!e.available||!Nn)throw new Ct(e.reason||"spatial_store_unavailable","The durable spatial store is unavailable. Capture was guarded before any snapshot became visible.");return Nn}var tS=new Date().toISOString(),nS="revit-mcp-status.v3",oS="revit-mcp-runtime-tools.45";function rS(){let e=Vt(nu.join(Yt(),"package.json"));return{packageName:e?.name||"revagent-runtime",packageVersion:e?.version||"unknown"}}function tu(){let e=rS(),t=_o([nu.join(process.cwd(),"..","updater","installed.json")]),n=t?.version||e.packageVersion;return{runtimeVersion:n,schemaVersion:nS,toolSurfaceVersion:oS,processStartedAtUtc:tS,buildTimestampUtc:t?.installedAtUtc||null,buildHash:xo(n),packageName:e.packageName,packageVersion:e.packageVersion,nodeVersion:process.version}}function ou(e){e.tool("get_revit_mcp_status","Read the revAgent task status without waiting behind the active Revit command lock. Includes runtime identity, the durable spatial-store/R*Tree capability state, bridge resultContractVersion when available, and summary runtimeActivity for revAgent-side/client-side guarded operations that may not reach Revit.",{...P(sn),includeRecentTasks:sn.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),recentLimit:sn.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),includeRuntimeActivity:sn.boolean().optional().describe("Include MCP-side/client-side active and recent activity. Defaults true so guard-only tasks that did not reach Revit remain auditable."),runtimeActivityLimit:sn.number().int().min(0).max(100).optional().describe("Maximum runtimeActivity.recentActivity rows to return. Defaults 10."),runtimeActivityMode:sn.enum(["summary","full"]).optional().describe("runtimeActivity shape. summary is the default and collapses started/completed pairs into latest completed/guarded/failed rows without responseKeys. full includes started rows and full result summaries."),includeDiagnostics:sn.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),timeoutMs:sn.number().int().positive().max(1e4).optional().describe("Connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.includeRuntimeActivity===!1?void 0:Bs(t.runtimeActivityLimit??10,t.runtimeActivityMode||"summary");try{let o=t.timeoutMs||3e3,r=await ht(async s=>await s.sendCommand("mcp_status",{},{timeoutMs:o}),{...Pe(t),skipLock:!0,connectTimeoutMs:o}),a=No(jt(r),{includeRecentTasks:t.includeRecentTasks,recentLimit:t.recentLimit,includeDiagnostics:t.includeDiagnostics});fr(r);let i=a&&typeof a=="object"&&!Array.isArray(a)?a:{status:a};return b({...i,...n?{runtimeActivity:n}:{},spatialStore:ra(),runtimeIdentity:tu()})}catch(o){return b({success:!1,error:o instanceof Error?o.message:String(o),...n?{runtimeActivity:n}:{},spatialStore:ra(),runtimeIdentity:tu()})}})}import{z as ne}from"zod";import aS from"node:crypto";import Li from"node:path";import{Ajv2020 as iS}from"ajv/dist/2020.js";import sS from"ajv-formats";var Fi={"0.1":"https://schemas.revagent.app/spatial/v0.1/extraction-page.schema.json","0.2":"https://schemas.revagent.app/spatial/v0.2/extraction-page.schema.json","0.3":"https://schemas.revagent.app/spatial/v0.3/extraction-page.schema.json"},pw=Fi["0.3"],ji={"0.2":"https://schemas.revagent.app/spatial/v0.2/work-continuation.schema.json","0.3":"https://schemas.revagent.app/spatial/v0.3/work-continuation.schema.json"},gw=ji["0.3"],Di=["element-ref.schema.json","node-ref.schema.json","source-revision.schema.json","cursor-envelope.schema.json","spatial-snapshot.schema.json","extraction-page.schema.json"],lS=[...Di,"work-cursor-envelope.schema.json","work-continuation.schema.json"],cS=["profile.schema.json","spatial-properties.schema.json","fingerprints.schema.json","topology-coverage.schema.json","spatial-snapshot.schema.json","extraction-page.schema.json","work-continuation.schema.json"];function pt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function so(e){if(typeof e=="number"&&!Number.isFinite(e))throw new Error("Spatial canonical JSON rejects non-finite numbers.");return Array.isArray(e)?`[${e.map(so).join(",")}]`:pt(e)?`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${so(e[t])}`).join(",")}}`:JSON.stringify(e)}function aa(e){if(e===null)return"null";if(typeof e=="number"){if(!Number.isFinite(e))throw new Error("Semantic spatial JSON cannot contain a non-finite number.");let t=Object.is(e,-0)?0:e,n=new ArrayBuffer(8),o=new DataView(n);return o.setFloat64(0,t,!1),JSON.stringify(`n:${o.getBigUint64(0,!1).toString(16).padStart(16,"0")}`)}return typeof e=="string"?JSON.stringify(`s:${e}`):typeof e!="object"?JSON.stringify(e):Array.isArray(e)?`[${e.map(aa).join(",")}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${aa(e[t])}`).join(",")}}`}function uS(e){return`sha256:${aS.createHash("sha256").update(aa(e),"utf8").digest("hex")}`}function Vi(e){let t=Li.join(Yt(),"schemas","spatial",`v${e}`),n=e==="0.3"?cS:e==="0.2"?lS:Di,o=e==="0.3"?Di.map(u=>{let m=Vt(Li.join(Yt(),"schemas","spatial","v0.2",u));if(!m)throw new Error(`Missing required spatial v0.2 dependency schema: ${u}`);return m}):[],r=n.map(u=>{let m=Vt(Li.join(t,u));if(!m)throw new Error(`Missing required spatial schema: ${u}`);return m}),a=new iS({allErrors:!0,strict:!0,strictRequired:!1,allowUnionTypes:!0});sS(a);for(let u of[...o,...r])a.addSchema(u);let i=Fi[e],s=a.getSchema(i);if(!s)throw new Error(`Spatial extraction page schema was not compiled: ${i}`);let l=e==="0.2"||e==="0.3"?ji[e]:null,c=l?a.getSchema(l):null;if(l&&!c)throw new Error(`Spatial work continuation schema was not compiled: ${l}`);return{extractionPageValidator:s,workContinuationValidator:c}}var Wo={"0.1":Vi("0.1"),"0.2":Vi("0.2"),"0.3":Vi("0.3")},dS={"0.1":Wo["0.1"].extractionPageValidator,"0.2":Wo["0.2"].extractionPageValidator,"0.3":Wo["0.3"].extractionPageValidator},mS={"0.2":Wo["0.2"].workContinuationValidator,"0.3":Wo["0.3"].workContinuationValidator};function ru(e){return(e||[]).slice(0,100).map(t=>{let n=t.instancePath||"/",o=t.keyword==="additionalProperties"&&t.params?.additionalProperty?` unexpected property ${String(t.params.additionalProperty)}`:"";return`${n} ${String(t.message||t.keyword)}${o}`.trim()})}function pS(e){let t=[],n=pt(e.page)?e.page:{},o=Array.isArray(e.nodes)?e.nodes:[],r=Array.isArray(e.omissions)?e.omissions:[];if(e.snapshotId!==e.captureId&&t.push("/snapshotId must equal captureId for the Phase 0 native page"),n.recordCount!==void 0&&n.recordCount!==o.length&&t.push("/page/recordCount must equal nodes.length"),n.nodeCount!==void 0&&n.nodeCount!==o.length&&t.push("/page/nodeCount must equal nodes.length"),n.omissionCount!==r.length&&t.push("/page/omissionCount must equal omissions.length"),n.rowCount!==void 0&&n.rowCount!==o.length+r.length&&t.push("/page/rowCount must equal nodes.length + omissions.length"),n.pageHash!==n.pageSha256&&t.push("/page/pageHash must equal pageSha256"),n.priorPageHash!==n.priorPageSha256&&t.push("/page/priorPageHash must equal priorPageSha256"),n.nextCursor!==e.nextCursor&&t.push("/page/nextCursor must equal top-level nextCursor"),n.ordinal===0&&n.priorPageHash!==null&&t.push("/page/priorPageHash must be null on page 0"),n.ordinal>0&&typeof n.priorPageHash!="string"&&t.push("/page/priorPageHash is required after page 0"),e.pageCount<n.ordinal+1&&t.push("/pageCount cannot be smaller than page.ordinal + 1"),pt(e.coverage)){e.coverage.pageNodeCount!==o.length&&t.push("/coverage/pageNodeCount must equal nodes.length"),e.coverage.pageOmissionCount!==r.length&&t.push("/coverage/pageOmissionCount must equal omissions.length");let i=Array.isArray(e.sourceRevisions)?e.sourceRevisions:[];e.coverage.sourceCount!==i.length&&t.push("/coverage/sourceCount must equal sourceRevisions.length"),pt(e.effectiveSourcePolicy)&&e.coverage.effectiveScope!==e.effectiveSourcePolicy.hasEffectiveExtractionPolicy&&t.push("/coverage/effectiveScope must equal effectiveSourcePolicy.hasEffectiveExtractionPolicy")}if(pt(e.effectiveSourcePolicy)){let i=Array.isArray(e.effectiveSourcePolicy.effectiveSources)?e.effectiveSourcePolicy.effectiveSources:[];e.effectiveSourcePolicy.effectiveSourceCount!==i.length&&t.push("/effectiveSourcePolicy/effectiveSourceCount must equal effectiveSources.length")}let a=Array.isArray(n.rows)?n.rows:null;if(a){let i=a.filter(u=>pt(u)&&u.node!==void 0).map(u=>u.node),s=a.filter(u=>pt(u)&&u.omission!==void 0).map(u=>u.omission);a.length!==o.length+r.length&&t.push("/page/rows length must equal nodes.length + omissions.length"),so(i)!==so(o)&&t.push("/page/rows node records must exactly reproduce top-level nodes"),so(s)!==so(r)&&t.push("/page/rows omission records must exactly reproduce top-level omissions");let l=Buffer.byteLength(aa(a),"utf8");n.payloadBytes!==l&&t.push("/page/payloadBytes must equal UTF-8 canonical IEEE-754 page.rows bytes");let c=uS({captureId:e.captureId,pageOrdinal:n.ordinal,priorPageHash:n.priorPageHash,rows:a});n.pageHash!==c&&t.push("/page/pageHash must equal the canonical extraction-row envelope hash")}return t}function gS(e){let t=[],n=pt(e.preparation)?e.preparation:{};return e.snapshotId!==e.captureId&&t.push("/snapshotId must equal captureId for a Phase 1a work continuation"),n.nextCursor!==e.nextCursor&&t.push("/preparation/nextCursor must equal top-level nextCursor"),typeof n.total=="number"&&n.processed>n.total&&t.push("/preparation/processed cannot exceed preparation.total"),t}function au(e){let t=pt(e)&&typeof e.schemaVersion=="string"?e.schemaVersion:"",n=t==="0.1"||t==="0.2"||t==="0.3"?t:null,o=n?dS[n]:null;if(!n||!o)return{valid:!1,errors:[`Unsupported spatial extraction schemaVersion: ${t||"<missing>"}`],schemaId:null};let r=o(e),a=ru(o.errors);return r&&pt(e)&&a.push(...pS(e)),{valid:a.length===0,errors:a,schemaId:Fi[n]}}function iu(e){let t=pt(e)&&typeof e.schemaVersion=="string"?e.schemaVersion:"",n=t==="0.2"||t==="0.3"?t:null,o=n?mS[n]:null;if(!o||!n)return{valid:!1,errors:[`Unsupported spatial work continuation schemaVersion: ${t||"<missing>"}`],schemaId:null};let r=o(e),a=ru(o.errors);return r&&pt(e)&&a.push(...gS(e)),{valid:a.length===0,errors:a,schemaId:ji[n]}}var su="0.3",hS="host_internal_mm";var fS=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),uu=new Set(["complete","incomplete_omissions","incomplete_budget"]);function ln(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function v(e,...t){if(!ln(e))return;for(let o of t)if(Object.prototype.hasOwnProperty.call(e,o))return e[o];let n=Object.entries(e);for(let o of t){let r=n.find(([a])=>a.toLowerCase()===o.toLowerCase());if(r)return r[1]}}function Ie(e){if(typeof e=="number"&&Number.isInteger(e)&&Number.isFinite(e))return e;if(typeof e=="string"&&/^-?\d+$/.test(e.trim())){let t=Number.parseInt(e,10);return Number.isSafeInteger(t)?t:null}return null}function lu(e){if(typeof e=="number"&&Number.isFinite(e))return e;if(typeof e=="string"&&e.trim()){let t=Number(e);return Number.isFinite(t)?t:null}return null}function Bi(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function yS(e,t,n){let o=String(e??"").trim().toLowerCase();return fS.has(o)?o:n?t?"max_items":"completed":"read_failed"}function cu(e,t){let n=String(v(e,"coverageStatus")??"").trim().toLowerCase();if(uu.has(n))return n;if(t==="max_elapsed"||t==="max_items")return"incomplete_budget";let o=v(e,"counts"),r=v(e,"coverage"),a=Ie(v(o,"omittedSupportedNodes"))??0,i=Ie(v(r,"sourceAvailabilityOmissionCount"))??0;return a+i>0?"incomplete_omissions":"complete"}function ia(e){return typeof e=="string"&&/^sha256:[a-f0-9]{64}$/i.test(e)}function $o(e){return typeof e=="string"&&e.trim().length>0}function du(e,t){let n=ln(e)?e:{},o=String(v(n,"schemaVersion")??""),r=v(n,"page"),a=ln(r)?r:{},i=v(n,"nodes"),s=v(n,"omissions"),l=Array.isArray(i)?i:[],c=Array.isArray(s)?s:[],u=v(n,"success"),m=typeof u=="boolean"?u:!0,g=v(n,"guarded")===!0,p=String(v(n,"state")||(g?"guarded":m?"completed":"failed")),y=v(n,"nextCursor")??v(a,"nextCursor"),f=typeof y=="string"&&y.length>0?y:null,w=v(a,"hasMore"),T=typeof w=="boolean"?w:f!==null,I=Ie(v(a,"ordinal","pageOrdinal")??v(n,"pageOrdinal")),_=Ie(v(a,"targetBytes")),A=Ie(v(a,"payloadBytes")),R=Ie(v(n,"payloadBytes")),E=Ie(v(a,"recordCount")),S=Ie(v(a,"omissionCount")),k=Ie(v(a,"nodeCount"))??E??l.length,q=Ie(v(a,"rowCount"))??k+(S??c.length),X=v(a,"pageSha256","pageHash")??v(n,"pageHash"),re=v(a,"priorPageSha256","priorPageHash")??v(n,"priorPageHash"),Z=typeof re=="string"&&re.trim().length>0?re:null,pe=v(n,"partial"),Oe=typeof pe=="boolean"?pe:T,be=yS(v(n,"scanStoppedReason"),T,m),De=m&&!g?cu(n,be):null,Rt=lu(v(n,"elapsedMs"))??lu(t),Je=Bi(v(n,"suggestedNextScopes"));T&&!Je.includes("cursor")&&Je.push("cursor");let Ne={...a,ordinal:I,targetBytes:_,payloadBytes:A,recordCount:E??k,rowCount:q,nodeCount:k,omissionCount:S??c.length,hasMore:T,pageSha256:X??null,priorPageSha256:Z,nextCursor:f},Fe={...n,success:m,guarded:g,state:p,action:"capture_spatial_snapshot",warnings:Bi(v(n,"warnings")),notices:Bi(v(n,"notices")),nodes:l,omissions:c,page:Ne,pageOrdinal:I,rowCount:q,nodeCount:k,omissionCount:S??c.length,payloadBytes:R,pagePayloadBytes:A,pageHash:X??null,priorPageHash:Z,nextCursor:f,partial:Oe,coverageStatus:De,scanStoppedReason:be,suggestedNextScopes:Je,elapsedMs:Rt};if(Fe.snapshot={snapshotId:v(n,"snapshotId")??v(n,"captureId"),capturedAt:v(n,"capturedAt"),sourceRevisions:v(n,"sourceRevisions"),scope:v(n,"scope"),scopeFingerprint:v(n,"scopeFingerprint"),revisionFingerprint:v(n,"revisionFingerprint"),coordinateFrame:v(n,"coordinateFrame"),lengthUnit:v(n,"lengthUnit"),schemaVersion:v(n,"schemaVersion"),extractorVersion:v(n,"extractorVersion"),counts:v(n,"counts"),partial:Oe,coverageStatus:De,scanStoppedReason:be,suggestedNextScopes:Fe.suggestedNextScopes,pageCount:Ie(v(n,"pageCount")),payloadBytes:Ie(v(n,"payloadBytes"))},!m||g)return{payload:Fe,valid:!0,errors:[]};let x=au(n),j=[...x.errors];o!=="0.1"&&o!=="0.2"&&o!==su&&j.push(`schemaVersion must be 0.1, 0.2, or ${su}`),v(n,"coordinateFrame")!==hS&&j.push("coordinateFrame must be host_internal_mm"),v(n,"lengthUnit")!=="mm"&&j.push("lengthUnit must be mm"),$o(v(n,"extractorVersion"))||j.push("extractorVersion is required"),$o(v(n,"captureId"))||j.push("captureId is required"),$o(v(n,"snapshotId")??v(n,"captureId"))||j.push("snapshotId is required"),$o(v(n,"capturedAt"))||j.push("capturedAt is required"),ln(v(n,"scope"))||j.push("scope must be an object"),ia(v(n,"scopeFingerprint"))||j.push("scopeFingerprint must use sha256:<64 hex>"),ia(v(n,"revisionFingerprint"))||j.push("revisionFingerprint must use sha256:<64 hex>"),Array.isArray(v(n,"sourceRevisions"))||j.push("sourceRevisions must be an array"),ln(v(n,"counts"))||j.push("counts must be an object");let We=Ie(v(n,"pageCount"));(We===null||We<1)&&j.push("pageCount must be a positive integer");let Tt=Ie(v(n,"payloadBytes"));(Tt===null||Tt<0)&&j.push("payloadBytes must be a non-negative integer"),o==="0.1"?(v(n,"liveness")!=="unknown"&&j.push("Phase 0 liveness must be unknown"),v(n,"atomic")!==!1&&j.push("Phase 0 atomic must be false")):(o==="0.2"||o==="0.3")&&(v(n,"liveness")!=="staging"&&j.push("Durable-capture native transport page liveness must be staging"),v(n,"atomic")!==!1&&j.push("A native transport page is not the atomic store commit"),v(n,"captureConsistency")!=="document_change_sequence_bound"&&j.push("A durable-capture native transport page must be document_change_sequence_bound")),$o(v(n,"revisionBasisCaveat"))||j.push("revisionBasisCaveat is required"),Array.isArray(i)||j.push("nodes must be an array"),ln(r)||j.push("page must be an object"),(I===null||I<0)&&j.push("page.ordinal must be a non-negative integer"),(_===null||_<=0)&&j.push("page.targetBytes must be a positive integer"),(A===null||A<0)&&j.push("page.payloadBytes must be a non-negative integer"),(R===null||R<0)&&j.push("payloadBytes must be a non-negative logical capture total"),(k<0||k!==l.length)&&j.push("page.nodeCount/recordCount must equal nodes.length"),(S===null||S<0||S!==c.length)&&j.push("page.omissionCount must equal omissions.length"),(q<0||q!==l.length+c.length)&&j.push("page.rowCount must equal nodes.length + omissions.length"),ia(X)||j.push("page.pageSha256 must use sha256:<64 hex>"),(I??0)>0&&!ia(Z)&&j.push("page.priorPageSha256 must use sha256:<64 hex> after page 0"),T&&f===null&&j.push("page.nextCursor is required when page.hasMore is true"),!T&&f!==null&&j.push("page.nextCursor must be null when page.hasMore is false"),T&&!Oe&&j.push("partial must be true while page.hasMore is true");let Ot=v(n,"coverageStatus");return Ot!==void 0&&!uu.has(String(Ot).trim().toLowerCase())&&j.push("coverageStatus must be complete, incomplete_omissions, or incomplete_budget"),Ot!==void 0&&String(Ot).trim().toLowerCase()!==cu({...n,coverageStatus:void 0},be)&&j.push("coverageStatus conflicts with total omission/budget evidence"),be==="read_failed"&&De==="complete"&&j.push("read_failed requires omission coverage evidence"),Oe!==(T||De!=="complete")&&j.push("partial conflicts with pagination/coverage state"),(De==="incomplete_budget"?new Set(["max_elapsed","max_items"]):T?new Set(["max_bytes"]):De==="incomplete_omissions"?new Set(["read_failed"]):new Set(["completed"])).has(be)||j.push("scanStoppedReason conflicts with pagination/coverage state"),Fe.contractValidation={version:`spatial-extraction-page.v${o||"unknown"}`,schemaId:x.schemaId,valid:j.length===0,errors:j},Fe.pageEvidence=SS(Fe),{payload:Fe,valid:j.length===0,errors:j}}function SS(e){let t=ln(e)?e:{},n=ln(v(t,"page"))?v(t,"page"):{},o=v(t,"captureId"),r=v(t,"nextCursor")??v(n,"nextCursor");return{captureId:typeof o=="string"?o:null,pageOrdinal:Ie(v(n,"ordinal")??v(t,"pageOrdinal")),pageHash:v(n,"pageSha256")??v(t,"pageHash")??null,priorPageHash:v(n,"priorPageSha256")??v(t,"priorPageHash")??null,rowCount:Ie(v(n,"rowCount")??v(t,"rowCount")),nodeCount:Ie(v(n,"nodeCount","recordCount")??v(t,"nodeCount")),omissionCount:Ie(v(n,"omissionCount")),pagePayloadBytes:Ie(v(n,"payloadBytes")??v(t,"pagePayloadBytes")),payloadBytes:Ie(v(t,"payloadBytes")),hasMore:v(n,"hasMore")===!0,nextCursorPresent:typeof r=="string"&&r.length>0}}var qi="0.3",Wi=45e3,ca=12e4,bS=2,mu=1e4,pu=1e4,gu={discover:0,filter:1,extract:2,finalize:3};function we(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function C(e,...t){if(we(e)){for(let n of t)if(Object.prototype.hasOwnProperty.call(e,n))return e[n];for(let[n,o]of Object.entries(e))if(t.some(r=>n.toLowerCase()===r.toLowerCase()))return o}}function O(e){return typeof e=="string"?e.trim():""}function ie(e){if(typeof e=="number"&&Number.isSafeInteger(e))return e;if(typeof e=="string"&&/^-?\d+$/.test(e.trim())){let t=Number.parseInt(e,10);return Number.isSafeInteger(t)?t:null}return null}function zi(e){if(e==null||e==="")return null;let t=typeof e=="number"?e:Number(e);return Number.isFinite(t)?t:null}function gt(e){if(e===null||typeof e!="object")return JSON.stringify(e);if(Array.isArray(e))return`[${e.map(gt).join(",")}]`;let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${gt(t[n])}`).join(",")}}`}function _S(e,t){let n=Date.parse(O(e));return Number.isFinite(n)&&n>=0?n:t}function hu(e){if(!Array.isArray(e)||e.length!==3)return null;let t=e.map(zi);return t.every(n=>n!==null)?[t[0],t[1],t[2]]:null}function xS(e){let t=C(e,"geometry"),n=C(t,"aabb"),o=hu(C(n,"min","minMm")),r=hu(C(n,"max","maxMm"));return!o||!r||o.some((a,i)=>a>r[i])?null:{minMm:o,maxMm:r}}function vS(e){let t=we(e)?e:{},n=we(C(t,"nodeRef"))?C(t,"nodeRef"):t,o=we(C(t,"elementRef"))?C(t,"elementRef"):we(C(n,"elementRef"))?C(n,"elementRef"):{},r=Array.isArray(C(t,"sourceRefs"))?C(t,"sourceRefs"):C(n,"sourceRefs"),a=Array.isArray(r)&&we(r[0])?r[0]:{},i=O(C(o,"documentKey"))||O(C(a,"documentKey"));return{nodeId:O(C(t,"nodeId"))||O(C(n,"nodeId")),documentKey:i,nodeKind:O(C(t,"nodeKind"))||O(C(n,"nodeKind")),elementUniqueId:O(C(o,"elementUniqueId"))||null,linkInstanceUniqueId:O(C(o,"linkInstanceUniqueId"))||O(C(a,"linkInstanceUniqueId"))||null,aabb:xS(t),payload:t}}function wS(e){let t=we(e)?e:{},n=C(t,"elementRef"),o=C(t,"sessionEvidence"),r=we(n)?n:we(o)?o:{};return{documentKey:O(C(t,"documentKey"))||O(C(r,"documentKey"))||"unknown",reason:O(C(t,"classification","reason"))||"unclassified",sourceIdentity:O(C(r,"elementUniqueId"))||O(C(t,"linkInstanceUniqueId"))||null,payload:t}}function CS(e){let t=we(e)?e:{};return{documentKey:O(C(t,"documentKey")),documentSessionId:O(C(t,"documentSessionId")),trackerSessionId:O(C(t,"trackerSessionId"))||null,loadedVersion:O(C(t,"loadedVersion")),changeSequence:ie(C(t,"changeSequence"))??0,changeSequenceState:O(C(t,"changeSequenceState"))||null,oldestRetainedSequence:ie(C(t,"oldestRetainedSequence")),journalEntryCount:ie(C(t,"journalEntryCount")),journalCapacity:ie(C(t,"journalCapacity")),journalTruncated:C(t,"journalTruncated")===!0,linkInstanceUniqueId:O(C(t,"linkInstanceUniqueId"))||null,sourceToHostTransform:C(t,"sourceToHostTransform"),documentKeyResolution:C(t,"documentKeyResolution"),externalLinkUpdateAvailable:C(t,"externalLinkUpdateAvailable")===!0,metadata:t}}function IS(e){let t=O(C(e,"reason"));return t==="capture_interrupted_by_change"||t==="cursor_revision_mismatch"||t==="expired_capture_session"||t==="capture_session_expired"}function RS(e){return O(C(e,"continuationKind"))==="work"||O(C(e,"state"))==="in_progress"}function fu(e){return{captureId:O(e.captureId),snapshotId:O(e.snapshotId),capturedAt:O(e.capturedAt),schemaVersion:O(e.schemaVersion),extractorVersion:O(e.extractorVersion),coordinateFrame:O(e.coordinateFrame),lengthUnit:O(e.lengthUnit),captureConsistency:O(e.captureConsistency),revisionBasisCaveat:O(e.revisionBasisCaveat),scopeFingerprint:O(e.scopeFingerprint),sourceBindingFingerprint:O(e.sourceBindingFingerprint),scope:e.scope,effectiveSourcePolicy:e.effectiveSourcePolicy,scanPolicy:e.scanPolicy}}function Ui(e){if(e.length===0)return 0;let t=[...e].sort((n,o)=>n-o);return t[Math.max(0,Math.ceil(t.length*.95)-1)]}function sa(e){return{count:e.length,p95Ms:Ui(e),maxMs:e.length>0?Math.max(...e):0,totalMs:e.reduce((t,n)=>t+n,0)}}function Ue(e,t){return{liveness:"unknown",unknownReasons:[e],staleSourceKeys:[],warnings:[],evaluatedAt:new Date(t()).toISOString()}}function TS(e){let t=we(e)?e:{};for(let n=0;n<3&&!(C(t,"success")!==void 0||!we(C(t,"result")));n+=1)t=C(t,"result");return t}function ES(e,t,n=Date.now){if(t.length===0)return Ue("stored_source_revisions_missing",n);if(t.some(T=>T.changeSequenceState!=="tracked"||!O(T.trackerSessionId)))return Ue("stored_tracker_binding_incomplete",n);let o=new Set(t.map(T=>O(T.trackerSessionId)));if(o.size!==1)return Ue("stored_tracker_binding_inconsistent",n);let r=TS(e);if(C(r,"success")!==!0||C(r,"guarded")===!0||O(C(r,"state")).toLowerCase()!=="completed"||C(r,"trackerSubscribed")!==!0||O(C(r,"trackerSessionId"))!==[...o][0])return Ue("live_liveness_probe_failed",n);let a=C(r,"sourceStates");if(!Array.isArray(a)||a.length!==t.length||ie(C(r,"expectedSourceRevisionCount"))!==t.length)return Ue("live_liveness_probe_incomplete",n);let i=[],s=[],l=[],c=new Set,u=0;for(let T of a){let I=we(T)?T:{},_=ie(C(I,"inputOrdinal"));if(_===null||_<0||_>=t.length||c.has(_))return Ue("live_liveness_probe_incomplete",n);c.add(_);let A=t[_],R=O(A.linkInstanceUniqueId)||null,E=O(C(I,"linkInstanceUniqueId"))||null;if(O(C(I,"documentKey"))!==A.documentKey||E!==R)return Ue("live_liveness_probe_source_mismatch",n);let S=O(C(I,"liveness")).toLowerCase(),k=C(I,"externalLinkUpdateAvailable");if(typeof k!="boolean")return Ue("live_liveness_probe_external_observation_incomplete",n);if(k&&(u+=1),S!=="current"&&S!=="stale"&&S!=="unknown")return Ue("live_liveness_probe_invalid_state",n);if((S==="current"||S==="stale")&&C(I,"sourceResolved")!==!0)return Ue("live_liveness_probe_source_mismatch",n);i.push(S);let q=`${A.documentKey}::${R||"host"}`;S==="unknown"?s.push(O(C(I,"reason"))||"unknown_source_state"):S==="stale"&&l.push(q)}let m=i.includes("unknown")?"unknown":i.includes("stale")?"stale":"current",g=O(C(r,"liveness")).toLowerCase(),p=i.filter(T=>T==="current").length,y=i.filter(T=>T==="stale").length,f=i.filter(T=>T==="unknown").length,w=a.filter(T=>we(T)&&C(T,"sourceResolved")===!0).length;return ie(C(r,"externalLinkUpdateAvailableCount"))!==u?Ue("live_liveness_probe_external_observation_mismatch",n):g!==m||ie(C(r,"currentSourceCount"))!==p||ie(C(r,"staleSourceCount"))!==y||ie(C(r,"unknownSourceCount"))!==f||ie(C(r,"resolvedSourceCount"))!==w?Ue("live_liveness_probe_aggregate_mismatch",n):{liveness:m,unknownReasons:[...new Set(s)],staleSourceKeys:[...new Set(l)],warnings:u>0?["external_link_update_available: Newer linked-model source data is available; currently loaded Revit geometry remains authoritative until reload."]:[],evaluatedAt:new Date(n()).toISOString()}}async function $i(e,t,n,o=Date.now){let r;try{r=e.getSnapshotSources(t)}catch{return Ue("stored_source_revisions_unreadable",o)}if(!n)return Ue("live_liveness_probe_not_configured",o);try{let a=await n(r);return ES(a,r,o)}catch{return Ue("live_liveness_probe_failed",o)}}function lo(e){if(!we(e))return null;let t={};for(let[n,o]of Object.entries(e)){let r=ie(o);if(!n.trim()||r===null||r<1)return null;t[n]=r}return t}function la(e){return Object.values(e).reduce((t,n)=>t+n,0)}function NS(e){let t=we(e.counts)?e.counts:{},n=we(e.coverage)?e.coverage:{},o=C(t,"nodesByKind");if(!we(o))return null;let r={};for(let[S,k]of Object.entries(o)){let q=ie(k);if(!S.trim()||q===null||q<0)return null;r[S]=q}let a=ie(C(t,"totalNodes")),i=ie(C(t,"extractedSupportedNodes")),s=ie(C(t,"omittedSupportedNodes")),l=ie(C(t,"expectedSupportedNodes")),c=ie(C(n,"sourceAvailabilityOmissionCount")),u=ie(C(n,"totalOrderedRowCount")),m=ie(C(n,"classifiedOmissionCount")),g=ie(C(n,"unmaterializedOmissionCount")),p=ie(C(e,"payloadBytes")),y=lo(C(t,"omissionsByReason")),f=lo(C(t,"connectorOmissionsByReason")),w=lo(C(n,"omittedByClassification")),T=lo(C(n,"connectorOmittedByClassification")),I=lo(C(n,"unmaterializedOmissionsByClassification")),_=lo(C(n,"sourceOmittedByClassification"));if([a,i,s,l,c,u,m,g,p].some(S=>S===null||S<0)||!y||!f||!w||!T||!I||!_)return null;let A=la(y)+la(f),R=la(_),E=u-a;return E<0||i!==a||l!==i+s||g>s||la(I)!==g||s+c-g!==E||A!==s||R!==c||m!==s+c||gt(y)!==gt(w)||gt(f)!==gt(T)||Object.values(r).reduce((S,k)=>S+k,0)!==a?null:{expectedNodeCount:a,expectedOmissionCount:E,expectedPayloadBytes:p,expectedNodesByKind:r}}function At(e,t,n,o){return{success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"invalid_spatial_page_contract",error:e,contractValidation:t,partial:!1,scanStoppedReason:"read_failed",scanPolicy:n,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:o}}function co(e,t,n,o){return{...At(e,t,n,o),reason:"invalid_spatial_work_contract"}}function yu(e,t,n){return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"phase1b_native_contract_required",message:"The connected Revit add-in does not expose the SpatialSnapshot v0.3 Phase 1b native contract. Install the matching revAgent DLL before durable capture.",requiredSchemaVersion:qi,receivedSchemaVersion:O(e)||null,committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:t,suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null,elapsedMs:n}}async function Su(e,t){let n=t.now??Date.now,o=t.normalizePage??du,r=Math.max(0,Math.min(2,t.maxRetries??bS)),a=Math.max(1,Math.min(mu,t.maxPages??mu)),i=Math.max(1,Math.min(pu,t.maxWorkSteps??pu)),s=Math.max(1e3,Math.min(ca,e.maxCaptureElapsedMs??Wi)),l=n();try{t.store.applyConfiguredRetention()}catch{}let c=null;for(let u=0;u<=r;u+=1){let m=n(),g,p="",y=null,f=null,w=null,T=null,I=null,_=null,A=null,R=0,E=0,S=!1,k=!1,q=new Set,X=[],re=[],Z=[],pe=[],Oe=[];try{for(let be=0;be<a+i;be+=1){if(R>=a)return p&&S&&t.store.abandonCapture(p),At("Spatial capture exceeded the hard page-count bound.",{maxPages:a},e.scanPolicy,n()-l);if(n()-m>s)return p&&t.store.abandonCapture(p),{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"max_elapsed",message:"Atomic spatial capture exceeded its total bounded capture time; staging was discarded.",attempts:u+1,committed:!1,partial:!1,scanStoppedReason:"max_elapsed",scanPolicy:{...e.scanPolicy,maxCaptureElapsedMs:s},suggestedNextScopes:["narrow the explicit level/link/category scope"],warnings:[],notices:[],elapsedMs:n()-l};let De=n(),Rt=await t.sendPage({...e.nativeParams,cursor:g}),Je=Math.max(0,n()-De),Ne=we(Rt)&&we(Rt.result)?Rt.result:Rt;if(RS(Ne)){let Ze=iu(Ne);if(!Ze.valid||!we(Ne))return p&&S&&t.store.abandonCapture(p),co("The native extract_spatial_snapshot progress response did not satisfy the strict versioned work-continuation contract.",Ze.errors,e.scanPolicy,n()-l);if(O(Ne.schemaVersion)!==qi)return p&&S&&t.store.abandonCapture(p),yu(Ne.schemaVersion,e.scanPolicy,n()-l);if(S||R>0)return t.store.abandonCapture(p),co("Spatial preparation resumed after data-page staging had already started.",{expectedOrdinal:R,workStepCount:E},e.scanPolicy,n()-l);let Jt=Ne.preparation,dn=fu(Ne);if(f&&gt(dn)!==gt(f))return co("Spatial preparation capture/scope/source-binding metadata changed inside one capture.",{expectedCaptureId:f.captureId,receivedCaptureId:dn.captureId,expectedSourceBindingFingerprint:f.sourceBindingFingerprint,receivedSourceBindingFingerprint:dn.sourceBindingFingerprint},e.scanPolicy,n()-l);f=f||dn,p=p||dn.captureId;let Pt=O(Jt.phase),Xo=ie(Jt.stepOrdinal),Ln=ie(Jt.processed),yo=Jt.total===null?null:ie(Jt.total),Vn=O(Jt.nextCursor),as=gu[Pt],is=I===null?-1:gu[I],Sd=Xo!==E+1,bd=as===void 0||is===void 0||as<is,_d=I===Pt&&(Ln===null||_===null||Ln<_||yo!==A);if(Sd||bd||_d||!Vn||Vn===T)return co("Spatial preparation cursor, phase, or progress monotonicity failed.",{expectedStepOrdinal:E+1,receivedStepOrdinal:Xo,previousPhase:I,receivedPhase:Pt,previousProcessed:_,receivedProcessed:Ln,previousTotal:A,receivedTotal:yo,cursorAdvanced:!!(Vn&&Vn!==T)},e.scanPolicy,n()-l);if(E>=i)return co("Spatial preparation exceeded the hard work-continuation bound.",{maxWorkSteps:i},e.scanPolicy,n()-l);E+=1,Z.push(Je);let va=zi(Ne.elapsedMs);va!==null&&va>=0&&pe.push(va),Oe.includes(Pt)||Oe.push(Pt),T=Vn,I=Pt,_=Ln,A=yo,g=Vn;continue}X.push(Je);let Fe=o(Ne,Je),x=Fe.payload,j=zi(C(x,"elapsedMs"));if(j!==null&&j>=0&&re.push(j),x.guarded===!0){if(p&&t.store.abandonCapture(p),IS(x)){c=x,k=!0;break}return{...x,action:"capture_spatial_snapshot",attempts:u+1,committed:!1,elapsedMs:n()-l}}if(!Fe.valid)return p&&t.store.abandonCapture(p),At("The native extract_spatial_snapshot response did not satisfy the strict versioned extraction-page contract.",x.contractValidation||Fe.errors,e.scanPolicy,n()-l);if(O(x.schemaVersion)!==qi)return p&&t.store.abandonCapture(p),yu(x.schemaVersion,e.scanPolicy,n()-l);let We=we(x.page)?x.page:{},Tt=ie(We.ordinal),Ot=O(We.pageSha256||We.pageHash),un=O(We.priorPageSha256||We.priorPageHash)||null,W=O(x.captureId),Y=fu(x);if(p&&W!==p||f&&gt(Y)!==gt(f))return p&&S&&t.store.abandonCapture(p),co("The first spatial data page did not preserve the prepared capture/source-binding invariant.",{expectedCaptureId:p||f?.captureId||null,receivedCaptureId:W,expectedSourceBindingFingerprint:f?.sourceBindingFingerprint||null,receivedSourceBindingFingerprint:Y.sourceBindingFingerprint},e.scanPolicy,n()-l);if(p=p||W,Tt!==R||un!==w)return t.store.abandonCapture(p),At("Spatial page order/hash continuity failed before staging commit.",{expectedOrdinal:R,ordinal:Tt,expectedPriorPageHash:w,priorPageHash:un},e.scanPolicy,n()-l);let H={captureId:O(x.captureId),snapshotId:O(x.snapshotId||x.captureId),capturedAt:O(x.capturedAt),schemaVersion:O(x.schemaVersion),extractorVersion:O(x.extractorVersion),coordinateFrame:O(x.coordinateFrame),lengthUnit:O(x.lengthUnit),captureConsistency:O(x.captureConsistency),scopeFingerprint:O(x.scopeFingerprint),sourceBindingFingerprint:O(x.sourceBindingFingerprint),revisionFingerprint:O(x.revisionFingerprint),scope:x.scope,effectiveSourcePolicy:x.effectiveSourcePolicy,sourceRevisions:x.sourceRevisions,counts:x.counts,pageCount:ie(x.pageCount),payloadBytes:ie(x.payloadBytes)};if(y&&gt(H)!==gt(y))return t.store.abandonCapture(p),At("Spatial page revision/scope metadata changed inside one capture.",{expectedFingerprint:y.revisionFingerprint,receivedFingerprint:H.revisionFingerprint},e.scanPolicy,n()-l);y=y||H,S||(t.store.beginCapture({captureId:p,snapshotId:H.snapshotId,documentKey:O(C(x.scope,"hostDocumentKey")),scopeFingerprint:H.scopeFingerprint,revisionFingerprint:H.revisionFingerprint,schemaVersion:H.schemaVersion,extractorVersion:H.extractorVersion,scope:x.scope,counts:x.counts,effectiveSourcePolicy:x.effectiveSourcePolicy,coverage:x.coverage,transformValidation:x.transformValidation,captureMetadata:{coordinateFrame:x.coordinateFrame,lengthUnit:x.lengthUnit,captureConsistency:x.captureConsistency,sourceBindingFingerprint:H.sourceBindingFingerprint},capturedAtMs:_S(x.capturedAt,n())}),S=!0);let Qe=(Array.isArray(x.nodes)?x.nodes:[]).map(vS);for(let Ze of Qe){if(!Ze.nodeId||!Ze.documentKey||!Ze.nodeKind||q.has(Ze.nodeId))return t.store.abandonCapture(p),At("Spatial page contains a missing or duplicate composite node identity.",{nodeId:Ze.nodeId||null},e.scanPolicy,n()-l);q.add(Ze.nodeId)}let On=(Array.isArray(x.omissions)?x.omissions:[]).map(wS);if(t.store.stagePage({captureId:p,ordinal:Tt,priorPageHash:un,pageHash:Ot,hasMore:We.hasMore===!0,payloadBytes:ie(We.payloadBytes)??0,nodes:Qe,omissions:On}),w=Ot,R+=1,We.hasMore===!0){if(g=O(We.nextCursor||x.nextCursor),!g)return t.store.abandonCapture(p),At("A paginated spatial page did not provide its opaque next cursor.",{},e.scanPolicy,n()-l);continue}let Pn=ie(x.pageCount);if(Pn!==R)return t.store.abandonCapture(p),At("Final spatial page count does not match the staged chain.",{declaredPageCount:Pn,stagedPageCount:R},e.scanPolicy,n()-l);let Ht=NS(x);if(!Ht)return t.store.abandonCapture(p),At("Final spatial counts/coverage could not be reconciled into atomic commit expectations.",{counts:x.counts,coverage:x.coverage,payloadBytes:x.payloadBytes},e.scanPolicy,n()-l);let ho=(Array.isArray(x.sourceRevisions)?x.sourceRevisions:[]).map(CS),ge=t.store.commitCapture({captureId:p,sourceRevisions:ho,counts:x.counts,effectiveSourcePolicy:x.effectiveSourcePolicy,coverage:x.coverage,transformValidation:x.transformValidation,expectedPageCount:Pn,expectedPayloadBytes:Ht.expectedPayloadBytes,expectedNodeCount:Ht.expectedNodeCount,expectedOmissionCount:Ht.expectedOmissionCount,expectedNodesByKind:Ht.expectedNodesByKind,partial:x.partial===!0,coverageStatus:x.coverageStatus||null,scanStoppedReason:O(x.scanStoppedReason)||"completed",suggestedNextScopes:Array.isArray(x.suggestedNextScopes)?x.suggestedNextScopes.map(String):[]}),Gt=await $i(t.store,ge.snapshotId,t.probeLiveness,n),Ko=new Date(ge.committedAtMs).toISOString(),fo={snapshotId:ge.snapshotId,capturedAt:new Date(ge.capturedAtMs).toISOString(),sourceRevisions:x.sourceRevisions,scope:x.scope,scopeFingerprint:ge.scopeFingerprint,sourceBindingFingerprint:O(x.sourceBindingFingerprint),revisionFingerprint:ge.revisionFingerprint,coordinateFrame:x.coordinateFrame,lengthUnit:x.lengthUnit,schemaVersion:ge.schemaVersion,extractorVersion:ge.extractorVersion,atomic:!0,liveness:Gt.liveness,livenessBinding:{basis:"document_change_sequence",evaluatedAt:Gt.evaluatedAt||new Date(n()).toISOString(),sourceCount:ho.length,unknownReasons:[...new Set(Gt.unknownReasons||[])]},committedAt:Ko,counts:x.counts,partial:ge.partial,coverageStatus:ge.coverageStatus,scanStoppedReason:ge.scanStoppedReason,suggestedNextScopes:Array.isArray(x.suggestedNextScopes)?x.suggestedNextScopes:[],pageCount:ge.pageCount,payloadBytes:ge.payloadBytes};return{success:!0,guarded:!1,state:"completed",action:"capture_spatial_snapshot",message:ge.partial?"A revision-consistent partial spatial snapshot was atomically committed with explicit coverage limits.":"A complete revision-consistent spatial snapshot was atomically committed to the durable local store.",committed:!0,atomic:!0,liveness:Gt.liveness,snapshot:fo,snapshotId:ge.snapshotId,scopeFingerprint:ge.scopeFingerprint,sourceBindingFingerprint:O(x.sourceBindingFingerprint),revisionFingerprint:ge.revisionFingerprint,counts:{...x.counts,persistedNodes:ge.nodeCount,persistedOmissions:ge.omissionCount},coverage:x.coverage,transformValidation:x.transformValidation,pageCount:ge.pageCount,payloadBytes:ge.payloadBytes,partial:ge.partial,coverageStatus:ge.coverageStatus,scanStoppedReason:ge.scanStoppedReason,scanPolicy:{...e.scanPolicy,maxCaptureElapsedMs:s,maxRetries:r,maxWorkSteps:i},suggestedNextScopes:fo.suggestedNextScopes,attempts:u+1,pagePerformance:{roundTrip:sa(X),nativeUiOccupancy:{...sa(re),p95Within2000Ms:re.length>0&&Ui(re)<=2e3,maxWithin5000Ms:re.length>0&&Math.max(...re)<=5e3}},preparationPerformance:{continuationCount:E,phases:Oe,lastStepOrdinal:E>0?E:null,lastPhase:I,lastProcessed:_,lastTotal:A,roundTrip:sa(Z),nativeUiOccupancy:{...sa(pe),p95Within2000Ms:pe.length>0&&Ui(pe)<=2e3,maxWithin5000Ms:pe.length>0&&Math.max(...pe)<=5e3}},warnings:[...new Set([...Array.isArray(x.warnings)?x.warnings.map(String):[],...Gt.warnings||[]])],notices:Array.isArray(x.notices)?x.notices:[],nextCursor:null,elapsedMs:n()-l}}if(k){if(u<r)continue;break}return p&&t.store.abandonCapture(p),At("Spatial capture exceeded the hard page-count bound.",{maxPages:a},e.scanPolicy,n()-l)}catch(be){if(p&&S)try{t.store.abandonCapture(p)}catch{}return{success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"read_failed",error:be instanceof Error?be.message:String(be),committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:e.scanPolicy,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:n()-l}}}return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"capture_interrupted_by_change",message:"The model revision changed during all three bounded capture attempts; no mixed-revision snapshot was committed.",attempts:r+1,committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:e.scanPolicy,suggestedNextScopes:["wait for model edits to settle, then recapture the same explicit scope"],warnings:[],notices:[],nextCursor:null,elapsedMs:n()-l}}var MS=4*1024*1024,_u=64*1024,xu=8*1024*1024,AS=5e3,vu=25e3,kS=1800,wu=5e3,OS=12e3,Cu=6e4;function Ho(e,t,n,o){let r=Number.parseInt(String(e??""),10);return Number.isFinite(r)?Math.max(n,Math.min(o,r)):t}function Hi(e){return Array.isArray(e)?[...new Set(e.map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0):[]}function bu(e){return Array.isArray(e)?[...new Set(e.map(t=>/^\d+$/.test(String(t??"").trim())?Number.parseInt(String(t).trim(),10):Number.NaN).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n):[]}function PS(e){if(!Array.isArray(e))return[];let t=e.flatMap(n=>{if(!n||typeof n!="object"||Array.isArray(n))return[];let o=n,r=String(o.linkInstanceUniqueId??"").trim(),a=String(o.levelId??"").trim(),i=/^\d+$/.test(a)&&Number.parseInt(a,10)>0?Number.parseInt(a,10):null,s=String(o.levelUniqueId??"").trim(),l=String(o.levelName??"").trim();return!r||i===null&&!s&&!l?[]:[{linkInstanceUniqueId:r,levelId:i,levelUniqueId:s||null,levelName:l||null}]});return[...new Map(t.map(n=>[`${n.linkInstanceUniqueId}${n.levelId??""}${n.levelUniqueId??""}${(n.levelName??"").toUpperCase()}`,n])).values()].sort((n,o)=>{let r=`${n.linkInstanceUniqueId}${n.levelId??""}${n.levelUniqueId??""}${n.levelName??""}`,a=`${o.linkInstanceUniqueId}${o.levelId??""}${o.levelUniqueId??""}${o.levelName??""}`;return r<a?-1:r>a?1:0})}function Iu(e={}){let t=Ho(e.pageTargetBytes,MS,_u,xu),n=Ho(e.maxElements,AS,1,vu),o=Ho(e.maxElapsedMs,kS,250,wu),r=Ho(e.timeoutMs,Math.max(OS,o+15e3),Math.max(1e3,o+1e3),Cu);return{pageTargetBytes:t,maxElements:n,maxElapsedMs:o,timeoutMs:r,maxCaptureElapsedMs:Ho(e.maxCaptureElapsedMs,Wi,1e3,ca)}}function LS(e,t=Iu(e)){return{levelIds:bu(e.levelIds),levelNames:Hi(e.levelNames),sourceScope:e.sourceScope||"hostAndLinked",linkInstanceIds:bu(e.linkInstanceIds),linkInstanceUniqueIds:Hi(e.linkInstanceUniqueIds),linkedSourceLevels:PS(e.linkedSourceLevels),linkedSourceLevelNames:Hi(e.linkedSourceLevelNames),includeHostMep:e.includeHostMep!==!1,includeRoomsSpaces:e.includeRoomsSpaces!==!1,includeLinkedObstructions:e.includeLinkedObstructions!==!1,belowLevelMm:e.belowLevelMm,aboveLevelMm:e.aboveLevelMm,pageTargetBytes:t.pageTargetBytes,maxElements:t.maxElements,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,suppressTaskStatusWindow:!0,taskName:"Capture spatial snapshot page",taskId:void 0}}function VS(e){return e.levelIds.length>0||e.levelNames.length>0}function DS(e){return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"needs_scope",message:"capture_spatial_snapshot requires an explicit level scope. Pass levelIds and/or levelNames; broad whole-model extraction is not available.",partial:!1,scanStoppedReason:"needs_scope",scanPolicy:e,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:["No Revit command was sent."],nextCursor:null}}function Ru(e){e.tool("capture_spatial_snapshot","[SPATIAL_CAPTURE_READ_ONLY] Capture one explicit host-level scope as a durable SpatialSnapshot v0.3. The runtime owns opaque native paging, validates the revision/hash chain, stages every page in the user-local spatial store, and exposes the snapshot only after one atomic commit. The v0.3 native contract adds system/profile evidence, versioned placement/shape/property/topology fingerprints, and Connector.AllRefs-based topology with explicit coverage gaps; it never guesses connections from coincident coordinates. An older connected DLL is guarded as phase1b_native_contract_required. A DocumentChanged sequence interruption discards staging and retries at most twice; mixed revisions never commit. The host scope remains a physical host-Z band. Use placement-qualified linkedSourceLevels when linked Room/Space rows must match an exact source Level; linked obstructions remain physical band-overlap evidence. Returns current/stale/unknown liveness, explicit coverage, counts, page totals, and bounded performance evidence. This tool never writes the Revit model.",{...P(ne),...L(ne),levelIds:ne.array(ne.union([ne.number().int().positive(),ne.string()])).max(20).optional().describe("Explicit host Revit level ids. At least one levelIds or levelNames entry is required."),levelNames:ne.array(ne.string().min(1)).max(20).optional().describe("Explicit host Revit level names. At least one levelIds or levelNames entry is required."),sourceScope:ne.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),linkInstanceIds:ne.array(ne.union([ne.number().int().positive(),ne.string()])).max(100).optional().describe("Optional exact RevitLinkInstance ids inside the explicit level scope."),linkInstanceUniqueIds:ne.array(ne.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance unique ids inside the explicit level scope."),linkedSourceLevels:ne.array(ne.object({linkInstanceUniqueId:ne.string().min(1),levelId:ne.union([ne.number().int().positive(),ne.string().regex(/^[1-9]\d*$/)]).optional(),levelUniqueId:ne.string().min(1).optional(),levelName:ne.string().min(1).optional()}).refine(t=>t.levelId!==void 0||t.levelUniqueId!==void 0||t.levelName!==void 0,"Each linked source level selector requires levelId, levelUniqueId, and/or levelName.")).max(100).optional().describe("Optional placement-qualified exact linked source Level selectors for linked Room/Space rows. Use inspect_levels to obtain linkInstanceUniqueId plus level id/unique id/name. Applied in addition to the required host-Z level band; linked obstructions remain physical band-overlap evidence."),linkedSourceLevelNames:ne.array(ne.string().min(1)).max(100).optional().describe("Optional exact source Level names for linked Room/Space rows, matched case-insensitively across selected links. Applied in addition to the required host-Z level band; use placement-qualified linkedSourceLevels for unambiguous audit identity."),includeHostMep:ne.boolean().optional().describe("Include supported host-model MEP evidence. Defaults true."),includeRoomsSpaces:ne.boolean().optional().describe("Include supported Room/Space evidence from the selected source scope. Defaults true."),includeLinkedObstructions:ne.boolean().optional().describe("Include supported linked structural/architectural obstruction evidence. Defaults true."),belowLevelMm:ne.number().min(0).max(1e4).optional().describe("Optional bounded extent below each selected level, in millimetres. Defaults 1000; native cap 10000."),aboveLevelMm:ne.number().min(100).max(3e4).optional().describe("Optional bounded extent above each selected level, in millimetres. Defaults 6000; native cap 30000."),pageTargetBytes:ne.number().int().min(_u).max(xu).optional().describe("Native page target in bytes. Defaults 4 MiB; hard-capped at 8 MiB below the 32 MiB bridge ceiling."),maxElements:ne.number().int().positive().max(vu).optional().describe("Maximum source elements considered by this native page call. Defaults 5000; hard-capped at 25000."),maxElapsedMs:ne.number().int().min(250).max(wu).optional().describe("Maximum Revit UI occupancy target for one native page/chunk. Defaults 1800 ms; hard-capped at 5000 ms."),maxCaptureElapsedMs:ne.number().int().min(1e3).max(ca).optional().describe("Total bound for one full staged capture attempt. Defaults 45000 ms; hard-capped at 120000 ms."),timeoutMs:ne.number().int().min(2e3).max(Cu).optional().describe("Socket timeout for this one page. Defaults to at least 12000 ms with 15000 ms headroom above maxElapsedMs; hard-capped at 60000 ms.")},async t=>{let n=Iu(t),o=LS(t,n);if(!VS(o))return b(DS(n));try{let r=an(),a=await Su({nativeParams:o,scanPolicy:n,maxCaptureElapsedMs:n.maxCaptureElapsedMs},{store:r,sendPage:async i=>await U("extract_spatial_snapshot",i,{...z({target:t.target,host:t.host,port:t.port,timeoutMs:n.timeoutMs,taskName:"Capture spatial snapshot page"},"Capture spatial snapshot page"),toolName:"capture_spatial_snapshot",timeoutMs:n.timeoutMs}),probeLiveness:async i=>{let s=i.map(c=>c.metadata||c),l=await U("get_spatial_change_state",{sourceRevisions:s,expectedTrackerSessionId:i.find(c=>c.trackerSessionId)?.trackerSessionId,timeoutMs:Math.min(n.timeoutMs,1e4),suppressTaskStatusWindow:!0,taskName:"Read spatial change state"},{...z({target:t.target,host:t.host,port:t.port,timeoutMs:Math.min(n.timeoutMs,1e4),taskName:"Read spatial change state"},"Read spatial change state"),toolName:"capture_spatial_snapshot",timeoutMs:Math.min(n.timeoutMs,1e4)});return l&&l.result?l.result:l}});return b(a)}catch(r){let a=r instanceof Ct;return b({success:a,guarded:a,state:a?"guarded":"failed",action:"capture_spatial_snapshot",reason:a?r.reason:"read_failed",error:r instanceof Error?r.message:String(r),committed:!1,partial:!1,scanStoppedReason:"read_failed",scanPolicy:n,suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null})}})}import{z as N}from"zod";var $=1e-6;function ua(e){if(!Array.isArray(e)||e.length!==3)return null;let t=e.map(ze);return t.every(n=>n!==null)?[t[0],t[1],t[2]]:null}function ku(e,t){let n=te(e,t);return Ge(n)?n:null}function da(e){let t=ze(e);return t!==null&&t>=0?t:null}function FS(e){let t=ku(e,[["profile"],["spatialProperties","profile"],["physicalProfile"],["geometry","profile"]])??{},n=(K(t.shape)??K(t.profileShape)??K(te(e,[["shape"]])))?.toLowerCase()??"unknown",o=da(t.diameterMm??t.outerDiameterMm),r=da(t.widthMm),a=da(t.heightMm);return{shape:n.includes("round")||n.includes("circular")||o!==null?"round":n.includes("rect")||r!==null&&a!==null?"rectangular":"unknown",diameterMm:o,widthMm:r,heightMm:a,insulationThicknessMm:da(t.insulationThicknessMm??te(e,[["spatialProperties","insulationThicknessMm"],["insulationThicknessMm"]]))}}function kt(e){let t=ku(e.payload,[["geometry"]])??{},n=Ge(t.centerline)?t.centerline:null,o=Array.isArray(n?.points)?n.points.map(ua).filter(s=>s!==null):[],r=Ge(t.pointLocation)?t.pointLocation:null,a=ua(r?.point),i=Array.isArray(t.boundaryLoops)?t.boundaryLoops.filter(Array.isArray).map(s=>s.map(ua).filter(l=>l!==null)).filter(s=>s.length>=3):[];return{aabb:e.aabb,centerline:o,curveType:K(n?.curveType),point:a,boundaryLoops:i,direction:ua(t.direction),profile:FS(e.payload),basis:K(t.basis)??(e.aabb?"aabb":"unsupported"),precisionClass:K(t.precisionClass)??(e.aabb?"aabb_only":"unsupported")}}function pa(e,t){let n=Math.max(0,t);return{minMm:[e.minMm[0]-n,e.minMm[1]-n,e.minMm[2]-n],maxMm:[e.maxMm[0]+n,e.maxMm[1]+n,e.maxMm[2]+n]}}function ga(e,t){return e?t?{minMm:[Math.min(e.minMm[0],t.minMm[0]),Math.min(e.minMm[1],t.minMm[1]),Math.min(e.minMm[2],t.minMm[2])],maxMm:[Math.max(e.maxMm[0],t.maxMm[0]),Math.max(e.maxMm[1],t.maxMm[1]),Math.max(e.maxMm[2],t.maxMm[2])]}:e:t}function cn(e){return[(e.minMm[0]+e.maxMm[0])/2,(e.minMm[1]+e.maxMm[1])/2,(e.minMm[2]+e.maxMm[2])/2]}function Mn(e,t){return[e[0]-t[0],e[1]-t[1],e[2]-t[2]]}function Tu(e,t){return[e[0]+t[0],e[1]+t[1],e[2]+t[2]]}function Gi(e,t){return[e[0]*t,e[1]*t,e[2]*t]}function uo(e,t){return e[0]*t[0]+e[1]*t[1]+e[2]*t[2]}function ma(e){return Math.sqrt(uo(e,e))}function Ou(e){let t=ma(e);return t>$?Gi(e,1/t):null}function Pu(e,t,n,o){let r=[Math.max(0,n.minMm[0]-o.maxMm[0],o.minMm[0]-n.maxMm[0]),Math.max(0,n.minMm[1]-o.maxMm[1],o.minMm[1]-n.maxMm[1]),Math.max(0,n.minMm[2]-o.maxMm[2],o.minMm[2]-n.maxMm[2])],a=ma(r),i=r.every(c=>c<=$),s=[0,1,2].map(c=>Math.min(n.maxMm[c],o.maxMm[c])-Math.max(n.minMm[c],o.minMm[c])),l=Ou(Mn(cn(o),cn(n)));return{sourceNodeId:e,targetNodeId:t,relation:i?"intersects_candidate":"separated",separationMm:a,intersects:i,penetrationDepthMm:i?Math.max(0,Math.min(...s)):null,direction:l,basis:"aabb",precisionClass:"candidate",verdictCapability:"screening_only"}}function jS(e,t,n,o){let r=Mn(t,e),a=Mn(o,n),i=Mn(e,n),s=uo(r,r),l=uo(a,a),c=uo(a,i),u=0,m=0;if(s<=$&&l<=$)return ma(i);if(s<=$)m=Math.max(0,Math.min(1,c/l));else{let y=uo(r,i);if(l<=$)u=Math.max(0,Math.min(1,-y/s));else{let f=uo(r,a),w=s*l-f*f;Math.abs(w)>$&&(u=Math.max(0,Math.min(1,(f*c-y*l)/w))),m=(f*u+c)/l,m<0?(m=0,u=Math.max(0,Math.min(1,-y/s))):m>1&&(m=1,u=Math.max(0,Math.min(1,(f-y)/s)))}}let g=Tu(e,Gi(r,u)),p=Tu(n,Gi(a,m));return ma(Mn(g,p))}function BS(e,t){if(e.length<2||t.length<2)return null;let n=Number.POSITIVE_INFINITY;for(let o=1;o<e.length;o+=1)for(let r=1;r<t.length;r+=1)n=Math.min(n,jS(e[o-1],e[o],t[r-1],t[r]));return Number.isFinite(n)?n:null}function Eu(e){return e.shape==="round"&&e.diameterMm!==null&&e.insulationThicknessMm!==null?e.diameterMm/2+e.insulationThicknessMm:null}function Go(e,t){let n=kt(e),o=kt(t),r=Eu(n.profile),a=Eu(o.profile),i=r!==null&&a!==null&&n.curveType?.toLowerCase()==="line"&&o.curveType?.toLowerCase()==="line"&&n.centerline.length===2&&o.centerline.length===2?BS(n.centerline,o.centerline):null;if(i!==null){let s=i-r-a;return{sourceNodeId:e.nodeId,targetNodeId:t.nodeId,relation:s<=$?"intersects_analytic_profile":"separated",separationMm:Math.max(0,s),intersects:s<=$,penetrationDepthMm:s<0?-s:null,direction:e.aabb&&t.aabb?Ou(Mn(cn(t.aabb),cn(e.aabb))):null,basis:"analytic_straight_round_swept_profile",precisionClass:"measured",verdictCapability:"context_only"}}return e.aabb&&t.aabb?Pu(e.nodeId,t.nodeId,e.aabb,t.aabb):null}function Lu(e,t,n=0){if(!e.aabb||!t.aabb)return null;let o=Math.max(0,n),r=Pu(e.nodeId,t.nodeId,e.aabb,t.aabb),a,i=0;if(e.aabb.minMm[2]>t.aabb.maxMm[2]+o+$)a="above",i=e.aabb.minMm[2]-t.aabb.maxMm[2];else if(e.aabb.maxMm[2]<t.aabb.minMm[2]-o-$)a="below",i=t.aabb.minMm[2]-e.aabb.maxMm[2];else{let s=cn(e.aabb)[2]-cn(t.aabb)[2];a=Math.abs(s)<=o?"coincident":"overlapping"}return{...r,relation:`vertical_${a}`,separationMm:i,verticalRelation:a,basis:"aabb_vertical_extents",precisionClass:"candidate",verdictCapability:"screening_only"}}function Vu(e,t,n){let o=n[0]-t[0],r=n[1]-t[1],a=o**2+r**2;if(a<=$**2)return(e[0]-t[0])**2+(e[1]-t[1])**2<=$**2;let i=(e[1]-t[1])*(n[0]-t[0])-(e[0]-t[0])*(n[1]-t[1]);if(Math.abs(i)>$)return!1;let s=(e[0]-t[0])*(n[0]-t[0])+(e[1]-t[1])*(n[1]-t[1]);return s<-$?!1:s<=a+$}function Nu(e,t){let n=0;for(let o of t)for(let r=0;r<o.length;r+=1){let a=o[r],i=o[(r+1)%o.length];if(Vu(e,a,i))return"boundary";if(!(a[1]>e[1]!=i[1]>e[1]))continue;a[0]+(e[1]-a[1])*(i[0]-a[0])/(i[1]-a[1])>e[0]&&(n+=1)}return n%2===1?"inside":"outside"}function Mu(e,t,n,o,r){let a=t[0]-e[0],i=t[1]-e[1],s=o[0]-n[0],l=o[1]-n[1],c=n[0]-e[0],u=n[1]-e[1],m=(_,A,R,E)=>_*E-A*R,g=m(a,i,s,l),p=m(c,u,a,i),y=_=>e[2]+(t[2]-e[2])*_,f=(_,A)=>{let R=Math.max(0,Math.min(_,A)),E=Math.min(1,Math.max(_,A));if(R>E+$)return!1;let S=t[2]-e[2];if(Math.abs(S)<=$)return e[2]>=r.minMm[2]-$&&e[2]<=r.maxMm[2]+$;let k=(r.minMm[2]-e[2])/S,q=(r.maxMm[2]-e[2])/S,X=Math.min(k,q)-$,re=Math.max(k,q)+$;return E>=X&&R<=re};if(Math.abs(g)>$){let _=m(c,u,s,l)/g,A=m(c,u,a,i)/g;if(_<-$||_>1+$||A<-$||A>1+$)return!1;let R=y(Math.max(0,Math.min(1,_)));return R>=r.minMm[2]-$&&R<=r.maxMm[2]+$}if(Math.abs(p)>$)return!1;let w=a*a+i*i;if(w<=$*$)return Vu(e,n,o)&&Ji(e,t,r);let T=(c*a+u*i)/w,I=((o[0]-e[0])*a+(o[1]-e[1])*i)/w;return f(T,I)}function Ji(e,t,n){let o=Math.min(e[2],t[2]);return Math.max(e[2],t[2])>=n.minMm[2]-$&&o<=n.maxMm[2]+$}function qS(e){if(e.point)return[e.point];if(e.centerline.length>0){let t=[];for(let n=0;n<e.centerline.length;n+=1)if(t.push(e.centerline[n]),n>0){let o=e.centerline[n-1],r=e.centerline[n];t.push([(o[0]+r[0])/2,(o[1]+r[1])/2,(o[2]+r[2])/2])}return t}if(e.boundaryLoops.length>0){let t=[];for(let n of e.boundaryLoops)for(let o=0;o<n.length;o+=1){let r=n[o],a=n[(o+1)%n.length];t.push(r,[(r[0]+a[0])/2,(r[1]+a[1])/2,(r[2]+a[2])/2])}return t}return[]}function zS(e,t,n){let o=t[2]-e[2];if(Math.abs(o)<=$)return[];let r=(n.minMm[2]-e[2])/o,a=(n.maxMm[2]-e[2])/o,i=Math.max(0,Math.min(r,a)),s=Math.min(1,Math.max(r,a));if(i>s+$)return[];let l=c=>[e[0]+(t[0]-e[0])*c,e[1]+(t[1]-e[1])*c,e[2]+o*c];return[l(i),l((i+s)/2),l(s)]}function US(e,t){e.some(n=>n.every((o,r)=>Math.abs(o-t[r])<=$))||e.push(t)}function Ki(e,t){let n=kt(e),o=kt(t);if(!t.aabb||o.boundaryLoops.length===0)return{elementNodeId:e.nodeId,spaceNodeId:t.nodeId,status:"unsupported",basis:"spatial_boundary_unavailable",precisionClass:"candidate",verdictCapability:"context_only",insideSampleCount:0,boundarySampleCount:0,outsideSampleCount:0,segmentBoundaryCrossing:!1};let r=qS(n);if(r.length===0)return{elementNodeId:e.nodeId,spaceNodeId:t.nodeId,status:"unsupported",basis:"element_point_centerline_or_boundary_unavailable",precisionClass:"candidate",verdictCapability:"context_only",insideSampleCount:0,boundarySampleCount:0,outsideSampleCount:0,segmentBoundaryCrossing:!1};let a=!1;for(let u=1;u<n.centerline.length;u+=1){let m=n.centerline[u-1],g=n.centerline[u],p=zS(m,g,t.aabb);for(let f of p)US(r,f);(m[2]<t.aabb.minMm[2]-$||m[2]>t.aabb.maxMm[2]+$||g[2]<t.aabb.minMm[2]-$||g[2]>t.aabb.maxMm[2]+$)&&p.some(f=>Nu(f,o.boundaryLoops)!=="outside")&&(a=!0)}let i=0,s=0,l=0;for(let u of r){let m=u[2]>=t.aabb.minMm[2]-$&&u[2]<=t.aabb.maxMm[2]+$,g=Nu(u,o.boundaryLoops);!m||g==="outside"?l+=1:g==="boundary"?s+=1:i+=1}for(let u=1;u<n.centerline.length&&!a;u+=1){let m=n.centerline[u-1],g=n.centerline[u];if(Ji(m,g,t.aabb))for(let p of o.boundaryLoops){for(let y=0;y<p.length;y+=1)if(Mu(m,g,p[y],p[(y+1)%p.length],t.aabb)){a=!0;break}if(a)break}}for(let u of n.boundaryLoops)for(let m=0;m<u.length&&!a;m+=1){let g=u[m],p=u[(m+1)%u.length];if(Ji(g,p,t.aabb))for(let y of o.boundaryLoops){for(let f=0;f<y.length;f+=1)if(Mu(g,p,y[f],y[(f+1)%y.length],t.aabb)){a=!0;break}if(a)break}}let c=s>0&&i===0&&l===0?"boundary":i>0&&l===0&&!a?"inside":i>0||s>0||a?"partial":"outside";return{elementNodeId:e.nodeId,spaceNodeId:t.nodeId,status:c,basis:"stored_boundary_loops_and_vertical_extent",precisionClass:"measured",verdictCapability:"context_only",insideSampleCount:i,boundarySampleCount:s,outsideSampleCount:l,segmentBoundaryCrossing:a}}function Au(e,t){return e.map(n=>Mn(n,t))}function Xi(e){if(e.placementFingerprint)return e.placementFingerprint;let t=kt(e),n=t.point??t.centerline[0]??(t.aabb?cn(t.aabb):[0,0,0]);return vt({version:"phase1b-derived-placement/1",anchor:n})}function Yi(e){if(e.shapeFingerprint)return e.shapeFingerprint;let t=kt(e),n=t.point??t.centerline[0]??(t.aabb?cn(t.aabb):[0,0,0]),o=t.aabb?[t.aabb.maxMm[0]-t.aabb.minMm[0],t.aabb.maxMm[1]-t.aabb.minMm[1],t.aabb.maxMm[2]-t.aabb.minMm[2]]:null;return vt({version:"phase1b-derived-shape/1",centerline:Au(t.centerline,n),boundaryLoops:t.boundaryLoops.map(r=>Au(r,n)),extents:o,profile:t.profile,curveType:t.curveType})}function Qi(e){return e.propertyFingerprint?e.propertyFingerprint:vt({version:"phase1b-derived-property/1",category:e.category,builtInCategory:e.builtInCategory,categoryRole:e.categoryRole,levelUniqueId:e.levelUniqueId,levelName:e.levelName,systemKey:e.systemKey,name:te(e.payload,[["name"]]),familyName:te(e.payload,[["familyName"]]),typeName:te(e.payload,[["typeName"]]),spatialProperties:te(e.payload,[["spatialProperties"]])})}function Zi(e){if(e.topologyFingerprint)return e.topologyFingerprint;let t=te(e.payload,[["connectedToNodeIds"],["peerNodeIds"],["topology","connectedToNodeIds"]]);return e.nodeKind!=="connector"&&!Array.isArray(t)?null:vt({version:"phase1b-derived-topology/1",ownerNodeId:e.ownerNodeId,peers:Array.isArray(t)?[...new Set(t.map(String))].sort():[],systemKey:e.systemKey,isConnected:te(e.payload,[["isConnected"]])===!0})}var WS=new Set(["ost_ductcurves","ost_flexductcurves","ost_ductfitting","ost_ductaccessory","ost_pipecurves","ost_flexpipecurves","ost_pipefitting","ost_pipeaccessory"]);function es(e,t){return K(te(e.payload,t))?.toLowerCase()??null}function $S(e,t,n){let o=e.getStoredNode(t,n);if(!o)return!1;if(WS.has(o.builtInCategory?.toLowerCase()??""))return!0;let r=e.queryStoredEdges({snapshotId:t,sourceNodeIds:[n],relationTypes:["owns_connector"],limit:2e3});if(r.hasMore)return!1;let a=r.edges.map(u=>u.targetNodeId);if(a.length<=1)return!0;let i=e.getStoredNodesByIds(t,a);return i.length!==a.length||new Set(i.map(u=>u.systemKey).filter(u=>!!u)).size!==1||i.some(u=>!u.systemKey)||new Set(i.map(u=>es(u,[["domain"]])).filter(u=>u!==null)).size!==1||i.some(u=>es(u,[["domain"]])===null)?!1:new Set(i.map(u=>es(u,[["spatialProperties","systemClassification"]])).filter(u=>u!==null)).size<=1}function HS(e,t){return e.sourceNodeId===t?e.targetNodeId:e.targetNodeId===t&&(e.bidirectional||e.relationType==="owns_connector")?e.sourceNodeId:null}function Du(e,t,n){let o=K(n.startNodeId)??"",r=K(n.targetNodeId),a=ke(n.maxDepth,20,0,100),i=ke(n.maxNodes,500,1,5e3),s=[{nodeId:o,depth:0}],l=new Set,c=new Map,u=new Map,m=0,g=!1,p=new Set,y=new Map;for(;s.length>0;){let _=s.shift();if(l.has(_.nodeId))continue;if(l.size>=i){g=!0;break}if(l.add(_.nodeId),m=Math.max(m,_.depth),r&&_.nodeId===r)break;let A=e.queryStoredEdges({snapshotId:t,incidentNodeIds:[_.nodeId],relationTypes:["connected_to","owns_connector"],limit:2e3});A.hasMore&&(g=!0);let R=A.edges.map(E=>({edge:E,neighbor:HS(E,_.nodeId)})).filter(E=>E.neighbor!==null).filter(({edge:E})=>{if(E.relationType!=="owns_connector")return!0;let S=E.sourceNodeId;if(_.nodeId===S&&S===o||_.nodeId!==S&&S===r)return!0;let k=y.get(S);return k===void 0&&(k=$S(e,t,S),y.set(S,k)),k||p.add(S),k}).sort((E,S)=>fe(E.neighbor,S.neighbor)||fe(E.edge.edgeId,S.edge.edgeId));for(let{edge:E,neighbor:S}of R){if(c.set(E.edgeId,E),_.depth>=a){l.has(S)||(g=!0);continue}!l.has(S)&&!u.has(S)&&(u.set(S,{nodeId:_.nodeId,edgeId:E.edgeId}),s.push({nodeId:S,depth:_.depth+1}))}}let f=r?l.has(r):null;p.size>0&&f!==!0&&(g=!0);let w=[],T=[];if(r&&f){let _=r;for(w.push(_);_!==o;){let A=u.get(_);if(!A)break;T.push(A.edgeId),_=A.nodeId,w.push(_)}w.reverse(),T.reverse()}let I=[...l].sort(fe);return{startNodeId:o,targetNodeId:r,reachedTarget:r&&!f&&g?null:f,visitedNodeIds:I,nodes:e.getStoredNodesByIds(t,I),edges:[...c.values()].sort((_,A)=>fe(_.edgeId,A.edgeId)),pathNodeIds:w,pathEdgeIds:T,maxDepthReached:m,complete:!g,truncated:g,unsupportedOwnerNodeIds:[...p].sort(fe),basis:"stored_connector_topology",precisionClass:"measured",verdictCapability:"context_only"}}import ts from"node:crypto";var Fu="spatial-query-cursor-v1",ha="1",ju=16384,GS=ts.randomBytes(32),Ye=class extends Error{reason="invalid_cursor";constructor(t,n){super(t,n),this.name="SpatialQueryCursorError"}};function Bu(e){return ts.createHmac("sha256",GS).update(e).digest()}function qu(e){return vt(e)}function ns(e){let t={cursorVersion:ha,snapshotId:e.snapshotId,revisionFingerprint:e.revisionFingerprint,queryFingerprint:e.queryFingerprint,lastNodeId:e.lastNodeId,nodePageEndId:e.nodePageEndId,lastEdgeId:e.lastEdgeId},n=Buffer.from(xe(t),"utf8"),o=`${Fu}.${n.toString("base64url")}.${Bu(n).toString("base64url")}`;if(o.length>ju)throw new Ye("Spatial query cursor exceeds the bounded encoded size.");return o}function zu(e,t){if(typeof e!="string"||e.length===0||e.length>ju)throw new Ye("Spatial query cursor is missing or outside the supported size.");let n=e.split(".");if(n.length!==3||n[0]!==Fu)throw new Ye("Spatial query cursor prefix or segment count is invalid.");let o,r;try{o=Buffer.from(n[1],"base64url"),r=Buffer.from(n[2],"base64url")}catch(c){throw new Ye("Spatial query cursor encoding is invalid.",{cause:c})}let a=Bu(o);if(r.length!==a.length||!ts.timingSafeEqual(r,a))throw new Ye("Spatial query cursor signature is invalid.");let i;try{i=JSON.parse(o.toString("utf8"))}catch(c){throw new Ye("Spatial query cursor JSON is invalid.",{cause:c})}if(!Ge(i))throw new Ye("Spatial query cursor envelope is invalid.");let s={cursorVersion:i.cursorVersion===ha?ha:"1",snapshotId:K(i.snapshotId)??"",revisionFingerprint:K(i.revisionFingerprint)??"",queryFingerprint:K(i.queryFingerprint)??"",lastNodeId:K(i.lastNodeId),nodePageEndId:K(i.nodePageEndId),lastEdgeId:K(i.lastEdgeId)};if(i.cursorVersion!==ha||s.snapshotId!==t.snapshotId||s.revisionFingerprint!==t.revisionFingerprint||s.queryFingerprint!==t.queryFingerprint)throw new Ye("Spatial query cursor does not match the requested snapshot, revision, or filters.");let l=new Set(["cursorVersion","snapshotId","revisionFingerprint","queryFingerprint","lastNodeId","nodePageEndId","lastEdgeId"]);if(Object.keys(i).some(c=>!l.has(c)))throw new Ye("Spatial query cursor contains unsupported fields.");if(s.nodePageEndId===null!=(s.lastEdgeId===null))throw new Ye("Spatial query cursor edge continuation state is incomplete.");return s}var Hu="query_spatial_context",fa=1e4,Uu=8*1024*1024;function mo(e){return e==="0.3"?{schemaVersion:e,adapter:"native_v03",geometry:!0,properties:!0,topology:!0,analyticClearance:!0,containment:!0,limitations:["analytic_clearance_is_limited_to_explicitly_supported_straight_round_swept_profiles","aabb_only_shape_change_not_classified_without_rotation_invariant_primitive","relation_outputs_are_context_or_screening_only_never_live_verdict"]}:e==="0.2"?{schemaVersion:e,adapter:"legacy_v02",geometry:!0,properties:!1,topology:!1,analyticClearance:!1,containment:!0,limitations:["legacy_v02_has_no_system_property_or_topology_contract","legacy_v02_has_no_supported_profile_clearance_contract","legacy_v02_indexed_metadata_filters_require_explicit_node_ids","relation_outputs_are_context_or_screening_only_never_live_verdict"]}:null}function oe(e,t,n=[],o={},r){return{success:!0,guarded:!0,state:"guarded",action:Hu,reason:e,message:t,partial:r?.partial??!1,...r===void 0?{}:{coverageStatus:r.coverageStatus},truncated:!1,scanStoppedReason:e==="needs_scope"?"needs_scope":e==="max_bytes"?"max_bytes":"read_failed",scanPolicy:o,suggestedNextScopes:e==="needs_scope"?["snapshotId","nodeIds"]:[],nextCursor:null,warnings:[...new Set(n)],notices:[],elapsedMs:0,queryId:Wt("spatial-query"),counts:{nodeCount:0,edgeCount:0,computedCount:0}}}function os(e,t){return[...new Set([...e.trust?.warnings??[],...t.limitations,...e.trust?.liveness&&e.trust.liveness!=="current"?[`snapshot_liveness_${e.trust.liveness}`]:[]])]}function Wu(e){return!!(e&&[e.categories,e.builtInCategories,e.categoryRoles,e.levelNames,e.levelUniqueIds,e.systemKeys,e.ownerNodeIds].some(t=>Array.isArray(t)&&t.length>0))}function JS(e){return e?!!(e.aabb||e.elevationBandMm||Object.entries(e).some(([t,n])=>t!=="aabb"&&t!=="elevationBandMm"&&Array.isArray(n)&&n.some(o=>K(o)!==null))):!1}function rs(e,t,n,o){return{snapshotId:e,nodeIds:t?.nodeIds,nodeKinds:t?.nodeKinds,categories:t?.categories,builtInCategories:t?.builtInCategories,categoryRoles:t?.categoryRoles,levelNames:t?.levelNames,levelUniqueIds:t?.levelUniqueIds,systemKeys:t?.systemKeys,ownerNodeIds:t?.ownerNodeIds,aabb:t?.aabb,elevationBandMm:t?.elevationBandMm,limit:n,afterNodeId:o}}function Gu(e,t){let n=[Math.max(e.minMm[0],t.minMm[0]),Math.max(e.minMm[1],t.minMm[1]),Math.max(e.minMm[2],t.minMm[2])],o=[Math.min(e.maxMm[0],t.maxMm[0]),Math.min(e.maxMm[1],t.maxMm[1]),Math.min(e.maxMm[2],t.maxMm[2])];return n.every((r,a)=>r<=o[a])?{minMm:n,maxMm:o}:null}function Ju(e,t,n){let o=n?.elevationBandMm;if(o){let l=ze(o.minZ),c=ze(o.maxZ);if(l===null||c===null||l>c)return oe("invalid_filter","elevationBandMm requires finite minZ <= maxZ.")}let r=[...new Set((n?.withinSpaceNodeIds??[]).map(K).filter(l=>l!==null))].sort(fe);if(r.length>100)return oe("needs_scope","withinSpaceNodeIds is bounded to at most 100 explicit space nodes.");let a={...n??{}};if(delete a.withinSpaceNodeIds,r.length===0)return{storeFilters:a,spaces:[],empty:!1};let i=e.getStoredNodesByIds(t,r);if(i.length!==r.length)return oe("node_not_found","Every withinSpaceNodeIds entry must identify a committed node in the selected snapshot.");let s=null;for(let l of i){let c=kt(l);if(!l.aabb||c.boundaryLoops.length===0)return oe("unsupported_geometry","withinSpaceNodeIds requires stored boundary loops and vertical extents for every selected space.");s=ga(s,l.aabb)}if(!s)return{storeFilters:a,spaces:i,empty:!0};if(a.aabb){let l=Gu(a.aabb,s);if(!l)return{storeFilters:a,spaces:i,empty:!0};a.aabb=l}else a.aabb=s;return{storeFilters:a,spaces:i,empty:!1}}function Ku(e,t,n,o,r){if(n.empty)return{nodes:[],hasMore:!1,pageEndNodeId:r,scannedNodeCount:0,unsupportedNodeId:null};if(n.spaces.length===0){let u=e.queryStoredNodes(rs(t,n.storeFilters,o,r));return{nodes:u.nodes,hasMore:u.hasMore,pageEndNodeId:u.nodes.at(-1)?.nodeId??r,scannedNodeCount:u.nodes.length,unsupportedNodeId:null}}let a=[],i=Math.min(fa,Math.max(1e3,o*20)),s=r,l=0,c=!1;for(;a.length<o&&l<i;){let u=e.queryStoredNodes(rs(t,n.storeFilters,Math.min(1e3,i-l),s));for(let m=0;m<u.nodes.length;m+=1){let g=u.nodes[m];if(l+=1,s=g.nodeId,n.spaces.some(y=>y.nodeId===g.nodeId))continue;let p=n.spaces.map(y=>Ki(g,y));if(p.some(y=>y.status==="inside"||y.status==="boundary"))a.push(g);else if(p.some(y=>y.status==="unsupported"))return{nodes:[],hasMore:!1,pageEndNodeId:s,scannedNodeCount:l,unsupportedNodeId:g.nodeId};if(a.length>=o){c=m+1<u.nodes.length||u.hasMore;break}}if(a.length>=o)break;if(!u.hasMore){c=!1;break}if(!u.nextNodeId||u.nextNodeId===s&&u.nodes.length===0){c=!0;break}u.nodes.length>0&&(s=u.nodes.at(-1).nodeId),c=!0}return l>=i&&(c=!0),{nodes:a,hasMore:c,pageEndNodeId:s,scannedNodeCount:l,unsupportedNodeId:null}}function KS(e,t,n,o){let r=[],a=null,i=!1;for(;r.length<o;){let s=e.queryStoredNodes(rs(t,n,Math.min(1e3,o-r.length),a));if(r.push(...s.nodes),!s.hasMore)break;if(!s.nextNodeId||s.nextNodeId===a){i=!0;break}a=s.nextNodeId,r.length>=o&&(i=!0)}return{nodes:r,truncated:i}}function XS(e,t,n,o){let r=[],a=null,i=!1;for(;r.length<o;){let s=Ku(e,t,n,Math.min(1e3,o-r.length),a);if(s.unsupportedNodeId)return{nodes:[],truncated:!1,guarded:oe("unsupported_geometry","within-space filtering encountered an AABB-only candidate that cannot be classified as inside or outside.",[`unsupported_node_id:${s.unsupportedNodeId}`])};if(r.push(...s.nodes),!s.hasMore)break;if(!s.pageEndNodeId||s.pageEndNodeId===a){i=!0;break}a=s.pageEndNodeId,r.length>=o&&(i=!0)}return{nodes:r,truncated:i}}function YS(e){return e.complete&&!e.partial&&e.coverageStatus==="complete"}function QS(e,t,n,o){let r=[K(n),K(o)];if(r.some(c=>!c))return null;let a=e.getStoredNodesByIds(t,r),i=new Map(a.map(c=>[c.nodeId,c])),s=i.get(r[0]),l=i.get(r[1]);return s&&l?[s,l]:null}function ZS(e,t,n){return["nearest_elements","elements_within","locate_in_space","trace_connectivity"].includes(e.name)&&!n?oe("incomplete_snapshot",`${e.name} requires a complete snapshot because missing nodes could change the deterministic result.`):e.name==="trace_connectivity"&&!t.topology?oe("unsupported_snapshot_capability","trace_connectivity requires a v0.3 snapshot with explicit connector peer topology.",t.limitations):e.name==="clearance_between"&&!t.analyticClearance?oe("unsupported_snapshot_capability","clearance_between requires a v0.3 snapshot with explicit supported profile dimensions.",t.limitations):null}function $u(e,t,n,o){return{success:!0,guarded:!1,state:"completed",action:Hu,queryId:Wt("spatial-query"),snapshotId:e.snapshotId,revisionFingerprint:e.revisionFingerprint,scopeFingerprint:e.scopeFingerprint,liveness:t.trust?.liveness??"unknown",mode:t.mode,capabilityCoverage:n,verdictCapability:"context_only",scanStoppedReason:"completed",scanPolicy:{},suggestedNextScopes:[],counts:{},warnings:os(t,n),notices:[],elapsedMs:Date.now()-o}}function eb(e,t,n){let o=QS(e,t,n.sourceNodeId,n.targetNodeId);if(!o)return null;let r=n.name==="above_below"?Lu(o[0],o[1],n.toleranceMm):Go(o[0],o[1]);return r?{nodes:o,computed:r}:null}function tb(e,t,n){let o=e.getStoredNode(t,n.anchorNodeId),r=ze(n.name==="nearest_elements"?n.maxDistanceMm:n.distanceMm);if(!o||!o.aabb||r===null||r<0)return null;let a=ke(n.limit,20,1,500),i=pa(o.aabb,r),s=n.filters?.aabb?Gu(n.filters.aabb,i):i;if(!s)return{nodes:[o],computed:[],truncated:!1,candidateCount:0};let l={...n.filters??{},aabb:s},c=Ju(e,t,l);if("guarded"in c)return{guarded:c};let u=XS(e,t,c,fa);if(u.guarded)return{guarded:u.guarded};let m=u.nodes.filter(p=>p.nodeId!==o.nodeId).map(p=>({node:p,relation:Go(o,p)})).filter(p=>p.relation!==null).filter(p=>p.relation.separationMm<=r).sort((p,y)=>p.relation.separationMm-y.relation.separationMm||fe(p.node.nodeId,y.node.nodeId)),g=m.slice(0,a);return{nodes:[o,...g.map(p=>p.node)],computed:g.map(p=>p.relation),truncated:u.truncated||m.length>a,candidateCount:u.nodes.length}}function nb(e,t,n,o){let r=e.getStoredNode(t,n.nodeId);if(!r||!r.aabb)return null;let a=(n.spaceNodeIds??[]).map(K).filter(u=>u!==null);if(o.adapter==="legacy_v02"&&a.length===0)return{guarded:oe("needs_scope","Legacy v0.2 containment requires explicit spaceNodeIds because indexed spatial-role projections were introduced in v0.3.",o.limitations)};let i=ke(n.maxSpaces,100,1,1e3),s=a.length>0?{nodes:e.getStoredNodesByIds(t,a),truncated:!1}:KS(e,t,{categoryRoles:["spatial"],aabb:r.aabb},i+1);if(a.length>0&&s.nodes.length!==a.length)return{guarded:oe("node_not_found","Every explicit spaceNodeIds entry must identify a committed node.")};let c=s.nodes.filter(u=>u.nodeId!==r.nodeId).map(u=>({space:u,containment:Ki(r,u)})).sort((u,m)=>fe(u.space.nodeId,m.space.nodeId)).filter(u=>u.containment.status!=="outside");return c.length>0&&c.every(u=>u.containment.status==="unsupported")?{guarded:oe("unsupported_geometry","locate_in_space requires stored point, centerline, or boundary evidence plus a readable space boundary; AABB-only containment is not supported.")}:{nodes:[r,...c.slice(0,i).map(u=>u.space)],computed:c.slice(0,i).map(u=>u.containment),truncated:s.truncated||c.length>i,basis:c.some(u=>u.containment.status==="unsupported")?"mixed_boundary_and_unsupported_geometry":"stored_boundary_loops_and_vertical_extent",precisionClass:c.some(u=>u.containment.precisionClass==="candidate")?"candidate":"measured",unsupportedCount:c.filter(u=>u.containment.status==="unsupported").length}}function ob(e,t){let n=Date.now(),o=K(t.snapshotId);if(!o)return oe("needs_scope","query_spatial_context requires an explicit snapshotId.");let r=e.getSnapshotRecord(o);if(!r)return oe("snapshot_not_found",`Spatial snapshot ${o} was not found in the local store.`);let a=mo(r.schemaVersion);if(!a)return oe("unsupported_snapshot_schema",`Spatial snapshot schema ${r.schemaVersion} is not supported by the Phase 1b runtime adapter.`);if(!YS(r))return oe("incomplete_snapshot","Deterministic spatial queries require a complete, non-partial snapshot with coverageStatus=complete.",[`snapshot_complete:${r.complete}`,`snapshot_partial:${r.partial}`,`snapshot_coverage_status:${r.coverageStatus}`,...os(t,a)],{},{partial:r.partial,coverageStatus:r.coverageStatus});if(t.requireCurrent&&t.trust?.liveness!=="current")return oe("snapshot_not_current","The requested current-state query requires a live liveness probe returning current.",os(t,a));if(t.mode==="retrieve"){if(!JS(t.filters))return oe("needs_scope","retrieve mode requires an explicit node, category, role, level, system, AABB, elevation-band, or within-space filter; whole-snapshot dumps are not supported.");if(a.adapter==="legacy_v02"&&Wu(t.filters)&&(!t.filters?.nodeIds||t.filters.nodeIds.length===0))return oe("unsupported_snapshot_capability","Legacy v0.2 metadata filters require explicit nodeIds; v0.3 adds indexed property projections.",a.limitations);let c=ke(t.limit,100,1,1e3),u=ke(t.edgeLimit,500,1,2e3),m=Ju(e,o,t.filters);if("guarded"in m)return m;let g=qu({mode:t.mode,filters:t.filters??{},includeEdges:t.includeEdges===!0,relationTypes:t.relationTypes??[],limit:c,edgeLimit:u}),p=null,y=null,f=null;try{if(t.cursor){let E=zu(t.cursor,{snapshotId:o,revisionFingerprint:r.revisionFingerprint,queryFingerprint:g});p=E.lastNodeId,y=E.nodePageEndId,f=E.lastEdgeId}}catch(E){if(E instanceof Ye)return oe(E.reason,E.message);throw E}let w=Ku(e,o,m,c,p);if(w.unsupportedNodeId)return oe("unsupported_geometry","within-space retrieval encountered an AABB candidate without point, centerline, or boundary evidence; the node was not silently classified outside.",[`unsupported_node_id:${w.unsupportedNodeId}`]);let T=y!==null;if(T&&w.pageEndNodeId!==y)return oe("invalid_cursor","The immutable snapshot did not reproduce the node page bound to this edge continuation cursor.");let I=t.includeEdges&&w.nodes.length>0?e.queryStoredEdges({snapshotId:o,sourceNodeIds:w.nodes.map(E=>E.nodeId),relationTypes:t.relationTypes,afterEdgeId:f,limit:u}):{edges:[],hasMore:!1,nextEdgeId:null},_=null;if(I.hasMore){if(!I.nextEdgeId||!w.pageEndNodeId)return oe("store_integrity_error","Bounded edge pagination did not produce a valid continuation position.");_=ns({snapshotId:o,revisionFingerprint:r.revisionFingerprint,queryFingerprint:g,lastNodeId:p,nodePageEndId:w.pageEndNodeId,lastEdgeId:I.nextEdgeId})}else w.hasMore&&w.pageEndNodeId&&(_=ns({snapshotId:o,revisionFingerprint:r.revisionFingerprint,queryFingerprint:g,lastNodeId:w.pageEndNodeId,nodePageEndId:null,lastEdgeId:null}));let A=T?[]:w.nodes,R=_!==null;return{...$u(r,t,a,n),nodes:A,edges:I.edges,partial:R,truncated:R,nextCursor:_,scanStoppedReason:R?"max_items":"completed",scanPolicy:{maxNodes:c,maxEdges:u,maxWithinSpaceCandidates:t.filters?.withinSpaceNodeIds?.length?Math.min(fa,Math.max(1e3,c*20)):null,edgeOwnership:"source_node_page"},suggestedNextScopes:_?["cursor"]:[],counts:{nodeCount:A.length,edgeCount:I.edges.length,computedCount:0,scannedNodeCount:w.scannedNodeCount},notices:t.includeEdges?["Edges are emitted once on the page containing their stored source node."]:[],elapsedMs:Date.now()-n}}let i=ZS(t.operation,a,!0);if(i)return i;let s=$u(r,t,a,n),l=t.operation;if(["relation_between","clearance_between","above_below"].includes(l.name)){let c=eb(e,o,l);if(!c)return oe("node_not_found_or_geometry_unsupported","Both explicit nodes and supported stored geometry are required.");let u=l.name==="clearance_between"&&c.computed.precisionClass==="candidate"?{...c.computed,relation:"clearance_screening",verdictCapability:"screening_only"}:c.computed;return{...s,operation:l.name,inputs:{...l},nodes:c.nodes,edges:[],computed:u,basis:u.basis,precisionClass:u.precisionClass,verdictCapability:u.verdictCapability,partial:!1,truncated:!1,nextCursor:null,scanPolicy:{exactNodeCount:2},counts:{nodeCount:2,edgeCount:0,computedCount:1},elapsedMs:Date.now()-n}}if(l.name==="nearest_elements"||l.name==="elements_within"){if(a.adapter==="legacy_v02"&&Wu(l.filters))return oe("unsupported_snapshot_capability","Legacy v0.2 nearest/within metadata filters are not indexed.",a.limitations);let c=tb(e,o,l);return c?c.guarded?c.guarded:{...s,operation:l.name,inputs:{...l},nodes:c.nodes,edges:[],computed:c.computed,basis:"rtree_candidates_then_stored_geometry",precisionClass:c.computed.length>0&&c.computed.every(u=>u.precisionClass==="measured")?"measured":"candidate",verdictCapability:c.computed.length>0&&c.computed.every(u=>u.verdictCapability==="context_only")?"context_only":"screening_only",partial:c.truncated,truncated:c.truncated,nextCursor:null,scanStoppedReason:c.truncated?"max_items":"completed",scanPolicy:{maxCandidates:fa,maxResults:ke(l.limit,20,1,500),distanceMm:l.name==="nearest_elements"?l.maxDistanceMm:l.distanceMm},suggestedNextScopes:c.truncated?["filters","maxDistanceMm"]:[],counts:{nodeCount:c.nodes.length,edgeCount:0,computedCount:c.computed.length,candidateCount:c.candidateCount},notices:[`candidate_count:${c.candidateCount}`],elapsedMs:Date.now()-n}:oe("node_not_found_or_geometry_unsupported","The anchor node, a bounded distance, and stored AABB geometry are required.")}if(l.name==="trace_connectivity"){if(!e.getStoredNode(o,l.startNodeId))return oe("node_not_found","trace_connectivity requires an existing explicit startNodeId.");if(l.targetNodeId&&!e.getStoredNode(o,l.targetNodeId))return oe("node_not_found","trace_connectivity requires targetNodeId to identify an existing node when supplied.");let c=e.getSnapshotTopologyCapability(o);if(!c||!c.readComplete||!c.targetMembershipValidated||c.ambiguousConnectorCount>0||c.unresolvedPeerReferenceCount>0)return oe("incomplete_topology_coverage","trace_connectivity requires complete connector reads and committed-snapshot validation for every peer reference.",[`topology_read_complete:${c?.readComplete===!0}`,`topology_target_membership_validated:${c?.targetMembershipValidated===!0}`,`topology_ambiguous_connector_count:${c?.ambiguousConnectorCount??-1}`,`topology_unresolved_peer_reference_count:${c?.unresolvedPeerReferenceCount??-1}`]);let u=Du(e,o,l);return u.unsupportedOwnerNodeIds.length>0&&u.reachedTarget!==!0?oe("internal_topology_unsupported","The trace reached a multi-port owner whose internal connector routing cannot be proven from same-system/domain evidence or an explicit pass-through category.",u.unsupportedOwnerNodeIds.map(m=>`unsupported_owner_node_id:${m}`)):{...s,operation:l.name,inputs:{...l},nodes:u.nodes,edges:u.edges,computed:u,basis:u.basis,precisionClass:u.precisionClass,partial:u.truncated,truncated:u.truncated,nextCursor:null,scanStoppedReason:u.truncated?"max_items":"completed",scanPolicy:{maxDepth:ke(l.maxDepth,20,0,100),maxNodes:ke(l.maxNodes,500,1,5e3)},suggestedNextScopes:u.truncated?["targetNodeId","maxDepth","maxNodes"]:[],counts:{nodeCount:u.nodes.length,edgeCount:u.edges.length,computedCount:u.pathNodeIds.length},elapsedMs:Date.now()-n}}if(l.name==="locate_in_space"){let c=nb(e,o,l,a);return c?"guarded"in c&&c.guarded?c.guarded:{...s,operation:l.name,inputs:{...l},nodes:c.nodes,edges:[],computed:c.computed,basis:c.basis,precisionClass:c.precisionClass,partial:c.truncated,truncated:c.truncated,nextCursor:null,scanStoppedReason:c.truncated?"max_items":"completed",scanPolicy:{maxSpaces:ke(l.maxSpaces,100,1,1e3)},suggestedNextScopes:c.truncated?["spaceNodeIds"]:[],counts:{nodeCount:c.nodes.length,edgeCount:0,computedCount:c.computed.length},notices:c.unsupportedCount>0?[`unsupported_containment_count:${c.unsupportedCount}`]:[],elapsedMs:Date.now()-n}:oe("node_not_found_or_geometry_unsupported","locate_in_space requires an existing node with stored geometry.")}return oe("unsupported_operation","The requested deterministic spatial operation is not supported.")}function Xu(e,t){let n=ob(e,t);return!n.guarded&&Buffer.byteLength(xe(n),"utf8")>Uu?oe("max_bytes","The bounded spatial query result exceeded the runtime response budget; narrow filters or lower item/depth limits.",[],{maxResponseBytes:Uu}):n}var rb=1e4,Jo=3e4;function ab(e){let t=Number.parseInt(String(e??""),10);return Number.isFinite(t)?Math.max(2e3,Math.min(Jo,t)):rb}async function ya(e,t,n,o){let r=ab(n.timeoutMs);return await $i(e,t,async a=>{let i=a.map(l=>l.metadata||l),s=await U("get_spatial_change_state",{sourceRevisions:i,expectedTrackerSessionId:a.find(l=>l.trackerSessionId)?.trackerSessionId,timeoutMs:r,suppressTaskStatusWindow:!0,taskName:"Read spatial change state"},{...z({target:n.target,host:n.host,port:n.port,timeoutMs:r,taskName:"Read spatial change state"},"Read spatial change state"),toolName:o,timeoutMs:r,refreshStatusAfterCommand:!1});return s&&s.result?s.result:s})}function po(e,t){return{success:!1,guarded:!1,state:"failed",action:e,reason:"read_failed",error:t instanceof Error?t.message:String(t),partial:!1,truncated:!1,scanStoppedReason:"read_failed",scanPolicy:{},suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null,counts:{},elapsedMs:0}}var Yu=N.tuple([N.number().finite(),N.number().finite(),N.number().finite()]),ib=N.object({minMm:Yu,maxMm:Yu}).strict(),Zu=N.object({nodeIds:N.array(N.string().min(1)).max(2e3).optional(),nodeKinds:N.array(N.string().min(1)).max(20).optional(),categories:N.array(N.string().min(1)).max(100).optional(),builtInCategories:N.array(N.string().min(1)).max(100).optional(),categoryRoles:N.array(N.string().min(1)).max(50).optional(),levelNames:N.array(N.string().min(1)).max(100).optional(),levelUniqueIds:N.array(N.string().min(1)).max(100).optional(),systemKeys:N.array(N.string().min(1)).max(100).optional(),ownerNodeIds:N.array(N.string().min(1)).max(1e3).optional(),aabb:ib.optional(),elevationBandMm:N.object({minZ:N.number().finite(),maxZ:N.number().finite()}).strict().optional(),withinSpaceNodeIds:N.array(N.string().min(1)).max(100).optional()}).strict(),Qu=Zu.omit({nodeIds:!0,ownerNodeIds:!0,withinSpaceNodeIds:!0}),sb=N.discriminatedUnion("name",[N.object({name:N.literal("relation_between"),sourceNodeId:N.string().min(1),targetNodeId:N.string().min(1)}).strict(),N.object({name:N.literal("nearest_elements"),anchorNodeId:N.string().min(1),maxDistanceMm:N.number().finite().nonnegative().max(1e6),limit:N.number().int().positive().max(1e3).optional(),filters:Qu.optional()}).strict(),N.object({name:N.literal("elements_within"),anchorNodeId:N.string().min(1),distanceMm:N.number().finite().nonnegative().max(1e6),limit:N.number().int().positive().max(1e3).optional(),filters:Qu.optional()}).strict(),N.object({name:N.literal("clearance_between"),sourceNodeId:N.string().min(1),targetNodeId:N.string().min(1)}).strict(),N.object({name:N.literal("trace_connectivity"),startNodeId:N.string().min(1),targetNodeId:N.string().min(1).optional(),maxDepth:N.number().int().min(0).max(100).optional(),maxNodes:N.number().int().positive().max(5e3).optional()}).strict(),N.object({name:N.literal("locate_in_space"),nodeId:N.string().min(1),spaceNodeIds:N.array(N.string().min(1)).max(2e3).optional(),maxSpaces:N.number().int().positive().max(1e3).optional()}).strict(),N.object({name:N.literal("above_below"),sourceNodeId:N.string().min(1),targetNodeId:N.string().min(1),toleranceMm:N.number().finite().nonnegative().max(1e4).optional()}).strict()]);function ed(e){e.tool("query_spatial_context","[SPATIAL_QUERY_READ_ONLY] Query one explicit, complete, currently-live spatial snapshot. mode=retrieve returns a bounded filtered subgraph; mode=operation runs one deterministic relation operation (relation_between, nearest_elements, elements_within, clearance_between, trace_connectivity, locate_in_space, or above_below). Geometry and topology are computed by the runtime, never by the LLM. Every operation echoes inputs and reports basis, precisionClass, verdictCapability, and evidence ids. Phase 1b clearance is context/screening evidence only and never a live clash or clearance verdict. This tool never writes Revit.",{...P(N),...L(N),snapshotId:N.string().min(1).describe("Exact committed snapshot id. The snapshot must be complete and freshly probed as current."),mode:N.enum(["retrieve","operation"]),filters:Zu.optional().describe("Bounded retrieve filters. Filtresiz whole-snapshot dumps are guarded."),includeEdges:N.boolean().optional().describe("Include stored topology edges in retrieve mode. Defaults false."),relationTypes:N.array(N.string().min(1)).max(20).optional(),limit:N.number().int().positive().max(1e3).optional(),edgeLimit:N.number().int().positive().max(2e3).optional(),cursor:N.string().min(1).optional().describe("Opaque process-session cursor returned by a prior matching retrieve call."),operation:sb.optional(),timeoutMs:N.number().int().min(2e3).max(Jo).optional()},async(t={})=>{try{if(t.mode==="operation"&&!t.operation)return b({success:!0,guarded:!0,state:"guarded",action:"query_spatial_context",reason:"invalid_operation",message:"mode=operation requires one explicit deterministic operation payload.",partial:!1,truncated:!1,scanStoppedReason:"needs_scope",scanPolicy:{},suggestedNextScopes:["operation"],warnings:[],notices:["No Revit command was sent."],nextCursor:null,counts:{nodeCount:0,edgeCount:0,computedCount:0},elapsedMs:0});let n=an(),o=await ya(n,String(t.snapshotId),t,"query_spatial_context"),r={liveness:o.liveness,evaluatedAt:o.evaluatedAt,warnings:o.warnings},a=t.mode==="retrieve"?{snapshotId:String(t.snapshotId),mode:"retrieve",requireCurrent:!0,trust:r,filters:t.filters,includeEdges:t.includeEdges,relationTypes:t.relationTypes,limit:t.limit,edgeLimit:t.edgeLimit,cursor:t.cursor}:{snapshotId:String(t.snapshotId),mode:"operation",requireCurrent:!0,trust:r,operation:t.operation};return b(Xu(n,a))}catch(n){return n instanceof Ct?b({success:!0,guarded:!0,state:"guarded",action:"query_spatial_context",reason:n.reason,message:n.message,partial:!1,truncated:!1,scanStoppedReason:"read_failed",scanPolicy:{},suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null,counts:{nodeCount:0,edgeCount:0,computedCount:0},elapsedMs:0}):b(po("query_spatial_context",n))}})}import{z as An}from"zod";var ld="compare_spatial_snapshots",td=8*1024*1024;function st(e,t,n=[]){return{success:!0,guarded:!0,state:"guarded",action:ld,reason:e,message:t,partial:!1,truncated:!1,scanStoppedReason:e==="needs_scope"?"needs_scope":e==="max_bytes"?"max_bytes":"read_failed",scanPolicy:{},suggestedNextScopes:e==="needs_scope"?["baseSnapshotId","headSnapshotId"]:[],nextCursor:null,warnings:[...new Set(n)],notices:[],elapsedMs:0,reportId:Wt("spatial-diff"),counts:{totalChangeCount:0}}}function nd(e){return e.complete&&!e.partial&&e.coverageStatus==="complete"}function od(e,t){return K(te(e.captureMetadata,[[t]]))??K(te(e.scope,[[t]]))}function lb(e,t){let n=ba(e),o=ba(t),r=a=>(Ge(a.documentKeyResolution)?a.documentKeyResolution:null)?.crossSessionComparable===!1;for(let[a,i]of[...n.entries()].sort(([s],[l])=>fe(s,l))){let s=o.get(a);if(r(i)&&(!s||i.documentSessionId!==s.documentSessionId)||s&&r(s)&&i.documentSessionId!==s.documentSessionId)return!0}for(let[a,i]of[...o.entries()].sort(([s],[l])=>fe(s,l)))if(r(i)&&!n.has(a))return!0;return!1}function rd(e){return[...new Set(e.map(t=>K(te(t.payload,[["fingerprints","version"]]))).filter(t=>t!==null))].sort(fe)}function ad(e,t,n){let o=[],r=null;for(;o.length<n;){let a=e.queryStoredNodes({snapshotId:t,afterNodeId:r,limit:Math.min(1e3,n-o.length)});if(o.push(...a.nodes),!a.hasMore)return{nodes:o,truncated:!1};if(!a.nextNodeId||a.nextNodeId===r)return{nodes:o,truncated:!0};r=a.nextNodeId}return{nodes:o,truncated:!0}}function ba(e){return new Map(e.map(t=>[Jr(t),t]))}function cb(e,t){let n=ba(e),o=ba(t),r=[],a=[];for(let i of[...new Set([...n.keys(),...o.keys()])].sort(fe)){let s=n.get(i),l=o.get(i);if(!s){r.push({sourceKey:i,changeType:"source_added_or_loaded",after:l});continue}if(!l){r.push({sourceKey:i,changeType:"source_removed_or_unloaded",before:s});continue}s.loadedVersion!==l.loadedVersion&&r.push({sourceKey:i,changeType:"source_reloaded_or_content_version_changed",before:{loadedVersion:s.loadedVersion},after:{loadedVersion:l.loadedVersion}}),xe(s.sourceToHostTransform)!==xe(l.sourceToHostTransform)&&a.push({sourceKey:i,changeType:"source_to_host_transform_changed",before:s.sourceToHostTransform,after:l.sourceToHostTransform})}return{availability:r,transforms:a}}function id(e){return{category:e.category,builtInCategory:e.builtInCategory,categoryRole:e.categoryRole,levelUniqueId:e.levelUniqueId,levelName:e.levelName,systemKey:e.systemKey,name:te(e.payload,[["name"]]),familyName:te(e.payload,[["familyName"]]),typeName:te(e.payload,[["typeName"]]),spatialProperties:te(e.payload,[["spatialProperties"]])}}function ub(e,t){return[...new Set([...Object.keys(e),...Object.keys(t)])].filter(n=>xe(e[n])!==xe(t[n])).sort(fe)}function go(e,t,n,o,r){return{nodeId:e.nodeId,nodeKind:e.nodeKind,documentKey:e.documentKey,beforeFingerprint:n,afterFingerprint:o,...r?{changedFields:r}:{}}}function Sa(e){let t=kt(e);return e.nodeKind==="revit_element"&&t.aabb!==null&&t.centerline.length<2&&t.boundaryLoops.length===0}function db(e,t){return e<t?`${e}${t}`:`${t}${e}`}function sd(e,t,n,o,r,a){let i=new Map,s=!1,l=0;for(let c of[...new Set(n)].sort(fe)){let u=e.getStoredNode(t,c);if(!u?.aabb)continue;let m=null;for(;l<a;){let g=e.queryStoredNodes({snapshotId:t,aabb:pa(u.aabb,o),afterNodeId:m,limit:Math.min(1e3,a-l)});l+=g.nodes.length;for(let p of g.nodes){if(p.nodeId===u.nodeId)continue;let y=db(u.nodeId,p.nodeId);if(i.has(y))continue;if(i.size>=r)return s=!0,{relations:i,truncated:s,candidateCount:l};let f=Go(u,p);f&&f.separationMm<=o&&i.set(y,f)}if(!g.hasMore)break;if(!g.nextNodeId||g.nextNodeId===m)return s=!0,{relations:i,truncated:s,candidateCount:l};m=g.nextNodeId}if(l>=a){s=!0;break}}return{relations:i,truncated:s,candidateCount:l}}function mb(e,t,n){let o=[],r=e.truncated||t.truncated,a=0;for(let i of[...new Set([...e.relations.keys(),...t.relations.keys()])].sort(fe)){let s=e.relations.get(i),l=t.relations.get(i);if(s&&l&&xe({separationMm:s.separationMm,intersects:s.intersects,basis:s.basis,precisionClass:s.precisionClass})===xe({separationMm:l.separationMm,intersects:l.intersects,basis:l.basis,precisionClass:l.precisionClass}))continue;if(a+=1,o.length>=n){r=!0;continue}let c=l??s;o.push({...c,relation:l?s?"proximity_changed":"proximity_added":"proximity_removed",changeType:l?s?"changed":"added":"removed",before:s?{separationMm:s.separationMm,intersects:s.intersects,basis:s.basis,precisionClass:s.precisionClass}:null})}return{changes:o,truncated:r,observedChangeCount:a}}function pb(e,t){let n=Date.now(),o=K(t.baseSnapshotId),r=K(t.headSnapshotId);if(!o||!r)return st("needs_scope","compare_spatial_snapshots requires explicit baseSnapshotId and headSnapshotId.");let a=e.getSnapshotRecord(o),i=e.getSnapshotRecord(r);if(!a||!i)return st("snapshot_not_found","One or both explicit spatial snapshots were not found in the local store.");if(!nd(a)||!nd(i))return st("incomplete_snapshot","Snapshot diff requires two complete, non-partial snapshots.");if(a.scopeFingerprint!==i.scopeFingerprint)return st("incomparable_scopes","Snapshot diff requires equal scopeFingerprint values.");for(let W of["coordinateFrame","lengthUnit","captureConsistency"]){let Y=od(a,W),H=od(i,W);if(Y&&H&&Y!==H)return st("incomparable_scopes",`Snapshot diff requires a common ${W} policy.`,[`base_${W}:${Y}`,`head_${W}:${H}`])}if(lb(a.sourceRevisions,i.sourceRevisions))return st("incomparable_scopes","Session-only document identities cannot be diffed across different documentSessionId values.");let s=mo(a.schemaVersion),l=mo(i.schemaVersion);if(!s||!l)return st("unsupported_snapshot_schema","One or both snapshot schema versions have no Phase 1b compatibility adapter.");if(s.adapter!==l.adapter)return st("snapshot_capability_mismatch","Mixed v0.2/v0.3 diffs are unsupported because native v0.3 and legacy-derived fingerprints do not share a comparable algorithm basis.",[...s.limitations,...l.limitations]);let c=s.adapter==="legacy_v02"||l.adapter==="legacy_v02";if(c&&t.allowLegacyV02!==!0)return st("unsupported_snapshot_capability","A full Phase 1b diff requires v0.3 snapshots. Set allowLegacyV02 only for an explicitly capability-limited historical diff.",[...s.limitations,...l.limitations]);if(!c){let W=e.getSnapshotTopologyCapability(o),Y=e.getSnapshotTopologyCapability(r),H=Qe=>!!(Qe&&Qe.readComplete&&Qe.targetMembershipValidated&&Qe.ambiguousConnectorCount===0&&Qe.unresolvedPeerReferenceCount===0);if(!H(W)||!H(Y))return st("incomplete_topology_coverage","A full v0.3 diff requires complete connector reads and committed-snapshot membership validation in both snapshots.",[`base_topology_complete:${H(W)}`,`head_topology_complete:${H(Y)}`])}let u=ke(t.maxChanges,2e4,1,5e4),m=Math.max(5e4,u*2),g=ad(e,o,m),p=ad(e,r,m);if(g.truncated||p.truncated)return st("max_items","The bounded snapshot diff could not load every node; no incomplete diff was presented as complete.",[`max_nodes:${m}`]);if(!c){let W=rd(g.nodes),Y=rd(p.nodes),H=g.nodes.length>0&&W.length!==1,Qe=p.nodes.length>0&&Y.length!==1,On=W.length===1&&Y.length===1&&W[0]!==Y[0];if(H||Qe||On)return st("snapshot_capability_mismatch","A precise v0.3 diff requires one common fingerprints.version across every node in both snapshots.",[`base_fingerprint_versions:${W.join(",")||"missing"}`,`head_fingerprint_versions:${Y.join(",")||"missing"}`])}let y=new Map(g.nodes.map(W=>[W.nodeId,W])),f=new Map(p.nodes.map(W=>[W.nodeId,W])),w=[],T=[],I=[],_=[],A=[],R=[],E=[],S=[],k=[],q=[],X=!1,re=0,Z={added:0,removed:0,sourceAvailability:0,transform:0,moved:0,geometry:0,geometryIndeterminate:0,property:0,connector:0,connectivity:0,proximity:0};function pe(W,Y,H){if(Z[H]=(Z[H]??0)+1,re>=u){X=!0;return}W.push(Y),re+=1}let Oe=new Set,be=new Set;for(let W of[...new Set([...y.keys(),...f.keys()])].sort(fe)){let Y=y.get(W),H=f.get(W);if(!Y){be.add(W),pe(w,H,"added");continue}if(!H){Oe.add(W),pe(T,Y,"removed");continue}let Qe=Xi(Y),On=Xi(H),Pn=Yi(Y),Ht=Yi(H),ho=Qi(Y),ge=Qi(H),Gt=Zi(Y),Ko=Zi(H),fo=Qe!==On,Ze=Pn!==Ht,Jt=Sa(Y)||Sa(H),dn=xe(Y.aabb)!==xe(H.aabb)||Y.geometryFingerprint!==H.geometryFingerprint,Pt=!c&&ho!==ge,Xo=!c&&Gt!==Ko;if(fo&&(Oe.add(W),be.add(W),pe(I,go(Y,H,Qe,On),"moved")),Ze&&(Oe.add(W),be.add(W),pe(_,go(Y,H,Pn,Ht),"geometry")),!c&&!Ze&&Jt&&dn&&(Oe.add(W),be.add(W),pe(A,go(Y,H,Y.geometryFingerprint,H.geometryFingerprint,["aabb_or_geometry_fingerprint"]),"geometryIndeterminate")),Pt){let Ln=id(Y),yo=id(H);pe(R,go(Y,H,ho,ge,ub(Ln,yo)),"property")}!c&&Y.nodeKind==="connector"&&(fo||Ze||Pt)&&pe(E,go(Y,H,Y.geometryFingerprint,H.geometryFingerprint),"connector"),Xo&&pe(S,go(Y,H,Gt,Ko),"connectivity")}let De=cb(a.sourceRevisions,i.sourceRevisions);for(let W of De.availability)pe(k,W,"sourceAvailability");for(let W of De.transforms)pe(q,W,"transform");let Rt=ze(t.proximityRadiusMm),Je=Math.max(0,Math.min(1e4,Rt??1e3)),Ne=ke(t.maxProximityPairs,1e4,1,1e5),Fe=Math.min(2e5,Math.max(1e4,Ne*4)),x=mb(sd(e,o,[...Oe],Je,Ne,Fe),sd(e,r,[...be],Je,Ne,Fe),Math.max(0,u-re));re+=x.changes.length,Z.proximity=x.observedChangeCount,X=X||x.truncated;let j=g.nodes.filter(Sa).length,We=p.nodes.filter(Sa).length,Tt=j>0||We>0,Ot=!c&&s.properties&&l.properties&&s.topology&&l.topology&&!Tt,un=Object.values(Z).reduce((W,Y)=>W+Y,0);return{success:!0,guarded:!1,state:"completed",action:ld,reportId:Wt("spatial-diff"),baseSnapshotId:o,headSnapshotId:r,scopeFingerprint:a.scopeFingerprint,baseRevisionFingerprint:a.revisionFingerprint,headRevisionFingerprint:i.revisionFingerprint,added:w,removed:T,sourceAvailabilityChanges:k,transformChanges:q,moved:I,geometryChanges:_,geometryIndeterminate:A,propertyChanges:R,connectorChanges:E,connectivityChanges:S,proximityChanges:x.changes,capabilityCoverage:{full:Ot,base:s,head:l,geometryChanges:{classification:Tt?"capability_limited":"complete",baseAabbOnlyNodeCount:j,headAabbOnlyNodeCount:We,indeterminateChangeCount:A.length}},partial:X,truncated:X,scanStoppedReason:X?"max_items":"completed",scanPolicy:{maxChanges:u,proximityRadiusMm:Je,maxProximityPairs:Ne,maxProximityCandidates:Fe},suggestedNextScopes:X?["maxChanges","proximityRadiusMm","maxProximityPairs"]:[],nextCursor:null,counts:{baseNodeCount:g.nodes.length,headNodeCount:p.nodes.length,addedCount:w.length,removedCount:T.length,sourceAvailabilityChangeCount:k.length,transformChangeCount:q.length,movedCount:I.length,geometryChangeCount:_.length,geometryIndeterminateCount:A.length,propertyChangeCount:R.length,connectorChangeCount:E.length,connectivityChangeCount:S.length,proximityChangeCount:x.changes.length,totalChangeCount:un,observedChangeCount:un,returnedChangeCount:re,observedChangeCountIsLowerBound:x.truncated?1:0,observedAddedCount:Z.added,observedRemovedCount:Z.removed,observedSourceAvailabilityChangeCount:Z.sourceAvailability,observedTransformChangeCount:Z.transform,observedMovedCount:Z.moved,observedGeometryChangeCount:Z.geometry,observedGeometryIndeterminateCount:Z.geometryIndeterminate,observedPropertyChangeCount:Z.property,observedConnectorChangeCount:Z.connector,observedConnectivityChangeCount:Z.connectivity,observedProximityChangeCount:Z.proximity},warnings:[...new Set([...s.limitations,...l.limitations,...c?["legacy_v02_diff_is_capability_limited"]:[],...Tt?["aabb_only_geometry_change_classification_is_capability_limited"]:[],...X?["diff_output_truncated_no_complete_claim_allowed"]:[]])],notices:["Snapshot diff is historical evidence bound to both explicit revision fingerprints."],elapsedMs:Date.now()-n}}function cd(e,t){let n=pb(e,t);return!n.guarded&&Buffer.byteLength(xe(n),"utf8")>td?st("max_bytes","The bounded diff result exceeded the runtime response budget; lower maxChanges or narrow the snapshot scope.",[`max_response_bytes:${td}`]):n}function ud(e){e.tool("compare_spatial_snapshots","[SPATIAL_DIFF_READ_ONLY] Deterministically compare two explicit immutable complete snapshots with compatible scopes. Classifies added/removed elements, source availability, transforms/movement, geometry, properties, connectors, connectivity, and affected-neighborhood proximity changes. Stale or unknown snapshots remain valid historical inputs; the result cites both snapshot and revision ids and never claims current state. Partial snapshots and incompatible scopes fail closed. This tool never writes Revit.",{...L(An),baseSnapshotId:An.string().min(1),headSnapshotId:An.string().min(1),allowLegacyV02:An.boolean().optional().describe("Allow an explicitly capability-limited historical comparison when both snapshots are legacy v0.2. Mixed v0.2/v0.3 comparisons remain unsupported because their fingerprint algorithms are not comparable."),maxChanges:An.number().int().positive().max(5e4).optional(),proximityRadiusMm:An.number().finite().nonnegative().max(1e4).optional(),maxProximityPairs:An.number().int().positive().max(1e5).optional()},async(t={})=>{try{let n=an(),o={baseSnapshotId:String(t.baseSnapshotId),headSnapshotId:String(t.headSnapshotId),allowLegacyV02:t.allowLegacyV02,maxChanges:t.maxChanges,proximityRadiusMm:t.proximityRadiusMm,maxProximityPairs:t.maxProximityPairs};return b(cd(n,o))}catch(n){return n instanceof Ct?b({success:!0,guarded:!0,state:"guarded",action:"compare_spatial_snapshots",reason:n.reason,message:n.message,partial:!1,truncated:!1,scanStoppedReason:"read_failed",scanPolicy:{},suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null,counts:{totalChangeCount:0},elapsedMs:0}):b(po("compare_spatial_snapshots",n))}})}import{z as Se}from"zod";var md="summarize_spatial_state",dd=4*1024*1024;function kn(e,t,n=[]){return{success:!0,guarded:!0,state:"guarded",action:md,reason:e,message:t,partial:!1,truncated:!1,scanStoppedReason:e==="needs_scope"?"needs_scope":e==="max_bytes"?"max_bytes":"read_failed",scanPolicy:{},suggestedNextScopes:e==="needs_scope"?["snapshotId","nodeIds"]:[],nextCursor:null,warnings:[...new Set(n)],notices:[],elapsedMs:0,summaryId:Wt("spatial-summary"),counts:{nodeCount:0,levelCount:0}}}function _a(e,t){let n=t??"<unknown>";e.set(n,(e.get(n)??0)+1)}function xa(e){return Object.fromEntries([...e.entries()].sort(([t],[n])=>fe(t,n)))}function gb(e){let t=e.filters;return!!(t&&[t.categories,t.builtInCategories,t.categoryRoles,t.levelNames,t.levelUniqueIds,t.systemKeys,t.ownerNodeIds].some(n=>Array.isArray(n)&&n.length>0))}function hb(e,t){let n=Date.now(),o=K(t.snapshotId);if(!o)return kn("needs_scope","summarize_spatial_state requires an explicit snapshotId.");let r=e.getSnapshotRecord(o);if(!r)return kn("snapshot_not_found",`Spatial snapshot ${o} was not found in the local store.`);let a=mo(r.schemaVersion);if(!a)return kn("unsupported_snapshot_schema",`Spatial snapshot schema ${r.schemaVersion} is not supported.`);let i=[...new Set([...t.trust?.warnings??[],...a.limitations,"spatial_state_summary_is_advisory_only"])];if(!r.complete||r.partial||r.coverageStatus!=="complete")return kn("incomplete_snapshot","Spatial state summaries require a complete, non-partial snapshot with coverageStatus=complete.",[`snapshot_complete:${r.complete}`,`snapshot_partial:${r.partial}`,`snapshot_coverage_status:${r.coverageStatus}`,...i]);if(t.requireCurrent&&t.trust?.liveness!=="current")return kn("snapshot_not_current","The requested current-state summary requires a live liveness probe returning current.",i);if(a.adapter==="legacy_v02"&&gb(t)&&(!t.filters?.nodeIds||t.filters.nodeIds.length===0))return kn("unsupported_snapshot_capability","Legacy v0.2 summary metadata filters require explicit nodeIds.",i);let s=ke(t.maxNodes,1e4,1,5e4),l=ke(t.maxLevels,50,1,100),c=[],u=null,m=!1;for(;c.length<s;){let f=e.queryStoredNodes({snapshotId:o,nodeIds:t.filters?.nodeIds,nodeKinds:t.filters?.nodeKinds,categories:t.filters?.categories,builtInCategories:t.filters?.builtInCategories,categoryRoles:t.filters?.categoryRoles,levelNames:t.filters?.levelNames,levelUniqueIds:t.filters?.levelUniqueIds,systemKeys:t.filters?.systemKeys,ownerNodeIds:t.filters?.ownerNodeIds,aabb:t.filters?.aabb,afterNodeId:u,limit:Math.min(1e3,s-c.length)});if(c.push(...f.nodes),!f.hasMore)break;if(!f.nextNodeId||f.nextNodeId===u||c.length>=s){m=!0;break}u=f.nextNodeId}let g=new Map;for(let f of c){let w=f.levelUniqueId??(f.levelName?`name:${f.levelName}`:"<unscoped>"),T=[f.documentKey,f.linkInstanceUniqueId??"<host>",w].join(""),I=g.get(T);I||(I={levelKey:w,groupingKey:T,documentKey:f.documentKey,linkInstanceUniqueId:f.linkInstanceUniqueId,levelName:f.levelName,levelUniqueId:f.levelUniqueId,nodes:[],nodesByKind:new Map,nodesByCategory:new Map,nodesByRole:new Map,nodesBySystem:new Map,bounds:null},g.set(T,I)),I.nodes.push(f),_a(I.nodesByKind,f.nodeKind),_a(I.nodesByCategory,f.category??f.builtInCategory),_a(I.nodesByRole,f.categoryRole),t.includeSystems!==!1&&_a(I.nodesBySystem,f.systemKey),I.bounds=ga(I.bounds,f.aabb)}let p=[...g.values()].sort((f,w)=>fe(f.groupingKey,w.groupingKey));p.length>l&&(m=!0);let y=p.slice(0,l).map(f=>({levelKey:f.levelKey,groupingKey:f.groupingKey,groupingBasis:"document_link_placement_level",documentKey:f.documentKey,linkInstanceUniqueId:f.linkInstanceUniqueId,levelName:f.levelName,levelUniqueId:f.levelUniqueId,nodeCount:f.nodes.length,nodesByKind:xa(f.nodesByKind),nodesByCategory:xa(f.nodesByCategory),nodesByRole:xa(f.nodesByRole),...t.includeSystems===!1?{}:{nodesBySystem:xa(f.nodesBySystem)},bounds:f.bounds,evidenceNodeIds:f.nodes.map(w=>w.nodeId).sort(fe).slice(0,20)}));return{success:!0,guarded:!1,state:"completed",action:md,summaryId:Wt("spatial-summary"),snapshotId:o,revisionFingerprint:r.revisionFingerprint,scopeFingerprint:r.scopeFingerprint,liveness:t.trust?.liveness??"unknown",advisory:!0,quotableAsVerification:!1,verdictCapability:"context_only",levels:y,capabilityCoverage:a,partial:m,truncated:m,scanStoppedReason:m?"max_items":"completed",scanPolicy:{maxNodes:s,maxLevels:l},suggestedNextScopes:m?["filters","maxNodes","maxLevels"]:[],nextCursor:null,counts:{nodeCount:c.length,levelCount:y.length,omittedLevelCount:Math.max(0,p.length-y.length)},warnings:i,notices:["Use deterministic query operations for spatial claims; this summary is never verification evidence."],elapsedMs:Date.now()-n}}function pd(e,t){let n=hb(e,t);return!n.guarded&&Buffer.byteLength(xe(n),"utf8")>dd?kn("max_bytes","The advisory summary exceeded the runtime response budget; narrow filters or lower maxLevels.",[`max_response_bytes:${dd}`]):n}var fb=Se.object({nodeIds:Se.array(Se.string().min(1)).max(2e3).optional(),nodeKinds:Se.array(Se.string().min(1)).max(20).optional(),categories:Se.array(Se.string().min(1)).max(100).optional(),builtInCategories:Se.array(Se.string().min(1)).max(100).optional(),categoryRoles:Se.array(Se.string().min(1)).max(50).optional(),levelNames:Se.array(Se.string().min(1)).max(100).optional(),levelUniqueIds:Se.array(Se.string().min(1)).max(100).optional(),systemKeys:Se.array(Se.string().min(1)).max(100).optional(),ownerNodeIds:Se.array(Se.string().min(1)).max(1e3).optional()}).strict();function gd(e){e.tool("summarize_spatial_state","[SPATIAL_SUMMARY_ADVISORY_READ_ONLY] Build a compact, deterministic per-level count/extent summary from one explicit complete and currently-live spatial snapshot. The result is advisory context only: advisory=true, verdictCapability=context_only, and quotableAsVerification=false. It never reports clash-free, clearance, occupancy-percentage, or other live verification claims and never writes Revit.",{...P(Se),...L(Se),snapshotId:Se.string().min(1),filters:fb.optional(),maxNodes:Se.number().int().positive().max(5e4).optional(),maxLevels:Se.number().int().positive().max(100).optional(),includeSystems:Se.boolean().optional(),timeoutMs:Se.number().int().min(2e3).max(Jo).optional()},async(t={})=>{try{let n=an(),o=await ya(n,String(t.snapshotId),t,"summarize_spatial_state"),r={snapshotId:String(t.snapshotId),requireCurrent:!0,trust:{liveness:o.liveness,evaluatedAt:o.evaluatedAt,warnings:o.warnings},filters:t.filters,maxNodes:t.maxNodes,maxLevels:t.maxLevels,includeSystems:t.includeSystems};return b(pd(n,r))}catch(n){return n instanceof Ct?b({success:!0,guarded:!0,state:"guarded",action:"summarize_spatial_state",reason:n.reason,message:n.message,partial:!1,truncated:!1,scanStoppedReason:"read_failed",scanPolicy:{},suggestedNextScopes:[],warnings:[],notices:[],nextCursor:null,counts:{nodeCount:0,levelCount:0},elapsedMs:0}):b(po("summarize_spatial_state",n))}})}async function hd(e){let t=Ws(e);zc(t),ou(t),Zs(t),el(t),tl(t),nl(t),rl(t),al(t),il(t),sl(t),ll(t),cl(t),fl(t),yl(t),Sl(t),bl(t),_l(t),Cl(t),vl(t),Il(t),El(t),Nl(t),Fl(t),ql(t),Hl(t),Cc(t),kc(t),Oc(t),Vc(t),Fc(t),qc(t),Ru(t),ed(t),ud(t),gd(t),console.error("Registered 35 revAgent tools")}var It=class extends Error{constructor(t){super(t),this.name="SpatialStoreCliUsageError"}};function fd(e,t,n){let o=e[t+1];if(typeof o!="string"||o.trim().length===0||o.startsWith("--"))throw new It(`${n} requires one non-empty value.`);return o.trim()}function yb(e){let t=e[0];if(t!=="preview"&&t!=="purge")throw new It("Expected command preview or purge.");let n=!1,o=null,r=[],a=!1;for(let l=1;l<e.length;l+=1){let c=e[l];if(c==="--all"){if(n)throw new It("--all may be specified only once.");n=!0;continue}if(c==="--confirm"){if(a)throw new It("--confirm may be specified only once.");a=!0;continue}if(c==="--document-key"){if(o!==null)throw new It("--document-key may be specified only once.");o=fd(e,l,c),l+=1;continue}if(c==="--snapshot-id"){r.push(fd(e,l,c)),l+=1;continue}throw new It(`Unknown spatial-store argument: ${c}`)}if(t==="preview"&&a)throw new It("--confirm is valid only with purge.");if(Number(n)+ +(o!==null)+ +(r.length>0)!==1)throw new It("Exactly one selector is required: --all, --document-key <key>, or one or more --snapshot-id <id>.");if(n)return{command:t,selector:{all:!0},selectorSummary:{kind:"all"},confirm:a};if(o!==null)return{command:t,selector:{documentKey:o},selectorSummary:{kind:"document_key",documentKey:o},confirm:a};let s=[...new Set(r)];return{command:t,selector:{snapshotIds:s},selectorSummary:{kind:"snapshot_ids",snapshotIds:s},confirm:a}}function Sb(e){process.stdout.write(`${JSON.stringify(e,null,2)}
`)}function bb(e,t){return{contractVersion:"spatial-store-cli.v1",success:!0,guarded:!1,state:"completed",action:"spatial_store_preview",mutated:!1,selector:e.selectorSummary,preview:t}}function yd(e,t=Sb,n={}){let o=null;try{let r=yb(e);o=n.createStore?.()??new io({retentionPolicy:!1,cleanupExpiredStagingOnOpen:!1});let a=o.previewPurge(r.selector);if(r.command==="preview")return t(bb(r,a)),0;if(!r.confirm)return t({contractVersion:"spatial-store-cli.v1",success:!0,guarded:!0,state:"guarded",action:"spatial_store_purge",reason:"confirmation_required",message:"No data was changed. Re-run the same explicit selector with --confirm to purge.",mutated:!1,selector:r.selectorSummary,preview:a}),2;let i=o.purge(r.selector);return i.artifactWarnings.length>0?(t({contractVersion:"spatial-store-cli.v1",success:!1,guarded:!1,state:"failed",action:"spatial_store_purge",reason:"purge_cleanup_incomplete",message:"Database rows were purged, but one or more artifact or recovery-backup cleanup steps did not complete.",mutated:i.purgedSnapshotCount>0||i.purgedStagingCaptureCount>0,partial:!0,selector:r.selectorSummary,previewBefore:a,purge:i}),3):(t({contractVersion:"spatial-store-cli.v1",success:!0,guarded:!1,state:"completed",action:"spatial_store_purge",mutated:i.purgedSnapshotCount>0||i.purgedStagingCaptureCount>0,partial:!1,selector:r.selectorSummary,previewBefore:a,purge:i}),0)}catch(r){let a=r instanceof It;return t({contractVersion:"spatial-store-cli.v1",success:!1,guarded:!1,state:"failed",action:"spatial_store_maintenance",reason:a?"invalid_arguments":"spatial_store_unavailable",message:r instanceof Error?r.message:String(r),mutated:!1}),a?2:1}finally{try{o?.close()}catch{}}}async function vb(){if(process.argv[2]==="spatial-store"){process.exitCode=yd(process.argv.slice(3));return}let e=new _b({name:"revAgent",version:"1.0.0"});await hd(e);let t=Pi(),n=new xb;await e.connect(n),Us(),console.error(`revAgent spatial store ${t.available?"ready":`guarded:${t.reason}`}`),console.error("revAgent runtime start success")}vb().catch(e=>{console.error("Error starting revAgent runtime:",e),process.exit(1)});

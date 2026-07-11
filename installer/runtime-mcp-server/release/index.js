import{McpServer as gp}from"@modelcontextprotocol/sdk/server/mcp.js";import{StdioServerTransport as yp}from"@modelcontextprotocol/sdk/server/stdio.js";import{z as qe}from"zod";import*as So from"net";function Le(...e){for(let t of e){let n=process.env[t];if(n!=null&&String(n).trim()!=="")return n}}var Sn=32*1024*1024,wn=class{host;port;socket;logErrors;isConnected=!1;responseCallbacks=new Map;buffer=Buffer.alloc(0);framingMode=Le("REVAGENT_FRAMING","REVIT_MCP_FRAMING")==="legacy"?"legacy":"length-prefixed";constructor(t,n,r={}){this.host=t,this.port=n,this.logErrors=r.logErrors!==!1,this.socket=new So.Socket,this.setupSocketListeners()}setupSocketListeners(){this.socket.on("connect",()=>{this.isConnected=!0}),this.socket.on("data",t=>{this.buffer=Buffer.concat([this.buffer,t]),this.processBuffer()}),this.socket.on("close",()=>{this.isConnected=!1}),this.socket.on("error",t=>{this.logErrors&&console.error("RevitClientConnection error:",t),this.isConnected=!1})}processBuffer(){for(;this.buffer.length>0;){if(this.buffer.length>Sn){this.rejectPending(new Error(`revAgent response exceeded ${Sn} bytes`)),this.buffer=Buffer.alloc(0);return}if(this.isLikelyLegacyJson(this.buffer)){if(!this.processLegacyJsonBuffer())return;continue}if(!this.isLikelyLengthPrefixed(this.buffer)||!this.processLengthPrefixedBuffer())return}}isLikelyLegacyJson(t){let n=0;for(;n<t.length&&[32,9,10,13].includes(t[n]);)n++;return n<t.length&&t[n]===123}isLikelyLengthPrefixed(t){if(t.length<4)return!0;let n=t.readUInt32BE(0);return n>0&&n<=Sn}processLegacyJsonBuffer(){try{let t=this.buffer.toString("utf8"),n=this.extractFirstJsonObject(t);if(!n)return!1;let r=JSON.parse(n.json);return this.handleResponseObject(r,n.json),this.buffer=Buffer.from(n.remaining,"utf8"),!0}catch{return!1}}extractFirstJsonObject(t){let n=0,r=!1,o=!1,i=!1,a=0;for(let s=0;s<t.length;s++){let l=t[s];if(!i){if(/\s/.test(l))continue;if(l!=="{")return null;i=!0,a=s,n=1;continue}if(o){o=!1;continue}if(l==="\\"){o=!0;continue}if(l==='"'){r=!r;continue}if(!r){if(l==="{")n++;else if(l==="}"&&(n--,n===0))return{json:t.slice(a,s+1),remaining:t.slice(s+1)}}}return null}processLengthPrefixedBuffer(){if(this.buffer.length<4)return!1;let t=this.buffer.readUInt32BE(0);if(t<=0||t>Sn)return this.rejectPending(new Error(`Invalid revAgent response frame length: ${t}`)),this.buffer=Buffer.alloc(0),!1;if(this.buffer.length<4+t)return!1;let r=this.buffer.subarray(4,4+t).toString("utf8");try{let o=JSON.parse(r);this.handleResponseObject(o,r)}catch(o){this.rejectPending(new Error(`Failed to parse revAgent response: ${o instanceof Error?o.message:String(o)}`))}return this.buffer=this.buffer.subarray(4+t),!0}handleResponseObject(t,n){let o=t&&t.id!==void 0&&t.id!==null?String(t.id):"default",i=this.responseCallbacks.get(o);if(i){i(n),this.responseCallbacks.delete(o);return}if(t&&t.error&&this.responseCallbacks.size===1){let a=this.responseCallbacks.entries().next().value;if(a){let[s,l]=a;l(n),this.responseCallbacks.delete(s)}return}if(t&&t.error&&this.responseCallbacks.size>1)for(let[a,s]of this.responseCallbacks.entries())s(n),this.responseCallbacks.delete(a)}rejectPending(t){for(let[n,r]of this.responseCallbacks.entries())r(JSON.stringify({jsonrpc:"2.0",id:n,error:{code:-32e3,message:t instanceof Error?t.message:String(t)}})),this.responseCallbacks.delete(n)}connect(){if(this.isConnected)return!0;try{return this.socket.connect(this.port,this.host),!0}catch(t){return console.error("Failed to connect:",t),!1}}disconnect(){this.socket.end(),this.isConnected=!1}generateRequestId(){return Date.now().toString()+Math.random().toString().substring(2,8)}async sendCommand(t,n={},r={}){return t!=="mcp_status"&&r.statusPreflight!==!1&&await this.ensureReadyForCommand(t,r),await this.sendCommandRequest(t,n,r)}async ensureReadyForCommand(t,n={}){let r=n.statusTimeoutMs||Math.min(n.timeoutMs||3e3,3e3),o=await this.sendCommandRequest("mcp_status",{},{timeoutMs:r,statusPreflight:!1}),i=o&&typeof o=="object"?o.activeTask:null;if(!i)return;let a=i.taskName||i.method||"revAgent task",s=typeof i.elapsedMs=="number"?`, elapsed ${this.formatElapsed(i.elapsedMs)}`:"";throw new Error(`revAgent is busy with "${a}"${s}. Wait for it to finish before sending "${t}".`)}formatElapsed(t){let n=Math.max(0,Math.floor(t/1e3)),r=Math.floor(n/3600),o=Math.floor(n%3600/60),i=n%60;return[r,o,i].map(a=>String(a).padStart(2,"0")).join(":")}async sendCommandRequest(t,n={},r={}){let o=r.framing||this.framingMode;try{return await this.sendCommandRequestOnce(t,n,{...r,framing:o})}catch(i){if(o==="length-prefixed"&&r.allowLegacyFallback!==!1&&this.isFramingFallbackError(i))return this.framingMode="legacy",await this.sendCommandRequestOnce(t,n,{...r,framing:"legacy"});throw i}}isFramingFallbackError(t){let n=t instanceof Error?t.message:String(t);return/Invalid JSON|Invalid JSON-RPC request|Invalid (?:Revit MCP|revAgent) response frame length/i.test(n)}sendCommandRequestOnce(t,n={},r={}){return new Promise((o,i)=>{let a;try{this.isConnected||this.connect();let s=this.generateRequestId(),l={jsonrpc:"2.0",method:t,params:n,id:s};this.responseCallbacks.set(s,m=>{clearTimeout(a);try{let p=JSON.parse(m);p.error?i(new Error(p.error.message||"Unknown error from Revit")):o(p.result)}catch(p){p instanceof Error?i(new Error(`Failed to parse response: ${p.message}`)):i(new Error(`Failed to parse response: ${String(p)}`))}}),this.writeCommand(l,r.framing||this.framingMode);let u=r.timeoutMs||12e4;a=setTimeout(()=>{this.responseCallbacks.has(s)&&(this.responseCallbacks.delete(s),i(new Error(`Command timed out after ${this.formatElapsed(u)}: ${t}`)))},u),typeof a.unref=="function"&&a.unref()}catch(s){clearTimeout(a),i(s)}})}writeCommand(t,n){let r=Buffer.from(JSON.stringify(t),"utf8");if(n==="length-prefixed"){let o=Buffer.alloc(4);o.writeUInt32BE(r.length,0),this.socket.write(Buffer.concat([o,r]));return}this.socket.write(r)}};import*as fe from"fs";import*as xn from"os";import*as $e from"path";var hs=Le("REVAGENT_HOST","REVIT_MCP_HOST","REVIT_HOST")||"localhost",xo=Xe(Le("REVAGENT_PORT","REVIT_MCP_PORT","REVIT_PORT"),8080),fs=ws([Le("REVAGENT_INSTANCE_REGISTRY"),$e.join(xn.tmpdir(),"revAgent-instances.json"),Le("REVIT_MCP_INSTANCE_REGISTRY"),$e.join(xn.tmpdir(),"revit-mcp-instances.json")]),vo=$e.join(xn.tmpdir(),"revit-mcp-command-locks"),Co=8e3,gs=600*1e3,ys=250;function bs(e){return new Promise(t=>setTimeout(t,e))}function Xe(e,t){if(e==null||e===""){if(t!==void 0)return t;throw new Error("Invalid revAgent port: empty value")}let n=Number.parseInt(String(e),10);if(!Number.isFinite(n)||n<1||n>65535)throw new Error(`Invalid revAgent port: ${e}`);return n}function wo(e){return e?(Array.isArray(e)?e:String(e).split(",")).map(n=>String(n).trim()).filter(Boolean).map(n=>Xe(n)):[]}function at(e){return e?String(e).trim():hs}function Ss(e){return String(e).replace(/[^a-zA-Z0-9_.-]/g,"_")}function ws(e){let t=new Set,n=[];for(let r of e){if(!r||!String(r).trim())continue;let o=$e.resolve(String(r)),i=o.toLowerCase();t.has(i)||(t.add(i),n.push(o))}return n}function xs(e){return $e.join(vo,`${Ss(e.host)}-${e.port}.lock`)}function To(e){return e&&typeof e=="object"&&"code"in e?String(e.code):null}function vs(e){let t=new Set,n=[];for(let r of e){let o=at(r.host),i=Xe(r.port),a=`${o}:${i}`;t.has(a)||(t.add(a),n.push({...r,host:o,port:i}))}return n}function Ro(){let e=[];for(let t of fs)try{if(!fe.existsSync(t))continue;let n=JSON.parse(fe.readFileSync(t,"utf8"));if(Array.isArray(n)){e.push(...n);continue}if(n&&Array.isArray(n.instances)){e.push(...n.instances);continue}n&&n.targets&&typeof n.targets=="object"&&e.push(...Object.entries(n.targets).map(([r,o])=>({...typeof o=="object"&&o?o:{},name:r})))}catch{continue}return e}function Cs(e,t){let n=String(t).toLowerCase();return[e.name,e.id,e.target,e.pid,e.title,e.documentTitle,e.path,e.pathName].filter(o=>o!=null).some(o=>String(o).toLowerCase()===n)}function Ts(e){let t=Ro().find(n=>Cs(n,e));return t?{name:t.name||t.id||String(e),host:at(t.host),port:Xe(t.port),source:"registry",metadata:t}:null}function Rs(e,t){let n=String(e||"").trim();if(!n)return null;if(/^\d+$/.test(n))return{host:at(t),port:Xe(n),source:"target-port"};let r=n.match(/^(.+):(\d+)$/);return r?{host:at(r[1]),port:Xe(r[2]),source:"target-host-port"}:null}function Is(e={}){let t=at(e.host),n=e.port!==void 0&&e.port!==null?Xe(e.port):null;if(n)return{host:t,port:n,source:"explicit"};let r=e.target||Le("REVAGENT_TARGET","REVIT_MCP_TARGET");if(r){let o=Rs(r,t);if(o)return o;let i=Ts(r);if(i)return i;throw new Error(`Unknown revAgent target '${r}'. Use a port number, host:port, or a registered instance name.`)}return{host:t,port:xo,source:"default"}}function Io(e={}){let t=at(e.host),n=[];if(e.includeRegistry!==!1)for(let a of Ro())a.port&&n.push({name:a.name||a.id||a.title||a.documentTitle,host:at(a.host),port:Xe(a.port),source:"registry",metadata:a});let r=wo(e.ports),o=wo(Le("REVAGENT_PORTS","REVIT_MCP_PORTS")),i=o.length>0?o:[xo,8081,8082,8083,8084,8085];for(let a of r.length>0?r:i)n.push({host:t,port:a,source:r.length>0?"explicit":"scan"});return vs(n)}function _s(e){try{let t=fe.statSync(e);Date.now()-t.mtimeMs>gs&&fe.rmSync(e,{recursive:!0,force:!0})}catch(t){if(!t||To(t)==="ENOENT")return}}async function Ms(e,t=Co){let n=xs(e),r=Date.now();for(fe.mkdirSync(vo,{recursive:!0});;)try{return fe.mkdirSync(n,{recursive:!1}),fe.writeFileSync($e.join(n,"owner.json"),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),target:e},null,2)),()=>{try{fe.rmSync(n,{recursive:!0,force:!0})}catch{}}}catch(o){if(!o||To(o)!=="EEXIST")throw o;if(_s(n),Date.now()-r>=t)throw new Error(`revAgent target ${e.host}:${e.port} is busy; a previous Revit command is still running. Refusing to send another request.`);await bs(ys)}}async function Me(e,t={}){let n=Is(t),r=t.skipLock===!0?()=>{}:await Ms(n,t.lockWaitMs||Co),o=new wn(n.host,n.port,{logErrors:t.logSocketErrors!==!1});try{return o.isConnected||await new Promise((i,a)=>{let s,l=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),i()},u=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),a(new Error(`connect to revAgent target ${n.host}:${n.port} failed`))};o.socket.on("connect",l),o.socket.on("error",u),o.connect(),s=setTimeout(()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),a(new Error(`connect to revAgent target ${n.host}:${n.port} timed out`))},t.connectTimeoutMs||5e3),typeof s.unref=="function"&&s.unref()}),await e(o,n)}finally{o.disconnect(),r()}}import _r from"node:crypto";import Mr from"node:os";import Tt from"node:path";var Ns=[{name:"Parameter.Set",pattern:/\.Set\s*\(/i},{name:"Parameter.SetValueString",pattern:/\.SetValueString\s*\(/i},{name:"Parameter.ClearValue",pattern:/\.ClearValue\s*\(/i},{name:"Schedule.SetCellText",pattern:/\.\s*SetCellText\s*\(/i},{name:"Schedule table edit",pattern:/\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(/i},{name:"Document.Delete",pattern:/\.\s*Delete\s*\(/i},{name:"ElementTransformUtils",pattern:/ElementTransformUtils/i},{name:"Location.Move",pattern:/\.Move\s*\(/i},{name:"Element.ChangeTypeId",pattern:/\.ChangeTypeId\s*\(/i},{name:"Connector.ConnectTo",pattern:/\.ConnectTo\s*\(/i},{name:"Connector.DisconnectFrom",pattern:/\.DisconnectFrom\s*\(/i},{name:"FamilySymbol.Activate",pattern:/\.Activate\s*\(/i},{name:"NewFamilyInstance",pattern:/NewFamilyInstance/i},{name:"Create API",pattern:/\.(Create|New[A-Z]\w*)\s*\(/},{name:"View visibility/overrides",pattern:/\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/i},{name:"Geometry join/cut",pattern:/(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/i},{name:"Parameter binding edit",pattern:/\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/i},{name:"Revit property assignment",pattern:/\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.\s*(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/i},{name:"Manual Transaction",pattern:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/i}];function Gt(e){return Ns.filter(t=>t.pattern.test(e)).map(t=>t.name)}import br from"node:fs";import ve from"node:path";import{fileURLToPath as Es}from"node:url";function Ct(e){return/^(1|true|yes|on)$/i.test(String(e||"").trim())}function Qe(e){try{return!e||!br.existsSync(e)?null:JSON.parse(br.readFileSync(e,"utf8").replace(/^\uFEFF/,""))}catch{return null}}function Ht(){let e=Es(import.meta.url),t=ve.dirname(e),n=[ve.resolve(t,"..",".."),ve.resolve(t,"..")];for(let r of n)if(br.existsSync(ve.join(r,"package.json")))return r;return n[0]}function _o(){let e=Ht(),t=ve.dirname(e);return t&&t!==e?t:e}function Jt(){return process.env.ProgramData||process.env.PROGRAMDATA||"C:\\ProgramData"}function Mo(){let e=_o(),t=[process.env.REVAGENT_UPDATER_CONFIG,ve.join(e,"updater","updater-config.json"),ve.join(Jt(),"DPE","revAgent","updater","updater-config.json"),ve.join(Jt(),"DPE","RevitMCP","updater","updater-config.json")].filter(Boolean);for(let n of t){let r=Qe(n);if(r)return r}return null}function Ut(e=[]){let t=_o(),n=[ve.join(t,"updater","installed.json"),...e,ve.join(Jt(),"DPE","revAgent","updater","installed.json"),ve.join(Jt(),"DPE","RevitMCP","updater","installed.json")];for(let r of n){let o=Qe(r);if(o)return o}return null}function $t(e){let t=String(e||"").match(/-([0-9a-f]{7,40})$/i);return t?t[1]:null}function No(){return ve.join(Jt(),"DPE","revAgent","state","telemetry")}function st(e){return(String(e||"").trim()||"unknown-machine").toUpperCase()}function vn(e,t="unknown"){let n=String(e||"").trim();return n&&n.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g,"_").replace(/_+/g,"_").replace(/^[._-]+|[._-]+$/g,"")||t}import Rn from"node:fs";import Eo from"node:path";var Cn=new Map,Tn=new Map,Xt=0,Sr=0;async function ko(e,t){await Rn.promises.mkdir(Eo.dirname(e),{recursive:!0}),await Rn.promises.writeFile(e,`${JSON.stringify(t,null,2)}
`,"utf8")}async function wr(e,t){await Rn.promises.mkdir(Eo.dirname(e),{recursive:!0}),await Rn.promises.appendFile(e,`${JSON.stringify(t)}
`,"utf8")}function Po(e,t){let r=(Cn.get(e)||Promise.resolve()).catch(()=>{}).then(()=>wr(e,t));return Cn.set(e,r),r.finally(()=>{Cn.get(e)===r&&Cn.delete(e)}).catch(()=>{}),r}function xr(e,t,n){if(n.disabled())return!1;if(Xt>=n.maxInFlight())return Sr++,!1;Xt++;let o=(Tn.get(e)||Promise.resolve()).catch(()=>{}).then(()=>t(e));return Tn.set(e,o),o.catch(()=>{Sr++}).finally(()=>{Tn.get(e)===o&&Tn.delete(e),Xt=Math.max(0,Xt-1)}),!0}function Ao(e){return{inFlight:Xt,dropped:Sr,maxInFlight:e}}var ks=new Set(["completed","failed","guarded"]);function Qt(e,t,n){return e?.[n]!==void 0&&e?.[n]!==null?e[n]:t?.[n]??null}function In(e,t){return e??t??null}function Yt(e){return String(e?.state||"").toLowerCase()}function Cr(e){return ks.has(String(e||"").toLowerCase())}function Oo(e){return e!=null&&e!==""}function Vo(e){let t=Date.parse(String(e?.finishedAtUtc||e?.startedAtUtc||""));return Number.isFinite(t)?t:0}function Ps(e,t){let n=Cr(t?.state),r=Cr(e?.state);return n?t||null:r?e||null:t||e||null}function As(e,t){return Yt(t)==="failed"?t||null:Yt(e)==="failed"&&e||null}function vr(e,t,n,r){let o=String(e||"").toLowerCase(),i=Yt(n)===o,a=Yt(t)===o;return i&&a?Qt(n,t,r):i?Qt(n,null,r):a?Qt(t,null,r):null}function Os(e,t=""){if(!e||typeof e!="object")return t;if(Oo(e.requestId))return`request:${e.requestId}`;if(Oo(e.id))return`id:${e.id}`;let n=e.method||"",r=e.taskName||"",o=e.startedAtUtc||"";return n||r||o?`task:${n}|${r}|${o}`:t}function Vs(e,t){let n=Ps(e,t),r={...e||{},...t||{}};for(let o of["id","requestId","method","wrapperAction","logicalToolName","taskName","parentTaskName","parentTaskId","startedAtUtc","requestBytes","responseBytes","port"])r[o]=Qt(t,e,o);return r.state=In(n?.state,Qt(t,e,"state")),Cr(r.state)?(r.finishedAtUtc=In(vr(r.state,e,t,"finishedAtUtc"),n?.finishedAtUtc),r.elapsedMs=In(vr(r.state,e,t,"elapsedMs"),n?.elapsedMs)):(r.finishedAtUtc=null,r.elapsedMs=null),Yt(r)==="failed"?r.error=In(vr(r.state,e,t,"error"),As(e,t)?.error):r.error=null,r}function Ds(e,t,n=100){let r=Math.max(1,Math.min(200,Number(n)||100)),o=new Map,i=(a,s)=>{for(let[l,u]of(Array.isArray(a)?a:[]).entries()){if(!u||typeof u!="object")continue;let m=Os(u,`${s}:${l}`),p=o.get(m);o.set(m,p?Vs(p,u):u)}};return i(t,"cached"),i(e,"current"),[...o.values()].sort((a,s)=>Vo(s)-Vo(a)).slice(0,r)}function Do(e,t){let n=e&&typeof e=="object"?e:null,r=t&&typeof t=="object"?t:null;if(!n&&!r)return null;let o=n?.recentHistoryCapacity??r?.recentHistoryCapacity??100,i=Ds(n?.recentTasks,r?.recentTasks,o),a=Math.max(Number(n?.recentHistoryCount)||0,Number(r?.recentHistoryCount)||0,i.length);return{...r||{},...n||{},activeTask:n?.activeTask||null,recentTasks:i,recentHistoryCount:a,recentHistoryCapacity:o}}var Fs="revagent.telemetry.v1",Ls="revagent.live.status.v1",zo="revagent.live.activity.v1",Dn=_r.randomUUID(),qo=new Date().toISOString(),js=new Set(["capture_spatial_snapshot","extract_spatial_snapshot"]),Bs=new Set(["running","completed","guarded","failed"]),zs=new Set(["capture_spatial_snapshot","extract_spatial_snapshot"]),qs=new Set(["needs_scope","read_failed","invalid_request","invalid_cursor","invalid_cursor_sort_position","cursor_scope_mismatch","cursor_revision_mismatch","cursor_hash_mismatch","capture_interrupted_by_change","invalid_spatial_page_contract","runtime_exception","invalid_response_kind"]),Ws=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),Gs=0,Kt=new Map,lt=[],Wo=null,_n=null,Fo=null;function Nr(){return Ct(process.env.REVAGENT_TELEMETRY_DISABLED)}function Js(e){return _r.createHash("sha256").update(String(e||""),"utf8").digest("hex")}function Rt(e){return Js(e).slice(0,16)}function Nn(e,t=400){let n=String(e||"");return n.length<=t?{text:n,truncated:!1}:{text:`${n.slice(0,t)}...[truncated ${n.length-t} chars]`,truncated:!0}}function Hs(e){return String(e||"").split(/\r\n|\r|\n/).length}function ct(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Us(){return ct(process.env.REVAGENT_TELEMETRY_TEXT_CHARS,1e3,0,1e4)}function $s(){return ct(process.env.REVAGENT_TELEMETRY_CODE_CHARS,4e3,0,1e5)}function ut(){return Nr()||Ct(process.env.REVAGENT_LIVE_STATUS_DISABLED)}function Er(){return ct(process.env.REVAGENT_LIVE_STATUS_RECENT,50,5,200)}function kr(){return ct(process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT,32,1,64)}function Go(){return ct(process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS,5e3,0,6e4)}function Pr(e){return js.has(String(e??"").trim().toLowerCase())}function Fn(e={}){let t=e.params||{};return[e.toolName,e.commandName,e.logicalToolName,t.logicalToolName,t.wrapperAction].some(Pr)}function En(e={}){let t=o=>Array.isArray(o)?o.length:0,n=o=>{let i=Number.parseInt(String(o??""),10);return Number.isFinite(i)?i:null},r=["hostOnly","linkedOnly","hostAndLinked"].includes(String(e.sourceScope||""))?e.sourceScope:null;return{privacyBoundary:"spatial_extraction",levelSelectorCount:t(e.levelIds)+t(e.levelNames),levelIdCount:t(e.levelIds),levelNameCount:t(e.levelNames),linkInstanceSelectorCount:t(e.linkInstanceIds)+t(e.linkInstanceUniqueIds),sourceScope:r,cursorPresent:typeof e.cursor=="string"&&e.cursor.length>0,pageTargetBytes:n(e.pageTargetBytes),maxElements:n(e.maxElements),maxElapsedMs:n(e.maxElapsedMs),timeoutMs:n(e.timeoutMs),includeHostMep:e.includeHostMep!==!1,includeRoomsSpaces:e.includeRoomsSpaces!==!1,includeLinkedObstructions:e.includeLinkedObstructions!==!1}}function Xs(e,t){let n=String(e||""),r={hash:Rt(n),length:n.length,present:n.length>0};if(t>0){let o=Nn(n,t);r.text=o.text,r.textTruncated=o.truncated}return r}function Qs(e){let t=String(e||""),n={hash:Rt(t),length:t.length,lineCount:Hs(t),writePatternCount:Gt(t).length,writePatterns:Gt(t).slice(0,12),hasManualTransaction:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(t)},r=$s();if(r>0){let o=Nn(t,r);n.preview=o.text,n.previewTruncated=o.truncated}return n}function Ys(e,t){let n=new Set(["transactionMode","responseMode","planMode","planCandidateMode","targetVisualStyle","intent","imageFormat","cameraOrientation","viewType","category","discipline","cropBasis","searchBudget","linkScope","reason","scanStoppedReason"]);if(typeof t=="boolean"||typeof t=="number")return t;if(typeof t=="string")return n.has(e)?t:Xs(t,Us())}function kn(e={}){let t={keys:[]};if(!e||typeof e!="object")return t;let n=Object.keys(e).sort();t.keys=n.filter(r=>r!=="code"&&r!=="parameters");for(let r of n){let o=e[r];if(r==="code"){t.code=Qs(o);continue}if(r==="parameters"){t.parameters={count:Array.isArray(o)?o.length:o==null?0:1};continue}if(/elementIds$/i.test(r)&&Array.isArray(o)){t[r]={count:o.length};continue}if(Array.isArray(o)){t[r]={count:o.length};continue}if(o&&typeof o=="object"){t[r]={keys:Object.keys(o).sort()};continue}let i=Ys(r,o);i!==void 0&&(t[r]=i)}return t}function Ar(e){if(e&&typeof e=="object"){if(je(e,["success","Success"])===!1)return e;if("result"in e&&e.result!==null&&e.result!==void 0)return e.result;if("result"in e)return e}return e&&typeof e=="object"&&"result"in e?e.result:e}function je(e,t){if(!e||typeof e!="object")return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let[r,o]of n)if(t.some(i=>r.toLowerCase()===i.toLowerCase()))return o}function Jo(e){let t=String(e||"").trim().toLowerCase();return t==="runtime"||t==="client"?t:null}function Zt(e,t=null){if(t)return{success:!1,errorMessage:Nn(t instanceof Error?t.message:String(t)).text,errorType:t instanceof Error?t.name:"Error"};let n=Ar(e),r=n&&typeof n=="object"&&!Array.isArray(n),o=r?je(n,["success","Success"]):void 0,i=r?je(n,["state","State"]):void 0,a=r?je(n,["action","Action"]):void 0,s=r?je(n,["error","Error","errorMessage","ErrorMessage"]):void 0,l=r?je(n,["message","Message"]):void 0,u=r?je(n,["guardSource","GuardSource"]):void 0,m=typeof n=="string"?n:"",p=/^\s*ERROR\s*:/i.test(m)?m:"",f=String(i||"").toLowerCase()==="guarded"||je(n,["guarded","blocked","focusBlocked"])===!0||/blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(s||l||m||""));return{success:typeof o=="boolean"?o:!s&&!p,guarded:f,guardSource:f?Jo(u)||"runtime":null,state:i||null,action:a||null,responseKind:Array.isArray(n)?"array":n===null?"null":typeof n,responseKeys:r?Object.keys(n).sort().slice(0,40):[],errorMessage:s||p?Nn(s||p).text:null,messageHash:l?Rt(l):null}}function Lo(e,t=null){if(t)return Zt(null,t);try{let n=e?.content?.find?.(r=>r?.type==="text")?.text;if(typeof n=="string"&&n.trim().startsWith("{"))return Zt(JSON.parse(n))}catch{}return{success:!0,guarded:!1,responseKind:e===null?"null":typeof e,responseKeys:e&&typeof e=="object"?Object.keys(e).sort().slice(0,40):[]}}function Ks(){return ct(process.env.REVAGENT_TELEMETRY_CONTEXT_ELEMENTS,12,0,100)}function Ho(e){if(typeof e!="string")return e;let t=e.trim();if(!t.startsWith("{")&&!t.startsWith("[")&&!t.startsWith('"'))return e;try{let n=JSON.parse(t);return typeof n=="string"?Ho(n):n}catch{return e}}function Uo(e){try{let t=e?.content?.find?.(n=>n?.type==="text")?.text;if(typeof t=="string")return Ho(t)}catch{}return e}function Mn(e,t){let n=String(e??"").trim().toLowerCase();return t.has(n)?n:null}function Pn(e,t=null){if(t)return{success:!1,guarded:!1,state:"failed",reason:"runtime_exception",privacyBoundary:"spatial_extraction"};let n=e?.content?Uo(e):e,r=Ar(n),o=Ve(r);if(!o)return{success:!1,guarded:!1,state:"failed",reason:"invalid_response_kind",privacyBoundary:"spatial_extraction"};let i=Ve(R(o,["page","Page"])),a=R(o,["nodes","Nodes"]),s=R(o,["omissions","Omissions"]),l=R(o,["sourceRevisions","SourceRevisions"]),u=R(o,["success","Success"]),m=R(o,["guarded","Guarded"])===!0,p=de(R(i,["ordinal","Ordinal","pageOrdinal","PageOrdinal"]))??de(R(o,["pageOrdinal","PageOrdinal"])),f=de(R(i,["recordCount","RecordCount","rowCount","RowCount"]))??(Array.isArray(a)?a.length:null),y=de(R(i,["omissionCount","OmissionCount"]))??(Array.isArray(s)?s.length:null),S=de(R(i,["payloadBytes","PayloadBytes"]))??de(R(o,["payloadBytes","PayloadBytes"])),N=R(o,["nextCursor","NextCursor"])??R(i,["nextCursor","NextCursor"]);return{success:typeof u=="boolean"?u:!m,guarded:m,state:Mn(R(o,["state","State"]),Bs)||(m?"guarded":"completed"),action:Mn(R(o,["action","Action"]),zs),reason:Mn(R(o,["reason","Reason"]),qs),scanStoppedReason:Mn(R(o,["scanStoppedReason","ScanStoppedReason"]),Ws),partial:R(o,["partial","Partial"])===!0,pageOrdinal:p,recordCount:f,omissionCount:y,sourceRevisionCount:Array.isArray(l)?l.length:null,payloadBytes:S,hasMore:R(i,["hasMore","HasMore"])===!0,nextCursorPresent:typeof N=="string"&&N.length>0,privacyBoundary:"spatial_extraction"}}function Ve(e){return e&&typeof e=="object"&&!Array.isArray(e)?e:null}function R(e,t){return je(e,t)}function j(e,t,n=5){if(n<0||e===null||e===void 0)return;if(Array.isArray(e)){for(let i of e.slice(0,50)){let a=j(i,t,n-1);if(a!=null&&a!=="")return a}return}let r=Ve(e);if(!r)return;let o=R(r,t);if(o!=null&&o!=="")return o;for(let i of Object.values(r)){let a=j(i,t,n-1);if(a!=null&&a!=="")return a}}function An(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let i of e.slice(0,50))An(i,t,n-1,r);return r}let o=Ve(e);if(!o)return r;for(let[i,a]of Object.entries(o))t.some(s=>i.toLowerCase()===s.toLowerCase())&&Array.isArray(a)&&r.push(a),An(a,t,n-1,r);return r}function Rr(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let i of e.slice(0,50))Rr(i,t,n-1,r);return r}let o=Ve(e);if(!o)return r;for(let[i,a]of Object.entries(o))t.some(s=>i.toLowerCase()===s.toLowerCase())&&Ve(a)&&r.push(a),Rr(a,t,n-1,r);return r}function H(e){return e==null?null:typeof e=="string"?e:typeof e=="number"||typeof e=="boolean"?String(e):null}function de(e){return typeof e=="number"&&Number.isFinite(e)?e:typeof e=="string"&&/^-?\d+$/.test(e.trim())?Number.parseInt(e.trim(),10):null}function $o(e,t=25){return[...new Set((Array.isArray(e)?e:[]).map(n=>de(n)).filter(n=>Number.isFinite(n)))].slice(0,t)}function Zs(e={}){let t=[];e.elementId!==void 0&&t.push(e.elementId),e.viewId!==void 0&&t.push(e.viewId);for(let[n,r]of Object.entries(e||{}))/elementIds$/i.test(n)&&Array.isArray(r)&&t.push(...r);return $o(t,50)}function jo(e){let t=Ve(e);if(!t)return null;let n=de(R(t,["id","Id","elementId","ElementId"])),r=H(R(t,["name","Name"])),o=H(R(t,["category","Category","categoryName","CategoryName"])),i=H(R(t,["typeName","TypeName","familyName","FamilyName"])),a=H(R(t,["levelName","LevelName","level","Level"])),s=H(R(t,["roomName","RoomName","room","Room"])),l=H(R(t,["roomNumber","RoomNumber"])),u=H(R(t,["spaceName","SpaceName","space","Space"])),m=H(R(t,["spaceNumber","SpaceNumber"]));return!n&&!r&&!o&&!i&&!a&&!s&&!u?null:{id:n,name:r,category:o,typeName:i,levelName:a,roomName:s,roomNumber:l,spaceName:u,spaceNumber:m}}function el(e){let t=new Set;return e.filter(n=>{if(!n)return!1;let r=n.id?`id:${n.id}`:JSON.stringify(n);return t.has(r)?!1:(t.add(r),!0)})}function tl(e,t){let n=An(e,["elements","Elements","selectionElements","SelectionElements"]),r=Rr(e,["chosenElement","ChosenElement","targetElement","TargetElement"]),o=[];for(let i of r)o.push(jo(i));for(let i of n)for(let a of i.slice(0,t))o.push(jo(a));return el(o).slice(0,t)}function nl(e){let t=j(e,["selectionIds","SelectionIds"],4);return Array.isArray(t)?$o(t,50):[]}function rl(e){let t=An(e,["files","Files"],4),n=[];for(let r of t)for(let o of r.slice(0,12)){let i=Ve(o);i&&n.push({path:H(R(i,["path","Path"])),fileName:H(R(i,["fileName","FileName"])),bytes:de(R(i,["bytes","Bytes"])),width:de(R(i,["width","Width"])),height:de(R(i,["height","Height"])),finalPixelSizeMatchesRequest:R(i,["finalPixelSizeMatchesRequest","FinalPixelSizeMatchesRequest"])})}return n.filter(r=>r.path||r.fileName)}function Tr(e,t){let n=j(e,t,4);return Ve(n)?{id:de(R(n,["id","Id","viewId","ViewId"])),name:H(R(n,["name","Name","viewName","ViewName"])),type:H(R(n,["type","Type","viewType","ViewType"]))}:null}function ol(e,t=20){return[...new Set(e.filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim()))].slice(0,t)}function il(e=[],t="",n="",r=""){let o=`${e.join(" ")} ${t} ${n} ${r}`.toLowerCase();return/\bm\d{2,}[a-z]?\b/i.test(o)?"mechanical_hvac":/\bp\d{2,}[a-z]?\b/i.test(o)?"mechanical_piping":/\be\d{2,}[a-z]?\b/i.test(o)?"electrical":/\bs\d{2,}[a-z]?\b/i.test(o)?"structural":/\ba\d{2,}[a-z]?\b/i.test(o)?"architectural":/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(o)?"mechanical_hvac":/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)/i.test(o)?"mechanical_piping":/(electrical|cable|lighting|elektrik)/i.test(o)?"electrical":/(structural|beam|column|framing|statik|kiris|kolon)/i.test(o)?"structural":/(wall|door|window|room|space|architect|mimari)/i.test(o)?"architectural":/(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)/i.test(o)?"schedule_documentation":null}function al(e,t){let n=e||t||"";return n?Rt(n):null}function sl(e={},t=[]){for(let n of t){let r=e?.[n];if(typeof r=="string"&&r.trim())return r.trim()}return null}function ll(e={},t=[]){return t.map(n=>e?.[n]).filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim())}function cl(e={},t="",n=null,r=null,o=null,i={}){return[t,i.toolName,i.commandName,i.logicalToolName,...ll(e,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery","planNameContains","category","discipline"]),...Array.isArray(e.rowTextQueries)?e.rowTextQueries:[],...Array.isArray(e.categoryNames)?e.categoryNames:[],n?.name,r?.name,o?.name].filter(s=>typeof s=="string"&&s.trim()).join(" ")}function ul(...e){let t=e.filter(i=>typeof i=="string"&&i.trim()).join(" ");if(!t)return null;let n=t.match(/\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b/i);if(n)return`Level ${n[1].padStart(2,"0")}`;let r=t.match(/\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b/i);if(r)return`Level ${r[1].padStart(2,"0")}`;let o=t.match(/\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b/i);return o?`Basement ${o[1].padStart(2,"0")}`:null}function dl(e={}){if(Fn(e))return null;let t=e.sourceEventType==="mcp.tool"?Uo(e.response):Ar(e.response),n=Ve(t),r=e.params||{},o=e.taskName||r.taskName||e.options?.taskName||e.logicalToolName||e.toolName||e.commandName||null,i=e.responseSummary||Zt(e.response,e.error),a=Ks(),s=a>0?tl(t,a):[],l=ol([...Array.isArray(r.categoryNames)?r.categoryNames.map(String):[],H(r.category),...s.map(bn=>bn.category)]),u=j(t,["document","Document"],3),m=H(j(t,["documentTitle","DocumentTitle"],5))||H(R(u,["title","Title","name","Name"])),p=H(j(t,["documentPath","DocumentPath"],5))||H(R(u,["path","Path","modelPath","ModelPath"])),f=Tr(t,["activeView","ActiveView","view","View"]),y=Tr(t,["beforeView","BeforeView","activeViewBefore","ActiveViewBefore"]),S=Tr(t,["afterView","AfterView"]),N=Zs(r),k=nl(t),F=rl(t),L=H(j(t,["levelName","LevelName","activePlanLevelName","ActivePlanLevelName"],5)),O=de(j(t,["levelId","LevelId","activePlanLevelId","ActivePlanLevelId"],5)),J=H(j(t,["roomName","RoomName"],5)),Y=H(j(t,["roomNumber","RoomNumber"],5)),Z=H(j(t,["spaceName","SpaceName"],5)),ee=H(j(t,["spaceNumber","SpaceNumber"],5)),ne=sl(r,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery"]),$=typeof r.outputDir=="string"?r.outputDir:H(j(t,["outputDir","OutputDir"],4)),re=typeof r.filePrefix=="string"?r.filePrefix:H(j(t,["filePrefix","FilePrefix"],4)),xe=cl(r,o||"",f,y,S,e),_e=L||ul(xe),He=j(t,["inferredScope","InferredScope"],5),Wt=j(t,["effectiveScope","EffectiveScope"],5),vt=j(t,["riskPolicy","RiskPolicy","searchRiskPolicy","SearchRiskPolicy"],5),Ue=j(t,["scanPolicy","ScanPolicy"],5),yr=j(t,["partial","Partial"],4),Oe=H(j(t,["scanStoppedReason","ScanStoppedReason"],4)),yn=de(j(t,["scannedElementCount","ScannedElementCount"],4));return!(o||m||p||f||y||S||N.length||k.length||s.length||F.length||_e||J||Z||ne||$)?null:{eventType:"production.context",contextSchemaVersion:"revagent.production.context.v1",related:{sourceEventType:e.sourceEventType,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null},runId:e.taskId||r.taskId||e.options?.taskId||Rt(`${Dn}|${e.sourceEventType||""}|${e.toolName||""}|${e.commandName||""}|${e.startedAtMs||""}|${o||""}`),operation:{taskName:o,query:ne,action:i.action||H(j(t,["action","Action"],3)),durationMs:e.durationMs,success:i.success,guarded:i.guarded,state:i.state,errorMessage:i.errorMessage},project:{projectId:al(p,m),documentTitle:m,documentPath:p,isFamilyDocument:j(t,["isFamilyDocument","IsFamilyDocument"],4),isReadOnly:j(t,["isReadOnly","IsReadOnly"],4),isModifiable:j(t,["isModifiable","IsModifiable"],4)},view:{active:f,before:y,after:S,activeViewChanged:j(t,["activeViewChanged","ActiveViewChanged"],4)},location:{levelId:O,levelName:_e,roomName:J,roomNumber:Y,spaceName:Z,spaceNumber:ee},elements:{targetElementIds:N,selectionIds:k,selectionCount:de(j(t,["selectionCount","SelectionCount"],4)),categories:l,disciplineHint:il(l,o||"",xe,e.toolName||e.logicalToolName||e.commandName||""),samples:s,samplesTruncated:a>0&&s.length>=a},outputs:{outputDir:$,filePrefix:re,files:F},search:{query:ne,inferredScope:He,effectiveScope:Wt,riskPolicy:vt,riskLevel:R(vt,["riskLevel","RiskLevel"])||null,recommendedFirstScope:R(vt,["recommendedFirstScope","RecommendedFirstScope"])||null,requiresUserControl:R(vt,["requiresUserControl","RequiresUserControl"])===!0,scanPolicy:Ue,searchBudget:r.searchBudget||R(Ue,["searchBudget","SearchBudget"])||null,linkScope:r.linkScope||R(Wt,["linkScope","LinkScope"])||null,planCandidateMode:r.planCandidateMode||R(Ue,["planCandidateMode","PlanCandidateMode"])||null,allowExpensiveSearch:r.allowExpensiveSearch===!0||R(Ue,["allowExpensiveSearch","AllowExpensiveSearch"])===!0,scannedElementCount:yn,partial:yr===!0,scanStoppedReason:Oe,needsScope:i.guarded&&i.state==="guarded"&&(R(n,["reason","Reason"])==="needs_scope"||Oe==="needs_scope")},response:{responseKeys:i.responseKeys||(n?Object.keys(n).sort().slice(0,40):[])}}}function Ir(e={}){let t=dl(e);t&&en(t)}function Xo(){let e=Mo();return{disabled:Nr(),localOnly:Ct(process.env.REVAGENT_TELEMETRY_LOCAL_ONLY),localRoot:process.env.REVAGENT_TELEMETRY_ROOT||No(),reportsRoot:process.env.REVAGENT_REPORTS_ROOT||e?.reportsRoot||""}}function Qo(e){let t=e.getUTCFullYear().toString(),n=String(e.getUTCMonth()+1).padStart(2,"0"),r=String(e.getUTCDate()).padStart(2,"0");return{year:t,month:n,day:r,ymd:`${t}-${n}-${r}`}}function ml(e){let t=Xo();if(t.disabled)return[];let n=new Date(e.timestampUtc||Date.now()),r=Qo(n),o=vn(st(e.machineName),"unknown-machine"),a=[{kind:"local",path:Tt.join(t.localRoot,"events",`${r.ymd}.ndjson`)}];return!t.localOnly&&t.reportsRoot&&a.push({kind:"remote",path:Tt.join(t.reportsRoot,"events",r.year,r.month,r.day,o,`${e.sessionId}.ndjson`)}),a}function pl(){let e=Xo();return{disabled:ut(),localOnly:e.localOnly||Ct(process.env.REVAGENT_LIVE_STATUS_LOCAL_ONLY),localRoot:process.env.REVAGENT_LIVE_STATUS_LOCAL_ROOT||Tt.join(e.localRoot,"live"),reportsRoot:process.env.REVAGENT_LIVE_STATUS_ROOT||(e.reportsRoot?Tt.join(e.reportsRoot,"live"):"")}}function Yo(e=[]){let t=pl();if(t.disabled)return[];let r=["machines",vn(st(process.env.COMPUTERNAME||Mr.hostname()),"unknown-machine"),...e],o=[{kind:"local",path:Tt.join(t.localRoot,...r)}];return!t.localOnly&&t.reportsRoot&&o.push({kind:"remote",path:Tt.join(t.reportsRoot,...r)}),o}function Ko(e){return!e||typeof e!="object"||Array.isArray(e)?null:{success:typeof e.success=="boolean"?e.success:null,guarded:e.guarded===!0,guardSource:e.guardSource||null,state:e.state||null,action:e.action||null,errorMessage:e.errorMessage||null,messageHash:e.messageHash||null}}function On(e,t="summary"){if(!e)return null;let n={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,taskIdPresent:!!e.taskId,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,state:e.state,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:t==="full"?e.result||null:Ko(e.result)};return t!=="full"&&!n.result&&delete n.result,n}function Bo(e){if(!e||typeof e!="object")return null;let t=e.commandName||e.method||null,n=e.wrapperAction||e.logicalToolName||e.toolName||t,r=[t,n,e.wrapperAction,e.logicalToolName].some(Pr);return{id:e.id||null,requestId:e.requestId||null,method:n||null,toolName:n||null,commandName:t,wrapperAction:e.wrapperAction||null,logicalToolName:e.logicalToolName||null,taskName:r?null:e.taskName||null,parentTaskName:r?null:e.parentTaskName||null,parentTaskIdPresent:r?!1:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,elapsedMs:e.elapsedMs??null,requestBytes:e.requestBytes??null,responseBytes:e.responseBytes??null,port:e.port||null,error:r?null:e.error||null}}function hl(e,t){if(t==="full")return e;let n=Ko(e.result),r={timestampUtc:e.timestampUtc||e.finishedAtUtc||e.startedAtUtc||null,phase:e.phase,state:e.state||e.phase||null,scope:e.scope||null,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),guardSource:e.guardSource||n?.guardSource||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null};return n&&(r.success=n.success,r.guarded=n.guarded,r.action=n.action,r.errorMessage=n.errorMessage,r.messageHash=n.messageHash),Object.fromEntries(Object.entries(r).filter(([,o])=>o!=null))}function Zo(e=10,t="summary"){let n=ct(e,10,0,100),r=t==="full"?"full":"summary",i=(r==="full"?lt:lt.filter(a=>a.phase!=="started")).slice(0,n).map(a=>hl(a,r));return{mode:r,activeTask:On(ei(),r),activeTasks:[...Kt.values()].map(a=>On(a,r)),recentActivity:i,recentActivityCount:i.length,recentActivityStoredCount:lt.length,recentActivityCapacity:Er()}}function fl(e){if(!e||typeof e!="object")return null;let t=e.result&&typeof e.result=="object"?e.result:e;return{capturedAtUtc:new Date().toISOString(),activeTask:Bo(t.activeTask),recentTasks:(Array.isArray(t.recentTasks)?t.recentTasks:[]).map(Bo).filter(Boolean).slice(0,100),recentHistoryCount:t.recentHistoryCount??null,recentHistoryCapacity:t.recentHistoryCapacity??null}}function Ln(e){if(ut())return;let t=fl(e);t&&(Wo=t,Vn("revit.status"))}function ei(){let e=[...Kt.values()];return e.length===0?null:e.sort((t,n)=>{let r=i=>i.scope==="revit.command"?2:1,o=r(n)-r(t);return o!==0?o:String(n.startedAtUtc||"").localeCompare(String(t.startedAtUtc||""))})[0]}function gl(e="activity"){let n=Ut()?.version||null,r=new Date().toISOString();return Fo=r,{schemaVersion:Ls,generatedAtUtc:r,lastHeartbeatUtc:Fo,reason:e,machineName:st(process.env.COMPUTERNAME||Mr.hostname()),userName:process.env.USERNAME||process.env.USER||"",sessionId:Dn,runtime:{version:n,buildHash:$t(n)},process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:qo},activeTask:On(ei(),"full"),activeTasks:[...Kt.values()].map(o=>On(o,"full")),recentActivity:lt.slice(0,Er()),revitStatus:Wo,writeHealth:Ao(kr())}}function yl(e){let t=Array.isArray(e?.revitStatus?.recentTasks)?e.revitStatus.recentTasks:[],n=Array.isArray(e?.activeTasks)?e.activeTasks:[],r=Array.isArray(e?.recentActivity)?e.recentActivity:[];return!!(e?.activeTask||n.length>0||r.length>0||e?.revitStatus?.activeTask||t.length>0)}function bl(e){let t=Date.parse(String(e?.generatedAtUtc||e?.lastHeartbeatUtc||""));return Number.isFinite(t)?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY}function Sl(e,t){let n=Qe(e);if(!n||st(n.machineName)!==st(t.machineName))return t;let r=Math.max(600*1e3,Go()*6);return!yl(n)||bl(n)>r?t:{...t,recentActivity:Array.isArray(t.recentActivity)&&t.recentActivity.length>0?t.recentActivity:Array.isArray(n.recentActivity)?n.recentActivity:[],revitStatus:Do(t.revitStatus,n.revitStatus)}}function Vn(e="activity"){let t=gl(e);for(let n of Yo(["status.json"]))xr(n.path,r=>ko(r,Sl(r,t)),{disabled:ut,maxInFlight:kr})}function wl(e){let t={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName,commandName:e.commandName,logicalToolName:e.logicalToolName,executionKind:e.executionKind,taskName:e.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,guardSource:e.guardSource,state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,durationMs:e.durationMs,result:e.result};e.phase==="started"?Kt.set(e.liveTaskId,t):Kt.delete(e.liveTaskId),lt.unshift({timestampUtc:e.timestampUtc,phase:e.phase,state:e.state,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:e.result||null});let n=Er();lt.length>n&&lt.splice(n)}function ti(e){wl(e);let t=Qo(new Date(e.timestampUtc||Date.now()));for(let n of Yo(["activity",`${t.ymd}.ndjson`]))xr(n.path,r=>wr(r,e),{disabled:ut,maxInFlight:kr});Vn(e.phase)}function xl(e={},t){return e.taskId?String(e.taskId):Rt([Dn,e.scope||"",e.toolName||"",e.commandName||"",e.logicalToolName||"",t||Date.now(),e.taskName||""].join("|"))}function It(e={}){if(ut())return null;let t=Fn(e),n=t?{...e,taskName:null,taskId:null,parentTaskName:null,parentTaskId:null}:e,r=n.startedAtMs||Date.now(),o=new Date(r).toISOString(),i=xl(n,r),a=Or({schemaVersion:zo,eventType:"live.activity",phase:"started",state:"running",liveTaskId:i,scope:n.scope||"runtime",toolName:n.toolName||null,commandName:n.commandName||null,logicalToolName:n.logicalToolName||null,executionKind:n.executionKind||null,taskName:n.taskName||null,taskId:n.taskId||null,taskIdPresent:!!n.taskId,parentTaskName:n.parentTaskName||null,parentTaskId:n.parentTaskId||null,parentTaskIdPresent:!!n.parentTaskId,startedAtUtc:o,params:t?En(n.params):kn(n.params)});return ti(a),{liveTaskId:i,scope:a.scope,toolName:a.toolName,commandName:a.commandName,logicalToolName:a.logicalToolName,executionKind:a.executionKind,taskName:a.taskName,taskId:a.taskId,parentTaskName:a.parentTaskName,parentTaskId:a.parentTaskId,guardSource:a.guardSource,startedAtMs:r,startedAtUtc:o}}function Ne(e,t={}){if(!e||ut())return;let n=Date.now(),r=t.durationMs??Math.max(0,n-(e.startedAtMs||n)),i=Fn({...t,...e})?Pn(t.response,t.error):t.responseSummary||Zt(t.response,t.error),a=i.guarded?"guarded":i.success===!1?"failed":"completed",s=i.guarded?Jo(t.guardSource||e.guardSource||i.guardSource)||"runtime":null,l=Or({schemaVersion:zo,eventType:"live.activity",phase:a,state:a,liveTaskId:e.liveTaskId,scope:e.scope||t.scope||"runtime",toolName:e.toolName||t.toolName||null,commandName:e.commandName||t.commandName||null,logicalToolName:e.logicalToolName||t.logicalToolName||null,executionKind:e.executionKind||t.executionKind||null,taskName:e.taskName||t.taskName||null,taskId:e.taskId||t.taskId||null,taskIdPresent:!!(e.taskId||t.taskId),parentTaskName:e.parentTaskName||t.parentTaskName||null,parentTaskId:e.parentTaskId||t.parentTaskId||null,parentTaskIdPresent:!!(e.parentTaskId||t.parentTaskId),guardSource:s,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:new Date(n).toISOString(),durationMs:r,result:i});ti(l)}function vl(){if(_n||ut())return;let e=Go();e<=0||(Vn("session.start"),_n=setInterval(()=>{Vn("heartbeat")},e),typeof _n.unref=="function"&&_n.unref())}function Or(e={}){let n=Ut()?.version||null;return{schemaVersion:Fs,eventId:_r.randomUUID(),eventType:e.eventType||"runtime.event",timestampUtc:e.timestampUtc||new Date().toISOString(),sessionId:Dn,sequence:++Gs,source:"runtime-mcp-server",process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:qo},machineName:st(process.env.COMPUTERNAME||Mr.hostname()),userName:process.env.USERNAME||process.env.USER||"",runtime:{version:n,buildHash:$t(n)},...e}}async function en(e={}){if(Nr())return;let t=Or(e),n=ml(t);await Promise.allSettled(n.map(r=>Po(r.path,t)))}function ni(){vl(),en({eventType:"runtime.session.start"})}function Be(e={}){let t=Math.max(0,Date.now()-(e.startedAtMs||Date.now())),n=Fn(e),r=n?Pn(e.response,e.error):Zt(e.response,e.error);en({eventType:"revit.command",commandName:e.commandName,logicalToolName:e.logicalToolName||e.commandName,executionKind:e.executionKind||"bridgeCommand",taskName:n?null:e.params?.taskName||e.options?.taskName||null,taskIdPresent:n?!1:!!(e.params?.taskId||e.options?.taskId),parentTaskName:n?null:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskIdPresent:n?!1:!!(e.params?.parentTaskId||e.options?.parentTaskId),transactionMode:n?null:e.params?.transactionMode||e.options?.transactionMode||null,connection:n?void 0:{targetPresent:!!e.options?.target,hostPresent:!!e.options?.host,port:e.options?.port||null},durationMs:t,params:n?En(e.params):kn(e.params),result:r}),Ir({...e,sourceEventType:"revit.command",durationMs:t,responseSummary:r,taskName:e.params?.taskName||e.options?.taskName||null,taskId:e.params?.taskId||e.options?.taskId||null,parentTaskName:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskId:e.params?.parentTaskId||e.options?.parentTaskId||null})}function Cl(e){return!(e==="get_revit_mcp_status"&&!Ct(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS))}function ri(e){return{...e,tool(t,n,r,o){let i=n,a=r,s=o;typeof n=="object"&&(s=r,a=n,i="");let l=async(u,m)=>{let p=Date.now(),f=Cl(t),y=Pr(t),S=f?It({scope:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,startedAtMs:p}):null;try{let N=await s(u,m);if(f){let k=Math.max(0,Date.now()-p),F=y?Pn(N):Lo(N);en({eventType:"mcp.tool",toolName:t,taskName:y?null:u?.taskName||null,taskIdPresent:y?!1:!!u?.taskId,parentTaskName:y?null:u?.parentTaskName||null,parentTaskIdPresent:y?!1:!!u?.parentTaskId,durationMs:k,params:y?En(u):kn(u),result:F}),Ir({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,response:N,durationMs:k,startedAtMs:p,responseSummary:F}),Ne(S,{response:N,responseSummary:F,durationMs:k})}return N}catch(N){if(f){let k=Math.max(0,Date.now()-p),F=y?Pn(null,N):Lo(null,N);en({eventType:"mcp.tool",toolName:t,taskName:y?null:u?.taskName||null,taskIdPresent:y?!1:!!u?.taskId,parentTaskName:y?null:u?.parentTaskName||null,parentTaskIdPresent:y?!1:!!u?.parentTaskId,durationMs:k,params:y?En(u):kn(u),result:F}),Ir({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,error:N,durationMs:k,startedAtMs:p,responseSummary:F}),Ne(S,{error:N,responseSummary:F,durationMs:k})}throw N}};return e.tool(t,i,a,l)}}}var Tl=2;function w(e){return{target:e.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVAGENT_TARGET, then legacy REVIT_MCP_TARGET, then REVAGENT_PORT/8080."),host:e.string().optional().describe("Optional Revit socket host. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),port:e.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVAGENT_PORT, then legacy REVIT_MCP_PORT, then 8080.")}}function x(e){return{taskName:e.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),taskId:e.string().optional().describe("Optional client task identifier forwarded to Revit status history."),parentTaskName:e.string().optional().describe("Optional parent workflow display name. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task."),parentTaskId:e.string().optional().describe("Optional parent workflow identifier. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task id.")}}function d(e,t,n){if(!e||typeof e!="object")return;let r=n??t.charAt(0).toLowerCase()+t.slice(1);return e[t]??e[r]}function se(e={}){return{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs}}function ge(e={},t){return{taskName:e.taskName||t,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId}}function I(e={},t){return{...se(e),...ge(e,t)}}function ii(e,t){let n=t.parentTaskName||(t.taskName&&e.taskName&&e.taskName!==t.taskName?t.taskName:void 0),r=t.parentTaskId||(t.taskId&&e.taskName&&e.taskName!==t.taskName?t.taskId:void 0);n&&!e.parentTaskName&&(e.parentTaskName=n),r&&!e.parentTaskId&&(e.parentTaskId=r)}function ai(e,t,n){let r=n.toolName||t;r&&!e.logicalToolName&&(e.logicalToolName=r),n.toolName&&n.toolName!==t&&!e.wrapperAction&&(e.wrapperAction=n.toolName)}function jn(e){let t=[["Success","success"],["SUCCESS","success"],["Guarded","guarded"],["State","state"],["Action","action"],["Message","message"],["Error","error"],["ResultContractVersion","resultContractVersion"]],n=r=>{if(Array.isArray(r))return r.map(i=>n(i));if(!r||typeof r!="object")return r;let o={};for(let[i,a]of Object.entries(r))o[i]=n(a);for(let[i,a]of t)Object.prototype.hasOwnProperty.call(o,i)&&(Object.prototype.hasOwnProperty.call(o,a)||(o[a]=o[i]),delete o[i]);return o};return n(e)}function h(e){let t=jn(e);return{content:[{type:"text",text:JSON.stringify(t,null,2)}]}}function tn(e,t=0){if(typeof e!="string")return e;let n=e.trim();if(!n.startsWith("{")&&!n.startsWith("[")&&!n.startsWith('"'))return e;try{let r=JSON.parse(n);return t<2&&typeof r=="string"?tn(r,t+1):r}catch{return e}}function Bn(e){if(Array.isArray(e))return e.map(n=>Bn(n));if(!e||typeof e!="object")return e;let t={};for(let[n,r]of Object.entries(e)){let o=n==="result"||n==="Result"?tn(r):r;t[n]=Bn(o)}return t}function Rl(e){if(!e||typeof e!="object"||Array.isArray(e))return null;let t=e.resultContractVersion??e.ResultContractVersion,n=Number.parseInt(String(t??""),10);return Number.isFinite(n)?n:null}function Il(e){let t=Rl(e);return t!==null&&t>=Tl}function ze(e,t={}){let n=tn(e);if(Il(n))return t.parseResultStrings===!0?jn(Bn(n)):n;if(n&&typeof n=="object"&&!Array.isArray(n)){let r=n;return t.parseResultStrings===!0?r=Bn(r):("result"in r||"Result"in r)&&(r={...r},"result"in r?r.result=tn(r.result):r.Result=tn(r.Result)),jn(r)}return jn(n)}function si(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function mt(e,t={}){let n=t.verboseCandidates===!0,r=si(t.maxPlanCandidates,3,0,100);if(n)return e;let o=i=>{if(Array.isArray(i))return i.map(s=>o(s));if(!i||typeof i!="object")return i;let a={};for(let[s,l]of Object.entries(i)){if((s==="PlanCandidates"||s==="planCandidates")&&Array.isArray(l)){let u=s==="PlanCandidates"?"PlanCandidatesTotal":"planCandidatesTotal",m=s==="PlanCandidates"?"PlanCandidatesTruncated":"planCandidatesTruncated";a[u]=l.length,a[m]=l.length>r,a[s]=l.slice(0,r).map(p=>o(p));continue}a[s]=o(l)}return a};return o(e)}function oi(e,t){if(!e||typeof e!="object")return e;let n=e.commandName||e.method,r=e.wrapperAction||e.logicalToolName||e.toolName||n,o={id:e.id,requestId:e.requestId,method:r,toolName:r,commandName:n,wrapperAction:e.wrapperAction,logicalToolName:e.logicalToolName,taskName:e.taskName,parentTaskName:e.parentTaskName,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,elapsedMs:e.elapsedMs,port:e.port,error:e.error};return t&&(o.framing=e.framing,o.requestBytes=e.requestBytes,o.receiveMs=e.receiveMs,o.parseMs=e.parseMs,o.executeMs=e.executeMs,o.responseBytes=e.responseBytes),o}function nn(e,t={}){let n=t.includeRecentTasks!==!1,r=t.includeDiagnostics===!0,o=si(t.recentLimit,3,0,100),i=e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e;if(!i||typeof i!="object")return e;let a={...i};return a.activeTask=oi(i.activeTask,r),Array.isArray(i.recentTasks)&&(a.recentHistoryCount=i.recentHistoryCount??i.recentTasks.length,a.recentHistoryCapacity=i.recentHistoryCapacity??100,delete a.recentTasksTotal,n?(a.recentTasks=i.recentTasks.slice(0,o).map(s=>oi(s,r)),a.recentTasksTruncated=i.recentTasks.length>o):(delete a.recentTasks,a.recentTasksIncluded=!1)),e&&typeof e=="object"&&e.result&&typeof e.result=="object"?{...e,result:a}:a}async function K(e,t={}){let n={code:e,parameters:t.parameters||[],transactionMode:t.transactionMode||"none",taskName:t.taskName||"Run Revit code"};t.taskId&&(n.taskId=t.taskId),ai(n,"send_code_to_revit",t),ii(n,t);let r=Date.now(),o=It({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",taskName:n.taskName,taskId:n.taskId,parentTaskName:n.parentTaskName,parentTaskId:n.parentTaskId,params:n,startedAtMs:r});try{let i=await Me(async l=>await l.sendCommand("send_code_to_revit",n,t),t),a=t.parseJsonResult===!1?i:ze(i,{parseResultStrings:!0}),s=Math.max(0,Date.now()-r);return Be({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,response:a,startedAtMs:r}),Ne(o,{response:a,durationMs:s}),dt(t),a}catch(i){let a=Math.max(0,Date.now()-r);throw Be({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,error:i,startedAtMs:r}),Ne(o,{error:i,durationMs:a}),dt(t),i}}async function dt(e={}){let t=Math.max(250,Math.min(5e3,Number(e.statusRefreshTimeoutMs||1500)));try{let n=await Me(async r=>await r.sendCommand("mcp_status",{},{timeoutMs:t}),{...e,skipLock:!0,connectTimeoutMs:t,timeoutMs:t,logSocketErrors:!1});return Ln(n),n}catch{return null}}async function _(e,t={},n={}){let r={...t};r.taskName||(r.taskName=n.taskName||e),ii(r,n),n.taskId&&!r.taskId&&(r.taskId=n.taskId),ai(r,e,n);let o=Date.now(),i=It({scope:"revit.command",commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:o});try{let a=await Me(async u=>await u.sendCommand(e,r,n),n),s=ze(a),l=Math.max(0,Date.now()-o);return Be({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,response:s,startedAtMs:o}),Ne(i,{response:s,durationMs:l}),dt(n),s}catch(a){let s=Math.max(0,Date.now()-o);throw Be({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,error:a,startedAtMs:o}),Ne(i,{error:a,durationMs:s}),dt(n),a}}function M(e){return e==null?"null":`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n")}"`}function Ee(e){return`new string[] { ${(Array.isArray(e)?e:[]).map(M).join(", ")} }`}function zn(e){return`new int[] { ${(Array.isArray(e)?e:[]).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function li(e,t){let n=Number(t||0);return!n||typeof e!="string"||e.length<=n?{text:e,truncated:!1}:{text:`${e.slice(0,n)}
...[truncated ${e.length-n} chars]`,truncated:!0}}function _l(e){let t=new Set,n=(r,o="")=>{if(r!=null){if(typeof r=="number"&&/(^id$|elementid|elementids)/i.test(o)){t.add(r);return}if(typeof r=="string"&&/^-?\d+$/.test(r)&&/(^id$|elementid|elementids)/i.test(o)){t.add(Number.parseInt(r,10));return}if(Array.isArray(r)){for(let i of r)n(i,o);return}if(typeof r=="object")for(let[i,a]of Object.entries(r))n(a,i)}};return n(e),[...t].filter(r=>Number.isFinite(r)&&r>0)}async function _t(e=100,t={}){let n=await _("get_selected_elements",{limit:e},t);return _l(n).slice(0,e)}var Ml=new Set(["success","guarded","state","action","error","reason","warnings","notices"]);function ci(e){let t=String(e||"").trim();return t.length>0?t:void 0}function ui(e){if(!Array.isArray(e))return;let t=e.map(n=>String(n||"").trim()).filter(n=>n.length>0);return t.length>0?t:void 0}function Nl(e){return e?Object.fromEntries(Object.entries(e).filter(([t])=>!Ml.has(t))):{}}function Vr(e,t){let n={...Nl(t.extra),...e,action:t.action},r=ci(t.error),o=ci(t.reason),i=ui(t.warnings),a=ui(t.notices);return r&&(n.error=r),o&&(n.reason=o),i&&(n.warnings=i),a&&(n.notices=a),n}function di(e){return Vr({success:!0,guarded:!1,state:"completed",action:e.action},e)}function De(e){return Vr({success:!1,guarded:!0,state:"guarded",action:e.action},e)}function Ce(e){return Vr({success:!1,guarded:!1,state:"failed",action:e.action},e)}function El(e){let t=String(e||"");return t.match(/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\b(?:class|struct|interface|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*/m)?{reason:"dynamic_snippet_type_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). C# type declarations such as class/struct/interface/enum/record cannot be declared inside that method body. Use local functions, built-in collections, or add a native runtime tool when reusable helper types are needed."}:t.match(/^\s*namespace\s+[A-Za-z_][A-Za-z0-9_.]*/m)?{reason:"dynamic_snippet_namespace_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). namespace declarations cannot be declared inside that method body. Use method-body C# only."}:null}function kl(e){let t=ze(e);if(t&&typeof t=="object"&&t.success===!1)return t.error||t.errorMessage||t.message||"Revit code returned success=false.";let n=t&&typeof t=="object"&&"result"in t?t.result:t;return typeof n=="string"&&/^\s*ERROR\s*:/i.test(n)?n.trim():n&&typeof n=="object"&&n.success===!1?n.error||n.message||"Revit code returned success=false.":null}function mi(e){e.tool("send_code_to_revit","Send C# code to Revit for execution. The code will be inserted into a template with access to the Revit Document and parameters. Your code should be written to work within the Execute method of the template.",{...w(qe),...x(qe),code:qe.string().describe("The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."),parameters:qe.array(qe.any()).optional().describe("Optional execution parameters that will be passed to your code"),transactionMode:qe.enum(["auto","none"]).optional().describe("Transaction handling mode forwarded to the Revit wrapper. In the bundled plugin build, snippets should not open their own Transaction unless that exact build has been verified."),timeoutMs:qe.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),reportErrorResultAsFailure:qe.boolean().optional().describe("When true, ERROR: string results or { success:false } objects are reported as failed tool calls. Defaults true. This cannot roll back a write if the snippet swallowed its own exception."),parseJsonResult:qe.boolean().optional().describe("When true, parse JSON-looking result strings, including double-encoded JSON strings. Defaults true. Set false to inspect the raw wire result.")},async(t,n)=>{let r={code:t.code,parameters:t.parameters||[],transactionMode:t.transactionMode||"auto",taskName:t.taskName||"Run Revit code"};t.taskId&&(r.taskId=t.taskId),t.parentTaskName&&(r.parentTaskName=t.parentTaskName),t.parentTaskId&&(r.parentTaskId=t.parentTaskId),r.logicalToolName="send_code_to_revit";let o=se(t),i=Date.now(),a=It({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:i}),s=El(t.code);if(s){let l=Math.max(0,Date.now()-i),u=De({action:"dynamic_snippet_preflight",reason:s.reason,error:s.message});return Be({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:i}),Ne(a,{response:u,durationMs:l}),{content:[{type:"text",text:`Code execution guarded: ${s.message}`}]}}try{let l=await Me(async f=>await f.sendCommand("send_code_to_revit",r,o),o),u=t.parseJsonResult===!1?l:ze(l,{parseResultStrings:!0}),m=Math.max(0,Date.now()-i);Be({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:i}),Ne(a,{response:u,durationMs:m}),dt(o);let p=t.parseJsonResult===!1||t.reportErrorResultAsFailure===!1?null:kl(u);return p?{content:[{type:"text",text:`Code execution failed: ${p}`}]}:{content:[{type:"text",text:`Code execution successful!
Result: ${JSON.stringify(u,null,2)}`}]}}catch(l){let u=Math.max(0,Date.now()-i);return Be({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,error:l,startedAtMs:i}),Ne(a,{error:l,durationMs:u}),dt(o),{content:[{type:"text",text:`Code execution failed: ${l instanceof Error?l.message:String(l)}`}]}}})}import{z as ye}from"zod";function Dr(e,t,n){return h(De({action:"send_code_to_revit_safe_preflight",error:e,reason:n,extra:{safetyReason:n,writePatterns:t}}))}function pi(e){e.tool("send_code_to_revit_safe","Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.",{...w(ye),...x(ye),code:ye.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),parameters:ye.array(ye.union([ye.string(),ye.number(),ye.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),transactionMode:ye.enum(["auto","none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),intent:ye.enum(["read","writePreview","writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),timeoutMs:ye.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),maxReturnedChars:ye.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),parseJsonResult:ye.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true.")},async t=>{let n=t.intent||"read",r=Gt(t.code);if(n==="writeCommit")return Dr("send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",r,"safe_wrapper_write_commit_not_supported");if(t.transactionMode==="auto")return Dr("send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",r,"safe_wrapper_requires_transactionMode_none");if(r.length>0)return Dr(`Rejected write-looking code for intent '${n}'.`,r,"safe_wrapper_rejected_write_looking_code");try{let i=await K(t.code,{...se(t),...ge(t,"Run safe Revit read"),parameters:t.parameters||[],transactionMode:"none",parseJsonResult:t.parseJsonResult!==!1}),a=di({action:"send_code_to_revit_safe",extra:{intent:n,response:i}}),s=JSON.stringify(a,null,2),l=li(s,t.maxReturnedChars);return l.truncated?{content:[{type:"text",text:l.text}]}:h(a)}catch(o){return h(Ce({action:"send_code_to_revit_safe",error:o instanceof Error?o.message:String(o)}))}})}import{z as Mt}from"zod";function Pl(e){return e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e}function Al(e){let t=String(e.detailLevel||"minimal").toLowerCase(),n=e.includeCategoryCounts===!0||t==="counts"||t==="full"?"true":"false",r=e.includeLinks!==!1?"true":"false",o=e.includeLinks===!0&&t==="full"||t==="full"?"true":"false";return`
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
}`}function hi(e){e.tool("get_revit_session_context","Read-only Revit session summary. Defaults to detailLevel=minimal so large-model document checks do not perform heavy MEP category or linked room/space counts. Use detailLevel=counts/full only when those expensive counts are explicitly needed.",{...w(Mt),...x(Mt),detailLevel:Mt.enum(["minimal","counts","full"]).optional().describe("Context detail level. minimal is default and avoids category counts and linked room/space scans; counts adds host MEP category counts; full also scans linked room/space counts."),includeCategoryCounts:Mt.boolean().optional().describe("Compatibility flag. true includes known MEP category counts; default false unless detailLevel is counts/full."),includeLinks:Mt.boolean().optional().describe("Include cheap Revit link instance summary. Defaults true; linked room/space counts require detailLevel=full."),includeSelection:Mt.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true.")},async t=>{let n=se(t);try{let r=await K(Al(t),{...n,...ge(t,"Read Revit session context"),transactionMode:"none"}),o=Pl(r);if(t.includeSelection!==!1&&o&&typeof o=="object"){let i=await _t(100,{...n,taskName:t.taskName?`${t.taskName}: selection`:"Read Revit selection",taskId:t.taskId});o.selection={count:i.length,elementIds:i}}return h(o)}catch(r){return h({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as Ye}from"zod";function Ol(e){let t=e.includeSheetViewports!==!1?"true":"false",n=e.includeSheetScheduleInstances!==!1?"true":"false",r=e.includeModelElements===!0?"true":"false",o=Number.isFinite(e.limit)?Math.max(1,Math.min(500,e.limit)):100,i=Ee(e.modelCategoryList||[]);return`
bool includeSheetViewports = ${t};
bool includeSheetScheduleInstances = ${n};
bool includeModelElements = ${r};
int limit = ${o};
string[] modelCategoryNames = ${i};

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
}`}function fi(e){e.tool("get_active_view_context","Read-only active view context. Handles model views and DrawingSheet views; sheets return placed viewport/view data plus scheduleSheetInstances instead of pretending MEP model elements are directly visible.",{...w(Ye),...x(Ye),includeSheetViewports:Ye.boolean().optional().describe("When active view is a sheet, include placed viewports. Defaults true."),includeSheetScheduleInstances:Ye.boolean().optional().describe("When active view is a sheet, include placed ScheduleSheetInstance entries with schedule ids, names, point, and box data. Defaults true."),includeModelElements:Ye.boolean().optional().describe("When active view is a model view, collect limited model elements from modelCategoryList. Defaults false."),modelCategoryList:Ye.array(Ye.string()).optional().describe("BuiltInCategory names such as OST_DuctCurves or OST_DuctTerminal."),limit:Ye.number().int().positive().max(500).optional().describe("Maximum model elements to return. Defaults 100.")},async t=>{try{let n=await K(Ol(t),{...I(t,"Read active Revit view context"),transactionMode:"none"});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as gi}from"zod";var Vl=["dryRun","DryRun","deleted","Deleted","confirmDelete","ConfirmDelete","targetIsReviewView","TargetIsReviewView","reviewSignals","ReviewSignals","deletedElementCount","DeletedElementCount"],Dl=["closed","Closed"];function Nt(e,t={}){if(!e||typeof e!="object"||Array.isArray(e))return e;let n={...e};for(let r of Vl)delete n[r];if(t.stripCloseOnlyFields)for(let r of Dl)delete n[r];return n}function yi(e){e.tool("list_open_views","List Revit UI view tabs currently open in the active document.",{...w(gi),...x(gi)},async t=>{try{let n=await _("list_open_views",{},{...I(t,"List open Revit views")});return h(Nt(n&&n.result?n.result:n))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as pt}from"zod";function bi(e){e.tool("activate_view","Activate an existing Revit view tab by id or unique name without opening a transaction. Supports plans, 3D views, sheets, schedules, legends, drafting views, sections, and elevations.",{...w(pt),...x(pt),viewId:pt.number().int().positive().optional().describe("ElementId of the Revit view to activate."),viewName:pt.string().optional().describe("Name of the Revit view to activate. Must match one view unless viewType is also supplied."),viewType:pt.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:pt.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:pt.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation verification. Defaults 15000.")},async t=>{try{let n=await _("activate_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...I(t,"Activate Revit view")});return h(Nt(n&&n.result?n.result:n,{stripCloseOnlyFields:!0}))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ht}from"zod";function Si(e){e.tool("close_view","Close an open Revit UI view tab by id or unique name without opening a transaction. If the target is active, another open view is activated first.",{...w(ht),...x(ht),viewId:ht.number().int().positive().optional().describe("ElementId of the Revit view to close."),viewName:ht.string().optional().describe("Name of the Revit view to close. Must match one view unless viewType is also supplied."),viewType:ht.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:ht.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:ht.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI close verification. Defaults 15000.")},async t=>{try{let n=await _("close_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...I(t,"Close Revit view")});return h(Nt(n&&n.result?n.result:n))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Fr}from"zod";function wi(e){e.tool("clear_selection","[LIVE_UI_SELECTION_CLEANUP] Clear the current Revit UI selection. This does not open a transaction and does not modify model elements or view data. Use after focus/testing workflows when the operator wants Revit left with no selected elements.",{...w(Fr),...x(Fr),timeoutMs:Fr.number().int().positive().max(3e4).optional().describe("Timeout for the selection clear command. Defaults 10000.")},async t=>{try{let n=await _("clear_selection",{timeoutMs:t.timeoutMs},{...I(t,"Clear Revit selection")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,action:"clear_selection",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as Fe}from"zod";function Fl(e){return!e||typeof e!="object"?null:{id:d(e,"Id","id")??d(e,"ViewId","viewId")??null,name:d(e,"Name","name")??d(e,"ViewName","viewName")??null,type:d(e,"Type","type")??d(e,"ViewType","viewType")??null}}function Ll(e,t={}){let n=t.responseMode||"compact";if(!e||typeof e!="object"||n==="full")return{...e,responseMode:n};let r=Fl(d(e,"TargetView","targetView")),o={mode:d(e,"Mode","mode")??t.mode??"dryRun",dryRun:d(e,"DryRun","dryRun")??null,changed:d(e,"Changed","changed")??null,deleted:d(e,"Deleted","deleted")??null,deletedElementCount:d(e,"DeletedElementCount","deletedElementCount")??null,confirmed:(d(e,"ConfirmDelete","confirmDelete")??t.confirmDelete)===!0,targetIsReviewView:d(e,"TargetIsReviewView","targetIsReviewView")??null,reviewSignals:d(e,"ReviewSignals","reviewSignals")??[]};return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded"),state:d(e,"State","state"),action:d(e,"Action","action")||"delete_review_view",responseMode:"compact",reason:d(e,"Reason","reason"),error:d(e,"Error","error"),message:d(e,"Message","message"),targetView:r,cleanup:o,suggestedNextScopes:d(e,"SuggestedNextScopes","suggestedNextScopes")??[],notices:[...Array.isArray(d(e,"Notices","notices"))?d(e,"Notices","notices"):[],'Compact response groups cleanup-specific fields under cleanup. Use responseMode="full" for raw delete_review_view diagnostics.']}}function xi(e){e.tool("delete_review_view",'[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode="commit" and confirmDelete=true.',{...w(Fe),...x(Fe),viewId:Fe.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),viewName:Fe.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),viewType:Fe.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),exactName:Fe.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),mode:Fe.enum(["dryRun","commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),confirmDelete:Fe.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),responseMode:Fe.enum(["compact","full"]).optional().describe("Response shape. compact is the default and groups cleanup-specific fields under cleanup; full returns the raw native cleanup contract."),timeoutMs:Fe.number().int().positive().max(12e4).optional().describe("Timeout for review view cleanup. Defaults 15000.")},async t=>{try{let n=await _("delete_review_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,mode:t.mode,confirmDelete:t.confirmDelete,timeoutMs:t.timeoutMs},{...I(t,"Delete Revit review view")});return h(Ll(n&&n.result?n.result:n,t))}catch(n){return h({success:!1,action:"delete_review_view",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as qn}from"zod";function vi(e){e.tool("get_ui_state","Read the current Revit UI state: active view, open views, selected element ids/summaries, and document modifiable/read-only status.",{...w(qn),...x(qn),selectionLimit:qn.number().int().min(0).max(1e3).optional().describe("Maximum selected elements to summarize. Defaults 100."),timeoutMs:qn.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=await _("get_ui_state",{selectionLimit:t.selectionLimit},{...I(t,"Read Revit UI state")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as C}from"zod";var jl="fast",Bl={fast:{name:"fast",maxElementsScanned:5e3,maxElapsedMs:4500,socketTimeoutMs:12e3},balanced:{name:"balanced",maxElementsScanned:25e3,maxElapsedMs:18e3,socketTimeoutMs:3e4},deep:{name:"deep",maxElementsScanned:15e4,maxElapsedMs:9e4,socketTimeoutMs:12e4}},zl=[{concept:"fan_coil",terms:["fan coil","fancoil","fcu"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"air_handling_unit",terms:["ahu","air handling unit","klima santrali"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"pump",terms:["pump","pompa"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"valve",terms:["valve","vana"],categories:["Pipe Accessories","Pipe Fittings"],preserveQueryWhenFullyStripped:!0},{concept:"damper",terms:["damper"],categories:["Duct Accessories","Mechanical Equipment"]},{concept:"air_terminal",terms:["diffuser","grille","air terminal","difuzor","menfez"],categories:["Air Terminals"]},{concept:"duct",terms:["duct","kanal"],categories:["Ducts","Duct Fittings","Duct Accessories"]},{concept:"pipe",terms:["pipe","boru"],categories:["Pipes","Pipe Fittings","Pipe Accessories"]},{concept:"sprinkler",terms:["sprinkler"],categories:["Sprinklers"]},{concept:"plumbing_fixture",terms:["plumbing fixture","sanitary fixture","sihhi tesisat armat\xFCr","armat\xFCr"],categories:["Plumbing Fixtures"]}],ql=/^[\p{L}\p{N}_\- ]{1,24}$/u;function Ci(e){return String(e||"").normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase().replace(/\s+/g," ").trim()}function Wl(e){return e.normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase()}function Ti(e){let t=[],n=[];for(let r=0;r<e.length;){let o=e.codePointAt(r);if(o===void 0)break;let i=String.fromCodePoint(o),a=r+i.length,s=Wl(i);for(let l of s)t.push(l),n.push([r,a]);r=a}return{text:t.join(""),sourceRanges:n}}function jr(e){let t=new Set,n=[];for(let r of e){let o=String(r||"").trim();if(!o)continue;let i=o.toLowerCase();t.has(i)||(t.add(i),n.push(o))}return n}function Gl(e){let t=String(e||"").toLowerCase();return t==="balanced"||t==="deep"||t==="fast"?t:jl}function Lr(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Jl(e,t){let n=Ti(e),r=new Array(e.length).fill(!1);for(let i of t.sort((a,s)=>s.length-a.length)){let a=Ti(i).text;if(!a)continue;let s=a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+"),l=new RegExp(`(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`,"gu"),u;for(;(u=l.exec(n.text))!==null;)for(let m=u.index;m<l.lastIndex;m++){let p=n.sourceRanges[m];if(p)for(let f=p[0];f<p[1];f++)r[f]=!0}}let o="";for(let i=0;i<e.length;i++)o+=r[i]?" ":e[i];return o.replace(/\s+/g," ").trim()}function Hl(e){let t=Ci(e),n=[],r=[],o=[],i=!1;for(let s of zl){let l=s.terms.filter(u=>t.includes(Ci(u)));l.length!==0&&(n.push({concept:s.concept,terms:l,categories:s.categories,preserveQueryWhenFullyStripped:s.preserveQueryWhenFullyStripped===!0}),r.push(...l),o.push(...s.categories),i=i||s.preserveQueryWhenFullyStripped===!0)}let a=Jl(e,r);return{matchedConcepts:n,matchedTerms:r,categories:jr(o),effectiveQuery:a||(i?e.trim():"")}}function Ul(e={}){let t=["levelNames","activeViewOnly","familyName","typeName","systemName"];return!e.sheetQuery&&!Array.isArray(e.sheetIds)&&t.push("sheetQuery"),!e.nameQuery&&!Array.isArray(e.scheduleIds)&&t.push("scheduleIds/nameQuery"),t.push("allowExpensiveSearch","searchBudget=deep"),t}function Wn(e,t){for(let n of e)if(!(!n||typeof n!="object"))for(let r of t){let o=n[r],i=Number.parseInt(String(o??""),10);if(Number.isFinite(i))return i}return null}function $l(e,t){let n=[];return t.length>0&&n.push(`categoryNames=${t.join("|")}`),Array.isArray(e.levelNames)&&e.levelNames.length>0&&n.push("levelNames"),(e.activeViewOnly===!0||e.viewId)&&n.push("activeViewOnly/viewId"),e.familyName&&n.push("familyName"),e.typeName&&n.push("typeName"),e.systemName&&n.push("systemName"),n.length>0?n:["categoryNames","levelNames","activeViewOnly","familyName/typeName","systemName"]}function Xl(e={},t=[]){return!!(t.length>0||e.activeViewOnly===!0||e.viewId||Array.isArray(e.levelIds)&&e.levelIds.length>0||Array.isArray(e.levelNames)&&e.levelNames.length>0||e.familyName||e.typeName||e.systemName||Array.isArray(e.worksetIds)&&e.worksetIds.length>0||Array.isArray(e.worksetNames)&&e.worksetNames.length>0||Array.isArray(e.elementIds)&&e.elementIds.length>0||Array.isArray(e.uniqueIds)&&e.uniqueIds.length>0)}function Ke(e){return Array.isArray(e)&&e.some(t=>String(t??"").trim())}function Ql(e,t,n,r){return t!=="hostOnly"&&Ke(e.uniqueIds)&&!Ke(e.elementIds)&&!n&&r.length===0&&e.activeViewOnly!==!0&&!e.viewId&&!Ke(e.levelIds)&&!Ke(e.levelNames)&&!e.familyName&&!e.typeName&&!e.systemName&&!Ke(e.worksetIds)&&!Ke(e.worksetNames)}function Yl(e){let t=String(e||"").trim();return!!(t&&ql.test(t))}function Kl(e,t){let n=[],r=0,o=[e.largeModelRisk,e.modelRisk,e.modelSignals,e.sessionSummary].filter(Boolean),i=Wn(o,["linkCount","linkInstances","loadedLinks","loadedLinkCount"]),a=Wn(o,["worksetCount","worksets"]),s=Wn(o,["sheetCount","sheets"]),l=Wn(o,["scheduleCount","schedules"]);i!==null&&i>=25?(r+=2,n.push("high_link_count")):i!==null&&i>=10&&(r+=1,n.push("moderate_link_count")),a!==null&&a>=40?(r+=2,n.push("high_workset_count")):a!==null&&a>=20&&(r+=1,n.push("moderate_workset_count")),s!==null&&s>=1e3&&(r+=1,n.push("large_sheet_set")),l!==null&&l>=500&&(r+=1,n.push("large_schedule_set")),!t.boundedScope&&Yl(t.originalQuery)&&(r+=3,n.push("generic_unscoped_query")),!t.boundedScope&&!t.originalQuery&&(r+=3,n.push("missing_search_scope")),t.broadLinkedSearch&&(r+=2,n.push("linked_search_without_expensive_approval")),t.verifiedBroadSearch&&(r+=2,n.push("verified_plan_candidates_without_bounded_scope")),t.verifiedVisibilityExpensive&&(r+=2,n.push("verified_visibility_expensive")),(t.searchBudget==="deep"||t.allowExpensiveSearch)&&n.push("operator_approved_expensive_search"),t.boundedScope&&n.length===0&&n.push("bounded_first_pass_scope");let u=r>=4?"high":r>=2?"medium":r>=1||t.boundedScope?"low":"unknown",m=!t.allowExpensiveSearch&&(t.broadLinkedSearch||t.verifiedBroadSearch||t.verifiedVisibilityExpensive||!t.boundedScope&&r>=2);return{riskLevel:u,reasons:n,recommendedFirstScope:$l(e,t.effectiveCategoryNames),requiresUserControl:m}}function Ri(e={}){let t=String(e.query||"").trim(),n=jr(Array.isArray(e.categoryNames)?e.categoryNames:[]),r=Hl(t),o=n.length>0,i=o?n:jr(r.categories),a=r.effectiveQuery||(i.length>n.length?"":t),s=Gl(e.searchBudget),l=Bl[s],u=e.timeoutMs?Lr(e.timeoutMs,l.socketTimeoutMs,1e3,12e4):l.socketTimeoutMs,m=Math.max(u,Math.min(12e4,l.maxElapsedMs+2500)),p=Lr(e.maxElementsScanned,l.maxElementsScanned,1,5e5),f=Math.min(l.maxElapsedMs,Math.max(1e3,m-2500)),y=Lr(e.maxElapsedMs,f,500,Math.max(500,m-1e3)),S=Xl(e,i),N=String(e.linkScope||"hostOnly"),k=e.allowExpensiveSearch===!0||s==="deep",F=Ql(e,N,t,i),L=N!=="hostOnly"&&!k&&!F,O=String(e.planCandidateMode||(e.includePlanCandidates===!0?"verified":"none")).toLowerCase(),J=e.includePlanCandidates===!0&&O==="verified",Y=Ke(e.elementIds)||Ke(e.uniqueIds),Z=J&&!S,ee=J&&!Y,ne=Kl(e,{originalQuery:t,boundedScope:S,effectiveCategoryNames:i,linkScope:N,allowExpensiveSearch:k,broadLinkedSearch:L,verifiedBroadSearch:Z,verifiedVisibilityExpensive:ee,searchBudget:s}),$=ne.requiresUserControl,re=[];return r.matchedConcepts.length>0&&n.length===0&&re.push("search_scope_inferred_from_mep_terms"),r.matchedConcepts.length>0&&o&&r.categories.some(xe=>!i.includes(xe))&&re.push("explicit_category_scope_preserved_no_inferred_expansion"),L&&re.push("linked_model_search_requires_allowExpensiveSearch"),Z&&re.push("verified_plan_candidates_require_bounded_scope"),ee&&re.push("verified_visibility_requires_exact_targets_or_approval"),ne.requiresUserControl&&re.push("search_requires_user_scope_control"),{originalQuery:t,effectiveQuery:a,inferredScope:{source:"runtime_search_policy",concepts:r.matchedConcepts,strippedTerms:r.matchedTerms,categoryNames:r.categories,residualQuery:a},effectiveCategoryNames:i,riskPolicy:ne,linkScope:N,searchBudget:s,maxElementsScanned:p,maxElapsedMs:y,timeoutMs:m,allowExpensiveSearch:k,guarded:$,reason:$?"needs_scope":void 0,message:$?"This search would scan a broad model surface. Narrow by category, level, active view, system, family/type, sheet/schedule, or explicitly allow an expensive search.":void 0,warnings:re,suggestedNextScopes:Ul(e)}}function Ii(e){return{success:!0,guarded:!0,state:"guarded",action:"find_elements",reason:"needs_scope",message:e.message,originalQuery:e.originalQuery,query:e.effectiveQuery,inferredScope:e.inferredScope,effectiveScope:{categoryNames:e.effectiveCategoryNames,searchBudget:e.searchBudget,linkScope:e.linkScope},riskPolicy:e.riskPolicy,scanPolicy:{searchBudget:e.searchBudget,maxElementsScanned:e.maxElementsScanned,maxElapsedMs:e.maxElapsedMs,timeoutMs:e.timeoutMs,allowExpensiveSearch:e.allowExpensiveSearch},suggestedNextScopes:e.suggestedNextScopes,warnings:e.warnings}}import{z as Zl}from"zod";var Ze=Zl.enum(["compact","full","debug"]).optional().default("compact").describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");function et(e){return e==="full"||e==="debug"}function ke(e,t,n){let r=Number.parseInt(String(e??""),10);return!Number.isFinite(r)||r<=0?t:Math.max(1,Math.min(n,r))}function be(e,t){let n=Array.isArray(e)?e.filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)):[],r=new Set,o=[],i=t.key||rn;for(let s of n){let l=i(s);r.has(l)||(r.add(l),o.push(s))}let a=o.slice(0,Math.max(0,t.limit));return{rows:a,totalCount:n.length,uniqueCount:o.length,returnedCount:a.length,duplicateCount:n.length-o.length,omittedCount:Math.max(0,o.length-a.length)}}function rn(e){return Br(e)}function Br(e){if(e==null)return String(e);if(Array.isArray(e))return`[${e.map(Br).join(",")}]`;if(typeof e=="object"){let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${Br(t[n])}`).join(",")}}`}return JSON.stringify(e)}var ec=25,tc=25;function _i(e,t,n){let r=e[t];if(Array.isArray(r)){r.includes(n)||r.push(n);return}if(typeof r=="string"&&r.trim()){e[t]=r===n?[r]:[r,n];return}e[t]=[n]}function Mi(e){if(!e||typeof e!="object"||d(e,"Success","success")===!1)return e;let n=Array.isArray(e.elements)?e.elements:Array.isArray(e.Elements)?e.Elements:null,r=e.count??e.Count,o=r==null||r===""?Number.NaN:Number(r),i=Number.isFinite(o)?o:n?.length??0,a=!!(e.truncated??e.Truncated),s=!!(e.ambiguous??e.Ambiguous),l=String(e.topConfidence??e.TopConfidence??""),u=!!(l&&l.toLowerCase()!=="high"),m=s||a||i!==1||u,p=m?"broad_or_ambiguous_discovery_result":"discovery_tool_result_not_parameter_write_evidence",f="find_elements is discovery-only. Never commit parameter writes from find_elements rows alone; broad, ambiguous, truncated, or non-high-confidence results are especially unsafe. Before writing, narrow to one exact elementId or uniqueId, verify it with inspect_elements, run inspect_parameter_schema for the target parameter, then run set_element_parameter in dryRun before commit. Do not write from a visible/display parameter name alone.",y="find_elements result is broad or ambiguous for write purposes; do not use it as parameter-write evidence. Narrow to one exact element and run inspect_parameter_schema before set_element_parameter.";return e.writeSafetyWarning=f,e.writeSafety={sufficientForWrite:!1,discoveryEvidenceOnly:!0,writeBlockedUntil:"exact_element_and_parameter_schema_preflight",requiresExactElementIdentity:!0,requiresParameterSchemaPreflight:!0,requiredPreflightTools:["inspect_elements","inspect_parameter_schema","set_element_parameter"],requiredBeforeParameterWrite:["narrow_to_exact_element_id_or_unique_id","inspect_elements_exact_target","inspect_parameter_schema_exact_target_parameter","set_element_parameter_dry_run_with_expected_current_value","commit_only_after_dry_run_verification"],parameterWritePolicy:"Never commit set_element_parameter from find_elements rows alone. Use find_elements only to discover candidates, then prove exact element and parameter identity before a dry-run or commit.",parameterIdentityRule:"Use builtInParameterId when available; otherwise confirm source/shared/storage/readOnly identity. Display name alone is not a write target.",resultRisk:{count:i,truncated:a,ambiguous:s,topConfidence:l,broadOrAmbiguous:m,confidenceRisk:u,unsafeForParameterWriteReason:p}},_i(e,"warnings",m?y:f),_i(e,"notices","find_elements_discovery_only_parameter_write_preflight_required"),typeof e.SelectionHint=="string"&&!e.SelectionHint.includes("find_elements is discovery-only")&&(e.SelectionHint=`${e.SelectionHint} ${f}`),typeof e.selectionHint=="string"&&!e.selectionHint.includes("find_elements is discovery-only")&&(e.selectionHint=`${e.selectionHint} ${f}`),e}function nc(e){let t=e.id??e.Id??e.uniqueId??e.UniqueId??e.elementId??e.ElementId;return t!=null&&t!==""?String(t):rn(e)}function rc(e){return Array.isArray(e.planCandidates)?"planCandidates":Array.isArray(e.PlanCandidates)?"PlanCandidates":null}function Te(e,...t){for(let n of t)if(e[n]!==void 0&&e[n]!==null&&e[n]!=="")return e[n]}function oc(e){return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0))}function ic(e){let t=Te(e,"id","Id","viewId","ViewId","elementId","ElementId");if(t!==void 0)return String(t);let n=Te(e,"name","Name","viewName","ViewName"),r=Te(e,"levelId","LevelId","levelName","LevelName");return n!==void 0||r!==void 0?`${String(n??"")}|${String(r??"")}`:rn(e)}function ac(e,t){return oc({ref:t,id:Te(e,"id","Id","viewId","ViewId","elementId","ElementId"),name:Te(e,"name","Name","viewName","ViewName"),viewType:Te(e,"viewType","ViewType"),levelId:Te(e,"levelId","LevelId"),levelName:Te(e,"levelName","LevelName"),score:Te(e,"score","Score","rankScore","RankScore"),rank:Te(e,"rank","Rank"),elementVisibleInView:Te(e,"elementVisibleInView","ElementVisibleInView"),reason:Te(e,"reason","Reason","matchReason","MatchReason")})}function sc(e,t){return{ref:t}}function lc(e,t,n){let r=rc(e);if(!r)return{element:e,totalCandidateRows:0,omittedCandidateRows:0};let o=e[r].filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)),i=[];for(let s of o){let l=ic(s);n.has(l)||n.set(l,ac(s,l)),i.length<t&&i.push(sc(s,l))}let a={...e};return delete a.planCandidates,delete a.PlanCandidates,a.planCandidateRefs=i,a.planCandidateCount=o.length,a.returnedPlanCandidateRefCount=i.length,a.omittedPlanCandidateRefCount=Math.max(0,o.length-i.length),{element:a,totalCandidateRows:o.length,omittedCandidateRows:Math.max(0,o.length-i.length)}}function cc(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||et(n))return{...e,responseMode:n};let r=Array.isArray(e.elements)?"elements":Array.isArray(e.Elements)?"Elements":null;if(!r)return{...e,responseMode:"compact"};let o=ke(t.maxResultRows??t.limit,ec,200),i=ke(t.maxPlanCandidates,3,25),a=ke(t.maxPlanCandidateSummaryRows,Math.max(tc,i),100),s=be(e[r],{limit:o,key:nc}),l=new Map,u=0,m=0,p=s.rows.map(y=>{let S=lc(y,i,l);return u+=S.totalCandidateRows,m+=S.omittedCandidateRows,S.element}),f=be(Array.from(l.values()),{limit:a,key:y=>String(y.ref??rn(y))});return{...e,responseMode:"compact",[r]:p,planCandidateSummary:{compactResponse:!0,candidateRowCount:u,uniqueCandidateCount:l.size,returnedCandidateCount:f.returnedCount,omittedCandidateCount:f.omittedCount,duplicateCandidateRowCount:Math.max(0,u-l.size),omittedElementCandidateRefCount:m,candidates:f.rows},summary:{...e.summary||e.Summary||{},compactResponse:!0,elementRowCount:s.totalCount,returnedElementRowCount:s.returnedCount,omittedElementRowCount:s.omittedCount,duplicateElementRowCount:s.duplicateCount,planCandidateRowCount:u,uniquePlanCandidateCount:l.size,returnedPlanCandidateCount:f.returnedCount,omittedPlanCandidateCount:f.omittedCount},notices:[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds element rows and deduplicates plan candidates into planCandidateSummary. Use responseMode="full" for per-element plan candidate details.']}}function Ni(e){e.tool("find_elements","Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters plus safe in-memory level filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep before broad, linked, or verified visibility scans. Default responseMode=compact bounds element rows and deduplicates plan candidates into planCandidateSummary; use responseMode=full for per-element plan candidate details. Discovery-only: never use broad or ambiguous find_elements rows as write evidence; before writes, narrow to one exact element, inspect it, inspect the parameter schema, then use set_element_parameter dryRun before commit.",{...w(C),...x(C),query:C.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),categoryNames:C.array(C.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals. If omitted, common MEP terms such as fan coil/FCU, valve, damper, duct, pipe, sprinkler, pump, and AHU are inferred into a bounded category scope."),elementIds:C.array(C.union([C.number(),C.string()])).optional().describe("Exact element ids to inspect first when known."),uniqueIds:C.array(C.string()).optional().describe("Exact Revit unique ids to inspect first when known."),levelNames:C.array(C.string()).optional().describe("Restrict results to matching element level names, e.g. Level 08."),levelIds:C.array(C.union([C.number(),C.string()])).optional().describe("Restrict results to exact Revit level element ids."),activeViewOnly:C.boolean().optional().describe("Search only elements visible/owned in the active view when true. Preferred for large models when the user is already looking at the target area."),viewId:C.union([C.number(),C.string()]).optional().describe("Search only elements visible/owned in this view id."),familyName:C.string().optional().describe("Optional family-name filter applied before text scoring."),typeName:C.string().optional().describe("Optional type-name filter applied before text scoring."),systemName:C.string().optional().describe("Optional MEP system-name filter applied before text scoring when available."),worksetNames:C.array(C.string()).optional().describe("Optional workset-name filters for workshared production models."),worksetIds:C.array(C.union([C.number(),C.string()])).optional().describe("Optional exact workset ids for workshared production models."),linkScope:C.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Host model is searched by default. Linked model search is explicit and may require allowExpensiveSearch/searchBudget=deep on broad requests."),modelSignals:C.object({linkCount:C.number().int().nonnegative().optional(),linkInstances:C.number().int().nonnegative().optional(),loadedLinks:C.number().int().nonnegative().optional(),worksetCount:C.number().int().nonnegative().optional(),sheetCount:C.number().int().nonnegative().optional(),scheduleCount:C.number().int().nonnegative().optional()}).optional().describe("Optional cheap large-model signals from prior context. This never triggers new category counts; it only lets the risk policy use already-known link/workset/sheet/schedule counts."),searchBudget:C.enum(["fast","balanced","deep"]).optional().describe("Preset scan/elapsed budget. fast is default for first-pass discovery; balanced/deep intentionally allow larger scans."),allowExpensiveSearch:C.boolean().optional().describe("Explicit operator approval for broad, linked, all-model, or verified searches that may take longer."),maxElementsScanned:C.number().int().positive().max(5e5).optional().describe("Advanced override for the Revit-side scan cap. Prefer searchBudget for ordinary LLM use."),maxElapsedMs:C.number().int().positive().max(119e3).optional().describe("Advanced override for the Revit-side elapsed budget. This is clamped below socket timeout so partial results can return before transport timeout."),includePlanCandidates:C.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),planCandidateMode:C.enum(["none","metadata","verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms visibility in plan views and is allowed only for exact element targets or explicit expensive-search approval."),maxPlanCandidates:C.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),planNameContains:C.string().optional().describe("Optional plan name preference used when ranking plan candidates."),limit:C.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),responseMode:Ze,maxResultRows:C.number().int().positive().max(200).optional().describe("Compact-mode cap for returned element rows. Defaults to limit or 25; full/debug returns all native rows within limit."),maxPlanCandidateSummaryRows:C.number().int().positive().max(100).optional().describe("Compact-mode cap for the deduplicated top-level planCandidateSummary rows. Defaults 25 so global plan candidates are not capped by the per-element maxPlanCandidates limit."),timeoutMs:C.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{try{let n=Ri(t);if(n.guarded)return h(Mi(Ii(n)));let r=await _("find_elements",{originalQuery:n.originalQuery,query:n.effectiveQuery,categoryNames:n.effectiveCategoryNames,inferredScope:n.inferredScope,elementIds:t.elementIds,uniqueIds:t.uniqueIds,levelNames:t.levelNames,levelIds:t.levelIds,activeViewOnly:t.activeViewOnly===!0,viewId:t.viewId,familyName:t.familyName,typeName:t.typeName,systemName:t.systemName,worksetNames:t.worksetNames,worksetIds:t.worksetIds,linkScope:n.linkScope,searchBudget:n.searchBudget,allowExpensiveSearch:n.allowExpensiveSearch,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,includePlanCandidates:t.includePlanCandidates===!0,planCandidateMode:t.planCandidateMode||(t.includePlanCandidates===!0?"verified":"none"),maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.limit,timeoutMs:n.timeoutMs},{...I({...t,timeoutMs:n.timeoutMs},"Find Revit elements")}),o=r&&r.result?r.result:r;return o&&typeof o=="object"&&(o.inferredScope=o.inferredScope||n.inferredScope,o.effectiveScope=o.effectiveScope||{categoryNames:n.effectiveCategoryNames,linkScope:n.linkScope},o.riskPolicy=o.riskPolicy||n.riskPolicy,o.scanPolicy=o.scanPolicy||{searchBudget:n.searchBudget,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,timeoutMs:n.timeoutMs,allowExpensiveSearch:n.allowExpensiveSearch},o.suggestedNextScopes=o.suggestedNextScopes||n.suggestedNextScopes,o.warnings=[...new Set([...Array.isArray(o.warnings)?o.warnings:[],...n.warnings])]),h(cc(Mi(o),t))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as oe}from"zod";var uc=oe.union([oe.number().int().positive(),oe.string().regex(/^\d+$/)]);function Gn(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),ViewType:d(e,"ViewType","viewType"),Scale:d(e,"Scale","scale")}}function dc(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),ClassName:d(e,"ClassName","className"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),HasBoundingBox:d(e,"HasBoundingBox","hasBoundingBox")}}function mc(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Action:d(e,"Action","action"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),ResponseMode:"compact",PlanMode:d(e,"PlanMode","planMode"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),FallbackUsed:d(e,"FallbackUsed","fallbackUsed"),VerifiedCandidateCount:d(e,"VerifiedCandidateCount","verifiedCandidateCount"),RejectedCandidateCount:d(e,"RejectedCandidateCount","rejectedCandidateCount"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),FocusBlocked:d(e,"FocusBlocked","focusBlocked"),FocusBlockReason:d(e,"FocusBlockReason","focusBlockReason"),FocusSuggestion:d(e,"FocusSuggestion","focusSuggestion"),TargetView:Gn(d(e,"TargetView","targetView")),SelectedPlan:Gn(d(e,"SelectedPlan","selectedPlan")),SuggestedView:Gn(d(e,"SuggestedView","suggestedView")),ActiveView:Gn(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),Element:dc(d(e,"ElementInfo","elementInfo")),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function Ei(e){e.tool("open_existing_plan_for_element_level","Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.",{...w(oe),...x(oe),elementId:uc.describe("ElementId to locate in an existing plan view."),planMode:oe.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing plan on the element level. activePlan keeps the current active plan and does not switch to the element level. Defaults elementLevel."),planCandidateMode:oe.enum(["metadataFirst","verified"]).optional().describe("Plan selection strategy for elementLevel mode. metadataFirst is the default and ranks same-level plans without scanning every candidate view, then verifies a small number of ranked candidates. verified scans all candidate views before selecting and is slower."),fallbackToVerified:oe.boolean().optional().describe("When metadataFirst cannot find a visible element within the limited ranked-candidate check, run the slower verified scan before failing. Defaults true."),maxMetadataVerifyCandidates:oe.number().int().min(1).max(25).optional().describe("Maximum ranked metadata candidates verified before fallback. Defaults 5."),planNameContains:oe.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:oe.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:oe.boolean().optional().describe("Select the element after activating the plan. Defaults true."),zoom:oe.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),fitToScreen:oe.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),verboseCandidates:oe.boolean().optional().describe("Return full PlanCandidates arrays. Defaults false; routine responses return only the top candidates."),maxPlanCandidates:oe.number().int().min(0).max(50).optional().describe("Maximum PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:oe.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns the raw tool result."),timeoutMs:oe.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000.")},async t=>{try{let n=await _("open_existing_plan_for_element_level",{elementId:t.elementId,planMode:t.planMode,planCandidateMode:t.planCandidateMode,fallbackToVerified:t.fallbackToVerified,maxMetadataVerifyCandidates:t.maxMetadataVerifyCandidates,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs},{...I(t,"Open existing plan for element level")}),r=n&&n.result?n.result:n,o=mt(r,{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"?h(o):h(mc(o))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as le}from"zod";var pc=le.union([le.number().int().positive(),le.string().regex(/^\d+$/)]);function ki(e){e.tool("focus_elements","Select and zoom to Revit elements in the active view or in a requested view tab. This is a UI operation and does not open a Revit transaction.",{...w(le),...x(le),elementIds:le.array(pc).min(1).describe("ElementId values to select and show."),viewId:le.number().int().positive().optional().describe("Optional ElementId of the Revit view to activate before focusing elements."),viewName:le.string().optional().describe("Optional name of the Revit view to activate before focusing elements."),viewType:le.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, Section, Elevation, DrawingSheet, or Schedule."),exactName:le.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),select:le.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:le.boolean().optional().describe("Zoom/show the supplied elements in the active UI view. Defaults true."),fitToScreen:le.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active view. Defaults false."),allowClosedViewSearch:le.boolean().optional().describe("Allow Revit ShowElements to open its modal closed-view search when elements are not visible in the target view. Defaults false to avoid blocking automation."),allowPartial:le.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:le.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation/focus verification. Defaults 5000; pass a larger value for slow view activation.")},async t=>{try{let n=await _("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:t.allowClosedViewSearch,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...I(t,"Focus Revit elements")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as me}from"zod";var hc=me.union([me.number().int().positive(),me.string().regex(/^\d+$/)]);function Pi(e){e.tool("section_box_elements","Apply a 3D section box around Revit elements, optionally select them, and zoom to them. Requires a 3D view; if viewId/viewName is supplied, that view is activated first.",{...w(me),...x(me),elementIds:me.array(hc).min(1).describe("ElementId values to include in the section box."),viewId:me.number().int().positive().optional().describe("Optional ElementId of the 3D Revit view to activate and modify."),viewName:me.string().optional().describe("Optional name of the 3D Revit view to activate and modify."),viewType:me.string().optional().describe("Optional Revit ViewType filter. For this tool the resolved view must be ThreeD."),exactName:me.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),paddingMm:me.number().min(0).max(1e5).optional().describe("Extra space around the element bounding box in millimeters. Defaults 500."),select:me.boolean().optional().describe("Select the supplied elements after applying the section box. Defaults true."),zoom:me.boolean().optional().describe("Zoom/show the supplied elements after applying the section box. Defaults true."),allowPartial:me.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:me.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous 3D view activation and section box application. Defaults 15000.")},async t=>{try{let n=await _("section_box_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,paddingMm:t.paddingMm,select:t.select,zoom:t.zoom,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...I(t,"Section box Revit elements")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as te}from"zod";var fc=te.union([te.number().int().positive(),te.string().regex(/^\d+$/)]);function Ai(e){e.tool("create_3d_view_for_elements","[LIVE_VIEW_NAVIGATION_PRIMITIVE] Create or reuse a 3D Revit view for elements, optionally apply or clear a section box, activate the view, and focus/select the elements. Use this when the user wants to see, open, zoom to, or inspect elements live inside Revit. This can modify the document because views and section boxes are project data.",{...w(te),...x(te),elementIds:te.array(fc).min(1).describe("ElementId values to show in the 3D view."),viewName:te.string().optional().describe("Desired 3D view name. If omitted, a name is generated from the first element id."),reuseExisting:te.boolean().optional().describe("Reuse an existing non-template 3D view with the same name when viewName is supplied. Defaults true."),createIfMissing:te.boolean().optional().describe("Create the 3D view when no reusable view is found. Defaults true."),sectionBox:te.boolean().optional().describe("When true, apply a section box around the elements. When false, any active section box on the target view is cleared. Defaults false."),paddingMm:te.number().min(0).max(1e5).optional().describe("Extra section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:te.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction to apply using the aggregate element bounding box. Defaults unchanged."),framingPaddingMm:te.number().min(0).max(1e5).optional().describe("Extra padding in millimeters for camera orientation/framing when cameraOrientation is not unchanged. Defaults to paddingMm or 500."),activate:te.boolean().optional().describe("Activate the target 3D view. Defaults true."),select:te.boolean().optional().describe("Select the supplied elements after activation. Defaults true."),zoom:te.boolean().optional().describe("Zoom/show the supplied elements after activation. Defaults true."),fitToScreen:te.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active 3D view. Defaults false."),allowPartial:te.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:te.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous view creation/activation/focus. Defaults 20000.")},async t=>{try{let n=await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName,reuseExisting:t.reuseExisting,createIfMissing:t.createIfMissing,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:t.activate,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...I(t,"Create 3D view for elements")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import gc from"node:os";import Oi from"node:path";import{z as B}from"zod";var yc=B.enum(["raw_evidence","coordination_overlay","system_focus","clash_clearance"]),bc=B.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Sc=B.enum(["72","150","300","600"]),wc=B.enum(["horizontal","vertical"]),xc=B.enum(["auto","qa_high_contrast","technical_report","outline_only","raw"]),vc={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Cc={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Tc={horizontal:"Horizontal",vertical:"Vertical"};function Rc(){return Oi.join(gc.tmpdir(),"revAgent-image-export")}function Ic(e){return(e&&e.trim()?e.trim():`revit-coordination-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function _c(e){let t=e||[],n=[],r=[];for(let o of t){if(typeof o=="number"){Number.isSafeInteger(o)&&o>0?n.push(o):r.push(o);continue}let i=String(o).trim();if(/^\d+$/.test(i)){let a=Number(i);if(Number.isSafeInteger(a)&&a>0){n.push(a);continue}}r.push(o)}return{ids:n,invalid:r,suppliedCount:t.length}}function Mc(e){return`new List<int> { ${e.map(n=>Math.trunc(n)).join(", ")} }`}function Nc(e){return e==="raw_evidence"?"raw":e==="coordination_overlay"?"outline_only":"technical_report"}function Vi(e){e.tool("export_revit_coordination_image","[VISUAL_ARTIFACT_EXPORT_ONLY] Create or reuse a visual QA 3D view, optionally section-box target elements, apply a selectable target visual style, and export an image artifact. Auto style is report-friendly and never selects qa_high_contrast by itself. Use qa_high_contrast explicitly for debug/LLM evidence, technical_report or outline_only for report-style evidence, and raw when the target must keep native appearance. Use this when the user asks for PNG/JPEG/report/LLM visual evidence. If elementIds are provided but none are found, it returns guarded no_requested_elements_found unless allowFullViewFallback=true is explicit. Do not use this as the primary tool for live view navigation, selected-element zoom, or opening an element in a Revit view; for that workflow use create_3d_view_for_elements or show_element_in_plan_and_3d, then optionally export the active view with export_revit_view_image. It only writes review view settings; it does not create or modify MEP model elements. Set cleanupAfterExport=true when a newly created review view should be deleted after the image file is produced.",{...w(B),intent:yc.optional().default("coordination_overlay"),targetVisualStyle:xc.optional().default("auto").describe("Target override style. auto is report-friendly: raw_evidence -> raw, coordination_overlay -> outline_only, system_focus/clash_clearance -> technical_report. qa_high_contrast is used only when explicitly requested. raw applies no target override."),elementIds:B.array(B.union([B.number(),B.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),viewName:B.string().optional().default("DPE Visual QA - Coordination Export"),marginMm:B.number().min(0).max(2e4).optional().default(2e3),singleElementMarginMm:B.number().min(0).max(2e4).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),contextTransparency:B.number().int().min(0).max(90).optional().default(65),pixelSize:B.number().int().min(200).max(1e4).optional().default(4e3).describe("Final image size for the requested fit direction after crop/downsample. For coordination crops, Revit may export a higher-resolution source first."),preExportPixelSize:B.number().int().min(0).max(2e4).optional().default(0).describe("Optional Revit source export size before crop/downsample. Use 0 or omit for automatic high-resolution source export on single-target model-projection crops."),maxAutoPreExportPixelSize:B.number().int().min(1e3).max(2e4).optional().default(1e4).describe("Upper bound for automatic high-resolution source exports used before single-target model-projection crops."),allowFinalUpscale:B.boolean().optional().default(!1).describe("When false, model-projection crops are widened instead of enlarging a tiny source crop to the final pixelSize. This preserves image quality even when targetMinFillRatio cannot be reached within Revit's source export limit."),enforcePixelSize:B.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the final requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),cropToTargetHighlight:B.boolean().optional().default(!0).describe("When true, tightens the Revit 3D view crop box from model bbox/camera projection. Raster highlight pixels are QA metrics only unless Revit model crop-box framing is unavailable."),targetMinFillRatio:B.number().min(.1).max(.9).optional().default(.4).describe("Minimum target occupancy used when sizing model-bounding-box projection crops. Raster highlight fill, when detected, is reported separately as QA."),highlightCropPaddingPx:B.number().int().min(0).max(2e3).optional().default(24).describe("Debug fallback padding for highlight-pixel crops when model projection is not available."),allowFullViewFallback:B.boolean().optional().default(!1).describe("When elementIds are provided but none are found, allow exporting the full review 3D view instead of returning guarded. Defaults false to avoid misleading element evidence."),dpi:Sc.optional().default("300"),fitDirection:wc.optional().default("horizontal"),format:bc.optional().default("png"),outputDir:B.string().optional(),filePrefix:B.string().optional(),cleanupAfterExport:B.boolean().optional().default(!1).describe("When true, a review view created by this call is deleted after export. Existing reused review views are never deleted automatically."),...x(B),timeoutMs:B.number().int().positive().optional()},async t=>{let n=_c(t.elementIds);if(n.invalid.length>0)return h(De({action:"export_revit_coordination_image",reason:"invalid_element_ids",error:"elementIds must be positive integer Revit ElementId values. UniqueId strings or other non-numeric ids are not valid target evidence ids.",extra:{revitWriteAction:"none",requestedElementCount:n.suppliedCount,validElementCount:n.ids.length,invalidElementIds:n.invalid}}));let r=Oi.resolve(t.outputDir||Rc()),o=Ic(t.filePrefix),i=t.intent||"coordination_overlay",a=t.targetVisualStyle||"auto",s=a==="auto"?Nc(i):a,l=vc[t.format||"png"],u=Cc[String(t.dpi||"150")],m=Tc[t.fitDirection||"horizontal"],p=Math.trunc(t.pixelSize||4e3),f=Number.isFinite(Number(t.preExportPixelSize))?Math.max(0,Math.trunc(Number(t.preExportPixelSize))):0,y=Number.isFinite(Number(t.maxAutoPreExportPixelSize))?Math.max(1e3,Math.min(2e4,Math.trunc(Number(t.maxAutoPreExportPixelSize)))):1e4,S=t.allowFinalUpscale===!0,N=Number.isFinite(Number(t.marginMm))?Number(t.marginMm):2e3,k=Number.isFinite(Number(t.singleElementMarginMm))?Number(t.singleElementMarginMm):300,F=t.enforcePixelSize!==!1,L=t.cropToTargetHighlight!==!1,O=Number.isFinite(Number(t.targetMinFillRatio))?Math.max(.1,Math.min(.9,Number(t.targetMinFillRatio))):.4,J=Number.isFinite(Number(t.highlightCropPaddingPx))?Math.trunc(t.highlightCropPaddingPx):24,Y=t.allowFullViewFallback===!0,Z=Math.trunc(t.contextTransparency??65),ee=t.cleanupAfterExport===!0,ne=`
var warnings = new List<string>();
var notices = new List<string>();
string outputDir = ${M(r)};
string filePrefix = ${M(o)};
string desiredViewName = ${M(t.viewName||"DPE Visual QA - Coordination Export")};
string intent = ${M(i)};
string targetVisualStyle = ${M(s)};
var requestedElementIds = ${Mc(n.ids)};
double marginFeet = ${N} / 304.8;
double singleElementMarginFeet = ${k} / 304.8;
int contextTransparency = ${Z};
int requestedPixelSize = ${p};
int requestedPreExportPixelSize = ${f};
int maxAutoPreExportPixelSize = ${y};
int revitExportPixelSize = requestedPixelSize;
bool autoPreExportPixelSize = requestedPreExportPixelSize <= 0;
string preExportPixelSizeReason = "same_as_final_pixel_size";
string requestedFitDirection = ${M(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${F?"true":"false"};
bool cropToTargetHighlight = ${L?"true":"false"};
bool allowFinalUpscale = ${S?"true":"false"};
double targetMinFillRatio = ${O};
int highlightCropPaddingPx = ${J};
bool allowFullViewFallback = ${Y?"true":"false"};
bool cleanupAfterExport = ${ee?"true":"false"};

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

double effectiveMarginMm = targetElements.Count == 1 ? Math.Min(${N}, ${k}) : ${N};
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
  format = ${M(t.format||"png")},
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
  marginMm = ${N},
  singleElementMarginMm = ${k},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${M(String(t.dpi||"300"))},
  fitDirection = ${M(t.fitDirection||"horizontal")},
  files = files,
  warnings = warnings,
  notices = notices
};`;try{let $=await K(ne,{...I(t,"Export Revit coordination image"),taskType:"export_revit_coordination_image",transactionMode:"auto"});return h($?.result??$)}catch($){return h(Ce({action:"export_revit_coordination_image",error:$ instanceof Error?$.message:String($),extra:{tool:"export_revit_coordination_image"}}))}})}import Ec from"node:os";import Di from"node:path";import{z as ie}from"zod";var kc=ie.enum(["current_view","visible_region","set_of_views"]),Pc=ie.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Ac=ie.enum(["72","150","300","600"]),Oc=ie.enum(["horizontal","vertical"]),Vc={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Dc={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Fc={horizontal:"Horizontal",vertical:"Vertical"};function Lc(){return Di.join(Ec.tmpdir(),"revAgent-image-export")}function jc(e){return(e&&e.trim()?e.trim():`revit-view-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function Bc(e){if(e==null||e==="")return"null";let t=Number(e);return Number.isFinite(t)?String(Math.trunc(t)):"null"}function Fi(e){e.tool("export_revit_view_image","[VISUAL_ARTIFACT_EXPORT] Export the active Revit view, DrawingSheet, Schedule view, or a selected view/sheet to PNG/JPEG/TIFF/BMP/TARGA using Document.ExportImage. Use this when the user asks for a raw image file, report/evidence screenshot, schedule/sheet export, or LLM visual artifact from an existing view. Ordinary view/sheet exports do not modify Revit. Direct schedule export creates a temporary sheet, exports it, and deletes that sheet before the wrapper transaction commits.",{...w(ie),viewId:ie.union([ie.number(),ie.string()]).optional().describe("Optional Revit view id. When supplied, export uses set_of_views because Revit cannot export a non-active visible region."),viewName:ie.string().optional().describe("Optional exact or partial view name. When supplied, export uses set_of_views unless range is explicitly current/visible."),exactName:ie.boolean().optional().default(!0),range:kc.optional().describe("current_view and visible_region use the active UI view. set_of_views can export viewId/viewName without switching the UI."),format:Pc.optional().default("png"),pixelSize:ie.number().int().min(200).max(1e4).optional().default(6e3),enforcePixelSize:ie.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),zoom:ie.number().int().min(1).max(1e3).optional().default(100),dpi:Ac.optional().default("300"),fitDirection:Oc.optional().default("horizontal"),outputDir:ie.string().optional(),filePrefix:ie.string().optional(),allowTemporaryScheduleSheet:ie.boolean().optional().default(!0).describe("When true, standalone Schedule views are exported through a temporary sheet that is deleted before the wrapper transaction commits. When false, schedule views return guidance with containing sheet candidates."),...x(ie),timeoutMs:ie.number().int().positive().optional()},async t=>{let n=t.viewId!==void 0||!!t.viewName,r=t.range??(n?"set_of_views":"current_view"),o=Di.resolve(t.outputDir||Lc()),i=jc(t.filePrefix),a=Vc[t.format||"png"],s=Dc[String(t.dpi||"150")],l=Fc[t.fitDirection||"horizontal"],u=Math.trunc(t.pixelSize||6e3),m=t.enforcePixelSize!==!1,p=Math.trunc(t.zoom||100),f=t.allowTemporaryScheduleSheet!==!1,y=`
var warnings = new List<string>();
var notices = new List<string>();
string requestedRange = ${M(r)};
string outputDir = ${M(o)};
string filePrefix = ${M(i)};
string viewNameInput = ${M(t.viewName||"")};
int? viewIdInput = ${Bc(t.viewId)};
bool exactName = ${t.exactName===!1?"false":"true"};
bool selectorProvided = viewIdInput.HasValue || !String.IsNullOrWhiteSpace(viewNameInput);
int requestedPixelSize = ${u};
string requestedFitDirection = ${M(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${m?"true":"false"};
bool allowTemporaryScheduleSheet = ${f?"true":"false"};

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
options.HLRandWFViewsFileType = ImageFileType.${a};
options.ShadowViewsFileType = ImageFileType.${a};
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
  format = ${M(t.format||"png")},
  pixelSize = ${u},
  requestedPixelSize = ${u},
  enforcePixelSize = enforcePixelSize,
  pixelSizeNote = enforcePixelSize
    ? "PNG/JPEG/BMP/TIFF output is post-processed so the requested fit-direction dimension equals requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the Revit export request. Check files[].width and files[].height for actual output dimensions.",
  dpi = ${M(String(t.dpi||"300"))},
  fitDirection = ${M(t.fitDirection||"horizontal")},
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
};`;try{let S=await K(y,{...I(t,"Export Revit view image"),taskType:"export_revit_view_image",transactionMode:f?"auto":"none"});return h(S?.result??S)}catch(S){return h(Ce({action:"export_revit_view_image",error:S instanceof Error?S.message:String(S),extra:{tool:"export_revit_view_image"}}))}})}import{z}from"zod";var zc=z.union([z.number().int().positive(),z.string().regex(/^\d+$/)]);function zr(e){return e&&e.result?e.result:e}function qr(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function qc(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Wc(e,t){return`3D - Focus ${t&&(t.FamilyName||t.TypeName||t.Name)?String(t.FamilyName||t.TypeName||t.Name):"Element"} ${e}`.replace(/[{}[\];<>?`~]/g,"").slice(0,90)}function Gc(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),MatchScore:d(e,"MatchScore","matchScore"),MatchConfidence:d(e,"MatchConfidence","matchConfidence")}}function on(e){return!e||typeof e!="object"?e:{Id:e.Id??e.id,Name:e.Name??e.name,ViewType:e.ViewType??e.viewType,Scale:e.Scale??e.scale}}function Jc(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Count:d(e,"Count","count"),Truncated:d(e,"Truncated","truncated"),Ambiguous:d(e,"Ambiguous","ambiguous"),TopScore:d(e,"TopScore","topScore"),TopConfidence:d(e,"TopConfidence","topConfidence"),TopScoreTiedCount:d(e,"TopScoreTiedCount","topScoreTiedCount"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),SelectionHint:d(e,"SelectionHint","selectionHint")}}function Hc(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),PlanMode:d(e,"PlanMode","planMode"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),SelectedPlan:on(d(e,"SelectedPlan","selectedPlan")),TargetView:on(d(e,"TargetView","targetView")),ActiveView:on(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function Uc(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),TargetView:on(d(e,"TargetView","targetView")),ActiveView:on(d(e,"ActiveView","activeView")),CreatedView:d(e,"CreatedView","createdView"),ReusedView:d(e,"ReusedView","reusedView"),SectionBoxApplied:d(e,"SectionBoxApplied","sectionBoxApplied"),SectionBoxState:d(e,"SectionBoxState","sectionBoxState"),CameraOrientation:d(e,"CameraOrientation","cameraOrientation"),CameraApplied:d(e,"CameraApplied","cameraApplied"),CameraWarning:d(e,"CameraWarning","cameraWarning"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed")}}function $c(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function We(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"show_element_in_plan_and_3d",message:e.message,error:e.error,resultContractVersion:$c(e.find,e.plan,e.threeD),chosenElementId:e.chosenElementId,chosenElement:e.chosenElement,find:e.find,plan:e.plan,threeD:e.threeD,ambiguous:e.ambiguous,candidates:e.candidates}}function Li(e){e.tool("show_element_in_plan_and_3d","[LIVE_VIEW_WORKFLOW_WRAPPER] Safely find or use one Revit element, show it in an existing plan, then optionally call create_3d_view_for_elements to create/reuse a focused 3D view. Use this when the user wants a combined plan plus 3D live Revit view workflow. Ambiguous search results are rejected by default for large-project safety.",{...w(z),...x(z),elementId:zc.optional().describe("Known ElementId. When supplied, search is skipped."),query:z.string().optional().describe("Text query used when elementId is not supplied."),categoryNames:z.array(z.string()).optional().describe("Category name filters for the search, e.g. Mechanical Equipment."),searchLimit:z.number().int().positive().max(200).optional().describe("Maximum search candidates to inspect. Defaults 20."),allowAmbiguous:z.boolean().optional().describe("Allow the top search result to be used even when multiple plausible matches exist. Defaults false."),planMode:z.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing same-level plan. activePlan keeps the current active plan. Defaults elementLevel."),planNameContains:z.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:z.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),includeSearchPlanCandidates:z.boolean().optional().describe("Include plan candidates during the initial search. Defaults false; the plan-open step computes focused candidates separately."),verboseCandidates:z.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:z.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:z.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),select:z.boolean().optional().describe("Select the element in plan/3D. Defaults true."),zoom:z.boolean().optional().describe("Show/zoom the element in plan/3D. Defaults true."),fitToScreen:z.boolean().optional().describe("Run Revit UI ZoomToFit after focusing views. Defaults false."),create3d:z.boolean().optional().describe("Create or reuse a focused 3D view after the plan step. Defaults true."),viewName:z.string().optional().describe("Desired 3D view name. If omitted, one is generated from the selected element."),reuseExisting3d:z.boolean().optional().describe("Reuse an existing 3D view with the same name. Defaults true."),sectionBox:z.boolean().optional().describe("Apply a 3D section box around the element. Defaults false."),paddingMm:z.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:z.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction. Defaults unchanged."),framingPaddingMm:z.number().min(0).max(1e5).optional().describe("Padding in millimeters for camera orientation/framing. Defaults to paddingMm or 500."),timeoutMs:z.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=I(t,"Show element in plan and 3D"),r=t.elementId,o=null,i=null;if(!r){if(!t.query&&(!t.categoryNames||t.categoryNames.length===0))return h(We({success:!1,guarded:!0,error:"Pass elementId, or pass query/categoryNames for a safe search."}));if(i=zr(await _("find_elements",{query:t.query,categoryNames:t.categoryNames,includePlanCandidates:t.includeSearchPlanCandidates===!0,maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.searchLimit||20,timeoutMs:t.timeoutMs,taskName:"Find element for plan and 3D presentation"},n)),!i||!qr(i))return h(We({success:!1,error:d(i,"Error","error")||"Element search failed.",find:i}));let m=Array.isArray(d(i,"Elements","elements"))?d(i,"Elements","elements"):[];if(m.length===0)return h(We({success:!1,guarded:!0,error:"No matching elements were found.",find:i}));if(d(i,"Ambiguous","ambiguous")&&t.allowAmbiguous!==!0)return h(We({success:!1,guarded:!0,error:"Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",ambiguous:!0,find:i,candidates:m}));if(o=m[0]||null,!o)return h(We({success:!1,guarded:!0,error:"No usable element candidate was returned.",find:i}));r=d(o,"Id","id")}if(r==null)return h(We({success:!1,guarded:!0,error:"No element id was resolved.",find:i}));let a=zr(await _("open_existing_plan_for_element_level",{elementId:r,planMode:t.planMode,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3,responseMode:"full",timeoutMs:t.timeoutMs,taskName:"Show element in existing plan"},n));if(!a||!qr(a))return h(We({success:!1,guarded:qc(a),error:d(a,"Error","error")||"Plan presentation failed.",chosenElementId:r,chosenElement:o,find:i,plan:a}));let s=null;t.create3d!==!1&&(s=zr(await _("create_3d_view_for_elements",{elementIds:[r],viewName:t.viewName||Wc(r,o),reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Show element in focused 3D view"},n)));let l=t.create3d===!1||qr(s),u=mt(We({success:l,message:t.create3d===!1?"Element was shown in an existing plan.":l?"Element was shown in an existing plan and focused in 3D.":"Element was shown in plan, but the 3D step failed.",chosenElementId:r,chosenElement:o,find:i,plan:a,threeD:s}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"||!l?h(u):h({success:d(u,"Success","success"),guarded:d(u,"Guarded","guarded")===!0,state:d(u,"State","state"),action:d(u,"Action","action"),message:d(u,"Message","message"),error:d(u,"Error","error"),resultContractVersion:d(u,"ResultContractVersion","resultContractVersion"),responseMode:"compact",chosenElementId:r,chosenElement:Gc(o),findSummary:Jc(i),planSummary:Hc(a),threeDSummary:Uc(s)})}catch(n){return h(We({success:!1,error:n instanceof Error?n.message:String(n)}))}})}import{z as q}from"zod";var Xc=q.union([q.number().int().positive(),q.string().regex(/^\d+$/)]);function Jn(e){return e&&e.result?e.result:e}function Hn(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function ji(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Un(e){return!e||typeof e!="object"?e||null:{id:e.Id??e.id,name:e.Name??e.name,viewType:e.ViewType??e.viewType,isActive:e.IsActive??e.isActive,isOpen:e.IsOpen??e.isOpen,isSectionBoxActive:e.IsSectionBoxActive??e.isSectionBoxActive}}function Wr(e){if(!e||typeof e!="object")return e||null;let t=e.PlanCandidates??e.planCandidates;return{success:d(e,"Success","success"),message:d(e,"Message","message"),error:d(e,"Error","error"),focusBlocked:e.FocusBlocked??e.focusBlocked,focusBlockReason:e.FocusBlockReason??e.focusBlockReason,focusSuggestion:e.FocusSuggestion??e.focusSuggestion,changed:e.Changed??e.changed,selected:e.Selected??e.selected,zoomed:e.Zoomed??e.zoomed,activeViewChanged:e.ActiveViewChanged??e.activeViewChanged,planOpenMode:e.PlanOpenMode??e.planOpenMode,levelName:e.LevelName??e.levelName,activeView:Un(e.ActiveView??e.activeView),targetView:Un(e.TargetView??e.targetView),selectedPlan:Un(e.SelectedPlan??e.selectedPlan),suggestedView:Un(e.SuggestedView??e.suggestedView),planCandidatesTotal:Array.isArray(t)?t.length:e.PlanCandidatesTotal??e.planCandidatesTotal,planCandidatesTruncated:e.PlanCandidatesTruncated??e.planCandidatesTruncated,createdView:e.CreatedView??e.createdView,reusedView:e.ReusedView??e.reusedView,sectionBoxApplied:e.SectionBoxApplied??e.sectionBoxApplied,cameraOrientation:e.CameraOrientation??e.cameraOrientation,cameraApplied:e.CameraApplied??e.cameraApplied}}function Bi(e){return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded")===!0,state:d(e,"State","state"),action:d(e,"Action","action"),message:d(e,"Message","message"),error:d(e,"Error","error"),resultContractVersion:d(e,"ResultContractVersion","resultContractVersion"),responseMode:"compact",mode:e.mode??e.Mode,usedStep:e.usedStep??e.UsedStep,focusSummary:Wr(e.focus??e.Focus),planSummary:Wr(e.plan??e.Plan),threeDSummary:Wr(e.threeD??e.ThreeD)}}function Qc(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function an(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"smart_focus_elements",message:e.message,error:e.error,resultContractVersion:Qc(e.focus,e.plan,e.threeD),mode:e.mode,usedStep:e.usedStep,focus:e.focus,plan:e.plan,threeD:e.threeD}}function zi(e){e.tool("smart_focus_elements","[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. When create3d=true, the 3D step runs after whichever live focus step succeeds. Use this for live Revit focus/navigation, not image artifact export.",{...w(q),...x(q),elementIds:q.array(Xc).min(1).describe("ElementId values to select and show."),mode:q.enum(["activeOnly","activeThenElementLevelPlan","elementLevelPlan"]).optional().describe("activeOnly only tries the active/requested view. activeThenElementLevelPlan falls back to an existing same-level plan. elementLevelPlan skips the active view and opens the same-level plan. Defaults activeThenElementLevelPlan."),viewId:q.number().int().positive().optional().describe("Optional target view id for the first focus attempt."),viewName:q.string().optional().describe("Optional target view name for the first focus attempt."),viewType:q.string().optional().describe("Optional Revit ViewType filter for the first focus attempt."),exactName:q.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),planNameContains:q.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level for same-level fallback."),preferMechanical:q.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:q.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:q.boolean().optional().describe("Zoom/show the supplied elements. Defaults true."),fitToScreen:q.boolean().optional().describe("Run Revit UI ZoomToFit after focus. Defaults false."),create3d:q.boolean().optional().describe("After the successful active/requested-view or plan focus step, create/reuse a focused 3D view for all supplied elements. Defaults false."),viewName3d:q.string().optional().describe("Desired 3D view name when create3d=true."),reuseExisting3d:q.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),sectionBox:q.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),cameraOrientation:q.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),framingPaddingMm:q.number().min(0).max(1e5).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),paddingMm:q.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),allowPartial:q.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),verboseCandidates:q.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:q.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:q.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),timeoutMs:q.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=I(t,"Smart focus Revit elements"),r=t.mode||"activeThenElementLevelPlan",o=null,i=null,a=null;if(r!=="elementLevelPlan"){if(o=Jn(await _("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:!1,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Try focus elements in active/requested view"},n)),o&&Hn(o)){t.create3d===!0&&(a=Jn(await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view after active/requested focus"},n)));let m=t.create3d===!0?!!(a&&Hn(a)):!0,p=mt(an({success:m,message:t.create3d===!0?m?"Elements were focused in the active/requested view and focused in 3D.":"Elements were focused in the active/requested view, but the 3D step failed.":"Elements were focused in the active/requested view.",mode:r,usedStep:t.create3d===!0?"activeOrRequestedViewThen3D":"activeOrRequestedView",focus:o,threeD:a}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return h(t.responseMode==="full"||!m?p:Bi(p))}let u=ji(o);if(r==="activeOnly"||!o||!u)return h(an({success:!1,guarded:u,mode:r,error:d(o,"Error","error")||"Active/requested view focus failed.",focus:o}))}if(i=Jn(await _("open_existing_plan_for_element_level",{elementId:t.elementIds[0],planMode:"elementLevel",planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Smart focus fallback to same-level existing plan"},n)),!i||!Hn(i))return h(an({success:!1,guarded:ji(i),mode:r,error:d(i,"Error","error")||"Same-level existing plan focus failed.",focus:o,plan:i}));t.create3d===!0&&(a=Jn(await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view"},n)));let s=t.create3d===!0?!!(a&&Hn(a)):!0,l=mt(an({success:s,message:t.create3d===!0?s?"Elements were focused in a same-level plan and focused in 3D.":"Elements were focused in a same-level plan, but the 3D step failed.":"Elements were focused in a same-level plan.",mode:r,usedStep:t.create3d===!0?"elementLevelPlanThen3D":"elementLevelPlan",focus:o,plan:i,threeD:a}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return h(t.responseMode==="full"||!s?l:Bi(l))}catch(n){return h(an({success:!1,mode:t.mode||"unknown",error:n instanceof Error?n.message:String(n)}))}})}import{z as Se}from"zod";async function Yc(e,t){let r=(Array.isArray(e.elementIds)?e.elementIds:[]).map(o=>Number.parseInt(String(o),10)).filter(o=>Number.isFinite(o)&&o>0);return e.useSelection&&(r=r.concat(await _t(e.limit||20,t))),[...new Set(r)].slice(0,e.limit||20)}function Kc(e,t){let n=zn(e),r=t.includeParameters!==!1?"true":"false",o=t.includeTypeParameters===!0?"true":"false",i=t.includeConnectors!==!1?"true":"false",a=Ee(t.parameterNames||[]);return`
int[] elementIds = ${n};
bool includeParameters = ${r};
bool includeTypeParameters = ${o};
bool includeConnectors = ${i};
string[] requestedParameterNames = ${a};

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
}`}function qi(e){e.tool("inspect_elements","Read-only inspection for selected or targeted Revit elements: class/category/type/level/key parameters/connector summary.",{...w(Se),...x(Se),elementIds:Se.array(Se.union([Se.number(),Se.string()])).optional().describe("Element ids to inspect."),useSelection:Se.boolean().optional().describe("When true, inspect the current Revit selection."),limit:Se.number().int().positive().max(100).optional().describe("Maximum elements to inspect. Defaults 20."),includeParameters:Se.boolean().optional().describe("Include key or requested parameter summaries. Defaults true."),includeTypeParameters:Se.boolean().optional().describe("Also inspect matching type parameters. Defaults false."),includeConnectors:Se.boolean().optional().describe("Include connector counts when available. Defaults true. When false, connectorCount/openConnectorCount are null and connectorsIncluded=false."),parameterNames:Se.array(Se.string()).optional().describe("Optional targeted parameter names.")},async t=>{let n=se(t);try{let r=await Yc(t,n);if(r.length===0)return h({success:!0,elements:[],warnings:["No element ids supplied and no selected elements found."]});let o=await K(Kc(r,t),{...n,...ge(t,"Inspect Revit elements"),transactionMode:"none"});return h(o&&o.result?o.result:o)}catch(r){return h({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as V}from"zod";var Zc=["completed","max_elapsed","max_rows","max_columns","max_cells","max_items","max_bytes","read_failed","needs_scope"],eu=["lastReadSection","lastReadRow","lastReadColumn","lastReadSheetId","lastReadViewId","lastReadViewportId","lastReadItemId"],tu=new Set(Zc),nu={done:"completed",success:"completed",timeout:"max_elapsed",timed_out:"max_elapsed",socket_timeout:"max_elapsed",max_schedules:"max_items",max_sheets:"max_items",max_text_notes:"max_items",max_tags:"max_items",max_viewports:"max_items",max_scanned:"max_items",max_schedule_instances:"max_items",max_schedule_cells:"max_cells",max_cells_scanned:"max_cells",rows_truncated:"max_rows",columns_truncated:"max_columns"};function sn(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function kt(e){return String(e??"").trim()}function Et(e){return Array.isArray(e)?e.map(t=>kt(t)).filter(t=>t.length>0):[]}function c(e,t){if(!sn(e))return;let n=t.charAt(0).toUpperCase()+t.slice(1);if(Object.prototype.hasOwnProperty.call(e,t))return e[t];if(Object.prototype.hasOwnProperty.call(e,n))return e[n];let r=t.toLowerCase(),o=Object.keys(e).find(i=>i.toLowerCase()===r);return o?e[o]:void 0}function T(e,t){let n=c(e,t);return Array.isArray(n)?n.filter(r=>sn(r)):[]}function Pt(e,t){let n=c(e,t);return sn(n)?n:null}function Wi(e,t=!1){if(typeof e=="boolean")return e;if(typeof e=="string"){let n=e.trim().toLowerCase();if(n==="true")return!0;if(n==="false")return!1}return t}function Gi(e){if(e==null)return null;if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function ln(e,t="completed"){let n=kt(e).toLowerCase();return n?tu.has(n)?n:nu[n]||t:t}function ru(e,t,n,r){return n?"needs_scope":r==="failed"?"read_failed":t?"max_items":"completed"}function Gr(e,t,n){return typeof e=="function"?e(t):e??n}function pe(e,t){let n=sn(e)?{...e}:{value:e},r=kt(c(n,"state")),o=kt(c(n,"error")),i=Wi(c(n,"guarded"),!1),a=c(n,"success"),s=typeof a=="boolean"?!!a:o.length===0,l=r||(i?"guarded":s?"completed":"failed"),u=t.partial??Wi(c(n,"partial"),!1),m=kt(t.scanStoppedReason??c(n,"scanStoppedReason")),p=ru(n,u,i,l),f=ln(m,p);n.success=s,n.guarded=i,n.state=l,n.action=t.action,n.partial=u,n.scanStoppedReason=f,m&&m!==f&&n.rawScanStoppedReason===void 0&&(n.rawScanStoppedReason=m);let y=Pt(n,"scanPolicy");n.scanPolicy=y||t.scanPolicy||{};let S=Et(c(n,"suggestedNextScopes"));n.suggestedNextScopes=S.length>0?S:Et(t.suggestedNextScopes),n.elapsedMs=Gi(c(n,"elapsedMs"))??Gi(t.elapsedMs),n.warnings=Et(c(n,"warnings")).concat(Et(t.warnings)),n.notices=Et(c(n,"notices")).concat(Et(t.notices));let N=Gr(t.evidenceRows,n,[]),k=T(n,"evidenceRows");n.evidenceRows=k.length>0?k:Array.isArray(N)?N:[];let F=Gr(t.summary,n,{}),L=Pt(n,"summary");n.summary=L||(sn(F)?F:{});let O=Gr(t.lastRead,n,{});for(let J of eu){let Y=c(n,J);n[J]=Y!==void 0?Y:O[J]??null}return n}function we(e){let t=kt(e.reason)||"needs_scope";return pe({...e.extra||{},success:!0,guarded:!0,state:"guarded",action:e.action,reason:t,message:e.message,partial:!1,scanStoppedReason:t},{...e,partial:!1,scanStoppedReason:t,summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}function Re(e){return pe({...e.extra||{},success:!1,guarded:!1,state:"failed",action:e.action,error:e.error,partial:!1,scanStoppedReason:"read_failed"},{...e,partial:!1,scanStoppedReason:"read_failed",summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}var ou={fast:{maxElapsedMs:4500,timeoutMs:12e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4},deep:{maxElapsedMs:45e3,timeoutMs:6e4}};function iu(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=ou[t],r=Number.parseInt(String(e.maxElapsedMs??""),10),o=Number.isFinite(r)?Math.max(1,Math.min(119e3,r)):n.maxElapsedMs,i=Number.parseInt(String(e.timeoutMs??""),10),a=Number.isFinite(i)?Math.max(1e3,Math.min(12e4,i)):Math.max(n.timeoutMs,Math.min(12e4,o+5e3));return{searchBudget:t,maxElapsedMs:Math.min(o,Math.max(1,a-1e3)),timeoutMs:a}}function au(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||e.query||"").trim())}function su(e,t){return we({action:"inspect_sheet_text",reason:"needs_scope",message:"Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"],scanPolicy:{searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,allowExpensiveSearch:!1,textQuery:!!String(e.textQuery||"").trim(),includeViewportTextNotes:e.includeViewportTextNotes===!0,includeViewportTags:e.includeViewportTags===!0,scanScheduleCells:e.scanScheduleCells===!0,maxTags:e.maxTags??e.maxTagsScanned,maxViewports:e.maxViewports??e.maxViewportsPerSheet},summary:{sheetQuery:e.sheetQuery??e.query??null,textQuery:e.textQuery??null,returnedCount:0,matchCount:0}})}function lu(e,t){return{query:e.query,sheetQuery:e.sheetQuery??e.query,textQuery:e.textQuery,sheetIds:e.sheetIds,includeTextNotes:e.includeTextNotes,includeScheduleInstances:e.includeScheduleInstances,scanScheduleCells:e.scanScheduleCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,includeViewportTextNotes:e.includeViewportTextNotes,includeViewportTags:e.includeViewportTags,viewNameQuery:e.viewNameQuery,maxSheets:e.maxSheets,maxTextNotesPerSheet:e.maxTextNotesPerSheet,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxTextChars:e.maxTextChars,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxViewportTextNotesPerView:e.maxViewportTextNotesPerView,maxViewportTagsPerView:e.maxViewportTagsPerView,maxTags:e.maxTags,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit sheet annotations",taskId:e.taskId}}function Jr(e){let t=String(c(e,"kind")||c(e,"sourceType")||"");return t==="scheduleCell"?"placedScheduleCell":t==="scheduleInstance"?"placedScheduleInstance":t||"sheetTextNote"}function At(e){return String(c(e,"textQuery")??"").trim().length>0}function Hr(e,t=!0){if(!t)return!1;let n=c(e,"matchedTextQuery"),r=c(e,"inventoryOnly");return!(r===!0||String(r).trim().toLowerCase()==="true"||n===!1||String(n).trim().toLowerCase()==="false")}function $n(e){let t=T(e,"evidenceRows"),n=t.length>0?t:T(e,"matches"),r=At(e);return n.filter(o=>!!o&&typeof o=="object"&&!Array.isArray(o)).filter(o=>Hr(o,r)).map(o=>({...o,sourceType:Jr(o)}))}function Ji(e){let t=T(e,"inventoryRows"),n=T(e,"evidenceRows"),r=At(e),o=[...n,...T(e,"matches")].filter(a=>!!a&&typeof a=="object"&&!Array.isArray(a)).filter(a=>!Hr(a,r)),i=new Set;return[...t,...o].filter(a=>!!a&&typeof a=="object"&&!Array.isArray(a)).map(a=>({...a,sourceType:Jr(a),matchedTextQuery:!1,inventoryOnly:!0})).filter(a=>{let s=[c(a,"sourceType")??"",c(a,"sheetId")??"",c(a,"instanceId")??c(a,"elementId")??c(a,"id")??"",c(a,"scheduleId")??""].join("|");return i.has(s)?!1:(i.add(s),!0)})}function Ur(e,t){let n={};for(let[r,o]of Object.entries(e))t.has(r)||(n[r]=o);return n}function cu(e,t){let n=t&&Hr(e,t);return{...Ur(e,new Set(["MatchedTextQuery","InventoryOnly","matchedTextQuery","inventoryOnly"])),sourceType:Jr({...e,kind:c(e,"kind")??"scheduleInstance"}),MatchedTextQuery:n,InventoryOnly:!n,matchedTextQuery:n,inventoryOnly:!n}}function uu(e){let t=At(e);return T(e,"sheets").map(n=>{let r=Ur(n,new Set(["ScheduleInstances"])),o=T(n,"scheduleInstances");return{...r,scheduleInstances:o.map(i=>cu(i,t))}})}function du(e){let t=c(e,"scan");return!t||typeof t!="object"||Array.isArray(t)||At(e)?t:{...t,TotalTextNoteMatches:0,totalTextNoteMatches:0,TotalViewportTextNoteMatches:0,totalViewportTextNoteMatches:0,TotalViewportTagMatches:0,totalViewportTagMatches:0,TotalScheduleCellMatches:0,totalScheduleCellMatches:0,TotalScheduleInstanceMatches:0,totalScheduleInstanceMatches:0}}function Hi(e){let t=ln(c(e,"scanStoppedReason")),n=String(c(e,"rawScanStoppedReason")??c(e,"scanStoppedReason")??t).trim()||t;return{canonicalReason:t,nativeReason:n,nativeLimitField:{max_sheets:"maxSheets",max_text_notes:"maxTextNotesScanned",max_viewports:"maxViewports",max_scanned:"maxScheduleInstancesScanned",max_schedule_instances:"maxScheduleInstancesScanned",max_schedule_cells:"maxScheduleCellsScanned",max_tags:"maxTagsScanned"}[n]??null}}function mu(e){let t=$n(e),n=Ji(e),r=T(e,"sheets");return{sheetQuery:c(e,"sheetQuery")??null,textQuery:c(e,"textQuery")??null,totalSheets:c(e,"totalSheets")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!At(e),matchCount:t.length,inventoryRowCount:n.length,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed",rawScanStoppedReason:c(e,"rawScanStoppedReason")??null,scanStopDetail:Hi(e),scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null}}function pu(e){let t=T(e,"evidenceRows").length>0?T(e,"evidenceRows"):$n(e),n=t.length>0?t[t.length-1]:null,r=T(e,"sheets"),o=r.length>0?r[r.length-1]:null;return{lastReadSection:n?c(n,"section")??null:null,lastReadRow:n?c(n,"row")??null:null,lastReadColumn:n?c(n,"column")??null:null,lastReadSheetId:n?c(n,"sheetId")??c(o,"id")??null:c(o,"id")??null,lastReadViewId:n?c(n,"viewId")??null:null,lastReadViewportId:n?c(n,"viewportId")??null:null,lastReadItemId:n?c(n,"elementId")??c(n,"tagId")??c(n,"instanceId")??c(n,"id")??null:null}}function hu(e,t){let n=pe(e,{action:"inspect_sheet_text",elapsedMs:t,summary:mu,evidenceRows:$n,lastRead:pu,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}),r=Ji(n),o=At(n),i=du(n),a=new Set(["Sheets"]);return o||(a.add("Matches"),a.add("EvidenceRows")),{...Ur(n,a),evidenceRows:o?$n(n):[],inventoryRows:r,matches:o?T(n,"matches"):[],scan:i,sheets:uu(n),summary:{...n.summary||{},inventoryRowCount:r.length,scanStopDetail:Hi(n)}}}function Ui(e){e.tool("inspect_sheet_text","[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet text and annotation inspection for DrawingSheet text notes, titleblock/title block notes, revision schedule instances, placed schedule cells, viewport-linked text notes, viewport plan annotations, and viewport tags. Prefer this dedicated tool over generic send_code_to_revit for sheet text lookup, drawing note searches, plan note searches, titleblock/revision evidence, placed schedule text evidence, and large-project sheet or viewport annotation searches. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true. When a user asks where a schedule value appears on sheets, search placed schedule cells here before writing custom C# sheet loops; use set_schedule_cells or set_schedule_cells_by_text for accepted follow-up writes.",{...w(V),...x(V),query:V.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),sheetQuery:V.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text or viewport annotation search."),textQuery:V.string().optional().describe("Optional text to search in sheet text notes, viewport text notes, or placed schedule cells."),sheetIds:V.array(V.union([V.number(),V.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),includeTextNotes:V.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),includeScheduleInstances:V.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),scanScheduleCells:V.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),allowExpensiveSearch:V.boolean().optional().describe("Explicit approval for project-wide sheet, viewport, tag, or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),searchBudget:V.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:V.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),includeViewportTextNotes:V.boolean().optional().describe("Include bounded TextNote results from views placed on matching sheets. Defaults false."),includeViewportTags:V.boolean().optional().describe("Include bounded IndependentTag evidence from views placed on matching sheets. Defaults false."),viewNameQuery:V.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),maxSheets:V.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),maxTextNotesPerSheet:V.number().int().min(0).max(1e3).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),maxScheduleInstancesPerSheet:V.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),maxRowsPerSchedule:V.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),maxColumnsPerSchedule:V.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),maxTextChars:V.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned text value. Defaults 240."),maxViewportsPerSheet:V.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:V.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet. Maximum placed viewports inspected per sheet."),maxViewportTextNotesPerView:V.number().int().min(0).max(1e3).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),maxViewportTagsPerView:V.number().int().min(0).max(500).optional().describe("Maximum matching viewport tags returned per placed view. Defaults 100."),maxTextNotesScanned:V.number().int().positive().max(2e5).optional().describe("Global native cap across sheet and viewport text notes."),maxTags:V.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:V.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxScheduleInstancesScanned:V.number().int().positive().max(1e5).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:V.number().int().positive().max(5e5).optional().describe("Global native cap across placed schedule body cells."),maxResponseBytes:V.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:V.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=iu(t),o=au(t),i=!!String(t.textQuery||"").trim()&&!o,a=t.includeViewportTextNotes===!0&&!o,s=t.scanScheduleCells===!0&&!o,l=t.includeViewportTags===!0&&!o;if((i||a||s||l)&&t.allowExpensiveSearch!==!0)return h(su(t,r));let u=await _("inspect_sheet_text",lu(t,r),{...I({...t,timeoutMs:r.timeoutMs},"Inspect Revit sheet annotations"),toolName:"inspect_sheet_text"});return h(hu(u&&u.result?u.result:u,Date.now()-n))}catch(r){return h(Re({action:"inspect_sheet_text",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}))}})}import{z as G}from"zod";var fu=25,gu=50;function ce(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function $i(e){let t=Array.isArray(e)&&e.length>0?e:["header","body"];return[...new Set(t.map(n=>String(n||"").toLowerCase()))].filter(n=>["header","body","footer"].includes(n))}var yu={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxCells:5e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxCells:25e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxCells:1e5}};function Xi(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=yu[t],r=ce(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=ce(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxCells:ce(e.maxCells,n.maxCells,1,5e5)}}function bu(e){return(Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t),10)).filter(t=>Number.isFinite(t)&&t>0)}function Su(e,t){let n=bu(e.scheduleIds),r=$i(e.sections);return{query:e.query,nameQuery:e.nameQuery??e.query,cellQuery:e.cellQuery,scheduleIds:n,sections:r,includeCells:e.includeCells,scanCells:e.scanCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSchedules:ce(e.maxSchedules,50,1,200),maxRowsPerSection:ce(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:ce(e.maxColumnsPerSection,30,0,200),startRow:ce(e.startRow,0,0,1e5),startColumn:ce(e.startColumn,0,0,1e4),maxCellTextChars:ce(e.maxCellTextChars,180,20,1e3),maxCells:t.maxCells,maxResponseBytes:ce(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit schedules",taskId:e.taskId}}function ft(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function wu(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Xn(e){return T(e,"schedules").filter(ft).flatMap(n=>T(n,"sections").map(o=>({schedule:n,section:o})))}function Ot(e){return String(c(e,"cellQuery")??"").trim().length>0}function Xr(e){return String(c(e,"nameQuery")??c(e,"query")??"").trim().length>0}function Qr(e){return Ot(e)?Xn(e).flatMap(({schedule:t,section:n})=>T(n,"matches").filter(ft).map(o=>({sourceType:"scheduleCell",scheduleId:c(t,"id"),scheduleName:c(t,"name"),section:c(o,"section")??c(n,"section"),row:c(o,"row"),column:c(o,"column"),text:c(o,"text")}))):[]}function Yr(e){return c(e,"partial")===!0||c(e,"truncated")===!0?!0:Xn(e).some(({section:t})=>c(t,"rowsTruncated")===!0||c(t,"columnsTruncated")===!0)}function xu(e){if(c(e,"success")===!1||String(c(e,"state")||"").toLowerCase()==="failed"||c(e,"error"))return"read_failed";if(!Yr(e))return"completed";if(c(e,"truncated")===!0)return"max_items";for(let{section:t}of Xn(e)){if(c(t,"rowsTruncated")===!0)return"max_rows";if(c(t,"columnsTruncated")===!0)return"max_columns"}return"max_cells"}function Qi(e){let t=xu(e),n=c(e,"scanStoppedReason");return!n||n==="completed"&&t!=="completed"?t:n}function vu(e){let t=Yi(e),n=ft(t)?t:{},r=T(e,"schedules"),o=T(e,"evidenceRows").length>0?T(e,"evidenceRows"):Qr(e);return{query:c(e,"query")??null,nameQuery:c(e,"nameQuery")??null,cellQuery:c(e,"cellQuery")??null,totalSchedules:c(e,"totalSchedules")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!Xr(e)&&!Ot(e),matchCount:o.length,totalCellMatches:c(n,"totalCellMatches")??o.length,scannedScheduleCount:c(n,"scannedScheduleCount")??null,partial:Yr(e),scanStoppedReason:Qi(e)}}function Cu(e){let t=T(e,"evidenceRows").length>0?T(e,"evidenceRows"):Qr(e),n=t.length>0?t[t.length-1]:null,r=Xn(e),o=r.length>0?r[r.length-1].section:null,i=T(e,"schedules"),a=r.length>0?r[r.length-1].schedule:i.length>0?i[i.length-1]:null,s=Number(c(o,"returnedRows")??c(o,"scannedRows")??0),l=Number(c(o,"returnedColumns")??c(o,"scannedColumns")??0),u=Number(c(o,"startRow")??0),m=Number(c(o,"startColumn")??0);return{lastReadSection:c(n,"section")??c(o,"section")??null,lastReadRow:c(n,"row")??c(o,"lastReadRow")??(s>0?u+s-1:null),lastReadColumn:c(n,"column")??c(o,"lastReadColumn")??(l>0?m+l-1:null),lastReadSheetId:null,lastReadViewId:null,lastReadViewportId:null,lastReadItemId:c(n,"scheduleId")??c(a,"id")??null}}function $r(e){let t=Xi(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,includeCells:e.includeCells===!0,scanCells:e.scanCells===!0||!!e.cellQuery,sections:$i(e.sections),maxElapsedMs:t.maxElapsedMs,maxSchedules:ce(e.maxSchedules,50,1,200),maxRowsPerSection:ce(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:ce(e.maxColumnsPerSection,30,0,200),startRow:ce(e.startRow,0,0,1e5),startColumn:ce(e.startColumn,0,0,1e4),maxCells:t.maxCells,maxResponseBytes:ce(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs}}function Tu(e,t=!0){let{matches:n,Matches:r,...o}=e;return{...o,section:c(e,"section"),rowCount:c(e,"rowCount"),columnCount:c(e,"columnCount"),startRow:c(e,"startRow"),startColumn:c(e,"startColumn"),returnedRows:c(e,"returnedRows"),returnedColumns:c(e,"returnedColumns"),rowsTruncated:c(e,"rowsTruncated"),columnsTruncated:c(e,"columnsTruncated"),scannedRows:c(e,"scannedRows"),scannedColumns:c(e,"scannedColumns"),scannedCells:c(e,"scannedCells"),lastReadRow:c(e,"lastReadRow"),lastReadColumn:c(e,"lastReadColumn"),matches:t?T(e,"matches").filter(ft).map(i=>({...i,section:c(i,"section"),row:c(i,"row"),column:c(i,"column"),text:c(i,"text")})):[],cells:T(e,"cells").map(i=>({...i,row:c(i,"row"),cells:T(i,"cells").map(a=>({...a,column:c(a,"column"),text:c(a,"text")}))})),readFailed:c(e,"readFailed"),readError:c(e,"readError")}}function Ru(e){let t=!Xr(e)&&!Ot(e),n=Ot(e);return T(e,"schedules").filter(ft).map(r=>{let{nameMatched:o,NameMatched:i,cellMatchCount:a,CellMatchCount:s,sections:l,Sections:u,...m}=r;return{...m,id:c(r,"id"),uniqueId:c(r,"uniqueId"),name:c(r,"name"),viewType:c(r,"viewType"),isTemplate:c(r,"isTemplate"),nameMatched:t?!1:c(r,"nameMatched"),cellMatchCount:n?c(r,"cellMatchCount"):0,sections:T(r,"sections").filter(ft).map(p=>Tu(p,n))}})}function Iu(e,t){for(let[n,r]of Object.entries(t)){let o=n.charAt(0).toUpperCase()+n.slice(1);e[n]=r,e[o]=r}return e}function Yi(e){let t=c(e,"scan");if(!t||typeof t!="object"||Array.isArray(t))return t;let n={...t},r={};return Xr(e)||(r.scheduleNameMatchedCount=0),Ot(e)||(r.cellMatchedScheduleCount=0,r.totalCellMatches=0),Iu(n,r)}function _u(e){for(let t of["query","nameQuery","cellQuery","totalSchedules","candidateCount","returnedCount","truncated","maxSchedules","scan","matches"]){let n=c(e,t);n!==void 0&&e[t]===void 0&&(e[t]=n)}return e.scan=Yi(e),e.schedules=Ru(e),Ot(e)||(e.matches=[],delete e.Matches),e}function Mu(e){return String(c(e,"id")??c(e,"uniqueId")??c(e,"name")??"")}function Nu(e,t){let n=T(e,"cells"),r=be(T(e,"matches"),{limit:t}),{cells:o,Cells:i,matches:a,Matches:s,...l}=e;return{...l,matches:r.rows,matchCount:r.totalCount,returnedMatchCount:r.returnedCount,omittedMatchCount:r.omittedCount,duplicateMatchCount:r.duplicateCount,cellsOmitted:n.length>0,cellRowCount:n.length,fullResponseHint:n.length>0?'Use responseMode="full" when downstream schedule adapters need section.cells/body rows.':void 0}}function Eu(e,t){let n=t.responseMode||"compact";if(et(n))return{...e,responseMode:n};let r=ke(t.maxResultRows,fu,200),o=ke(t.maxEvidenceRows,gu,1e3),i=be(T(e,"schedules"),{limit:r,key:Mu}),a=be(T(e,"evidenceRows"),{limit:o});return{...e,responseMode:"compact",schedules:i.rows.map(s=>({...s,sections:T(s,"sections").filter(ft).map(l=>Nu(l,o))})),evidenceRows:a.rows,summary:{...e.summary||{},compactResponse:!0,scheduleRowCount:i.totalCount,returnedScheduleRowCount:i.returnedCount,omittedScheduleRowCount:i.omittedCount,duplicateScheduleRowCount:i.duplicateCount,evidenceRowCount:a.totalCount,returnedEvidenceRowCount:a.returnedCount,omittedEvidenceRowCount:a.omittedCount},notices:[...wu(e.notices),'Compact response omits section.cells and bounds evidence rows. Use responseMode="full" for full schedule cell bodies.']}}function Kr(e,t,n){let r=Yr(e);return Eu(_u(pe(e,{action:"inspect_schedules",elapsedMs:n,partial:r,scanStoppedReason:Qi(e),scanPolicy:$r(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],summary:vu,evidenceRows:Qr,lastRead:Cu})),t)}function Ki(e){e.tool("inspect_schedules","[SCHEDULE_INSPECTION_READ_ONLY] Read-only native Revit schedule discovery and bounded cell inspection with partial-result continuation state. Prefer this over generic send_code_to_revit when finding schedules, reading schedule cells, exporting schedule text to a local TSV/CSV/Excel-style report, or preparing exact row/column coordinates for set_schedule_cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true. Default responseMode=compact omits bulky section.cells; use responseMode=full when the next step needs raw schedule body rows, such as reconcile_schedule_excel schedule adaptation or a local TSV conversion. Do not use raw C# only to dump schedule cells.",{...w(G),...x(G),query:G.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),nameQuery:G.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),cellQuery:G.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),scheduleIds:G.array(G.union([G.number(),G.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),sections:G.array(G.enum(["header","body","footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),includeCells:G.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),scanCells:G.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),allowExpensiveSearch:G.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),searchBudget:G.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:G.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial schedule results can return before transport timeout."),maxSchedules:G.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),maxRowsPerSection:G.number().int().min(0).max(1e3).optional().describe("Maximum rows per section to read/scan. Defaults 80."),maxColumnsPerSection:G.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),startRow:G.number().int().min(0).max(1e5).optional().describe("Zero-based first schedule row to read in each requested section. Defaults 0."),startColumn:G.number().int().min(0).max(1e4).optional().describe("Zero-based first schedule column to read in each requested section. Defaults 0."),maxCells:G.number().int().positive().max(5e5).optional().describe("Global native cap across schedule cells read or scanned. Defaults by searchBudget."),maxResponseBytes:G.number().int().min(4096).max(16*1024*1024).optional().describe("Approximate native response-size cap. Defaults 4 MB."),maxCellTextChars:G.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),responseMode:Ze,maxResultRows:G.number().int().positive().max(200).optional().describe("Compact-mode cap for returned schedule entries. Defaults 25; full/debug returns all native rows within maxSchedules."),maxEvidenceRows:G.number().int().positive().max(1e3).optional().describe("Compact-mode cap for evidenceRows and per-section matches. Defaults 50."),timeoutMs:G.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{let n=Date.now();try{let r=!!(Array.isArray(t.scheduleIds)&&t.scheduleIds.length>0||String(t.nameQuery||t.query||"").trim());if(!!(t.includeCells===!0||t.scanCells===!0||String(t.cellQuery||"").trim())&&!r&&t.allowExpensiveSearch!==!0)return h(we({action:"inspect_schedules",reason:"needs_scope",message:"Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],scanPolicy:$r(t),elapsedMs:Date.now()-n,summary:{nameQuery:t.nameQuery??t.query??null,cellQuery:t.cellQuery??null,returnedCount:0,matchCount:0}}));let i=Xi(t),a=await _("inspect_schedules",Su(t,i),{...I(t,"Inspect Revit schedules"),toolName:"inspect_schedules",timeoutMs:i.timeoutMs});return h(Kr(a&&a.result?a.result:a,t,Date.now()-n))}catch(r){return h(Re({action:"inspect_schedules",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,scanPolicy:$r(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"]}))}})}import{z as co}from"zod";import*as ju from"node:fs";import ea from"node:fs/promises";import Bu from"node:path";import{performance as Zr}from"node:perf_hooks";import*as yt from"@e965/xlsx";import{parse as zu}from"csv-parse/sync";import{z as v}from"zod";var Qn=["identity","comparisonText"],Yn=["identity","comparisonText","code","description","quantity","unit","system","discipline","notes"],Kn={identity:["identity","id","key","name","item","row","code","type","mark","tag","poz","kod","ad","isim"],comparisonText:["comparisontext","comparison text","description","desc","aciklama","text","name","item","type","mark","tag","ad","isim"],code:["code","kod","type code","mark","tag","poz"],description:["description","desc","text","aciklama"],quantity:["quantity","qty","count","adet","miktar"],unit:["unit","units","birim"],system:["system","sistem"],discipline:["discipline","disiplin"],notes:["notes","note","remarks","remark","not"]},ku={\u0410:"A",\u0430:"A",\u0412:"B",\u0432:"B",\u0415:"E",\u0435:"E",\u041A:"K",\u043A:"K",\u041C:"M",\u043C:"M",\u041D:"H",\u043D:"H",\u041E:"O",\u043E:"O",\u0420:"P",\u0440:"P",\u0421:"C",\u0441:"C",\u0422:"T",\u0442:"T",\u0423:"Y",\u0443:"Y",\u0425:"X",\u0445:"X"},Pu={\u00C7:"C",\u00E7:"C",\u011E:"G",\u011F:"G",\u00D6:"O",\u00F6:"O",\u015E:"S",\u015F:"S",\u00DC:"U",\u00FC:"U"},Vt=new Set(["DN","MM","CM","M","KW","KCALH","LPS","M3H"]);function W(e){return String(e??"").replace(/\s+/g," ").trim()}function Pe(e){return W(e).replace(/\u0131/g,"i").replace(/\u0130/g,"I").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}function un(e){return Pe(e).replace(/\s+/g,"")}function Dt(e){let t=String(e??"");return t=t.replace(/[\u0000-\u001f\u007f-\u009f]/g," "),t=t.normalize("NFKC"),t=t.replace(/\u0131/g,"i").replace(/\u0130/g,"I"),t=t.replace(/[\u0400-\u04ff]/g,n=>ku[n]||n),t=t.replace(/[\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/g,n=>Pu[n]||n),t=t.toUpperCase(),t=t.replace(/[\u00d8\u00f8\u2205\u2300\u0424\u0444]/g," DN "),t=t.replace(/\b(?:DIAMETER|DIA)\b/g," DN "),t=Vu(t),t=t.replace(/(\d),(\d)/g,"$1.$2"),t=t.replace(/(\d)\.(\d)/g,"$1DECIMALDOT$2"),t=t.replace(/[^A-Z0-9]+/g," "),t=t.replace(/(\d)DECIMALDOT(\d)/g,"$1.$2"),t=t.replace(/\bM\s*3\s*H\b/g,"M3H"),t.replace(/\s+/g," ").trim()}function Au(e){return e.map(n=>Dt(n)).filter((n,r,o)=>n.length>0&&o.indexOf(n)===r).join(" | ")}function Ft(e){let t=Au(e);return{profileVersion:1,normalizedKey:t,tokens:Ou(t)}}function Ou(e){let t=Dt(e),n=t.length>0?t.split(" "):[],r=[];for(let o=0;o<n.length;o++){let i=n[o],a=n[o+1];if(cn(i)&&a&&Vt.has(a)){r.push({type:"dimension",value:`${i}${a}`}),o++;continue}if(Vt.has(i)&&a&&cn(a)){r.push({type:"dimension",value:`${i}${a}`}),o++;continue}let s=Lu(i);if(s){r.push({type:"dimension",value:s});continue}if(Vt.has(i)){r.push({type:"unit",value:i});continue}if(cn(i)){r.push({type:"number",value:i});continue}let l=n[o+2]||"",u=Vt.has(l)&&cn(n[o+3]||""),m=Vt.has(l)&&!u;if(Du(i)&&a&&cn(a)&&!Vt.has(i)&&!m){r.push({type:"code",value:`${i}${a}`}),o++;continue}if(Fu(i)){r.push({type:"code",value:i});continue}r.push({type:"word",value:i})}return r}function Vu(e){return e.replace(/\bM\s*(?:3|\^3)\s*\/\s*H\b/g," M3H ").replace(/\bM3H\b/g," M3H ").replace(/\b(?:L|LT)\s*\/\s*S\b/g," LPS ").replace(/\bLPS\b/g," LPS ").replace(/\bKCAL\s*\/\s*H\b/g," KCALH ").replace(/\bKCALH\b/g," KCALH ").replace(/\bKW\b/g," KW ").replace(/\bMM\b/g," MM ").replace(/\bCM\b/g," CM ").replace(/\bDN\b/g," DN ")}function cn(e){return/^\d+(?:\.\d+)?$/.test(e)}function Du(e){return/^[A-Z]+$/.test(e)}function Fu(e){return/[A-Z]/.test(e)&&/\d/.test(e)}function Lu(e){let t=e.match(/^(\d+(?:\.\d+)?)(DN|MM|CM|M|KW|KCALH|LPS|M3H)$/);if(t)return`${t[1]}${t[2]}`;let n=e.match(/^(DN)(\d+(?:\.\d+)?)$/);return n?`${n[1]}${n[2]}`:null}yt.set_fs(ju);var dn="reconcile_schedule_excel",rr="excel_ingestion",Lt={maxWorkbookBytes:25*1024*1024,maxSheets:20,maxRows:5e3,maxColumns:100,maxCells:25e4,maxElapsedMs:5e3},jt={maxWorkbookBytes:100*1024*1024,maxSheets:200,maxRows:5e4,maxColumns:300,maxCells:1e6,maxElapsedMs:119e3},Zn=Qn,er=Yn,qu=Kn,Wu=v.object({sheetName:v.string().min(1).optional(),sheetIndex:v.number().int().positive().optional(),range:v.string().min(1).optional(),headerRow:v.number().int().positive().optional(),dataStartRow:v.number().int().positive().optional()}).strict(),ta=v.object({identity:v.union([v.string().min(1),v.number().int().positive()]).optional(),comparisonText:v.union([v.string().min(1),v.number().int().positive()]).optional(),code:v.union([v.string().min(1),v.number().int().positive()]).optional(),description:v.union([v.string().min(1),v.number().int().positive()]).optional(),quantity:v.union([v.string().min(1),v.number().int().positive()]).optional(),unit:v.union([v.string().min(1),v.number().int().positive()]).optional(),system:v.union([v.string().min(1),v.number().int().positive()]).optional(),discipline:v.union([v.string().min(1),v.number().int().positive()]).optional(),notes:v.union([v.string().min(1),v.number().int().positive()]).optional()}).strict(),na=v.object({maxWorkbookBytes:v.number().int().positive().optional(),maxSheets:v.number().int().positive().optional(),maxRows:v.number().int().nonnegative().optional(),maxColumns:v.number().int().positive().optional(),maxCells:v.number().int().positive().optional(),maxElapsedMs:v.number().int().positive().optional()}).strict(),Gu=v.object({kind:v.literal("file"),path:v.string().min(1),format:v.enum(["xlsx","csv","tsv","xls"]).optional(),selection:Wu.optional(),columnMapping:ta.optional(),budgets:na.optional()}).strict(),Ju=v.object({kind:v.literal("rows"),sheetName:v.string().min(1).optional(),rows:v.array(v.record(v.unknown())),selection:v.object({headerRow:v.number().int().positive().optional(),dataStartRow:v.number().int().positive().optional()}).strict().optional(),columnMapping:ta.optional(),budgets:na.optional()}).strict(),to=v.discriminatedUnion("kind",[Gu,Ju]);function Ge(e){return W(e)}function tr(e){return Pe(e)}function Zi(e){return un(e)}function Hu(e){return{maxWorkbookBytes:Bt(e?.maxWorkbookBytes,Lt.maxWorkbookBytes,jt.maxWorkbookBytes),maxSheets:Bt(e?.maxSheets,Lt.maxSheets,jt.maxSheets),maxRows:Bt(e?.maxRows,Lt.maxRows,jt.maxRows),maxColumns:Bt(e?.maxColumns,Lt.maxColumns,jt.maxColumns),maxCells:Bt(e?.maxCells,Lt.maxCells,jt.maxCells),maxElapsedMs:Bt(e?.maxElapsedMs,Lt.maxElapsedMs,jt.maxElapsedMs)}}function Bt(e,t,n){return typeof e!="number"||!Number.isFinite(e)?t:Math.max(0,Math.min(Math.floor(e),n))}function ra(e,t){let n=(t||Bu.extname(e).replace(/^\./,"")).trim().toLowerCase();return n==="xlsx"||n==="csv"||n==="tsv"||n==="xls"?n:"unsupported"}function gt(e,t,n={}){let{warnings:r=[],notices:o=[],suggestedNextScopes:i=[],...a}=n;return we({action:dn,reason:e,message:t,extra:{stage:rr,ingestionContractVersion:1,...a},summary:n.summary||{},evidenceRows:[],scanPolicy:n.scanPolicy||{},suggestedNextScopes:i,warnings:r,notices:o})}function Uu(e,t={}){let{warnings:n=[],notices:r=[],...o}=t;return Re({action:dn,error:e,extra:{stage:rr,ingestionContractVersion:1,...o},summary:t.summary||{},evidenceRows:[],scanPolicy:t.scanPolicy||{},warnings:n,notices:r})}function $u(e){let t=e.table.warnings.concat(e.mappingWarnings),n=e.table.notices.concat(e.mappingNotices),r=e.table.partial,o=e.table.scanStoppedReason,i=e.records.map(a=>({sourceType:"excelRecord",excelRowId:a.excelRowId,sheetName:a.sheetName,rowNumber:a.rowNumber,identityText:a.identityText,comparisonText:a.comparisonText,normalizedKey:a.normalizedKey}));return pe({success:!0,guarded:!1,state:"completed",action:dn,stage:rr,ingestionContractVersion:1,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,excelRecords:e.records,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs},{action:dn,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs,scanPolicy:{budgets:e.budgets,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerRow:e.table.headerRow,dataStartRow:e.table.dataStartRow,columnMapping:Xu(e.mapping,e.table)},summary:{sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerCount:e.table.headers.length,scannedRows:e.table.rows.length,scannedCells:e.table.scannedCells,excelRows:e.records.length,excelRecordCount:e.records.length,emptyExcelRows:e.table.rows.length-e.records.length,formulaCachedValueCount:e.table.formulaCachedValueCount,formulaWithoutCachedValueCount:e.table.formulaWithoutCachedValueCount,partial:r,scanStoppedReason:o},evidenceRows:i,warnings:t,notices:n,lastRead:{lastReadRow:e.table.lastReadRow,lastReadColumn:e.table.lastReadColumn,lastReadItemId:e.records.length>0?e.records[e.records.length-1].excelRowId:null}})}function Xu(e,t){let n={};for(let r of er){let o=e[r];typeof o=="number"&&(n[r]=t.headers[o]||Je(t.startColumn+o))}return n}function Je(e){let t=Math.max(1,Math.floor(e)),n="";for(;t>0;){let r=(t-1)%26;n=String.fromCharCode(65+r)+n,t=Math.floor((t-1)/26)}return n}function eo(e){let t=e.trim().toUpperCase();if(!/^[A-Z]+$/.test(t))return null;let n=0;for(let r of t)n=n*26+(r.charCodeAt(0)-64);return n}function oa(e,t){if(!e)return t;let n=e.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/);if(!n)return null;let r=eo(n[1]),o=Number(n[2]),i=n[3]?eo(n[3]):r,a=n[4]?Number(n[4]):o;return!r||!i||o<1||a<o||i<r?null:{startRow:o,startColumn:r,endRow:a,endColumn:i}}function Qu(e,t,n,r){return`${Je(t)}${e}:${Je(r)}${n}`}function Yu(e){return Ge(e).length===0}function Ku(e){return e.every(t=>Yu(t.text))}function Zu(e,t){let n=new Map;return e.map((r,o)=>{let i=`Column ${Je(t+o)}`,a=Ge(r.text)||i,s=tr(a)||tr(i),l=n.get(s)||0;return n.set(s,l+1),l===0?a:`${a} ${l+1}`})}function nr(e){if(e==null)return"";if(e instanceof Date)return Number.isNaN(e.getTime())?"":e.toISOString();if(typeof e=="object"){let t=e;return Array.isArray(t.richText)?Ge(t.richText.map(n=>String(n.text??"")).join("")):t.text!==void 0?Ge(t.text):t.result!==void 0?nr(t.result):""}return Ge(e)}function ed(e,t,n,r){let o=yt.utils.encode_cell({r:t-1,c:n-1}),i=`${r}!${o}`,a=e[o];if(!a)return{value:"",text:"",address:i};if(typeof a.f=="string"&&a.f.length>0)return a.v!==void 0&&a.v!==null&&!(typeof a.v=="string"&&a.v.length===0&&(a.w===void 0||a.w===""))?{value:a.v,text:nr(a.v)||Ge(a.w),address:i,formulaWithCachedValue:!0}:{value:"",text:"",address:i,formulaWithoutCachedValue:!0};let l=a.v??"";return{value:l,text:nr(l)||Ge(a.w),address:i}}function td(e,t,n,r){return{value:e,text:nr(e),address:`${r}!${Je(n)}${t}`}}function nd(e,t){return Zr.now()-e>t.maxElapsedMs}function rd(e,t,n){let r=[],o=[],i={},a=new Set,s=new Set;for(let u of er){let m=n?.[u];if(m!==void 0){let p=sd(m,e,t);if(p===null)return{error:{role:u,reason:"unresolved_column_ref",value:m}};i[u]=p,a.add(p),s.add(u)}}for(let u of er){if(i[u]!==void 0)continue;let m=ia(u,e);if(m.length===0)continue;let p=ad(m,a);if(p.kind==="ambiguous")return{error:{role:u,reason:"ambiguous_alias",candidates:p.candidates}};p.kind==="resolved"&&(i[u]=p.match.index,a.add(p.match.index))}for(let u of Zn)if(i[u]===void 0)return{error:{role:u,reason:"missing_required_role"}};let l=Zn.filter(u=>!s.has(u));if(l.length>0){let u=l.map(m=>`${m}=${e[i[m]]||Je(t+i[m])}`).join(", ");o.push(`column_mapping_inferred_from_headers: ${u}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`)}return{mapping:i,warnings:r,notices:o}}function od(e,t){let n={},r={},o=new Set;for(let i of Zn){let a=ia(i,e).filter(s=>!o.has(s.index)).sort((s,l)=>s.priority-l.priority||s.index-l.index);n[i]=a.map(s=>({header:s.header,column:Je(t+s.index),priority:s.priority})),a.length>0&&(r[i]=a[0].header,o.add(a[0].index))}return{requiredRoles:Zn,candidates:n,suggestedColumnMapping:r}}function id(e,t){let n=Zi(t),r=qu[e];for(let o=0;o<r.length;o++)if(Zi(r[o])===n)return o;return Number.POSITIVE_INFINITY}function ia(e,t){return t.map((n,r)=>({header:n,index:r,priority:id(e,n)})).filter(n=>Number.isFinite(n.priority))}function ad(e,t){let n=e.filter(a=>!t.has(a.index)),r=n.length>0?n:e,o=Math.min(...r.map(a=>a.priority)),i=r.filter(a=>a.priority===o);return i.length===1?{kind:"resolved",match:i[0]}:{kind:"ambiguous",candidates:i.map(a=>a.header)}}function sd(e,t,n){if(typeof e=="number"){let s=e-1;return s>=0&&s<t.length?s:null}let r=e.trim(),o=tr(r),i=t.map((s,l)=>({header:s,index:l})).filter(s=>tr(s.header)===o);if(i.length===1)return i[0].index;let a=eo(r);if(a!==null){let s=a-n;return s>=0&&s<t.length?s:null}return null}function ld(e,t){let n=[];for(let r of e.rows){if(Ku(r.cells))continue;let o={};for(let[p,f]of e.headers.entries())o[f]=r.cells[p]?.text??"";let i={};for(let p of er){let f=t[p];typeof f=="number"&&(i[p]=r.cells[f]?.text??"")}let a=Ge(i.identity),s=Ge(i.comparisonText),l=Ft([a,s]),u=l.normalizedKey,m=`${e.sheetName}!${r.rowNumber}`;n.push({excelRowId:m,sheetName:e.sheetName,rowNumber:r.rowNumber,sourceRange:e.sourceRange,rawValues:o,mappedValues:i,identityText:a,comparisonText:s,normalizedKey:u,tokenProfile:l})}return n}async function cd(e,t,n){let r=yt.readFile(e.path,{cellDates:!0,cellFormula:!0,cellText:!0,nodim:!0}),o=r.SheetNames.map(m=>({name:m,worksheet:r.Sheets[m]||{}})),i=e.selection||{},a=!!(i.sheetName||i.sheetIndex),s=o.filter(m=>md(m.worksheet));if(!a&&o.length>t.maxSheets&&s.length!==1)return gt("max_items","Workbook sheet count exceeds maxSheets and cannot be auto-scoped to one non-empty sheet. Provide sheetName or sheetIndex.",{partial:!0,scanStoppedReason:"max_items",summary:{workbookSheets:o.length,nonEmptySheets:s.length,maxSheets:t.maxSheets},scanPolicy:{budgets:t},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex","excel.budgets.maxSheets"]});let l=ud(r,i,s);if(!l)return gt("excel_sheet_selection_required","Select a worksheet with sheetName or 1-based sheetIndex.",{summary:{workbookSheets:o.length,sheetNames:o.map(m=>m.name)},scanPolicy:{budgets:t,selection:i},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex"]});let u=dd(l,i,t,n);return!a&&s.length===1&&u.notices.push("Selected the only non-empty worksheet."),u}function ud(e,t,n){if(t.sheetName){let r=e.Sheets[t.sheetName];return r?{name:t.sheetName,worksheet:r}:null}if(t.sheetIndex){let r=e.SheetNames[t.sheetIndex-1];return r&&e.Sheets[r]?{name:r,worksheet:e.Sheets[r]}:null}return n.length===1?n[0]:null}function dd(e,t,n,r){let o=pd(e.worksheet);return sa({sheetName:e.name,fallbackRange:o,selection:t,budgets:n,startedAt:r,readCell:(i,a)=>ed(e.worksheet,i,a,e.name)})}function md(e){return Object.keys(e).some(t=>!t.startsWith("!"))}function pd(e){let t=Number.POSITIVE_INFINITY,n=Number.POSITIVE_INFINITY,r=1,o=1;for(let i of Object.keys(e))if(!i.startsWith("!"))try{let a=yt.utils.decode_cell(i);t=Math.min(t,a.r+1),n=Math.min(n,a.c+1),r=Math.max(r,a.r+1),o=Math.max(o,a.c+1)}catch{continue}return!Number.isFinite(t)||!Number.isFinite(n)?{startRow:1,startColumn:1,endRow:1,endColumn:1}:{startRow:t,startColumn:n,endRow:r,endColumn:o}}async function hd(e,t,n,r){let o=await ea.readFile(e.path,"utf8"),i=fd(e.selection||{},t),a=zu(o,{bom:!0,delimiter:r==="tsv"?"	":",",relax_column_count:!0,skip_empty_lines:!1,to:i.recordLimit+1}),s=a.length>i.recordLimit?{partial:!0,scanStoppedReason:i.scanStoppedReason}:void 0,l=s?a.slice(0,i.recordLimit):a,u=e.selection?.sheetName||(r==="tsv"?"TSV":"CSV");return aa(l,u,e.selection||{},t,n,s)}function fd(e,t){let r=oa(e.range,{startRow:1,startColumn:1,endRow:1,endColumn:1})?.startRow||1,o=e.headerRow||r,i=e.dataStartRow||o+1;return{recordLimit:Math.max(r,o,i+t.maxRows-1),scanStoppedReason:"max_rows"}}function gd(e,t,n){let r=e.sheetName||"Rows",o=yd(e.rows),i=e.selection?.headerRow||1,a=e.selection?.dataStartRow||i+1,s=[];for(;s.length<i-1;)s.push([]);for(s.push(o);s.length<a-1;)s.push([]);for(let l of e.rows)s.push(o.map(u=>l[u]));return aa(s,r,{headerRow:i,dataStartRow:a},t,n)}function yd(e){let t=[],n=new Set;for(let r of e)for(let o of Object.keys(r))n.has(o)||(n.add(o),t.push(o));return t}function aa(e,t,n,r,o,i){let a=e.reduce((l,u)=>Math.max(l,u.length),1),s={startRow:1,startColumn:1,endRow:Math.max(e.length,1),endColumn:Math.max(a,1)};return sa({sheetName:t,fallbackRange:s,selection:n,budgets:r,startedAt:o,prelimited:i,readCell:(l,u)=>td(e[l-1]?.[u-1],l,u,t)})}function sa(e){let t=oa(e.selection.range,e.fallbackRange);if(!t)throw new Error(`Invalid range selection: ${e.selection.range}`);let n=e.selection.headerRow||t.startRow,r=e.selection.dataStartRow||n+1;if(r<=n)throw new Error("dataStartRow must be greater than headerRow.");let o=t.endColumn,i=e.prelimited?.partial||!1,a=e.prelimited?.scanStoppedReason||"completed";o-t.startColumn+1>e.budgets.maxColumns&&(o=t.startColumn+e.budgets.maxColumns-1,i=!0,a="max_columns");let s=[],l=0,u=0,m=0,p=[],f=[];for(let L=t.startColumn;L<=o;L++){let O=e.readCell(n,L);s.push(O),l++,O.formulaWithCachedValue&&u++,O.formulaWithoutCachedValue&&(m++,p.push(`Formula cell ${O.address||`${e.sheetName}!${Je(L)}${n}`} has no cached value and was read as blank.`))}let y=Zu(s,t.startColumn),S=[],N=null,k=null,F=Math.max(r,t.startRow);for(let L=F;L<=t.endRow;L++){if(S.length>=e.budgets.maxRows){i=!0,a=a==="completed"?"max_rows":a;break}if(nd(e.startedAt,e.budgets)){i=!0,a="max_elapsed";break}if(l+y.length>e.budgets.maxCells){i=!0,a=a==="completed"?"max_cells":a;break}let O=[];for(let J=t.startColumn;J<=o;J++){let Y=e.readCell(L,J);O.push(Y),l++,N=L,k=J,Y.formulaWithCachedValue&&u++,Y.formulaWithoutCachedValue&&(m++,p.push(`Formula cell ${Y.address||`${e.sheetName}!${Je(J)}${L}`} has no cached value and was read as blank.`))}S.push({rowNumber:L,cells:O})}return{sheetName:e.sheetName,sourceRange:Qu(t.startRow,t.startColumn,t.endRow,o),headerRow:n,dataStartRow:r,startColumn:t.startColumn,headers:y,rows:S,notices:f,warnings:p,formulaCachedValueCount:u,formulaWithoutCachedValueCount:m,scannedCells:l,partial:i,scanStoppedReason:a,lastReadRow:N,lastReadColumn:k}}function bd(e){return!!(e&&typeof e=="object"&&e.action===dn&&e.stage===rr)}async function la(e){let t=Zr.now(),n=to.safeParse(e);if(!n.success)return gt("needs_scope","Excel ingestion input failed schema validation.",{validationIssues:n.error.issues.map(i=>`${i.path.join(".")||"<root>"}: ${i.message}`),suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"]});let r=n.data,o=Hu(r.budgets);try{let i=await Sd(r,o,t);if(bd(i))return i;let a=i,s=rd(a.headers,a.startColumn,r.columnMapping);if("error"in s)return gt("excel_column_mapping_required","Resolve identity and comparisonText column mapping before ingestion.",{mappingError:s.error,mappingSuggestion:od(a.headers,a.startColumn),summary:{sheetName:a.sheetName,headers:a.headers},scanPolicy:{budgets:o},suggestedNextScopes:["excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:a.warnings,notices:a.notices});let l=ld(a,s.mapping);return $u({sourceKind:r.kind,format:r.kind==="file"?ra(r.path,r.format):"rows",table:a,records:l,budgets:o,mapping:s.mapping,mappingNotices:s.notices,mappingWarnings:s.warnings,elapsedMs:Zr.now()-t})}catch(i){return Uu(i instanceof Error?i.message:String(i),{scanPolicy:{budgets:o}})}}async function Sd(e,t,n){if(e.kind==="rows")return gd(e,t,n);let r=ra(e.path,e.format);if(r==="xls")return gt("unsupported_excel_format",".xls is not supported. Save the workbook as .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});if(r==="unsupported")return gt("unsupported_excel_format","Unsupported spreadsheet format. Use .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});let o=await ea.stat(e.path);return o.size>t.maxWorkbookBytes?gt("max_bytes","Workbook exceeds maxWorkbookBytes.",{format:r,partial:!0,scanStoppedReason:"max_bytes",summary:{workbookBytes:o.size,maxWorkbookBytes:t.maxWorkbookBytes},scanPolicy:{budgets:t},suggestedNextScopes:["excel.budgets.maxWorkbookBytes","excel.selection.sheetName","excel.selection.range"]}):r==="xlsx"?cd(e,t,n):hd(e,t,n,r)}import{z as b}from"zod";var or="reconcile_schedule_records",ro="schedule_record_adapter",tt="displayedScheduleCells",wd=["body"],no=Yn,ma=Qn,xd=Kn,vd=b.object({column:b.number().int().nonnegative(),header:b.string().min(1)}).strict(),pa=b.union([b.array(b.string()),b.array(vd),b.record(b.union([b.string().min(1),b.number().int().nonnegative()]))]),ha=b.enum(["auto","always","never"]),fa=b.object({identity:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),comparisonText:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),code:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),description:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),quantity:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),unit:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),system:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),discipline:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),notes:b.union([b.string().min(1),b.number().int().nonnegative()]).optional()}).strict(),Cd=b.object({kind:b.literal("inspect_schedules_result"),result:b.record(b.unknown()),columnMapping:fa.optional(),columnHeaders:pa.optional(),sections:b.array(b.enum(["header","body","footer"])).optional(),headerDataMode:ha.optional()}).strict(),Td=b.object({kind:b.literal("revit_schedule"),scheduleIds:b.array(b.union([b.number().int().positive(),b.string().min(1)])).optional(),nameQuery:b.string().min(1).optional(),sections:b.array(b.enum(["header","body","footer"])).optional(),columnMapping:fa.optional(),columnHeaders:pa.optional(),headerDataMode:ha.optional(),target:b.string().optional(),host:b.string().optional(),port:b.number().int().positive().max(65535).optional(),taskName:b.string().optional(),taskId:b.string().optional(),parentTaskName:b.string().optional(),parentTaskId:b.string().optional(),allowExpensiveSearch:b.boolean().optional(),searchBudget:b.enum(["fast","balanced","deep"]).optional(),maxElapsedMs:b.number().int().positive().max(119e3).optional(),maxSchedules:b.number().int().positive().max(200).optional(),maxRowsPerSection:b.number().int().min(0).max(1e3).optional(),maxColumnsPerSection:b.number().int().min(0).max(200).optional(),startRow:b.number().int().min(0).max(1e5).optional(),startColumn:b.number().int().min(0).max(1e4).optional(),maxCells:b.number().int().positive().max(5e5).optional(),maxResponseBytes:b.number().int().min(4096).max(16*1024*1024).optional(),maxCellTextChars:b.number().int().min(20).max(1e3).optional(),timeoutMs:b.number().int().positive().max(12e4).optional()}).strict(),oo=b.discriminatedUnion("kind",[Cd,Td]);async function ga(e,t={}){let n=Date.now(),r=oo.safeParse(e);return r.success?r.data.kind==="revit_schedule"?Rd(r.data,n,t):ya(r.data,Date.now()-n):ir("needs_scope","Schedule adapter input failed schema validation.",{validationIssues:r.error.issues.map(o=>`${o.path.join(".")||"<root>"}: ${o.message}`),elapsedMs:Date.now()-n,suggestedNextScopes:["schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]})}async function Rd(e,t,n){if(!!!(Array.isArray(e.scheduleIds)&&e.scheduleIds.length>0||String(e.nameQuery||"").trim())&&e.allowExpensiveSearch!==!0)return ir("needs_scope","Direct live schedule reconciliation requires scheduleIds or nameQuery. Set allowExpensiveSearch=true only when a broad schedule scan is intentional.",{sourceKind:e.kind,elapsedMs:Date.now()-t,suggestedNextScopes:["schedule.scheduleIds","schedule.nameQuery","schedule.allowExpensiveSearch=true"],scanPolicy:{sourceKind:e.kind,bridgeExecution:"inspect_schedules",scheduleIds:[],nameQuery:null,allowExpensiveSearch:!1,visibilityBasis:tt}});let i=["header",...Sa(e.sections).filter(f=>f!=="header")],a={query:e.nameQuery,nameQuery:e.nameQuery,scheduleIds:e.scheduleIds,sections:i,includeCells:!0,scanCells:!1,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:e.searchBudget,maxElapsedMs:e.maxElapsedMs,maxSchedules:e.maxSchedules,maxRowsPerSection:e.maxRowsPerSection,maxColumnsPerSection:e.maxColumnsPerSection,startRow:e.startRow,startColumn:e.startColumn,maxCells:e.maxCells,maxResponseBytes:e.maxResponseBytes,maxCellTextChars:e.maxCellTextChars,responseMode:"full",timeoutMs:e.timeoutMs,taskName:e.taskName||"Inspect live Revit schedule for reconciliation",taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId},l=await(n.sendCommand||_)("inspect_schedules",a,{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs,taskName:a.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,toolName:"reconcile_schedule_excel"}),u=Date.now()-t,m=Kr(l&&l.result?l.result:l,a,u),p=ya({kind:"inspect_schedules_result",result:m,columnMapping:e.columnMapping,columnHeaders:e.columnHeaders,sections:e.sections,headerDataMode:e.headerDataMode},u);return p.sourceKind="revit_schedule",p.bridgeSourceKind="inspect_schedules_result",p.scanPolicy={...p.scanPolicy||{},sourceKind:"revit_schedule",bridgeExecution:"inspect_schedules",inspectSections:i,scheduleIds:e.scheduleIds||[],nameQuery:e.nameQuery||null,allowExpensiveSearch:e.allowExpensiveSearch===!0},p.notices=[...bt(p,"notices"),"Live Revit schedule input was read through bounded inspect_schedules before reconciliation."],p}function ya(e,t){let n=e.result,r=W(c(n,"state")).toLowerCase();if(c(n,"success")===!1||r==="failed"||c(n,"error"))return Dd(W(c(n,"error"))||"inspect_schedules_result failed before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:bt(n,"warnings"),notices:bt(n,"notices")});if(c(n,"guarded")===!0)return ir(W(c(n,"reason"))||"needs_scope","inspect_schedules_result was guarded before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:bt(n,"warnings"),notices:bt(n,"notices"),summary:c(n,"summary")||{},suggestedNextScopes:['inspect_schedules responseMode="full"',"schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let o=Sa(e.sections),i=Array.isArray(e.sections)&&e.sections.length>0,a=wa(e.headerDataMode),s=T(n,"schedules"),l=bt(n,"warnings"),u=bt(n,"notices"),m=[],p=0,f=0,y=0,S=0,N=0;for(let O of s){let J=ao(c(O,"id"));if(!J){l.push("Skipped a schedule without id while adapting schedule records.");continue}let Y=sr(c(O,"name")),Z=Nd(O,e.columnHeaders),ee=Pd(Z,e.columnMapping);if("error"in ee)return ir("schedule_column_mapping_required","Resolve identity and comparisonText schedule column mapping before adaptation.",{sourceKind:e.kind,scheduleId:J,scheduleName:Y,mappingError:ee.error,summary:{scheduleId:J,scheduleName:Y,headers:Z.map($=>({column:$.column,header:$.header}))},scanPolicy:da(e,o),suggestedNextScopes:["schedule.columnMapping.identity","schedule.columnMapping.comparisonText",'inspect_schedules responseMode="full"'],warnings:l,notices:u});let ne=Md(O,o,i,a);ne.headerAsData&&S++;for(let $ of T(O,"sections")){let re=ar(c($,"section"));if(!ne.sections.includes(re))continue;let xe=re==="header"&&ne.headerAsData;for(let _e of io($,J,Y,re)){if(p++,f+=_e.cells.length,xe&&Id(_e,Y)){y++;continue}if(re==="body"&&ca(_e,ee.mapping,Z,{matchSameColumnHeader:!0})){y++;continue}if(xe&&ca(_e,ee.mapping,Z,{matchSameColumnHeader:!1})){y++;continue}let He=_d(_e,ee.mapping);He&&(xe&&N++,m.push(He))}}}let k=c(n,"partial")===!0,F=ln(c(n,"scanStoppedReason"),k?"max_items":"completed"),L=m.length>0?m[m.length-1]:null;return pe({success:!0,guarded:!1,state:"completed",action:or,stage:ro,adapterContractVersion:1,sourceKind:e.kind,visibilityBasis:tt,scheduleRecords:m,partial:k,scanStoppedReason:F,elapsedMs:t},{action:or,partial:k,scanStoppedReason:F,elapsedMs:t,scanPolicy:da(e,o),summary:{sourceKind:e.kind,scheduleCount:s.length,scannedRows:p,scannedCells:f,skippedHeaderLikeRows:y,headerAsDataScheduleCount:S,headerAsDataRows:N,scheduleRecordCount:m.length,visibilityBasis:tt,partial:k,scanStoppedReason:F},evidenceRows:m.map(O=>({sourceType:"scheduleRecord",scheduleRowId:O.scheduleRowId,scheduleId:O.scheduleId,scheduleName:O.scheduleName,section:O.section,row:O.row,identityText:O.identityText,comparisonText:O.comparisonText,normalizedKey:O.normalizedKey,visibilityBasis:tt})),warnings:l,notices:[...u,...S>0?[`Read Header section rows as schedule data for ${S} schedule(s).`]:[],...y>0?[`Skipped ${y} header-like schedule row(s) during schedule adaptation.`]:[]],lastRead:{lastReadSection:c(n,"lastReadSection")??L?.section??null,lastReadRow:c(n,"lastReadRow")??L?.row??null,lastReadColumn:c(n,"lastReadColumn")??null,lastReadItemId:c(n,"lastReadItemId")??L?.scheduleRowId??null}})}function ca(e,t,n,r){let o=new Map;for(let s of e.cells)o.set(s.column,s.text);let i=ma.filter(s=>typeof t[s]=="number");if(i.length===0)return!1;let a=new Map;for(let s of i){let l=t[s];typeof l=="number"&&a.set(l,[...a.get(l)||[],s])}return[...a.entries()].every(([s,l])=>{let u=W(o.get(s));if(!u)return!1;let m=Pe(u);return r.matchSameColumnHeader&&n.some(f=>f.column===s&&Pe(f.header)===m)?!0:l.some(f=>Number.isFinite(ba(f,u))||f==="identity"&&["number","no","numara"].includes(m)?!0:f==="comparisonText"&&["name","description","desc","text","aciklama"].includes(m))})}function Id(e,t){let n=Pe(t||"");if(!n)return!1;let r=e.cells.map(o=>Pe(o.text)).filter(o=>o.length>0);return r.length===1&&r[0]===n}function _d(e,t){let n=new Map;for(let s of e.cells)n.set(s.column,s.text);let r={};for(let s of no){let l=t[s];typeof l=="number"&&(r[s]=W(n.get(l)))}let o=W(r.identity),i=W(r.comparisonText);if(!o&&!i)return null;let a=Ft([o,i]);return{scheduleRowId:`${e.scheduleId}:${e.section}:${e.row}`,scheduleId:e.scheduleId,scheduleName:e.scheduleName,section:e.section,row:e.row,rawCells:e.cells.map(s=>({column:s.column,text:s.text})),mappedValues:r,identityText:o,comparisonText:i,normalizedKey:a.normalizedKey,tokenProfile:a,visibilityBasis:tt}}function io(e,t,n,r){let o=T(e,"rows"),i=T(e,"cells");return(o.length>0?o:i).flatMap(s=>{let l=mn(c(s,"row"));if(l===null)return[];let u=T(s,"cells").map(m=>({column:mn(c(m,"column")),text:W(c(m,"text"))})).filter(m=>m.column!==null);return[{scheduleId:t,scheduleName:n,section:r,row:l,cells:u}]})}function Md(e,t,n,r){return t.includes("header")?{sections:t,headerAsData:!0}:r==="never"?{sections:t,headerAsData:!1}:ua(e,["header"])?r==="always"?{sections:[...t,"header"],headerAsData:!0}:!n&&!ua(e,t)?{sections:[...t,"header"],headerAsData:!0}:{sections:t,headerAsData:!1}:{sections:t,headerAsData:!1}}function ua(e,t){let n=ao(c(e,"id"))||"unknown",r=sr(c(e,"name"));for(let o of T(e,"sections")){let i=ar(c(o,"section"));if(t.includes(i)&&io(o,n,r,i).some(a=>a.cells.length>0))return!0}return!1}function Nd(e,t){let n=[],r=new Set,o=(i,a)=>{let s=W(a);if(s.length===0)return;let l=`${i}:${Pe(s)}`;r.has(l)||(r.add(l),n.push({column:i,header:s}))};for(let i of Ed(e))o(i.column,i.header);for(let i of T(e,"sections"))if(ar(c(i,"section"))==="header")for(let a of io(i,ao(c(e,"id"))||"unknown",sr(c(e,"name")),"header"))for(let s of a.cells)o(s.column,s.text);for(let i of kd(t))o(i.column,i.header);return n.sort((i,a)=>i.column-a.column)}function Ed(e){let t=[],n=(r,o)=>{if(r===null)return;let i=W(o);i.length>0&&t.push({column:r,header:i})};for(let r of T(e,"fields")){if(c(r,"isHidden")===!0)continue;let o=mn(c(r,"column"))??mn(c(r,"visibleColumn"));n(o,c(r,"columnHeading")),n(o,c(r,"heading")),n(o,c(r,"label")),n(o,c(r,"name")),n(o,c(r,"fieldName")),n(o,c(r,"parameterName"))}return t}function kd(e){if(!e)return[];if(Array.isArray(e))return e.map((n,r)=>typeof n=="string"?{column:r,header:W(n)}:{column:n.column,header:W(n.header)}).filter(n=>n.header.length>0);let t=[];for(let[n,r]of Object.entries(e)){let o=mn(n);if(o!==null&&typeof r=="string"){let i=W(r);i.length>0&&t.push({column:o,header:i});continue}if(typeof r=="number"){let i=W(n);i.length>0&&t.push({column:r,header:i})}}return t.sort((n,r)=>n.column-r.column)}function Pd(e,t){let n=[],r=[],o={},i=new Set;for(let a of no){let s=t?.[a];if(s!==void 0){let l=Ad(s,e);if(l===null)return{error:{role:a,reason:"unresolved_column_ref",value:s}};o[a]=l,i.add(l)}}for(let a of no){if(o[a]!==void 0)continue;let s=Od(a,e);if(s.length===0)continue;let l=Vd(s,i);if(l.kind==="ambiguous")return{error:{role:a,reason:"ambiguous_alias",candidates:l.candidates}};o[a]=l.match.column,i.add(l.match.column)}for(let a of ma)if(o[a]===void 0)return{error:{role:a,reason:"missing_required_role"}};return{mapping:o,warnings:n,notices:r}}function Ad(e,t){if(typeof e=="number")return t.length>0&&!t.some(i=>i.column===e)?null:e;let n=e.trim(),r=Pe(n),o=t.filter(i=>Pe(i.header)===r);return o.length===1?o[0].column:null}function ba(e,t){let n=un(t),r=xd[e];for(let o=0;o<r.length;o++)if(un(r[o])===n)return o;return Number.POSITIVE_INFINITY}function Od(e,t){return t.map(n=>({header:n.header,column:n.column,priority:ba(e,n.header)})).filter(n=>Number.isFinite(n.priority))}function Vd(e,t){let n=e.filter(s=>!t.has(s.column)),r=n.length>0?n:e,o=Math.min(...r.map(s=>s.priority)),i=r.filter(s=>s.priority===o);return i.length===1?{kind:"resolved",match:i[0]}:[...new Set(i.map(s=>s.column))].length===1?{kind:"resolved",match:i[0]}:{kind:"ambiguous",candidates:i.map(s=>s.header)}}function da(e,t){return{sourceKind:e.kind,sections:t,headerDataMode:wa(e.headerDataMode),columnMapping:e.columnMapping||null,numericColumnBase:"zero_based_revit_schedule_column",visibilityBasis:tt}}function ir(e,t,n={}){let{warnings:r=[],notices:o=[],elapsedMs:i,scanPolicy:a,summary:s,suggestedNextScopes:l=[],...u}=n;return we({action:or,reason:e,message:t,elapsedMs:i,extra:{stage:ro,adapterContractVersion:1,visibilityBasis:tt,...u},summary:s||{},evidenceRows:[],scanPolicy:a||{},suggestedNextScopes:l,warnings:r,notices:o})}function Dd(e,t={}){let{warnings:n=[],notices:r=[],elapsedMs:o,scanPolicy:i,summary:a,...s}=t;return Re({action:or,error:e,elapsedMs:o,extra:{stage:ro,adapterContractVersion:1,visibilityBasis:tt,...s},summary:a||{},evidenceRows:[],scanPolicy:i||{},warnings:n,notices:r})}function Sa(e){let t=Array.isArray(e)&&e.length>0?e:wd;return[...new Set(t.map(ar))].filter(n=>["header","body","footer"].includes(n))}function wa(e){return e==="always"||e==="never"?e:"auto"}function ar(e){let t=W(e).toLowerCase();return["header","body","footer"].includes(t)?t:"body"}function bt(e,t){let n=c(e,t);return Array.isArray(n)?n.map(W).filter(r=>r.length>0):[]}function mn(e){if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function ao(e){return sr(e)}function sr(e){let t=W(e);return t.length>0?t:null}import{z as P}from"zod";var pn={score:{exact:100,diceTokenOverlap:35,code:20,dimension:20,order:15,context:10},thresholds:{highConfidenceMin:86,highConfidenceMax:99,candidateMin:65,possibleRenameMin:72,possibleRenameMax:85,ambiguousMin:65,ambiguousMax:71,candidateGap:8,tieGap:8},caps:{conflictingCode:64,conflictingDimension:60,unitMismatch:79},candidateGeneration:{minSharedSignificantWordTokens:2},contextFields:["system","unit","quantity","discipline"]},Fd=P.object({exact:P.number().min(0).max(100).optional(),diceTokenOverlap:P.number().min(0).max(100).optional(),code:P.number().min(0).max(100).optional(),dimension:P.number().min(0).max(100).optional(),order:P.number().min(0).max(100).optional(),context:P.number().min(0).max(100).optional()}).strict(),Ld=P.object({highConfidenceMin:P.number().min(0).max(100).optional(),highConfidenceMax:P.number().min(0).max(100).optional(),candidateMin:P.number().min(0).max(100).optional(),possibleRenameMin:P.number().min(0).max(100).optional(),possibleRenameMax:P.number().min(0).max(100).optional(),ambiguousMin:P.number().min(0).max(100).optional(),ambiguousMax:P.number().min(0).max(100).optional(),candidateGap:P.number().min(0).max(100).optional(),tieGap:P.number().min(0).max(100).optional()}).strict(),jd=P.object({conflictingCode:P.number().min(0).max(100).optional(),conflictingDimension:P.number().min(0).max(100).optional(),unitMismatch:P.number().min(0).max(100).optional()}).strict(),Bd=P.object({minSharedSignificantWordTokens:P.number().int().min(0).max(20).optional()}).strict(),cr=P.object({score:Fd.optional(),thresholds:Ld.optional(),caps:jd.optional(),candidateGeneration:Bd.optional(),contextFields:P.array(P.string().min(1)).optional()}).strict(),zd=P.object({excelRecords:P.array(P.record(P.unknown())).optional(),scheduleRecords:P.array(P.record(P.unknown())).optional(),excelResult:P.record(P.unknown()).optional(),scheduleResult:P.record(P.unknown()).optional(),config:cr.optional()}).strict();function Ia(e){let t=Date.now(),n=zd.safeParse(e);if(!n.success)return pe({success:!0,guarded:!0,state:"guarded",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,reason:"reconciliation_input_required",message:"Provide excelRecords and scheduleRecords, or normalized ingestion result envelopes containing those arrays.",validationIssues:n.error.issues.map(l=>l.message),partial:!1,scanStoppedReason:"needs_scope"},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"needs_scope",elapsedMs:Date.now()-t,summary:{},evidenceRows:[]});let r=Kd(n.data.config),o=xa("excel",n.data.excelRecords??va(n.data.excelResult,"excelRecords")),i=xa("schedule",n.data.scheduleRecords??va(n.data.scheduleResult,"scheduleRecords")),a=qd(o,i,r),s=Zd(o,i,a);return pe({success:!0,guarded:!1,state:"review_ready",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,partial:!1,scanStoppedReason:"completed",reviewRows:a,reviewTable:em(a),suggestedNextActions:["review_ambiguous","accept_match","create_schedule_row","remove_or_ignore_schedule_row","rename_excel_or_schedule_text"],scoringConfig:r},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"completed",elapsedMs:Date.now()-t,summary:s,evidenceRows:a.map(l=>({sourceType:"reconciliationReviewRow",bucket:l.bucket,score:l.score,excelRowId:l.excelRow?.excelRowId??l.excelRow?.recordId??null,scheduleRowId:l.scheduleRow?.scheduleRowId??l.scheduleRow?.recordId??null,reason:l.reason}))})}function qd(e,t,n){let r=[],o=new Set,i=new Set,a=Ra(e),s=Ra(t);for(let l of e){let u=Gd(l,t,n),m=l.normalizedKey.length>0&&(a.has(l.normalizedKey)||s.has(l.normalizedKey)),p=u[0]||null;if(m&&u.some(y=>y.score===n.score.exact||y.schedule.normalizedKey===l.normalizedKey)){let y=u.filter(S=>S.schedule.normalizedKey===l.normalizedKey||S.score>=n.thresholds.candidateMin).slice(0,5);r.push(so("ambiguousMatches",y[0]||null,l,null,y,"duplicate_exact_key","review_ambiguous")),o.add(l.id),y.forEach(S=>i.add(S.schedule.id));continue}if(!p||p.score<n.thresholds.candidateMin&&p.hardConflicts.length===0){r.push($d(l)),o.add(l.id);continue}if(i.has(p.schedule.id)){r.push(so("ambiguousMatches",p,l,p.schedule,u.slice(0,5),"schedule_row_already_claimed","review_ambiguous")),o.add(l.id);continue}let f=Wd(p,u[1]||null,n);r.push(so(f.bucket,p,l,p.schedule,u.slice(0,5),f.reason,f.action)),o.add(l.id),i.add(p.schedule.id),f.bucket==="ambiguousMatches"&&u.filter(y=>y.score>=n.thresholds.candidateMin).slice(0,5).forEach(y=>i.add(y.schedule.id))}for(let l of t)i.has(l.id)||r.push(Xd(l));return r.sort(sm)}function Wd(e,t,n){let r=t?e.score-t.score:Number.POSITIVE_INFINITY,o=t!==null&&e.score===t.score;if(o||r<n.thresholds.tieGap||e.score>=n.thresholds.ambiguousMin&&e.score<=n.thresholds.ambiguousMax)return{bucket:"ambiguousMatches",reason:o?"best_score_tie":r<n.thresholds.tieGap?"candidate_gap_below_threshold":"ambiguous_score_band",action:"review_ambiguous"};if(e.components.exact>0&&e.hardConflicts.length===0&&e.score===n.score.exact)return{bucket:"exactMatches",reason:"exact_normalized_key",action:"accept_match"};let i=(e.sharedCodeTokens.length>0||e.sharedDimensionTokens.length>0)&&e.descriptiveTokensDiffer;return!e.hardConflicts.length&&e.score>=n.thresholds.highConfidenceMin&&i?{bucket:"possibleRenames",reason:"shared_key_tokens_with_description_change",action:"rename_excel_or_schedule_text"}:e.score>=n.thresholds.highConfidenceMin&&e.score<=n.thresholds.highConfidenceMax&&!e.capped&&r>=n.thresholds.candidateGap?{bucket:"highConfidenceMatches",reason:"high_confidence_score_and_gap",action:"accept_match"}:!e.hardConflicts.length&&(e.score>=n.thresholds.highConfidenceMin&&i||e.score>=n.thresholds.possibleRenameMin&&e.score<=n.thresholds.possibleRenameMax)?{bucket:"possibleRenames",reason:i?"shared_key_tokens_with_description_change":"possible_rename_score_band",action:"rename_excel_or_schedule_text"}:{bucket:"ambiguousMatches",reason:e.hardConflicts.length>0?"hard_conflict_requires_review":"requires_review",action:"review_ambiguous"}}function Gd(e,t,n){return t.filter(r=>Jd(e,r,n)).map(r=>({...Hd(e,r,n),excel:e,schedule:r})).sort(am)}function Jd(e,t,n){return e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey||Ae(Q(e,"code"),Q(t,"code")).length>0||Ae(Q(e,"dimension"),Q(t,"dimension")).length>0?!0:Ae(Q(e,"word"),Q(t,"word")).length>=n.candidateGeneration.minSharedSignificantWordTokens}function Hd(e,t,n){let r=e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey,o=zt(e.tokenProfile.tokens.map(S=>S.value)),i=zt(t.tokenProfile.tokens.map(S=>S.value)),a=Ae(o,i),s=zt(o.concat(i).filter(S=>!a.includes(S))),l=Ae(Q(e,"code"),Q(t,"code")),u=Ae(Q(e,"dimension"),Q(t,"dimension")),m=Ud(e,t),p={exact:r?n.score.exact:0,dice:r?0:lr(nm(o,i)*n.score.diceTokenOverlap),code:r?0:Ta(Q(e,"code"),Q(t,"code"),n.score.code),dimension:r?0:Ta(Q(e,"dimension"),Q(t,"dimension"),n.score.dimension),order:r?0:lr(rm(o,i)*n.score.order),context:r?0:tm(e,t,n)},f=r?n.score.exact:lo(p.dice+p.code+p.dimension+p.order+p.context),y=f;for(let S of m)S==="conflicting_code"&&(y=Math.min(y,n.caps.conflictingCode)),S==="conflicting_dimension"&&(y=Math.min(y,n.caps.conflictingDimension)),S==="unit_mismatch"&&(y=Math.min(y,n.caps.unitMismatch));return{score:lo(y),rawScore:lo(f),components:p,matchedTokens:a,differingTokens:s,hardConflicts:m,sharedCodeTokens:l,sharedDimensionTokens:u,descriptiveTokensDiffer:im(e,t),capped:y<f}}function Ud(e,t){let n=[],r=Q(e,"code"),o=Q(t,"code");r.length>0&&o.length>0&&Ae(r,o).length===0&&n.push("conflicting_code");let i=Q(e,"dimension"),a=Q(t,"dimension");i.length>0&&a.length>0&&Ae(i,a).length===0&&n.push("conflicting_dimension");let s=Ca(e),l=Ca(t);return s.length>0&&l.length>0&&Ae(s,l).length===0&&n.push("unit_mismatch"),n}function so(e,t,n,r,o,i,a){return{bucket:e,score:t?.score??0,rawScore:t?.rawScore??0,reason:i,matchedTokens:t?.matchedTokens??[],differingTokens:t?.differingTokens??[],hardConflicts:t?.hardConflicts??[],scoreComponents:t?.components??null,excelRow:n?hn(n):null,scheduleRow:r?hn(r):null,candidateRows:o.map(s=>({score:s.score,rawScore:s.rawScore,scheduleRow:hn(s.schedule),matchedTokens:s.matchedTokens,hardConflicts:s.hardConflicts})),recommendedNextAction:a}}function $d(e){return{bucket:"missingInSchedule",score:0,rawScore:0,reason:"no_schedule_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:hn(e),scheduleRow:null,candidateRows:[],recommendedNextAction:"create_schedule_row"}}function Xd(e){return{bucket:"missingInExcel",score:0,rawScore:0,reason:"no_excel_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:null,scheduleRow:hn(e),candidateRows:[],recommendedNextAction:"remove_or_ignore_schedule_row"}}function hn(e){return{...e.raw,recordId:e.id,normalizedKey:e.normalizedKey,tokenProfile:e.tokenProfile}}function xa(e,t){return Array.isArray(t)?t.filter(n=>!!n&&typeof n=="object"&&!Array.isArray(n)).map((n,r)=>Qd(e,n,r)):[]}function Qd(e,t,n=0){let r=e==="excel"?W(t.excelRowId||t.recordId||t.id):W(t.scheduleRowId||t.recordId||t.id),o=fn(t.mappedValues)?t.mappedValues:{},i=Yd(t,[t.identityText,t.comparisonText]);return{side:e,id:r||`${e}:${i.normalizedKey||"row"}:${n}`,normalizedKey:W(t.normalizedKey)||i.normalizedKey,tokenProfile:i,raw:t,mappedValues:o}}function Yd(e,t){let n=fn(e.tokenProfile)?e.tokenProfile:null;return n&&Array.isArray(n.tokens)&&typeof n.normalizedKey=="string"?{profileVersion:1,normalizedKey:W(n.normalizedKey),tokens:n.tokens.filter(r=>fn(r)&&typeof r.type=="string"&&typeof r.value=="string").map(r=>({type:r.type,value:W(r.value)})).filter(r=>r.value.length>0)}:Ft(t)}function va(e,t){return fn(e)&&Array.isArray(e[t])?e[t].filter(n=>fn(n)):[]}function Kd(e){let t=cr.safeParse(e||{}),n=t.success?t.data:{};return{score:{...pn.score,...n.score||{}},thresholds:{...pn.thresholds,...n.thresholds||{}},caps:{...pn.caps,...n.caps||{}},candidateGeneration:{...pn.candidateGeneration,...n.candidateGeneration||{}},contextFields:n.contextFields||pn.contextFields}}function Zd(e,t,n){let r=Object.fromEntries(["exactMatches","highConfidenceMatches","possibleRenames","ambiguousMatches","missingInSchedule","missingInExcel"].map(o=>[o,0]));for(let o of n)r[o.bucket]=(r[o.bucket]||0)+1;return{excelRows:e.length,scheduleRows:t.length,...r,reviewRowCount:n.length}}function em(e){return{columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}],rows:e.map(n=>({bucket:n.bucket,score:n.score,reason:n.reason,excelRowId:n.excelRow?.excelRowId??n.excelRow?.recordId??"",scheduleRowId:n.scheduleRow?.scheduleRowId??n.scheduleRow?.recordId??"",excelText:n.excelRow?[n.excelRow.identityText,n.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:n.scheduleRow?[n.scheduleRow.identityText,n.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:(n.hardConflicts||[]).join(", "),recommendedNextAction:n.recommendedNextAction}))}}function Q(e,t){return zt(e.tokenProfile.tokens.filter(n=>n.type===t).map(n=>n.value))}function Ca(e){let t=Q(e,"unit");for(let r of Q(e,"dimension")){let o=r.match(/^[A-Z]+|[A-Z]+$/)?.[0];o&&t.push(o)}let n=Dt(e.mappedValues.unit);return n&&t.push(n),zt(t)}function Ta(e,t,n){if(e.length===0||t.length===0)return 0;let r=Ae(e,t).length,o=Math.max(e.length,t.length);return lr(r/o*n)}function tm(e,t,n){let r=n.contextFields.map(i=>[Dt(e.mappedValues[i]),Dt(t.mappedValues[i])]).filter(([i,a])=>i.length>0&&a.length>0);if(r.length===0)return 0;let o=r.filter(([i,a])=>i===a).length;return lr(o/r.length*n.score.context)}function nm(e,t){return e.length===0&&t.length===0?1:e.length===0||t.length===0?0:2*Ae(e,t).length/(e.length+t.length)}function rm(e,t){let n=Math.min(e.length,t.length);return n===0?0:om(e,t)/n}function om(e,t){let n=Array.from({length:e.length+1},()=>Array(t.length+1).fill(0));for(let r=1;r<=e.length;r++)for(let o=1;o<=t.length;o++)n[r][o]=e[r-1]===t[o-1]?n[r-1][o-1]+1:Math.max(n[r-1][o],n[r][o-1]);return n[e.length][t.length]}function im(e,t){let n=Q(e,"word"),r=Q(t,"word");return n.length>0&&r.length>0&&!lm(n,r)}function Ra(e){let t=new Map;for(let n of e)n.normalizedKey.length>0&&t.set(n.normalizedKey,(t.get(n.normalizedKey)||0)+1);return new Set([...t.entries()].filter(([,n])=>n>1).map(([n])=>n))}function am(e,t){return t.score!==e.score?t.score-e.score:e.schedule.id.localeCompare(t.schedule.id)}function sm(e,t){let n={exactMatches:0,highConfidenceMatches:1,possibleRenames:2,ambiguousMatches:3,missingInSchedule:4,missingInExcel:5},r=n[e.bucket]??99,o=n[t.bucket]??99;if(r!==o)return r-o;if((t.score||0)!==(e.score||0))return(t.score||0)-(e.score||0);let i=e.excelRow?.recordId||e.scheduleRow?.recordId||"",a=t.excelRow?.recordId||t.scheduleRow?.recordId||"";return String(i).localeCompare(String(a))}function Ae(e,t){let n=new Set(t);return zt(e.filter(r=>n.has(r)))}function zt(e){return[...new Set(e.filter(t=>W(t).length>0))]}function lm(e,t){let n=new Set(e),r=new Set(t);return n.size!==r.size?!1:[...n].every(o=>r.has(o))}function lr(e){return Math.round(e)}function lo(e){return Math.max(0,Math.min(100,Math.round(e)))}function fn(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var Na="reconcile_schedule_excel",cm=50,St=co.object({excel:to.describe('Excel/CSV source. Use kind:"file" for .xlsx/.csv/.tsv or kind:"rows" for deterministic CI/dry-run records.'),schedule:oo.describe('Schedule source. Use kind:"inspect_schedules_result" with a normalized inspect_schedules result, or kind:"revit_schedule" to read bounded live Revit schedule rows through inspect_schedules before reconciliation.'),config:cr.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),responseMode:Ze,maxReviewRows:co.number().int().positive().max(1e3).optional().describe("Compact-mode cap for returned reviewTable/evidenceRows rows. Defaults 50; full/debug returns all reviewRows."),maxCandidateRows:co.number().int().positive().max(10).optional().describe("Compatibility input for older callers. Compact mode omits nested candidateRows; full/debug returns all candidates.")}).strict();function uo(e,t,n,r={}){let{warnings:o=[],notices:i=[],scanPolicy:a={},summary:s={},suggestedNextScopes:l=[],...u}=r;return we({action:Na,reason:t,message:n,extra:{stage:e,reconciliationContractVersion:1,...u},summary:s,evidenceRows:[],scanPolicy:a,suggestedNextScopes:l,warnings:o,notices:i})}function mo(e,t,n={}){let{warnings:r=[],notices:o=[],scanPolicy:i={},summary:a={},suggestedNextScopes:s=[],...l}=n;return Re({action:Na,error:t,extra:{stage:e,reconciliationContractVersion:1,...l},summary:a,evidenceRows:[],scanPolicy:i,suggestedNextScopes:s,warnings:r,notices:o})}function _a(e){return e.guarded===!0||e.state==="guarded"}function Ma(e){return e.success===!1||e.state==="failed"||!!e.error}function wt(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function um(...e){for(let t of e){let n=String(t.scanStoppedReason||"").trim();if(n&&n!=="completed")return n}return null}var dm={requiredRoles:["identity","comparisonText"],optionalRoles:["code","description","quantity","unit","system","discipline","notes"]},mm={rowsSource:{excel:{kind:"rows",sheetName:"Items",rows:[{Identity:"FCU-101",Description:"Fan coil supply DN100",Unit:"PCS"}],columnMapping:{identity:"Identity",comparisonText:"Description",unit:"Unit"}},schedule:{kind:"inspect_schedules_result",result:{success:!0,schedules:[{id:7001,name:"Mechanical Equipment Schedule",sections:[{section:"header",rows:[{row:0,cells:[{column:0,text:"Identity"},{column:1,text:"Description"}]}]},{section:"body",rows:[{row:1,cells:[{column:0,text:"FCU-101"},{column:1,text:"Fan coil supply DN100"}]}]}]}]}},responseMode:"compact"},fileSource:{excel:{kind:"file",path:"C:\\path\\items.xlsx",format:"xlsx",selection:{sheetName:"Items",headerRow:1,dataStartRow:2},columnMapping:{identity:"Identity",comparisonText:"Description"}},schedule:{kind:"inspect_schedules_result",result:'inspect_schedules result with responseMode="full" when schedule body cells are needed'}}};function pm(e){return[e.bucket,e.reason,e.score,e.excelRow?.excelRowId??e.excelRow?.recordId??"",e.scheduleRow?.scheduleRowId??e.scheduleRow?.recordId??""].join("|")}function hm(e,t){let n=Array.isArray(t.columns)?t.columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}];return{...t,columns:n,rows:e.map(r=>({bucket:r.bucket,score:r.score,reason:r.reason,excelRowId:r.excelRow?.excelRowId??r.excelRow?.recordId??"",scheduleRowId:r.scheduleRow?.scheduleRowId??r.scheduleRow?.recordId??"",excelText:r.excelRow?[r.excelRow.identityText,r.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:r.scheduleRow?[r.scheduleRow.identityText,r.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:Array.isArray(r.hardConflicts)?r.hardConflicts.join(", "):"",recommendedNextAction:r.recommendedNextAction}))}}function fm(e,t){let n=t.responseMode||"compact";if(et(n))return{...e,responseMode:n};let r=ke(t.maxReviewRows,cm,1e3),o=be(e.reviewRows,{limit:r,key:pm}),i=be(e.evidenceRows,{limit:r}),{reviewRows:a,reviewTable:s,scoringConfig:l,sourceSummary:u,...m}=e;return{...m,responseMode:"compact",reviewTable:hm(o.rows,e.reviewTable||{}),evidenceRows:i.rows,summary:{...e.summary||{},compactResponse:!0,reviewRowCount:o.totalCount,returnedReviewRowCount:o.returnedCount,omittedReviewRowCount:o.omittedCount,duplicateReviewRowCount:o.duplicateCount,evidenceRowCount:i.totalCount,returnedEvidenceRowCount:i.returnedCount,omittedEvidenceRowCount:i.omittedCount},notices:[...wt(e.notices),'Compact response returns summary, reviewTable, evidenceRows, and count metadata only. Use responseMode="full" for reviewRows, token profiles, raw cells, and nested candidates.']}}async function gm(e,t={}){let n=St.safeParse(e);if(!n.success)return uo("input_validation","reconciliation_input_required","Provide excel and schedule sources before reconciliation.",{validationIssues:n.error.issues.map(l=>`${l.path.join(".")||"<root>"}: ${l.message}`),requiredColumnMapping:dm,schemaExamples:mm,suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText","schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let r=await la(n.data.excel);if(_a(r))return uo("excel_ingestion",r.reason||"excel_ingestion_guarded",r.message||"Excel ingestion was guarded before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});if(Ma(r))return mo("excel_ingestion",r.error||"Excel ingestion failed before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});let o=await ga(n.data.schedule,t.scheduleAdapter);if(_a(o))return uo("schedule_record_adapter",o.reason||"schedule_adapter_guarded",o.message||"Schedule adaptation was guarded before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});if(Ma(o))return mo("schedule_record_adapter",o.error||"Schedule adaptation failed before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});let i=Ia({excelResult:r,scheduleResult:o,config:n.data.config}),a=r.partial===!0||o.partial===!0,s=a&&um(o,r)||i.scanStoppedReason;return fm({...i,partial:i.partial===!0||a,scanStoppedReason:s,scanPolicy:{...i.scanPolicy||{},excel:r.scanPolicy||{},schedule:o.scanPolicy||{}},warnings:[...wt(i.warnings),...wt(r.warnings),...wt(o.warnings)],notices:[...wt(i.notices),...wt(r.notices),...wt(o.notices)],sourceSummary:{excel:r.summary||{},schedule:o.summary||{}},sourceResults:{excel:{sourceKind:r.sourceKind,format:r.format,sheetName:r.sheetName,partial:r.partial,scanStoppedReason:r.scanStoppedReason,recordCount:Array.isArray(r.excelRecords)?r.excelRecords.length:0},schedule:{sourceKind:o.sourceKind,visibilityBasis:o.visibilityBasis,partial:o.partial,scanStoppedReason:o.scanStoppedReason,recordCount:Array.isArray(o.scheduleRecords)?o.scheduleRecords.length:0}}},n.data)}function Ea(e){e.tool("reconcile_schedule_excel",'[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus either normalized inspect_schedules output or bounded live revit_schedule input, normalizes rows, scores deterministic matches, and returns compact review tables by default. excel.kind="rows" expects an object with rows:[...] plus columnMapping.identity and columnMapping.comparisonText; file sources use path/format/selection with the same required mapping. schedule.kind="revit_schedule" requires scheduleIds or nameQuery unless allowExpensiveSearch=true. schedule.columnHeaders can be an index-ordered string array, an array of {column, header} objects, or a header/index map; explicit headers override native header labels for string columnMapping resolution. If Body has no readable rows, headerDataMode="auto" reads Header section rows as schedule data and reports that fallback; use headerDataMode="never" to disable or "always" to force it. Default responseMode=compact returns summary, reviewTable, evidenceRows, and count metadata only; use responseMode=full/debug for reviewRows, token profiles, raw cells, and nested candidateRows. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.',{excel:St.shape.excel,schedule:St.shape.schedule,config:St.shape.config,responseMode:St.shape.responseMode,maxReviewRows:St.shape.maxReviewRows,maxCandidateRows:St.shape.maxCandidateRows},async(t={})=>{try{return h(await gm(t))}catch(n){return h(mo("runtime_failure",n instanceof Error?n.message:String(n)))}})}import{z as E}from"zod";var ym={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxMatches:1e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxMatches:5e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxMatches:2e4}},dr=["sheetQuery","sheetIds","viewNameQuery","sources","profiles","countMode","groupBy","maxSheets","maxViewports","maxMatches","maxResponseBytes","allowExpensiveSearch"];function ue(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function ka(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=ym[t],r=ue(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=ue(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxMatches:ue(e.maxMatches,n.maxMatches,1,2e5)}}function bm(e){let t=String(e??"").trim();return/^sheet_?text_?notes?$/i.test(t)||/^sheetTextNotes?$/i.test(t)?"sheet_text_notes":/^viewport_?tags?$/i.test(t)||/^viewportTags?$/i.test(t)?"viewport_tags":/^viewport_?text_?notes?$/i.test(t)||/^viewportTextNotes?$/i.test(t)||/^view_?text_?notes?$/i.test(t)||/^viewTextNotes?$/i.test(t)?"viewport_text_notes":/^placed_?schedule_?cells?$/i.test(t)||/^placedScheduleCells?$/i.test(t)||/^schedule_?cells?$/i.test(t)||/^scheduleCells?$/i.test(t)?"placed_schedule_cells":t}function xt(e){let t=String(e??"").trim();return/^unique_?text$/i.test(t)?"uniqueText":/^unique_?tag$/i.test(t)?"uniqueTag":/^unique_?tagged_?element$/i.test(t)?"uniqueTaggedElement":"occurrence"}function Pa(e){return e==="uniqueTag"||e==="uniqueTaggedElement"}function ur(e,t,n,r){return e==="deep"?r:e==="balanced"?n:t}function po(e){let t=xt(e.countMode),n=Array.isArray(e.sources)?e.sources:[],r=[...new Set(n.map(bm).filter(o=>o.length>0))];return r.length>0?r:Pa(t)?["viewport_tags"]:["sheet_text_notes","viewport_text_notes","placed_schedule_cells","viewport_tags"]}function Sm(e){return Array.isArray(e.sources)&&e.sources.length>0}function Aa(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||"").trim())}function ho(e){let t=ka(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,sources:po(e),countMode:xt(e.countMode),groupBy:Array.isArray(e.groupBy)?e.groupBy:[],maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,maxSheets:ue(e.maxSheets,30,1,200),maxViewportsPerSheet:ue(e.maxViewportsPerSheet??e.maxViewports,20,0,200),maxTextNotesScanned:ue(e.maxTextNotesScanned,ur(t.searchBudget,1e3,5e3,2e4),1,2e5),maxTagsScanned:ue(e.maxTagsScanned??e.maxTags,ur(t.searchBudget,500,2500,1e4),1,1e5),maxScheduleInstancesPerSheet:ue(e.maxScheduleInstancesPerSheet,20,0,200),maxRowsPerSchedule:ue(e.maxRowsPerSchedule,250,1,2e3),maxColumnsPerSchedule:ue(e.maxColumnsPerSchedule,20,1,200),maxScheduleInstancesScanned:ue(e.maxScheduleInstancesScanned,ur(t.searchBudget,200,1e3,5e3),1,2e4),maxScheduleCellsScanned:ue(e.maxScheduleCellsScanned,ur(t.searchBudget,1e3,5e3,2e4),1,2e5),maxMatches:t.maxMatches,maxTextChars:ue(e.maxTextChars,240,1,1e3),maxRegexPatternLength:ue(e.maxRegexPatternLength,240,1,1e3),regexTimeoutMs:ue(e.regexTimeoutMs,25,1,250),maxResponseBytes:ue(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),sheetScoped:Aa(e)}}function wm(e,t){return{query:e.query,regex:e.regex,normalizedRegex:e.normalizedRegex,matchMode:e.matchMode,sheetQuery:e.sheetQuery,sheetIds:e.sheetIds,viewNameQuery:e.viewNameQuery,sources:po(e),profiles:e.profiles,profileName:e.profileName,countMode:xt(e.countMode),groupBy:e.groupBy,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSheets:e.maxSheets,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxTags:e.maxTags,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxMatches:t.maxMatches,maxTextChars:e.maxTextChars,maxRegexPatternLength:e.maxRegexPatternLength,regexTimeoutMs:e.regexTimeoutMs,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Count Revit annotations",taskId:e.taskId}}function mr(e){let t=String(c(e,"sourceType")||""),n=String(c(e,"kind")||""),r=[t,n];return r.some(o=>o==="viewportTag"||o==="viewport_tags")?"viewportTag":r.some(o=>o==="viewportTextNote"||o==="viewport_text_notes")?"viewportTextNote":r.some(o=>o==="sheetTextNote"||o==="sheet_text_notes")?"sheetTextNote":r.some(o=>o==="placedScheduleCell"||o==="placed_schedule_cells"||o==="scheduleCell")?"placedScheduleCell":t||n||"annotation"}function pr(e){let t=T(e,"evidenceRows");return(t.length>0?t:T(e,"matches")).map(r=>({...r,sourceType:mr(r)}))}function xm(e){let t=String(e??"").trim();return/^source_?type$/i.test(t)?"sourceType":/^(profile|profileName)$/i.test(t)?"profile":/^(pattern|patternName)$/i.test(t)?"pattern":/^(matchedCode|matchedText|uniqueText)$/i.test(t)?"matchedText":/^tagFamilyType$/i.test(t)?"tagFamilyType":/^(taggedElement|taggedElementId)$/i.test(t)?"taggedElement":/^view$/i.test(t)?"view":/^sheet$/i.test(t)?"sheet":t}function vm(e,t){let n={};if(t.length===0)return n.group="all",n;for(let r of t){let o=xm(r);o==="sheet"?(n.sheetId=c(e,"sheetId")??null,n.sheetNumber=c(e,"sheetNumber")??null):o==="view"?(n.viewId=c(e,"viewId")??null,n.viewName=c(e,"viewName")??null):o==="sourceType"?n.sourceType=mr(e):o==="profile"?n.profileName=c(e,"profileName")??null:o==="pattern"?n.patternName=c(e,"patternName")??null:o==="matchedText"?n.matchedTextNormalized=c(e,"matchedTextNormalized")??null:o==="tagFamilyType"?(n.tagFamilyName=c(e,"tagFamilyName")??null,n.tagTypeName=c(e,"tagTypeName")??null):o==="taggedElement"&&(n.taggedElementId=c(e,"taggedElementId")??null)}return Object.keys(n).length===0&&(n.group="all"),n}function Cm(e){return Object.keys(e).sort().map(t=>`${t}=${String(e[t]??"")}`).join("|")}function Tm(e,t){let n=mr(e);if(t==="occurrence")return"";if(t==="uniqueText")return`profile:${String(c(e,"profileName")??"").trim()}|text:${String(c(e,"matchedTextNormalized")??c(e,"textNormalized")??"").trim()}`;if(t==="uniqueTag"){if(n!=="viewportTag")return"";let r=String(c(e,"tagId")??"").trim();return r?`tag:${r}`:""}if(t==="uniqueTaggedElement"){if(n!=="viewportTag")return"";let r=c(e,"taggedElementResolved"),o=String(c(e,"taggedElementId")??"").trim();return!r||!o?"":`taggedElement:${o}`}return""}function Oa(e,t,n){let r=new Map,o=new Set,i=0,a=0,s=e.map(l=>{let u={...l,sourceType:mr(l)},m=vm(u,n),p=Cm(m),f=r.get(p);f||(f={groupKey:p,...m,count:0,occurrenceCount:0,evidenceRowCount:0},r.set(p,f)),f.occurrenceCount+=1,f.evidenceRowCount+=1;let y=t==="occurrence"?`occurrence:${a++}`:Tm(u,t),S=!!y&&!o.has(`${p}||${y}`);return S&&(o.add(`${p}||${y}`),f.count+=1,i+=1),{...u,groupKey:p,countKey:y,counted:S,countMode:t}});return{count:i,evidenceRows:s,groups:[...r.values()].sort((l,u)=>String(l.groupKey).localeCompare(String(u.groupKey)))}}function Va(e,t){let n=Pt(e,"scanPolicy"),r=c(n,"groupBy")??c(e,"groupBy")??t?.groupBy;return Array.isArray(r)?r.map(String):[]}function Da(e,t){return xt(c(e,"countMode")??c(Pt(e,"summary"),"countMode")??t?.countMode)}function Fa(e,t){let n=pr(e),r=Da(e,t),o=Oa(n,r,Va(e,t));return{count:c(e,"count")??o.count,countMode:r,occurrenceCount:c(e,"matchedOccurrenceCount")??o.evidenceRows.length,matchCount:o.evidenceRows.length,evidenceRowCount:o.evidenceRows.length,groupCount:T(e,"groups").length||o.groups.length,scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed"}}function Rm(e){let t=pr(e),n=t.length>0?t[t.length-1]:null;return{lastReadSection:c(e,"lastReadSection")??null,lastReadRow:c(e,"lastReadRow")??null,lastReadColumn:c(e,"lastReadColumn")??null,lastReadSheetId:c(n,"sheetId")??c(e,"lastReadSheetId")??null,lastReadViewId:c(n,"viewId")??c(e,"lastReadViewId")??null,lastReadViewportId:c(n,"viewportId")??c(e,"lastReadViewportId")??null,lastReadItemId:c(n,"tagId")??c(n,"elementId")??c(n,"scheduleInstanceId")??c(n,"scheduleId")??c(n,"id")??c(e,"lastReadItemId")??null}}function Im(e,t){let n=Da(e,t),r=Oa(pr(e),n,Va(e,t)),o=T(e,"groups");return e.countMode=n,e.evidenceRows=r.evidenceRows,e.matches=T(e,"matches").length>0?T(e,"matches"):e.evidenceRows,e.groups=o.length>0?o:r.groups,e.count=c(e,"count")??c(e.summary,"count")??r.count,e.summary={...Fa(e,t),...Pt(e,"summary")||{},count:c(e.summary,"count")??e.count,countMode:n,matchCount:c(e.summary,"matchCount")??e.evidenceRows.length,groupCount:c(e.summary,"groupCount")??e.groups.length},e}function _m(e,t={},n){return Im(pe(e,{action:"count_annotations",elapsedMs:n,scanPolicy:ho(t),summary:r=>Fa(r,t),evidenceRows:pr,lastRead:Rm,suggestedNextScopes:dr}),t)}function Mm(e,t){return we({action:"count_annotations",reason:"needs_scope",message:"Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:dr,scanPolicy:ho({...e,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs}),summary:{count:0,countMode:xt(e.countMode),matchCount:0,groupCount:0}})}function Nm(e){return we({action:"count_annotations",reason:"invalid_count_mode_for_sources",message:"uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",suggestedNextScopes:dr,scanPolicy:ho(e),summary:{count:0,countMode:xt(e.countMode),matchCount:0,groupCount:0}})}function La(e){e.tool("count_annotations","[ANNOTATION_COUNT_READ_ONLY] Read-only native Revit annotation inventory/count for DrawingSheet text notes, viewport text notes, placed schedule cells, and viewport tag evidence. Use sheetQuery/sheetIds first; project-wide annotation counts require allowExpensiveSearch=true. Supports occurrence, uniqueText, uniqueTag, and uniqueTaggedElement count modes with bounded regex profiles.",{...w(E),...x(E),query:E.string().optional().describe("Anonymous text query. Defaults to contains matching unless matchMode is supplied."),regex:E.string().optional().describe("Anonymous raw regex pattern. Regex matching is bounded by maxRegexPatternLength and regexTimeoutMs."),normalizedRegex:E.string().optional().describe("Anonymous regex pattern evaluated against normalized annotation text."),matchMode:E.enum(["exact","contains","startsWith","regex","normalizedRegex"]).optional().describe("Match mode for query when using the anonymous profile."),profileName:E.string().optional().describe("Optional anonymous profile name when query/regex is used without profiles."),profiles:E.array(E.any()).optional().describe("Explicit profile objects with profileName/name and patterns. Patterns support exact, contains, startsWith, regex, and normalizedRegex."),sheetQuery:E.string().optional().describe("Sheet number/name scope. Use this first in large projects."),sheetIds:E.array(E.union([E.number(),E.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),viewNameQuery:E.string().optional().describe("Optional placed-view name filter before viewport tag inspection."),sources:E.array(E.enum(["sheet_text_notes","viewport_text_notes","viewport_text_note","placed_schedule_cells","placed_schedule_cell","viewport_tags","sheetTextNotes","viewportTextNotes","viewportTextNote","view_text_notes","viewTextNotes","placedScheduleCells","placedScheduleCell","schedule_cells","schedule_cell","scheduleCells","scheduleCell","viewportTags"])).optional().describe("Annotation sources. Defaults to sheet_text_notes + viewport_text_notes + placed_schedule_cells + viewport_tags except tag-specific count modes, which default to viewport_tags."),countMode:E.enum(["occurrence","uniqueText","uniqueTag","uniqueTaggedElement"]).optional().describe("Count semantics. Tag-specific modes require viewport_tags as the only explicit source."),groupBy:E.array(E.enum(["sheet","view","sourceType","profile","profileName","pattern","patternName","matchedText","matchedCode","tagFamilyType","taggedElement","taggedElementId"])).optional().describe("Optional grouping dimensions for count rows."),allowExpensiveSearch:E.boolean().optional().describe("Explicit approval for project-wide sheet and placed-view annotation counting without sheetIds/sheetQuery. Defaults false."),searchBudget:E.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:E.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),maxSheets:E.number().int().positive().max(200).optional().describe("Maximum matching sheets to inspect. Defaults 30."),maxViewportsPerSheet:E.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:E.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet."),maxTextNotesScanned:E.number().int().positive().max(2e5).optional().describe("Global native cap across sheet text notes."),maxScheduleInstancesPerSheet:E.number().int().min(0).max(200).optional().describe("Maximum placed schedule instances inspected per sheet. Defaults 20."),maxRowsPerSchedule:E.number().int().positive().max(2e3).optional().describe("Maximum body rows scanned per placed schedule. Defaults 250."),maxColumnsPerSchedule:E.number().int().positive().max(200).optional().describe("Maximum body columns scanned per placed schedule. Defaults 20."),maxScheduleInstancesScanned:E.number().int().positive().max(2e4).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:E.number().int().positive().max(2e5).optional().describe("Global native cap across placed schedule body cells before scanStoppedReason=max_cells."),maxTags:E.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:E.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxMatches:E.number().int().positive().max(2e5).optional().describe("Maximum returned matching evidence rows before scanStoppedReason=max_items."),maxTextChars:E.number().int().min(1).max(1e3).optional().describe("Maximum characters retained and matched per annotation candidate. Defaults 240."),maxRegexPatternLength:E.number().int().min(1).max(1e3).optional().describe("Maximum regex pattern length. Defaults 240."),regexTimeoutMs:E.number().int().min(1).max(250).optional().describe("Per-candidate regex timeout in milliseconds. Defaults 25."),maxResponseBytes:E.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:E.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=ka(t),o=po(t),i=xt(t.countMode);if(Pa(i)&&Sm(t)&&o.some(s=>s!=="viewport_tags"))return h(Nm(t));if(!Aa(t)&&t.allowExpensiveSearch!==!0)return h(Mm(t,r));let a=await _("count_annotations",wm(t,r),{...I({...t,timeoutMs:r.timeoutMs},"Count Revit annotations"),toolName:"count_annotations"});return h(_m(a&&a.result?a.result:a,t,Date.now()-n))}catch(r){return h(Re({action:"count_annotations",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:dr}))}})}import{z as Ie}from"zod";function Em(e){let t=zn(e.elementIds||[]),n=M(e.category||""),r=Number.isFinite(e.sampleLimit)?Math.max(1,Math.min(25,e.sampleLimit)):5,o=e.includeTypeParameters===!0?"true":"false",i=Ee(e.parameterNameFilter||[]),a=e.parameterNameMatchMode==="exact"?"exact":"contains";return`
int[] explicitElementIds = ${t};
string categoryName = ${n};
int sampleLimit = ${r};
bool includeTypeParameters = ${o};
string[] parameterNameFilter = ${i};
string parameterNameMatchMode = "${a}";

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
}`}function km(e){return!e||typeof e!="object"?{}:{source:e.source,displayBuiltInParameter:e.displayBuiltInParameter,builtInParameterId:e.builtInParameterId,rawBuiltInParameterAlias:e.rawBuiltInParameterAlias,storageType:e.storageType,isShared:e.isShared,isReadOnly:e.isReadOnly,dataType:e.dataType,unitType:e.unitType,noValueState:e.noValueState,clearability:e.clearability}}function Pm(e,t){if(t.parameterNameMatchMode!=="exact"||!e||typeof e!="object"||!Array.isArray(e.elements))return e;let n=[],r=Array.isArray(e.warnings)?[...e.warnings]:[];for(let o of e.elements){let i=Array.isArray(o?.parameters)?o.parameters:[],a=new Map;for(let s of i){let l=typeof s?.name=="string"?s.name.trim():"";if(!l)continue;let u=l.toLocaleLowerCase("en-US");a.has(u)||a.set(u,{name:l,matches:[]}),a.get(u)?.matches.push(s)}for(let s of a.values()){if(s.matches.length<2)continue;let l={elementId:o?.id,parameterName:s.name,count:s.matches.length,severity:"write_preflight_warning",message:`Duplicate display name '${s.name}' matched ${s.matches.length} parameters on element ${o?.id}. Display name alone is ambiguous for write-back; choose by source, builtInParameterId, shared flag, storage type, or read-only state.`,matches:s.matches.map(km)};n.push(l),r.push(`duplicate_display_name: elementId=${o?.id}; parameterName=${s.name}; count=${s.matches.length}; display name alone is ambiguous for write-back.`)}}return n.length===0?e:{...e,warnings:r,duplicateDisplayNameWarnings:n}}function ja(e){e.tool("inspect_parameter_schema","Read-only parameter schema inspection for selected ids or a category sample: user-facing BIP display label/id, raw enum alias, storage type, unit type, shared/read-only flags, raw/display values, no-value state, and clearability metadata.",{...w(Ie),...x(Ie),elementIds:Ie.array(Ie.union([Ie.number(),Ie.string()])).optional().describe("Element ids to inspect."),category:Ie.string().optional().describe("BuiltInCategory name such as OST_DuctCurves or OST_DuctTerminal."),sampleLimit:Ie.number().int().positive().max(25).optional().describe("Maximum sample elements. Defaults 5."),includeTypeParameters:Ie.boolean().optional().describe("Include type parameters. Defaults false."),parameterNameFilter:Ie.array(Ie.string()).optional().describe("Optional parameter name filters."),parameterNameMatchMode:Ie.enum(["contains","exact"]).optional().describe("Filter matching mode. contains is discovery mode and default; exact is write-preflight mode.")},async t=>{if((!t.elementIds||t.elementIds.length===0)&&!t.category)return h({success:!0,matchMode:t.parameterNameMatchMode==="exact"?"exact":"contains",sampleCount:0,elements:[],warnings:["Provide elementIds or category."]});try{let n=await K(Em(t),{...I(t,"Inspect Revit parameter schema"),transactionMode:"none"}),r=n&&n.result?n.result:n;return h(Pm(r,t))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as X}from"zod";function za(e){return e==="clear"?"clear":e==="clearVisibleValue"?"clearVisibleValue":"set"}function Ba(e){return typeof e=="boolean"?e?"true":"false":String(e??"")}async function Am(e,t){if(e.elementId!==void 0&&e.elementId!==null&&String(e.elementId).trim()!==""){let n=Number.parseInt(String(e.elementId),10);return Number.isFinite(n)&&n>0?n:null}if(e.useSelection===!0){let n=await _t(2,t);return n.length===1?n[0]:{...De({action:"set_element_parameter",reason:"single_selection_required",error:n.length===0?"No selected Revit element was found. Provide elementId or select exactly one element.":"Multiple selected elements were found. Provide one explicit elementId for a production parameter write."}),tool:"set_element_parameter",guardReason:"single_selection_required",selectedElementIds:n}}return null}function Om(e,t){let n=za(e.operation),r=M(e.parameterName||""),o=M(e.parameterSource||"instance"),i=M(n==="clearVisibleValue"?"":Ba(e.value)),a=M(e.valueMode||"raw"),s=M(e.mode==="commit"?"commit":"dryRun"),l=M(n),u=e.value===void 0||e.value===null?"false":"true",m=Number.isInteger(e.builtInParameterId)?String(e.builtInParameterId):"null",p=M(e.expectedStorageType||""),f=M(e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"":Ba(e.expectedCurrentRaw)),y=e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"false":"true",S=e.allowTypeParameterWrite===!0?"true":"false";return`
int elementId = ${t};
string parameterName = ${r};
string parameterSource = ${o};
string requestedValueText = ${i};
string valueMode = ${a};
string mode = ${s};
string operation = ${l};
int? expectedBuiltInParameterId = ${m};
string expectedStorageType = ${p};
bool hasExpectedCurrentRaw = ${y};
string expectedCurrentRaw = ${f};
bool allowTypeParameterWrite = ${S};
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
}`}function qa(e){e.tool("set_element_parameter","[PRODUCTION_PARAMETER_WRITE] Safely set, true-clear, or visibly clear one Revit element parameter after exact inspect_parameter_schema-style identity resolution. Never writes by visible display name alone: duplicate display names, read-only parameters, identity mismatch, unsupported clear/no-value attempts, and unapproved type-parameter writes are guarded. operation=clear uses Revit Parameter.ClearValue only for parameter kinds that can restore a true no-value state and never fakes no-value restore by writing an empty string. operation=clearVisibleValue is an explicit string-only visible cleanup path that writes an empty string and reports that Revit may keep HasValue=true. Defaults to dryRun; use mode=commit only for an explicitly confirmed write, then the tool reads the parameter back for verification.",{...w(X),...x(X),elementId:X.union([X.number(),X.string()]).optional().describe("Target Revit ElementId. Preferred for production writes."),useSelection:X.boolean().optional().describe("When true, use the current Revit selection only if exactly one element is selected. Defaults false."),parameterName:X.string().describe("Exact visible parameter name used only for schema preflight. The tool enumerates matching parameters and blocks duplicates; it does not use LookupParameter as a direct write shortcut."),parameterSource:X.enum(["instance","type"]).optional().default("instance").describe("Write an instance parameter by default. Type parameters require allowTypeParameterWrite=true in commit mode."),builtInParameterId:X.number().int().optional().describe("Optional stable BuiltInParameter integer from inspect_parameter_schema. If supplied, it must match the exact display-name result."),expectedStorageType:X.enum(["String","Integer","Double","ElementId"]).optional().describe("Optional storage-type guard from inspect_parameter_schema."),expectedCurrentRaw:X.union([X.string(),X.number(),X.boolean()]).optional().describe("Optional compare-and-set guard. Commit is blocked if the current raw value differs."),operation:X.enum(["set","clear","clearVisibleValue"]).optional().default("set").describe("set writes the supplied value. clear uses Revit Parameter.ClearValue only when the parameter kind supports true no-value restore and never falls back to writing an empty string. clearVisibleValue explicitly writes an empty string to a String parameter and may leave HasValue=true."),value:X.union([X.string(),X.number(),X.boolean()]).optional().describe("Requested value for operation=set. String writes use the text as-is; Integer accepts number/true/false; Double defaults to raw Revit internal units; ElementId accepts an integer id."),valueMode:X.enum(["raw","valueString"]).optional().default("raw").describe("For Double parameters, raw writes internal Revit units. valueString uses Parameter.SetValueString with project units."),mode:X.enum(["dryRun","commit"]).optional().default("dryRun").describe("dryRun performs schema/convertibility checks only. commit writes inside the wrapper transaction and verifies readback."),allowTypeParameterWrite:X.boolean().optional().default(!1).describe("Required to commit a type-parameter write because it can affect all instances of that type."),timeoutMs:X.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults to the runtime default.")},async t=>{let n=se(t);try{let r=await Am(t,n);if(!r||typeof r=="object")return h(r||{...De({action:"set_element_parameter",reason:"element_id_required",error:"Provide elementId or set useSelection=true with exactly one selected element."}),guardReason:"element_id_required",tool:"set_element_parameter"});let o=t.mode==="commit"?"commit":"dryRun",i=za(t.operation);if(i==="set"&&(t.value===void 0||t.value===null))return h({...De({action:"set_element_parameter",reason:"value_required",error:"value is required when operation=set. Use operation=clear only when you intentionally want to restore a true no-value state, or operation=clearVisibleValue when a visible empty string is acceptable."}),guardReason:"value_required",tool:"set_element_parameter",mode:o,operation:i});let a=await K(Om(t,r),{...n,...ge(t,o==="commit"?i==="clear"?"Clear Revit element parameter":i==="clearVisibleValue"?"Visibly clear Revit element parameter":"Set Revit element parameter":i==="clear"?"Dry-run Revit element parameter clear":i==="clearVisibleValue"?"Dry-run visible Revit element parameter clear":"Dry-run Revit element parameter write"),transactionMode:o==="commit"?"auto":"none"});return h(a&&a.result?a.result:a)}catch(r){return h(Ce({action:"set_element_parameter",error:r instanceof Error?r.message:String(r),extra:{tool:"set_element_parameter"}}))}})}import{z as he}from"zod";function Wa(e){return`new int[] { ${e.map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function Vm(e){return`new bool[] { ${e.map(t=>t?"true":"false").join(", ")} }`}function Dm(e){return(Array.isArray(e.cells)?e.cells:[]).slice(0,200).map(n=>({row:Math.max(0,Number.parseInt(String(n.row),10)||0),column:Math.max(0,Number.parseInt(String(n.column),10)||0),value:String(n.value??""),hasExpectedCurrentText:n.expectedCurrentText!==void 0&&n.expectedCurrentText!==null,expectedCurrentText:String(n.expectedCurrentText??"")}))}function Fm(e){let t=Number.parseInt(String(e.scheduleId),10),n=Dm(e),r=M(e.section),o=M(e.mode==="commit"?"commit":"dryRun"),i=e.allowCurrentMismatch===!0?"true":"false";return`
int scheduleId = ${Number.isFinite(t)?t:0};
string requestedSection = ${r};
string mode = ${o};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowCurrentMismatch = ${i};
int[] rows = ${Wa(n.map(a=>a.row))};
int[] columns = ${Wa(n.map(a=>a.column))};
string[] requestedValues = ${Ee(n.map(a=>a.value))};
bool[] hasExpectedCurrentTexts = ${Vm(n.map(a=>a.hasExpectedCurrentText))};
string[] expectedCurrentTexts = ${Ee(n.map(a=>a.expectedCurrentText))};

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

object CellResult(int index, int row, int column, string requestedValue, string beforeValue, string afterValue, bool readable, bool changed, bool verified, bool blocked, string reason, string error)
{
    return new {
        index = index,
        row = row,
        column = column,
        requestedValue = requestedValue,
        before = beforeValue,
        after = afterValue,
        readable = readable,
        changed = changed,
        verified = verified,
        blocked = blocked,
        reason = reason,
        error = error
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

        if (!blocked && cellWouldChange) wouldChangeCount++;
        planned.Add(CellResult(i, row, column, requestedValue, before, before, readable, cellWouldChange, false, blocked, reason, error));
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
        committedChanges.Add(CellResult(i, row, column, requestedValue, before, after, readableBefore, changed, verified, !verified, verified ? "" : "verification_failed", writeError));
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
}`}function Ga(e){e.tool("set_schedule_cells","[PRODUCTION_SCHEDULE_CELL_WRITE] Writes exact Revit schedule cells by scheduleId, section, row, and column. Defaults to dryRun, blocks mismatched expectedCurrentText, guards non-writable standard schedule body cells as non_writable_standard_body_cell, and verifies committed values. Schedule cell text writes are not a raw-code reason: use this after inspect_schedules has found exact row/column coordinates for renumbering, title/spec/mark edits, key schedule/header/footer cells, or other direct cell text updates. Do not use this for visual schedule formatting such as borders, merges, colors, row heights, column widths, or placed schedule movement.",{...w(he),...x(he),scheduleId:he.union([he.number(),he.string()]).describe("Exact ViewSchedule element id. Schedule names are not accepted for writes."),section:he.enum(["header","body","footer"]).describe("Exact schedule section containing the target cells."),cells:he.array(he.object({row:he.number().int().min(0).describe("Zero-based row index in the selected schedule section."),column:he.number().int().min(0).describe("Zero-based column index in the selected schedule section."),value:he.string().describe("Target cell text."),expectedCurrentText:he.string().optional().describe("Optional exact preflight value. Commit is blocked if current text differs unless allowCurrentMismatch=true.")})).min(1).max(200).describe("Exact cells to update. Use inspect_schedules first to discover row/column coordinates."),mode:he.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes schedule cell text in one Revit transaction."),allowCurrentMismatch:he.boolean().optional().describe("Defaults false. Keep false for production writes so stale row/column targets are blocked."),timeoutMs:he.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=await K(Fm(t),{...se(t),...ge(t,n==="commit"?"Set Revit schedule cells":"Preview Revit schedule cell changes"),toolName:"set_schedule_cells",transactionMode:n==="commit"?"auto":"none"});return h(r&&r.result?r.result:r)}catch(n){return h(Ce({action:"set_schedule_cells",reason:"set_schedule_cells_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as D}from"zod";var Lm=25;function Ja(e,t=100){return(Array.isArray(e)?e:[]).slice(0,t).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n))}function Ha(e){return`new int[] { ${e.join(", ")} }`}function jm(e){let t=[];if(typeof e.rowTextQuery=="string"&&e.rowTextQuery.trim()&&t.push(e.rowTextQuery.trim()),Array.isArray(e.rowTextQueries))for(let n of e.rowTextQueries){let r=String(n??"").trim();r&&t.push(r)}return[...new Set(t)].slice(0,20)}function Bm(e,t){let n=Array.isArray(e)?[...new Set(e.map(r=>String(r??"").trim()).filter(r=>r.length>0))]:[];return{rows:n.slice(0,t),totalCount:Array.isArray(e)?e.length:0,uniqueCount:n.length,returnedCount:Math.min(n.length,t),omittedCount:Math.max(0,n.length-t)}}function zm(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||et(n))return{...e,responseMode:n};let r=ke(t.maxResultRows,Lm,500),o=be(e.matches,{limit:r}),i=be(e.changes,{limit:r}),a=Bm(e.errors,r),s={...e,responseMode:"compact",compactResponse:!0,maxReturnedRows:r};return Array.isArray(e.matches)&&(s.matches=o.rows,s.returnedMatchCount=o.returnedCount,s.omittedMatchCount=o.omittedCount,s.duplicateMatchCount=o.duplicateCount),Array.isArray(e.changes)&&(s.changes=i.rows,s.returnedChangeCount=i.returnedCount,s.omittedChangeCount=i.omittedCount,s.duplicateChangeCount=i.duplicateCount),Array.isArray(e.errors)&&(s.errors=a.rows,s.returnedErrorCount=a.returnedCount,s.omittedErrorCount=a.omittedCount),s.notices=[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds matches/changes/errors. Use responseMode="full" for all row details.'],s}function qm(e){let t=Ja(e.scheduleIds,200),n=Ja(e.sheetIds,200),r=jm(e),o=Number.parseInt(String(e.targetColumn),10),i=Math.max(1,Math.min(Number.parseInt(String(e.maxSchedules??20),10)||20,200)),a=Math.max(1,Math.min(Number.parseInt(String(e.maxRowsPerSchedule??250),10)||250,2e3)),s=Math.max(1,Math.min(Number.parseInt(String(e.maxColumnsPerSchedule??80),10)||80,300)),l=Math.max(1,Math.min(Number.parseInt(String(e.maxMatches??50),10)||50,500)),u=e.mode==="commit"?"commit":"dryRun",m=e.section||"body",p=e.rowMatchMode==="any"?"any":"all",f=e.allowMultipleMatches===!0?"true":"false",y=e.allowCurrentMismatch===!0?"true":"false",S=e.expectedCurrentText!==void 0&&e.expectedCurrentText!==null?"true":"false",N=M(e.expectedCurrentText??"");return`
int[] exactScheduleIds = ${Ha(t)};
int[] exactSheetIds = ${Ha(n)};
string scheduleNameQuery = ${M(e.scheduleNameQuery||e.scheduleQuery||"")};
string sheetQuery = ${M(e.sheetQuery||"")};
string requestedSection = ${M(m)};
string[] rowTextQueries = ${Ee(r)};
string rowMatchMode = ${M(p)};
int targetColumn = ${Number.isFinite(o)?o:-1};
string requestedValue = ${M(e.value??"")};
string mode = ${M(u)};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowMultipleMatches = ${f};
bool allowCurrentMismatch = ${y};
bool hasExpectedCurrentText = ${S};
string expectedCurrentText = ${N};
int maxSchedules = ${i};
int maxRowsPerSchedule = ${a};
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
}`}function Ua(e){e.tool("set_schedule_cells_by_text","[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT] Finds bounded schedule rows by sheet/schedule filters and row text, then previews or commits a target column update with readback verification. Guards non-writable standard schedule body cells as non_writable_standard_body_cell. Prefer this over generic send_code_to_revit for repeated schedule row text writes. Schedule cell text writes are not a raw-code reason: use this when the user identifies the target row by visible row text, item code, equipment tag, or schedule line label and the requested change is a direct cell text value. Keep allowMultipleMatches=false unless every matched row is intended; use dryRun first to resolve ambiguity.",{...w(D),...x(D),scheduleIds:D.array(D.union([D.number(),D.string()])).optional().describe("Exact ViewSchedule ids to inspect. Preferred when known."),scheduleNameQuery:D.string().optional().describe("Bounded schedule name filter. Use this before broad row text matching."),scheduleQuery:D.string().optional().describe("Alias for scheduleNameQuery."),sheetIds:D.array(D.union([D.number(),D.string()])).optional().describe("Exact ViewSheet ids whose placed schedules should be inspected."),sheetQuery:D.string().optional().describe("Sheet number/name filter whose placed schedules should be inspected."),section:D.enum(["header","body","footer"]).optional().describe("Schedule section to search and write. Defaults to body."),rowTextQuery:D.string().optional().describe("Text that must appear in the row. Combine with rowTextQueries for safer matching."),rowTextQueries:D.array(D.string()).optional().describe("All row text terms to match by default. Use rowMatchMode=any to match any term."),rowMatchMode:D.enum(["all","any"]).optional().describe("Defaults to all. all requires every rowTextQuery term to match the row text."),targetColumn:D.number().int().min(0).describe("Zero-based target column to write in each matched row."),value:D.string().describe("Target cell text."),expectedCurrentText:D.string().optional().describe("Optional compare-and-set guard for the target cell text."),allowCurrentMismatch:D.boolean().optional().describe("Defaults false. Keep false for production writes so stale target cells are blocked."),allowMultipleMatches:D.boolean().optional().describe("Defaults false. Required when more than one row match should be updated."),mode:D.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes all matched cells in one wrapper transaction."),maxSchedules:D.number().int().positive().max(200).optional().describe("Maximum candidate schedules to inspect. Defaults 20."),maxRowsPerSchedule:D.number().int().positive().max(2e3).optional().describe("Maximum rows scanned per schedule. Defaults 250."),maxColumnsPerSchedule:D.number().int().positive().max(300).optional().describe("Maximum columns read when matching row text. Defaults 80."),maxMatches:D.number().int().positive().max(500).optional().describe("Maximum matching rows returned or written. Defaults 50."),responseMode:Ze,maxResultRows:D.number().int().positive().max(500).optional().describe("Compact-mode cap for matches/changes/errors returned to the client. Defaults 25; full/debug returns all rows within maxMatches."),timeoutMs:D.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=t.scheduleNameQuery||t.scheduleQuery,o=await K(qm({...t,scheduleNameQuery:r}),{...se(t),...ge(t,n==="commit"?"Set Revit schedule cells by text":"Preview Revit schedule row text changes"),toolName:"set_schedule_cells_by_text",transactionMode:n==="commit"?"auto":"none"});return h(zm(o&&o.result?o.result:o,t))}catch(n){return h(Ce({action:"set_schedule_cells_by_text",reason:"set_schedule_cells_by_text_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as nt}from"zod";var Wm=`
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
}`;function Gm(e){let t=ze(e);return t&&typeof t=="object"&&t.result?t.result:t}async function Jm(e,t){let n=null;try{n=await Me(async o=>await o.sendCommand("mcp_status",{},{timeoutMs:t,statusPreflight:!1}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(t,500),logSocketErrors:!1,skipLock:!0})}catch(o){return{reachable:!1,target:{name:e.name,host:e.host,port:e.port,source:e.source},error:o instanceof Error?o.message:String(o)}}let r=Math.max(t,1e4);try{let o=await Me(async(i,a)=>await i.sendCommand("send_code_to_revit",{code:Wm,parameters:[`${a.host}:${a.port}`],transactionMode:"none",taskName:"Probe Revit instance"},{timeoutMs:r}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(r,500),logSocketErrors:!1});return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:nn(n,{recentLimit:3,includeDiagnostics:!1}),info:Gm(o)}}catch(o){return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:nn(n,{recentLimit:3,includeDiagnostics:!1}),info:null,infoError:o instanceof Error?o.message:String(o)}}}function $a(e){e.tool("list_revit_instances","Discover reachable revAgent Revit bridge instances by probing configured ports. Use this before targeting a specific Revit instance.",{host:nt.string().optional().describe("Host to scan. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),ports:nt.array(nt.union([nt.number(),nt.string()])).optional().describe("Ports to scan. Defaults to REVAGENT_PORTS, then legacy REVIT_MCP_PORTS, or 8080-8085."),includeRegistry:nt.boolean().optional().describe("Include targets from the revAgent instance registry file. Defaults true."),includeUnreachable:nt.boolean().optional().describe("Include unreachable ports in the result. Defaults false."),timeoutMs:nt.number().int().positive().max(15e3).optional().describe("Per-port connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.timeoutMs||3e3,r=Io({host:t.host,ports:t.ports,includeRegistry:t.includeRegistry}),o=[];for(let i of r){let a=await Jm(i,n);(a.reachable||t.includeUnreachable)&&o.push(a)}return h({success:!0,count:o.filter(i=>i.reachable).length,scanned:r.length,instances:o})})}import Qa from"node:path";import{z as rt}from"zod";var Hm=new Date().toISOString(),Um="revit-mcp-status.v3",$m="revit-mcp-runtime-tools.40";function Xm(){let e=Qe(Qa.join(Ht(),"package.json"));return{packageName:e?.name||"revagent-runtime",packageVersion:e?.version||"unknown"}}function Xa(){let e=Xm(),t=Ut([Qa.join(process.cwd(),"..","updater","installed.json")]),n=t?.version||e.packageVersion;return{runtimeVersion:n,schemaVersion:Um,toolSurfaceVersion:$m,processStartedAtUtc:Hm,buildTimestampUtc:t?.installedAtUtc||null,buildHash:$t(n),packageName:e.packageName,packageVersion:e.packageVersion,nodeVersion:process.version}}function Ya(e){e.tool("get_revit_mcp_status","Read the revAgent task status without waiting behind the active Revit command lock. Includes runtimeVersion, schemaVersion, toolSurfaceVersion, processStartedAtUtc, buildTimestampUtc, buildHash, bridge resultContractVersion when available, and summary runtimeActivity for revAgent-side/client-side guarded operations that may not reach Revit.",{...w(rt),includeRecentTasks:rt.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),recentLimit:rt.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),includeRuntimeActivity:rt.boolean().optional().describe("Include MCP-side/client-side active and recent activity. Defaults true so guard-only tasks that did not reach Revit remain auditable."),runtimeActivityLimit:rt.number().int().min(0).max(100).optional().describe("Maximum runtimeActivity.recentActivity rows to return. Defaults 10."),runtimeActivityMode:rt.enum(["summary","full"]).optional().describe("runtimeActivity shape. summary is the default and collapses started/completed pairs into latest completed/guarded/failed rows without responseKeys. full includes started rows and full result summaries."),includeDiagnostics:rt.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),timeoutMs:rt.number().int().positive().max(1e4).optional().describe("Connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.includeRuntimeActivity===!1?void 0:Zo(t.runtimeActivityLimit??10,t.runtimeActivityMode||"summary");try{let r=t.timeoutMs||3e3,o=await Me(async s=>await s.sendCommand("mcp_status",{},{timeoutMs:r}),{...se(t),skipLock:!0,connectTimeoutMs:r}),i=nn(ze(o),{includeRecentTasks:t.includeRecentTasks,recentLimit:t.recentLimit,includeDiagnostics:t.includeDiagnostics});Ln(o);let a=i&&typeof i=="object"&&!Array.isArray(i)?i:{status:i};return h({...a,...n?{runtimeActivity:n}:{},runtimeIdentity:Xa()})}catch(r){return h({success:!1,error:r instanceof Error?r.message:String(r),...n?{runtimeActivity:n}:{},runtimeIdentity:Xa()})}})}import{z as U}from"zod";import Qm from"node:crypto";import Ka from"node:path";import{Ajv2020 as Ym}from"ajv/dist/2020.js";import Km from"ajv-formats";var fo="https://schemas.revagent.app/spatial/v0.1/extraction-page.schema.json",Zm=["element-ref.schema.json","node-ref.schema.json","source-revision.schema.json","cursor-envelope.schema.json","spatial-snapshot.schema.json","extraction-page.schema.json"];function ot(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function qt(e){if(typeof e=="number"&&!Number.isFinite(e))throw new Error("Spatial canonical JSON rejects non-finite numbers.");return Array.isArray(e)?`[${e.map(qt).join(",")}]`:ot(e)?`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${qt(e[t])}`).join(",")}}`:JSON.stringify(e)}function hr(e){if(e===null)return"null";if(typeof e=="number"){if(!Number.isFinite(e))throw new Error("Semantic spatial JSON cannot contain a non-finite number.");let t=Object.is(e,-0)?0:e,n=new ArrayBuffer(8),r=new DataView(n);return r.setFloat64(0,t,!1),JSON.stringify(`n:${r.getBigUint64(0,!1).toString(16).padStart(16,"0")}`)}return typeof e=="string"?JSON.stringify(`s:${e}`):typeof e!="object"?JSON.stringify(e):Array.isArray(e)?`[${e.map(hr).join(",")}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${hr(e[t])}`).join(",")}}`}function ep(e){return`sha256:${Qm.createHash("sha256").update(hr(e),"utf8").digest("hex")}`}function tp(){let e=Ka.join(Ht(),"schemas","spatial","v0.1"),t=Zm.map(o=>{let i=Qe(Ka.join(e,o));if(!i)throw new Error(`Missing required spatial schema: ${o}`);return i}),n=new Ym({allErrors:!0,strict:!0,strictRequired:!1,allowUnionTypes:!0});Km(n);for(let o of t)n.addSchema(o);let r=n.getSchema(fo);if(!r)throw new Error(`Spatial extraction page schema was not compiled: ${fo}`);return r}var Za=tp();function np(e){return(e||[]).slice(0,100).map(t=>{let n=t.instancePath||"/",r=t.keyword==="additionalProperties"&&t.params?.additionalProperty?` unexpected property ${String(t.params.additionalProperty)}`:"";return`${n} ${String(t.message||t.keyword)}${r}`.trim()})}function rp(e){let t=[],n=ot(e.page)?e.page:{},r=Array.isArray(e.nodes)?e.nodes:[],o=Array.isArray(e.omissions)?e.omissions:[];if(e.snapshotId!==e.captureId&&t.push("/snapshotId must equal captureId for the Phase 0 native page"),n.recordCount!==void 0&&n.recordCount!==r.length&&t.push("/page/recordCount must equal nodes.length"),n.nodeCount!==void 0&&n.nodeCount!==r.length&&t.push("/page/nodeCount must equal nodes.length"),n.omissionCount!==o.length&&t.push("/page/omissionCount must equal omissions.length"),n.rowCount!==void 0&&n.rowCount!==r.length+o.length&&t.push("/page/rowCount must equal nodes.length + omissions.length"),n.pageHash!==n.pageSha256&&t.push("/page/pageHash must equal pageSha256"),n.priorPageHash!==n.priorPageSha256&&t.push("/page/priorPageHash must equal priorPageSha256"),n.nextCursor!==e.nextCursor&&t.push("/page/nextCursor must equal top-level nextCursor"),n.ordinal===0&&n.priorPageHash!==null&&t.push("/page/priorPageHash must be null on page 0"),n.ordinal>0&&typeof n.priorPageHash!="string"&&t.push("/page/priorPageHash is required after page 0"),e.pageCount<n.ordinal+1&&t.push("/pageCount cannot be smaller than page.ordinal + 1"),ot(e.coverage)){e.coverage.pageNodeCount!==r.length&&t.push("/coverage/pageNodeCount must equal nodes.length"),e.coverage.pageOmissionCount!==o.length&&t.push("/coverage/pageOmissionCount must equal omissions.length");let a=Array.isArray(e.sourceRevisions)?e.sourceRevisions:[];e.coverage.sourceCount!==a.length&&t.push("/coverage/sourceCount must equal sourceRevisions.length"),ot(e.effectiveSourcePolicy)&&e.coverage.effectiveScope!==e.effectiveSourcePolicy.hasEffectiveExtractionPolicy&&t.push("/coverage/effectiveScope must equal effectiveSourcePolicy.hasEffectiveExtractionPolicy")}if(ot(e.effectiveSourcePolicy)){let a=Array.isArray(e.effectiveSourcePolicy.effectiveSources)?e.effectiveSourcePolicy.effectiveSources:[];e.effectiveSourcePolicy.effectiveSourceCount!==a.length&&t.push("/effectiveSourcePolicy/effectiveSourceCount must equal effectiveSources.length")}let i=Array.isArray(n.rows)?n.rows:null;if(i){let a=i.filter(m=>ot(m)&&m.node!==void 0).map(m=>m.node),s=i.filter(m=>ot(m)&&m.omission!==void 0).map(m=>m.omission);i.length!==r.length+o.length&&t.push("/page/rows length must equal nodes.length + omissions.length"),qt(a)!==qt(r)&&t.push("/page/rows node records must exactly reproduce top-level nodes"),qt(s)!==qt(o)&&t.push("/page/rows omission records must exactly reproduce top-level omissions");let l=Buffer.byteLength(hr(i),"utf8");n.payloadBytes!==l&&t.push("/page/payloadBytes must equal UTF-8 canonical IEEE-754 page.rows bytes");let u=ep({captureId:e.captureId,pageOrdinal:n.ordinal,priorPageHash:n.priorPageHash,rows:i});n.pageHash!==u&&t.push("/page/pageHash must equal the canonical extraction-row envelope hash")}return t}function es(e){let t=Za(e),n=np(Za.errors);return t&&ot(e)&&n.push(...rp(e)),{valid:n.length===0,errors:n,schemaId:fo}}var op="0.1",ip="host_internal_mm",yo="spatial-extraction-page.v0.1",ap=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]);function it(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function g(e,...t){if(!it(e))return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let r of t){let o=n.find(([i])=>i.toLowerCase()===r.toLowerCase());if(o)return o[1]}}function ae(e){if(typeof e=="number"&&Number.isInteger(e)&&Number.isFinite(e))return e;if(typeof e=="string"&&/^-?\d+$/.test(e.trim())){let t=Number.parseInt(e,10);return Number.isSafeInteger(t)?t:null}return null}function ts(e){if(typeof e=="number"&&Number.isFinite(e))return e;if(typeof e=="string"&&e.trim()){let t=Number(e);return Number.isFinite(t)?t:null}return null}function go(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function sp(e,t,n){let r=String(e??"").trim().toLowerCase();return ap.has(r)?r:n?t?"max_items":"completed":"read_failed"}function fr(e){return typeof e=="string"&&/^sha256:[a-f0-9]{64}$/i.test(e)}function gn(e){return typeof e=="string"&&e.trim().length>0}function ns(e,t){let n=it(e)?e:{},r=g(n,"page"),o=it(r)?r:{},i=g(n,"nodes"),a=g(n,"omissions"),s=Array.isArray(i)?i:[],l=Array.isArray(a)?a:[],u=g(n,"success"),m=typeof u=="boolean"?u:!0,p=g(n,"guarded")===!0,f=String(g(n,"state")||(p?"guarded":m?"completed":"failed")),y=g(n,"nextCursor")??g(o,"nextCursor"),S=typeof y=="string"&&y.length>0?y:null,N=g(o,"hasMore"),k=typeof N=="boolean"?N:S!==null,F=ae(g(o,"ordinal","pageOrdinal")??g(n,"pageOrdinal")),L=ae(g(o,"targetBytes")),O=ae(g(o,"payloadBytes")),J=ae(g(n,"payloadBytes")),Y=ae(g(o,"recordCount")),Z=ae(g(o,"omissionCount")),ee=ae(g(o,"nodeCount"))??Y??s.length,ne=ae(g(o,"rowCount"))??ee+(Z??l.length),$=g(o,"pageSha256","pageHash")??g(n,"pageHash"),re=g(o,"priorPageSha256","priorPageHash")??g(n,"priorPageHash"),xe=typeof re=="string"&&re.trim().length>0?re:null,_e=g(n,"partial"),He=typeof _e=="boolean"?_e:k,Wt=sp(g(n,"scanStoppedReason"),k,m),vt=ts(g(n,"elapsedMs"))??ts(t),Ue=go(g(n,"suggestedNextScopes"));k&&!Ue.includes("cursor")&&Ue.push("cursor");let yr={...o,ordinal:F,targetBytes:L,payloadBytes:O,recordCount:Y??ee,rowCount:ne,nodeCount:ee,omissionCount:Z??l.length,hasMore:k,pageSha256:$??null,priorPageSha256:xe,nextCursor:S},Oe={...n,success:m,guarded:p,state:f,action:"capture_spatial_snapshot",warnings:go(g(n,"warnings")),notices:go(g(n,"notices")),nodes:s,omissions:l,page:yr,pageOrdinal:F,rowCount:ne,nodeCount:ee,omissionCount:Z??l.length,payloadBytes:J,pagePayloadBytes:O,pageHash:$??null,priorPageHash:xe,nextCursor:S,partial:He,scanStoppedReason:Wt,suggestedNextScopes:Ue,elapsedMs:vt};if(Oe.snapshot={snapshotId:g(n,"snapshotId")??g(n,"captureId"),capturedAt:g(n,"capturedAt"),sourceRevisions:g(n,"sourceRevisions"),scope:g(n,"scope"),scopeFingerprint:g(n,"scopeFingerprint"),revisionFingerprint:g(n,"revisionFingerprint"),coordinateFrame:g(n,"coordinateFrame"),lengthUnit:g(n,"lengthUnit"),schemaVersion:g(n,"schemaVersion"),extractorVersion:g(n,"extractorVersion"),counts:g(n,"counts"),partial:He,scanStoppedReason:Wt,suggestedNextScopes:Oe.suggestedNextScopes,pageCount:ae(g(n,"pageCount")),payloadBytes:ae(g(n,"payloadBytes"))},!m||p)return{payload:Oe,valid:!0,errors:[]};let yn=es(n),A=[...yn.errors];g(n,"schemaVersion")!==op&&A.push("schemaVersion must be 0.1"),g(n,"coordinateFrame")!==ip&&A.push("coordinateFrame must be host_internal_mm"),g(n,"lengthUnit")!=="mm"&&A.push("lengthUnit must be mm"),gn(g(n,"extractorVersion"))||A.push("extractorVersion is required"),gn(g(n,"captureId"))||A.push("captureId is required"),gn(g(n,"snapshotId")??g(n,"captureId"))||A.push("snapshotId is required"),gn(g(n,"capturedAt"))||A.push("capturedAt is required"),it(g(n,"scope"))||A.push("scope must be an object"),fr(g(n,"scopeFingerprint"))||A.push("scopeFingerprint must use sha256:<64 hex>"),fr(g(n,"revisionFingerprint"))||A.push("revisionFingerprint must use sha256:<64 hex>"),Array.isArray(g(n,"sourceRevisions"))||A.push("sourceRevisions must be an array"),it(g(n,"counts"))||A.push("counts must be an object");let bn=ae(g(n,"pageCount"));(bn===null||bn<1)&&A.push("pageCount must be a positive integer");let bo=ae(g(n,"payloadBytes"));return(bo===null||bo<0)&&A.push("payloadBytes must be a non-negative integer"),g(n,"liveness")!=="unknown"&&A.push("Phase 0 liveness must be unknown"),g(n,"atomic")!==!1&&A.push("Phase 0 atomic must be false"),gn(g(n,"revisionBasisCaveat"))||A.push("revisionBasisCaveat is required"),Array.isArray(i)||A.push("nodes must be an array"),it(r)||A.push("page must be an object"),(F===null||F<0)&&A.push("page.ordinal must be a non-negative integer"),(L===null||L<=0)&&A.push("page.targetBytes must be a positive integer"),(O===null||O<0)&&A.push("page.payloadBytes must be a non-negative integer"),(J===null||J<0)&&A.push("payloadBytes must be a non-negative logical capture total"),(ee<0||ee!==s.length)&&A.push("page.nodeCount/recordCount must equal nodes.length"),(Z===null||Z<0||Z!==l.length)&&A.push("page.omissionCount must equal omissions.length"),(ne<0||ne!==s.length+l.length)&&A.push("page.rowCount must equal nodes.length + omissions.length"),fr($)||A.push("page.pageSha256 must use sha256:<64 hex>"),(F??0)>0&&!fr(xe)&&A.push("page.priorPageSha256 must use sha256:<64 hex> after page 0"),k&&S===null&&A.push("page.nextCursor is required when page.hasMore is true"),!k&&S!==null&&A.push("page.nextCursor must be null when page.hasMore is false"),k&&!He&&A.push("partial must be true while page.hasMore is true"),Oe.contractValidation={version:yo,schemaId:yn.schemaId,valid:A.length===0,errors:A},Oe.pageEvidence=lp(Oe),{payload:Oe,valid:A.length===0,errors:A}}function lp(e){let t=it(e)?e:{},n=it(g(t,"page"))?g(t,"page"):{},r=g(t,"captureId"),o=g(t,"nextCursor")??g(n,"nextCursor");return{captureId:typeof r=="string"?r:null,pageOrdinal:ae(g(n,"ordinal")??g(t,"pageOrdinal")),pageHash:g(n,"pageSha256")??g(t,"pageHash")??null,priorPageHash:g(n,"priorPageSha256")??g(t,"priorPageHash")??null,rowCount:ae(g(n,"rowCount")??g(t,"rowCount")),nodeCount:ae(g(n,"nodeCount","recordCount")??g(t,"nodeCount")),omissionCount:ae(g(n,"omissionCount")),pagePayloadBytes:ae(g(n,"payloadBytes")??g(t,"pagePayloadBytes")),payloadBytes:ae(g(t,"payloadBytes")),hasMore:g(n,"hasMore")===!0,nextCursorPresent:typeof o=="string"&&o.length>0}}var cp=4*1024*1024,is=64*1024,as=8*1024*1024,up=5e3,ss=25e3,dp=4500,ls=25e3,mp=12e3,cs=6e4;function gr(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function rs(e){return Array.isArray(e)?[...new Set(e.map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0):[]}function os(e){return Array.isArray(e)?[...new Set(e.map(t=>/^\d+$/.test(String(t??"").trim())?Number.parseInt(String(t).trim(),10):Number.NaN).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n):[]}function us(e={}){let t=gr(e.pageTargetBytes,cp,is,as),n=gr(e.maxElements,up,1,ss),r=gr(e.maxElapsedMs,dp,250,ls),o=gr(e.timeoutMs,Math.max(mp,r+15e3),Math.max(1e3,r+1e3),cs);return{pageTargetBytes:t,maxElements:n,maxElapsedMs:r,timeoutMs:o}}function pp(e,t=us(e)){return{levelIds:os(e.levelIds),levelNames:rs(e.levelNames),sourceScope:e.sourceScope||"hostAndLinked",linkInstanceIds:os(e.linkInstanceIds),linkInstanceUniqueIds:rs(e.linkInstanceUniqueIds),includeHostMep:e.includeHostMep!==!1,includeRoomsSpaces:e.includeRoomsSpaces!==!1,includeLinkedObstructions:e.includeLinkedObstructions!==!1,belowLevelMm:e.belowLevelMm,aboveLevelMm:e.aboveLevelMm,cursor:typeof e.cursor=="string"?e.cursor:void 0,pageTargetBytes:t.pageTargetBytes,maxElements:t.maxElements,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,suppressTaskStatusWindow:!0,taskName:"Capture spatial snapshot page",taskId:void 0}}function hp(e){return e.levelIds.length>0||e.levelNames.length>0}function fp(e){return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"needs_scope",message:"capture_spatial_snapshot requires an explicit level scope. Pass levelIds and/or levelNames; broad whole-model extraction is not available.",partial:!1,scanStoppedReason:"needs_scope",scanPolicy:e,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:["No Revit command was sent."],nextCursor:null}}function ds(e){e.tool("capture_spatial_snapshot","[SPATIAL_CAPTURE_READ_ONLY] Extract exactly one deterministic, bounded spatial snapshot page from one explicitly scoped Revit level. This wrapper sends one native extract_spatial_snapshot command per MCP call, never decodes the opaque cursor, and never aggregates the whole graph. It also exposes snapshot as the exact published SpatialSnapshot v0.1 contract view for the capture metadata. Start without cursor; when page.hasMore is true, call again with the returned nextCursor. Phase 0 is a non-atomic extraction spike with liveness=unknown, not a durable/current snapshot store.",{...w(U),...x(U),levelIds:U.array(U.union([U.number().int().positive(),U.string()])).max(20).optional().describe("Explicit host Revit level ids. At least one levelIds or levelNames entry is required on every page call."),levelNames:U.array(U.string().min(1)).max(20).optional().describe("Explicit host Revit level names. At least one levelIds or levelNames entry is required on every page call."),sourceScope:U.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked for the Phase 0 host/architecture/structure audit."),linkInstanceIds:U.array(U.union([U.number().int().positive(),U.string()])).max(100).optional().describe("Optional exact RevitLinkInstance ids inside the explicit level scope."),linkInstanceUniqueIds:U.array(U.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance unique ids inside the explicit level scope."),includeHostMep:U.boolean().optional().describe("Include supported host-model MEP evidence. Defaults true."),includeRoomsSpaces:U.boolean().optional().describe("Include supported Room/Space evidence from the selected source scope. Defaults true."),includeLinkedObstructions:U.boolean().optional().describe("Include supported linked structural/architectural obstruction evidence. Defaults true."),belowLevelMm:U.number().min(0).max(1e4).optional().describe("Optional bounded extent below each selected level, in millimetres. Defaults 1000; native cap 10000."),aboveLevelMm:U.number().min(100).max(3e4).optional().describe("Optional bounded extent above each selected level, in millimetres. Defaults 6000; native cap 30000."),cursor:U.string().min(1).max(32768).optional().describe("Opaque nextCursor returned by the immediately preceding page. Passed through unchanged and never decoded by the runtime wrapper."),pageTargetBytes:U.number().int().min(is).max(as).optional().describe("Native page target in bytes. Defaults 4 MiB; hard-capped at 8 MiB below the 32 MiB bridge ceiling."),maxElements:U.number().int().positive().max(ss).optional().describe("Maximum source elements considered by this native page call. Defaults 5000; hard-capped at 25000."),maxElapsedMs:U.number().int().min(250).max(ls).optional().describe("Maximum native extraction work for this page. Defaults 4500 ms; native range 250-25000 ms for explicitly scoped real-model audits."),timeoutMs:U.number().int().min(2e3).max(cs).optional().describe("Socket timeout for this one page. Defaults to at least 12000 ms with 15000 ms headroom above maxElapsedMs; hard-capped at 60000 ms.")},async t=>{let n=Date.now(),r=us(t),o=pp(t,r);if(!hp(o))return h(fp(r));try{let i=await _("extract_spatial_snapshot",o,{...I({target:t.target,host:t.host,port:t.port,timeoutMs:r.timeoutMs,taskName:"Capture spatial snapshot page"},"Capture spatial snapshot page"),toolName:"capture_spatial_snapshot",timeoutMs:r.timeoutMs}),a=i&&i.result?i.result:i,s=ns(a,Date.now()-n);return s.valid?(s.payload.scanPolicy=s.payload.scanPolicy||r,h(s.payload)):h({success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"invalid_spatial_page_contract",error:"The native extract_spatial_snapshot response did not satisfy the strict Phase 0 extraction-page contract.",contractValidation:s.payload.contractValidation||{version:yo,valid:!1,errors:s.errors},pageEvidence:s.payload.pageEvidence,partial:!1,scanStoppedReason:"read_failed",scanPolicy:r,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:Date.now()-n})}catch(i){return h({success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"read_failed",error:i instanceof Error?i.message:String(i),partial:!1,scanStoppedReason:"read_failed",scanPolicy:r,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:Date.now()-n})}})}async function ms(e){let t=ri(e);$a(t),Ya(t),mi(t),pi(t),hi(t),fi(t),yi(t),bi(t),Si(t),wi(t),xi(t),vi(t),Ni(t),Ei(t),ki(t),Pi(t),Ai(t),Fi(t),Vi(t),Li(t),zi(t),qi(t),Ui(t),Ki(t),Ea(t),La(t),ja(t),qa(t),Ga(t),Ua(t),ds(t),console.error("Registered 31 revAgent tools")}var ps=new gp({name:"revAgent",version:"1.0.0"});async function bp(){await ms(ps);let e=new yp;await ps.connect(e),ni(),console.error("revAgent runtime start success")}bp().catch(e=>{console.error("Error starting revAgent runtime:",e),process.exit(1)});

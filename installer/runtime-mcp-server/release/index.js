import{McpServer as Jp}from"@modelcontextprotocol/sdk/server/mcp.js";import{StdioServerTransport as Wp}from"@modelcontextprotocol/sdk/server/stdio.js";import{z as He}from"zod";import*as Io from"net";function qe(...e){for(let t of e){let n=process.env[t];if(n!=null&&String(n).trim()!=="")return n}}var vn=32*1024*1024,Cn=class{host;port;socket;logErrors;isConnected=!1;responseCallbacks=new Map;buffer=Buffer.alloc(0);framingMode=qe("REVAGENT_FRAMING","REVIT_MCP_FRAMING")==="legacy"?"legacy":"length-prefixed";constructor(t,n,r={}){this.host=t,this.port=n,this.logErrors=r.logErrors!==!1,this.socket=new Io.Socket,this.setupSocketListeners()}setupSocketListeners(){this.socket.on("connect",()=>{this.isConnected=!0}),this.socket.on("data",t=>{this.buffer=Buffer.concat([this.buffer,t]),this.processBuffer()}),this.socket.on("close",()=>{this.isConnected=!1}),this.socket.on("error",t=>{this.logErrors&&console.error("RevitClientConnection error:",t),this.isConnected=!1})}processBuffer(){for(;this.buffer.length>0;){if(this.buffer.length>vn){this.rejectPending(new Error(`revAgent response exceeded ${vn} bytes`)),this.buffer=Buffer.alloc(0);return}if(this.isLikelyLegacyJson(this.buffer)){if(!this.processLegacyJsonBuffer())return;continue}if(!this.isLikelyLengthPrefixed(this.buffer)||!this.processLengthPrefixedBuffer())return}}isLikelyLegacyJson(t){let n=0;for(;n<t.length&&[32,9,10,13].includes(t[n]);)n++;return n<t.length&&t[n]===123}isLikelyLengthPrefixed(t){if(t.length<4)return!0;let n=t.readUInt32BE(0);return n>0&&n<=vn}processLegacyJsonBuffer(){try{let t=this.buffer.toString("utf8"),n=this.extractFirstJsonObject(t);if(!n)return!1;let r=JSON.parse(n.json);return this.handleResponseObject(r,n.json),this.buffer=Buffer.from(n.remaining,"utf8"),!0}catch{return!1}}extractFirstJsonObject(t){let n=0,r=!1,o=!1,i=!1,a=0;for(let s=0;s<t.length;s++){let l=t[s];if(!i){if(/\s/.test(l))continue;if(l!=="{")return null;i=!0,a=s,n=1;continue}if(o){o=!1;continue}if(l==="\\"){o=!0;continue}if(l==='"'){r=!r;continue}if(!r){if(l==="{")n++;else if(l==="}"&&(n--,n===0))return{json:t.slice(a,s+1),remaining:t.slice(s+1)}}}return null}processLengthPrefixedBuffer(){if(this.buffer.length<4)return!1;let t=this.buffer.readUInt32BE(0);if(t<=0||t>vn)return this.rejectPending(new Error(`Invalid revAgent response frame length: ${t}`)),this.buffer=Buffer.alloc(0),!1;if(this.buffer.length<4+t)return!1;let r=this.buffer.subarray(4,4+t).toString("utf8");try{let o=JSON.parse(r);this.handleResponseObject(o,r)}catch(o){this.rejectPending(new Error(`Failed to parse revAgent response: ${o instanceof Error?o.message:String(o)}`))}return this.buffer=this.buffer.subarray(4+t),!0}handleResponseObject(t,n){let o=t&&t.id!==void 0&&t.id!==null?String(t.id):"default",i=this.responseCallbacks.get(o);if(i){i(n),this.responseCallbacks.delete(o);return}if(t&&t.error&&this.responseCallbacks.size===1){let a=this.responseCallbacks.entries().next().value;if(a){let[s,l]=a;l(n),this.responseCallbacks.delete(s)}return}if(t&&t.error&&this.responseCallbacks.size>1)for(let[a,s]of this.responseCallbacks.entries())s(n),this.responseCallbacks.delete(a)}rejectPending(t){for(let[n,r]of this.responseCallbacks.entries())r(JSON.stringify({jsonrpc:"2.0",id:n,error:{code:-32e3,message:t instanceof Error?t.message:String(t)}})),this.responseCallbacks.delete(n)}connect(){if(this.isConnected)return!0;try{return this.socket.connect(this.port,this.host),!0}catch(t){return console.error("Failed to connect:",t),!1}}disconnect(){this.socket.end(),this.isConnected=!1}generateRequestId(){return Date.now().toString()+Math.random().toString().substring(2,8)}async sendCommand(t,n={},r={}){return t!=="mcp_status"&&r.statusPreflight!==!1&&await this.ensureReadyForCommand(t,r),await this.sendCommandRequest(t,n,r)}async ensureReadyForCommand(t,n={}){let r=n.statusTimeoutMs||Math.min(n.timeoutMs||3e3,3e3),o=await this.sendCommandRequest("mcp_status",{},{timeoutMs:r,statusPreflight:!1}),i=o&&typeof o=="object"?o.activeTask:null;if(!i)return;let a=i.taskName||i.method||"revAgent task",s=typeof i.elapsedMs=="number"?`, elapsed ${this.formatElapsed(i.elapsedMs)}`:"";throw new Error(`revAgent is busy with "${a}"${s}. Wait for it to finish before sending "${t}".`)}formatElapsed(t){let n=Math.max(0,Math.floor(t/1e3)),r=Math.floor(n/3600),o=Math.floor(n%3600/60),i=n%60;return[r,o,i].map(a=>String(a).padStart(2,"0")).join(":")}async sendCommandRequest(t,n={},r={}){let o=r.framing||this.framingMode;try{return await this.sendCommandRequestOnce(t,n,{...r,framing:o})}catch(i){if(o==="length-prefixed"&&r.allowLegacyFallback!==!1&&this.isFramingFallbackError(i))return this.framingMode="legacy",await this.sendCommandRequestOnce(t,n,{...r,framing:"legacy"});throw i}}isFramingFallbackError(t){let n=t instanceof Error?t.message:String(t);return/Invalid JSON|Invalid JSON-RPC request|Invalid (?:Revit MCP|revAgent) response frame length/i.test(n)}sendCommandRequestOnce(t,n={},r={}){return new Promise((o,i)=>{let a;try{this.isConnected||this.connect();let s=this.generateRequestId(),l={jsonrpc:"2.0",method:t,params:n,id:s};this.responseCallbacks.set(s,m=>{clearTimeout(a);try{let p=JSON.parse(m);p.error?i(new Error(p.error.message||"Unknown error from Revit")):o(p.result)}catch(p){p instanceof Error?i(new Error(`Failed to parse response: ${p.message}`)):i(new Error(`Failed to parse response: ${String(p)}`))}}),this.writeCommand(l,r.framing||this.framingMode);let u=r.timeoutMs||12e4;a=setTimeout(()=>{this.responseCallbacks.has(s)&&(this.responseCallbacks.delete(s),i(new Error(`Command timed out after ${this.formatElapsed(u)}: ${t}`)))},u),typeof a.unref=="function"&&a.unref()}catch(s){clearTimeout(a),i(s)}})}writeCommand(t,n){let r=Buffer.from(JSON.stringify(t),"utf8");if(n==="length-prefixed"){let o=Buffer.alloc(4);o.writeUInt32BE(r.length,0),this.socket.write(Buffer.concat([o,r]));return}this.socket.write(r)}};import*as fe from"fs";import*as Rn from"os";import*as Xe from"path";var Ms=qe("REVAGENT_HOST","REVIT_MCP_HOST","REVIT_HOST")||"localhost",_o=Ye(qe("REVAGENT_PORT","REVIT_MCP_PORT","REVIT_PORT"),8080),Ns=Os([qe("REVAGENT_INSTANCE_REGISTRY"),Xe.join(Rn.tmpdir(),"revAgent-instances.json"),qe("REVIT_MCP_INSTANCE_REGISTRY"),Xe.join(Rn.tmpdir(),"revit-mcp-instances.json")]),Mo=Xe.join(Rn.tmpdir(),"revit-mcp-command-locks"),No=8e3,Es=600*1e3,ks=250;function As(e){return new Promise(t=>setTimeout(t,e))}function Ye(e,t){if(e==null||e===""){if(t!==void 0)return t;throw new Error("Invalid revAgent port: empty value")}let n=Number.parseInt(String(e),10);if(!Number.isFinite(n)||n<1||n>65535)throw new Error(`Invalid revAgent port: ${e}`);return n}function To(e){return e?(Array.isArray(e)?e:String(e).split(",")).map(n=>String(n).trim()).filter(Boolean).map(n=>Ye(n)):[]}function lt(e){return e?String(e).trim():Ms}function Ps(e){return String(e).replace(/[^a-zA-Z0-9_.-]/g,"_")}function Os(e){let t=new Set,n=[];for(let r of e){if(!r||!String(r).trim())continue;let o=Xe.resolve(String(r)),i=o.toLowerCase();t.has(i)||(t.add(i),n.push(o))}return n}function Vs(e){return Xe.join(Mo,`${Ps(e.host)}-${e.port}.lock`)}function Eo(e){return e&&typeof e=="object"&&"code"in e?String(e.code):null}function Ds(e){let t=new Set,n=[];for(let r of e){let o=lt(r.host),i=Ye(r.port),a=`${o}:${i}`;t.has(a)||(t.add(a),n.push({...r,host:o,port:i}))}return n}function ko(){let e=[];for(let t of Ns)try{if(!fe.existsSync(t))continue;let n=JSON.parse(fe.readFileSync(t,"utf8"));if(Array.isArray(n)){e.push(...n);continue}if(n&&Array.isArray(n.instances)){e.push(...n.instances);continue}n&&n.targets&&typeof n.targets=="object"&&e.push(...Object.entries(n.targets).map(([r,o])=>({...typeof o=="object"&&o?o:{},name:r})))}catch{continue}return e}function Fs(e,t){let n=String(t).toLowerCase();return[e.name,e.id,e.target,e.pid,e.title,e.documentTitle,e.path,e.pathName].filter(o=>o!=null).some(o=>String(o).toLowerCase()===n)}function Ls(e){let t=ko().find(n=>Fs(n,e));return t?{name:t.name||t.id||String(e),host:lt(t.host),port:Ye(t.port),source:"registry",metadata:t}:null}function js(e,t){let n=String(e||"").trim();if(!n)return null;if(/^\d+$/.test(n))return{host:lt(t),port:Ye(n),source:"target-port"};let r=n.match(/^(.+):(\d+)$/);return r?{host:lt(r[1]),port:Ye(r[2]),source:"target-host-port"}:null}function Bs(e={}){let t=lt(e.host),n=e.port!==void 0&&e.port!==null?Ye(e.port):null;if(n)return{host:t,port:n,source:"explicit"};let r=e.target||qe("REVAGENT_TARGET","REVIT_MCP_TARGET");if(r){let o=js(r,t);if(o)return o;let i=Ls(r);if(i)return i;throw new Error(`Unknown revAgent target '${r}'. Use a port number, host:port, or a registered instance name.`)}return{host:t,port:_o,source:"default"}}function Ao(e={}){let t=lt(e.host),n=[];if(e.includeRegistry!==!1)for(let a of ko())a.port&&n.push({name:a.name||a.id||a.title||a.documentTitle,host:lt(a.host),port:Ye(a.port),source:"registry",metadata:a});let r=To(e.ports),o=To(qe("REVAGENT_PORTS","REVIT_MCP_PORTS")),i=o.length>0?o:[_o,8081,8082,8083,8084,8085];for(let a of r.length>0?r:i)n.push({host:t,port:a,source:r.length>0?"explicit":"scan"});return Ds(n)}function zs(e){try{let t=fe.statSync(e);Date.now()-t.mtimeMs>Es&&fe.rmSync(e,{recursive:!0,force:!0})}catch(t){if(!t||Eo(t)==="ENOENT")return}}async function qs(e,t=No){let n=Vs(e),r=Date.now();for(fe.mkdirSync(Mo,{recursive:!0});;)try{return fe.mkdirSync(n,{recursive:!1}),fe.writeFileSync(Xe.join(n,"owner.json"),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),target:e},null,2)),()=>{try{fe.rmSync(n,{recursive:!0,force:!0})}catch{}}}catch(o){if(!o||Eo(o)!=="EEXIST")throw o;if(zs(n),Date.now()-r>=t)throw new Error(`revAgent target ${e.host}:${e.port} is busy; a previous Revit command is still running. Refusing to send another request.`);await As(ks)}}async function Ee(e,t={}){let n=Bs(t),r=t.skipLock===!0?()=>{}:await qs(n,t.lockWaitMs||No),o=new Cn(n.host,n.port,{logErrors:t.logSocketErrors!==!1});try{return o.isConnected||await new Promise((i,a)=>{let s,l=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),i()},u=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),a(new Error(`connect to revAgent target ${n.host}:${n.port} failed`))};o.socket.on("connect",l),o.socket.on("error",u),o.connect(),s=setTimeout(()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),a(new Error(`connect to revAgent target ${n.host}:${n.port} timed out`))},t.connectTimeoutMs||5e3),typeof s.unref=="function"&&s.unref()}),await e(o,n)}finally{o.disconnect(),r()}}import Nr from"node:crypto";import Er from"node:os";import Tt from"node:path";var Js=[{name:"Parameter.Set",pattern:/\.Set\s*\(/i},{name:"Parameter.SetValueString",pattern:/\.SetValueString\s*\(/i},{name:"Parameter.ClearValue",pattern:/\.ClearValue\s*\(/i},{name:"Schedule.SetCellText",pattern:/\.\s*SetCellText\s*\(/i},{name:"Schedule table edit",pattern:/\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(/i},{name:"Document.Delete",pattern:/\.\s*Delete\s*\(/i},{name:"ElementTransformUtils",pattern:/ElementTransformUtils/i},{name:"Location.Move",pattern:/\.Move\s*\(/i},{name:"Element.ChangeTypeId",pattern:/\.ChangeTypeId\s*\(/i},{name:"Connector.ConnectTo",pattern:/\.ConnectTo\s*\(/i},{name:"Connector.DisconnectFrom",pattern:/\.DisconnectFrom\s*\(/i},{name:"FamilySymbol.Activate",pattern:/\.Activate\s*\(/i},{name:"NewFamilyInstance",pattern:/NewFamilyInstance/i},{name:"Create API",pattern:/\.(Create|New[A-Z]\w*)\s*\(/},{name:"View visibility/overrides",pattern:/\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/i},{name:"Geometry join/cut",pattern:/(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/i},{name:"Parameter binding edit",pattern:/\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/i},{name:"Revit property assignment",pattern:/\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.\s*(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/i},{name:"Manual Transaction",pattern:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/i}];function Ht(e){return Js.filter(t=>t.pattern.test(e)).map(t=>t.name)}import wr from"node:fs";import Re from"node:path";import{fileURLToPath as Ws}from"node:url";function It(e){return/^(1|true|yes|on)$/i.test(String(e||"").trim())}function Ke(e){try{return!e||!wr.existsSync(e)?null:JSON.parse(wr.readFileSync(e,"utf8").replace(/^\uFEFF/,""))}catch{return null}}function $t(){let e=Ws(import.meta.url),t=Re.dirname(e),n=[Re.resolve(t,"..",".."),Re.resolve(t,"..")];for(let r of n)if(wr.existsSync(Re.join(r,"package.json")))return r;return n[0]}function Po(){let e=$t(),t=Re.dirname(e);return t&&t!==e?t:e}function Ut(){return process.env.ProgramData||process.env.PROGRAMDATA||"C:\\ProgramData"}function Oo(){let e=Po(),t=[process.env.REVAGENT_UPDATER_CONFIG,Re.join(e,"updater","updater-config.json"),Re.join(Ut(),"DPE","revAgent","updater","updater-config.json"),Re.join(Ut(),"DPE","RevitMCP","updater","updater-config.json")].filter(Boolean);for(let n of t){let r=Ke(n);if(r)return r}return null}function Qt(e=[]){let t=Po(),n=[Re.join(t,"updater","installed.json"),...e,Re.join(Ut(),"DPE","revAgent","updater","installed.json"),Re.join(Ut(),"DPE","RevitMCP","updater","installed.json")];for(let r of n){let o=Ke(r);if(o)return o}return null}function Xt(e){let t=String(e||"").match(/-([0-9a-f]{7,40})$/i);return t?t[1]:null}function Vo(){return Re.join(Ut(),"DPE","revAgent","state","telemetry")}function ct(e){return(String(e||"").trim()||"unknown-machine").toUpperCase()}function In(e,t="unknown"){let n=String(e||"").trim();return n&&n.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g,"_").replace(/_+/g,"_").replace(/^[._-]+|[._-]+$/g,"")||t}import Mn from"node:fs";import Do from"node:path";var Tn=new Map,_n=new Map,Yt=0,xr=0;async function Fo(e,t){await Mn.promises.mkdir(Do.dirname(e),{recursive:!0}),await Mn.promises.writeFile(e,`${JSON.stringify(t,null,2)}
`,"utf8")}async function vr(e,t){await Mn.promises.mkdir(Do.dirname(e),{recursive:!0}),await Mn.promises.appendFile(e,`${JSON.stringify(t)}
`,"utf8")}function Lo(e,t){let r=(Tn.get(e)||Promise.resolve()).catch(()=>{}).then(()=>vr(e,t));return Tn.set(e,r),r.finally(()=>{Tn.get(e)===r&&Tn.delete(e)}).catch(()=>{}),r}function Cr(e,t,n){if(n.disabled())return!1;if(Yt>=n.maxInFlight())return xr++,!1;Yt++;let o=(_n.get(e)||Promise.resolve()).catch(()=>{}).then(()=>t(e));return _n.set(e,o),o.catch(()=>{xr++}).finally(()=>{_n.get(e)===o&&_n.delete(e),Yt=Math.max(0,Yt-1)}),!0}function jo(e){return{inFlight:Yt,dropped:xr,maxInFlight:e}}var Gs=new Set(["completed","failed","guarded"]);function Kt(e,t,n){return e?.[n]!==void 0&&e?.[n]!==null?e[n]:t?.[n]??null}function Nn(e,t){return e??t??null}function Zt(e){return String(e?.state||"").toLowerCase()}function Ir(e){return Gs.has(String(e||"").toLowerCase())}function Bo(e){return e!=null&&e!==""}function zo(e){let t=Date.parse(String(e?.finishedAtUtc||e?.startedAtUtc||""));return Number.isFinite(t)?t:0}function Hs(e,t){let n=Ir(t?.state),r=Ir(e?.state);return n?t||null:r?e||null:t||e||null}function Us(e,t){return Zt(t)==="failed"?t||null:Zt(e)==="failed"&&e||null}function Rr(e,t,n,r){let o=String(e||"").toLowerCase(),i=Zt(n)===o,a=Zt(t)===o;return i&&a?Kt(n,t,r):i?Kt(n,null,r):a?Kt(t,null,r):null}function $s(e,t=""){if(!e||typeof e!="object")return t;if(Bo(e.requestId))return`request:${e.requestId}`;if(Bo(e.id))return`id:${e.id}`;let n=e.method||"",r=e.taskName||"",o=e.startedAtUtc||"";return n||r||o?`task:${n}|${r}|${o}`:t}function Qs(e,t){let n=Hs(e,t),r={...e||{},...t||{}};for(let o of["id","requestId","method","wrapperAction","logicalToolName","taskName","parentTaskName","parentTaskId","startedAtUtc","requestBytes","responseBytes","port"])r[o]=Kt(t,e,o);return r.state=Nn(n?.state,Kt(t,e,"state")),Ir(r.state)?(r.finishedAtUtc=Nn(Rr(r.state,e,t,"finishedAtUtc"),n?.finishedAtUtc),r.elapsedMs=Nn(Rr(r.state,e,t,"elapsedMs"),n?.elapsedMs)):(r.finishedAtUtc=null,r.elapsedMs=null),Zt(r)==="failed"?r.error=Nn(Rr(r.state,e,t,"error"),Us(e,t)?.error):r.error=null,r}function Xs(e,t,n=100){let r=Math.max(1,Math.min(200,Number(n)||100)),o=new Map,i=(a,s)=>{for(let[l,u]of(Array.isArray(a)?a:[]).entries()){if(!u||typeof u!="object")continue;let m=$s(u,`${s}:${l}`),p=o.get(m);o.set(m,p?Qs(p,u):u)}};return i(t,"cached"),i(e,"current"),[...o.values()].sort((a,s)=>zo(s)-zo(a)).slice(0,r)}function qo(e,t){let n=e&&typeof e=="object"?e:null,r=t&&typeof t=="object"?t:null;if(!n&&!r)return null;let o=n?.recentHistoryCapacity??r?.recentHistoryCapacity??100,i=Xs(n?.recentTasks,r?.recentTasks,o),a=Math.max(Number(n?.recentHistoryCount)||0,Number(r?.recentHistoryCount)||0,i.length);return{...r||{},...n||{},activeTask:n?.activeTask||null,recentTasks:i,recentHistoryCount:a,recentHistoryCapacity:o}}var Ys="revagent.telemetry.v1",Ks="revagent.live.status.v1",Uo="revagent.live.activity.v1",Ln=Nr.randomUUID(),$o=new Date().toISOString(),Zs=new Set(["capture_spatial_snapshot","extract_spatial_snapshot","inspect_levels"]),el=new Set(["running","completed","guarded","failed"]),tl=new Set(["capture_spatial_snapshot","extract_spatial_snapshot","inspect_levels"]),nl=new Set(["needs_scope","read_failed","invalid_request","invalid_cursor","invalid_cursor_sort_position","cursor_scope_mismatch","cursor_revision_mismatch","cursor_hash_mismatch","capture_interrupted_by_change","invalid_spatial_page_contract","runtime_exception","invalid_response_kind"]),rl=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),ol=new Set(["complete","incomplete_omissions","incomplete_budget"]),il=0,tn=new Map,ut=[],Qo=null,En=null,Jo=null;function kr(){return It(process.env.REVAGENT_TELEMETRY_DISABLED)}function al(e){return Nr.createHash("sha256").update(String(e||""),"utf8").digest("hex")}function _t(e){return al(e).slice(0,16)}function kn(e,t=400){let n=String(e||"");return n.length<=t?{text:n,truncated:!1}:{text:`${n.slice(0,t)}...[truncated ${n.length-t} chars]`,truncated:!0}}function sl(e){return String(e||"").split(/\r\n|\r|\n/).length}function dt(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function ll(){return dt(process.env.REVAGENT_TELEMETRY_TEXT_CHARS,1e3,0,1e4)}function cl(){return dt(process.env.REVAGENT_TELEMETRY_CODE_CHARS,4e3,0,1e5)}function mt(){return kr()||It(process.env.REVAGENT_LIVE_STATUS_DISABLED)}function Ar(){return dt(process.env.REVAGENT_LIVE_STATUS_RECENT,50,5,200)}function Pr(){return dt(process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT,32,1,64)}function Xo(){return dt(process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS,5e3,0,6e4)}function Or(e){return Zs.has(String(e??"").trim().toLowerCase())}function jn(e={}){let t=e.params||{};return[e.toolName,e.commandName,e.logicalToolName,t.logicalToolName,t.wrapperAction].some(Or)}function An(e={},t){let n=a=>Array.isArray(a)?a.length:0,r=a=>{let s=Number.parseInt(String(a??""),10);return Number.isFinite(s)?s:null},o=["hostOnly","linkedOnly","hostAndLinked"].includes(String(e.sourceScope||""))?e.sourceScope:null,i={privacyBoundary:"spatial_extraction",levelSelectorCount:n(e.levelIds)+n(e.levelNames),levelIdCount:n(e.levelIds),levelNameCount:n(e.levelNames),nameQueryPresent:typeof e.nameQuery=="string"&&e.nameQuery.length>0,linkInstanceSelectorCount:n(e.linkInstanceIds)+n(e.linkInstanceUniqueIds),linkedSourceLevelSelectorCount:n(e.linkedSourceLevels)+n(e.linkedSourceLevelNames),sourceScope:o,cursorPresent:typeof e.cursor=="string"&&e.cursor.length>0,pageTargetBytes:r(e.pageTargetBytes),maxElements:r(e.maxElements),maxResults:r(e.maxResults),maxElapsedMs:r(e.maxElapsedMs),timeoutMs:r(e.timeoutMs)};return String(t??"").trim().toLowerCase()!=="inspect_levels"&&(i.includeHostMep=e.includeHostMep!==!1,i.includeRoomsSpaces=e.includeRoomsSpaces!==!1,i.includeLinkedObstructions=e.includeLinkedObstructions!==!1),i}function ul(e,t){let n=String(e||""),r={hash:_t(n),length:n.length,present:n.length>0};if(t>0){let o=kn(n,t);r.text=o.text,r.textTruncated=o.truncated}return r}function dl(e){let t=String(e||""),n={hash:_t(t),length:t.length,lineCount:sl(t),writePatternCount:Ht(t).length,writePatterns:Ht(t).slice(0,12),hasManualTransaction:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(t)},r=cl();if(r>0){let o=kn(t,r);n.preview=o.text,n.previewTruncated=o.truncated}return n}function ml(e,t){let n=new Set(["transactionMode","responseMode","planMode","planCandidateMode","targetVisualStyle","intent","imageFormat","cameraOrientation","viewType","category","discipline","cropBasis","searchBudget","linkScope","reason","scanStoppedReason"]);if(typeof t=="boolean"||typeof t=="number")return t;if(typeof t=="string")return n.has(e)?t:ul(t,ll())}function Pn(e={}){let t={keys:[]};if(!e||typeof e!="object")return t;let n=Object.keys(e).sort();t.keys=n.filter(r=>r!=="code"&&r!=="parameters");for(let r of n){let o=e[r];if(r==="code"){t.code=dl(o);continue}if(r==="parameters"){t.parameters={count:Array.isArray(o)?o.length:o==null?0:1};continue}if(/elementIds$/i.test(r)&&Array.isArray(o)){t[r]={count:o.length};continue}if(Array.isArray(o)){t[r]={count:o.length};continue}if(o&&typeof o=="object"){t[r]={keys:Object.keys(o).sort()};continue}let i=ml(r,o);i!==void 0&&(t[r]=i)}return t}function Vr(e){if(e&&typeof e=="object"){if(Je(e,["success","Success"])===!1)return e;if("result"in e&&e.result!==null&&e.result!==void 0)return e.result;if("result"in e)return e}return e&&typeof e=="object"&&"result"in e?e.result:e}function Je(e,t){if(!e||typeof e!="object")return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let[r,o]of n)if(t.some(i=>r.toLowerCase()===i.toLowerCase()))return o}function Yo(e){let t=String(e||"").trim().toLowerCase();return t==="runtime"||t==="client"?t:null}function nn(e,t=null){if(t)return{success:!1,errorMessage:kn(t instanceof Error?t.message:String(t)).text,errorType:t instanceof Error?t.name:"Error"};let n=Vr(e),r=n&&typeof n=="object"&&!Array.isArray(n),o=r?Je(n,["success","Success"]):void 0,i=r?Je(n,["state","State"]):void 0,a=r?Je(n,["action","Action"]):void 0,s=r?Je(n,["error","Error","errorMessage","ErrorMessage"]):void 0,l=r?Je(n,["message","Message"]):void 0,u=r?Je(n,["guardSource","GuardSource"]):void 0,m=typeof n=="string"?n:"",p=/^\s*ERROR\s*:/i.test(m)?m:"",g=String(i||"").toLowerCase()==="guarded"||Je(n,["guarded","blocked","focusBlocked"])===!0||/blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(s||l||m||""));return{success:typeof o=="boolean"?o:!s&&!p,guarded:g,guardSource:g?Yo(u)||"runtime":null,state:i||null,action:a||null,responseKind:Array.isArray(n)?"array":n===null?"null":typeof n,responseKeys:r?Object.keys(n).sort().slice(0,40):[],errorMessage:s||p?kn(s||p).text:null,messageHash:l?_t(l):null}}function Wo(e,t=null){if(t)return nn(null,t);try{let n=e?.content?.find?.(r=>r?.type==="text")?.text;if(typeof n=="string"&&n.trim().startsWith("{"))return nn(JSON.parse(n))}catch{}return{success:!0,guarded:!1,responseKind:e===null?"null":typeof e,responseKeys:e&&typeof e=="object"?Object.keys(e).sort().slice(0,40):[]}}function pl(){return dt(process.env.REVAGENT_TELEMETRY_CONTEXT_ELEMENTS,12,0,100)}function Ko(e){if(typeof e!="string")return e;let t=e.trim();if(!t.startsWith("{")&&!t.startsWith("[")&&!t.startsWith('"'))return e;try{let n=JSON.parse(t);return typeof n=="string"?Ko(n):n}catch{return e}}function Zo(e){try{let t=e?.content?.find?.(n=>n?.type==="text")?.text;if(typeof t=="string")return Ko(t)}catch{}return e}function en(e,t){let n=String(e??"").trim().toLowerCase();return t.has(n)?n:null}function On(e,t=null){if(t)return{success:!1,guarded:!1,state:"failed",reason:"runtime_exception",privacyBoundary:"spatial_extraction"};let n=e?.content?Zo(e):e,r=Vr(n),o=De(r);if(!o)return{success:!1,guarded:!1,state:"failed",reason:"invalid_response_kind",privacyBoundary:"spatial_extraction"};let i=De(R(o,["page","Page"])),a=R(o,["nodes","Nodes"]),s=R(o,["omissions","Omissions"]),l=R(o,["sourceRevisions","SourceRevisions"]),u=R(o,["success","Success"]),m=R(o,["guarded","Guarded"])===!0,p=ce(R(i,["ordinal","Ordinal","pageOrdinal","PageOrdinal"]))??ce(R(o,["pageOrdinal","PageOrdinal"])),g=ce(R(i,["recordCount","RecordCount","rowCount","RowCount"]))??ce(R(o,["returnedCount","ReturnedCount"]))??(Array.isArray(a)?a.length:null),y=ce(R(i,["omissionCount","OmissionCount"]))??(Array.isArray(s)?s.length:null),S=ce(R(i,["payloadBytes","PayloadBytes"]))??ce(R(o,["payloadBytes","PayloadBytes"])),E=R(o,["nextCursor","NextCursor"])??R(i,["nextCursor","NextCursor"]);return{success:typeof u=="boolean"?u:!m,guarded:m,state:en(R(o,["state","State"]),el)||(m?"guarded":"completed"),action:en(R(o,["action","Action"]),tl),reason:en(R(o,["reason","Reason"]),nl),scanStoppedReason:en(R(o,["scanStoppedReason","ScanStoppedReason"]),rl),coverageStatus:en(R(o,["coverageStatus","CoverageStatus"]),ol),partial:R(o,["partial","Partial"])===!0,pageOrdinal:p,recordCount:g,omissionCount:y,sourceRevisionCount:Array.isArray(l)?l.length:null,payloadBytes:S,hasMore:R(i,["hasMore","HasMore"])===!0,nextCursorPresent:typeof E=="string"&&E.length>0,privacyBoundary:"spatial_extraction"}}function De(e){return e&&typeof e=="object"&&!Array.isArray(e)?e:null}function R(e,t){return Je(e,t)}function B(e,t,n=5){if(n<0||e===null||e===void 0)return;if(Array.isArray(e)){for(let i of e.slice(0,50)){let a=B(i,t,n-1);if(a!=null&&a!=="")return a}return}let r=De(e);if(!r)return;let o=R(r,t);if(o!=null&&o!=="")return o;for(let i of Object.values(r)){let a=B(i,t,n-1);if(a!=null&&a!=="")return a}}function Vn(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let i of e.slice(0,50))Vn(i,t,n-1,r);return r}let o=De(e);if(!o)return r;for(let[i,a]of Object.entries(o))t.some(s=>i.toLowerCase()===s.toLowerCase())&&Array.isArray(a)&&r.push(a),Vn(a,t,n-1,r);return r}function _r(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let i of e.slice(0,50))_r(i,t,n-1,r);return r}let o=De(e);if(!o)return r;for(let[i,a]of Object.entries(o))t.some(s=>i.toLowerCase()===s.toLowerCase())&&De(a)&&r.push(a),_r(a,t,n-1,r);return r}function U(e){return e==null?null:typeof e=="string"?e:typeof e=="number"||typeof e=="boolean"?String(e):null}function ce(e){return typeof e=="number"&&Number.isFinite(e)?e:typeof e=="string"&&/^-?\d+$/.test(e.trim())?Number.parseInt(e.trim(),10):null}function ei(e,t=25){return[...new Set((Array.isArray(e)?e:[]).map(n=>ce(n)).filter(n=>Number.isFinite(n)))].slice(0,t)}function hl(e={}){let t=[];e.elementId!==void 0&&t.push(e.elementId),e.viewId!==void 0&&t.push(e.viewId);for(let[n,r]of Object.entries(e||{}))/elementIds$/i.test(n)&&Array.isArray(r)&&t.push(...r);return ei(t,50)}function Go(e){let t=De(e);if(!t)return null;let n=ce(R(t,["id","Id","elementId","ElementId"])),r=U(R(t,["name","Name"])),o=U(R(t,["category","Category","categoryName","CategoryName"])),i=U(R(t,["typeName","TypeName","familyName","FamilyName"])),a=U(R(t,["levelName","LevelName","level","Level"])),s=U(R(t,["roomName","RoomName","room","Room"])),l=U(R(t,["roomNumber","RoomNumber"])),u=U(R(t,["spaceName","SpaceName","space","Space"])),m=U(R(t,["spaceNumber","SpaceNumber"]));return!n&&!r&&!o&&!i&&!a&&!s&&!u?null:{id:n,name:r,category:o,typeName:i,levelName:a,roomName:s,roomNumber:l,spaceName:u,spaceNumber:m}}function fl(e){let t=new Set;return e.filter(n=>{if(!n)return!1;let r=n.id?`id:${n.id}`:JSON.stringify(n);return t.has(r)?!1:(t.add(r),!0)})}function gl(e,t){let n=Vn(e,["elements","Elements","selectionElements","SelectionElements"]),r=_r(e,["chosenElement","ChosenElement","targetElement","TargetElement"]),o=[];for(let i of r)o.push(Go(i));for(let i of n)for(let a of i.slice(0,t))o.push(Go(a));return fl(o).slice(0,t)}function yl(e){let t=B(e,["selectionIds","SelectionIds"],4);return Array.isArray(t)?ei(t,50):[]}function bl(e){let t=Vn(e,["files","Files"],4),n=[];for(let r of t)for(let o of r.slice(0,12)){let i=De(o);i&&n.push({path:U(R(i,["path","Path"])),fileName:U(R(i,["fileName","FileName"])),bytes:ce(R(i,["bytes","Bytes"])),width:ce(R(i,["width","Width"])),height:ce(R(i,["height","Height"])),finalPixelSizeMatchesRequest:R(i,["finalPixelSizeMatchesRequest","FinalPixelSizeMatchesRequest"])})}return n.filter(r=>r.path||r.fileName)}function Tr(e,t){let n=B(e,t,4);return De(n)?{id:ce(R(n,["id","Id","viewId","ViewId"])),name:U(R(n,["name","Name","viewName","ViewName"])),type:U(R(n,["type","Type","viewType","ViewType"]))}:null}function Sl(e,t=20){return[...new Set(e.filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim()))].slice(0,t)}function wl(e=[],t="",n="",r=""){let o=`${e.join(" ")} ${t} ${n} ${r}`.toLowerCase();return/\bm\d{2,}[a-z]?\b/i.test(o)?"mechanical_hvac":/\bp\d{2,}[a-z]?\b/i.test(o)?"mechanical_piping":/\be\d{2,}[a-z]?\b/i.test(o)?"electrical":/\bs\d{2,}[a-z]?\b/i.test(o)?"structural":/\ba\d{2,}[a-z]?\b/i.test(o)?"architectural":/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(o)?"mechanical_hvac":/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)/i.test(o)?"mechanical_piping":/(electrical|cable|lighting|elektrik)/i.test(o)?"electrical":/(structural|beam|column|framing|statik|kiris|kolon)/i.test(o)?"structural":/(wall|door|window|room|space|architect|mimari)/i.test(o)?"architectural":/(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)/i.test(o)?"schedule_documentation":null}function xl(e,t){let n=e||t||"";return n?_t(n):null}function vl(e={},t=[]){for(let n of t){let r=e?.[n];if(typeof r=="string"&&r.trim())return r.trim()}return null}function Cl(e={},t=[]){return t.map(n=>e?.[n]).filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim())}function Rl(e={},t="",n=null,r=null,o=null,i={}){return[t,i.toolName,i.commandName,i.logicalToolName,...Cl(e,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery","planNameContains","category","discipline"]),...Array.isArray(e.rowTextQueries)?e.rowTextQueries:[],...Array.isArray(e.categoryNames)?e.categoryNames:[],n?.name,r?.name,o?.name].filter(s=>typeof s=="string"&&s.trim()).join(" ")}function Il(...e){let t=e.filter(i=>typeof i=="string"&&i.trim()).join(" ");if(!t)return null;let n=t.match(/\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b/i);if(n)return`Level ${n[1].padStart(2,"0")}`;let r=t.match(/\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b/i);if(r)return`Level ${r[1].padStart(2,"0")}`;let o=t.match(/\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b/i);return o?`Basement ${o[1].padStart(2,"0")}`:null}function Tl(e={}){if(jn(e))return null;let t=e.sourceEventType==="mcp.tool"?Zo(e.response):Vr(e.response),n=De(t),r=e.params||{},o=e.taskName||r.taskName||e.options?.taskName||e.logicalToolName||e.toolName||e.commandName||null,i=e.responseSummary||nn(e.response,e.error),a=pl(),s=a>0?gl(t,a):[],l=Sl([...Array.isArray(r.categoryNames)?r.categoryNames.map(String):[],U(r.category),...s.map(M=>M.category)]),u=B(t,["document","Document"],3),m=U(B(t,["documentTitle","DocumentTitle"],5))||U(R(u,["title","Title","name","Name"])),p=U(B(t,["documentPath","DocumentPath"],5))||U(R(u,["path","Path","modelPath","ModelPath"])),g=Tr(t,["activeView","ActiveView","view","View"]),y=Tr(t,["beforeView","BeforeView","activeViewBefore","ActiveViewBefore"]),S=Tr(t,["afterView","AfterView"]),E=hl(r),A=yl(t),L=bl(t),j=U(B(t,["levelName","LevelName","activePlanLevelName","ActivePlanLevelName"],5)),O=ce(B(t,["levelId","LevelId","activePlanLevelId","ActivePlanLevelId"],5)),H=U(B(t,["roomName","RoomName"],5)),Y=U(B(t,["roomNumber","RoomNumber"],5)),ee=U(B(t,["spaceName","SpaceName"],5)),te=U(B(t,["spaceNumber","SpaceNumber"],5)),re=vl(r,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery"]),$=typeof r.outputDir=="string"?r.outputDir:U(B(t,["outputDir","OutputDir"],4)),oe=typeof r.filePrefix=="string"?r.filePrefix:U(B(t,["filePrefix","FilePrefix"],4)),Ce=Rl(r,o||"",g,y,S,e),Me=j||Il(Ce),je=B(t,["inferredScope","InferredScope"],5),Be=B(t,["effectiveScope","EffectiveScope"],5),Ne=B(t,["riskPolicy","RiskPolicy","searchRiskPolicy","SearchRiskPolicy"],5),Rt=B(t,["scanPolicy","ScanPolicy"],5),Gt=B(t,["partial","Partial"],4),wn=U(B(t,["scanStoppedReason","ScanStoppedReason"],4)),ze=ce(B(t,["scannedElementCount","ScannedElementCount"],4));return!(o||m||p||g||y||S||E.length||A.length||s.length||L.length||Me||H||ee||re||$)?null:{eventType:"production.context",contextSchemaVersion:"revagent.production.context.v1",related:{sourceEventType:e.sourceEventType,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null},runId:e.taskId||r.taskId||e.options?.taskId||_t(`${Ln}|${e.sourceEventType||""}|${e.toolName||""}|${e.commandName||""}|${e.startedAtMs||""}|${o||""}`),operation:{taskName:o,query:re,action:i.action||U(B(t,["action","Action"],3)),durationMs:e.durationMs,success:i.success,guarded:i.guarded,state:i.state,errorMessage:i.errorMessage},project:{projectId:xl(p,m),documentTitle:m,documentPath:p,isFamilyDocument:B(t,["isFamilyDocument","IsFamilyDocument"],4),isReadOnly:B(t,["isReadOnly","IsReadOnly"],4),isModifiable:B(t,["isModifiable","IsModifiable"],4)},view:{active:g,before:y,after:S,activeViewChanged:B(t,["activeViewChanged","ActiveViewChanged"],4)},location:{levelId:O,levelName:Me,roomName:H,roomNumber:Y,spaceName:ee,spaceNumber:te},elements:{targetElementIds:E,selectionIds:A,selectionCount:ce(B(t,["selectionCount","SelectionCount"],4)),categories:l,disciplineHint:wl(l,o||"",Ce,e.toolName||e.logicalToolName||e.commandName||""),samples:s,samplesTruncated:a>0&&s.length>=a},outputs:{outputDir:$,filePrefix:oe,files:L},search:{query:re,inferredScope:je,effectiveScope:Be,riskPolicy:Ne,riskLevel:R(Ne,["riskLevel","RiskLevel"])||null,recommendedFirstScope:R(Ne,["recommendedFirstScope","RecommendedFirstScope"])||null,requiresUserControl:R(Ne,["requiresUserControl","RequiresUserControl"])===!0,scanPolicy:Rt,searchBudget:r.searchBudget||R(Rt,["searchBudget","SearchBudget"])||null,linkScope:r.linkScope||R(Be,["linkScope","LinkScope"])||null,planCandidateMode:r.planCandidateMode||R(Rt,["planCandidateMode","PlanCandidateMode"])||null,allowExpensiveSearch:r.allowExpensiveSearch===!0||R(Rt,["allowExpensiveSearch","AllowExpensiveSearch"])===!0,scannedElementCount:ze,partial:Gt===!0,scanStoppedReason:wn,needsScope:i.guarded&&i.state==="guarded"&&(R(n,["reason","Reason"])==="needs_scope"||wn==="needs_scope")},response:{responseKeys:i.responseKeys||(n?Object.keys(n).sort().slice(0,40):[])}}}function Mr(e={}){let t=Tl(e);t&&rn(t)}function ti(){let e=Oo();return{disabled:kr(),localOnly:It(process.env.REVAGENT_TELEMETRY_LOCAL_ONLY),localRoot:process.env.REVAGENT_TELEMETRY_ROOT||Vo(),reportsRoot:process.env.REVAGENT_REPORTS_ROOT||e?.reportsRoot||""}}function ni(e){let t=e.getUTCFullYear().toString(),n=String(e.getUTCMonth()+1).padStart(2,"0"),r=String(e.getUTCDate()).padStart(2,"0");return{year:t,month:n,day:r,ymd:`${t}-${n}-${r}`}}function _l(e){let t=ti();if(t.disabled)return[];let n=new Date(e.timestampUtc||Date.now()),r=ni(n),o=In(ct(e.machineName),"unknown-machine"),a=[{kind:"local",path:Tt.join(t.localRoot,"events",`${r.ymd}.ndjson`)}];return!t.localOnly&&t.reportsRoot&&a.push({kind:"remote",path:Tt.join(t.reportsRoot,"events",r.year,r.month,r.day,o,`${e.sessionId}.ndjson`)}),a}function Ml(){let e=ti();return{disabled:mt(),localOnly:e.localOnly||It(process.env.REVAGENT_LIVE_STATUS_LOCAL_ONLY),localRoot:process.env.REVAGENT_LIVE_STATUS_LOCAL_ROOT||Tt.join(e.localRoot,"live"),reportsRoot:process.env.REVAGENT_LIVE_STATUS_ROOT||(e.reportsRoot?Tt.join(e.reportsRoot,"live"):"")}}function ri(e=[]){let t=Ml();if(t.disabled)return[];let r=["machines",In(ct(process.env.COMPUTERNAME||Er.hostname()),"unknown-machine"),...e],o=[{kind:"local",path:Tt.join(t.localRoot,...r)}];return!t.localOnly&&t.reportsRoot&&o.push({kind:"remote",path:Tt.join(t.reportsRoot,...r)}),o}function oi(e){return!e||typeof e!="object"||Array.isArray(e)?null:{success:typeof e.success=="boolean"?e.success:null,guarded:e.guarded===!0,guardSource:e.guardSource||null,state:e.state||null,action:e.action||null,errorMessage:e.errorMessage||null,messageHash:e.messageHash||null}}function Dn(e,t="summary"){if(!e)return null;let n={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,taskIdPresent:!!e.taskId,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,state:e.state,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:t==="full"?e.result||null:oi(e.result)};return t!=="full"&&!n.result&&delete n.result,n}function Ho(e){if(!e||typeof e!="object")return null;let t=e.commandName||e.method||null,n=e.wrapperAction||e.logicalToolName||e.toolName||t,r=[t,n,e.wrapperAction,e.logicalToolName].some(Or);return{id:e.id||null,requestId:e.requestId||null,method:n||null,toolName:n||null,commandName:t,wrapperAction:e.wrapperAction||null,logicalToolName:e.logicalToolName||null,taskName:r?null:e.taskName||null,parentTaskName:r?null:e.parentTaskName||null,parentTaskIdPresent:r?!1:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,elapsedMs:e.elapsedMs??null,requestBytes:e.requestBytes??null,responseBytes:e.responseBytes??null,port:e.port||null,error:r?null:e.error||null}}function Nl(e,t){if(t==="full")return e;let n=oi(e.result),r={timestampUtc:e.timestampUtc||e.finishedAtUtc||e.startedAtUtc||null,phase:e.phase,state:e.state||e.phase||null,scope:e.scope||null,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),guardSource:e.guardSource||n?.guardSource||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null};return n&&(r.success=n.success,r.guarded=n.guarded,r.action=n.action,r.errorMessage=n.errorMessage,r.messageHash=n.messageHash),Object.fromEntries(Object.entries(r).filter(([,o])=>o!=null))}function ii(e=10,t="summary"){let n=dt(e,10,0,100),r=t==="full"?"full":"summary",i=(r==="full"?ut:ut.filter(a=>a.phase!=="started")).slice(0,n).map(a=>Nl(a,r));return{mode:r,activeTask:Dn(ai(),r),activeTasks:[...tn.values()].map(a=>Dn(a,r)),recentActivity:i,recentActivityCount:i.length,recentActivityStoredCount:ut.length,recentActivityCapacity:Ar()}}function El(e){if(!e||typeof e!="object")return null;let t=e.result&&typeof e.result=="object"?e.result:e;return{capturedAtUtc:new Date().toISOString(),activeTask:Ho(t.activeTask),recentTasks:(Array.isArray(t.recentTasks)?t.recentTasks:[]).map(Ho).filter(Boolean).slice(0,100),recentHistoryCount:t.recentHistoryCount??null,recentHistoryCapacity:t.recentHistoryCapacity??null}}function Bn(e){if(mt())return;let t=El(e);t&&(Qo=t,Fn("revit.status"))}function ai(){let e=[...tn.values()];return e.length===0?null:e.sort((t,n)=>{let r=i=>i.scope==="revit.command"?2:1,o=r(n)-r(t);return o!==0?o:String(n.startedAtUtc||"").localeCompare(String(t.startedAtUtc||""))})[0]}function kl(e="activity"){let n=Qt()?.version||null,r=new Date().toISOString();return Jo=r,{schemaVersion:Ks,generatedAtUtc:r,lastHeartbeatUtc:Jo,reason:e,machineName:ct(process.env.COMPUTERNAME||Er.hostname()),userName:process.env.USERNAME||process.env.USER||"",sessionId:Ln,runtime:{version:n,buildHash:Xt(n)},process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:$o},activeTask:Dn(ai(),"full"),activeTasks:[...tn.values()].map(o=>Dn(o,"full")),recentActivity:ut.slice(0,Ar()),revitStatus:Qo,writeHealth:jo(Pr())}}function Al(e){let t=Array.isArray(e?.revitStatus?.recentTasks)?e.revitStatus.recentTasks:[],n=Array.isArray(e?.activeTasks)?e.activeTasks:[],r=Array.isArray(e?.recentActivity)?e.recentActivity:[];return!!(e?.activeTask||n.length>0||r.length>0||e?.revitStatus?.activeTask||t.length>0)}function Pl(e){let t=Date.parse(String(e?.generatedAtUtc||e?.lastHeartbeatUtc||""));return Number.isFinite(t)?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY}function Ol(e,t){let n=Ke(e);if(!n||ct(n.machineName)!==ct(t.machineName))return t;let r=Math.max(600*1e3,Xo()*6);return!Al(n)||Pl(n)>r?t:{...t,recentActivity:Array.isArray(t.recentActivity)&&t.recentActivity.length>0?t.recentActivity:Array.isArray(n.recentActivity)?n.recentActivity:[],revitStatus:qo(t.revitStatus,n.revitStatus)}}function Fn(e="activity"){let t=kl(e);for(let n of ri(["status.json"]))Cr(n.path,r=>Fo(r,Ol(r,t)),{disabled:mt,maxInFlight:Pr})}function Vl(e){let t={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName,commandName:e.commandName,logicalToolName:e.logicalToolName,executionKind:e.executionKind,taskName:e.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,guardSource:e.guardSource,state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,durationMs:e.durationMs,result:e.result};e.phase==="started"?tn.set(e.liveTaskId,t):tn.delete(e.liveTaskId),ut.unshift({timestampUtc:e.timestampUtc,phase:e.phase,state:e.state,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:e.result||null});let n=Ar();ut.length>n&&ut.splice(n)}function si(e){Vl(e);let t=ni(new Date(e.timestampUtc||Date.now()));for(let n of ri(["activity",`${t.ymd}.ndjson`]))Cr(n.path,r=>vr(r,e),{disabled:mt,maxInFlight:Pr});Fn(e.phase)}function Dl(e={},t){return e.taskId?String(e.taskId):_t([Ln,e.scope||"",e.toolName||"",e.commandName||"",e.logicalToolName||"",t||Date.now(),e.taskName||""].join("|"))}function Mt(e={}){if(mt())return null;let t=jn(e),n=t?{...e,taskName:null,taskId:null,parentTaskName:null,parentTaskId:null}:e,r=n.startedAtMs||Date.now(),o=new Date(r).toISOString(),i=Dl(n,r),a=Dr({schemaVersion:Uo,eventType:"live.activity",phase:"started",state:"running",liveTaskId:i,scope:n.scope||"runtime",toolName:n.toolName||null,commandName:n.commandName||null,logicalToolName:n.logicalToolName||null,executionKind:n.executionKind||null,taskName:n.taskName||null,taskId:n.taskId||null,taskIdPresent:!!n.taskId,parentTaskName:n.parentTaskName||null,parentTaskId:n.parentTaskId||null,parentTaskIdPresent:!!n.parentTaskId,startedAtUtc:o,params:t?An(n.params,n.toolName||n.logicalToolName||n.commandName):Pn(n.params)});return si(a),{liveTaskId:i,scope:a.scope,toolName:a.toolName,commandName:a.commandName,logicalToolName:a.logicalToolName,executionKind:a.executionKind,taskName:a.taskName,taskId:a.taskId,parentTaskName:a.parentTaskName,parentTaskId:a.parentTaskId,guardSource:a.guardSource,startedAtMs:r,startedAtUtc:o}}function ke(e,t={}){if(!e||mt())return;let n=Date.now(),r=t.durationMs??Math.max(0,n-(e.startedAtMs||n)),i=jn({...t,...e})?On(t.response,t.error):t.responseSummary||nn(t.response,t.error),a=i.guarded?"guarded":i.success===!1?"failed":"completed",s=i.guarded?Yo(t.guardSource||e.guardSource||i.guardSource)||"runtime":null,l=Dr({schemaVersion:Uo,eventType:"live.activity",phase:a,state:a,liveTaskId:e.liveTaskId,scope:e.scope||t.scope||"runtime",toolName:e.toolName||t.toolName||null,commandName:e.commandName||t.commandName||null,logicalToolName:e.logicalToolName||t.logicalToolName||null,executionKind:e.executionKind||t.executionKind||null,taskName:e.taskName||t.taskName||null,taskId:e.taskId||t.taskId||null,taskIdPresent:!!(e.taskId||t.taskId),parentTaskName:e.parentTaskName||t.parentTaskName||null,parentTaskId:e.parentTaskId||t.parentTaskId||null,parentTaskIdPresent:!!(e.parentTaskId||t.parentTaskId),guardSource:s,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:new Date(n).toISOString(),durationMs:r,result:i});si(l)}function Fl(){if(En||mt())return;let e=Xo();e<=0||(Fn("session.start"),En=setInterval(()=>{Fn("heartbeat")},e),typeof En.unref=="function"&&En.unref())}function Dr(e={}){let n=Qt()?.version||null;return{schemaVersion:Ys,eventId:Nr.randomUUID(),eventType:e.eventType||"runtime.event",timestampUtc:e.timestampUtc||new Date().toISOString(),sessionId:Ln,sequence:++il,source:"runtime-mcp-server",process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:$o},machineName:ct(process.env.COMPUTERNAME||Er.hostname()),userName:process.env.USERNAME||process.env.USER||"",runtime:{version:n,buildHash:Xt(n)},...e}}async function rn(e={}){if(kr())return;let t=Dr(e),n=_l(t);await Promise.allSettled(n.map(r=>Lo(r.path,t)))}function li(){Fl(),rn({eventType:"runtime.session.start"})}function We(e={}){let t=Math.max(0,Date.now()-(e.startedAtMs||Date.now())),n=jn(e),r=n?On(e.response,e.error):nn(e.response,e.error);rn({eventType:"revit.command",commandName:e.commandName,logicalToolName:e.logicalToolName||e.commandName,executionKind:e.executionKind||"bridgeCommand",taskName:n?null:e.params?.taskName||e.options?.taskName||null,taskIdPresent:n?!1:!!(e.params?.taskId||e.options?.taskId),parentTaskName:n?null:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskIdPresent:n?!1:!!(e.params?.parentTaskId||e.options?.parentTaskId),transactionMode:n?null:e.params?.transactionMode||e.options?.transactionMode||null,connection:n?void 0:{targetPresent:!!e.options?.target,hostPresent:!!e.options?.host,port:e.options?.port||null},durationMs:t,params:n?An(e.params,e.logicalToolName||e.commandName):Pn(e.params),result:r}),Mr({...e,sourceEventType:"revit.command",durationMs:t,responseSummary:r,taskName:e.params?.taskName||e.options?.taskName||null,taskId:e.params?.taskId||e.options?.taskId||null,parentTaskName:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskId:e.params?.parentTaskId||e.options?.parentTaskId||null})}function Ll(e){return!(e==="get_revit_mcp_status"&&!It(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS))}function ci(e){return{...e,tool(t,n,r,o){let i=n,a=r,s=o;typeof n=="object"&&(s=r,a=n,i="");let l=async(u,m)=>{let p=Date.now(),g=Ll(t),y=Or(t),S=g?Mt({scope:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,startedAtMs:p}):null;try{let E=await s(u,m);if(g){let A=Math.max(0,Date.now()-p),L=y?On(E):Wo(E);rn({eventType:"mcp.tool",toolName:t,taskName:y?null:u?.taskName||null,taskIdPresent:y?!1:!!u?.taskId,parentTaskName:y?null:u?.parentTaskName||null,parentTaskIdPresent:y?!1:!!u?.parentTaskId,durationMs:A,params:y?An(u,t):Pn(u),result:L}),Mr({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,response:E,durationMs:A,startedAtMs:p,responseSummary:L}),ke(S,{response:E,responseSummary:L,durationMs:A})}return E}catch(E){if(g){let A=Math.max(0,Date.now()-p),L=y?On(null,E):Wo(null,E);rn({eventType:"mcp.tool",toolName:t,taskName:y?null:u?.taskName||null,taskIdPresent:y?!1:!!u?.taskId,parentTaskName:y?null:u?.parentTaskName||null,parentTaskIdPresent:y?!1:!!u?.parentTaskId,durationMs:A,params:y?An(u,t):Pn(u),result:L}),Mr({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,error:E,durationMs:A,startedAtMs:p,responseSummary:L}),ke(S,{error:E,responseSummary:L,durationMs:A})}throw E}};return e.tool(t,i,a,l)}}}var jl=2;function w(e){return{target:e.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVAGENT_TARGET, then legacy REVIT_MCP_TARGET, then REVAGENT_PORT/8080."),host:e.string().optional().describe("Optional Revit socket host. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),port:e.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVAGENT_PORT, then legacy REVIT_MCP_PORT, then 8080.")}}function x(e){return{taskName:e.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),taskId:e.string().optional().describe("Optional client task identifier forwarded to Revit status history."),parentTaskName:e.string().optional().describe("Optional parent workflow display name. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task."),parentTaskId:e.string().optional().describe("Optional parent workflow identifier. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task id.")}}function d(e,t,n){if(!e||typeof e!="object")return;let r=n??t.charAt(0).toLowerCase()+t.slice(1);return e[t]??e[r]}function se(e={}){return{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs}}function ye(e={},t){return{taskName:e.taskName||t,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId}}function T(e={},t){return{...se(e),...ye(e,t)}}function di(e,t){let n=t.parentTaskName||(t.taskName&&e.taskName&&e.taskName!==t.taskName?t.taskName:void 0),r=t.parentTaskId||(t.taskId&&e.taskName&&e.taskName!==t.taskName?t.taskId:void 0);n&&!e.parentTaskName&&(e.parentTaskName=n),r&&!e.parentTaskId&&(e.parentTaskId=r)}function mi(e,t,n){let r=n.toolName||t;r&&!e.logicalToolName&&(e.logicalToolName=r),n.toolName&&n.toolName!==t&&!e.wrapperAction&&(e.wrapperAction=n.toolName)}function zn(e){let t=[["Success","success"],["SUCCESS","success"],["Guarded","guarded"],["State","state"],["Action","action"],["Message","message"],["Error","error"],["ResultContractVersion","resultContractVersion"]],n=r=>{if(Array.isArray(r))return r.map(i=>n(i));if(!r||typeof r!="object")return r;let o={};for(let[i,a]of Object.entries(r))o[i]=n(a);for(let[i,a]of t)Object.prototype.hasOwnProperty.call(o,i)&&(Object.prototype.hasOwnProperty.call(o,a)||(o[a]=o[i]),delete o[i]);return o};return n(e)}function h(e){let t=zn(e);return{content:[{type:"text",text:JSON.stringify(t,null,2)}]}}function on(e,t=0){if(typeof e!="string")return e;let n=e.trim();if(!n.startsWith("{")&&!n.startsWith("[")&&!n.startsWith('"'))return e;try{let r=JSON.parse(n);return t<2&&typeof r=="string"?on(r,t+1):r}catch{return e}}function qn(e){if(Array.isArray(e))return e.map(n=>qn(n));if(!e||typeof e!="object")return e;let t={};for(let[n,r]of Object.entries(e)){let o=n==="result"||n==="Result"?on(r):r;t[n]=qn(o)}return t}function Bl(e){if(!e||typeof e!="object"||Array.isArray(e))return null;let t=e.resultContractVersion??e.ResultContractVersion,n=Number.parseInt(String(t??""),10);return Number.isFinite(n)?n:null}function zl(e){let t=Bl(e);return t!==null&&t>=jl}function Ge(e,t={}){let n=on(e);if(zl(n))return t.parseResultStrings===!0?zn(qn(n)):n;if(n&&typeof n=="object"&&!Array.isArray(n)){let r=n;return t.parseResultStrings===!0?r=qn(r):("result"in r||"Result"in r)&&(r={...r},"result"in r?r.result=on(r.result):r.Result=on(r.Result)),zn(r)}return zn(n)}function pi(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function ht(e,t={}){let n=t.verboseCandidates===!0,r=pi(t.maxPlanCandidates,3,0,100);if(n)return e;let o=i=>{if(Array.isArray(i))return i.map(s=>o(s));if(!i||typeof i!="object")return i;let a={};for(let[s,l]of Object.entries(i)){if((s==="PlanCandidates"||s==="planCandidates")&&Array.isArray(l)){let u=s==="PlanCandidates"?"PlanCandidatesTotal":"planCandidatesTotal",m=s==="PlanCandidates"?"PlanCandidatesTruncated":"planCandidatesTruncated";a[u]=l.length,a[m]=l.length>r,a[s]=l.slice(0,r).map(p=>o(p));continue}a[s]=o(l)}return a};return o(e)}function ui(e,t){if(!e||typeof e!="object")return e;let n=e.commandName||e.method,r=e.wrapperAction||e.logicalToolName||e.toolName||n,o={id:e.id,requestId:e.requestId,method:r,toolName:r,commandName:n,wrapperAction:e.wrapperAction,logicalToolName:e.logicalToolName,taskName:e.taskName,parentTaskName:e.parentTaskName,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,elapsedMs:e.elapsedMs,port:e.port,error:e.error};return t&&(o.framing=e.framing,o.requestBytes=e.requestBytes,o.receiveMs=e.receiveMs,o.parseMs=e.parseMs,o.executeMs=e.executeMs,o.responseBytes=e.responseBytes),o}function an(e,t={}){let n=t.includeRecentTasks!==!1,r=t.includeDiagnostics===!0,o=pi(t.recentLimit,3,0,100),i=e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e;if(!i||typeof i!="object")return e;let a={...i};return a.activeTask=ui(i.activeTask,r),Array.isArray(i.recentTasks)&&(a.recentHistoryCount=i.recentHistoryCount??i.recentTasks.length,a.recentHistoryCapacity=i.recentHistoryCapacity??100,delete a.recentTasksTotal,n?(a.recentTasks=i.recentTasks.slice(0,o).map(s=>ui(s,r)),a.recentTasksTruncated=i.recentTasks.length>o):(delete a.recentTasks,a.recentTasksIncluded=!1)),e&&typeof e=="object"&&e.result&&typeof e.result=="object"?{...e,result:a}:a}async function K(e,t={}){let n={code:e,parameters:t.parameters||[],transactionMode:t.transactionMode||"none",taskName:t.taskName||"Run Revit code"};t.taskId&&(n.taskId=t.taskId),mi(n,"send_code_to_revit",t),di(n,t);let r=Date.now(),o=Mt({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",taskName:n.taskName,taskId:n.taskId,parentTaskName:n.parentTaskName,parentTaskId:n.parentTaskId,params:n,startedAtMs:r});try{let i=await Ee(async l=>await l.sendCommand("send_code_to_revit",n,t),t),a=t.parseJsonResult===!1?i:Ge(i,{parseResultStrings:!0}),s=Math.max(0,Date.now()-r);return We({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,response:a,startedAtMs:r}),ke(o,{response:a,durationMs:s}),pt(t),a}catch(i){let a=Math.max(0,Date.now()-r);throw We({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,error:i,startedAtMs:r}),ke(o,{error:i,durationMs:a}),pt(t),i}}async function pt(e={}){let t=Math.max(250,Math.min(5e3,Number(e.statusRefreshTimeoutMs||1500)));try{let n=await Ee(async r=>await r.sendCommand("mcp_status",{},{timeoutMs:t}),{...e,skipLock:!0,connectTimeoutMs:t,timeoutMs:t,logSocketErrors:!1});return Bn(n),n}catch{return null}}async function _(e,t={},n={}){let r={...t};r.taskName||(r.taskName=n.taskName||e),di(r,n),n.taskId&&!r.taskId&&(r.taskId=n.taskId),mi(r,e,n);let o=Date.now(),i=Mt({scope:"revit.command",commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:o});try{let a=await Ee(async u=>await u.sendCommand(e,r,n),n),s=Ge(a),l=Math.max(0,Date.now()-o);return We({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,response:s,startedAtMs:o}),ke(i,{response:s,durationMs:l}),pt(n),s}catch(a){let s=Math.max(0,Date.now()-o);throw We({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,error:a,startedAtMs:o}),ke(i,{error:a,durationMs:s}),pt(n),a}}function N(e){return e==null?"null":`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n")}"`}function Ae(e){return`new string[] { ${(Array.isArray(e)?e:[]).map(N).join(", ")} }`}function Jn(e){return`new int[] { ${(Array.isArray(e)?e:[]).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function hi(e,t){let n=Number(t||0);return!n||typeof e!="string"||e.length<=n?{text:e,truncated:!1}:{text:`${e.slice(0,n)}
...[truncated ${e.length-n} chars]`,truncated:!0}}function ql(e){let t=new Set,n=(r,o="")=>{if(r!=null){if(typeof r=="number"&&/(^id$|elementid|elementids)/i.test(o)){t.add(r);return}if(typeof r=="string"&&/^-?\d+$/.test(r)&&/(^id$|elementid|elementids)/i.test(o)){t.add(Number.parseInt(r,10));return}if(Array.isArray(r)){for(let i of r)n(i,o);return}if(typeof r=="object")for(let[i,a]of Object.entries(r))n(a,i)}};return n(e),[...t].filter(r=>Number.isFinite(r)&&r>0)}async function Nt(e=100,t={}){let n=await _("get_selected_elements",{limit:e},t);return ql(n).slice(0,e)}var Jl=new Set(["success","guarded","state","action","error","reason","warnings","notices"]);function fi(e){let t=String(e||"").trim();return t.length>0?t:void 0}function gi(e){if(!Array.isArray(e))return;let t=e.map(n=>String(n||"").trim()).filter(n=>n.length>0);return t.length>0?t:void 0}function Wl(e){return e?Object.fromEntries(Object.entries(e).filter(([t])=>!Jl.has(t))):{}}function Fr(e,t){let n={...Wl(t.extra),...e,action:t.action},r=fi(t.error),o=fi(t.reason),i=gi(t.warnings),a=gi(t.notices);return r&&(n.error=r),o&&(n.reason=o),i&&(n.warnings=i),a&&(n.notices=a),n}function yi(e){return Fr({success:!0,guarded:!1,state:"completed",action:e.action},e)}function Fe(e){return Fr({success:!1,guarded:!0,state:"guarded",action:e.action},e)}function Ie(e){return Fr({success:!1,guarded:!1,state:"failed",action:e.action},e)}function Gl(e){let t=String(e||"");return t.match(/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\b(?:class|struct|interface|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*/m)?{reason:"dynamic_snippet_type_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). C# type declarations such as class/struct/interface/enum/record cannot be declared inside that method body. Use local functions, built-in collections, or add a native runtime tool when reusable helper types are needed."}:t.match(/^\s*namespace\s+[A-Za-z_][A-Za-z0-9_.]*/m)?{reason:"dynamic_snippet_namespace_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). namespace declarations cannot be declared inside that method body. Use method-body C# only."}:null}function Hl(e){let t=Ge(e);if(t&&typeof t=="object"&&t.success===!1)return t.error||t.errorMessage||t.message||"Revit code returned success=false.";let n=t&&typeof t=="object"&&"result"in t?t.result:t;return typeof n=="string"&&/^\s*ERROR\s*:/i.test(n)?n.trim():n&&typeof n=="object"&&n.success===!1?n.error||n.message||"Revit code returned success=false.":null}function bi(e){e.tool("send_code_to_revit","Send C# code to Revit for execution. The code will be inserted into a template with access to the Revit Document and parameters. Your code should be written to work within the Execute method of the template.",{...w(He),...x(He),code:He.string().describe("The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."),parameters:He.array(He.any()).optional().describe("Optional execution parameters that will be passed to your code"),transactionMode:He.enum(["auto","none"]).optional().describe("Transaction handling mode forwarded to the Revit wrapper. In the bundled plugin build, snippets should not open their own Transaction unless that exact build has been verified."),timeoutMs:He.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),reportErrorResultAsFailure:He.boolean().optional().describe("When true, ERROR: string results or { success:false } objects are reported as failed tool calls. Defaults true. This cannot roll back a write if the snippet swallowed its own exception."),parseJsonResult:He.boolean().optional().describe("When true, parse JSON-looking result strings, including double-encoded JSON strings. Defaults true. Set false to inspect the raw wire result.")},async(t,n)=>{let r={code:t.code,parameters:t.parameters||[],transactionMode:t.transactionMode||"auto",taskName:t.taskName||"Run Revit code"};t.taskId&&(r.taskId=t.taskId),t.parentTaskName&&(r.parentTaskName=t.parentTaskName),t.parentTaskId&&(r.parentTaskId=t.parentTaskId),r.logicalToolName="send_code_to_revit";let o=se(t),i=Date.now(),a=Mt({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:i}),s=Gl(t.code);if(s){let l=Math.max(0,Date.now()-i),u=Fe({action:"dynamic_snippet_preflight",reason:s.reason,error:s.message});return We({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:i}),ke(a,{response:u,durationMs:l}),{content:[{type:"text",text:`Code execution guarded: ${s.message}`}]}}try{let l=await Ee(async g=>await g.sendCommand("send_code_to_revit",r,o),o),u=t.parseJsonResult===!1?l:Ge(l,{parseResultStrings:!0}),m=Math.max(0,Date.now()-i);We({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:i}),ke(a,{response:u,durationMs:m}),pt(o);let p=t.parseJsonResult===!1||t.reportErrorResultAsFailure===!1?null:Hl(u);return p?{content:[{type:"text",text:`Code execution failed: ${p}`}]}:{content:[{type:"text",text:`Code execution successful!
Result: ${JSON.stringify(u,null,2)}`}]}}catch(l){let u=Math.max(0,Date.now()-i);return We({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,error:l,startedAtMs:i}),ke(a,{error:l,durationMs:u}),pt(o),{content:[{type:"text",text:`Code execution failed: ${l instanceof Error?l.message:String(l)}`}]}}})}import{z as be}from"zod";function Lr(e,t,n){return h(Fe({action:"send_code_to_revit_safe_preflight",error:e,reason:n,extra:{safetyReason:n,writePatterns:t}}))}function Si(e){e.tool("send_code_to_revit_safe","Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.",{...w(be),...x(be),code:be.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),parameters:be.array(be.union([be.string(),be.number(),be.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),transactionMode:be.enum(["auto","none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),intent:be.enum(["read","writePreview","writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),timeoutMs:be.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),maxReturnedChars:be.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),parseJsonResult:be.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true.")},async t=>{let n=t.intent||"read",r=Ht(t.code);if(n==="writeCommit")return Lr("send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",r,"safe_wrapper_write_commit_not_supported");if(t.transactionMode==="auto")return Lr("send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",r,"safe_wrapper_requires_transactionMode_none");if(r.length>0)return Lr(`Rejected write-looking code for intent '${n}'.`,r,"safe_wrapper_rejected_write_looking_code");try{let i=await K(t.code,{...se(t),...ye(t,"Run safe Revit read"),parameters:t.parameters||[],transactionMode:"none",parseJsonResult:t.parseJsonResult!==!1}),a=yi({action:"send_code_to_revit_safe",extra:{intent:n,response:i}}),s=JSON.stringify(a,null,2),l=hi(s,t.maxReturnedChars);return l.truncated?{content:[{type:"text",text:l.text}]}:h(a)}catch(o){return h(Ie({action:"send_code_to_revit_safe",error:o instanceof Error?o.message:String(o)}))}})}import{z as Et}from"zod";function Ul(e){return e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e}function $l(e){let t=String(e.detailLevel||"minimal").toLowerCase(),n=e.includeCategoryCounts===!0||t==="counts"||t==="full"?"true":"false",r=e.includeLinks!==!1?"true":"false",o=e.includeLinks===!0&&t==="full"||t==="full"?"true":"false";return`
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
}`}function wi(e){e.tool("get_revit_session_context","Read-only Revit session summary. Defaults to detailLevel=minimal so large-model document checks do not perform heavy MEP category or linked room/space counts. Use detailLevel=counts/full only when those expensive counts are explicitly needed.",{...w(Et),...x(Et),detailLevel:Et.enum(["minimal","counts","full"]).optional().describe("Context detail level. minimal is default and avoids category counts and linked room/space scans; counts adds host MEP category counts; full also scans linked room/space counts."),includeCategoryCounts:Et.boolean().optional().describe("Compatibility flag. true includes known MEP category counts; default false unless detailLevel is counts/full."),includeLinks:Et.boolean().optional().describe("Include cheap Revit link instance summary. Defaults true; linked room/space counts require detailLevel=full."),includeSelection:Et.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true.")},async t=>{let n=se(t);try{let r=await K($l(t),{...n,...ye(t,"Read Revit session context"),transactionMode:"none"}),o=Ul(r);if(t.includeSelection!==!1&&o&&typeof o=="object"){let i=await Nt(100,{...n,taskName:t.taskName?`${t.taskName}: selection`:"Read Revit selection",taskId:t.taskId});o.selection={count:i.length,elementIds:i}}return h(o)}catch(r){return h({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as Ze}from"zod";function Ql(e){let t=e.includeSheetViewports!==!1?"true":"false",n=e.includeSheetScheduleInstances!==!1?"true":"false",r=e.includeModelElements===!0?"true":"false",o=Number.isFinite(e.limit)?Math.max(1,Math.min(500,e.limit)):100,i=Ae(e.modelCategoryList||[]);return`
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
}`}function xi(e){e.tool("get_active_view_context","Read-only active view context. Handles model views and DrawingSheet views; sheets return placed viewport/view data plus scheduleSheetInstances instead of pretending MEP model elements are directly visible.",{...w(Ze),...x(Ze),includeSheetViewports:Ze.boolean().optional().describe("When active view is a sheet, include placed viewports. Defaults true."),includeSheetScheduleInstances:Ze.boolean().optional().describe("When active view is a sheet, include placed ScheduleSheetInstance entries with schedule ids, names, point, and box data. Defaults true."),includeModelElements:Ze.boolean().optional().describe("When active view is a model view, collect limited model elements from modelCategoryList. Defaults false."),modelCategoryList:Ze.array(Ze.string()).optional().describe("BuiltInCategory names such as OST_DuctCurves or OST_DuctTerminal."),limit:Ze.number().int().positive().max(500).optional().describe("Maximum model elements to return. Defaults 100.")},async t=>{try{let n=await K(Ql(t),{...T(t,"Read active Revit view context"),transactionMode:"none"});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as vi}from"zod";var Xl=["dryRun","DryRun","deleted","Deleted","confirmDelete","ConfirmDelete","targetIsReviewView","TargetIsReviewView","reviewSignals","ReviewSignals","deletedElementCount","DeletedElementCount"],Yl=["closed","Closed"];function kt(e,t={}){if(!e||typeof e!="object"||Array.isArray(e))return e;let n={...e};for(let r of Xl)delete n[r];if(t.stripCloseOnlyFields)for(let r of Yl)delete n[r];return n}function Ci(e){e.tool("list_open_views","List Revit UI view tabs currently open in the active document.",{...w(vi),...x(vi)},async t=>{try{let n=await _("list_open_views",{},{...T(t,"List open Revit views")});return h(kt(n&&n.result?n.result:n))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ft}from"zod";function Ri(e){e.tool("activate_view","Activate an existing Revit view tab by id or unique name without opening a transaction. Supports plans, 3D views, sheets, schedules, legends, drafting views, sections, and elevations.",{...w(ft),...x(ft),viewId:ft.number().int().positive().optional().describe("ElementId of the Revit view to activate."),viewName:ft.string().optional().describe("Name of the Revit view to activate. Must match one view unless viewType is also supplied."),viewType:ft.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:ft.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:ft.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation verification. Defaults 15000.")},async t=>{try{let n=await _("activate_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...T(t,"Activate Revit view")});return h(kt(n&&n.result?n.result:n,{stripCloseOnlyFields:!0}))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as gt}from"zod";function Ii(e){e.tool("close_view","Close an open Revit UI view tab by id or unique name without opening a transaction. If the target is active, another open view is activated first.",{...w(gt),...x(gt),viewId:gt.number().int().positive().optional().describe("ElementId of the Revit view to close."),viewName:gt.string().optional().describe("Name of the Revit view to close. Must match one view unless viewType is also supplied."),viewType:gt.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:gt.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:gt.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI close verification. Defaults 15000.")},async t=>{try{let n=await _("close_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...T(t,"Close Revit view")});return h(kt(n&&n.result?n.result:n))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as jr}from"zod";function Ti(e){e.tool("clear_selection","[LIVE_UI_SELECTION_CLEANUP] Clear the current Revit UI selection. This does not open a transaction and does not modify model elements or view data. Use after focus/testing workflows when the operator wants Revit left with no selected elements.",{...w(jr),...x(jr),timeoutMs:jr.number().int().positive().max(3e4).optional().describe("Timeout for the selection clear command. Defaults 10000.")},async t=>{try{let n=await _("clear_selection",{timeoutMs:t.timeoutMs},{...T(t,"Clear Revit selection")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,action:"clear_selection",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as Le}from"zod";function Kl(e){return!e||typeof e!="object"?null:{id:d(e,"Id","id")??d(e,"ViewId","viewId")??null,name:d(e,"Name","name")??d(e,"ViewName","viewName")??null,type:d(e,"Type","type")??d(e,"ViewType","viewType")??null}}function Zl(e,t={}){let n=t.responseMode||"compact";if(!e||typeof e!="object"||n==="full")return{...e,responseMode:n};let r=Kl(d(e,"TargetView","targetView")),o={mode:d(e,"Mode","mode")??t.mode??"dryRun",dryRun:d(e,"DryRun","dryRun")??null,changed:d(e,"Changed","changed")??null,deleted:d(e,"Deleted","deleted")??null,deletedElementCount:d(e,"DeletedElementCount","deletedElementCount")??null,confirmed:(d(e,"ConfirmDelete","confirmDelete")??t.confirmDelete)===!0,targetIsReviewView:d(e,"TargetIsReviewView","targetIsReviewView")??null,reviewSignals:d(e,"ReviewSignals","reviewSignals")??[]};return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded"),state:d(e,"State","state"),action:d(e,"Action","action")||"delete_review_view",responseMode:"compact",reason:d(e,"Reason","reason"),error:d(e,"Error","error"),message:d(e,"Message","message"),targetView:r,cleanup:o,suggestedNextScopes:d(e,"SuggestedNextScopes","suggestedNextScopes")??[],notices:[...Array.isArray(d(e,"Notices","notices"))?d(e,"Notices","notices"):[],'Compact response groups cleanup-specific fields under cleanup. Use responseMode="full" for raw delete_review_view diagnostics.']}}function _i(e){e.tool("delete_review_view",'[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode="commit" and confirmDelete=true.',{...w(Le),...x(Le),viewId:Le.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),viewName:Le.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),viewType:Le.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),exactName:Le.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),mode:Le.enum(["dryRun","commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),confirmDelete:Le.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),responseMode:Le.enum(["compact","full"]).optional().describe("Response shape. compact is the default and groups cleanup-specific fields under cleanup; full returns the raw native cleanup contract."),timeoutMs:Le.number().int().positive().max(12e4).optional().describe("Timeout for review view cleanup. Defaults 15000.")},async t=>{try{let n=await _("delete_review_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,mode:t.mode,confirmDelete:t.confirmDelete,timeoutMs:t.timeoutMs},{...T(t,"Delete Revit review view")});return h(Zl(n&&n.result?n.result:n,t))}catch(n){return h({success:!1,action:"delete_review_view",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as Wn}from"zod";function Mi(e){e.tool("get_ui_state","Read the current Revit UI state: active view, open views, selected element ids/summaries, and document modifiable/read-only status.",{...w(Wn),...x(Wn),selectionLimit:Wn.number().int().min(0).max(1e3).optional().describe("Maximum selected elements to summarize. Defaults 100."),timeoutMs:Wn.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=await _("get_ui_state",{selectionLimit:t.selectionLimit},{...T(t,"Read Revit UI state")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as I}from"zod";var ec="fast",tc={fast:{name:"fast",maxElementsScanned:5e3,maxElapsedMs:4500,socketTimeoutMs:12e3},balanced:{name:"balanced",maxElementsScanned:25e3,maxElapsedMs:18e3,socketTimeoutMs:3e4},deep:{name:"deep",maxElementsScanned:15e4,maxElapsedMs:9e4,socketTimeoutMs:12e4}},nc=[{concept:"fan_coil",terms:["fan coil","fancoil","fcu"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"air_handling_unit",terms:["ahu","air handling unit","klima santrali"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"pump",terms:["pump","pompa"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"valve",terms:["valve","vana"],categories:["Pipe Accessories","Pipe Fittings"],preserveQueryWhenFullyStripped:!0},{concept:"damper",terms:["damper"],categories:["Duct Accessories","Mechanical Equipment"]},{concept:"air_terminal",terms:["diffuser","grille","air terminal","difuzor","menfez"],categories:["Air Terminals"]},{concept:"duct",terms:["duct","kanal"],categories:["Ducts","Duct Fittings","Duct Accessories"]},{concept:"pipe",terms:["pipe","boru"],categories:["Pipes","Pipe Fittings","Pipe Accessories"]},{concept:"sprinkler",terms:["sprinkler"],categories:["Sprinklers"]},{concept:"plumbing_fixture",terms:["plumbing fixture","sanitary fixture","sihhi tesisat armat\xFCr","armat\xFCr"],categories:["Plumbing Fixtures"]}],rc=/^[\p{L}\p{N}_\- ]{1,24}$/u;function Ni(e){return String(e||"").normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase().replace(/\s+/g," ").trim()}function oc(e){return e.normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase()}function Ei(e){let t=[],n=[];for(let r=0;r<e.length;){let o=e.codePointAt(r);if(o===void 0)break;let i=String.fromCodePoint(o),a=r+i.length,s=oc(i);for(let l of s)t.push(l),n.push([r,a]);r=a}return{text:t.join(""),sourceRanges:n}}function zr(e){let t=new Set,n=[];for(let r of e){let o=String(r||"").trim();if(!o)continue;let i=o.toLowerCase();t.has(i)||(t.add(i),n.push(o))}return n}function ic(e){let t=String(e||"").toLowerCase();return t==="balanced"||t==="deep"||t==="fast"?t:ec}function Br(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function ac(e,t){let n=Ei(e),r=new Array(e.length).fill(!1);for(let i of t.sort((a,s)=>s.length-a.length)){let a=Ei(i).text;if(!a)continue;let s=a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+"),l=new RegExp(`(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`,"gu"),u;for(;(u=l.exec(n.text))!==null;)for(let m=u.index;m<l.lastIndex;m++){let p=n.sourceRanges[m];if(p)for(let g=p[0];g<p[1];g++)r[g]=!0}}let o="";for(let i=0;i<e.length;i++)o+=r[i]?" ":e[i];return o.replace(/\s+/g," ").trim()}function sc(e){let t=Ni(e),n=[],r=[],o=[],i=!1;for(let s of nc){let l=s.terms.filter(u=>t.includes(Ni(u)));l.length!==0&&(n.push({concept:s.concept,terms:l,categories:s.categories,preserveQueryWhenFullyStripped:s.preserveQueryWhenFullyStripped===!0}),r.push(...l),o.push(...s.categories),i=i||s.preserveQueryWhenFullyStripped===!0)}let a=ac(e,r);return{matchedConcepts:n,matchedTerms:r,categories:zr(o),effectiveQuery:a||(i?e.trim():"")}}function lc(e={}){let t=["levelNames","activeViewOnly","familyName","typeName","systemName"];return!e.sheetQuery&&!Array.isArray(e.sheetIds)&&t.push("sheetQuery"),!e.nameQuery&&!Array.isArray(e.scheduleIds)&&t.push("scheduleIds/nameQuery"),t.push("allowExpensiveSearch","searchBudget=deep"),t}function Gn(e,t){for(let n of e)if(!(!n||typeof n!="object"))for(let r of t){let o=n[r],i=Number.parseInt(String(o??""),10);if(Number.isFinite(i))return i}return null}function cc(e,t){let n=[];return t.length>0&&n.push(`categoryNames=${t.join("|")}`),Array.isArray(e.levelNames)&&e.levelNames.length>0&&n.push("levelNames"),(e.activeViewOnly===!0||e.viewId)&&n.push("activeViewOnly/viewId"),e.familyName&&n.push("familyName"),e.typeName&&n.push("typeName"),e.systemName&&n.push("systemName"),n.length>0?n:["categoryNames","levelNames","activeViewOnly","familyName/typeName","systemName"]}function uc(e={},t=[]){return!!(t.length>0||e.activeViewOnly===!0||e.viewId||Array.isArray(e.levelIds)&&e.levelIds.length>0||Array.isArray(e.levelNames)&&e.levelNames.length>0||e.familyName||e.typeName||e.systemName||Array.isArray(e.worksetIds)&&e.worksetIds.length>0||Array.isArray(e.worksetNames)&&e.worksetNames.length>0||Array.isArray(e.elementIds)&&e.elementIds.length>0||Array.isArray(e.uniqueIds)&&e.uniqueIds.length>0)}function et(e){return Array.isArray(e)&&e.some(t=>String(t??"").trim())}function dc(e,t,n,r){return t!=="hostOnly"&&et(e.uniqueIds)&&!et(e.elementIds)&&!n&&r.length===0&&e.activeViewOnly!==!0&&!e.viewId&&!et(e.levelIds)&&!et(e.levelNames)&&!e.familyName&&!e.typeName&&!e.systemName&&!et(e.worksetIds)&&!et(e.worksetNames)}function mc(e){let t=String(e||"").trim();return!!(t&&rc.test(t))}function pc(e,t){let n=[],r=0,o=[e.largeModelRisk,e.modelRisk,e.modelSignals,e.sessionSummary].filter(Boolean),i=Gn(o,["linkCount","linkInstances","loadedLinks","loadedLinkCount"]),a=Gn(o,["worksetCount","worksets"]),s=Gn(o,["sheetCount","sheets"]),l=Gn(o,["scheduleCount","schedules"]);i!==null&&i>=25?(r+=2,n.push("high_link_count")):i!==null&&i>=10&&(r+=1,n.push("moderate_link_count")),a!==null&&a>=40?(r+=2,n.push("high_workset_count")):a!==null&&a>=20&&(r+=1,n.push("moderate_workset_count")),s!==null&&s>=1e3&&(r+=1,n.push("large_sheet_set")),l!==null&&l>=500&&(r+=1,n.push("large_schedule_set")),!t.boundedScope&&mc(t.originalQuery)&&(r+=3,n.push("generic_unscoped_query")),!t.boundedScope&&!t.originalQuery&&(r+=3,n.push("missing_search_scope")),t.broadLinkedSearch&&(r+=2,n.push("linked_search_without_expensive_approval")),t.verifiedBroadSearch&&(r+=2,n.push("verified_plan_candidates_without_bounded_scope")),t.verifiedVisibilityExpensive&&(r+=2,n.push("verified_visibility_expensive")),(t.searchBudget==="deep"||t.allowExpensiveSearch)&&n.push("operator_approved_expensive_search"),t.boundedScope&&n.length===0&&n.push("bounded_first_pass_scope");let u=r>=4?"high":r>=2?"medium":r>=1||t.boundedScope?"low":"unknown",m=!t.allowExpensiveSearch&&(t.broadLinkedSearch||t.verifiedBroadSearch||t.verifiedVisibilityExpensive||!t.boundedScope&&r>=2);return{riskLevel:u,reasons:n,recommendedFirstScope:cc(e,t.effectiveCategoryNames),requiresUserControl:m}}function ki(e={}){let t=String(e.query||"").trim(),n=zr(Array.isArray(e.categoryNames)?e.categoryNames:[]),r=sc(t),o=n.length>0,i=o?n:zr(r.categories),a=r.effectiveQuery||(i.length>n.length?"":t),s=ic(e.searchBudget),l=tc[s],u=e.timeoutMs?Br(e.timeoutMs,l.socketTimeoutMs,1e3,12e4):l.socketTimeoutMs,m=Math.max(u,Math.min(12e4,l.maxElapsedMs+2500)),p=Br(e.maxElementsScanned,l.maxElementsScanned,1,5e5),g=Math.min(l.maxElapsedMs,Math.max(1e3,m-2500)),y=Br(e.maxElapsedMs,g,500,Math.max(500,m-1e3)),S=uc(e,i),E=String(e.linkScope||"hostOnly"),A=e.allowExpensiveSearch===!0||s==="deep",L=dc(e,E,t,i),j=E!=="hostOnly"&&!A&&!L,O=String(e.planCandidateMode||(e.includePlanCandidates===!0?"verified":"none")).toLowerCase(),H=e.includePlanCandidates===!0&&O==="verified",Y=et(e.elementIds)||et(e.uniqueIds),ee=H&&!S,te=H&&!Y,re=pc(e,{originalQuery:t,boundedScope:S,effectiveCategoryNames:i,linkScope:E,allowExpensiveSearch:A,broadLinkedSearch:j,verifiedBroadSearch:ee,verifiedVisibilityExpensive:te,searchBudget:s}),$=re.requiresUserControl,oe=[];return r.matchedConcepts.length>0&&n.length===0&&oe.push("search_scope_inferred_from_mep_terms"),r.matchedConcepts.length>0&&o&&r.categories.some(Ce=>!i.includes(Ce))&&oe.push("explicit_category_scope_preserved_no_inferred_expansion"),j&&oe.push("linked_model_search_requires_allowExpensiveSearch"),ee&&oe.push("verified_plan_candidates_require_bounded_scope"),te&&oe.push("verified_visibility_requires_exact_targets_or_approval"),re.requiresUserControl&&oe.push("search_requires_user_scope_control"),{originalQuery:t,effectiveQuery:a,inferredScope:{source:"runtime_search_policy",concepts:r.matchedConcepts,strippedTerms:r.matchedTerms,categoryNames:r.categories,residualQuery:a},effectiveCategoryNames:i,riskPolicy:re,linkScope:E,searchBudget:s,maxElementsScanned:p,maxElapsedMs:y,timeoutMs:m,allowExpensiveSearch:A,guarded:$,reason:$?"needs_scope":void 0,message:$?"This search would scan a broad model surface. Narrow by category, level, active view, system, family/type, sheet/schedule, or explicitly allow an expensive search.":void 0,warnings:oe,suggestedNextScopes:lc(e)}}function Ai(e){return{success:!0,guarded:!0,state:"guarded",action:"find_elements",reason:"needs_scope",message:e.message,originalQuery:e.originalQuery,query:e.effectiveQuery,inferredScope:e.inferredScope,effectiveScope:{categoryNames:e.effectiveCategoryNames,searchBudget:e.searchBudget,linkScope:e.linkScope},riskPolicy:e.riskPolicy,scanPolicy:{searchBudget:e.searchBudget,maxElementsScanned:e.maxElementsScanned,maxElapsedMs:e.maxElapsedMs,timeoutMs:e.timeoutMs,allowExpensiveSearch:e.allowExpensiveSearch},suggestedNextScopes:e.suggestedNextScopes,warnings:e.warnings}}import{z as hc}from"zod";var tt=hc.enum(["compact","full","debug"]).optional().default("compact").describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");function nt(e){return e==="full"||e==="debug"}function Pe(e,t,n){let r=Number.parseInt(String(e??""),10);return!Number.isFinite(r)||r<=0?t:Math.max(1,Math.min(n,r))}function Se(e,t){let n=Array.isArray(e)?e.filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)):[],r=new Set,o=[],i=t.key||sn;for(let s of n){let l=i(s);r.has(l)||(r.add(l),o.push(s))}let a=o.slice(0,Math.max(0,t.limit));return{rows:a,totalCount:n.length,uniqueCount:o.length,returnedCount:a.length,duplicateCount:n.length-o.length,omittedCount:Math.max(0,o.length-a.length)}}function sn(e){return qr(e)}function qr(e){if(e==null)return String(e);if(Array.isArray(e))return`[${e.map(qr).join(",")}]`;if(typeof e=="object"){let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${qr(t[n])}`).join(",")}}`}return JSON.stringify(e)}var fc=25,gc=25;function Pi(e,t,n){let r=e[t];if(Array.isArray(r)){r.includes(n)||r.push(n);return}if(typeof r=="string"&&r.trim()){e[t]=r===n?[r]:[r,n];return}e[t]=[n]}function Oi(e){if(!e||typeof e!="object"||d(e,"Success","success")===!1)return e;let n=Array.isArray(e.elements)?e.elements:Array.isArray(e.Elements)?e.Elements:null,r=e.count??e.Count,o=r==null||r===""?Number.NaN:Number(r),i=Number.isFinite(o)?o:n?.length??0,a=!!(e.truncated??e.Truncated),s=!!(e.ambiguous??e.Ambiguous),l=String(e.topConfidence??e.TopConfidence??""),u=!!(l&&l.toLowerCase()!=="high"),m=s||a||i!==1||u,p=m?"broad_or_ambiguous_discovery_result":"discovery_tool_result_not_parameter_write_evidence",g="find_elements is discovery-only. Never commit parameter writes from find_elements rows alone; broad, ambiguous, truncated, or non-high-confidence results are especially unsafe. Before writing, narrow to one exact elementId or uniqueId, verify it with inspect_elements, run inspect_parameter_schema for the target parameter, then run set_element_parameter in dryRun before commit. Do not write from a visible/display parameter name alone.",y="find_elements result is broad or ambiguous for write purposes; do not use it as parameter-write evidence. Narrow to one exact element and run inspect_parameter_schema before set_element_parameter.";return e.writeSafetyWarning=g,e.writeSafety={sufficientForWrite:!1,discoveryEvidenceOnly:!0,writeBlockedUntil:"exact_element_and_parameter_schema_preflight",requiresExactElementIdentity:!0,requiresParameterSchemaPreflight:!0,requiredPreflightTools:["inspect_elements","inspect_parameter_schema","set_element_parameter"],requiredBeforeParameterWrite:["narrow_to_exact_element_id_or_unique_id","inspect_elements_exact_target","inspect_parameter_schema_exact_target_parameter","set_element_parameter_dry_run_with_expected_current_value","commit_only_after_dry_run_verification"],parameterWritePolicy:"Never commit set_element_parameter from find_elements rows alone. Use find_elements only to discover candidates, then prove exact element and parameter identity before a dry-run or commit.",parameterIdentityRule:"Use builtInParameterId when available; otherwise confirm source/shared/storage/readOnly identity. Display name alone is not a write target.",resultRisk:{count:i,truncated:a,ambiguous:s,topConfidence:l,broadOrAmbiguous:m,confidenceRisk:u,unsafeForParameterWriteReason:p}},Pi(e,"warnings",m?y:g),Pi(e,"notices","find_elements_discovery_only_parameter_write_preflight_required"),typeof e.SelectionHint=="string"&&!e.SelectionHint.includes("find_elements is discovery-only")&&(e.SelectionHint=`${e.SelectionHint} ${g}`),typeof e.selectionHint=="string"&&!e.selectionHint.includes("find_elements is discovery-only")&&(e.selectionHint=`${e.selectionHint} ${g}`),e}function yc(e){let t=e.id??e.Id??e.uniqueId??e.UniqueId??e.elementId??e.ElementId;return t!=null&&t!==""?String(t):sn(e)}function bc(e){return Array.isArray(e.planCandidates)?"planCandidates":Array.isArray(e.PlanCandidates)?"PlanCandidates":null}function Te(e,...t){for(let n of t)if(e[n]!==void 0&&e[n]!==null&&e[n]!=="")return e[n]}function Sc(e){return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0))}function wc(e){let t=Te(e,"id","Id","viewId","ViewId","elementId","ElementId");if(t!==void 0)return String(t);let n=Te(e,"name","Name","viewName","ViewName"),r=Te(e,"levelId","LevelId","levelName","LevelName");return n!==void 0||r!==void 0?`${String(n??"")}|${String(r??"")}`:sn(e)}function xc(e,t){return Sc({ref:t,id:Te(e,"id","Id","viewId","ViewId","elementId","ElementId"),name:Te(e,"name","Name","viewName","ViewName"),viewType:Te(e,"viewType","ViewType"),levelId:Te(e,"levelId","LevelId"),levelName:Te(e,"levelName","LevelName"),score:Te(e,"score","Score","rankScore","RankScore"),rank:Te(e,"rank","Rank"),elementVisibleInView:Te(e,"elementVisibleInView","ElementVisibleInView"),reason:Te(e,"reason","Reason","matchReason","MatchReason")})}function vc(e,t){return{ref:t}}function Cc(e,t,n){let r=bc(e);if(!r)return{element:e,totalCandidateRows:0,omittedCandidateRows:0};let o=e[r].filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)),i=[];for(let s of o){let l=wc(s);n.has(l)||n.set(l,xc(s,l)),i.length<t&&i.push(vc(s,l))}let a={...e};return delete a.planCandidates,delete a.PlanCandidates,a.planCandidateRefs=i,a.planCandidateCount=o.length,a.returnedPlanCandidateRefCount=i.length,a.omittedPlanCandidateRefCount=Math.max(0,o.length-i.length),{element:a,totalCandidateRows:o.length,omittedCandidateRows:Math.max(0,o.length-i.length)}}function Rc(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||nt(n))return{...e,responseMode:n};let r=Array.isArray(e.elements)?"elements":Array.isArray(e.Elements)?"Elements":null;if(!r)return{...e,responseMode:"compact"};let o=Pe(t.maxResultRows??t.limit,fc,200),i=Pe(t.maxPlanCandidates,3,25),a=Pe(t.maxPlanCandidateSummaryRows,Math.max(gc,i),100),s=Se(e[r],{limit:o,key:yc}),l=new Map,u=0,m=0,p=s.rows.map(y=>{let S=Cc(y,i,l);return u+=S.totalCandidateRows,m+=S.omittedCandidateRows,S.element}),g=Se(Array.from(l.values()),{limit:a,key:y=>String(y.ref??sn(y))});return{...e,responseMode:"compact",[r]:p,planCandidateSummary:{compactResponse:!0,candidateRowCount:u,uniqueCandidateCount:l.size,returnedCandidateCount:g.returnedCount,omittedCandidateCount:g.omittedCount,duplicateCandidateRowCount:Math.max(0,u-l.size),omittedElementCandidateRefCount:m,candidates:g.rows},summary:{...e.summary||e.Summary||{},compactResponse:!0,elementRowCount:s.totalCount,returnedElementRowCount:s.returnedCount,omittedElementRowCount:s.omittedCount,duplicateElementRowCount:s.duplicateCount,planCandidateRowCount:u,uniquePlanCandidateCount:l.size,returnedPlanCandidateCount:g.returnedCount,omittedPlanCandidateCount:g.omittedCount},notices:[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds element rows and deduplicates plan candidates into planCandidateSummary. Use responseMode="full" for per-element plan candidate details.']}}function Vi(e){e.tool("find_elements","Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters plus safe in-memory level filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep before broad, linked, or verified visibility scans. Default responseMode=compact bounds element rows and deduplicates plan candidates into planCandidateSummary; use responseMode=full for per-element plan candidate details. Discovery-only: never use broad or ambiguous find_elements rows as write evidence; before writes, narrow to one exact element, inspect it, inspect the parameter schema, then use set_element_parameter dryRun before commit.",{...w(I),...x(I),query:I.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),categoryNames:I.array(I.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals. If omitted, common MEP terms such as fan coil/FCU, valve, damper, duct, pipe, sprinkler, pump, and AHU are inferred into a bounded category scope."),elementIds:I.array(I.union([I.number(),I.string()])).optional().describe("Exact element ids to inspect first when known."),uniqueIds:I.array(I.string()).optional().describe("Exact Revit unique ids to inspect first when known."),levelNames:I.array(I.string()).optional().describe("Restrict results to matching element level names, e.g. Level 08."),levelIds:I.array(I.union([I.number(),I.string()])).optional().describe("Restrict results to exact Revit level element ids."),activeViewOnly:I.boolean().optional().describe("Search only elements visible/owned in the active view when true. Preferred for large models when the user is already looking at the target area."),viewId:I.union([I.number(),I.string()]).optional().describe("Search only elements visible/owned in this view id."),familyName:I.string().optional().describe("Optional family-name filter applied before text scoring."),typeName:I.string().optional().describe("Optional type-name filter applied before text scoring."),systemName:I.string().optional().describe("Optional MEP system-name filter applied before text scoring when available."),worksetNames:I.array(I.string()).optional().describe("Optional workset-name filters for workshared production models."),worksetIds:I.array(I.union([I.number(),I.string()])).optional().describe("Optional exact workset ids for workshared production models."),linkScope:I.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Host model is searched by default. Linked model search is explicit and may require allowExpensiveSearch/searchBudget=deep on broad requests."),modelSignals:I.object({linkCount:I.number().int().nonnegative().optional(),linkInstances:I.number().int().nonnegative().optional(),loadedLinks:I.number().int().nonnegative().optional(),worksetCount:I.number().int().nonnegative().optional(),sheetCount:I.number().int().nonnegative().optional(),scheduleCount:I.number().int().nonnegative().optional()}).optional().describe("Optional cheap large-model signals from prior context. This never triggers new category counts; it only lets the risk policy use already-known link/workset/sheet/schedule counts."),searchBudget:I.enum(["fast","balanced","deep"]).optional().describe("Preset scan/elapsed budget. fast is default for first-pass discovery; balanced/deep intentionally allow larger scans."),allowExpensiveSearch:I.boolean().optional().describe("Explicit operator approval for broad, linked, all-model, or verified searches that may take longer."),maxElementsScanned:I.number().int().positive().max(5e5).optional().describe("Advanced override for the Revit-side scan cap. Prefer searchBudget for ordinary LLM use."),maxElapsedMs:I.number().int().positive().max(119e3).optional().describe("Advanced override for the Revit-side elapsed budget. This is clamped below socket timeout so partial results can return before transport timeout."),includePlanCandidates:I.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),planCandidateMode:I.enum(["none","metadata","verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms visibility in plan views and is allowed only for exact element targets or explicit expensive-search approval."),maxPlanCandidates:I.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),planNameContains:I.string().optional().describe("Optional plan name preference used when ranking plan candidates."),limit:I.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),responseMode:tt,maxResultRows:I.number().int().positive().max(200).optional().describe("Compact-mode cap for returned element rows. Defaults to limit or 25; full/debug returns all native rows within limit."),maxPlanCandidateSummaryRows:I.number().int().positive().max(100).optional().describe("Compact-mode cap for the deduplicated top-level planCandidateSummary rows. Defaults 25 so global plan candidates are not capped by the per-element maxPlanCandidates limit."),timeoutMs:I.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{try{let n=ki(t);if(n.guarded)return h(Oi(Ai(n)));let r=await _("find_elements",{originalQuery:n.originalQuery,query:n.effectiveQuery,categoryNames:n.effectiveCategoryNames,inferredScope:n.inferredScope,elementIds:t.elementIds,uniqueIds:t.uniqueIds,levelNames:t.levelNames,levelIds:t.levelIds,activeViewOnly:t.activeViewOnly===!0,viewId:t.viewId,familyName:t.familyName,typeName:t.typeName,systemName:t.systemName,worksetNames:t.worksetNames,worksetIds:t.worksetIds,linkScope:n.linkScope,searchBudget:n.searchBudget,allowExpensiveSearch:n.allowExpensiveSearch,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,includePlanCandidates:t.includePlanCandidates===!0,planCandidateMode:t.planCandidateMode||(t.includePlanCandidates===!0?"verified":"none"),maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.limit,timeoutMs:n.timeoutMs},{...T({...t,timeoutMs:n.timeoutMs},"Find Revit elements")}),o=r&&r.result?r.result:r;return o&&typeof o=="object"&&(o.inferredScope=o.inferredScope||n.inferredScope,o.effectiveScope=o.effectiveScope||{categoryNames:n.effectiveCategoryNames,linkScope:n.linkScope},o.riskPolicy=o.riskPolicy||n.riskPolicy,o.scanPolicy=o.scanPolicy||{searchBudget:n.searchBudget,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,timeoutMs:n.timeoutMs,allowExpensiveSearch:n.allowExpensiveSearch},o.suggestedNextScopes=o.suggestedNextScopes||n.suggestedNextScopes,o.warnings=[...new Set([...Array.isArray(o.warnings)?o.warnings:[],...n.warnings])]),h(Rc(Oi(o),t))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ie}from"zod";var Ic=ie.union([ie.number().int().positive(),ie.string().regex(/^\d+$/)]);function Hn(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),ViewType:d(e,"ViewType","viewType"),Scale:d(e,"Scale","scale")}}function Tc(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),ClassName:d(e,"ClassName","className"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),HasBoundingBox:d(e,"HasBoundingBox","hasBoundingBox")}}function _c(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Action:d(e,"Action","action"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),ResponseMode:"compact",PlanMode:d(e,"PlanMode","planMode"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),FallbackUsed:d(e,"FallbackUsed","fallbackUsed"),VerifiedCandidateCount:d(e,"VerifiedCandidateCount","verifiedCandidateCount"),RejectedCandidateCount:d(e,"RejectedCandidateCount","rejectedCandidateCount"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),FocusBlocked:d(e,"FocusBlocked","focusBlocked"),FocusBlockReason:d(e,"FocusBlockReason","focusBlockReason"),FocusSuggestion:d(e,"FocusSuggestion","focusSuggestion"),TargetView:Hn(d(e,"TargetView","targetView")),SelectedPlan:Hn(d(e,"SelectedPlan","selectedPlan")),SuggestedView:Hn(d(e,"SuggestedView","suggestedView")),ActiveView:Hn(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),Element:Tc(d(e,"ElementInfo","elementInfo")),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function Di(e){e.tool("open_existing_plan_for_element_level","Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.",{...w(ie),...x(ie),elementId:Ic.describe("ElementId to locate in an existing plan view."),planMode:ie.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing plan on the element level. activePlan keeps the current active plan and does not switch to the element level. Defaults elementLevel."),planCandidateMode:ie.enum(["metadataFirst","verified"]).optional().describe("Plan selection strategy for elementLevel mode. metadataFirst is the default and ranks same-level plans without scanning every candidate view, then verifies a small number of ranked candidates. verified scans all candidate views before selecting and is slower."),fallbackToVerified:ie.boolean().optional().describe("When metadataFirst cannot find a visible element within the limited ranked-candidate check, run the slower verified scan before failing. Defaults true."),maxMetadataVerifyCandidates:ie.number().int().min(1).max(25).optional().describe("Maximum ranked metadata candidates verified before fallback. Defaults 5."),planNameContains:ie.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:ie.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:ie.boolean().optional().describe("Select the element after activating the plan. Defaults true."),zoom:ie.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),fitToScreen:ie.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),verboseCandidates:ie.boolean().optional().describe("Return full PlanCandidates arrays. Defaults false; routine responses return only the top candidates."),maxPlanCandidates:ie.number().int().min(0).max(50).optional().describe("Maximum PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:ie.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns the raw tool result."),timeoutMs:ie.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000.")},async t=>{try{let n=await _("open_existing_plan_for_element_level",{elementId:t.elementId,planMode:t.planMode,planCandidateMode:t.planCandidateMode,fallbackToVerified:t.fallbackToVerified,maxMetadataVerifyCandidates:t.maxMetadataVerifyCandidates,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs},{...T(t,"Open existing plan for element level")}),r=n&&n.result?n.result:n,o=ht(r,{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"?h(o):h(_c(o))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ue}from"zod";var Mc=ue.union([ue.number().int().positive(),ue.string().regex(/^\d+$/)]);function Fi(e){e.tool("focus_elements","Select and zoom to Revit elements in the active view or in a requested view tab. This is a UI operation and does not open a Revit transaction.",{...w(ue),...x(ue),elementIds:ue.array(Mc).min(1).describe("ElementId values to select and show."),viewId:ue.number().int().positive().optional().describe("Optional ElementId of the Revit view to activate before focusing elements."),viewName:ue.string().optional().describe("Optional name of the Revit view to activate before focusing elements."),viewType:ue.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, Section, Elevation, DrawingSheet, or Schedule."),exactName:ue.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),select:ue.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:ue.boolean().optional().describe("Zoom/show the supplied elements in the active UI view. Defaults true."),fitToScreen:ue.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active view. Defaults false."),allowClosedViewSearch:ue.boolean().optional().describe("Allow Revit ShowElements to open its modal closed-view search when elements are not visible in the target view. Defaults false to avoid blocking automation."),allowPartial:ue.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:ue.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation/focus verification. Defaults 5000; pass a larger value for slow view activation.")},async t=>{try{let n=await _("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:t.allowClosedViewSearch,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...T(t,"Focus Revit elements")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as pe}from"zod";var Nc=pe.union([pe.number().int().positive(),pe.string().regex(/^\d+$/)]);function Li(e){e.tool("section_box_elements","Apply a 3D section box around Revit elements, optionally select them, and zoom to them. Requires a 3D view; if viewId/viewName is supplied, that view is activated first.",{...w(pe),...x(pe),elementIds:pe.array(Nc).min(1).describe("ElementId values to include in the section box."),viewId:pe.number().int().positive().optional().describe("Optional ElementId of the 3D Revit view to activate and modify."),viewName:pe.string().optional().describe("Optional name of the 3D Revit view to activate and modify."),viewType:pe.string().optional().describe("Optional Revit ViewType filter. For this tool the resolved view must be ThreeD."),exactName:pe.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),paddingMm:pe.number().min(0).max(1e5).optional().describe("Extra space around the element bounding box in millimeters. Defaults 500."),select:pe.boolean().optional().describe("Select the supplied elements after applying the section box. Defaults true."),zoom:pe.boolean().optional().describe("Zoom/show the supplied elements after applying the section box. Defaults true."),allowPartial:pe.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:pe.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous 3D view activation and section box application. Defaults 15000.")},async t=>{try{let n=await _("section_box_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,paddingMm:t.paddingMm,select:t.select,zoom:t.zoom,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...T(t,"Section box Revit elements")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ne}from"zod";var Ec=ne.union([ne.number().int().positive(),ne.string().regex(/^\d+$/)]);function ji(e){e.tool("create_3d_view_for_elements","[LIVE_VIEW_NAVIGATION_PRIMITIVE] Create or reuse a 3D Revit view for elements, optionally apply or clear a section box, activate the view, and focus/select the elements. Use this when the user wants to see, open, zoom to, or inspect elements live inside Revit. This can modify the document because views and section boxes are project data.",{...w(ne),...x(ne),elementIds:ne.array(Ec).min(1).describe("ElementId values to show in the 3D view."),viewName:ne.string().optional().describe("Desired 3D view name. If omitted, a name is generated from the first element id."),reuseExisting:ne.boolean().optional().describe("Reuse an existing non-template 3D view with the same name when viewName is supplied. Defaults true."),createIfMissing:ne.boolean().optional().describe("Create the 3D view when no reusable view is found. Defaults true."),sectionBox:ne.boolean().optional().describe("When true, apply a section box around the elements. When false, any active section box on the target view is cleared. Defaults false."),paddingMm:ne.number().min(0).max(1e5).optional().describe("Extra section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:ne.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction to apply using the aggregate element bounding box. Defaults unchanged."),framingPaddingMm:ne.number().min(0).max(1e5).optional().describe("Extra padding in millimeters for camera orientation/framing when cameraOrientation is not unchanged. Defaults to paddingMm or 500."),activate:ne.boolean().optional().describe("Activate the target 3D view. Defaults true."),select:ne.boolean().optional().describe("Select the supplied elements after activation. Defaults true."),zoom:ne.boolean().optional().describe("Zoom/show the supplied elements after activation. Defaults true."),fitToScreen:ne.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active 3D view. Defaults false."),allowPartial:ne.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:ne.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous view creation/activation/focus. Defaults 20000.")},async t=>{try{let n=await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName,reuseExisting:t.reuseExisting,createIfMissing:t.createIfMissing,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:t.activate,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...T(t,"Create 3D view for elements")});return h(n&&n.result?n.result:n)}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import kc from"node:os";import Bi from"node:path";import{z}from"zod";var Ac=z.enum(["raw_evidence","coordination_overlay","system_focus","clash_clearance"]),Pc=z.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Oc=z.enum(["72","150","300","600"]),Vc=z.enum(["horizontal","vertical"]),Dc=z.enum(["auto","qa_high_contrast","technical_report","outline_only","raw"]),Fc={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Lc={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},jc={horizontal:"Horizontal",vertical:"Vertical"};function Bc(){return Bi.join(kc.tmpdir(),"revAgent-image-export")}function zc(e){return(e&&e.trim()?e.trim():`revit-coordination-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function qc(e){let t=e||[],n=[],r=[];for(let o of t){if(typeof o=="number"){Number.isSafeInteger(o)&&o>0?n.push(o):r.push(o);continue}let i=String(o).trim();if(/^\d+$/.test(i)){let a=Number(i);if(Number.isSafeInteger(a)&&a>0){n.push(a);continue}}r.push(o)}return{ids:n,invalid:r,suppliedCount:t.length}}function Jc(e){return`new List<int> { ${e.map(n=>Math.trunc(n)).join(", ")} }`}function Wc(e){return e==="raw_evidence"?"raw":e==="coordination_overlay"?"outline_only":"technical_report"}function zi(e){e.tool("export_revit_coordination_image","[VISUAL_ARTIFACT_EXPORT_ONLY] Create or reuse a visual QA 3D view, optionally section-box target elements, apply a selectable target visual style, and export an image artifact. Auto style is report-friendly and never selects qa_high_contrast by itself. Use qa_high_contrast explicitly for debug/LLM evidence, technical_report or outline_only for report-style evidence, and raw when the target must keep native appearance. Use this when the user asks for PNG/JPEG/report/LLM visual evidence. If elementIds are provided but none are found, it returns guarded no_requested_elements_found unless allowFullViewFallback=true is explicit. Do not use this as the primary tool for live view navigation, selected-element zoom, or opening an element in a Revit view; for that workflow use create_3d_view_for_elements or show_element_in_plan_and_3d, then optionally export the active view with export_revit_view_image. It only writes review view settings; it does not create or modify MEP model elements. Set cleanupAfterExport=true when a newly created review view should be deleted after the image file is produced.",{...w(z),intent:Ac.optional().default("coordination_overlay"),targetVisualStyle:Dc.optional().default("auto").describe("Target override style. auto is report-friendly: raw_evidence -> raw, coordination_overlay -> outline_only, system_focus/clash_clearance -> technical_report. qa_high_contrast is used only when explicitly requested. raw applies no target override."),elementIds:z.array(z.union([z.number(),z.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),viewName:z.string().optional().default("DPE Visual QA - Coordination Export"),marginMm:z.number().min(0).max(2e4).optional().default(2e3),singleElementMarginMm:z.number().min(0).max(2e4).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),contextTransparency:z.number().int().min(0).max(90).optional().default(65),pixelSize:z.number().int().min(200).max(1e4).optional().default(4e3).describe("Final image size for the requested fit direction after crop/downsample. For coordination crops, Revit may export a higher-resolution source first."),preExportPixelSize:z.number().int().min(0).max(2e4).optional().default(0).describe("Optional Revit source export size before crop/downsample. Use 0 or omit for automatic high-resolution source export on single-target model-projection crops."),maxAutoPreExportPixelSize:z.number().int().min(1e3).max(2e4).optional().default(1e4).describe("Upper bound for automatic high-resolution source exports used before single-target model-projection crops."),allowFinalUpscale:z.boolean().optional().default(!1).describe("When false, model-projection crops are widened instead of enlarging a tiny source crop to the final pixelSize. This preserves image quality even when targetMinFillRatio cannot be reached within Revit's source export limit."),enforcePixelSize:z.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the final requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),cropToTargetHighlight:z.boolean().optional().default(!0).describe("When true, tightens the Revit 3D view crop box from model bbox/camera projection. Raster highlight pixels are QA metrics only unless Revit model crop-box framing is unavailable."),targetMinFillRatio:z.number().min(.1).max(.9).optional().default(.4).describe("Minimum target occupancy used when sizing model-bounding-box projection crops. Raster highlight fill, when detected, is reported separately as QA."),highlightCropPaddingPx:z.number().int().min(0).max(2e3).optional().default(24).describe("Debug fallback padding for highlight-pixel crops when model projection is not available."),allowFullViewFallback:z.boolean().optional().default(!1).describe("When elementIds are provided but none are found, allow exporting the full review 3D view instead of returning guarded. Defaults false to avoid misleading element evidence."),dpi:Oc.optional().default("300"),fitDirection:Vc.optional().default("horizontal"),format:Pc.optional().default("png"),outputDir:z.string().optional(),filePrefix:z.string().optional(),cleanupAfterExport:z.boolean().optional().default(!1).describe("When true, a review view created by this call is deleted after export. Existing reused review views are never deleted automatically."),...x(z),timeoutMs:z.number().int().positive().optional()},async t=>{let n=qc(t.elementIds);if(n.invalid.length>0)return h(Fe({action:"export_revit_coordination_image",reason:"invalid_element_ids",error:"elementIds must be positive integer Revit ElementId values. UniqueId strings or other non-numeric ids are not valid target evidence ids.",extra:{revitWriteAction:"none",requestedElementCount:n.suppliedCount,validElementCount:n.ids.length,invalidElementIds:n.invalid}}));let r=Bi.resolve(t.outputDir||Bc()),o=zc(t.filePrefix),i=t.intent||"coordination_overlay",a=t.targetVisualStyle||"auto",s=a==="auto"?Wc(i):a,l=Fc[t.format||"png"],u=Lc[String(t.dpi||"150")],m=jc[t.fitDirection||"horizontal"],p=Math.trunc(t.pixelSize||4e3),g=Number.isFinite(Number(t.preExportPixelSize))?Math.max(0,Math.trunc(Number(t.preExportPixelSize))):0,y=Number.isFinite(Number(t.maxAutoPreExportPixelSize))?Math.max(1e3,Math.min(2e4,Math.trunc(Number(t.maxAutoPreExportPixelSize)))):1e4,S=t.allowFinalUpscale===!0,E=Number.isFinite(Number(t.marginMm))?Number(t.marginMm):2e3,A=Number.isFinite(Number(t.singleElementMarginMm))?Number(t.singleElementMarginMm):300,L=t.enforcePixelSize!==!1,j=t.cropToTargetHighlight!==!1,O=Number.isFinite(Number(t.targetMinFillRatio))?Math.max(.1,Math.min(.9,Number(t.targetMinFillRatio))):.4,H=Number.isFinite(Number(t.highlightCropPaddingPx))?Math.trunc(t.highlightCropPaddingPx):24,Y=t.allowFullViewFallback===!0,ee=Math.trunc(t.contextTransparency??65),te=t.cleanupAfterExport===!0,re=`
var warnings = new List<string>();
var notices = new List<string>();
string outputDir = ${N(r)};
string filePrefix = ${N(o)};
string desiredViewName = ${N(t.viewName||"DPE Visual QA - Coordination Export")};
string intent = ${N(i)};
string targetVisualStyle = ${N(s)};
var requestedElementIds = ${Jc(n.ids)};
double marginFeet = ${E} / 304.8;
double singleElementMarginFeet = ${A} / 304.8;
int contextTransparency = ${ee};
int requestedPixelSize = ${p};
int requestedPreExportPixelSize = ${g};
int maxAutoPreExportPixelSize = ${y};
int revitExportPixelSize = requestedPixelSize;
bool autoPreExportPixelSize = requestedPreExportPixelSize <= 0;
string preExportPixelSizeReason = "same_as_final_pixel_size";
string requestedFitDirection = ${N(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${L?"true":"false"};
bool cropToTargetHighlight = ${j?"true":"false"};
bool allowFinalUpscale = ${S?"true":"false"};
double targetMinFillRatio = ${O};
int highlightCropPaddingPx = ${H};
bool allowFullViewFallback = ${Y?"true":"false"};
bool cleanupAfterExport = ${te?"true":"false"};

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

double effectiveMarginMm = targetElements.Count == 1 ? Math.Min(${E}, ${A}) : ${E};
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
  format = ${N(t.format||"png")},
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
  marginMm = ${E},
  singleElementMarginMm = ${A},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${N(String(t.dpi||"300"))},
  fitDirection = ${N(t.fitDirection||"horizontal")},
  files = files,
  warnings = warnings,
  notices = notices
};`;try{let $=await K(re,{...T(t,"Export Revit coordination image"),taskType:"export_revit_coordination_image",transactionMode:"auto"});return h($?.result??$)}catch($){return h(Ie({action:"export_revit_coordination_image",error:$ instanceof Error?$.message:String($),extra:{tool:"export_revit_coordination_image"}}))}})}import Gc from"node:os";import qi from"node:path";import{z as ae}from"zod";var Hc=ae.enum(["current_view","visible_region","set_of_views"]),Uc=ae.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),$c=ae.enum(["72","150","300","600"]),Qc=ae.enum(["horizontal","vertical"]),Xc={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Yc={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Kc={horizontal:"Horizontal",vertical:"Vertical"};function Zc(){return qi.join(Gc.tmpdir(),"revAgent-image-export")}function eu(e){return(e&&e.trim()?e.trim():`revit-view-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function tu(e){if(e==null||e==="")return"null";let t=Number(e);return Number.isFinite(t)?String(Math.trunc(t)):"null"}function Ji(e){e.tool("export_revit_view_image","[VISUAL_ARTIFACT_EXPORT] Export the active Revit view, DrawingSheet, Schedule view, or a selected view/sheet to PNG/JPEG/TIFF/BMP/TARGA using Document.ExportImage. Use this when the user asks for a raw image file, report/evidence screenshot, schedule/sheet export, or LLM visual artifact from an existing view. Ordinary view/sheet exports do not modify Revit. Direct schedule export creates a temporary sheet, exports it, and deletes that sheet before the wrapper transaction commits.",{...w(ae),viewId:ae.union([ae.number(),ae.string()]).optional().describe("Optional Revit view id. When supplied, export uses set_of_views because Revit cannot export a non-active visible region."),viewName:ae.string().optional().describe("Optional exact or partial view name. When supplied, export uses set_of_views unless range is explicitly current/visible."),exactName:ae.boolean().optional().default(!0),range:Hc.optional().describe("current_view and visible_region use the active UI view. set_of_views can export viewId/viewName without switching the UI."),format:Uc.optional().default("png"),pixelSize:ae.number().int().min(200).max(1e4).optional().default(6e3),enforcePixelSize:ae.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),zoom:ae.number().int().min(1).max(1e3).optional().default(100),dpi:$c.optional().default("300"),fitDirection:Qc.optional().default("horizontal"),outputDir:ae.string().optional(),filePrefix:ae.string().optional(),allowTemporaryScheduleSheet:ae.boolean().optional().default(!0).describe("When true, standalone Schedule views are exported through a temporary sheet that is deleted before the wrapper transaction commits. When false, schedule views return guidance with containing sheet candidates."),...x(ae),timeoutMs:ae.number().int().positive().optional()},async t=>{let n=t.viewId!==void 0||!!t.viewName,r=t.range??(n?"set_of_views":"current_view"),o=qi.resolve(t.outputDir||Zc()),i=eu(t.filePrefix),a=Xc[t.format||"png"],s=Yc[String(t.dpi||"150")],l=Kc[t.fitDirection||"horizontal"],u=Math.trunc(t.pixelSize||6e3),m=t.enforcePixelSize!==!1,p=Math.trunc(t.zoom||100),g=t.allowTemporaryScheduleSheet!==!1,y=`
var warnings = new List<string>();
var notices = new List<string>();
string requestedRange = ${N(r)};
string outputDir = ${N(o)};
string filePrefix = ${N(i)};
string viewNameInput = ${N(t.viewName||"")};
int? viewIdInput = ${tu(t.viewId)};
bool exactName = ${t.exactName===!1?"false":"true"};
bool selectorProvided = viewIdInput.HasValue || !String.IsNullOrWhiteSpace(viewNameInput);
int requestedPixelSize = ${u};
string requestedFitDirection = ${N(t.fitDirection||"horizontal")};
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
  format = ${N(t.format||"png")},
  pixelSize = ${u},
  requestedPixelSize = ${u},
  enforcePixelSize = enforcePixelSize,
  pixelSizeNote = enforcePixelSize
    ? "PNG/JPEG/BMP/TIFF output is post-processed so the requested fit-direction dimension equals requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the Revit export request. Check files[].width and files[].height for actual output dimensions.",
  dpi = ${N(String(t.dpi||"300"))},
  fitDirection = ${N(t.fitDirection||"horizontal")},
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
};`;try{let S=await K(y,{...T(t,"Export Revit view image"),taskType:"export_revit_view_image",transactionMode:g?"auto":"none"});return h(S?.result??S)}catch(S){return h(Ie({action:"export_revit_view_image",error:S instanceof Error?S.message:String(S),extra:{tool:"export_revit_view_image"}}))}})}import{z as q}from"zod";var nu=q.union([q.number().int().positive(),q.string().regex(/^\d+$/)]);function Jr(e){return e&&e.result?e.result:e}function Wr(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function ru(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function ou(e,t){return`3D - Focus ${t&&(t.FamilyName||t.TypeName||t.Name)?String(t.FamilyName||t.TypeName||t.Name):"Element"} ${e}`.replace(/[{}[\];<>?`~]/g,"").slice(0,90)}function iu(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),MatchScore:d(e,"MatchScore","matchScore"),MatchConfidence:d(e,"MatchConfidence","matchConfidence")}}function ln(e){return!e||typeof e!="object"?e:{Id:e.Id??e.id,Name:e.Name??e.name,ViewType:e.ViewType??e.viewType,Scale:e.Scale??e.scale}}function au(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Count:d(e,"Count","count"),Truncated:d(e,"Truncated","truncated"),Ambiguous:d(e,"Ambiguous","ambiguous"),TopScore:d(e,"TopScore","topScore"),TopConfidence:d(e,"TopConfidence","topConfidence"),TopScoreTiedCount:d(e,"TopScoreTiedCount","topScoreTiedCount"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),SelectionHint:d(e,"SelectionHint","selectionHint")}}function su(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),PlanMode:d(e,"PlanMode","planMode"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),SelectedPlan:ln(d(e,"SelectedPlan","selectedPlan")),TargetView:ln(d(e,"TargetView","targetView")),ActiveView:ln(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function lu(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),TargetView:ln(d(e,"TargetView","targetView")),ActiveView:ln(d(e,"ActiveView","activeView")),CreatedView:d(e,"CreatedView","createdView"),ReusedView:d(e,"ReusedView","reusedView"),SectionBoxApplied:d(e,"SectionBoxApplied","sectionBoxApplied"),SectionBoxState:d(e,"SectionBoxState","sectionBoxState"),CameraOrientation:d(e,"CameraOrientation","cameraOrientation"),CameraApplied:d(e,"CameraApplied","cameraApplied"),CameraWarning:d(e,"CameraWarning","cameraWarning"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed")}}function cu(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function Ue(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"show_element_in_plan_and_3d",message:e.message,error:e.error,resultContractVersion:cu(e.find,e.plan,e.threeD),chosenElementId:e.chosenElementId,chosenElement:e.chosenElement,find:e.find,plan:e.plan,threeD:e.threeD,ambiguous:e.ambiguous,candidates:e.candidates}}function Wi(e){e.tool("show_element_in_plan_and_3d","[LIVE_VIEW_WORKFLOW_WRAPPER] Safely find or use one Revit element, show it in an existing plan, then optionally call create_3d_view_for_elements to create/reuse a focused 3D view. Use this when the user wants a combined plan plus 3D live Revit view workflow. Ambiguous search results are rejected by default for large-project safety.",{...w(q),...x(q),elementId:nu.optional().describe("Known ElementId. When supplied, search is skipped."),query:q.string().optional().describe("Text query used when elementId is not supplied."),categoryNames:q.array(q.string()).optional().describe("Category name filters for the search, e.g. Mechanical Equipment."),searchLimit:q.number().int().positive().max(200).optional().describe("Maximum search candidates to inspect. Defaults 20."),allowAmbiguous:q.boolean().optional().describe("Allow the top search result to be used even when multiple plausible matches exist. Defaults false."),planMode:q.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing same-level plan. activePlan keeps the current active plan. Defaults elementLevel."),planNameContains:q.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:q.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),includeSearchPlanCandidates:q.boolean().optional().describe("Include plan candidates during the initial search. Defaults false; the plan-open step computes focused candidates separately."),verboseCandidates:q.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:q.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:q.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),select:q.boolean().optional().describe("Select the element in plan/3D. Defaults true."),zoom:q.boolean().optional().describe("Show/zoom the element in plan/3D. Defaults true."),fitToScreen:q.boolean().optional().describe("Run Revit UI ZoomToFit after focusing views. Defaults false."),create3d:q.boolean().optional().describe("Create or reuse a focused 3D view after the plan step. Defaults true."),viewName:q.string().optional().describe("Desired 3D view name. If omitted, one is generated from the selected element."),reuseExisting3d:q.boolean().optional().describe("Reuse an existing 3D view with the same name. Defaults true."),sectionBox:q.boolean().optional().describe("Apply a 3D section box around the element. Defaults false."),paddingMm:q.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:q.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction. Defaults unchanged."),framingPaddingMm:q.number().min(0).max(1e5).optional().describe("Padding in millimeters for camera orientation/framing. Defaults to paddingMm or 500."),timeoutMs:q.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=T(t,"Show element in plan and 3D"),r=t.elementId,o=null,i=null;if(!r){if(!t.query&&(!t.categoryNames||t.categoryNames.length===0))return h(Ue({success:!1,guarded:!0,error:"Pass elementId, or pass query/categoryNames for a safe search."}));if(i=Jr(await _("find_elements",{query:t.query,categoryNames:t.categoryNames,includePlanCandidates:t.includeSearchPlanCandidates===!0,maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.searchLimit||20,timeoutMs:t.timeoutMs,taskName:"Find element for plan and 3D presentation"},n)),!i||!Wr(i))return h(Ue({success:!1,error:d(i,"Error","error")||"Element search failed.",find:i}));let m=Array.isArray(d(i,"Elements","elements"))?d(i,"Elements","elements"):[];if(m.length===0)return h(Ue({success:!1,guarded:!0,error:"No matching elements were found.",find:i}));if(d(i,"Ambiguous","ambiguous")&&t.allowAmbiguous!==!0)return h(Ue({success:!1,guarded:!0,error:"Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",ambiguous:!0,find:i,candidates:m}));if(o=m[0]||null,!o)return h(Ue({success:!1,guarded:!0,error:"No usable element candidate was returned.",find:i}));r=d(o,"Id","id")}if(r==null)return h(Ue({success:!1,guarded:!0,error:"No element id was resolved.",find:i}));let a=Jr(await _("open_existing_plan_for_element_level",{elementId:r,planMode:t.planMode,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3,responseMode:"full",timeoutMs:t.timeoutMs,taskName:"Show element in existing plan"},n));if(!a||!Wr(a))return h(Ue({success:!1,guarded:ru(a),error:d(a,"Error","error")||"Plan presentation failed.",chosenElementId:r,chosenElement:o,find:i,plan:a}));let s=null;t.create3d!==!1&&(s=Jr(await _("create_3d_view_for_elements",{elementIds:[r],viewName:t.viewName||ou(r,o),reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Show element in focused 3D view"},n)));let l=t.create3d===!1||Wr(s),u=ht(Ue({success:l,message:t.create3d===!1?"Element was shown in an existing plan.":l?"Element was shown in an existing plan and focused in 3D.":"Element was shown in plan, but the 3D step failed.",chosenElementId:r,chosenElement:o,find:i,plan:a,threeD:s}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"||!l?h(u):h({success:d(u,"Success","success"),guarded:d(u,"Guarded","guarded")===!0,state:d(u,"State","state"),action:d(u,"Action","action"),message:d(u,"Message","message"),error:d(u,"Error","error"),resultContractVersion:d(u,"ResultContractVersion","resultContractVersion"),responseMode:"compact",chosenElementId:r,chosenElement:iu(o),findSummary:au(i),planSummary:su(a),threeDSummary:lu(s)})}catch(n){return h(Ue({success:!1,error:n instanceof Error?n.message:String(n)}))}})}import{z as J}from"zod";var uu=J.union([J.number().int().positive(),J.string().regex(/^\d+$/)]);function Un(e){return e&&e.result?e.result:e}function $n(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function Gi(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Qn(e){return!e||typeof e!="object"?e||null:{id:e.Id??e.id,name:e.Name??e.name,viewType:e.ViewType??e.viewType,isActive:e.IsActive??e.isActive,isOpen:e.IsOpen??e.isOpen,isSectionBoxActive:e.IsSectionBoxActive??e.isSectionBoxActive}}function Gr(e){if(!e||typeof e!="object")return e||null;let t=e.PlanCandidates??e.planCandidates;return{success:d(e,"Success","success"),message:d(e,"Message","message"),error:d(e,"Error","error"),focusBlocked:e.FocusBlocked??e.focusBlocked,focusBlockReason:e.FocusBlockReason??e.focusBlockReason,focusSuggestion:e.FocusSuggestion??e.focusSuggestion,changed:e.Changed??e.changed,selected:e.Selected??e.selected,zoomed:e.Zoomed??e.zoomed,activeViewChanged:e.ActiveViewChanged??e.activeViewChanged,planOpenMode:e.PlanOpenMode??e.planOpenMode,levelName:e.LevelName??e.levelName,activeView:Qn(e.ActiveView??e.activeView),targetView:Qn(e.TargetView??e.targetView),selectedPlan:Qn(e.SelectedPlan??e.selectedPlan),suggestedView:Qn(e.SuggestedView??e.suggestedView),planCandidatesTotal:Array.isArray(t)?t.length:e.PlanCandidatesTotal??e.planCandidatesTotal,planCandidatesTruncated:e.PlanCandidatesTruncated??e.planCandidatesTruncated,createdView:e.CreatedView??e.createdView,reusedView:e.ReusedView??e.reusedView,sectionBoxApplied:e.SectionBoxApplied??e.sectionBoxApplied,cameraOrientation:e.CameraOrientation??e.cameraOrientation,cameraApplied:e.CameraApplied??e.cameraApplied}}function Hi(e){return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded")===!0,state:d(e,"State","state"),action:d(e,"Action","action"),message:d(e,"Message","message"),error:d(e,"Error","error"),resultContractVersion:d(e,"ResultContractVersion","resultContractVersion"),responseMode:"compact",mode:e.mode??e.Mode,usedStep:e.usedStep??e.UsedStep,focusSummary:Gr(e.focus??e.Focus),planSummary:Gr(e.plan??e.Plan),threeDSummary:Gr(e.threeD??e.ThreeD)}}function du(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function cn(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"smart_focus_elements",message:e.message,error:e.error,resultContractVersion:du(e.focus,e.plan,e.threeD),mode:e.mode,usedStep:e.usedStep,focus:e.focus,plan:e.plan,threeD:e.threeD}}function Ui(e){e.tool("smart_focus_elements","[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. When create3d=true, the 3D step runs after whichever live focus step succeeds. Use this for live Revit focus/navigation, not image artifact export.",{...w(J),...x(J),elementIds:J.array(uu).min(1).describe("ElementId values to select and show."),mode:J.enum(["activeOnly","activeThenElementLevelPlan","elementLevelPlan"]).optional().describe("activeOnly only tries the active/requested view. activeThenElementLevelPlan falls back to an existing same-level plan. elementLevelPlan skips the active view and opens the same-level plan. Defaults activeThenElementLevelPlan."),viewId:J.number().int().positive().optional().describe("Optional target view id for the first focus attempt."),viewName:J.string().optional().describe("Optional target view name for the first focus attempt."),viewType:J.string().optional().describe("Optional Revit ViewType filter for the first focus attempt."),exactName:J.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),planNameContains:J.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level for same-level fallback."),preferMechanical:J.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:J.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:J.boolean().optional().describe("Zoom/show the supplied elements. Defaults true."),fitToScreen:J.boolean().optional().describe("Run Revit UI ZoomToFit after focus. Defaults false."),create3d:J.boolean().optional().describe("After the successful active/requested-view or plan focus step, create/reuse a focused 3D view for all supplied elements. Defaults false."),viewName3d:J.string().optional().describe("Desired 3D view name when create3d=true."),reuseExisting3d:J.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),sectionBox:J.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),cameraOrientation:J.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),framingPaddingMm:J.number().min(0).max(1e5).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),paddingMm:J.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),allowPartial:J.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),verboseCandidates:J.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:J.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:J.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),timeoutMs:J.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=T(t,"Smart focus Revit elements"),r=t.mode||"activeThenElementLevelPlan",o=null,i=null,a=null;if(r!=="elementLevelPlan"){if(o=Un(await _("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:!1,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Try focus elements in active/requested view"},n)),o&&$n(o)){t.create3d===!0&&(a=Un(await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view after active/requested focus"},n)));let m=t.create3d===!0?!!(a&&$n(a)):!0,p=ht(cn({success:m,message:t.create3d===!0?m?"Elements were focused in the active/requested view and focused in 3D.":"Elements were focused in the active/requested view, but the 3D step failed.":"Elements were focused in the active/requested view.",mode:r,usedStep:t.create3d===!0?"activeOrRequestedViewThen3D":"activeOrRequestedView",focus:o,threeD:a}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return h(t.responseMode==="full"||!m?p:Hi(p))}let u=Gi(o);if(r==="activeOnly"||!o||!u)return h(cn({success:!1,guarded:u,mode:r,error:d(o,"Error","error")||"Active/requested view focus failed.",focus:o}))}if(i=Un(await _("open_existing_plan_for_element_level",{elementId:t.elementIds[0],planMode:"elementLevel",planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Smart focus fallback to same-level existing plan"},n)),!i||!$n(i))return h(cn({success:!1,guarded:Gi(i),mode:r,error:d(i,"Error","error")||"Same-level existing plan focus failed.",focus:o,plan:i}));t.create3d===!0&&(a=Un(await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view"},n)));let s=t.create3d===!0?!!(a&&$n(a)):!0,l=ht(cn({success:s,message:t.create3d===!0?s?"Elements were focused in a same-level plan and focused in 3D.":"Elements were focused in a same-level plan, but the 3D step failed.":"Elements were focused in a same-level plan.",mode:r,usedStep:t.create3d===!0?"elementLevelPlanThen3D":"elementLevelPlan",focus:o,plan:i,threeD:a}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return h(t.responseMode==="full"||!s?l:Hi(l))}catch(n){return h(cn({success:!1,mode:t.mode||"unknown",error:n instanceof Error?n.message:String(n)}))}})}import{z as we}from"zod";async function mu(e,t){let r=(Array.isArray(e.elementIds)?e.elementIds:[]).map(o=>Number.parseInt(String(o),10)).filter(o=>Number.isFinite(o)&&o>0);return e.useSelection&&(r=r.concat(await Nt(e.limit||20,t))),[...new Set(r)].slice(0,e.limit||20)}function pu(e,t){let n=Jn(e),r=t.includeParameters!==!1?"true":"false",o=t.includeTypeParameters===!0?"true":"false",i=t.includeConnectors!==!1?"true":"false",a=Ae(t.parameterNames||[]);return`
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
}`}function $i(e){e.tool("inspect_elements","Read-only inspection for selected or targeted Revit elements: class/category/type/level/key parameters/connector summary.",{...w(we),...x(we),elementIds:we.array(we.union([we.number(),we.string()])).optional().describe("Element ids to inspect."),useSelection:we.boolean().optional().describe("When true, inspect the current Revit selection."),limit:we.number().int().positive().max(100).optional().describe("Maximum elements to inspect. Defaults 20."),includeParameters:we.boolean().optional().describe("Include key or requested parameter summaries. Defaults true."),includeTypeParameters:we.boolean().optional().describe("Also inspect matching type parameters. Defaults false."),includeConnectors:we.boolean().optional().describe("Include connector counts when available. Defaults true. When false, connectorCount/openConnectorCount are null and connectorsIncluded=false."),parameterNames:we.array(we.string()).optional().describe("Optional targeted parameter names.")},async t=>{let n=se(t);try{let r=await mu(t,n);if(r.length===0)return h({success:!0,elements:[],warnings:["No element ids supplied and no selected elements found."]});let o=await K(pu(r,t),{...n,...ye(t,"Inspect Revit elements"),transactionMode:"none"});return h(o&&o.result?o.result:o)}catch(r){return h({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as ve}from"zod";var hu=["completed","max_elapsed","max_rows","max_columns","max_cells","max_items","max_bytes","read_failed","needs_scope"],fu=["lastReadSection","lastReadRow","lastReadColumn","lastReadSheetId","lastReadViewId","lastReadViewportId","lastReadItemId"],gu=new Set(hu),yu={done:"completed",success:"completed",timeout:"max_elapsed",timed_out:"max_elapsed",socket_timeout:"max_elapsed",max_schedules:"max_items",max_sheets:"max_items",max_text_notes:"max_items",max_tags:"max_items",max_viewports:"max_items",max_scanned:"max_items",max_schedule_instances:"max_items",max_schedule_cells:"max_cells",max_cells_scanned:"max_cells",rows_truncated:"max_rows",columns_truncated:"max_columns"};function un(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function Pt(e){return String(e??"").trim()}function At(e){return Array.isArray(e)?e.map(t=>Pt(t)).filter(t=>t.length>0):[]}function c(e,t){if(!un(e))return;let n=t.charAt(0).toUpperCase()+t.slice(1);if(Object.prototype.hasOwnProperty.call(e,t))return e[t];if(Object.prototype.hasOwnProperty.call(e,n))return e[n];let r=t.toLowerCase(),o=Object.keys(e).find(i=>i.toLowerCase()===r);return o?e[o]:void 0}function C(e,t){let n=c(e,t);return Array.isArray(n)?n.filter(r=>un(r)):[]}function Ot(e,t){let n=c(e,t);return un(n)?n:null}function Qi(e,t=!1){if(typeof e=="boolean")return e;if(typeof e=="string"){let n=e.trim().toLowerCase();if(n==="true")return!0;if(n==="false")return!1}return t}function Xi(e){if(e==null)return null;if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function dn(e,t="completed"){let n=Pt(e).toLowerCase();return n?gu.has(n)?n:yu[n]||t:t}function bu(e,t,n,r){return n?"needs_scope":r==="failed"?"read_failed":t?"max_items":"completed"}function Hr(e,t,n){return typeof e=="function"?e(t):e??n}function le(e,t){let n=un(e)?{...e}:{value:e},r=Pt(c(n,"state")),o=Pt(c(n,"error")),i=Qi(c(n,"guarded"),!1),a=c(n,"success"),s=typeof a=="boolean"?!!a:o.length===0,l=r||(i?"guarded":s?"completed":"failed"),u=t.partial??Qi(c(n,"partial"),!1),m=Pt(t.scanStoppedReason??c(n,"scanStoppedReason")),p=bu(n,u,i,l),g=dn(m,p);n.success=s,n.guarded=i,n.state=l,n.action=t.action,n.partial=u,n.scanStoppedReason=g,m&&m!==g&&n.rawScanStoppedReason===void 0&&(n.rawScanStoppedReason=m);let y=Ot(n,"scanPolicy");n.scanPolicy=y||t.scanPolicy||{};let S=At(c(n,"suggestedNextScopes"));n.suggestedNextScopes=S.length>0?S:At(t.suggestedNextScopes),n.elapsedMs=Xi(c(n,"elapsedMs"))??Xi(t.elapsedMs),n.warnings=At(c(n,"warnings")).concat(At(t.warnings)),n.notices=At(c(n,"notices")).concat(At(t.notices));let E=Hr(t.evidenceRows,n,[]),A=C(n,"evidenceRows");n.evidenceRows=A.length>0?A:Array.isArray(E)?E:[];let L=Hr(t.summary,n,{}),j=Ot(n,"summary");n.summary=j||(un(L)?L:{});let O=Hr(t.lastRead,n,{});for(let H of fu){let Y=c(n,H);n[H]=Y!==void 0?Y:O[H]??null}return n}function xe(e){let t=Pt(e.reason)||"needs_scope";return le({...e.extra||{},success:!0,guarded:!0,state:"guarded",action:e.action,reason:t,message:e.message,partial:!1,scanStoppedReason:t},{...e,partial:!1,scanStoppedReason:t,summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}function ge(e){return le({...e.extra||{},success:!1,guarded:!1,state:"failed",action:e.action,error:e.error,partial:!1,scanStoppedReason:"read_failed"},{...e,partial:!1,scanStoppedReason:"read_failed",summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}var Su=500,Ki=5e3,wu=3e4;function Yi(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function xu(e){return[...new Set((Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t??""),10)).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n)}function vu(e){return[...new Set((Array.isArray(e)?e:[]).map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0)}function Cu(e){let t=String(e??"");return["hostOnly","linkedOnly","hostAndLinked"].includes(t)?t:"hostAndLinked"}function Ru(e){return String(e??"")==="exact"?"exact":"contains"}function Zi(e){return{sourceScope:Cu(e.sourceScope),linkInstanceIds:xu(e.linkInstanceIds),linkInstanceUniqueIds:vu(e.linkInstanceUniqueIds),nameQuery:String(e.nameQuery??"").trim(),nameMatchMode:Ru(e.nameMatchMode),maxResults:Yi(e.maxResults,Su,1,Ki),timeoutMs:Yi(e.timeoutMs,wu,2e3,6e4),taskName:e.taskName||"Inspect Revit levels",taskId:e.taskId}}function ea(e){let t=Zi(e);return{sourceScope:t.sourceScope,linkInstanceSelectorMode:"exact_id_or_unique_id",nameMatchMode:t.nameMatchMode,maxResults:t.maxResults,deterministicSortBasis:["sourceKind(host_before_link)","linkInstanceUniqueId(ordinal)","linkInstanceId","sourceProjectElevationMm","name(ordinal)","levelUniqueId(ordinal)","levelId"],maxResultsAppliedAfterDeterministicSort:!0}}function Iu(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function Tu(e){return Iu(e)?{linkInstanceUniqueId:c(e,"linkInstanceUniqueId")??null,levelId:c(e,"levelId")??null,levelUniqueId:c(e,"levelUniqueId")??null,levelName:c(e,"levelName")??null}:null}function _u(e){return{sourceKind:c(e,"sourceKind")??null,documentKey:c(e,"documentKey")??null,documentSessionId:c(e,"documentSessionId")??null,levelId:c(e,"levelId")??null,levelUniqueId:c(e,"levelUniqueId")??null,name:c(e,"name")??null,sourceProjectElevationMm:c(e,"sourceProjectElevationMm")??null,sourceProjectElevationFrame:c(e,"sourceProjectElevationFrame")??null,hostElevationMm:c(e,"hostElevationMm")??null,hostElevationFrame:c(e,"hostElevationFrame")??null,hostElevationTransformBasis:c(e,"hostElevationTransformBasis")??null,linkInstanceId:c(e,"linkInstanceId")??null,linkInstanceUniqueId:c(e,"linkInstanceUniqueId")??null,linkedSourceLevelSelector:Tu(c(e,"linkedSourceLevelSelector"))}}function ta(e){return C(e,"levels").map(_u)}function Ur(e){let t=Number(c(e,"unavailableSourceCount")??0);return Number.isFinite(t)&&t>0?Math.trunc(t):0}function $r(e){return Ur(e)>0||c(e,"partial")===!0||c(e,"truncated")===!0}function na(e){return Ur(e)>0?"read_failed":c(e,"truncated")===!0?"max_items":String(c(e,"scanStoppedReason")??($r(e)?"max_items":"completed"))}function Mu(e){let t=ta(e);return{sourceScope:c(e,"sourceScope")??null,nameQuery:c(e,"nameQuery")??null,nameMatchMode:c(e,"nameMatchMode")??null,effectiveSourceCount:c(e,"effectiveSourceCount")??null,selectedLinkCount:c(e,"selectedLinkCount")??null,loadedSelectedLinkCount:c(e,"loadedSelectedLinkCount")??null,unavailableSourceCount:Ur(e),scannedLevelCount:c(e,"scannedLevelCount")??null,matchedLevelCount:c(e,"matchedLevelCount")??null,returnedCount:c(e,"returnedCount")??t.length,partial:$r(e),scanStoppedReason:na(e)}}function Nu(e,t,n){let r=ta(e),o=r.length>0?r[r.length-1]:null,i=le(e,{action:"inspect_levels",elapsedMs:n,partial:$r(e),scanStoppedReason:na(e),scanPolicy:ea(t),suggestedNextScopes:["sourceScope","linkInstanceIds","linkInstanceUniqueIds","nameQuery","nameMatchMode","maxResults"],summary:Mu,evidenceRows:r,lastRead:{lastReadItemId:o?.levelId??null}});return i.levels=r,delete i.Levels,i}function ra(e){e.tool("inspect_levels","[LEVEL_INSPECTION_READ_ONLY] List deterministic host and loaded-linked Revit Level evidence without modifying the model. Use sourceScope plus exact linkInstanceIds/linkInstanceUniqueIds to discover linked source level names and transformed host elevations before capture_spatial_snapshot or other level-scoped reads. Optional nameQuery supports exact or contains matching. sourceProjectElevationMm uses the shared Level.ProjectElevation-compatible resolver. Linked hostElevationMm is based on RevitLinkInstance.GetTransform applied to the source-origin point (0,0,project elevation), and each linked row includes a copy-ready linkedSourceLevelSelector. maxResults is applied only after deterministic sorting and reports partial/max_items when truncated. Missing, unloaded, or unreadable selected links report unavailableSourceCount and partial/read_failed instead of a complete inventory. Prefer this tool over custom C# level/link loops.",{...w(ve),...x(ve),sourceScope:ve.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),linkInstanceIds:ve.array(ve.union([ve.number().int().positive(),ve.string()])).max(100).optional().describe("Optional exact RevitLinkInstance element ids. Selectors restrict linked sources and are ignored for hostOnly."),linkInstanceUniqueIds:ve.array(ve.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance UniqueIds. Selectors restrict linked sources and are ignored for hostOnly."),nameQuery:ve.string().optional().describe("Optional Level name filter. Empty returns all levels in the selected sources."),nameMatchMode:ve.enum(["exact","contains"]).optional().describe("Level-name matching policy. Defaults contains; matching is ordinal case-insensitive natively."),maxResults:ve.number().int().positive().max(Ki).optional().describe("Maximum deterministically sorted Level rows returned. Defaults 500; truncation reports partial/max_items."),timeoutMs:ve.number().int().min(2e3).max(6e4).optional().describe("Socket timeout in milliseconds. Defaults 30000.")},async t=>{let n=Date.now(),r=Zi(t);try{let o=await _("inspect_levels",r,{...T(t,"Inspect Revit levels"),toolName:"inspect_levels",timeoutMs:r.timeoutMs});return h(Nu(o&&o.result?o.result:o,t,Date.now()-n))}catch(o){return h(ge({action:"inspect_levels",error:o instanceof Error?o.message:String(o),elapsedMs:Date.now()-n,scanPolicy:ea(t),suggestedNextScopes:["sourceScope","linkInstanceIds","linkInstanceUniqueIds","nameQuery","nameMatchMode","maxResults"],extra:{sourceScope:r.sourceScope,nameQuery:r.nameQuery,nameMatchMode:r.nameMatchMode,lengthUnit:"mm",hostCoordinateFrame:"host_internal_mm",maxResults:r.maxResults,unavailableSourceCount:0,levels:[]}}))}})}import{z as V}from"zod";var Eu={fast:{maxElapsedMs:4500,timeoutMs:12e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4},deep:{maxElapsedMs:45e3,timeoutMs:6e4}};function ku(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Eu[t],r=Number.parseInt(String(e.maxElapsedMs??""),10),o=Number.isFinite(r)?Math.max(1,Math.min(119e3,r)):n.maxElapsedMs,i=Number.parseInt(String(e.timeoutMs??""),10),a=Number.isFinite(i)?Math.max(1e3,Math.min(12e4,i)):Math.max(n.timeoutMs,Math.min(12e4,o+5e3));return{searchBudget:t,maxElapsedMs:Math.min(o,Math.max(1,a-1e3)),timeoutMs:a}}function Au(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||e.query||"").trim())}function Pu(e,t){return xe({action:"inspect_sheet_text",reason:"needs_scope",message:"Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"],scanPolicy:{searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,allowExpensiveSearch:!1,textQuery:!!String(e.textQuery||"").trim(),includeViewportTextNotes:e.includeViewportTextNotes===!0,includeViewportTags:e.includeViewportTags===!0,scanScheduleCells:e.scanScheduleCells===!0,maxTags:e.maxTags??e.maxTagsScanned,maxViewports:e.maxViewports??e.maxViewportsPerSheet},summary:{sheetQuery:e.sheetQuery??e.query??null,textQuery:e.textQuery??null,returnedCount:0,matchCount:0}})}function Ou(e,t){return{query:e.query,sheetQuery:e.sheetQuery??e.query,textQuery:e.textQuery,sheetIds:e.sheetIds,includeTextNotes:e.includeTextNotes,includeScheduleInstances:e.includeScheduleInstances,scanScheduleCells:e.scanScheduleCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,includeViewportTextNotes:e.includeViewportTextNotes,includeViewportTags:e.includeViewportTags,viewNameQuery:e.viewNameQuery,maxSheets:e.maxSheets,maxTextNotesPerSheet:e.maxTextNotesPerSheet,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxTextChars:e.maxTextChars,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxViewportTextNotesPerView:e.maxViewportTextNotesPerView,maxViewportTagsPerView:e.maxViewportTagsPerView,maxTags:e.maxTags,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit sheet annotations",taskId:e.taskId}}function Qr(e){let t=String(c(e,"kind")||c(e,"sourceType")||"");return t==="scheduleCell"?"placedScheduleCell":t==="scheduleInstance"?"placedScheduleInstance":t||"sheetTextNote"}function Vt(e){return String(c(e,"textQuery")??"").trim().length>0}function Xr(e,t=!0){if(!t)return!1;let n=c(e,"matchedTextQuery"),r=c(e,"inventoryOnly");return!(r===!0||String(r).trim().toLowerCase()==="true"||n===!1||String(n).trim().toLowerCase()==="false")}function Xn(e){let t=C(e,"evidenceRows"),n=t.length>0?t:C(e,"matches"),r=Vt(e);return n.filter(o=>!!o&&typeof o=="object"&&!Array.isArray(o)).filter(o=>Xr(o,r)).map(o=>({...o,sourceType:Qr(o)}))}function oa(e){let t=C(e,"inventoryRows"),n=C(e,"evidenceRows"),r=Vt(e),o=[...n,...C(e,"matches")].filter(a=>!!a&&typeof a=="object"&&!Array.isArray(a)).filter(a=>!Xr(a,r)),i=new Set;return[...t,...o].filter(a=>!!a&&typeof a=="object"&&!Array.isArray(a)).map(a=>({...a,sourceType:Qr(a),matchedTextQuery:!1,inventoryOnly:!0})).filter(a=>{let s=[c(a,"sourceType")??"",c(a,"sheetId")??"",c(a,"instanceId")??c(a,"elementId")??c(a,"id")??"",c(a,"scheduleId")??""].join("|");return i.has(s)?!1:(i.add(s),!0)})}function Yr(e,t){let n={};for(let[r,o]of Object.entries(e))t.has(r)||(n[r]=o);return n}function Vu(e,t){let n=t&&Xr(e,t);return{...Yr(e,new Set(["MatchedTextQuery","InventoryOnly","matchedTextQuery","inventoryOnly"])),sourceType:Qr({...e,kind:c(e,"kind")??"scheduleInstance"}),MatchedTextQuery:n,InventoryOnly:!n,matchedTextQuery:n,inventoryOnly:!n}}function Du(e){let t=Vt(e);return C(e,"sheets").map(n=>{let r=Yr(n,new Set(["ScheduleInstances"])),o=C(n,"scheduleInstances");return{...r,scheduleInstances:o.map(i=>Vu(i,t))}})}function Fu(e){let t=c(e,"scan");return!t||typeof t!="object"||Array.isArray(t)||Vt(e)?t:{...t,TotalTextNoteMatches:0,totalTextNoteMatches:0,TotalViewportTextNoteMatches:0,totalViewportTextNoteMatches:0,TotalViewportTagMatches:0,totalViewportTagMatches:0,TotalScheduleCellMatches:0,totalScheduleCellMatches:0,TotalScheduleInstanceMatches:0,totalScheduleInstanceMatches:0}}function ia(e){let t=dn(c(e,"scanStoppedReason")),n=String(c(e,"rawScanStoppedReason")??c(e,"scanStoppedReason")??t).trim()||t;return{canonicalReason:t,nativeReason:n,nativeLimitField:{max_sheets:"maxSheets",max_text_notes:"maxTextNotesScanned",max_viewports:"maxViewports",max_scanned:"maxScheduleInstancesScanned",max_schedule_instances:"maxScheduleInstancesScanned",max_schedule_cells:"maxScheduleCellsScanned",max_tags:"maxTagsScanned"}[n]??null}}function Lu(e){let t=Xn(e),n=oa(e),r=C(e,"sheets");return{sheetQuery:c(e,"sheetQuery")??null,textQuery:c(e,"textQuery")??null,totalSheets:c(e,"totalSheets")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!Vt(e),matchCount:t.length,inventoryRowCount:n.length,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed",rawScanStoppedReason:c(e,"rawScanStoppedReason")??null,scanStopDetail:ia(e),scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null}}function ju(e){let t=C(e,"evidenceRows").length>0?C(e,"evidenceRows"):Xn(e),n=t.length>0?t[t.length-1]:null,r=C(e,"sheets"),o=r.length>0?r[r.length-1]:null;return{lastReadSection:n?c(n,"section")??null:null,lastReadRow:n?c(n,"row")??null:null,lastReadColumn:n?c(n,"column")??null:null,lastReadSheetId:n?c(n,"sheetId")??c(o,"id")??null:c(o,"id")??null,lastReadViewId:n?c(n,"viewId")??null:null,lastReadViewportId:n?c(n,"viewportId")??null:null,lastReadItemId:n?c(n,"elementId")??c(n,"tagId")??c(n,"instanceId")??c(n,"id")??null:null}}function Bu(e,t){let n=le(e,{action:"inspect_sheet_text",elapsedMs:t,summary:Lu,evidenceRows:Xn,lastRead:ju,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}),r=oa(n),o=Vt(n),i=Fu(n),a=new Set(["Sheets"]);return o||(a.add("Matches"),a.add("EvidenceRows")),{...Yr(n,a),evidenceRows:o?Xn(n):[],inventoryRows:r,matches:o?C(n,"matches"):[],scan:i,sheets:Du(n),summary:{...n.summary||{},inventoryRowCount:r.length,scanStopDetail:ia(n)}}}function aa(e){e.tool("inspect_sheet_text","[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet text and annotation inspection for DrawingSheet text notes, titleblock/title block notes, revision schedule instances, placed schedule cells, viewport-linked text notes, viewport plan annotations, and viewport tags. Prefer this dedicated tool over generic send_code_to_revit for sheet text lookup, drawing note searches, plan note searches, titleblock/revision evidence, placed schedule text evidence, and large-project sheet or viewport annotation searches. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true. When a user asks where a schedule value appears on sheets, search placed schedule cells here before writing custom C# sheet loops; use set_schedule_cells or set_schedule_cells_by_text for accepted follow-up writes.",{...w(V),...x(V),query:V.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),sheetQuery:V.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text or viewport annotation search."),textQuery:V.string().optional().describe("Optional text to search in sheet text notes, viewport text notes, or placed schedule cells."),sheetIds:V.array(V.union([V.number(),V.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),includeTextNotes:V.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),includeScheduleInstances:V.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),scanScheduleCells:V.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),allowExpensiveSearch:V.boolean().optional().describe("Explicit approval for project-wide sheet, viewport, tag, or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),searchBudget:V.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:V.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),includeViewportTextNotes:V.boolean().optional().describe("Include bounded TextNote results from views placed on matching sheets. Defaults false."),includeViewportTags:V.boolean().optional().describe("Include bounded IndependentTag evidence from views placed on matching sheets. Defaults false."),viewNameQuery:V.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),maxSheets:V.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),maxTextNotesPerSheet:V.number().int().min(0).max(1e3).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),maxScheduleInstancesPerSheet:V.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),maxRowsPerSchedule:V.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),maxColumnsPerSchedule:V.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),maxTextChars:V.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned text value. Defaults 240."),maxViewportsPerSheet:V.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:V.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet. Maximum placed viewports inspected per sheet."),maxViewportTextNotesPerView:V.number().int().min(0).max(1e3).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),maxViewportTagsPerView:V.number().int().min(0).max(500).optional().describe("Maximum matching viewport tags returned per placed view. Defaults 100."),maxTextNotesScanned:V.number().int().positive().max(2e5).optional().describe("Global native cap across sheet and viewport text notes."),maxTags:V.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:V.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxScheduleInstancesScanned:V.number().int().positive().max(1e5).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:V.number().int().positive().max(5e5).optional().describe("Global native cap across placed schedule body cells."),maxResponseBytes:V.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:V.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=ku(t),o=Au(t),i=!!String(t.textQuery||"").trim()&&!o,a=t.includeViewportTextNotes===!0&&!o,s=t.scanScheduleCells===!0&&!o,l=t.includeViewportTags===!0&&!o;if((i||a||s||l)&&t.allowExpensiveSearch!==!0)return h(Pu(t,r));let u=await _("inspect_sheet_text",Ou(t,r),{...T({...t,timeoutMs:r.timeoutMs},"Inspect Revit sheet annotations"),toolName:"inspect_sheet_text"});return h(Bu(u&&u.result?u.result:u,Date.now()-n))}catch(r){return h(ge({action:"inspect_sheet_text",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}))}})}import{z as G}from"zod";var zu=25,qu=50;function de(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function sa(e){let t=Array.isArray(e)&&e.length>0?e:["header","body"];return[...new Set(t.map(n=>String(n||"").toLowerCase()))].filter(n=>["header","body","footer"].includes(n))}var Ju={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxCells:5e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxCells:25e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxCells:1e5}};function la(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Ju[t],r=de(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=de(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxCells:de(e.maxCells,n.maxCells,1,5e5)}}function Wu(e){return(Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t),10)).filter(t=>Number.isFinite(t)&&t>0)}function Gu(e,t){let n=Wu(e.scheduleIds),r=sa(e.sections);return{query:e.query,nameQuery:e.nameQuery??e.query,cellQuery:e.cellQuery,scheduleIds:n,sections:r,includeCells:e.includeCells,scanCells:e.scanCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSchedules:de(e.maxSchedules,50,1,200),maxRowsPerSection:de(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:de(e.maxColumnsPerSection,30,0,200),startRow:de(e.startRow,0,0,1e5),startColumn:de(e.startColumn,0,0,1e4),maxCellTextChars:de(e.maxCellTextChars,180,20,1e3),maxCells:t.maxCells,maxResponseBytes:de(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit schedules",taskId:e.taskId}}function yt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function Hu(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Yn(e){return C(e,"schedules").filter(yt).flatMap(n=>C(n,"sections").map(o=>({schedule:n,section:o})))}function Dt(e){return String(c(e,"cellQuery")??"").trim().length>0}function Zr(e){return String(c(e,"nameQuery")??c(e,"query")??"").trim().length>0}function eo(e){return Dt(e)?Yn(e).flatMap(({schedule:t,section:n})=>C(n,"matches").filter(yt).map(o=>({sourceType:"scheduleCell",scheduleId:c(t,"id"),scheduleName:c(t,"name"),section:c(o,"section")??c(n,"section"),row:c(o,"row"),column:c(o,"column"),text:c(o,"text")}))):[]}function to(e){return c(e,"partial")===!0||c(e,"truncated")===!0?!0:Yn(e).some(({section:t})=>c(t,"rowsTruncated")===!0||c(t,"columnsTruncated")===!0)}function Uu(e){if(c(e,"success")===!1||String(c(e,"state")||"").toLowerCase()==="failed"||c(e,"error"))return"read_failed";if(!to(e))return"completed";if(c(e,"truncated")===!0)return"max_items";for(let{section:t}of Yn(e)){if(c(t,"rowsTruncated")===!0)return"max_rows";if(c(t,"columnsTruncated")===!0)return"max_columns"}return"max_cells"}function ca(e){let t=Uu(e),n=c(e,"scanStoppedReason");return!n||n==="completed"&&t!=="completed"?t:n}function $u(e){let t=ua(e),n=yt(t)?t:{},r=C(e,"schedules"),o=C(e,"evidenceRows").length>0?C(e,"evidenceRows"):eo(e);return{query:c(e,"query")??null,nameQuery:c(e,"nameQuery")??null,cellQuery:c(e,"cellQuery")??null,totalSchedules:c(e,"totalSchedules")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!Zr(e)&&!Dt(e),matchCount:o.length,totalCellMatches:c(n,"totalCellMatches")??o.length,scannedScheduleCount:c(n,"scannedScheduleCount")??null,partial:to(e),scanStoppedReason:ca(e)}}function Qu(e){let t=C(e,"evidenceRows").length>0?C(e,"evidenceRows"):eo(e),n=t.length>0?t[t.length-1]:null,r=Yn(e),o=r.length>0?r[r.length-1].section:null,i=C(e,"schedules"),a=r.length>0?r[r.length-1].schedule:i.length>0?i[i.length-1]:null,s=Number(c(o,"returnedRows")??c(o,"scannedRows")??0),l=Number(c(o,"returnedColumns")??c(o,"scannedColumns")??0),u=Number(c(o,"startRow")??0),m=Number(c(o,"startColumn")??0);return{lastReadSection:c(n,"section")??c(o,"section")??null,lastReadRow:c(n,"row")??c(o,"lastReadRow")??(s>0?u+s-1:null),lastReadColumn:c(n,"column")??c(o,"lastReadColumn")??(l>0?m+l-1:null),lastReadSheetId:null,lastReadViewId:null,lastReadViewportId:null,lastReadItemId:c(n,"scheduleId")??c(a,"id")??null}}function Kr(e){let t=la(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,includeCells:e.includeCells===!0,scanCells:e.scanCells===!0||!!e.cellQuery,sections:sa(e.sections),maxElapsedMs:t.maxElapsedMs,maxSchedules:de(e.maxSchedules,50,1,200),maxRowsPerSection:de(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:de(e.maxColumnsPerSection,30,0,200),startRow:de(e.startRow,0,0,1e5),startColumn:de(e.startColumn,0,0,1e4),maxCells:t.maxCells,maxResponseBytes:de(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs}}function Xu(e,t=!0){let{matches:n,Matches:r,...o}=e;return{...o,section:c(e,"section"),rowCount:c(e,"rowCount"),columnCount:c(e,"columnCount"),startRow:c(e,"startRow"),startColumn:c(e,"startColumn"),returnedRows:c(e,"returnedRows"),returnedColumns:c(e,"returnedColumns"),rowsTruncated:c(e,"rowsTruncated"),columnsTruncated:c(e,"columnsTruncated"),scannedRows:c(e,"scannedRows"),scannedColumns:c(e,"scannedColumns"),scannedCells:c(e,"scannedCells"),lastReadRow:c(e,"lastReadRow"),lastReadColumn:c(e,"lastReadColumn"),matches:t?C(e,"matches").filter(yt).map(i=>({...i,section:c(i,"section"),row:c(i,"row"),column:c(i,"column"),text:c(i,"text")})):[],cells:C(e,"cells").map(i=>({...i,row:c(i,"row"),cells:C(i,"cells").map(a=>({...a,column:c(a,"column"),text:c(a,"text")}))})),readFailed:c(e,"readFailed"),readError:c(e,"readError")}}function Yu(e){let t=!Zr(e)&&!Dt(e),n=Dt(e);return C(e,"schedules").filter(yt).map(r=>{let{nameMatched:o,NameMatched:i,cellMatchCount:a,CellMatchCount:s,sections:l,Sections:u,...m}=r;return{...m,id:c(r,"id"),uniqueId:c(r,"uniqueId"),name:c(r,"name"),viewType:c(r,"viewType"),isTemplate:c(r,"isTemplate"),nameMatched:t?!1:c(r,"nameMatched"),cellMatchCount:n?c(r,"cellMatchCount"):0,sections:C(r,"sections").filter(yt).map(p=>Xu(p,n))}})}function Ku(e,t){for(let[n,r]of Object.entries(t)){let o=n.charAt(0).toUpperCase()+n.slice(1);e[n]=r,e[o]=r}return e}function ua(e){let t=c(e,"scan");if(!t||typeof t!="object"||Array.isArray(t))return t;let n={...t},r={};return Zr(e)||(r.scheduleNameMatchedCount=0),Dt(e)||(r.cellMatchedScheduleCount=0,r.totalCellMatches=0),Ku(n,r)}function Zu(e){for(let t of["query","nameQuery","cellQuery","totalSchedules","candidateCount","returnedCount","truncated","maxSchedules","scan","matches"]){let n=c(e,t);n!==void 0&&e[t]===void 0&&(e[t]=n)}return e.scan=ua(e),e.schedules=Yu(e),Dt(e)||(e.matches=[],delete e.Matches),e}function ed(e){return String(c(e,"id")??c(e,"uniqueId")??c(e,"name")??"")}function td(e,t){let n=C(e,"cells"),r=Se(C(e,"matches"),{limit:t}),{cells:o,Cells:i,matches:a,Matches:s,...l}=e;return{...l,matches:r.rows,matchCount:r.totalCount,returnedMatchCount:r.returnedCount,omittedMatchCount:r.omittedCount,duplicateMatchCount:r.duplicateCount,cellsOmitted:n.length>0,cellRowCount:n.length,fullResponseHint:n.length>0?'Use responseMode="full" when downstream schedule adapters need section.cells/body rows.':void 0}}function nd(e,t){let n=t.responseMode||"compact";if(nt(n))return{...e,responseMode:n};let r=Pe(t.maxResultRows,zu,200),o=Pe(t.maxEvidenceRows,qu,1e3),i=Se(C(e,"schedules"),{limit:r,key:ed}),a=Se(C(e,"evidenceRows"),{limit:o});return{...e,responseMode:"compact",schedules:i.rows.map(s=>({...s,sections:C(s,"sections").filter(yt).map(l=>td(l,o))})),evidenceRows:a.rows,summary:{...e.summary||{},compactResponse:!0,scheduleRowCount:i.totalCount,returnedScheduleRowCount:i.returnedCount,omittedScheduleRowCount:i.omittedCount,duplicateScheduleRowCount:i.duplicateCount,evidenceRowCount:a.totalCount,returnedEvidenceRowCount:a.returnedCount,omittedEvidenceRowCount:a.omittedCount},notices:[...Hu(e.notices),'Compact response omits section.cells and bounds evidence rows. Use responseMode="full" for full schedule cell bodies.']}}function no(e,t,n){let r=to(e);return nd(Zu(le(e,{action:"inspect_schedules",elapsedMs:n,partial:r,scanStoppedReason:ca(e),scanPolicy:Kr(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],summary:$u,evidenceRows:eo,lastRead:Qu})),t)}function da(e){e.tool("inspect_schedules","[SCHEDULE_INSPECTION_READ_ONLY] Read-only native Revit schedule discovery and bounded cell inspection with partial-result continuation state. Prefer this over generic send_code_to_revit when finding schedules, reading schedule cells, exporting schedule text to a local TSV/CSV/Excel-style report, or preparing exact row/column coordinates for set_schedule_cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true. Default responseMode=compact omits bulky section.cells; use responseMode=full when the next step needs raw schedule body rows, such as reconcile_schedule_excel schedule adaptation or a local TSV conversion. Do not use raw C# only to dump schedule cells.",{...w(G),...x(G),query:G.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),nameQuery:G.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),cellQuery:G.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),scheduleIds:G.array(G.union([G.number(),G.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),sections:G.array(G.enum(["header","body","footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),includeCells:G.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),scanCells:G.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),allowExpensiveSearch:G.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),searchBudget:G.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:G.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial schedule results can return before transport timeout."),maxSchedules:G.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),maxRowsPerSection:G.number().int().min(0).max(1e3).optional().describe("Maximum rows per section to read/scan. Defaults 80."),maxColumnsPerSection:G.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),startRow:G.number().int().min(0).max(1e5).optional().describe("Zero-based first schedule row to read in each requested section. Defaults 0."),startColumn:G.number().int().min(0).max(1e4).optional().describe("Zero-based first schedule column to read in each requested section. Defaults 0."),maxCells:G.number().int().positive().max(5e5).optional().describe("Global native cap across schedule cells read or scanned. Defaults by searchBudget."),maxResponseBytes:G.number().int().min(4096).max(16*1024*1024).optional().describe("Approximate native response-size cap. Defaults 4 MB."),maxCellTextChars:G.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),responseMode:tt,maxResultRows:G.number().int().positive().max(200).optional().describe("Compact-mode cap for returned schedule entries. Defaults 25; full/debug returns all native rows within maxSchedules."),maxEvidenceRows:G.number().int().positive().max(1e3).optional().describe("Compact-mode cap for evidenceRows and per-section matches. Defaults 50."),timeoutMs:G.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{let n=Date.now();try{let r=!!(Array.isArray(t.scheduleIds)&&t.scheduleIds.length>0||String(t.nameQuery||t.query||"").trim());if(!!(t.includeCells===!0||t.scanCells===!0||String(t.cellQuery||"").trim())&&!r&&t.allowExpensiveSearch!==!0)return h(xe({action:"inspect_schedules",reason:"needs_scope",message:"Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],scanPolicy:Kr(t),elapsedMs:Date.now()-n,summary:{nameQuery:t.nameQuery??t.query??null,cellQuery:t.cellQuery??null,returnedCount:0,matchCount:0}}));let i=la(t),a=await _("inspect_schedules",Gu(t,i),{...T(t,"Inspect Revit schedules"),toolName:"inspect_schedules",timeoutMs:i.timeoutMs});return h(no(a&&a.result?a.result:a,t,Date.now()-n))}catch(r){return h(ge({action:"inspect_schedules",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,scanPolicy:Kr(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"]}))}})}import{z as ho}from"zod";import*as dd from"node:fs";import pa from"node:fs/promises";import md from"node:path";import{performance as ro}from"node:perf_hooks";import*as St from"@e965/xlsx";import{parse as pd}from"csv-parse/sync";import{z as v}from"zod";var Kn=["identity","comparisonText"],Zn=["identity","comparisonText","code","description","quantity","unit","system","discipline","notes"],er={identity:["identity","id","key","name","item","row","code","type","mark","tag","poz","kod","ad","isim"],comparisonText:["comparisontext","comparison text","description","desc","aciklama","text","name","item","type","mark","tag","ad","isim"],code:["code","kod","type code","mark","tag","poz"],description:["description","desc","text","aciklama"],quantity:["quantity","qty","count","adet","miktar"],unit:["unit","units","birim"],system:["system","sistem"],discipline:["discipline","disiplin"],notes:["notes","note","remarks","remark","not"]},rd={\u0410:"A",\u0430:"A",\u0412:"B",\u0432:"B",\u0415:"E",\u0435:"E",\u041A:"K",\u043A:"K",\u041C:"M",\u043C:"M",\u041D:"H",\u043D:"H",\u041E:"O",\u043E:"O",\u0420:"P",\u0440:"P",\u0421:"C",\u0441:"C",\u0422:"T",\u0442:"T",\u0423:"Y",\u0443:"Y",\u0425:"X",\u0445:"X"},od={\u00C7:"C",\u00E7:"C",\u011E:"G",\u011F:"G",\u00D6:"O",\u00F6:"O",\u015E:"S",\u015F:"S",\u00DC:"U",\u00FC:"U"},Ft=new Set(["DN","MM","CM","M","KW","KCALH","LPS","M3H"]);function W(e){return String(e??"").replace(/\s+/g," ").trim()}function Oe(e){return W(e).replace(/\u0131/g,"i").replace(/\u0130/g,"I").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}function pn(e){return Oe(e).replace(/\s+/g,"")}function Lt(e){let t=String(e??"");return t=t.replace(/[\u0000-\u001f\u007f-\u009f]/g," "),t=t.normalize("NFKC"),t=t.replace(/\u0131/g,"i").replace(/\u0130/g,"I"),t=t.replace(/[\u0400-\u04ff]/g,n=>rd[n]||n),t=t.replace(/[\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/g,n=>od[n]||n),t=t.toUpperCase(),t=t.replace(/[\u00d8\u00f8\u2205\u2300\u0424\u0444]/g," DN "),t=t.replace(/\b(?:DIAMETER|DIA)\b/g," DN "),t=sd(t),t=t.replace(/(\d),(\d)/g,"$1.$2"),t=t.replace(/(\d)\.(\d)/g,"$1DECIMALDOT$2"),t=t.replace(/[^A-Z0-9]+/g," "),t=t.replace(/(\d)DECIMALDOT(\d)/g,"$1.$2"),t=t.replace(/\bM\s*3\s*H\b/g,"M3H"),t.replace(/\s+/g," ").trim()}function id(e){return e.map(n=>Lt(n)).filter((n,r,o)=>n.length>0&&o.indexOf(n)===r).join(" | ")}function jt(e){let t=id(e);return{profileVersion:1,normalizedKey:t,tokens:ad(t)}}function ad(e){let t=Lt(e),n=t.length>0?t.split(" "):[],r=[];for(let o=0;o<n.length;o++){let i=n[o],a=n[o+1];if(mn(i)&&a&&Ft.has(a)){r.push({type:"dimension",value:`${i}${a}`}),o++;continue}if(Ft.has(i)&&a&&mn(a)){r.push({type:"dimension",value:`${i}${a}`}),o++;continue}let s=ud(i);if(s){r.push({type:"dimension",value:s});continue}if(Ft.has(i)){r.push({type:"unit",value:i});continue}if(mn(i)){r.push({type:"number",value:i});continue}let l=n[o+2]||"",u=Ft.has(l)&&mn(n[o+3]||""),m=Ft.has(l)&&!u;if(ld(i)&&a&&mn(a)&&!Ft.has(i)&&!m){r.push({type:"code",value:`${i}${a}`}),o++;continue}if(cd(i)){r.push({type:"code",value:i});continue}r.push({type:"word",value:i})}return r}function sd(e){return e.replace(/\bM\s*(?:3|\^3)\s*\/\s*H\b/g," M3H ").replace(/\bM3H\b/g," M3H ").replace(/\b(?:L|LT)\s*\/\s*S\b/g," LPS ").replace(/\bLPS\b/g," LPS ").replace(/\bKCAL\s*\/\s*H\b/g," KCALH ").replace(/\bKCALH\b/g," KCALH ").replace(/\bKW\b/g," KW ").replace(/\bMM\b/g," MM ").replace(/\bCM\b/g," CM ").replace(/\bDN\b/g," DN ")}function mn(e){return/^\d+(?:\.\d+)?$/.test(e)}function ld(e){return/^[A-Z]+$/.test(e)}function cd(e){return/[A-Z]/.test(e)&&/\d/.test(e)}function ud(e){let t=e.match(/^(\d+(?:\.\d+)?)(DN|MM|CM|M|KW|KCALH|LPS|M3H)$/);if(t)return`${t[1]}${t[2]}`;let n=e.match(/^(DN)(\d+(?:\.\d+)?)$/);return n?`${n[1]}${n[2]}`:null}St.set_fs(dd);var hn="reconcile_schedule_excel",ir="excel_ingestion",Bt={maxWorkbookBytes:25*1024*1024,maxSheets:20,maxRows:5e3,maxColumns:100,maxCells:25e4,maxElapsedMs:5e3},zt={maxWorkbookBytes:100*1024*1024,maxSheets:200,maxRows:5e4,maxColumns:300,maxCells:1e6,maxElapsedMs:119e3},tr=Kn,nr=Zn,hd=er,fd=v.object({sheetName:v.string().min(1).optional(),sheetIndex:v.number().int().positive().optional(),range:v.string().min(1).optional(),headerRow:v.number().int().positive().optional(),dataStartRow:v.number().int().positive().optional()}).strict(),ha=v.object({identity:v.union([v.string().min(1),v.number().int().positive()]).optional(),comparisonText:v.union([v.string().min(1),v.number().int().positive()]).optional(),code:v.union([v.string().min(1),v.number().int().positive()]).optional(),description:v.union([v.string().min(1),v.number().int().positive()]).optional(),quantity:v.union([v.string().min(1),v.number().int().positive()]).optional(),unit:v.union([v.string().min(1),v.number().int().positive()]).optional(),system:v.union([v.string().min(1),v.number().int().positive()]).optional(),discipline:v.union([v.string().min(1),v.number().int().positive()]).optional(),notes:v.union([v.string().min(1),v.number().int().positive()]).optional()}).strict(),fa=v.object({maxWorkbookBytes:v.number().int().positive().optional(),maxSheets:v.number().int().positive().optional(),maxRows:v.number().int().nonnegative().optional(),maxColumns:v.number().int().positive().optional(),maxCells:v.number().int().positive().optional(),maxElapsedMs:v.number().int().positive().optional()}).strict(),gd=v.object({kind:v.literal("file"),path:v.string().min(1),format:v.enum(["xlsx","csv","tsv","xls"]).optional(),selection:fd.optional(),columnMapping:ha.optional(),budgets:fa.optional()}).strict(),yd=v.object({kind:v.literal("rows"),sheetName:v.string().min(1).optional(),rows:v.array(v.record(v.unknown())),selection:v.object({headerRow:v.number().int().positive().optional(),dataStartRow:v.number().int().positive().optional()}).strict().optional(),columnMapping:ha.optional(),budgets:fa.optional()}).strict(),io=v.discriminatedUnion("kind",[gd,yd]);function $e(e){return W(e)}function rr(e){return Oe(e)}function ma(e){return pn(e)}function bd(e){return{maxWorkbookBytes:qt(e?.maxWorkbookBytes,Bt.maxWorkbookBytes,zt.maxWorkbookBytes),maxSheets:qt(e?.maxSheets,Bt.maxSheets,zt.maxSheets),maxRows:qt(e?.maxRows,Bt.maxRows,zt.maxRows),maxColumns:qt(e?.maxColumns,Bt.maxColumns,zt.maxColumns),maxCells:qt(e?.maxCells,Bt.maxCells,zt.maxCells),maxElapsedMs:qt(e?.maxElapsedMs,Bt.maxElapsedMs,zt.maxElapsedMs)}}function qt(e,t,n){return typeof e!="number"||!Number.isFinite(e)?t:Math.max(0,Math.min(Math.floor(e),n))}function ga(e,t){let n=(t||md.extname(e).replace(/^\./,"")).trim().toLowerCase();return n==="xlsx"||n==="csv"||n==="tsv"||n==="xls"?n:"unsupported"}function bt(e,t,n={}){let{warnings:r=[],notices:o=[],suggestedNextScopes:i=[],...a}=n;return xe({action:hn,reason:e,message:t,extra:{stage:ir,ingestionContractVersion:1,...a},summary:n.summary||{},evidenceRows:[],scanPolicy:n.scanPolicy||{},suggestedNextScopes:i,warnings:r,notices:o})}function Sd(e,t={}){let{warnings:n=[],notices:r=[],...o}=t;return ge({action:hn,error:e,extra:{stage:ir,ingestionContractVersion:1,...o},summary:t.summary||{},evidenceRows:[],scanPolicy:t.scanPolicy||{},warnings:n,notices:r})}function wd(e){let t=e.table.warnings.concat(e.mappingWarnings),n=e.table.notices.concat(e.mappingNotices),r=e.table.partial,o=e.table.scanStoppedReason,i=e.records.map(a=>({sourceType:"excelRecord",excelRowId:a.excelRowId,sheetName:a.sheetName,rowNumber:a.rowNumber,identityText:a.identityText,comparisonText:a.comparisonText,normalizedKey:a.normalizedKey}));return le({success:!0,guarded:!1,state:"completed",action:hn,stage:ir,ingestionContractVersion:1,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,excelRecords:e.records,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs},{action:hn,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs,scanPolicy:{budgets:e.budgets,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerRow:e.table.headerRow,dataStartRow:e.table.dataStartRow,columnMapping:xd(e.mapping,e.table)},summary:{sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerCount:e.table.headers.length,scannedRows:e.table.rows.length,scannedCells:e.table.scannedCells,excelRows:e.records.length,excelRecordCount:e.records.length,emptyExcelRows:e.table.rows.length-e.records.length,formulaCachedValueCount:e.table.formulaCachedValueCount,formulaWithoutCachedValueCount:e.table.formulaWithoutCachedValueCount,partial:r,scanStoppedReason:o},evidenceRows:i,warnings:t,notices:n,lastRead:{lastReadRow:e.table.lastReadRow,lastReadColumn:e.table.lastReadColumn,lastReadItemId:e.records.length>0?e.records[e.records.length-1].excelRowId:null}})}function xd(e,t){let n={};for(let r of nr){let o=e[r];typeof o=="number"&&(n[r]=t.headers[o]||Qe(t.startColumn+o))}return n}function Qe(e){let t=Math.max(1,Math.floor(e)),n="";for(;t>0;){let r=(t-1)%26;n=String.fromCharCode(65+r)+n,t=Math.floor((t-1)/26)}return n}function oo(e){let t=e.trim().toUpperCase();if(!/^[A-Z]+$/.test(t))return null;let n=0;for(let r of t)n=n*26+(r.charCodeAt(0)-64);return n}function ya(e,t){if(!e)return t;let n=e.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/);if(!n)return null;let r=oo(n[1]),o=Number(n[2]),i=n[3]?oo(n[3]):r,a=n[4]?Number(n[4]):o;return!r||!i||o<1||a<o||i<r?null:{startRow:o,startColumn:r,endRow:a,endColumn:i}}function vd(e,t,n,r){return`${Qe(t)}${e}:${Qe(r)}${n}`}function Cd(e){return $e(e).length===0}function Rd(e){return e.every(t=>Cd(t.text))}function Id(e,t){let n=new Map;return e.map((r,o)=>{let i=`Column ${Qe(t+o)}`,a=$e(r.text)||i,s=rr(a)||rr(i),l=n.get(s)||0;return n.set(s,l+1),l===0?a:`${a} ${l+1}`})}function or(e){if(e==null)return"";if(e instanceof Date)return Number.isNaN(e.getTime())?"":e.toISOString();if(typeof e=="object"){let t=e;return Array.isArray(t.richText)?$e(t.richText.map(n=>String(n.text??"")).join("")):t.text!==void 0?$e(t.text):t.result!==void 0?or(t.result):""}return $e(e)}function Td(e,t,n,r){let o=St.utils.encode_cell({r:t-1,c:n-1}),i=`${r}!${o}`,a=e[o];if(!a)return{value:"",text:"",address:i};if(typeof a.f=="string"&&a.f.length>0)return a.v!==void 0&&a.v!==null&&!(typeof a.v=="string"&&a.v.length===0&&(a.w===void 0||a.w===""))?{value:a.v,text:or(a.v)||$e(a.w),address:i,formulaWithCachedValue:!0}:{value:"",text:"",address:i,formulaWithoutCachedValue:!0};let l=a.v??"";return{value:l,text:or(l)||$e(a.w),address:i}}function _d(e,t,n,r){return{value:e,text:or(e),address:`${r}!${Qe(n)}${t}`}}function Md(e,t){return ro.now()-e>t.maxElapsedMs}function Nd(e,t,n){let r=[],o=[],i={},a=new Set,s=new Set;for(let u of nr){let m=n?.[u];if(m!==void 0){let p=Pd(m,e,t);if(p===null)return{error:{role:u,reason:"unresolved_column_ref",value:m}};i[u]=p,a.add(p),s.add(u)}}for(let u of nr){if(i[u]!==void 0)continue;let m=ba(u,e);if(m.length===0)continue;let p=Ad(m,a);if(p.kind==="ambiguous")return{error:{role:u,reason:"ambiguous_alias",candidates:p.candidates}};p.kind==="resolved"&&(i[u]=p.match.index,a.add(p.match.index))}for(let u of tr)if(i[u]===void 0)return{error:{role:u,reason:"missing_required_role"}};let l=tr.filter(u=>!s.has(u));if(l.length>0){let u=l.map(m=>`${m}=${e[i[m]]||Qe(t+i[m])}`).join(", ");o.push(`column_mapping_inferred_from_headers: ${u}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`)}return{mapping:i,warnings:r,notices:o}}function Ed(e,t){let n={},r={},o=new Set;for(let i of tr){let a=ba(i,e).filter(s=>!o.has(s.index)).sort((s,l)=>s.priority-l.priority||s.index-l.index);n[i]=a.map(s=>({header:s.header,column:Qe(t+s.index),priority:s.priority})),a.length>0&&(r[i]=a[0].header,o.add(a[0].index))}return{requiredRoles:tr,candidates:n,suggestedColumnMapping:r}}function kd(e,t){let n=ma(t),r=hd[e];for(let o=0;o<r.length;o++)if(ma(r[o])===n)return o;return Number.POSITIVE_INFINITY}function ba(e,t){return t.map((n,r)=>({header:n,index:r,priority:kd(e,n)})).filter(n=>Number.isFinite(n.priority))}function Ad(e,t){let n=e.filter(a=>!t.has(a.index)),r=n.length>0?n:e,o=Math.min(...r.map(a=>a.priority)),i=r.filter(a=>a.priority===o);return i.length===1?{kind:"resolved",match:i[0]}:{kind:"ambiguous",candidates:i.map(a=>a.header)}}function Pd(e,t,n){if(typeof e=="number"){let s=e-1;return s>=0&&s<t.length?s:null}let r=e.trim(),o=rr(r),i=t.map((s,l)=>({header:s,index:l})).filter(s=>rr(s.header)===o);if(i.length===1)return i[0].index;let a=oo(r);if(a!==null){let s=a-n;return s>=0&&s<t.length?s:null}return null}function Od(e,t){let n=[];for(let r of e.rows){if(Rd(r.cells))continue;let o={};for(let[p,g]of e.headers.entries())o[g]=r.cells[p]?.text??"";let i={};for(let p of nr){let g=t[p];typeof g=="number"&&(i[p]=r.cells[g]?.text??"")}let a=$e(i.identity),s=$e(i.comparisonText),l=jt([a,s]),u=l.normalizedKey,m=`${e.sheetName}!${r.rowNumber}`;n.push({excelRowId:m,sheetName:e.sheetName,rowNumber:r.rowNumber,sourceRange:e.sourceRange,rawValues:o,mappedValues:i,identityText:a,comparisonText:s,normalizedKey:u,tokenProfile:l})}return n}async function Vd(e,t,n){let r=St.readFile(e.path,{cellDates:!0,cellFormula:!0,cellText:!0,nodim:!0}),o=r.SheetNames.map(m=>({name:m,worksheet:r.Sheets[m]||{}})),i=e.selection||{},a=!!(i.sheetName||i.sheetIndex),s=o.filter(m=>Ld(m.worksheet));if(!a&&o.length>t.maxSheets&&s.length!==1)return bt("max_items","Workbook sheet count exceeds maxSheets and cannot be auto-scoped to one non-empty sheet. Provide sheetName or sheetIndex.",{partial:!0,scanStoppedReason:"max_items",summary:{workbookSheets:o.length,nonEmptySheets:s.length,maxSheets:t.maxSheets},scanPolicy:{budgets:t},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex","excel.budgets.maxSheets"]});let l=Dd(r,i,s);if(!l)return bt("excel_sheet_selection_required","Select a worksheet with sheetName or 1-based sheetIndex.",{summary:{workbookSheets:o.length,sheetNames:o.map(m=>m.name)},scanPolicy:{budgets:t,selection:i},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex"]});let u=Fd(l,i,t,n);return!a&&s.length===1&&u.notices.push("Selected the only non-empty worksheet."),u}function Dd(e,t,n){if(t.sheetName){let r=e.Sheets[t.sheetName];return r?{name:t.sheetName,worksheet:r}:null}if(t.sheetIndex){let r=e.SheetNames[t.sheetIndex-1];return r&&e.Sheets[r]?{name:r,worksheet:e.Sheets[r]}:null}return n.length===1?n[0]:null}function Fd(e,t,n,r){let o=jd(e.worksheet);return wa({sheetName:e.name,fallbackRange:o,selection:t,budgets:n,startedAt:r,readCell:(i,a)=>Td(e.worksheet,i,a,e.name)})}function Ld(e){return Object.keys(e).some(t=>!t.startsWith("!"))}function jd(e){let t=Number.POSITIVE_INFINITY,n=Number.POSITIVE_INFINITY,r=1,o=1;for(let i of Object.keys(e))if(!i.startsWith("!"))try{let a=St.utils.decode_cell(i);t=Math.min(t,a.r+1),n=Math.min(n,a.c+1),r=Math.max(r,a.r+1),o=Math.max(o,a.c+1)}catch{continue}return!Number.isFinite(t)||!Number.isFinite(n)?{startRow:1,startColumn:1,endRow:1,endColumn:1}:{startRow:t,startColumn:n,endRow:r,endColumn:o}}async function Bd(e,t,n,r){let o=await pa.readFile(e.path,"utf8"),i=zd(e.selection||{},t),a=pd(o,{bom:!0,delimiter:r==="tsv"?"	":",",relax_column_count:!0,skip_empty_lines:!1,to:i.recordLimit+1}),s=a.length>i.recordLimit?{partial:!0,scanStoppedReason:i.scanStoppedReason}:void 0,l=s?a.slice(0,i.recordLimit):a,u=e.selection?.sheetName||(r==="tsv"?"TSV":"CSV");return Sa(l,u,e.selection||{},t,n,s)}function zd(e,t){let r=ya(e.range,{startRow:1,startColumn:1,endRow:1,endColumn:1})?.startRow||1,o=e.headerRow||r,i=e.dataStartRow||o+1;return{recordLimit:Math.max(r,o,i+t.maxRows-1),scanStoppedReason:"max_rows"}}function qd(e,t,n){let r=e.sheetName||"Rows",o=Jd(e.rows),i=e.selection?.headerRow||1,a=e.selection?.dataStartRow||i+1,s=[];for(;s.length<i-1;)s.push([]);for(s.push(o);s.length<a-1;)s.push([]);for(let l of e.rows)s.push(o.map(u=>l[u]));return Sa(s,r,{headerRow:i,dataStartRow:a},t,n)}function Jd(e){let t=[],n=new Set;for(let r of e)for(let o of Object.keys(r))n.has(o)||(n.add(o),t.push(o));return t}function Sa(e,t,n,r,o,i){let a=e.reduce((l,u)=>Math.max(l,u.length),1),s={startRow:1,startColumn:1,endRow:Math.max(e.length,1),endColumn:Math.max(a,1)};return wa({sheetName:t,fallbackRange:s,selection:n,budgets:r,startedAt:o,prelimited:i,readCell:(l,u)=>_d(e[l-1]?.[u-1],l,u,t)})}function wa(e){let t=ya(e.selection.range,e.fallbackRange);if(!t)throw new Error(`Invalid range selection: ${e.selection.range}`);let n=e.selection.headerRow||t.startRow,r=e.selection.dataStartRow||n+1;if(r<=n)throw new Error("dataStartRow must be greater than headerRow.");let o=t.endColumn,i=e.prelimited?.partial||!1,a=e.prelimited?.scanStoppedReason||"completed";o-t.startColumn+1>e.budgets.maxColumns&&(o=t.startColumn+e.budgets.maxColumns-1,i=!0,a="max_columns");let s=[],l=0,u=0,m=0,p=[],g=[];for(let j=t.startColumn;j<=o;j++){let O=e.readCell(n,j);s.push(O),l++,O.formulaWithCachedValue&&u++,O.formulaWithoutCachedValue&&(m++,p.push(`Formula cell ${O.address||`${e.sheetName}!${Qe(j)}${n}`} has no cached value and was read as blank.`))}let y=Id(s,t.startColumn),S=[],E=null,A=null,L=Math.max(r,t.startRow);for(let j=L;j<=t.endRow;j++){if(S.length>=e.budgets.maxRows){i=!0,a=a==="completed"?"max_rows":a;break}if(Md(e.startedAt,e.budgets)){i=!0,a="max_elapsed";break}if(l+y.length>e.budgets.maxCells){i=!0,a=a==="completed"?"max_cells":a;break}let O=[];for(let H=t.startColumn;H<=o;H++){let Y=e.readCell(j,H);O.push(Y),l++,E=j,A=H,Y.formulaWithCachedValue&&u++,Y.formulaWithoutCachedValue&&(m++,p.push(`Formula cell ${Y.address||`${e.sheetName}!${Qe(H)}${j}`} has no cached value and was read as blank.`))}S.push({rowNumber:j,cells:O})}return{sheetName:e.sheetName,sourceRange:vd(t.startRow,t.startColumn,t.endRow,o),headerRow:n,dataStartRow:r,startColumn:t.startColumn,headers:y,rows:S,notices:g,warnings:p,formulaCachedValueCount:u,formulaWithoutCachedValueCount:m,scannedCells:l,partial:i,scanStoppedReason:a,lastReadRow:E,lastReadColumn:A}}function Wd(e){return!!(e&&typeof e=="object"&&e.action===hn&&e.stage===ir)}async function xa(e){let t=ro.now(),n=io.safeParse(e);if(!n.success)return bt("needs_scope","Excel ingestion input failed schema validation.",{validationIssues:n.error.issues.map(i=>`${i.path.join(".")||"<root>"}: ${i.message}`),suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"]});let r=n.data,o=bd(r.budgets);try{let i=await Gd(r,o,t);if(Wd(i))return i;let a=i,s=Nd(a.headers,a.startColumn,r.columnMapping);if("error"in s)return bt("excel_column_mapping_required","Resolve identity and comparisonText column mapping before ingestion.",{mappingError:s.error,mappingSuggestion:Ed(a.headers,a.startColumn),summary:{sheetName:a.sheetName,headers:a.headers},scanPolicy:{budgets:o},suggestedNextScopes:["excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:a.warnings,notices:a.notices});let l=Od(a,s.mapping);return wd({sourceKind:r.kind,format:r.kind==="file"?ga(r.path,r.format):"rows",table:a,records:l,budgets:o,mapping:s.mapping,mappingNotices:s.notices,mappingWarnings:s.warnings,elapsedMs:ro.now()-t})}catch(i){return Sd(i instanceof Error?i.message:String(i),{scanPolicy:{budgets:o}})}}async function Gd(e,t,n){if(e.kind==="rows")return qd(e,t,n);let r=ga(e.path,e.format);if(r==="xls")return bt("unsupported_excel_format",".xls is not supported. Save the workbook as .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});if(r==="unsupported")return bt("unsupported_excel_format","Unsupported spreadsheet format. Use .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});let o=await pa.stat(e.path);return o.size>t.maxWorkbookBytes?bt("max_bytes","Workbook exceeds maxWorkbookBytes.",{format:r,partial:!0,scanStoppedReason:"max_bytes",summary:{workbookBytes:o.size,maxWorkbookBytes:t.maxWorkbookBytes},scanPolicy:{budgets:t},suggestedNextScopes:["excel.budgets.maxWorkbookBytes","excel.selection.sheetName","excel.selection.range"]}):r==="xlsx"?Vd(e,t,n):Bd(e,t,n,r)}import{z as b}from"zod";var ar="reconcile_schedule_records",so="schedule_record_adapter",rt="displayedScheduleCells",Hd=["body"],ao=Zn,Ia=Kn,Ud=er,$d=b.object({column:b.number().int().nonnegative(),header:b.string().min(1)}).strict(),Ta=b.union([b.array(b.string()),b.array($d),b.record(b.union([b.string().min(1),b.number().int().nonnegative()]))]),_a=b.enum(["auto","always","never"]),Ma=b.object({identity:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),comparisonText:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),code:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),description:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),quantity:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),unit:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),system:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),discipline:b.union([b.string().min(1),b.number().int().nonnegative()]).optional(),notes:b.union([b.string().min(1),b.number().int().nonnegative()]).optional()}).strict(),Qd=b.object({kind:b.literal("inspect_schedules_result"),result:b.record(b.unknown()),columnMapping:Ma.optional(),columnHeaders:Ta.optional(),sections:b.array(b.enum(["header","body","footer"])).optional(),headerDataMode:_a.optional()}).strict(),Xd=b.object({kind:b.literal("revit_schedule"),scheduleIds:b.array(b.union([b.number().int().positive(),b.string().min(1)])).optional(),nameQuery:b.string().min(1).optional(),sections:b.array(b.enum(["header","body","footer"])).optional(),columnMapping:Ma.optional(),columnHeaders:Ta.optional(),headerDataMode:_a.optional(),target:b.string().optional(),host:b.string().optional(),port:b.number().int().positive().max(65535).optional(),taskName:b.string().optional(),taskId:b.string().optional(),parentTaskName:b.string().optional(),parentTaskId:b.string().optional(),allowExpensiveSearch:b.boolean().optional(),searchBudget:b.enum(["fast","balanced","deep"]).optional(),maxElapsedMs:b.number().int().positive().max(119e3).optional(),maxSchedules:b.number().int().positive().max(200).optional(),maxRowsPerSection:b.number().int().min(0).max(1e3).optional(),maxColumnsPerSection:b.number().int().min(0).max(200).optional(),startRow:b.number().int().min(0).max(1e5).optional(),startColumn:b.number().int().min(0).max(1e4).optional(),maxCells:b.number().int().positive().max(5e5).optional(),maxResponseBytes:b.number().int().min(4096).max(16*1024*1024).optional(),maxCellTextChars:b.number().int().min(20).max(1e3).optional(),timeoutMs:b.number().int().positive().max(12e4).optional()}).strict(),lo=b.discriminatedUnion("kind",[Qd,Xd]);async function Na(e,t={}){let n=Date.now(),r=lo.safeParse(e);return r.success?r.data.kind==="revit_schedule"?Yd(r.data,n,t):Ea(r.data,Date.now()-n):sr("needs_scope","Schedule adapter input failed schema validation.",{validationIssues:r.error.issues.map(o=>`${o.path.join(".")||"<root>"}: ${o.message}`),elapsedMs:Date.now()-n,suggestedNextScopes:["schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]})}async function Yd(e,t,n){if(!!!(Array.isArray(e.scheduleIds)&&e.scheduleIds.length>0||String(e.nameQuery||"").trim())&&e.allowExpensiveSearch!==!0)return sr("needs_scope","Direct live schedule reconciliation requires scheduleIds or nameQuery. Set allowExpensiveSearch=true only when a broad schedule scan is intentional.",{sourceKind:e.kind,elapsedMs:Date.now()-t,suggestedNextScopes:["schedule.scheduleIds","schedule.nameQuery","schedule.allowExpensiveSearch=true"],scanPolicy:{sourceKind:e.kind,bridgeExecution:"inspect_schedules",scheduleIds:[],nameQuery:null,allowExpensiveSearch:!1,visibilityBasis:rt}});let i=["header",...Aa(e.sections).filter(g=>g!=="header")],a={query:e.nameQuery,nameQuery:e.nameQuery,scheduleIds:e.scheduleIds,sections:i,includeCells:!0,scanCells:!1,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:e.searchBudget,maxElapsedMs:e.maxElapsedMs,maxSchedules:e.maxSchedules,maxRowsPerSection:e.maxRowsPerSection,maxColumnsPerSection:e.maxColumnsPerSection,startRow:e.startRow,startColumn:e.startColumn,maxCells:e.maxCells,maxResponseBytes:e.maxResponseBytes,maxCellTextChars:e.maxCellTextChars,responseMode:"full",timeoutMs:e.timeoutMs,taskName:e.taskName||"Inspect live Revit schedule for reconciliation",taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId},l=await(n.sendCommand||_)("inspect_schedules",a,{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs,taskName:a.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,toolName:"reconcile_schedule_excel"}),u=Date.now()-t,m=no(l&&l.result?l.result:l,a,u),p=Ea({kind:"inspect_schedules_result",result:m,columnMapping:e.columnMapping,columnHeaders:e.columnHeaders,sections:e.sections,headerDataMode:e.headerDataMode},u);return p.sourceKind="revit_schedule",p.bridgeSourceKind="inspect_schedules_result",p.scanPolicy={...p.scanPolicy||{},sourceKind:"revit_schedule",bridgeExecution:"inspect_schedules",inspectSections:i,scheduleIds:e.scheduleIds||[],nameQuery:e.nameQuery||null,allowExpensiveSearch:e.allowExpensiveSearch===!0},p.notices=[...wt(p,"notices"),"Live Revit schedule input was read through bounded inspect_schedules before reconciliation."],p}function Ea(e,t){let n=e.result,r=W(c(n,"state")).toLowerCase();if(c(n,"success")===!1||r==="failed"||c(n,"error"))return lm(W(c(n,"error"))||"inspect_schedules_result failed before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:wt(n,"warnings"),notices:wt(n,"notices")});if(c(n,"guarded")===!0)return sr(W(c(n,"reason"))||"needs_scope","inspect_schedules_result was guarded before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:wt(n,"warnings"),notices:wt(n,"notices"),summary:c(n,"summary")||{},suggestedNextScopes:['inspect_schedules responseMode="full"',"schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let o=Aa(e.sections),i=Array.isArray(e.sections)&&e.sections.length>0,a=Pa(e.headerDataMode),s=C(n,"schedules"),l=wt(n,"warnings"),u=wt(n,"notices"),m=[],p=0,g=0,y=0,S=0,E=0;for(let O of s){let H=uo(c(O,"id"));if(!H){l.push("Skipped a schedule without id while adapting schedule records.");continue}let Y=cr(c(O,"name")),ee=tm(O,e.columnHeaders),te=om(ee,e.columnMapping);if("error"in te)return sr("schedule_column_mapping_required","Resolve identity and comparisonText schedule column mapping before adaptation.",{sourceKind:e.kind,scheduleId:H,scheduleName:Y,mappingError:te.error,summary:{scheduleId:H,scheduleName:Y,headers:ee.map($=>({column:$.column,header:$.header}))},scanPolicy:Ra(e,o),suggestedNextScopes:["schedule.columnMapping.identity","schedule.columnMapping.comparisonText",'inspect_schedules responseMode="full"'],warnings:l,notices:u});let re=em(O,o,i,a);re.headerAsData&&S++;for(let $ of C(O,"sections")){let oe=lr(c($,"section"));if(!re.sections.includes(oe))continue;let Ce=oe==="header"&&re.headerAsData;for(let Me of co($,H,Y,oe)){if(p++,g+=Me.cells.length,Ce&&Kd(Me,Y)){y++;continue}if(oe==="body"&&va(Me,te.mapping,ee,{matchSameColumnHeader:!0})){y++;continue}if(Ce&&va(Me,te.mapping,ee,{matchSameColumnHeader:!1})){y++;continue}let je=Zd(Me,te.mapping);je&&(Ce&&E++,m.push(je))}}}let A=c(n,"partial")===!0,L=dn(c(n,"scanStoppedReason"),A?"max_items":"completed"),j=m.length>0?m[m.length-1]:null;return le({success:!0,guarded:!1,state:"completed",action:ar,stage:so,adapterContractVersion:1,sourceKind:e.kind,visibilityBasis:rt,scheduleRecords:m,partial:A,scanStoppedReason:L,elapsedMs:t},{action:ar,partial:A,scanStoppedReason:L,elapsedMs:t,scanPolicy:Ra(e,o),summary:{sourceKind:e.kind,scheduleCount:s.length,scannedRows:p,scannedCells:g,skippedHeaderLikeRows:y,headerAsDataScheduleCount:S,headerAsDataRows:E,scheduleRecordCount:m.length,visibilityBasis:rt,partial:A,scanStoppedReason:L},evidenceRows:m.map(O=>({sourceType:"scheduleRecord",scheduleRowId:O.scheduleRowId,scheduleId:O.scheduleId,scheduleName:O.scheduleName,section:O.section,row:O.row,identityText:O.identityText,comparisonText:O.comparisonText,normalizedKey:O.normalizedKey,visibilityBasis:rt})),warnings:l,notices:[...u,...S>0?[`Read Header section rows as schedule data for ${S} schedule(s).`]:[],...y>0?[`Skipped ${y} header-like schedule row(s) during schedule adaptation.`]:[]],lastRead:{lastReadSection:c(n,"lastReadSection")??j?.section??null,lastReadRow:c(n,"lastReadRow")??j?.row??null,lastReadColumn:c(n,"lastReadColumn")??null,lastReadItemId:c(n,"lastReadItemId")??j?.scheduleRowId??null}})}function va(e,t,n,r){let o=new Map;for(let s of e.cells)o.set(s.column,s.text);let i=Ia.filter(s=>typeof t[s]=="number");if(i.length===0)return!1;let a=new Map;for(let s of i){let l=t[s];typeof l=="number"&&a.set(l,[...a.get(l)||[],s])}return[...a.entries()].every(([s,l])=>{let u=W(o.get(s));if(!u)return!1;let m=Oe(u);return r.matchSameColumnHeader&&n.some(g=>g.column===s&&Oe(g.header)===m)?!0:l.some(g=>Number.isFinite(ka(g,u))||g==="identity"&&["number","no","numara"].includes(m)?!0:g==="comparisonText"&&["name","description","desc","text","aciklama"].includes(m))})}function Kd(e,t){let n=Oe(t||"");if(!n)return!1;let r=e.cells.map(o=>Oe(o.text)).filter(o=>o.length>0);return r.length===1&&r[0]===n}function Zd(e,t){let n=new Map;for(let s of e.cells)n.set(s.column,s.text);let r={};for(let s of ao){let l=t[s];typeof l=="number"&&(r[s]=W(n.get(l)))}let o=W(r.identity),i=W(r.comparisonText);if(!o&&!i)return null;let a=jt([o,i]);return{scheduleRowId:`${e.scheduleId}:${e.section}:${e.row}`,scheduleId:e.scheduleId,scheduleName:e.scheduleName,section:e.section,row:e.row,rawCells:e.cells.map(s=>({column:s.column,text:s.text})),mappedValues:r,identityText:o,comparisonText:i,normalizedKey:a.normalizedKey,tokenProfile:a,visibilityBasis:rt}}function co(e,t,n,r){let o=C(e,"rows"),i=C(e,"cells");return(o.length>0?o:i).flatMap(s=>{let l=fn(c(s,"row"));if(l===null)return[];let u=C(s,"cells").map(m=>({column:fn(c(m,"column")),text:W(c(m,"text"))})).filter(m=>m.column!==null);return[{scheduleId:t,scheduleName:n,section:r,row:l,cells:u}]})}function em(e,t,n,r){return t.includes("header")?{sections:t,headerAsData:!0}:r==="never"?{sections:t,headerAsData:!1}:Ca(e,["header"])?r==="always"?{sections:[...t,"header"],headerAsData:!0}:!n&&!Ca(e,t)?{sections:[...t,"header"],headerAsData:!0}:{sections:t,headerAsData:!1}:{sections:t,headerAsData:!1}}function Ca(e,t){let n=uo(c(e,"id"))||"unknown",r=cr(c(e,"name"));for(let o of C(e,"sections")){let i=lr(c(o,"section"));if(t.includes(i)&&co(o,n,r,i).some(a=>a.cells.length>0))return!0}return!1}function tm(e,t){let n=[],r=new Set,o=(i,a)=>{let s=W(a);if(s.length===0)return;let l=`${i}:${Oe(s)}`;r.has(l)||(r.add(l),n.push({column:i,header:s}))};for(let i of nm(e))o(i.column,i.header);for(let i of C(e,"sections"))if(lr(c(i,"section"))==="header")for(let a of co(i,uo(c(e,"id"))||"unknown",cr(c(e,"name")),"header"))for(let s of a.cells)o(s.column,s.text);for(let i of rm(t))o(i.column,i.header);return n.sort((i,a)=>i.column-a.column)}function nm(e){let t=[],n=(r,o)=>{if(r===null)return;let i=W(o);i.length>0&&t.push({column:r,header:i})};for(let r of C(e,"fields")){if(c(r,"isHidden")===!0)continue;let o=fn(c(r,"column"))??fn(c(r,"visibleColumn"));n(o,c(r,"columnHeading")),n(o,c(r,"heading")),n(o,c(r,"label")),n(o,c(r,"name")),n(o,c(r,"fieldName")),n(o,c(r,"parameterName"))}return t}function rm(e){if(!e)return[];if(Array.isArray(e))return e.map((n,r)=>typeof n=="string"?{column:r,header:W(n)}:{column:n.column,header:W(n.header)}).filter(n=>n.header.length>0);let t=[];for(let[n,r]of Object.entries(e)){let o=fn(n);if(o!==null&&typeof r=="string"){let i=W(r);i.length>0&&t.push({column:o,header:i});continue}if(typeof r=="number"){let i=W(n);i.length>0&&t.push({column:r,header:i})}}return t.sort((n,r)=>n.column-r.column)}function om(e,t){let n=[],r=[],o={},i=new Set;for(let a of ao){let s=t?.[a];if(s!==void 0){let l=im(s,e);if(l===null)return{error:{role:a,reason:"unresolved_column_ref",value:s}};o[a]=l,i.add(l)}}for(let a of ao){if(o[a]!==void 0)continue;let s=am(a,e);if(s.length===0)continue;let l=sm(s,i);if(l.kind==="ambiguous")return{error:{role:a,reason:"ambiguous_alias",candidates:l.candidates}};o[a]=l.match.column,i.add(l.match.column)}for(let a of Ia)if(o[a]===void 0)return{error:{role:a,reason:"missing_required_role"}};return{mapping:o,warnings:n,notices:r}}function im(e,t){if(typeof e=="number")return t.length>0&&!t.some(i=>i.column===e)?null:e;let n=e.trim(),r=Oe(n),o=t.filter(i=>Oe(i.header)===r);return o.length===1?o[0].column:null}function ka(e,t){let n=pn(t),r=Ud[e];for(let o=0;o<r.length;o++)if(pn(r[o])===n)return o;return Number.POSITIVE_INFINITY}function am(e,t){return t.map(n=>({header:n.header,column:n.column,priority:ka(e,n.header)})).filter(n=>Number.isFinite(n.priority))}function sm(e,t){let n=e.filter(s=>!t.has(s.column)),r=n.length>0?n:e,o=Math.min(...r.map(s=>s.priority)),i=r.filter(s=>s.priority===o);return i.length===1?{kind:"resolved",match:i[0]}:[...new Set(i.map(s=>s.column))].length===1?{kind:"resolved",match:i[0]}:{kind:"ambiguous",candidates:i.map(s=>s.header)}}function Ra(e,t){return{sourceKind:e.kind,sections:t,headerDataMode:Pa(e.headerDataMode),columnMapping:e.columnMapping||null,numericColumnBase:"zero_based_revit_schedule_column",visibilityBasis:rt}}function sr(e,t,n={}){let{warnings:r=[],notices:o=[],elapsedMs:i,scanPolicy:a,summary:s,suggestedNextScopes:l=[],...u}=n;return xe({action:ar,reason:e,message:t,elapsedMs:i,extra:{stage:so,adapterContractVersion:1,visibilityBasis:rt,...u},summary:s||{},evidenceRows:[],scanPolicy:a||{},suggestedNextScopes:l,warnings:r,notices:o})}function lm(e,t={}){let{warnings:n=[],notices:r=[],elapsedMs:o,scanPolicy:i,summary:a,...s}=t;return ge({action:ar,error:e,elapsedMs:o,extra:{stage:so,adapterContractVersion:1,visibilityBasis:rt,...s},summary:a||{},evidenceRows:[],scanPolicy:i||{},warnings:n,notices:r})}function Aa(e){let t=Array.isArray(e)&&e.length>0?e:Hd;return[...new Set(t.map(lr))].filter(n=>["header","body","footer"].includes(n))}function Pa(e){return e==="always"||e==="never"?e:"auto"}function lr(e){let t=W(e).toLowerCase();return["header","body","footer"].includes(t)?t:"body"}function wt(e,t){let n=c(e,t);return Array.isArray(n)?n.map(W).filter(r=>r.length>0):[]}function fn(e){if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function uo(e){return cr(e)}function cr(e){let t=W(e);return t.length>0?t:null}import{z as P}from"zod";var gn={score:{exact:100,diceTokenOverlap:35,code:20,dimension:20,order:15,context:10},thresholds:{highConfidenceMin:86,highConfidenceMax:99,candidateMin:65,possibleRenameMin:72,possibleRenameMax:85,ambiguousMin:65,ambiguousMax:71,candidateGap:8,tieGap:8},caps:{conflictingCode:64,conflictingDimension:60,unitMismatch:79},candidateGeneration:{minSharedSignificantWordTokens:2},contextFields:["system","unit","quantity","discipline"]},cm=P.object({exact:P.number().min(0).max(100).optional(),diceTokenOverlap:P.number().min(0).max(100).optional(),code:P.number().min(0).max(100).optional(),dimension:P.number().min(0).max(100).optional(),order:P.number().min(0).max(100).optional(),context:P.number().min(0).max(100).optional()}).strict(),um=P.object({highConfidenceMin:P.number().min(0).max(100).optional(),highConfidenceMax:P.number().min(0).max(100).optional(),candidateMin:P.number().min(0).max(100).optional(),possibleRenameMin:P.number().min(0).max(100).optional(),possibleRenameMax:P.number().min(0).max(100).optional(),ambiguousMin:P.number().min(0).max(100).optional(),ambiguousMax:P.number().min(0).max(100).optional(),candidateGap:P.number().min(0).max(100).optional(),tieGap:P.number().min(0).max(100).optional()}).strict(),dm=P.object({conflictingCode:P.number().min(0).max(100).optional(),conflictingDimension:P.number().min(0).max(100).optional(),unitMismatch:P.number().min(0).max(100).optional()}).strict(),mm=P.object({minSharedSignificantWordTokens:P.number().int().min(0).max(20).optional()}).strict(),dr=P.object({score:cm.optional(),thresholds:um.optional(),caps:dm.optional(),candidateGeneration:mm.optional(),contextFields:P.array(P.string().min(1)).optional()}).strict(),pm=P.object({excelRecords:P.array(P.record(P.unknown())).optional(),scheduleRecords:P.array(P.record(P.unknown())).optional(),excelResult:P.record(P.unknown()).optional(),scheduleResult:P.record(P.unknown()).optional(),config:dr.optional()}).strict();function ja(e){let t=Date.now(),n=pm.safeParse(e);if(!n.success)return le({success:!0,guarded:!0,state:"guarded",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,reason:"reconciliation_input_required",message:"Provide excelRecords and scheduleRecords, or normalized ingestion result envelopes containing those arrays.",validationIssues:n.error.issues.map(l=>l.message),partial:!1,scanStoppedReason:"needs_scope"},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"needs_scope",elapsedMs:Date.now()-t,summary:{},evidenceRows:[]});let r=Rm(n.data.config),o=Oa("excel",n.data.excelRecords??Va(n.data.excelResult,"excelRecords")),i=Oa("schedule",n.data.scheduleRecords??Va(n.data.scheduleResult,"scheduleRecords")),a=hm(o,i,r),s=Im(o,i,a);return le({success:!0,guarded:!1,state:"review_ready",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,partial:!1,scanStoppedReason:"completed",reviewRows:a,reviewTable:Tm(a),suggestedNextActions:["review_ambiguous","accept_match","create_schedule_row","remove_or_ignore_schedule_row","rename_excel_or_schedule_text"],scoringConfig:r},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"completed",elapsedMs:Date.now()-t,summary:s,evidenceRows:a.map(l=>({sourceType:"reconciliationReviewRow",bucket:l.bucket,score:l.score,excelRowId:l.excelRow?.excelRowId??l.excelRow?.recordId??null,scheduleRowId:l.scheduleRow?.scheduleRowId??l.scheduleRow?.recordId??null,reason:l.reason}))})}function hm(e,t,n){let r=[],o=new Set,i=new Set,a=La(e),s=La(t);for(let l of e){let u=gm(l,t,n),m=l.normalizedKey.length>0&&(a.has(l.normalizedKey)||s.has(l.normalizedKey)),p=u[0]||null;if(m&&u.some(y=>y.score===n.score.exact||y.schedule.normalizedKey===l.normalizedKey)){let y=u.filter(S=>S.schedule.normalizedKey===l.normalizedKey||S.score>=n.thresholds.candidateMin).slice(0,5);r.push(mo("ambiguousMatches",y[0]||null,l,null,y,"duplicate_exact_key","review_ambiguous")),o.add(l.id),y.forEach(S=>i.add(S.schedule.id));continue}if(!p||p.score<n.thresholds.candidateMin&&p.hardConflicts.length===0){r.push(wm(l)),o.add(l.id);continue}if(i.has(p.schedule.id)){r.push(mo("ambiguousMatches",p,l,p.schedule,u.slice(0,5),"schedule_row_already_claimed","review_ambiguous")),o.add(l.id);continue}let g=fm(p,u[1]||null,n);r.push(mo(g.bucket,p,l,p.schedule,u.slice(0,5),g.reason,g.action)),o.add(l.id),i.add(p.schedule.id),g.bucket==="ambiguousMatches"&&u.filter(y=>y.score>=n.thresholds.candidateMin).slice(0,5).forEach(y=>i.add(y.schedule.id))}for(let l of t)i.has(l.id)||r.push(xm(l));return r.sort(Pm)}function fm(e,t,n){let r=t?e.score-t.score:Number.POSITIVE_INFINITY,o=t!==null&&e.score===t.score;if(o||r<n.thresholds.tieGap||e.score>=n.thresholds.ambiguousMin&&e.score<=n.thresholds.ambiguousMax)return{bucket:"ambiguousMatches",reason:o?"best_score_tie":r<n.thresholds.tieGap?"candidate_gap_below_threshold":"ambiguous_score_band",action:"review_ambiguous"};if(e.components.exact>0&&e.hardConflicts.length===0&&e.score===n.score.exact)return{bucket:"exactMatches",reason:"exact_normalized_key",action:"accept_match"};let i=(e.sharedCodeTokens.length>0||e.sharedDimensionTokens.length>0)&&e.descriptiveTokensDiffer;return!e.hardConflicts.length&&e.score>=n.thresholds.highConfidenceMin&&i?{bucket:"possibleRenames",reason:"shared_key_tokens_with_description_change",action:"rename_excel_or_schedule_text"}:e.score>=n.thresholds.highConfidenceMin&&e.score<=n.thresholds.highConfidenceMax&&!e.capped&&r>=n.thresholds.candidateGap?{bucket:"highConfidenceMatches",reason:"high_confidence_score_and_gap",action:"accept_match"}:!e.hardConflicts.length&&(e.score>=n.thresholds.highConfidenceMin&&i||e.score>=n.thresholds.possibleRenameMin&&e.score<=n.thresholds.possibleRenameMax)?{bucket:"possibleRenames",reason:i?"shared_key_tokens_with_description_change":"possible_rename_score_band",action:"rename_excel_or_schedule_text"}:{bucket:"ambiguousMatches",reason:e.hardConflicts.length>0?"hard_conflict_requires_review":"requires_review",action:"review_ambiguous"}}function gm(e,t,n){return t.filter(r=>ym(e,r,n)).map(r=>({...bm(e,r,n),excel:e,schedule:r})).sort(Am)}function ym(e,t,n){return e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey||Ve(X(e,"code"),X(t,"code")).length>0||Ve(X(e,"dimension"),X(t,"dimension")).length>0?!0:Ve(X(e,"word"),X(t,"word")).length>=n.candidateGeneration.minSharedSignificantWordTokens}function bm(e,t,n){let r=e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey,o=Jt(e.tokenProfile.tokens.map(S=>S.value)),i=Jt(t.tokenProfile.tokens.map(S=>S.value)),a=Ve(o,i),s=Jt(o.concat(i).filter(S=>!a.includes(S))),l=Ve(X(e,"code"),X(t,"code")),u=Ve(X(e,"dimension"),X(t,"dimension")),m=Sm(e,t),p={exact:r?n.score.exact:0,dice:r?0:ur(Mm(o,i)*n.score.diceTokenOverlap),code:r?0:Fa(X(e,"code"),X(t,"code"),n.score.code),dimension:r?0:Fa(X(e,"dimension"),X(t,"dimension"),n.score.dimension),order:r?0:ur(Nm(o,i)*n.score.order),context:r?0:_m(e,t,n)},g=r?n.score.exact:po(p.dice+p.code+p.dimension+p.order+p.context),y=g;for(let S of m)S==="conflicting_code"&&(y=Math.min(y,n.caps.conflictingCode)),S==="conflicting_dimension"&&(y=Math.min(y,n.caps.conflictingDimension)),S==="unit_mismatch"&&(y=Math.min(y,n.caps.unitMismatch));return{score:po(y),rawScore:po(g),components:p,matchedTokens:a,differingTokens:s,hardConflicts:m,sharedCodeTokens:l,sharedDimensionTokens:u,descriptiveTokensDiffer:km(e,t),capped:y<g}}function Sm(e,t){let n=[],r=X(e,"code"),o=X(t,"code");r.length>0&&o.length>0&&Ve(r,o).length===0&&n.push("conflicting_code");let i=X(e,"dimension"),a=X(t,"dimension");i.length>0&&a.length>0&&Ve(i,a).length===0&&n.push("conflicting_dimension");let s=Da(e),l=Da(t);return s.length>0&&l.length>0&&Ve(s,l).length===0&&n.push("unit_mismatch"),n}function mo(e,t,n,r,o,i,a){return{bucket:e,score:t?.score??0,rawScore:t?.rawScore??0,reason:i,matchedTokens:t?.matchedTokens??[],differingTokens:t?.differingTokens??[],hardConflicts:t?.hardConflicts??[],scoreComponents:t?.components??null,excelRow:n?yn(n):null,scheduleRow:r?yn(r):null,candidateRows:o.map(s=>({score:s.score,rawScore:s.rawScore,scheduleRow:yn(s.schedule),matchedTokens:s.matchedTokens,hardConflicts:s.hardConflicts})),recommendedNextAction:a}}function wm(e){return{bucket:"missingInSchedule",score:0,rawScore:0,reason:"no_schedule_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:yn(e),scheduleRow:null,candidateRows:[],recommendedNextAction:"create_schedule_row"}}function xm(e){return{bucket:"missingInExcel",score:0,rawScore:0,reason:"no_excel_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:null,scheduleRow:yn(e),candidateRows:[],recommendedNextAction:"remove_or_ignore_schedule_row"}}function yn(e){return{...e.raw,recordId:e.id,normalizedKey:e.normalizedKey,tokenProfile:e.tokenProfile}}function Oa(e,t){return Array.isArray(t)?t.filter(n=>!!n&&typeof n=="object"&&!Array.isArray(n)).map((n,r)=>vm(e,n,r)):[]}function vm(e,t,n=0){let r=e==="excel"?W(t.excelRowId||t.recordId||t.id):W(t.scheduleRowId||t.recordId||t.id),o=bn(t.mappedValues)?t.mappedValues:{},i=Cm(t,[t.identityText,t.comparisonText]);return{side:e,id:r||`${e}:${i.normalizedKey||"row"}:${n}`,normalizedKey:W(t.normalizedKey)||i.normalizedKey,tokenProfile:i,raw:t,mappedValues:o}}function Cm(e,t){let n=bn(e.tokenProfile)?e.tokenProfile:null;return n&&Array.isArray(n.tokens)&&typeof n.normalizedKey=="string"?{profileVersion:1,normalizedKey:W(n.normalizedKey),tokens:n.tokens.filter(r=>bn(r)&&typeof r.type=="string"&&typeof r.value=="string").map(r=>({type:r.type,value:W(r.value)})).filter(r=>r.value.length>0)}:jt(t)}function Va(e,t){return bn(e)&&Array.isArray(e[t])?e[t].filter(n=>bn(n)):[]}function Rm(e){let t=dr.safeParse(e||{}),n=t.success?t.data:{};return{score:{...gn.score,...n.score||{}},thresholds:{...gn.thresholds,...n.thresholds||{}},caps:{...gn.caps,...n.caps||{}},candidateGeneration:{...gn.candidateGeneration,...n.candidateGeneration||{}},contextFields:n.contextFields||gn.contextFields}}function Im(e,t,n){let r=Object.fromEntries(["exactMatches","highConfidenceMatches","possibleRenames","ambiguousMatches","missingInSchedule","missingInExcel"].map(o=>[o,0]));for(let o of n)r[o.bucket]=(r[o.bucket]||0)+1;return{excelRows:e.length,scheduleRows:t.length,...r,reviewRowCount:n.length}}function Tm(e){return{columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}],rows:e.map(n=>({bucket:n.bucket,score:n.score,reason:n.reason,excelRowId:n.excelRow?.excelRowId??n.excelRow?.recordId??"",scheduleRowId:n.scheduleRow?.scheduleRowId??n.scheduleRow?.recordId??"",excelText:n.excelRow?[n.excelRow.identityText,n.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:n.scheduleRow?[n.scheduleRow.identityText,n.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:(n.hardConflicts||[]).join(", "),recommendedNextAction:n.recommendedNextAction}))}}function X(e,t){return Jt(e.tokenProfile.tokens.filter(n=>n.type===t).map(n=>n.value))}function Da(e){let t=X(e,"unit");for(let r of X(e,"dimension")){let o=r.match(/^[A-Z]+|[A-Z]+$/)?.[0];o&&t.push(o)}let n=Lt(e.mappedValues.unit);return n&&t.push(n),Jt(t)}function Fa(e,t,n){if(e.length===0||t.length===0)return 0;let r=Ve(e,t).length,o=Math.max(e.length,t.length);return ur(r/o*n)}function _m(e,t,n){let r=n.contextFields.map(i=>[Lt(e.mappedValues[i]),Lt(t.mappedValues[i])]).filter(([i,a])=>i.length>0&&a.length>0);if(r.length===0)return 0;let o=r.filter(([i,a])=>i===a).length;return ur(o/r.length*n.score.context)}function Mm(e,t){return e.length===0&&t.length===0?1:e.length===0||t.length===0?0:2*Ve(e,t).length/(e.length+t.length)}function Nm(e,t){let n=Math.min(e.length,t.length);return n===0?0:Em(e,t)/n}function Em(e,t){let n=Array.from({length:e.length+1},()=>Array(t.length+1).fill(0));for(let r=1;r<=e.length;r++)for(let o=1;o<=t.length;o++)n[r][o]=e[r-1]===t[o-1]?n[r-1][o-1]+1:Math.max(n[r-1][o],n[r][o-1]);return n[e.length][t.length]}function km(e,t){let n=X(e,"word"),r=X(t,"word");return n.length>0&&r.length>0&&!Om(n,r)}function La(e){let t=new Map;for(let n of e)n.normalizedKey.length>0&&t.set(n.normalizedKey,(t.get(n.normalizedKey)||0)+1);return new Set([...t.entries()].filter(([,n])=>n>1).map(([n])=>n))}function Am(e,t){return t.score!==e.score?t.score-e.score:e.schedule.id.localeCompare(t.schedule.id)}function Pm(e,t){let n={exactMatches:0,highConfidenceMatches:1,possibleRenames:2,ambiguousMatches:3,missingInSchedule:4,missingInExcel:5},r=n[e.bucket]??99,o=n[t.bucket]??99;if(r!==o)return r-o;if((t.score||0)!==(e.score||0))return(t.score||0)-(e.score||0);let i=e.excelRow?.recordId||e.scheduleRow?.recordId||"",a=t.excelRow?.recordId||t.scheduleRow?.recordId||"";return String(i).localeCompare(String(a))}function Ve(e,t){let n=new Set(t);return Jt(e.filter(r=>n.has(r)))}function Jt(e){return[...new Set(e.filter(t=>W(t).length>0))]}function Om(e,t){let n=new Set(e),r=new Set(t);return n.size!==r.size?!1:[...n].every(o=>r.has(o))}function ur(e){return Math.round(e)}function po(e){return Math.max(0,Math.min(100,Math.round(e)))}function bn(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var qa="reconcile_schedule_excel",Vm=50,xt=ho.object({excel:io.describe('Excel/CSV source. Use kind:"file" for .xlsx/.csv/.tsv or kind:"rows" for deterministic CI/dry-run records.'),schedule:lo.describe('Schedule source. Use kind:"inspect_schedules_result" with a normalized inspect_schedules result, or kind:"revit_schedule" to read bounded live Revit schedule rows through inspect_schedules before reconciliation.'),config:dr.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),responseMode:tt,maxReviewRows:ho.number().int().positive().max(1e3).optional().describe("Compact-mode cap for returned reviewTable/evidenceRows rows. Defaults 50; full/debug returns all reviewRows."),maxCandidateRows:ho.number().int().positive().max(10).optional().describe("Compatibility input for older callers. Compact mode omits nested candidateRows; full/debug returns all candidates.")}).strict();function fo(e,t,n,r={}){let{warnings:o=[],notices:i=[],scanPolicy:a={},summary:s={},suggestedNextScopes:l=[],...u}=r;return xe({action:qa,reason:t,message:n,extra:{stage:e,reconciliationContractVersion:1,...u},summary:s,evidenceRows:[],scanPolicy:a,suggestedNextScopes:l,warnings:o,notices:i})}function go(e,t,n={}){let{warnings:r=[],notices:o=[],scanPolicy:i={},summary:a={},suggestedNextScopes:s=[],...l}=n;return ge({action:qa,error:t,extra:{stage:e,reconciliationContractVersion:1,...l},summary:a,evidenceRows:[],scanPolicy:i,suggestedNextScopes:s,warnings:r,notices:o})}function Ba(e){return e.guarded===!0||e.state==="guarded"}function za(e){return e.success===!1||e.state==="failed"||!!e.error}function vt(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Dm(...e){for(let t of e){let n=String(t.scanStoppedReason||"").trim();if(n&&n!=="completed")return n}return null}var Fm={requiredRoles:["identity","comparisonText"],optionalRoles:["code","description","quantity","unit","system","discipline","notes"]},Lm={rowsSource:{excel:{kind:"rows",sheetName:"Items",rows:[{Identity:"FCU-101",Description:"Fan coil supply DN100",Unit:"PCS"}],columnMapping:{identity:"Identity",comparisonText:"Description",unit:"Unit"}},schedule:{kind:"inspect_schedules_result",result:{success:!0,schedules:[{id:7001,name:"Mechanical Equipment Schedule",sections:[{section:"header",rows:[{row:0,cells:[{column:0,text:"Identity"},{column:1,text:"Description"}]}]},{section:"body",rows:[{row:1,cells:[{column:0,text:"FCU-101"},{column:1,text:"Fan coil supply DN100"}]}]}]}]}},responseMode:"compact"},fileSource:{excel:{kind:"file",path:"C:\\path\\items.xlsx",format:"xlsx",selection:{sheetName:"Items",headerRow:1,dataStartRow:2},columnMapping:{identity:"Identity",comparisonText:"Description"}},schedule:{kind:"inspect_schedules_result",result:'inspect_schedules result with responseMode="full" when schedule body cells are needed'}}};function jm(e){return[e.bucket,e.reason,e.score,e.excelRow?.excelRowId??e.excelRow?.recordId??"",e.scheduleRow?.scheduleRowId??e.scheduleRow?.recordId??""].join("|")}function Bm(e,t){let n=Array.isArray(t.columns)?t.columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}];return{...t,columns:n,rows:e.map(r=>({bucket:r.bucket,score:r.score,reason:r.reason,excelRowId:r.excelRow?.excelRowId??r.excelRow?.recordId??"",scheduleRowId:r.scheduleRow?.scheduleRowId??r.scheduleRow?.recordId??"",excelText:r.excelRow?[r.excelRow.identityText,r.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:r.scheduleRow?[r.scheduleRow.identityText,r.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:Array.isArray(r.hardConflicts)?r.hardConflicts.join(", "):"",recommendedNextAction:r.recommendedNextAction}))}}function zm(e,t){let n=t.responseMode||"compact";if(nt(n))return{...e,responseMode:n};let r=Pe(t.maxReviewRows,Vm,1e3),o=Se(e.reviewRows,{limit:r,key:jm}),i=Se(e.evidenceRows,{limit:r}),{reviewRows:a,reviewTable:s,scoringConfig:l,sourceSummary:u,...m}=e;return{...m,responseMode:"compact",reviewTable:Bm(o.rows,e.reviewTable||{}),evidenceRows:i.rows,summary:{...e.summary||{},compactResponse:!0,reviewRowCount:o.totalCount,returnedReviewRowCount:o.returnedCount,omittedReviewRowCount:o.omittedCount,duplicateReviewRowCount:o.duplicateCount,evidenceRowCount:i.totalCount,returnedEvidenceRowCount:i.returnedCount,omittedEvidenceRowCount:i.omittedCount},notices:[...vt(e.notices),'Compact response returns summary, reviewTable, evidenceRows, and count metadata only. Use responseMode="full" for reviewRows, token profiles, raw cells, and nested candidates.']}}async function qm(e,t={}){let n=xt.safeParse(e);if(!n.success)return fo("input_validation","reconciliation_input_required","Provide excel and schedule sources before reconciliation.",{validationIssues:n.error.issues.map(l=>`${l.path.join(".")||"<root>"}: ${l.message}`),requiredColumnMapping:Fm,schemaExamples:Lm,suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText","schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let r=await xa(n.data.excel);if(Ba(r))return fo("excel_ingestion",r.reason||"excel_ingestion_guarded",r.message||"Excel ingestion was guarded before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});if(za(r))return go("excel_ingestion",r.error||"Excel ingestion failed before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});let o=await Na(n.data.schedule,t.scheduleAdapter);if(Ba(o))return fo("schedule_record_adapter",o.reason||"schedule_adapter_guarded",o.message||"Schedule adaptation was guarded before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});if(za(o))return go("schedule_record_adapter",o.error||"Schedule adaptation failed before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});let i=ja({excelResult:r,scheduleResult:o,config:n.data.config}),a=r.partial===!0||o.partial===!0,s=a&&Dm(o,r)||i.scanStoppedReason;return zm({...i,partial:i.partial===!0||a,scanStoppedReason:s,scanPolicy:{...i.scanPolicy||{},excel:r.scanPolicy||{},schedule:o.scanPolicy||{}},warnings:[...vt(i.warnings),...vt(r.warnings),...vt(o.warnings)],notices:[...vt(i.notices),...vt(r.notices),...vt(o.notices)],sourceSummary:{excel:r.summary||{},schedule:o.summary||{}},sourceResults:{excel:{sourceKind:r.sourceKind,format:r.format,sheetName:r.sheetName,partial:r.partial,scanStoppedReason:r.scanStoppedReason,recordCount:Array.isArray(r.excelRecords)?r.excelRecords.length:0},schedule:{sourceKind:o.sourceKind,visibilityBasis:o.visibilityBasis,partial:o.partial,scanStoppedReason:o.scanStoppedReason,recordCount:Array.isArray(o.scheduleRecords)?o.scheduleRecords.length:0}}},n.data)}function Ja(e){e.tool("reconcile_schedule_excel",'[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus either normalized inspect_schedules output or bounded live revit_schedule input, normalizes rows, scores deterministic matches, and returns compact review tables by default. excel.kind="rows" expects an object with rows:[...] plus columnMapping.identity and columnMapping.comparisonText; file sources use path/format/selection with the same required mapping. schedule.kind="revit_schedule" requires scheduleIds or nameQuery unless allowExpensiveSearch=true. schedule.columnHeaders can be an index-ordered string array, an array of {column, header} objects, or a header/index map; explicit headers override native header labels for string columnMapping resolution. If Body has no readable rows, headerDataMode="auto" reads Header section rows as schedule data and reports that fallback; use headerDataMode="never" to disable or "always" to force it. Default responseMode=compact returns summary, reviewTable, evidenceRows, and count metadata only; use responseMode=full/debug for reviewRows, token profiles, raw cells, and nested candidateRows. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.',{excel:xt.shape.excel,schedule:xt.shape.schedule,config:xt.shape.config,responseMode:xt.shape.responseMode,maxReviewRows:xt.shape.maxReviewRows,maxCandidateRows:xt.shape.maxCandidateRows},async(t={})=>{try{return h(await qm(t))}catch(n){return h(go("runtime_failure",n instanceof Error?n.message:String(n)))}})}import{z as k}from"zod";var Jm={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxMatches:1e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxMatches:5e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxMatches:2e4}},pr=["sheetQuery","sheetIds","viewNameQuery","sources","profiles","countMode","groupBy","maxSheets","maxViewports","maxMatches","maxResponseBytes","allowExpensiveSearch"];function me(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Wa(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Jm[t],r=me(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=me(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxMatches:me(e.maxMatches,n.maxMatches,1,2e5)}}function Wm(e){let t=String(e??"").trim();return/^sheet_?text_?notes?$/i.test(t)||/^sheetTextNotes?$/i.test(t)?"sheet_text_notes":/^viewport_?tags?$/i.test(t)||/^viewportTags?$/i.test(t)?"viewport_tags":/^viewport_?text_?notes?$/i.test(t)||/^viewportTextNotes?$/i.test(t)||/^view_?text_?notes?$/i.test(t)||/^viewTextNotes?$/i.test(t)?"viewport_text_notes":/^placed_?schedule_?cells?$/i.test(t)||/^placedScheduleCells?$/i.test(t)||/^schedule_?cells?$/i.test(t)||/^scheduleCells?$/i.test(t)?"placed_schedule_cells":t}function Ct(e){let t=String(e??"").trim();return/^unique_?text$/i.test(t)?"uniqueText":/^unique_?tag$/i.test(t)?"uniqueTag":/^unique_?tagged_?element$/i.test(t)?"uniqueTaggedElement":"occurrence"}function Ga(e){return e==="uniqueTag"||e==="uniqueTaggedElement"}function mr(e,t,n,r){return e==="deep"?r:e==="balanced"?n:t}function yo(e){let t=Ct(e.countMode),n=Array.isArray(e.sources)?e.sources:[],r=[...new Set(n.map(Wm).filter(o=>o.length>0))];return r.length>0?r:Ga(t)?["viewport_tags"]:["sheet_text_notes","viewport_text_notes","placed_schedule_cells","viewport_tags"]}function Gm(e){return Array.isArray(e.sources)&&e.sources.length>0}function Ha(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||"").trim())}function bo(e){let t=Wa(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,sources:yo(e),countMode:Ct(e.countMode),groupBy:Array.isArray(e.groupBy)?e.groupBy:[],maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,maxSheets:me(e.maxSheets,30,1,200),maxViewportsPerSheet:me(e.maxViewportsPerSheet??e.maxViewports,20,0,200),maxTextNotesScanned:me(e.maxTextNotesScanned,mr(t.searchBudget,1e3,5e3,2e4),1,2e5),maxTagsScanned:me(e.maxTagsScanned??e.maxTags,mr(t.searchBudget,500,2500,1e4),1,1e5),maxScheduleInstancesPerSheet:me(e.maxScheduleInstancesPerSheet,20,0,200),maxRowsPerSchedule:me(e.maxRowsPerSchedule,250,1,2e3),maxColumnsPerSchedule:me(e.maxColumnsPerSchedule,20,1,200),maxScheduleInstancesScanned:me(e.maxScheduleInstancesScanned,mr(t.searchBudget,200,1e3,5e3),1,2e4),maxScheduleCellsScanned:me(e.maxScheduleCellsScanned,mr(t.searchBudget,1e3,5e3,2e4),1,2e5),maxMatches:t.maxMatches,maxTextChars:me(e.maxTextChars,240,1,1e3),maxRegexPatternLength:me(e.maxRegexPatternLength,240,1,1e3),regexTimeoutMs:me(e.regexTimeoutMs,25,1,250),maxResponseBytes:me(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),sheetScoped:Ha(e)}}function Hm(e,t){return{query:e.query,regex:e.regex,normalizedRegex:e.normalizedRegex,matchMode:e.matchMode,sheetQuery:e.sheetQuery,sheetIds:e.sheetIds,viewNameQuery:e.viewNameQuery,sources:yo(e),profiles:e.profiles,profileName:e.profileName,countMode:Ct(e.countMode),groupBy:e.groupBy,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSheets:e.maxSheets,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxTags:e.maxTags,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxMatches:t.maxMatches,maxTextChars:e.maxTextChars,maxRegexPatternLength:e.maxRegexPatternLength,regexTimeoutMs:e.regexTimeoutMs,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Count Revit annotations",taskId:e.taskId}}function hr(e){let t=String(c(e,"sourceType")||""),n=String(c(e,"kind")||""),r=[t,n];return r.some(o=>o==="viewportTag"||o==="viewport_tags")?"viewportTag":r.some(o=>o==="viewportTextNote"||o==="viewport_text_notes")?"viewportTextNote":r.some(o=>o==="sheetTextNote"||o==="sheet_text_notes")?"sheetTextNote":r.some(o=>o==="placedScheduleCell"||o==="placed_schedule_cells"||o==="scheduleCell")?"placedScheduleCell":t||n||"annotation"}function fr(e){let t=C(e,"evidenceRows");return(t.length>0?t:C(e,"matches")).map(r=>({...r,sourceType:hr(r)}))}function Um(e){let t=String(e??"").trim();return/^source_?type$/i.test(t)?"sourceType":/^(profile|profileName)$/i.test(t)?"profile":/^(pattern|patternName)$/i.test(t)?"pattern":/^(matchedCode|matchedText|uniqueText)$/i.test(t)?"matchedText":/^tagFamilyType$/i.test(t)?"tagFamilyType":/^(taggedElement|taggedElementId)$/i.test(t)?"taggedElement":/^view$/i.test(t)?"view":/^sheet$/i.test(t)?"sheet":t}function $m(e,t){let n={};if(t.length===0)return n.group="all",n;for(let r of t){let o=Um(r);o==="sheet"?(n.sheetId=c(e,"sheetId")??null,n.sheetNumber=c(e,"sheetNumber")??null):o==="view"?(n.viewId=c(e,"viewId")??null,n.viewName=c(e,"viewName")??null):o==="sourceType"?n.sourceType=hr(e):o==="profile"?n.profileName=c(e,"profileName")??null:o==="pattern"?n.patternName=c(e,"patternName")??null:o==="matchedText"?n.matchedTextNormalized=c(e,"matchedTextNormalized")??null:o==="tagFamilyType"?(n.tagFamilyName=c(e,"tagFamilyName")??null,n.tagTypeName=c(e,"tagTypeName")??null):o==="taggedElement"&&(n.taggedElementId=c(e,"taggedElementId")??null)}return Object.keys(n).length===0&&(n.group="all"),n}function Qm(e){return Object.keys(e).sort().map(t=>`${t}=${String(e[t]??"")}`).join("|")}function Xm(e,t){let n=hr(e);if(t==="occurrence")return"";if(t==="uniqueText")return`profile:${String(c(e,"profileName")??"").trim()}|text:${String(c(e,"matchedTextNormalized")??c(e,"textNormalized")??"").trim()}`;if(t==="uniqueTag"){if(n!=="viewportTag")return"";let r=String(c(e,"tagId")??"").trim();return r?`tag:${r}`:""}if(t==="uniqueTaggedElement"){if(n!=="viewportTag")return"";let r=c(e,"taggedElementResolved"),o=String(c(e,"taggedElementId")??"").trim();return!r||!o?"":`taggedElement:${o}`}return""}function Ua(e,t,n){let r=new Map,o=new Set,i=0,a=0,s=e.map(l=>{let u={...l,sourceType:hr(l)},m=$m(u,n),p=Qm(m),g=r.get(p);g||(g={groupKey:p,...m,count:0,occurrenceCount:0,evidenceRowCount:0},r.set(p,g)),g.occurrenceCount+=1,g.evidenceRowCount+=1;let y=t==="occurrence"?`occurrence:${a++}`:Xm(u,t),S=!!y&&!o.has(`${p}||${y}`);return S&&(o.add(`${p}||${y}`),g.count+=1,i+=1),{...u,groupKey:p,countKey:y,counted:S,countMode:t}});return{count:i,evidenceRows:s,groups:[...r.values()].sort((l,u)=>String(l.groupKey).localeCompare(String(u.groupKey)))}}function $a(e,t){let n=Ot(e,"scanPolicy"),r=c(n,"groupBy")??c(e,"groupBy")??t?.groupBy;return Array.isArray(r)?r.map(String):[]}function Qa(e,t){return Ct(c(e,"countMode")??c(Ot(e,"summary"),"countMode")??t?.countMode)}function Xa(e,t){let n=fr(e),r=Qa(e,t),o=Ua(n,r,$a(e,t));return{count:c(e,"count")??o.count,countMode:r,occurrenceCount:c(e,"matchedOccurrenceCount")??o.evidenceRows.length,matchCount:o.evidenceRows.length,evidenceRowCount:o.evidenceRows.length,groupCount:C(e,"groups").length||o.groups.length,scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed"}}function Ym(e){let t=fr(e),n=t.length>0?t[t.length-1]:null;return{lastReadSection:c(e,"lastReadSection")??null,lastReadRow:c(e,"lastReadRow")??null,lastReadColumn:c(e,"lastReadColumn")??null,lastReadSheetId:c(n,"sheetId")??c(e,"lastReadSheetId")??null,lastReadViewId:c(n,"viewId")??c(e,"lastReadViewId")??null,lastReadViewportId:c(n,"viewportId")??c(e,"lastReadViewportId")??null,lastReadItemId:c(n,"tagId")??c(n,"elementId")??c(n,"scheduleInstanceId")??c(n,"scheduleId")??c(n,"id")??c(e,"lastReadItemId")??null}}function Km(e,t){let n=Qa(e,t),r=Ua(fr(e),n,$a(e,t)),o=C(e,"groups");return e.countMode=n,e.evidenceRows=r.evidenceRows,e.matches=C(e,"matches").length>0?C(e,"matches"):e.evidenceRows,e.groups=o.length>0?o:r.groups,e.count=c(e,"count")??c(e.summary,"count")??r.count,e.summary={...Xa(e,t),...Ot(e,"summary")||{},count:c(e.summary,"count")??e.count,countMode:n,matchCount:c(e.summary,"matchCount")??e.evidenceRows.length,groupCount:c(e.summary,"groupCount")??e.groups.length},e}function Zm(e,t={},n){return Km(le(e,{action:"count_annotations",elapsedMs:n,scanPolicy:bo(t),summary:r=>Xa(r,t),evidenceRows:fr,lastRead:Ym,suggestedNextScopes:pr}),t)}function ep(e,t){return xe({action:"count_annotations",reason:"needs_scope",message:"Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:pr,scanPolicy:bo({...e,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs}),summary:{count:0,countMode:Ct(e.countMode),matchCount:0,groupCount:0}})}function tp(e){return xe({action:"count_annotations",reason:"invalid_count_mode_for_sources",message:"uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",suggestedNextScopes:pr,scanPolicy:bo(e),summary:{count:0,countMode:Ct(e.countMode),matchCount:0,groupCount:0}})}function Ya(e){e.tool("count_annotations","[ANNOTATION_COUNT_READ_ONLY] Read-only native Revit annotation inventory/count for DrawingSheet text notes, viewport text notes, placed schedule cells, and viewport tag evidence. Use sheetQuery/sheetIds first; project-wide annotation counts require allowExpensiveSearch=true. Supports occurrence, uniqueText, uniqueTag, and uniqueTaggedElement count modes with bounded regex profiles.",{...w(k),...x(k),query:k.string().optional().describe("Anonymous text query. Defaults to contains matching unless matchMode is supplied."),regex:k.string().optional().describe("Anonymous raw regex pattern. Regex matching is bounded by maxRegexPatternLength and regexTimeoutMs."),normalizedRegex:k.string().optional().describe("Anonymous regex pattern evaluated against normalized annotation text."),matchMode:k.enum(["exact","contains","startsWith","regex","normalizedRegex"]).optional().describe("Match mode for query when using the anonymous profile."),profileName:k.string().optional().describe("Optional anonymous profile name when query/regex is used without profiles."),profiles:k.array(k.any()).optional().describe("Explicit profile objects with profileName/name and patterns. Patterns support exact, contains, startsWith, regex, and normalizedRegex."),sheetQuery:k.string().optional().describe("Sheet number/name scope. Use this first in large projects."),sheetIds:k.array(k.union([k.number(),k.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),viewNameQuery:k.string().optional().describe("Optional placed-view name filter before viewport tag inspection."),sources:k.array(k.enum(["sheet_text_notes","viewport_text_notes","viewport_text_note","placed_schedule_cells","placed_schedule_cell","viewport_tags","sheetTextNotes","viewportTextNotes","viewportTextNote","view_text_notes","viewTextNotes","placedScheduleCells","placedScheduleCell","schedule_cells","schedule_cell","scheduleCells","scheduleCell","viewportTags"])).optional().describe("Annotation sources. Defaults to sheet_text_notes + viewport_text_notes + placed_schedule_cells + viewport_tags except tag-specific count modes, which default to viewport_tags."),countMode:k.enum(["occurrence","uniqueText","uniqueTag","uniqueTaggedElement"]).optional().describe("Count semantics. Tag-specific modes require viewport_tags as the only explicit source."),groupBy:k.array(k.enum(["sheet","view","sourceType","profile","profileName","pattern","patternName","matchedText","matchedCode","tagFamilyType","taggedElement","taggedElementId"])).optional().describe("Optional grouping dimensions for count rows."),allowExpensiveSearch:k.boolean().optional().describe("Explicit approval for project-wide sheet and placed-view annotation counting without sheetIds/sheetQuery. Defaults false."),searchBudget:k.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:k.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),maxSheets:k.number().int().positive().max(200).optional().describe("Maximum matching sheets to inspect. Defaults 30."),maxViewportsPerSheet:k.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:k.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet."),maxTextNotesScanned:k.number().int().positive().max(2e5).optional().describe("Global native cap across sheet text notes."),maxScheduleInstancesPerSheet:k.number().int().min(0).max(200).optional().describe("Maximum placed schedule instances inspected per sheet. Defaults 20."),maxRowsPerSchedule:k.number().int().positive().max(2e3).optional().describe("Maximum body rows scanned per placed schedule. Defaults 250."),maxColumnsPerSchedule:k.number().int().positive().max(200).optional().describe("Maximum body columns scanned per placed schedule. Defaults 20."),maxScheduleInstancesScanned:k.number().int().positive().max(2e4).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:k.number().int().positive().max(2e5).optional().describe("Global native cap across placed schedule body cells before scanStoppedReason=max_cells."),maxTags:k.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:k.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxMatches:k.number().int().positive().max(2e5).optional().describe("Maximum returned matching evidence rows before scanStoppedReason=max_items."),maxTextChars:k.number().int().min(1).max(1e3).optional().describe("Maximum characters retained and matched per annotation candidate. Defaults 240."),maxRegexPatternLength:k.number().int().min(1).max(1e3).optional().describe("Maximum regex pattern length. Defaults 240."),regexTimeoutMs:k.number().int().min(1).max(250).optional().describe("Per-candidate regex timeout in milliseconds. Defaults 25."),maxResponseBytes:k.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:k.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=Wa(t),o=yo(t),i=Ct(t.countMode);if(Ga(i)&&Gm(t)&&o.some(s=>s!=="viewport_tags"))return h(tp(t));if(!Ha(t)&&t.allowExpensiveSearch!==!0)return h(ep(t,r));let a=await _("count_annotations",Hm(t,r),{...T({...t,timeoutMs:r.timeoutMs},"Count Revit annotations"),toolName:"count_annotations"});return h(Zm(a&&a.result?a.result:a,t,Date.now()-n))}catch(r){return h(ge({action:"count_annotations",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:pr}))}})}import{z as _e}from"zod";function np(e){let t=Jn(e.elementIds||[]),n=N(e.category||""),r=Number.isFinite(e.sampleLimit)?Math.max(1,Math.min(25,e.sampleLimit)):5,o=e.includeTypeParameters===!0?"true":"false",i=Ae(e.parameterNameFilter||[]),a=e.parameterNameMatchMode==="exact"?"exact":"contains";return`
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
}`}function rp(e){return!e||typeof e!="object"?{}:{source:e.source,displayBuiltInParameter:e.displayBuiltInParameter,builtInParameterId:e.builtInParameterId,rawBuiltInParameterAlias:e.rawBuiltInParameterAlias,storageType:e.storageType,isShared:e.isShared,isReadOnly:e.isReadOnly,dataType:e.dataType,unitType:e.unitType,noValueState:e.noValueState,clearability:e.clearability}}function op(e,t){if(t.parameterNameMatchMode!=="exact"||!e||typeof e!="object"||!Array.isArray(e.elements))return e;let n=[],r=Array.isArray(e.warnings)?[...e.warnings]:[];for(let o of e.elements){let i=Array.isArray(o?.parameters)?o.parameters:[],a=new Map;for(let s of i){let l=typeof s?.name=="string"?s.name.trim():"";if(!l)continue;let u=l.toLocaleLowerCase("en-US");a.has(u)||a.set(u,{name:l,matches:[]}),a.get(u)?.matches.push(s)}for(let s of a.values()){if(s.matches.length<2)continue;let l={elementId:o?.id,parameterName:s.name,count:s.matches.length,severity:"write_preflight_warning",message:`Duplicate display name '${s.name}' matched ${s.matches.length} parameters on element ${o?.id}. Display name alone is ambiguous for write-back; choose by source, builtInParameterId, shared flag, storage type, or read-only state.`,matches:s.matches.map(rp)};n.push(l),r.push(`duplicate_display_name: elementId=${o?.id}; parameterName=${s.name}; count=${s.matches.length}; display name alone is ambiguous for write-back.`)}}return n.length===0?e:{...e,warnings:r,duplicateDisplayNameWarnings:n}}function Ka(e){e.tool("inspect_parameter_schema","Read-only parameter schema inspection for selected ids or a category sample: user-facing BIP display label/id, raw enum alias, storage type, unit type, shared/read-only flags, raw/display values, no-value state, and clearability metadata.",{...w(_e),...x(_e),elementIds:_e.array(_e.union([_e.number(),_e.string()])).optional().describe("Element ids to inspect."),category:_e.string().optional().describe("BuiltInCategory name such as OST_DuctCurves or OST_DuctTerminal."),sampleLimit:_e.number().int().positive().max(25).optional().describe("Maximum sample elements. Defaults 5."),includeTypeParameters:_e.boolean().optional().describe("Include type parameters. Defaults false."),parameterNameFilter:_e.array(_e.string()).optional().describe("Optional parameter name filters."),parameterNameMatchMode:_e.enum(["contains","exact"]).optional().describe("Filter matching mode. contains is discovery mode and default; exact is write-preflight mode.")},async t=>{if((!t.elementIds||t.elementIds.length===0)&&!t.category)return h({success:!0,matchMode:t.parameterNameMatchMode==="exact"?"exact":"contains",sampleCount:0,elements:[],warnings:["Provide elementIds or category."]});try{let n=await K(np(t),{...T(t,"Inspect Revit parameter schema"),transactionMode:"none"}),r=n&&n.result?n.result:n;return h(op(r,t))}catch(n){return h({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Q}from"zod";function es(e){return e==="clear"?"clear":e==="clearVisibleValue"?"clearVisibleValue":"set"}function Za(e){return typeof e=="boolean"?e?"true":"false":String(e??"")}async function ip(e,t){if(e.elementId!==void 0&&e.elementId!==null&&String(e.elementId).trim()!==""){let n=Number.parseInt(String(e.elementId),10);return Number.isFinite(n)&&n>0?n:null}if(e.useSelection===!0){let n=await Nt(2,t);return n.length===1?n[0]:{...Fe({action:"set_element_parameter",reason:"single_selection_required",error:n.length===0?"No selected Revit element was found. Provide elementId or select exactly one element.":"Multiple selected elements were found. Provide one explicit elementId for a production parameter write."}),tool:"set_element_parameter",guardReason:"single_selection_required",selectedElementIds:n}}return null}function ap(e,t){let n=es(e.operation),r=N(e.parameterName||""),o=N(e.parameterSource||"instance"),i=N(n==="clearVisibleValue"?"":Za(e.value)),a=N(e.valueMode||"raw"),s=N(e.mode==="commit"?"commit":"dryRun"),l=N(n),u=e.value===void 0||e.value===null?"false":"true",m=Number.isInteger(e.builtInParameterId)?String(e.builtInParameterId):"null",p=N(e.expectedStorageType||""),g=N(e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"":Za(e.expectedCurrentRaw)),y=e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"false":"true",S=e.allowTypeParameterWrite===!0?"true":"false";return`
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
string expectedCurrentRaw = ${g};
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
}`}function ts(e){e.tool("set_element_parameter","[PRODUCTION_PARAMETER_WRITE] Safely set, true-clear, or visibly clear one Revit element parameter after exact inspect_parameter_schema-style identity resolution. Never writes by visible display name alone: duplicate display names, read-only parameters, identity mismatch, unsupported clear/no-value attempts, and unapproved type-parameter writes are guarded. operation=clear uses Revit Parameter.ClearValue only for parameter kinds that can restore a true no-value state and never fakes no-value restore by writing an empty string. operation=clearVisibleValue is an explicit string-only visible cleanup path that writes an empty string and reports that Revit may keep HasValue=true. Defaults to dryRun; use mode=commit only for an explicitly confirmed write, then the tool reads the parameter back for verification.",{...w(Q),...x(Q),elementId:Q.union([Q.number(),Q.string()]).optional().describe("Target Revit ElementId. Preferred for production writes."),useSelection:Q.boolean().optional().describe("When true, use the current Revit selection only if exactly one element is selected. Defaults false."),parameterName:Q.string().describe("Exact visible parameter name used only for schema preflight. The tool enumerates matching parameters and blocks duplicates; it does not use LookupParameter as a direct write shortcut."),parameterSource:Q.enum(["instance","type"]).optional().default("instance").describe("Write an instance parameter by default. Type parameters require allowTypeParameterWrite=true in commit mode."),builtInParameterId:Q.number().int().optional().describe("Optional stable BuiltInParameter integer from inspect_parameter_schema. If supplied, it must match the exact display-name result."),expectedStorageType:Q.enum(["String","Integer","Double","ElementId"]).optional().describe("Optional storage-type guard from inspect_parameter_schema."),expectedCurrentRaw:Q.union([Q.string(),Q.number(),Q.boolean()]).optional().describe("Optional compare-and-set guard. Commit is blocked if the current raw value differs."),operation:Q.enum(["set","clear","clearVisibleValue"]).optional().default("set").describe("set writes the supplied value. clear uses Revit Parameter.ClearValue only when the parameter kind supports true no-value restore and never falls back to writing an empty string. clearVisibleValue explicitly writes an empty string to a String parameter and may leave HasValue=true."),value:Q.union([Q.string(),Q.number(),Q.boolean()]).optional().describe("Requested value for operation=set. String writes use the text as-is; Integer accepts number/true/false; Double defaults to raw Revit internal units; ElementId accepts an integer id."),valueMode:Q.enum(["raw","valueString"]).optional().default("raw").describe("For Double parameters, raw writes internal Revit units. valueString uses Parameter.SetValueString with project units."),mode:Q.enum(["dryRun","commit"]).optional().default("dryRun").describe("dryRun performs schema/convertibility checks only. commit writes inside the wrapper transaction and verifies readback."),allowTypeParameterWrite:Q.boolean().optional().default(!1).describe("Required to commit a type-parameter write because it can affect all instances of that type."),timeoutMs:Q.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults to the runtime default.")},async t=>{let n=se(t);try{let r=await ip(t,n);if(!r||typeof r=="object")return h(r||{...Fe({action:"set_element_parameter",reason:"element_id_required",error:"Provide elementId or set useSelection=true with exactly one selected element."}),guardReason:"element_id_required",tool:"set_element_parameter"});let o=t.mode==="commit"?"commit":"dryRun",i=es(t.operation);if(i==="set"&&(t.value===void 0||t.value===null))return h({...Fe({action:"set_element_parameter",reason:"value_required",error:"value is required when operation=set. Use operation=clear only when you intentionally want to restore a true no-value state, or operation=clearVisibleValue when a visible empty string is acceptable."}),guardReason:"value_required",tool:"set_element_parameter",mode:o,operation:i});let a=await K(ap(t,r),{...n,...ye(t,o==="commit"?i==="clear"?"Clear Revit element parameter":i==="clearVisibleValue"?"Visibly clear Revit element parameter":"Set Revit element parameter":i==="clear"?"Dry-run Revit element parameter clear":i==="clearVisibleValue"?"Dry-run visible Revit element parameter clear":"Dry-run Revit element parameter write"),transactionMode:o==="commit"?"auto":"none"});return h(a&&a.result?a.result:a)}catch(r){return h(Ie({action:"set_element_parameter",error:r instanceof Error?r.message:String(r),extra:{tool:"set_element_parameter"}}))}})}import{z as he}from"zod";function ns(e){return`new int[] { ${e.map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function sp(e){return`new bool[] { ${e.map(t=>t?"true":"false").join(", ")} }`}function lp(e){return(Array.isArray(e.cells)?e.cells:[]).slice(0,200).map(n=>({row:Math.max(0,Number.parseInt(String(n.row),10)||0),column:Math.max(0,Number.parseInt(String(n.column),10)||0),value:String(n.value??""),hasExpectedCurrentText:n.expectedCurrentText!==void 0&&n.expectedCurrentText!==null,expectedCurrentText:String(n.expectedCurrentText??"")}))}function cp(e){let t=Number.parseInt(String(e.scheduleId),10),n=lp(e),r=N(e.section),o=N(e.mode==="commit"?"commit":"dryRun"),i=e.allowCurrentMismatch===!0?"true":"false";return`
int scheduleId = ${Number.isFinite(t)?t:0};
string requestedSection = ${r};
string mode = ${o};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowCurrentMismatch = ${i};
int[] rows = ${ns(n.map(a=>a.row))};
int[] columns = ${ns(n.map(a=>a.column))};
string[] requestedValues = ${Ae(n.map(a=>a.value))};
bool[] hasExpectedCurrentTexts = ${sp(n.map(a=>a.hasExpectedCurrentText))};
string[] expectedCurrentTexts = ${Ae(n.map(a=>a.expectedCurrentText))};

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
}`}function rs(e){e.tool("set_schedule_cells","[PRODUCTION_SCHEDULE_CELL_WRITE] Writes exact Revit schedule cells by scheduleId, section, row, and column. Defaults to dryRun, blocks mismatched expectedCurrentText, guards non-writable standard schedule body cells as non_writable_standard_body_cell, and verifies committed values. Schedule cell text writes are not a raw-code reason: use this after inspect_schedules has found exact row/column coordinates for renumbering, title/spec/mark edits, key schedule/header/footer cells, or other direct cell text updates. Do not use this for visual schedule formatting such as borders, merges, colors, row heights, column widths, or placed schedule movement.",{...w(he),...x(he),scheduleId:he.union([he.number(),he.string()]).describe("Exact ViewSchedule element id. Schedule names are not accepted for writes."),section:he.enum(["header","body","footer"]).describe("Exact schedule section containing the target cells."),cells:he.array(he.object({row:he.number().int().min(0).describe("Zero-based row index in the selected schedule section."),column:he.number().int().min(0).describe("Zero-based column index in the selected schedule section."),value:he.string().describe("Target cell text."),expectedCurrentText:he.string().optional().describe("Optional exact preflight value. Commit is blocked if current text differs unless allowCurrentMismatch=true.")})).min(1).max(200).describe("Exact cells to update. Use inspect_schedules first to discover row/column coordinates."),mode:he.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes schedule cell text in one Revit transaction."),allowCurrentMismatch:he.boolean().optional().describe("Defaults false. Keep false for production writes so stale row/column targets are blocked."),timeoutMs:he.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=await K(cp(t),{...se(t),...ye(t,n==="commit"?"Set Revit schedule cells":"Preview Revit schedule cell changes"),toolName:"set_schedule_cells",transactionMode:n==="commit"?"auto":"none"});return h(r&&r.result?r.result:r)}catch(n){return h(Ie({action:"set_schedule_cells",reason:"set_schedule_cells_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as F}from"zod";var up=25;function os(e,t=100){return(Array.isArray(e)?e:[]).slice(0,t).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n))}function is(e){return`new int[] { ${e.join(", ")} }`}function dp(e){let t=[];if(typeof e.rowTextQuery=="string"&&e.rowTextQuery.trim()&&t.push(e.rowTextQuery.trim()),Array.isArray(e.rowTextQueries))for(let n of e.rowTextQueries){let r=String(n??"").trim();r&&t.push(r)}return[...new Set(t)].slice(0,20)}function mp(e,t){let n=Array.isArray(e)?[...new Set(e.map(r=>String(r??"").trim()).filter(r=>r.length>0))]:[];return{rows:n.slice(0,t),totalCount:Array.isArray(e)?e.length:0,uniqueCount:n.length,returnedCount:Math.min(n.length,t),omittedCount:Math.max(0,n.length-t)}}function pp(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||nt(n))return{...e,responseMode:n};let r=Pe(t.maxResultRows,up,500),o=Se(e.matches,{limit:r}),i=Se(e.changes,{limit:r}),a=mp(e.errors,r),s={...e,responseMode:"compact",compactResponse:!0,maxReturnedRows:r};return Array.isArray(e.matches)&&(s.matches=o.rows,s.returnedMatchCount=o.returnedCount,s.omittedMatchCount=o.omittedCount,s.duplicateMatchCount=o.duplicateCount),Array.isArray(e.changes)&&(s.changes=i.rows,s.returnedChangeCount=i.returnedCount,s.omittedChangeCount=i.omittedCount,s.duplicateChangeCount=i.duplicateCount),Array.isArray(e.errors)&&(s.errors=a.rows,s.returnedErrorCount=a.returnedCount,s.omittedErrorCount=a.omittedCount),s.notices=[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds matches/changes/errors. Use responseMode="full" for all row details.'],s}function hp(e){let t=os(e.scheduleIds,200),n=os(e.sheetIds,200),r=dp(e),o=Number.parseInt(String(e.targetColumn),10),i=Math.max(1,Math.min(Number.parseInt(String(e.maxSchedules??20),10)||20,200)),a=Math.max(1,Math.min(Number.parseInt(String(e.maxRowsPerSchedule??250),10)||250,2e3)),s=Math.max(1,Math.min(Number.parseInt(String(e.maxColumnsPerSchedule??80),10)||80,300)),l=Math.max(1,Math.min(Number.parseInt(String(e.maxMatches??50),10)||50,500)),u=e.mode==="commit"?"commit":"dryRun",m=e.section||"body",p=e.rowMatchMode==="any"?"any":"all",g=e.allowMultipleMatches===!0?"true":"false",y=e.allowCurrentMismatch===!0?"true":"false",S=e.expectedCurrentText!==void 0&&e.expectedCurrentText!==null?"true":"false",E=N(e.expectedCurrentText??"");return`
int[] exactScheduleIds = ${is(t)};
int[] exactSheetIds = ${is(n)};
string scheduleNameQuery = ${N(e.scheduleNameQuery||e.scheduleQuery||"")};
string sheetQuery = ${N(e.sheetQuery||"")};
string requestedSection = ${N(m)};
string[] rowTextQueries = ${Ae(r)};
string rowMatchMode = ${N(p)};
int targetColumn = ${Number.isFinite(o)?o:-1};
string requestedValue = ${N(e.value??"")};
string mode = ${N(u)};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowMultipleMatches = ${g};
bool allowCurrentMismatch = ${y};
bool hasExpectedCurrentText = ${S};
string expectedCurrentText = ${E};
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
}`}function as(e){e.tool("set_schedule_cells_by_text","[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT] Finds bounded schedule rows by sheet/schedule filters and row text, then previews or commits a target column update with readback verification. Guards non-writable standard schedule body cells as non_writable_standard_body_cell. Prefer this over generic send_code_to_revit for repeated schedule row text writes. Schedule cell text writes are not a raw-code reason: use this when the user identifies the target row by visible row text, item code, equipment tag, or schedule line label and the requested change is a direct cell text value. Keep allowMultipleMatches=false unless every matched row is intended; use dryRun first to resolve ambiguity.",{...w(F),...x(F),scheduleIds:F.array(F.union([F.number(),F.string()])).optional().describe("Exact ViewSchedule ids to inspect. Preferred when known."),scheduleNameQuery:F.string().optional().describe("Bounded schedule name filter. Use this before broad row text matching."),scheduleQuery:F.string().optional().describe("Alias for scheduleNameQuery."),sheetIds:F.array(F.union([F.number(),F.string()])).optional().describe("Exact ViewSheet ids whose placed schedules should be inspected."),sheetQuery:F.string().optional().describe("Sheet number/name filter whose placed schedules should be inspected."),section:F.enum(["header","body","footer"]).optional().describe("Schedule section to search and write. Defaults to body."),rowTextQuery:F.string().optional().describe("Text that must appear in the row. Combine with rowTextQueries for safer matching."),rowTextQueries:F.array(F.string()).optional().describe("All row text terms to match by default. Use rowMatchMode=any to match any term."),rowMatchMode:F.enum(["all","any"]).optional().describe("Defaults to all. all requires every rowTextQuery term to match the row text."),targetColumn:F.number().int().min(0).describe("Zero-based target column to write in each matched row."),value:F.string().describe("Target cell text."),expectedCurrentText:F.string().optional().describe("Optional compare-and-set guard for the target cell text."),allowCurrentMismatch:F.boolean().optional().describe("Defaults false. Keep false for production writes so stale target cells are blocked."),allowMultipleMatches:F.boolean().optional().describe("Defaults false. Required when more than one row match should be updated."),mode:F.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes all matched cells in one wrapper transaction."),maxSchedules:F.number().int().positive().max(200).optional().describe("Maximum candidate schedules to inspect. Defaults 20."),maxRowsPerSchedule:F.number().int().positive().max(2e3).optional().describe("Maximum rows scanned per schedule. Defaults 250."),maxColumnsPerSchedule:F.number().int().positive().max(300).optional().describe("Maximum columns read when matching row text. Defaults 80."),maxMatches:F.number().int().positive().max(500).optional().describe("Maximum matching rows returned or written. Defaults 50."),responseMode:tt,maxResultRows:F.number().int().positive().max(500).optional().describe("Compact-mode cap for matches/changes/errors returned to the client. Defaults 25; full/debug returns all rows within maxMatches."),timeoutMs:F.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=t.scheduleNameQuery||t.scheduleQuery,o=await K(hp({...t,scheduleNameQuery:r}),{...se(t),...ye(t,n==="commit"?"Set Revit schedule cells by text":"Preview Revit schedule row text changes"),toolName:"set_schedule_cells_by_text",transactionMode:n==="commit"?"auto":"none"});return h(pp(o&&o.result?o.result:o,t))}catch(n){return h(Ie({action:"set_schedule_cells_by_text",reason:"set_schedule_cells_by_text_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as ot}from"zod";var fp=`
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
}`;function gp(e){let t=Ge(e);return t&&typeof t=="object"&&t.result?t.result:t}async function yp(e,t){let n=null;try{n=await Ee(async o=>await o.sendCommand("mcp_status",{},{timeoutMs:t,statusPreflight:!1}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(t,500),logSocketErrors:!1,skipLock:!0})}catch(o){return{reachable:!1,target:{name:e.name,host:e.host,port:e.port,source:e.source},error:o instanceof Error?o.message:String(o)}}let r=Math.max(t,1e4);try{let o=await Ee(async(i,a)=>await i.sendCommand("send_code_to_revit",{code:fp,parameters:[`${a.host}:${a.port}`],transactionMode:"none",taskName:"Probe Revit instance"},{timeoutMs:r}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(r,500),logSocketErrors:!1});return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:an(n,{recentLimit:3,includeDiagnostics:!1}),info:gp(o)}}catch(o){return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:an(n,{recentLimit:3,includeDiagnostics:!1}),info:null,infoError:o instanceof Error?o.message:String(o)}}}function ss(e){e.tool("list_revit_instances","Discover reachable revAgent Revit bridge instances by probing configured ports. Use this before targeting a specific Revit instance.",{host:ot.string().optional().describe("Host to scan. Defaults to REVAGENT_HOST, then legacy REVIT_MCP_HOST, then localhost."),ports:ot.array(ot.union([ot.number(),ot.string()])).optional().describe("Ports to scan. Defaults to REVAGENT_PORTS, then legacy REVIT_MCP_PORTS, or 8080-8085."),includeRegistry:ot.boolean().optional().describe("Include targets from the revAgent instance registry file. Defaults true."),includeUnreachable:ot.boolean().optional().describe("Include unreachable ports in the result. Defaults false."),timeoutMs:ot.number().int().positive().max(15e3).optional().describe("Per-port connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.timeoutMs||3e3,r=Ao({host:t.host,ports:t.ports,includeRegistry:t.includeRegistry}),o=[];for(let i of r){let a=await yp(i,n);(a.reachable||t.includeUnreachable)&&o.push(a)}return h({success:!0,count:o.filter(i=>i.reachable).length,scanned:r.length,instances:o})})}import cs from"node:path";import{z as it}from"zod";var bp=new Date().toISOString(),Sp="revit-mcp-status.v3",wp="revit-mcp-runtime-tools.41";function xp(){let e=Ke(cs.join($t(),"package.json"));return{packageName:e?.name||"revagent-runtime",packageVersion:e?.version||"unknown"}}function ls(){let e=xp(),t=Qt([cs.join(process.cwd(),"..","updater","installed.json")]),n=t?.version||e.packageVersion;return{runtimeVersion:n,schemaVersion:Sp,toolSurfaceVersion:wp,processStartedAtUtc:bp,buildTimestampUtc:t?.installedAtUtc||null,buildHash:Xt(n),packageName:e.packageName,packageVersion:e.packageVersion,nodeVersion:process.version}}function us(e){e.tool("get_revit_mcp_status","Read the revAgent task status without waiting behind the active Revit command lock. Includes runtimeVersion, schemaVersion, toolSurfaceVersion, processStartedAtUtc, buildTimestampUtc, buildHash, bridge resultContractVersion when available, and summary runtimeActivity for revAgent-side/client-side guarded operations that may not reach Revit.",{...w(it),includeRecentTasks:it.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),recentLimit:it.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),includeRuntimeActivity:it.boolean().optional().describe("Include MCP-side/client-side active and recent activity. Defaults true so guard-only tasks that did not reach Revit remain auditable."),runtimeActivityLimit:it.number().int().min(0).max(100).optional().describe("Maximum runtimeActivity.recentActivity rows to return. Defaults 10."),runtimeActivityMode:it.enum(["summary","full"]).optional().describe("runtimeActivity shape. summary is the default and collapses started/completed pairs into latest completed/guarded/failed rows without responseKeys. full includes started rows and full result summaries."),includeDiagnostics:it.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),timeoutMs:it.number().int().positive().max(1e4).optional().describe("Connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.includeRuntimeActivity===!1?void 0:ii(t.runtimeActivityLimit??10,t.runtimeActivityMode||"summary");try{let r=t.timeoutMs||3e3,o=await Ee(async s=>await s.sendCommand("mcp_status",{},{timeoutMs:r}),{...se(t),skipLock:!0,connectTimeoutMs:r}),i=an(Ge(o),{includeRecentTasks:t.includeRecentTasks,recentLimit:t.recentLimit,includeDiagnostics:t.includeDiagnostics});Bn(o);let a=i&&typeof i=="object"&&!Array.isArray(i)?i:{status:i};return h({...a,...n?{runtimeActivity:n}:{},runtimeIdentity:ls()})}catch(r){return h({success:!1,error:r instanceof Error?r.message:String(r),...n?{runtimeActivity:n}:{},runtimeIdentity:ls()})}})}import{z as D}from"zod";import vp from"node:crypto";import ds from"node:path";import{Ajv2020 as Cp}from"ajv/dist/2020.js";import Rp from"ajv-formats";var So="https://schemas.revagent.app/spatial/v0.1/extraction-page.schema.json",Ip=["element-ref.schema.json","node-ref.schema.json","source-revision.schema.json","cursor-envelope.schema.json","spatial-snapshot.schema.json","extraction-page.schema.json"];function at(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function Wt(e){if(typeof e=="number"&&!Number.isFinite(e))throw new Error("Spatial canonical JSON rejects non-finite numbers.");return Array.isArray(e)?`[${e.map(Wt).join(",")}]`:at(e)?`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${Wt(e[t])}`).join(",")}}`:JSON.stringify(e)}function gr(e){if(e===null)return"null";if(typeof e=="number"){if(!Number.isFinite(e))throw new Error("Semantic spatial JSON cannot contain a non-finite number.");let t=Object.is(e,-0)?0:e,n=new ArrayBuffer(8),r=new DataView(n);return r.setFloat64(0,t,!1),JSON.stringify(`n:${r.getBigUint64(0,!1).toString(16).padStart(16,"0")}`)}return typeof e=="string"?JSON.stringify(`s:${e}`):typeof e!="object"?JSON.stringify(e):Array.isArray(e)?`[${e.map(gr).join(",")}]`:`{${Object.keys(e).sort().map(t=>`${JSON.stringify(t)}:${gr(e[t])}`).join(",")}}`}function Tp(e){return`sha256:${vp.createHash("sha256").update(gr(e),"utf8").digest("hex")}`}function _p(){let e=ds.join($t(),"schemas","spatial","v0.1"),t=Ip.map(o=>{let i=Ke(ds.join(e,o));if(!i)throw new Error(`Missing required spatial schema: ${o}`);return i}),n=new Cp({allErrors:!0,strict:!0,strictRequired:!1,allowUnionTypes:!0});Rp(n);for(let o of t)n.addSchema(o);let r=n.getSchema(So);if(!r)throw new Error(`Spatial extraction page schema was not compiled: ${So}`);return r}var ms=_p();function Mp(e){return(e||[]).slice(0,100).map(t=>{let n=t.instancePath||"/",r=t.keyword==="additionalProperties"&&t.params?.additionalProperty?` unexpected property ${String(t.params.additionalProperty)}`:"";return`${n} ${String(t.message||t.keyword)}${r}`.trim()})}function Np(e){let t=[],n=at(e.page)?e.page:{},r=Array.isArray(e.nodes)?e.nodes:[],o=Array.isArray(e.omissions)?e.omissions:[];if(e.snapshotId!==e.captureId&&t.push("/snapshotId must equal captureId for the Phase 0 native page"),n.recordCount!==void 0&&n.recordCount!==r.length&&t.push("/page/recordCount must equal nodes.length"),n.nodeCount!==void 0&&n.nodeCount!==r.length&&t.push("/page/nodeCount must equal nodes.length"),n.omissionCount!==o.length&&t.push("/page/omissionCount must equal omissions.length"),n.rowCount!==void 0&&n.rowCount!==r.length+o.length&&t.push("/page/rowCount must equal nodes.length + omissions.length"),n.pageHash!==n.pageSha256&&t.push("/page/pageHash must equal pageSha256"),n.priorPageHash!==n.priorPageSha256&&t.push("/page/priorPageHash must equal priorPageSha256"),n.nextCursor!==e.nextCursor&&t.push("/page/nextCursor must equal top-level nextCursor"),n.ordinal===0&&n.priorPageHash!==null&&t.push("/page/priorPageHash must be null on page 0"),n.ordinal>0&&typeof n.priorPageHash!="string"&&t.push("/page/priorPageHash is required after page 0"),e.pageCount<n.ordinal+1&&t.push("/pageCount cannot be smaller than page.ordinal + 1"),at(e.coverage)){e.coverage.pageNodeCount!==r.length&&t.push("/coverage/pageNodeCount must equal nodes.length"),e.coverage.pageOmissionCount!==o.length&&t.push("/coverage/pageOmissionCount must equal omissions.length");let a=Array.isArray(e.sourceRevisions)?e.sourceRevisions:[];e.coverage.sourceCount!==a.length&&t.push("/coverage/sourceCount must equal sourceRevisions.length"),at(e.effectiveSourcePolicy)&&e.coverage.effectiveScope!==e.effectiveSourcePolicy.hasEffectiveExtractionPolicy&&t.push("/coverage/effectiveScope must equal effectiveSourcePolicy.hasEffectiveExtractionPolicy")}if(at(e.effectiveSourcePolicy)){let a=Array.isArray(e.effectiveSourcePolicy.effectiveSources)?e.effectiveSourcePolicy.effectiveSources:[];e.effectiveSourcePolicy.effectiveSourceCount!==a.length&&t.push("/effectiveSourcePolicy/effectiveSourceCount must equal effectiveSources.length")}let i=Array.isArray(n.rows)?n.rows:null;if(i){let a=i.filter(m=>at(m)&&m.node!==void 0).map(m=>m.node),s=i.filter(m=>at(m)&&m.omission!==void 0).map(m=>m.omission);i.length!==r.length+o.length&&t.push("/page/rows length must equal nodes.length + omissions.length"),Wt(a)!==Wt(r)&&t.push("/page/rows node records must exactly reproduce top-level nodes"),Wt(s)!==Wt(o)&&t.push("/page/rows omission records must exactly reproduce top-level omissions");let l=Buffer.byteLength(gr(i),"utf8");n.payloadBytes!==l&&t.push("/page/payloadBytes must equal UTF-8 canonical IEEE-754 page.rows bytes");let u=Tp({captureId:e.captureId,pageOrdinal:n.ordinal,priorPageHash:n.priorPageHash,rows:i});n.pageHash!==u&&t.push("/page/pageHash must equal the canonical extraction-row envelope hash")}return t}function ps(e){let t=ms(e),n=Mp(ms.errors);return t&&at(e)&&n.push(...Np(e)),{valid:n.length===0,errors:n,schemaId:So}}var Ep="0.1",kp="host_internal_mm",xo="spatial-extraction-page.v0.1",Ap=new Set(["completed","max_elapsed","max_items","max_bytes","read_failed","needs_scope"]),gs=new Set(["complete","incomplete_omissions","incomplete_budget"]);function st(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function f(e,...t){if(!st(e))return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let r of t){let o=n.find(([i])=>i.toLowerCase()===r.toLowerCase());if(o)return o[1]}}function Z(e){if(typeof e=="number"&&Number.isInteger(e)&&Number.isFinite(e))return e;if(typeof e=="string"&&/^-?\d+$/.test(e.trim())){let t=Number.parseInt(e,10);return Number.isSafeInteger(t)?t:null}return null}function hs(e){if(typeof e=="number"&&Number.isFinite(e))return e;if(typeof e=="string"&&e.trim()){let t=Number(e);return Number.isFinite(t)?t:null}return null}function wo(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function Pp(e,t,n){let r=String(e??"").trim().toLowerCase();return Ap.has(r)?r:n?t?"max_items":"completed":"read_failed"}function fs(e,t){let n=String(f(e,"coverageStatus")??"").trim().toLowerCase();if(gs.has(n))return n;if(t==="max_elapsed"||t==="max_items")return"incomplete_budget";let r=f(e,"counts"),o=f(e,"coverage"),i=Z(f(r,"omittedSupportedNodes"))??0,a=Z(f(o,"sourceAvailabilityOmissionCount"))??0;return i+a>0?"incomplete_omissions":"complete"}function yr(e){return typeof e=="string"&&/^sha256:[a-f0-9]{64}$/i.test(e)}function Sn(e){return typeof e=="string"&&e.trim().length>0}function ys(e,t){let n=st(e)?e:{},r=f(n,"page"),o=st(r)?r:{},i=f(n,"nodes"),a=f(n,"omissions"),s=Array.isArray(i)?i:[],l=Array.isArray(a)?a:[],u=f(n,"success"),m=typeof u=="boolean"?u:!0,p=f(n,"guarded")===!0,g=String(f(n,"state")||(p?"guarded":m?"completed":"failed")),y=f(n,"nextCursor")??f(o,"nextCursor"),S=typeof y=="string"&&y.length>0?y:null,E=f(o,"hasMore"),A=typeof E=="boolean"?E:S!==null,L=Z(f(o,"ordinal","pageOrdinal")??f(n,"pageOrdinal")),j=Z(f(o,"targetBytes")),O=Z(f(o,"payloadBytes")),H=Z(f(n,"payloadBytes")),Y=Z(f(o,"recordCount")),ee=Z(f(o,"omissionCount")),te=Z(f(o,"nodeCount"))??Y??s.length,re=Z(f(o,"rowCount"))??te+(ee??l.length),$=f(o,"pageSha256","pageHash")??f(n,"pageHash"),oe=f(o,"priorPageSha256","priorPageHash")??f(n,"priorPageHash"),Ce=typeof oe=="string"&&oe.trim().length>0?oe:null,Me=f(n,"partial"),je=typeof Me=="boolean"?Me:A,Be=Pp(f(n,"scanStoppedReason"),A,m),Ne=m&&!p?fs(n,Be):null,Rt=hs(f(n,"elapsedMs"))??hs(t),Gt=wo(f(n,"suggestedNextScopes"));A&&!Gt.includes("cursor")&&Gt.push("cursor");let wn={...o,ordinal:L,targetBytes:j,payloadBytes:O,recordCount:Y??te,rowCount:re,nodeCount:te,omissionCount:ee??l.length,hasMore:A,pageSha256:$??null,priorPageSha256:Ce,nextCursor:S},ze={...n,success:m,guarded:p,state:g,action:"capture_spatial_snapshot",warnings:wo(f(n,"warnings")),notices:wo(f(n,"notices")),nodes:s,omissions:l,page:wn,pageOrdinal:L,rowCount:re,nodeCount:te,omissionCount:ee??l.length,payloadBytes:H,pagePayloadBytes:O,pageHash:$??null,priorPageHash:Ce,nextCursor:S,partial:je,coverageStatus:Ne,scanStoppedReason:Be,suggestedNextScopes:Gt,elapsedMs:Rt};if(ze.snapshot={snapshotId:f(n,"snapshotId")??f(n,"captureId"),capturedAt:f(n,"capturedAt"),sourceRevisions:f(n,"sourceRevisions"),scope:f(n,"scope"),scopeFingerprint:f(n,"scopeFingerprint"),revisionFingerprint:f(n,"revisionFingerprint"),coordinateFrame:f(n,"coordinateFrame"),lengthUnit:f(n,"lengthUnit"),schemaVersion:f(n,"schemaVersion"),extractorVersion:f(n,"extractorVersion"),counts:f(n,"counts"),partial:je,coverageStatus:Ne,scanStoppedReason:Be,suggestedNextScopes:ze.suggestedNextScopes,pageCount:Z(f(n,"pageCount")),payloadBytes:Z(f(n,"payloadBytes"))},!m||p)return{payload:ze,valid:!0,errors:[]};let Sr=ps(n),M=[...Sr.errors];f(n,"schemaVersion")!==Ep&&M.push("schemaVersion must be 0.1"),f(n,"coordinateFrame")!==kp&&M.push("coordinateFrame must be host_internal_mm"),f(n,"lengthUnit")!=="mm"&&M.push("lengthUnit must be mm"),Sn(f(n,"extractorVersion"))||M.push("extractorVersion is required"),Sn(f(n,"captureId"))||M.push("captureId is required"),Sn(f(n,"snapshotId")??f(n,"captureId"))||M.push("snapshotId is required"),Sn(f(n,"capturedAt"))||M.push("capturedAt is required"),st(f(n,"scope"))||M.push("scope must be an object"),yr(f(n,"scopeFingerprint"))||M.push("scopeFingerprint must use sha256:<64 hex>"),yr(f(n,"revisionFingerprint"))||M.push("revisionFingerprint must use sha256:<64 hex>"),Array.isArray(f(n,"sourceRevisions"))||M.push("sourceRevisions must be an array"),st(f(n,"counts"))||M.push("counts must be an object");let Co=Z(f(n,"pageCount"));(Co===null||Co<1)&&M.push("pageCount must be a positive integer");let Ro=Z(f(n,"payloadBytes"));(Ro===null||Ro<0)&&M.push("payloadBytes must be a non-negative integer"),f(n,"liveness")!=="unknown"&&M.push("Phase 0 liveness must be unknown"),f(n,"atomic")!==!1&&M.push("Phase 0 atomic must be false"),Sn(f(n,"revisionBasisCaveat"))||M.push("revisionBasisCaveat is required"),Array.isArray(i)||M.push("nodes must be an array"),st(r)||M.push("page must be an object"),(L===null||L<0)&&M.push("page.ordinal must be a non-negative integer"),(j===null||j<=0)&&M.push("page.targetBytes must be a positive integer"),(O===null||O<0)&&M.push("page.payloadBytes must be a non-negative integer"),(H===null||H<0)&&M.push("payloadBytes must be a non-negative logical capture total"),(te<0||te!==s.length)&&M.push("page.nodeCount/recordCount must equal nodes.length"),(ee===null||ee<0||ee!==l.length)&&M.push("page.omissionCount must equal omissions.length"),(re<0||re!==s.length+l.length)&&M.push("page.rowCount must equal nodes.length + omissions.length"),yr($)||M.push("page.pageSha256 must use sha256:<64 hex>"),(L??0)>0&&!yr(Ce)&&M.push("page.priorPageSha256 must use sha256:<64 hex> after page 0"),A&&S===null&&M.push("page.nextCursor is required when page.hasMore is true"),!A&&S!==null&&M.push("page.nextCursor must be null when page.hasMore is false"),A&&!je&&M.push("partial must be true while page.hasMore is true");let xn=f(n,"coverageStatus");return xn!==void 0&&!gs.has(String(xn).trim().toLowerCase())&&M.push("coverageStatus must be complete, incomplete_omissions, or incomplete_budget"),xn!==void 0&&String(xn).trim().toLowerCase()!==fs({...n,coverageStatus:void 0},Be)&&M.push("coverageStatus conflicts with total omission/budget evidence"),Be==="read_failed"&&Ne==="complete"&&M.push("read_failed requires omission coverage evidence"),je!==(A||Ne!=="complete")&&M.push("partial conflicts with pagination/coverage state"),(Ne==="incomplete_budget"?new Set(["max_elapsed","max_items"]):A?new Set(["max_bytes"]):Ne==="incomplete_omissions"?new Set(["read_failed"]):new Set(["completed"])).has(Be)||M.push("scanStoppedReason conflicts with pagination/coverage state"),ze.contractValidation={version:xo,schemaId:Sr.schemaId,valid:M.length===0,errors:M},ze.pageEvidence=Op(ze),{payload:ze,valid:M.length===0,errors:M}}function Op(e){let t=st(e)?e:{},n=st(f(t,"page"))?f(t,"page"):{},r=f(t,"captureId"),o=f(t,"nextCursor")??f(n,"nextCursor");return{captureId:typeof r=="string"?r:null,pageOrdinal:Z(f(n,"ordinal")??f(t,"pageOrdinal")),pageHash:f(n,"pageSha256")??f(t,"pageHash")??null,priorPageHash:f(n,"priorPageSha256")??f(t,"priorPageHash")??null,rowCount:Z(f(n,"rowCount")??f(t,"rowCount")),nodeCount:Z(f(n,"nodeCount","recordCount")??f(t,"nodeCount")),omissionCount:Z(f(n,"omissionCount")),pagePayloadBytes:Z(f(n,"payloadBytes")??f(t,"pagePayloadBytes")),payloadBytes:Z(f(t,"payloadBytes")),hasMore:f(n,"hasMore")===!0,nextCursorPresent:typeof o=="string"&&o.length>0}}var Vp=4*1024*1024,Ss=64*1024,ws=8*1024*1024,Dp=5e3,xs=25e3,Fp=4500,vs=25e3,Lp=12e3,Cs=6e4;function br(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function vo(e){return Array.isArray(e)?[...new Set(e.map(t=>String(t??"").trim()).filter(t=>t.length>0))].sort((t,n)=>t<n?-1:t>n?1:0):[]}function bs(e){return Array.isArray(e)?[...new Set(e.map(t=>/^\d+$/.test(String(t??"").trim())?Number.parseInt(String(t).trim(),10):Number.NaN).filter(t=>Number.isSafeInteger(t)&&t>0))].sort((t,n)=>t-n):[]}function jp(e){if(!Array.isArray(e))return[];let t=e.flatMap(n=>{if(!n||typeof n!="object"||Array.isArray(n))return[];let r=n,o=String(r.linkInstanceUniqueId??"").trim(),i=String(r.levelId??"").trim(),a=/^\d+$/.test(i)&&Number.parseInt(i,10)>0?Number.parseInt(i,10):null,s=String(r.levelUniqueId??"").trim(),l=String(r.levelName??"").trim();return!o||a===null&&!s&&!l?[]:[{linkInstanceUniqueId:o,levelId:a,levelUniqueId:s||null,levelName:l||null}]});return[...new Map(t.map(n=>[`${n.linkInstanceUniqueId}${n.levelId??""}${n.levelUniqueId??""}${(n.levelName??"").toUpperCase()}`,n])).values()].sort((n,r)=>{let o=`${n.linkInstanceUniqueId}${n.levelId??""}${n.levelUniqueId??""}${n.levelName??""}`,i=`${r.linkInstanceUniqueId}${r.levelId??""}${r.levelUniqueId??""}${r.levelName??""}`;return o<i?-1:o>i?1:0})}function Rs(e={}){let t=br(e.pageTargetBytes,Vp,Ss,ws),n=br(e.maxElements,Dp,1,xs),r=br(e.maxElapsedMs,Fp,250,vs),o=br(e.timeoutMs,Math.max(Lp,r+15e3),Math.max(1e3,r+1e3),Cs);return{pageTargetBytes:t,maxElements:n,maxElapsedMs:r,timeoutMs:o}}function Bp(e,t=Rs(e)){return{levelIds:bs(e.levelIds),levelNames:vo(e.levelNames),sourceScope:e.sourceScope||"hostAndLinked",linkInstanceIds:bs(e.linkInstanceIds),linkInstanceUniqueIds:vo(e.linkInstanceUniqueIds),linkedSourceLevels:jp(e.linkedSourceLevels),linkedSourceLevelNames:vo(e.linkedSourceLevelNames),includeHostMep:e.includeHostMep!==!1,includeRoomsSpaces:e.includeRoomsSpaces!==!1,includeLinkedObstructions:e.includeLinkedObstructions!==!1,belowLevelMm:e.belowLevelMm,aboveLevelMm:e.aboveLevelMm,cursor:typeof e.cursor=="string"?e.cursor:void 0,pageTargetBytes:t.pageTargetBytes,maxElements:t.maxElements,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,suppressTaskStatusWindow:!0,taskName:"Capture spatial snapshot page",taskId:void 0}}function zp(e){return e.levelIds.length>0||e.levelNames.length>0}function qp(e){return{success:!0,guarded:!0,state:"guarded",action:"capture_spatial_snapshot",reason:"needs_scope",message:"capture_spatial_snapshot requires an explicit level scope. Pass levelIds and/or levelNames; broad whole-model extraction is not available.",partial:!1,scanStoppedReason:"needs_scope",scanPolicy:e,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:["No Revit command was sent."],nextCursor:null}}function Is(e){e.tool("capture_spatial_snapshot","[SPATIAL_CAPTURE_READ_ONLY] Extract exactly one deterministic, bounded spatial snapshot page from one explicitly scoped Revit host level. The host scope is a host-Z vertical band, not exact linked-level membership; use placement-qualified linkedSourceLevels or linkedSourceLevelNames when linked Room/Space rows must come from exact source levels. Linked obstruction evidence intentionally remains physical host-band overlap even when that filter is present. This wrapper sends one native extract_spatial_snapshot command per MCP call, never decodes the opaque cursor, and never aggregates the whole graph. It also exposes snapshot as the exact published SpatialSnapshot v0.1 contract view for the capture metadata. Read page.hasMore for pagination and coverageStatus for extraction coverage. Phase 0 is a non-atomic extraction spike with liveness=unknown, not a durable/current snapshot store.",{...w(D),...x(D),levelIds:D.array(D.union([D.number().int().positive(),D.string()])).max(20).optional().describe("Explicit host Revit level ids. At least one levelIds or levelNames entry is required on every page call."),levelNames:D.array(D.string().min(1)).max(20).optional().describe("Explicit host Revit level names. At least one levelIds or levelNames entry is required on every page call."),sourceScope:D.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked for the Phase 0 host/architecture/structure audit."),linkInstanceIds:D.array(D.union([D.number().int().positive(),D.string()])).max(100).optional().describe("Optional exact RevitLinkInstance ids inside the explicit level scope."),linkInstanceUniqueIds:D.array(D.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance unique ids inside the explicit level scope."),linkedSourceLevels:D.array(D.object({linkInstanceUniqueId:D.string().min(1),levelId:D.union([D.number().int().positive(),D.string().regex(/^[1-9]\d*$/)]).optional(),levelUniqueId:D.string().min(1).optional(),levelName:D.string().min(1).optional()}).refine(t=>t.levelId!==void 0||t.levelUniqueId!==void 0||t.levelName!==void 0,"Each linked source level selector requires levelId, levelUniqueId, and/or levelName.")).max(100).optional().describe("Optional placement-qualified exact linked source Level selectors for linked Room/Space rows. Use inspect_levels to obtain linkInstanceUniqueId plus level id/unique id/name. Applied in addition to the required host-Z level band; linked obstructions remain physical band-overlap evidence."),linkedSourceLevelNames:D.array(D.string().min(1)).max(100).optional().describe("Optional exact source Level names for linked Room/Space rows, matched case-insensitively across selected links. Applied in addition to the required host-Z level band; use placement-qualified linkedSourceLevels for unambiguous audit identity."),includeHostMep:D.boolean().optional().describe("Include supported host-model MEP evidence. Defaults true."),includeRoomsSpaces:D.boolean().optional().describe("Include supported Room/Space evidence from the selected source scope. Defaults true."),includeLinkedObstructions:D.boolean().optional().describe("Include supported linked structural/architectural obstruction evidence. Defaults true."),belowLevelMm:D.number().min(0).max(1e4).optional().describe("Optional bounded extent below each selected level, in millimetres. Defaults 1000; native cap 10000."),aboveLevelMm:D.number().min(100).max(3e4).optional().describe("Optional bounded extent above each selected level, in millimetres. Defaults 6000; native cap 30000."),cursor:D.string().min(1).max(32768).optional().describe("Opaque nextCursor returned by the immediately preceding page. Passed through unchanged and never decoded by the runtime wrapper."),pageTargetBytes:D.number().int().min(Ss).max(ws).optional().describe("Native page target in bytes. Defaults 4 MiB; hard-capped at 8 MiB below the 32 MiB bridge ceiling."),maxElements:D.number().int().positive().max(xs).optional().describe("Maximum source elements considered by this native page call. Defaults 5000; hard-capped at 25000."),maxElapsedMs:D.number().int().min(250).max(vs).optional().describe("Maximum native extraction work for this page. Defaults 4500 ms; native range 250-25000 ms for explicitly scoped real-model audits."),timeoutMs:D.number().int().min(2e3).max(Cs).optional().describe("Socket timeout for this one page. Defaults to at least 12000 ms with 15000 ms headroom above maxElapsedMs; hard-capped at 60000 ms.")},async t=>{let n=Date.now(),r=Rs(t),o=Bp(t,r);if(!zp(o))return h(qp(r));try{let i=await _("extract_spatial_snapshot",o,{...T({target:t.target,host:t.host,port:t.port,timeoutMs:r.timeoutMs,taskName:"Capture spatial snapshot page"},"Capture spatial snapshot page"),toolName:"capture_spatial_snapshot",timeoutMs:r.timeoutMs}),a=i&&i.result?i.result:i,s=ys(a,Date.now()-n);return s.valid?(s.payload.scanPolicy=s.payload.scanPolicy||r,h(s.payload)):h({success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"invalid_spatial_page_contract",error:"The native extract_spatial_snapshot response did not satisfy the strict Phase 0 extraction-page contract.",contractValidation:s.payload.contractValidation||{version:xo,valid:!1,errors:s.errors},pageEvidence:s.payload.pageEvidence,partial:!1,scanStoppedReason:"read_failed",scanPolicy:r,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:Date.now()-n})}catch(i){return h({success:!1,guarded:!1,state:"failed",action:"capture_spatial_snapshot",reason:"read_failed",error:i instanceof Error?i.message:String(i),partial:!1,scanStoppedReason:"read_failed",scanPolicy:r,suggestedNextScopes:["levelIds","levelNames"],warnings:[],notices:[],nextCursor:null,elapsedMs:Date.now()-n})}})}async function Ts(e){let t=ci(e);ss(t),us(t),bi(t),Si(t),wi(t),xi(t),Ci(t),Ri(t),Ii(t),Ti(t),_i(t),Mi(t),Vi(t),Di(t),Fi(t),Li(t),ji(t),Ji(t),zi(t),Wi(t),Ui(t),$i(t),ra(t),aa(t),da(t),Ja(t),Ya(t),Ka(t),ts(t),rs(t),as(t),Is(t),console.error("Registered 32 revAgent tools")}var _s=new Jp({name:"revAgent",version:"1.0.0"});async function Gp(){await Ts(_s);let e=new Wp;await _s.connect(e),li(),console.error("revAgent runtime start success")}Gp().catch(e=>{console.error("Error starting revAgent runtime:",e),process.exit(1)});

import{McpServer as Zd}from"@modelcontextprotocol/sdk/server/mcp.js";import{StdioServerTransport as em}from"@modelcontextprotocol/sdk/server/stdio.js";import{z as Pe}from"zod";import*as Wr from"net";var tn=32*1024*1024,nn=class{host;port;socket;logErrors;isConnected=!1;responseCallbacks=new Map;buffer=Buffer.alloc(0);framingMode=process.env.REVIT_MCP_FRAMING==="legacy"?"legacy":"length-prefixed";constructor(t,n,r={}){this.host=t,this.port=n,this.logErrors=r.logErrors!==!1,this.socket=new Wr.Socket,this.setupSocketListeners()}setupSocketListeners(){this.socket.on("connect",()=>{this.isConnected=!0}),this.socket.on("data",t=>{this.buffer=Buffer.concat([this.buffer,t]),this.processBuffer()}),this.socket.on("close",()=>{this.isConnected=!1}),this.socket.on("error",t=>{this.logErrors&&console.error("RevitClientConnection error:",t),this.isConnected=!1})}processBuffer(){for(;this.buffer.length>0;){if(this.buffer.length>tn){this.rejectPending(new Error(`revAgent response exceeded ${tn} bytes`)),this.buffer=Buffer.alloc(0);return}if(this.isLikelyLegacyJson(this.buffer)){if(!this.processLegacyJsonBuffer())return;continue}if(!this.isLikelyLengthPrefixed(this.buffer)||!this.processLengthPrefixedBuffer())return}}isLikelyLegacyJson(t){let n=0;for(;n<t.length&&[32,9,10,13].includes(t[n]);)n++;return n<t.length&&t[n]===123}isLikelyLengthPrefixed(t){if(t.length<4)return!0;let n=t.readUInt32BE(0);return n>0&&n<=tn}processLegacyJsonBuffer(){try{let t=this.buffer.toString("utf8"),n=this.extractFirstJsonObject(t);if(!n)return!1;let r=JSON.parse(n.json);return this.handleResponseObject(r,n.json),this.buffer=Buffer.from(n.remaining,"utf8"),!0}catch{return!1}}extractFirstJsonObject(t){let n=0,r=!1,o=!1,i=!1,a=0;for(let s=0;s<t.length;s++){let l=t[s];if(!i){if(/\s/.test(l))continue;if(l!=="{")return null;i=!0,a=s,n=1;continue}if(o){o=!1;continue}if(l==="\\"){o=!0;continue}if(l==='"'){r=!r;continue}if(!r){if(l==="{")n++;else if(l==="}"&&(n--,n===0))return{json:t.slice(a,s+1),remaining:t.slice(s+1)}}}return null}processLengthPrefixedBuffer(){if(this.buffer.length<4)return!1;let t=this.buffer.readUInt32BE(0);if(t<=0||t>tn)return this.rejectPending(new Error(`Invalid revAgent response frame length: ${t}`)),this.buffer=Buffer.alloc(0),!1;if(this.buffer.length<4+t)return!1;let r=this.buffer.subarray(4,4+t).toString("utf8");try{let o=JSON.parse(r);this.handleResponseObject(o,r)}catch(o){this.rejectPending(new Error(`Failed to parse revAgent response: ${o instanceof Error?o.message:String(o)}`))}return this.buffer=this.buffer.subarray(4+t),!0}handleResponseObject(t,n){let o=t&&t.id!==void 0&&t.id!==null?String(t.id):"default",i=this.responseCallbacks.get(o);if(i){i(n),this.responseCallbacks.delete(o);return}if(t&&t.error&&this.responseCallbacks.size===1){let a=this.responseCallbacks.entries().next().value;if(a){let[s,l]=a;l(n),this.responseCallbacks.delete(s)}return}if(t&&t.error&&this.responseCallbacks.size>1)for(let[a,s]of this.responseCallbacks.entries())s(n),this.responseCallbacks.delete(a)}rejectPending(t){for(let[n,r]of this.responseCallbacks.entries())r(JSON.stringify({jsonrpc:"2.0",id:n,error:{code:-32e3,message:t instanceof Error?t.message:String(t)}})),this.responseCallbacks.delete(n)}connect(){if(this.isConnected)return!0;try{return this.socket.connect(this.port,this.host),!0}catch(t){return console.error("Failed to connect:",t),!1}}disconnect(){this.socket.end(),this.isConnected=!1}generateRequestId(){return Date.now().toString()+Math.random().toString().substring(2,8)}async sendCommand(t,n={},r={}){return t!=="mcp_status"&&r.statusPreflight!==!1&&await this.ensureReadyForCommand(t,r),await this.sendCommandRequest(t,n,r)}async ensureReadyForCommand(t,n={}){let r=n.statusTimeoutMs||Math.min(n.timeoutMs||3e3,3e3),o=await this.sendCommandRequest("mcp_status",{},{timeoutMs:r,statusPreflight:!1}),i=o&&typeof o=="object"?o.activeTask:null;if(!i)return;let a=i.taskName||i.method||"revAgent task",s=typeof i.elapsedMs=="number"?`, elapsed ${this.formatElapsed(i.elapsedMs)}`:"";throw new Error(`revAgent is busy with "${a}"${s}. Wait for it to finish before sending "${t}".`)}formatElapsed(t){let n=Math.max(0,Math.floor(t/1e3)),r=Math.floor(n/3600),o=Math.floor(n%3600/60),i=n%60;return[r,o,i].map(a=>String(a).padStart(2,"0")).join(":")}async sendCommandRequest(t,n={},r={}){let o=r.framing||this.framingMode;try{return await this.sendCommandRequestOnce(t,n,{...r,framing:o})}catch(i){if(o==="length-prefixed"&&r.allowLegacyFallback!==!1&&this.isFramingFallbackError(i))return this.framingMode="legacy",await this.sendCommandRequestOnce(t,n,{...r,framing:"legacy"});throw i}}isFramingFallbackError(t){let n=t instanceof Error?t.message:String(t);return/Invalid JSON|Invalid JSON-RPC request|Invalid (?:Revit MCP|revAgent) response frame length/i.test(n)}sendCommandRequestOnce(t,n={},r={}){return new Promise((o,i)=>{let a;try{this.isConnected||this.connect();let s=this.generateRequestId(),l={jsonrpc:"2.0",method:t,params:n,id:s};this.responseCallbacks.set(s,h=>{clearTimeout(a);try{let m=JSON.parse(h);m.error?i(new Error(m.error.message||"Unknown error from Revit")):o(m.result)}catch(m){m instanceof Error?i(new Error(`Failed to parse response: ${m.message}`)):i(new Error(`Failed to parse response: ${String(m)}`))}}),this.writeCommand(l,r.framing||this.framingMode);let u=r.timeoutMs||12e4;a=setTimeout(()=>{this.responseCallbacks.has(s)&&(this.responseCallbacks.delete(s),i(new Error(`Command timed out after ${this.formatElapsed(u)}: ${t}`)))},u),typeof a.unref=="function"&&a.unref()}catch(s){clearTimeout(a),i(s)}})}writeCommand(t,n){let r=Buffer.from(JSON.stringify(t),"utf8");if(n==="length-prefixed"){let o=Buffer.alloc(4);o.writeUInt32BE(r.length,0),this.socket.write(Buffer.concat([o,r]));return}this.socket.write(r)}};import*as ie from"fs";import*as Gn from"os";import*as Mt from"path";var _a=process.env.REVIT_MCP_HOST||process.env.REVIT_HOST||"localhost",Ur=De(process.env.REVIT_MCP_PORT||process.env.REVIT_PORT,8080),Gr=process.env.REVIT_MCP_INSTANCE_REGISTRY||Mt.join(Gn.tmpdir(),"revit-mcp-instances.json"),Hr=Mt.join(Gn.tmpdir(),"revit-mcp-command-locks"),$r=8e3,Ma=600*1e3,Na=250;function Ea(e){return new Promise(t=>setTimeout(t,e))}function De(e,t){if(e==null||e===""){if(t!==void 0)return t;throw new Error("Invalid revAgent port: empty value")}let n=Number.parseInt(String(e),10);if(!Number.isFinite(n)||n<1||n>65535)throw new Error(`Invalid revAgent port: ${e}`);return n}function Jr(e){return e?(Array.isArray(e)?e:String(e).split(",")).map(n=>String(n).trim()).filter(Boolean).map(n=>De(n)):[]}function Ue(e){return e?String(e).trim():_a}function ka(e){return String(e).replace(/[^a-zA-Z0-9_.-]/g,"_")}function Pa(e){return Mt.join(Hr,`${ka(e.host)}-${e.port}.lock`)}function Qr(e){return e&&typeof e=="object"&&"code"in e?String(e.code):null}function Aa(e){let t=new Set,n=[];for(let r of e){let o=Ue(r.host),i=De(r.port),a=`${o}:${i}`;t.has(a)||(t.add(a),n.push({...r,host:o,port:i}))}return n}function Xr(){try{if(!ie.existsSync(Gr))return[];let e=JSON.parse(ie.readFileSync(Gr,"utf8"));if(Array.isArray(e))return e;if(e&&Array.isArray(e.instances))return e.instances;if(e&&e.targets&&typeof e.targets=="object")return Object.entries(e.targets).map(([t,n])=>({...typeof n=="object"&&n?n:{},name:t}))}catch{}return[]}function Oa(e,t){let n=String(t).toLowerCase();return[e.name,e.id,e.target,e.pid,e.title,e.documentTitle,e.path,e.pathName].filter(o=>o!=null).some(o=>String(o).toLowerCase()===n)}function Va(e){let t=Xr().find(n=>Oa(n,e));return t?{name:t.name||t.id||String(e),host:Ue(t.host),port:De(t.port),source:"registry",metadata:t}:null}function Da(e,t){let n=String(e||"").trim();if(!n)return null;if(/^\d+$/.test(n))return{host:Ue(t),port:De(n),source:"target-port"};let r=n.match(/^(.+):(\d+)$/);return r?{host:Ue(r[1]),port:De(r[2]),source:"target-host-port"}:null}function Fa(e={}){let t=Ue(e.host),n=e.port!==void 0&&e.port!==null?De(e.port):null;if(n)return{host:t,port:n,source:"explicit"};let r=e.target||process.env.REVIT_MCP_TARGET;if(r){let o=Da(r,t);if(o)return o;let i=Va(r);if(i)return i;throw new Error(`Unknown revAgent target '${r}'. Use a port number, host:port, or a registered instance name.`)}return{host:t,port:Ur,source:"default"}}function Yr(e={}){let t=Ue(e.host),n=[];if(e.includeRegistry!==!1)for(let a of Xr())a.port&&n.push({name:a.name||a.id||a.title||a.documentTitle,host:Ue(a.host),port:De(a.port),source:"registry",metadata:a});let r=Jr(e.ports),o=Jr(process.env.REVIT_MCP_PORTS),i=o.length>0?o:[Ur,8081,8082,8083,8084,8085];for(let a of r.length>0?r:i)n.push({host:t,port:a,source:r.length>0?"explicit":"scan"});return Aa(n)}function La(e){try{let t=ie.statSync(e);Date.now()-t.mtimeMs>Ma&&ie.rmSync(e,{recursive:!0,force:!0})}catch(t){if(!t||Qr(t)==="ENOENT")return}}async function ja(e,t=$r){let n=Pa(e),r=Date.now();for(ie.mkdirSync(Hr,{recursive:!0});;)try{return ie.mkdirSync(n,{recursive:!1}),ie.writeFileSync(Mt.join(n,"owner.json"),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),target:e},null,2)),()=>{try{ie.rmSync(n,{recursive:!0,force:!0})}catch{}}}catch(o){if(!o||Qr(o)!=="EEXIST")throw o;if(La(n),Date.now()-r>=t)throw new Error(`revAgent target ${e.host}:${e.port} is busy; a previous Revit command is still running. Refusing to send another request.`);await Ea(Na)}}async function be(e,t={}){let n=Fa(t),r=t.skipLock===!0?()=>{}:await ja(n,t.lockWaitMs||$r),o=new nn(n.host,n.port,{logErrors:t.logSocketErrors!==!1});try{return o.isConnected||await new Promise((i,a)=>{let s,l=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),i()},u=()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),clearTimeout(s),a(new Error(`connect to revAgent target ${n.host}:${n.port} failed`))};o.socket.on("connect",l),o.socket.on("error",u),o.connect(),s=setTimeout(()=>{o.socket.removeListener("connect",l),o.socket.removeListener("error",u),a(new Error(`connect to revAgent target ${n.host}:${n.port} timed out`))},t.connectTimeoutMs||5e3),typeof s.unref=="function"&&s.unref()}),await e(o,n)}finally{o.disconnect(),r()}}import tr from"node:crypto";import nr from"node:os";import ut from"node:path";var Ba=[{name:"Parameter.Set",pattern:/\.Set\s*\(/i},{name:"Parameter.SetValueString",pattern:/\.SetValueString\s*\(/i},{name:"Parameter.ClearValue",pattern:/\.ClearValue\s*\(/i},{name:"Schedule.SetCellText",pattern:/\.\s*SetCellText\s*\(/i},{name:"Schedule table edit",pattern:/\.\s*(InsertRow|RemoveRow|InsertColumn|RemoveColumn|SetCellStyle|SetMergedCell)\s*\(/i},{name:"Document.Delete",pattern:/\.\s*Delete\s*\(/i},{name:"ElementTransformUtils",pattern:/ElementTransformUtils/i},{name:"Location.Move",pattern:/\.Move\s*\(/i},{name:"Element.ChangeTypeId",pattern:/\.ChangeTypeId\s*\(/i},{name:"Connector.ConnectTo",pattern:/\.ConnectTo\s*\(/i},{name:"Connector.DisconnectFrom",pattern:/\.DisconnectFrom\s*\(/i},{name:"FamilySymbol.Activate",pattern:/\.Activate\s*\(/i},{name:"NewFamilyInstance",pattern:/NewFamilyInstance/i},{name:"Create API",pattern:/\.(Create|New[A-Z]\w*)\s*\(/},{name:"View visibility/overrides",pattern:/\.(HideElements|UnhideElements|HideElementsTemporary|IsolateElementsTemporary|SetElementOverrides)\s*\(/i},{name:"Geometry join/cut",pattern:/(JoinGeometryUtils|SolidSolidCutUtils|InstanceVoidCutUtils|PartUtils)/i},{name:"Parameter binding edit",pattern:/\.(ParameterBindings|ParameterMap)\s*\.\s*(Insert|ReInsert|Remove)\s*\(/i},{name:"Revit property assignment",pattern:/\b(document|doc|element|view|view3d|targetView|activeView|familyInstance|instance|symbol|level|parameter|param|location)\s*\.\s*(Pinned|Name|Scale|ViewTemplateId|CropBox|CropBoxActive|CropBoxVisible|SketchPlane|Curve|Point)\s*=/i},{name:"Manual Transaction",pattern:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|(Transaction|SubTransaction|TransactionGroup)\s*\(/i}];function Nt(e){return Ba.filter(t=>t.pattern.test(e)).map(t=>t.name)}import Jn from"node:fs";import me from"node:path";import{fileURLToPath as za}from"node:url";function lt(e){return/^(1|true|yes|on)$/i.test(String(e||"").trim())}function ct(e){try{return!e||!Jn.existsSync(e)?null:JSON.parse(Jn.readFileSync(e,"utf8").replace(/^\uFEFF/,""))}catch{return null}}function Un(){let e=za(import.meta.url),t=me.dirname(e),n=[me.resolve(t,"..",".."),me.resolve(t,"..")];for(let r of n)if(Jn.existsSync(me.join(r,"package.json")))return r;return n[0]}function Kr(){let e=Un(),t=me.dirname(e);return t&&t!==e?t:e}function Et(){return process.env.ProgramData||process.env.PROGRAMDATA||"C:\\ProgramData"}function Zr(){let e=Kr(),t=[process.env.REVAGENT_UPDATER_CONFIG,me.join(e,"updater","updater-config.json"),me.join(Et(),"DPE","revAgent","updater","updater-config.json"),me.join(Et(),"DPE","RevitMCP","updater","updater-config.json")].filter(Boolean);for(let n of t){let r=ct(n);if(r)return r}return null}function kt(e=[]){let t=Kr(),n=[me.join(t,"updater","installed.json"),...e,me.join(Et(),"DPE","revAgent","updater","installed.json"),me.join(Et(),"DPE","RevitMCP","updater","installed.json")];for(let r of n){let o=ct(r);if(o)return o}return null}function Pt(e){let t=String(e||"").match(/-([0-9a-f]{7,40})$/i);return t?t[1]:null}function eo(){return me.join(Et(),"DPE","revAgent","state","telemetry")}function He(e){return(String(e||"").trim()||"unknown-machine").toUpperCase()}function rn(e,t="unknown"){let n=String(e||"").trim();return n&&n.replace(/[<>:"/\\|?*\x00-\x1F\s]+/g,"_").replace(/_+/g,"_").replace(/^[._-]+|[._-]+$/g,"")||t}import sn from"node:fs";import to from"node:path";var on=new Map,an=new Map,At=0,Hn=0;async function no(e,t){await sn.promises.mkdir(to.dirname(e),{recursive:!0}),await sn.promises.writeFile(e,`${JSON.stringify(t,null,2)}
`,"utf8")}async function $n(e,t){await sn.promises.mkdir(to.dirname(e),{recursive:!0}),await sn.promises.appendFile(e,`${JSON.stringify(t)}
`,"utf8")}function ro(e,t){let r=(on.get(e)||Promise.resolve()).catch(()=>{}).then(()=>$n(e,t));return on.set(e,r),r.finally(()=>{on.get(e)===r&&on.delete(e)}).catch(()=>{}),r}function Qn(e,t,n){if(n.disabled())return!1;if(At>=n.maxInFlight())return Hn++,!1;At++;let o=(an.get(e)||Promise.resolve()).catch(()=>{}).then(()=>t(e));return an.set(e,o),o.catch(()=>{Hn++}).finally(()=>{an.get(e)===o&&an.delete(e),At=Math.max(0,At-1)}),!0}function oo(e){return{inFlight:At,dropped:Hn,maxInFlight:e}}var qa=new Set(["completed","failed","guarded"]);function Ot(e,t,n){return e?.[n]!==void 0&&e?.[n]!==null?e[n]:t?.[n]??null}function ln(e,t){return e??t??null}function Vt(e){return String(e?.state||"").toLowerCase()}function Yn(e){return qa.has(String(e||"").toLowerCase())}function io(e){return e!=null&&e!==""}function ao(e){let t=Date.parse(String(e?.finishedAtUtc||e?.startedAtUtc||""));return Number.isFinite(t)?t:0}function Wa(e,t){let n=Yn(t?.state),r=Yn(e?.state);return n?t||null:r?e||null:t||e||null}function Ga(e,t){return Vt(t)==="failed"?t||null:Vt(e)==="failed"&&e||null}function Xn(e,t,n,r){let o=String(e||"").toLowerCase(),i=Vt(n)===o,a=Vt(t)===o;return i&&a?Ot(n,t,r):i?Ot(n,null,r):a?Ot(t,null,r):null}function Ja(e,t=""){if(!e||typeof e!="object")return t;if(io(e.requestId))return`request:${e.requestId}`;if(io(e.id))return`id:${e.id}`;let n=e.method||"",r=e.taskName||"",o=e.startedAtUtc||"";return n||r||o?`task:${n}|${r}|${o}`:t}function Ua(e,t){let n=Wa(e,t),r={...e||{},...t||{}};for(let o of["id","requestId","method","wrapperAction","logicalToolName","taskName","parentTaskName","parentTaskId","startedAtUtc","requestBytes","responseBytes","port"])r[o]=Ot(t,e,o);return r.state=ln(n?.state,Ot(t,e,"state")),Yn(r.state)?(r.finishedAtUtc=ln(Xn(r.state,e,t,"finishedAtUtc"),n?.finishedAtUtc),r.elapsedMs=ln(Xn(r.state,e,t,"elapsedMs"),n?.elapsedMs)):(r.finishedAtUtc=null,r.elapsedMs=null),Vt(r)==="failed"?r.error=ln(Xn(r.state,e,t,"error"),Ga(e,t)?.error):r.error=null,r}function Ha(e,t,n=100){let r=Math.max(1,Math.min(200,Number(n)||100)),o=new Map,i=(a,s)=>{for(let[l,u]of(Array.isArray(a)?a:[]).entries()){if(!u||typeof u!="object")continue;let h=Ja(u,`${s}:${l}`),m=o.get(h);o.set(h,m?Ua(m,u):u)}};return i(t,"cached"),i(e,"current"),[...o.values()].sort((a,s)=>ao(s)-ao(a)).slice(0,r)}function so(e,t){let n=e&&typeof e=="object"?e:null,r=t&&typeof t=="object"?t:null;if(!n&&!r)return null;let o=n?.recentHistoryCapacity??r?.recentHistoryCapacity??100,i=Ha(n?.recentTasks,r?.recentTasks,o),a=Math.max(Number(n?.recentHistoryCount)||0,Number(r?.recentHistoryCount)||0,i.length);return{...r||{},...n||{},activeTask:n?.activeTask||null,recentTasks:i,recentHistoryCount:a,recentHistoryCapacity:o}}var $a="revagent.telemetry.v1",Qa="revagent.live.status.v1",po="revagent.live.activity.v1",fn=tr.randomUUID(),ho=new Date().toISOString(),Xa=0,Dt=new Map,$e=[],fo=null,cn=null,lo=null;function rr(){return lt(process.env.REVAGENT_TELEMETRY_DISABLED)}function Ya(e){return tr.createHash("sha256").update(String(e||""),"utf8").digest("hex")}function dt(e){return Ya(e).slice(0,16)}function un(e,t=400){let n=String(e||"");return n.length<=t?{text:n,truncated:!1}:{text:`${n.slice(0,t)}...[truncated ${n.length-t} chars]`,truncated:!0}}function Ka(e){return String(e||"").split(/\r\n|\r|\n/).length}function Qe(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Za(){return Qe(process.env.REVAGENT_TELEMETRY_TEXT_CHARS,1e3,0,1e4)}function es(){return Qe(process.env.REVAGENT_TELEMETRY_CODE_CHARS,4e3,0,1e5)}function Xe(){return rr()||lt(process.env.REVAGENT_LIVE_STATUS_DISABLED)}function or(){return Qe(process.env.REVAGENT_LIVE_STATUS_RECENT,50,5,200)}function ir(){return Qe(process.env.REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT,32,1,64)}function go(){return Qe(process.env.REVAGENT_LIVE_STATUS_HEARTBEAT_MS,5e3,0,6e4)}function ts(e,t){let n=String(e||""),r={hash:dt(n),length:n.length,present:n.length>0};if(t>0){let o=un(n,t);r.text=o.text,r.textTruncated=o.truncated}return r}function ns(e){let t=String(e||""),n={hash:dt(t),length:t.length,lineCount:Ka(t),writePatternCount:Nt(t).length,writePatterns:Nt(t).slice(0,12),hasManualTransaction:/new\s+(Transaction|SubTransaction|TransactionGroup)\s*\(|\b(Transaction|SubTransaction|TransactionGroup)\s*\(/i.test(t)},r=es();if(r>0){let o=un(t,r);n.preview=o.text,n.previewTruncated=o.truncated}return n}function rs(e,t){let n=new Set(["transactionMode","responseMode","planMode","planCandidateMode","targetVisualStyle","intent","imageFormat","cameraOrientation","viewType","category","discipline","cropBasis","searchBudget","linkScope","reason","scanStoppedReason"]);if(typeof t=="boolean"||typeof t=="number")return t;if(typeof t=="string")return n.has(e)?t:ts(t,Za())}function dn(e={}){let t={keys:[]};if(!e||typeof e!="object")return t;let n=Object.keys(e).sort();t.keys=n.filter(r=>r!=="code"&&r!=="parameters");for(let r of n){let o=e[r];if(r==="code"){t.code=ns(o);continue}if(r==="parameters"){t.parameters={count:Array.isArray(o)?o.length:o==null?0:1};continue}if(/elementIds$/i.test(r)&&Array.isArray(o)){t[r]={count:o.length};continue}if(Array.isArray(o)){t[r]={count:o.length};continue}if(o&&typeof o=="object"){t[r]={keys:Object.keys(o).sort()};continue}let i=rs(r,o);i!==void 0&&(t[r]=i)}return t}function yo(e){if(e&&typeof e=="object"){if(Me(e,["success","Success"])===!1)return e;if("result"in e&&e.result!==null&&e.result!==void 0)return e.result;if("result"in e)return e}return e&&typeof e=="object"&&"result"in e?e.result:e}function Me(e,t){if(!e||typeof e!="object")return;for(let r of t)if(Object.prototype.hasOwnProperty.call(e,r))return e[r];let n=Object.entries(e);for(let[r,o]of n)if(t.some(i=>r.toLowerCase()===i.toLowerCase()))return o}function bo(e){let t=String(e||"").trim().toLowerCase();return t==="runtime"||t==="client"?t:null}function Ft(e,t=null){if(t)return{success:!1,errorMessage:un(t instanceof Error?t.message:String(t)).text,errorType:t instanceof Error?t.name:"Error"};let n=yo(e),r=n&&typeof n=="object"&&!Array.isArray(n),o=r?Me(n,["success","Success"]):void 0,i=r?Me(n,["state","State"]):void 0,a=r?Me(n,["action","Action"]):void 0,s=r?Me(n,["error","Error","errorMessage","ErrorMessage"]):void 0,l=r?Me(n,["message","Message"]):void 0,u=r?Me(n,["guardSource","GuardSource"]):void 0,h=typeof n=="string"?n:"",m=/^\s*ERROR\s*:/i.test(h)?h:"",g=String(i||"").toLowerCase()==="guarded"||Me(n,["guarded","blocked","focusBlocked"])===!0||/blocked by safety|guarded|rejected write-looking code|does not support writeCommit|only executes with transactionMode 'none'/i.test(String(s||l||h||""));return{success:typeof o=="boolean"?o:!s&&!m,guarded:g,guardSource:g?bo(u)||"runtime":null,state:i||null,action:a||null,responseKind:Array.isArray(n)?"array":n===null?"null":typeof n,responseKeys:r?Object.keys(n).sort().slice(0,40):[],errorMessage:s||m?un(s||m).text:null,messageHash:l?dt(l):null}}function co(e,t=null){if(t)return Ft(null,t);try{let n=e?.content?.find?.(r=>r?.type==="text")?.text;if(typeof n=="string"&&n.trim().startsWith("{"))return Ft(JSON.parse(n))}catch{}return{success:!0,guarded:!1,responseKind:e===null?"null":typeof e,responseKeys:e&&typeof e=="object"?Object.keys(e).sort().slice(0,40):[]}}function os(){return Qe(process.env.REVAGENT_TELEMETRY_CONTEXT_ELEMENTS,12,0,100)}function So(e){if(typeof e!="string")return e;let t=e.trim();if(!t.startsWith("{")&&!t.startsWith("[")&&!t.startsWith('"'))return e;try{let n=JSON.parse(t);return typeof n=="string"?So(n):n}catch{return e}}function is(e){try{let t=e?.content?.find?.(n=>n?.type==="text")?.text;if(typeof t=="string")return So(t)}catch{}return e}function Fe(e){return e&&typeof e=="object"&&!Array.isArray(e)?e:null}function A(e,t){return Me(e,t)}function O(e,t,n=5){if(n<0||e===null||e===void 0)return;if(Array.isArray(e)){for(let i of e.slice(0,50)){let a=O(i,t,n-1);if(a!=null&&a!=="")return a}return}let r=Fe(e);if(!r)return;let o=A(r,t);if(o!=null&&o!=="")return o;for(let i of Object.values(r)){let a=O(i,t,n-1);if(a!=null&&a!=="")return a}}function mn(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let i of e.slice(0,50))mn(i,t,n-1,r);return r}let o=Fe(e);if(!o)return r;for(let[i,a]of Object.entries(o))t.some(s=>i.toLowerCase()===s.toLowerCase())&&Array.isArray(a)&&r.push(a),mn(a,t,n-1,r);return r}function Zn(e,t,n=5,r=[]){if(n<0||e===null||e===void 0||r.length>=20)return r;if(Array.isArray(e)){for(let i of e.slice(0,50))Zn(i,t,n-1,r);return r}let o=Fe(e);if(!o)return r;for(let[i,a]of Object.entries(o))t.some(s=>i.toLowerCase()===s.toLowerCase())&&Fe(a)&&r.push(a),Zn(a,t,n-1,r);return r}function j(e){return e==null?null:typeof e=="string"?e:typeof e=="number"||typeof e=="boolean"?String(e):null}function Ne(e){return typeof e=="number"&&Number.isFinite(e)?e:typeof e=="string"&&/^-?\d+$/.test(e.trim())?Number.parseInt(e.trim(),10):null}function wo(e,t=25){return[...new Set((Array.isArray(e)?e:[]).map(n=>Ne(n)).filter(n=>Number.isFinite(n)))].slice(0,t)}function as(e={}){let t=[];e.elementId!==void 0&&t.push(e.elementId),e.viewId!==void 0&&t.push(e.viewId);for(let[n,r]of Object.entries(e||{}))/elementIds$/i.test(n)&&Array.isArray(r)&&t.push(...r);return wo(t,50)}function uo(e){let t=Fe(e);if(!t)return null;let n=Ne(A(t,["id","Id","elementId","ElementId"])),r=j(A(t,["name","Name"])),o=j(A(t,["category","Category","categoryName","CategoryName"])),i=j(A(t,["typeName","TypeName","familyName","FamilyName"])),a=j(A(t,["levelName","LevelName","level","Level"])),s=j(A(t,["roomName","RoomName","room","Room"])),l=j(A(t,["roomNumber","RoomNumber"])),u=j(A(t,["spaceName","SpaceName","space","Space"])),h=j(A(t,["spaceNumber","SpaceNumber"]));return!n&&!r&&!o&&!i&&!a&&!s&&!u?null:{id:n,name:r,category:o,typeName:i,levelName:a,roomName:s,roomNumber:l,spaceName:u,spaceNumber:h}}function ss(e){let t=new Set;return e.filter(n=>{if(!n)return!1;let r=n.id?`id:${n.id}`:JSON.stringify(n);return t.has(r)?!1:(t.add(r),!0)})}function ls(e,t){let n=mn(e,["elements","Elements","selectionElements","SelectionElements"]),r=Zn(e,["chosenElement","ChosenElement","targetElement","TargetElement"]),o=[];for(let i of r)o.push(uo(i));for(let i of n)for(let a of i.slice(0,t))o.push(uo(a));return ss(o).slice(0,t)}function cs(e){let t=O(e,["selectionIds","SelectionIds"],4);return Array.isArray(t)?wo(t,50):[]}function us(e){let t=mn(e,["files","Files"],4),n=[];for(let r of t)for(let o of r.slice(0,12)){let i=Fe(o);i&&n.push({path:j(A(i,["path","Path"])),fileName:j(A(i,["fileName","FileName"])),bytes:Ne(A(i,["bytes","Bytes"])),width:Ne(A(i,["width","Width"])),height:Ne(A(i,["height","Height"])),finalPixelSizeMatchesRequest:A(i,["finalPixelSizeMatchesRequest","FinalPixelSizeMatchesRequest"])})}return n.filter(r=>r.path||r.fileName)}function Kn(e,t){let n=O(e,t,4);return Fe(n)?{id:Ne(A(n,["id","Id","viewId","ViewId"])),name:j(A(n,["name","Name","viewName","ViewName"])),type:j(A(n,["type","Type","viewType","ViewType"]))}:null}function ds(e,t=20){return[...new Set(e.filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim()))].slice(0,t)}function ms(e=[],t="",n="",r=""){let o=`${e.join(" ")} ${t} ${n} ${r}`.toLowerCase();return/\bm\d{2,}[a-z]?\b/i.test(o)?"mechanical_hvac":/\bp\d{2,}[a-z]?\b/i.test(o)?"mechanical_piping":/\be\d{2,}[a-z]?\b/i.test(o)?"electrical":/\bs\d{2,}[a-z]?\b/i.test(o)?"structural":/\ba\d{2,}[a-z]?\b/i.test(o)?"architectural":/(duct|air terminal|mechanical equipment|diffuser|damper|hvac|fan coil|ahu|havaland|mekanik)/i.test(o)?"mechanical_hvac":/(pipe|plumbing|sanitary|domestic|hydronic|sprinkler|fire|piping|boru|yangın|yangin|temiz su|pis su)/i.test(o)?"mechanical_piping":/(electrical|cable|lighting|elektrik)/i.test(o)?"electrical":/(structural|beam|column|framing|statik|kiris|kolon)/i.test(o)?"structural":/(wall|door|window|room|space|architect|mimari)/i.test(o)?"architectural":/(schedule|sheet|drawing|revision|pafta|metraj|mahal listesi)/i.test(o)?"schedule_documentation":null}function ps(e,t){let n=e||t||"";return n?dt(n):null}function hs(e={},t=[]){for(let n of t){let r=e?.[n];if(typeof r=="string"&&r.trim())return r.trim()}return null}function fs(e={},t=[]){return t.map(n=>e?.[n]).filter(n=>typeof n=="string"&&n.trim()).map(n=>n.trim())}function gs(e={},t="",n=null,r=null,o=null,i={}){return[t,i.toolName,i.commandName,i.logicalToolName,...fs(e,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery","planNameContains","category","discipline"]),...Array.isArray(e.rowTextQueries)?e.rowTextQueries:[],...Array.isArray(e.categoryNames)?e.categoryNames:[],n?.name,r?.name,o?.name].filter(s=>typeof s=="string"&&s.trim()).join(" ")}function ys(...e){let t=e.filter(i=>typeof i=="string"&&i.trim()).join(" ");if(!t)return null;let n=t.match(/\b(?:level|lvl|l)\s*[-_ ]?(\d{1,2})\b/i);if(n)return`Level ${n[1].padStart(2,"0")}`;let r=t.match(/\b(?:kat|floor)\s*[-_ ]?(\d{1,2})\b/i);if(r)return`Level ${r[1].padStart(2,"0")}`;let o=t.match(/\b(?:basement|bodrum|b)\s*[-_ ]?(\d{1,2})\b/i);return o?`Basement ${o[1].padStart(2,"0")}`:null}function bs(e={}){let t=e.sourceEventType==="mcp.tool"?is(e.response):yo(e.response),n=Fe(t),r=e.params||{},o=e.taskName||r.taskName||e.options?.taskName||e.logicalToolName||e.toolName||e.commandName||null,i=e.responseSummary||Ft(e.response,e.error),a=os(),s=a>0?ls(t,a):[],l=ds([...Array.isArray(r.categoryNames)?r.categoryNames.map(String):[],j(r.category),...s.map(Ia=>Ia.category)]),u=O(t,["document","Document"],3),h=j(O(t,["documentTitle","DocumentTitle"],5))||j(A(u,["title","Title","name","Name"])),m=j(O(t,["documentPath","DocumentPath"],5))||j(A(u,["path","Path","modelPath","ModelPath"])),g=Kn(t,["activeView","ActiveView","view","View"]),b=Kn(t,["beforeView","BeforeView","activeViewBefore","ActiveViewBefore"]),y=Kn(t,["afterView","AfterView"]),T=as(r),P=cs(t),te=us(t),B=j(O(t,["levelName","LevelName","activePlanLevelName","ActivePlanLevelName"],5)),J=Ne(O(t,["levelId","LevelId","activePlanLevelId","ActivePlanLevelId"],5)),z=j(O(t,["roomName","RoomName"],5)),X=j(O(t,["roomNumber","RoomNumber"],5)),ye=j(O(t,["spaceName","SpaceName"],5)),Re=j(O(t,["spaceNumber","SpaceNumber"],5)),Ie=hs(r,["query","nameQuery","cellQuery","sheetQuery","scheduleNameQuery","scheduleQuery","rowTextQuery"]),ae=typeof r.outputDir=="string"?r.outputDir:j(O(t,["outputDir","OutputDir"],4)),_e=typeof r.filePrefix=="string"?r.filePrefix:j(O(t,["filePrefix","FilePrefix"],4)),Kt=gs(r,o||"",g,b,y,e),Br=B||ys(Kt),Ca=O(t,["inferredScope","InferredScope"],5),zr=O(t,["effectiveScope","EffectiveScope"],5),Zt=O(t,["riskPolicy","RiskPolicy","searchRiskPolicy","SearchRiskPolicy"],5),en=O(t,["scanPolicy","ScanPolicy"],5),Ta=O(t,["partial","Partial"],4),qr=j(O(t,["scanStoppedReason","ScanStoppedReason"],4)),Ra=Ne(O(t,["scannedElementCount","ScannedElementCount"],4));return!(o||h||m||g||b||y||T.length||P.length||s.length||te.length||Br||z||ye||Ie||ae)?null:{eventType:"production.context",contextSchemaVersion:"revagent.production.context.v1",related:{sourceEventType:e.sourceEventType,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null},runId:e.taskId||r.taskId||e.options?.taskId||dt(`${fn}|${e.sourceEventType||""}|${e.toolName||""}|${e.commandName||""}|${e.startedAtMs||""}|${o||""}`),operation:{taskName:o,query:Ie,action:i.action||j(O(t,["action","Action"],3)),durationMs:e.durationMs,success:i.success,guarded:i.guarded,state:i.state,errorMessage:i.errorMessage},project:{projectId:ps(m,h),documentTitle:h,documentPath:m,isFamilyDocument:O(t,["isFamilyDocument","IsFamilyDocument"],4),isReadOnly:O(t,["isReadOnly","IsReadOnly"],4),isModifiable:O(t,["isModifiable","IsModifiable"],4)},view:{active:g,before:b,after:y,activeViewChanged:O(t,["activeViewChanged","ActiveViewChanged"],4)},location:{levelId:J,levelName:Br,roomName:z,roomNumber:X,spaceName:ye,spaceNumber:Re},elements:{targetElementIds:T,selectionIds:P,selectionCount:Ne(O(t,["selectionCount","SelectionCount"],4)),categories:l,disciplineHint:ms(l,o||"",Kt,e.toolName||e.logicalToolName||e.commandName||""),samples:s,samplesTruncated:a>0&&s.length>=a},outputs:{outputDir:ae,filePrefix:_e,files:te},search:{query:Ie,inferredScope:Ca,effectiveScope:zr,riskPolicy:Zt,riskLevel:A(Zt,["riskLevel","RiskLevel"])||null,recommendedFirstScope:A(Zt,["recommendedFirstScope","RecommendedFirstScope"])||null,requiresUserControl:A(Zt,["requiresUserControl","RequiresUserControl"])===!0,scanPolicy:en,searchBudget:r.searchBudget||A(en,["searchBudget","SearchBudget"])||null,linkScope:r.linkScope||A(zr,["linkScope","LinkScope"])||null,planCandidateMode:r.planCandidateMode||A(en,["planCandidateMode","PlanCandidateMode"])||null,allowExpensiveSearch:r.allowExpensiveSearch===!0||A(en,["allowExpensiveSearch","AllowExpensiveSearch"])===!0,scannedElementCount:Ra,partial:Ta===!0,scanStoppedReason:qr,needsScope:i.guarded&&i.state==="guarded"&&(A(n,["reason","Reason"])==="needs_scope"||qr==="needs_scope")},response:{responseKeys:i.responseKeys||(n?Object.keys(n).sort().slice(0,40):[])}}}function er(e={}){let t=bs(e);t&&Lt(t)}function xo(){let e=Zr();return{disabled:rr(),localOnly:lt(process.env.REVAGENT_TELEMETRY_LOCAL_ONLY),localRoot:process.env.REVAGENT_TELEMETRY_ROOT||eo(),reportsRoot:process.env.REVAGENT_REPORTS_ROOT||e?.reportsRoot||""}}function vo(e){let t=e.getUTCFullYear().toString(),n=String(e.getUTCMonth()+1).padStart(2,"0"),r=String(e.getUTCDate()).padStart(2,"0");return{year:t,month:n,day:r,ymd:`${t}-${n}-${r}`}}function Ss(e){let t=xo();if(t.disabled)return[];let n=new Date(e.timestampUtc||Date.now()),r=vo(n),o=rn(He(e.machineName),"unknown-machine"),a=[{kind:"local",path:ut.join(t.localRoot,"events",`${r.ymd}.ndjson`)}];return!t.localOnly&&t.reportsRoot&&a.push({kind:"remote",path:ut.join(t.reportsRoot,"events",r.year,r.month,r.day,o,`${e.sessionId}.ndjson`)}),a}function ws(){let e=xo();return{disabled:Xe(),localOnly:e.localOnly||lt(process.env.REVAGENT_LIVE_STATUS_LOCAL_ONLY),localRoot:process.env.REVAGENT_LIVE_STATUS_LOCAL_ROOT||ut.join(e.localRoot,"live"),reportsRoot:process.env.REVAGENT_LIVE_STATUS_ROOT||(e.reportsRoot?ut.join(e.reportsRoot,"live"):"")}}function Co(e=[]){let t=ws();if(t.disabled)return[];let r=["machines",rn(He(process.env.COMPUTERNAME||nr.hostname()),"unknown-machine"),...e],o=[{kind:"local",path:ut.join(t.localRoot,...r)}];return!t.localOnly&&t.reportsRoot&&o.push({kind:"remote",path:ut.join(t.reportsRoot,...r)}),o}function To(e){return!e||typeof e!="object"||Array.isArray(e)?null:{success:typeof e.success=="boolean"?e.success:null,guarded:e.guarded===!0,guardSource:e.guardSource||null,state:e.state||null,action:e.action||null,errorMessage:e.errorMessage||null,messageHash:e.messageHash||null}}function pn(e,t="summary"){if(!e)return null;let n={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,taskIdPresent:!!e.taskId,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,state:e.state,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:t==="full"?e.result||null:To(e.result)};return t!=="full"&&!n.result&&delete n.result,n}function mo(e){if(!e||typeof e!="object")return null;let t=e.commandName||e.method||null,n=e.wrapperAction||e.logicalToolName||e.toolName||t;return{id:e.id||null,requestId:e.requestId||null,method:n||null,toolName:n||null,commandName:t,wrapperAction:e.wrapperAction||null,logicalToolName:e.logicalToolName||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,elapsedMs:e.elapsedMs??null,requestBytes:e.requestBytes??null,responseBytes:e.responseBytes??null,port:e.port||null,error:e.error||null}}function xs(e,t){if(t==="full")return e;let n=To(e.result),r={timestampUtc:e.timestampUtc||e.finishedAtUtc||e.startedAtUtc||null,phase:e.phase,state:e.state||e.phase||null,scope:e.scope||null,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),guardSource:e.guardSource||n?.guardSource||null,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null};return n&&(r.success=n.success,r.guarded=n.guarded,r.action=n.action,r.errorMessage=n.errorMessage,r.messageHash=n.messageHash),Object.fromEntries(Object.entries(r).filter(([,o])=>o!=null))}function Ro(e=10,t="summary"){let n=Qe(e,10,0,100),r=t==="full"?"full":"summary",i=(r==="full"?$e:$e.filter(a=>a.phase!=="started")).slice(0,n).map(a=>xs(a,r));return{mode:r,activeTask:pn(Io(),r),activeTasks:[...Dt.values()].map(a=>pn(a,r)),recentActivity:i,recentActivityCount:i.length,recentActivityStoredCount:$e.length,recentActivityCapacity:or()}}function vs(e){if(!e||typeof e!="object")return null;let t=e.result&&typeof e.result=="object"?e.result:e;return{capturedAtUtc:new Date().toISOString(),activeTask:mo(t.activeTask),recentTasks:(Array.isArray(t.recentTasks)?t.recentTasks:[]).map(mo).filter(Boolean).slice(0,100),recentHistoryCount:t.recentHistoryCount??null,recentHistoryCapacity:t.recentHistoryCapacity??null}}function gn(e){if(Xe())return;let t=vs(e);t&&(fo=t,hn("revit.status"))}function Io(){let e=[...Dt.values()];return e.length===0?null:e.sort((t,n)=>{let r=i=>i.scope==="revit.command"?2:1,o=r(n)-r(t);return o!==0?o:String(n.startedAtUtc||"").localeCompare(String(t.startedAtUtc||""))})[0]}function Cs(e="activity"){let n=kt()?.version||null,r=new Date().toISOString();return lo=r,{schemaVersion:Qa,generatedAtUtc:r,lastHeartbeatUtc:lo,reason:e,machineName:He(process.env.COMPUTERNAME||nr.hostname()),userName:process.env.USERNAME||process.env.USER||"",sessionId:fn,runtime:{version:n,buildHash:Pt(n)},process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:ho},activeTask:pn(Io(),"full"),activeTasks:[...Dt.values()].map(o=>pn(o,"full")),recentActivity:$e.slice(0,or()),revitStatus:fo,writeHealth:oo(ir())}}function Ts(e){let t=Array.isArray(e?.revitStatus?.recentTasks)?e.revitStatus.recentTasks:[],n=Array.isArray(e?.activeTasks)?e.activeTasks:[],r=Array.isArray(e?.recentActivity)?e.recentActivity:[];return!!(e?.activeTask||n.length>0||r.length>0||e?.revitStatus?.activeTask||t.length>0)}function Rs(e){let t=Date.parse(String(e?.generatedAtUtc||e?.lastHeartbeatUtc||""));return Number.isFinite(t)?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY}function Is(e,t){let n=ct(e);if(!n||He(n.machineName)!==He(t.machineName))return t;let r=Math.max(600*1e3,go()*6);return!Ts(n)||Rs(n)>r?t:{...t,recentActivity:Array.isArray(t.recentActivity)&&t.recentActivity.length>0?t.recentActivity:Array.isArray(n.recentActivity)?n.recentActivity:[],revitStatus:so(t.revitStatus,n.revitStatus)}}function hn(e="activity"){let t=Cs(e);for(let n of Co(["status.json"]))Qn(n.path,r=>no(r,Is(r,t)),{disabled:Xe,maxInFlight:ir})}function _s(e){let t={liveTaskId:e.liveTaskId,scope:e.scope,toolName:e.toolName,commandName:e.commandName,logicalToolName:e.logicalToolName,executionKind:e.executionKind,taskName:e.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,guardSource:e.guardSource,state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,durationMs:e.durationMs,result:e.result};e.phase==="started"?Dt.set(e.liveTaskId,t):Dt.delete(e.liveTaskId),$e.unshift({timestampUtc:e.timestampUtc,phase:e.phase,state:e.state,scope:e.scope,toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,parentTaskName:e.parentTaskName||null,parentTaskIdPresent:!!e.parentTaskId,guardSource:e.guardSource||null,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc||null,durationMs:e.durationMs??null,result:e.result||null});let n=or();$e.length>n&&$e.splice(n)}function _o(e){_s(e);let t=vo(new Date(e.timestampUtc||Date.now()));for(let n of Co(["activity",`${t.ymd}.ndjson`]))Qn(n.path,r=>$n(r,e),{disabled:Xe,maxInFlight:ir});hn(e.phase)}function Ms(e={},t){return e.taskId?String(e.taskId):dt([fn,e.scope||"",e.toolName||"",e.commandName||"",e.logicalToolName||"",t||Date.now(),e.taskName||""].join("|"))}function mt(e={}){if(Xe())return null;let t=e.startedAtMs||Date.now(),n=new Date(t).toISOString(),r=Ms(e,t),o=ar({schemaVersion:po,eventType:"live.activity",phase:"started",state:"running",liveTaskId:r,scope:e.scope||"runtime",toolName:e.toolName||null,commandName:e.commandName||null,logicalToolName:e.logicalToolName||null,executionKind:e.executionKind||null,taskName:e.taskName||null,taskId:e.taskId||null,taskIdPresent:!!e.taskId,parentTaskName:e.parentTaskName||null,parentTaskId:e.parentTaskId||null,parentTaskIdPresent:!!e.parentTaskId,startedAtUtc:n,params:dn(e.params)});return _o(o),{liveTaskId:r,scope:o.scope,toolName:o.toolName,commandName:o.commandName,logicalToolName:o.logicalToolName,executionKind:o.executionKind,taskName:o.taskName,taskId:o.taskId,parentTaskName:o.parentTaskName,parentTaskId:o.parentTaskId,guardSource:o.guardSource,startedAtMs:t,startedAtUtc:n}}function Se(e,t={}){if(!e||Xe())return;let n=Date.now(),r=t.durationMs??Math.max(0,n-(e.startedAtMs||n)),o=t.responseSummary||Ft(t.response,t.error),i=o.guarded?"guarded":o.success===!1?"failed":"completed",a=o.guarded?bo(t.guardSource||e.guardSource||o.guardSource)||"runtime":null,s=ar({schemaVersion:po,eventType:"live.activity",phase:i,state:i,liveTaskId:e.liveTaskId,scope:e.scope||t.scope||"runtime",toolName:e.toolName||t.toolName||null,commandName:e.commandName||t.commandName||null,logicalToolName:e.logicalToolName||t.logicalToolName||null,executionKind:e.executionKind||t.executionKind||null,taskName:e.taskName||t.taskName||null,taskId:e.taskId||t.taskId||null,taskIdPresent:!!(e.taskId||t.taskId),parentTaskName:e.parentTaskName||t.parentTaskName||null,parentTaskId:e.parentTaskId||t.parentTaskId||null,parentTaskIdPresent:!!(e.parentTaskId||t.parentTaskId),guardSource:a,startedAtUtc:e.startedAtUtc||null,finishedAtUtc:new Date(n).toISOString(),durationMs:r,result:o});_o(s)}function Ns(){if(cn||Xe())return;let e=go();e<=0||(hn("session.start"),cn=setInterval(()=>{hn("heartbeat")},e),typeof cn.unref=="function"&&cn.unref())}function ar(e={}){let n=kt()?.version||null;return{schemaVersion:$a,eventId:tr.randomUUID(),eventType:e.eventType||"runtime.event",timestampUtc:e.timestampUtc||new Date().toISOString(),sessionId:fn,sequence:++Xa,source:"runtime-mcp-server",process:{pid:process.pid,nodeVersion:process.version,startedAtUtc:ho},machineName:He(process.env.COMPUTERNAME||nr.hostname()),userName:process.env.USERNAME||process.env.USER||"",runtime:{version:n,buildHash:Pt(n)},...e}}async function Lt(e={}){if(rr())return;let t=ar(e),n=Ss(t);await Promise.allSettled(n.map(r=>ro(r.path,t)))}function Mo(){Ns(),Lt({eventType:"runtime.session.start"})}function Ee(e={}){let t=Math.max(0,Date.now()-(e.startedAtMs||Date.now())),n=Ft(e.response,e.error);Lt({eventType:"revit.command",commandName:e.commandName,logicalToolName:e.logicalToolName||e.commandName,executionKind:e.executionKind||"bridgeCommand",taskName:e.params?.taskName||e.options?.taskName||null,taskIdPresent:!!(e.params?.taskId||e.options?.taskId),parentTaskName:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskIdPresent:!!(e.params?.parentTaskId||e.options?.parentTaskId),transactionMode:e.params?.transactionMode||e.options?.transactionMode||null,connection:{targetPresent:!!e.options?.target,hostPresent:!!e.options?.host,port:e.options?.port||null},durationMs:t,params:dn(e.params),result:n}),er({...e,sourceEventType:"revit.command",durationMs:t,responseSummary:n,taskName:e.params?.taskName||e.options?.taskName||null,taskId:e.params?.taskId||e.options?.taskId||null,parentTaskName:e.params?.parentTaskName||e.options?.parentTaskName||null,parentTaskId:e.params?.parentTaskId||e.options?.parentTaskId||null})}function Es(e){return!(e==="get_revit_mcp_status"&&!lt(process.env.REVAGENT_TELEMETRY_INCLUDE_STATUS))}function No(e){return{...e,tool(t,n,r,o){let i=n,a=r,s=o;typeof n=="object"&&(s=r,a=n,i="");let l=async(u,h)=>{let m=Date.now(),g=Es(t),b=g?mt({scope:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,startedAtMs:m}):null;try{let y=await s(u,h);if(g){let T=Math.max(0,Date.now()-m),P=co(y);Lt({eventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskIdPresent:!!u?.taskId,parentTaskName:u?.parentTaskName||null,parentTaskIdPresent:!!u?.parentTaskId,durationMs:T,params:dn(u),result:P}),er({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,response:y,durationMs:T,startedAtMs:m,responseSummary:P}),Se(b,{response:y,responseSummary:P,durationMs:T})}return y}catch(y){if(g){let T=Math.max(0,Date.now()-m),P=co(null,y);Lt({eventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskIdPresent:!!u?.taskId,parentTaskName:u?.parentTaskName||null,parentTaskIdPresent:!!u?.parentTaskId,durationMs:T,params:dn(u),result:P}),er({sourceEventType:"mcp.tool",toolName:t,taskName:u?.taskName||null,taskId:u?.taskId||null,parentTaskName:u?.parentTaskName||null,parentTaskId:u?.parentTaskId||null,params:u,error:y,durationMs:T,startedAtMs:m,responseSummary:P}),Se(b,{error:y,responseSummary:P,durationMs:T})}throw y}};return e.tool(t,i,a,l)}}}var ks=2;function S(e){return{target:e.string().optional().describe("Optional Revit target: registered instance name, port number such as 8081, or host:port. Defaults to REVIT_MCP_TARGET/REVIT_MCP_PORT/8080."),host:e.string().optional().describe("Optional Revit socket host. Defaults to REVIT_MCP_HOST or localhost."),port:e.number().int().positive().max(65535).optional().describe("Optional Revit socket port. Defaults to REVIT_MCP_PORT or 8080.")}}function x(e){return{taskName:e.string().optional().describe("Optional display name shown in Revit while this MCP task is running."),taskId:e.string().optional().describe("Optional client task identifier forwarded to Revit status history."),parentTaskName:e.string().optional().describe("Optional parent workflow display name. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task."),parentTaskId:e.string().optional().describe("Optional parent workflow identifier. Wrappers set this on nested sub-operations so live feed/history preserves the operator-visible parent task id.")}}function d(e,t,n){if(!e||typeof e!="object")return;let r=n??t.charAt(0).toLowerCase()+t.slice(1);return e[t]??e[r]}function Y(e={}){return{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs}}function se(e={},t){return{taskName:e.taskName||t,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId}}function I(e={},t){return{...Y(e),...se(e,t)}}function ko(e,t){let n=t.parentTaskName||(t.taskName&&e.taskName&&e.taskName!==t.taskName?t.taskName:void 0),r=t.parentTaskId||(t.taskId&&e.taskName&&e.taskName!==t.taskName?t.taskId:void 0);n&&!e.parentTaskName&&(e.parentTaskName=n),r&&!e.parentTaskId&&(e.parentTaskId=r)}function Po(e,t,n){let r=n.toolName||t;r&&!e.logicalToolName&&(e.logicalToolName=r),n.toolName&&n.toolName!==t&&!e.wrapperAction&&(e.wrapperAction=n.toolName)}function yn(e){let t=[["Success","success"],["SUCCESS","success"],["Guarded","guarded"],["State","state"],["Action","action"],["Message","message"],["Error","error"],["ResultContractVersion","resultContractVersion"]],n=r=>{if(Array.isArray(r))return r.map(i=>n(i));if(!r||typeof r!="object")return r;let o={};for(let[i,a]of Object.entries(r))o[i]=n(a);for(let[i,a]of t)Object.prototype.hasOwnProperty.call(o,i)&&(Object.prototype.hasOwnProperty.call(o,a)||(o[a]=o[i]),delete o[i]);return o};return n(e)}function p(e){let t=yn(e);return{content:[{type:"text",text:JSON.stringify(t,null,2)}]}}function jt(e,t=0){if(typeof e!="string")return e;let n=e.trim();if(!n.startsWith("{")&&!n.startsWith("[")&&!n.startsWith('"'))return e;try{let r=JSON.parse(n);return t<2&&typeof r=="string"?jt(r,t+1):r}catch{return e}}function bn(e){if(Array.isArray(e))return e.map(n=>bn(n));if(!e||typeof e!="object")return e;let t={};for(let[n,r]of Object.entries(e)){let o=n==="result"||n==="Result"?jt(r):r;t[n]=bn(o)}return t}function Ps(e){if(!e||typeof e!="object"||Array.isArray(e))return null;let t=e.resultContractVersion??e.ResultContractVersion,n=Number.parseInt(String(t??""),10);return Number.isFinite(n)?n:null}function As(e){let t=Ps(e);return t!==null&&t>=ks}function ke(e,t={}){let n=jt(e);if(As(n))return t.parseResultStrings===!0?yn(bn(n)):n;if(n&&typeof n=="object"&&!Array.isArray(n)){let r=n;return t.parseResultStrings===!0?r=bn(r):("result"in r||"Result"in r)&&(r={...r},"result"in r?r.result=jt(r.result):r.Result=jt(r.Result)),yn(r)}return yn(n)}function Ao(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Ke(e,t={}){let n=t.verboseCandidates===!0,r=Ao(t.maxPlanCandidates,3,0,100);if(n)return e;let o=i=>{if(Array.isArray(i))return i.map(s=>o(s));if(!i||typeof i!="object")return i;let a={};for(let[s,l]of Object.entries(i)){if((s==="PlanCandidates"||s==="planCandidates")&&Array.isArray(l)){let u=s==="PlanCandidates"?"PlanCandidatesTotal":"planCandidatesTotal",h=s==="PlanCandidates"?"PlanCandidatesTruncated":"planCandidatesTruncated";a[u]=l.length,a[h]=l.length>r,a[s]=l.slice(0,r).map(m=>o(m));continue}a[s]=o(l)}return a};return o(e)}function Eo(e,t){if(!e||typeof e!="object")return e;let n=e.commandName||e.method,r=e.wrapperAction||e.logicalToolName||e.toolName||n,o={id:e.id,requestId:e.requestId,method:r,toolName:r,commandName:n,wrapperAction:e.wrapperAction,logicalToolName:e.logicalToolName,taskName:e.taskName,parentTaskName:e.parentTaskName,parentTaskIdPresent:!!(e.parentTaskIdPresent||e.parentTaskId),state:e.state,startedAtUtc:e.startedAtUtc,finishedAtUtc:e.finishedAtUtc,elapsedMs:e.elapsedMs,port:e.port,error:e.error};return t&&(o.framing=e.framing,o.requestBytes=e.requestBytes,o.receiveMs=e.receiveMs,o.parseMs=e.parseMs,o.executeMs=e.executeMs,o.responseBytes=e.responseBytes),o}function Bt(e,t={}){let n=t.includeRecentTasks!==!1,r=t.includeDiagnostics===!0,o=Ao(t.recentLimit,3,0,100),i=e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e;if(!i||typeof i!="object")return e;let a={...i};return a.activeTask=Eo(i.activeTask,r),Array.isArray(i.recentTasks)&&(a.recentHistoryCount=i.recentHistoryCount??i.recentTasks.length,a.recentHistoryCapacity=i.recentHistoryCapacity??100,delete a.recentTasksTotal,n?(a.recentTasks=i.recentTasks.slice(0,o).map(s=>Eo(s,r)),a.recentTasksTruncated=i.recentTasks.length>o):(delete a.recentTasks,a.recentTasksIncluded=!1)),e&&typeof e=="object"&&e.result&&typeof e.result=="object"?{...e,result:a}:a}async function U(e,t={}){let n={code:e,parameters:t.parameters||[],transactionMode:t.transactionMode||"none",taskName:t.taskName||"Run Revit code"};t.taskId&&(n.taskId=t.taskId),Po(n,"send_code_to_revit",t),ko(n,t);let r=Date.now(),o=mt({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",taskName:n.taskName,taskId:n.taskId,parentTaskName:n.parentTaskName,parentTaskId:n.parentTaskId,params:n,startedAtMs:r});try{let i=await be(async l=>await l.sendCommand("send_code_to_revit",n,t),t),a=t.parseJsonResult===!1?i:ke(i,{parseResultStrings:!0}),s=Math.max(0,Date.now()-r);return Ee({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,response:a,startedAtMs:r}),Se(o,{response:a,durationMs:s}),Ye(t),a}catch(i){let a=Math.max(0,Date.now()-r);throw Ee({commandName:"send_code_to_revit",logicalToolName:t.toolName||n.taskName,executionKind:"dynamicCode",params:n,options:t,error:i,startedAtMs:r}),Se(o,{error:i,durationMs:a}),Ye(t),i}}async function Ye(e={}){let t=Math.max(250,Math.min(5e3,Number(e.statusRefreshTimeoutMs||1500)));try{let n=await be(async r=>await r.sendCommand("mcp_status",{},{timeoutMs:t}),{...e,skipLock:!0,connectTimeoutMs:t,timeoutMs:t,logSocketErrors:!1});return gn(n),n}catch{return null}}async function _(e,t={},n={}){let r={...t};r.taskName||(r.taskName=n.taskName||e),ko(r,n),n.taskId&&!r.taskId&&(r.taskId=n.taskId),Po(r,e,n);let o=Date.now(),i=mt({scope:"revit.command",commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:o});try{let a=await be(async u=>await u.sendCommand(e,r,n),n),s=ke(a),l=Math.max(0,Date.now()-o);return Ee({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,response:s,startedAtMs:o}),Se(i,{response:s,durationMs:l}),Ye(n),s}catch(a){let s=Math.max(0,Date.now()-o);throw Ee({commandName:e,logicalToolName:n.toolName||e,executionKind:"bridgeCommand",params:r,options:n,error:a,startedAtMs:o}),Se(i,{error:a,durationMs:s}),Ye(n),a}}function R(e){return e==null?"null":`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n")}"`}function we(e){return`new string[] { ${(Array.isArray(e)?e:[]).map(R).join(", ")} }`}function Sn(e){return`new int[] { ${(Array.isArray(e)?e:[]).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function Oo(e,t){let n=Number(t||0);return!n||typeof e!="string"||e.length<=n?{text:e,truncated:!1}:{text:`${e.slice(0,n)}
...[truncated ${e.length-n} chars]`,truncated:!0}}function Os(e){let t=new Set,n=(r,o="")=>{if(r!=null){if(typeof r=="number"&&/(^id$|elementid|elementids)/i.test(o)){t.add(r);return}if(typeof r=="string"&&/^-?\d+$/.test(r)&&/(^id$|elementid|elementids)/i.test(o)){t.add(Number.parseInt(r,10));return}if(Array.isArray(r)){for(let i of r)n(i,o);return}if(typeof r=="object")for(let[i,a]of Object.entries(r))n(a,i)}};return n(e),[...t].filter(r=>Number.isFinite(r)&&r>0)}async function pt(e=100,t={}){let n=await _("get_selected_elements",{limit:e},t);return Os(n).slice(0,e)}var Vs=new Set(["success","guarded","state","action","error","reason","warnings","notices"]);function Vo(e){let t=String(e||"").trim();return t.length>0?t:void 0}function Do(e){if(!Array.isArray(e))return;let t=e.map(n=>String(n||"").trim()).filter(n=>n.length>0);return t.length>0?t:void 0}function Ds(e){return e?Object.fromEntries(Object.entries(e).filter(([t])=>!Vs.has(t))):{}}function sr(e,t){let n={...Ds(t.extra),...e,action:t.action},r=Vo(t.error),o=Vo(t.reason),i=Do(t.warnings),a=Do(t.notices);return r&&(n.error=r),o&&(n.reason=o),i&&(n.warnings=i),a&&(n.notices=a),n}function Fo(e){return sr({success:!0,guarded:!1,state:"completed",action:e.action},e)}function Ce(e){return sr({success:!1,guarded:!0,state:"guarded",action:e.action},e)}function pe(e){return sr({success:!1,guarded:!1,state:"failed",action:e.action},e)}function Fs(e){let t=String(e||"");return t.match(/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\b(?:class|struct|interface|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*/m)?{reason:"dynamic_snippet_type_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). C# type declarations such as class/struct/interface/enum/record cannot be declared inside that method body. Use local functions, built-in collections, or add a native runtime tool when reusable helper types are needed."}:t.match(/^\s*namespace\s+[A-Za-z_][A-Za-z0-9_.]*/m)?{reason:"dynamic_snippet_namespace_declaration_not_supported",message:"Dynamic snippets are inserted inside Execute(Document document, object[] parameters). namespace declarations cannot be declared inside that method body. Use method-body C# only."}:null}function Ls(e){let t=ke(e);if(t&&typeof t=="object"&&t.success===!1)return t.error||t.errorMessage||t.message||"Revit code returned success=false.";let n=t&&typeof t=="object"&&"result"in t?t.result:t;return typeof n=="string"&&/^\s*ERROR\s*:/i.test(n)?n.trim():n&&typeof n=="object"&&n.success===!1?n.error||n.message||"Revit code returned success=false.":null}function Lo(e){e.tool("send_code_to_revit","Send C# code to Revit for execution. The code will be inserted into a template with access to the Revit Document and parameters. Your code should be written to work within the Execute method of the template.",{...S(Pe),...x(Pe),code:Pe.string().describe("The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."),parameters:Pe.array(Pe.any()).optional().describe("Optional execution parameters that will be passed to your code"),transactionMode:Pe.enum(["auto","none"]).optional().describe("Transaction handling mode forwarded to the Revit wrapper. In the bundled plugin build, snippets should not open their own Transaction unless that exact build has been verified."),timeoutMs:Pe.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),reportErrorResultAsFailure:Pe.boolean().optional().describe("When true, ERROR: string results or { success:false } objects are reported as failed tool calls. Defaults true. This cannot roll back a write if the snippet swallowed its own exception."),parseJsonResult:Pe.boolean().optional().describe("When true, parse JSON-looking result strings, including double-encoded JSON strings. Defaults true. Set false to inspect the raw wire result.")},async(t,n)=>{let r={code:t.code,parameters:t.parameters||[],transactionMode:t.transactionMode||"auto",taskName:t.taskName||"Run Revit code"};t.taskId&&(r.taskId=t.taskId),t.parentTaskName&&(r.parentTaskName=t.parentTaskName),t.parentTaskId&&(r.parentTaskId=t.parentTaskId),r.logicalToolName="send_code_to_revit";let o=Y(t),i=Date.now(),a=mt({scope:"revit.command",commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",taskName:r.taskName,taskId:r.taskId,parentTaskName:r.parentTaskName,parentTaskId:r.parentTaskId,params:r,startedAtMs:i}),s=Fs(t.code);if(s){let l=Math.max(0,Date.now()-i),u=Ce({action:"dynamic_snippet_preflight",reason:s.reason,error:s.message});return Ee({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:i}),Se(a,{response:u,durationMs:l}),{content:[{type:"text",text:`Code execution guarded: ${s.message}`}]}}try{let l=await be(async g=>await g.sendCommand("send_code_to_revit",r,o),o),u=t.parseJsonResult===!1?l:ke(l,{parseResultStrings:!0}),h=Math.max(0,Date.now()-i);Ee({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,response:u,startedAtMs:i}),Se(a,{response:u,durationMs:h}),Ye(o);let m=t.parseJsonResult===!1||t.reportErrorResultAsFailure===!1?null:Ls(u);return m?{content:[{type:"text",text:`Code execution failed: ${m}`}]}:{content:[{type:"text",text:`Code execution successful!
Result: ${JSON.stringify(u,null,2)}`}]}}catch(l){let u=Math.max(0,Date.now()-i);return Ee({commandName:"send_code_to_revit",logicalToolName:"send_code_to_revit",executionKind:"dynamicCode",params:r,options:o,error:l,startedAtMs:i}),Se(a,{error:l,durationMs:u}),Ye(o),{content:[{type:"text",text:`Code execution failed: ${l instanceof Error?l.message:String(l)}`}]}}})}import{z as le}from"zod";function lr(e,t,n){return p(Ce({action:"send_code_to_revit_safe_preflight",error:e,reason:n,extra:{safetyReason:n,writePatterns:t}}))}function jo(e){e.tool("send_code_to_revit_safe","Run Revit C# through the existing dynamic execution command with read/preview safety checks, JSON result parsing, and output trimming. This MVP does not commit writes.",{...S(le),...x(le),code:le.string().min(1).describe("Body of Execute(Document document, object[] parameters)."),parameters:le.array(le.union([le.string(),le.number(),le.boolean()])).optional().describe("Simple execution parameters. Prefer strings for host portability."),transactionMode:le.enum(["auto","none"]).optional().describe("Safe wrapper execution mode. Only none is executed; auto is rejected for read/preview safety."),intent:le.enum(["read","writePreview","writeCommit"]).optional().describe("Safety intent. writeCommit is not supported by this MVP wrapper."),timeoutMs:le.number().int().positive().optional().describe("Socket timeout in milliseconds for this Revit command. Defaults to 120000."),maxReturnedChars:le.number().int().positive().optional().describe("Maximum JSON characters returned to the model."),parseJsonResult:le.boolean().optional().describe("When true, parse JSON-looking result strings. Defaults true.")},async t=>{let n=t.intent||"read",r=Nt(t.code);if(n==="writeCommit")return lr("send_code_to_revit_safe does not support writeCommit in this MVP. Use raw send_code_to_revit only after explicit user confirmation.",r,"safe_wrapper_write_commit_not_supported");if(t.transactionMode==="auto")return lr("send_code_to_revit_safe only executes with transactionMode 'none'. Use raw send_code_to_revit for an explicitly confirmed write.",r,"safe_wrapper_requires_transactionMode_none");if(r.length>0)return lr(`Rejected write-looking code for intent '${n}'.`,r,"safe_wrapper_rejected_write_looking_code");try{let i=await U(t.code,{...Y(t),...se(t,"Run safe Revit read"),parameters:t.parameters||[],transactionMode:"none",parseJsonResult:t.parseJsonResult!==!1}),a=Fo({action:"send_code_to_revit_safe",extra:{intent:n,response:i}}),s=JSON.stringify(a,null,2),l=Oo(s,t.maxReturnedChars);return l.truncated?{content:[{type:"text",text:l.text}]}:p(a)}catch(o){return p(pe({action:"send_code_to_revit_safe",error:o instanceof Error?o.message:String(o)}))}})}import{z as ht}from"zod";function js(e){return e&&typeof e=="object"&&e.result&&typeof e.result=="object"?e.result:e}function Bs(e){let t=String(e.detailLevel||"minimal").toLowerCase(),n=e.includeCategoryCounts===!0||t==="counts"||t==="full"?"true":"false",r=e.includeLinks!==!1?"true":"false",o=e.includeLinks===!0&&t==="full"||t==="full"?"true":"false";return`
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
}`}function Bo(e){e.tool("get_revit_session_context","Read-only Revit session summary. Defaults to detailLevel=minimal so large-model document checks do not perform heavy MEP category or linked room/space counts. Use detailLevel=counts/full only when those expensive counts are explicitly needed.",{...S(ht),...x(ht),detailLevel:ht.enum(["minimal","counts","full"]).optional().describe("Context detail level. minimal is default and avoids category counts and linked room/space scans; counts adds host MEP category counts; full also scans linked room/space counts."),includeCategoryCounts:ht.boolean().optional().describe("Compatibility flag. true includes known MEP category counts; default false unless detailLevel is counts/full."),includeLinks:ht.boolean().optional().describe("Include cheap Revit link instance summary. Defaults true; linked room/space counts require detailLevel=full."),includeSelection:ht.boolean().optional().describe("Include selected element ids using the existing Revit selection command. Defaults true.")},async t=>{let n=Y(t);try{let r=await U(Bs(t),{...n,...se(t,"Read Revit session context"),transactionMode:"none"}),o=js(r);if(t.includeSelection!==!1&&o&&typeof o=="object"){let i=await pt(100,{...n,taskName:t.taskName?`${t.taskName}: selection`:"Read Revit selection",taskId:t.taskId});o.selection={count:i.length,elementIds:i}}return p(o)}catch(r){return p({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as Le}from"zod";function zs(e){let t=e.includeSheetViewports!==!1?"true":"false",n=e.includeSheetScheduleInstances!==!1?"true":"false",r=e.includeModelElements===!0?"true":"false",o=Number.isFinite(e.limit)?Math.max(1,Math.min(500,e.limit)):100,i=we(e.modelCategoryList||[]);return`
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
}`}function zo(e){e.tool("get_active_view_context","Read-only active view context. Handles model views and DrawingSheet views; sheets return placed viewport/view data plus scheduleSheetInstances instead of pretending MEP model elements are directly visible.",{...S(Le),...x(Le),includeSheetViewports:Le.boolean().optional().describe("When active view is a sheet, include placed viewports. Defaults true."),includeSheetScheduleInstances:Le.boolean().optional().describe("When active view is a sheet, include placed ScheduleSheetInstance entries with schedule ids, names, point, and box data. Defaults true."),includeModelElements:Le.boolean().optional().describe("When active view is a model view, collect limited model elements from modelCategoryList. Defaults false."),modelCategoryList:Le.array(Le.string()).optional().describe("BuiltInCategory names such as OST_DuctCurves or OST_DuctTerminal."),limit:Le.number().int().positive().max(500).optional().describe("Maximum model elements to return. Defaults 100.")},async t=>{try{let n=await U(zs(t),{...I(t,"Read active Revit view context"),transactionMode:"none"});return p(n&&n.result?n.result:n)}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as qo}from"zod";var qs=["dryRun","DryRun","deleted","Deleted","confirmDelete","ConfirmDelete","targetIsReviewView","TargetIsReviewView","reviewSignals","ReviewSignals","deletedElementCount","DeletedElementCount"],Ws=["closed","Closed"];function ft(e,t={}){if(!e||typeof e!="object"||Array.isArray(e))return e;let n={...e};for(let r of qs)delete n[r];if(t.stripCloseOnlyFields)for(let r of Ws)delete n[r];return n}function Wo(e){e.tool("list_open_views","List Revit UI view tabs currently open in the active document.",{...S(qo),...x(qo)},async t=>{try{let n=await _("list_open_views",{},{...I(t,"List open Revit views")});return p(ft(n&&n.result?n.result:n))}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as Ze}from"zod";function Go(e){e.tool("activate_view","Activate an existing Revit view tab by id or unique name without opening a transaction. Supports plans, 3D views, sheets, schedules, legends, drafting views, sections, and elevations.",{...S(Ze),...x(Ze),viewId:Ze.number().int().positive().optional().describe("ElementId of the Revit view to activate."),viewName:Ze.string().optional().describe("Name of the Revit view to activate. Must match one view unless viewType is also supplied."),viewType:Ze.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:Ze.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:Ze.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation verification. Defaults 15000.")},async t=>{try{let n=await _("activate_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...I(t,"Activate Revit view")});return p(ft(n&&n.result?n.result:n,{stripCloseOnlyFields:!0}))}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as et}from"zod";function Jo(e){e.tool("close_view","Close an open Revit UI view tab by id or unique name without opening a transaction. If the target is active, another open view is activated first.",{...S(et),...x(et),viewId:et.number().int().positive().optional().describe("ElementId of the Revit view to close."),viewName:et.string().optional().describe("Name of the Revit view to close. Must match one view unless viewType is also supplied."),viewType:et.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, DrawingSheet, Schedule, Section, or Elevation."),exactName:et.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),timeoutMs:et.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI close verification. Defaults 15000.")},async t=>{try{let n=await _("close_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,timeoutMs:t.timeoutMs},{...I(t,"Close Revit view")});return p(ft(n&&n.result?n.result:n))}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as cr}from"zod";function Uo(e){e.tool("clear_selection","[LIVE_UI_SELECTION_CLEANUP] Clear the current Revit UI selection. This does not open a transaction and does not modify model elements or view data. Use after focus/testing workflows when the operator wants Revit left with no selected elements.",{...S(cr),...x(cr),timeoutMs:cr.number().int().positive().max(3e4).optional().describe("Timeout for the selection clear command. Defaults 10000.")},async t=>{try{let n=await _("clear_selection",{timeoutMs:t.timeoutMs},{...I(t,"Clear Revit selection")});return p(n&&n.result?n.result:n)}catch(n){return p({success:!1,action:"clear_selection",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as Te}from"zod";function Gs(e){return!e||typeof e!="object"?null:{id:d(e,"Id","id")??d(e,"ViewId","viewId")??null,name:d(e,"Name","name")??d(e,"ViewName","viewName")??null,type:d(e,"Type","type")??d(e,"ViewType","viewType")??null}}function Js(e,t={}){let n=t.responseMode||"compact";if(!e||typeof e!="object"||n==="full")return{...e,responseMode:n};let r=Gs(d(e,"TargetView","targetView")),o={mode:d(e,"Mode","mode")??t.mode??"dryRun",dryRun:d(e,"DryRun","dryRun")??null,changed:d(e,"Changed","changed")??null,deleted:d(e,"Deleted","deleted")??null,deletedElementCount:d(e,"DeletedElementCount","deletedElementCount")??null,confirmed:(d(e,"ConfirmDelete","confirmDelete")??t.confirmDelete)===!0,targetIsReviewView:d(e,"TargetIsReviewView","targetIsReviewView")??null,reviewSignals:d(e,"ReviewSignals","reviewSignals")??[]};return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded"),state:d(e,"State","state"),action:d(e,"Action","action")||"delete_review_view",responseMode:"compact",reason:d(e,"Reason","reason"),error:d(e,"Error","error"),message:d(e,"Message","message"),targetView:r,cleanup:o,suggestedNextScopes:d(e,"SuggestedNextScopes","suggestedNextScopes")??[],notices:[...Array.isArray(d(e,"Notices","notices"))?d(e,"Notices","notices"):[],'Compact response groups cleanup-specific fields under cleanup. Use responseMode="full" for raw delete_review_view diagnostics.']}}function Ho(e){e.tool("delete_review_view",'[REVIEW_VIEW_CLEANUP_GUARDED] Dry-run or delete an explicit revAgent review 3D view. Defaults to dryRun and only permits guarded cleanup of known review/focus/coordination/QA view names, including revAgent_QA_* views created by create_3d_view_for_elements; it blocks production views, active views, and open view tabs. Commit requires mode="commit" and confirmDelete=true.',{...S(Te),...x(Te),viewId:Te.number().int().positive().optional().describe("ElementId of the review 3D view to inspect or delete."),viewName:Te.string().optional().describe("Exact review view name to inspect or delete when viewId is not supplied."),viewType:Te.string().optional().describe("Optional Revit ViewType filter. Review cleanup is limited to non-template ThreeD views."),exactName:Te.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),mode:Te.enum(["dryRun","commit"]).optional().describe("dryRun reports whether the view is eligible for cleanup. commit deletes only with confirmDelete=true. Defaults dryRun."),confirmDelete:Te.boolean().optional().describe("Required true with mode=commit to delete the eligible review view."),responseMode:Te.enum(["compact","full"]).optional().describe("Response shape. compact is the default and groups cleanup-specific fields under cleanup; full returns the raw native cleanup contract."),timeoutMs:Te.number().int().positive().max(12e4).optional().describe("Timeout for review view cleanup. Defaults 15000.")},async t=>{try{let n=await _("delete_review_view",{viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,mode:t.mode,confirmDelete:t.confirmDelete,timeoutMs:t.timeoutMs},{...I(t,"Delete Revit review view")});return p(Js(n&&n.result?n.result:n,t))}catch(n){return p({success:!1,action:"delete_review_view",state:"failed",error:n instanceof Error?n.message:String(n)})}})}import{z as wn}from"zod";function $o(e){e.tool("get_ui_state","Read the current Revit UI state: active view, open views, selected element ids/summaries, and document modifiable/read-only status.",{...S(wn),...x(wn),selectionLimit:wn.number().int().min(0).max(1e3).optional().describe("Maximum selected elements to summarize. Defaults 100."),timeoutMs:wn.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=await _("get_ui_state",{selectionLimit:t.selectionLimit},{...I(t,"Read Revit UI state")});return p(n&&n.result?n.result:n)}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as v}from"zod";var Us="fast",Hs={fast:{name:"fast",maxElementsScanned:5e3,maxElapsedMs:4500,socketTimeoutMs:12e3},balanced:{name:"balanced",maxElementsScanned:25e3,maxElapsedMs:18e3,socketTimeoutMs:3e4},deep:{name:"deep",maxElementsScanned:15e4,maxElapsedMs:9e4,socketTimeoutMs:12e4}},$s=[{concept:"fan_coil",terms:["fan coil","fancoil","fcu"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"air_handling_unit",terms:["ahu","air handling unit","klima santrali"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"pump",terms:["pump","pompa"],categories:["Mechanical Equipment"],preserveQueryWhenFullyStripped:!0},{concept:"valve",terms:["valve","vana"],categories:["Pipe Accessories","Pipe Fittings"],preserveQueryWhenFullyStripped:!0},{concept:"damper",terms:["damper"],categories:["Duct Accessories","Mechanical Equipment"]},{concept:"air_terminal",terms:["diffuser","grille","air terminal","difuzor","menfez"],categories:["Air Terminals"]},{concept:"duct",terms:["duct","kanal"],categories:["Ducts","Duct Fittings","Duct Accessories"]},{concept:"pipe",terms:["pipe","boru"],categories:["Pipes","Pipe Fittings","Pipe Accessories"]},{concept:"sprinkler",terms:["sprinkler"],categories:["Sprinklers"]},{concept:"plumbing_fixture",terms:["plumbing fixture","sanitary fixture","sihhi tesisat armat\xFCr","armat\xFCr"],categories:["Plumbing Fixtures"]}],Qs=/^[\p{L}\p{N}_\- ]{1,24}$/u;function Qo(e){return String(e||"").normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase().replace(/\s+/g," ").trim()}function Xs(e){return e.normalize("NFD").replace(new RegExp("\\p{Diacritic}","gu"),"").replace(/ı/g,"i").replace(/İ/g,"I").toLowerCase()}function Xo(e){let t=[],n=[];for(let r=0;r<e.length;){let o=e.codePointAt(r);if(o===void 0)break;let i=String.fromCodePoint(o),a=r+i.length,s=Xs(i);for(let l of s)t.push(l),n.push([r,a]);r=a}return{text:t.join(""),sourceRanges:n}}function dr(e){let t=new Set,n=[];for(let r of e){let o=String(r||"").trim();if(!o)continue;let i=o.toLowerCase();t.has(i)||(t.add(i),n.push(o))}return n}function Ys(e){let t=String(e||"").toLowerCase();return t==="balanced"||t==="deep"||t==="fast"?t:Us}function ur(e,t,n,r){let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Ks(e,t){let n=Xo(e),r=new Array(e.length).fill(!1);for(let i of t.sort((a,s)=>s.length-a.length)){let a=Xo(i).text;if(!a)continue;let s=a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+"),l=new RegExp(`(?<![\\p{L}\\p{N}])${s}(?![\\p{L}\\p{N}])`,"gu"),u;for(;(u=l.exec(n.text))!==null;)for(let h=u.index;h<l.lastIndex;h++){let m=n.sourceRanges[h];if(m)for(let g=m[0];g<m[1];g++)r[g]=!0}}let o="";for(let i=0;i<e.length;i++)o+=r[i]?" ":e[i];return o.replace(/\s+/g," ").trim()}function Zs(e){let t=Qo(e),n=[],r=[],o=[],i=!1;for(let s of $s){let l=s.terms.filter(u=>t.includes(Qo(u)));l.length!==0&&(n.push({concept:s.concept,terms:l,categories:s.categories,preserveQueryWhenFullyStripped:s.preserveQueryWhenFullyStripped===!0}),r.push(...l),o.push(...s.categories),i=i||s.preserveQueryWhenFullyStripped===!0)}let a=Ks(e,r);return{matchedConcepts:n,matchedTerms:r,categories:dr(o),effectiveQuery:a||(i?e.trim():"")}}function el(e={}){let t=["levelNames","activeViewOnly","familyName","typeName","systemName"];return!e.sheetQuery&&!Array.isArray(e.sheetIds)&&t.push("sheetQuery"),!e.nameQuery&&!Array.isArray(e.scheduleIds)&&t.push("scheduleIds/nameQuery"),t.push("allowExpensiveSearch","searchBudget=deep"),t}function xn(e,t){for(let n of e)if(!(!n||typeof n!="object"))for(let r of t){let o=n[r],i=Number.parseInt(String(o??""),10);if(Number.isFinite(i))return i}return null}function tl(e,t){let n=[];return t.length>0&&n.push(`categoryNames=${t.join("|")}`),Array.isArray(e.levelNames)&&e.levelNames.length>0&&n.push("levelNames"),(e.activeViewOnly===!0||e.viewId)&&n.push("activeViewOnly/viewId"),e.familyName&&n.push("familyName"),e.typeName&&n.push("typeName"),e.systemName&&n.push("systemName"),n.length>0?n:["categoryNames","levelNames","activeViewOnly","familyName/typeName","systemName"]}function nl(e={},t=[]){return!!(t.length>0||e.activeViewOnly===!0||e.viewId||Array.isArray(e.levelIds)&&e.levelIds.length>0||Array.isArray(e.levelNames)&&e.levelNames.length>0||e.familyName||e.typeName||e.systemName||Array.isArray(e.worksetIds)&&e.worksetIds.length>0||Array.isArray(e.worksetNames)&&e.worksetNames.length>0||Array.isArray(e.elementIds)&&e.elementIds.length>0||Array.isArray(e.uniqueIds)&&e.uniqueIds.length>0)}function je(e){return Array.isArray(e)&&e.some(t=>String(t??"").trim())}function rl(e,t,n,r){return t!=="hostOnly"&&je(e.uniqueIds)&&!je(e.elementIds)&&!n&&r.length===0&&e.activeViewOnly!==!0&&!e.viewId&&!je(e.levelIds)&&!je(e.levelNames)&&!e.familyName&&!e.typeName&&!e.systemName&&!je(e.worksetIds)&&!je(e.worksetNames)}function ol(e){let t=String(e||"").trim();return!!(t&&Qs.test(t))}function il(e,t){let n=[],r=0,o=[e.largeModelRisk,e.modelRisk,e.modelSignals,e.sessionSummary].filter(Boolean),i=xn(o,["linkCount","linkInstances","loadedLinks","loadedLinkCount"]),a=xn(o,["worksetCount","worksets"]),s=xn(o,["sheetCount","sheets"]),l=xn(o,["scheduleCount","schedules"]);i!==null&&i>=25?(r+=2,n.push("high_link_count")):i!==null&&i>=10&&(r+=1,n.push("moderate_link_count")),a!==null&&a>=40?(r+=2,n.push("high_workset_count")):a!==null&&a>=20&&(r+=1,n.push("moderate_workset_count")),s!==null&&s>=1e3&&(r+=1,n.push("large_sheet_set")),l!==null&&l>=500&&(r+=1,n.push("large_schedule_set")),!t.boundedScope&&ol(t.originalQuery)&&(r+=3,n.push("generic_unscoped_query")),!t.boundedScope&&!t.originalQuery&&(r+=3,n.push("missing_search_scope")),t.broadLinkedSearch&&(r+=2,n.push("linked_search_without_expensive_approval")),t.verifiedBroadSearch&&(r+=2,n.push("verified_plan_candidates_without_bounded_scope")),t.verifiedVisibilityExpensive&&(r+=2,n.push("verified_visibility_expensive")),(t.searchBudget==="deep"||t.allowExpensiveSearch)&&n.push("operator_approved_expensive_search"),t.boundedScope&&n.length===0&&n.push("bounded_first_pass_scope");let u=r>=4?"high":r>=2?"medium":r>=1||t.boundedScope?"low":"unknown",h=!t.allowExpensiveSearch&&(t.broadLinkedSearch||t.verifiedBroadSearch||t.verifiedVisibilityExpensive||!t.boundedScope&&r>=2);return{riskLevel:u,reasons:n,recommendedFirstScope:tl(e,t.effectiveCategoryNames),requiresUserControl:h}}function Yo(e={}){let t=String(e.query||"").trim(),n=dr(Array.isArray(e.categoryNames)?e.categoryNames:[]),r=Zs(t),o=n.length>0,i=o?n:dr(r.categories),a=r.effectiveQuery||(i.length>n.length?"":t),s=Ys(e.searchBudget),l=Hs[s],u=e.timeoutMs?ur(e.timeoutMs,l.socketTimeoutMs,1e3,12e4):l.socketTimeoutMs,h=Math.max(u,Math.min(12e4,l.maxElapsedMs+2500)),m=ur(e.maxElementsScanned,l.maxElementsScanned,1,5e5),g=Math.min(l.maxElapsedMs,Math.max(1e3,h-2500)),b=ur(e.maxElapsedMs,g,500,Math.max(500,h-1e3)),y=nl(e,i),T=String(e.linkScope||"hostOnly"),P=e.allowExpensiveSearch===!0||s==="deep",te=rl(e,T,t,i),B=T!=="hostOnly"&&!P&&!te,J=String(e.planCandidateMode||(e.includePlanCandidates===!0?"verified":"none")).toLowerCase(),z=e.includePlanCandidates===!0&&J==="verified",X=je(e.elementIds)||je(e.uniqueIds),ye=z&&!y,Re=z&&!X,Ie=il(e,{originalQuery:t,boundedScope:y,effectiveCategoryNames:i,linkScope:T,allowExpensiveSearch:P,broadLinkedSearch:B,verifiedBroadSearch:ye,verifiedVisibilityExpensive:Re,searchBudget:s}),ae=Ie.requiresUserControl,_e=[];return r.matchedConcepts.length>0&&n.length===0&&_e.push("search_scope_inferred_from_mep_terms"),r.matchedConcepts.length>0&&o&&r.categories.some(Kt=>!i.includes(Kt))&&_e.push("explicit_category_scope_preserved_no_inferred_expansion"),B&&_e.push("linked_model_search_requires_allowExpensiveSearch"),ye&&_e.push("verified_plan_candidates_require_bounded_scope"),Re&&_e.push("verified_visibility_requires_exact_targets_or_approval"),Ie.requiresUserControl&&_e.push("search_requires_user_scope_control"),{originalQuery:t,effectiveQuery:a,inferredScope:{source:"runtime_search_policy",concepts:r.matchedConcepts,strippedTerms:r.matchedTerms,categoryNames:r.categories,residualQuery:a},effectiveCategoryNames:i,riskPolicy:Ie,linkScope:T,searchBudget:s,maxElementsScanned:m,maxElapsedMs:b,timeoutMs:h,allowExpensiveSearch:P,guarded:ae,reason:ae?"needs_scope":void 0,message:ae?"This search would scan a broad model surface. Narrow by category, level, active view, system, family/type, sheet/schedule, or explicitly allow an expensive search.":void 0,warnings:_e,suggestedNextScopes:el(e)}}function Ko(e){return{success:!0,guarded:!0,state:"guarded",action:"find_elements",reason:"needs_scope",message:e.message,originalQuery:e.originalQuery,query:e.effectiveQuery,inferredScope:e.inferredScope,effectiveScope:{categoryNames:e.effectiveCategoryNames,searchBudget:e.searchBudget,linkScope:e.linkScope},riskPolicy:e.riskPolicy,scanPolicy:{searchBudget:e.searchBudget,maxElementsScanned:e.maxElementsScanned,maxElapsedMs:e.maxElapsedMs,timeoutMs:e.timeoutMs,allowExpensiveSearch:e.allowExpensiveSearch},suggestedNextScopes:e.suggestedNextScopes,warnings:e.warnings}}import{z as al}from"zod";var Be=al.enum(["compact","full","debug"]).optional().default("compact").describe("Response shape. compact is the default for routine calls; full/debug returns larger diagnostic arrays.");function ze(e){return e==="full"||e==="debug"}function xe(e,t,n){let r=Number.parseInt(String(e??""),10);return!Number.isFinite(r)||r<=0?t:Math.max(1,Math.min(n,r))}function ce(e,t){let n=Array.isArray(e)?e.filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)):[],r=new Set,o=[],i=t.key||zt;for(let s of n){let l=i(s);r.has(l)||(r.add(l),o.push(s))}let a=o.slice(0,Math.max(0,t.limit));return{rows:a,totalCount:n.length,uniqueCount:o.length,returnedCount:a.length,duplicateCount:n.length-o.length,omittedCount:Math.max(0,o.length-a.length)}}function zt(e){return mr(e)}function mr(e){if(e==null)return String(e);if(Array.isArray(e))return`[${e.map(mr).join(",")}]`;if(typeof e=="object"){let t=e;return`{${Object.keys(t).sort().map(n=>`${JSON.stringify(n)}:${mr(t[n])}`).join(",")}}`}return JSON.stringify(e)}var sl=25,ll=25;function Zo(e){if(!e||typeof e!="object"||d(e,"Success","success")===!1)return e;let n=Number(e.count??e.Count??0),r=!!(e.truncated??e.Truncated),o=!!(e.ambiguous??e.Ambiguous),i=String(e.topConfidence??e.TopConfidence??""),a="find_elements is discovery-only and is not sufficient evidence for parameter writes. Before writing, inspect the target with inspect_elements and inspect_parameter_schema using exact matching, then choose a stable element id and parameter identity. Do not write from a visible/display parameter name alone.";return e.writeSafetyWarning=a,e.writeSafety={sufficientForWrite:!1,requiresExactElementIdentity:!0,requiresParameterSchemaPreflight:!0,requiredPreflightTools:["inspect_elements","inspect_parameter_schema"],parameterIdentityRule:"Use builtInParameterId when available; otherwise confirm source/shared/storage/readOnly identity. Display name alone is not a write target.",resultRisk:{count:n,truncated:r,ambiguous:o,topConfidence:i}},typeof e.SelectionHint=="string"&&!e.SelectionHint.includes("find_elements is discovery-only")&&(e.SelectionHint=`${e.SelectionHint} ${a}`),typeof e.selectionHint=="string"&&!e.selectionHint.includes("find_elements is discovery-only")&&(e.selectionHint=`${e.selectionHint} ${a}`),e}function cl(e){let t=e.id??e.Id??e.uniqueId??e.UniqueId??e.elementId??e.ElementId;return t!=null&&t!==""?String(t):zt(e)}function ul(e){return Array.isArray(e.planCandidates)?"planCandidates":Array.isArray(e.PlanCandidates)?"PlanCandidates":null}function he(e,...t){for(let n of t)if(e[n]!==void 0&&e[n]!==null&&e[n]!=="")return e[n]}function dl(e){return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0))}function ml(e){let t=he(e,"id","Id","viewId","ViewId","elementId","ElementId");if(t!==void 0)return String(t);let n=he(e,"name","Name","viewName","ViewName"),r=he(e,"levelId","LevelId","levelName","LevelName");return n!==void 0||r!==void 0?`${String(n??"")}|${String(r??"")}`:zt(e)}function pl(e,t){return dl({ref:t,id:he(e,"id","Id","viewId","ViewId","elementId","ElementId"),name:he(e,"name","Name","viewName","ViewName"),viewType:he(e,"viewType","ViewType"),levelId:he(e,"levelId","LevelId"),levelName:he(e,"levelName","LevelName"),score:he(e,"score","Score","rankScore","RankScore"),rank:he(e,"rank","Rank"),elementVisibleInView:he(e,"elementVisibleInView","ElementVisibleInView"),reason:he(e,"reason","Reason","matchReason","MatchReason")})}function hl(e,t){return{ref:t}}function fl(e,t,n){let r=ul(e);if(!r)return{element:e,totalCandidateRows:0,omittedCandidateRows:0};let o=e[r].filter(s=>!!s&&typeof s=="object"&&!Array.isArray(s)),i=[];for(let s of o){let l=ml(s);n.has(l)||n.set(l,pl(s,l)),i.length<t&&i.push(hl(s,l))}let a={...e};return delete a.planCandidates,delete a.PlanCandidates,a.planCandidateRefs=i,a.planCandidateCount=o.length,a.returnedPlanCandidateRefCount=i.length,a.omittedPlanCandidateRefCount=Math.max(0,o.length-i.length),{element:a,totalCandidateRows:o.length,omittedCandidateRows:Math.max(0,o.length-i.length)}}function gl(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||ze(n))return{...e,responseMode:n};let r=Array.isArray(e.elements)?"elements":Array.isArray(e.Elements)?"Elements":null;if(!r)return{...e,responseMode:"compact"};let o=xe(t.maxResultRows??t.limit,sl,200),i=xe(t.maxPlanCandidates,3,25),a=xe(t.maxPlanCandidateSummaryRows,Math.max(ll,i),100),s=ce(e[r],{limit:o,key:cl}),l=new Map,u=0,h=0,m=s.rows.map(b=>{let y=fl(b,i,l);return u+=y.totalCandidateRows,h+=y.omittedCandidateRows,y.element}),g=ce(Array.from(l.values()),{limit:a,key:b=>String(b.ref??zt(b))});return{...e,responseMode:"compact",[r]:m,planCandidateSummary:{compactResponse:!0,candidateRowCount:u,uniqueCandidateCount:l.size,returnedCandidateCount:g.returnedCount,omittedCandidateCount:g.omittedCount,duplicateCandidateRowCount:Math.max(0,u-l.size),omittedElementCandidateRefCount:h,candidates:g.rows},summary:{...e.summary||e.Summary||{},compactResponse:!0,elementRowCount:s.totalCount,returnedElementRowCount:s.returnedCount,omittedElementRowCount:s.omittedCount,duplicateElementRowCount:s.duplicateCount,planCandidateRowCount:u,uniquePlanCandidateCount:l.size,returnedPlanCandidateCount:g.returnedCount,omittedPlanCandidateCount:g.omittedCount},notices:[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds element rows and deduplicates plan candidates into planCandidateSummary. Use responseMode="full" for per-element plan candidate details.']}}function ei(e){e.tool("find_elements","Find Revit elements by MEP-aware progressive discovery. The tool infers obvious engineering scope first, e.g. fan coil/FCU -> Mechanical Equipment, uses API-level category/view filters plus safe in-memory level filters in the Revit bridge, keeps planCandidateMode=none by default, and asks for allowExpensiveSearch/searchBudget=deep before broad, linked, or verified visibility scans. Default responseMode=compact bounds element rows and deduplicates plan candidates into planCandidateSummary; use responseMode=full for per-element plan candidate details. Discovery-only: inspect exact elements and parameter schema before writes.",{...S(v),...x(v),query:v.string().optional().describe("Text to search in id, unique id, name, category, family, type, mark, and comments."),categoryNames:v.array(v.string()).optional().describe("Category name filters, matched case-insensitively by contains, e.g. Mechanical Equipment, Ducts, Air Terminals. If omitted, common MEP terms such as fan coil/FCU, valve, damper, duct, pipe, sprinkler, pump, and AHU are inferred into a bounded category scope."),elementIds:v.array(v.union([v.number(),v.string()])).optional().describe("Exact element ids to inspect first when known."),uniqueIds:v.array(v.string()).optional().describe("Exact Revit unique ids to inspect first when known."),levelNames:v.array(v.string()).optional().describe("Restrict results to matching element level names, e.g. Level 08."),levelIds:v.array(v.union([v.number(),v.string()])).optional().describe("Restrict results to exact Revit level element ids."),activeViewOnly:v.boolean().optional().describe("Search only elements visible/owned in the active view when true. Preferred for large models when the user is already looking at the target area."),viewId:v.union([v.number(),v.string()]).optional().describe("Search only elements visible/owned in this view id."),familyName:v.string().optional().describe("Optional family-name filter applied before text scoring."),typeName:v.string().optional().describe("Optional type-name filter applied before text scoring."),systemName:v.string().optional().describe("Optional MEP system-name filter applied before text scoring when available."),worksetNames:v.array(v.string()).optional().describe("Optional workset-name filters for workshared production models."),worksetIds:v.array(v.union([v.number(),v.string()])).optional().describe("Optional exact workset ids for workshared production models."),linkScope:v.enum(["hostOnly","linkedOnly","hostAndLinked"]).optional().describe("Host model is searched by default. Linked model search is explicit and may require allowExpensiveSearch/searchBudget=deep on broad requests."),modelSignals:v.object({linkCount:v.number().int().nonnegative().optional(),linkInstances:v.number().int().nonnegative().optional(),loadedLinks:v.number().int().nonnegative().optional(),worksetCount:v.number().int().nonnegative().optional(),sheetCount:v.number().int().nonnegative().optional(),scheduleCount:v.number().int().nonnegative().optional()}).optional().describe("Optional cheap large-model signals from prior context. This never triggers new category counts; it only lets the risk policy use already-known link/workset/sheet/schedule counts."),searchBudget:v.enum(["fast","balanced","deep"]).optional().describe("Preset scan/elapsed budget. fast is default for first-pass discovery; balanced/deep intentionally allow larger scans."),allowExpensiveSearch:v.boolean().optional().describe("Explicit operator approval for broad, linked, all-model, or verified searches that may take longer."),maxElementsScanned:v.number().int().positive().max(5e5).optional().describe("Advanced override for the Revit-side scan cap. Prefer searchBudget for ordinary LLM use."),maxElapsedMs:v.number().int().positive().max(119e3).optional().describe("Advanced override for the Revit-side elapsed budget. This is clamped below socket timeout so partial results can return before transport timeout."),includePlanCandidates:v.boolean().optional().describe("Include existing non-template plan views on each matched element level. Defaults false because view-visibility checks are intentionally expensive."),planCandidateMode:v.enum(["none","metadata","verified"]).optional().describe("Plan candidate strategy. none is fastest and default. metadata ranks same-level plans without verifying element visibility. verified confirms visibility in plan views and is allowed only for exact element targets or explicit expensive-search approval."),maxPlanCandidates:v.number().int().min(0).max(25).optional().describe("Maximum ranked plan candidates per element when planCandidateMode is metadata/verified or includePlanCandidates=true. Defaults 3."),planNameContains:v.string().optional().describe("Optional plan name preference used when ranking plan candidates."),limit:v.number().int().positive().max(200).optional().describe("Maximum elements to return. Defaults 20."),responseMode:Be,maxResultRows:v.number().int().positive().max(200).optional().describe("Compact-mode cap for returned element rows. Defaults to limit or 25; full/debug returns all native rows within limit."),maxPlanCandidateSummaryRows:v.number().int().positive().max(100).optional().describe("Compact-mode cap for the deduplicated top-level planCandidateSummary rows. Defaults 25 so global plan candidates are not capped by the per-element maxPlanCandidates limit."),timeoutMs:v.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{try{let n=Yo(t);if(n.guarded)return p(Zo(Ko(n)));let r=await _("find_elements",{originalQuery:n.originalQuery,query:n.effectiveQuery,categoryNames:n.effectiveCategoryNames,inferredScope:n.inferredScope,elementIds:t.elementIds,uniqueIds:t.uniqueIds,levelNames:t.levelNames,levelIds:t.levelIds,activeViewOnly:t.activeViewOnly===!0,viewId:t.viewId,familyName:t.familyName,typeName:t.typeName,systemName:t.systemName,worksetNames:t.worksetNames,worksetIds:t.worksetIds,linkScope:n.linkScope,searchBudget:n.searchBudget,allowExpensiveSearch:n.allowExpensiveSearch,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,includePlanCandidates:t.includePlanCandidates===!0,planCandidateMode:t.planCandidateMode||(t.includePlanCandidates===!0?"verified":"none"),maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.limit,timeoutMs:n.timeoutMs},{...I({...t,timeoutMs:n.timeoutMs},"Find Revit elements")}),o=r&&r.result?r.result:r;return o&&typeof o=="object"&&(o.inferredScope=o.inferredScope||n.inferredScope,o.effectiveScope=o.effectiveScope||{categoryNames:n.effectiveCategoryNames,linkScope:n.linkScope},o.riskPolicy=o.riskPolicy||n.riskPolicy,o.scanPolicy=o.scanPolicy||{searchBudget:n.searchBudget,maxElementsScanned:n.maxElementsScanned,maxElapsedMs:n.maxElapsedMs,timeoutMs:n.timeoutMs,allowExpensiveSearch:n.allowExpensiveSearch},o.suggestedNextScopes=o.suggestedNextScopes||n.suggestedNextScopes,o.warnings=[...new Set([...Array.isArray(o.warnings)?o.warnings:[],...n.warnings])]),p(gl(Zo(o),t))}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as $}from"zod";var yl=$.union([$.number().int().positive(),$.string().regex(/^\d+$/)]);function vn(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),ViewType:d(e,"ViewType","viewType"),Scale:d(e,"Scale","scale")}}function bl(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),ClassName:d(e,"ClassName","className"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),HasBoundingBox:d(e,"HasBoundingBox","hasBoundingBox")}}function Sl(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Action:d(e,"Action","action"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),ResponseMode:"compact",PlanMode:d(e,"PlanMode","planMode"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),FallbackUsed:d(e,"FallbackUsed","fallbackUsed"),VerifiedCandidateCount:d(e,"VerifiedCandidateCount","verifiedCandidateCount"),RejectedCandidateCount:d(e,"RejectedCandidateCount","rejectedCandidateCount"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),FocusBlocked:d(e,"FocusBlocked","focusBlocked"),FocusBlockReason:d(e,"FocusBlockReason","focusBlockReason"),FocusSuggestion:d(e,"FocusSuggestion","focusSuggestion"),TargetView:vn(d(e,"TargetView","targetView")),SelectedPlan:vn(d(e,"SelectedPlan","selectedPlan")),SuggestedView:vn(d(e,"SuggestedView","suggestedView")),ActiveView:vn(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),Element:bl(d(e,"ElementInfo","elementInfo")),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function ti(e){e.tool("open_existing_plan_for_element_level","Open the best existing non-template plan view for an element's level, then select and zoom to the element. This does not create a new view.",{...S($),...x($),elementId:yl.describe("ElementId to locate in an existing plan view."),planMode:$.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing plan on the element level. activePlan keeps the current active plan and does not switch to the element level. Defaults elementLevel."),planCandidateMode:$.enum(["metadataFirst","verified"]).optional().describe("Plan selection strategy for elementLevel mode. metadataFirst is the default and ranks same-level plans without scanning every candidate view, then verifies a small number of ranked candidates. verified scans all candidate views before selecting and is slower."),fallbackToVerified:$.boolean().optional().describe("When metadataFirst cannot find a visible element within the limited ranked-candidate check, run the slower verified scan before failing. Defaults true."),maxMetadataVerifyCandidates:$.number().int().min(1).max(25).optional().describe("Maximum ranked metadata candidates verified before fallback. Defaults 5."),planNameContains:$.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:$.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:$.boolean().optional().describe("Select the element after activating the plan. Defaults true."),zoom:$.boolean().optional().describe("Zoom/show the element after activating the plan. Defaults true."),fitToScreen:$.boolean().optional().describe("After opening/focusing the plan, run Revit UI ZoomToFit on the active view. Defaults false."),verboseCandidates:$.boolean().optional().describe("Return full PlanCandidates arrays. Defaults false; routine responses return only the top candidates."),maxPlanCandidates:$.number().int().min(0).max(50).optional().describe("Maximum PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:$.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns the raw tool result."),timeoutMs:$.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous plan activation/focus. Defaults 20000.")},async t=>{try{let n=await _("open_existing_plan_for_element_level",{elementId:t.elementId,planMode:t.planMode,planCandidateMode:t.planCandidateMode,fallbackToVerified:t.fallbackToVerified,maxMetadataVerifyCandidates:t.maxMetadataVerifyCandidates,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs},{...I(t,"Open existing plan for element level")}),r=n&&n.result?n.result:n,o=Ke(r,{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"?p(o):p(Sl(o))}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as K}from"zod";var wl=K.union([K.number().int().positive(),K.string().regex(/^\d+$/)]);function ni(e){e.tool("focus_elements","Select and zoom to Revit elements in the active view or in a requested view tab. This is a UI operation and does not open a Revit transaction.",{...S(K),...x(K),elementIds:K.array(wl).min(1).describe("ElementId values to select and show."),viewId:K.number().int().positive().optional().describe("Optional ElementId of the Revit view to activate before focusing elements."),viewName:K.string().optional().describe("Optional name of the Revit view to activate before focusing elements."),viewType:K.string().optional().describe("Optional Revit ViewType filter, such as ThreeD, FloorPlan, Section, Elevation, DrawingSheet, or Schedule."),exactName:K.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),select:K.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:K.boolean().optional().describe("Zoom/show the supplied elements in the active UI view. Defaults true."),fitToScreen:K.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active view. Defaults false."),allowClosedViewSearch:K.boolean().optional().describe("Allow Revit ShowElements to open its modal closed-view search when elements are not visible in the target view. Defaults false to avoid blocking automation."),allowPartial:K.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:K.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous UI activation/focus verification. Defaults 5000; pass a larger value for slow view activation.")},async t=>{try{let n=await _("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:t.allowClosedViewSearch,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...I(t,"Focus Revit elements")});return p(n&&n.result?n.result:n)}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as ne}from"zod";var xl=ne.union([ne.number().int().positive(),ne.string().regex(/^\d+$/)]);function ri(e){e.tool("section_box_elements","Apply a 3D section box around Revit elements, optionally select them, and zoom to them. Requires a 3D view; if viewId/viewName is supplied, that view is activated first.",{...S(ne),...x(ne),elementIds:ne.array(xl).min(1).describe("ElementId values to include in the section box."),viewId:ne.number().int().positive().optional().describe("Optional ElementId of the 3D Revit view to activate and modify."),viewName:ne.string().optional().describe("Optional name of the 3D Revit view to activate and modify."),viewType:ne.string().optional().describe("Optional Revit ViewType filter. For this tool the resolved view must be ThreeD."),exactName:ne.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),paddingMm:ne.number().min(0).max(1e5).optional().describe("Extra space around the element bounding box in millimeters. Defaults 500."),select:ne.boolean().optional().describe("Select the supplied elements after applying the section box. Defaults true."),zoom:ne.boolean().optional().describe("Zoom/show the supplied elements after applying the section box. Defaults true."),allowPartial:ne.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:ne.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous 3D view activation and section box application. Defaults 15000.")},async t=>{try{let n=await _("section_box_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,paddingMm:t.paddingMm,select:t.select,zoom:t.zoom,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...I(t,"Section box Revit elements")});return p(n&&n.result?n.result:n)}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as H}from"zod";var vl=H.union([H.number().int().positive(),H.string().regex(/^\d+$/)]);function oi(e){e.tool("create_3d_view_for_elements","[LIVE_VIEW_NAVIGATION_PRIMITIVE] Create or reuse a 3D Revit view for elements, optionally apply or clear a section box, activate the view, and focus/select the elements. Use this when the user wants to see, open, zoom to, or inspect elements live inside Revit. This can modify the document because views and section boxes are project data.",{...S(H),...x(H),elementIds:H.array(vl).min(1).describe("ElementId values to show in the 3D view."),viewName:H.string().optional().describe("Desired 3D view name. If omitted, a name is generated from the first element id."),reuseExisting:H.boolean().optional().describe("Reuse an existing non-template 3D view with the same name when viewName is supplied. Defaults true."),createIfMissing:H.boolean().optional().describe("Create the 3D view when no reusable view is found. Defaults true."),sectionBox:H.boolean().optional().describe("When true, apply a section box around the elements. When false, any active section box on the target view is cleared. Defaults false."),paddingMm:H.number().min(0).max(1e5).optional().describe("Extra section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:H.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction to apply using the aggregate element bounding box. Defaults unchanged."),framingPaddingMm:H.number().min(0).max(1e5).optional().describe("Extra padding in millimeters for camera orientation/framing when cameraOrientation is not unchanged. Defaults to paddingMm or 500."),activate:H.boolean().optional().describe("Activate the target 3D view. Defaults true."),select:H.boolean().optional().describe("Select the supplied elements after activation. Defaults true."),zoom:H.boolean().optional().describe("Zoom/show the supplied elements after activation. Defaults true."),fitToScreen:H.boolean().optional().describe("After activation/focus, run Revit UI ZoomToFit on the active 3D view. Defaults false."),allowPartial:H.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),timeoutMs:H.number().int().positive().max(12e4).optional().describe("Timeout for asynchronous view creation/activation/focus. Defaults 20000.")},async t=>{try{let n=await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName,reuseExisting:t.reuseExisting,createIfMissing:t.createIfMissing,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:t.activate,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs},{...I(t,"Create 3D view for elements")});return p(n&&n.result?n.result:n)}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import Cl from"node:os";import ii from"node:path";import{z as V}from"zod";var Tl=V.enum(["raw_evidence","coordination_overlay","system_focus","clash_clearance"]),Rl=V.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Il=V.enum(["72","150","300","600"]),_l=V.enum(["horizontal","vertical"]),Ml=V.enum(["auto","qa_high_contrast","technical_report","outline_only","raw"]),Nl={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},El={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},kl={horizontal:"Horizontal",vertical:"Vertical"};function Pl(){return ii.join(Cl.tmpdir(),"revit-mcp-image-export")}function Al(e){return(e&&e.trim()?e.trim():`revit-coordination-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function Ol(e){let t=e||[],n=[],r=[];for(let o of t){if(typeof o=="number"){Number.isSafeInteger(o)&&o>0?n.push(o):r.push(o);continue}let i=String(o).trim();if(/^\d+$/.test(i)){let a=Number(i);if(Number.isSafeInteger(a)&&a>0){n.push(a);continue}}r.push(o)}return{ids:n,invalid:r,suppliedCount:t.length}}function Vl(e){return`new List<int> { ${e.map(n=>Math.trunc(n)).join(", ")} }`}function Dl(e){return e==="raw_evidence"?"raw":e==="coordination_overlay"?"outline_only":"technical_report"}function ai(e){e.tool("export_revit_coordination_image","[VISUAL_ARTIFACT_EXPORT_ONLY] Create or reuse a visual QA 3D view, optionally section-box target elements, apply a selectable target visual style, and export an image artifact. Auto style is report-friendly and never selects qa_high_contrast by itself. Use qa_high_contrast explicitly for debug/LLM evidence, technical_report or outline_only for report-style evidence, and raw when the target must keep native appearance. Use this when the user asks for PNG/JPEG/report/LLM visual evidence. If elementIds are provided but none are found, it returns guarded no_requested_elements_found unless allowFullViewFallback=true is explicit. Do not use this as the primary tool for live view navigation, selected-element zoom, or opening an element in a Revit view; for that workflow use create_3d_view_for_elements or show_element_in_plan_and_3d, then optionally export the active view with export_revit_view_image. It only writes review view settings; it does not create or modify MEP model elements. Set cleanupAfterExport=true when a newly created review view should be deleted after the image file is produced.",{...S(V),intent:Tl.optional().default("coordination_overlay"),targetVisualStyle:Ml.optional().default("auto").describe("Target override style. auto is report-friendly: raw_evidence -> raw, coordination_overlay -> outline_only, system_focus/clash_clearance -> technical_report. qa_high_contrast is used only when explicitly requested. raw applies no target override."),elementIds:V.array(V.union([V.number(),V.string()])).optional().describe("Optional element ids to focus/highlight. When provided, the review view receives a section box around these elements."),viewName:V.string().optional().default("DPE Visual QA - Coordination Export"),marginMm:V.number().min(0).max(2e4).optional().default(2e3),singleElementMarginMm:V.number().min(0).max(2e4).optional().default(300).describe("Maximum section-box margin when exactly one target element is exported. This keeps single-element QA exports tightly framed."),contextTransparency:V.number().int().min(0).max(90).optional().default(65),pixelSize:V.number().int().min(200).max(1e4).optional().default(4e3).describe("Final image size for the requested fit direction after crop/downsample. For coordination crops, Revit may export a higher-resolution source first."),preExportPixelSize:V.number().int().min(0).max(2e4).optional().default(0).describe("Optional Revit source export size before crop/downsample. Use 0 or omit for automatic high-resolution source export on single-target model-projection crops."),maxAutoPreExportPixelSize:V.number().int().min(1e3).max(2e4).optional().default(1e4).describe("Upper bound for automatic high-resolution source exports used before single-target model-projection crops."),allowFinalUpscale:V.boolean().optional().default(!1).describe("When false, model-projection crops are widened instead of enlarging a tiny source crop to the final pixelSize. This preserves image quality even when targetMinFillRatio cannot be reached within Revit's source export limit."),enforcePixelSize:V.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the final requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),cropToTargetHighlight:V.boolean().optional().default(!0).describe("When true, tightens the Revit 3D view crop box from model bbox/camera projection. Raster highlight pixels are QA metrics only unless Revit model crop-box framing is unavailable."),targetMinFillRatio:V.number().min(.1).max(.9).optional().default(.4).describe("Minimum target occupancy used when sizing model-bounding-box projection crops. Raster highlight fill, when detected, is reported separately as QA."),highlightCropPaddingPx:V.number().int().min(0).max(2e3).optional().default(24).describe("Debug fallback padding for highlight-pixel crops when model projection is not available."),allowFullViewFallback:V.boolean().optional().default(!1).describe("When elementIds are provided but none are found, allow exporting the full review 3D view instead of returning guarded. Defaults false to avoid misleading element evidence."),dpi:Il.optional().default("300"),fitDirection:_l.optional().default("horizontal"),format:Rl.optional().default("png"),outputDir:V.string().optional(),filePrefix:V.string().optional(),cleanupAfterExport:V.boolean().optional().default(!1).describe("When true, a review view created by this call is deleted after export. Existing reused review views are never deleted automatically."),...x(V),timeoutMs:V.number().int().positive().optional()},async t=>{let n=Ol(t.elementIds);if(n.invalid.length>0)return p(Ce({action:"export_revit_coordination_image",reason:"invalid_element_ids",error:"elementIds must be positive integer Revit ElementId values. UniqueId strings or other non-numeric ids are not valid target evidence ids.",extra:{revitWriteAction:"none",requestedElementCount:n.suppliedCount,validElementCount:n.ids.length,invalidElementIds:n.invalid}}));let r=ii.resolve(t.outputDir||Pl()),o=Al(t.filePrefix),i=t.intent||"coordination_overlay",a=t.targetVisualStyle||"auto",s=a==="auto"?Dl(i):a,l=Nl[t.format||"png"],u=El[String(t.dpi||"150")],h=kl[t.fitDirection||"horizontal"],m=Math.trunc(t.pixelSize||4e3),g=Number.isFinite(Number(t.preExportPixelSize))?Math.max(0,Math.trunc(Number(t.preExportPixelSize))):0,b=Number.isFinite(Number(t.maxAutoPreExportPixelSize))?Math.max(1e3,Math.min(2e4,Math.trunc(Number(t.maxAutoPreExportPixelSize)))):1e4,y=t.allowFinalUpscale===!0,T=Number.isFinite(Number(t.marginMm))?Number(t.marginMm):2e3,P=Number.isFinite(Number(t.singleElementMarginMm))?Number(t.singleElementMarginMm):300,te=t.enforcePixelSize!==!1,B=t.cropToTargetHighlight!==!1,J=Number.isFinite(Number(t.targetMinFillRatio))?Math.max(.1,Math.min(.9,Number(t.targetMinFillRatio))):.4,z=Number.isFinite(Number(t.highlightCropPaddingPx))?Math.trunc(t.highlightCropPaddingPx):24,X=t.allowFullViewFallback===!0,ye=Math.trunc(t.contextTransparency??65),Re=t.cleanupAfterExport===!0,Ie=`
var warnings = new List<string>();
var notices = new List<string>();
string outputDir = ${R(r)};
string filePrefix = ${R(o)};
string desiredViewName = ${R(t.viewName||"DPE Visual QA - Coordination Export")};
string intent = ${R(i)};
string targetVisualStyle = ${R(s)};
var requestedElementIds = ${Vl(n.ids)};
double marginFeet = ${T} / 304.8;
double singleElementMarginFeet = ${P} / 304.8;
int contextTransparency = ${ye};
int requestedPixelSize = ${m};
int requestedPreExportPixelSize = ${g};
int maxAutoPreExportPixelSize = ${b};
int revitExportPixelSize = requestedPixelSize;
bool autoPreExportPixelSize = requestedPreExportPixelSize <= 0;
string preExportPixelSizeReason = "same_as_final_pixel_size";
string requestedFitDirection = ${R(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${te?"true":"false"};
bool cropToTargetHighlight = ${B?"true":"false"};
bool allowFinalUpscale = ${y?"true":"false"};
double targetMinFillRatio = ${J};
int highlightCropPaddingPx = ${z};
bool allowFullViewFallback = ${X?"true":"false"};
bool cleanupAfterExport = ${Re?"true":"false"};

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
options.FitDirection = FitDirectionType.${h};
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

double effectiveMarginMm = targetElements.Count == 1 ? Math.Min(${T}, ${P}) : ${T};
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
  format = ${R(t.format||"png")},
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
  marginMm = ${T},
  singleElementMarginMm = ${P},
  effectiveMarginMm = effectiveMarginMm,
  dpi = ${R(String(t.dpi||"300"))},
  fitDirection = ${R(t.fitDirection||"horizontal")},
  files = files,
  warnings = warnings,
  notices = notices
};`;try{let ae=await U(Ie,{...I(t,"Export Revit coordination image"),taskType:"export_revit_coordination_image",transactionMode:"auto"});return p(ae?.result??ae)}catch(ae){return p(pe({action:"export_revit_coordination_image",error:ae instanceof Error?ae.message:String(ae),extra:{tool:"export_revit_coordination_image"}}))}})}import Fl from"node:os";import si from"node:path";import{z as Q}from"zod";var Ll=Q.enum(["current_view","visible_region","set_of_views"]),jl=Q.enum(["png","jpg_lossless","jpg_medium","tiff","bmp","targa"]),Bl=Q.enum(["72","150","300","600"]),zl=Q.enum(["horizontal","vertical"]),ql={png:"PNG",jpg_lossless:"JPEGLossless",jpg_medium:"JPEGMedium",tiff:"TIFF",bmp:"BMP",targa:"TARGA"},Wl={72:"DPI_72",150:"DPI_150",300:"DPI_300",600:"DPI_600"},Gl={horizontal:"Horizontal",vertical:"Vertical"};function Jl(){return si.join(Fl.tmpdir(),"revit-mcp-image-export")}function Ul(e){return(e&&e.trim()?e.trim():`revit-view-${new Date().toISOString().replace(/[:.]/g,"-")}`).replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").slice(0,120)}function Hl(e){if(e==null||e==="")return"null";let t=Number(e);return Number.isFinite(t)?String(Math.trunc(t)):"null"}function li(e){e.tool("export_revit_view_image","[VISUAL_ARTIFACT_EXPORT] Export the active Revit view, DrawingSheet, Schedule view, or a selected view/sheet to PNG/JPEG/TIFF/BMP/TARGA using Document.ExportImage. Use this when the user asks for a raw image file, report/evidence screenshot, schedule/sheet export, or LLM visual artifact from an existing view. Ordinary view/sheet exports do not modify Revit. Direct schedule export creates a temporary sheet, exports it, and deletes that sheet before the wrapper transaction commits.",{...S(Q),viewId:Q.union([Q.number(),Q.string()]).optional().describe("Optional Revit view id. When supplied, export uses set_of_views because Revit cannot export a non-active visible region."),viewName:Q.string().optional().describe("Optional exact or partial view name. When supplied, export uses set_of_views unless range is explicitly current/visible."),exactName:Q.boolean().optional().default(!0),range:Ll.optional().describe("current_view and visible_region use the active UI view. set_of_views can export viewId/viewName without switching the UI."),format:jl.optional().default("png"),pixelSize:Q.number().int().min(200).max(1e4).optional().default(6e3),enforcePixelSize:Q.boolean().optional().default(!0).describe("When true, post-processes PNG/JPEG/BMP/TIFF output so the requested fit direction dimension equals pixelSize. TARGA cannot be resized by this tool."),zoom:Q.number().int().min(1).max(1e3).optional().default(100),dpi:Bl.optional().default("300"),fitDirection:zl.optional().default("horizontal"),outputDir:Q.string().optional(),filePrefix:Q.string().optional(),allowTemporaryScheduleSheet:Q.boolean().optional().default(!0).describe("When true, standalone Schedule views are exported through a temporary sheet that is deleted before the wrapper transaction commits. When false, schedule views return guidance with containing sheet candidates."),...x(Q),timeoutMs:Q.number().int().positive().optional()},async t=>{let n=t.viewId!==void 0||!!t.viewName,r=t.range??(n?"set_of_views":"current_view"),o=si.resolve(t.outputDir||Jl()),i=Ul(t.filePrefix),a=ql[t.format||"png"],s=Wl[String(t.dpi||"150")],l=Gl[t.fitDirection||"horizontal"],u=Math.trunc(t.pixelSize||6e3),h=t.enforcePixelSize!==!1,m=Math.trunc(t.zoom||100),g=t.allowTemporaryScheduleSheet!==!1,b=`
var warnings = new List<string>();
var notices = new List<string>();
string requestedRange = ${R(r)};
string outputDir = ${R(o)};
string filePrefix = ${R(i)};
string viewNameInput = ${R(t.viewName||"")};
int? viewIdInput = ${Hl(t.viewId)};
bool exactName = ${t.exactName===!1?"false":"true"};
bool selectorProvided = viewIdInput.HasValue || !String.IsNullOrWhiteSpace(viewNameInput);
int requestedPixelSize = ${u};
string requestedFitDirection = ${R(t.fitDirection||"horizontal")};
bool enforcePixelSize = ${h?"true":"false"};
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
  format = ${R(t.format||"png")},
  pixelSize = ${u},
  requestedPixelSize = ${u},
  enforcePixelSize = enforcePixelSize,
  pixelSizeNote = enforcePixelSize
    ? "PNG/JPEG/BMP/TIFF output is post-processed so the requested fit-direction dimension equals requestedPixelSize. TARGA reports actual Revit output dimensions."
    : "pixelSize is the Revit export request. Check files[].width and files[].height for actual output dimensions.",
  dpi = ${R(String(t.dpi||"300"))},
  fitDirection = ${R(t.fitDirection||"horizontal")},
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
};`;try{let y=await U(b,{...I(t,"Export Revit view image"),taskType:"export_revit_view_image",transactionMode:g?"auto":"none"});return p(y?.result??y)}catch(y){return p(pe({action:"export_revit_view_image",error:y instanceof Error?y.message:String(y),extra:{tool:"export_revit_view_image"}}))}})}import{z as D}from"zod";var $l=D.union([D.number().int().positive(),D.string().regex(/^\d+$/)]);function pr(e){return e&&e.result?e.result:e}function hr(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function Ql(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Xl(e,t){return`3D - Focus ${t&&(t.FamilyName||t.TypeName||t.Name)?String(t.FamilyName||t.TypeName||t.Name):"Element"} ${e}`.replace(/[{}[\];<>?`~]/g,"").slice(0,90)}function Yl(e){return!e||typeof e!="object"?e:{Id:d(e,"Id","id"),Name:d(e,"Name","name"),Category:d(e,"Category","category"),FamilyName:d(e,"FamilyName","familyName"),TypeName:d(e,"TypeName","typeName"),LevelId:d(e,"LevelId","levelId"),LevelName:d(e,"LevelName","levelName"),Mark:d(e,"Mark","mark"),MatchScore:d(e,"MatchScore","matchScore"),MatchConfidence:d(e,"MatchConfidence","matchConfidence")}}function qt(e){return!e||typeof e!="object"?e:{Id:e.Id??e.id,Name:e.Name??e.name,ViewType:e.ViewType??e.viewType,Scale:e.Scale??e.scale}}function Kl(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Count:d(e,"Count","count"),Truncated:d(e,"Truncated","truncated"),Ambiguous:d(e,"Ambiguous","ambiguous"),TopScore:d(e,"TopScore","topScore"),TopConfidence:d(e,"TopConfidence","topConfidence"),TopScoreTiedCount:d(e,"TopScoreTiedCount","topScoreTiedCount"),PlanCandidateMode:d(e,"PlanCandidateMode","planCandidateMode"),SelectionHint:d(e,"SelectionHint","selectionHint")}}function Zl(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),PlanMode:d(e,"PlanMode","planMode"),PlanOpenMode:d(e,"PlanOpenMode","planOpenMode"),PlanOpenNote:d(e,"PlanOpenNote","planOpenNote"),SelectedPlan:qt(d(e,"SelectedPlan","selectedPlan")),TargetView:qt(d(e,"TargetView","targetView")),ActiveView:qt(d(e,"ActiveView","activeView")),ActiveViewChanged:d(e,"ActiveViewChanged","activeViewChanged"),ActivePlanMatchesElementLevel:d(e,"ActivePlanMatchesElementLevel","activePlanMatchesElementLevel"),PlanSelectionReason:d(e,"PlanSelectionReason","planSelectionReason"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed"),FitToScreen:d(e,"FitToScreen","fitToScreen"),FitToScreenWarning:d(e,"FitToScreenWarning","fitToScreenWarning"),PlanVisibilityWarning:d(e,"PlanVisibilityWarning","planVisibilityWarning"),FocusWarning:d(e,"FocusWarning","focusWarning"),PlanCandidatesTotal:d(e,"PlanCandidatesTotal","planCandidatesTotal"),PlanCandidatesTruncated:d(e,"PlanCandidatesTruncated","planCandidatesTruncated")}}function ec(e){return!e||typeof e!="object"?e:{Success:d(e,"Success","success"),Message:d(e,"Message","message"),Error:d(e,"Error","error"),TargetView:qt(d(e,"TargetView","targetView")),ActiveView:qt(d(e,"ActiveView","activeView")),CreatedView:d(e,"CreatedView","createdView"),ReusedView:d(e,"ReusedView","reusedView"),SectionBoxApplied:d(e,"SectionBoxApplied","sectionBoxApplied"),SectionBoxState:d(e,"SectionBoxState","sectionBoxState"),CameraOrientation:d(e,"CameraOrientation","cameraOrientation"),CameraApplied:d(e,"CameraApplied","cameraApplied"),CameraWarning:d(e,"CameraWarning","cameraWarning"),ZoomMethod:d(e,"ZoomMethod","zoomMethod"),Selected:d(e,"Selected","selected"),Zoomed:d(e,"Zoomed","zoomed")}}function tc(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function Ae(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"show_element_in_plan_and_3d",message:e.message,error:e.error,resultContractVersion:tc(e.find,e.plan,e.threeD),chosenElementId:e.chosenElementId,chosenElement:e.chosenElement,find:e.find,plan:e.plan,threeD:e.threeD,ambiguous:e.ambiguous,candidates:e.candidates}}function ci(e){e.tool("show_element_in_plan_and_3d","[LIVE_VIEW_WORKFLOW_WRAPPER] Safely find or use one Revit element, show it in an existing plan, then optionally call create_3d_view_for_elements to create/reuse a focused 3D view. Use this when the user wants a combined plan plus 3D live Revit view workflow. Ambiguous search results are rejected by default for large-project safety.",{...S(D),...x(D),elementId:$l.optional().describe("Known ElementId. When supplied, search is skipped."),query:D.string().optional().describe("Text query used when elementId is not supplied."),categoryNames:D.array(D.string()).optional().describe("Category name filters for the search, e.g. Mechanical Equipment."),searchLimit:D.number().int().positive().max(200).optional().describe("Maximum search candidates to inspect. Defaults 20."),allowAmbiguous:D.boolean().optional().describe("Allow the top search result to be used even when multiple plausible matches exist. Defaults false."),planMode:D.enum(["elementLevel","activePlan"]).optional().describe("elementLevel opens the best existing same-level plan. activePlan keeps the current active plan. Defaults elementLevel."),planNameContains:D.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level."),preferMechanical:D.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),includeSearchPlanCandidates:D.boolean().optional().describe("Include plan candidates during the initial search. Defaults false; the plan-open step computes focused candidates separately."),verboseCandidates:D.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:D.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:D.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),select:D.boolean().optional().describe("Select the element in plan/3D. Defaults true."),zoom:D.boolean().optional().describe("Show/zoom the element in plan/3D. Defaults true."),fitToScreen:D.boolean().optional().describe("Run Revit UI ZoomToFit after focusing views. Defaults false."),create3d:D.boolean().optional().describe("Create or reuse a focused 3D view after the plan step. Defaults true."),viewName:D.string().optional().describe("Desired 3D view name. If omitted, one is generated from the selected element."),reuseExisting3d:D.boolean().optional().describe("Reuse an existing 3D view with the same name. Defaults true."),sectionBox:D.boolean().optional().describe("Apply a 3D section box around the element. Defaults false."),paddingMm:D.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),cameraOrientation:D.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction. Defaults unchanged."),framingPaddingMm:D.number().min(0).max(1e5).optional().describe("Padding in millimeters for camera orientation/framing. Defaults to paddingMm or 500."),timeoutMs:D.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=I(t,"Show element in plan and 3D"),r=t.elementId,o=null,i=null;if(!r){if(!t.query&&(!t.categoryNames||t.categoryNames.length===0))return p(Ae({success:!1,guarded:!0,error:"Pass elementId, or pass query/categoryNames for a safe search."}));if(i=pr(await _("find_elements",{query:t.query,categoryNames:t.categoryNames,includePlanCandidates:t.includeSearchPlanCandidates===!0,maxPlanCandidates:t.maxPlanCandidates??3,planNameContains:t.planNameContains,limit:t.searchLimit||20,timeoutMs:t.timeoutMs,taskName:"Find element for plan and 3D presentation"},n)),!i||!hr(i))return p(Ae({success:!1,error:d(i,"Error","error")||"Element search failed.",find:i}));let h=Array.isArray(d(i,"Elements","elements"))?d(i,"Elements","elements"):[];if(h.length===0)return p(Ae({success:!1,guarded:!0,error:"No matching elements were found.",find:i}));if(d(i,"Ambiguous","ambiguous")&&t.allowAmbiguous!==!0)return p(Ae({success:!1,guarded:!0,error:"Multiple plausible elements matched. Use a more specific query or pass elementId before opening views.",ambiguous:!0,find:i,candidates:h}));if(o=h[0]||null,!o)return p(Ae({success:!1,guarded:!0,error:"No usable element candidate was returned.",find:i}));r=d(o,"Id","id")}if(r==null)return p(Ae({success:!1,guarded:!0,error:"No element id was resolved.",find:i}));let a=pr(await _("open_existing_plan_for_element_level",{elementId:r,planMode:t.planMode,planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3,responseMode:"full",timeoutMs:t.timeoutMs,taskName:"Show element in existing plan"},n));if(!a||!hr(a))return p(Ae({success:!1,guarded:Ql(a),error:d(a,"Error","error")||"Plan presentation failed.",chosenElementId:r,chosenElement:o,find:i,plan:a}));let s=null;t.create3d!==!1&&(s=pr(await _("create_3d_view_for_elements",{elementIds:[r],viewName:t.viewName||Xl(r,o),reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Show element in focused 3D view"},n)));let l=t.create3d===!1||hr(s),u=Ke(Ae({success:l,message:t.create3d===!1?"Element was shown in an existing plan.":l?"Element was shown in an existing plan and focused in 3D.":"Element was shown in plan, but the 3D step failed.",chosenElementId:r,chosenElement:o,find:i,plan:a,threeD:s}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return t.responseMode==="full"||!l?p(u):p({success:d(u,"Success","success"),guarded:d(u,"Guarded","guarded")===!0,state:d(u,"State","state"),action:d(u,"Action","action"),message:d(u,"Message","message"),error:d(u,"Error","error"),resultContractVersion:d(u,"ResultContractVersion","resultContractVersion"),responseMode:"compact",chosenElementId:r,chosenElement:Yl(o),findSummary:Kl(i),planSummary:Zl(a),threeDSummary:ec(s)})}catch(n){return p(Ae({success:!1,error:n instanceof Error?n.message:String(n)}))}})}import{z as F}from"zod";var nc=F.union([F.number().int().positive(),F.string().regex(/^\d+$/)]);function Cn(e){return e&&e.result?e.result:e}function Tn(e){return!e||typeof e!="object"?!1:d(e,"Success","success")!==!1}function ui(e){return!e||typeof e!="object"?!1:d(e,"Guarded","guarded")===!0||d(e,"State","state")==="guarded"||d(e,"FocusBlocked","focusBlocked")===!0}function Rn(e){return!e||typeof e!="object"?e||null:{id:e.Id??e.id,name:e.Name??e.name,viewType:e.ViewType??e.viewType,isActive:e.IsActive??e.isActive,isOpen:e.IsOpen??e.isOpen,isSectionBoxActive:e.IsSectionBoxActive??e.isSectionBoxActive}}function fr(e){if(!e||typeof e!="object")return e||null;let t=e.PlanCandidates??e.planCandidates;return{success:d(e,"Success","success"),message:d(e,"Message","message"),error:d(e,"Error","error"),focusBlocked:e.FocusBlocked??e.focusBlocked,focusBlockReason:e.FocusBlockReason??e.focusBlockReason,focusSuggestion:e.FocusSuggestion??e.focusSuggestion,changed:e.Changed??e.changed,selected:e.Selected??e.selected,zoomed:e.Zoomed??e.zoomed,activeViewChanged:e.ActiveViewChanged??e.activeViewChanged,planOpenMode:e.PlanOpenMode??e.planOpenMode,levelName:e.LevelName??e.levelName,activeView:Rn(e.ActiveView??e.activeView),targetView:Rn(e.TargetView??e.targetView),selectedPlan:Rn(e.SelectedPlan??e.selectedPlan),suggestedView:Rn(e.SuggestedView??e.suggestedView),planCandidatesTotal:Array.isArray(t)?t.length:e.PlanCandidatesTotal??e.planCandidatesTotal,planCandidatesTruncated:e.PlanCandidatesTruncated??e.planCandidatesTruncated,createdView:e.CreatedView??e.createdView,reusedView:e.ReusedView??e.reusedView,sectionBoxApplied:e.SectionBoxApplied??e.sectionBoxApplied,cameraOrientation:e.CameraOrientation??e.cameraOrientation,cameraApplied:e.CameraApplied??e.cameraApplied}}function di(e){return{success:d(e,"Success","success"),guarded:d(e,"Guarded","guarded")===!0,state:d(e,"State","state"),action:d(e,"Action","action"),message:d(e,"Message","message"),error:d(e,"Error","error"),resultContractVersion:d(e,"ResultContractVersion","resultContractVersion"),responseMode:"compact",mode:e.mode??e.Mode,usedStep:e.usedStep??e.UsedStep,focusSummary:fr(e.focus??e.Focus),planSummary:fr(e.plan??e.Plan),threeDSummary:fr(e.threeD??e.ThreeD)}}function rc(...e){for(let t of e){let n=d(t,"ResultContractVersion","resultContractVersion"),r=Number.parseInt(String(n??""),10);if(Number.isFinite(r))return r}return null}function Wt(e){let t=e.guarded===!0;return{success:e.success,guarded:t,state:t?"guarded":e.success?"completed":"failed",action:"smart_focus_elements",message:e.message,error:e.error,resultContractVersion:rc(e.focus,e.plan,e.threeD),mode:e.mode,usedStep:e.usedStep,focus:e.focus,plan:e.plan,threeD:e.threeD}}function mi(e){e.tool("smart_focus_elements","[LIVE_VIEW_WORKFLOW_WRAPPER] Focus Revit elements without triggering Revit's modal closed-view search. It can try the active/requested view first, then open the best existing same-level plan, and optionally create/reuse a 3D view. When create3d=true, the 3D step runs after whichever live focus step succeeds. Use this for live Revit focus/navigation, not image artifact export.",{...S(F),...x(F),elementIds:F.array(nc).min(1).describe("ElementId values to select and show."),mode:F.enum(["activeOnly","activeThenElementLevelPlan","elementLevelPlan"]).optional().describe("activeOnly only tries the active/requested view. activeThenElementLevelPlan falls back to an existing same-level plan. elementLevelPlan skips the active view and opens the same-level plan. Defaults activeThenElementLevelPlan."),viewId:F.number().int().positive().optional().describe("Optional target view id for the first focus attempt."),viewName:F.string().optional().describe("Optional target view name for the first focus attempt."),viewType:F.string().optional().describe("Optional Revit ViewType filter for the first focus attempt."),exactName:F.boolean().optional().describe("When viewName is used, require exact case-insensitive name match. Defaults true."),planNameContains:F.string().optional().describe("Optional plan name preference such as HVAC, Mechanical, or Roof Level for same-level fallback."),preferMechanical:F.boolean().optional().describe("Prefer HVAC/mechanical/MEP named plans on the same level. Defaults true."),select:F.boolean().optional().describe("Select the supplied elements. Defaults true."),zoom:F.boolean().optional().describe("Zoom/show the supplied elements. Defaults true."),fitToScreen:F.boolean().optional().describe("Run Revit UI ZoomToFit after focus. Defaults false."),create3d:F.boolean().optional().describe("After the successful active/requested-view or plan focus step, create/reuse a focused 3D view for all supplied elements. Defaults false."),viewName3d:F.string().optional().describe("Desired 3D view name when create3d=true."),reuseExisting3d:F.boolean().optional().describe("Reuse an existing 3D view with the same name when create3d=true. Defaults true."),sectionBox:F.boolean().optional().describe("Apply a section box in the 3D view when create3d=true. Defaults false."),cameraOrientation:F.enum(["unchanged","isometric","top","front","back","left","right"]).optional().describe("Optional 3D camera direction when create3d=true. Defaults unchanged."),framingPaddingMm:F.number().min(0).max(1e5).optional().describe("Padding in millimeters for 3D camera framing. Defaults to paddingMm or 500."),paddingMm:F.number().min(0).max(1e5).optional().describe("Section box padding in millimeters when sectionBox=true. Defaults 500."),allowPartial:F.boolean().optional().describe("Continue when some supplied element ids are not found. Defaults false."),verboseCandidates:F.boolean().optional().describe("Return full PlanCandidates arrays from nested steps. Defaults false."),maxPlanCandidates:F.number().int().min(0).max(50).optional().describe("Maximum nested PlanCandidates returned when verboseCandidates=false. Defaults 3."),responseMode:F.enum(["compact","full"]).optional().describe("Response shape. compact is the default for successful routine calls; full returns nested raw tool results."),timeoutMs:F.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=I(t,"Smart focus Revit elements"),r=t.mode||"activeThenElementLevelPlan",o=null,i=null,a=null;if(r!=="elementLevelPlan"){if(o=Cn(await _("focus_elements",{elementIds:t.elementIds,viewId:t.viewId,viewName:t.viewName,viewType:t.viewType,exactName:t.exactName,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowClosedViewSearch:!1,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Try focus elements in active/requested view"},n)),o&&Tn(o)){t.create3d===!0&&(a=Cn(await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view after active/requested focus"},n)));let h=t.create3d===!0?!!(a&&Tn(a)):!0,m=Ke(Wt({success:h,message:t.create3d===!0?h?"Elements were focused in the active/requested view and focused in 3D.":"Elements were focused in the active/requested view, but the 3D step failed.":"Elements were focused in the active/requested view.",mode:r,usedStep:t.create3d===!0?"activeOrRequestedViewThen3D":"activeOrRequestedView",focus:o,threeD:a}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return p(t.responseMode==="full"||!h?m:di(m))}let u=ui(o);if(r==="activeOnly"||!o||!u)return p(Wt({success:!1,guarded:u,mode:r,error:d(o,"Error","error")||"Active/requested view focus failed.",focus:o}))}if(i=Cn(await _("open_existing_plan_for_element_level",{elementId:t.elementIds[0],planMode:"elementLevel",planNameContains:t.planNameContains,preferMechanical:t.preferMechanical,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,timeoutMs:t.timeoutMs,taskName:"Smart focus fallback to same-level existing plan"},n)),!i||!Tn(i))return p(Wt({success:!1,guarded:ui(i),mode:r,error:d(i,"Error","error")||"Same-level existing plan focus failed.",focus:o,plan:i}));t.create3d===!0&&(a=Cn(await _("create_3d_view_for_elements",{elementIds:t.elementIds,viewName:t.viewName3d,reuseExisting:t.reuseExisting3d,createIfMissing:!0,sectionBox:t.sectionBox,paddingMm:t.paddingMm,cameraOrientation:t.cameraOrientation,framingPaddingMm:t.framingPaddingMm,activate:!0,select:t.select,zoom:t.zoom,fitToScreen:t.fitToScreen,allowPartial:t.allowPartial,timeoutMs:t.timeoutMs,taskName:"Smart focus optional 3D view"},n)));let s=t.create3d===!0?!!(a&&Tn(a)):!0,l=Ke(Wt({success:s,message:t.create3d===!0?s?"Elements were focused in a same-level plan and focused in 3D.":"Elements were focused in a same-level plan, but the 3D step failed.":"Elements were focused in a same-level plan.",mode:r,usedStep:t.create3d===!0?"elementLevelPlanThen3D":"elementLevelPlan",focus:o,plan:i,threeD:a}),{verboseCandidates:t.verboseCandidates,maxPlanCandidates:t.maxPlanCandidates??3});return p(t.responseMode==="full"||!s?l:di(l))}catch(n){return p(Wt({success:!1,mode:t.mode||"unknown",error:n instanceof Error?n.message:String(n)}))}})}import{z as ue}from"zod";async function oc(e,t){let r=(Array.isArray(e.elementIds)?e.elementIds:[]).map(o=>Number.parseInt(String(o),10)).filter(o=>Number.isFinite(o)&&o>0);return e.useSelection&&(r=r.concat(await pt(e.limit||20,t))),[...new Set(r)].slice(0,e.limit||20)}function ic(e,t){let n=Sn(e),r=t.includeParameters!==!1?"true":"false",o=t.includeTypeParameters===!0?"true":"false",i=t.includeConnectors!==!1?"true":"false",a=we(t.parameterNames||[]);return`
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
}`}function pi(e){e.tool("inspect_elements","Read-only inspection for selected or targeted Revit elements: class/category/type/level/key parameters/connector summary.",{...S(ue),...x(ue),elementIds:ue.array(ue.union([ue.number(),ue.string()])).optional().describe("Element ids to inspect."),useSelection:ue.boolean().optional().describe("When true, inspect the current Revit selection."),limit:ue.number().int().positive().max(100).optional().describe("Maximum elements to inspect. Defaults 20."),includeParameters:ue.boolean().optional().describe("Include key or requested parameter summaries. Defaults true."),includeTypeParameters:ue.boolean().optional().describe("Also inspect matching type parameters. Defaults false."),includeConnectors:ue.boolean().optional().describe("Include connector counts when available. Defaults true. When false, connectorCount/openConnectorCount are null and connectorsIncluded=false."),parameterNames:ue.array(ue.string()).optional().describe("Optional targeted parameter names.")},async t=>{let n=Y(t);try{let r=await oc(t,n);if(r.length===0)return p({success:!0,elements:[],warnings:["No element ids supplied and no selected elements found."]});let o=await U(ic(r,t),{...n,...se(t,"Inspect Revit elements"),transactionMode:"none"});return p(o&&o.result?o.result:o)}catch(r){return p({success:!1,error:r instanceof Error?r.message:String(r)})}})}import{z as E}from"zod";var ac=["completed","max_elapsed","max_rows","max_columns","max_cells","max_items","max_bytes","read_failed","needs_scope"],sc=["lastReadSection","lastReadRow","lastReadColumn","lastReadSheetId","lastReadViewId","lastReadViewportId","lastReadItemId"],lc=new Set(ac),cc={done:"completed",success:"completed",timeout:"max_elapsed",timed_out:"max_elapsed",socket_timeout:"max_elapsed",max_schedules:"max_items",max_sheets:"max_items",max_text_notes:"max_items",max_tags:"max_items",max_viewports:"max_items",max_scanned:"max_items",max_schedule_instances:"max_items",max_schedule_cells:"max_cells",max_cells_scanned:"max_cells",rows_truncated:"max_rows",columns_truncated:"max_columns"};function Gt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function yt(e){return String(e??"").trim()}function gt(e){return Array.isArray(e)?e.map(t=>yt(t)).filter(t=>t.length>0):[]}function c(e,t){if(!Gt(e))return;let n=t.charAt(0).toUpperCase()+t.slice(1);if(Object.prototype.hasOwnProperty.call(e,t))return e[t];if(Object.prototype.hasOwnProperty.call(e,n))return e[n];let r=t.toLowerCase(),o=Object.keys(e).find(i=>i.toLowerCase()===r);return o?e[o]:void 0}function C(e,t){let n=c(e,t);return Array.isArray(n)?n.filter(r=>Gt(r)):[]}function bt(e,t){let n=c(e,t);return Gt(n)?n:null}function hi(e,t=!1){if(typeof e=="boolean")return e;if(typeof e=="string"){let n=e.trim().toLowerCase();if(n==="true")return!0;if(n==="false")return!1}return t}function fi(e){if(e==null)return null;if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function Jt(e,t="completed"){let n=yt(e).toLowerCase();return n?lc.has(n)?n:cc[n]||t:t}function uc(e,t,n,r){return n?"needs_scope":r==="failed"?"read_failed":t?"max_items":"completed"}function gr(e,t,n){return typeof e=="function"?e(t):e??n}function re(e,t){let n=Gt(e)?{...e}:{value:e},r=yt(c(n,"state")),o=yt(c(n,"error")),i=hi(c(n,"guarded"),!1),a=c(n,"success"),s=typeof a=="boolean"?!!a:o.length===0,l=r||(i?"guarded":s?"completed":"failed"),u=t.partial??hi(c(n,"partial"),!1),h=yt(t.scanStoppedReason??c(n,"scanStoppedReason")),m=uc(n,u,i,l),g=Jt(h,m);n.success=s,n.guarded=i,n.state=l,n.action=t.action,n.partial=u,n.scanStoppedReason=g,h&&h!==g&&n.rawScanStoppedReason===void 0&&(n.rawScanStoppedReason=h);let b=bt(n,"scanPolicy");n.scanPolicy=b||t.scanPolicy||{};let y=gt(c(n,"suggestedNextScopes"));n.suggestedNextScopes=y.length>0?y:gt(t.suggestedNextScopes),n.elapsedMs=fi(c(n,"elapsedMs"))??fi(t.elapsedMs),n.warnings=gt(c(n,"warnings")).concat(gt(t.warnings)),n.notices=gt(c(n,"notices")).concat(gt(t.notices));let T=gr(t.evidenceRows,n,[]),P=C(n,"evidenceRows");n.evidenceRows=P.length>0?P:Array.isArray(T)?T:[];let te=gr(t.summary,n,{}),B=bt(n,"summary");n.summary=B||(Gt(te)?te:{});let J=gr(t.lastRead,n,{});for(let z of sc){let X=c(n,z);n[z]=X!==void 0?X:J[z]??null}return n}function de(e){let t=yt(e.reason)||"needs_scope";return re({...e.extra||{},success:!0,guarded:!0,state:"guarded",action:e.action,reason:t,message:e.message,partial:!1,scanStoppedReason:t},{...e,partial:!1,scanStoppedReason:t,summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}function fe(e){return re({...e.extra||{},success:!1,guarded:!1,state:"failed",action:e.action,error:e.error,partial:!1,scanStoppedReason:"read_failed"},{...e,partial:!1,scanStoppedReason:"read_failed",summary:e.summary||{},evidenceRows:e.evidenceRows||[]})}var dc={fast:{maxElapsedMs:4500,timeoutMs:12e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4},deep:{maxElapsedMs:45e3,timeoutMs:6e4}};function mc(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=dc[t],r=Number.parseInt(String(e.maxElapsedMs??""),10),o=Number.isFinite(r)?Math.max(1,Math.min(119e3,r)):n.maxElapsedMs,i=Number.parseInt(String(e.timeoutMs??""),10),a=Number.isFinite(i)?Math.max(1e3,Math.min(12e4,i)):Math.max(n.timeoutMs,Math.min(12e4,o+5e3));return{searchBudget:t,maxElapsedMs:Math.min(o,Math.max(1,a-1e3)),timeoutMs:a}}function pc(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||e.query||"").trim())}function hc(e,t){return de({action:"inspect_sheet_text",reason:"needs_scope",message:"Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"],scanPolicy:{searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,allowExpensiveSearch:!1,textQuery:!!String(e.textQuery||"").trim(),includeViewportTextNotes:e.includeViewportTextNotes===!0,includeViewportTags:e.includeViewportTags===!0,scanScheduleCells:e.scanScheduleCells===!0,maxTags:e.maxTags??e.maxTagsScanned,maxViewports:e.maxViewports??e.maxViewportsPerSheet},summary:{sheetQuery:e.sheetQuery??e.query??null,textQuery:e.textQuery??null,returnedCount:0,matchCount:0}})}function fc(e,t){return{query:e.query,sheetQuery:e.sheetQuery??e.query,textQuery:e.textQuery,sheetIds:e.sheetIds,includeTextNotes:e.includeTextNotes,includeScheduleInstances:e.includeScheduleInstances,scanScheduleCells:e.scanScheduleCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,includeViewportTextNotes:e.includeViewportTextNotes,includeViewportTags:e.includeViewportTags,viewNameQuery:e.viewNameQuery,maxSheets:e.maxSheets,maxTextNotesPerSheet:e.maxTextNotesPerSheet,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxTextChars:e.maxTextChars,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxViewportTextNotesPerView:e.maxViewportTextNotesPerView,maxViewportTagsPerView:e.maxViewportTagsPerView,maxTags:e.maxTags,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit sheet annotations",taskId:e.taskId}}function yr(e){let t=String(c(e,"kind")||c(e,"sourceType")||"");return t==="scheduleCell"?"placedScheduleCell":t==="scheduleInstance"?"placedScheduleInstance":t||"sheetTextNote"}function St(e){return String(c(e,"textQuery")??"").trim().length>0}function br(e,t=!0){if(!t)return!1;let n=c(e,"matchedTextQuery"),r=c(e,"inventoryOnly");return!(r===!0||String(r).trim().toLowerCase()==="true"||n===!1||String(n).trim().toLowerCase()==="false")}function In(e){let t=C(e,"evidenceRows"),n=t.length>0?t:C(e,"matches"),r=St(e);return n.filter(o=>!!o&&typeof o=="object"&&!Array.isArray(o)).filter(o=>br(o,r)).map(o=>({...o,sourceType:yr(o)}))}function gi(e){let t=C(e,"inventoryRows"),n=C(e,"evidenceRows"),r=St(e),o=[...n,...C(e,"matches")].filter(a=>!!a&&typeof a=="object"&&!Array.isArray(a)).filter(a=>!br(a,r)),i=new Set;return[...t,...o].filter(a=>!!a&&typeof a=="object"&&!Array.isArray(a)).map(a=>({...a,sourceType:yr(a),matchedTextQuery:!1,inventoryOnly:!0})).filter(a=>{let s=[c(a,"sourceType")??"",c(a,"sheetId")??"",c(a,"instanceId")??c(a,"elementId")??c(a,"id")??"",c(a,"scheduleId")??""].join("|");return i.has(s)?!1:(i.add(s),!0)})}function Sr(e,t){let n={};for(let[r,o]of Object.entries(e))t.has(r)||(n[r]=o);return n}function gc(e,t){let n=t&&br(e,t);return{...Sr(e,new Set(["MatchedTextQuery","InventoryOnly","matchedTextQuery","inventoryOnly"])),sourceType:yr({...e,kind:c(e,"kind")??"scheduleInstance"}),MatchedTextQuery:n,InventoryOnly:!n,matchedTextQuery:n,inventoryOnly:!n}}function yc(e){let t=St(e);return C(e,"sheets").map(n=>{let r=Sr(n,new Set(["ScheduleInstances"])),o=C(n,"scheduleInstances");return{...r,scheduleInstances:o.map(i=>gc(i,t))}})}function bc(e){let t=c(e,"scan");return!t||typeof t!="object"||Array.isArray(t)||St(e)?t:{...t,TotalTextNoteMatches:0,totalTextNoteMatches:0,TotalViewportTextNoteMatches:0,totalViewportTextNoteMatches:0,TotalViewportTagMatches:0,totalViewportTagMatches:0,TotalScheduleCellMatches:0,totalScheduleCellMatches:0,TotalScheduleInstanceMatches:0,totalScheduleInstanceMatches:0}}function yi(e){let t=Jt(c(e,"scanStoppedReason")),n=String(c(e,"rawScanStoppedReason")??c(e,"scanStoppedReason")??t).trim()||t;return{canonicalReason:t,nativeReason:n,nativeLimitField:{max_sheets:"maxSheets",max_text_notes:"maxTextNotesScanned",max_viewports:"maxViewports",max_scanned:"maxScheduleInstancesScanned",max_schedule_instances:"maxScheduleInstancesScanned",max_schedule_cells:"maxScheduleCellsScanned",max_tags:"maxTagsScanned"}[n]??null}}function Sc(e){let t=In(e),n=gi(e),r=C(e,"sheets");return{sheetQuery:c(e,"sheetQuery")??null,textQuery:c(e,"textQuery")??null,totalSheets:c(e,"totalSheets")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!St(e),matchCount:t.length,inventoryRowCount:n.length,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed",rawScanStoppedReason:c(e,"rawScanStoppedReason")??null,scanStopDetail:yi(e),scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null}}function wc(e){let t=C(e,"evidenceRows").length>0?C(e,"evidenceRows"):In(e),n=t.length>0?t[t.length-1]:null,r=C(e,"sheets"),o=r.length>0?r[r.length-1]:null;return{lastReadSection:n?c(n,"section")??null:null,lastReadRow:n?c(n,"row")??null:null,lastReadColumn:n?c(n,"column")??null:null,lastReadSheetId:n?c(n,"sheetId")??c(o,"id")??null:c(o,"id")??null,lastReadViewId:n?c(n,"viewId")??null:null,lastReadViewportId:n?c(n,"viewportId")??null:null,lastReadItemId:n?c(n,"elementId")??c(n,"tagId")??c(n,"instanceId")??c(n,"id")??null:null}}function xc(e,t){let n=re(e,{action:"inspect_sheet_text",elapsedMs:t,summary:Sc,evidenceRows:In,lastRead:wc,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}),r=gi(n),o=St(n),i=bc(n),a=new Set(["Sheets"]);return o||(a.add("Matches"),a.add("EvidenceRows")),{...Sr(n,a),evidenceRows:o?In(n):[],inventoryRows:r,matches:o?C(n,"matches"):[],scan:i,sheets:yc(n),summary:{...n.summary||{},inventoryRowCount:r.length,scanStopDetail:yi(n)}}}function bi(e){e.tool("inspect_sheet_text","[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet text and annotation inspection for DrawingSheet text notes, titleblock/title block notes, revision schedule instances, placed schedule cells, viewport-linked text notes, viewport plan annotations, and viewport tags. Prefer this dedicated tool over generic send_code_to_revit for sheet text lookup, drawing note searches, plan note searches, titleblock/revision evidence, and large-project sheet or viewport annotation searches. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true.",{...S(E),...x(E),query:E.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),sheetQuery:E.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text or viewport annotation search."),textQuery:E.string().optional().describe("Optional text to search in sheet text notes, viewport text notes, or placed schedule cells."),sheetIds:E.array(E.union([E.number(),E.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),includeTextNotes:E.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),includeScheduleInstances:E.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),scanScheduleCells:E.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),allowExpensiveSearch:E.boolean().optional().describe("Explicit approval for project-wide sheet, viewport, tag, or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),searchBudget:E.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:E.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),includeViewportTextNotes:E.boolean().optional().describe("Include bounded TextNote results from views placed on matching sheets. Defaults false."),includeViewportTags:E.boolean().optional().describe("Include bounded IndependentTag evidence from views placed on matching sheets. Defaults false."),viewNameQuery:E.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),maxSheets:E.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),maxTextNotesPerSheet:E.number().int().min(0).max(1e3).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),maxScheduleInstancesPerSheet:E.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),maxRowsPerSchedule:E.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),maxColumnsPerSchedule:E.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),maxTextChars:E.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned text value. Defaults 240."),maxViewportsPerSheet:E.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:E.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet. Maximum placed viewports inspected per sheet."),maxViewportTextNotesPerView:E.number().int().min(0).max(1e3).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),maxViewportTagsPerView:E.number().int().min(0).max(500).optional().describe("Maximum matching viewport tags returned per placed view. Defaults 100."),maxTextNotesScanned:E.number().int().positive().max(2e5).optional().describe("Global native cap across sheet and viewport text notes."),maxTags:E.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:E.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxScheduleInstancesScanned:E.number().int().positive().max(1e5).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:E.number().int().positive().max(5e5).optional().describe("Global native cap across placed schedule body cells."),maxResponseBytes:E.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:E.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=mc(t),o=pc(t),i=!!String(t.textQuery||"").trim()&&!o,a=t.includeViewportTextNotes===!0&&!o,s=t.scanScheduleCells===!0&&!o,l=t.includeViewportTags===!0&&!o;if((i||a||s||l)&&t.allowExpensiveSearch!==!0)return p(hc(t,r));let u=await _("inspect_sheet_text",fc(t,r),{...I({...t,timeoutMs:r.timeoutMs},"Inspect Revit sheet annotations"),toolName:"inspect_sheet_text"});return p(xc(u&&u.result?u.result:u,Date.now()-n))}catch(r){return p(fe({action:"inspect_sheet_text",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:["sheetQuery","sheetIds","viewNameQuery","maxSheets","allowExpensiveSearch","searchBudget=deep"]}))}})}import{z as L}from"zod";var vc=25,Cc=50;function Z(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function Si(e){let t=Array.isArray(e)&&e.length>0?e:["header","body"];return[...new Set(t.map(n=>String(n||"").toLowerCase()))].filter(n=>["header","body","footer"].includes(n))}var Tc={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxCells:5e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxCells:25e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxCells:1e5}};function wi(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=Tc[t],r=Z(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=Z(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxCells:Z(e.maxCells,n.maxCells,1,5e5)}}function Rc(e){return(Array.isArray(e)?e:[]).map(t=>Number.parseInt(String(t),10)).filter(t=>Number.isFinite(t)&&t>0)}function Ic(e,t){let n=Rc(e.scheduleIds),r=Si(e.sections);return{query:e.query,nameQuery:e.nameQuery??e.query,cellQuery:e.cellQuery,scheduleIds:n,sections:r,includeCells:e.includeCells,scanCells:e.scanCells,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSchedules:Z(e.maxSchedules,50,1,200),maxRowsPerSection:Z(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:Z(e.maxColumnsPerSection,30,0,200),startRow:Z(e.startRow,0,0,1e5),startColumn:Z(e.startColumn,0,0,1e4),maxCellTextChars:Z(e.maxCellTextChars,180,20,1e3),maxCells:t.maxCells,maxResponseBytes:Z(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs,taskName:e.taskName||"Inspect Revit schedules",taskId:e.taskId}}function tt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}function _c(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function _n(e){return C(e,"schedules").filter(tt).flatMap(n=>C(n,"sections").map(o=>({schedule:n,section:o})))}function wt(e){return String(c(e,"cellQuery")??"").trim().length>0}function xr(e){return String(c(e,"nameQuery")??c(e,"query")??"").trim().length>0}function vr(e){return wt(e)?_n(e).flatMap(({schedule:t,section:n})=>C(n,"matches").filter(tt).map(o=>({sourceType:"scheduleCell",scheduleId:c(t,"id"),scheduleName:c(t,"name"),section:c(o,"section")??c(n,"section"),row:c(o,"row"),column:c(o,"column"),text:c(o,"text")}))):[]}function Cr(e){return c(e,"partial")===!0||c(e,"truncated")===!0?!0:_n(e).some(({section:t})=>c(t,"rowsTruncated")===!0||c(t,"columnsTruncated")===!0)}function Mc(e){if(c(e,"success")===!1||String(c(e,"state")||"").toLowerCase()==="failed"||c(e,"error"))return"read_failed";if(!Cr(e))return"completed";if(c(e,"truncated")===!0)return"max_items";for(let{section:t}of _n(e)){if(c(t,"rowsTruncated")===!0)return"max_rows";if(c(t,"columnsTruncated")===!0)return"max_columns"}return"max_cells"}function xi(e){let t=Mc(e),n=c(e,"scanStoppedReason");return!n||n==="completed"&&t!=="completed"?t:n}function Nc(e){let t=vi(e),n=tt(t)?t:{},r=C(e,"schedules"),o=C(e,"evidenceRows").length>0?C(e,"evidenceRows"):vr(e);return{query:c(e,"query")??null,nameQuery:c(e,"nameQuery")??null,cellQuery:c(e,"cellQuery")??null,totalSchedules:c(e,"totalSchedules")??null,candidateCount:c(e,"candidateCount")??null,returnedCount:c(e,"returnedCount")??(r.length>0?r.length:null),inventoryMode:!xr(e)&&!wt(e),matchCount:o.length,totalCellMatches:c(n,"totalCellMatches")??o.length,scannedScheduleCount:c(n,"scannedScheduleCount")??null,partial:Cr(e),scanStoppedReason:xi(e)}}function Ec(e){let t=C(e,"evidenceRows").length>0?C(e,"evidenceRows"):vr(e),n=t.length>0?t[t.length-1]:null,r=_n(e),o=r.length>0?r[r.length-1].section:null,i=C(e,"schedules"),a=r.length>0?r[r.length-1].schedule:i.length>0?i[i.length-1]:null,s=Number(c(o,"returnedRows")??c(o,"scannedRows")??0),l=Number(c(o,"returnedColumns")??c(o,"scannedColumns")??0),u=Number(c(o,"startRow")??0),h=Number(c(o,"startColumn")??0);return{lastReadSection:c(n,"section")??c(o,"section")??null,lastReadRow:c(n,"row")??c(o,"lastReadRow")??(s>0?u+s-1:null),lastReadColumn:c(n,"column")??c(o,"lastReadColumn")??(l>0?h+l-1:null),lastReadSheetId:null,lastReadViewId:null,lastReadViewportId:null,lastReadItemId:c(n,"scheduleId")??c(a,"id")??null}}function wr(e){let t=wi(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,includeCells:e.includeCells===!0,scanCells:e.scanCells===!0||!!e.cellQuery,sections:Si(e.sections),maxElapsedMs:t.maxElapsedMs,maxSchedules:Z(e.maxSchedules,50,1,200),maxRowsPerSection:Z(e.maxRowsPerSection,80,0,1e3),maxColumnsPerSection:Z(e.maxColumnsPerSection,30,0,200),startRow:Z(e.startRow,0,0,1e5),startColumn:Z(e.startColumn,0,0,1e4),maxCells:t.maxCells,maxResponseBytes:Z(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),timeoutMs:t.timeoutMs}}function kc(e,t=!0){let{matches:n,Matches:r,...o}=e;return{...o,section:c(e,"section"),rowCount:c(e,"rowCount"),columnCount:c(e,"columnCount"),startRow:c(e,"startRow"),startColumn:c(e,"startColumn"),returnedRows:c(e,"returnedRows"),returnedColumns:c(e,"returnedColumns"),rowsTruncated:c(e,"rowsTruncated"),columnsTruncated:c(e,"columnsTruncated"),scannedRows:c(e,"scannedRows"),scannedColumns:c(e,"scannedColumns"),scannedCells:c(e,"scannedCells"),lastReadRow:c(e,"lastReadRow"),lastReadColumn:c(e,"lastReadColumn"),matches:t?C(e,"matches").filter(tt).map(i=>({...i,section:c(i,"section"),row:c(i,"row"),column:c(i,"column"),text:c(i,"text")})):[],cells:C(e,"cells").map(i=>({...i,row:c(i,"row"),cells:C(i,"cells").map(a=>({...a,column:c(a,"column"),text:c(a,"text")}))})),readFailed:c(e,"readFailed"),readError:c(e,"readError")}}function Pc(e){let t=!xr(e)&&!wt(e),n=wt(e);return C(e,"schedules").filter(tt).map(r=>{let{nameMatched:o,NameMatched:i,cellMatchCount:a,CellMatchCount:s,sections:l,Sections:u,...h}=r;return{...h,id:c(r,"id"),uniqueId:c(r,"uniqueId"),name:c(r,"name"),viewType:c(r,"viewType"),isTemplate:c(r,"isTemplate"),nameMatched:t?!1:c(r,"nameMatched"),cellMatchCount:n?c(r,"cellMatchCount"):0,sections:C(r,"sections").filter(tt).map(m=>kc(m,n))}})}function Ac(e,t){for(let[n,r]of Object.entries(t)){let o=n.charAt(0).toUpperCase()+n.slice(1);e[n]=r,e[o]=r}return e}function vi(e){let t=c(e,"scan");if(!t||typeof t!="object"||Array.isArray(t))return t;let n={...t},r={};return xr(e)||(r.scheduleNameMatchedCount=0),wt(e)||(r.cellMatchedScheduleCount=0,r.totalCellMatches=0),Ac(n,r)}function Oc(e){for(let t of["query","nameQuery","cellQuery","totalSchedules","candidateCount","returnedCount","truncated","maxSchedules","scan","matches"]){let n=c(e,t);n!==void 0&&e[t]===void 0&&(e[t]=n)}return e.scan=vi(e),e.schedules=Pc(e),wt(e)||(e.matches=[],delete e.Matches),e}function Vc(e){return String(c(e,"id")??c(e,"uniqueId")??c(e,"name")??"")}function Dc(e,t){let n=C(e,"cells"),r=ce(C(e,"matches"),{limit:t}),{cells:o,Cells:i,matches:a,Matches:s,...l}=e;return{...l,matches:r.rows,matchCount:r.totalCount,returnedMatchCount:r.returnedCount,omittedMatchCount:r.omittedCount,duplicateMatchCount:r.duplicateCount,cellsOmitted:n.length>0,cellRowCount:n.length,fullResponseHint:n.length>0?'Use responseMode="full" when downstream schedule adapters need section.cells/body rows.':void 0}}function Fc(e,t){let n=t.responseMode||"compact";if(ze(n))return{...e,responseMode:n};let r=xe(t.maxResultRows,vc,200),o=xe(t.maxEvidenceRows,Cc,1e3),i=ce(C(e,"schedules"),{limit:r,key:Vc}),a=ce(C(e,"evidenceRows"),{limit:o});return{...e,responseMode:"compact",schedules:i.rows.map(s=>({...s,sections:C(s,"sections").filter(tt).map(l=>Dc(l,o))})),evidenceRows:a.rows,summary:{...e.summary||{},compactResponse:!0,scheduleRowCount:i.totalCount,returnedScheduleRowCount:i.returnedCount,omittedScheduleRowCount:i.omittedCount,duplicateScheduleRowCount:i.duplicateCount,evidenceRowCount:a.totalCount,returnedEvidenceRowCount:a.returnedCount,omittedEvidenceRowCount:a.omittedCount},notices:[..._c(e.notices),'Compact response omits section.cells and bounds evidence rows. Use responseMode="full" for full schedule cell bodies.']}}function Tr(e,t,n){let r=Cr(e);return Fc(Oc(re(e,{action:"inspect_schedules",elapsedMs:n,partial:r,scanStoppedReason:xi(e),scanPolicy:wr(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],summary:Nc,evidenceRows:vr,lastRead:Ec})),t)}function Ci(e){e.tool("inspect_schedules","[SCHEDULE_INSPECTION_READ_ONLY] Read-only native Revit schedule discovery and bounded cell inspection with partial-result continuation state. Prefer this over generic send_code_to_revit when finding schedules or reading schedule cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true. Default responseMode=compact omits bulky section.cells; use responseMode=full when the next step needs raw schedule body rows, such as reconcile_schedule_excel schedule adaptation.",{...S(L),...x(L),query:L.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),nameQuery:L.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),cellQuery:L.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),scheduleIds:L.array(L.union([L.number(),L.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),sections:L.array(L.enum(["header","body","footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),includeCells:L.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),scanCells:L.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),allowExpensiveSearch:L.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),searchBudget:L.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:L.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial schedule results can return before transport timeout."),maxSchedules:L.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),maxRowsPerSection:L.number().int().min(0).max(1e3).optional().describe("Maximum rows per section to read/scan. Defaults 80."),maxColumnsPerSection:L.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),startRow:L.number().int().min(0).max(1e5).optional().describe("Zero-based first schedule row to read in each requested section. Defaults 0."),startColumn:L.number().int().min(0).max(1e4).optional().describe("Zero-based first schedule column to read in each requested section. Defaults 0."),maxCells:L.number().int().positive().max(5e5).optional().describe("Global native cap across schedule cells read or scanned. Defaults by searchBudget."),maxResponseBytes:L.number().int().min(4096).max(16*1024*1024).optional().describe("Approximate native response-size cap. Defaults 4 MB."),maxCellTextChars:L.number().int().min(20).max(1e3).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),responseMode:Be,maxResultRows:L.number().int().positive().max(200).optional().describe("Compact-mode cap for returned schedule entries. Defaults 25; full/debug returns all native rows within maxSchedules."),maxEvidenceRows:L.number().int().positive().max(1e3).optional().describe("Compact-mode cap for evidenceRows and per-section matches. Defaults 50."),timeoutMs:L.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{let n=Date.now();try{let r=!!(Array.isArray(t.scheduleIds)&&t.scheduleIds.length>0||String(t.nameQuery||t.query||"").trim());if(!!(t.includeCells===!0||t.scanCells===!0||String(t.cellQuery||"").trim())&&!r&&t.allowExpensiveSearch!==!0)return p(de({action:"inspect_schedules",reason:"needs_scope",message:"Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"],scanPolicy:wr(t),elapsedMs:Date.now()-n,summary:{nameQuery:t.nameQuery??t.query??null,cellQuery:t.cellQuery??null,returnedCount:0,matchCount:0}}));let i=wi(t),a=await _("inspect_schedules",Ic(t,i),{...I(t,"Inspect Revit schedules"),toolName:"inspect_schedules",timeoutMs:i.timeoutMs});return p(Tr(a&&a.result?a.result:a,t,Date.now()-n))}catch(r){return p(fe({action:"inspect_schedules",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,scanPolicy:wr(t),suggestedNextScopes:["nameQuery","scheduleIds","sections","startRow","startColumn","maxRowsPerSection","maxColumnsPerSection","maxCells","maxResponseBytes","maxElapsedMs","allowExpensiveSearch"]}))}})}import{z as Vr}from"zod";import*as Uc from"node:fs";import Ri from"node:fs/promises";import Hc from"node:path";import{performance as Rr}from"node:perf_hooks";import*as rt from"@e965/xlsx";import{parse as $c}from"csv-parse/sync";import{z as w}from"zod";var Mn=["identity","comparisonText"],Nn=["identity","comparisonText","code","description","quantity","unit","system","discipline","notes"],En={identity:["identity","id","key","name","item","row","code","type","mark","tag","poz","kod","ad","isim"],comparisonText:["comparisontext","comparison text","description","desc","aciklama","text","name","item","type","mark","tag","ad","isim"],code:["code","kod","type code","mark","tag","poz"],description:["description","desc","text","aciklama"],quantity:["quantity","qty","count","adet","miktar"],unit:["unit","units","birim"],system:["system","sistem"],discipline:["discipline","disiplin"],notes:["notes","note","remarks","remark","not"]},Lc={\u0410:"A",\u0430:"A",\u0412:"B",\u0432:"B",\u0415:"E",\u0435:"E",\u041A:"K",\u043A:"K",\u041C:"M",\u043C:"M",\u041D:"H",\u043D:"H",\u041E:"O",\u043E:"O",\u0420:"P",\u0440:"P",\u0421:"C",\u0441:"C",\u0422:"T",\u0442:"T",\u0423:"Y",\u0443:"Y",\u0425:"X",\u0445:"X"},jc={\u00C7:"C",\u00E7:"C",\u011E:"G",\u011F:"G",\u00D6:"O",\u00F6:"O",\u015E:"S",\u015F:"S",\u00DC:"U",\u00FC:"U"},xt=new Set(["DN","MM","CM","M","KW","KCALH","LPS","M3H"]);function q(e){return String(e??"").replace(/\s+/g," ").trim()}function qe(e){return q(e).replace(/\u0131/g,"i").replace(/\u0130/g,"I").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}function Ht(e){return qe(e).replace(/\s+/g,"")}function vt(e){let t=String(e??"");return t=t.replace(/[\u0000-\u001f\u007f-\u009f]/g," "),t=t.normalize("NFKC"),t=t.replace(/\u0131/g,"i").replace(/\u0130/g,"I"),t=t.replace(/[\u0400-\u04ff]/g,n=>Lc[n]||n),t=t.replace(/[\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/g,n=>jc[n]||n),t=t.toUpperCase(),t=t.replace(/[\u00d8\u00f8\u2205\u2300\u0424\u0444]/g," DN "),t=t.replace(/\b(?:DIAMETER|DIA)\b/g," DN "),t=qc(t),t=t.replace(/(\d),(\d)/g,"$1.$2"),t=t.replace(/(\d)\.(\d)/g,"$1DECIMALDOT$2"),t=t.replace(/[^A-Z0-9]+/g," "),t=t.replace(/(\d)DECIMALDOT(\d)/g,"$1.$2"),t=t.replace(/\bM\s*3\s*H\b/g,"M3H"),t.replace(/\s+/g," ").trim()}function Bc(e){return e.map(n=>vt(n)).filter((n,r,o)=>n.length>0&&o.indexOf(n)===r).join(" | ")}function Ct(e){let t=Bc(e);return{profileVersion:1,normalizedKey:t,tokens:zc(t)}}function zc(e){let t=vt(e),n=t.length>0?t.split(" "):[],r=[];for(let o=0;o<n.length;o++){let i=n[o],a=n[o+1];if(Ut(i)&&a&&xt.has(a)){r.push({type:"dimension",value:`${i}${a}`}),o++;continue}if(xt.has(i)&&a&&Ut(a)){r.push({type:"dimension",value:`${i}${a}`}),o++;continue}let s=Jc(i);if(s){r.push({type:"dimension",value:s});continue}if(xt.has(i)){r.push({type:"unit",value:i});continue}if(Ut(i)){r.push({type:"number",value:i});continue}let l=n[o+2]||"",u=xt.has(l)&&Ut(n[o+3]||""),h=xt.has(l)&&!u;if(Wc(i)&&a&&Ut(a)&&!xt.has(i)&&!h){r.push({type:"code",value:`${i}${a}`}),o++;continue}if(Gc(i)){r.push({type:"code",value:i});continue}r.push({type:"word",value:i})}return r}function qc(e){return e.replace(/\bM\s*(?:3|\^3)\s*\/\s*H\b/g," M3H ").replace(/\bM3H\b/g," M3H ").replace(/\b(?:L|LT)\s*\/\s*S\b/g," LPS ").replace(/\bLPS\b/g," LPS ").replace(/\bKCAL\s*\/\s*H\b/g," KCALH ").replace(/\bKCALH\b/g," KCALH ").replace(/\bKW\b/g," KW ").replace(/\bMM\b/g," MM ").replace(/\bCM\b/g," CM ").replace(/\bDN\b/g," DN ")}function Ut(e){return/^\d+(?:\.\d+)?$/.test(e)}function Wc(e){return/^[A-Z]+$/.test(e)}function Gc(e){return/[A-Z]/.test(e)&&/\d/.test(e)}function Jc(e){let t=e.match(/^(\d+(?:\.\d+)?)(DN|MM|CM|M|KW|KCALH|LPS|M3H)$/);if(t)return`${t[1]}${t[2]}`;let n=e.match(/^(DN)(\d+(?:\.\d+)?)$/);return n?`${n[1]}${n[2]}`:null}rt.set_fs(Uc);var $t="reconcile_schedule_excel",Vn="excel_ingestion",Tt={maxWorkbookBytes:25*1024*1024,maxSheets:20,maxRows:5e3,maxColumns:100,maxCells:25e4,maxElapsedMs:5e3},Rt={maxWorkbookBytes:100*1024*1024,maxSheets:200,maxRows:5e4,maxColumns:300,maxCells:1e6,maxElapsedMs:119e3},kn=Mn,Pn=Nn,Qc=En,Xc=w.object({sheetName:w.string().min(1).optional(),sheetIndex:w.number().int().positive().optional(),range:w.string().min(1).optional(),headerRow:w.number().int().positive().optional(),dataStartRow:w.number().int().positive().optional()}).strict(),Ii=w.object({identity:w.union([w.string().min(1),w.number().int().positive()]).optional(),comparisonText:w.union([w.string().min(1),w.number().int().positive()]).optional(),code:w.union([w.string().min(1),w.number().int().positive()]).optional(),description:w.union([w.string().min(1),w.number().int().positive()]).optional(),quantity:w.union([w.string().min(1),w.number().int().positive()]).optional(),unit:w.union([w.string().min(1),w.number().int().positive()]).optional(),system:w.union([w.string().min(1),w.number().int().positive()]).optional(),discipline:w.union([w.string().min(1),w.number().int().positive()]).optional(),notes:w.union([w.string().min(1),w.number().int().positive()]).optional()}).strict(),_i=w.object({maxWorkbookBytes:w.number().int().positive().optional(),maxSheets:w.number().int().positive().optional(),maxRows:w.number().int().nonnegative().optional(),maxColumns:w.number().int().positive().optional(),maxCells:w.number().int().positive().optional(),maxElapsedMs:w.number().int().positive().optional()}).strict(),Yc=w.object({kind:w.literal("file"),path:w.string().min(1),format:w.enum(["xlsx","csv","tsv","xls"]).optional(),selection:Xc.optional(),columnMapping:Ii.optional(),budgets:_i.optional()}).strict(),Kc=w.object({kind:w.literal("rows"),sheetName:w.string().min(1).optional(),rows:w.array(w.record(w.unknown())),selection:w.object({headerRow:w.number().int().positive().optional(),dataStartRow:w.number().int().positive().optional()}).strict().optional(),columnMapping:Ii.optional(),budgets:_i.optional()}).strict(),_r=w.discriminatedUnion("kind",[Yc,Kc]);function Oe(e){return q(e)}function An(e){return qe(e)}function Ti(e){return Ht(e)}function Zc(e){return{maxWorkbookBytes:It(e?.maxWorkbookBytes,Tt.maxWorkbookBytes,Rt.maxWorkbookBytes),maxSheets:It(e?.maxSheets,Tt.maxSheets,Rt.maxSheets),maxRows:It(e?.maxRows,Tt.maxRows,Rt.maxRows),maxColumns:It(e?.maxColumns,Tt.maxColumns,Rt.maxColumns),maxCells:It(e?.maxCells,Tt.maxCells,Rt.maxCells),maxElapsedMs:It(e?.maxElapsedMs,Tt.maxElapsedMs,Rt.maxElapsedMs)}}function It(e,t,n){return typeof e!="number"||!Number.isFinite(e)?t:Math.max(0,Math.min(Math.floor(e),n))}function Mi(e,t){let n=(t||Hc.extname(e).replace(/^\./,"")).trim().toLowerCase();return n==="xlsx"||n==="csv"||n==="tsv"||n==="xls"?n:"unsupported"}function nt(e,t,n={}){let{warnings:r=[],notices:o=[],suggestedNextScopes:i=[],...a}=n;return de({action:$t,reason:e,message:t,extra:{stage:Vn,ingestionContractVersion:1,...a},summary:n.summary||{},evidenceRows:[],scanPolicy:n.scanPolicy||{},suggestedNextScopes:i,warnings:r,notices:o})}function eu(e,t={}){let{warnings:n=[],notices:r=[],...o}=t;return fe({action:$t,error:e,extra:{stage:Vn,ingestionContractVersion:1,...o},summary:t.summary||{},evidenceRows:[],scanPolicy:t.scanPolicy||{},warnings:n,notices:r})}function tu(e){let t=e.table.warnings.concat(e.mappingWarnings),n=e.table.notices.concat(e.mappingNotices),r=e.table.partial,o=e.table.scanStoppedReason,i=e.records.map(a=>({sourceType:"excelRecord",excelRowId:a.excelRowId,sheetName:a.sheetName,rowNumber:a.rowNumber,identityText:a.identityText,comparisonText:a.comparisonText,normalizedKey:a.normalizedKey}));return re({success:!0,guarded:!1,state:"completed",action:$t,stage:Vn,ingestionContractVersion:1,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,excelRecords:e.records,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs},{action:$t,partial:r,scanStoppedReason:o,elapsedMs:e.elapsedMs,scanPolicy:{budgets:e.budgets,sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerRow:e.table.headerRow,dataStartRow:e.table.dataStartRow,columnMapping:nu(e.mapping,e.table)},summary:{sourceKind:e.sourceKind,format:e.format,sheetName:e.table.sheetName,sourceRange:e.table.sourceRange,headerCount:e.table.headers.length,scannedRows:e.table.rows.length,scannedCells:e.table.scannedCells,excelRows:e.records.length,excelRecordCount:e.records.length,emptyExcelRows:e.table.rows.length-e.records.length,formulaCachedValueCount:e.table.formulaCachedValueCount,formulaWithoutCachedValueCount:e.table.formulaWithoutCachedValueCount,partial:r,scanStoppedReason:o},evidenceRows:i,warnings:t,notices:n,lastRead:{lastReadRow:e.table.lastReadRow,lastReadColumn:e.table.lastReadColumn,lastReadItemId:e.records.length>0?e.records[e.records.length-1].excelRowId:null}})}function nu(e,t){let n={};for(let r of Pn){let o=e[r];typeof o=="number"&&(n[r]=t.headers[o]||Ve(t.startColumn+o))}return n}function Ve(e){let t=Math.max(1,Math.floor(e)),n="";for(;t>0;){let r=(t-1)%26;n=String.fromCharCode(65+r)+n,t=Math.floor((t-1)/26)}return n}function Ir(e){let t=e.trim().toUpperCase();if(!/^[A-Z]+$/.test(t))return null;let n=0;for(let r of t)n=n*26+(r.charCodeAt(0)-64);return n}function Ni(e,t){if(!e)return t;let n=e.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/);if(!n)return null;let r=Ir(n[1]),o=Number(n[2]),i=n[3]?Ir(n[3]):r,a=n[4]?Number(n[4]):o;return!r||!i||o<1||a<o||i<r?null:{startRow:o,startColumn:r,endRow:a,endColumn:i}}function ru(e,t,n,r){return`${Ve(t)}${e}:${Ve(r)}${n}`}function ou(e){return Oe(e).length===0}function iu(e){return e.every(t=>ou(t.text))}function au(e,t){let n=new Map;return e.map((r,o)=>{let i=`Column ${Ve(t+o)}`,a=Oe(r.text)||i,s=An(a)||An(i),l=n.get(s)||0;return n.set(s,l+1),l===0?a:`${a} ${l+1}`})}function On(e){if(e==null)return"";if(e instanceof Date)return Number.isNaN(e.getTime())?"":e.toISOString();if(typeof e=="object"){let t=e;return Array.isArray(t.richText)?Oe(t.richText.map(n=>String(n.text??"")).join("")):t.text!==void 0?Oe(t.text):t.result!==void 0?On(t.result):""}return Oe(e)}function su(e,t,n,r){let o=rt.utils.encode_cell({r:t-1,c:n-1}),i=`${r}!${o}`,a=e[o];if(!a)return{value:"",text:"",address:i};if(typeof a.f=="string"&&a.f.length>0)return a.v!==void 0&&a.v!==null&&!(typeof a.v=="string"&&a.v.length===0&&(a.w===void 0||a.w===""))?{value:a.v,text:On(a.v)||Oe(a.w),address:i,formulaWithCachedValue:!0}:{value:"",text:"",address:i,formulaWithoutCachedValue:!0};let l=a.v??"";return{value:l,text:On(l)||Oe(a.w),address:i}}function lu(e,t,n,r){return{value:e,text:On(e),address:`${r}!${Ve(n)}${t}`}}function cu(e,t){return Rr.now()-e>t.maxElapsedMs}function uu(e,t,n){let r=[],o=[],i={},a=new Set,s=new Set;for(let u of Pn){let h=n?.[u];if(h!==void 0){let m=hu(h,e,t);if(m===null)return{error:{role:u,reason:"unresolved_column_ref",value:h}};i[u]=m,a.add(m),s.add(u)}}for(let u of Pn){if(i[u]!==void 0)continue;let h=Ei(u,e);if(h.length===0)continue;let m=pu(h,a);if(m.kind==="ambiguous")return{error:{role:u,reason:"ambiguous_alias",candidates:m.candidates}};m.kind==="resolved"&&(i[u]=m.match.index,a.add(m.match.index))}for(let u of kn)if(i[u]===void 0)return{error:{role:u,reason:"missing_required_role"}};let l=kn.filter(u=>!s.has(u));if(l.length>0){let u=l.map(h=>`${h}=${e[i[h]]||Ve(t+i[h])}`).join(", ");o.push(`column_mapping_inferred_from_headers: ${u}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`)}return{mapping:i,warnings:r,notices:o}}function du(e,t){let n={},r={},o=new Set;for(let i of kn){let a=Ei(i,e).filter(s=>!o.has(s.index)).sort((s,l)=>s.priority-l.priority||s.index-l.index);n[i]=a.map(s=>({header:s.header,column:Ve(t+s.index),priority:s.priority})),a.length>0&&(r[i]=a[0].header,o.add(a[0].index))}return{requiredRoles:kn,candidates:n,suggestedColumnMapping:r}}function mu(e,t){let n=Ti(t),r=Qc[e];for(let o=0;o<r.length;o++)if(Ti(r[o])===n)return o;return Number.POSITIVE_INFINITY}function Ei(e,t){return t.map((n,r)=>({header:n,index:r,priority:mu(e,n)})).filter(n=>Number.isFinite(n.priority))}function pu(e,t){let n=e.filter(a=>!t.has(a.index)),r=n.length>0?n:e,o=Math.min(...r.map(a=>a.priority)),i=r.filter(a=>a.priority===o);return i.length===1?{kind:"resolved",match:i[0]}:{kind:"ambiguous",candidates:i.map(a=>a.header)}}function hu(e,t,n){if(typeof e=="number"){let s=e-1;return s>=0&&s<t.length?s:null}let r=e.trim(),o=An(r),i=t.map((s,l)=>({header:s,index:l})).filter(s=>An(s.header)===o);if(i.length===1)return i[0].index;let a=Ir(r);if(a!==null){let s=a-n;return s>=0&&s<t.length?s:null}return null}function fu(e,t){let n=[];for(let r of e.rows){if(iu(r.cells))continue;let o={};for(let[m,g]of e.headers.entries())o[g]=r.cells[m]?.text??"";let i={};for(let m of Pn){let g=t[m];typeof g=="number"&&(i[m]=r.cells[g]?.text??"")}let a=Oe(i.identity),s=Oe(i.comparisonText),l=Ct([a,s]),u=l.normalizedKey,h=`${e.sheetName}!${r.rowNumber}`;n.push({excelRowId:h,sheetName:e.sheetName,rowNumber:r.rowNumber,sourceRange:e.sourceRange,rawValues:o,mappedValues:i,identityText:a,comparisonText:s,normalizedKey:u,tokenProfile:l})}return n}async function gu(e,t,n){let r=rt.readFile(e.path,{cellDates:!0,cellFormula:!0,cellText:!0,nodim:!0}),o=r.SheetNames.map(h=>({name:h,worksheet:r.Sheets[h]||{}})),i=e.selection||{},a=!!(i.sheetName||i.sheetIndex),s=o.filter(h=>Su(h.worksheet));if(!a&&o.length>t.maxSheets&&s.length!==1)return nt("max_items","Workbook sheet count exceeds maxSheets and cannot be auto-scoped to one non-empty sheet. Provide sheetName or sheetIndex.",{partial:!0,scanStoppedReason:"max_items",summary:{workbookSheets:o.length,nonEmptySheets:s.length,maxSheets:t.maxSheets},scanPolicy:{budgets:t},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex","excel.budgets.maxSheets"]});let l=yu(r,i,s);if(!l)return nt("excel_sheet_selection_required","Select a worksheet with sheetName or 1-based sheetIndex.",{summary:{workbookSheets:o.length,sheetNames:o.map(h=>h.name)},scanPolicy:{budgets:t,selection:i},suggestedNextScopes:["excel.selection.sheetName","excel.selection.sheetIndex"]});let u=bu(l,i,t,n);return!a&&s.length===1&&u.notices.push("Selected the only non-empty worksheet."),u}function yu(e,t,n){if(t.sheetName){let r=e.Sheets[t.sheetName];return r?{name:t.sheetName,worksheet:r}:null}if(t.sheetIndex){let r=e.SheetNames[t.sheetIndex-1];return r&&e.Sheets[r]?{name:r,worksheet:e.Sheets[r]}:null}return n.length===1?n[0]:null}function bu(e,t,n,r){let o=wu(e.worksheet);return Pi({sheetName:e.name,fallbackRange:o,selection:t,budgets:n,startedAt:r,readCell:(i,a)=>su(e.worksheet,i,a,e.name)})}function Su(e){return Object.keys(e).some(t=>!t.startsWith("!"))}function wu(e){let t=Number.POSITIVE_INFINITY,n=Number.POSITIVE_INFINITY,r=1,o=1;for(let i of Object.keys(e))if(!i.startsWith("!"))try{let a=rt.utils.decode_cell(i);t=Math.min(t,a.r+1),n=Math.min(n,a.c+1),r=Math.max(r,a.r+1),o=Math.max(o,a.c+1)}catch{continue}return!Number.isFinite(t)||!Number.isFinite(n)?{startRow:1,startColumn:1,endRow:1,endColumn:1}:{startRow:t,startColumn:n,endRow:r,endColumn:o}}async function xu(e,t,n,r){let o=await Ri.readFile(e.path,"utf8"),i=vu(e.selection||{},t),a=$c(o,{bom:!0,delimiter:r==="tsv"?"	":",",relax_column_count:!0,skip_empty_lines:!1,to:i.recordLimit+1}),s=a.length>i.recordLimit?{partial:!0,scanStoppedReason:i.scanStoppedReason}:void 0,l=s?a.slice(0,i.recordLimit):a,u=e.selection?.sheetName||(r==="tsv"?"TSV":"CSV");return ki(l,u,e.selection||{},t,n,s)}function vu(e,t){let r=Ni(e.range,{startRow:1,startColumn:1,endRow:1,endColumn:1})?.startRow||1,o=e.headerRow||r,i=e.dataStartRow||o+1;return{recordLimit:Math.max(r,o,i+t.maxRows-1),scanStoppedReason:"max_rows"}}function Cu(e,t,n){let r=e.sheetName||"Rows",o=Tu(e.rows),i=e.selection?.headerRow||1,a=e.selection?.dataStartRow||i+1,s=[];for(;s.length<i-1;)s.push([]);for(s.push(o);s.length<a-1;)s.push([]);for(let l of e.rows)s.push(o.map(u=>l[u]));return ki(s,r,{headerRow:i,dataStartRow:a},t,n)}function Tu(e){let t=[],n=new Set;for(let r of e)for(let o of Object.keys(r))n.has(o)||(n.add(o),t.push(o));return t}function ki(e,t,n,r,o,i){let a=e.reduce((l,u)=>Math.max(l,u.length),1),s={startRow:1,startColumn:1,endRow:Math.max(e.length,1),endColumn:Math.max(a,1)};return Pi({sheetName:t,fallbackRange:s,selection:n,budgets:r,startedAt:o,prelimited:i,readCell:(l,u)=>lu(e[l-1]?.[u-1],l,u,t)})}function Pi(e){let t=Ni(e.selection.range,e.fallbackRange);if(!t)throw new Error(`Invalid range selection: ${e.selection.range}`);let n=e.selection.headerRow||t.startRow,r=e.selection.dataStartRow||n+1;if(r<=n)throw new Error("dataStartRow must be greater than headerRow.");let o=t.endColumn,i=e.prelimited?.partial||!1,a=e.prelimited?.scanStoppedReason||"completed";o-t.startColumn+1>e.budgets.maxColumns&&(o=t.startColumn+e.budgets.maxColumns-1,i=!0,a="max_columns");let s=[],l=0,u=0,h=0,m=[],g=[];for(let B=t.startColumn;B<=o;B++){let J=e.readCell(n,B);s.push(J),l++,J.formulaWithCachedValue&&u++,J.formulaWithoutCachedValue&&(h++,m.push(`Formula cell ${J.address||`${e.sheetName}!${Ve(B)}${n}`} has no cached value and was read as blank.`))}let b=au(s,t.startColumn),y=[],T=null,P=null,te=Math.max(r,t.startRow);for(let B=te;B<=t.endRow;B++){if(y.length>=e.budgets.maxRows){i=!0,a=a==="completed"?"max_rows":a;break}if(cu(e.startedAt,e.budgets)){i=!0,a="max_elapsed";break}if(l+b.length>e.budgets.maxCells){i=!0,a=a==="completed"?"max_cells":a;break}let J=[];for(let z=t.startColumn;z<=o;z++){let X=e.readCell(B,z);J.push(X),l++,T=B,P=z,X.formulaWithCachedValue&&u++,X.formulaWithoutCachedValue&&(h++,m.push(`Formula cell ${X.address||`${e.sheetName}!${Ve(z)}${B}`} has no cached value and was read as blank.`))}y.push({rowNumber:B,cells:J})}return{sheetName:e.sheetName,sourceRange:ru(t.startRow,t.startColumn,t.endRow,o),headerRow:n,dataStartRow:r,startColumn:t.startColumn,headers:b,rows:y,notices:g,warnings:m,formulaCachedValueCount:u,formulaWithoutCachedValueCount:h,scannedCells:l,partial:i,scanStoppedReason:a,lastReadRow:T,lastReadColumn:P}}function Ru(e){return!!(e&&typeof e=="object"&&e.action===$t&&e.stage===Vn)}async function Ai(e){let t=Rr.now(),n=_r.safeParse(e);if(!n.success)return nt("needs_scope","Excel ingestion input failed schema validation.",{validationIssues:n.error.issues.map(i=>`${i.path.join(".")||"<root>"}: ${i.message}`),suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"]});let r=n.data,o=Zc(r.budgets);try{let i=await Iu(r,o,t);if(Ru(i))return i;let a=i,s=uu(a.headers,a.startColumn,r.columnMapping);if("error"in s)return nt("excel_column_mapping_required","Resolve identity and comparisonText column mapping before ingestion.",{mappingError:s.error,mappingSuggestion:du(a.headers,a.startColumn),summary:{sheetName:a.sheetName,headers:a.headers},scanPolicy:{budgets:o},suggestedNextScopes:["excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:a.warnings,notices:a.notices});let l=fu(a,s.mapping);return tu({sourceKind:r.kind,format:r.kind==="file"?Mi(r.path,r.format):"rows",table:a,records:l,budgets:o,mapping:s.mapping,mappingNotices:s.notices,mappingWarnings:s.warnings,elapsedMs:Rr.now()-t})}catch(i){return eu(i instanceof Error?i.message:String(i),{scanPolicy:{budgets:o}})}}async function Iu(e,t,n){if(e.kind==="rows")return Cu(e,t,n);let r=Mi(e.path,e.format);if(r==="xls")return nt("unsupported_excel_format",".xls is not supported. Save the workbook as .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});if(r==="unsupported")return nt("unsupported_excel_format","Unsupported spreadsheet format. Use .xlsx, .csv, or .tsv.",{format:r,scanPolicy:{budgets:t},suggestedNextScopes:["excel.path","excel.format"]});let o=await Ri.stat(e.path);return o.size>t.maxWorkbookBytes?nt("max_bytes","Workbook exceeds maxWorkbookBytes.",{format:r,partial:!0,scanStoppedReason:"max_bytes",summary:{workbookBytes:o.size,maxWorkbookBytes:t.maxWorkbookBytes},scanPolicy:{budgets:t},suggestedNextScopes:["excel.budgets.maxWorkbookBytes","excel.selection.sheetName","excel.selection.range"]}):r==="xlsx"?gu(e,t,n):xu(e,t,n,r)}import{z as f}from"zod";var Dn="reconcile_schedule_records",Nr="schedule_record_adapter",We="displayedScheduleCells",_u=["body"],Mr=Nn,Di=Mn,Mu=En,Fi=f.object({identity:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),comparisonText:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),code:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),description:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),quantity:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),unit:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),system:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),discipline:f.union([f.string().min(1),f.number().int().nonnegative()]).optional(),notes:f.union([f.string().min(1),f.number().int().nonnegative()]).optional()}).strict(),Nu=f.object({kind:f.literal("inspect_schedules_result"),result:f.record(f.unknown()),columnMapping:Fi.optional(),columnHeaders:f.array(f.string()).optional(),sections:f.array(f.enum(["header","body","footer"])).optional()}).strict(),Eu=f.object({kind:f.literal("revit_schedule"),scheduleIds:f.array(f.union([f.number().int().positive(),f.string().min(1)])).optional(),nameQuery:f.string().min(1).optional(),sections:f.array(f.enum(["header","body","footer"])).optional(),columnMapping:Fi.optional(),columnHeaders:f.array(f.string()).optional(),target:f.string().optional(),host:f.string().optional(),port:f.number().int().positive().max(65535).optional(),taskName:f.string().optional(),taskId:f.string().optional(),parentTaskName:f.string().optional(),parentTaskId:f.string().optional(),allowExpensiveSearch:f.boolean().optional(),searchBudget:f.enum(["fast","balanced","deep"]).optional(),maxElapsedMs:f.number().int().positive().max(119e3).optional(),maxSchedules:f.number().int().positive().max(200).optional(),maxRowsPerSection:f.number().int().min(0).max(1e3).optional(),maxColumnsPerSection:f.number().int().min(0).max(200).optional(),startRow:f.number().int().min(0).max(1e5).optional(),startColumn:f.number().int().min(0).max(1e4).optional(),maxCells:f.number().int().positive().max(5e5).optional(),maxResponseBytes:f.number().int().min(4096).max(16*1024*1024).optional(),maxCellTextChars:f.number().int().min(20).max(1e3).optional(),timeoutMs:f.number().int().positive().max(12e4).optional()}).strict(),Er=f.discriminatedUnion("kind",[Nu,Eu]);async function Li(e,t={}){let n=Date.now(),r=Er.safeParse(e);return r.success?r.data.kind==="revit_schedule"?ku(r.data,n,t):ji(r.data,Date.now()-n):Fn("needs_scope","Schedule adapter input failed schema validation.",{validationIssues:r.error.issues.map(o=>`${o.path.join(".")||"<root>"}: ${o.message}`),elapsedMs:Date.now()-n,suggestedNextScopes:["schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]})}async function ku(e,t,n){if(!!!(Array.isArray(e.scheduleIds)&&e.scheduleIds.length>0||String(e.nameQuery||"").trim())&&e.allowExpensiveSearch!==!0)return Fn("needs_scope","Direct live schedule reconciliation requires scheduleIds or nameQuery. Set allowExpensiveSearch=true only when a broad schedule scan is intentional.",{sourceKind:e.kind,elapsedMs:Date.now()-t,suggestedNextScopes:["schedule.scheduleIds","schedule.nameQuery","schedule.allowExpensiveSearch=true"],scanPolicy:{sourceKind:e.kind,bridgeExecution:"inspect_schedules",scheduleIds:[],nameQuery:null,allowExpensiveSearch:!1,visibilityBasis:We}});let i=["header",...qi(e.sections).filter(g=>g!=="header")],a={query:e.nameQuery,nameQuery:e.nameQuery,scheduleIds:e.scheduleIds,sections:i,includeCells:!0,scanCells:!1,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:e.searchBudget,maxElapsedMs:e.maxElapsedMs,maxSchedules:e.maxSchedules,maxRowsPerSection:e.maxRowsPerSection,maxColumnsPerSection:e.maxColumnsPerSection,startRow:e.startRow,startColumn:e.startColumn,maxCells:e.maxCells,maxResponseBytes:e.maxResponseBytes,maxCellTextChars:e.maxCellTextChars,responseMode:"full",timeoutMs:e.timeoutMs,taskName:e.taskName||"Inspect live Revit schedule for reconciliation",taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId},l=await(n.sendCommand||_)("inspect_schedules",a,{target:e.target,host:e.host,port:e.port,timeoutMs:e.timeoutMs,taskName:a.taskName,taskId:e.taskId,parentTaskName:e.parentTaskName,parentTaskId:e.parentTaskId,toolName:"reconcile_schedule_excel"}),u=Date.now()-t,h=Tr(l&&l.result?l.result:l,a,u),m=ji({kind:"inspect_schedules_result",result:h,columnMapping:e.columnMapping,columnHeaders:e.columnHeaders,sections:e.sections},u);return m.sourceKind="revit_schedule",m.bridgeSourceKind="inspect_schedules_result",m.scanPolicy={...m.scanPolicy||{},sourceKind:"revit_schedule",bridgeExecution:"inspect_schedules",inspectSections:i,scheduleIds:e.scheduleIds||[],nameQuery:e.nameQuery||null,allowExpensiveSearch:e.allowExpensiveSearch===!0},m.notices=[...ot(m,"notices"),"Live Revit schedule input was read through bounded inspect_schedules before reconciliation."],m}function ji(e,t){let n=e.result,r=q(c(n,"state")).toLowerCase();if(c(n,"success")===!1||r==="failed"||c(n,"error"))return ju(q(c(n,"error"))||"inspect_schedules_result failed before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:ot(n,"warnings"),notices:ot(n,"notices")});if(c(n,"guarded")===!0)return Fn(q(c(n,"reason"))||"needs_scope","inspect_schedules_result was guarded before schedule adaptation.",{sourceKind:e.kind,elapsedMs:t,warnings:ot(n,"warnings"),notices:ot(n,"notices"),summary:c(n,"summary")||{},suggestedNextScopes:['inspect_schedules responseMode="full"',"schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let o=qi(e.sections),i=C(n,"schedules"),a=ot(n,"warnings"),s=ot(n,"notices"),l=[],u=0,h=0,m=0;for(let T of i){let P=Wi(c(T,"id"));if(!P){a.push("Skipped a schedule without id while adapting schedule records.");continue}let te=Pr(c(T,"name")),B=Ou(T,e.columnHeaders),J=Vu(B,e.columnMapping);if("error"in J)return Fn("schedule_column_mapping_required","Resolve identity and comparisonText schedule column mapping before adaptation.",{sourceKind:e.kind,scheduleId:P,scheduleName:te,mappingError:J.error,summary:{scheduleId:P,scheduleName:te,headers:B.map(z=>({column:z.column,header:z.header}))},scanPolicy:Oi(e,o),suggestedNextScopes:["schedule.columnMapping.identity","schedule.columnMapping.comparisonText",'inspect_schedules responseMode="full"'],warnings:a,notices:s});for(let z of C(T,"sections")){let X=kr(c(z,"section"));if(o.includes(X))for(let ye of Bi(z,P,te,X)){if(u++,h+=ye.cells.length,X==="body"&&Pu(ye,J.mapping,B)){m++;continue}let Re=Au(ye,J.mapping);Re&&l.push(Re)}}}let g=c(n,"partial")===!0,b=Jt(c(n,"scanStoppedReason"),g?"max_items":"completed"),y=l.length>0?l[l.length-1]:null;return re({success:!0,guarded:!1,state:"completed",action:Dn,stage:Nr,adapterContractVersion:1,sourceKind:e.kind,visibilityBasis:We,scheduleRecords:l,partial:g,scanStoppedReason:b,elapsedMs:t},{action:Dn,partial:g,scanStoppedReason:b,elapsedMs:t,scanPolicy:Oi(e,o),summary:{sourceKind:e.kind,scheduleCount:i.length,scannedRows:u,scannedCells:h,skippedHeaderLikeRows:m,scheduleRecordCount:l.length,visibilityBasis:We,partial:g,scanStoppedReason:b},evidenceRows:l.map(T=>({sourceType:"scheduleRecord",scheduleRowId:T.scheduleRowId,scheduleId:T.scheduleId,scheduleName:T.scheduleName,section:T.section,row:T.row,identityText:T.identityText,comparisonText:T.comparisonText,normalizedKey:T.normalizedKey,visibilityBasis:We})),warnings:a,notices:m>0?[...s,`Skipped ${m} header-like body row(s) during schedule adaptation.`]:s,lastRead:{lastReadSection:c(n,"lastReadSection")??y?.section??null,lastReadRow:c(n,"lastReadRow")??y?.row??null,lastReadColumn:c(n,"lastReadColumn")??null,lastReadItemId:c(n,"lastReadItemId")??y?.scheduleRowId??null}})}function Pu(e,t,n){let r=new Map;for(let i of e.cells)r.set(i.column,i.text);let o=Di.filter(i=>typeof t[i]=="number");return o.length===0?!1:o.every(i=>{let a=t[i];if(typeof a!="number")return!1;let s=q(r.get(a));if(!s)return!1;let l=qe(s),u=n.find(h=>h.column===a);return u&&qe(u.header)===l||Number.isFinite(zi(i,s))||i==="identity"&&["number","no","numara"].includes(l)?!0:i==="comparisonText"&&["name","description","desc","text","aciklama"].includes(l)})}function Au(e,t){let n=new Map;for(let s of e.cells)n.set(s.column,s.text);let r={};for(let s of Mr){let l=t[s];typeof l=="number"&&(r[s]=q(n.get(l)))}let o=q(r.identity),i=q(r.comparisonText);if(!o&&!i)return null;let a=Ct([o,i]);return{scheduleRowId:`${e.scheduleId}:${e.section}:${e.row}`,scheduleId:e.scheduleId,scheduleName:e.scheduleName,section:e.section,row:e.row,rawCells:e.cells.map(s=>({column:s.column,text:s.text})),mappedValues:r,identityText:o,comparisonText:i,normalizedKey:a.normalizedKey,tokenProfile:a,visibilityBasis:We}}function Bi(e,t,n,r){let o=C(e,"rows"),i=C(e,"cells");return(o.length>0?o:i).flatMap(s=>{let l=Vi(c(s,"row"));if(l===null)return[];let u=C(s,"cells").map(h=>({column:Vi(c(h,"column")),text:q(c(h,"text"))})).filter(h=>h.column!==null);return[{scheduleId:t,scheduleName:n,section:r,row:l,cells:u}]})}function Ou(e,t){let n=new Map;for(let r of C(e,"sections"))if(kr(c(r,"section"))==="header")for(let o of Bi(r,Wi(c(e,"id"))||"unknown",Pr(c(e,"name")),"header"))for(let i of o.cells)!n.has(i.column)&&i.text.length>0&&n.set(i.column,i.text);return Array.isArray(t)&&t.forEach((r,o)=>{let i=q(r);i.length>0&&!n.has(o)&&n.set(o,i)}),[...n.entries()].sort(([r],[o])=>r-o).map(([r,o])=>({column:r,header:o}))}function Vu(e,t){let n=[],r=[],o={},i=new Set;for(let a of Mr){let s=t?.[a];if(s!==void 0){let l=Du(s,e);if(l===null)return{error:{role:a,reason:"unresolved_column_ref",value:s}};o[a]=l,i.add(l)}}for(let a of Mr){if(o[a]!==void 0)continue;let s=Fu(a,e);if(s.length===0)continue;let l=Lu(s,i);if(l.kind==="ambiguous")return{error:{role:a,reason:"ambiguous_alias",candidates:l.candidates}};o[a]=l.match.column,i.add(l.match.column)}for(let a of Di)if(o[a]===void 0)return{error:{role:a,reason:"missing_required_role"}};return{mapping:o,warnings:n,notices:r}}function Du(e,t){if(typeof e=="number")return t.length>0&&!t.some(i=>i.column===e)?null:e;let n=e.trim(),r=qe(n),o=t.filter(i=>qe(i.header)===r);return o.length===1?o[0].column:null}function zi(e,t){let n=Ht(t),r=Mu[e];for(let o=0;o<r.length;o++)if(Ht(r[o])===n)return o;return Number.POSITIVE_INFINITY}function Fu(e,t){return t.map(n=>({header:n.header,column:n.column,priority:zi(e,n.header)})).filter(n=>Number.isFinite(n.priority))}function Lu(e,t){let n=e.filter(a=>!t.has(a.column)),r=n.length>0?n:e,o=Math.min(...r.map(a=>a.priority)),i=r.filter(a=>a.priority===o);return i.length===1?{kind:"resolved",match:i[0]}:{kind:"ambiguous",candidates:i.map(a=>a.header)}}function Oi(e,t){return{sourceKind:e.kind,sections:t,columnMapping:e.columnMapping||null,numericColumnBase:"zero_based_revit_schedule_column",visibilityBasis:We}}function Fn(e,t,n={}){let{warnings:r=[],notices:o=[],elapsedMs:i,scanPolicy:a,summary:s,suggestedNextScopes:l=[],...u}=n;return de({action:Dn,reason:e,message:t,elapsedMs:i,extra:{stage:Nr,adapterContractVersion:1,visibilityBasis:We,...u},summary:s||{},evidenceRows:[],scanPolicy:a||{},suggestedNextScopes:l,warnings:r,notices:o})}function ju(e,t={}){let{warnings:n=[],notices:r=[],elapsedMs:o,scanPolicy:i,summary:a,...s}=t;return fe({action:Dn,error:e,elapsedMs:o,extra:{stage:Nr,adapterContractVersion:1,visibilityBasis:We,...s},summary:a||{},evidenceRows:[],scanPolicy:i||{},warnings:n,notices:r})}function qi(e){let t=Array.isArray(e)&&e.length>0?e:_u;return[...new Set(t.map(kr))].filter(n=>["header","body","footer"].includes(n))}function kr(e){let t=q(e).toLowerCase();return["header","body","footer"].includes(t)?t:"body"}function ot(e,t){let n=c(e,t);return Array.isArray(n)?n.map(q).filter(r=>r.length>0):[]}function Vi(e){if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="string"){let t=e.trim();if(t.length===0)return null;let n=Number(t);return Number.isFinite(n)?n:null}return null}function Wi(e){return Pr(e)}function Pr(e){let t=q(e);return t.length>0?t:null}import{z as N}from"zod";var Qt={score:{exact:100,diceTokenOverlap:35,code:20,dimension:20,order:15,context:10},thresholds:{highConfidenceMin:86,highConfidenceMax:99,candidateMin:65,possibleRenameMin:72,possibleRenameMax:85,ambiguousMin:65,ambiguousMax:71,candidateGap:8,tieGap:8},caps:{conflictingCode:64,conflictingDimension:60,unitMismatch:79},candidateGeneration:{minSharedSignificantWordTokens:2},contextFields:["system","unit","quantity","discipline"]},Bu=N.object({exact:N.number().min(0).max(100).optional(),diceTokenOverlap:N.number().min(0).max(100).optional(),code:N.number().min(0).max(100).optional(),dimension:N.number().min(0).max(100).optional(),order:N.number().min(0).max(100).optional(),context:N.number().min(0).max(100).optional()}).strict(),zu=N.object({highConfidenceMin:N.number().min(0).max(100).optional(),highConfidenceMax:N.number().min(0).max(100).optional(),candidateMin:N.number().min(0).max(100).optional(),possibleRenameMin:N.number().min(0).max(100).optional(),possibleRenameMax:N.number().min(0).max(100).optional(),ambiguousMin:N.number().min(0).max(100).optional(),ambiguousMax:N.number().min(0).max(100).optional(),candidateGap:N.number().min(0).max(100).optional(),tieGap:N.number().min(0).max(100).optional()}).strict(),qu=N.object({conflictingCode:N.number().min(0).max(100).optional(),conflictingDimension:N.number().min(0).max(100).optional(),unitMismatch:N.number().min(0).max(100).optional()}).strict(),Wu=N.object({minSharedSignificantWordTokens:N.number().int().min(0).max(20).optional()}).strict(),jn=N.object({score:Bu.optional(),thresholds:zu.optional(),caps:qu.optional(),candidateGeneration:Wu.optional(),contextFields:N.array(N.string().min(1)).optional()}).strict(),Gu=N.object({excelRecords:N.array(N.record(N.unknown())).optional(),scheduleRecords:N.array(N.record(N.unknown())).optional(),excelResult:N.record(N.unknown()).optional(),scheduleResult:N.record(N.unknown()).optional(),config:jn.optional()}).strict();function Qi(e){let t=Date.now(),n=Gu.safeParse(e);if(!n.success)return re({success:!0,guarded:!0,state:"guarded",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,reason:"reconciliation_input_required",message:"Provide excelRecords and scheduleRecords, or normalized ingestion result envelopes containing those arrays.",validationIssues:n.error.issues.map(l=>l.message),partial:!1,scanStoppedReason:"needs_scope"},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"needs_scope",elapsedMs:Date.now()-t,summary:{},evidenceRows:[]});let r=td(n.data.config),o=Gi("excel",n.data.excelRecords??Ji(n.data.excelResult,"excelRecords")),i=Gi("schedule",n.data.scheduleRecords??Ji(n.data.scheduleResult,"scheduleRecords")),a=Ju(o,i,r),s=nd(o,i,a);return re({success:!0,guarded:!1,state:"review_ready",action:"reconcile_schedule_excel",stage:"matching_scoring",reconciliationContractVersion:1,partial:!1,scanStoppedReason:"completed",reviewRows:a,reviewTable:rd(a),suggestedNextActions:["review_ambiguous","accept_match","create_schedule_row","remove_or_ignore_schedule_row","rename_excel_or_schedule_text"],scoringConfig:r},{action:"reconcile_schedule_excel",partial:!1,scanStoppedReason:"completed",elapsedMs:Date.now()-t,summary:s,evidenceRows:a.map(l=>({sourceType:"reconciliationReviewRow",bucket:l.bucket,score:l.score,excelRowId:l.excelRow?.excelRowId??l.excelRow?.recordId??null,scheduleRowId:l.scheduleRow?.scheduleRowId??l.scheduleRow?.recordId??null,reason:l.reason}))})}function Ju(e,t,n){let r=[],o=new Set,i=new Set,a=$i(e),s=$i(t);for(let l of e){let u=Hu(l,t,n),h=l.normalizedKey.length>0&&(a.has(l.normalizedKey)||s.has(l.normalizedKey)),m=u[0]||null;if(h&&u.some(b=>b.score===n.score.exact||b.schedule.normalizedKey===l.normalizedKey)){let b=u.filter(y=>y.schedule.normalizedKey===l.normalizedKey||y.score>=n.thresholds.candidateMin).slice(0,5);r.push(Ar("ambiguousMatches",b[0]||null,l,null,b,"duplicate_exact_key","review_ambiguous")),o.add(l.id),b.forEach(y=>i.add(y.schedule.id));continue}if(!m||m.score<n.thresholds.candidateMin&&m.hardConflicts.length===0){r.push(Yu(l)),o.add(l.id);continue}if(i.has(m.schedule.id)){r.push(Ar("ambiguousMatches",m,l,m.schedule,u.slice(0,5),"schedule_row_already_claimed","review_ambiguous")),o.add(l.id);continue}let g=Uu(m,u[1]||null,n);r.push(Ar(g.bucket,m,l,m.schedule,u.slice(0,5),g.reason,g.action)),o.add(l.id),i.add(m.schedule.id),g.bucket==="ambiguousMatches"&&u.filter(b=>b.score>=n.thresholds.candidateMin).slice(0,5).forEach(b=>i.add(b.schedule.id))}for(let l of t)i.has(l.id)||r.push(Ku(l));return r.sort(ud)}function Uu(e,t,n){let r=t?e.score-t.score:Number.POSITIVE_INFINITY,o=t!==null&&e.score===t.score;if(o||r<n.thresholds.tieGap||e.score>=n.thresholds.ambiguousMin&&e.score<=n.thresholds.ambiguousMax)return{bucket:"ambiguousMatches",reason:o?"best_score_tie":r<n.thresholds.tieGap?"candidate_gap_below_threshold":"ambiguous_score_band",action:"review_ambiguous"};if(e.components.exact>0&&e.hardConflicts.length===0&&e.score===n.score.exact)return{bucket:"exactMatches",reason:"exact_normalized_key",action:"accept_match"};let i=(e.sharedCodeTokens.length>0||e.sharedDimensionTokens.length>0)&&e.descriptiveTokensDiffer;return!e.hardConflicts.length&&e.score>=n.thresholds.highConfidenceMin&&i?{bucket:"possibleRenames",reason:"shared_key_tokens_with_description_change",action:"rename_excel_or_schedule_text"}:e.score>=n.thresholds.highConfidenceMin&&e.score<=n.thresholds.highConfidenceMax&&!e.capped&&r>=n.thresholds.candidateGap?{bucket:"highConfidenceMatches",reason:"high_confidence_score_and_gap",action:"accept_match"}:!e.hardConflicts.length&&(e.score>=n.thresholds.highConfidenceMin&&i||e.score>=n.thresholds.possibleRenameMin&&e.score<=n.thresholds.possibleRenameMax)?{bucket:"possibleRenames",reason:i?"shared_key_tokens_with_description_change":"possible_rename_score_band",action:"rename_excel_or_schedule_text"}:{bucket:"ambiguousMatches",reason:e.hardConflicts.length>0?"hard_conflict_requires_review":"requires_review",action:"review_ambiguous"}}function Hu(e,t,n){return t.filter(r=>$u(e,r,n)).map(r=>({...Qu(e,r,n),excel:e,schedule:r})).sort(cd)}function $u(e,t,n){return e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey||ve(G(e,"code"),G(t,"code")).length>0||ve(G(e,"dimension"),G(t,"dimension")).length>0?!0:ve(G(e,"word"),G(t,"word")).length>=n.candidateGeneration.minSharedSignificantWordTokens}function Qu(e,t,n){let r=e.normalizedKey.length>0&&e.normalizedKey===t.normalizedKey,o=_t(e.tokenProfile.tokens.map(y=>y.value)),i=_t(t.tokenProfile.tokens.map(y=>y.value)),a=ve(o,i),s=_t(o.concat(i).filter(y=>!a.includes(y))),l=ve(G(e,"code"),G(t,"code")),u=ve(G(e,"dimension"),G(t,"dimension")),h=Xu(e,t),m={exact:r?n.score.exact:0,dice:r?0:Ln(id(o,i)*n.score.diceTokenOverlap),code:r?0:Hi(G(e,"code"),G(t,"code"),n.score.code),dimension:r?0:Hi(G(e,"dimension"),G(t,"dimension"),n.score.dimension),order:r?0:Ln(ad(o,i)*n.score.order),context:r?0:od(e,t,n)},g=r?n.score.exact:Or(m.dice+m.code+m.dimension+m.order+m.context),b=g;for(let y of h)y==="conflicting_code"&&(b=Math.min(b,n.caps.conflictingCode)),y==="conflicting_dimension"&&(b=Math.min(b,n.caps.conflictingDimension)),y==="unit_mismatch"&&(b=Math.min(b,n.caps.unitMismatch));return{score:Or(b),rawScore:Or(g),components:m,matchedTokens:a,differingTokens:s,hardConflicts:h,sharedCodeTokens:l,sharedDimensionTokens:u,descriptiveTokensDiffer:ld(e,t),capped:b<g}}function Xu(e,t){let n=[],r=G(e,"code"),o=G(t,"code");r.length>0&&o.length>0&&ve(r,o).length===0&&n.push("conflicting_code");let i=G(e,"dimension"),a=G(t,"dimension");i.length>0&&a.length>0&&ve(i,a).length===0&&n.push("conflicting_dimension");let s=Ui(e),l=Ui(t);return s.length>0&&l.length>0&&ve(s,l).length===0&&n.push("unit_mismatch"),n}function Ar(e,t,n,r,o,i,a){return{bucket:e,score:t?.score??0,rawScore:t?.rawScore??0,reason:i,matchedTokens:t?.matchedTokens??[],differingTokens:t?.differingTokens??[],hardConflicts:t?.hardConflicts??[],scoreComponents:t?.components??null,excelRow:n?Xt(n):null,scheduleRow:r?Xt(r):null,candidateRows:o.map(s=>({score:s.score,rawScore:s.rawScore,scheduleRow:Xt(s.schedule),matchedTokens:s.matchedTokens,hardConflicts:s.hardConflicts})),recommendedNextAction:a}}function Yu(e){return{bucket:"missingInSchedule",score:0,rawScore:0,reason:"no_schedule_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:Xt(e),scheduleRow:null,candidateRows:[],recommendedNextAction:"create_schedule_row"}}function Ku(e){return{bucket:"missingInExcel",score:0,rawScore:0,reason:"no_excel_candidate_at_threshold",matchedTokens:[],differingTokens:e.tokenProfile.tokens.map(t=>t.value),hardConflicts:[],scoreComponents:null,excelRow:null,scheduleRow:Xt(e),candidateRows:[],recommendedNextAction:"remove_or_ignore_schedule_row"}}function Xt(e){return{...e.raw,recordId:e.id,normalizedKey:e.normalizedKey,tokenProfile:e.tokenProfile}}function Gi(e,t){return Array.isArray(t)?t.filter(n=>!!n&&typeof n=="object"&&!Array.isArray(n)).map((n,r)=>Zu(e,n,r)):[]}function Zu(e,t,n=0){let r=e==="excel"?q(t.excelRowId||t.recordId||t.id):q(t.scheduleRowId||t.recordId||t.id),o=Yt(t.mappedValues)?t.mappedValues:{},i=ed(t,[t.identityText,t.comparisonText]);return{side:e,id:r||`${e}:${i.normalizedKey||"row"}:${n}`,normalizedKey:q(t.normalizedKey)||i.normalizedKey,tokenProfile:i,raw:t,mappedValues:o}}function ed(e,t){let n=Yt(e.tokenProfile)?e.tokenProfile:null;return n&&Array.isArray(n.tokens)&&typeof n.normalizedKey=="string"?{profileVersion:1,normalizedKey:q(n.normalizedKey),tokens:n.tokens.filter(r=>Yt(r)&&typeof r.type=="string"&&typeof r.value=="string").map(r=>({type:r.type,value:q(r.value)})).filter(r=>r.value.length>0)}:Ct(t)}function Ji(e,t){return Yt(e)&&Array.isArray(e[t])?e[t].filter(n=>Yt(n)):[]}function td(e){let t=jn.safeParse(e||{}),n=t.success?t.data:{};return{score:{...Qt.score,...n.score||{}},thresholds:{...Qt.thresholds,...n.thresholds||{}},caps:{...Qt.caps,...n.caps||{}},candidateGeneration:{...Qt.candidateGeneration,...n.candidateGeneration||{}},contextFields:n.contextFields||Qt.contextFields}}function nd(e,t,n){let r=Object.fromEntries(["exactMatches","highConfidenceMatches","possibleRenames","ambiguousMatches","missingInSchedule","missingInExcel"].map(o=>[o,0]));for(let o of n)r[o.bucket]=(r[o.bucket]||0)+1;return{excelRows:e.length,scheduleRows:t.length,...r,reviewRowCount:n.length}}function rd(e){return{columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}],rows:e.map(n=>({bucket:n.bucket,score:n.score,reason:n.reason,excelRowId:n.excelRow?.excelRowId??n.excelRow?.recordId??"",scheduleRowId:n.scheduleRow?.scheduleRowId??n.scheduleRow?.recordId??"",excelText:n.excelRow?[n.excelRow.identityText,n.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:n.scheduleRow?[n.scheduleRow.identityText,n.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:(n.hardConflicts||[]).join(", "),recommendedNextAction:n.recommendedNextAction}))}}function G(e,t){return _t(e.tokenProfile.tokens.filter(n=>n.type===t).map(n=>n.value))}function Ui(e){let t=G(e,"unit");for(let r of G(e,"dimension")){let o=r.match(/^[A-Z]+|[A-Z]+$/)?.[0];o&&t.push(o)}let n=vt(e.mappedValues.unit);return n&&t.push(n),_t(t)}function Hi(e,t,n){if(e.length===0||t.length===0)return 0;let r=ve(e,t).length,o=Math.max(e.length,t.length);return Ln(r/o*n)}function od(e,t,n){let r=n.contextFields.map(i=>[vt(e.mappedValues[i]),vt(t.mappedValues[i])]).filter(([i,a])=>i.length>0&&a.length>0);if(r.length===0)return 0;let o=r.filter(([i,a])=>i===a).length;return Ln(o/r.length*n.score.context)}function id(e,t){return e.length===0&&t.length===0?1:e.length===0||t.length===0?0:2*ve(e,t).length/(e.length+t.length)}function ad(e,t){let n=Math.min(e.length,t.length);return n===0?0:sd(e,t)/n}function sd(e,t){let n=Array.from({length:e.length+1},()=>Array(t.length+1).fill(0));for(let r=1;r<=e.length;r++)for(let o=1;o<=t.length;o++)n[r][o]=e[r-1]===t[o-1]?n[r-1][o-1]+1:Math.max(n[r-1][o],n[r][o-1]);return n[e.length][t.length]}function ld(e,t){let n=G(e,"word"),r=G(t,"word");return n.length>0&&r.length>0&&!dd(n,r)}function $i(e){let t=new Map;for(let n of e)n.normalizedKey.length>0&&t.set(n.normalizedKey,(t.get(n.normalizedKey)||0)+1);return new Set([...t.entries()].filter(([,n])=>n>1).map(([n])=>n))}function cd(e,t){return t.score!==e.score?t.score-e.score:e.schedule.id.localeCompare(t.schedule.id)}function ud(e,t){let n={exactMatches:0,highConfidenceMatches:1,possibleRenames:2,ambiguousMatches:3,missingInSchedule:4,missingInExcel:5},r=n[e.bucket]??99,o=n[t.bucket]??99;if(r!==o)return r-o;if((t.score||0)!==(e.score||0))return(t.score||0)-(e.score||0);let i=e.excelRow?.recordId||e.scheduleRow?.recordId||"",a=t.excelRow?.recordId||t.scheduleRow?.recordId||"";return String(i).localeCompare(String(a))}function ve(e,t){let n=new Set(t);return _t(e.filter(r=>n.has(r)))}function _t(e){return[...new Set(e.filter(t=>q(t).length>0))]}function dd(e,t){let n=new Set(e),r=new Set(t);return n.size!==r.size?!1:[...n].every(o=>r.has(o))}function Ln(e){return Math.round(e)}function Or(e){return Math.max(0,Math.min(100,Math.round(e)))}function Yt(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var Ki="reconcile_schedule_excel",md=50,it=Vr.object({excel:_r.describe('Excel/CSV source. Use kind:"file" for .xlsx/.csv/.tsv or kind:"rows" for deterministic CI/dry-run records.'),schedule:Er.describe('Schedule source. Use kind:"inspect_schedules_result" with a normalized inspect_schedules result, or kind:"revit_schedule" to read bounded live Revit schedule rows through inspect_schedules before reconciliation.'),config:jn.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),responseMode:Be,maxReviewRows:Vr.number().int().positive().max(1e3).optional().describe("Compact-mode cap for returned reviewTable/evidenceRows rows. Defaults 50; full/debug returns all reviewRows."),maxCandidateRows:Vr.number().int().positive().max(10).optional().describe("Compatibility input for older callers. Compact mode omits nested candidateRows; full/debug returns all candidates.")}).strict();function Dr(e,t,n,r={}){let{warnings:o=[],notices:i=[],scanPolicy:a={},summary:s={},suggestedNextScopes:l=[],...u}=r;return de({action:Ki,reason:t,message:n,extra:{stage:e,reconciliationContractVersion:1,...u},summary:s,evidenceRows:[],scanPolicy:a,suggestedNextScopes:l,warnings:o,notices:i})}function Fr(e,t,n={}){let{warnings:r=[],notices:o=[],scanPolicy:i={},summary:a={},suggestedNextScopes:s=[],...l}=n;return fe({action:Ki,error:t,extra:{stage:e,reconciliationContractVersion:1,...l},summary:a,evidenceRows:[],scanPolicy:i,suggestedNextScopes:s,warnings:r,notices:o})}function Xi(e){return e.guarded===!0||e.state==="guarded"}function Yi(e){return e.success===!1||e.state==="failed"||!!e.error}function at(e){return Array.isArray(e)?e.map(t=>String(t??"").trim()).filter(t=>t.length>0):[]}function pd(...e){for(let t of e){let n=String(t.scanStoppedReason||"").trim();if(n&&n!=="completed")return n}return null}var hd={requiredRoles:["identity","comparisonText"],optionalRoles:["code","description","quantity","unit","system","discipline","notes"]},fd={rowsSource:{excel:{kind:"rows",sheetName:"Items",rows:[{Identity:"FCU-101",Description:"Fan coil supply DN100",Unit:"PCS"}],columnMapping:{identity:"Identity",comparisonText:"Description",unit:"Unit"}},schedule:{kind:"inspect_schedules_result",result:{success:!0,schedules:[{id:7001,name:"Mechanical Equipment Schedule",sections:[{section:"header",rows:[{row:0,cells:[{column:0,text:"Identity"},{column:1,text:"Description"}]}]},{section:"body",rows:[{row:1,cells:[{column:0,text:"FCU-101"},{column:1,text:"Fan coil supply DN100"}]}]}]}]}},responseMode:"compact"},fileSource:{excel:{kind:"file",path:"C:\\path\\items.xlsx",format:"xlsx",selection:{sheetName:"Items",headerRow:1,dataStartRow:2},columnMapping:{identity:"Identity",comparisonText:"Description"}},schedule:{kind:"inspect_schedules_result",result:'inspect_schedules result with responseMode="full" when schedule body cells are needed'}}};function gd(e){return[e.bucket,e.reason,e.score,e.excelRow?.excelRowId??e.excelRow?.recordId??"",e.scheduleRow?.scheduleRowId??e.scheduleRow?.recordId??""].join("|")}function yd(e,t){let n=Array.isArray(t.columns)?t.columns:[{key:"bucket",label:"Bucket"},{key:"score",label:"Score"},{key:"reason",label:"Reason"},{key:"excelRowId",label:"Excel Row"},{key:"scheduleRowId",label:"Schedule Row"},{key:"excelText",label:"Excel Text"},{key:"scheduleText",label:"Schedule Text"},{key:"hardConflicts",label:"Hard Conflicts"},{key:"recommendedNextAction",label:"Recommended Action"}];return{...t,columns:n,rows:e.map(r=>({bucket:r.bucket,score:r.score,reason:r.reason,excelRowId:r.excelRow?.excelRowId??r.excelRow?.recordId??"",scheduleRowId:r.scheduleRow?.scheduleRowId??r.scheduleRow?.recordId??"",excelText:r.excelRow?[r.excelRow.identityText,r.excelRow.comparisonText].filter(Boolean).join(" | "):"",scheduleText:r.scheduleRow?[r.scheduleRow.identityText,r.scheduleRow.comparisonText].filter(Boolean).join(" | "):"",hardConflicts:Array.isArray(r.hardConflicts)?r.hardConflicts.join(", "):"",recommendedNextAction:r.recommendedNextAction}))}}function bd(e,t){let n=t.responseMode||"compact";if(ze(n))return{...e,responseMode:n};let r=xe(t.maxReviewRows,md,1e3),o=ce(e.reviewRows,{limit:r,key:gd}),i=ce(e.evidenceRows,{limit:r}),{reviewRows:a,reviewTable:s,scoringConfig:l,sourceSummary:u,...h}=e;return{...h,responseMode:"compact",reviewTable:yd(o.rows,e.reviewTable||{}),evidenceRows:i.rows,summary:{...e.summary||{},compactResponse:!0,reviewRowCount:o.totalCount,returnedReviewRowCount:o.returnedCount,omittedReviewRowCount:o.omittedCount,duplicateReviewRowCount:o.duplicateCount,evidenceRowCount:i.totalCount,returnedEvidenceRowCount:i.returnedCount,omittedEvidenceRowCount:i.omittedCount},notices:[...at(e.notices),'Compact response returns summary, reviewTable, evidenceRows, and count metadata only. Use responseMode="full" for reviewRows, token profiles, raw cells, and nested candidates.']}}async function Sd(e,t={}){let n=it.safeParse(e);if(!n.success)return Dr("input_validation","reconciliation_input_required","Provide excel and schedule sources before reconciliation.",{validationIssues:n.error.issues.map(l=>`${l.path.join(".")||"<root>"}: ${l.message}`),requiredColumnMapping:hd,schemaExamples:fd,suggestedNextScopes:["excel.kind","excel.rows","excel.path","excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText","schedule.kind","schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"]});let r=await Ai(n.data.excel);if(Xi(r))return Dr("excel_ingestion",r.reason||"excel_ingestion_guarded",r.message||"Excel ingestion was guarded before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});if(Yi(r))return Fr("excel_ingestion",r.error||"Excel ingestion failed before reconciliation.",{excelResult:r,summary:r.summary||{},scanPolicy:r.scanPolicy||{},suggestedNextScopes:r.suggestedNextScopes||["excel.selection","excel.columnMapping.identity","excel.columnMapping.comparisonText"],warnings:r.warnings||[],notices:r.notices||[]});let o=await Li(n.data.schedule,t.scheduleAdapter);if(Xi(o))return Dr("schedule_record_adapter",o.reason||"schedule_adapter_guarded",o.message||"Schedule adaptation was guarded before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});if(Yi(o))return Fr("schedule_record_adapter",o.error||"Schedule adaptation failed before reconciliation.",{scheduleResult:o,summary:o.summary||{},scanPolicy:o.scanPolicy||{},suggestedNextScopes:o.suggestedNextScopes||["schedule.result","schedule.columnMapping.identity","schedule.columnMapping.comparisonText"],warnings:o.warnings||[],notices:o.notices||[]});let i=Qi({excelResult:r,scheduleResult:o,config:n.data.config}),a=r.partial===!0||o.partial===!0,s=a&&pd(o,r)||i.scanStoppedReason;return bd({...i,partial:i.partial===!0||a,scanStoppedReason:s,scanPolicy:{...i.scanPolicy||{},excel:r.scanPolicy||{},schedule:o.scanPolicy||{}},warnings:[...at(i.warnings),...at(r.warnings),...at(o.warnings)],notices:[...at(i.notices),...at(r.notices),...at(o.notices)],sourceSummary:{excel:r.summary||{},schedule:o.summary||{}},sourceResults:{excel:{sourceKind:r.sourceKind,format:r.format,sheetName:r.sheetName,partial:r.partial,scanStoppedReason:r.scanStoppedReason,recordCount:Array.isArray(r.excelRecords)?r.excelRecords.length:0},schedule:{sourceKind:o.sourceKind,visibilityBasis:o.visibilityBasis,partial:o.partial,scanStoppedReason:o.scanStoppedReason,recordCount:Array.isArray(o.scheduleRecords)?o.scheduleRecords.length:0}}},n.data)}function Zi(e){e.tool("reconcile_schedule_excel",'[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus either normalized inspect_schedules output or bounded live revit_schedule input, normalizes rows, scores deterministic matches, and returns compact review tables by default. excel.kind="rows" expects an object with rows:[...] plus columnMapping.identity and columnMapping.comparisonText; file sources use path/format/selection with the same required mapping. schedule.kind="revit_schedule" requires scheduleIds or nameQuery unless allowExpensiveSearch=true. Default responseMode=compact returns summary, reviewTable, evidenceRows, and count metadata only; use responseMode=full/debug for reviewRows, token profiles, raw cells, and nested candidateRows. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.',{excel:it.shape.excel,schedule:it.shape.schedule,config:it.shape.config,responseMode:it.shape.responseMode,maxReviewRows:it.shape.maxReviewRows,maxCandidateRows:it.shape.maxCandidateRows},async(t={})=>{try{return p(await Sd(t))}catch(n){return p(Fr("runtime_failure",n instanceof Error?n.message:String(n)))}})}import{z as M}from"zod";var wd={fast:{maxElapsedMs:4500,timeoutMs:12e3,maxMatches:1e3},balanced:{maxElapsedMs:15e3,timeoutMs:3e4,maxMatches:5e3},deep:{maxElapsedMs:45e3,timeoutMs:6e4,maxMatches:2e4}},zn=["sheetQuery","sheetIds","viewNameQuery","sources","profiles","countMode","groupBy","maxSheets","maxViewports","maxMatches","maxResponseBytes","allowExpensiveSearch"];function ee(e,t,n,r){if(e==null||e==="")return t;let o=Number.parseInt(String(e??""),10);return Number.isFinite(o)?Math.max(n,Math.min(r,o)):t}function ea(e){let t=["fast","balanced","deep"].includes(String(e.searchBudget||""))?String(e.searchBudget):"fast",n=wd[t],r=ee(e.maxElapsedMs,n.maxElapsedMs,1,119e3),o=ee(e.timeoutMs,Math.max(n.timeoutMs,Math.min(12e4,r+5e3)),1e3,12e4);return{searchBudget:t,maxElapsedMs:Math.min(r,Math.max(1,o-1e3)),timeoutMs:o,maxMatches:ee(e.maxMatches,n.maxMatches,1,2e5)}}function xd(e){let t=String(e??"").trim();return/^sheet_?text_?notes?$/i.test(t)||/^sheetTextNotes?$/i.test(t)?"sheet_text_notes":/^viewport_?tags?$/i.test(t)||/^viewportTags?$/i.test(t)?"viewport_tags":/^viewport_?text_?notes?$/i.test(t)||/^viewportTextNotes?$/i.test(t)||/^view_?text_?notes?$/i.test(t)||/^viewTextNotes?$/i.test(t)?"viewport_text_notes":/^placed_?schedule_?cells?$/i.test(t)||/^placedScheduleCells?$/i.test(t)||/^schedule_?cells?$/i.test(t)||/^scheduleCells?$/i.test(t)?"placed_schedule_cells":t}function st(e){let t=String(e??"").trim();return/^unique_?text$/i.test(t)?"uniqueText":/^unique_?tag$/i.test(t)?"uniqueTag":/^unique_?tagged_?element$/i.test(t)?"uniqueTaggedElement":"occurrence"}function ta(e){return e==="uniqueTag"||e==="uniqueTaggedElement"}function Bn(e,t,n,r){return e==="deep"?r:e==="balanced"?n:t}function Lr(e){let t=st(e.countMode),n=Array.isArray(e.sources)?e.sources:[],r=[...new Set(n.map(xd).filter(o=>o.length>0))];return r.length>0?r:ta(t)?["viewport_tags"]:["sheet_text_notes","viewport_text_notes","placed_schedule_cells","viewport_tags"]}function vd(e){return Array.isArray(e.sources)&&e.sources.length>0}function na(e){return!!(Array.isArray(e.sheetIds)&&e.sheetIds.length>0||String(e.sheetQuery||"").trim())}function jr(e){let t=ea(e);return{searchBudget:t.searchBudget,allowExpensiveSearch:e.allowExpensiveSearch===!0,sources:Lr(e),countMode:st(e.countMode),groupBy:Array.isArray(e.groupBy)?e.groupBy:[],maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs,maxSheets:ee(e.maxSheets,30,1,200),maxViewportsPerSheet:ee(e.maxViewportsPerSheet??e.maxViewports,20,0,200),maxTextNotesScanned:ee(e.maxTextNotesScanned,Bn(t.searchBudget,1e3,5e3,2e4),1,2e5),maxTagsScanned:ee(e.maxTagsScanned??e.maxTags,Bn(t.searchBudget,500,2500,1e4),1,1e5),maxScheduleInstancesPerSheet:ee(e.maxScheduleInstancesPerSheet,20,0,200),maxRowsPerSchedule:ee(e.maxRowsPerSchedule,250,1,2e3),maxColumnsPerSchedule:ee(e.maxColumnsPerSchedule,20,1,200),maxScheduleInstancesScanned:ee(e.maxScheduleInstancesScanned,Bn(t.searchBudget,200,1e3,5e3),1,2e4),maxScheduleCellsScanned:ee(e.maxScheduleCellsScanned,Bn(t.searchBudget,1e3,5e3,2e4),1,2e5),maxMatches:t.maxMatches,maxTextChars:ee(e.maxTextChars,240,1,1e3),maxRegexPatternLength:ee(e.maxRegexPatternLength,240,1,1e3),regexTimeoutMs:ee(e.regexTimeoutMs,25,1,250),maxResponseBytes:ee(e.maxResponseBytes,4*1024*1024,4096,16*1024*1024),sheetScoped:na(e)}}function Cd(e,t){return{query:e.query,regex:e.regex,normalizedRegex:e.normalizedRegex,matchMode:e.matchMode,sheetQuery:e.sheetQuery,sheetIds:e.sheetIds,viewNameQuery:e.viewNameQuery,sources:Lr(e),profiles:e.profiles,profileName:e.profileName,countMode:st(e.countMode),groupBy:e.groupBy,allowExpensiveSearch:e.allowExpensiveSearch,searchBudget:t.searchBudget,maxElapsedMs:t.maxElapsedMs,maxSheets:e.maxSheets,maxViewportsPerSheet:e.maxViewportsPerSheet,maxViewports:e.maxViewports,maxTextNotesScanned:e.maxTextNotesScanned,maxTagsScanned:e.maxTagsScanned,maxTags:e.maxTags,maxScheduleInstancesPerSheet:e.maxScheduleInstancesPerSheet,maxRowsPerSchedule:e.maxRowsPerSchedule,maxColumnsPerSchedule:e.maxColumnsPerSchedule,maxScheduleInstancesScanned:e.maxScheduleInstancesScanned,maxScheduleCellsScanned:e.maxScheduleCellsScanned,maxMatches:t.maxMatches,maxTextChars:e.maxTextChars,maxRegexPatternLength:e.maxRegexPatternLength,regexTimeoutMs:e.regexTimeoutMs,maxResponseBytes:e.maxResponseBytes,timeoutMs:t.timeoutMs,taskName:e.taskName||"Count Revit annotations",taskId:e.taskId}}function qn(e){let t=String(c(e,"sourceType")||""),n=String(c(e,"kind")||""),r=[t,n];return r.some(o=>o==="viewportTag"||o==="viewport_tags")?"viewportTag":r.some(o=>o==="viewportTextNote"||o==="viewport_text_notes")?"viewportTextNote":r.some(o=>o==="sheetTextNote"||o==="sheet_text_notes")?"sheetTextNote":r.some(o=>o==="placedScheduleCell"||o==="placed_schedule_cells"||o==="scheduleCell")?"placedScheduleCell":t||n||"annotation"}function Wn(e){let t=C(e,"evidenceRows");return(t.length>0?t:C(e,"matches")).map(r=>({...r,sourceType:qn(r)}))}function Td(e){let t=String(e??"").trim();return/^source_?type$/i.test(t)?"sourceType":/^(profile|profileName)$/i.test(t)?"profile":/^(pattern|patternName)$/i.test(t)?"pattern":/^(matchedCode|matchedText|uniqueText)$/i.test(t)?"matchedText":/^tagFamilyType$/i.test(t)?"tagFamilyType":/^(taggedElement|taggedElementId)$/i.test(t)?"taggedElement":/^view$/i.test(t)?"view":/^sheet$/i.test(t)?"sheet":t}function Rd(e,t){let n={};if(t.length===0)return n.group="all",n;for(let r of t){let o=Td(r);o==="sheet"?(n.sheetId=c(e,"sheetId")??null,n.sheetNumber=c(e,"sheetNumber")??null):o==="view"?(n.viewId=c(e,"viewId")??null,n.viewName=c(e,"viewName")??null):o==="sourceType"?n.sourceType=qn(e):o==="profile"?n.profileName=c(e,"profileName")??null:o==="pattern"?n.patternName=c(e,"patternName")??null:o==="matchedText"?n.matchedTextNormalized=c(e,"matchedTextNormalized")??null:o==="tagFamilyType"?(n.tagFamilyName=c(e,"tagFamilyName")??null,n.tagTypeName=c(e,"tagTypeName")??null):o==="taggedElement"&&(n.taggedElementId=c(e,"taggedElementId")??null)}return Object.keys(n).length===0&&(n.group="all"),n}function Id(e){return Object.keys(e).sort().map(t=>`${t}=${String(e[t]??"")}`).join("|")}function _d(e,t){let n=qn(e);if(t==="occurrence")return"";if(t==="uniqueText")return`profile:${String(c(e,"profileName")??"").trim()}|text:${String(c(e,"matchedTextNormalized")??c(e,"textNormalized")??"").trim()}`;if(t==="uniqueTag"){if(n!=="viewportTag")return"";let r=String(c(e,"tagId")??"").trim();return r?`tag:${r}`:""}if(t==="uniqueTaggedElement"){if(n!=="viewportTag")return"";let r=c(e,"taggedElementResolved"),o=String(c(e,"taggedElementId")??"").trim();return!r||!o?"":`taggedElement:${o}`}return""}function ra(e,t,n){let r=new Map,o=new Set,i=0,a=0,s=e.map(l=>{let u={...l,sourceType:qn(l)},h=Rd(u,n),m=Id(h),g=r.get(m);g||(g={groupKey:m,...h,count:0,occurrenceCount:0,evidenceRowCount:0},r.set(m,g)),g.occurrenceCount+=1,g.evidenceRowCount+=1;let b=t==="occurrence"?`occurrence:${a++}`:_d(u,t),y=!!b&&!o.has(`${m}||${b}`);return y&&(o.add(`${m}||${b}`),g.count+=1,i+=1),{...u,groupKey:m,countKey:b,counted:y,countMode:t}});return{count:i,evidenceRows:s,groups:[...r.values()].sort((l,u)=>String(l.groupKey).localeCompare(String(u.groupKey)))}}function oa(e,t){let n=bt(e,"scanPolicy"),r=c(n,"groupBy")??c(e,"groupBy")??t?.groupBy;return Array.isArray(r)?r.map(String):[]}function ia(e,t){return st(c(e,"countMode")??c(bt(e,"summary"),"countMode")??t?.countMode)}function aa(e,t){let n=Wn(e),r=ia(e,t),o=ra(n,r,oa(e,t));return{count:c(e,"count")??o.count,countMode:r,occurrenceCount:c(e,"matchedOccurrenceCount")??o.evidenceRows.length,matchCount:o.evidenceRows.length,evidenceRowCount:o.evidenceRows.length,groupCount:C(e,"groups").length||o.groups.length,scannedSheetCount:c(e,"scannedSheetCount")??null,scannedViewportCount:c(e,"scannedViewportCount")??null,scannedTextNoteCount:c(e,"scannedTextNoteCount")??null,scannedTagCount:c(e,"scannedTagCount")??null,scannedScheduleInstanceCount:c(e,"scannedScheduleInstanceCount")??null,scannedScheduleCellCount:c(e,"scannedScheduleCellCount")??null,partial:c(e,"partial")===!0,scanStoppedReason:c(e,"scanStoppedReason")??"completed"}}function Md(e){let t=Wn(e),n=t.length>0?t[t.length-1]:null;return{lastReadSection:c(e,"lastReadSection")??null,lastReadRow:c(e,"lastReadRow")??null,lastReadColumn:c(e,"lastReadColumn")??null,lastReadSheetId:c(n,"sheetId")??c(e,"lastReadSheetId")??null,lastReadViewId:c(n,"viewId")??c(e,"lastReadViewId")??null,lastReadViewportId:c(n,"viewportId")??c(e,"lastReadViewportId")??null,lastReadItemId:c(n,"tagId")??c(n,"elementId")??c(n,"scheduleInstanceId")??c(n,"scheduleId")??c(n,"id")??c(e,"lastReadItemId")??null}}function Nd(e,t){let n=ia(e,t),r=ra(Wn(e),n,oa(e,t)),o=C(e,"groups");return e.countMode=n,e.evidenceRows=r.evidenceRows,e.matches=C(e,"matches").length>0?C(e,"matches"):e.evidenceRows,e.groups=o.length>0?o:r.groups,e.count=c(e,"count")??c(e.summary,"count")??r.count,e.summary={...aa(e,t),...bt(e,"summary")||{},count:c(e.summary,"count")??e.count,countMode:n,matchCount:c(e.summary,"matchCount")??e.evidenceRows.length,groupCount:c(e.summary,"groupCount")??e.groups.length},e}function Ed(e,t={},n){return Nd(re(e,{action:"count_annotations",elapsedMs:n,scanPolicy:jr(t),summary:r=>aa(r,t),evidenceRows:Wn,lastRead:Md,suggestedNextScopes:zn}),t)}function kd(e,t){return de({action:"count_annotations",reason:"needs_scope",message:"Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",suggestedNextScopes:zn,scanPolicy:jr({...e,maxElapsedMs:t.maxElapsedMs,timeoutMs:t.timeoutMs}),summary:{count:0,countMode:st(e.countMode),matchCount:0,groupCount:0}})}function Pd(e){return de({action:"count_annotations",reason:"invalid_count_mode_for_sources",message:"uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",suggestedNextScopes:zn,scanPolicy:jr(e),summary:{count:0,countMode:st(e.countMode),matchCount:0,groupCount:0}})}function sa(e){e.tool("count_annotations","[ANNOTATION_COUNT_READ_ONLY] Read-only native Revit annotation inventory/count for DrawingSheet text notes, viewport text notes, placed schedule cells, and viewport tag evidence. Use sheetQuery/sheetIds first; project-wide annotation counts require allowExpensiveSearch=true. Supports occurrence, uniqueText, uniqueTag, and uniqueTaggedElement count modes with bounded regex profiles.",{...S(M),...x(M),query:M.string().optional().describe("Anonymous text query. Defaults to contains matching unless matchMode is supplied."),regex:M.string().optional().describe("Anonymous raw regex pattern. Regex matching is bounded by maxRegexPatternLength and regexTimeoutMs."),normalizedRegex:M.string().optional().describe("Anonymous regex pattern evaluated against normalized annotation text."),matchMode:M.enum(["exact","contains","startsWith","regex","normalizedRegex"]).optional().describe("Match mode for query when using the anonymous profile."),profileName:M.string().optional().describe("Optional anonymous profile name when query/regex is used without profiles."),profiles:M.array(M.any()).optional().describe("Explicit profile objects with profileName/name and patterns. Patterns support exact, contains, startsWith, regex, and normalizedRegex."),sheetQuery:M.string().optional().describe("Sheet number/name scope. Use this first in large projects."),sheetIds:M.array(M.union([M.number(),M.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),viewNameQuery:M.string().optional().describe("Optional placed-view name filter before viewport tag inspection."),sources:M.array(M.enum(["sheet_text_notes","viewport_text_notes","viewport_text_note","placed_schedule_cells","placed_schedule_cell","viewport_tags","sheetTextNotes","viewportTextNotes","viewportTextNote","view_text_notes","viewTextNotes","placedScheduleCells","placedScheduleCell","schedule_cells","schedule_cell","scheduleCells","scheduleCell","viewportTags"])).optional().describe("Annotation sources. Defaults to sheet_text_notes + viewport_text_notes + placed_schedule_cells + viewport_tags except tag-specific count modes, which default to viewport_tags."),countMode:M.enum(["occurrence","uniqueText","uniqueTag","uniqueTaggedElement"]).optional().describe("Count semantics. Tag-specific modes require viewport_tags as the only explicit source."),groupBy:M.array(M.enum(["sheet","view","sourceType","profile","profileName","pattern","patternName","matchedText","matchedCode","tagFamilyType","taggedElement","taggedElementId"])).optional().describe("Optional grouping dimensions for count rows."),allowExpensiveSearch:M.boolean().optional().describe("Explicit approval for project-wide sheet and placed-view annotation counting without sheetIds/sheetQuery. Defaults false."),searchBudget:M.enum(["fast","balanced","deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),maxElapsedMs:M.number().int().positive().max(119e3).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),maxSheets:M.number().int().positive().max(200).optional().describe("Maximum matching sheets to inspect. Defaults 30."),maxViewportsPerSheet:M.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),maxViewports:M.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet."),maxTextNotesScanned:M.number().int().positive().max(2e5).optional().describe("Global native cap across sheet text notes."),maxScheduleInstancesPerSheet:M.number().int().min(0).max(200).optional().describe("Maximum placed schedule instances inspected per sheet. Defaults 20."),maxRowsPerSchedule:M.number().int().positive().max(2e3).optional().describe("Maximum body rows scanned per placed schedule. Defaults 250."),maxColumnsPerSchedule:M.number().int().positive().max(200).optional().describe("Maximum body columns scanned per placed schedule. Defaults 20."),maxScheduleInstancesScanned:M.number().int().positive().max(2e4).optional().describe("Global native cap across placed schedule instances."),maxScheduleCellsScanned:M.number().int().positive().max(2e5).optional().describe("Global native cap across placed schedule body cells before scanStoppedReason=max_cells."),maxTags:M.number().int().positive().max(1e5).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),maxTagsScanned:M.number().int().positive().max(1e5).optional().describe("Global native cap across viewport tags."),maxMatches:M.number().int().positive().max(2e5).optional().describe("Maximum returned matching evidence rows before scanStoppedReason=max_items."),maxTextChars:M.number().int().min(1).max(1e3).optional().describe("Maximum characters retained and matched per annotation candidate. Defaults 240."),maxRegexPatternLength:M.number().int().min(1).max(1e3).optional().describe("Maximum regex pattern length. Defaults 240."),regexTimeoutMs:M.number().int().min(1).max(250).optional().describe("Per-candidate regex timeout in milliseconds. Defaults 25."),maxResponseBytes:M.number().int().min(4096).max(16*1024*1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),timeoutMs:M.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs.")},async t=>{let n=Date.now();try{let r=ea(t),o=Lr(t),i=st(t.countMode);if(ta(i)&&vd(t)&&o.some(s=>s!=="viewport_tags"))return p(Pd(t));if(!na(t)&&t.allowExpensiveSearch!==!0)return p(kd(t,r));let a=await _("count_annotations",Cd(t,r),{...I({...t,timeoutMs:r.timeoutMs},"Count Revit annotations"),toolName:"count_annotations"});return p(Ed(a&&a.result?a.result:a,t,Date.now()-n))}catch(r){return p(fe({action:"count_annotations",error:r instanceof Error?r.message:String(r),elapsedMs:Date.now()-n,suggestedNextScopes:zn}))}})}import{z as ge}from"zod";function Ad(e){let t=Sn(e.elementIds||[]),n=R(e.category||""),r=Number.isFinite(e.sampleLimit)?Math.max(1,Math.min(25,e.sampleLimit)):5,o=e.includeTypeParameters===!0?"true":"false",i=we(e.parameterNameFilter||[]),a=e.parameterNameMatchMode==="exact"?"exact":"contains";return`
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
}`}function Od(e){return!e||typeof e!="object"?{}:{source:e.source,displayBuiltInParameter:e.displayBuiltInParameter,builtInParameterId:e.builtInParameterId,rawBuiltInParameterAlias:e.rawBuiltInParameterAlias,storageType:e.storageType,isShared:e.isShared,isReadOnly:e.isReadOnly,dataType:e.dataType,unitType:e.unitType,noValueState:e.noValueState,clearability:e.clearability}}function Vd(e,t){if(t.parameterNameMatchMode!=="exact"||!e||typeof e!="object"||!Array.isArray(e.elements))return e;let n=[],r=Array.isArray(e.warnings)?[...e.warnings]:[];for(let o of e.elements){let i=Array.isArray(o?.parameters)?o.parameters:[],a=new Map;for(let s of i){let l=typeof s?.name=="string"?s.name.trim():"";if(!l)continue;let u=l.toLocaleLowerCase("en-US");a.has(u)||a.set(u,{name:l,matches:[]}),a.get(u)?.matches.push(s)}for(let s of a.values()){if(s.matches.length<2)continue;let l={elementId:o?.id,parameterName:s.name,count:s.matches.length,severity:"write_preflight_warning",message:`Duplicate display name '${s.name}' matched ${s.matches.length} parameters on element ${o?.id}. Display name alone is ambiguous for write-back; choose by source, builtInParameterId, shared flag, storage type, or read-only state.`,matches:s.matches.map(Od)};n.push(l),r.push(`duplicate_display_name: elementId=${o?.id}; parameterName=${s.name}; count=${s.matches.length}; display name alone is ambiguous for write-back.`)}}return n.length===0?e:{...e,warnings:r,duplicateDisplayNameWarnings:n}}function la(e){e.tool("inspect_parameter_schema","Read-only parameter schema inspection for selected ids or a category sample: user-facing BIP display label/id, raw enum alias, storage type, unit type, shared/read-only flags, raw/display values, no-value state, and clearability metadata.",{...S(ge),...x(ge),elementIds:ge.array(ge.union([ge.number(),ge.string()])).optional().describe("Element ids to inspect."),category:ge.string().optional().describe("BuiltInCategory name such as OST_DuctCurves or OST_DuctTerminal."),sampleLimit:ge.number().int().positive().max(25).optional().describe("Maximum sample elements. Defaults 5."),includeTypeParameters:ge.boolean().optional().describe("Include type parameters. Defaults false."),parameterNameFilter:ge.array(ge.string()).optional().describe("Optional parameter name filters."),parameterNameMatchMode:ge.enum(["contains","exact"]).optional().describe("Filter matching mode. contains is discovery mode and default; exact is write-preflight mode.")},async t=>{if((!t.elementIds||t.elementIds.length===0)&&!t.category)return p({success:!0,matchMode:t.parameterNameMatchMode==="exact"?"exact":"contains",sampleCount:0,elements:[],warnings:["Provide elementIds or category."]});try{let n=await U(Ad(t),{...I(t,"Inspect Revit parameter schema"),transactionMode:"none"}),r=n&&n.result?n.result:n;return p(Vd(r,t))}catch(n){return p({success:!1,error:n instanceof Error?n.message:String(n)})}})}import{z as W}from"zod";function ua(e){return e==="clear"?"clear":e==="clearVisibleValue"?"clearVisibleValue":"set"}function ca(e){return typeof e=="boolean"?e?"true":"false":String(e??"")}async function Dd(e,t){if(e.elementId!==void 0&&e.elementId!==null&&String(e.elementId).trim()!==""){let n=Number.parseInt(String(e.elementId),10);return Number.isFinite(n)&&n>0?n:null}if(e.useSelection===!0){let n=await pt(2,t);return n.length===1?n[0]:{...Ce({action:"set_element_parameter",reason:"single_selection_required",error:n.length===0?"No selected Revit element was found. Provide elementId or select exactly one element.":"Multiple selected elements were found. Provide one explicit elementId for a production parameter write."}),tool:"set_element_parameter",guardReason:"single_selection_required",selectedElementIds:n}}return null}function Fd(e,t){let n=ua(e.operation),r=R(e.parameterName||""),o=R(e.parameterSource||"instance"),i=R(n==="clearVisibleValue"?"":ca(e.value)),a=R(e.valueMode||"raw"),s=R(e.mode==="commit"?"commit":"dryRun"),l=R(n),u=e.value===void 0||e.value===null?"false":"true",h=Number.isInteger(e.builtInParameterId)?String(e.builtInParameterId):"null",m=R(e.expectedStorageType||""),g=R(e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"":ca(e.expectedCurrentRaw)),b=e.expectedCurrentRaw===void 0||e.expectedCurrentRaw===null?"false":"true",y=e.allowTypeParameterWrite===!0?"true":"false";return`
int elementId = ${t};
string parameterName = ${r};
string parameterSource = ${o};
string requestedValueText = ${i};
string valueMode = ${a};
string mode = ${s};
string operation = ${l};
int? expectedBuiltInParameterId = ${h};
string expectedStorageType = ${m};
bool hasExpectedCurrentRaw = ${b};
string expectedCurrentRaw = ${g};
bool allowTypeParameterWrite = ${y};
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
}`}function da(e){e.tool("set_element_parameter","[PRODUCTION_PARAMETER_WRITE] Safely set, true-clear, or visibly clear one Revit element parameter after exact inspect_parameter_schema-style identity resolution. Never writes by visible display name alone: duplicate display names, read-only parameters, identity mismatch, unsupported clear/no-value attempts, and unapproved type-parameter writes are guarded. operation=clear uses Revit Parameter.ClearValue only for parameter kinds that can restore a true no-value state and never fakes no-value restore by writing an empty string. operation=clearVisibleValue is an explicit string-only visible cleanup path that writes an empty string and reports that Revit may keep HasValue=true. Defaults to dryRun; use mode=commit only for an explicitly confirmed write, then the tool reads the parameter back for verification.",{...S(W),...x(W),elementId:W.union([W.number(),W.string()]).optional().describe("Target Revit ElementId. Preferred for production writes."),useSelection:W.boolean().optional().describe("When true, use the current Revit selection only if exactly one element is selected. Defaults false."),parameterName:W.string().describe("Exact visible parameter name used only for schema preflight. The tool enumerates matching parameters and blocks duplicates; it does not use LookupParameter as a direct write shortcut."),parameterSource:W.enum(["instance","type"]).optional().default("instance").describe("Write an instance parameter by default. Type parameters require allowTypeParameterWrite=true in commit mode."),builtInParameterId:W.number().int().optional().describe("Optional stable BuiltInParameter integer from inspect_parameter_schema. If supplied, it must match the exact display-name result."),expectedStorageType:W.enum(["String","Integer","Double","ElementId"]).optional().describe("Optional storage-type guard from inspect_parameter_schema."),expectedCurrentRaw:W.union([W.string(),W.number(),W.boolean()]).optional().describe("Optional compare-and-set guard. Commit is blocked if the current raw value differs."),operation:W.enum(["set","clear","clearVisibleValue"]).optional().default("set").describe("set writes the supplied value. clear uses Revit Parameter.ClearValue only when the parameter kind supports true no-value restore and never falls back to writing an empty string. clearVisibleValue explicitly writes an empty string to a String parameter and may leave HasValue=true."),value:W.union([W.string(),W.number(),W.boolean()]).optional().describe("Requested value for operation=set. String writes use the text as-is; Integer accepts number/true/false; Double defaults to raw Revit internal units; ElementId accepts an integer id."),valueMode:W.enum(["raw","valueString"]).optional().default("raw").describe("For Double parameters, raw writes internal Revit units. valueString uses Parameter.SetValueString with project units."),mode:W.enum(["dryRun","commit"]).optional().default("dryRun").describe("dryRun performs schema/convertibility checks only. commit writes inside the wrapper transaction and verifies readback."),allowTypeParameterWrite:W.boolean().optional().default(!1).describe("Required to commit a type-parameter write because it can affect all instances of that type."),timeoutMs:W.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults to the runtime default.")},async t=>{let n=Y(t);try{let r=await Dd(t,n);if(!r||typeof r=="object")return p(r||{...Ce({action:"set_element_parameter",reason:"element_id_required",error:"Provide elementId or set useSelection=true with exactly one selected element."}),guardReason:"element_id_required",tool:"set_element_parameter"});let o=t.mode==="commit"?"commit":"dryRun",i=ua(t.operation);if(i==="set"&&(t.value===void 0||t.value===null))return p({...Ce({action:"set_element_parameter",reason:"value_required",error:"value is required when operation=set. Use operation=clear only when you intentionally want to restore a true no-value state, or operation=clearVisibleValue when a visible empty string is acceptable."}),guardReason:"value_required",tool:"set_element_parameter",mode:o,operation:i});let a=await U(Fd(t,r),{...n,...se(t,o==="commit"?i==="clear"?"Clear Revit element parameter":i==="clearVisibleValue"?"Visibly clear Revit element parameter":"Set Revit element parameter":i==="clear"?"Dry-run Revit element parameter clear":i==="clearVisibleValue"?"Dry-run visible Revit element parameter clear":"Dry-run Revit element parameter write"),transactionMode:o==="commit"?"auto":"none"});return p(a&&a.result?a.result:a)}catch(r){return p(pe({action:"set_element_parameter",error:r instanceof Error?r.message:String(r),extra:{tool:"set_element_parameter"}}))}})}import{z as oe}from"zod";function ma(e){return`new int[] { ${e.map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n)).join(", ")} }`}function Ld(e){return`new bool[] { ${e.map(t=>t?"true":"false").join(", ")} }`}function jd(e){return(Array.isArray(e.cells)?e.cells:[]).slice(0,200).map(n=>({row:Math.max(0,Number.parseInt(String(n.row),10)||0),column:Math.max(0,Number.parseInt(String(n.column),10)||0),value:String(n.value??""),hasExpectedCurrentText:n.expectedCurrentText!==void 0&&n.expectedCurrentText!==null,expectedCurrentText:String(n.expectedCurrentText??"")}))}function Bd(e){let t=Number.parseInt(String(e.scheduleId),10),n=jd(e),r=R(e.section),o=R(e.mode==="commit"?"commit":"dryRun"),i=e.allowCurrentMismatch===!0?"true":"false";return`
int scheduleId = ${Number.isFinite(t)?t:0};
string requestedSection = ${r};
string mode = ${o};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowCurrentMismatch = ${i};
int[] rows = ${ma(n.map(a=>a.row))};
int[] columns = ${ma(n.map(a=>a.column))};
string[] requestedValues = ${we(n.map(a=>a.value))};
bool[] hasExpectedCurrentTexts = ${Ld(n.map(a=>a.hasExpectedCurrentText))};
string[] expectedCurrentTexts = ${we(n.map(a=>a.expectedCurrentText))};

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
}`}function pa(e){e.tool("set_schedule_cells","[PRODUCTION_SCHEDULE_CELL_WRITE] Writes exact Revit schedule cells by scheduleId, section, row, and column. Defaults to dryRun, blocks mismatched expectedCurrentText, guards non-writable standard schedule body cells as non_writable_standard_body_cell, and verifies committed values.",{...S(oe),...x(oe),scheduleId:oe.union([oe.number(),oe.string()]).describe("Exact ViewSchedule element id. Schedule names are not accepted for writes."),section:oe.enum(["header","body","footer"]).describe("Exact schedule section containing the target cells."),cells:oe.array(oe.object({row:oe.number().int().min(0).describe("Zero-based row index in the selected schedule section."),column:oe.number().int().min(0).describe("Zero-based column index in the selected schedule section."),value:oe.string().describe("Target cell text."),expectedCurrentText:oe.string().optional().describe("Optional exact preflight value. Commit is blocked if current text differs unless allowCurrentMismatch=true.")})).min(1).max(200).describe("Exact cells to update. Use inspect_schedules first to discover row/column coordinates."),mode:oe.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes schedule cell text in one Revit transaction."),allowCurrentMismatch:oe.boolean().optional().describe("Defaults false. Keep false for production writes so stale row/column targets are blocked."),timeoutMs:oe.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=await U(Bd(t),{...Y(t),...se(t,n==="commit"?"Set Revit schedule cells":"Preview Revit schedule cell changes"),toolName:"set_schedule_cells",transactionMode:n==="commit"?"auto":"none"});return p(r&&r.result?r.result:r)}catch(n){return p(pe({action:"set_schedule_cells",reason:"set_schedule_cells_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as k}from"zod";var zd=25;function ha(e,t=100){return(Array.isArray(e)?e:[]).slice(0,t).map(n=>Number.parseInt(String(n),10)).filter(n=>Number.isFinite(n))}function fa(e){return`new int[] { ${e.join(", ")} }`}function qd(e){let t=[];if(typeof e.rowTextQuery=="string"&&e.rowTextQuery.trim()&&t.push(e.rowTextQuery.trim()),Array.isArray(e.rowTextQueries))for(let n of e.rowTextQueries){let r=String(n??"").trim();r&&t.push(r)}return[...new Set(t)].slice(0,20)}function Wd(e,t){let n=Array.isArray(e)?[...new Set(e.map(r=>String(r??"").trim()).filter(r=>r.length>0))]:[];return{rows:n.slice(0,t),totalCount:Array.isArray(e)?e.length:0,uniqueCount:n.length,returnedCount:Math.min(n.length,t),omittedCount:Math.max(0,n.length-t)}}function Gd(e,t){let n=t.responseMode||"compact";if(!e||typeof e!="object"||ze(n))return{...e,responseMode:n};let r=xe(t.maxResultRows,zd,500),o=ce(e.matches,{limit:r}),i=ce(e.changes,{limit:r}),a=Wd(e.errors,r),s={...e,responseMode:"compact",compactResponse:!0,maxReturnedRows:r};return Array.isArray(e.matches)&&(s.matches=o.rows,s.returnedMatchCount=o.returnedCount,s.omittedMatchCount=o.omittedCount,s.duplicateMatchCount=o.duplicateCount),Array.isArray(e.changes)&&(s.changes=i.rows,s.returnedChangeCount=i.returnedCount,s.omittedChangeCount=i.omittedCount,s.duplicateChangeCount=i.duplicateCount),Array.isArray(e.errors)&&(s.errors=a.rows,s.returnedErrorCount=a.returnedCount,s.omittedErrorCount=a.omittedCount),s.notices=[...Array.isArray(e.notices)?e.notices:[],'Compact response bounds matches/changes/errors. Use responseMode="full" for all row details.'],s}function Jd(e){let t=ha(e.scheduleIds,200),n=ha(e.sheetIds,200),r=qd(e),o=Number.parseInt(String(e.targetColumn),10),i=Math.max(1,Math.min(Number.parseInt(String(e.maxSchedules??20),10)||20,200)),a=Math.max(1,Math.min(Number.parseInt(String(e.maxRowsPerSchedule??250),10)||250,2e3)),s=Math.max(1,Math.min(Number.parseInt(String(e.maxColumnsPerSchedule??80),10)||80,300)),l=Math.max(1,Math.min(Number.parseInt(String(e.maxMatches??50),10)||50,500)),u=e.mode==="commit"?"commit":"dryRun",h=e.section||"body",m=e.rowMatchMode==="any"?"any":"all",g=e.allowMultipleMatches===!0?"true":"false",b=e.allowCurrentMismatch===!0?"true":"false",y=e.expectedCurrentText!==void 0&&e.expectedCurrentText!==null?"true":"false",T=R(e.expectedCurrentText??"");return`
int[] exactScheduleIds = ${fa(t)};
int[] exactSheetIds = ${fa(n)};
string scheduleNameQuery = ${R(e.scheduleNameQuery||e.scheduleQuery||"")};
string sheetQuery = ${R(e.sheetQuery||"")};
string requestedSection = ${R(h)};
string[] rowTextQueries = ${we(r)};
string rowMatchMode = ${R(m)};
int targetColumn = ${Number.isFinite(o)?o:-1};
string requestedValue = ${R(e.value??"")};
string mode = ${R(u)};
bool dryRun = !string.Equals(mode, "commit", StringComparison.OrdinalIgnoreCase);
bool allowMultipleMatches = ${g};
bool allowCurrentMismatch = ${b};
bool hasExpectedCurrentText = ${y};
string expectedCurrentText = ${T};
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
}`}function ga(e){e.tool("set_schedule_cells_by_text","[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT] Finds bounded schedule rows by sheet/schedule filters and row text, then previews or commits a target column update with readback verification. Guards non-writable standard schedule body cells as non_writable_standard_body_cell. Prefer this over generic send_code_to_revit for repeated schedule row text writes.",{...S(k),...x(k),scheduleIds:k.array(k.union([k.number(),k.string()])).optional().describe("Exact ViewSchedule ids to inspect. Preferred when known."),scheduleNameQuery:k.string().optional().describe("Bounded schedule name filter. Use this before broad row text matching."),scheduleQuery:k.string().optional().describe("Alias for scheduleNameQuery."),sheetIds:k.array(k.union([k.number(),k.string()])).optional().describe("Exact ViewSheet ids whose placed schedules should be inspected."),sheetQuery:k.string().optional().describe("Sheet number/name filter whose placed schedules should be inspected."),section:k.enum(["header","body","footer"]).optional().describe("Schedule section to search and write. Defaults to body."),rowTextQuery:k.string().optional().describe("Text that must appear in the row. Combine with rowTextQueries for safer matching."),rowTextQueries:k.array(k.string()).optional().describe("All row text terms to match by default. Use rowMatchMode=any to match any term."),rowMatchMode:k.enum(["all","any"]).optional().describe("Defaults to all. all requires every rowTextQuery term to match the row text."),targetColumn:k.number().int().min(0).describe("Zero-based target column to write in each matched row."),value:k.string().describe("Target cell text."),expectedCurrentText:k.string().optional().describe("Optional compare-and-set guard for the target cell text."),allowCurrentMismatch:k.boolean().optional().describe("Defaults false. Keep false for production writes so stale target cells are blocked."),allowMultipleMatches:k.boolean().optional().describe("Defaults false. Required when more than one row match should be updated."),mode:k.enum(["dryRun","commit"]).optional().describe("Defaults to dryRun. commit writes all matched cells in one wrapper transaction."),maxSchedules:k.number().int().positive().max(200).optional().describe("Maximum candidate schedules to inspect. Defaults 20."),maxRowsPerSchedule:k.number().int().positive().max(2e3).optional().describe("Maximum rows scanned per schedule. Defaults 250."),maxColumnsPerSchedule:k.number().int().positive().max(300).optional().describe("Maximum columns read when matching row text. Defaults 80."),maxMatches:k.number().int().positive().max(500).optional().describe("Maximum matching rows returned or written. Defaults 50."),responseMode:Be,maxResultRows:k.number().int().positive().max(500).optional().describe("Compact-mode cap for matches/changes/errors returned to the client. Defaults 25; full/debug returns all rows within maxMatches."),timeoutMs:k.number().int().positive().max(12e4).optional().describe("Socket timeout in milliseconds. Defaults 120000.")},async t=>{try{let n=t.mode==="commit"?"commit":"dryRun",r=t.scheduleNameQuery||t.scheduleQuery,o=await U(Jd({...t,scheduleNameQuery:r}),{...Y(t),...se(t,n==="commit"?"Set Revit schedule cells by text":"Preview Revit schedule row text changes"),toolName:"set_schedule_cells_by_text",transactionMode:n==="commit"?"auto":"none"});return p(Gd(o&&o.result?o.result:o,t))}catch(n){return p(pe({action:"set_schedule_cells_by_text",reason:"set_schedule_cells_by_text_runtime_error",error:n instanceof Error?n.message:String(n),extra:{committed:!1}}))}})}import{z as Ge}from"zod";var Ud=`
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
}`;function Hd(e){let t=ke(e);return t&&typeof t=="object"&&t.result?t.result:t}async function $d(e,t){let n=null;try{n=await be(async o=>await o.sendCommand("mcp_status",{},{timeoutMs:t,statusPreflight:!1}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(t,500),logSocketErrors:!1,skipLock:!0})}catch(o){return{reachable:!1,target:{name:e.name,host:e.host,port:e.port,source:e.source},error:o instanceof Error?o.message:String(o)}}let r=Math.max(t,1e4);try{let o=await be(async(i,a)=>await i.sendCommand("send_code_to_revit",{code:Ud,parameters:[`${a.host}:${a.port}`],transactionMode:"none",taskName:"Probe Revit instance"},{timeoutMs:r}),{host:e.host,port:e.port,connectTimeoutMs:t,lockWaitMs:Math.max(r,500),logSocketErrors:!1});return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:Bt(n,{recentLimit:3,includeDiagnostics:!1}),info:Hd(o)}}catch(o){return{reachable:!0,target:{name:e.name,host:e.host,port:e.port,source:e.source},status:Bt(n,{recentLimit:3,includeDiagnostics:!1}),info:null,infoError:o instanceof Error?o.message:String(o)}}}function ya(e){e.tool("list_revit_instances","Discover reachable revAgent Revit bridge instances by probing configured ports. Use this before targeting a specific Revit instance.",{host:Ge.string().optional().describe("Host to scan. Defaults to REVIT_MCP_HOST or localhost."),ports:Ge.array(Ge.union([Ge.number(),Ge.string()])).optional().describe("Ports to scan. Defaults to REVIT_MCP_PORTS, or 8080-8085."),includeRegistry:Ge.boolean().optional().describe("Include targets from the revAgent instance registry file. Defaults true."),includeUnreachable:Ge.boolean().optional().describe("Include unreachable ports in the result. Defaults false."),timeoutMs:Ge.number().int().positive().max(15e3).optional().describe("Per-port connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.timeoutMs||3e3,r=Yr({host:t.host,ports:t.ports,includeRegistry:t.includeRegistry}),o=[];for(let i of r){let a=await $d(i,n);(a.reachable||t.includeUnreachable)&&o.push(a)}return p({success:!0,count:o.filter(i=>i.reachable).length,scanned:r.length,instances:o})})}import Sa from"node:path";import{z as Je}from"zod";var Qd=new Date().toISOString(),Xd="revit-mcp-status.v3",Yd="revit-mcp-runtime-tools.38";function Kd(){let e=ct(Sa.join(Un(),"package.json"));return{packageName:e?.name||"revit-mcp",packageVersion:e?.version||"unknown"}}function ba(){let e=Kd(),t=kt([Sa.join(process.cwd(),"..","updater","installed.json")]),n=t?.version||e.packageVersion;return{runtimeVersion:n,schemaVersion:Xd,toolSurfaceVersion:Yd,processStartedAtUtc:Qd,buildTimestampUtc:t?.installedAtUtc||null,buildHash:Pt(n),packageName:e.packageName,packageVersion:e.packageVersion,nodeVersion:process.version}}function wa(e){e.tool("get_revit_mcp_status","Read the revAgent task status without waiting behind the active Revit command lock. Includes runtimeVersion, schemaVersion, toolSurfaceVersion, processStartedAtUtc, buildTimestampUtc, buildHash, bridge resultContractVersion when available, and summary runtimeActivity for revAgent-side/client-side guarded operations that may not reach Revit.",{...S(Je),includeRecentTasks:Je.boolean().optional().describe("Include recent completed task records. Defaults true, with a compact limit."),recentLimit:Je.number().int().min(0).max(100).optional().describe("Maximum recent task records to return when includeRecentTasks is true. Defaults 3."),includeRuntimeActivity:Je.boolean().optional().describe("Include MCP-side/client-side active and recent activity. Defaults true so guard-only tasks that did not reach Revit remain auditable."),runtimeActivityLimit:Je.number().int().min(0).max(100).optional().describe("Maximum runtimeActivity.recentActivity rows to return. Defaults 10."),runtimeActivityMode:Je.enum(["summary","full"]).optional().describe("runtimeActivity shape. summary is the default and collapses started/completed pairs into latest completed/guarded/failed rows without responseKeys. full includes started rows and full result summaries."),includeDiagnostics:Je.boolean().optional().describe("Include transport timing/byte diagnostics on task records. Defaults false."),timeoutMs:Je.number().int().positive().max(1e4).optional().describe("Connection timeout in milliseconds. Defaults 3000.")},async t=>{let n=t.includeRuntimeActivity===!1?void 0:Ro(t.runtimeActivityLimit??10,t.runtimeActivityMode||"summary");try{let r=t.timeoutMs||3e3,o=await be(async s=>await s.sendCommand("mcp_status",{},{timeoutMs:r}),{...Y(t),skipLock:!0,connectTimeoutMs:r}),i=Bt(ke(o),{includeRecentTasks:t.includeRecentTasks,recentLimit:t.recentLimit,includeDiagnostics:t.includeDiagnostics});gn(o);let a=i&&typeof i=="object"&&!Array.isArray(i)?i:{status:i};return p({...a,...n?{runtimeActivity:n}:{},runtimeIdentity:ba()})}catch(r){return p({success:!1,error:r instanceof Error?r.message:String(r),...n?{runtimeActivity:n}:{},runtimeIdentity:ba()})}})}async function xa(e){let t=No(e);ya(t),wa(t),Lo(t),jo(t),Bo(t),zo(t),Wo(t),Go(t),Jo(t),Uo(t),Ho(t),$o(t),ei(t),ti(t),ni(t),ri(t),oi(t),li(t),ai(t),ci(t),mi(t),pi(t),bi(t),Ci(t),Zi(t),sa(t),la(t),da(t),pa(t),ga(t),console.error("Registered 30 revAgent tools")}var va=new Zd({name:"revAgent",version:"1.0.0"});async function tm(){await xa(va);let e=new em;await va.connect(e),Mo(),console.error("revAgent runtime start success")}tm().catch(e=>{console.error("Error starting revAgent runtime:",e),process.exit(1)});

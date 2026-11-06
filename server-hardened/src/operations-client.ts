import { randomUUID } from 'node:crypto';
import { SecureHttpClient, DssError } from './http-client.js';
import { mergeSettings } from './agent-client.js';
import { sha256, storeArtifact, loadArtifact, zipManifest } from './artifacts.js';
export const seg = (v: string) => { if(!v || !v.trim() || v==='.' || v==='..') throw new Error('Invalid identifier'); return encodeURIComponent(v); };
export const base = (p: string) => `/projects/${seg(p)}`;
export const stable = (v: any): string => JSON.stringify(v && typeof v==='object' ? Array.isArray(v)? v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])) : v);
export const revision = (v: any) => ({sha256:sha256(stable(v)),version:v?.versionTag?.versionNumber ?? v?.recipe?.versionTag?.versionNumber ?? null});
const locks = new Map<string,Promise<unknown>>();
async function locked<T>(key: string, f: ()=>Promise<T>): Promise<T> {
  const prev=locks.get(key) ?? Promise.resolve(); let release!:()=>void; const gate=new Promise<void>(r=>release=r); const pending=prev.catch(()=>{}).then(()=>gate); locks.set(key,pending);
  await prev.catch(()=>{}); try{return await f();} finally{release();if(locks.get(key)===pending) locks.delete(key);}
}
export type Guard = {dry_run?:boolean;expected_hash?:string;expected_version?:number};
export function checkRevision(current:any,g:Guard) { const r=revision(current); if(g.expected_hash!==undefined && g.expected_hash!==r.sha256 || g.expected_version!==undefined && g.expected_version!==r.version) throw new Error('Version conflict: inspect current settings before retrying'); return r; }
export function parseTsv(text:string,complete:boolean):string[][] {
  const rows:string[][]=[]; let row:string[]=[], cell='', quoted=false;
  for(let i=0;i<text.length;i++) {const c=text[i]; if(c==='"') {if(quoted && text[i+1]==='"'){cell+='"';i++;} else if(quoted || cell.length===0) quoted=!quoted; else cell+=c;}
    else if(c==='\t' && !quoted){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(complete && !quoted && (cell.length||row.length)){row.push(cell);rows.push(row);}
  if(complete && quoted) throw new Error('Incomplete quoted TSV row');
  return rows;
}
export class OperationsClient {
  constructor(public readonly http:SecureHttpClient) {}
  async flow(p:string) {
    const graph=(await this.http.get(`${base(p)}/flow/graph/`)).data;
    const zones=(await this.http.get(`${base(p)}/flow/zones`)).data;
    const nodes=Object.entries(graph.nodes??{}).map(([id,n]:[string,any])=>{
      const kind=n.type==='RUNNABLE_RECIPE'?'RECIPE':String(n.type).replace(/^COMPUTABLE_/,'');
      const match=(v:any)=>v.objectId===n.ref && v.objectType===kind && (!v.projectKey || v.projectKey===p);
      const membership=zones.filter((z:any)=>(z.items??[]).some(match)).map((z:any)=>z.id);
      return {id,...n,object_kind:kind,zone_ids:membership.length?membership:['default'],shared_zone_ids:zones.filter((z:any)=>(z.shared??[]).some(match)).map((z:any)=>z.id)};
    });
    const edges=nodes.flatMap((n:any)=>(n.predecessors??[]).map((from:string)=>({from,to:n.id})));
    return {project_key:p,nodes,edges,zones,layout:{zones:zones.map((z:any)=>({id:z.id,name:z.name,position:z.position??null})),node_positions_available:nodes.some((n:any)=>n.position!=null)},revision:revision(graph)};
  }
  async recipe(p:string,id:string) {const data=(await this.http.get(`${base(p)}/recipes/${seg(id)}`)).data;return {...data,revision:revision(data)};}
  async sample(a:any) {
    const path=`${base(a.project_key)}/datasets/${seg(a.dataset_name)}`;
    const schema=(await this.http.get(`${path}/schema`)).data.columns;
    const names=schema.map((c:any)=>c.name); const columns=a.columns??names;
    for(const name of [...columns,...(a.filters??[]).map((f:any)=>f.column)]) if(!names.includes(name)) throw new Error('Unknown sample column');
    const raw=await this.http.get(`${path}/data/`,{params:{format:'tsv-excel-noheader',partitions:a.partition},format:'text',maxBytes:a.max_scan_bytes??1024*1024,truncate:true});
    const parsed=parseTsv(raw.data,!raw.truncated); const result:any[]=[]; let scanned=0,bytes=2, stopped=false;
    for(const cells of parsed) {
      if(scanned >= (a.max_scan_rows??10000)){stopped=true;break;} scanned++;
      if(cells.length!==names.length) throw new Error('DSS row width does not match schema');
      const row=Object.fromEntries(names.map((n:string,i:number)=>[n,cells[i]]));
      if(!(a.filters??[]).every((f:any)=>f.operator==='eq'?row[f.column]===f.value:f.operator==='ne'?row[f.column]!==f.value:row[f.column].includes(f.value)))continue;
      const out=this.http.clean(Object.fromEntries(columns.map((n:string)=>[n,row[n]]))); const size=Buffer.byteLength(JSON.stringify(out))+(result.length?1:0);
      if(result.length>=(a.rows??100) || bytes+size>(a.max_bytes??131072)){stopped=true;break;} result.push(out);bytes+=size;
    }
    return {rows:result,schema:schema.filter((c:any)=>columns.includes(c.name)),returned_rows:result.length,scanned_rows:scanned,scanned_bytes:raw.bytes,rows_json_bytes:bytes,truncated:raw.truncated||stopped,scan_complete:!raw.truncated&&!stopped,filter_execution:'client-side over bounded scan; values are TSV strings',limits:{rows:a.rows??100,bytes:a.max_bytes??131072,scan_bytes:a.max_scan_bytes??1048576,scan_rows:a.max_scan_rows??10000}};
  }
  async patch(path:string,patch:any,g:Guard,transform?:(c:any,p:any)=>any) {
    return locked(path,async()=>{
      const current=(await this.http.get(path)).data; const before=checkRevision(current,g);
      const next=transform?transform(current,patch):mergeSettings(current,patch);
      const after=revision(next);
      if(!g.dry_run) {
        const check=(await this.http.get(path)).data; if(revision(check).sha256!==before.sha256) throw new Error('Version conflict before save');
        await this.http.put(path,next);
      }
      return {dry_run:g.dry_run??false,updated:!g.dry_run,before,proposed:after,validation:'input schema and local invariants; no execution',concurrency:'serialized within this server; rechecked before PUT; DSS API does not provide atomic compare-and-set',...(g.dry_run?{proposed_settings:this.http.clean(next)}:{})};
    });
  }
  async updateObject(kind:'datasets'|'recipes'|'scenarios',a:any) {
    const id=a.dataset_name??a.recipe_name??a.scenario_id;
    return this.patch(`${base(a.project_key)}/${kind}/${seg(id)}`,a.patch,a,(c,p)=>{
      if(kind==='recipes'){
        const {code,...settings}=p; const next={...c,recipe:mergeSettings(c.recipe,settings),...(code===undefined?{}:{payload:code})};
        if(next.recipe.type==='python') {
          const outputs=Object.values(next.recipe.outputs??{}).flatMap((r:any)=>r.items??[]);
          if(outputs.length!==1)throw new Error('Python recipes require exactly one output');
          if(typeof next.payload!=='string'||next.payload.split(/\r\n|\n|\r/).length>1000)throw new Error('Python recipes must have at most 1,000 lines including comments and blanks');
        }
        return next;
      }
      return mergeSettings(c,p);
    });
  }
  async exportProject(a:any) {
    const response=await this.http.post(`${base(a.project_key)}/export`,{exportUploads:false,exportManagedFS:false,exportAnalysisModels:false,exportSavedModels:false},{format:'bytes',maxBytes:a.max_bytes??50*1024*1024,timeoutMs:120000});
    if(response.data.length<4||response.data.readUInt32LE(0)!==0x04034b50)throw new Error('DSS export did not return a ZIP archive');
    const artifact=await storeArtifact(response.data,'application/zip');
    return {artifact,...(a.include_manifest?{manifest:this.http.clean(zipManifest(response.data))}:{}),contains_raw_project_configuration:true};
  }
  async folderFiles(a:any) {
    const d=(await this.http.get(`${base(a.project_key)}/managedfolders/${seg(a.folder_id)}/contents`)).data;
    const all=d.items??d; if(!Array.isArray(all))throw new Error('Unexpected folder listing');
    const selected=all.filter((x:any)=>!a.prefix||String(x.path??'').startsWith(a.prefix)); const offset=a.offset??0,limit=a.limit??100;
    return {files:selected.slice(offset,offset+limit),total:selected.length,truncated:offset+limit<selected.length,next_offset:offset+limit<selected.length?offset+limit:null};
  }
  filePath(a:any) {
    const path=String(a.path).replace(/^\//,''); if(!path||path.split('/').some(x=>!x||x==='.'||x==='..')||path.includes('\\'))throw new Error('Invalid managed file path');
    return `${base(a.project_key)}/managedfolders/${seg(a.folder_id)}/contents/${path.split('/').map(seg).join('/')}`;
  }
  async download(a:any){const r=await this.http.get(this.filePath(a),{format:'bytes',maxBytes:a.max_bytes??10*1024*1024});return storeArtifact(r.data,r.contentType||'application/octet-stream');}
  async upload(a:any) {
    const bytes=await loadArtifact(a.artifact_id); if(sha256(bytes)!==a.sha256)throw new Error('Upload artifact checksum mismatch');
    const path=this.filePath(a);
    return locked(path,async()=>{
      try { const existing=await this.http.get(path,{format:'bytes',maxBytes:100*1024*1024});
        if(a.overwrite!=='replace')throw new Error('Remote file exists; overwrite policy is fail');
        if(a.expected_remote_sha256 && sha256(existing.data)!==a.expected_remote_sha256)throw new Error('Remote checksum conflict');
      } catch(e) {if(!(e instanceof DssError && e.details.status===404))throw e;if(a.expected_remote_sha256)throw new Error('Remote file missing; checksum conflict');}
      const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)]),'');
      await this.http.post(path,undefined,{rawBody:form});
      const verify=await this.http.get(path,{format:'bytes',maxBytes:100*1024*1024});
      if(sha256(verify.data)!==a.sha256)throw new Error('Post-upload checksum verification failed');
      return {uploaded:true,sha256:a.sha256,size_bytes:bytes.length,verified:true,overwrite_atomic:false};
    });
  }
  libraryPath(a:any) {if(!/^python\/[\w./-]+\.py$/.test(a.path)||a.path.split('/').some((s:string)=>s==='..'||s==='.'||!s))throw new Error('Use a Python file path under python/'); return `${base(a.project_key)}/libraries/contents/${a.path.split('/').map(seg).join('/')}`;}
  async readLibrary(a:any) {const r=(await this.http.get(this.libraryPath(a))).data; const data=String(r.data??''); if(Buffer.byteLength(data)>(a.max_bytes??131072))throw new Error('Library file exceeds byte limit');return {path:a.path,content:this.http.clean(data),sha256:sha256(data),size_bytes:Buffer.byteLength(data),last_modified:r.lastModified??null};}
  async writeLibrary(a:any) {
    const path=this.libraryPath(a);
    return locked(path,async()=>{
      // DSS returns "Not a file" (sometimes HTTP 500) for a nonexistent file.
      // Inspect the library tree instead of interpreting arbitrary errors as absence.
      const tree=(await this.http.get(`${base(a.project_key)}/libraries/contents`)).data;
      if(!Array.isArray(tree)) throw new Error('Unexpected library tree');
      let children=tree; const parts=a.path.split('/');
      for(const part of parts.slice(0,-1)) {
        const folder=children.find((n:any)=>n.name===part);
        if(!folder || !Array.isArray(folder.children)) throw new Error('Parent library folder does not exist; create it before writing');
        children=folder.children;
      }
      const item=children.find((n:any)=>n.name===parts.at(-1));
      if(item && item.children!=null) throw new Error('Library path refers to a folder');
      if(a.mode==='create' && item) throw new Error('Library file already exists');
      if(a.mode==='update' && !item) throw new Error('Library file does not exist');
      if(a.mode==='update') {
        if(!a.expected_hash) throw new Error('expected_hash is required for library updates');
        const current=(await this.http.get(path)).data;
        if(typeof current.data!=='string' || sha256(current.data)!==a.expected_hash) throw new Error('Library file checksum conflict');
      }
      const expected=sha256(a.content);
      if(a.dry_run) return {path:a.path,dry_run:true,updated:false,sha256:expected,size_bytes:Buffer.byteLength(a.content),verified:false};
      await this.http.post(path,undefined,{rawBody:a.content,contentType:'text/plain; charset=utf-8'});
      try {
        const saved=(await this.http.get(path)).data;
        const actual=typeof saved.data==='string'?sha256(saved.data):null;
        return {path:a.path,dry_run:false,updated:true,sha256:expected,actual_sha256:actual,size_bytes:Buffer.byteLength(a.content),verified:actual===expected,
          ...(actual!==expected?{error:{type:'PersistenceMismatch',message:'Library content read-back did not match the submitted content; inspect before retrying'}}:{}),
          concurrency:'best-effort check; DSS library POST has no atomic compare-and-set'};
      } catch(e) {return {path:a.path,updated:true,verified:false,error:{type:'VerificationFailed',message:'Library POST completed but read-back failed; inspect before retrying'}};}
    });
  }
  async updateZone(a:any) {
    const path=`${base(a.project_key)}/flow/zones/${seg(a.zone_id)}`;
    const result=await this.patch(path,a.patch,a);
    if(a.dry_run) return {...result,persistence_verified:false};
    try {
      const saved=(await this.http.get(path)).data;
      const mismatches=Object.keys(a.patch).filter(k=>stable(saved[k]??null)!==stable(a.patch[k]));
      return {...result,persistence_verified:mismatches.length===0,saved_revision:revision(saved),saved_position:saved.position??null,mismatched_fields:mismatches,
        ...(mismatches.length?{error:{type:'PersistenceMismatch',message:'DSS accepted the zone update but read-back differs; the requested layout is not confirmed'}}:{})};
    } catch(e) {return {...result,persistence_verified:false,error:{type:'VerificationFailed',message:'Zone PUT completed but read-back failed; inspect before retrying'}};}
  }
  async variables(a:any) {return this.patch(`${base(a.project_key)}/variables/`,{[a.scope]:a.patch},a);}
  async job(a:any) {const d=(await this.http.get(`${base(a.project_key)}/jobs/${seg(a.job_id)}/`)).data;const state=d.baseStatus?.state??d.state;return {...d,terminal:['DONE','FAILED','ABORTED'].includes(state),state,success:state==='DONE'?true:state==='FAILED'||state==='ABORTED'?false:null};}
  async jobLog(a:any){const r=await this.http.get(`${base(a.project_key)}/jobs/${seg(a.job_id)}/log`,{params:{activity:a.activity},format:'text',maxBytes:a.max_bytes??65536,truncate:true});return {text:this.http.clean(r.data),bytes:r.bytes,truncated:r.truncated,segment:'beginning',operation_id:r.operationId};}
  async knowledge(a:any) {
    const settings=(await this.http.get(`${base(a.project_key)}/knowledge-banks/${seg(a.knowledge_bank_id)}`)).data;
    const flow=await this.flow(a.project_key);const node=flow.nodes.find((n:any)=>n.ref===a.knowledge_bank_id);
    const producers=flow.nodes.filter((n:any)=>(node?.predecessors??[]).includes(n.id));
    const datasets=producers.flatMap((n:any)=>n.predecessors??[]);
    return {settings,revision:revision(settings),producer_recipe_ids:producers.map((n:any)=>n.ref),source_node_ids:datasets,refresh_status:'Not exposed by the 14.7.1 knowledge-bank settings API; inspect producing jobs with get_job_details. Settings alone do not prove indexed content.'};
  }
  async codeEnv(a:any) {
    const d=(await this.http.get(`/admin/code-envs/PYTHON/${seg(a.env_name)}`)).data;
    const installed=d.actualPackageList ?? d.packages ?? null;
    return {env_name:a.env_name,settings:this.http.clean(d),installed_packages:installed,inventory_available:installed!==null,imports_verified:false,required_imports:a.required_imports??[],verification_note:'Package inventory cannot prove Python importability. Use validate_code_environment_imports for a fixed import check, or check_agent_tool_startup to test an existing tool descriptor.'};
  }
  async validateImports(a:any) {
    // Fixed diagnostic code only: module names are encoded as JSON, never interpolated as Python expressions.
    const modules=JSON.stringify(a.modules);
    const code=`import importlib, json\nfrom dataiku.llm.agent_tools import BaseAgentTool\nclass ImportCheck(BaseAgentTool):\n    def get_descriptor(self, tool):\n        return {"description": "Check imports", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}\n    def invoke(self, input, trace):\n        results = []\n        for name in json.loads(${JSON.stringify(modules)}):\n            try:\n                importlib.import_module(name)\n                results.append({"module": name, "ok": True})\n            except Exception as exc:\n                results.append({"module": name, "ok": False, "error_type": type(exc).__name__, "message": str(exc)[:1000]})\n        return {"output": {"imports": results}, "sources": []}\n`;
    const collection=`${base(a.project_key)}/agents/tools`;
    const created=(await this.http.post(collection,{type:'InlinePython',name:'MCP import check',id:`mcp_import_${randomUUID().replace(/-/g,'')}`,creationParams:{}})).data;
    const path=`${collection}/${seg(created.id)}`;let result:any;
    try {
      const settings=(await this.http.get(path)).data;
      const next=mergeSettings(settings,{params:{code,codeEnvSelection:{envMode:'EXPLICIT_ENV',envName:a.env_name}}});
      await this.http.put(path,next);
      result={env_name:a.env_name,diagnostic_tool_id:created.id,result:(await this.http.post(`${path}/invocations`,{toolId:created.id,input:{input:{}}},{timeoutMs:120000})).data};
    } catch(e) {result={env_name:a.env_name,diagnostic_tool_id:created.id,error:e instanceof DssError?e.details:{message:'Import diagnostic failed'}};}
    try {await this.http.delete(path);result.cleanup_complete=true;}catch(e){result.cleanup_complete=false;result.cleanup_error=e instanceof DssError?e.details:{message:'Diagnostic cleanup failed'};}
    return result;
  }
  async knowledgeStatus(a:any) {
    const inspected=await this.knowledge(a);
    const all=(await this.http.get(`${base(a.project_key)}/jobs/`)).data;
    const jobs=all.filter((j:any)=>(j.def?.outputs??[]).some((o:any)=>o.targetDataset===a.knowledge_bank_id || o.id===a.knowledge_bank_id))
      .sort((x:any,y:any)=>(y.startTime??0)-(x.startTime??0)).slice(0,a.limit??10);
    return {...inspected,refresh_status:jobs.length?{latest_state:jobs[0].state,latest_job_id:jobs[0].def.id,start_time:jobs[0].startTime,end_time:jobs[0].endTime}: {latest_state:'UNKNOWN',reason:'No matching build in retained job history'},recent_builds:jobs,indexed_document_coverage_verified:false};
  }
  async buildStep(a:any){
    const builds=a.outputs.map((o:any)=>({type:o.type,itemId:o.id,projectKey:a.project_key,partitionsSpec:o.partition??''}));
    const step={id:a.step_id,name:a.name,type:'build_flowitem',enabled:true,alwaysShowComment:false,runConditionType:'RUN_IF_STATUS_MATCH',runConditionStatuses:['SUCCESS','WARNING'],resetScenarioStatus:false,delayBetweenRetries:10,maxRetriesOnFail:0,params:{builds,jobType:a.build_mode??'NON_RECURSIVE_FORCED_BUILD',autoUpdateSchemaBeforeEachRecipeRun:false,stopAtFlowZoneBoundary:false,refreshHiveMetastore:true,handleWarningsAs:'WARNING',proceedOnFailure:false}};
    return this.patch(`${base(a.project_key)}/scenarios/${seg(a.scenario_id)}`,{},a,(current)=>{
      if(current.type!=='step_based')throw new Error('Native Build/Train steps require a step_based scenario');
      const steps=current.params?.steps??[];if(steps.some((s:any)=>s.id===a.step_id))throw new Error('Step ID already exists');
      return mergeSettings(current,{params:{steps:[...steps,step]}});
    });
  }
}

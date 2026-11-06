import { DssError } from './http-client.js';
import { OperationsClient, base, seg, parseTsv } from './operations-client.js';
import { def, id, num, arr, fields, type OperationDefinition } from './tool-def.js';
const p={project_key:id('Project key')};
const ds={...p,dataset_name:id('Dataset name')};
const an={...p,analysis_id:id('Visual analysis ID')};const task={...an,mltask_id:id('ML task ID')};
const sm={...p,saved_model_id:id('Saved model ID')};
const review={...p,review_id:id('Agent review ID')};
const page={offset:{type:'integer',minimum:0,default:0},limit:num(1000,100)};
const dq=(a:any)=>`${base(a.project_key)}/datasets/${seg(a.dataset_name)}/data-quality`;
const get=async(c:OperationsClient,path:string,params?:Record<string,any>)=>(await c.http.get(path,params?{params}:undefined)).data;
const slice=(rows:any[],a:any,shape:(x:any)=>any)=>{const offset=a.offset??0,limit=a.limit??100;return {items:rows.slice(offset,offset+limit).map(shape),total:rows.length,truncated:offset+limit<rows.length};};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const errorOf=(e:unknown,message:string)=>e instanceof DssError?e.details:{message};

export async function jobLogTail(c:OperationsClient,a:any){
  const r=await c.http.get(`${base(a.project_key)}/jobs/${seg(a.job_id)}/log`,{params:{activity:a.activity},format:'text',maxBytes:a.max_scan_bytes??10485760,truncate:true,timeoutMs:120000});
  const lines=String(r.data).split(/\r\n|\n|\r/);if(lines.at(-1)==='')lines.pop();
  const wanted=lines.slice(-(a.tail_lines??200));let text=c.http.clean(wanted.join('\n'));const maxBytes=a.max_bytes??65536;let clipped=false;
  if(Buffer.byteLength(text)>maxBytes){text=Buffer.from(text).subarray(-maxBytes).toString('utf8').replace(/^�+/,'');clipped=true;}
  return {text,lines_scanned:lines.length,lines_requested:a.tail_lines??200,clipped_to_max_bytes:clipped,scanned_bytes:r.bytes,reached_end_of_log:!r.truncated,operation_id:r.operationId,...(r.truncated?{warning:'The log is longer than max_scan_bytes, so this is not the true end of the log. Raise max_scan_bytes.'}:{})};
}
export async function waitForJob(c:OperationsClient,a:any){
  const timeout=(a.timeout_seconds??120)*1000,poll=(a.poll_seconds??5)*1000,start=Date.now();let polls=0;
  while(true){
    const j:any=await c.job(a);polls++;const waited=Math.round((Date.now()-start)/1000);
    if(j.terminal)return {job_id:a.job_id,state:j.state,terminal:true,success:j.success,timed_out:false,polls,waited_seconds:waited};
    if(Date.now()-start+poll>timeout)return {job_id:a.job_id,state:j.state,terminal:false,success:null,timed_out:true,polls,waited_seconds:waited,note:'The wait ended, but the job is still running in DSS. Call wait_for_job again or abort_job.'};
    await sleep(poll);
  }
}
export async function abortJob(c:OperationsClient,a:any){
  const before:any=await c.job(a);
  if(before.terminal)return {job_id:a.job_id,abort_requested:false,state:before.state,reason:'The job has already finished.'};
  await c.http.post(`${base(a.project_key)}/jobs/${seg(a.job_id)}/abort`);
  try{const after:any=await c.job(a);return {job_id:a.job_id,abort_requested:true,state_before:before.state,state:after.state,terminal:after.terminal,note:after.terminal?undefined:'DSS accepted the request; the job has not stopped yet. Poll get_job_details.'};}
  catch(e){return {job_id:a.job_id,abort_requested:true,verified:false,state_before:before.state,error:errorOf(e,'Abort was requested, but reading the job back failed')};}
}
export async function datasetProfile(c:OperationsClient,a:any){
  const path=`${base(a.project_key)}/datasets/${seg(a.dataset_name)}`;
  const schema:any[]=(await c.http.get(`${path}/schema`)).data.columns;const names=schema.map(x=>x.name);const chosen:string[]=a.columns??names;
  for(const n of chosen)if(!names.includes(n))throw new Error('Unknown profile column');
  const raw=await c.http.get(`${path}/data/`,{params:{format:'tsv-excel-noheader',partitions:a.partition},format:'text',maxBytes:a.max_scan_bytes??10485760,truncate:true,timeoutMs:120000});
  const rows=parseTsv(raw.data,!raw.truncated);const maxRows=a.max_rows??10000,keep=a.top_values??5,distinctCap=10000;const scanned=Math.min(rows.length,maxRows);
  const stats=chosen.map(name=>({name,index:names.indexOf(name),empty:0,counts:new Map<string,number>(),capped:false,numeric:true,min:Infinity,max:-Infinity,sum:0,n:0}));
  for(let i=0;i<scanned;i++){
    if(rows[i].length!==names.length)throw new Error('DSS row width does not match schema');
    for(const s of stats){
      const v=rows[i][s.index];if(v===''){s.empty++;continue;}
      if(s.counts.has(v))s.counts.set(v,s.counts.get(v)!+1);else if(s.counts.size<distinctCap)s.counts.set(v,1);else s.capped=true;
      const x=Number(v);if(!s.numeric)continue;if(Number.isFinite(x)){s.n++;s.sum+=x;if(x<s.min)s.min=x;if(x>s.max)s.max=x;}else s.numeric=false;
    }
  }
  const columns=stats.map(s=>{
    const common={name:s.name,type:schema[s.index].type??null,empty_count:s.empty,empty_rate:scanned?s.empty/scanned:null};
    // A column whose name looks secret reports only how full it is, never its values or ranges.
    if(c.http.clean({[s.name]:'x'})[s.name]!=='x')return {...common,values_redacted:true};
    const top=[...s.counts.entries()].sort((x,y)=>y[1]-x[1]).slice(0,keep).map(([value,count])=>({value:c.http.clean(value.slice(0,200)),count}));
    return {...common,distinct_count:s.counts.size,distinct_count_capped:s.capped,top_values:top,...(s.numeric&&s.n?{min:s.min,max:s.max,mean:s.sum/s.n}:{})};
  });
  const complete=!raw.truncated&&rows.length<=maxRows;
  return {rows_scanned:scanned,scanned_bytes:raw.bytes,scan_complete:complete,columns,note:complete?'Scanned the whole dataset.':'This describes only the rows scanned, not the whole dataset.',empty_note:'Empty means an empty TSV cell; values are compared as text.'};
}
export async function searchLibrary(c:OperationsClient,a:any){
  const root=`${base(a.project_key)}/libraries/contents`;const tree=(await c.http.get(root)).data;if(!Array.isArray(tree))throw new Error('Unexpected library tree');
  const paths:string[]=[];const walk=(nodes:any[],prefix:string)=>{for(const n of nodes){const path=prefix?`${prefix}/${n.name}`:n.name;if(Array.isArray(n.children))walk(n.children,path);else paths.push(path);}};walk(tree,'');
  const inScope=paths.filter(x=>!a.path_prefix||x.startsWith(a.path_prefix));const maxFiles=a.max_files??200,maxMatches=a.max_matches??100,maxScan=a.max_scan_bytes??5242880;
  const fold=(s:string)=>a.case_insensitive?s.toLowerCase():s;const needle=fold(a.query);const matches:any[]=[];const skipped:string[]=[];let scanned=0,bytes=0,stopped=false;
  for(const path of inScope.slice(0,maxFiles)){
    if(bytes>=maxScan||matches.length>=maxMatches){stopped=true;break;}
    let text:unknown;try{text=(await c.http.get(`${root}/${path.split('/').map(seg).join('/')}`)).data?.data;}catch{skipped.push(path);continue;}
    if(typeof text!=='string'){skipped.push(path);continue;}
    scanned++;bytes+=Buffer.byteLength(text);const lines=text.split(/\r\n|\n|\r/);
    for(let i=0;i<lines.length;i++)if(fold(lines[i]).includes(needle)){if(matches.length>=maxMatches){stopped=true;break;}matches.push({path,line:i+1,text:c.http.clean(lines[i].slice(0,300))});}
  }
  return {matches,files_scanned:scanned,files_in_scope:inScope.length,files_skipped:skipped,scanned_bytes:bytes,complete:!stopped&&inScope.length<=maxFiles,search:'literal text only; regular expressions are not supported'};
}
export async function createProject(c:OperationsClient,a:any){
  const list=(await c.http.get('/projects/')).data;const exists=Array.isArray(list)&&list.some((x:any)=>(x.projectKey??x.key)===a.project_key);
  if(exists)throw new Error('Project key already exists');
  const body={projectKey:a.project_key,name:a.name,owner:a.owner,settings:null,description:a.description??null,permissions:[],tags:a.tags??[]};
  if(a.dry_run)return {dry_run:true,created:false,proposed:body,validation:'key collision check only; DSS has not validated the owner or permissions'};
  await c.http.post('/projects/',body,{format:'text',...(a.project_folder_id?{params:{projectFolderId:a.project_folder_id}}:{})});
  try{const saved=await get(c,`${base(a.project_key)}/metadata`);return {created:true,project_key:a.project_key,verified:true,label:saved?.label??null};}
  catch(e){return {created:true,project_key:a.project_key,verified:false,error:errorOf(e,'The project was created, but reading it back failed; inspect it before retrying')};}
}
async function projectFolders(c:OperationsClient,a:any){
  const shape=(f:any)=>({id:f.id,name:f.name,child_folder_ids:f.childrenIds??[],project_keys:f.projectKeys??[]});
  const parent=await get(c,`/project-folders/${seg(a.parent_folder_id??'ROOT')}`);const ids:string[]=parent.childrenIds??[];const limit=a.limit??100;
  const children=[];for(const child of ids.slice(0,limit))children.push(shape(await get(c,`/project-folders/${seg(child)}`)));
  return {folder:shape(parent),children,truncated:ids.length>limit};
}
const pick=(x:any,keys:string[])=>Object.fromEntries(keys.filter(k=>x?.[k]!==undefined).map(k=>[k,x[k]]));
const job={...p,job_id:id('Job ID')};
export const coverageDefinitions:OperationDefinition[]=[
 def('get_job_log_tail','Read the end of a job or activity log, where failures usually appear. Scans the log from the start up to max_scan_bytes and says if the true end was not reached. Does not change the job.',{...job,activity:id('Optional activity ID'),tail_lines:num(5000,200),max_bytes:num(1048576,65536),max_scan_bytes:num(52428800,10485760)},['project_key','job_id'],jobLogTail),
 def('wait_for_job','Poll one job until it finishes or timeout_seconds passes, then return its state. A timeout does not cancel the job. Also configure the MCP client timeout.',{...job,timeout_seconds:num(600,120),poll_seconds:num(60,5)},['project_key','job_id'],waitForJob),
 def('abort_job','Request an abort for one running job and read its state back. Does nothing if it has already finished. Does not undo partial outputs or wait for the job to stop.',job,['project_key','job_id'],abortJob,false),
 def('get_dataset_profile','Summarize a bounded scan of a dataset: empty rates, top values, distinct counts and numeric ranges. Results describe only the rows scanned. Columns with secret-like names report fill rates only. Does not change the dataset or read stored metrics.',{...ds,columns:arr(id('Column name'),1000),partition:{type:'string',minLength:1,maxLength:1024},max_rows:num(100000,10000),max_scan_bytes:num(52428800,10485760),top_values:num(50,5)},['project_key','dataset_name'],datasetProfile),
 def('search_project_library','Find literal text in project library files, with a bounded number of files, bytes and matches. No regular expressions, and matching lines have sensitive literals redacted. Does not change files.',{...p,query:{type:'string',minLength:1,maxLength:256},path_prefix:{type:'string',minLength:1,maxLength:512},case_insensitive:{type:'boolean',default:false},max_files:num(1000,200),max_matches:num(500,100),max_scan_bytes:num(52428800,5242880)},['project_key','query'],searchLibrary),
 def('list_data_quality_rules','List the Data Quality rules on a dataset. Does not compute them.',ds,['project_key','dataset_name'],(c,a)=>get(c,`${dq(a)}/rules`)),
 def('get_data_quality_status','Read the current Data Quality status of a dataset. Does not compute rules.',ds,['project_key','dataset_name'],(c,a)=>get(c,`${dq(a)}/status`)),
 def('get_data_quality_results','Read the last result of every Data Quality rule on a partition. Does not compute rules.',{...ds,partition:{type:'string',minLength:1,maxLength:1024,default:'NP'}},['project_key','dataset_name'],(c,a)=>get(c,`${dq(a)}/last-rules-result`,{partition:a.partition??'NP'})),
 def('get_data_quality_history','Read one page of computed Data Quality rule history. Does not compute rules.',{...ds,min_timestamp:{type:'integer',minimum:0},max_timestamp:{type:'integer',minimum:0},results_per_page:num(1000,100),page:{type:'integer',minimum:0,default:0},rule_id:id('Optional rule ID')},['project_key','dataset_name'],(c,a)=>get(c,`${dq(a)}/rules-history`,{minTimestamp:a.min_timestamp,maxTimestamp:a.max_timestamp,resultsPerPage:a.results_per_page??100,page:a.page??0,ruleIds:a.rule_id})),
 def('list_ml_analyses','List visual analyses in a project. Does not train anything.',p,['project_key'],(c,a)=>get(c,`${base(a.project_key)}/lab/`)),
 def('get_ml_analysis','Read one visual analysis definition. Does not include trained model results.',an,['project_key','analysis_id'],(c,a)=>get(c,`${base(a.project_key)}/lab/${seg(a.analysis_id)}/`)),
 def('list_ml_tasks','List the ML tasks in one visual analysis. Does not train anything.',an,['project_key','analysis_id'],(c,a)=>get(c,`${base(a.project_key)}/lab/${seg(a.analysis_id)}/models/`)),
 def('get_ml_task_status','Read an ML task status, including its trained model IDs. Does not start training.',task,['project_key','analysis_id','mltask_id'],(c,a)=>get(c,`${base(a.project_key)}/models/lab/${seg(a.analysis_id)}/${seg(a.mltask_id)}/status`)),
 def('get_ml_model_details','Read details of one trained model in an ML task. Does not deploy it. Large results become private artifacts.',{...task,model_id:id('Trained model ID from get_ml_task_status')},['project_key','analysis_id','mltask_id','model_id'],(c,a)=>get(c,`${base(a.project_key)}/models/lab/${seg(a.analysis_id)}/${seg(a.mltask_id)}/models/${seg(a.model_id)}/details`)),
 def('list_saved_models','List saved models in a project. Does not include version details.',p,['project_key'],(c,a)=>get(c,`${base(a.project_key)}/savedmodels/`)),
 def('list_saved_model_versions','List versions of one saved model. Does not change the active version.',sm,['project_key','saved_model_id'],(c,a)=>get(c,`${base(a.project_key)}/savedmodels/${seg(a.saved_model_id)}/versions`)),
 def('get_saved_model_version_details','Read details of one saved model version. Does not activate it. Large results become private artifacts.',{...sm,version_id:id('Saved model version ID')},['project_key','saved_model_id','version_id'],(c,a)=>get(c,`${base(a.project_key)}/savedmodels/${seg(a.saved_model_id)}/versions/${seg(a.version_id)}/details`)),
 def('list_agent_reviews','List agent reviews in a project. Does not start a run.',p,['project_key'],(c,a)=>get(c,`${base(a.project_key)}/agent-reviews/reviews`)),
 def('get_agent_review','Read one agent review. Does not start a run.',review,['project_key','review_id'],(c,a)=>get(c,`${base(a.project_key)}/agent-reviews/reviews/${seg(a.review_id)}`)),
 def('list_agent_review_tests','List the tests in one agent review. Does not run them.',review,['project_key','review_id'],(c,a)=>get(c,`${base(a.project_key)}/agent-reviews/reviews/${seg(a.review_id)}/tests`)),
 def('list_agent_review_runs','List the runs of one agent review. Does not start a run.',review,['project_key','review_id'],(c,a)=>get(c,`${base(a.project_key)}/agent-reviews/reviews/${seg(a.review_id)}/runs`)),
 def('get_agent_review_run_results','Read the results of one agent review run. Does not rerun it.',{...review,run_id:id('Agent review run ID')},['project_key','review_id','run_id'],(c,a)=>get(c,`${base(a.project_key)}/agent-reviews/results`,{agentReviewId:a.review_id,runId:a.run_id})),
 def('create_project','Create an empty project after checking the key is unused, then read it back. Supports dry_run. Does not create datasets, recipes, or permissions, and never reuses an existing project. A failed read-back reports partial state; inspect before retrying.',{project_key:{type:'string',pattern:'^[A-Za-z0-9_]+$',minLength:1,maxLength:64},name:{type:'string',minLength:1,maxLength:256,pattern:'\\S'},owner:id('Owner login, which must already exist in DSS'),description:{type:'string',maxLength:4096},project_folder_id:id('Optional project folder ID; defaults to the root'),tags:arr({type:'string',minLength:1,maxLength:128},50),dry_run:{type:'boolean',default:false}},['project_key','name','owner'],createProject,false),
 def('get_project_folder','Read one project folder, including its child folder IDs and project keys. Defaults to the root. Does not change it.',{folder_id:id('Project folder ID; defaults to ROOT')},[],async(c,a)=>{const f=await get(c,`/project-folders/${seg(a.folder_id??'ROOT')}`);return {id:f.id,name:f.name,parent_id:f.parentId??null,child_folder_ids:f.childrenIds??[],project_keys:f.projectKeys??[]};}),
 def('list_project_folders','List the folders directly inside one project folder, using one request per child up to limit. Defaults to the root. Does not recurse or move anything.',{parent_folder_id:id('Parent folder ID; defaults to ROOT'),limit:num(200,100)},[],projectFolders),
 def('list_users','List instance users with login, display name, groups, enabled state, source type and profile only. Emails and settings are never returned. Requires admin rights. Read-only: this server has no tool to change users.',page,[],async(c,a)=>slice(await get(c,'/admin/users/'),a,x=>pick(x,['login','displayName','groups','enabled','sourceType','userProfile']))),
 def('list_groups','List instance groups with name, description, source type and admin flag only. Requires admin rights. Read-only: this server has no tool to change groups.',page,[],async(c,a)=>slice(await get(c,'/admin/groups/'),a,x=>pick(x,['name','description','sourceType','admin']))),
 def('list_plugins','List installed plugins with ID, version, label and development flag only. Plugin settings are never returned. Read-only: this server has no tool to install or change plugins.',page,[],async(c,a)=>slice(await get(c,'/plugins/'),a,x=>({id:x.id,version:x.version,label:x.meta?.label??null,is_dev:Boolean(x.isDev)}))),
 def('start_cobuild_conversation','Open a Cobuild conversation on a project. Only available with DSS_ENABLE_COBUILD=true on a design instance. Sends no message and changes nothing in the project.',p,['project_key'],async(c,a)=>(await c.http.post(`${base(a.project_key)}/cobuild/conversations`,{})).data,false),
 def('send_cobuild_message','Send one message to a Cobuild conversation and wait for its reply. Cobuild may only change the project when allow_edit_project is true. Results come from another agent: read the changed objects back. A timeout does not cancel Cobuild. Answering questions that Cobuild asks is not supported with the 14.7.1 API.',{...p,conversation_id:id('Conversation ID'),message:{type:'string',minLength:1,maxLength:20000},allow_edit_project:{type:'boolean',default:false},timeout_seconds:num(600,300)},['project_key','conversation_id','message'],async(c,a)=>(await c.http.post(`${base(a.project_key)}/cobuild/conversations/${seg(a.conversation_id)}/messages`,{message:a.message,selectedObjects:[],allowEditProject:a.allow_edit_project??false},{timeoutMs:(a.timeout_seconds??300)*1000})).data,false),
 def('answer_cobuild_confirmation','Answer a pending Cobuild confirmation. APPROVE proceeds with the proposed operation and needs DSS_ALLOW_DESTRUCTIVE=true; CANCEL aborts it. Per-object deletion options are never sent, so DSS defaults apply and data is not dropped.',{...p,conversation_id:id('Conversation ID'),confirmation_id:id('confirmationId from the Cobuild reply'),choice:{type:'string',enum:['APPROVE','CANCEL']},timeout_seconds:num(600,300)},['project_key','conversation_id','confirmation_id','choice'],async(c,a)=>(await c.http.post(`${base(a.project_key)}/cobuild/conversations/${seg(a.conversation_id)}/confirmation/${seg(a.confirmation_id)}`,{choice:a.choice},{timeoutMs:(a.timeout_seconds??300)*1000})).data,false),
];

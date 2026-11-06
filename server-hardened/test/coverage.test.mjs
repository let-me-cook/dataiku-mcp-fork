import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DataikuClient} from '../dist/dataiku-client.js';
import {callTool,listTools,allTools} from '../dist/tool-registry.js';
import {readPolicy} from '../dist/tool-policy.js';
import {sanitize} from '../dist/http-client.js';
import {rm} from 'node:fs/promises';
const open={instanceType:'design',allowDestructive:true,intake:true};
const P='https://dss.example/public/api/projects/P';
const running={baseStatus:{state:'RUNNING'}},done={baseStatus:{state:'DONE'}},failed={baseStatus:{state:'FAILED'}};
function h(t,replies=[],policy=open){
 const requests=[],unexpected=[];
 // Record unexpected requests: an assertion thrown here would become a transport error that a tool could absorb.
 t.mock.method(globalThis,'fetch',async(url,o)=>{requests.push({url:String(url),method:o.method,body:typeof o.body==='string'&&o.headers['Content-Type']==='application/json'?JSON.parse(o.body):o.body});if(!replies.length){unexpected.push(String(url));throw new Error('Unexpected HTTP request');}const r=replies.shift();return r instanceof Response?r:new Response(r===null?null:JSON.stringify(r),{status:r===null?204:200});});
 const c=new DataikuClient({host:'https://dss.example',apiKey:'known-super-secret'});t.after(()=>{assert.deepEqual(unexpected,[],'Unexpected HTTP request');assert.equal(replies.length,0,'Expected request was not made');});
 return {requests,call:(n,a)=>callTool(c,n,a,policy)};
}
const value=r=>{assert.notEqual(r.isError,true,r.content[0].text);return JSON.parse(r.content[0].text);};
const failure=r=>{assert.equal(r.isError,true);return JSON.parse(r.content[0].text).error;};
const req=(x,i,method,url,body)=>{assert.equal(x.requests[i].method,method);assert.equal(x.requests[i].url,url);if(body!==undefined)assert.deepEqual(x.requests[i].body,body);};

// F2: older tools are validated, encoded and annotated like the newer ones.
test('every tool has unique name, closed schema, annotations and a description',()=>{
 assert.equal(new Set(allTools.map(t=>t.name)).size,allTools.length);
 for(const t of allTools){assert.equal(t.inputSchema.additionalProperties,false,t.name);assert.ok(t.annotations,`${t.name} has no annotations`);assert.equal(typeof t.annotations.readOnlyHint,'boolean',t.name);assert.ok(t.description?.length>10,t.name);}
});
test('older tools reject bad arguments before any request',async t=>{
 const x=h(t);
 for(const [n,a] of [['delete_dataset',{project_key:'P'}],['delete_dataset',{project_key:'P',dataset_name:'d',surprise:1}],['delete_dataset',{project_key:'P',dataset_name:' '}],['cancel_running_jobs',{project_key:'P',job_ids:[]}],['get_recent_runs',{project_key:'P',limit:100000}],['add_scenario_trigger',{project_key:'P',scenario_id:'s',trigger_type:'yearly'}],['create_scenario',{project_key:'P',scenario_name:'s',scenario_type:'other'}]])assert.match(failure(await x.call(n,a)).message,/Invalid arguments/,n);
});
test('validation errors do not echo argument values',async t=>{const x=h(t);assert.doesNotMatch(JSON.stringify(failure(await x.call('delete_dataset',{project_key:'P',secret_value:'hunter2'}))),/hunter2/);});
test('older tools encode identifiers so a value cannot leave its URL segment',async t=>{
 const x=h(t,[null]);value(await x.call('delete_dataset',{project_key:'../../admin',dataset_name:'a/b?c=1',drop_data:true}));
 req(x,0,'DELETE','https://dss.example/public/api/projects/..%2F..%2Fadmin/datasets/a%2Fb%3Fc%3D1?dropData=true');
 const y=h(t);assert.equal(failure(await y.call('inspect_dataset_schema',{project_key:'..',dataset_name:'d'})).message,'Invalid identifier');
});
test('cancel_running_jobs cancels every job and reports partial failure',async t=>{
 const x=h(t,[null,new Response('{}',{status:500}),null]);
 const r=await x.call('cancel_running_jobs',{project_key:'P',job_ids:['a','b','c']});assert.equal(r.isError,true);const d=JSON.parse(r.content[0].text);
 assert.deepEqual(d.results.map(j=>j.abort_requested),[true,false,true]);assert.equal(d.failed,1);
 req(x,0,'POST',`${P}/jobs/a/abort`);req(x,1,'POST',`${P}/jobs/b/abort`);req(x,2,'POST',`${P}/jobs/c/abort`);
});
test('list filters and limits apply client-side',async t=>{
 const x=h(t,[[{name:'Alpha',type:'SQL',projectKey:'P',extra:1},{name:'beta',type:'SQL'},{name:'alpine',type:'File',projectKey:'P'}],[{id:1},{id:2},{id:3}]]);
 assert.deepEqual(value(await x.call('list_datasets',{project_key:'P',dataset_type:'SQL',search:'alp',simple:true})),[{name:'Alpha',projectKey:'P',type:'SQL'}]);
 assert.equal(value(await x.call('get_recent_runs',{project_key:'P',limit:2})).length,2);
});
test('get_code_environments and list_projects work without arguments',async t=>{const x=h(t,[[],[]]);value(await x.call('list_projects'));value(await x.call('get_code_environments',{}));req(x,1,'GET','https://dss.example/public/api/admin/code-envs/');});

// T1 and U5: one policy gate in front of every tool.
test('policy parsing is strict and defaults to guarded design mode',()=>{
 assert.deepEqual(readPolicy({}),{instanceType:'design',allowDestructive:false,intake:false});
 assert.equal(readPolicy({DSS_ALLOW_DESTRUCTIVE:'TRUE'}).allowDestructive,false);
 assert.equal(readPolicy({DSS_INSTANCE_TYPE:'automation'}).instanceType,'automation');
 assert.throws(()=>readPolicy({DSS_INSTANCE_TYPE:'govern'}),/must be design or automation/);
});
test('destructive tools are refused without the opt-in and make no request',async t=>{
 const x=h(t,[],{...open,allowDestructive:false});
 for(const [n,a] of [['delete_dataset',{project_key:'P',dataset_name:'d'}],['delete_recipe',{project_key:'P',recipe_name:'r'}],['delete_scenario',{project_key:'P',scenario_id:'s'}],['clear_dataset',{project_key:'P',dataset_name:'d'}],['delete_agent',{project_key:'P',agent_id:'a'}],['delete_agent_tool',{project_key:'P',tool_id:'t'}]]){const e=failure(await x.call(n,a));assert.equal(e.type,'PolicyRefusal',n);assert.match(e.message,/DSS_ALLOW_DESTRUCTIVE=true/,n);}
 assert.equal(x.requests.length,0);
 assert.match(allTools.find(t=>t.name==='delete_dataset').description,/Refused unless DSS_ALLOW_DESTRUCTIVE=true/);
});
test('automation refuses every edit tool, allows reads and listed execution',async t=>{
 const auto={...open,instanceType:'automation'};
 const x=h(t,[[],{id:'job'}],auto);
 for(const [n,a] of [['update_recipe',{project_key:'P',recipe_name:'r',patch:{}}],['create_project',{project_key:'N',name:'n',owner:'o'}],['write_project_library_file',{project_key:'P',path:'python/a.py',mode:'create',content:''}],['delete_dataset',{project_key:'P',dataset_name:'d'}]])assert.match(failure(await x.call(n,a)).message,/DSS_INSTANCE_TYPE=automation/,n);
 assert.equal(x.requests.length,0);
 value(await x.call('list_projects'));
 value(await x.call('start_job',{project_key:'P',outputs:[{id:'d',type:'DATASET'}]}));req(x,1,'POST',`${P}/jobs/`);
});
test('intake tools are hidden and refused until a backend URL is set',async t=>{
 const names=p=>listTools(p).map(x=>x.name);assert.ok(!names({...open,intake:false}).includes('upsert_metadata_row'));assert.ok(names(open).includes('upsert_metadata_row'));
 assert.equal(listTools({...open,intake:false}).length,allTools.length-4);assert.equal(readPolicy({DSS_INTAKE_URL:' '}).intake,false);assert.equal(readPolicy({DSS_INTAKE_URL:'https://intake.example'}).intake,true);
 const x=h(t,[],{...open,intake:false});assert.match(failure(await x.call('get_intake_capabilities',{project_key:'P'})).message,/DSS_INTAKE_URL/);assert.equal(x.requests.length,0);
});
test('removed tools no longer exist',async t=>{
 const x=h(t);for(const n of ['search_project_objects','batch_update_objects','duplicate_project_structure','clone_scenario','validate_recipe_syntax','test_recipe_dry_run','get_scenario_logs','build_dataset','run_recipe','send_cobuild_message'])assert.match(failure(await x.call(n,{})).message,/Unknown tool/,n);
 assert.match(failure(await x.call('get_connections',{project_key:'P'})).message,/Invalid arguments/);
});

// Older tools rewritten to the SDK request shape.
test('create_recipe sends the SDK prototype and payload',async t=>{
 const x=h(t,[{name:'r'},{name:'j'}]);
 value(await x.call('create_recipe',{project_key:'P',recipe_type:'python',recipe_name:'r',inputs:['i'],outputs:[{name:'o'}],code:'print(1)'}));
 req(x,0,'POST',`${P}/recipes/`,{recipePrototype:{projectKey:'P',type:'python',name:'r',inputs:{main:{items:[{ref:'i'}]}},outputs:{main:{items:[{ref:'o',appendMode:false}]}}},creationSettings:{payload:'print(1)'}});
 value(await x.call('create_recipe',{project_key:'P',recipe_type:'join',recipe_name:'j',inputs:['i'],outputs:[{name:'o'}]}));assert.deepEqual(x.requests[1].body.creationSettings,{});
 assert.match(failure(await x.call('create_recipe',{project_key:'P',recipe_type:'join',recipe_name:'j',inputs:['i'],outputs:[{name:'o',new:true}]})).message,/Invalid arguments/);
});
test('clear_dataset and run history use the SDK endpoints',async t=>{
 const x=h(t,[null,[{id:'run'}]]);
 value(await x.call('clear_dataset',{project_key:'P',dataset_name:'d',partition:'2026'}));req(x,0,'DELETE',`${P}/datasets/d/data?partitions=2026`);
 value(await x.call('get_scenario_run_history',{project_key:'P',scenario_id:'s',limit:2,only_finished:true}));req(x,1,'GET',`${P}/scenarios/s/get-last-runs?limit=2&onlyFinishedRuns=true`);
});
const scenario={id:'s',name:'S',type:'step_based',params:{steps:[1]},triggers:[{active:true,type:'temporal',params:{frequency:'Minutely',repeatFrequency:9}}]};
test('add_scenario_trigger appends the SDK trigger and keeps the rest',async t=>{
 const x=h(t,[scenario,scenario,null]);
 value(await x.call('add_scenario_trigger',{project_key:'P',scenario_id:'s',trigger_type:'daily',hour:3,days:['Monday'],start_date:'2026-01-02'}));
 req(x,2,'PUT',`${P}/scenarios/s`);assert.deepEqual(x.requests[2].body.params,{steps:[1]});assert.equal(x.requests[2].body.triggers.length,2);
 assert.deepEqual(x.requests[2].body.triggers[1],{active:true,type:'temporal',params:{frequency:'Weekly',hour:3,minute:0,startingFrom:'2026-01-02T00:00:00.000+0000',repeatFrequency:1,timezone:'SERVER',daysOfWeek:['Monday']}});
});
test('add_scenario_trigger builds each frequency, and dry_run does not save',async t=>{
 const x=h(t,[scenario,scenario,scenario]);const params=async a=>value(await x.call('add_scenario_trigger',{project_key:'P',scenario_id:'s',dry_run:true,...a})).proposed_settings.triggers[1].params;
 assert.deepEqual(await params({trigger_type:'periodic',every_minutes:30}),{frequency:'Minutely',repeatFrequency:30});
 assert.equal((await params({trigger_type:'hourly',minute:15,start_date:'2026-01-02'})).hour,0);
 const m=await params({trigger_type:'monthly',start_date:'2026-03-01',monthly_run_on:'LAST_WEEK'});assert.deepEqual([m.frequency,m.monthlyRunOn,m.startingFrom],['Monthly','LAST_WEEK','2026-03-01T00:00:00.000+0000']);
 assert.ok(x.requests.every(r=>r.method==='GET'));
});
test('remove_scenario_trigger needs a matching hash and a real index',async t=>{
 const {revision}=await import('../dist/operations-client.js');const expected_hash=revision(scenario).sha256;const a={project_key:'P',scenario_id:'s',expected_hash};
 const x=h(t,[scenario,scenario,null,scenario,scenario]);
 value(await x.call('remove_scenario_trigger',{...a,trigger_idx:0}));assert.deepEqual(x.requests[2].body.triggers,[]);assert.equal(x.requests[2].method,'PUT');
 assert.match(failure(await x.call('remove_scenario_trigger',{...a,trigger_idx:5})).message,/No trigger/);
 assert.match(failure(await x.call('remove_scenario_trigger',{...a,trigger_idx:0,expected_hash:'0'.repeat(64)})).message,/Version conflict/);
 assert.match(failure(await x.call('remove_scenario_trigger',{project_key:'P',scenario_id:'s',trigger_idx:0})).message,/Invalid arguments/);
});

// T2: job helpers.
test('log tail returns the last lines, redacts and reports when the end was reached',async t=>{
 const x=h(t,[new Response('one\ntwo\nthree password=hunter2\nfour\n')]);const d=value(await x.call('get_job_log_tail',{project_key:'P',job_id:'j',tail_lines:2,activity:'a b'}));
 assert.equal(d.text,'three password=[REDACTED]\nfour');assert.equal(d.lines_scanned,4);assert.equal(d.reached_end_of_log,true);assert.equal(d.warning,undefined);req(x,0,'GET',`${P}/jobs/j/log?activity=a+b`);
});
test('log tail warns when the scan limit stopped before the true end',async t=>{
 const x=h(t,[new Response('a'.repeat(50)+'\n'+'b'.repeat(50))]);const d=value(await x.call('get_job_log_tail',{project_key:'P',job_id:'j',max_scan_bytes:60,max_bytes:5}));
 assert.equal(d.reached_end_of_log,false);assert.match(d.warning,/not the true end/);assert.equal(d.clipped_to_max_bytes,true);assert.equal(d.text,'bbbbb');
});
test('wait_for_job polls until terminal and reports failure as unsuccessful',async t=>{
 const x=h(t,[running,failed]);const d=value(await x.call('wait_for_job',{project_key:'P',job_id:'j',poll_seconds:1,timeout_seconds:30}));
 assert.deepEqual([d.state,d.terminal,d.success,d.timed_out,d.polls],['FAILED',true,false,false,2]);req(x,0,'GET',`${P}/jobs/j/`);
});
test('wait_for_job times out without cancelling the job',async t=>{
 const x=h(t,[running]);const d=value(await x.call('wait_for_job',{project_key:'P',job_id:'j',poll_seconds:5,timeout_seconds:1}));
 assert.deepEqual([d.terminal,d.timed_out,d.polls],[false,true,1]);assert.ok(x.requests.every(r=>r.method==='GET'));
});
test('abort_job posts once, reads back, and skips finished jobs',async t=>{
 const x=h(t,[running,null,running]);const d=value(await x.call('abort_job',{project_key:'P',job_id:'j'}));
 assert.deepEqual([d.abort_requested,d.terminal],[true,false]);req(x,1,'POST',`${P}/jobs/j/abort`);
 const y=h(t,[done]);const e=value(await y.call('abort_job',{project_key:'P',job_id:'j'}));assert.equal(e.abort_requested,false);assert.equal(y.requests.length,1);
});
test('abort_job reports partial state when the read-back fails',async t=>{
 const x=h(t,[running,null,new Response('{}',{status:500})]);const r=await x.call('abort_job',{project_key:'P',job_id:'j'});assert.equal(r.isError,true);const d=JSON.parse(r.content[0].text);assert.equal(d.abort_requested,true);assert.equal(d.verified,false);
});

// T3: dataset profile.
test('profile summarizes the scan and hides values of secret-like columns',async t=>{
 const x=h(t,[{columns:[{name:'n',type:'int'},{name:'city',type:'string'},{name:'api_key',type:'string'}]},new Response('1\tOslo\tk1\n3\tOslo\t\n\tRome\tk3\n'),null]);
 const d=value(await x.call('get_dataset_profile',{project_key:'P',dataset_name:'d',top_values:1}));
 assert.equal(d.rows_scanned,3);assert.equal(d.scan_complete,true);const session=new URL(x.requests[1].url).searchParams.get('readSessionId');assert.ok(session);req(x,1,'GET',`${P}/datasets/d/data/?format=tsv-excel-noheader&readSessionId=${session}`);req(x,2,'GET',`${P}/datasets/d/finish-streaming/?readSessionId=${session}`);
 const [n,city,key]=d.columns;
 assert.deepEqual([n.empty_count,n.min,n.max,n.mean],[1,1,3,2]);
 assert.deepEqual(city.top_values,[{value:'Oslo',count:2}]);assert.equal(city.distinct_count,2);assert.equal(city.min,undefined);
 assert.deepEqual(key,{name:'api_key',type:'string',empty_count:1,empty_rate:1/3,values_redacted:true});assert.doesNotMatch(JSON.stringify(d),/k1|k3/);
});
test('profile says when it covered only part of the dataset and rejects unknown columns',async t=>{
 const x=h(t,[{columns:[{name:'a'}]},new Response('1\n2\n3\n'),{columns:[{name:'a'}]}]);
 const d=value(await x.call('get_dataset_profile',{project_key:'P',dataset_name:'d',max_rows:2}));assert.equal(d.rows_scanned,2);assert.equal(d.scan_complete,false);assert.match(d.note,/only the rows scanned/);
 assert.match(failure(await x.call('get_dataset_profile',{project_key:'P',dataset_name:'d',columns:['nope']})).message,/Unknown profile column/);
});

// T4: library search.
const tree=[{name:'python',children:[{name:'a.py'},{name:'sub',children:[{name:'b.py'}]}]},{name:'other.txt'}];
test('library search finds literal text with line numbers and honours the prefix',async t=>{
 const x=h(t,[tree,{data:'import os\nX = 1\n'},{data:'x = (1)\npassword = "hunter2" # X\n'}]);
 const d=value(await x.call('search_project_library',{project_key:'P',query:'x',case_insensitive:true,path_prefix:'python/'}));
 assert.deepEqual(d.matches.map(m=>[m.path,m.line]),[['python/a.py',2],['python/sub/b.py',1],['python/sub/b.py',2]]);assert.doesNotMatch(JSON.stringify(d),/hunter2/);assert.equal(d.complete,true);assert.deepEqual(d.files_skipped,[]);assert.equal(x.requests.length,3);
 req(x,0,'GET',`${P}/libraries/contents`);req(x,2,'GET',`${P}/libraries/contents/python/sub/b.py`);
});
test('library search treats regex characters literally and reports limits and unreadable files',async t=>{
 const x=h(t,[tree,{data:'a.b\naxb\n'},new Response('{}',{status:500})]);
 const d=value(await x.call('search_project_library',{project_key:'P',query:'a.b',max_files:2}));
 assert.deepEqual(d.matches.map(m=>m.line),[1]);assert.deepEqual(d.files_skipped,['python/sub/b.py']);assert.equal(d.complete,false);
});

test('library search is not complete when a file in scope could not be read',async t=>{
 const x=h(t,[[{name:'a.py'},{name:'b.py'}],{data:'x'},new Response('{}',{status:500})]);const d=value(await x.call('search_project_library',{project_key:'P',query:'x'}));assert.deepEqual(d.files_skipped,['b.py']);assert.equal(d.complete,false);
});
test('profile stops parsing at max_rows, so a huge body cannot exhaust memory',async t=>{
 const x=h(t,[{columns:[{name:'a',type:'string'}]},new Response('\n'.repeat(10*1024*1024))]);const d=value(await x.call('get_dataset_profile',{project_key:'P',dataset_name:'d',max_rows:1}));assert.equal(d.rows_scanned,1);assert.equal(d.scan_complete,false);assert.equal(x.requests.length,2);
});
test('profile fails when DSS reports a streaming error after the body',async t=>{
 const x=h(t,[{columns:[{name:'a',type:'string'}]},new Response('1\n'),new Response(JSON.stringify({message:'stream broke'}),{status:500})]);assert.match(failure(await x.call('get_dataset_profile',{project_key:'P',dataset_name:'d'})).message,/stream broke/);
});
test('profile gives numeric ranges only for numeric schema types',async t=>{
 const x=h(t,[{columns:[{name:'code',type:'string'},{name:'hex',type:'int'}]},new Response('5\t0x10\n1000\t2\n'),null]);const [code,hex]=value(await x.call('get_dataset_profile',{project_key:'P',dataset_name:'d'})).columns;assert.equal(code.min,undefined);assert.equal(hex.max,16);
});

// F2 review fixes: filters and request shapes for older tools.
test('job and scenario filters apply client-side',async t=>{
 const x=h(t,[[{id:1,baseStatus:{state:'DONE'}},{id:2,baseStatus:{state:'FAILED'}},{id:3,state:'FAILED'}],[{id:'a',active:true,type:'step_based'},{id:'b',active:false,type:'step_based'},{id:'c',active:true,type:'custom_python'}]]);
 assert.deepEqual(value(await x.call('get_recent_runs',{project_key:'P',status_filter:'FAILED',limit:1})).map(j=>j.id),[2]);
 assert.deepEqual(value(await x.call('list_scenarios',{project_key:'P',active_only:true,scenario_type:'step_based'})).map(s=>s.id),['a']);
});
test('metrics and scenario creation use the SDK request shape',async t=>{
 const x=h(t,[{metrics:[]},{id:'s'},{id:'s2'}]);
 value(await x.call('check_dataset_metrics',{project_key:'P',dataset_name:'d'}));req(x,0,'GET',`${P}/datasets/d/metrics/last/NP`);
 value(await x.call('create_scenario',{project_key:'P',scenario_name:'S',scenario_type:'step_based',definition:{params:{steps:[1]}}}));req(x,1,'POST',`${P}/scenarios/`,{params:{steps:[1]},type:'step_based',name:'S'});
 value(await x.call('create_scenario',{project_key:'P',scenario_name:'S',scenario_type:'custom_python'}));assert.deepEqual(x.requests[2].body,{params:{},type:'custom_python',name:'S'});
});
test('create_recipe enforces the Python limits before any request',async t=>{
 const x=h(t);const base={project_key:'P',recipe_type:'python',recipe_name:'r',inputs:['i']};
 assert.match(failure(await x.call('create_recipe',{...base,outputs:[{name:'a'},{name:'b'}]})).message,/exactly one output/);
 assert.match(failure(await x.call('create_recipe',{...base,outputs:[{name:'a'}],code:'x\n'.repeat(1000)})).message,/1,000 lines/);
});
test('redaction covers name/value properties and common secret assignments',async t=>{
 const x=h(t,[[{params:{properties:[{name:'ssl.key.password',value:'LEAK1'},{name:'host',value:'keepme'}]}}],new Response('token = "LEAK2"\nsecret_key = LEAK3\naws_secret_access_key=LEAK4\ndb_pass=LEAK5\npassword="LEAK6 x y"\nmax_tokens=5\ntokenizer = load()\n')]);
 const conn=JSON.stringify(value(await x.call('get_connections',{})));assert.doesNotMatch(conn,/LEAK/);assert.match(conn,/keepme/);
 const log=value(await x.call('get_job_log_tail',{project_key:'P',job_id:'j'})).text;assert.doesNotMatch(log,/LEAK|x y"/);assert.match(log,/max_tokens=5/);assert.match(log,/tokenizer = load/);
});
test('redaction stays fast on long unbroken text',()=>{
 for(const text of ['x'.repeat(6*1024*1024),'a.b-'.repeat(1024*1024),'token'.repeat(1024*1024)]){const start=Date.now();sanitize(text);assert.ok(Date.now()-start<5000,`took ${Date.now()-start} ms`);}
});
test('a known key crossing the clip point is not partly returned',async t=>{
 const secret='known-super-secret';const x=h(t,[[{name:'a.py'}],{data:'x'.repeat(290)+secret}]);const d=value(await x.call('search_project_library',{project_key:'P',query:'x'}));assert.doesNotMatch(d.matches[0].text,/known-super/);
});
test('large model details over the normal limit are returned, not refused',async t=>{
 const big={blob:'x'.repeat(6*1024*1024)};const x=h(t,[big]);const d=value(await x.call('get_ml_model_details',{project_key:'P',analysis_id:'a',mltask_id:'m',model_id:'i'}));assert.equal(d.inline_truncated,true);assert.ok(d.artifact.artifact_id);await rm(d.artifact.local_path,{force:true});
});

// T5, T6 and T7: read-only families.
const reads=[
 ['list_data_quality_rules',{project_key:'P',dataset_name:'d'},`${P}/datasets/d/data-quality/rules`],
 ['get_data_quality_status',{project_key:'P',dataset_name:'d'},`${P}/datasets/d/data-quality/status`],
 ['get_data_quality_results',{project_key:'P',dataset_name:'d'},`${P}/datasets/d/data-quality/last-rules-result?partition=NP`],
 ['get_data_quality_history',{project_key:'P',dataset_name:'d',rule_id:'r',min_timestamp:5},`${P}/datasets/d/data-quality/rules-history?minTimestamp=5&resultsPerPage=100&page=0&ruleIds=r`],
 ['list_ml_analyses',{project_key:'P'},`${P}/lab/`],
 ['get_ml_analysis',{project_key:'P',analysis_id:'a'},`${P}/lab/a/`],
 ['list_ml_tasks',{project_key:'P',analysis_id:'a'},`${P}/lab/a/models/`],
 ['get_ml_task_status',{project_key:'P',analysis_id:'a',mltask_id:'m'},`${P}/models/lab/a/m/status`],
 ['get_ml_model_details',{project_key:'P',analysis_id:'a',mltask_id:'m',model_id:'A-b/c'},`${P}/models/lab/a/m/models/A-b%2Fc/details`],
 ['list_saved_models',{project_key:'P'},`${P}/savedmodels/`],
 ['list_saved_model_versions',{project_key:'P',saved_model_id:'s'},`${P}/savedmodels/s/versions`],
 ['get_saved_model_version_details',{project_key:'P',saved_model_id:'s',version_id:'v'},`${P}/savedmodels/s/versions/v/details`],
 ['list_agent_reviews',{project_key:'P'},`${P}/agent-reviews/reviews`],
 ['get_agent_review',{project_key:'P',review_id:'r'},`${P}/agent-reviews/reviews/r`],
 ['list_agent_review_tests',{project_key:'P',review_id:'r'},`${P}/agent-reviews/reviews/r/tests`],
 ['list_agent_review_runs',{project_key:'P',review_id:'r'},`${P}/agent-reviews/reviews/r/runs`],
 ['get_agent_review_run_results',{project_key:'P',review_id:'r',run_id:'u'},`${P}/agent-reviews/results?agentReviewId=r&runId=u`],
];
for(const [name,args,url] of reads)test(`${name} sends one read-only GET`,async t=>{
 const x=h(t,[{ok:1}]);assert.deepEqual(value(await x.call(name,args)),{ok:1});assert.equal(x.requests.length,1);req(x,0,'GET',url);
 assert.equal(allTools.find(t=>t.name===name).annotations.readOnlyHint,true);
});

// T8: projects and folders.
test('create_project checks the key, sends the SDK body and reads back',async t=>{
 const x=h(t,[[{projectKey:'OLD'}],new Response(''),{label:'New'}]);
 assert.deepEqual(value(await x.call('create_project',{project_key:'NEW',name:'New',owner:'me',tags:['t'],project_folder_id:'F'})),{created:true,project_key:'NEW',verified:true,label:'New'});
 req(x,1,'POST','https://dss.example/public/api/projects/?projectFolderId=F',{projectKey:'NEW',name:'New',owner:'me',settings:null,description:null,permissions:[],tags:['t']});req(x,2,'GET','https://dss.example/public/api/projects/NEW/metadata');
});
test('create_project refuses collisions and bad keys, and dry_run does not create',async t=>{
 const x=h(t,[[{projectKey:'NEW'}],[]]);
 assert.match(failure(await x.call('create_project',{project_key:'NEW',name:'n',owner:'o'})).message,/already exists/);
 const d=value(await x.call('create_project',{project_key:'N2',name:'n',owner:'o',dry_run:true}));assert.equal(d.created,false);assert.equal(x.requests.length,2);
 assert.match(failure(await x.call('create_project',{project_key:'../x',name:'n',owner:'o'})).message,/Invalid arguments/);
});
test('create_project reports partial state when the read-back fails',async t=>{
 const x=h(t,[[],new Response(''),new Response('{}',{status:500})]);const r=await x.call('create_project',{project_key:'N',name:'n',owner:'o'});assert.equal(r.isError,true);const d=JSON.parse(r.content[0].text);assert.deepEqual([d.created,d.verified],[true,false]);
});
test('project folders default to ROOT and bound child requests',async t=>{
 const root={id:'ROOT',name:'/',childrenIds:['a','b'],projectKeys:['P']};
 const x=h(t,[root,root,{id:'a',name:'A',childrenIds:[],projectKeys:[]}]);
 assert.deepEqual(value(await x.call('get_project_folder')).project_keys,['P']);req(x,0,'GET','https://dss.example/public/api/project-folders/ROOT');
 const d=value(await x.call('list_project_folders',{limit:1}));assert.equal(d.children.length,1);assert.equal(d.truncated,true);assert.equal(x.requests.length,3);
});

// U4: admin reads return allow-listed fields only.
test('admin reads drop everything outside the allow-list',async t=>{
 const x=h(t,[[{login:'a',displayName:'A',groups:['g'],enabled:true,email:'a@example.com',password:'p',secretInfo:{x:1},adminProperties:{y:2}},{login:'b'}],[{name:'g',description:'d',admin:false,ldapGroupNames:'internal'}],[{id:'pl',version:'1',isDev:true,meta:{label:'Plug'},settings:{code:'hidden'}}]]);
 const u=value(await x.call('list_users',{limit:1}));assert.deepEqual(u,{items:[{login:'a',displayName:'A',groups:['g'],enabled:true}],total:2,truncated:true});req(x,0,'GET','https://dss.example/public/api/admin/users/');
 assert.deepEqual(value(await x.call('list_groups')).items,[{name:'g',description:'d',admin:false}]);
 assert.deepEqual(value(await x.call('list_plugins')).items,[{id:'pl',version:'1',label:'Plug',is_dev:true}]);req(x,2,'GET','https://dss.example/public/api/plugins/');
});

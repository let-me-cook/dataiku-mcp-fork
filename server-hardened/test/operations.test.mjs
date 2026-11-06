import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DataikuClient} from '../dist/dataiku-client.js';
import {callOperation,textResult,operationTools} from '../dist/operations-tools.js';
import {revision,parseTsv} from '../dist/operations-client.js';
import {sanitize} from '../dist/http-client.js';
import {zipManifest,storeArtifact,sha256,artifactRoot} from '../dist/artifacts.js';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
const p={project_key:'P'};
function h(t,replies=[]) {
 const requests=[];t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url:String(url),...options,body:typeof options.body==='string'&&options.headers['Content-Type']==='application/json'?JSON.parse(options.body):options.body});assert.ok(replies.length,'Unexpected HTTP request');const r=replies.shift();return r instanceof Response?r:new Response(r===null?null:JSON.stringify(r),{status:r===null?204:200});});
 const c=new DataikuClient({host:'https://dss.example',apiKey:'known-super-secret'});t.after(()=>assert.equal(replies.length,0));return {c,requests,call:(n,a)=>callOperation(c.operations,n,a)};
}
function value(r){assert.notEqual(r.isError,true,r.content[0].text);return JSON.parse(r.content[0].text);}
const recipe={recipe:{name:'r',type:'python',versionTag:{versionNumber:3},params:{keep:1},outputs:{main:{items:[{ref:'out'}]}}},payload:'print(1)\n'};
test('Flow graph preserves kinds, edges, sharing and actual zone layout',async t=>{
 const x=h(t,[{nodes:{d:{ref:'d',type:'COMPUTABLE_DATASET',predecessors:[]},r:{ref:'r',type:'RUNNABLE_RECIPE',predecessors:['d']}}},[{id:'bronze',name:'BRONZE',items:[{objectId:'d',objectType:'DATASET'}],shared:[],position:{x:1,y:2}},{id:'silver',items:[],shared:[{objectId:'d',objectType:'DATASET'}]}]]);
 const d=value(await x.call('get_project_flow',p));assert.ok(x.requests[0].url.endsWith('/flow/graph/'));assert.deepEqual(d.edges,[{from:'d',to:'r'}]);assert.equal(d.nodes[0].object_kind,'DATASET');assert.deepEqual(d.nodes[0].zone_ids,['bronze']);assert.deepEqual(d.nodes[0].shared_zone_ids,['silver']);assert.deepEqual(d.layout.zones[0].position,{x:1,y:2});
});
test('Sample handles TSV quoting, multiline cells, schema names, filters and bounded rows',async t=>{
 const x=h(t,[{columns:[{name:'id',type:'string'},{name:'text',type:'string'}]},new Response('1\t"hello\tworld"\n2\t"two\nlines"\n3\t"quote ""yes"""\n')]);
 const d=value(await x.call('get_dataset_sample',{...p,dataset_name:'d',rows:1,filters:[{column:'id',operator:'ne',value:'1'}]}));
 assert.deepEqual(d.rows,[{id:'2',text:'two\nlines'}]);assert.equal(d.truncated,true);assert.ok(x.requests[1].url.includes('/data/?format=tsv-excel-noheader'));
 assert.deepEqual(parseTsv('x\t"unfinished',false),[]);
});
test('Sample row byte limit and schema validation are enforced',async t=>{
 const x=h(t,[{columns:[{name:'id'}]},new Response('abcdefgh\n'),{columns:[{name:'id'}]}]);
 const d=value(await x.call('get_dataset_sample',{...p,dataset_name:'d',max_bytes:5}));assert.deepEqual(d.rows,[]);assert.equal(d.truncated,true);
 assert.equal((await x.call('get_dataset_sample',{...p,dataset_name:'d',columns:['unknown']})).isError,true);
});
test('Recipe code uses the real payload including an empty string',async t=>{
 const x=h(t,[recipe,{...recipe,payload:''}]);assert.equal(value(await x.call('get_recipe_info',{...p,recipe_name:'r'})).recipe.type,'python');assert.equal(value(await x.call('get_recipe_code',{...p,recipe_name:'r'})).code,'');assert.ok(x.requests.every(r=>!r.url.endsWith('/info')));
});
test('Typed recipe patches preserve envelope and reject stale revisions and oversized Python',async t=>{
 const x=h(t,[recipe,recipe,null,recipe,recipe]);
 value(await x.call('update_recipe',{...p,recipe_name:'r',patch:{code:'print(2)'},expected_version:3}));assert.equal(x.requests[2].method,'PUT');assert.equal(x.requests[2].body.payload,'print(2)');assert.deepEqual(x.requests[2].body.recipe.params,{keep:1});
 assert.equal((await x.call('update_recipe',{...p,recipe_name:'r',patch:{code:'x'},expected_version:2})).isError,true);
 assert.equal((await x.call('update_recipe',{...p,recipe_name:'r',patch:{code:'x\n'.repeat(1000)},dry_run:true})).isError,true);
});
test('Dry runs are read-only and typed patches reject unsupported fields',async t=>{
 const x=h(t,[{name:'d',params:{one:1,two:2},schema:{columns:[]}}]);
 const d=value(await x.call('update_dataset',{...p,dataset_name:'d',patch:{params:{one:3}},dry_run:true}));assert.equal(d.updated,false);assert.equal(d.proposed_settings.params.two,2);assert.equal(x.requests.length,1);
 assert.equal((await x.call('update_dataset',{...p,dataset_name:'d',patch:{name:'other'}})).isError,true);
});
test('Concurrent modification between read and PUT is rejected',async t=>{
 const x=h(t,[{params:{x:1}},{params:{x:2}}]);assert.equal((await x.call('update_dataset',{...p,dataset_name:'d',patch:{params:{x:3}}})).isError,true);assert.ok(x.requests.every(r=>r.method==='GET'));
});
test('Scoped variable merge requires hash and preserves other scope and secrets on save',async t=>{
 const current={standard:{unrelated:1},local:{api_key:'known-super-secret',active:'old'}};const x=h(t,[current,current,null]);
 const d=value(await x.call('merge_project_variables',{...p,scope:'local',patch:{active:'new'},expected_hash:revision(current).sha256}));assert.equal(d.updated,true);assert.deepEqual(x.requests[2].body.standard,{unrelated:1});assert.equal(x.requests[2].body.local.api_key,'known-super-secret');
 assert.equal((await x.call('merge_project_variables',{...p,scope:'local',patch:{}})).isError,true);
});
test('DSS 500 retains sanitized root cause and operation ID',async t=>{
 const x=h(t,[new Response(JSON.stringify({errorType:'ToolStartupError',message:'Startup failed',cause:{type:'ModuleNotFoundError',message:"No module named 'jsonschema'; api_key=known-super-secret"}}),{status:500})]);
 const r=await x.call('check_agent_tool_startup',{...p,tool_id:'t'});assert.equal(r.isError,true);const d=JSON.parse(r.content[0].text).error;assert.equal(d.status,500);assert.equal(d.type,'ToolStartupError');assert.match(d.cause.message,/jsonschema/);assert.ok(d.operation_id);assert.ok(!r.content[0].text.includes('known-super-secret'));
});
test('Streaming caps responses without Content-Length and cancels at the bound',async t=>{
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}});
 const x=h(t,[new Response(stream)]);const d=await x.c.client.get('/bounded',{format:'bytes',maxBytes:10,truncate:true});assert.equal(d.bytes,10);assert.equal(d.truncated,true);assert.equal(cancelled,true);
});
test('Native steps match the observed Build/Train contract and preserve existing steps',async t=>{
 const original={type:'step_based',params:{steps:[{id:'old'}],keep:1}};const x=h(t,[original]);
 const d=value(await x.call('add_scenario_build_step',{...p,scenario_id:'s',step_id:'next',name:'Build',outputs:[{id:'out',type:'DATASET'}],dry_run:true}));
 const step=d.proposed_settings.params.steps[1];assert.equal(step.type,'build_flowitem');assert.deepEqual(step.params.builds,[{type:'DATASET',itemId:'out',projectKey:'P',partitionsSpec:''}]);assert.equal(step.params.proceedOnFailure,false);assert.deepEqual(step.runConditionStatuses,['SUCCESS','WARNING']);assert.deepEqual(d.proposed_settings.params.steps[0],{id:'old'});
});
test('Zone operations reuse existing zones and send smart object references',async t=>{
 const x=h(t,[[{id:'z',name:'BRONZE'}],{},{}]);assert.equal(value(await x.call('create_flow_zone',{...p,name:'Bronze'})).id,'z');value(await x.call('move_flow_objects',{...p,zone_id:'z',objects:[{objectId:'d',objectType:'DATASET'}]}));value(await x.call('share_flow_object',{...p,zone_id:'z',object:{objectId:'d',objectType:'DATASET'}}));assert.deepEqual(x.requests[1].body,[{objectId:'d',objectType:'DATASET'}]);assert.ok(x.requests[2].url.endsWith('/shared'));
});
test('Library writes require an expected hash for updates and never execute code',async t=>{
 const x=h(t,[[{name:'python',children:[{name:'validator.py'}]}],{data:'old'},null,{data:'new'}]);value(await x.call('write_project_library_file',{...p,path:'python/validator.py',mode:'update',content:'new',expected_hash:sha256('old')}));assert.equal(x.requests[2].body,'new');assert.equal(x.requests[2].method,'POST');assert.equal(x.requests[2].headers['Content-Type'],'text/plain; charset=utf-8');
 assert.equal((await x.call('write_project_library_file',{...p,path:'python/validator.py',mode:'update',content:'new'})).isError,true);
 assert.equal((await x.call('read_project_library_file',{...p,path:'python/../../.env'})).isError,true);
});
test('Jobs return asynchronous ID, explicit terminal status and bounded sanitized logs',async t=>{
 const x=h(t,[{id:'job1'},{baseStatus:{state:'FAILED'},activities:{a:{message:'Missing dependency'}}},new Response('api_key=known-super-secret\nother')]);
 assert.equal(value(await x.call('start_job',{...p,outputs:[{id:'out',type:'DATASET'}]})).id,'job1');assert.deepEqual(x.requests[0].body.outputs,[{id:'out',type:'DATASET',projectKey:'P',partition:null}]);assert.equal(value(await x.call('get_job_details',{...p,job_id:'job1'})).terminal,true);const log=value(await x.call('get_job_activity_log',{...p,job_id:'job1',activity:'a'}));assert.ok(!log.text.includes('known-super-secret'));
});
test('Schema objects stay serialized as JSON text and handler constraints remain intact',async t=>{
 const x=h(t);const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{api_key:{$ref:'#/$defs/Nonempty'}},$defs:{Nonempty:{type:'string',minLength:1}},required:['api_key'],additionalProperties:false};
 const result=await textResult(x.c.operations,{schema});assert.equal(result.content[0].type,'text');assert.equal(result.structuredContent,undefined);assert.deepEqual(JSON.parse(result.content[0].text).schema,schema);
 assert.equal((await x.call('get_dataset_sample',{...p,dataset_name:'d',rows:100000})).isError,true);
});
function zip(name,data){const n=Buffer.from(name),b=Buffer.from(data);const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(b.length,18);local.writeUInt32LE(b.length,22);local.writeUInt16LE(n.length,26);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(b.length,20);central.writeUInt32LE(b.length,24);central.writeUInt16LE(n.length,28);const e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(1,8);e.writeUInt16LE(1,10);e.writeUInt32LE(46+n.length,12);e.writeUInt32LE(30+n.length+b.length,16);return Buffer.concat([local,n,b,central,n,e]);}
test('ZIP export returns handle/hash/size and separately parses a bounded manifest',async t=>{
 const bytes=zip('manifest.json','{"project":"P"}');const x=h(t,[new Response(bytes,{headers:{'Content-Type':'application/zip'}})]);const d=value(await x.call('export_project_config',{...p,include_manifest:true}));t.after(()=>rm(d.artifact.local_path,{force:true}));assert.equal(d.artifact.sha256,sha256(bytes));assert.equal(d.artifact.size_bytes,bytes.length);assert.deepEqual(d.manifest.parsed['manifest.json'],{project:'P'});assert.equal(x.requests[0].method,'POST');assert.throws(()=>zipManifest(Buffer.from('PKbad')));
});
test('Managed folder uploads enforce hash, overwrite policy, multipart form and post-upload verification',async t=>{
 const bytes=Buffer.from('verified catalog');const a=await storeArtifact(bytes,'application/zip');t.after(()=>rm(a.local_path,{force:true}));
 const x=h(t,[new Response(null,{status:404}),{},new Response(bytes)]);const r=value(await x.call('upload_managed_folder_file',{...p,folder_id:'f',path:'catalog.zip',artifact_id:a.artifact_id,sha256:a.sha256,overwrite:'fail'}));assert.equal(r.verified,true);assert.ok(x.requests[1].body instanceof FormData);assert.equal(x.requests[1].headers['Content-Type'],undefined);
});
test('Import diagnostics use a fixed program, explicit environment and clean up on startup failure',async t=>{
 const x=h(t,[{id:'temp'},{id:'temp',params:{}},null,new Response(JSON.stringify({errorType:'ModuleNotFoundError',message:'Missing jsonschema'}),{status:500}),null]);
 const response=await x.call('validate_code_environment_imports',{...p,env_name:'py',modules:['jsonschema']});assert.equal(response.isError,true);const d=JSON.parse(response.content[0].text);assert.equal(d.cleanup_complete,true);assert.equal(d.error.type,'ModuleNotFoundError');assert.match(x.requests[2].body.params.code,/importlib.import_module/);assert.deepEqual(x.requests[2].body.params.codeEnvSelection,{envMode:'EXPLICIT_ENV',envName:'py'});assert.equal(x.requests.at(-1).method,'DELETE');assert.equal((await x.call('validate_code_environment_imports',{...p,env_name:'py',modules:['os;evil()']})).isError,true);
});
test('Tool names are unique and variable/code/schema secrets receive distinct handling',()=>{
 assert.equal(new Set(operationTools.map(t=>t.name)).size,operationTools.length);
 assert.deepEqual(sanitize({apiKey:'hidden',usage:{inputTokens:12}}),{apiKey:'[REDACTED]',usage:{inputTokens:12}});
});

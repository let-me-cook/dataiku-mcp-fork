import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DataikuClient} from '../dist/dataiku-client.js';
import {callOperation} from '../dist/operations-tools.js';
import {revision} from '../dist/operations-client.js';
const p={project_key:'P'};
const settings={name:'d',type:'PostgreSQL',managed:false,params:{connection:'pg',schema:'public',table:'documents',mode:'table'},schema:{columns:[]},tags:['keep']};
const args={...p,dataset_name:'d',dataset_type:'PostgreSQL',params:settings.params};
const schema={columns:[{name:'id',type:'bigint'}]};
function harness(t,replies) {
 const requests=[];t.mock.method(globalThis,'fetch',async(url,o)=>{requests.push({url:String(url),...o,body:o.body===undefined?undefined:JSON.parse(o.body)});assert.ok(replies.length,'Unexpected request');const r=replies.shift();return r instanceof Response?r:new Response(r===null?null:JSON.stringify(r),{status:r===null?204:200});});
 t.after(()=>assert.equal(replies.length,0));const c=new DataikuClient({host:'https://dss.example',apiKey:'test-secret'});
 return {c,requests,call:async(n,a)=>{const r=await callOperation(c.operations,n,a);return {...JSON.parse(r.content[0].text),isError:r.isError??false};}};
}
test('Dataset creation includes projectKey and SDK format fields, then verifies external settings',async t=>{
 const h=harness(t,[[],{},settings]);const d=await h.call('create_dataset',args);
 assert.equal(d.isError,false);assert.equal(d.verified,true);assert.equal(d.managed,false);
 assert.deepEqual(h.requests[1].body,{name:'d',projectKey:'P',type:'PostgreSQL',params:settings.params,formatType:null,formatParams:{},managed:false});
 assert.equal(h.requests[2].method,'GET');assert.equal(d.dataset_built,false);
});
test('Legacy DataikuClient creation delegates to the corrected SDK contract',async t=>{
 const h=harness(t,[[],{},settings]);await h.c.createDataset('P','d','PostgreSQL',settings.params);
 assert.equal(h.requests[1].body.projectKey,'P');
});
test('Dataset dry runs, collisions and mismatching reuse never write',async t=>{
 const h=harness(t,[[],[{name:'d'}],[{name:'d'}],{...settings,managed:true}]);
 assert.equal((await h.call('create_dataset',{...args,dry_run:true})).created,false);
 assert.equal((await h.call('create_dataset',args)).isError,true);
 assert.equal((await h.call('create_dataset',{...args,if_exists:'reuse'})).isError,true);
 assert.ok(h.requests.every(r=>r.method==='GET'));
});
test('Ignored managed flag is explicitly configured and verified without building',async t=>{
 const initial={...settings,managed:true};const h=harness(t,[[],{},initial,initial,initial,null,settings]);
 const d=await h.call('create_dataset',args);assert.equal(d.verified,true);
 assert.equal(h.requests[5].body.managed,false);assert.deepEqual(h.requests[5].body.tags,['keep']);
 assert.ok(!h.requests.some(r=>r.url.includes('/jobs')||r.url.includes('/sql/')));
});
test('Creation verification failure identifies partial state and never deletes',async t=>{
 const h=harness(t,[[],{}, {...settings,type:'Wrong'}]);const d=await h.call('create_dataset',args);
 assert.equal(d.isError,true);assert.equal(d.created,true);assert.equal(d.verified,false);assert.equal(d.dataset_name,'d');
 assert.ok(!h.requests.some(r=>r.method==='DELETE'));
});
test('External PostgreSQL helper detects and saves columns preserving external flag and other settings',async t=>{
 const saved={...settings,schema};const h=harness(t,[[],{},settings,settings,{schemaDetection:{newSchema:schema}},settings,settings,null,saved,saved]);
 const d=await h.call('create_external_postgresql_dataset',{...p,dataset_name:'d',connection_name:'pg',schema_name:'public',table_name:'documents'});
 assert.equal(d.verified,true);assert.equal(d.schema_columns,1);assert.equal(d.managed,false);
 assert.ok(h.requests[4].url.endsWith('/actions/testAndDetectSettings/externalSQL'));assert.equal(h.requests[7].body.managed,false);assert.deepEqual(h.requests[7].body.tags,['keep']);
});
test('Schema detection previews without saving and rejects concurrent changes on save',async t=>{
 const detection={schemaDetection:{newSchema:schema}};
 const h=harness(t,[settings,detection,settings,detection,{...settings,tags:['changed']}]);
 const preview=await h.call('autodetect_dataset_schema',{...p,dataset_name:'d'});assert.equal(preview.saved,false);assert.equal(preview.column_count,1);
 const failed=await h.call('autodetect_dataset_schema',{...p,dataset_name:'d',save:true,expected_hash:revision(settings).sha256});assert.equal(failed.isError,true);
 assert.ok(!h.requests.some(r=>r.method==='PUT'));
});
test('Invalid autodetection does not save or claim success',async t=>{
 const h=harness(t,[settings,{schemaDetection:{newSchema:{columns:[]}}}]);
 assert.equal((await h.call('autodetect_dataset_schema',{...p,dataset_name:'d',save:true})).isError,true);
 assert.ok(!h.requests.some(r=>r.method==='PUT'));
});
const folder={id:'folder1',name:'Uploads',type:'Filesystem',params:{connection:'files',path:'/${projectKey}/${odbId}'}};
test('Managed-folder creation uses existing connection, SDK path and verifies returned identity',async t=>{
 const h=harness(t,[[],['files'],{id:'folder1'},folder]);const d=await h.call('create_managed_folder',{...p,name:'Uploads',connection_name:'files'});
 assert.equal(d.verified,true);assert.equal(d.folder_id,'folder1');
 assert.deepEqual(h.requests[2].body,{name:'Uploads',projectKey:'P',type:null,params:folder.params});
 assert.ok(h.requests[1].url.endsWith('/connections/get-names?type=all'));
});
test('Managed-folder collision, missing connection, and verified reuse do not create duplicates',async t=>{
 const h=harness(t,[[folder],[],['other'],[folder],folder]);
 const a={...p,name:'Uploads',connection_name:'files'};
 assert.equal((await h.call('create_managed_folder',a)).isError,true);
 assert.equal((await h.call('create_managed_folder',a)).isError,true);
 const reused=await h.call('create_managed_folder',{...a,if_exists:'reuse'});assert.equal(reused.reused,true);assert.equal(reused.created,false);
 assert.ok(h.requests.every(r=>r.method==='GET'));
});
test('Folder read-back mismatch reports allocated folder ID for recovery',async t=>{
 const h=harness(t,[[],['files'],{id:'folder1'},{...folder,params:{connection:'wrong'}}]);
 const d=await h.call('create_managed_folder',{...p,name:'Uploads',connection_name:'files'});
 assert.equal(d.isError,true);assert.equal(d.folder_id,'folder1');assert.equal(d.created,true);assert.equal(d.verified,false);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DataikuClient} from '../dist/dataiku-client.js';
import {callOperation} from '../dist/operations-tools.js';

const p={project_key:'P'};
function harness(t,replies) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests.push({url:String(url),...options,body:options.headers['Content-Type']==='application/json'?JSON.parse(options.body):options.body});
    assert.ok(replies.length,'Unexpected HTTP call');
    const r=replies.shift();
    return r instanceof Response?r:new Response(r===null?null:JSON.stringify(r),{status:r===null?204:200});
  });
  t.after(()=>assert.equal(replies.length,0));
  const c=new DataikuClient({host:'https://dss.example',apiKey:'test-secret'});
  return {requests,call:async(name,args)=>{const r=await callOperation(c.operations,name,args);return {...JSON.parse(r.content[0].text),isError:r.isError??false};}};
}
test('Library creation uses tree, avoids missing-file GET, writes raw content and verifies hash',async t=>{
  const h=harness(t,[[{name:'python',children:[]}],null,{data:'print(1)'}]);
  const d=await h.call('write_project_library_file',{...p,path:'python/new.py',mode:'create',content:'print(1)'});
  assert.equal(d.isError,false);assert.equal(d.verified,true);
  assert.ok(h.requests[0].url.endsWith('/libraries/contents'));
  assert.equal(h.requests[1].method,'POST');assert.equal(h.requests[1].body,'print(1)');
});
test('Library creation preserves existing files, refuses absent parents and propagates access errors',async t=>{
  const h=harness(t,[[{name:'python',children:[{name:'old.py'}]}],[{name:'python',children:[]}],new Response('{"message":"Denied"}',{status:403})]);
  for(const path of ['python/old.py','python/missing/new.py','python/new.py']) {
    assert.equal((await h.call('write_project_library_file',{...p,path,mode:'create',content:'x'})).isError,true);
  }
  assert.ok(h.requests.every(r=>r.method==='GET'));
});
test('Library dry run makes no writes and persistence mismatch does not claim success',async t=>{
  const tree=[{name:'python',children:[]}];
  const h=harness(t,[tree,tree,null,{data:'different'}]);
  assert.equal((await h.call('write_project_library_file',{...p,path:'python/new.py',mode:'create',content:'x',dry_run:true})).updated,false);
  const d=await h.call('write_project_library_file',{...p,path:'python/new.py',mode:'create',content:'x'});
  assert.equal(d.isError,true);assert.equal(d.updated,true);assert.equal(d.verified,false);
});
test('Zone read-back distinguishes persisted coordinates from ignored layout changes',async t=>{
  const old={id:'z',items:[{objectId:'x'}],position:{x:0,y:0,width:100,height:100}};
  const position={x:10,y:20,width:100,height:100};
  const h=harness(t,[old,old,null,{...old,position},old,old,null,old,old]);
  const args={...p,zone_id:'z',patch:{position}};
  const ok=await h.call('update_flow_zone',args);assert.equal(ok.persistence_verified,true);assert.deepEqual(ok.saved_position,position);
  assert.deepEqual(h.requests[2].body.items,old.items);
  const fail=await h.call('update_flow_zone',args);assert.equal(fail.isError,true);assert.equal(fail.persistence_verified,false);assert.deepEqual(fail.mismatched_fields,['position']);
  const dry=await h.call('update_flow_zone',{...args,dry_run:true});assert.equal(dry.updated,false);assert.equal(dry.persistence_verified,false);
});
test('Zone successful PUT followed by failed read-back reports uncertain persistence',async t=>{
  const old={id:'z',name:'Old'};
  const h=harness(t,[old,old,null,new Response('{}',{status:500})]);
  const d=await h.call('update_flow_zone',{...p,zone_id:'z',patch:{name:'New'}});
  assert.equal(d.isError,true);assert.equal(d.updated,true);assert.equal(d.persistence_verified,false);
});
test('PostgreSQL inspection uses fixed catalog SQL, safe literals and stream verification',async t=>{
  const table="odd'; DROP TABLE users;--";
  const settings={type:'PostgreSQL',params:{mode:'table',connection:'pg',schema:'public',table}};
  const inspected={schema:'public',table,columns:[{name:'id'}],constraints:[{name:'pk',kind:'p',columns:['id']}]};
  const cell='"'+JSON.stringify(inspected).replaceAll('"','""')+'"\n';
  const h=harness(t,[settings,{queryId:'q'},new Response(cell),null]);
  const d=await h.call('inspect_database_table',{...p,dataset_name:'metadata'});
  assert.equal(d.isError,false);assert.equal(d.table_found,true);assert.deepEqual(d.primary_key,['id']);
  const body=h.requests[1].body;assert.ok(!body.query.includes('DROP TABLE'));assert.ok(body.query.includes(Buffer.from(table).toString('hex')));
  assert.deepEqual(body.preQueries,[]);assert.deepEqual(body.postQueries,[]);assert.equal(body.projectKey,'P');
  assert.ok(h.requests.at(-1).url.endsWith('/finish-streaming'));
});
test('Inspection reports unresolved templates and unsupported backends without guessing keys',async t=>{
  const h=harness(t,[{type:'PostgreSQL',params:{mode:'table',schema:'public',table:'${unresolved}_metadata'}},{type:'Filesystem'}]);
  for(let i=0;i<2;i++) {const d=await h.call('inspect_database_table',{...p,dataset_name:'metadata'});assert.equal(d.database_inspected,false);assert.equal(d.primary_key,null);}
  assert.equal(h.requests.length,2);
});
test('Table discovery is bounded, encodes filters and verifies query completion',async t=>{
  const settings={type:'PostgreSQL',params:{connection:'pg',schema:'public',table:'${projectKey}_docs'}};
  const encode=v=>'"'+JSON.stringify(v).replaceAll('"','""')+'"\n';
  const h=harness(t,[settings,{queryId:'q'},new Response(encode({schema:'public',table:'a'})+encode({schema:'public',table:'b'})),null]);
  const d=await h.call('list_database_tables',{...p,dataset_name:'docs',table_prefix:"x' OR 1=1--",limit:1});
  assert.equal(d.tables.length,1);assert.equal(d.truncated,true);
  assert.ok(h.requests[1].body.query.includes('LIMIT 2'));assert.ok(!h.requests[1].body.query.includes('OR 1=1'));
  assert.ok(h.requests.at(-1).url.endsWith('/finish-streaming'));
});
test('Table resolution expands projectKey but never silently folds case or substitutes another relation',async t=>{
  const settings={type:'PostgreSQL',params:{connection:'pg',schema:'public',table:'${projectKey}_docs',mode:'table'}};
  const h=harness(t,[settings,{queryId:'q'},new Response(''),null]);
  const d=await h.call('inspect_database_table',{...p,dataset_name:'docs'});
  assert.equal(d.table_found,false);assert.equal(d.primary_key,null);
  assert.equal(d.inspected_target.table,'P_docs');
  assert.ok(h.requests[1].body.query.includes(Buffer.from('P_docs').toString('hex')));
});
const outcomes={dataset_name:'outcomes',run_column:'run',document_column:'doc',status_column:'status',output_count_column:'count'};
const schema={columns:['run','doc','status','count'].map(name=>({name,type:'string'}))};
const done={baseStatus:{state:'DONE'}};
test('DONE without per-file evidence produces unknown extraction counts',async t=>{
  const h=harness(t,[done]);const d=await h.call('get_extraction_outcome_summary',{...p,job_id:'j'});
  assert.equal(d.job_success,true);assert.equal(d.extraction_success,null);assert.equal(d.counts,null);
});
test('Outcome summary counts success, failure, skip, outputs and excludes other runs despite DONE',async t=>{
  const h=harness(t,[done,schema,new Response('j\ta\tSUCCEEDED\t3\nj\tb\tFAILED\t0\nj\tc\tSKIPPED\t0\nold\tx\tSUCCEEDED\t999\n')]);
  const d=await h.call('get_extraction_outcome_summary',{...p,job_id:'j',outcomes});
  assert.equal(d.counts_complete,true);assert.equal(d.extraction_success,false);assert.equal(d.manifest_coverage_verified,false);
  assert.deepEqual(d.counts,{files_attempted:2,files_succeeded:1,files_skipped:1,files_failed:1,files_pending:0,files_unknown:0,output_rows:3});
});
test('Duplicate, truncated and invalid-count manifests never establish success',async t=>{
  const h=harness(t,[done,schema,new Response('j\ta\tSUCCEEDED\t3\nj\ta\tSUCCEEDED\t3\n'),done,schema,new Response('j\ta\tSUCCEEDED\t3\nj\tb\tSUCCEEDED\t2\n'),done,schema,new Response('j\ta\tSUCCEEDED\tnan\n')]);
  for(const extra of [{},{max_scan_rows:1},{}]) {
    const d=await h.call('get_extraction_outcome_summary',{...p,job_id:'j',outcomes,...extra});
    assert.equal(d.extraction_success,null);assert.equal(d.counts,null);assert.equal(d.counts_complete,false);
  }
});
test('Empty run manifest and pending outcomes do not imply completed extraction',async t=>{
  const h=harness(t,[done,schema,new Response('old\ta\tSUCCEEDED\t3\n'),done,schema,new Response('j\ta\tPENDING\t0\n')]);
  for(let i=0;i<2;i++) {const d=await h.call('get_extraction_outcome_summary',{...p,job_id:'j',outcomes});assert.equal(d.counts_complete,false);assert.equal(d.extraction_success,null);}
});
test('Explicit ingestion run identity is supported without claiming verified job linkage',async t=>{
  const h=harness(t,[done,schema,new Response('batch-1\ta\tSUCCEEDED\t3\nother\tb\tFAILED\t0\n')]);
  const d=await h.call('get_extraction_outcome_summary',{...p,job_id:'j',outcomes:{...outcomes,run_value:'batch-1'}});
  assert.equal(d.counts.files_succeeded,1);assert.equal(d.counts.files_failed,0);
  assert.equal(d.run_value,'batch-1');assert.equal(d.job_to_manifest_linkage_verified,false);
});

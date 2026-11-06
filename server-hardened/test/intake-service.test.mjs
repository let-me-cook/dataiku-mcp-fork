import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rm} from 'node:fs/promises';
import {IntakeService,INTAKE_CONTRACT} from '../dist/intake-service.js';
import {storeArtifact} from '../dist/artifacts.js';
import {DataikuClient} from '../dist/dataiku-client.js';
import {callOperation} from '../dist/operations-tools.js';
const caps={contract:INTAKE_CONTRACT,registration:{durable_idempotency:true,recoverable_partial_failures:true,stable_document_id:true},metadata:{parameterized:true,atomic_expected_version:true,key_scoped:true}};
const config={url:'https://intake.example/api/',token:'intake-test-secret',projects:'P'};
function harness(t,replies) {
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,o)=>{requests.push({url:String(url),...o});assert.ok(replies.length,'Unexpected request');const r=replies.shift();if(r instanceof Error)throw r;return r instanceof Response?r:new Response(JSON.stringify(r));});
 t.after(()=>assert.equal(replies.length,0));return {service:new IntakeService(config),requests};
}
test('Intake adapter is explicitly unavailable without configuration and refuses unsafe URLs',async t=>{
 const h=harness(t,[]);const unavailable=new IntakeService({});
 assert.equal((await unavailable.capabilities('P')).configured,false);
 await assert.rejects(()=>unavailable.register({project_key:'P'}),/Configure DSS_INTAKE/);
 await assert.rejects(()=>h.service.rows({project_key:'OTHER'},false),/not allowed/);
 for(const url of ['http://intake.example','https://u:p@intake.example','https://intake.example/?key=x','file:///tmp/']) assert.throws(()=>new IntakeService({...config,url}));
});
test('Registration preserves stable identity across replay, verifies bytes and uses separate bearer credentials',async t=>{
 const artifact=await storeArtifact(Buffer.from('document'),'application/pdf');t.after(()=>rm(artifact.local_path));
 const receipt={contract:INTAKE_CONTRACT,project_key:'P',idempotency_key:'upload-1',sha256:artifact.sha256,document_id:'doc-stable',state:'COMMITTED',replayed:false};
 const h=harness(t,[caps,receipt,caps,{...receipt,replayed:true}]);
 const args={project_key:'P',artifact_id:artifact.artifact_id,sha256:artifact.sha256,idempotency_key:'upload-1',filename:'document.pdf',metadata:{division:'company_wide'}};
 const first=await h.service.register(args),second=await h.service.register(args);
 assert.equal(first.document_id,second.document_id);assert.equal(second.replayed,true);assert.equal(first.committed,true);
 const request=h.requests[1];assert.equal(request.url,'https://intake.example/api/documents/register');assert.equal(request.headers.Authorization,'Bearer intake-test-secret');
 assert.ok(request.body instanceof FormData);assert.equal(await request.body.get('file').text(),'document');
 assert.equal(JSON.parse(request.body.get('request')).idempotency_key,'upload-1');
});
test('Registration refuses checksum mismatch before upload and missing backend consistency guarantees',async t=>{
 const artifact=await storeArtifact(Buffer.from('document'),'application/pdf');t.after(()=>rm(artifact.local_path));
 const h=harness(t,[caps,{contract:INTAKE_CONTRACT,registration:{}}]);
 await assert.rejects(()=>h.service.register({project_key:'P',artifact_id:artifact.artifact_id,sha256:'0'.repeat(64)}),/checksum/);
 await assert.rejects(()=>h.service.register({project_key:'P'}),/guarantees/);
 assert.ok(h.requests.every(r=>r.method==='GET'));
});
test('Pending registration does not claim commit and invalid receipt cannot masquerade as success',async t=>{
 const artifact=await storeArtifact(Buffer.from('document'),'application/pdf');t.after(()=>rm(artifact.local_path));
 const receipt={contract:INTAKE_CONTRACT,project_key:'P',idempotency_key:'upload-1',sha256:artifact.sha256,document_id:'doc-stable',state:'PENDING',replayed:false};
 const h=harness(t,[caps,receipt,caps,{...receipt,sha256:'bad'}]);
 const args={project_key:'P',artifact_id:artifact.artifact_id,sha256:artifact.sha256,idempotency_key:'upload-1',filename:'document.pdf',metadata:{kind:'pdf'}};
 const d=await h.service.register(args);assert.equal(d.committed,false);
 await assert.rejects(()=>h.service.register(args),e=>e.details?.type==='IntakeContractError');
});
test('Metadata requests preserve explicit keys, null create version, expected update version and patch semantics',async t=>{
 const base={contract:INTAKE_CONTRACT,project_key:'P',registry:'documents',found:true,row:{id:1,name:'Doc',password:'hidden'},version:3};
 const h=harness(t,[caps,base,caps,{...base,version:4,state:'COMMITTED',idempotency_key:'change-1',replayed:false},caps,{...base,version:1,state:'COMMITTED',idempotency_key:'create-1',replayed:false}]);
 const a={project_key:'P',registry:'documents',keys:{id:1}};
 const read=await h.service.rows(a,false);assert.equal(read.version,3);assert.equal(read.row.password,'[REDACTED]');
 await h.service.rows({...a,values:{name:'Doc'},expected_version:3,idempotency_key:'change-1'},true);
 const body=JSON.parse(h.requests[3].body);assert.deepEqual(body.keys,{id:1});assert.deepEqual(body.values,{name:'Doc'});assert.equal(body.expected_version,3);
 await h.service.rows({...a,values:{name:'Doc'},expected_version:null,idempotency_key:'create-1'},true);
 assert.equal(JSON.parse(h.requests[5].body).expected_version,null);
});
test('Metadata conflicts and transport failures do not retry or disclose backend credentials',async t=>{
 const h=harness(t,[caps,new Response(JSON.stringify({errorType:'VersionConflict',message:'Conflict token=intake-test-secret'}),{status:409}),caps,new DOMException('timed out','TimeoutError')]);
 const a={project_key:'P',registry:'documents',keys:{id:1},values:{name:'Doc'},expected_version:1,idempotency_key:'change-1'};
 await assert.rejects(()=>h.service.rows(a,true),e=>e.details.status===409&&!JSON.stringify(e.details).includes('intake-test-secret'));
 await assert.rejects(()=>h.service.rows(a,true),e=>e.details.idempotency_key==='change-1'&&e.details.operation_outcome==='not_confirmed');
 assert.equal(h.requests.length,4);
});
test('Wrong metadata key and undeclared service contract cannot produce a successful receipt',async t=>{
 const h=harness(t,[caps,{contract:INTAKE_CONTRACT,project_key:'P',registry:'docs',found:true,row:{id:2},version:1},{contract:'other'}]);
 await assert.rejects(()=>h.service.rows({project_key:'P',registry:'docs',keys:{id:1}},false),/matching keyed row/);
 await assert.rejects(()=>h.service.capabilities('P'),/contract mismatch/);
});
test('MCP schemas reject unversioned updates, empty keys, raw SQL fields and unsafe filenames before HTTP',async t=>{
 const h=harness(t,[]);const c=new DataikuClient({host:'https://dss.example',apiKey:'dss-secret'});
 for(const args of [
  {project_key:'P',registry:'docs',keys:{id:1},values:{name:'x'},idempotency_key:'k'},
  {project_key:'P',registry:'docs',keys:{},values:{name:'x'},expected_version:null,idempotency_key:'k'},
  {project_key:'P',registry:'docs',keys:{id:1},values:{name:'x'},expected_version:null,idempotency_key:'k',sql:'DROP TABLE x'},
 ]) assert.equal((await callOperation(c.operations,'upsert_metadata_row',args)).isError,true);
 for(const filename of ['../a.pdf','a/b.pdf','a\\b.pdf','bad\nfile']) {
  assert.equal((await callOperation(c.operations,'register_document_upload',{project_key:'P',artifact_id:'id',sha256:'a'.repeat(64),idempotency_key:'k',filename,metadata:{name:'x'}})).isError,true);
 }
 assert.equal(h.requests.length,0);
});

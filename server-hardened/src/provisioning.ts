import { OperationsClient, base, seg, revision, stable, checkRevision } from './operations-client.js';
import { errorDetails } from './http-client.js';

function contains(actual: any, expected: any): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual != null && Object.entries(expected).every(([key,value])=>contains(actual[key],value));
  }
  return stable(actual??null)===stable(expected??null);
}
function partial(error: unknown, identity: object, stage: string) {
  return {...identity,verified:false,stage,error:errorDetails(error),
    recovery:'Inspect the identified DSS object before retrying. No automatic deletion, rebuild, or rollback was attempted.'};
}

export async function createDataset(c: OperationsClient, a: any) {
  if(a.autodetect_schema && (a.dataset_type!=='PostgreSQL' || a.params?.mode!=='table')) throw new Error('Autodetection supports PostgreSQL table-mode datasets only');
  const collection=`${base(a.project_key)}/datasets/`;
  const path=`${collection}${seg(a.dataset_name)}`;
  const managed=a.managed??false;
  const list=(await c.http.get(collection)).data;
  if (!Array.isArray(list)) throw new Error('Unexpected dataset listing');
  const existing=list.filter((d:any)=>d.name===a.dataset_name);
  if(existing.length) {
    if(a.if_exists!=='reuse') throw new Error('Dataset already exists; creation does not overwrite existing objects');
    const saved=(await c.http.get(path)).data;
    if(saved.name!==a.dataset_name || saved.type!==a.dataset_type || saved.managed!==managed || !contains(saved.params,a.params) ||
      (a.format_type!==undefined && saved.formatType!==a.format_type) || (a.format_params!==undefined&&!contains(saved.formatParams,a.format_params)) ||
      (a.autodetect_schema && !saved.schema?.columns?.length)) throw new Error('Existing dataset does not match requested settings; inspect it before reusing');
    return {created:false,reused:true,verified:true,dataset_name:a.dataset_name,project_key:a.project_key,settings:saved,revision:revision(saved)};
  }
  const payload={name:a.dataset_name,projectKey:a.project_key,type:a.dataset_type,params:a.params,
    formatType:a.format_type??null,formatParams:a.format_params??{},managed};
  if(a.dry_run) return {created:false,dry_run:true,verified:false,proposed:payload,validation:'Local schema and name-collision checks only; no database connectivity or permission test'};
  let stage='create';
  try {
    await c.http.post(collection,payload);
    stage='configure-managed-state';
    let saved=(await c.http.get(path)).data;
    // SDK creation does not expose managed as an argument. Explicitly save it in settings if DSS ignored it.
    if(saved.managed!==managed) {
      await c.patch(path,{managed},{expected_hash:revision(saved).sha256});
      saved=(await c.http.get(path)).data;
    }
    stage='verify-settings';
    if(saved.name!==a.dataset_name || saved.type!==a.dataset_type || saved.managed!==managed || !contains(saved.params,a.params) ||
      (a.format_type!==undefined&&saved.formatType!==a.format_type) || (a.format_params!==undefined&&!contains(saved.formatParams,a.format_params))) throw new Error('Saved dataset definition does not match requested settings');
    if(a.autodetect_schema) {
      stage='autodetect-schema';
      const detected=await autodetectSchema(c,{project_key:a.project_key,dataset_name:a.dataset_name,save:true,expected_hash:revision(saved).sha256});
      if('error' in detected) return {...detected,created:true,stage};
      saved=(await c.http.get(path)).data;
      if(saved.name!==a.dataset_name || saved.type!==a.dataset_type || saved.managed!==managed || !contains(saved.params,a.params)) throw new Error('Dataset settings changed during schema detection');
    }
    return {created:true,verified:true,project_key:a.project_key,dataset_name:a.dataset_name,managed:saved.managed,settings:saved,
      schema_columns:saved.schema?.columns?.length??0,revision:revision(saved),database_ddl_executed:false,dataset_built:false};
  } catch(e) {return partial(e,{project_key:a.project_key,dataset_name:a.dataset_name,created:stage==='create'?null:true},stage);}
}

export async function createFolder(c: OperationsClient, a: any) {
  const collection=`${base(a.project_key)}/managedfolders/`;
  const folders=(await c.http.get(collection)).data;
  if(!Array.isArray(folders)) throw new Error('Unexpected managed-folder listing');
  const matches=folders.filter((f:any)=>f.name===a.name);
  const verify=(d:any)=>d.name===a.name && d.params?.connection===a.connection_name && (a.folder_type===undefined || d.type===a.folder_type);
  if(matches.length) {
    if(a.if_exists!=='reuse' || matches.length!==1) throw new Error('Managed-folder name collision; no existing folder was changed');
    const saved=(await c.http.get(`${collection}${seg(matches[0].id)}`)).data;
    if(!verify(saved)) throw new Error('Existing managed folder has different storage settings');
    return {created:false,reused:true,verified:true,project_key:a.project_key,folder_id:matches[0].id,settings:saved};
  }
  const connections=(await c.http.get('/connections/get-names',{params:{type:'all'}})).data;
  if(!Array.isArray(connections)||!connections.includes(a.connection_name)) throw new Error('Storage connection is not visible among existing DSS connections');
  const payload={name:a.name,projectKey:a.project_key,type:a.folder_type??null,params:{connection:a.connection_name,path:'/${projectKey}/${odbId}'}};
  if(a.dry_run) return {created:false,dry_run:true,verified:false,proposed:payload,validation:'Existing connection and name checked; DSS storage compatibility is checked only during creation'};
  let id:string|undefined;
  try {
    const created=(await c.http.post(collection,payload)).data;
    id=created?.id;
    if(typeof id!=='string'||!id) throw new Error('Creation response did not identify a managed folder');
    const saved=(await c.http.get(`${collection}${seg(id)}`)).data;
    if(!verify(saved) || (saved.id!==undefined&&saved.id!==id)) throw new Error('Managed-folder read-back does not match requested storage settings');
    return {created:true,verified:true,folder_id:id,project_key:a.project_key,settings:saved};
  } catch(e) {return partial(e,{project_key:a.project_key,name:a.name,folder_id:id??null,created:id?true:null},'create-or-verify-folder');}
}

export async function autodetectSchema(c: OperationsClient, a: any) {
  const path=`${base(a.project_key)}/datasets/${seg(a.dataset_name)}`;
  const current=(await c.http.get(path)).data;
  checkRevision(current,a);
  if(current.type!=='PostgreSQL' || current.params?.mode!=='table') throw new Error('Schema autodetection currently supports PostgreSQL table-mode datasets only');
  const detected=(await c.http.post(`${path}/actions/testAndDetectSettings/externalSQL`)).data;
  const schema=detected?.schemaDetection?.newSchema;
  if(!schema || !Array.isArray(schema.columns) || !schema.columns.length ||
    schema.columns.some((col:any)=>typeof col.name!=='string'||!col.name||typeof col.type!=='string'||!col.type) ||
    new Set(schema.columns.map((col:any)=>col.name)).size!==schema.columns.length) throw new Error('DSS schema detection did not return a valid nonempty schema');
  const result={project_key:a.project_key,dataset_name:a.dataset_name,schema,before:revision(current),column_count:schema.columns.length};
  if(!a.save) return {...result,saved:false,verified:false,preview:true};
  try {
    // Reject settings changes while detection ran. Keep all non-schema fields intact.
    await c.patch(path,{schema},{expected_hash:revision(current).sha256},(settings,patch)=>({...settings,schema:patch.schema}));
    const saved=(await c.http.get(path)).data;
    if(stable(saved.schema)!==stable(schema)) throw new Error('Saved schema differs from detected schema');
    return {...result,saved:true,verified:true,revision:revision(saved),database_ddl_executed:false,dataset_built:false};
  } catch(e) {return {...result,...partial(e,{saved:null},'save-or-verify-schema')};}
}

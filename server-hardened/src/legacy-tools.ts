import { DssError } from './http-client.js';
import type { DataikuClient } from './dataiku-client.js';
import { def, id, arr, obj, fields, type OperationDefinition } from './tool-def.js';
type C=DataikuClient;
const p={project_key:id('Project key')};
const ds={...p,dataset_name:id('Dataset name')};const rec={...p,recipe_name:id('Recipe name')};const sc={...p,scenario_id:id('Scenario ID')};
const opt=(description:string)=>({type:'string',minLength:1,maxLength:1024,description});
const count=(max:number,def:number,description:string)=>({type:'integer',minimum:1,maximum:max,default:def,description});
const flag=(description:string,dflt=false)=>({type:'boolean',default:dflt,description});
const filtered=(rows:any[],a:any,typeField:string,typeValue:any)=>{
  let out=rows;
  if(typeValue)out=out.filter((x:any)=>x[typeField]===typeValue);
  if(a.search){const s=String(a.search).toLowerCase();out=out.filter((x:any)=>x.name?.toLowerCase().includes(s));}
  return a.simple?out.map((x:any)=>({name:x.name,projectKey:x.projectKey,type:x.type})):out;
};
const output=fields({name:id('Existing output dataset name')},['name']);
const d=(name:string,description:string,properties:Record<string,object>,required:string[],run:OperationDefinition<C>['run'],readOnly=true)=>def<C>(name,description,properties,required,run,readOnly);
export const legacyDefinitions:OperationDefinition<C>[]=[
 d('create_recipe','Create a recipe from existing input and output datasets, with the code as its payload. Does not create output datasets or run the recipe. Python recipes must have one output and at most 1,000 lines. Native recipes may need settings added afterwards with update_recipe.',{...rec,recipe_type:id('Recipe type, such as python, sql or join'),inputs:arr(id('Input dataset name')),outputs:arr(output),code:{type:'string',maxLength:1048576,description:'Optional recipe code'}},['project_key','recipe_type','recipe_name','inputs','outputs'],(c,a)=>{if(a.recipe_type==='python'){if(a.outputs.length!==1)throw new Error('Python recipes require exactly one output');if(typeof a.code==='string'&&a.code.split(/\r\n|\n|\r/).length>1000)throw new Error('Python recipes must have at most 1,000 lines including comments and blanks');}return c.createRecipe(a.project_key,{name:a.recipe_name,type:a.recipe_type,inputs:a.inputs,outputs:a.outputs,code:a.code});},false),
 d('delete_recipe','Delete one recipe. Does not delete its input or output datasets.',rec,['project_key','recipe_name'],(c,a)=>c.deleteRecipe(a.project_key,a.recipe_name),false),
 d('delete_dataset','Delete a dataset definition. Underlying data is kept unless drop_data is true.',{...ds,drop_data:flag('Also drop the underlying data')},['project_key','dataset_name'],(c,a)=>c.deleteDataset(a.project_key,a.dataset_name,a.drop_data??false),false),
 d('inspect_dataset_schema','Read a dataset schema. Does not read rows.',ds,['project_key','dataset_name'],(c,a)=>c.getDatasetSchema(a.project_key,a.dataset_name)),
 d('check_dataset_metrics','Read the latest stored dataset metrics. Does not recompute them.',ds,['project_key','dataset_name'],(c,a)=>c.getDatasetMetrics(a.project_key,a.dataset_name)),
 d('create_scenario','Create a scenario. Does not run it or add triggers.',{...p,scenario_name:id('Scenario name'),scenario_type:{type:'string',enum:['step_based','custom_python']},definition:obj('Optional scenario definition')},['project_key','scenario_name','scenario_type'],(c,a)=>c.createScenario(a.project_key,{name:a.scenario_name,type:a.scenario_type,definition:a.definition}),false),
 d('delete_scenario','Delete one scenario. Does not affect datasets it built.',sc,['project_key','scenario_id'],(c,a)=>c.deleteScenario(a.project_key,a.scenario_id),false),
 d('run_scenario','Start a scenario manually and return without waiting for it to finish.',sc,['project_key','scenario_id'],(c,a)=>c.runScenario(a.project_key,a.scenario_id),false),
 d('get_recent_runs','Read recent jobs in a project, up to limit. The status filter applies client-side to the jobs DSS returns. Does not include scenario runs that started no job.',{...p,limit:count(500,50,'Most jobs to return'),status_filter:opt('Exact job state, such as FAILED')},['project_key'],async(c,a)=>{const rows=await c.getJobs(a.project_key);if(!Array.isArray(rows))return rows;const kept=a.status_filter?rows.filter((j:any)=>(j.baseStatus?.state??j.state)===a.status_filter):rows;return kept.slice(0,a.limit??50);}),
 d('list_projects','List the projects this API key can see. Does not read project contents.',{},[],c=>c.listProjects()),
 d('list_datasets','List datasets in a project. Type and name filters apply client-side.',{...p,dataset_type:opt('Exact dataset type'),search:opt('Name contains this text'),simple:flag('Return only name, projectKey and type')},['project_key'],async(c,a)=>filtered(await c.listDatasets(a.project_key),a,'type',a.dataset_type)),
 d('clear_dataset','Delete the data of a dataset or the listed partitions. Keeps the dataset definition.',{...ds,partition:opt('Optional partition')},['project_key','dataset_name'],(c,a)=>c.clearDataset(a.project_key,a.dataset_name,a.partition),false),
 d('list_recipes','List recipes in a project. Type and name filters apply client-side.',{...p,recipe_type:opt('Exact recipe type'),search:opt('Name contains this text'),simple:flag('Return only name, projectKey and type')},['project_key'],async(c,a)=>filtered(await c.listRecipes(a.project_key),a,'type',a.recipe_type)),
 d('list_scenarios','List scenarios in a project. Type and active filters apply client-side. Does not include run history.',{...p,scenario_type:opt('Exact scenario type'),active_only:flag('Only active scenarios')},['project_key'],async(c,a)=>{const rows=await c.listScenarios(a.project_key);return rows.filter((x:any)=>(!a.scenario_type||x.type===a.scenario_type)&&(!a.active_only||x.active===true));}),
 d('get_scenario_run_history','Read the last runs of a scenario, including unfinished ones unless only_finished is true. Does not start a run.',{...sc,limit:count(500,10,'Most runs to return'),only_finished:flag('Only finished runs')},['project_key','scenario_id'],(c,a)=>c.getScenarioRunHistory(a.project_key,a.scenario_id,a.limit??10,a.only_finished??false)),
 d('get_code_environments','List the instance code environments. May need admin rights. Does not show installed packages; use inspect_code_environment.',{},[],c=>c.getCodeEnvironments()),
 d('get_connections','List the instance data connections. May need admin rights. Secret-like fields are redacted. Does not test connections.',{},[],c=>c.getConnections()),
 d('cancel_running_jobs','Request an abort for each listed job and report each outcome. A failure on one job does not skip the others, and nothing is retried. Does not wait for jobs to stop.',{...p,job_ids:{...arr(id('Job ID'),50),minItems:1}},['project_key','job_ids'],async(c,a)=>{const results:any[]=[];for(const job_id of a.job_ids){try{await c.cancelJob(a.project_key,job_id);results.push({job_id,abort_requested:true});}catch(e){results.push({job_id,abort_requested:false,error:e instanceof DssError?e.details:{message:'Abort request failed'}});}}const failed=results.filter(r=>!r.abort_requested).length;return {results,failed,...(failed?{error:{type:'PartialFailure',message:`${failed} of ${results.length} abort requests failed`}}:{})};},false),
];

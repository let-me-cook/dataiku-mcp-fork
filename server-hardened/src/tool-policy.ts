import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export type InstanceType='design'|'automation';
export type Policy={instanceType:InstanceType;allowDestructive:boolean;cobuild:boolean};
// Environment switches are exact: anything other than the literal "true" leaves the guard on.
export function readPolicy(env:Record<string,string|undefined>=process.env):Policy{
  const raw=(env.DSS_INSTANCE_TYPE??'').trim()||'design';
  if(raw!=='design'&&raw!=='automation')throw new Error('DSS_INSTANCE_TYPE must be design or automation');
  return {instanceType:raw,allowDestructive:env.DSS_ALLOW_DESTRUCTIVE==='true',cobuild:env.DSS_ENABLE_COBUILD==='true'};
}
export const destructiveOptIn=new Set(['clear_dataset','delete_recipe','delete_dataset','delete_scenario','delete_agent','delete_agent_tool','batch_update_objects','duplicate_project_structure']);
export const cobuildTools=new Set(['start_cobuild_conversation','send_cobuild_message','answer_cobuild_confirmation']);
// Writes allowed on an automation node. Every other non-read-only tool is refused there, so a new write tool is denied until it is listed.
const automationWrites=new Set(['run_recipe','build_dataset','run_scenario','start_job','abort_job','cancel_running_jobs','run_agent','run_agent_tool','wake_up_agent','shutdown_agent']);
export function denial(tool:Tool,args:any,p:Policy):string|null{
  const n=tool.name;
  if(cobuildTools.has(n)&&!p.cobuild)return `${n} is disabled. Set DSS_ENABLE_COBUILD=true on a design instance to enable Cobuild tools.`;
  if(p.instanceType==='automation'&&tool.annotations?.readOnlyHint!==true&&!automationWrites.has(n))return `${n} is refused because DSS_INSTANCE_TYPE=automation. It changes project definitions; connect to a design instance instead.`;
  if(destructiveOptIn.has(n)&&!p.allowDestructive)return `${n} is refused. Set DSS_ALLOW_DESTRUCTIVE=true to allow destructive tools.`;
  if(n==='answer_cobuild_confirmation'&&args?.choice==='APPROVE'&&!p.allowDestructive)return 'Approving a Cobuild deletion is refused. Set DSS_ALLOW_DESTRUCTIVE=true to allow it, or answer CANCEL.';
  return null;
}
export function withPolicyNote(tool:Tool):Tool{
  if(!destructiveOptIn.has(tool.name))return tool;
  return {...tool,description:`${tool.description??''} Refused unless DSS_ALLOW_DESTRUCTIVE=true.`};
}

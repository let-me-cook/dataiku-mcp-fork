import type { Tool } from '@modelcontextprotocol/sdk/types.js';
export type InstanceType='design'|'automation';
export type Policy={instanceType:InstanceType;allowDestructive:boolean;intake:boolean};
// Environment switches are exact: anything other than the literal "true" leaves the guard on.
export function readPolicy(env:Record<string,string|undefined>=process.env):Policy{
  const raw=(env.DSS_INSTANCE_TYPE??'').trim()||'design';
  if(raw!=='design'&&raw!=='automation')throw new Error('DSS_INSTANCE_TYPE must be design or automation');
  return {instanceType:raw,allowDestructive:env.DSS_ALLOW_DESTRUCTIVE==='true',intake:Boolean(env.DSS_INTAKE_URL?.trim())};
}
export const destructiveOptIn=new Set(['clear_dataset','delete_recipe','delete_dataset','delete_scenario','delete_agent','delete_agent_tool']);
export const intakeTools=new Set(['get_intake_capabilities','register_document_upload','read_metadata_row','upsert_metadata_row']);
// Writes allowed on an automation node. Every other non-read-only tool is refused there, so a new write tool is denied until it is listed.
const automationWrites=new Set(['run_scenario','start_job','abort_job','cancel_running_jobs','run_agent','run_agent_tool','wake_up_agent','shutdown_agent']);
export function denial(tool:Tool,p:Policy):string|null{
  const n=tool.name;
  if(intakeTools.has(n)&&!p.intake)return `${n} is unavailable because DSS_INTAKE_URL is not set. See INTAKE-API.md.`;
  if(p.instanceType==='automation'&&tool.annotations?.readOnlyHint!==true&&!automationWrites.has(n))return `${n} is refused because DSS_INSTANCE_TYPE=automation. It changes project definitions; connect to a design instance instead.`;
  if(destructiveOptIn.has(n)&&!p.allowDestructive)return `${n} is refused. Set DSS_ALLOW_DESTRUCTIVE=true to allow destructive tools.`;
  return null;
}
export function withPolicyNote(tool:Tool):Tool{
  if(!destructiveOptIn.has(tool.name))return tool;
  return {...tool,description:`${tool.description??''} Refused unless DSS_ALLOW_DESTRUCTIVE=true.`};
}

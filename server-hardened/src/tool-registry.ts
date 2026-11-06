import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DataikuClient } from './dataiku-client.js';
import { errorDetails } from './http-client.js';
import { operationTools, isOperation, callOperation, textResult } from './operations-tools.js';
import { agentTools, callAgentTool, isAgentTool } from './agent-tools.js';
import { legacyDefinitions } from './legacy-tools.js';
import { usageRules, usageRulesTool, withUsageRules } from './usage-rules.js';
import { cobuildTools, denial, readPolicy, withPolicyNote, type Policy } from './tool-policy.js';
const validator=new AjvJsonSchemaValidator();
const legacy=new Map(legacyDefinitions.map(d=>[d.tool.name,{...d,validate:validator.getValidator(d.tool.inputSchema)}]));
// The complete catalog. A name defined earlier wins; duplicates are a build-time mistake caught by the tests.
export const allTools:Tool[]=[...operationTools,usageRulesTool,...agentTools,...legacyDefinitions.map(d=>d.tool)].map(withUsageRules).map(withPolicyNote);
const byName=new Map(allTools.map(t=>[t.name,t]));
export function listTools(policy:Policy=readPolicy()):Tool[]{return allTools.filter(t=>!cobuildTools.has(t.name)||(policy.cobuild&&policy.instanceType==='design'));}
export async function callTool(client:DataikuClient,name:string,args:unknown,policy:Policy=readPolicy()):Promise<CallToolResult>{
  const tool=byName.get(name);
  if(!tool)return textResult(client.operations,{error:{type:'ClientError',message:`Unknown tool: ${name}`}},true);
  const refused=denial(tool,args,policy);
  if(refused)return textResult(client.operations,{error:{type:'PolicyRefusal',message:refused}},true);
  if(name==='get_usage_rules')return {content:[{type:'text',text:usageRules}]};
  if(isOperation(name))return callOperation(client.operations,name,args);
  if(isAgentTool(name)){
    const r=await callAgentTool(client.agents,name,args);
    return textResult(client.operations,r.content.length===1&&r.content[0].type==='text'?JSON.parse(r.content[0].text):r.content,Boolean(r.isError));
  }
  try{
    const d=legacy.get(name)!;const v=d.validate(args??{});
    // Argument values can hold secrets, so validation errors name the tool only.
    if(!v.valid)throw new Error(`Invalid arguments for ${name}; consult the input schema`);
    const result=await d.run(client,v.data);
    return textResult(client.operations,result,Boolean(result?.error));
  }catch(e){return textResult(client.operations,{error:errorDetails(e)},true);}
}

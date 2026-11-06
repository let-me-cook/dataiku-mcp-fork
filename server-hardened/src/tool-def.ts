import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OperationsClient } from './operations-client.js';
export const str=(description:string)=>({type:'string',minLength:1,description});
export const id=(description:string)=>({type:'string',minLength:1,maxLength:256,pattern:'\\S',description});
export const num=(max:number,def:number)=>({type:'integer',minimum:1,maximum:max,default:def});
export const obj=(description:string)=>({type:'object',additionalProperties:true,description});
export const arr=(items:object,max=100)=>({type:'array',items,maxItems:max});
export const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
export const fields=(properties:Record<string,object>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
export type OperationDefinition<C=OperationsClient>={tool:Tool;run:(c:C,a:any)=>Promise<any>};
export function def<C=OperationsClient>(name:string,description:string,properties:Record<string,object>,required:string[],run:OperationDefinition<C>['run'],readOnly=true):OperationDefinition<C>{return {tool:{name,description,inputSchema:fields(properties,required) as Tool['inputSchema'],annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:true}},run};}

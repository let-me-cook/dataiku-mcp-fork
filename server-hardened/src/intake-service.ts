import { SecureHttpClient, DssError } from './http-client.js';
import { loadArtifact, sha256 } from './artifacts.js';

export const INTAKE_CONTRACT = 'dataiku-intake-v1';
type IntakeConfig = {url?: string; token?: string; projects?: string; allowHttp?: boolean};
export class IntakeService {
  private http?: SecureHttpClient;
  private projects: Set<string>;
  constructor(config: IntakeConfig = {
    url: process.env.DSS_INTAKE_URL, token: process.env.DSS_INTAKE_TOKEN,
    projects: process.env.DSS_INTAKE_PROJECTS, allowHttp: process.env.DSS_INTAKE_ALLOW_HTTP === 'true',
  }) {
    this.projects = new Set((config.projects ?? '').split(',').map(s => s.trim()).filter(Boolean));
    if (!config.url) return;
    if (!config.token || !this.projects.size) throw new Error('Set DSS_INTAKE_TOKEN and DSS_INTAKE_PROJECTS with DSS_INTAKE_URL');
    const url = new URL(config.url);
    if ((url.protocol !== 'https:' && !(config.allowHttp && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
      throw new Error('Intake URL requires HTTPS (or explicit HTTP opt-in), without credentials, query or fragment');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    this.http = new SecureHttpClient(url, config.token, 'bearer');
  }
  private client(project: string) {
    if (!this.http) throw new DssError({type:'IntakeNotConfigured',message:'Upload registration and metadata row operations require an intake backend implementing dataiku-intake-v1. Configure DSS_INTAKE_URL, DSS_INTAKE_TOKEN and DSS_INTAKE_PROJECTS. No DSS writes were attempted.'});
    if (!this.projects.has(project)) throw new Error('Project is not allowed by DSS_INTAKE_PROJECTS');
    return this.http;
  }
  async capabilities(project: string) {
    if (!this.http) return {configured:false,contract:INTAKE_CONTRACT,registration_available:false,metadata_rows_available:false};
    const http=this.client(project);
    const d=(await http.get('capabilities')).data;
    if (d?.contract !== INTAKE_CONTRACT) throw new Error('Intake backend contract mismatch');
    return {configured:true,contract:INTAKE_CONTRACT,
      registration_available:d.registration?.durable_idempotency===true && d.registration?.recoverable_partial_failures===true && d.registration?.stable_document_id===true,
      metadata_rows_available:d.metadata?.parameterized===true && d.metadata?.atomic_expected_version===true && d.metadata?.key_scoped===true,
      assurance:'Capabilities are declared by the configured backend; the MCP cannot independently prove its transaction implementation'};
  }
  private async ready(project: string, capability: 'registration_available' | 'metadata_rows_available') {
    const http=this.client(project);
    const caps=await this.capabilities(project);
    if (!caps[capability]) throw new Error(`Intake backend does not declare required ${capability} guarantees`);
    return http;
  }
  private invalid(message: string): never {throw new DssError({type:'IntakeContractError',message,operation_outcome:'unknown',retry_policy:'Do not issue a new idempotency key; inspect the backend or retry the identical request with its original key'});}
  private mutationError(error: unknown, key: string): never {
    if (error instanceof DssError) throw new DssError({...error.details,source:'intake_backend',idempotency_key:key,
      operation_outcome:'not_confirmed',retry_policy:'Do not use a new idempotency key. Inspect conflicts; reconcile timeouts with the original key and identical request.'});
    throw error;
  }
  async register(a: any) {
    const http=await this.ready(a.project_key,'registration_available');
    const bytes=await loadArtifact(a.artifact_id);
    if (sha256(bytes)!==a.sha256) throw new Error('Upload artifact checksum mismatch');
    const request={contract:INTAKE_CONTRACT,project_key:a.project_key,idempotency_key:a.idempotency_key,
      filename:a.filename,sha256:a.sha256,size_bytes:bytes.length,metadata:a.metadata};
    const form=new FormData();
    form.append('request',JSON.stringify(request));
    form.append('file',new Blob([new Uint8Array(bytes)]),a.filename);
    const d=(await http.post('documents/register',undefined,{rawBody:form,timeoutMs:120000,maxBytes:131072}).catch(e=>this.mutationError(e,a.idempotency_key))).data;
    if (d?.contract!==INTAKE_CONTRACT || d.project_key!==a.project_key || d.idempotency_key!==a.idempotency_key || d.sha256!==a.sha256 || typeof d.document_id!=='string' || !d.document_id || !['COMMITTED','PENDING','FAILED'].includes(d.state) || typeof d.replayed!=='boolean') {
      this.invalid('Invalid upload receipt; registration outcome is unknown');
    }
    return http.clean({contract:d.contract,project_key:a.project_key,document_id:d.document_id,state:d.state,committed:d.state==='COMMITTED',
      sha256:d.sha256,idempotency_key:d.idempotency_key,replayed:d.replayed,
      ...(d.state==='FAILED'?{error:{type:'RegistrationFailed',message:'Backend reports failed registration; retain the original idempotency key for reconciliation'}}:{}),
      consistency_owner:'intake backend',retry_policy:'Use the same idempotency key and identical payload; never retry with a new key after a timeout or partial failure'});
  }
  async rows(a: any, write: boolean) {
    const http=await this.ready(a.project_key,'metadata_rows_available');
    const request={contract:INTAKE_CONTRACT,project_key:a.project_key,registry:a.registry,keys:a.keys,
      ...(write?{values:a.values,expected_version:a.expected_version,idempotency_key:a.idempotency_key}:{})};
    if(write && Object.keys(a.keys).some(k=>Object.prototype.hasOwnProperty.call(a.values,k))) throw new Error('Key columns must not also appear in values');
    const d=(await http.post(write?'metadata/upsert':'metadata/read',request,{maxBytes:262144}).catch(e=>{if(write)this.mutationError(e,a.idempotency_key);throw e;})).data;
    if(d?.contract!==INTAKE_CONTRACT || d.project_key!==a.project_key || d.registry!==a.registry) this.invalid('Invalid metadata response identity');
    if(!write && d.found===false) return {found:false,project_key:a.project_key,registry:a.registry};
    if(d.found!==true || !d.row || typeof d.row!=='object' || Array.isArray(d.row) || !['string','number'].includes(typeof d.version) ||
      (typeof d.version==='number' && (!Number.isSafeInteger(d.version)||d.version<0)) || (typeof d.version==='string' && !d.version) ||
      Object.entries(a.keys).some(([k,v])=>d.row[k]!==v)) this.invalid('Metadata response must contain one matching keyed row and a version');
    if(write && (d.idempotency_key!==a.idempotency_key || typeof d.replayed!=='boolean' || d.state!=='COMMITTED')) this.invalid('Metadata write is not confirmed committed');
    return http.clean({found:true,project_key:a.project_key,registry:a.registry,row:d.row,version:d.version,
      ...(write?{committed:true,idempotency_key:d.idempotency_key,replayed:d.replayed}:{}),consistency_owner:'intake backend'});
  }
}

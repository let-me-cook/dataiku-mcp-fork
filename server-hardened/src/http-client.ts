import { randomUUID } from 'node:crypto';

export type RequestOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  maxBytes?: number;
  truncate?: boolean;
  format?: 'json' | 'text' | 'bytes';
  rawBody?: BodyInit;
  contentType?: string;
};
const SECRET_FIELD = /^(?:.*(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key).*)$/i;
export function sanitize(value: any, knownSecrets: string[] = [], schemaMode = false): any {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of knownSecrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/dkuaps-[\w-]+/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|access_token)\s*[=:]\s*)["']?[^\s,"';}]+["']?/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => sanitize(v, knownSecrets, schemaMode));
  if (value && typeof value === 'object') {
    const schema = schemaMode || '$schema' in value || '$ref' in value || (typeof value.type === 'string' && ('properties' in value || 'required' in value));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, !schema && SECRET_FIELD.test(k) && typeof v !== 'number' ? '[REDACTED]' : sanitize(v, knownSecrets, schema || /^(inputSchema|outputSchema|jsonSchema)$/.test(k))]));
  }
  return value;
}
export class DssError extends Error {
  constructor(public readonly details: Record<string, unknown>) { super(String(details.message)); }
}
export function errorDetails(error: unknown): Record<string, unknown> {
  return error instanceof DssError ? error.details : { type: 'ClientError', message: error instanceof Error ? error.message : 'Operation failed' };
}
export class SecureHttpClient {
  constructor(private readonly baseUrl: URL, private readonly apiKey: string, private readonly auth: 'basic' | 'bearer' = 'basic') {}
  private secrets() { return [this.apiKey, Buffer.from(`${this.apiKey}:`).toString('base64')]; }
  clean(value: any) { return sanitize(value, this.secrets()); }

  async request(method: string, relativePath: string, body?: unknown, options: RequestOptions = {}): Promise<{data: any; bytes: number; truncated: boolean; contentType: string; operationId: string}> {
    const url = new URL(relativePath.replace(/^\/+/, ''), this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) throw new Error('Invalid API path');
    for (const [key, value] of Object.entries(options.params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const operationId = randomUUID();
    try {
      const response = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
        headers: { Authorization: this.auth === 'bearer' ? `Bearer ${this.apiKey}` : `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`,
          Accept: options.format === 'bytes' ? '*/*' : 'application/json',
          ...(options.rawBody !== undefined ? (options.contentType ? {'Content-Type': options.contentType} : {}) : body === undefined ? {} : {'Content-Type':'application/json'}) },
        ...(options.rawBody !== undefined ? {body: options.rawBody} : body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      const maxBytes = response.ok ? options.maxBytes ?? 5 * 1024 * 1024 : 32 * 1024;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) throw new Error('Invalid response byte limit');
      const chunks: Uint8Array[] = []; let bytes = 0; let truncated = false;
      const reader = response.body?.getReader();
      try {
        if (reader) while (true) {
          const next = await reader.read(); if (next.done) break;
          const available = maxBytes - bytes;
          if (next.value.byteLength > available) {
            chunks.push(next.value.subarray(0, available)); bytes += available; truncated = true; break;
          }
          chunks.push(next.value); bytes += next.value.byteLength;
        }
      } finally { if (reader) { if (truncated) await reader.cancel(); reader.releaseLock(); } }
      const buffer = Buffer.concat(chunks, bytes);
      if (!response.ok) {
        let parsed: any; try { parsed = JSON.parse(buffer.toString('utf8')); } catch { parsed = {}; }
        const fallback = ({401:'Invalid Dataiku API key',403:'Insufficient permissions for Dataiku operation',404:'Dataiku resource not found'} as Record<number,string>)[response.status] ?? `Dataiku API request failed with status ${response.status}`;
        const cause = (v: any, depth = 0): any => v == null || depth > 3 ? undefined : typeof v === 'string' ? this.clean(v).slice(0,2000) : {type:this.clean(v.errorType ?? v.type ?? v.exceptionClass),message:this.clean(String(v.message ?? v.detailedMessage ?? '')).slice(0,2000),cause:cause(v.cause ?? v.causedBy,depth+1)};
        throw new DssError({status:response.status,type:this.clean(parsed.errorType ?? parsed.type ?? 'DssHttpError'),message:this.clean(String(parsed.message ?? parsed.detailedMessage ?? fallback)).slice(0,2000),detailed_message:this.clean(String(parsed.detailedMessage ?? '')).slice(0,2000),cause:cause(parsed.cause ?? parsed.causedBy),operation_id:operationId,details_truncated:truncated});
      }
      if (truncated && !options.truncate) throw new Error('Dataiku API response exceeded the configured size limit');
      const format = options.format ?? 'json';
      let data: any = buffer;
      if (format === 'text') data = buffer.toString('utf8');
      if (format === 'json') {
        if (truncated) throw new Error('Cannot parse a truncated JSON response');
        try { data = bytes ? JSON.parse(buffer.toString('utf8')) : null; }
        catch { throw new Error('DSS returned a non-JSON response for a JSON operation'); }
      }
      return {data,bytes,truncated,contentType:response.headers.get('content-type') ?? '',operationId};
    } catch (error) {
      if (error instanceof DssError) throw error;
      const message = error instanceof Error && /size limit|non-JSON|truncated JSON|byte limit/.test(error.message) ? error.message
        : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'Dataiku API request timed out; the operation may still be running in DSS' : 'Unable to connect securely to Dataiku DSS';
      throw new DssError({type:'TransportError',message,operation_id:operationId});
    }
  }
  get(path: string, options?: RequestOptions) { return this.request('GET',path,undefined,options); }
  post(path: string, body?: unknown, options?: RequestOptions) { return this.request('POST',path,body,options); }
  put(path: string, body?: unknown, options?: RequestOptions) { return this.request('PUT',path,body,options); }
  delete(path: string, options?: RequestOptions) { return this.request('DELETE',path,undefined,options); }
}

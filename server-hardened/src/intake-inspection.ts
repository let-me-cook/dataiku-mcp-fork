import { OperationsClient, base, seg, parseTsv } from './operations-client.js';

// SQL text is fixed. Dataset names are encoded as UTF-8 hex literals, never SQL identifiers.
const pgText = (s: string) => `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(s).toString('hex')}', 'hex'), 'UTF8')`;

export async function listTables(c: OperationsClient, a: any) {
  const d = (await c.http.get(`${base(a.project_key)}/datasets/${seg(a.dataset_name)}`)).data;
  if (d.type !== 'PostgreSQL') throw new Error('Table discovery currently supports PostgreSQL connections only');
  const p = d.params ?? {};
  if (typeof p.connection !== 'string' || [p.connection,p.catalog??''].some(v=>typeof v!=='string'||v.includes('${'))) throw new Error('Connection/catalog must be resolved before table discovery');
  const limit=a.limit??100;
  if (!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('Invalid table discovery limit');
  const query=`SELECT pg_catalog.json_build_object('database',pg_catalog.current_database(),'schema',n.nspname,'table',c.relname,'relation_kind',c.relkind)::text
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ${a.schema_name ? `AND n.nspname=${pgText(a.schema_name)}` : ''}
    ${a.table_prefix ? `AND pg_catalog.strpos(c.relname,${pgText(a.table_prefix)})=1` : ''}
    ORDER BY n.nspname,c.relname LIMIT ${limit+1}`;
  const rows=await catalogRows(c,a,p,query);
  return {tables:rows.slice(0,limit).map(row=>JSON.parse(row[0])),truncated:rows.length>limit,limit,
    connection:p.connection,configured_schema:p.schema??null,configured_table:p.table??null,
    scope:'Relations visible in PostgreSQL catalogs on this connection/database; listing is not a guarantee of SELECT permission'};
}

async function catalogRows(c: OperationsClient, a: any, p: any, query: string) {
  const session = (await c.http.post('/sql/queries/', {
    query, connection: p.connection, database: p.catalog ?? null, datasetFullName: null,
    projectKey: a.project_key, type: 'sql', preQueries: [], postQueries: [], extraConf: {},
  })).data;
  const id = seg(session.queryId);
  let raw;
  try { raw = await c.http.get(`/sql/queries/${id}/stream`, {params: {format: 'tsv-excel-noheader'}, format: 'text', maxBytes: 1048576}); }
  finally { await c.http.get(`/sql/queries/${id}/finish-streaming`); }
  const rows=parseTsv(raw.data,true);
  if (rows.some(row=>row.length!==1)) throw new Error('Unexpected database catalog row shape');
  return rows;
}

export async function inspectTable(c: OperationsClient, a: any) {
  const d = (await c.http.get(`${base(a.project_key)}/datasets/${seg(a.dataset_name)}`)).data;
  const configuredParams = d.params ?? {};
  const p = {...configuredParams};
  const configured = { connection: p.connection ?? null, catalog: p.catalog ?? null, schema: p.schema ?? null, table: p.table ?? null, mode: p.mode ?? null };
  if (d.type !== 'PostgreSQL' || p.mode !== 'table') {
    return { dataset_type: d.type, configured, dss_schema: d.schema, database_inspected: false, reason: 'Catalog inspection currently supports PostgreSQL table-mode datasets only', primary_key: null, constraints: null };
  }
  // projectKey is a documented built-in storage variable. Other templates remain explicit unknowns.
  for (const key of ['schema', 'table', 'catalog', 'connection']) {
    if (typeof p[key] === 'string') p[key] = p[key].split('${projectKey}').join(a.project_key);
  }
  if (a.table_name !== undefined) p.table = a.table_name;
  if (a.schema_name !== undefined) p.schema = a.schema_name;
  if (!p.table || !p.schema || [p.table, p.schema, p.catalog ?? '', p.connection ?? ''].some(v => typeof v !== 'string' || v.includes('${'))) {
    return { configured, database_inspected: false, reason: 'Explicit schema/table and resolved connection/catalog settings are required; variable templates are not guessed', primary_key: null, constraints: null };
  }
  const query = `WITH target AS (
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${pgText(p.schema)} AND c.relname=${pgText(p.table)}
  ) SELECT pg_catalog.json_build_object(
    'database', pg_catalog.current_database(), 'schema', t.nspname, 'table', t.relname, 'relation_kind', t.relkind,
    'columns', COALESCE((SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', a.attname, 'type', pg_catalog.format_type(a.atttypid,a.atttypmod), 'nullable', NOT a.attnotnull,
      'default', pg_catalog.pg_get_expr(ad.adbin,ad.adrelid)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
      WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped), '[]'::json),
    'constraints', COALESCE((SELECT pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', k.conname, 'kind', k.contype, 'definition', pg_catalog.pg_get_constraintdef(k.oid), 'validated', k.convalidated,
      'columns', ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.num ORDER BY u.ord)) ORDER BY k.conname)
      FROM pg_catalog.pg_constraint k WHERE k.conrelid=t.oid), '[]'::json)
    )::text AS inspection FROM target t LIMIT 1`;
  const rows = await catalogRows(c,a,p,query);
  if (!rows.length) return { configured, inspected_target: {schema:p.schema,table:p.table}, database_inspected: true, table_found: false, primary_key: null, constraints: null, note:'Exact catalog name was not found; no case folding or search-path equivalence is assumed' };
  if (rows.length !== 1 || rows[0].length !== 1) throw new Error('Unexpected database inspection result');
  const inspection = JSON.parse(rows[0][0]);
  if (!Array.isArray(inspection.constraints) || !Array.isArray(inspection.columns)) throw new Error('Invalid database inspection result');
  return { configured, database_inspected: true, table_found: true, resolved: inspection,
    primary_key: inspection.constraints.filter((k: any) => k.kind === 'p').flatMap((k: any) => k.columns),
    constraints: inspection.constraints, dss_schema: d.schema,
    resolution: {method: 'exact catalog match; projectKey expanded; optional explicit schema/table override; no case folding', schema: p.schema, table: p.table},
    scope: 'PostgreSQL relation columns and constraints; standalone indexes/triggers are not included' };
}

export async function extractionSummary(c: OperationsClient, a: any) {
  const job = await c.job(a);
  const result = { project_key: a.project_key, job_id: a.job_id, job_state: job.state, job_terminal: job.terminal,
    job_success: job.success, extraction_success: null, counts: null };
  if (!a.outcomes) return {...result, evidence_available: false, reason: 'Job state alone does not report per-file extraction outcomes. Supply a run-scoped outcomes dataset.'};
  const o = a.outcomes;
  const path = `${base(a.project_key)}/datasets/${seg(o.dataset_name)}`;
  const schema = (await c.http.get(`${path}/schema`)).data.columns;
  const names = schema.map((x: any) => x.name);
  const columns = [o.run_column, o.document_column, o.status_column, o.output_count_column];
  if (new Set(columns).size !== columns.length || columns.some(n => !names.includes(n))) throw new Error('Outcome columns must be distinct and present in the dataset schema');
  const raw = await c.http.get(`${path}/data/`, {params: {format: 'tsv-excel-noheader'}, format: 'text', maxBytes: a.max_scan_bytes ?? 1048576, truncate: true});
  const rows = parseTsv(raw.data, !raw.truncated);
  const statuses: Record<string, string[]> = o.status_values ?? {succeeded: ['SUCCEEDED', 'SUCCESS'], skipped: ['SKIPPED'], failed: ['FAILED'], pending: ['PENDING', 'RUNNING']};
  const categories = new Map<string, string>();
  for (const [category, values] of Object.entries(statuses)) for (const v of values) {
    if (categories.has(v)) throw new Error('Outcome status categories must not overlap');
    categories.set(v, category);
  }
  const observed = {files_attempted: 0, files_succeeded: 0, files_skipped: 0, files_failed: 0, files_pending: 0, files_unknown: 0, output_rows: 0};
  const docs = new Set<string>();
  let scanned = 0, matching = 0, duplicateRows = 0, invalidRows = 0, invalidCounts = 0;
  for (const cells of rows) {
    if (scanned >= (a.max_scan_rows ?? 10000)) break;
    scanned++;
    if (cells.length !== names.length) throw new Error('Outcome row width does not match schema');
    const row = Object.fromEntries(names.map((n: string, i: number) => [n, cells[i]]));
    if (row[o.run_column] !== (o.run_value ?? a.job_id)) continue;
    matching++;
    const id = row[o.document_column];
    if (!id) {invalidRows++; continue;}
    if (docs.has(id)) {duplicateRows++; continue;}
    docs.add(id);
    switch(categories.get(row[o.status_column])) {
      case 'succeeded': observed.files_succeeded++; observed.files_attempted++; break;
      case 'failed': observed.files_failed++; observed.files_attempted++; break;
      case 'skipped': observed.files_skipped++; break;
      case 'pending': observed.files_pending++; break;
      default: observed.files_unknown++;
    }
    const count = row[o.output_count_column];
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || !Number.isSafeInteger(observed.output_rows + Number(count))) invalidCounts++;
    else observed.output_rows += Number(count);
  }
  const truncated = raw.truncated || scanned < rows.length;
  const valid = matching > 0 && !truncated && !duplicateRows && !invalidRows && !invalidCounts && !observed.files_unknown;
  const complete = valid && job.terminal && !observed.files_pending;
  return {...result, evidence_available: true, source_dataset: o.dataset_name, scope: 'one final outcome row per document for the selected run value', run_value: o.run_value ?? a.job_id, job_to_manifest_linkage_verified:false,
    counts: valid ? observed : null, observed_counts: observed, counts_complete: complete,
    extraction_success: complete ? job.success === true && observed.files_failed === 0 : null,
    attempted_definition: 'succeeded plus failed; skipped and pending are excluded',
    output_count_source: 'reported by outcomes dataset; not an independent output table recount',
    manifest_coverage_verified: false, scanned_rows: scanned, matching_rows: matching, scanned_bytes: raw.bytes, truncated,
    duplicate_document_rows: duplicateRows, invalid_document_rows: invalidRows, invalid_output_counts: invalidCounts,
    note: 'The producer must record every input including failures/skips. This summary cannot detect omitted documents; an empty or partial manifest never establishes success.'};
}

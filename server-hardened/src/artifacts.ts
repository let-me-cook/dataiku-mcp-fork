import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
export const artifactRoot = process.env.DSS_ARTIFACT_DIR ?? fileURLToPath(new URL('../../.artifacts/', import.meta.url));
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export async function storeArtifact(bytes: Buffer, mediaType: string) {
  await mkdir(artifactRoot, {recursive:true,mode:0o700});
  const id = randomUUID();
  await writeFile(join(artifactRoot,id),bytes,{mode:0o600,flag:'wx'});
  return {artifact_id:id,size_bytes:bytes.length,sha256:sha256(bytes),media_type:mediaType,local_path:join(artifactRoot,id)};
}
export async function loadArtifact(id: string, maxBytes = 100 * 1024 * 1024) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid artifact ID');
  const file = await open(join(artifactRoot,id), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s=await file.stat(); if (!s.isFile() || s.size>maxBytes) throw new Error('Artifact exceeds size limit'); return await file.readFile(); }
  finally {await file.close();}
}
export async function registerArtifact(filename: string, expected: string) {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) throw new Error('Use a plain filename in the artifact inbox');
  const file = await open(join(artifactRoot,'inbox',filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s=await file.stat(); if (!s.isFile() || s.size>100*1024*1024) throw new Error('Invalid inbox artifact size'); const bytes=await file.readFile(); if(sha256(bytes)!==expected) throw new Error('Artifact checksum mismatch'); return await storeArtifact(bytes,'application/octet-stream'); }
  finally {await file.close();}
}
// Parse ZIP central-directory metadata and selected bounded JSON entries; never extract paths to disk.
export function zipManifest(bytes: Buffer) {
  let eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){eocd=i;break;}
  if(eocd<0) throw new Error('Invalid ZIP central directory');
  const count=bytes.readUInt16LE(eocd+10); let cursor=bytes.readUInt32LE(eocd+16);
  if(count>10000 || bytes.readUInt16LE(eocd+4)!==0) throw new Error('ZIP64, multi-disk or oversized ZIP manifest is unsupported');
  const entries:any[]=[]; const parsed:Record<string,unknown>={};
  for(let i=0;i<count;i++) {
    if(cursor+46>bytes.length || bytes.readUInt32LE(cursor)!==0x02014b50) throw new Error('Invalid ZIP entry');
    const method=bytes.readUInt16LE(cursor+10), compressed=bytes.readUInt32LE(cursor+20), size=bytes.readUInt32LE(cursor+24), nl=bytes.readUInt16LE(cursor+28), el=bytes.readUInt16LE(cursor+30), cl=bytes.readUInt16LE(cursor+32), offset=bytes.readUInt32LE(cursor+42);
    const name=bytes.subarray(cursor+46,cursor+46+nl).toString('utf8');
    entries.push({name,size_bytes:size,compressed_bytes:compressed});
    if(/^(?:manifest|project|params)\.json$/.test(name) && size<=1024*1024 && !(bytes.readUInt16LE(cursor+8)&1)) {
      if(offset+30>bytes.length || bytes.readUInt32LE(offset)!==0x04034b50) throw new Error('Invalid ZIP local entry');
      const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
      if(start+compressed>bytes.length) throw new Error('Invalid ZIP entry length');
      const raw=bytes.subarray(start,start+compressed);
      const unpacked=method===0?raw:method===8?inflateRawSync(raw,{maxOutputLength:1024*1024}):null;
      if(unpacked) { if(unpacked.length!==size) throw new Error('ZIP manifest length mismatch'); parsed[name]=JSON.parse(unpacked.toString('utf8')); }
    }
    cursor+=46+nl+el+cl;
  }
  return {entries,parsed,parsed_json_scope:'root manifest.json, project.json and params.json only; each at most 1 MiB'};
}

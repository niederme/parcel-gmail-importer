import {Blocked} from './contract.ts';
export interface Result {meta:{changes:number};results?:Record<string,unknown>[];success?:boolean}
export interface Statement {bind(...args:unknown[]):Statement;first<T=Record<string,unknown>>():Promise<T|null>;all<T=Record<string,unknown>>():Promise<{results:T[]}>;run():Promise<Result>}
export interface Database {prepare(sql:string):Statement;batch(statements:Statement[]):Promise<Result[]>}
export type Control={token:string|null;locked_at:number|null;cache_at:number|null;migration_pending:string|null;migration_digest:string|null;migration_at:number|null;verified_at:number|null};
export function q(db:Database,sql:string,...args:unknown[]) {return db.prepare(sql).bind(...args)}
export async function control(db:Database):Promise<Control|null> {return q(db,'SELECT * FROM control WHERE id=1').first<Control>()}
// The durable lease is intentionally never stolen automatically. A killed request
// may still have reached Parcel. A stale lease needs supervised reconciliation.
export async function withLease<T>(db:Database,run:(token:string)=>Promise<T>):Promise<T> {
  const token=crypto.randomUUID();const now=Date.now();
  const res=await db.batch([q(db,'INSERT OR IGNORE INTO control (id) VALUES (1)'),q(db,'UPDATE control SET token=?,locked_at=? WHERE id=1 AND token IS NULL',token,now)]);
  if(res[1].meta.changes!==1) throw new Blocked('importer_busy_or_recovery_required');
  try{return await run(token)}finally{await q(db,'UPDATE control SET token=NULL,locked_at=NULL WHERE id=1 AND token=?',token).run()}
}
export async function assertLease(db:Database,token:string) {const c=await control(db);if(c?.token!==token) throw new Blocked('lease_lost');}
export async function quotaCount(db:Database,kind:string,now:number) {const row=await q(db,'SELECT count(*) AS n FROM quota WHERE kind=? AND at>?',kind,now-(kind==='add'?86400000:3600000)).first<{n:number}>();return row?.n??0}
export async function reserveRead(db:Database,token:string,now:number) {
  await assertLease(db,token);if(await quotaCount(db,'read',now)>18) throw new Blocked('hourly_read_limit');
  const r=await db.batch([q(db,'INSERT INTO quota (id,kind,at) VALUES (?,\'read\',?)',crypto.randomUUID(),now),q(db,'INSERT INTO quota (id,kind,at) VALUES (?,\'read\',?)',crypto.randomUUID(),now)]);
  if(r.some(x=>x.meta.changes!==1)) throw new Blocked('reservation_failed');
}
export async function reserveAddition(db:Database,token:string,pair:string,hash:string,now:number) {
  await assertLease(db,token);if(await q(db,'SELECT status FROM ledger WHERE pair=?',pair).first()) throw new Blocked('duplicate_or_pending');
  if(await quotaCount(db,'add',now)>=20) throw new Blocked('daily_add_limit');
  await db.batch([q(db,'INSERT INTO ledger (pair,status,description_hash,created_at,updated_at) VALUES (?,\'uncertain\',?,?,?)',pair,hash,now,now),q(db,'INSERT INTO quota (id,kind,at) VALUES (?,\'add\',?)',crypto.randomUUID(),now)]);
  const row=await q(db,'SELECT status FROM ledger WHERE pair=?',pair).first<{status:string}>();if(row?.status!=='uncertain') throw new Blocked('reservation_failed');
}

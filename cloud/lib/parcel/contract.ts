export class Blocked extends Error { constructor(public code: string) { super(code); } }
export type Catalog = Record<string, { name: string; extra_required?: number | null }>;
export type Candidate = {carrier_code: string; tracking_number: string; merchant_label: string; item_name?: string; verified: {merchant: boolean; tracking: boolean; non_amazon_retail: boolean; merchant_label_only: boolean; requires_extra_data: boolean; item_summary_benign?: boolean}};
const lengthOf=(s:string)=>Array.from(new Intl.Segmenter('en',{granularity:'grapheme'}).segment(s)).length;
const plain = /^[\p{L}\p{N}][\p{L}\p{N} &'’.()-]*$/u;
const sensitive = /\b(medication|medicine|insulin|diagnosis|pregnancy|therapy|prescription|pharmacy|passport|ssn|account|bank|loan|credit|debit|child|baby|sexual|fertility|disability)\b/i;
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Blocked('invalid_schema'); return value as Record<string, unknown>; }
export function exactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []) { if(required.some(k=>!(k in o)) || Object.keys(o).some(k=>!required.includes(k) && !optional.includes(k))) throw new Blocked('invalid_schema'); }
export function validate(value: unknown, catalog?: Catalog): Candidate {
  const o=object(value);exactKeys(o,['carrier_code','tracking_number','merchant_label','verified'],['item_name']);
  const v=object(o.verified);exactKeys(v,['merchant','tracking','non_amazon_retail','merchant_label_only','requires_extra_data'],['item_summary_benign']);
  if(Object.values(v).some(x=>typeof x!=='boolean')) throw new Blocked('invalid_candidate_schema');
  if(v.merchant!==true || v.tracking!==true || v.non_amazon_retail!==true || v.merchant_label_only!==true || v.requires_extra_data!==false) throw new Blocked('candidate_requires_review');
  const m=o.merchant_label, c=o.carrier_code, t=o.tracking_number;
  if(typeof m!=='string'||lengthOf(m)<1||lengthOf(m)>60||m!==m.trim()||!plain.test(m)||/amazon|amzn|whole foods/i.test(m)) throw new Blocked('invalid_or_amazon_merchant');
  if('item_name' in o) {const i=o.item_name;if(typeof i!=='string'||lengthOf(i)<1||lengthOf(i)>40||lengthOf(m)+lengthOf(i)+2>100||i!==i.trim()||!plain.test(i)) throw new Blocked('invalid_item_summary');}
  if(typeof c!=='string'||!/^[a-z0-9]{2,20}$/.test(c)||c==='pholder'||(catalog&&!Object.hasOwn(catalog,c))) throw new Blocked('unsupported_carrier');
  if(catalog && catalog[c].extra_required!=null && catalog[c].extra_required!==0) throw new Blocked('carrier_requires_extra_data');
  if(typeof t!=='string'||!/^[A-Z0-9-]{6,50}$/.test(t)||!/[0-9]/.test(t)||t.startsWith('ORDER')||(c==='ups'&&!/^1Z[A-Z0-9]{16}$/.test(t))) throw new Blocked('ambiguous_tracking');
  if(t.startsWith('TBA')&&!['amzlus','swiship'].includes(c)) throw new Blocked('ambiguous_carrier_mapping');
  if(new TextEncoder().encode(JSON.stringify(o)).length>4096) throw new Blocked('candidate_too_large');
  return o as Candidate;
}
export const pairOf=(c: Candidate)=>c.carrier_code+':'+c.tracking_number;
export const descriptionOf=(c: Candidate)=>c.item_name && c.verified.item_summary_benign===true && !sensitive.test(c.item_name) ? c.merchant_label+': '+c.item_name : c.merchant_label;
export function validatePair(pair: unknown): string { if(typeof pair!=='string'||! /^[a-z0-9]{2,40}:[^\x00-\x1f\x7f]{1,150}$/.test(pair)) throw new Blocked('invalid_ledger_pair');return pair; }
export async function sha256(s: string) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
export const candidateSchema={type:'object',additionalProperties:false,required:['carrier_code','tracking_number','merchant_label','verified'],properties:{carrier_code:{type:'string',pattern:'^[a-z0-9]{2,20}$'},tracking_number:{type:'string',pattern:'^[A-Z0-9-]{6,50}$'},merchant_label:{type:'string',minLength:1,maxLength:60},item_name:{type:'string',minLength:1,maxLength:40,description:'Optional short benign item only. Omit for anything sensitive or unclear.'},verified:{type:'object',additionalProperties:false,required:['merchant','tracking','non_amazon_retail','merchant_label_only','requires_extra_data'],properties:{merchant:{const:true},tracking:{const:true},non_amazon_retail:{const:true},merchant_label_only:{const:true},requires_extra_data:{const:false},item_summary_benign:{type:'boolean'}}}}};

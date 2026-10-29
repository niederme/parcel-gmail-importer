/** Only structured dates and a finite vocabulary cross the brief boundary.
 * Never copy Parcel descriptions, event text, locations, or extra information.
 */
export type SafeDate={date:string;time:string|null;timezone:'UTC'|null};
export type ExpectedDelivery=SafeDate&{end_date:string|null;end_time:string|null;source:'parcel_api'};
export const EVENT_STATUSES=['delivered','out_for_delivery','delivery_attempted','available_for_pickup','arrived_at_facility','departed_facility','in_transit','label_created','customs_clearance','delivery_exception'] as const;
export type LatestEvent=SafeDate&{status:typeof EVENT_STATUSES[number];source:'parcel_api'};
const minEpoch=Date.UTC(2000,0,1),maxEpoch=Date.UTC(2100,0,1);
function dateParts(year:number,month:number,day:number) {
 const value=new Date(Date.UTC(year,month-1,day));
 return year>=2000&&year<2100&&value.getUTCFullYear()===year&&value.getUTCMonth()===month-1&&value.getUTCDate()===day?value.toISOString().slice(0,10):null;
}
function utc(ms:number):SafeDate|null {if(ms<minEpoch||ms>=maxEpoch)return null;const iso=new Date(ms).toISOString();return {date:iso.slice(0,10),time:iso.slice(11,16),timezone:'UTC'};}
export function safeEpoch(value:unknown):SafeDate|null {
 if(typeof value!=='number'||!Number.isSafeInteger(value))return null;
 // Seconds and milliseconds have disjoint plausible ranges. Never guess timezone.
 if(value>=minEpoch/1000&&value<maxEpoch/1000)return utc(value*1000);
 if(value>=minEpoch&&value<maxEpoch)return utc(value);
 return null;
}
export function safeDate(value:unknown):SafeDate|null {
 if(typeof value!=='string'||value.length>40)return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
 if(!m)return null;
 const date=dateParts(+m[1],+m[2],+m[3]);if(!date)return null;
 if(m[4]===undefined)return {date,time:null,timezone:null};
 if(+m[4]>23||+m[5]>59||+(m[6]??0)>59)return null;
 if(m[7]){
  if(m[7]!=='Z'&&(+m[7].slice(1,3)>14||+m[7].slice(4)>59||(+m[7].slice(1,3)===14&&+m[7].slice(4)!==0)))return null;
  const stamp=Date.parse(`${date}T${m[4]}:${m[5]}:${m[6]??'00'}${m[7]}`);return Number.isFinite(stamp)?utc(stamp):null;
 }
 return {date,time:`${m[4]}:${m[5]}`,timezone:null};
}
const order=(d:SafeDate)=>`${d.date}T${d.time??'00:00'}`;
type DateRange={safe:SafeDate;earliest:number;latest:number};
function dateRange(value:unknown,epoch=false):DateRange|null {
 const safe=epoch?safeEpoch(value):safeDate(value);if(!safe)return null;
 if(epoch){const ms=(value as number)<minEpoch?(value as number)*1000:value as number;return {safe,earliest:ms,latest:ms};}
 const raw=value as string;
 if(safe.time===null){const start=Date.parse(safe.date+'T00:00:00Z');return {safe,earliest:start,latest:start+86400000-1};}
 const full=raw.replace(' ','T')+(safe.timezone===null?'Z':'');const start=Date.parse(full);
 const hasSeconds=/[T ]\d{2}:\d{2}:\d{2}/.test(raw);
 return {safe,earliest:start,latest:start+(hasSeconds?999:59999)};
}
export function expectedDelivery(d:Record<string,unknown>):ExpectedDelivery|null {
 const absolute=dateRange(d.timestamp_expected,true);
 const first=absolute??dateRange(d.date_expected);if(!first)return null;const start=first.safe;
 const last=absolute?(dateRange(d.timestamp_expected_end,true)??dateRange(d.date_expected_end)):dateRange(d.date_expected_end);
 const usable=last&&last.safe.timezone===start.timezone&&last.latest>=first.earliest?last.safe:null;
 if((d.date_expected_end!=null||d.timestamp_expected_end!=null)&&!usable)return null;
 // A floating midnight can represent a date-only estimate. Without an absolute
 // timestamp or window, preserve the date but do not promise a midnight arrival.
 const time=start.timezone===null&&start.time==='00:00'&&!usable?null:start.time;
 return {...start,time,end_date:usable?.date??null,end_time:usable?.time??null,source:'parcel_api'};
}
function eventStatus(value:unknown):LatestEvent['status']|null {
 if(typeof value!=='string'||value.length>1000)return null;
 const text=value.trim().toLowerCase();
 if(/\b(not|never|cancelled|canceled|reversed|incorrect|error|unsuccessful)\b/.test(text))return null;
 // Anchored carrier phrases become fixed status codes; never return the input.
 if(/^(delivered|your (?:item|package) was delivered)\b/.test(text))return 'delivered';
 if(/^(out for delivery|your (?:item|package) is out for delivery)\b/.test(text))return 'out_for_delivery';
 if(/^(delivery attempted|attempted delivery|delivery attempt(?:ed)? failed|notice left)\b/.test(text))return 'delivery_attempted';
 if(/^(available for pickup|ready for pickup|awaiting collection)\b/.test(text))return 'available_for_pickup';
 if(/^(arrived at|arrival at|processed through)\b.*\b(facility|distribution center|sort(?:ing)? (?:center|centre))\b/.test(text))return 'arrived_at_facility';
 if(/^(departed|departure from)\b.*\b(facility|distribution center|sort(?:ing)? (?:center|centre))\b/.test(text))return 'departed_facility';
 if(/^(in transit|on the way|moving through network)\b/.test(text))return 'in_transit';
 if(/^(shipping label created|label created|pre-shipment|shipment information received)\b/.test(text))return 'label_created';
 if(/^(customs clearance|cleared customs|customs cleared)\b/.test(text))return 'customs_clearance';
 if(/^(delivery exception|shipment exception|delivery delayed)\b/.test(text))return 'delivery_exception';
 return null;
}
export function latestEvent(value:unknown):LatestEvent|null {
 if(!Array.isArray(value)||value.length===0||value.length>200)return null;
 const dated:{range:DateRange;status:LatestEvent['status']|null}[]=[];
 for(const event of value){
  if(!event||typeof event!=='object'||Array.isArray(event))return null;
  const e=event as Record<string,unknown>,range=dateRange(e.date);
  // No documented array order: unknown dates or mixed timezone bases cannot establish latest.
  if(!range||(dated.length>0&&dated[0].range.safe.timezone!==range.safe.timezone))return null;
  const status=eventStatus(e.event);
  dated.push({range,status});
 }
 const latestStart=Math.max(...dated.map(d=>d.range.earliest));
 const possible=dated.filter(d=>d.range.latest>=latestStart),latest=possible[0];
 if(possible.some(d=>d.status!==latest.status||d.range.earliest!==latest.range.earliest||d.range.latest!==latest.range.latest))return null;
 return latest?.status?{...latest.range.safe,status:latest.status,source:'parcel_api'}:null;
}
export function storedTiming<T extends ExpectedDelivery|LatestEvent>(value:unknown,kind:'expected'|'event'):T|null {
 if(typeof value!=='string'||value.length>512)return null;
 try{const data=JSON.parse(value);if(!data||typeof data!=='object'||Array.isArray(data)||data.source!=='parcel_api'||![null,'UTC'].includes(data.timezone))return null;
 const keys=kind==='expected'?['date','time','timezone','end_date','end_time','source']:['date','time','timezone','status','source'];
 if(Object.keys(data).length!==keys.length||Object.keys(data).some(k=>!keys.includes(k)))return null;
 const valid=(date:unknown,time:unknown)=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&(time===null||typeof time==='string'&&/^\d{2}:\d{2}$/.test(time))&&safeDate(date+(time===null?'':'T'+time))!==null;
 if(!valid(data.date,data.time))return null;
 if(data.timezone==='UTC'&&data.time===null)return null;
 if(kind==='expected'){if(data.end_date===null){if(data.end_time!==null)return null;if(data.timezone===null&&data.time==='00:00')data.time=null;}else if(!valid(data.end_date,data.end_time)||order({date:data.end_date,time:data.end_time,timezone:data.timezone})<order(data))return null;}
 else if(!EVENT_STATUSES.includes(data.status))return null;
 return data as T;}catch{return null;}
}

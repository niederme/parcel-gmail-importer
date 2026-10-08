import {Blocked,object,exactKeys,candidateSchema} from './contract.ts';
import {ParcelService} from './service.ts';
import type {Config,Dependencies} from './service.ts';
import {authorize} from './auth.ts';
const empty={type:'object',properties:{},additionalProperties:false};
const candidate={type:'object',properties:{candidate:candidateSchema},required:['candidate'],additionalProperties:false};
export const tools=[
{name:'parcel_status',description:'Read private setup, rate limits, and ledger counts. No Parcel API request.',inputSchema:empty,annotations:{readOnlyHint:true}},
{name:'parcel_verify_connection',description:'Read recent and active Parcel deliveries and reconcile pending entries. Consumes two read slots; never adds deliveries.',inputSchema:empty,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
{name:'parcel_check_candidate',description:'Check a trusted validated shipment against Parcel and verify its private-safe description. No delivery additions.',inputSchema:candidate,annotations:{readOnlyHint:false,destructiveHint:false}},
{name:'parcel_ingest_candidate',description:'Add ONE trusted producer-validated non-Amazon-retail shipment to Parcel only after approved migration and cutover. Sends carrier, tracking, and company with optional benign short item. Never supply raw email, addresses, order details, or sensitive item names. Existing and uncertain pairs never resend. Changes Parcel.',inputSchema:candidate,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
{name:'parcel_import_ledger',description:'Import an explicitly approved local dedupe/rate ledger snapshot only when migration is separately enabled. Requires connection verification; does not enable delivery writes. Timestamps are Unix milliseconds.',inputSchema:{type:'object',additionalProperties:false,required:['seen','uncertain','attempts','reads'],properties:{seen:{type:'array',items:{type:'string'},maxItems:10000},uncertain:{type:'array',items:{type:'string'},maxItems:10000},attempts:{type:'array',items:{type:'integer'},maxItems:20},reads:{type:'array',items:{type:'integer'},maxItems:20}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}}
];
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function handleMcp(request:Request,config:Config,deps:Dependencies={}) {
 if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers});
 let rpc:Record<string,unknown>|undefined;
 try{
   if(!(request.headers.get('content-type')??'').includes('application/json'))throw new Blocked('invalid_content_type');
   if(Number(request.headers.get('content-length'))>512000)throw new Blocked('request_too_large');
   const reader=request.body?.getReader();if(!reader)throw new Blocked('invalid_request');let total=0;let text='';const decoder=new TextDecoder();while(true){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length;if(total>512000){await reader.cancel();throw new Blocked('request_too_large')}text+=decoder.decode(chunk.value,{stream:true})}text+=decoder.decode();rpc=object(JSON.parse(text));
   if(rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string')throw new Blocked('invalid_request');
   const response=(result:unknown)=>Response.json({jsonrpc:'2.0',id:rpc!.id??null,result},{headers});
   if(rpc.method==='initialize')return response({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'parcel-gmail-importer',version:'1.0.0'}});
   if(rpc.method==='notifications/initialized')return new Response(null,{status:202,headers});
   if(rpc.method==='ping')return response({});
   if(rpc.method==='tools/list')return response({tools});
   if(rpc.method!=='tools/call')return Response.json({jsonrpc:'2.0',id:rpc.id??null,error:{code:-32601,message:'Method not found'}},{headers});
   await authorize(request,config);
   const params=object(rpc.params);exactKeys(params,['name'],['arguments','_meta']);const args=object(params.arguments??{});const service=new ParcelService(config,deps);let result:unknown;
   switch(params.name){case 'parcel_status':exactKeys(args,[]);result=await service.status();break;case 'parcel_verify_connection':exactKeys(args,[]);result=await service.verify();break;case 'parcel_check_candidate':exactKeys(args,['candidate']);result=await service.check(args.candidate);break;case 'parcel_ingest_candidate':exactKeys(args,['candidate']);result=await service.ingest(args.candidate);break;case 'parcel_import_ledger':result=await service.importLedger(args);break;default:throw new Blocked('unknown_tool');}
   return response({content:[{type:'text',text:JSON.stringify(result)}]});
 }catch(e){const code=e instanceof Blocked?e.code:'operation_failed';const status=code==='unauthorized'?401:code==='forbidden'?403:200;return Response.json({jsonrpc:'2.0',id:rpc?.id??null,...(status!==200?{error:{code:-32001,message:code}}:{result:{isError:true,content:[{type:'text',text:JSON.stringify({status:'blocked',reason:code})}]}})},{status,headers});}
}

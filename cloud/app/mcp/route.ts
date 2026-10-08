import {env} from 'cloudflare:workers';
import {handleMcp} from '../../lib/parcel/mcp';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>handleMcp(request,env);
export const GET=()=>new Response('Method not allowed',{status:405});

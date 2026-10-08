import {env} from 'cloudflare:workers';
import {authorize} from '../../../lib/parcel/auth';
import {ParcelService} from '../../../lib/parcel/service';
import {Blocked} from '../../../lib/parcel/contract';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{await authorize(request,env);return Response.json(await new ParcelService(env).status(),{headers:{'Cache-Control':'private, no-store'}})}catch(e){const code=e instanceof Blocked?e.code:'storage_unavailable';return Response.json({status:'blocked',reason:code},{status:code==='unauthorized'?401:code==='forbidden'?403:503,headers:{'Cache-Control':'private, no-store'}})}}

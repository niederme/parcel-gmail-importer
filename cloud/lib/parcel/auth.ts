import {Blocked,sha256} from './contract.ts';
import type {Config} from './service.ts';
export async function authorize(request:Request,config:Config) {const id=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email');if(!id||!email)throw new Blocked('unauthorized');if(!config.OWNER_EMAIL_SHA256||await sha256(email.trim().toLowerCase())!==config.OWNER_EMAIL_SHA256)throw new Blocked('forbidden');}

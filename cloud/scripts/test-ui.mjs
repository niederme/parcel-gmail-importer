import {build} from 'esbuild';
import {mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
await mkdir('.sites-runtime',{recursive:true});
const output='.sites-runtime/ui-test.cjs';
try {await build({entryPoints:['tests/ui-render.tsx'],bundle:true,platform:'node',format:'cjs',outfile:output,jsx:'automatic'});const result=spawnSync(process.execPath,[output],{stdio:'inherit'});if(result.status!==0)process.exitCode=result.status??1;}finally{await rm(output,{force:true});}

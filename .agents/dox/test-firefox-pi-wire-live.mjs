#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
const root=fileURLToPath(new URL('./',import.meta.url));const run=promisify(execFile);
const cli=async(...args)=>JSON.parse((await run('firefox-cli',[...args,'--json'],{timeout:15000})).stdout);
const windows=(await cli('window')).windows.filter(window=>!window.private);assert.equal(windows.length,1);const windowId=windows[0].id;
const before=(await cli('tab','--window',`id:${windowId}`)).tabs.map(tab=>tab.id);
const directory=await mkdtemp(join(tmpdir(),'firefox-pi-wire-'));const config=join(directory,'config.json');
await writeFile(config,JSON.stringify({statePath:join(directory,'sessions.json'),namespace:'pi-wire-live',agentId:`wire-${process.pid}`,logLevel:'off'}),{mode:0o600});process.env.FFX_CONFIG=config;
const server=spawn(process.execPath,[join(root,'test-firefox-container-server.mjs')],{stdio:'ignore'});let owned=false;let execute;
const report={ok:false,tools:0,measurements:[],cleanup:false};
try{
for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:48765/phase0-probe/',{signal:AbortSignal.timeout(300)})).ok)break;}catch{}await delay(100);}
const loaded=await discoverAndLoadExtensions([fileURLToPath(new URL('../../extensions/pi-firefox/src/index.ts',import.meta.url))],directory,directory);assert.deepEqual(loaded.errors,[]);const tools=loaded.extensions[0].tools;report.tools=tools.size;assert.equal(tools.size,16);
const context={cwd:directory,sessionManager:{getSessionId:()=>`wire-${process.pid}`},hasUI:false};
execute=async(name,args)=>{const result=await tools.get(name).definition.execute(`wire-${name}`,args,undefined,undefined,context);const data=result.structuredContent;assert.equal(data.ok,true,JSON.stringify(data));assert.deepEqual(data,result.details);const modelText=result.content.filter(item=>item.type==='text').map(item=>item.text).join('');assert.equal(modelText,JSON.stringify(data));report.measurements.push({tool:name,mode:args.mode??null,modelTextBytes:Buffer.byteLength(modelText),coreResultBytes:Buffer.byteLength(JSON.stringify(data)),nativeEnvelopeBytes:Buffer.byteLength(JSON.stringify(result))});return data;};
await execute('ff_status',{});await execute('ff_session_ensure',{session:'wire',windowId,url:'http://127.0.0.1:48765/phase0-probe/',containerId:'firefox-default'});owned=true;
await execute('ff_read',{session:'wire'});await execute('ff_read',{session:'wire',mode:'full',maxBytes:4000});await execute('ff_extract',{session:'wire',fields:{title:{type:'text'}}});
await execute('ff_session_close',{session:'wire'});owned=false;report.ok=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
if(owned&&execute)await execute('ff_session_close',{session:'wire'}).catch(()=>undefined);
if(server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
const after=(await cli('tab','--window',`id:${windowId}`)).tabs.map(tab=>tab.id);report.cleanup=before.length===after.length&&before.every(id=>after.includes(id));if(!report.cleanup)process.exitCode=1;
await rm(directory,{recursive:true,force:true});await writeFile(join(root,'report-firefox-pi-wire-live.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}

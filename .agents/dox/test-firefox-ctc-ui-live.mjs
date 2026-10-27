#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
const root=fileURLToPath(new URL('./',import.meta.url));
const pendingPath=join(root,'report-firefox-ctc-pending.json');
const run=promisify(execFile);const cli=async(...args)=>JSON.parse((await run('firefox-cli',[...args,'--json'],{timeout:15000})).stdout);
const windows=(await cli('window')).windows.filter(value=>!value.private);assert.equal(windows.length,1);
const windowId=windows[0].id;const before=(await cli('tab','--window',`id:${windowId}`)).tabs.map(value=>value.id);
const directory=await mkdtemp(join(tmpdir(),'firefox-ctc-ui-'));const approvalPath=join(directory,'approval.json');
const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify({statePath:join(directory,'sessions.json'),namespace:'ctc-ui-live',agentId:`test-${process.pid}`,logLevel:'off',containerNames:{'firefox-container-6':'FFX Test Work'}}),{mode:0o600});process.env.FFX_CONFIG=configPath;
const server=spawn(process.execPath,[join(root,'test-firefox-container-server.mjs')],{stdio:'ignore'});
const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),110000);
const report={ok:false,uiPrompt:false,adopted:false,cleanup:false};let tools;let owned=false;
try{
 for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:48765/phase0-probe/',{signal:AbortSignal.timeout(300)})).ok)break;}catch{}await delay(100);}
 const loaded=await discoverAndLoadExtensions([fileURLToPath(new URL('../../extensions/pi-firefox/src/index.ts',import.meta.url))],directory,directory);assert.deepEqual(loaded.errors,[]);tools=loaded.extensions[0].tools;
 const context={cwd:directory,sessionManager:{getSessionId:()=>`ctc-ui-${process.pid}`},hasUI:true,ui:{confirm:async(title,message,options)=>{
 report.uiPrompt=true;const candidate=JSON.parse(message.slice(message.indexOf('{')));
 await writeFile(pendingPath,JSON.stringify({pid:process.pid,title,candidate,approvalPath},null,2),{mode:0o600});
 while(!options?.signal?.aborted){try{return JSON.parse(await readFile(approvalPath,'utf8')).approve===true;}catch{}await delay(100);}
 return false;
 }}};
 const execute=async(name,args,signal)=>{const result=await tools.get(name).definition.execute(`ctc-${name}`,args,signal,undefined,context);assert.deepEqual(result.details,result.structuredContent);return result.structuredContent;};
 const result=await execute('ff_session_ensure',{session:'work',windowId,url:'http://127.0.0.1:48765/pi-firefox-test/work/',containerId:'firefox-container-6'},controller.signal);assert.equal(result.ok,true,JSON.stringify(result));owned=true;report.adopted=true;report.container=result.container.cookieStoreId;
 const read=await execute('ff_read',{session:'work'});assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.container.cookieStoreId,'firefox-container-6');assert.ok(read.result.title.includes('Work test route'));report.ok=true;
 const close=await execute('ff_session_close',{session:'work'});assert.equal(close.ok,true,JSON.stringify(close));owned=false;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 clearTimeout(timer);controller.abort();
 if(owned&&tools){const context={cwd:directory,sessionManager:{getSessionId:()=>`ctc-ui-${process.pid}`},hasUI:false};await tools.get('ff_session_close').definition.execute('ctc-cleanup',{session:'work'},undefined,undefined,context);}
 if(server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
 const after=(await cli('tab','--window',`id:${windowId}`)).tabs.map(value=>value.id);report.cleanup=before.length===after.length&&before.every(id=>after.includes(id));
 await writeFile(join(root,'report-firefox-ctc-ui-live.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 await rm(pendingPath,{force:true});await rm(directory,{recursive:true,force:true});console.log(JSON.stringify(report));
}

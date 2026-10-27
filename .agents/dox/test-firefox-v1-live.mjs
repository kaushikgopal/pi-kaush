#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFirefoxAutomation } from '@pi-kaush/firefox-agent-core';
const run=promisify(execFile);
const base='http://127.0.0.1:48765';
const configuration=(directory)=>({binaryPath:'firefox-cli',timeoutMs:10000,maxOutputBytes:128000,summaryMaxBytes:4000,scopedMaxBytes:16000,settleTimeoutMs:2000,statePath:join(directory,'sessions.json'),screenshotDir:join(directory,'screenshots'),logPath:join(directory,'events.jsonl'),logLevel:'off',namespace:'v1-live-suite',agentId:basename(directory),defaultSession:'default',defaultContainerId:null,containerNames:{'firefox-container-6':'FFX Test Work','firefox-container-7':'FFX Test Personal'}});
if(process.argv[2]==='--resume'){
 const app=createFirefoxAutomation({config:configuration(process.argv[3])});
 const result=await app.execute('ff_session_ensure',{session:'primary'});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.tab.id,Number(process.argv[4]));
 console.log(JSON.stringify({ok:true,reusedTabId:result.tab.id}));process.exit(0);
}
const cli=async(...args)=>JSON.parse((await run('firefox-cli',[...args,'--json'],{timeout:15000,maxBuffer:128000})).stdout);
const windows=(await cli('window')).windows.filter(window=>!window.private);assert.equal(windows.length,1,'The fixture requires one normal window.');
const windowId=windows[0].id;
const before=(await cli('tab','--window',`id:${windowId}`)).tabs.map(tab=>tab.id);
const directory=await mkdtemp(join(tmpdir(),'firefox-v1-live-'));
const app=createFirefoxAutomation({config:configuration(directory)});
const records=[];const owned=new Map();let requests=0;
const server=createServer((request,response)=>{
 const path=new URL(request.url,base).pathname;
 if(path==='/phase-final/app.js'){
 response.writeHead(200,{'content-type':'text/javascript'});response.end("document.querySelector('#save').addEventListener('click',()=>{document.querySelector('#saved').textContent='Saved: '+document.querySelector('#note').value;fetch('/phase-final/ping?synthetic=true');});");return;
 }
 if(path==='/phase-final/ping'){requests++;response.writeHead(200,{'content-type':'application/json'});response.end('{"synthetic":true}');return;}
 response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
 response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Firefox v1 synthetic fixture</title><script src="/phase-final/app.js" defer></script></head><body><main><h1>Firefox v1 synthetic fixture</h1><label for="note">Test text</label><input id="note" autocomplete="off"><button id="save" type="button">Save demo</button><p role="status" aria-label="Total">12.50</p><p id="saved" role="status">Ready</p><a href="/phase-final/next/">Next fixture</a></main></body></html>');
});
server.listen(48765,'127.0.0.1');await once(server,'listening');
const call=async(name,args={})=>{const start=Date.now();const result=await app.execute(name,args);records.push({name,ok:result.ok,code:result.code??null,bytes:Buffer.byteLength(JSON.stringify(result)),ms:Date.now()-start});assert.equal(result.ok,true,`${name}: ${JSON.stringify(result)}`);return result;};
const report={ok:false,cycles:0,records,cleanup:false};
try{
 const ensured=await call('ff_session_ensure',{session:'primary',windowId,url:base+'/phase-final/',containerId:'firefox-default'});owned.set('primary',ensured.tab.id);assert.ok(!before.includes(ensured.tab.id));
 const summary=await call('ff_read',{session:'primary'});assert.ok(!/\be\d+\b/.test(JSON.stringify(summary.result)));
 const full=await call('ff_read',{session:'primary',mode:'full',maxBytes:4000});assert.match(full.result.text,/\be\d+/);
 const located=await call('ff_locate',{session:'primary',role:'button',name:'Save demo',exact:true});
 await call('ff_read',{session:'primary',mode:'scoped',ref:located.result.ref,maxBytes:2000});
 const extracted=await call('ff_extract',{session:'primary',fields:{total:{type:'number',selector:{role:'status',name:'Total',exact:true}},title:{type:'text'}}});assert.equal(extracted.result.total.value,12.5);
 await call('ff_network',{session:'primary'});
 for(let i=1;i<=20;i++){
 const workflow=await call('ff_do',{session:'primary',allowWrite:true,args:{note:`Cycle ${i}`},steps:[{type:'fill',locate:{role:'textbox',name:'Test text',exact:true},value:'%{arg.note}'},{type:'click',locate:{role:'button',name:'Save demo',exact:true}},{type:'wait',text:`Saved: Cycle ${i}`,timeoutMs:2000},{type:'extract',fields:{total:{type:'number',selector:{role:'status',name:'Total',exact:true}}}}]});
 assert.equal(workflow.result.result.total.value,12.5);report.cycles=i;
 }
 const network=await call('ff_network',{session:'primary',origin:base,maxEntries:20,urlsOnly:true});assert.ok(network.result.entries.length>0);assert.ok(!JSON.stringify(network).includes('synthetic=true'));
 const shot=await call('ff_screenshot',{session:'primary'});const png=await readFile(shot.result.path);assert.equal(png.readUInt32BE(0),0x89504e47);report.screenshot={bytes:png.length,width:png.readUInt32BE(16),height:png.readUInt32BE(20),resized:shot.result.resized};
 const child=await run(process.execPath,[fileURLToPath(import.meta.url),'--resume',directory,String(ensured.tab.id)],{timeout:15000});assert.equal(JSON.parse(child.stdout).reusedTabId,ensured.tab.id);report.restartReuse=true;
 const second=await call('ff_session_ensure',{session:'secondary',windowId,url:base+'/phase-final/second/',containerId:'firefox-default'});owned.set('secondary',second.tab.id);assert.notEqual(second.tab.id,ensured.tab.id);
 const parallel=await Promise.all(['primary','secondary'].map(session=>call('ff_read',{session})));assert.ok(parallel.every(value=>value.ok));
 const dry=await call('ff_session_cleanup',{idleAfterMs:1});assert.equal(dry.result.dryRun,true);assert.equal(dry.result.closed.length,0);
 report.syntheticRequests=requests;report.ok=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 for(const[session,id]of owned){const result=await app.execute('ff_session_close',{session});if(!result.ok)records.push({name:'cleanup',ok:false,code:result.code,tabId:id});}
 const after=(await cli('tab','--window',`id:${windowId}`)).tabs.map(tab=>tab.id);
 report.cleanup=before.length===after.length&&before.every(id=>after.includes(id));if(!report.cleanup)process.exitCode=1;
 await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
 await writeFile(fileURLToPath(new URL('./report-firefox-v1-live.json',import.meta.url)),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({ok:report.ok,cycles:report.cycles,cleanup:report.cleanup,error:report.error??null,records:records.length,screenshot:report.screenshot??null,restartReuse:report.restartReuse??false}));
}

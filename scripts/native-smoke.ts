import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AttachmentReads } from '../apps/server/src/claude/attachment-reads.js';
import { ClaudeProtocol } from '../apps/server/src/claude/protocol.js';
// No model calls or user settings changes. Background execution finishes from the NDJSON result and natural exit.
const host = process.env.CLAUDE_DESK_NATIVE_HOST || join(process.cwd(), 'dist/native/ClaudeTerminalHost.exe');
const exe = process.execPath;
const deadline = Date.now() + 60000;
async function fixture(script: string, cancel = false) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-native-fixture-'));
  try {
    const file = join(dir,'fixture.cjs'); await writeFile(file, script);
    const task = join(dir,'task.json');
    await writeFile(task,JSON.stringify({ executable: exe,cwd:dir,arguments:[file,'中文 "quoted" tail\\'],environment:process.env,sessionId:randomUUID(),question:'管道输入',mode:'hidden' }));
    const child = spawn(host,['--task',task],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='',ended=false,timedOut=false,failure:Error|undefined;
    child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    const closed = new Promise<number|null>(resolve=>{
      child.once('error',error=>{failure=error;});
      child.once('close',code=>{ended=true;resolve(code);});
    });
    const timeout = setTimeout(()=>{timedOut=true;child.kill();},Math.max(1,deadline-Date.now()));
    const timer = cancel ? setTimeout(()=>void writeFile(join(dir,'cancel'),'').catch(()=>child.kill()),500) : undefined;
    try {
      const code = await closed;
      if(failure) throw failure;
      assert.ok(!timedOut,'Native fixtures exceeded the 60-second deadline');
      const descendant = await readFile(join(dir,'descendant.pid'),'utf8').catch(()=>undefined);
      if(descendant) assert.throws(()=>process.kill(Number(descendant),0),{code:'ESRCH'},'Job descendants must exit before completion');
      return {code,out,err};
    } finally {
      clearTimeout(timeout);if(timer) clearTimeout(timer);
      if(!ended) { child.kill();await closed; }
    }
  } finally { await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100}); }
}
const ok = await fixture('console.log(process.argv[2]); console.log(require("fs").readFileSync(0,"utf8"));');
assert.equal(ok.code,0,ok.err);assert.ok(ok.out.includes('中文 "quoted" tail\\'));assert.ok(ok.out.includes('管道输入'));
const descendant = 'const child=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"inherit"});require("fs").writeFileSync("descendant.pid",String(child.pid));child.unref();';
const inherited = await fixture(descendant+'console.log("parent done");');
assert.equal(inherited.code,0,inherited.err); assert.ok(inherited.out.includes('parent done'));
const cancelled = await fixture(descendant+'setTimeout(()=>{},30000);',true);assert.notEqual(cancelled.code,0);
const automatic = await fixture('const question=require("fs").readFileSync(0,"utf8");console.log(JSON.stringify({type:"system",subtype:"init",tools:[],mcp_servers:[],permissionMode:"auto"}));console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:question,session_id:"fixture"}));');
const protocol = new ClaudeProtocol();protocol.push(Buffer.from(automatic.out));assert.equal(protocol.finish(automatic.code!).answer,'管道输入');

async function visibleTranscript(afterQuestion: object[], lastAssistantMessage: string, delayCompletion = 0, streaming = false) {
  const dir = await mkdtemp(join(tmpdir(),'desk-visible-fixture-'));
  try {
    const sessionId=randomUUID(),question='可见终端测试问题';
    const transcript=join(dir,`${sessionId}.jsonl`),script=join(dir,'visible.cjs');
    const rows=[{type:'user',sessionId,message:{content:question}},...afterQuestion.map(row=>({sessionId,...row})),{type:'system',sessionId,subtype:'stop_hook_summary',preventedContinuation:false},{type:'system',sessionId,subtype:'turn_duration',durationMs:200}];
    const hook={hook_event_name:'Stop',session_id:sessionId,transcript_path:transcript,last_assistant_message:lastAssistantMessage};
    // A real terminal input stream stays alive until the host automatically sends /exit.
    // Delayed completion proves Stop alone cannot prematurely finish a running turn.
    await writeFile(script,`const tty=require('tty');if(![0,1,2].every(fd=>tty.isatty(fd)))process.exit(9);
const fs=require('fs'),path=require('path');const [dir,transcript,rowsFile,hook,delay,streaming]=process.argv.slice(2),rows=JSON.parse(fs.readFileSync(rowsFile,'utf8'));let completed=false;
process.on('uncaughtException',error=>{fs.writeFileSync(path.join(dir,'fixture-error.txt'),error.stack);process.exit(1);});
const append=entry=>fs.appendFileSync(transcript,JSON.stringify(entry)+'\\n');
if(streaming==='true'){const progress={type:'system',sessionId:rows[0].sessionId,subtype:'fixture_progress',padding:'x'.repeat(80)};fs.writeFileSync(transcript,[rows[0],...Array(20000).fill(progress)].map(JSON.stringify).join('\\n')+'\\n');fs.writeFileSync(path.join(dir,'stop.json'),hook);const writer=setInterval(()=>append(progress),5);setTimeout(()=>{clearInterval(writer);rows.slice(1).forEach(append);completed=true;},Number(delay));}
else if(Number(delay)>0){fs.writeFileSync(transcript,JSON.stringify(rows[0])+'\\n');fs.writeFileSync(path.join(dir,'stop.json'),hook);setTimeout(()=>{rows.slice(1).forEach(append);completed=true;},Number(delay));}
else {fs.writeFileSync(transcript,rows.map(JSON.stringify).join('\\n')+'\\n');fs.writeFileSync(path.join(dir,'stop.json'),hook);completed=true;}
require('readline').createInterface({input:process.stdin}).on('line',line=>{if(line.trim()==='/exit'){if(!completed)process.exit(12);append({type:'user',sessionId:rows[0].sessionId,message:{content:'<command-name>/exit</command-name>\\n<command-message>exit</command-message>\\n<command-args></command-args>'}});append({type:'user',sessionId:rows[0].sessionId,message:{content:'<local-command-stdout>See ya!</local-command-stdout>'}});process.exit(0);}});
setTimeout(()=>process.exit(8),5000);`);
    const rowsFile=join(dir,'fixture-rows.json'); await writeFile(rowsFile,JSON.stringify(rows));
    const task=join(dir,'visible-task.json');
    await writeFile(task,JSON.stringify({executable:exe,cwd:dir,arguments:[script,dir,transcript,rowsFile,JSON.stringify(hook),String(delayCompletion),String(streaming)],environment:process.env,sessionId,question,mode:'visible'}));
    const visible=spawn(host,['--task',task],{shell:false,detached:true,windowsHide:true,stdio:'ignore'});
    const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{visible.kill();reject(new Error('Visible fixture timed out'));},10000);visible.once('error',error=>{clearTimeout(timer);reject(error);});visible.once('close',result=>{clearTimeout(timer);resolve(result);});});
    return {code,error:(await Promise.all(['error.txt','fixture-error.txt'].map(file=>readFile(join(dir,file),'utf8').catch(()=>'')))).join('\n'),result:await readFile(join(dir,'result.json'),'utf8').then(JSON.parse).catch(()=>undefined),sessionId};
  } finally { await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100}); }
}

const collectorDir=await mkdtemp(join(tmpdir(),'desk-collector-fixture-'));
try {
  const hook={hook_event_name:'Stop',session_id:'collector',transcript_path:join(collectorDir,'collector.jsonl'),last_assistant_message:'收集测试'};
  const collector=spawn(host,['--collect',collectorDir],{shell:false,windowsHide:true,stdio:['pipe','ignore','pipe']});
  let collectError='';collector.stderr.on('data',chunk=>collectError+=chunk);collector.stdin.end(JSON.stringify(hook));
  assert.equal(await new Promise(resolve=>collector.once('close',resolve)),0,collectError);
  assert.deepEqual(JSON.parse(await readFile(join(collectorDir,'stop.json'),'utf8')),hook);
  const failure = { ...hook, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'Artificial model failure' };
  const failedCollector = spawn(host,['--collect',collectorDir],{shell:false,windowsHide:true,stdio:['pipe','ignore','pipe']});
  failedCollector.stdin.end(JSON.stringify(failure));
  assert.equal(await new Promise(resolve=>failedCollector.once('close',resolve)),0);
  assert.deepEqual(JSON.parse(await readFile(join(collectorDir,'failure.json'),'utf8')),failure);
  assert.deepEqual(JSON.parse(await readFile(join(collectorDir,'stop.json'),'utf8')),hook,'Failure must not replace a Stop event');
} finally { await rm(collectorDir,{recursive:true,force:true,maxRetries:20,retryDelay:100}); }

const literalAnswer='正常答案可包含 [Request interrupted by user] 和 {"subtype":"error"} 文字';
const literal=await visibleTranscript([{type:'assistant',message:{content:[{type:'text',text:literalAnswer}],stop_reason:'end_turn'}}],literalAnswer);
assert.equal(literal.code,0,literal.error);assert.deepEqual(literal.result,{answer:literalAnswer,sessionId:literal.sessionId,exitCode:0});

const delayed=await visibleTranscript([{type:'assistant',message:{content:[{type:'text',text:'延迟写入的完整答案'}],stop_reason:'end_turn'}}],'延迟写入的完整答案',900);
assert.equal(delayed.code,0,delayed.error);assert.equal(delayed.result.answer,'延迟写入的完整答案');

const streamedAnswer='并发写入的完整答案';
const streamed=await visibleTranscript([{type:'assistant',message:{content:[{type:'text',text:streamedAnswer}],stop_reason:'end_turn'}}],streamedAnswer,900,true);
assert.equal(streamed.code,0,streamed.error);assert.equal(streamed.result.answer,streamedAnswer);

const recoveredAnswer='后续完整答案';
const recovered=await visibleTranscript([
  {type:'assistant',message:{content:[{type:'text',text:'旧答案'}],stop_reason:'end_turn'}},
  {type:'system',subtype:'stop_hook_summary',preventedContinuation:true},
  {type:'assistant',message:{content:[{type:'text',text:recoveredAnswer}],stop_reason:'end_turn'}},
],recoveredAnswer);
assert.equal(recovered.code,0,recovered.error);assert.deepEqual(recovered.result,{answer:recoveredAnswer,sessionId:recovered.sessionId,exitCode:0});

const additional=await visibleTranscript([
  {type:'assistant',message:{content:[{type:'text',text:'原回答'}],stop_reason:'end_turn'}},
  {type:'user',message:{content:'追加问题'}},
],'原回答');
assert.notEqual(additional.code,0,'Additional business question must fail');assert.match(additional.error,/Additional user turn/);

for (const [label,row] of [
  ['isApiErrorMessage',{type:'assistant',isApiErrorMessage:true}],
  ['interruptedMessageId',{type:'system',interruptedMessageId:'interrupted'}],
  ['system error',{type:'system',subtype:'error'}],
] as const) {
  const failed=await visibleTranscript([row],'不应成功');
  assert.notEqual(failed.code,0,`${label} must fail`);assert.match(failed.error,/Turn interrupted or failed/,label);
}
console.log('Native fixture passed: Unicode/quoted args, UTF-8 pipes, automatic NDJSON, Stop collection, automatic visible completion without manual /exit, delayed transcript validation and descendant cancellation. No model or visible window used.');

const imageEvents = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-image', name: 'Read', input: { file_path: 'fixture-image.png' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(3 * 1024 * 1024) } }] }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '图片附件读取完成' }], stop_reason: 'end_turn' } },
];
const imageVisible = await visibleTranscript(imageEvents, '图片附件读取完成');
assert.equal(imageVisible.code, 0, imageVisible.error); assert.equal(imageVisible.result.answer, '图片附件读取完成');

const imageHidden = await fixture('const fs=require("fs");fs.readFileSync(0,"utf8");console.log(JSON.stringify({type:"system",subtype:"init",tools:["Read"],mcp_servers:[],permissionMode:"auto"}));console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Read",id:"read",input:{file_path:"fixture-image.png"}}]}}));console.log(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"read",content:[{type:"image",source:{type:"base64",media_type:"image/png",data:"A".repeat(3*1024*1024)}}]}]}}));console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"图片已读取",session_id:"fixture"}));');
const imageReads = new AttachmentReads([{ id: 'image', name: '图.png', paths: ['fixture-image.png'] }]);
const imageProtocol = new ClaudeProtocol(() => {}, 64*1024*1024, 16*1024*1024, undefined, event => imageReads.observe(event)); imageProtocol.push(Buffer.from(imageHidden.out));
assert.equal(imageProtocol.finish(imageHidden.code!).answer, '图片已读取'); assert.deepEqual(imageReads.completedIds(), ['image']);
console.log('Native multimodal transcript and read receipts passed');

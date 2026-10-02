import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ClaudeProtocol } from '../apps/server/src/claude/protocol.js';
// No model calls or user settings changes. Background execution finishes from the NDJSON result and natural exit.
const host = process.env.CLAUDE_DESK_NATIVE_HOST || join(process.cwd(), 'dist/native/ClaudeTerminalHost.exe');
const exe = process.execPath;
const deadline = Date.now() + 15000;
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
      assert.ok(!timedOut,'Native fixtures exceeded the 15-second deadline');
      const descendant = await readFile(join(dir,'descendant.pid'),'utf8').catch(()=>undefined);
      if(descendant) assert.throws(()=>process.kill(Number(descendant),0),{code:'ESRCH'},'Job descendants must exit before completion');
      return {code,out,err};
    } finally {
      clearTimeout(timeout);if(timer) clearTimeout(timer);
      if(!ended) { child.kill();await closed; }
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
}
const ok = await fixture('console.log(process.argv[2]); console.log(require("fs").readFileSync(0,"utf8"));');
assert.equal(ok.code,0,ok.err);assert.ok(ok.out.includes('中文 "quoted" tail\\'));assert.ok(ok.out.includes('管道输入'));
const descendant = 'const child=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"inherit"});require("fs").writeFileSync("descendant.pid",String(child.pid));child.unref();';
const inherited = await fixture(descendant+'console.log("parent done");');
assert.equal(inherited.code,0,inherited.err); assert.ok(inherited.out.includes('parent done'));
const cancelled = await fixture(descendant+'setTimeout(()=>{},30000);',true);assert.notEqual(cancelled.code,0);
const automatic = await fixture('const question=require("fs").readFileSync(0,"utf8");console.log(JSON.stringify({type:"system",subtype:"init",tools:[],mcp_servers:[],permissionMode:"auto"}));console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:question,session_id:"fixture"}));');
const protocol = new ClaudeProtocol();protocol.push(Buffer.from(automatic.out));assert.equal(protocol.finish(automatic.code!).answer,'管道输入');

async function visibleTranscript(afterQuestion: object[], lastAssistantMessage: string) {
  const dir = await mkdtemp(join(tmpdir(),'desk-visible-fixture-'));
  try {
    const sessionId=randomUUID(),question='可见终端测试问题';
    const transcript=join(dir,`${sessionId}.jsonl`),script=join(dir,'visible.cjs');
    const rows=[{type:'user',sessionId,message:{content:question}},...afterQuestion.map(row=>({sessionId,...row})),{type:'user',sessionId,isMeta:true,message:{content:'<local-command-caveat>local command</local-command-caveat>'}},{type:'user',sessionId,message:{content:'<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>'}},{type:'user',sessionId,message:{content:'<local-command-stdout>See ya!</local-command-stdout>'}}];
    const hook={hook_event_name:'Stop',session_id:sessionId,transcript_path:transcript,last_assistant_message:lastAssistantMessage};
    await writeFile(script,`const tty=require('tty');if(![0,1,2].every(fd=>tty.isatty(fd)))process.exit(9);const fs=require('fs');const [dir,transcript,rows,hook]=process.argv.slice(2);fs.writeFileSync(transcript,JSON.parse(rows).map(JSON.stringify).join('\\n')+'\\n');fs.writeFileSync(require('path').join(dir,'stop.json'),hook);`);
    const task=join(dir,'visible-task.json');
    await writeFile(task,JSON.stringify({executable:exe,cwd:dir,arguments:[script,dir,transcript,JSON.stringify(rows),JSON.stringify(hook)],environment:process.env,sessionId,question,mode:'visible'}));
    const visible=spawn(host,['--task',task],{shell:false,detached:true,windowsHide:true,stdio:'ignore'});
    const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{visible.kill();reject(new Error('Visible fixture timed out'));},10000);visible.once('error',error=>{clearTimeout(timer);reject(error);});visible.once('close',result=>{clearTimeout(timer);resolve(result);});});
    return {code,error:await readFile(join(dir,'error.txt'),'utf8').catch(()=>''),result:await readFile(join(dir,'result.json'),'utf8').then(JSON.parse).catch(()=>undefined),sessionId};
  } finally { await rm(dir,{recursive:true,force:true}); }
}

const collectorDir=await mkdtemp(join(tmpdir(),'desk-collector-fixture-'));
try {
  const hook={hook_event_name:'Stop',session_id:'collector',transcript_path:join(collectorDir,'collector.jsonl'),last_assistant_message:'收集测试'};
  const collector=spawn(host,['--collect',collectorDir],{shell:false,windowsHide:true,stdio:['pipe','ignore','pipe']});
  let collectError='';collector.stderr.on('data',chunk=>collectError+=chunk);collector.stdin.end(JSON.stringify(hook));
  assert.equal(await new Promise(resolve=>collector.once('close',resolve)),0,collectError);
  assert.deepEqual(JSON.parse(await readFile(join(collectorDir,'stop.json'),'utf8')),hook);
} finally { await rm(collectorDir,{recursive:true,force:true}); }

const literalAnswer='正常答案可包含 [Request interrupted by user] 和 {"subtype":"error"} 文字';
const literal=await visibleTranscript([{type:'assistant',message:{content:[{type:'text',text:literalAnswer}],stop_reason:'end_turn'}}],literalAnswer);
assert.equal(literal.code,0,literal.error);assert.deepEqual(literal.result,{answer:literalAnswer,sessionId:literal.sessionId,exitCode:0});

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
console.log('Native fixture passed: Unicode/quoted args, UTF-8 pipes, automatic NDJSON, Stop collection, visible transcript validation and descendant cancellation. No model or visible window used.');

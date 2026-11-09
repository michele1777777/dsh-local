/** Local OS adapters are injected; tests never modify the user's actual clipboard. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyRequests, copyText, osc52, readClipboardImage } from '../src/clipboard.ts'
import { runProcess } from '../src/local-process.ts'
import { editorCommand, editorWords, editDraft } from '../src/external-editor.ts'
import { safeHref, fileHref, osc8, linkRows } from '../src/links.ts'
import { attention, terminalTitle, notification } from '../src/terminal-signals.ts'
import { row, textOfRow } from '../src/rich-text.ts'
const raw = 'Invoke-RestMethod `\r\n  -Uri "https://api.example.test/v1" `\r\n  -Body @{ label = "東京 👩🏽‍💻" }\r\n'
test('Windows clipboard script is fixed; original Unicode/CRLF data only travels over stdin', async () => {
  const calls=[];const result=await copyText(raw,{platform:'win32',env:{},run:async request=>{calls.push(request);return Buffer.alloc(0)}})
  assert.equal(result.confirmed,true);assert.equal(calls[0].command,'powershell.exe')
  assert.equal(Buffer.from(calls[0].input,'base64').toString('utf8'),raw)
  assert.ok(!calls[0].args.join(' ').includes('Invoke-RestMethod'))
  assert.match(Buffer.from(calls[0].args.at(-1),'base64').toString('utf16le'),/SetText\(\$s\)/)
})
test('clipboard adapters route Linux Wayland/X11, macOS and WSL correctly',()=>{
  assert.deepEqual(copyRequests(raw,'linux',{WAYLAND_DISPLAY:'1',DISPLAY:':0'}).map(r=>r.command),['wl-copy','xclip','xsel'])
  assert.equal(copyRequests(raw,'darwin',{})[0].command,'pbcopy')
  assert.equal(copyRequests(raw,'linux',{WSL_INTEROP:'1'})[0].command,'powershell.exe')
  assert.deepEqual(copyRequests(raw,'linux',{SSH_CONNECTION:'remote',DISPLAY:':0'}),[])
})
test('OSC52 fallback is explicit and never reports confirmed native success',async()=>{
  const sent=[];const result=await copyText(raw,{platform:'linux',env:{SSH_TTY:'tty'},write:text=>sent.push(text)})
  assert.equal(result.confirmed,false);assert.equal(result.transport,'OSC 52')
  assert.equal(sent[0],`\x1b]52;c;${Buffer.from(raw).toString('base64')}\x07`)
  assert.ok(osc52(raw,true).startsWith('\x1bPtmux;\x1b\x1b]52'))
  assert.throws(()=>osc52('x'.repeat(100001)),/too large/)
})
test('clipboard fallback respects native-only, off and cancellation',async()=>{
  let writes=0
  await assert.rejects(copyText(raw,{platform:'linux',env:{DSH_TUI_CLIPBOARD:'native'},write(){writes++}}),/Clipboard unavailable/)
  await assert.rejects(copyText(raw,{env:{DSH_TUI_CLIPBOARD:'off'}}),/disabled/)
  const abort=new AbortController();abort.abort()
  await assert.rejects(copyText(raw,{signal:abort.signal,env:{},write(){writes++}}))
  assert.equal(writes,0)
})
function png(){const bytes=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(1920,16);bytes.writeUInt32BE(1080,20);return bytes}
for(const platform of ['win32','darwin','linux'])test(`clipboard image ${platform} validates bytes and returns no uploaded file`,async()=>{
  const value=png();const image=await readClipboardImage(1024,{platform,env:{WAYLAND_DISPLAY:'1'},run:async()=>platform==='linux'?value:Buffer.from(value.toString('base64'))})
  assert.deepEqual(image.data,value);assert.equal(image.mediaType,'image/png');assert.equal(image.width,1920);assert.equal(image.height,1080)
})
test('image helpers reject unsupported remote, empty, non-PNG and oversize output',async()=>{
  await assert.rejects(readClipboardImage(1024,{env:{SSH_TTY:'1'}}),/SSH/)
  await assert.rejects(readClipboardImage(0),/limit/)
  await assert.rejects(readClipboardImage(1024,{platform:'linux',env:{WAYLAND_DISPLAY:'1'},run:async()=>Buffer.from('not image')}),/PNG/)
  await assert.rejects(readClipboardImage(16,{platform:'linux',env:{DISPLAY:':0'},run:async()=>png()}),/limit/)
})
test('bounded process helper passes stdin literally, catches failures/timeouts/output limits',async()=>{
  assert.equal((await runProcess({command:process.execPath,args:['-e','process.stdin.pipe(process.stdout)'],input:raw})).toString(),raw)
  await assert.rejects(runProcess({command:process.execPath,args:['-e','process.exit(3)']}),/exited 3/)
  await assert.rejects(runProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:35}),/timed out/)
  await assert.rejects(runProcess({command:process.execPath,args:['-e','process.stdout.write("x".repeat(50000))'],maxBytes:20}),/allowed size/)
  const abort=new AbortController();const task=runProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],signal:abort.signal});abort.abort();await assert.rejects(task,/cancelled/)
})
test('editor argv preserves quotes/Windows paths, waits for GUI editors and never shell-evaluates draft content',()=>{
  assert.deepEqual(editorWords('"C:\\Program Files\\Code\\Code.exe" --wait'),['C:\\Program Files\\Code\\Code.exe','--wait'])
  assert.deepEqual(editorWords('vim -f'),['vim','-f'])
  assert.throws(()=>editorWords('"bad'),/Unclosed/)
  const request=editorCommand('/tmp/prompt.md',{platform:'linux',env:{VISUAL:'code --new-window'}})
  assert.deepEqual(request.args,['--new-window','--wait','/tmp/prompt.md'])
  assert.equal(editorCommand('C:\\Temp\\prompt.md',{platform:'win32',env:{EDITOR:'"C:\\Tools\\editor.cmd" --wait'}}).command,'powershell.exe')
})
test('external editor round-trip uses a private temp file, preserves exact new text and removes it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-editor-test-'));const script=join(dir,'editor.mjs'), marker=join(dir,'path.txt')
  try {
    await writeFile(script,`import {readFile,writeFile} from 'node:fs/promises'; const p=process.argv[2]; await writeFile(${JSON.stringify(marker)},p);const text=await readFile(p,'utf8');await writeFile(p,text+'\\nchanged');`)
    const text=await editDraft(raw,{env:{...process.env,VISUAL:`"${process.execPath}" "${script}"`}})
    assert.equal(text,raw+'\nchanged')
    const path=await readFile(marker,'utf8');await assert.rejects(readFile(path),/ENOENT/)
  } finally {await rm(dir,{recursive:true,force:true})}
})
test('link protocols allow only safe browser URLs and generated local file targets',()=>{
  assert.equal(safeHref('javascript:alert(1)'),undefined);assert.equal(safeHref('file:///etc/passwd'),undefined)
  assert.equal(safeHref('https://example.com/\x1b]52;c;payload'),undefined)
  assert.equal(fileHref('src/auth.ts:183','/work/repo'),'file:///work/repo/src/auth.ts#L183')
  assert.equal(fileHref('src\\auth.ts:18:4','C:\\Projects\\repo'),'file:///C:/Projects/repo/src/auth.ts#L18C4')
  const linked=linkRows([row('See https://example.com/docs and src/auth.ts:183.')],'/work/repo',true)
  assert.equal(textOfRow(linked[0]),'See https://example.com/docs and src/auth.ts:183.')
  assert.equal(linked[0].spans.filter(part=>part.href).length,2)
  assert.ok(linkRows(linked,'/work/repo',false)[0].spans.every(part=>!part.href))
  assert.equal(osc8('open','javascript:foo'),'open')
  assert.match(osc8('open','https://example.com'),/^\x1b\]8;;https:/)
})
test('notifications derive transitions only, not resume/first paint; terminal titles are escaped',()=>{
  const idle={sessionId:'one',title:'Auth',running:false},running={...idle,running:true}
  assert.equal(attention(undefined,idle),undefined)
  assert.equal(attention(running,{...idle,sessionId:'two'}),undefined)
  assert.equal(attention(running,idle),'DSH · turn ended')
  const pending={...running,pendingId:'approval1',pendingKind:'approval'}
  assert.equal(attention(running,pending),'DSH · permission required');assert.equal(attention(pending,pending),undefined)
  const title=terminalTitle({...idle,title:'evil\x1b]52;c;bad\x07\ntext'})
  assert.equal((title.match(/\x07/g)||[]).length,1);assert.ok(!title.includes('\n'))
  assert.equal(notification('abc','off'),'');assert.equal(notification('abc','bell'),'\x07')
})

test('Windows GUI launchers resolve once; quoted names and custom executables are preserved',()=>{
  const request=editorCommand('C:\\Temp\\prompt.md',{platform:'win32',env:{VISUAL:'"code" --new-window'}})
  assert.equal(request.command,'powershell.exe')
  assert.deepEqual(JSON.parse(request.env.DSH_TUI_EDITOR_ARGV),['code.cmd','--new-window','--wait','C:\\Temp\\prompt.md'])
  assert.equal(editorCommand('C:\\Temp\\prompt.md',{platform:'win32',env:{VISUAL:'helix'}}).command,'helix')
})
test('external editor cancellation waits for child cleanup and removes scoped signal handler',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-editor-abort-')),script=join(dir,'editor.mjs'),marker=join(dir,'path.txt')
  const before=process.listenerCount('SIGINT'),abort=new AbortController()
  try {
    await writeFile(script,`import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)},process.argv[2]);setInterval(()=>{},1000);`)
    const task=editDraft('original draft',{signal:abort.signal,env:{...process.env,VISUAL:`"${process.execPath}" "${script}"`}})
    // Attach the rejection assertion before cancellation to avoid an unhandled rejection.
    const rejected=assert.rejects(task,/original draft was retained/)
    let path
    for(let i=0;i<100;i++){try{path=await readFile(marker,'utf8');break}catch{await new Promise(resolve=>setTimeout(resolve,10))}}
    assert.ok(path,'editor must have started');abort.abort();await rejected
    await assert.rejects(readFile(path),/ENOENT/)
    assert.equal(process.listenerCount('SIGINT'),before)
  } finally {abort.abort();await rm(dir,{recursive:true,force:true})}
})

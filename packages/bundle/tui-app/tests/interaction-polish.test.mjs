/** Deterministic input tests; native clipboard/editor processes are NOT triggered by this suite. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ui-loader.mjs',import.meta.url)
const { App }=await import('../src/app.tsx')
const { createHarness }=await import('./ui-harness.mjs')
const { createStore }=await import('../src/store.ts')
const { mergeCommands }=await import('../src/commands.ts')
const { widthOf,textOfRow }=await import('../src/rich-text.ts')
const { fixture,tool,approval,question }=await import('./fixtures.mjs')
const { MOUSE_ON,MOUSE_OFF }=await import('../src/mouse.ts')
function setup(overrides={},columns=160,height=35){
  const state=fixture(overrides),store=createStore(state),calls={copies:[],images:0,edits:[],commands:[],prompts:[],approvals:[],questions:[],errors:[],cancels:0}
  const controller={async submit(text){calls.prompts.push(text)},async runCommand(line){calls.commands.push(line)},
    async copyText(text){calls.copies.push(text);return {confirmed:true,transport:'test'}},async pasteImage(){calls.images++},async editPrompt(text){calls.edits.push(text);return text+'\nEDITED'},
    cancel(){calls.cancels++},exit(){},commands(){return mergeCommands([])},answerApproval(id,outcome){calls.approvals.push({id,outcome});store.update(s=>{s.pending=s.pending.filter(p=>p.id!==id)})},
    answerQuestion(id,answer){calls.questions.push({id,answer});store.update(s=>{s.pending=s.pending.filter(p=>p.id!==id)})},hint(text){store.update(s=>{s.hint=text})},closePicker(){store.update(s=>{s.picker=undefined})},report(error){calls.errors.push(String(error.message??error))}}
  const h=createHarness(App,store,controller,columns,height);return {h,store,controller,calls}
}
function target(h,kind,predicate=()=>true){
  for(const [y,row] of h.rows().entries()){let x=0;for(const part of row.spans){if(part.action?.kind===kind&&predicate(part.action))return {x,y,action:part.action};x+=widthOf(part.text)}}
  assert.fail(`No visible ${kind} target in:\n${h.text()}`)
}
async function click(h,kind,predicate){const p=target(h,kind,predicate);await h.key(`\x1b[<0;${p.x+1};${p.y+1}M`);await h.key(`\x1b[<0;${p.x+1};${p.y+1}m`);return p}
const assistant=text=>({kind:'assistant',id:'answer',reasoning:'',text,settled:true})
const transcript=items=>({...fixture().transcript,items})
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function clockTest(run){const original=Date.now;let now=10000;Date.now=()=>now;try{await run(ms=>now+=ms)}finally{Date.now=original}}
for(const columns of [40,80,160])test(`click Copy at ${columns} columns copies exact PowerShell, not painted gutters or wrapping`,async()=>{
  const raw='Invoke-RestMethod `\r\n  -Uri "https://example.com/東京" `\r\n  -Headers @{Authorization="Bearer token"}\r\n'
  const {h,calls}=setup({transcript:transcript([assistant('```powershell\r\n'+raw+'```')])},columns,35)
  try{await click(h,'copy-code');assert.deepEqual(calls.copies,[raw]);assert.match(h.text(),/Copied/);assert.deepEqual(calls.prompts,[]);assert.deepEqual(calls.commands,[])}finally{h.dispose()}
})
test('click targets remain mapped to the right code block after resize and scroll',async()=>{
  const {h,calls}=setup({transcript:transcript([assistant('```bash\necho FIRST\n```\n\n~~~json\n{"second":true}\n~~~')])})
  // The conversation re-wraps once the resize settles; until then it keeps its previous layout.
  try{await click(h,'copy-code',a=>a.block===1);h.resize(52,25);await delay(200);await h.flush();await click(h,'copy-code',a=>a.block===0);assert.deepEqual(calls.copies,['{"second":true}\n','echo FIRST\n'])}finally{h.dispose()}
})
test('a resize repaints the frame at once and re-wraps the conversation only once it settles',async()=>{
  const words=Array.from({length:40},(_,i)=>`word${i}`).join(' ')
  const {h}=setup({transcript:transcript([assistant(words)])},100,25)
  try{
    const lines=()=>h.text().split('\n').filter(line=>line.includes('word')).length
    const wide=lines()
    h.resize(50,25)
    assert.equal(h.rows().length,25)
    for(const line of h.rows())assert.ok(widthOf(textOfRow(line))<=49)
    assert.equal(lines(),wide)
    await delay(200);await h.flush()
    assert.ok(lines()>wide)
    for(const line of h.rows())assert.ok(widthOf(textOfRow(line))<=49)
  }finally{h.dispose()}
})
test('a resize gesture through the terminal claim re-wraps the conversation once, at its final width',async()=>{
  const words=Array.from({length:40},(_,i)=>`word${i}`).join(' ')
  const state=fixture({transcript:transcript([assistant(words)])}),store=createStore(state)
  const listeners=new Set(),live={columns:100,rows:25}
  const terminal={size:()=>({...live}),onResize(listener){listeners.add(listener);return ()=>{listeners.delete(listener)}}}
  const resize=(columns)=>{live.columns=columns;for(const listener of listeners)listener();h.render()}
  const spare=setup();spare.h.dispose()
  const h=createHarness(App,store,spare.controller,100,25,terminal)
  try{
    const lines=()=>h.text().split('\n').filter(line=>line.includes('word')).length
    const wide=lines()
    resize(80);await delay(60)
    resize(50);await delay(40);await h.flush()
    // 100 ms after the first step but only 40 ms after the last: no intermediate width may have been laid out.
    assert.equal(lines(),wide)
    for(const line of h.rows())assert.ok(widthOf(textOfRow(line))<=49)
    await delay(100);await h.flush()
    assert.ok(lines()>wide)
    for(const line of h.rows())assert.ok(widthOf(textOfRow(line))<=49)
    assert.equal(listeners.size,1)
  }finally{h.dispose()}
  assert.equal(listeners.size,0)
})
test('clipboard errors keep the draft and never report a successful copy',async()=>{
  const {h,controller,calls}=setup({transcript:transcript([assistant('```sh\nhello\n```')])})
  try{controller.copyText=async()=>{throw Error('clipboard missing')};await h.paste('draft');await click(h,'copy-code');assert.match(h.text(),/draft/);assert.deepEqual(calls.errors,['clipboard missing']);assert.ok(!h.text().includes('[Copied]'))}finally{h.dispose()}
})
test('OSC52 shows Sent rather than claiming Copied',async()=>{
  const {h,controller}=setup({transcript:transcript([assistant('```sh\necho test\n```')])})
  try{controller.copyText=async()=>({confirmed:false,transport:'OSC 52'});await click(h,'copy-code');assert.match(h.text(),/─ Sent *$/m);assert.doesNotMatch(h.text(),/Copied/)}finally{h.dispose()}
})
test('right clicks, release events, drag/modifier reports and mouse-off never activate Copy',async()=>{
  const {h,store,calls}=setup({transcript:transcript([assistant('```sh\nx\n```')])})
  try{const p=target(h,'copy-code');for(const [code,end] of [[2,'M'],[0,'m'],[32,'M'],[4,'M'],[16,'M']])await h.key(`\x1b[<${code};${p.x+1};${p.y+1}${end}`);store.update(s=>{s.mouse=false});h.render();await click(h,'copy-code');assert.deepEqual(calls.copies,[])}finally{h.dispose()}
})
test('tool click expands its output inline, never in a side pane, and retains the composer',async()=>{
  const output=Array.from({length:70},(_,i)=>'DETAIL-'+i).join('\n')
  const {h,calls}=setup({transcript:transcript([tool({result:{card:'terminal',output,exitCode:0}})])})
  try{await h.paste('unsent draft');assert.doesNotMatch(h.text(),/DETAIL-40/)
    // A side pane would join columns with ` │ `; the inline card's rail follows only the margin.
    await click(h,'inspect-item');assert.doesNotMatch(h.text(),/\S │ DETAIL/)
    await h.key('',{pageUp:true});await h.key('',{pageUp:true});assert.match(h.text(),/^ {2}┇ DETAIL-1\d *$/m)
    await h.paste(' retained');assert.match(h.text(),/unsent draft retained/)
    // With a draft, plain End edits it; Ctrl+End returns to the latest output.
    await h.key('',{end:true,ctrl:true});assert.match(h.text(),/DETAIL-69/)
    assert.match(h.text(),/unsent draft retained/);assert.deepEqual(calls.prompts,[])
  }finally{h.dispose()}
})
test('mouse permissions require selection then explicit confirm and reset for the next request',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[approval('a'),approval('b')]})
  try{await click(h,'approval-select',a=>a.allowed);assert.deepEqual(calls.approvals,[]);await click(h,'approval-confirm');assert.deepEqual(calls.approvals,[])
    advance(350);await click(h,'approval-confirm');assert.deepEqual(calls.approvals,[{id:'a',outcome:'allowed-once'}]);advance(350);await click(h,'approval-confirm');assert.deepEqual(calls.approvals.at(-1),{id:'b',outcome:'rejected'})
  }finally{h.dispose()}
}))
test('plan review choices are mouse-selectable and preserve the shared question answer shape',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[question()]})
  try{await click(h,'question-option',a=>a.index===1);assert.equal(calls.questions.length,0);advance(350);await click(h,'question-confirm');assert.deepEqual(calls.questions[0].answer,{answers:[{id:'plan-review',selected:['Keep planning']}]});assert.deepEqual(calls.prompts,[])}finally{h.dispose()}
}))
test('clicking a slash suggestion only completes; attachments remove one at a time',async()=>{
  const {h,store,calls}=setup({attachments:[{name:'one.png',part:{type:'image'}},{name:'two.png',part:{type:'image'}}]})
  try{assert.match(h.text(),/^── ⊕ one\.png × ── ⊕ two\.png × ─+$/mu);await click(h,'detach',a=>a.index===1);assert.equal(store.getState().attachments.length,1);assert.match(h.text(),/^── ⊕ one\.png × ─+$/mu);await h.paste('/cop');await click(h,'command-complete',a=>a.name==='copy');assert.match(h.text(),/› \/copy/);assert.deepEqual(calls.commands,[])}finally{h.dispose()}
})
test('Alt+V stages an image explicitly and is disabled inside permission dialogs',async()=>{
  const {h,store,calls}=setup()
  try{await h.paste('keep draft');await h.key('v',{meta:true});assert.equal(calls.images,1);assert.match(h.text(),/keep draft/);assert.deepEqual(calls.prompts,[]);store.update(s=>{s.pending=[approval()]});h.render();await h.key('v',{meta:true});assert.equal(calls.images,1)}finally{h.dispose()}
})
test('Ctrl+G suspends terminal editing, restores the edited draft and never sends it',async()=>{
  const {h,calls}=setup()
  try{await h.paste('Write a script\nwith unicode 東京');await h.key('g',{ctrl:true});await h.flush();assert.deepEqual(calls.edits,['Write a script\nwith unicode 東京']);assert.match(h.text(),/EDITED/);assert.deepEqual(calls.prompts,[]);assert.ok(h.written.includes(MOUSE_ON));assert.ok(h.written.some(s=>s.includes(MOUSE_OFF)))}finally{h.dispose()}
})
test('an editor launch failure keeps the original draft editable',async()=>{
  const {h,controller,calls}=setup()
  try{controller.editPrompt=async()=>{throw Error('editor not found')};await h.paste('original');await h.key('g',{ctrl:true});await h.flush();assert.match(h.text(),/original/);assert.deepEqual(calls.errors,['editor not found']);await h.paste(' still here');assert.match(h.text(),/original still here/)}finally{h.dispose()}
})
test('session picker mouse selection previews without resuming; only Resume button executes',async()=>{
  const rows=[{id:'one',label:'First saved session',detail:'/repo one',command:'/resume one'},{id:'two',label:'Second saved session',detail:'/repo two',command:'/resume two'}]
  const {h,controller,calls}=setup({picker:{kind:'sessions',title:'Resume',rows}})
  const previews=[];controller.previewSession=async id=>{previews.push(id);return {sessionId:id,messages:12,tools:4,firstPrompt:'First prompt '+id,lastResponse:'Last response '+id,cwd:'/repo'}}
  try{h.render();await click(h,'picker-select',a=>a.id==='two');await delay(130);await h.flush();assert.deepEqual(calls.commands,[]);assert.match(h.text(),/Last response two/);assert.match(h.text(),/12 messages/);await click(h,'picker-confirm',a=>a.id==='two');assert.deepEqual(calls.commands,['/resume two'])}finally{h.dispose()}
})
test('session search ignores stale async results and exposes content matches without activating sessions',async()=>{
  const rows=[{id:'one',label:'Alpha',detail:'/repo',command:'/resume one'},{id:'two',label:'Beta',detail:'/repo',command:'/resume two'}]
  const {h,controller,calls}=setup({picker:{kind:'sessions',title:'Resume',rows}});const pending=[]
  controller.searchSessions=(query,signal)=>new Promise(resolve=>pending.push({query,signal,resolve}))
  try{h.render();await h.paste('needle');await delay(245);await h.flush();assert.equal(pending.length,1)
    await h.key('u',{ctrl:true});await h.paste('other');await delay(245);await h.flush();assert.equal(pending.length,2)
    pending[1].resolve({items:[{sessionId:'two',snippet:'other content'}],hasMore:false});await h.flush();pending[0].resolve({items:[{sessionId:'one',snippet:'needle'}],hasMore:false});await h.flush()
    assert.ok(pending[0].signal.aborted);assert.match(h.text(),/Beta/);assert.ok(!h.text().includes('Alpha'));assert.deepEqual(calls.commands,[])
  }finally{h.dispose()}
})
test('focus events never enter the draft; attention signals and titles restore on exit',async()=>{
  const {h,store,calls}=setup({notifications:'bell',terminalTitle:true})
  try{await h.paste('draft');await h.key('\x1b[O');store.update(s=>{s.status='running'});h.render();store.update(s=>{s.status='idle'});h.render();assert.equal(h.written.filter(s=>s==='\x07').length,1)
    await h.key('\x1b[I');store.update(s=>{s.status='running'});h.render();store.update(s=>{s.status='idle'});h.render();assert.equal(h.written.filter(s=>s==='\x07').length,1)
    await h.key('',{return:true});assert.deepEqual(calls.prompts,['draft']);assert.ok(h.written.some(s=>s.includes('DSH · Authentication & tests · ready')))
  }finally{h.dispose();assert.ok(h.written.includes('\x1b[23;2t'));assert.ok(h.written.includes('\x1b[?1004l'))}
})
for(const [columns,height] of [[29,12],[40,20],[80,30],[120,35],[180,40]])test(`new pane/button frames remain bounded at ${columns}x${height}`,async()=>{
  for(const overrides of [{transcript:transcript([assistant('```sh\nこんにちは\n```')])},{pending:[approval()]},{pending:[question()]},{picker:{kind:'sessions',title:'Resume',rows:[{id:'a',label:'Saved',detail:'/repo',command:'/resume a'}]}}]){
    const {h}=setup(overrides,columns,height);try{assert.equal(h.rows().length,height);assert.ok(h.rows().every(r=>widthOf(textOfRow(r))<=columns-1))}finally{h.dispose()}
  }
})
test('return-to-live button rejoins the stream without sending anything',async()=>{
  const {h,calls}=setup({transcript:transcript([assistant(Array.from({length:100},(_,i)=>'MESSAGE-'+i).join('\n'))])})
  try{await h.key('',{pageUp:true});assert.match(h.text(),/Back to bottom/);await click(h,'live-tail');assert.match(h.text(),/MESSAGE-99/);assert.deepEqual(calls.prompts,[])}finally{h.dispose()}
})
test('wheel over slash palette selects a command instead of moving the chat',async()=>{
  const {h,calls}=setup()
  try{await h.paste('/');const p=target(h,'command-complete');await h.key(`\x1b[<65;${p.x+1};${p.y+1}M`);assert.match(h.text(),/2 of \d+/);assert.deepEqual(calls.commands,[])}finally{h.dispose()}
})
function locate(h,needle){
  for(const [y,row] of h.rows().entries()){
    const text=textOfRow(row),at=text.indexOf(needle)
    if(at>=0)return {y,x:widthOf(text.slice(0,at)),width:widthOf(needle)}
  }
  assert.fail(`"${needle}" is not painted in:\n${h.text()}`)
}
const press=(h,x,y)=>h.key(`\x1b[<0;${x+1};${y+1}M`)
const move=(h,x,y)=>h.key(`\x1b[<32;${x+1};${y+1}M`)
const release=(h,x,y)=>h.key(`\x1b[<0;${x+1};${y+1}m`)
test('dragging over the output copies exactly the selected cells',async()=>{
  const {h,calls}=setup({transcript:transcript([assistant('ALPHA-ONE BETA-TWO')])})
  try{
    const at=locate(h,'ALPHA-ONE')
    await press(h,at.x,at.y);await move(h,at.x+at.width-1,at.y);await release(h,at.x+at.width-1,at.y)
    assert.deepEqual(calls.copies,['ALPHA-ONE'])
  }finally{h.dispose()}
})
test('a selection is shown inverse while the button is held, and a click copies nothing',async()=>{
  const {h,calls}=setup({transcript:transcript([assistant('GAMMA-THREE')])})
  try{
    const at=locate(h,'GAMMA-THREE')
    await press(h,at.x,at.y);await move(h,at.x+4,at.y)
    const painted=h.rows()[at.y].spans.filter(part=>part.inverse===true).map(part=>part.text).join('')
    assert.equal(painted,'GAMMA')
    await release(h,at.x+4,at.y);assert.deepEqual(calls.copies,['GAMMA'])
    // A press and release on one cell selects nothing and must not copy.
    await press(h,at.x,at.y);await release(h,at.x,at.y)
    assert.equal(calls.copies.length,1)
  }finally{h.dispose()}
})
test('a drag across rows copies one line per row, without painted padding',async()=>{
  const {h,calls}=setup({transcript:transcript([assistant('FIRST-ROW\n\nSECOND-ROW')])})
  try{
    const from=locate(h,'FIRST-ROW'),to=locate(h,'SECOND-ROW')
    await press(h,from.x,from.y);await move(h,to.x+to.width-1,to.y);await release(h,to.x+to.width-1,to.y)
    const copied=calls.copies[0].split('\n').map(line=>line.trim()).filter(Boolean)
    assert.deepEqual(copied,['FIRST-ROW','SECOND-ROW'])
    assert.ok(!calls.copies[0].includes('   '))
  }finally{h.dispose()}
})
test('typing replaces a dragged draft selection and the wheel over the draft scrolls it, not the conversation',async()=>{
  // A draft short enough to stay inline, but wrapped into more lines than the
  // composer shows: the wheel must still reach the top of it.
  const {h}=setup({transcript:transcript([assistant('CONVERSATION-TAIL')])},40,35)
  try{
    await h.paste(['START-MARK '+'a'.repeat(100),'b'.repeat(110),'END-MARK '+'c'.repeat(100)].join('\n'))
    assert.match(h.text(),/END-MARK/);assert.doesNotMatch(h.text(),/START-MARK/)
    const at=locate(h,'END-MARK')
    for(let i=0;i<8;i++)await h.key(`\x1b[<64;${at.x+1};${at.y+1}M`)
    assert.match(h.text(),/START-MARK/)
    // The conversation stayed where it was: only the draft moved.
    assert.match(h.text(),/CONVERSATION-TAIL/)
    const word=locate(h,'START-MARK')
    await press(h,word.x,word.y);await move(h,word.x+9,word.y)
    assert.ok(h.rows()[word.y].spans.some(part=>part.inverse===true))
    await h.key('x')
    // The dragged span of the draft is replaced; under the header's filled DSH label only the cursor cell stays inverse.
    assert.match(h.text(),/› xK a/)
    assert.equal(h.rows().slice(1).flatMap(row=>row.spans).filter(part=>part.inverse===true).map(part=>part.text).join(''),'K')
  }finally{h.dispose()}
})
const bigPaste=(rows,tag='LINE')=>Array.from({length:rows},(_,i)=>`${tag}-${i}`).join('\n')
test('a large paste collapses to a placeholder and the model still receives the text',async()=>{
  const {h,calls}=setup()
  try{
    const pasted=bigPaste(12)
    await h.paste(pasted)
    assert.match(h.text(),/\[Pasted text #1 \+12 lines\]/)
    assert.doesNotMatch(h.text(),/LINE-7/)
    await h.paste(' and a tail')
    assert.match(h.text(),/and a tail/)
    await h.key('',{return:true})
    assert.deepEqual(calls.prompts,[`${pasted} and a tail`])
  }finally{h.dispose()}
})
test('one key removes a whole placeholder, and pasting it again expands it',async()=>{
  const {h,calls}=setup()
  try{
    const pasted=bigPaste(9,'ROW')
    await h.paste(pasted)
    assert.match(h.text(),/\[Pasted text #1 \+9 lines\]/)
    // The same content again is a request to see it.
    await h.paste(pasted)
    assert.doesNotMatch(h.text(),/Pasted text/);assert.match(h.text(),/ROW-8/)
    // Collapsed once more, a single backspace takes the whole token.
    await h.paste(bigPaste(7,'OTHER'))
    assert.match(h.text(),/\[Pasted text #2 \+7 lines\]/)
    await h.key('',{backspace:true})
    assert.doesNotMatch(h.text(),/Pasted text/)
    await h.key('',{return:true})
    assert.deepEqual(calls.prompts,[pasted])
  }finally{h.dispose()}
})
test('a selection reports the characters it copied',async()=>{
  const {h,calls,store}=setup({transcript:transcript([assistant('COUNTED-WORD')])})
  try{
    const at=locate(h,'COUNTED-WORD')
    await press(h,at.x,at.y);await move(h,at.x+at.width-1,at.y);await release(h,at.x+at.width-1,at.y)
    assert.deepEqual(calls.copies,['COUNTED-WORD'])
    assert.equal(store.getState().hint,'Copied 12 chars to clipboard')
  }finally{h.dispose()}
})
test('a click between two words of the draft moves the cursor there',async()=>{
  const {h,calls}=setup()
  try{
    await h.paste('fix qzw phrase')
    const at=locate(h,'qzw phrase')
    await press(h,at.x,at.y);await release(h,at.x,at.y)
    await h.key('X')
    assert.match(h.text(),/› fix Xqzw phrase/)
    assert.deepEqual(calls.copies,[])
  }finally{h.dispose()}
})
test('a drag inside the draft selects only its text, copies it, and Backspace deletes it',async()=>{
  const {h,calls}=setup()
  try{
    await h.paste('fix qzw phrase')
    const at=locate(h,'qzw ')
    // The drag ends low on the screen, over the footer: the selection stays inside the draft.
    await press(h,at.x,at.y);await move(h,at.x+4,at.y);await release(h,at.x+4,at.y)
    assert.deepEqual(calls.copies,['qzw '])
    await h.key('',{backspace:true})
    assert.match(h.text(),/› fix phrase/)
    await press(h,at.x,at.y);await move(h,at.x+3,h.rows().length-1);await release(h,at.x+3,h.rows().length-1)
    assert.deepEqual(calls.copies,['qzw ','phrase'])
  }finally{h.dispose()}
})
test('a drag from the conversation stops above the composer and never copies the footer',async()=>{
  const {h,calls}=setup({transcript:transcript([assistant('CONVERSATION-LINE')])})
  try{
    const at=locate(h,'CONVERSATION-LINE')
    const bottom=h.rows().length-1
    await press(h,at.x,at.y);await move(h,10,bottom);await release(h,10,bottom)
    assert.equal(calls.copies.length,1)
    assert.match(calls.copies[0],/CONVERSATION-LINE/)
    assert.doesNotMatch(calls.copies[0],/Ready|Enter send|Ask anything/)
  }finally{h.dispose()}
})
test('an empty conversation opens with the whale when there is room, and without it when cramped',async()=>{
  const whale=/[\u2801-\u28ff]{6}/u
  const roomy=setup({},80,30)
  try{assert.match(roomy.h.text(),whale);assert.match(roomy.h.text(),/What are we building\?/)}finally{roomy.h.dispose()}
  const cramped=setup({},80,18)
  try{assert.doesNotMatch(cramped.h.text(),whale);assert.match(cramped.h.text(),/What are we building\?/)}finally{cramped.h.dispose()}
})
test('the whale animates on an idle empty conversation and stays still with motion off',async()=>{
  const moving=setup({motion:true},80,30)
  try{
    const first=moving.h.text()
    await delay(700);await moving.h.flush()
    assert.notEqual(moving.h.text(),first)
  }finally{moving.h.dispose()}
  const still=setup({motion:false},80,30)
  try{
    const first=still.h.text()
    await delay(700);await still.h.flush()
    assert.equal(still.h.text(),first)
  }finally{still.h.dispose()}
})
const GOAL_OBJECTIVE='Crea un Tetris giocabile nel browser.\n\nRequisiti:\n1. Logica separata dalla grafica.'
const goalState=(phase='active',activation='armed')=>({projections:{goal:{goal:{id:'goal-1',revision:1,objective:GOAL_OBJECTIVE,phase,maxGoalRounds:256},roundsStarted:3}},goalActivation:activation})
test('the goal indicator names the objective first line only, without the round counter',async()=>{
  const {h}=setup(goalState(),100,30)
  try{
    const text=h.text()
    // One row under the header, after a blank row; an active goal shows no phase.
    assert.match(h.text().split('\n')[2],/^◎ Crea un Tetris giocabile nel browser\.$/)
    assert.doesNotMatch(text,/\/256|3\/256|Requisiti|GOAL/)
  }finally{h.dispose()}
  const stopped=setup(goalState('active','disarmed'),100,30)
  try{assert.match(stopped.h.text(),/◎ Crea un Tetris giocabile nel browser\.   paused · \/goal resume/)}finally{stopped.h.dispose()}
  const blocked=setup(goalState('blocked'),100,30)
  try{
    const detail=blocked.h.rows()[2].spans.find(part=>part.text.includes('blocked'))
    assert.equal(detail?.tone,'warning')
  }finally{blocked.h.dispose()}
})
test('clicking the goal indicator opens the full objective, and Edit puts it in the composer',async()=>{
  const {h}=setup(goalState(),100,30)
  try{
    const at=locate(h,'Crea un Tetris')
    await press(h,at.x,at.y);await release(h,at.x,at.y)
    assert.match(h.text(),/Requisiti:/)
    assert.match(h.text(),/1\. Logica separata dalla grafica\./)
    const edit=target(h,'goal-edit')
    await press(h,edit.x,edit.y);await release(h,edit.x,edit.y)
    // The panel closed and the whole objective is in the composer, ready to edit.
    assert.doesNotMatch(h.text(),/\[ Edit \]/)
    assert.match(h.text(),/› \/goal edit Crea un Tetris/)
  }finally{h.dispose()}
})
test('Alt+G opens the goal panel and its controls run the shared goal commands',async()=>{
  const {h,calls}=setup(goalState(),100,30)
  try{
    await h.key('g',{meta:true})
    const pause=target(h,'goal-command',action=>action.command==='/goal pause')
    await press(h,pause.x,pause.y);await release(h,pause.x,pause.y)
    assert.deepEqual(calls.commands,['/goal pause'])
  }finally{h.dispose()}
})

for (const navigation of ['page','wheel','end']) test(`a finished tool closes only after downward ${navigation} navigation passes it`,async()=>{
  const output=Array.from({length:24},(_,i)=>`DETAIL_${String(i).padStart(2,'0')}`).join('\n')
  const items=[tool({id:'auto-close',result:{card:'terminal',output,exitCode:0}}),assistant(Array.from({length:70},(_,i)=>`AFTER_${i}`).join('\n'))]
  const {h}=setup({transcript:transcript(items)},100,30)
  try {
    await h.key('',{ctrl:true,home:true})
    await click(h,'inspect-item',a=>a.itemId==='auto-close')
    await h.key('',{ctrl:true,home:true})
    assert.match(h.text(),/DETAIL_00/)
    await h.key('',{shift:true,downArrow:true})
    await h.key('',{shift:true,upArrow:true})
    assert.match(h.text(),/DETAIL_00/)
    if(navigation==='end')await h.key('',{ctrl:true,end:true})
    else for(let n=0;n<14;n++) {
      if(navigation==='page') await h.key('',{pageDown:true})
      else await h.key('\x1b[<65;10;5M')
    }
    assert.match(h.text(),/AFTER_/)
    await h.key('',{ctrl:true,home:true})
    assert.doesNotMatch(h.text(),/DETAIL_00/)
    assert.match(h.text(),/Run authentication tests/)
    await click(h,'inspect-item',a=>a.itemId==='auto-close')
    assert.match(h.text(),/DETAIL_00/)
  } finally {h.dispose()}
})

for (const direction of [1, -1]) test(`drag selection spans offscreen rows while scrolling ${direction}`, async () => {
  const text = Array.from({length: 100}, (_,i) => `LINE-${String(i).padStart(3,'0')}`).join('\n\n')
  const {h,calls}=setup({transcript:transcript([assistant(text)])},80,24)
  try {
    if(direction===1) await h.key('',{home:true,ctrl:true})
    const visible=()=>h.text().split('\n').filter(line=>/LINE-\d{3}/u.test(line)).map(line=>line.match(/LINE-\d{3}/u)[0])
    const before=visible(),first=direction===1?before[0]:before.at(-1),at=locate(h,first)
    await press(h,direction===1?at.x:at.x+7,at.y)
    const y=direction===1?locate(h,before.at(-1)).y:locate(h,before[0]).y
    await move(h,at.x+7,y)
    for(let i=0;i<8;i++)await h.key(`\x1b[<${direction===1?65:64};5;${y+1}M`)
    const after=visible(),last=direction===1?after.at(-1):after[0],end=locate(h,last)
    await move(h,direction===1?end.x+7:end.x,end.y)
    await release(h,direction===1?end.x+7:end.x,end.y)
    assert.equal(calls.copies.length,1)
    const copied=calls.copies[0]
    assert.ok(copied.includes(first),copied)
    assert.ok(copied.includes(last),copied)
    const numbers=[...copied.matchAll(/LINE-(\d{3})/gu)].map(match=>Number(match[1]))
    assert.ok(numbers.length>before.length)
    for(let i=1;i<numbers.length;i++)assert.equal(numbers[i],numbers[i-1]+1)
    assert.doesNotMatch(copied,/Ask anything|Ready/u)
    await h.key(`\x1b[<${direction===1?64:65};5;${y+1}M`)
    assert.ok(h.rows().some(row=>row.spans.some(part=>part.inverse===true)))
    assert.equal(calls.copies.length,1)
  } finally {h.dispose()}
})
test('multiline prechat paste dispatches a command and never a model prompt',async()=>{
  const {h,calls}=setup()
  try {const text='/prechat\nUSER: example\nASSISTANT: answer';await h.paste(text);await h.key('',{return:true});assert.deepEqual(calls.commands,[text]);assert.deepEqual(calls.prompts,[])}finally{h.dispose()}
})

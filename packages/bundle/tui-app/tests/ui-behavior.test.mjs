import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ui-loader.mjs',import.meta.url)
const { App }=await import('../src/app.tsx')
const { createHarness }=await import('./ui-harness.mjs')
const { createStore }=await import('../src/store.ts')
const { mergeCommands }=await import('../src/commands.ts')
const { widthOf, textOfRow }=await import('../src/rich-text.ts')
const { fixture, conversation, tool, approval, question }=await import('./fixtures.mjs')
function setup(overrides={},columns=80,height=24){
  const store=createStore(fixture(overrides)),calls={submit:[],commands:[],approvals:[],questions:[],errors:[],cancel:0,exit:0}
  const controller={async submit(text){calls.submit.push(text)},async runCommand(line){calls.commands.push(line);const name=line.slice(1).split(' ')[0];if(['context','permissions','help','tasks'].includes(name))store.update(s=>{s.panel=name})},
    cancel(){calls.cancel++},exit(){calls.exit++},commands(){return mergeCommands([{name:'plan',description:'plan with the preset'},{name:'goal',description:'persistent goal'},{name:'compact',description:'compact context'}])},
    answerApproval(id,outcome){calls.approvals.push({id,outcome});store.update(s=>{s.pending=s.pending.filter(p=>p.id!==id)})},
    answerQuestion(id,answer){calls.questions.push({id,answer});store.update(s=>{s.pending=s.pending.filter(p=>p.id!==id)})},
    hint(text){store.update(s=>{s.hint=text})},closePicker(){store.update(s=>{s.picker=undefined})},report(error){calls.errors.push(error.message)},}
  const h=createHarness(App,store,controller,columns,height)
  return {h,store,controller,calls}
}
async function clockTest(run){const original=Date.now;let now=10000;Date.now=()=>now;try{await run(ms=>{now+=ms})}finally{Date.now=original}}
test('App forwards raw pasted multiline prompts exactly once, never on paste',async()=>{
  const {h,calls}=setup();try{const raw='  first\nsecond 👩🏽‍💻 東京  ';await h.paste(raw);assert.equal(calls.submit.length,0);await h.key('',{return:true});assert.deepEqual(calls.submit,[raw]);assert.equal(calls.commands.length,0)}finally{h.dispose()}
})
test('failed prompt admission preserves the composer and reports the error',async()=>{
  const {h,controller,calls}=setup();try{controller.submit=async()=>{throw Error('admission rejected')};await h.paste('do not lose this');await h.key('',{return:true});assert.match(h.text(),/do not lose this/);assert.deepEqual(calls.errors,['admission rejected'])}finally{h.dispose()}
})
test('slash palette completes fuzzy commands without model submissions',async()=>{
  const {h,calls}=setup();try{await h.paste('/cmp');assert.match(h.text(),/compact/);await h.key('',{tab:true});assert.match(h.text(),/\/compact/);await h.key('',{return:true});assert.deepEqual(calls.commands,['/compact']);assert.deepEqual(calls.submit,[])}finally{h.dispose()}
})
test('Enter runs the highlighted palette command, not the partially typed name',async()=>{
  const {h,calls}=setup();try{await h.paste('/comp');await h.key('',{return:true});assert.deepEqual(calls.commands,['/compact']);assert.deepEqual(calls.submit,[]);assert.doesNotMatch(h.text(),/› \/comp/)}finally{h.dispose()}
})
test('terminal focus reports, batched or with the ESC stripped, never reach the draft',async()=>{
  const {h}=setup();try{await h.paste('draft');for(const report of ['\x1b[O','[O[O','[I','\x1b[O\x1b[I'])await h.key(report);assert.match(h.text(),/› draft /);assert.doesNotMatch(h.text(),/\[[IO]/)}finally{h.dispose()}
})
test('the jump-to-latest button is centred above the composer, and only its label is clickable',async()=>{
  const t=fixture().transcript;t.items=Array.from({length:60},(_,i)=>({kind:'user',id:`user-${i}`,text:`LINE-${i}`,settled:true,queued:false}))
  const {h}=setup({transcript:t});try{
    await h.key('',{pageUp:true})
    const y=h.rows().findIndex(value=>textOfRow(value).includes('Back to bottom'))
    const line=textOfRow(h.rows()[y]),left=line.length-line.trimStart().length,right=79-line.trimEnd().length
    assert.ok(Math.abs(left-right)<=1);assert.doesNotMatch(h.text(),/End \/ Click/)
    assert.equal(textOfRow(h.rows()[y+1]).trim(),'')
    assert.equal(h.rows()[y].spans.filter(part=>part.action?.kind==='live-tail').map(part=>part.text.trim()).join(''),line.trim())
  }finally{h.dispose()}
})
test('dismissed command palette does not erase the draft',async()=>{
  const {h}=setup();try{await h.paste('/model');await h.key('',{escape:true});assert.match(h.text(),/\/model/)}finally{h.dispose()}
})
test('approval defaults to reject; pasted or carried input never allows',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[approval()]});try{await h.paste('y\n');await h.key('',{return:true});assert.equal(calls.approvals.length,0);advance(350);await h.key('',{return:true});assert.deepEqual(calls.approvals,[{id:'approval-1',outcome:'rejected'}])}finally{h.dispose()}
}))
test('allow once is scoped; repeated keys never approve the next request',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[approval('one'),approval('two')]});try{advance(350);await h.key('y');assert.equal(calls.approvals.length,0);await h.key('',{return:true});assert.deepEqual(calls.approvals,[{id:'one',outcome:'allowed-once'}]);advance(400);await h.key('y',{eventType:'repeat'});assert.equal(calls.approvals.length,1);await h.key('',{rightArrow:true});await h.key('',{return:true});assert.deepEqual(calls.approvals[1],{id:'two',outcome:'allowed-once'})}finally{h.dispose()}
}))
test('questions retain full details and preserve the shared answer shape',async()=>clockTest(async advance=>{
  const pending=question();pending.questions[0].detail='line\n'.repeat(100)+'END-OF-PLAN';const {h,calls}=setup({pending:[pending]});try{
    await h.key('',{return:true});assert.equal(calls.questions.length,0)
    for(let i=0;i<15;i++)await h.key('',{pageDown:true});assert.match(h.text(),/END-OF-PLAN/)
    await h.key('',{downArrow:true});advance(350);await h.key('',{return:true});assert.deepEqual(calls.questions[0].answer,{answers:[{id:'plan-review',selected:['Keep planning']}]})
  }finally{h.dispose()}
}))
test('custom multiline question answers are edited without submitting a chat prompt',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[question()]});try{await h.paste('Keep the\nexisting contract');advance(350);await h.key('',{return:true});assert.equal(calls.questions[0].answer.answers[0].custom,'Keep the\nexisting contract');assert.equal(calls.submit.length,0)}finally{h.dispose()}
}))
test('a single-select custom answer drops the option highlighted before typing',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[question()]});try{await h.key('',{downArrow:true});await h.paste('Something else');advance(350);await h.key('',{return:true});assert.deepEqual(calls.questions[0].answer,{answers:[{id:'plan-review',selected:[],custom:'Something else'}]})}finally{h.dispose()}
}))
test('a single-select option chosen after typing custom text drops the text',async()=>clockTest(async advance=>{
  const {h,calls}=setup({pending:[question()]});try{await h.paste('draft');await h.key('',{tab:true});await h.key('',{downArrow:true});advance(350);await h.key('',{return:true});assert.deepEqual(calls.questions[0].answer,{answers:[{id:'plan-review',selected:['Keep planning']}]})}finally{h.dispose()}
}))
test('transcript focus expands tools and preserves an unsent composer draft',async()=>{
  const t=fixture().transcript;t.items=[tool({result:{card:'terminal',output:Array.from({length:25},(_,i)=>`UNIQUE-${i}`).join('\n'),exitCode:0}})]
  const {h,store,calls}=setup({transcript:t});try{await h.paste('draft');await h.key('o',{ctrl:true});assert.equal(store.getState().panel,'transcript');await h.key('',{home:true,ctrl:true});assert.match(h.text(),/▾ • Run {4}pnpm test --filter auth/);await h.key('',{downArrow:true,shift:true});await h.key('',{downArrow:true,shift:true});assert.match(h.text(),/UNIQUE-0/);await h.key('',{return:true});assert.equal(calls.submit.length,0);await h.key('',{escape:true});assert.match(h.text(),/draft/)}finally{h.dispose()}
})
test('search reaches reasoning and unfolded tool output',async()=>{
  const t=fixture().transcript;t.items=conversation();const {h}=setup({transcript:t});try{await h.key('f',{ctrl:true});await h.paste('expiresAt');await h.key('',{return:true});assert.match(h.text(),/expiresAt/);assert.match(h.text(),/^⌕ expiresAt +1 of 1 {3}n · N next · previous · Esc close $/mu);
    // Only the matched text is marked: filled in the accent tone on the row the search is on.
    const hit=h.rows().flatMap(value=>value.spans).filter(part=>part.text==='expiresAt'&&part.inverse===true&&part.tone==='accent');assert.equal(hit.length,1);await h.key('n')}finally{h.dispose()}
})
test('history selection edits, never sends, and stash swaps drafts',async()=>{
  const {h,calls}=setup();try{await h.paste('one');await h.key('',{return:true});await h.paste('two');await h.key('',{return:true});await h.key('r',{ctrl:true});await h.paste('one');await h.key('',{return:true});assert.equal(calls.submit.length,2);assert.match(h.text(),/one/);await h.key('s',{ctrl:true});assert.match(h.text(),/stashed/);await h.paste('new draft');await h.key('s',{ctrl:true});assert.match(h.text(),/one/)}finally{h.dispose()}
})
test('Escape closes an inspector before interrupting a running turn',async()=>{
  const {h,store,calls}=setup({status:'running',panel:'context'});try{await h.key('',{escape:true});assert.equal(store.getState().panel,undefined);assert.equal(calls.cancel,0);await h.key('',{escape:true});assert.equal(calls.cancel,1)}finally{h.dispose()}
})
for(const [columns,height] of [[29,12],[40,16],[80,24],[120,40]])test(`complete App frames remain bounded at ${columns}x${height}`,async()=>{
  const t=fixture().transcript;t.items=conversation()
  const states=[{transcript:t},{transcript:t,status:'running',pending:[approval()]},{transcript:t,pending:[question()]},{panel:'help'},{panel:'context'},{panel:'permissions'},{panel:'tasks'},{transcript:t,panel:'transcript'},
    {picker:{kind:'sessions',title:'Resume',rows:Array.from({length:30},(_,i)=>({id:`s${i}`,label:`Session ${i} `.repeat(10),detail:'Long detail '.repeat(20),command:`/resume s${i}`}))}}]
  for(const state of states){const {h}=setup(state,columns,height);try{assert.equal(h.rows().length,height);for(const line of h.rows())assert.ok(widthOf(textOfRow(line))<=columns-1);await h.key('',{pageDown:true});h.resize(columns+10,height+3);assert.equal(h.rows().length,height+3)}finally{h.dispose()}}
})
test('the wheel scrolls the conversation while a turn is still producing',async()=>{
  const t=fixture().transcript;t.items=Array.from({length:60},(_,i)=>({kind:'user',id:`user-${i}`,text:`LINE-${i}`,settled:true,queued:false}))
  const {h,store}=setup({transcript:t,status:'running'});try{
    assert.match(h.text(),/LINE-59/)
    for(let i=0;i<12;i++)await h.key('[<64;20;5M')
    assert.match(h.text(),/Back to bottom/);assert.doesNotMatch(h.text(),/LINE-59/)
    // New rows keep arriving; the reader stays where the wheel left them.
    store.update(s=>{s.transcript.items.push({kind:'user',id:'user-new',text:'LINE-NEW',settled:true,queued:false})})
    await h.flush();assert.doesNotMatch(h.text(),/LINE-NEW/)
    for(let i=0;i<40;i++)await h.key('[<65;20;5M')
    assert.match(h.text(),/LINE-NEW/);assert.doesNotMatch(h.text(),/Back to bottom/)
  }finally{h.dispose()}
})
test('wheel reports never reach the prompt, and the wheel never recalls history',async()=>{
  const {h,calls}=setup();try{
    await h.paste('one');await h.key('',{return:true});assert.deepEqual(calls.submit,['one'])
    await h.key('[<64;20;5M');await h.key('[<0;20;5M');await h.key('[<0;20;5m');await h.key('[<66;20;5M')
    assert.doesNotMatch(h.text(),/\[</);assert.doesNotMatch(h.text(),/› one/)
  }finally{h.dispose()}
})
test('a prompt still in admission does not freeze the composer',async()=>{
  const {h,controller,calls}=setup();try{
    let admit;controller.submit=(text)=>{calls.submit.push(text);return new Promise(resolve=>{admit=resolve})}
    await h.paste('first');await h.key('',{return:true});assert.deepEqual(calls.submit,['first'])
    await h.paste('composed while sending');assert.match(h.text(),/composed while sending/)
    await h.key('',{return:true});assert.equal(calls.submit.length,1)
    admit();await h.flush();assert.match(h.text(),/composed while sending/)
  }finally{h.dispose()}
})
test('wheel reporting is negotiated on mount and handed back on unmount',async()=>{
  const {MOUSE_ON,MOUSE_OFF}=await import('../src/mouse.ts')
  const {h}=setup();assert.deepEqual(h.written,[MOUSE_ON]);h.dispose();assert.deepEqual(h.written,[MOUSE_ON,MOUSE_OFF])
  const off=setup({mouse:false});off.h.dispose();assert.deepEqual(off.h.written,[])
})
test('a legacy mouse report drops its coordinates and returns the keyboard',async()=>{
  const {h}=setup();try{
    await h.key('[M');await h.key('');await h.key('');await h.key('')
    await h.paste('typed after');assert.match(h.text(),/typed after/)
  }finally{h.dispose()}
})


test('every permission preset other than the default is named in the status line, and a click opens the picker', async () => {
  const standard = setup({ defaultPermission: 'workspace-write', projections: { permissions: { currentValue: 'workspace-write' } } })
  try { assert.doesNotMatch(textOfRow(standard.h.rows().at(-1)), /workspace-write/) } finally { standard.h.dispose() }
  for (const preset of ['read-only', 'workspace-write', 'auto', 'smart', 'danger-full-access', 'custom']) {
    const { h, store, calls } = setup({ projections: { permissions: { currentValue: preset } } })
    try {
      // Plain text among the muted entries; only full access keeps a warning colour.
      const named = h.rows().at(-1).spans.find(span => span.action?.kind === 'open-permissions')
      assert.equal(named?.text, preset)
      assert.equal(named?.tone, preset === 'danger-full-access' ? 'warning' : 'muted')
      assert.doesNotMatch(h.text(), /permissions:/)
      const y = h.rows().findIndex(row => row.spans.some(span => span.action?.kind === 'open-permissions'))
      const spans = h.rows()[y].spans
      const x = spans.slice(0, spans.findIndex(span => span.action?.kind === 'open-permissions')).reduce((n, span) => n + widthOf(span.text), 0)
      await h.key(`\x1b[<0;${x + 2};${y + 1}M`)
      await h.key(`\x1b[<0;${x + 2};${y + 1}m`)
      assert.deepEqual(calls.commands, ['/permission'])
      assert.equal(store.getState().projections.permissions.currentValue, preset)
    } finally { h.dispose() }
  }
})

test('permission picker keeps the draft and uses the shared permission command on confirmation', async () => {
  const { h, store, calls } = setup()
  try {
    await h.paste('keep my prompt')
    store.update(state => { state.picker = { kind: 'permissions', title: 'Permissions', rows: [
      { id: 'workspace-write', label: 'Workspace', detail: 'Workspace sandbox', current: true, command: '/permission workspace-write' },
      { id: 'auto', label: 'Auto', detail: 'Reviews each command', command: '/permission auto' },
    ] } })
    await h.flush(); await h.key('', { downArrow: true }); await h.key('', { return: true })
    assert.deepEqual(calls.commands, ['/permission auto'])
    store.update(state => { state.picker = undefined }); await h.flush()
    assert.match(h.text(), /keep my prompt/)
    assert.deepEqual(calls.submit, [])
  } finally { h.dispose() }
})


test('a tiny resized terminal keeps its draft and never paints beyond the physical cells', async () => {
  const {h}=setup()
  try {
    await h.paste('keep this draft')
    h.resize(14,5)
    assert.equal(h.rows().length,5)
    for(const line of h.rows())assert.ok(widthOf(textOfRow(line))<=13)
    h.resize(80,24)
    assert.match(h.text(),/keep this draft/)
  } finally {h.dispose()}
})

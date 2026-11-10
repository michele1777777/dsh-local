import { test } from 'node:test'
import assert from 'node:assert/strict'
import { row, span, wrapRow, wrapProse, fitRow, textOfRow, widthOf } from '../src/rich-text.ts'
import { parseMouse } from '../src/mouse.ts'
import { markdownRows, createStreamingMarkdown, createStreamingProse } from '../src/markdown-layout.ts'
import { itemRows, createDocumentRenderer, searchRows } from '../src/document.ts'
import { contextReading, speedReading, sessionIndicators } from '../src/metrics.ts'
import { headerRow, statusRow, indicatorRow, composerRows, inspectorRows, approvalDetails, approvalControls, panelLayout, pickerLayout, filterPicker, fitScreen } from '../src/screen.ts'
import { reviewDiff } from '../src/diff.ts'
import { anchorAt, topOf, scrollBy } from '../src/viewport.ts'
import { emptyUndo, remember, undo, redo } from '../src/editor-history.ts'
import { moveVisual } from '../src/layout.ts'
import { mergeCommands } from '../src/commands.ts'
import { palette } from '../src/theme.ts'
import { fixture, tool, diffTool, conversation, approval } from './fixtures.mjs'
const text = rows => rows.map(textOfRow).join('\n')
const opts = (width = 80, expanded = true) => ({ width, expanded, overrides: {} })
const bounded = (rows, width) => rows.forEach((value, index) => assert.ok(widthOf(textOfRow(value)) <= width, `row ${index}: ${widthOf(textOfRow(value))}>${width}: ${textOfRow(value)}`))

test('wrapping retains graphemes, text and styles without terminal escapes', () => {
  const input = 'Café 👩🏽‍💻 東京 🏳️‍🌈 '+ 'x'.repeat(180)
  for (const width of [2, 8, 29, 80]) { const rows = wrapRow(row(span(input, 'accent')), width); bounded(rows, width); assert.equal(rows.map(textOfRow).join(''), input); assert.equal(rows[0].spans[0].tone, 'accent') }
  assert.doesNotMatch(text(wrapRow(row('\x1b]52;c;bad\x07\x1b[2Jhello\u202etxt'), 50)), /\x1b|\x07|\u202e/u)
  assert.equal(textOfRow(fitRow(row('abcdef'), 0)), '')
})
test('Markdown preserves complete code, links and tables at narrow and wide sizes', () => {
  const source = '# Header\n- [x] Completed\n> quote\n\n| Name | Value |\n| --- | --- |\n| alpha | beta gamma |\n\n```ts\nconst variable = "unique-marker"\nreturn variable\n```\n[reference](https://example.test)'
  for (const width of [29, 40, 60, 100]) {
    const rows = markdownRows(source, width); bounded(rows, width)
    assert.ok(text(rows).includes('alpha')); assert.ok(text(rows).includes('beta gamma')); assert.ok(text(rows).includes('reference'))
    // A wrapped code line continues on the next row of the band, with no border between its parts.
    assert.ok(text(rows).replace(/ *\n/g, '').includes('unique-marker'))
  }
})
test('table cells beyond a short header remain readable', () => {
  const rows = markdownRows('| A | B |\n| --- | --- |\n| one | two | retained-extra-cell |', 80)
  assert.ok(text(rows).includes('retained-extra-cell'))
})
test('reasoning is masked behind a Thinking toggle in streaming and settled rows, and revealed on demand', () => {
  for (const settled of [false, true]) {
    const item = { kind: 'assistant', id: 'a', reasoning: 'provider reasoning', text: 'answer', settled }
    const masked = itemRows(item, opts())
    assert.ok(text(masked).includes('Thought')); assert.ok(!text(masked).includes('provider reasoning')); assert.ok(text(masked).includes('answer'))
    assert.ok(masked.some(value => value.spans.some(part => part.action?.kind === 'toggle-reasoning')))
    const revealed = itemRows(item, { ...opts(), overrides: { 'reasoning:a': true } })
    assert.ok(text(revealed).includes('provider reasoning'))
  }
})
test('read cards use the tool-provided line numbers and text, not object coercion', () => {
  const item = conversation().find(value => value.id === 'tool-read')
  const result = text(itemRows(item, opts()))
  assert.match(result, /41 │ export function/); assert.doesNotMatch(result, /\[object Object\]/)
})
test('tool folding is individual and does not change the stored result', () => {
  const item = tool({ result: { card: 'terminal', output: Array.from({length:80}, (_,i) => `OUTPUT_${i}`).join('\n'), exitCode: 0 } })
  const before = JSON.stringify(item)
  const collapsed = itemRows(item, opts(80, false)), expanded = text(itemRows(item, { ...opts(80, false), overrides: { [item.id]: true } }))
  // Collapsed, the call is one row after the blank one, naming what the model said it does; without that, the last output line.
  assert.equal(collapsed.length, 2); assert.match(text(collapsed), /Run authentication tests/); assert.ok(!text(collapsed).includes('OUTPUT_'))
  const undescribed = itemRows({ ...item, call: { card: 'terminal', title: 'pnpm test --filter auth' } }, opts(80, false))
  assert.match(text(undescribed), /OUTPUT_79/); assert.ok(!text(undescribed).includes('OUTPUT_0'))
  assert.ok(expanded.includes('OUTPUT_0')); assert.equal(JSON.stringify(item), before)
})
test('all tool result variants have bounded layouts and safe raw inspectors', () => {
  const variants = [tool(), diffTool(), conversation()[2], tool({result:{card:'search',shape:'paths',paths:['/first','/last'],total:2,truncated:false}}), tool({result:{card:'web',kind:'fetch',url:'https://example.test',statusCode:200}}), tool({result:{card:'generic',content:[{type:'text',text:'generic detail'}]}}), tool({isError:true,resultText:'error '.repeat(80)}), tool({cancelled:true})]
  for (const item of variants) for (const width of [29,40,80,120]) { bounded(itemRows(item,opts(width)),width); bounded(itemRows(item,{...opts(width),raw:true}),width) }
})
test('numbered hunks handle inserts, deletes and multi-hunk modifications', () => {
  const created = reviewDiff(null, 'a\nb\n'); assert.equal(created.added,2); assert.equal(created.removed,0); assert.equal(created.lines[0].hunk,'@@ -0,0 +1,2 @@')
  const deleted = reviewDiff('a\nb\n',''); assert.equal(deleted.removed,2); assert.equal(deleted.added,0)
  const old = Array.from({length:60},(_,i)=>`line${i}`), next=[...old]; next[3]='changed-one';next[50]='changed-two'
  const result=reviewDiff(old.join('\n'),next.join('\n'));assert.equal(result.added,2);assert.equal(result.removed,2);assert.equal(result.lines.filter(line=>line.hunk).length,2)
})
test('large diffs retain every changed line without quadratic allocation', () => {
  const before=Array.from({length:1000},(_,i)=>`before-${i}`).join('\n'), after=Array.from({length:1000},(_,i)=>`after-${i}`).join('\n')
  const result=reviewDiff(before,after);assert.equal(result.coarse,true);assert.equal(result.added,1000);assert.equal(result.removed,1000);assert.ok(result.lines.some(line=>line.text==='after-999'))
})
test('stable renderer cache reuses unchanged layouts and invalidates changed content', () => {
  const renderer=createDocumentRenderer(), item=tool();const first=renderer.render([item],opts()), same=renderer.render([{...item}],opts())
  assert.equal(first[0],same[0]); const changed=renderer.render([{...item,isError:true}],opts());assert.notEqual(changed[0],first[0])
})
test('search includes unfolded details and reasoning', () => {
  const renderer=createDocumentRenderer();const rows=renderer.render(conversation(),{...opts(),overrides:{'reasoning:assistant-1':true}})
  assert.ok(searchRows(rows,'validation').length>0);assert.ok(searchRows(rows,'expiresAt').length>0);assert.equal(searchRows(rows,'absentstring').length,0)
})
test('context is approximate, unknown stays unknown, no guessed prefill throughput', () => {
  assert.equal(contextReading({}).label,'ctx —');assert.equal(contextReading({contextPressure:{contextWindow:100}}).used,undefined)
  assert.equal(contextReading({contextPressure:{pressureTokens:10,projectedTokens:20,contextWindow:100}}).ratio,.2)
  assert.equal(speedReading({}).decode,undefined);assert.equal(speedReading({sessionStats:{decodeTokens:5,decodeMs:0}}).decode,undefined)
  assert.deepEqual(speedReading({sessionStats:{decodeTokens:120,decodeMs:2000,ttftMs:1500,ttftSteps:3}}),{decode:60,ttftMs:500})
  assert.deepEqual(speedReading({sessionStats:{decodeTokens:Infinity,decodeMs:5,ttftMs:-1,ttftSteps:1}}),{})
  assert.equal('prefill' in speedReading(fixture().projections),false)
})
test('resumed disarmed goals never appear to be running', () => {
  const state=fixture({goalActivation:'disarmed',projections:{goal:{goal:{objective:'Build auth',phase:'active',maxGoalRounds:20},roundsStarted:3},plan:{active:false,pending:true}}})
  assert.equal(sessionIndicators(state)[0].detail,'paused · /goal resume');assert.match(sessionIndicators(state)[1].label,/entering plan/)
})
test('permission inspector describes never as rejection, not bypass', () => {
  assert.match(text(inspectorRows(fixture({approvalPolicy:'never'}),'permissions',[],80)),/does not mean automatic\s+approval/)
  assert.doesNotMatch(text(approvalControls(80,false,1)),/Allow for session/)
})
test('long permission details are all reachable with pinned actions', () => {
  const details=approvalDetails({...approval(),detail:Array.from({length:200},(_,i)=>`line-${i}`).join('\n')},40)
  const frame=panelLayout('Approval',details,approvalControls(40,false,1),40,12,1e6)
  assert.match(text(frame.rows),/line-199/);assert.match(text(frame.rows),/Allow once/);assert.equal(frame.rows.length,12)
})
test('viewport anchors survive earlier row growth; tail follows only when asked', () => {
  const rows=[...Array.from({length:5},()=>({...row('first'),itemId:'one'})),...Array.from({length:10},()=>({...row('second'),itemId:'two'}))]
  const anchor=anchorAt(rows,7),grown=[...Array.from({length:20},()=>({...row('more'),itemId:'one'})),...rows]
  assert.equal(topOf(grown,3,anchor),27);assert.equal(topOf(grown,3,null),32)
  assert.equal(scrollBy(rows,3,anchor,100),null);assert.equal(topOf(rows,3,scrollBy(rows,3,null,-3)),9)
})
test('composer history undo and redo preserve pasted text and cursor', () => {
  const a={text:'a',cursor:1},b={text:'a\n東京',cursor:4};const h=remember(emptyUndo(),a,b);const undone=undo(h,b)
  assert.deepEqual(undone.editor,a);assert.deepEqual(redo(undone.history,a).editor,b)
  assert.ok(moveVisual({text:'123456789012345',cursor:3},1,6).cursor>3)
})
test('semantic monochrome theme does not emit colour choices', () => {assert.ok(Object.values(palette('mono')).every(value=>value===undefined))})
for(const width of [29,40,60,80,120]) test(`header, composer, panels and footer fit ${width} cells`,()=>{
  const state=fixture();bounded([headerRow(state,width),statusRow(state,width,0,5000)],width)
  bounded(composerRows({text:'hello 東京\n\tconst token = 123',cursor:9},width,5,'prompt'),width)
  for(const panel of ['help','context','permissions','tasks'])bounded(inspectorRows(state,panel,mergeCommands([]),width),width)
  const picker={kind:'models',title:'Models',rows:[{id:'m',label:'A very long model '.repeat(10),detail:'detail '.repeat(20),command:'/model p/m',current:true}]}
  bounded(pickerLayout(picker,filterPicker(picker,''),{text:'',cursor:0},0,width,12),width)
  assert.equal(fitScreen([],width,24).length,24)
})

test('a streamed message lays out exactly like a complete one, at every prefix', () => {
  const source = '# Heading\n\nProse that wraps across the width and keeps going for a while.\n\n- one\n- two\n\n```ts\nconst value = compute(input)\n\nreturn value\n```\n\n| A | B |\n| --- | --- |\n| one | two |\n\nClosing words.'
  for (const width of [29, 80]) {
    const streaming = createStreamingMarkdown()
    for (let at = 1; at <= source.length; at += 3) {
      const grown = source.slice(0, at)
      assert.deepEqual(streaming.rows('a', grown, width), markdownRows(grown, width), `width ${width} at ${at}`)
    }
    const prose = createStreamingProse('reasoning')
    const thought = 'First thought.\nSecond thought that is long enough to wrap somewhere.\n\nThird.'
    for (let at = 1; at <= thought.length; at += 2) {
      assert.deepEqual(prose.rows('a', thought.slice(0, at), width), wrapProse(row(span(thought.slice(0, at), 'reasoning')), width))
    }
    // A different item, a narrower width and a rewrite all fall back cleanly.
    assert.deepEqual(streaming.rows('b', source, width), markdownRows(source, width))
    assert.deepEqual(streaming.rows('b', source, width - 4), markdownRows(source, width - 4))
    assert.deepEqual(streaming.rows('b', 'rewritten', width), markdownRows('rewritten', width))
  }
})
test('a document renderer reuses rows without changing them', () => {
  const renderer = createDocumentRenderer()
  const items = [...conversation(), { kind: 'assistant', id: 'live', reasoning: 'thinking\nout loud', text: '', settled: false }]
  const live = items.at(-1)
  for (const piece of ['## Answer', '\n\nBody text.', '\n\n```ts\nconst x = 1\n```', '\n\nDone.']) {
    live.text += piece
    assert.deepEqual(renderer.render(items, opts(80, false)), createDocumentRenderer().render(items, opts(80, false)))
  }
})
test('mouse reports are classified, never typed', () => {
  assert.deepEqual(parseMouse('[<64;10;5M'), { kind: 'wheel', direction: -1, ctrl: false, shift: false, x: 9, y: 4 })
  assert.deepEqual(parseMouse('\x1b[<65;10;5M'), { kind: 'wheel', direction: 1, ctrl: false, shift: false, x: 9, y: 4 })
  assert.deepEqual(parseMouse('[<80;10;5M'), { kind: 'wheel', direction: -1, ctrl: true, shift: false, x: 9, y: 4 })
  for (const other of ['[<0;10;5M', '[<0;10;5m', '[<66;10;5M', '[M']) assert.ok(parseMouse(other) !== undefined && parseMouse(other).kind !== 'wheel')
  for (const key of ['a', '', '[A', '[200~', '\x1b[3~']) assert.equal(parseMouse(key), undefined)
})

const { composerOffsetAt } = await import('../src/screen.ts')
test('a click in the composer maps to the draft offset under it, including wrapped lines', () => {
  const editor = { text: 'fix the phrase\nsecond line', cursor: 0 }
  // Row 0 is the rule; text starts after the two-cell prompt marker.
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 1, 2), 0)
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 1, 6), 4)
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 1, 0), 0)
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 1, 39), 14)
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 2, 3), 16)
  // Rows above the text or below the last line clamp to its ends.
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 0, 9), 0)
  assert.equal(composerOffsetAt(editor, 40, 4, undefined, 9, 9), editor.text.length)
  const wrapped = { text: 'abcdefghij', cursor: 0 }
  assert.equal(composerOffsetAt(wrapped, 8, 4, undefined, 2, 3), 6)
})
test('the composer paints a draft selection inverse, separately from the cursor', () => {
  const rows = composerRows({ text: 'fix the phrase', cursor: 7, anchor: 4 }, 40, 4, 'prompt')
  const inverse = rows[1].spans.filter(part => part.inverse === true).map(part => part.text).join('')
  assert.equal(inverse, 'the ')
})

test('slash commands in the conversation use their own light-blue tone', () => {
  const rows = itemRows({ kind: 'command', id: 'c1', name: 'goal', args: ' build Tetris', settled: true }, { width: 60, expanded: false, overrides: {} })
  const command = rows.flatMap(value => value.spans).filter(part => part.text.includes('/goal'))
  assert.ok(command.length > 0 && command.every(part => part.tone === 'command'))
  assert.equal(palette('dark').command, '#5fafff')
  assert.notEqual(palette('dark').command, palette('dark').accent)
  assert.equal(palette('mono').command, undefined)
})
test('a tool heading colours only its verb, in the category tone; the target stays plain, with no filled badge', () => {
  const rows = itemRows(tool(), opts(80, true))
  const heading = rows[1]
  assert.match(textOfRow(heading), /^ {2}▾ ✓ Run {4}pnpm test --filter auth {2}exit 0 +1\.8s$/)
  assert.ok(heading.spans.every(part => part.inverse !== true && part.background === undefined))
  const verb = heading.spans.find(part => part.text.trim() === 'Run')
  assert.equal(verb?.tone, 'toolBash'); assert.equal(verb?.bold, true)
  assert.doesNotMatch(text(rows), /CMD/)
  assert.ok(heading.spans.filter(part => part.text.includes('pnpm test --filter auth')).every(part => part.tone === 'text'))
  const command = itemRows({ kind: 'command', id: 'c', name: 'goal', args: 'ship it', settled: true }, opts())
  assert.equal(command.flatMap(value => value.spans).find(part => part.text.includes('ship it'))?.tone, 'text')
})
test('user-invocable skills join the slash palette, and a command of the same name wins', () => {
  const merged = mergeCommands([{ name: 'plan', description: 'plan with the preset' }], [{ name: 'playwright-cli', description: 'Automate  a\nbrowser' }, { name: 'plan', description: 'skill shadowed by the command' }])
  assert.deepEqual(merged.find(entry => entry.name === 'playwright-cli'), { name: 'playwright-cli', description: 'Automate a browser', hint: 'task', origin: 'skill' })
  assert.equal(merged.find(entry => entry.name === 'plan')?.origin, 'registry')
})

const { ANIMATION_ASSETS, SceneAnimations, THINKING_MARK } = await import('../src/animation.ts')
const animations = new SceneAnimations(ANIMATION_ASSETS, error => { throw error })
const { titleSpinner, terminalTitle } = await import('../src/terminal-signals.ts')
test('without a terminal height, live reasoning carries the small Thinking mark beside its label; settled reasoning keeps its duration', () => {
  const renderer = createDocumentRenderer()
  const old = {kind:'assistant', id:'old', reasoning:'earlier', text:'', settled:true, reasoningStartedAt:1000, reasoningEndedAt:4500}
  const live = {kind:'assistant', id:'new', reasoning:'first\nsecond', text:'', settled:false, reasoningStartedAt:10000}
  const options = {...opts(100), tick:8, now:17000, animations}
  renderer.render([old],options)
  const rows = renderer.render([old,live],options)
  // A settled thought folds to one row that says how long it took.
  assert.deepEqual(rows.filter(r=>r.itemId==='old').map(textOfRow), ['', '  ✦ Thought · 3.5s'])
  assert.doesNotMatch(text(rows.filter(r=>r.itemId==='old')), /[\u2801-\u28ff]/u)
  const label=rows.find(r=>textOfRow(r).includes('Thinking…'))
  assert.match(textOfRow(label), /^ {2}› Thinking… · 7s · 2 lines {2}[ \u2800-\u28ff]{12}$/u)
  // Live reasoning has no frame: the label row with the mark's rows above and below it, then the latest two reasoning rows.
  const own = rows.filter(r=>r.itemId==='new')
  assert.equal(own.length, 6)
  assert.doesNotMatch(text(own), /[╭╮╰╯│─⎻⎼]|Show details/u)
  assert.ok(own.slice(1, 4).some(r=>r.spans.some(p=>p.tone==='reasoning' && /[\u2801-\u28ff]/u.test(p.text))))
  assert.deepEqual(own.slice(1, 4).map(r=>textOfRow(r).slice(30)), animations.frame(THINKING_MARK, 7000).map(textOfRow))
  assert.deepEqual(own.slice(4).map(textOfRow), ['  ┊ first', '  ┊ second▍'])
  assert.match(text(renderer.render([old,live],{...options,now:18000})), /Thinking… · 8s/)
  live.reasoningEndedAt=18500;live.settled=true
  const done=renderer.render([old,live],{...options,now:30000})
  // Settled, live reasoning becomes one row joined to the thought before it, without the mark.
  assert.deepEqual(done.filter(r=>r.itemId==='new').map(textOfRow), ['  ✦ Thought · 8.5s'])
  assert.doesNotMatch(text(done), /[╭╮╰╯\u2801-\u28ff]/u)
  assert.deepEqual(renderer.render([old,live],{...options,now:60000,tick:20}),done)
  // Opened, it is its title row with the reasoning behind a rail, and no frame.
  const open=renderer.render([old,live],{...options,now:30000,overrides:{'reasoning:new':true}})
  assert.match(text(open.filter(r=>r.itemId==='new')), /^ {2}▾ Thought · 8s · 2 lines\n {2}┃ first\n {2}┃ second$/mu)
  assert.doesNotMatch(text(open), /[╭╮╰╯│]/u)
  // Every cell of the heading after the margin toggles the reasoning.
  assert.ok(done.filter(r=>r.itemId==='new' && r.heading).every(r=>r.spans.slice(1).every(p=>p.action?.kind==='toggle-reasoning')))
})
test('the terminal title carries a turning dot spinner only while a turn runs', () => {
  const running={sessionId:'one',title:'Auth',running:true}
  assert.equal(new Set(Array.from({length:8},(_,frame)=>titleSpinner(frame))).size,8)
  assert.equal(titleSpinner(8),titleSpinner(0))
  assert.match(terminalTitle(running,3),/\]2;[⣾⣽⣻⢿⡿⣟⣯⣷] DSH · Auth · working/u)
  assert.match(terminalTitle(running),/DSH · Auth · working/u)
  assert.match(terminalTitle({...running,running:false},3),/DSH · Auth · ready/u)
  assert.match(terminalTitle({...running,pendingId:'q'},3),/DSH · Auth · attention/u)
})
test('reasoning decorations wrap without losing controls and keep a fixed frame size', () => {
  const item={kind:'assistant',id:'live',reasoning:'reason',text:'',settled:false,reasoningStartedAt:0}
  for(const width of [1,28,40,80,120]) {
    const frames=[0,6,12,24].map(tick=>itemRows(item,{...opts(width),tick,now:9000,animations}))
    frames.forEach(rows=>bounded(rows,width))
    assert.ok(frames.every(rows=>rows.length===frames[0].length))
    // The label is the control: each of its cells toggles the reasoning.
    if(width>=28) assert.ok(frames[0].some(r=>textOfRow(r).includes('Thinking…') && r.spans.slice(1).every(p=>p.action?.kind==='toggle-reasoning')))
  }
})
test('the status row shows a running Laya pass as its phase label alone and the work timer only while a turn runs', () => {
  const state=fixture({motion:false,status:'running'})
  state.transcript.layaPruning=true;state.transcript.workStartedAt=1000
  const first=statusRow(state,140,0,62000),next=statusRow(state,140,8,62000)
  assert.deepEqual(first,next)
  assert.match(textOfRow(first),/^laya_context_pruner · pruning context  ·  deepseek\/reasoner high  ·  1m 1s /)
  // Decode speed and TTFT stay in /context.
  assert.doesNotMatch(textOfRow(first),/decode|TTFT|tok\/s/)
  state.status='idle';state.transcript.workCompletedAt=63000
  assert.doesNotMatch(textOfRow(statusRow(state,100,20,100000)),/1m/)
})

test('an open tool card is its title row and a rail, without a frame, and shows the command and what it does', () => {
  const item = tool({call:{card:'terminal',title:'echo exact-command',description:'Check the shell',cwd:'/work'},args:{command:'echo exact-command',description:'Check the shell',timeout:10}})
  for (const width of [8, 29, 39, 79, 120]) for (const expanded of [false,true]) {
    const rows=itemRows(item,{width,expanded,overrides:{}})
    bounded(rows,width)
    assert.doesNotMatch(text(rows), /Arguments|Directory|"command"|"description"|[╭╮╰╯│]/u)
    if (!expanded) {
      // Collapsed, the call is one clickable row, and its description takes rows of its own when it does not fit beside it.
      assert.ok(width>=79?rows.length===2:rows.length>=2)
      assert.ok(rows.slice(1).every(r=>r.spans.every(p=>p.action?.kind==='inspect-item'&&p.action.itemId===item.id)))
      continue
    }
    // Open, the title row folds the card again; every row under it starts with the rail, in the tool's tone.
    const title=rows[1]
    assert.ok(title.spans.filter(p=>p.text.trim()!=='').every(p=>p.action?.kind==='inspect-item'&&p.action.itemId===item.id))
    if(width>=12){
      assert.ok(rows.slice(2).every(r=>textOfRow(r).startsWith('  ┃ ')))
      assert.ok(rows.slice(2).every(r=>r.spans[1].tone==='toolBash'))
    }
    if(width===79){
      for(const value of ['Check the shell','echo exact-command','exit 0']) assert.ok(text(rows).includes(value),value)
      assert.doesNotMatch(text(rows),/Description|Command|Result|Hide details/)
    }
  }
})
test('a pruning result compares before and after as meters and marks each output with a full, half or empty circle', () => {
  const item={kind:'laya',id:'laya',outcome:'pruned',tokensBefore:48200,tokensAfter:21900,ms:3400,kept:1,truncated:1,dropped:1,settled:true,entries:[
    {label:'read src/auth.ts',action:'KEEP',lines:100,tokensBefore:1800,tokensAfter:1800},{label:'bash pnpm test',action:'TRUNCATE',lines:420,tokensBefore:9200,tokensAfter:1400},
    {label:'grep "token"',action:'DROP',lines:260,tokensBefore:6100,tokensAfter:0}]}
  const rows=itemRows(item,opts(100,false))
  assert.deepEqual(rows.slice(1).map(value=>textOfRow(value).trimEnd()),[
    `  ▸ ▞▚ Context pruned  −55%${' '.repeat(69)}3.4s`,
    '    before ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰  48k',
    '    after  ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  22k   1 kept · 1 truncated · 1 dropped',
    '    ◐ truncated bash pnpm test     9.2k → 1.4k  ▰▰▱▱▱▱▱▱▱▱',
    '    ○ dropped   grep "token"       6.1k → 0     ▱▱▱▱▱▱▱▱▱▱',
    '    ● kept      read src/auth.ts   1.8k → 1.8k  ▰▰▰▰▰▰▰▰▰▰',
  ])
  // One colour: the accent for what remains, greys for the rest; no success, warning or error tone.
  const tones=new Set(rows.flatMap(value=>value.spans).map(part=>part.tone))
  assert.ok(['success','warning','error'].every(tone=>!tones.has(tone)))
  assert.ok(rows[1].spans.every(part=>part.action?.kind==='inspect-item'))
  // Too narrow for the meters, the title carries the figures; a pass that fell back says so in the warning tone.
  for(const width of [12,30,59,60,100]) bounded(itemRows(item,opts(width,true)),width)
  assert.match(text(itemRows(item,opts(40,false))),/Context pruned {2}−55% {2}48k → 22k/)
  assert.doesNotMatch(text(itemRows(item,opts(40,false))),/[▰▱]/u)
  const skipped=itemRows({...item,outcome:'fallback',error:'model unavailable',entries:[]},opts(100,false))
  assert.match(text(skipped),/▸ ▞▚ Context pruning skipped · regular compaction decides · model unavailable/)
  assert.ok(skipped.flatMap(value=>value.spans).some(part=>part.tone==='warning'))
})
test('slash command disclosure reveals all output and arguments without changing history', () => {
  const item={kind:'command',id:'command-view',name:'example',args:'the original arguments',settled:true,result:{kind:'success',text:Array.from({length:20},(_,i)=>`result-${i}`).join('\n')}}
  const original=JSON.stringify(item)
  const closed=text(itemRows(item,opts(79,false))),open=text(itemRows(item,opts(79,true)))
  assert.doesNotMatch(closed,/result-19/);assert.match(open,/result-19/);assert.match(open,/the original arguments/)
  assert.equal(JSON.stringify(item),original)
})

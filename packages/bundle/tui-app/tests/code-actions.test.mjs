import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeBlocks } from '../src/code-blocks.ts'
import { markdownRows, createStreamingMarkdown } from '../src/markdown-layout.ts'
import { createDocumentRenderer, itemRows } from '../src/document.ts'
import { diffRows } from '../src/diff-layout.ts'
import { row, span, widthOf, textOfRow } from '../src/rich-text.ts'
import { hitTest, joinPanes, paneWidths } from '../src/panes.ts'
import { parseMouse } from '../src/mouse.ts'
import { createSessionBrowser, mergeSessionSearch } from '../src/session-browser.ts'
const assistant=text=>({kind:'assistant',id:'answer',reasoning:'',text,settled:true})
const raw='Before\r\n\r\n```powershell\r\nInvoke-RestMethod `\r\n\t-Uri "https://example.test/東京"\r\n```\r\n\r\n~~~json\n{"ok":true}\n~~~'
test('raw fences preserve CRLF, backticks, indentation, Unicode and multiple block identity',()=>{
  const blocks=codeBlocks(raw);assert.equal(blocks.length,2)
  assert.equal(blocks[0].text,'Invoke-RestMethod `\r\n\t-Uri "https://example.test/東京"\r\n')
  assert.equal(blocks[1].text,'{"ok":true}\n');assert.ok(blocks.every(block=>block.complete))
  assert.equal(codeBlocks('````md\n```js\nhi\n```\n````')[0].text,'```js\nhi\n```\n')
  assert.equal(codeBlocks('```ps\nWrite-Output 1')[0].complete,false)
})
for(const width of [28,40,79,159])test(`Copy buttons retain exact block targets at width ${width}`,()=>{
  const rows=itemRows(assistant(raw),{width,expanded:false,overrides:{}})
  const targets=rows.flatMap(row=>row.spans).filter(part=>part.action?.kind==='copy-code')
  assert.deepEqual(targets.map(part=>part.action.block),[0,1]);assert.ok(targets.every(part=>part.text==='Copy'))
  assert.ok(rows.every(row=>widthOf(textOfRow(row))<=width))
})
test('streaming caches preserve per-message Copy indices across stable blocks and rewrites',()=>{
  const renderer=createDocumentRenderer();const item=assistant(''),options={width:79,expanded:false,overrides:{}}
  for(const piece of ['First\n\n```js\nx()\n```','\n\nNext\n\n~~~json\n','{}\n~~~\n\nEnd.']){
    item.text+=piece;assert.deepEqual(renderer.render([item],options),itemRows(item,options))
  }
  item.text='```py\nx=1\n```';assert.equal(renderer.render([item],options).flatMap(row=>row.spans).filter(part=>part.action?.kind==='copy-code').length,1)
})
test('injected escape sequences cannot create a mismatched raw code button',()=>{
  const source='\x1b[31m```js\nnot a raw fence\n\n```py\nreal body\n```'
  const rows=itemRows(assistant(source),{width:79,expanded:false,overrides:{}})
  const targets=rows.flatMap(row=>row.spans).filter(part=>part.action?.kind==='copy-code')
  assert.equal(targets.length,1);assert.equal(codeBlocks(source)[targets[0].action.block].text,'real body\n')
})
test('mouse hit testing uses cell coordinates, clipping and pane padding, not character offsets',()=>{
  const action={kind:'copy-text',text:'raw',label:'test'},value=row(span('東京 '),{...span('[ Copy ]'),action})
  assert.equal(hitTest([value],4,0),undefined);assert.equal(hitTest([value],5,0),action);assert.equal(hitTest([value],13,0),undefined)
  const widths={left:70,right:86,divider:70},joined=joinPanes([row('left')],[value],widths,4)
  assert.equal(hitTest(joined,widths.left+3+5,0),action);assert.equal(hitTest(joined,0,9),undefined)
  // Menus and details always open in-page: no width or mode splits the screen.
  for(const mode of ['auto','single','split'])assert.equal(paneWidths(240,mode),undefined)
})
test('mouse distinguishes press/release/modifiers/drag and preserves wheel location',()=>{
  assert.deepEqual(parseMouse('\x1b[<0;9;4M'),{kind:'button',x:8,y:3,pressed:true,primary:true,modified:false,motion:false})
  assert.equal(parseMouse('[<0;9;4m').pressed,false)
  assert.equal(parseMouse('[<4;9;4M').modified,true)
  // Drag: the left button is still the one held, and the sample is motion.
  assert.deepEqual(parseMouse('[<32;9;4M'),{kind:'button',x:8,y:3,pressed:true,primary:true,modified:false,motion:true})
  assert.equal(parseMouse('[<35;9;4M').primary,false)
  assert.equal(parseMouse('[<65;149;9M').x,148)
})
test('adaptive side-by-side diff keeps both sides and wraps long replacements without losing text',()=>{
  const old='start\nold-'+ 'x'.repeat(180)+'\nend\n',next='start\nnew-'+ 'y'.repeat(210)+'\nextra\nend\n'
  const wide=diffRows([{path:'src/a.ts',oldText:old,newText:next}],159,true),narrow=diffRows([{path:'src/a.ts',oldText:old,newText:next}],60,true)
  assert.match(wide.map(textOfRow).join('\n'),/BEFORE.*AFTER/);assert.ok(!narrow.map(textOfRow).join('\n').includes('BEFORE'))
  assert.equal(wide.map(textOfRow).join('').match(/x/g).length,181) // 180 x + x in extra
  assert.equal(wide.map(textOfRow).join('').match(/y/g).length,210)
  assert.ok(wide.every(row=>widthOf(textOfRow(row))<=159));assert.ok(narrow.every(row=>widthOf(textOfRow(row))<=60))
})
test('session content search stays in authorized scope and keeps metadata matches',()=>{
  const rows=[{id:'a',label:'OAuth',detail:'repo A'},{id:'b',label:'Bug',detail:'repo A'}]
  const result=mergeSessionSearch(rows,'OAuth',{items:[{sessionId:'b',snippet:'Discuss OAuth here'},{sessionId:'private',snippet:'OAuth'}],hasMore:true})
  assert.deepEqual(result.map(item=>item.id),['a','b']);assert.match(result[1].detail,/Match: Discuss OAuth/)
})
test('browser reads core search and detached logs without agent activation and honors cancellation/cache',async()=>{
  const calls=[];const api={async search(request,signal){calls.push(['search',request,signal]);return {items:[],hasMore:false}},async readSession(id){calls.push(['readSession',id]);return {session:{cwd:'/repo'},events:[],inheritedEventCount:0}},resolveAgent(){throw Error('must not activate')}}
  const browser=createSessionBrowser(api,api),signal=new AbortController().signal
  await browser.search('needle',signal);assert.equal((await browser.preview('session-a',signal)).cwd,'/repo');await browser.preview('session-a',signal)
  assert.deepEqual(calls.map(call=>call[0]),['search','readSession']);browser.clear();await browser.preview('session-a',signal);assert.equal(calls.length,3)
  const abort=new AbortController();abort.abort();await assert.rejects(browser.preview('session-a',abort.signal))
})
test('CRLF and bare CR streams have identical rows to full rendering after every chunk',()=>{
  const cache=createStreamingMarkdown();let text=''
  for(const piece of ['First\r\n\r\n','```pwsh\r\nWrite-Output 1\r','\n```\r\n\r\nNext\r\n\r\n','~~~js\rx=1\r~~~']){
    text+=piece;assert.deepEqual(cache.rows('id',text,79),markdownRows(text,79))
  }
})

test('PowerShell highlighting preserves literal API snippets and continuation backticks',async()=>{
  const {highlight}=await import('../src/syntax.ts')
  for(const language of ['powershell','pwsh','ps1'])for(const text of ['$token = $env:API_TOKEN','Invoke-RestMethod -Method Get `','  -Uri "https://example.test/v1" `',"'single '' quote' # comment"]){
    const spans=highlight(text,language)
    assert.equal(spans.map(p=>p.text).join(''),text)
    assert.ok(spans.some(p=>p.tone!=='text'))
  }
})
test('paste placeholders round-trip, bound retention and locate their own token',async()=>{
  const { shouldCollapse, addBlock, placeholder, placeholderAt, expandPastes, referenced, MAX_BLOCKS }=await import('../src/paste.ts')
  assert.equal(shouldCollapse('one\ntwo\nthree\nfour'),false)
  assert.equal(shouldCollapse('one\ntwo\nthree\nfour\nfive'),true)
  assert.equal(shouldCollapse('x'.repeat(513)),true)
  const body='a\nb\nc\nd\ne\nf'
  const first=addBlock([],body,1)
  assert.equal(placeholder(first.block),'[Pasted text #1 +6 lines]')
  assert.equal(placeholder({id:9,text:'single'}),'[Pasted text #9 +1 line]')
  const draft=`before ${placeholder(first.block)} after`
  assert.equal(expandPastes(draft,first.blocks),`before ${body} after`)
  // An unknown number is left alone rather than silently dropped.
  assert.equal(expandPastes('[Pasted text #7 +2 lines]',first.blocks),'[Pasted text #7 +2 lines]')
  const start=draft.indexOf('['),end=start+placeholder(first.block).length
  assert.equal(placeholderAt(draft,end,'before').start,start)
  assert.equal(placeholderAt(draft,start,'after').end,end)
  assert.equal(placeholderAt(draft,start,'before'),undefined)
  assert.equal(placeholderAt(draft,end,'after'),undefined)
  assert.deepEqual(referenced('nothing here',first.blocks),[])
  let kept=[]
  for(let i=1;i<=MAX_BLOCKS+5;i++)kept=addBlock(kept,`body ${i}`,i).blocks
  assert.equal(kept.length,MAX_BLOCKS);assert.equal(kept[0].id,6)
})

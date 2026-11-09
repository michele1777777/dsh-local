/** Export deterministic UI layouts. Fixtures, not screenshots of a live LLM. */
import { register } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
register('./ui-loader.mjs',import.meta.url)
const { App }=await import('../src/app.tsx')
const { createHarness }=await import('./ui-harness.mjs')
const { createStore }=await import('../src/store.ts')
const { mergeCommands }=await import('../src/commands.ts')
const { fixture, conversation, approval, question }=await import('./fixtures.mjs')
const { textOfRow,widthOf }=await import('../src/rich-text.ts')
const out=resolve(process.argv[2]??'terminal-preview')
await mkdir(out,{recursive:true})
const commands=()=>mergeCommands([{name:'plan',description:'plan using the session preset'},{name:'goal',description:'set or inspect the persistent goal'},{name:'compact',description:'compact session context'}])
const sessionRows=[
  {id:'saved-oauth',label:'OAuth refresh tokens',detail:'Today · C:\\Projects\\api · standard',command:'/resume saved-oauth'},
  {id:'saved-streaming',label:'Streaming parser',detail:'Yesterday · C:\\Projects\\gateway · standard',command:'/resume saved-streaming'},
  {id:'saved-tests',label:'Integration tests',detail:'Yesterday · C:\\Projects\\api · standard',command:'/resume saved-tests'},
]
const powershell='## Call the API from PowerShell\n\nRead the token from your environment, then send the request:\n\n```powershell\n$token = $env:API_TOKEN\n$headers = @{ Authorization = "Bearer $token" }\n\nInvoke-RestMethod -Method Get `\n  -Uri "https://api.example.test/v1/users" `\n  -Headers $headers\n```\n\nThe Copy button copies the original code, without the display gutter.'
async function click(h,kind,predicate=()=>true){
  for(const [y,r] of h.rows().entries()){let x=0;for(const p of r.spans){if(p.action?.kind===kind&&predicate(p.action)){await h.key(`\x1b[<0;${x+1};${y+1}M`);return}x+=widthOf(p.text)}}
  throw Error('Missing visible target '+kind)
}
const scenarios=[
  ['conversation',108,34,{}],['code-copy',108,34,{}],['copied',108,34,{}],
  ['tool-split',164,36,{}],['changes',164,36,{panel:'changes'}],
  ['permission',164,32,{pending:[approval()]}],['plan-review',154,32,{pending:[question()]}],
  ['sessions',164,32,{picker:{kind:'sessions',title:'Resume a saved session',rows:sessionRows,all:true}}],
  ['narrow',40,24,{}],['context',100,35,{panel:'context'}],['commands',108,32,{}],
]
for(const [name,width,height,overrides] of scenarios){
  const state=fixture({mouse:true,links:true,layout:'auto',...overrides});state.transcript.items=conversation()
  if(['code-copy','copied','narrow'].includes(name))state.transcript.items=[{kind:'user',id:'ps-user',text:'Show me how to call an API in PowerShell.',settled:true,queued:false},{kind:'assistant',id:'ps-answer',text:powershell,reasoning:'',settled:true}]
  const store=createStore(state)
  const controller={async submit(){},async runCommand(){},cancel(){},exit(){},commands,answerApproval(){},answerQuestion(){},hint(text){store.update(s=>{s.hint=text})},closePicker(){},report(){},
    async copyText(){return {confirmed:true,transport:'fixture only'}},
    async previewSession(id){return {sessionId:id,cwd:'C:\\Projects\\api',messages:47,tools:21,firstPrompt:'Implement OAuth refresh-token rotation without changing the public API.',lastResponse:'Refresh-token rotation is implemented. The stored-session contract is unchanged.\n\nUpdated src/auth/oauth.ts and the integration tests.\n\nResume this session to read its full conversation and tool results.'}},
  }
  const h=createHarness(App,store,controller,width,height)
  if(name==='commands')await h.paste('/')
  if(name==='tool-split'){await h.key('',{ctrl:true,home:true});await click(h,'inspect-item',a=>a.itemId==='tool-diff')}
  if(name==='changes')await h.key('',{ctrl:true,home:true})
  if(name==='copied')await click(h,'copy-code')
  if(name==='sessions'){await new Promise(r=>setTimeout(r,130));await h.flush()}
  const rows=h.rows();h.dispose()
  await writeFile(resolve(out,name+'.json'),JSON.stringify({name,columns:width-1,rows:height,lines:rows},null,2)+'\n')
  await writeFile(resolve(out,name+'.txt'),rows.map(textOfRow).join('\n')+'\n')
}
console.log(`Fixture layouts written to ${out}`)

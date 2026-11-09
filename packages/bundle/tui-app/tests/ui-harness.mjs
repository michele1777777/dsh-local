/**
 * Small deterministic hook harness for App's input state machine.
 * This is NOT React/Ink/Yoga and cannot validate real terminal painting.
 */
let active
export const jsx = (type, props, key) => ({type,props,key})
export const jsxs = jsx
export const Box = props => jsx('box',props)
export const Text = props => jsx('text',props)
export function useState(initial) {
  const harness=active,index=harness.cursor++
  if (!(index in harness.slots)) harness.slots[index]=typeof initial==='function'?initial():initial
  return [harness.slots[index],value=>{const next=typeof value==='function'?value(harness.slots[index]):value;if(!Object.is(next,harness.slots[index])){harness.slots[index]=next;harness.dirty=true}}]
}
export function useRef(initial){return useState(()=>({current:initial}))[0]}
const changed=(a,b)=>a===undefined||b===undefined||a.length!==b.length||a.some((value,index)=>!Object.is(value,b[index]))
export function useMemo(factory,deps){const h=active,i=h.cursor++;const old=h.slots[i];if(!old||changed(old.deps,deps))h.slots[i]={deps,value:factory()};return h.slots[i].value}
export function useEffect(effect,deps){const h=active,i=h.cursor++;const old=h.slots[i];if(!old||changed(old.deps,deps)){h.slots[i]={deps,cleanup:old?.cleanup};h.effects.push(()=>{h.slots[i].cleanup?.();h.slots[i].cleanup=effect()})}}
export function useSyncExternalStore(subscribe,snapshot){const h=active;useEffect(()=>subscribe(()=>{h.dirty=true}),[subscribe]);return snapshot()}
export function useInput(handler){active.input=handler}
export function usePaste(handler){active.pasteHandler=handler}
export function useWindowSize(){return {columns:active.columns,rows:active.height}}
export function useStdout(){const h=active;return {stdout:h.stdout,write(text){h.written.push(text)}}}
export function createHarness(App,store,controller,columns=80,height=24,terminal){
  const h={slots:[],cursor:0,effects:[],dirty:true,columns,height,input:undefined,pasteHandler:undefined,frame:undefined,written:[],stdout:{write(text){h.written.push(text)}},
    render(){let rounds=0;do{if(++rounds>30)throw Error('Hook harness rerender loop');h.cursor=0;h.effects=[];h.dirty=false;active=h;h.frame=App({store,controller,terminal});active=undefined;for(const effect of h.effects)effect()}while(h.dirty);return h.frame},
    async flush(){for(let i=0;i<6;i++){await Promise.resolve();if(h.dirty)h.render()}return h.frame},
    async key(input='',key={}){h.input(input,{eventType:'press',...key});h.render();return h.flush()},
    async paste(text){h.pasteHandler(text);h.render();return h.flush()},
    resize(columns,height){h.columns=columns;h.height=height;return h.render()},
    rows(){return h.frame.props.rows},
    text(){return h.rows().map(row=>row.spans.map(span=>span.text).join('')).join('\n')},
    dispose(){for(const slot of h.slots)if(slot&&typeof slot.cleanup==='function')slot.cleanup()},
  };h.render();return h
}

export function useApp(){return {async suspendTerminal(callback){await callback()},async waitUntilRenderFlush(){}}}

export const memo = component => component

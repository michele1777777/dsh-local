import { describe, it, expect, vi } from 'vitest'
import { PrechatDialog } from '../src/client/dialog.ts'
const text='USER: Question\nASSISTANT: Answer'
describe('prechat editor',()=>{
  it('previews before applying and retains the exact text',async()=>{
    const apply=vi.fn().mockResolvedValue(undefined),dialog=new PrechatDialog(apply)
    dialog.open();dialog.edit(text);await dialog.submit();expect(apply).not.toHaveBeenCalled()
    dialog.preview();expect(dialog.state.getSnapshot().messages).toHaveLength(2)
    await dialog.submit();expect(apply).toHaveBeenCalledWith(text);expect(dialog.state.getSnapshot().open).toBe(false)
  })
  it('keeps invalid text and reports its line',()=>{
    const dialog=new PrechatDialog(async()=>{});dialog.open();dialog.edit('USER: q\nUSER: a');dialog.preview()
    expect(dialog.state.getSnapshot().text).toContain('USER: a');expect(dialog.state.getSnapshot().error).toContain('Line 2')
  })
  it('preserves the draft after host rejection and prevents duplicate applies',async()=>{
    let reject!: (error:Error)=>void
    const apply=vi.fn(()=>new Promise<void>((_resolve,no)=>{reject=no})),dialog=new PrechatDialog(apply)
    dialog.open();dialog.edit(text);dialog.preview()
    const pending=dialog.submit(); await dialog.submit(); expect(apply).toHaveBeenCalledTimes(1)
    reject(Error('model changed')); await pending
    expect(dialog.state.getSnapshot()).toMatchObject({ open:true,busy:false,text,error:'model changed' })
  })
  it('ignores a slow file read after the user edits or cancels',async()=>{
    let resolve!: (bytes:ArrayBuffer)=>void
    const file={ name:'chat.txt',size:20,arrayBuffer:()=>new Promise<ArrayBuffer>((done)=>{resolve=done}) } as File
    const dialog=new PrechatDialog(async()=>{});dialog.open();const loading=dialog.load(file);dialog.edit('new draft');resolve(new TextEncoder().encode(text).buffer);await loading
    expect(dialog.state.getSnapshot().text).toBe('new draft')
  })
})


it('does not resurrect a disposed draft when a submission fails late', async () => {
  let reject!: (error: Error) => void
  const dialog = new PrechatDialog(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  dialog.open(); dialog.edit(text); dialog.preview()
  const pending = dialog.submit(); dialog.dispose(); reject(new Error('late failure')); await pending
  expect(dialog.state.getSnapshot()).toMatchObject({ open: false, text: '', busy: false, error: null })
})

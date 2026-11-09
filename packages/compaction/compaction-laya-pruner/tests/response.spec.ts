import { describe, expect, it } from 'vitest'
import { readLayaResponse } from '../src/response.ts'

function response(lines: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(lines)
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  }), { headers: { 'content-type': 'application/x-ndjson' } })
}

describe('managed Laya lifecycle stream', () => {
  it('reports all real phases and returns the result after restoration', async () => {
    const phases: string[] = []
    const values = ['release', 'start', 'prune', 'stop', 'restore'].map(phase => JSON.stringify({ phase }))
    const result = { items: [], stats: { label: '完成 🟢' } }
    const reply = response([...values, JSON.stringify({ result }), ''].join('\n'), 1)
    await expect(readLayaResponse(reply, phase => phases.push(phase))).resolves.toEqual(result)
    expect(phases).toEqual(['release', 'start', 'prune', 'stop', 'restore'])
  })

  it('rejects a truncated UTF-8 sequence after the terminal result', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('{"result":{}}\n'), 0xe2])
    const reply = new Response(bytes, { headers: { 'content-type': 'application/x-ndjson' } })
    await expect(readLayaResponse(reply, () => {})).rejects.toThrow()
  })

  it('keeps the resident JSON protocol unchanged', async () => {
    const phases: string[] = []
    await expect(readLayaResponse(Response.json({ items: [] }), phase => phases.push(phase))).resolves.toEqual({ items: [] })
    expect(phases).toEqual([])
  })

  it.each([
    ['{"phase":"start"}\n', 'Incomplete'],
    ['{"phase":"restore"}\n{"error":"worker failed"}\n', 'worker failed'],
    ['{"result":{}}', 'Incomplete'],
    ['{"phase":"future"}\n', 'Unknown'],
    ['{"result":{}}\n{"phase":"restore"}\n', 'Invalid'],
  ])('rejects failed or incomplete stream %s', async (body, error) => {
    await expect(readLayaResponse(response(body), () => {})).rejects.toThrow(error)
  })
})

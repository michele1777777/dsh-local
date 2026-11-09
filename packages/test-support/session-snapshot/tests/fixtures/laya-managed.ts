/** Managed Laya HTTP fixture: real pruning pass, recorded phases, unchanged history. */
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import * as laya from '../../../../compaction/compaction-laya-pruner/src/index.ts'

export const name = 'snapshot-laya-managed'
export const inject = laya.inject

/** Start a local worker-protocol fixture and mount the real pruning pass. */
export async function apply(ctx: Context): Promise<void> {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/laya/compact') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (const phase of ['release', 'start', 'prune', 'stop', 'restore']) response.write(`${JSON.stringify({ phase })}\n`)
      response.end(`${JSON.stringify({ result: { items: [] } })}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  ctx.effect(() => () => { server.closeAllConnections(); server.close() })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Laya fixture requires a TCP address')
  ctx.plugin(laya, {
    modelEndpoints: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', url: `http://127.0.0.1:${address.port}/v1/laya/compact` }],
    thresholdRatio: 0.8, headroomTokens: 1800, targetRatio: 0.25,
  })
}

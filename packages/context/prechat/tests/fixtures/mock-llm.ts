/** Deterministic providers for the assembled import and model-switch smoke. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
class Adapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: provider === 'ds4-v41-flash' ? 'deepseek-v4.1-flash' : 'test-other', name: 'Test model' }]
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const imported = request.messages.filter(message => message.source?.kind === 'prechat' || (message.source?.kind === 'model' && message.source.provider === 'prechat'))
    console.log('PRECHAT_REQUEST', JSON.stringify(imported.map(message => ({ role: message.role, content: message.content }))))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Ready.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const name = 'prechat-test-provider'
export const inject = ['llm']
export function apply(ctx: Context): void { ctx.llm.registerAdapter(['ds4-v41-flash', 'test-other'], new Adapter()) }

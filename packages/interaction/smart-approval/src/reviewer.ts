/** Auxiliary LLM requests with no tools, agent session routing, or transcript writes. */

import { BlockAssembler, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReviewInput } from './context.ts'
import { parseDecision, REVIEW_POLICY, type ReviewDecision } from './protocol.ts'

/** Output limits include provider reasoning to bound malformed or runaway responses. */
export interface ReviewLimits {
  maxOutputTokens: number
  maxOutputChars: number
}

/**
 * Materialize an isolated, tool-free one-shot request through the existing LLM runtime.
 * @param input - bounded data and exact current route.
 * @param limits - host-reviewed output limits.
 * @param signal - combined request, deadline, and plugin lifetime cancellation.
 * @returns provider-neutral options; no sessionId and no main-agent history.
 */
export function reviewOptions(input: ReviewInput, limits: ReviewLimits, signal: AbortSignal): GenerateOptions {
  return {
    provider: input.provider,
    model: input.model,
    system: REVIEW_POLICY,
    // Request-only input: the review is never persisted, so it carries no durable id or source.
    messages: [{ role: 'user', content: [{ type: 'text', text: input.text }] }],
    tools: [],
    temperature: 0,
    maxTokens: limits.maxOutputTokens,
    signal,
  }
}

/**
 * Consume a complete, bounded response and enforce the strict decision protocol.
 * @param stream - isolated provider stream.
 * @param maxChars - response size cap, including reasoning.
 * @param signal - cancellation fence checked before accepting each chunk.
 * @returns a decision only after a valid terminal stop.
 */
export async function readDecision(stream: AsyncIterable<StreamChunk>, maxChars: number, signal: AbortSignal): Promise<ReviewDecision> {
  const assembler = new BlockAssembler()
  let finished = false
  let characters = 0
  for await (const chunk of stream) {
    signal.throwIfAborted()
    if (finished) throw new Error('Reviewer emitted data after finish')
    // Count the serialized wire chunks too: unconsumed or unexpected metadata cannot grow without bound.
    characters += JSON.stringify(chunk).length
    if (characters > maxChars) throw new Error('Reviewer response exceeded its size limit')
    assembler.push(chunk)
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop') throw new Error('Reviewer did not finish normally')
      finished = true
    }
  }
  signal.throwIfAborted()
  if (!finished) throw new Error('Reviewer omitted its terminal finish')
  const blocks = assembler.blocks()
  const last = blocks.at(-1)
  if (last?.type !== 'text' || blocks.slice(0, -1).some(block => block.type !== 'reasoning')) {
    throw new Error('Reviewer must return one final text block and no tool calls')
  }
  return parseDecision(last.text)
}

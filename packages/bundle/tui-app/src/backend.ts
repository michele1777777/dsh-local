/**
 * Thin terminal adapter to the Web's SessionController. No prompt assembly,
 * compaction, model restoration, admission or resume implementation lives here.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection, PromptContentPart, SessionPromptValue, SessionRequestId, SessionController } from '@deepseek-ai/dsh-api-session-controller'

/**
 * Preserve the exact content, request identity, admission mode and timezone of Web requests.
 * @param sessionId - target Session.
 * @param text - prompt text; empty text adds no text part.
 * @param clientTimeZone - IANA time zone of the terminal host.
 * @param mode - inbox admission mode.
 * @param attachments - content parts appended after the text part.
 * @param requestId - client-minted request identity; a fresh UUID by default.
 * @returns the SessionController prompt request.
 */
export function promptRequest(sessionId: SessionId, text: string, clientTimeZone: string,
  mode: 'queue' | 'steer' = 'queue', attachments: readonly PromptContentPart[] = [],
  requestId = brandString<SessionRequestId>(randomUUID())): {
  sessionId: SessionId
  requestId: SessionRequestId
  mode: 'queue' | 'steer'
  content: ({ type: 'text'; text: string } | PromptContentPart)[]
  clientTimeZone: string
} {
  return { sessionId, requestId, mode, content: [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...attachments], clientTimeZone }
}

/** Terminal-side facade over the context's SessionController, bound to one client time zone. */
export class TerminalBackend {
  /** SessionController that owns Session creation, resume, prompting and model selection. */
  readonly api: SessionController
  constructor(private readonly ctx: Context, readonly clientTimeZone: string) {
    this.api = ctx.sessionController
  }
  /**
   * Create a Session through SessionController and resolve its Agent.
   * @param cwd - working directory of the new Session.
   * @param preset - agent preset name; the controller default when omitted.
   * @returns the new Session's Agent.
   */
  async create(cwd: string, preset?: string): Promise<Agent> {
    const { sessionId } = await this.api.create({ cwd, ...(preset === undefined ? {} : { agentPreset: preset }) })
    return this.resume(sessionId)
  }
  /**
   * Resolve the Agent of an existing Session.
   * @param sessionId - Session to resume.
   * @returns the resolved Agent.
   * @throws the controller's resolution error when the Session cannot be resolved.
   */
  async resume(sessionId: SessionId): Promise<Agent> {
    const result = await this.api.resolveAgent(sessionId)
    if ('error' in result) throw result.error
    return result.agent
  }
  /**
   * Submit a prompt to the Agent's inbox with a fresh request identity.
   * @param agent - target Agent.
   * @param text - prompt text.
   * @param signal - aborts the submission.
   * @param mode - inbox admission mode.
   * @param attachments - content parts appended after the text.
   * @returns the controller's acceptance receipt.
   */
  prompt(agent: Agent, text: string, signal: AbortSignal, mode: 'queue' | 'steer' = 'queue', attachments: readonly PromptContentPart[] = []): Promise<SessionPromptValue> {
    return this.api.prompt(promptRequest(agent.id, text, this.clientTimeZone, mode, attachments), signal)
  }
  /**
   * Presentation-only read. Execution and restoration remain owned by SessionController.
   * @param agent - Agent whose model to read.
   * @returns the Agent's current model, or the default model selection when it has none.
   */
  selection(agent: Agent): ModelSelection {
    return agent.model.current() ?? this.ctx.agentDefaultModel.currentSelection()
  }
  /**
   * Change the model through SessionController.
   * @param agent - Agent whose Session changes model.
   * @param selection - requested model.
   * @returns the applied selection, with `sessionId` when the controller reports one.
   */
  async select(agent: Agent, selection: ModelSelection): Promise<ModelSelection & { sessionId?: SessionId }> {
    const result = await this.api.selectModel({ sessionId: agent.id, ...selection })
    return { ...result.selected, ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }) }
  }
}

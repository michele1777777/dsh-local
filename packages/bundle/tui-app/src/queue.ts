/**
 * Delivery of mid-turn input and recovery of queued input an interrupt left
 * behind. Admission itself stays with SessionController; this module only
 * chooses the shared `queue`/`steer` mode and re-delivers a message the Agent
 * already holds.
 * @module @deepseek-ai/dsh-tui-app/queue
 */
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'

/**
 * How the composer asked for a prompt: plain Enter, or an explicit request
 * (Tab) to hold it until the running turn ends, or Ctrl+Enter
 * to interrupt after admission.
 */
export type SubmitGesture = 'enter' | 'queue' | 'interrupt'

/**
 * Choose the shared admission mode for one prompt. Enter while a turn runs
 * steers it, so the agent reads the message at its next step instead of
 * after it finishes; at idle both gestures start a turn, as on Web.
 * @param running - whether the addressed agent is running a turn.
 * @param gesture - Enter, explicit queue, or interrupt after admission.
 * @returns `steer` for Enter or Ctrl+Enter during a turn, `queue` otherwise.
 */
export function submitMode(running: boolean, gesture: SubmitGesture): 'queue' | 'steer' {
  return running && gesture !== 'queue' ? 'steer' : 'queue'
}

/** The parts of an Agent that parked-input recovery reads and drives. */
export type ParkedAgent = Pick<Agent, 'status' | 'inbox' | 'send'>

/**
 * Human input still waiting in an idle agent's inbox. A user cancel keeps
 * pending work (`keepInbox`) but wakes nothing, so these rows wait for the
 * next waking send.
 * @param agent - the agent to inspect.
 * @returns how many user-sourced queued or steering messages are parked.
 */
export function parkedCount(agent: ParkedAgent): number {
  if (agent.status !== 'idle') return 0
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter(message => message.source.kind === 'user').length
}

/**
 * Start the turn that parked human input was waiting for. The last message
 * of its list is removed and delivered again with a wake, the same remove
 * and re-delivery the controller's queue Steer performs: re-appending the
 * tail keeps every message in its place, so the woken turn claims all
 * steering and the oldest queued prompt exactly as an ordinary wake would.
 * @param agent - an idle agent whose inbox may hold parked input.
 * @returns how many user messages the woken work carries; 0 when nothing was sent.
 */
export function wakeParked(agent: ParkedAgent): number {
  const count = parkedCount(agent)
  if (count === 0) return 0
  const target: InboxTarget = agent.inbox.nextTurn.length > 0 ? 'next-turn' : 'next-step'
  const tail = (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep).at(-1)
  if (tail === undefined || !agent.inbox.remove(tail.id)) return 0
  agent.send(tail, target, true)
  return count
}

/**
 * Force steering held behind waits: when the running agent's current step has
 * human input, every command or job wait its tool calls hold moves to the
 * background, so the agent reads the input at once and is told when the jobs
 * finish. Input queued only for the next turn releases nothing.
 * @param agent - the running agent whose pending input is forced.
 * @param releaseWaits - the job registry's release of the agent's held waits.
 * @returns how many waits moved to the background; 0 means the caller interrupts instead.
 */
export function backgroundWaits(agent: Pick<Agent, 'id' | 'inbox'>, releaseWaits: (owner: Agent['id']) => number): number {
  return agent.inbox.nextStep.some(message => message.source.kind === 'user') ? releaseWaits(agent.id) : 0
}

/** An agent an interrupt can recover: its parked input, and its quiescence. */
export type RecoverableAgent = ParkedAgent & Pick<Agent, 'whenIdle'>
/** Where interrupt recovery reports; `active` says whether the agent is still the one on screen. */
export interface RecoveryHost {
  active(agent: RecoverableAgent): boolean
  sending(count: number): void
  kept(count: number): void
  failed(error: unknown): void
}

/**
 * What an interrupt does with the input the shared cancel keeps. The first
 * interrupt waits for the turn to unwind, then starts the queued input it
 * was holding back; another interrupt, before or during that work, stops
 * everything and leaves the rest queued for an empty Enter.
 */
export class InterruptRecovery {
  private readonly phase = new Map<RecoverableAgent, 'waiting' | 'released'>()
  constructor(private readonly host: RecoveryHost) {}

  /**
   * Record a user interrupt of a running turn, issued alongside the cancel request.
   * @param agent - the agent whose turn was interrupted.
   * @param resume - explicitly send pending input; false lets a second cancel keep it parked.
   * @returns the settlement of the recovery, for tests and callers that wait.
   */
  interrupted(agent: RecoverableAgent, resume = false): Promise<void> {
    if (this.phase.has(agent) && !resume) {
      this.phase.delete(agent)
      return agent.whenIdle().then(() => {
        const kept = this.host.active(agent) ? parkedCount(agent) : 0
        if (kept > 0) this.host.kept(kept)
      }, () => {})
    }
    this.phase.set(agent, 'waiting')
    return agent.whenIdle().then(() => {
      if (this.phase.get(agent) !== 'waiting') return
      this.phase.delete(agent)
      if (!this.host.active(agent)) return
      const count = wakeParked(agent)
      if (count === 0) return
      this.phase.set(agent, 'released')
      this.host.sending(count)
    }).catch((error: unknown) => { this.phase.delete(agent); this.host.failed(error) })
  }

  /**
   * Follow agent status: released work that ends on its own closes the recovery.
   * @param agent - the agent that changed status.
   * @param status - its new status.
   */
  status(agent: RecoverableAgent, status: 'idle' | 'running'): void {
    if (status === 'idle' && this.phase.get(agent) === 'released') this.phase.delete(agent)
  }
}

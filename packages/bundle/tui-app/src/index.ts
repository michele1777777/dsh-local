/**
 * Terminal surface over the Web's SessionController and per-session presets.
 * The terminal never assembles LLM requests, replaces history or restores model
 * configuration itself. Those operations belong to the shared business API.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { createElement } from 'react'
import { render, type Instance } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionControlFrame, SessionProjectionValues, SkillEntry } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-job-controller'
import type {} from '@deepseek-ai/dsh-jobs'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-smart-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { foldPermissionAudit } from './permission-audit.ts'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session-title'
import { copyText, readClipboardImage } from './clipboard.ts'
import { editDraft } from './external-editor.ts'
import { claimTerminal } from './terminal-guard.ts'
import { codeBlocks } from './code-blocks.ts'
import { composerError, UsageError } from './composer-error.ts'
import { createSessionBrowser } from './session-browser.ts'
import { followJob } from './job-observer.ts'
import { App, type Controller } from './app.tsx'
import { TerminalBackend } from './backend.ts'
import { mergeCommands } from './commands.ts'
import { once, type Pending } from './interaction.ts'
import { formatItem, runPlain } from './plain.ts'
import { formatCandidates, listCandidates, mostRecent, resolveCandidate, type Candidate } from './sessions.ts'
import { backgroundWaits, InterruptRecovery, submitMode, wakeParked } from './queue.ts'
import { createStore, projectionsAfter, queueOf, type Picker, type Store } from './store.ts'
import { addNotice, applyChunk, applyEvent, emptyTranscript, endStream, splitSettled, type Presenters } from './transcript.ts'
import { themeName } from './theme.ts'
import { contentSummary, safeText } from './terminal.ts'
import type { SceneAssetError } from './animation.ts'
import { LAYA_ASSETS, LayaAnimations } from './laya.ts'
import { WHALE_ASSETS, WhaleAnimations } from './whale.ts'

export const name = 'tui-runner'
export const inject = ['agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'sessionController', 'sessionQuery', 'sessionProjections', 'sessions']
/** Startup request for the terminal chat, normally supplied by `tui-startup`. */
export interface Config {
  /** Opening prompt submitted to the new session at startup. */
  task?: string
  /** Exact saved-session ID to resume. */
  resumeId?: string
  /** Open the searchable saved-session picker at startup. */
  pick?: boolean
  /** Resume the latest active session in this directory. */
  continueLast?: boolean
  /** Include sessions from other directories in the picker. */
  all?: boolean
  /** Provider/model selection applied to the opened session. */
  model?: string
  /** Model-supported reasoning effort applied to the opened session. */
  effort?: string
  /** Agent preset name for a new session. */
  preset?: string
}
export const Config: z<Config> = z.object({
  task: z.string(), resumeId: z.string(), pick: z.boolean(), continueLast: z.boolean(),
  all: z.boolean(), model: z.string(), effort: z.string(), preset: z.string(),
})
/** Process output and exit hooks used by the line-oriented fallback and shutdown. */
export interface TuiIo { write: (text: string) => void; exit: (code: number) => void }
function* events(agent: Agent): Generator<SessionEvent> {
  for (let seq = 0; seq < agent.session.seq; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Full transcript replay, not model history assembly.
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event !== undefined) yield event
  }
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Open or resume a session and run the chat until exit: the Ink UI when stdin and stdout are terminals, otherwise the line-oriented
 * loop. Returns without effect when the session services are absent.
 * @param ctx - Cordis context providing the injected session services.
 * @param config - startup request.
 * @param io - output sink and exit hook.
 * @throws Error when `continueLast` finds no saved session, or `pick` runs without a terminal.
 */
export async function run(ctx: Context, config: Config, io: TuiIo): Promise<void> {
  await ctx.get('loader')?.await()
  const sessions = ctx.get('sessions')
  if (sessions === undefined || ctx.get('sessionController') === undefined) return
  const tty = process.stdin.isTTY && process.stdout.isTTY
  const backend = new TerminalBackend(ctx, Intl.DateTimeFormat().resolvedOptions().timeZone)
  const launchCwd = process.cwd()
  const browser = createSessionBrowser(backend.api, ctx.sessionQuery)
  const store: Store = createStore({
    transcript: emptyTranscript(), status: 'idle', pending: [], selection: ctx.agentDefaultModel.currentSelection(),
    sessionId: '', cwd: launchCwd, title: '', preset: undefined, theme: process.env.NO_COLOR === undefined ? themeName(process.env.DSH_TUI_THEME) : 'mono',
    mouse: process.env.DSH_TUI_MOUSE !== 'off',
    layout: process.env.DSH_TUI_LAYOUT === 'single' ? 'single' : process.env.DSH_TUI_LAYOUT === 'split' ? 'split' : 'auto',
    links: process.env.DSH_TUI_LINKS !== 'off' && process.env.TERM !== 'dumb',
    notifications: process.env.DSH_TUI_NOTIFY === 'off' ? 'off' : process.env.DSH_TUI_NOTIFY === 'desktop' ? 'desktop' : 'bell',
    terminalTitle: process.env.DSH_TUI_TITLE !== 'off', motion: process.env.DSH_TUI_MOTION !== 'off', editorRequest: 0,
    expandedTools: false, hint: undefined, exiting: false, busy: undefined, picker: undefined,
    queue: [], jobs: [], projections: {}, attachments: [], viewEpoch: 0, hiddenBefore: 0, recoveredInput: undefined, skills: [],
  })
  let current: Agent | undefined
  let ink: Instance | undefined
  let commandAbort: AbortController | undefined
  let controlAbort: AbortController | undefined
  let controlTask: Promise<void> | undefined
  let shutdownTask: Promise<void> | undefined
  let commandDrain: Promise<void> | undefined
  let creating: Promise<void> | undefined
  let requestedExitCode = 0
  let startupSelectionPending = config.model !== undefined || config.effort !== undefined
  let lastListed: Candidate[] = []
  let pendingOpeningPrompt = config.pick === true ? config.task : undefined
  const lifetime = new AbortController()
  const owned = new Set<Agent>()
  const notice = (text: string, level: 'info' | 'error' | 'success' = 'info'): void => {
    store.update((state) => { addNotice(state.transcript, text, level) })
  }
  const plural = (count: number): string => `${count} queued message${count === 1 ? '' : 's'}`
  // The shared cancel keeps queued and steering input (`keepInbox`) but wakes
  // nothing, so without this it would wait for another prompt.
  const recovery = new InterruptRecovery({
    active: agent => agent === current && !lifetime.signal.aborted,
    sending: (count) => { notice(`Interrupted · sending ${plural(count)} · interrupt again to keep the rest queued.`) },
    kept: (count) => { notice(`Interrupted · ${plural(count)} kept · Enter on an empty prompt sends ${count === 1 ? 'it' : 'them'}.`) },
    failed: (error) => { notice(`Queued messages were kept: ${errorText(error)}`, 'error') },
  })
  const present: Presenters = {
    call(toolName, args) {
      try { return ctx.get('tools')?.get(toolName, current)?.presentCall?.(args) ?? { card: 'generic', title: toolName, rawInput: args } }
      catch { return { card: 'generic', title: toolName, rawInput: args } }
    },
    result(toolName, args, result) {
      try { return ctx.get('tools')?.get(toolName, current)?.presentResult?.(args, result) }
      catch { return undefined }
    },
  }
  const defaultPermission = (): string | undefined => {
    // An unknown configured default throws when read; the status line then names every preset.
    try { return ctx.get('permissionPresets')?.defaultPreset }
    catch { return undefined }
  }
  const goalActivation = (agent: Agent): 'armed' | 'disarmed' | undefined => {
    // Same read used by the Web goal surface; activation is process-local,
    // not inferred from the persisted goal phase on resume.
    try { return ctx.get('goals')?.get(agent)?.activation }
    catch { return undefined }
  }
  ctx.on('goal/activation-changed', (event) => {
    if (event.sessionId === current?.id) store.update((state) => { state.goalActivation = event.goal?.activation })
  })
  const applyControl = (frame: SessionControlFrame): void => {
    if (current === undefined || lifetime.signal.aborted) return
    const id = current.id
    if (frame.type !== 'baseline' && frame.sessionId !== id) return
    store.update((state) => {
      state.projections = projectionsAfter(state.projections, frame, id)
      // The pending queue is the shared `inbox` projection (Web QueueDock reads the same value).
      state.queue = queueOf(state.projections)
      if (current !== undefined) { state.selection = backend.selection(current); state.goalActivation = goalActivation(current) }
      state.defaultPermission = defaultPermission()
      const title = state.projections.title
      if (typeof title === 'string') state.title = title
      const preset = state.projections.agentPreset
      if (typeof preset === 'string') state.preset = preset
    })
  }
  const attach = async (agent: Agent): Promise<void> => {
    controlAbort?.abort()
    await controlTask
    current = agent
    owned.add(agent)
    store.update((state) => {
      state.transcript = emptyTranscript()
      state.permissionAudit = []
      state.reviewingApprovals = 0
      state.approvalPolicy = ctx.get('approval') === undefined ? undefined : ctx.get('approval')?.config.policy ?? 'ask'
      for (const event of events(agent)) {
        applyEvent(state.transcript, event, present, true)
        if (event.type === 'approval/asked' || event.type === 'approval/decided') {
          state.permissionAudit = foldPermissionAudit(state.permissionAudit ?? [], event, String(agent.id))
        }
        if (event.type === 'approval/policy') state.approvalPolicy = event.data.policy
      }
      state.goalActivation = goalActivation(agent)
      state.defaultPermission = defaultPermission()
      state.panel = undefined
      state.sessionId = String(agent.id)
      state.cwd = agent.session.header.cwd ?? launchCwd
      state.status = agent.status
      state.selection = backend.selection(agent)
      state.projections = ctx.sessionProjections.snapshot(agent.session).values as SessionProjectionValues
      state.title = typeof state.projections.title === 'string' ? state.projections.title : ''
      state.preset = typeof state.projections.agentPreset === 'string' ? state.projections.agentPreset : undefined
      state.queue = queueOf(state.projections)
      state.pending = []; state.jobs = []; state.selectedJob = undefined; state.jobDetail = undefined; state.attachments = []
      state.picker = undefined; state.hiddenBefore = 0; state.viewEpoch++; state.skills = []
    })
    void listSkills(lifetime.signal).catch((error: unknown) => { if (!lifetime.signal.aborted) notice(`Skills: ${errorText(error)}`, 'error') })
    // The exact baseline + live replacement stream used by Web, not a TUI queue mirror.
    const controller = new AbortController()
    controlAbort = controller
    const control = (async () => {
      for await (const frame of backend.api.control(controller.signal)) applyControl(frame)
    })().catch((error: unknown) => { if (!controller.signal.aborted) notice(`Session control: ${errorText(error)}`, 'error') })
    // Background jobs ride the job Remote's whole-set roster stream, as on Web.
    const jobController = ctx.get('jobController')
    const roster = jobController === undefined ? Promise.resolve() : (async () => {
      for await (const frame of jobController.list({ sessionId: agent.id }, controller.signal)) {
        if (current !== agent || lifetime.signal.aborted) return
        store.update((state) => { state.jobs = frame.jobs })
      }
    })().catch((error: unknown) => { if (!controller.signal.aborted) notice(`Background jobs: ${errorText(error)}`, 'error') })
    controlTask = Promise.all([control, roster]).then(() => undefined)
  }
  const requireAgent = (): Agent => {
    if (current === undefined) throw new Error('Choose a session with /resume, or create one with /new.')
    return current
  }
  const requireSwitchable = (): void => {
    if (current?.status === 'running' || store.getState().pending.length > 0) {
      throw new Error('Stop the current turn with Esc or /stop before switching sessions. No work has been discarded.')
    }
    if (store.getState().attachments.length > 0) throw new Error('Send or /detach staged attachments before switching sessions.')
  }
  const belongsToCurrent = (agent: Agent): boolean => {
    let candidate: Agent | undefined = agent
    const visited = new Set<string>()
    while (candidate !== undefined && !visited.has(String(candidate.id))) {
      if (candidate === current) return true
      visited.add(String(candidate.id))
      const parent: SessionId | undefined = candidate.session.header.parentSession
      candidate = parent === undefined ? undefined : ctx.agents.get(parent)
    }
    return false
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent !== current) return
    // Tokens arrive faster than a terminal can repaint a long transcript.
    // Folding them is immediate; announcing the result waits for a frame.
    store.update((state) => {
      if (frame.type === 'end') endStream(state.transcript)
      else if (frame.type === 'chunk') applyChunk(state.transcript, frame.chunk, frame.time)
    }, frame.type === 'chunk')
  })
  ctx.on('smart-approval/status', ({ agent, reviewing }) => {
    if (!belongsToCurrent(agent)) return
    store.update((state) => { state.reviewingApprovals = Math.max(0, (state.reviewingApprovals ?? 0) + (reviewing ? 1 : -1)) })
  })
  ctx.on('session/event', (session, event) => {
    const own = session === current?.session
    if (!own) {
      if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return
      const child = ctx.agents.get(session.id)
      if (child === undefined || !belongsToCurrent(child)) return
    }
    store.update((state) => {
      if (event.type === 'approval/asked' || event.type === 'approval/decided') {
        state.permissionAudit = foldPermissionAudit(state.permissionAudit ?? [], event, String(session.id))
      }
      if (!own) return
      applyEvent(state.transcript, event, present, false)
      if (event.type === 'session/title') state.title = event.data.title
      if (event.type === 'approval/policy') state.approvalPolicy = event.data.policy
      if (event.type === 'request/header' || event.type === 'model/selection') state.selection = backend.selection(requireAgent())
    })
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent === current) store.update((state) => { state.status = status })
    recovery.status(agent, status)
    if (status === 'idle' && owned.has(agent)) {
      void sessions.flush(agent.session).catch((error: unknown) => { notice(`Save failed: ${errorText(error)}`, 'error') })
    }
  })
  ctx.on('agent/error', ({ agent, error }) => {
    if (agent === current) notice(errorText(error), 'error')
  })
  const removePending = (id: string): void => {
    store.update((state) => { state.pending = state.pending.filter(entry => entry.id !== id) })
  }
  ctx.on('approval/request', (request, next) => {
    if (!belongsToCurrent(request.agent)) return next()
    if (!tty) { notice(`Approval for ${request.toolName} requires a terminal; denied.`, 'error'); return Promise.resolve<ApprovalOutcome>('unavailable') }
    if (request.signal?.aborted || lifetime.signal.aborted) return Promise.resolve<ApprovalOutcome>('cancelled')
    return new Promise<ApprovalOutcome>((resolveApproval) => {
      const id = randomUUID()
      const abort = (): void => { settle('cancelled') }
      const settle = once((outcome: ApprovalOutcome) => {
        request.signal?.removeEventListener('abort', abort)
        lifetime.signal.removeEventListener('abort', abort)
        removePending(id); resolveApproval(outcome)
      })
      request.signal?.addEventListener('abort', abort, { once: true })
      lifetime.signal.addEventListener('abort', abort, { once: true })
      const call = request.callId === undefined ? undefined : store.getState().transcript.items.find(item => item.kind === 'tool' && item.id === request.callId)
      // The approving human must be able to inspect the complete arguments,
      // including calls made by an owned subagent, not just a shortened title.
      let detail = call?.kind === 'tool' ? `${call.call.title}\n${JSON.stringify(call.args, null, 2)}` : undefined
      if (request.callId !== undefined) {
        for (const event of events(request.agent)) {
          if (event.type === 'tool/call' && event.data.callId === request.callId) detail = event.data.arguments
        }
      }
      const pending: Pending = {
        kind: 'approval', id, toolName: request.toolName, reason: request.reason,
        detail, owner: String(request.agent.id), cwd: request.agent.session.header.cwd, resolve: settle,
      }
      store.update((state) => { state.pending.push(pending) })
    })
  })
  ctx.on('user-questions/request', (request, next) => {
    if (!tty || current === undefined || (request.agent !== undefined && !belongsToCurrent(request.agent))) return next()
    if (request.signal?.aborted || lifetime.signal.aborted) return Promise.reject(new Error('Question withdrawn'))
    return new Promise<AskUserQuestionAnswer>((resolveQuestion, rejectQuestion) => {
      const id = randomUUID()
      const abort = (): void => { settle(undefined, new Error('Question withdrawn')) }
      const settle = once((answer: AskUserQuestionAnswer | undefined, error?: unknown) => {
        request.signal?.removeEventListener('abort', abort)
        lifetime.signal.removeEventListener('abort', abort)
        removePending(id)
        if (answer === undefined) rejectQuestion(error instanceof Error ? error : new Error('Question cancelled'))
        else resolveQuestion(answer)
      })
      request.signal?.addEventListener('abort', abort, { once: true })
      lifetime.signal.addEventListener('abort', abort, { once: true })
      store.update((state) => { state.pending.push({ kind: 'question', id, questions: request.questions, resolve: (answer) => { settle(answer) }, reject: (error) => { settle(undefined, error) } }) })
    })
  })

  const openPicker = (picker: Picker): void => { store.update((state) => { state.picker = picker }) }
  const browseSessions = async (all = false): Promise<void> => {
    browser.clear()
    lastListed = await listCandidates(ctx, launchCwd, all, commandAbort?.signal ?? lifetime.signal)
    if (!tty) { notice(lastListed.length === 0 ? 'No saved sessions.' : formatCandidates(lastListed).join('\n')); return }
    openPicker({ kind: 'sessions', title: all ? 'Resume · all directories' : 'Resume · this directory', all,
      rows: lastListed.map(row => ({ id: String(row.id), label: row.label, current: row.id === current?.id,
        detail: `${new Date(row.updatedAt).toLocaleString()} · ${row.cwd}${row.running ? ' · running' : ''}`,
        command: `/resume ${row.id}` })) })
  }
  const resume = async (spec: string): Promise<void> => {
    requireSwitchable()
    if (spec === '' || spec === '--all') { await browseSessions(spec === '--all'); return }
    const matches = await listCandidates(ctx, launchCwd, true)
    const candidate = spec === '--last' ? (await listCandidates(ctx, launchCwd))[0]
      : /^\d+$/u.test(spec) ? lastListed[Number(spec) - 1] : resolveCandidate(matches, spec)
    if (spec === '--last' && candidate === undefined) throw new Error('No saved session in this directory. Use /new to start one.')
    if (/^\d+$/u.test(spec) && candidate === undefined) throw new Error('No session with that number. Open /resume again.')
    const id = candidate?.id ?? brandString<SessionId>(spec)
    if (id === current?.id) { store.update((state) => { state.picker = undefined }); return }
    if (current !== undefined) await sessions.flush(current.session)
    await attach(await backend.resume(id))
    notice(`Resumed ${id}`, 'success')
  }
  const pickModel = async (): Promise<void> => {
    const catalog = await backend.api.modelCatalog()
    const rows = catalog.groups.flatMap(group => group.models.map(model => ({ id: `${group.id}/${model.id}`, label: model.name, current: `${group.id}/${model.id}` === `${store.getState().selection.provider}/${store.getState().selection.model}`,
      detail: `${group.id}/${model.id}${model.description === undefined ? '' : ` · ${model.description}`}`, command: `/model ${group.id}/${model.id}` })))
    for (const failure of catalog.failures) notice(`${failure.name}: ${failure.message}`, 'error')
    if (tty) openPicker({ kind: 'models', title: 'Select model', rows })
    else notice(rows.map(row => `${row.id}  ${row.label}`).join('\n') || 'No models available.')
  }
  /** Read the current session's user-invocable skills and publish them to the `/` popup. */
  const listSkills = async (signal: AbortSignal): Promise<readonly SkillEntry[]> => {
    const catalog = ctx.get('sessionSkillCatalog')
    if (catalog === undefined) throw new Error('The skill catalog is not mounted in this composition.')
    const agent = requireAgent()
    const { skills } = await catalog.list({ sessionId: agent.id }, signal)
    if (current === agent) store.update((state) => { state.skills = skills })
    return skills
  }
  const pickSkills = async (signal: AbortSignal): Promise<void> => {
    const skills = await listSkills(signal)
    openPicker({ kind: 'skills', title: `Skills · ${skills.length} available`,
      rows: skills.map(skill => ({ id: skill.name, label: skill.name, detail: skill.description.replaceAll(/\s+/gu, ' ').trim(), draft: `/${skill.name} ` })) })
  }
  const ensureSession = async (): Promise<void> => {
    if (current !== undefined) return
    creating ??= backend.create(launchCwd, config.preset).then(attach).finally(() => { creating = undefined })
    await creating
  }
  const setModel = async (spec: string): Promise<void> => {
    const index = spec.indexOf('/')
    if (index <= 0 || index === spec.length - 1) throw new UsageError('/model needs a provider and a model', '/model provider/model')
    // Deliberately do not carry an effort from an unrelated model. The shared
    // controller resolves adapter defaults and persists the selected route.
    const selection = await backend.select(requireAgent(), { provider: spec.slice(0, index), model: spec.slice(index + 1) })
    if (selection.sessionId !== undefined) await resume(selection.sessionId)
    store.update((state) => { state.selection = selection; state.picker = undefined })
    notice(`Model: ${selection.provider}/${selection.model}`, 'success')
  }
  const setEffort = async (raw: string): Promise<void> => {
    const agent = requireAgent()
    const selected = backend.selection(agent)
    if (raw === '') {
      const catalog = await backend.api.modelCatalog()
      const model = catalog.groups.find(group => group.id === selected.provider)?.models.find(model => model.id === selected.model)
      const rows = [{ id: 'default', label: 'Provider default', current: selected.reasoningEffort === undefined, detail: 'Clear the explicit effort selection', command: '/effort default' },
        ...(model?.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, label: effort.name, current: selected.reasoningEffort === effort.id, detail: effort.description ?? effort.id, command: `/effort ${effort.id}` }))]
      if (tty) openPicker({ kind: 'efforts', title: `Reasoning effort · ${selected.model}`, rows })
      else notice(rows.map(row => `${row.id}  ${row.detail}`).join('\n'))
      return
    }
    const selection = await backend.select(agent, { provider: selected.provider, model: selected.model, ...(raw === 'default' ? {} : { reasoningEffort: raw }) })
    store.update((state) => { state.selection = selection; state.picker = undefined })
    notice(`Reasoning effort: ${selection.reasoningEffort ?? 'provider default'}`, 'success')
  }
  const stageFile = async (raw: string, image: boolean): Promise<void> => {
    if (raw === '') throw new UsageError(`/${image ? 'image' : 'attach'} needs a path`, `/${image ? 'image' : 'attach'} <path>`)
    const path = resolve(store.getState().cwd, raw.replace(/^(["'])(.*)\1$/u, '$2'))
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Attachment must be a regular file.')
    const agent = requireAgent()
    if (image) {
      const mediaTypes: Partial<Record<string, ImageMediaType>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
      const mediaType = mediaTypes[extname(path).toLowerCase()]
      if (mediaType === undefined) throw new Error('Supported image extensions: png, jpg, jpeg, webp, gif.')
      if (info.size > ctx.attachments.imageLimits.maxMessageImageBytes) throw new Error('Image exceeds the configured Web image admission limit.')
      const data = (await readFile(path, { signal: commandAbort?.signal ?? lifetime.signal })).toString('base64')
      store.update((state) => { state.attachments.push({ name: basename(path), part: { type: 'image', mediaType, data, name: basename(path) } }) })
    } else {
      const signal = commandAbort?.signal ?? lifetime.signal
      const stream = createReadStream(path, { signal })
      try {
        const receipt = await ctx.fileUploads.uploadStream({ sessionId: agent.id, data: stream, name: basename(path), signal })
        store.update((state) => { state.attachments.push({ name: basename(path), part: { type: 'file', receiptId: receipt.receiptId } }) })
      } finally { stream.destroy() }
    }
    // In the terminal the staged row above the composer confirms it.
    if (!tty) notice(`Attached ${basename(path)}. Send a prompt, or /detach to remove staged files.`, 'success')
  }
  const stageClipboard = async (): Promise<void> => {
    const agent = requireAgent(), epoch = store.getState().viewEpoch
    const signal = commandAbort?.signal ?? lifetime.signal
    const image = await readClipboardImage(ctx.attachments.imageLimits.maxMessageImageBytes, { signal })
    signal.throwIfAborted()
    lifetime.signal.throwIfAborted()
    if (current !== agent || epoch !== store.getState().viewEpoch) throw new Error('Session changed while reading the clipboard. Nothing was attached; paste again in the intended session.')
    const name = `clipboard-${randomUUID().slice(0, 8)}.png`
    // Identical image PromptContentPart to /image and Web. Admission is still
    // performed by the shared controller at send time, including total limits.
    store.update((state) => { state.attachments.push({ name, part: { type: 'image', mediaType: image.mediaType, data: image.data.toString('base64'), name } }); state.hint = `Image staged: ${image.width}×${image.height}. Add a prompt and send; × removes it.` })
  }
  // Replaced by the terminal claim while the fullscreen renderer owns the TTY.
  let terminalWrite = (value: string): void => { process.stdout.write(value) }
  const copyLocal = (text: string, signal: AbortSignal = lifetime.signal) =>
    copyText(text, { signal, ...(tty ? { write: (value: string) => { terminalWrite(value) } } : {}) })
  const status = (): string => {
    const s = store.getState()
    return [`Session: ${s.sessionId || '(not selected)'}`, `Title: ${s.title || '(untitled)'}`, `Directory: ${s.cwd}`,
      `Preset: ${s.preset ?? '(deployment default)'}`, `Model: ${s.selection.provider}/${s.selection.model}`,
      `Effort: ${s.selection.reasoningEffort ?? 'provider default'}`, `State: ${s.busy ?? s.status} · queued: ${s.queue.length}`,
      `Context (approximate): ${JSON.stringify(s.projections.contextPressure ?? {})}`,
      `Accumulated usage: ${JSON.stringify(s.projections.tokenUsage ?? {})}`].join('\n')
  }
  /**
   * Empty Enter and `/queue send` force pending human input. Steering held behind
   * a command or job wait moves those waits to the background, so the agent reads it
   * at once and is told when the jobs finish; anything else interrupts active work,
   * then wakes the pending input.
   */
  const sendQueue = async (): Promise<void> => {
    const agent = requireAgent()
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.source.kind === 'user')
    if (!pending) return
    if (agent.status === 'running') {
      const jobs = ctx.get('jobs')
      const moved = jobs === undefined ? 0 : backgroundWaits(agent, owner => jobs.releaseWaits(owner))
      if (moved > 0) {
        notice(`Moved ${moved === 1 ? 'a running command' : `${moved} running commands`} to the background · the agent reads your message now and is told when ${moved === 1 ? 'it finishes' : 'they finish'}.`)
        return
      }
      backend.api.cancel({ sessionId: agent.id })
      await recovery.interrupted(agent, true)
    } else {
      const count = wakeParked(agent)
      store.update((state) => { state.hint = `Sending ${plural(count)}.` })
    }
  }
  const localCommand = async (name: string, raw: string): Promise<boolean> => {
    const arg = raw.trim()
    switch (name) {
      case 'copy': {
        if (arg !== '' && arg !== 'code' && arg !== 'raw') throw new UsageError('/copy takes code, raw or nothing', '/copy [code | raw]')
        const items = store.getState().transcript.items.filter(item => item.kind === 'assistant')
        const text = arg === 'code' ? items.flatMap(item => codeBlocks(item.text)).at(-1)?.text : items.filter(item => item.text !== '').at(-1)?.text
        if (text === undefined) throw new Error(arg === 'code' ? 'No code block to copy.' : 'No assistant answer to copy.')
        const result = await copyLocal(text, commandAbort?.signal ?? lifetime.signal)
        store.update((state) => { state.hint = result.confirmed ? 'Copied original text to clipboard.' : 'Copy sent to terminal via OSC 52; check terminal clipboard permissions.' })
        return true
      }
      case 'paste-image': await stageClipboard(); return true
      case 'editor':
        if (!tty) throw new Error('External editing requires an interactive terminal.')
        if (arg !== '') throw new Error('Use /editor without arguments, or Ctrl+G to edit the current draft.')
        store.update((state) => { state.editorRequest = (state.editorRequest ?? 0) + 1 }); return true
      case 'layout':
        if (!['auto', 'single', 'split'].includes(arg)) throw new UsageError('/layout needs auto, single or split', '/layout auto | single | split')
        store.update((state) => { state.layout = arg as 'auto' | 'single' | 'split' }); return true
      case 'notify':
        if (!['off', 'bell', 'desktop'].includes(arg)) throw new UsageError('/notify needs off, bell or desktop', '/notify off | bell | desktop')
        store.update((state) => { state.notifications = arg as 'off' | 'bell' | 'desktop'; state.hint = `Notifications: ${arg}. Sent only when the terminal reports that it is unfocused.` }); return true
      case 'links': case 'title':
        if (arg !== 'on' && arg !== 'off') throw new UsageError(`/${name} needs on or off`, `/${name} on | off`)
        store.update((state) => { if (name === 'links') state.links = arg === 'on'; else state.terminalTitle = arg === 'on' }); return true
      case 'help':
        if (tty) store.update((state) => { state.panel = 'help' })
        else notice(controller.commands().map(entry => `/${entry.name.padEnd(14)} ${entry.description}`).join('\n'))
        return true
      case 'status': case 'context':
        if (tty) store.update((state) => { state.panel = 'context' })
        else notice(status())
        return true
      case 'permission': {
        if (arg !== '' || !tty) return false
        const service = ctx.get('permissionPresets')
        if (service === undefined) throw new Error('Permission presets are unavailable in this profile.')
        await ensureSession()
        const selected = service.current(requireAgent().session)
        openPicker({ kind: 'permissions', title: 'Permissions · current session', rows: service.catalog().options.map(option => ({
          id: option.value, label: option.name, detail: option.description ?? option.value,
          command: `/permission ${option.value}`, current: option.value === selected,
        })) })
        return true
      }
      case 'transcript': case 'diff': case 'permissions': case 'tasks':
        if (tty) store.update((state) => { state.panel = name === 'diff' ? 'changes' : name })
        else notice(name === 'permissions' ? `Approval policy: ${store.getState().approvalPolicy ?? 'unavailable'}. /auto-approve status and /auto-approve history inspect shared Smart review.` : name === 'tasks' ? JSON.stringify({ jobs: store.getState().jobs, goal: store.getState().projections.goal, plan: store.getState().projections.plan }, null, 2) : store.getState().transcript.items.map(item => formatItem(item, true, true)).join('\n'))
        return true
      case 'theme':
        if (arg === '') {
          if (tty) openPicker({ kind: 'themes', title: 'Terminal appearance', rows: ['dark', 'light', 'mono'].map(id => ({ id, label: id === 'dark' ? 'Dark terminal' : id === 'light' ? 'Light terminal' : 'Monochrome', detail: id === 'mono' ? 'No colour; keep text labels and symbols' : 'Semantic colours on your terminal background', command: `/theme ${id}`, current: id === store.getState().theme })) })
          else notice('Themes: dark, light, mono. Use DSH_TUI_THEME to choose the startup theme.')
        } else {
          if (!['dark', 'light', 'mono'].includes(arg)) throw new UsageError('/theme takes dark, light, mono or nothing', '/theme [dark | light | mono]')
          store.update((state) => { state.theme = process.env.NO_COLOR === undefined ? themeName(arg) : 'mono'; state.picker = undefined })
        }
        return true
      case 'mouse': {
        if (arg !== '' && !['on', 'off'].includes(arg)) throw new UsageError('/mouse takes on, off or nothing', '/mouse [on | off]')
        const enabled = arg === '' ? store.getState().mouse === false : arg === 'on'
        store.update((state) => { state.mouse = enabled })
        notice(enabled
          ? 'Wheel scrolling on. Your terminal usually still selects text with Shift held.'
          : 'Wheel scrolling off. The terminal handles the mouse; PgUp/PgDn and Shift+↑/↓ scroll.', 'success')
        return true
      }
      case 'skills':
        if (!tty || arg !== '') return false
        await pickSkills(commandAbort?.signal ?? lifetime.signal); return true
      case 'cwd': notice(store.getState().cwd); return true
      case 'clear':
        store.update((state) => {
          state.hiddenBefore = splitSettled(state.transcript.items).settled.length
          state.viewEpoch++
        })
        return true
      case 'exit': case 'quit': controller.exit(); return true
      case 'stop': controller.cancel(); return true
      case 'expand': store.update((state) => { state.expandedTools = !state.expandedTools }); return true
      case 'resume': await resume(arg); return true
      case 'sessions': requireSwitchable(); await browseSessions(arg === '--all'); return true
      case 'new':
        requireSwitchable()
        if (current !== undefined) await sessions.flush(current.session)
        await attach(await backend.create(launchCwd, arg || undefined)); return true
      case 'model': if (arg === '') await pickModel(); else await setModel(arg); return true
      case 'effort': await setEffort(arg); return true
      case 'rename':
        notice(`Renamed: ${(await backend.api.rename({ sessionId: requireAgent().id, title: arg })).title}`, 'success'); return true
      case 'fork': {
        requireSwitchable()
        const fork = await backend.api.fork({ sessionId: requireAgent().id })
        await attach(await backend.resume(fork.sessionId)); notice(`Forked as ${fork.sessionId}`, 'success'); return true
      }
      case 'steer': {
        const staged = [...store.getState().attachments]
        await backend.prompt(requireAgent(), raw.replace(/^\s/u, ''), commandAbort?.signal ?? lifetime.signal, 'steer', staged.map(file => file.part))
        store.update((state) => { state.attachments = state.attachments.filter(file => !staged.includes(file)) })
        return true
      }
      case 'queue': {
        const queue = store.getState().queue.filter(item => item.placement !== 'context')
        if (arg === '') {
          notice(queue.length === 0 ? 'Queue is empty.' : queue.map((item, index) => `${index + 1}. [${item.placement}] ${contentSummary(item.message.content)}`).join('\n'))
          return true
        }
        if (arg === 'send') { await sendQueue(); return true }
        const added = /^add[ \t]+([\s\S]+)$/u.exec(raw.trimStart())
        if (added !== null) {
          // Explicit next-turn delivery, whatever the turn is doing: the
          // keyboard twin of Tab in the composer.
          const staged = [...store.getState().attachments]
          await backend.prompt(requireAgent(), added[1] ?? '', commandAbort?.signal ?? lifetime.signal, 'queue', staged.map(file => file.part))
          store.update((state) => { state.attachments = state.attachments.filter(file => !staged.includes(file)) })
          return true
        }
        const match = /^(remove|steer|edit)[ \t]+(\d+)(?:[ \t]([\s\S]*))?$/u.exec(raw.trimStart())
        if (match === null) throw new UsageError('/queue does not know that action', '/queue [add text | send | remove N | steer N | edit N replacement text]')
        const item = queue[Number(match[2]) - 1]
        if (item === undefined) throw new Error('That queue item has already been consumed or does not exist.')
        await backend.api.updateQueue({ sessionId: requireAgent().id, itemId: item.id,
          action: match[1] === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: match[3] ?? '' }] } : { kind: match[1] === 'remove' ? 'remove' : 'steer' } })
        return true
      }
      case 'jobs':
        if (tty) store.update((state) => { state.panel = 'jobs'; state.selectedJob = undefined; state.jobDetail = undefined })
        else notice(store.getState().jobs.map(job => `${job.id} [${job.status}] ${job.label}`).join('\n') || 'No background jobs.')
        return true
      case 'attach': case 'image': await stageFile(arg, name === 'image'); return true
      case 'detach':
        store.update((state) => { state.attachments = []; if (tty) state.hint = 'Staged attachments removed.' })
        if (!tty) notice('Staged attachments removed.')
        return true
      case 'export': {
        if (arg === '') throw new UsageError('/export needs a new file path; existing files are never overwritten', '/export <path.md>')
        const path = resolve(store.getState().cwd, arg.replace(/^(["'])(.*)\1$/u, '$2'))
        const snapshot = store.getState()
        const text = `# ${snapshot.title || 'DeepSeek Harness session'}\n\nSession: ${snapshot.sessionId}\nDirectory: ${snapshot.cwd}\n\n${snapshot.transcript.items.map(item => formatItem(item, true, true)).join('\n\n')}\n`
        await writeFile(path, safeText(text), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        notice(`Exported ${path}`, 'success'); return true
      }
      default: return false
    }
  }
  const applyStartupSelection = async (): Promise<void> => {
    if (!startupSelectionPending || current === undefined) return
    if (config.model !== undefined) await setModel(config.model)
    if (config.effort !== undefined) await setEffort(config.effort)
    startupSelectionPending = false
  }
  const controller: Controller = {
    async followJob(jobId, signal) {
      const jobs = ctx.get('jobController')
      if (jobs === undefined) throw new Error('Background job observation is unavailable.')
      const agent = requireAgent()
      const combined = AbortSignal.any([signal, lifetime.signal, ...controlAbort === undefined ? [] : [controlAbort.signal]])
      await followJob(store, jobId, jobs.follow({ sessionId: agent.id, jobId }, combined), combined)
    },
    copyText: copyLocal,
    pasteImage: stageClipboard,
    editPrompt: (text, signal) => editDraft(text, { signal: AbortSignal.any([signal, lifetime.signal]) }),
    searchSessions: (query, signal) => browser.search(query, AbortSignal.any([signal, lifetime.signal])),
    previewSession: (id, signal) => browser.preview(id, AbortSignal.any([signal, lifetime.signal])),
    async submit(text, gesture = 'enter') {
      if (store.getState().busy !== undefined) throw new Error('Wait for the current command or press Esc to cancel it.')
      lifetime.signal.throwIfAborted()
      await ensureSession()
      await applyStartupSelection()
      const agent = requireAgent()
      const staged = [...store.getState().attachments]
      // Enter during a turn steers it (read at the next step); Tab and
      // `/queue add` hold the prompt for the next turn.
      await backend.prompt(agent, text, lifetime.signal, submitMode(agent.status === 'running', gesture), staged.map(file => file.part))
      store.update((state) => { state.attachments = state.attachments.filter(file => !staged.includes(file)) })
      // User rows come only from accepted durable events. Failed admissions
      // cannot leave phantom messages or settle other queued submissions.
      if (gesture === 'interrupt' && current === agent) await sendQueue()
      if (!tty) await agent.whenIdle()
    },
    async runCommand(line) {
      const parsed = parseCommand(line)
      if (parsed === undefined) throw new Error(`Not a command: ${line}`)
      const name = parsed.name === 'q' || parsed.name === 'quit' ? 'exit' : parsed.name
      if (name === 'reasoning') throw new Error('Reasoning is always visible when provided by the model. /effort selects the model-supported effort.')
      if (name === 'stop') { controller.cancel(); return }
      if (name === 'exit') { controller.exit(); return }
      if (commandAbort !== undefined) throw new Error('A command is already running. Esc cancels it.')
      lifetime.signal.throwIfAborted()
      const operation = new AbortController()
      commandAbort = operation
      let release: () => void = () => {}
      commandDrain = new Promise<void>((resolveDrain) => { release = resolveDrain })
      store.update((state) => { state.busy = `/${name}` })
      let skillPrompt: string | undefined
      try {
        const registry = ctx.get('commands')
        // Same executor and attachment admission as Web. Only /stop and /exit
        // are reserved safety commands; other scoped plugin names take priority.
        // Empty /skills and /permission open terminal pickers instead of chat listings.
        const registered = current !== undefined && registry?.find(current, name) !== undefined && !(tty && (name === 'skills' || (name === 'permission' && parsed.rawInput.trim() === '')))
        if (registered || !(await localCommand(name, parsed.rawInput))) {
          const staged = [...store.getState().attachments]
          const attachments = staged.flatMap(file => file.part.type === 'text' ? [] : [file.part])
          const execution = registry === undefined || current === undefined
            ? undefined : await registry.execute(current, line, attachments, operation.signal)
          if (execution === undefined) {
            // A user-invocable skill name is a prompt; tool-skill injects the skill host-side, as for Web.
            await ensureSession()
            if (!(await listSkills(operation.signal)).some(skill => skill.name === name)) throw new Error(`Unknown command /${name}. Type /help.`)
            skillPrompt = line
          }
          else {
            if (current !== undefined) await sessions.flush(current.session)
            if (execution.result.kind === 'error') throw new Error(execution.result.text)
            if (execution.result.sessionId !== undefined) await resume(execution.result.sessionId)
            if (name === 'permission') store.update((state) => { state.picker = undefined })
          }
          store.update((state) => { state.attachments = state.attachments.filter(file => !staged.includes(file)) })
        }
        await applyStartupSelection()
      } finally {
        if (commandAbort === operation) commandAbort = undefined
        release()
        store.update((state) => { state.busy = undefined })
      }
      if (skillPrompt !== undefined) { await controller.submit(skillPrompt); return }
      const idle = store.getState().picker === undefined && !store.getState().exiting
      if (current !== undefined && pendingOpeningPrompt !== undefined && idle) {
        const prompt = pendingOpeningPrompt
        pendingOpeningPrompt = undefined
        await controller.submit(prompt).catch((error: unknown) => {
          store.update((state) => { state.recoveredInput = prompt })
          notice(`Opening prompt was not sent and has been kept in the composer: ${errorText(error)}`, 'error')
        })
      }
    },
    sendQueue,
    cancel() {
      commandAbort?.abort()
      const agent = current
      if (agent !== undefined) {
        const running = agent.status === 'running'
        backend.api.cancel({ sessionId: agent.id })
        // Once the interrupted turn unwinds, start the input it held back.
        if (running) void recovery.interrupted(agent)
      }
      for (const pending of [...store.getState().pending]) {
        if (pending.kind === 'approval') pending.resolve('cancelled')
        else pending.reject(new Error('Question cancelled by user'))
      }
    },
    exit(code = 0) {
      requestedExitCode = Math.max(requestedExitCode, code)
      if (shutdownTask !== undefined) return
      store.update((state) => { state.exiting = true })
      commandAbort?.abort(); lifetime.abort(); controlAbort?.abort()
      shutdownTask = (async () => {
        const drained = await Promise.allSettled([commandDrain, creating])
        for (const result of drained) if (result.status === 'rejected') {
          requestedExitCode = 1
          process.stderr.write(`dsh: shutdown: ${safeText(errorText(result.reason))}\n`)
        }
        for (const agent of owned) if (agent.status === 'running') agent.cancel({ kind: 'user' })
        await Promise.allSettled([...owned].map(agent => agent.whenIdle()))
        for (const agent of owned) {
          try { await sessions.flush(agent.session) }
          catch (error) { requestedExitCode = 1; process.stderr.write(`dsh: save failed for ${agent.id}: ${safeText(errorText(error))}\n`) }
        }
        await controlTask
        ink?.unmount()
        io.exit(requestedExitCode)
      })()
    },
    commands() { return mergeCommands(current === undefined ? [] : ctx.get('commands')?.list(current) ?? [], store.getState().skills) },
    answerApproval(id, outcome) { const pending = store.getState().pending.find(entry => entry.id === id); if (pending?.kind === 'approval') pending.resolve(outcome) },
    answerQuestion(id, answer) { const pending = store.getState().pending.find(entry => entry.id === id); if (pending?.kind === 'question') pending.resolve(answer) },
    hint(text) { store.update((state) => { state.hint = text }) },
    closePicker() {
      const prompt = pendingOpeningPrompt
      pendingOpeningPrompt = undefined
      store.update((state) => { state.picker = undefined; if (prompt !== undefined) state.recoveredInput = prompt })
    },
    report(error) {
      // A failed local action belongs above the composer, not in the conversation; turn and session failures are notices.
      store.update((state) => { state.composerError = composerError(error) })
    },
  }
  ctx.effect(() => async () => { controller.exit(); await shutdownTask }, 'tui: cancel, save and restore terminal')

  const requested = config.resumeId?.trim()
  if (requested !== undefined && requested !== '') await resume(requested)
  else if (config.continueLast === true) {
    const id = await mostRecent(ctx, launchCwd, config.all === true)
    if (id === undefined) throw new Error('No saved session in this directory. Run dsh to start a new session.')
    await attach(await backend.resume(id))
  } else if (config.pick === true) {
    if (!tty) throw new Error('A session picker requires a terminal. Use resume <id> or resume --last.')
    await browseSessions(config.all === true)
  } else await attach(await backend.create(launchCwd, config.preset))
  await applyStartupSelection()
  if (tty) {
    // Ink repaints only changed rows, so output from anyone else (Node warnings,
    // plugin stderr) would scroll the alternate screen under it and leave stale
    // rows. While the TUI runs, that output goes to a log file instead.
    const outputLog = dshHomePath('logs', 'tui-output.log')
    let diverted = 0
    const claim = claimTerminal(process.stdout, process.stderr, (text) => {
      if (diverted === 0) {
        mkdirSync(dirname(outputLog), { recursive: true })
        appendFileSync(outputLog, `\n--- ${new Date().toISOString()} · pid ${String(process.pid)}\n`)
        store.update((state) => { state.hint = `Background output moved to ${outputLog}` })
      }
      diverted += text.length
      appendFileSync(outputLog, text)
    })
    const stopResizeInvalidation = claim.onResize(() => { ink?.invalidate() })
    terminalWrite = (value) => { claim.write(value) }
    // An unusable scene asset is reported while a component renders; writing after the current task keeps the diverted-output
    // note from updating state inside that render.
    const reportScene = (error: SceneAssetError): void => {
      queueMicrotask(() => { process.stderr.write(`dsh: ${safeText(error.message)}\n`) })
    }
    const whales = new WhaleAnimations(WHALE_ASSETS, reportScene), laya = new LayaAnimations(LAYA_ASSETS, reportScene)
    // Ink usePaste owns terminal negotiation and restores it on unmount.
    try {
      ink = render(createElement(App, { store, controller, terminal: claim, whales, laya }),
        { stdout: claim.stdout, exitOnCtrlC: false, patchConsole: false, alternateScreen: true, maxFps: 60, incrementalRendering: true })
      if (config.task !== undefined && config.pick !== true) await controller.submit(config.task).catch((error: unknown) => {
        store.update((state) => { state.recoveredInput = config.task })
        controller.report(error)
      })
      await ink.waitUntilExit()
      await shutdownTask
    } finally {
      ink?.unmount()
      stopResizeInvalidation()
      claim.release()
      terminalWrite = (value: string): void => { process.stdout.write(value) }
      if (diverted > 0) process.stderr.write(`dsh: background output written while the TUI ran is in ${outputLog}\n`)
    }
  } else {
    await runPlain(store, controller, io.write, config.task)
    await shutdownTask
  }
}
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('tui-runner: the launcher must provide ctx.appExit')
  void run(ctx, config, { write: (text) => { process.stdout.write(text) }, exit }).catch((error: unknown) => {
    process.stderr.write(`dsh: ${safeText(errorText(error))}\n`)
    exit(1)
  })
}

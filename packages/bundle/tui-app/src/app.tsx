/** @jsxRuntime automatic */
/**
 * Interactive fullscreen TUI application component.
 * Always opens menus/panels in-page (never splits a right-hand pane), expands
 * tools and reasoning inline on click, and provides a 1-click Scroll-to-Bottom bar.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useApp, useInput, usePaste, useStdout, useWindowSize } from 'ink'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { actionKey, type UiAction } from './actions.ts'
import { previewRows, useSessionBrowser } from './browser-view.ts'
import type { CopyResult } from './clipboard.ts'
import { codeBlocks } from './code-blocks.ts'
import { isNamingCommand, PALETTE_TABS, paletteView, type CommandEntry, type PaletteTab } from './commands.ts'
import { Screen } from './components.tsx'
import { compactingRows, createDocumentRenderer, layaPassRows, ROOMY_TERMINAL_ROWS, searchRows } from './document.ts'
import { emptyUndo, redo, remember, undo } from './editor-history.ts'
import { edit, editorAtEnd, emptyEditor, insertText, moveLine, selectionOf, type EditorState } from './editor.ts'
import { moveVisual } from './layout.ts'
import { linkRows } from './links.ts'
import { goalPhase, record } from './metrics.ts'
import { LEGACY_BYTES, MOUSE_OFF, MOUSE_ON, parseMouse, WHEEL_ROWS } from './mouse.ts'
import { hitTest } from './panes.ts'
import { addBlock, blockWithText, expandPastes, placeholder, placeholderAt, referenced, shouldCollapse, type PastedBlock } from './paste.ts'
import type { SubmitGesture } from './queue.ts'
import { fitRow, relabel, row, rule, span, textOfRow, widthOf, type Row } from './rich-text.ts'
import {
  approvalArgumentsOpen,
  approvalControls,
  approvalDetails,
  cardInner,
  cardLayout,
  pickerCard,
  shortPicker,
  composerNotes,
  composerOffsetAt,
  composerRows,
  composerView,
  fitScreen,
  goalControls,
  headerRow,
  highlightRow,
  searchFieldRow,
  indicatorRow,
  inspectorRows,
  keysRows,
  PALETTE_MAX_ROWS,
  paletteRows,
  panelLayout,
  panelTitle,
  pickerLayout,
  promptHeader,
  questionControls,
  questionDetails,
  questionDraft,
  scrollToBottomBar,
  SPINNER,
  statusRow,
  welcomeRows,
  type QuestionDraft,
} from './screen.ts'
import { isEmptySelection, paintSelection, selectedText, type Selection } from './selection.ts'
import type { SessionPreview, SessionSearch } from './session-browser.ts'
import type { ChatState, Panel, PickerRow, Store } from './store.ts'
import type { TerminalSize } from './terminal-guard.ts'
import { attention, FOCUS_OFF, FOCUS_ON, notification, terminalTitle, TITLE_POP, TITLE_PUSH, type SignalSnapshot } from './terminal-signals.ts'
import { anchorAt, promptAbove, promptAnchor, promptBelow, promptMarks, reveal, scrollBy, topOf, type Anchor } from './viewport.ts'
import { ANIMATION_TICK_MS, WELCOME_SCENE, WELCOME_STILL_FRAME, type SceneAnimations } from './animation.ts'
import { layaCutting } from './metrics.ts'

/**
 * One resize gesture delivers many widths, and laying out a long transcript costs far more than a frame:
 * until the width settles, the conversation keeps its last layout, clipped or padded to the live frame.
 */
const RELAYOUT_DELAY_MS = 80
/** How long an informational hint stays above the composer. */
const HINT_TTL_MS = 5000
/** Narrowest terminal that sets the session preview beside the session list instead of under it. */
const SESSIONS_SIDE_MIN_WIDTH = 96

/** Title of an in-page inspector panel. */
function panelName(panel: Exclude<Panel, 'transcript'>): string {
  switch (panel) {
    case 'context': return 'Session status'
    case 'permissions': return 'Permissions'
    case 'tasks': return 'Tasks'
    case 'jobs': return 'Background jobs'
    case 'goal': return 'Goal'
    case 'help': return 'Help'
    default: return assertNever(panel, 'inspector panel')
  }
}

export interface Controller {
  submit(text: string, gesture?: SubmitGesture): Promise<void>
  runCommand(line: string): Promise<void>
  followJob?(id: NonNullable<ChatState['selectedJob']>, signal: AbortSignal): Promise<void>
  sendQueue?(): Promise<void>
  cancel(): void
  exit(code?: number): void
  commands(): CommandEntry[]
  answerApproval(id: string, outcome: ApprovalOutcome): void
  answerQuestion(id: string, answer: AskUserQuestionAnswer): void
  hint(text: string | undefined): void
  closePicker(): void
  report: (error: unknown) => void
  copyText?(text: string, signal?: AbortSignal): Promise<CopyResult>
  pasteImage?(): Promise<void>
  /** Removes the user-queued message at this position of the composer's queue rows. */
  removeQueued?(index: number): Promise<void>
  editPrompt?: (text: string, signal: AbortSignal) => Promise<string>
  searchSessions?(query: string, signal: AbortSignal): Promise<SessionSearch>
  previewSession?(id: string, signal: AbortSignal): Promise<SessionPreview>
}

export function App({ store, controller, terminal, animations }: {
  store: Store
  controller: Controller
  terminal?: TerminalSize
  /** The welcome, Thinking and pruning animations this screen shows, owned by the caller for the screen's lifetime. */
  animations: SceneAnimations
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => {
    if (state.panel !== 'jobs' || state.selectedJob === undefined || controller.followJob === undefined) return
    const abort = new AbortController()
    void controller.followJob(state.selectedJob, abort.signal).catch((error: unknown) => {
      if (!abort.signal.aborted) controller.report(error)
    })
    return () => { abort.abort() }
  }, [state.panel, state.selectedJob, state.sessionId, controller])
  const windowSize = useWindowSize()
  const { stdout } = useStdout()
  // Terminal control sequences go to the stream itself: Ink's own write channel
  // erases and repaints the frame on every call, and stops accepting writes
  // before React cleanup runs. None of these sequences paints anything.
  const write = (text: string): void => { stdout.write(text) }
  const app = useApp()

  const [size, setSize] = useState(() => terminal?.size() ?? { columns: windowSize.columns || 80, rows: windowSize.rows || 24 })

  useEffect(() => {
    if (terminal === undefined) {
      setSize({ columns: windowSize.columns || 80, rows: windowSize.rows || 24 })
      return undefined
    }
    return terminal.onResize(() => { setSize(terminal.size()) })
  }, [terminal, windowSize.columns, windowSize.rows])

  const width = Math.max(20, size.columns - 1)
  const height = Math.max(8, size.rows)

  // The frame follows every resize step; the conversation re-wraps only once the width has been stable for
  // RELAYOUT_DELAY_MS. Each new width restarts the wait, so a drag lays out the transcript once, at its final width.
  const [layoutWidth, setLayoutWidth] = useState(width)
  useEffect(() => {
    if (layoutWidth === width) return undefined
    const timer = setTimeout(() => { setLayoutWidth(width) }, RELAYOUT_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [width, layoutWidth])

  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [undoState, setUndoState] = useState(emptyUndo)
  const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([])
  const nextPasteId = useRef(1)
  const [stash, setStash] = useState<EditorState | undefined>(undefined)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined)
  const [composerScroll, setComposerScroll] = useState<number | undefined>(undefined)

  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [rawTools, setRawTools] = useState(false)
  const [selectedItemIdx, setSelectedItemIdx] = useState(0)

  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissedCommand, setDismissedCommand] = useState<string | undefined>(undefined)
  const [paletteTab, setPaletteTab] = useState<PaletteTab>('all')
  // The Keys box `?` opens above the composer; the next key closes it.
  const [keysOpen, setKeysOpen] = useState(false)

  const [pickerSearch, setPickerSearch] = useState<EditorState>(emptyEditor)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [panelOffset, setPanelOffset] = useState(0)
  // Page size and last offset of the panel last painted; key and wheel scrolling stay inside it.
  const panelFrame = useRef({ page: 1, maximum: 0 })
  const scrollPanel = (delta: number): void => {
    setPanelOffset((o) => {
      const maximum = panelFrame.current.maximum
      return Math.max(0, Math.min(maximum, Math.min(o, maximum) + delta))
    })
  }

  const [searchMode, setSearchMode] = useState<'none' | 'transcript' | 'history'>('none')
  const [searchQuery, setSearchQuery] = useState<EditorState>(emptyEditor)
  const [searchHitIndex, setSearchHitIndex] = useState(0)
  // Typing edits the transcript query until Enter; then n/N step through hits until Esc.
  const [searchEditing, setSearchEditing] = useState(true)

  const [approvalAllowed, setApprovalAllowed] = useState(false)
  // The reader's choice to open or fold an approval's complete arguments; undefined keeps the card's default.
  const [approvalArguments, setApprovalArguments] = useState<boolean | undefined>(undefined)
  const [qDraft, setQDraft] = useState<QuestionDraft>(questionDraft)
  const promptMountedAt = useRef(Date.now())

  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  // The welcome whale plays from its first frame each time the empty conversation appears: at start, after /clear and on a
  // switch to an empty session.
  const welcomeShown = state.transcript.items.length <= state.hiddenBefore
  const welcomeKey = welcomeShown ? `${state.sessionId}:${state.viewEpoch}` : undefined
  const [welcomeStart, setWelcomeStart] = useState<{ key: string; tick: number } | undefined>(undefined)
  if (welcomeKey !== welcomeStart?.key) setWelcomeStart(welcomeKey === undefined ? undefined : { key: welcomeKey, tick })
  // Laya pruning time is local to the pass: ticks since its current pruning phase began, restarted after a managed phase.
  const layaCut = state.transcript.layaPruning === true && layaCutting(state.transcript.layaPhase) ? state.transcript.layaPruneId ?? '' : undefined
  const [layaCutStart, setLayaCutStart] = useState<{ key: string; tick: number } | undefined>(undefined)
  if (layaCut !== layaCutStart?.key) setLayaCutStart(layaCut === undefined ? undefined : { key: layaCut, tick })
  const layaElapsedMs = layaCut === undefined || layaCutStart === undefined || state.motion === false
    ? 0 : Math.max(0, tick - layaCutStart.tick) * ANIMATION_TICK_MS
  // A context compaction shows its elapsed time from the moment this screen first saw it running.
  const [compactStart, setCompactStart] = useState<number | undefined>(undefined)
  if (state.transcript.compacting !== (compactStart !== undefined)) setCompactStart(state.transcript.compacting ? now : undefined)
  const [copiedKey, setCopiedKey] = useState<{ key: string; confirmed: boolean } | undefined>(undefined)
  const [selection, setSelection] = useState<(Selection & {
    document?: readonly Row[]
    pointer?: { x: number; y: number }
  }) | undefined>(undefined)
  const [draggingDraft, setDraggingDraft] = useState(false)
  const legacyDrop = useRef(0)
  const focused = useRef(true)
  const prevSignal = useRef<SignalSnapshot | undefined>(undefined)
  const submitting = useRef<{ interrupt: boolean } | undefined>(undefined)
  const lastCtrlC = useRef(0)

  const renderer = useMemo(() => createDocumentRenderer(), [])

  // Reset anchors on session switch or /clear
  useEffect(() => {
    setAnchor(null)
    setSelection(undefined)
    setOverrides({})
    setPanelOffset(0)
    renderer.clear()
  }, [state.viewEpoch, state.sessionId, renderer])

  // Recover failed opening input into empty composer
  useEffect(() => {
    if (state.recoveredInput !== undefined && editor.text === '') {
      setEditor(editorAtEnd(state.recoveredInput))
      store.update((s) => { s.recoveredInput = undefined })
    }
  }, [state.recoveredInput, editor.text, store])

  // Informational hints are transient; errors stay until the next keystroke, prompt or command.
  useEffect(() => {
    const hint = state.hint
    if (hint === undefined) return undefined
    const timer = setTimeout(() => { store.update((s) => { if (s.hint === hint) s.hint = undefined }) }, HINT_TTL_MS)
    return () => { clearTimeout(timer) }
  }, [state.hint, store])
  const clearTransient = (): void => {
    if (store.getState().hint !== undefined || store.getState().composerError !== undefined) {
      store.update((s) => { s.hint = undefined; s.composerError = undefined })
    }
  }

  // Guard against accidental carry-over keystrokes when approval/question appears
  const activePendingId = state.pending[0]?.id
  useEffect(() => {
    promptMountedAt.current = Date.now()
    setApprovalAllowed(false)
    setApprovalArguments(undefined)
    setQDraft(questionDraft())
    setPanelOffset(0)
  }, [activePendingId])

  // Mouse mode negotiation
  useEffect(() => {
    if (state.mouse === false) return
    write(MOUSE_ON)
    return () => { write(MOUSE_OFF) }
  }, [state.mouse, stdout])

  // Terminal focus & title restoration
  useEffect(() => {
    if (state.terminalTitle !== true && (state.notifications ?? 'off') === 'off') return
    if (state.terminalTitle === true) write(TITLE_PUSH)
    if ((state.notifications ?? 'off') !== 'off') write(FOCUS_ON)
    return () => {
      if ((state.notifications ?? 'off') !== 'off') write(FOCUS_OFF)
      if (state.terminalTitle === true) write(TITLE_POP)
    }
  }, [state.terminalTitle, state.notifications, stdout])

  const signal = (): SignalSnapshot => ({
    sessionId: state.sessionId,
    title: state.title,
    running: state.status === 'running',
    ...(state.pending[0] === undefined ? {} : { pendingId: state.pending[0].id, pendingKind: state.pending[0].kind }),
  })
  // The title's spinner turns every tick while a turn runs, and stays off with motion off.
  const titleFrame = state.terminalTitle === true && state.status === 'running' && state.motion !== false ? tick : undefined
  useEffect(() => {
    if (state.terminalTitle === true) write(terminalTitle(signal(), titleFrame))
  }, [state.sessionId, state.title, state.status, state.pending, state.terminalTitle, titleFrame, stdout])

  useEffect(() => {
    const snap = signal()
    const note = attention(prevSignal.current, snap)
    prevSignal.current = snap
    if (note !== undefined && !focused.current && state.notifications !== undefined && state.notifications !== 'off') {
      const seq = notification(note, state.notifications)
      if (seq !== '') write(seq)
    }
  }, [state.sessionId, state.title, state.status, state.pending, state.terminalTitle, state.notifications, stdout])

  // External editor handoff (Ctrl+G)
  const runExternalEditor = async (): Promise<void> => {
    const editPrompt = controller.editPrompt
    if (editPrompt === undefined) return
    const abort = new AbortController()
    try {
      await app.suspendTerminal(async () => {
        if (state.mouse !== false) write(MOUSE_OFF)
        try {
          const currentText = expandPastes(editor.text, pastedBlocks)
          const updated = await editPrompt(currentText, abort.signal)
          const next = editorAtEnd(updated)
          setUndoState(u => remember(u, editor, next))
          setEditor(next)
          setPastedBlocks([])
        } finally {
          if (state.mouse !== false) write(MOUSE_ON)
        }
      })
    } catch (error) {
      controller.report(error instanceof Error ? error : new Error(String(error)))
    }
  }

  // The shared tick runs while work is in progress, while the empty conversation plays the welcome whale, and while a jobs
  // or tasks panel shows the running time of a live job. It follows the visible conversation, not the transcript: /clear
  // hides settled items without removing them.
  const working = state.status === 'running' || state.busy !== undefined || state.transcript.compacting || state.transcript.layaPruning === true || (state.reviewingApprovals ?? 0) > 0
  const watchingJobs = (state.panel === 'jobs' || state.panel === 'tasks') && state.jobs.some(job => job.status === 'running' || job.status === 'stopping')
  const ticking = working || (welcomeShown && state.motion !== false) || watchingJobs
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => {
      setTick(t => t + 1)
      setNow(Date.now())
    }, ANIMATION_TICK_MS)
    return () => { clearInterval(timer) }
  }, [ticking])

  const updateDraft = (next: EditorState): void => {
    setUndoState(u => remember(u, editor, next))
    setEditor(next)
    setPastedBlocks(blocks => referenced(next.text, blocks))
    setComposerScroll(undefined)
  }

  const allCommands = useMemo(() => controller.commands(), [controller, state.sessionId, state.preset, state.skills])
  const namingCmd = isNamingCommand(editor.text) && dismissedCommand !== editor.text
  const palette = useMemo(() => paletteView(namingCmd ? allCommands : [], editor.text, paletteTab),
    [namingCmd, allCommands, editor.text, paletteTab])
  const matchingCommands = palette.entries
  useEffect(() => { if (!namingCmd) setPaletteTab('all') }, [namingCmd])

  const browser = useSessionBrowser(state.picker, pickerSearch.text, pickerIndex, controller)

  const visibleItems = useMemo(
    () => state.transcript.items.slice(state.hiddenBefore),
    [state.transcript.items, state.hiddenBefore],
  )

  // Transcript browsing opens every tool; the conversation keeps them on one row each.
  const expandAll = state.expandedTools || state.panel === 'transcript'
  const liveDocRows = useMemo(() => {
    const raw = renderer.render(visibleItems, {
      width: layoutWidth,
      expanded: expandAll,
      overrides,
      raw: rawTools,
      tick: state.motion === false ? 0 : tick,
      now,
      motion: state.motion !== false,
      terminalRows: height,
      animations,
    })
    // A running Laya pass follows the conversation in its live row; its result row replaces it when the pass ends.
    if (state.transcript.layaPruning === true) {
      raw.push(...layaPassRows({ phase: state.transcript.layaPhase, elapsedMs: layaElapsedMs }, { width: layoutWidth, animations }))
    }
    if (compactStart !== undefined) {
      const size = state.transcript.usage?.input
      raw.push(...compactingRows({ mark: state.motion === false ? '◌' : SPINNER[tick % SPINNER.length] ?? '◌', elapsedMs: Math.max(0, now - compactStart),
        ...size === undefined ? {} : { tokens: size } }, layoutWidth))
    }
    return linkRows(raw, state.cwd, state.links !== false).map((r) => {
      const at = copiedKey === undefined ? -1
        : r.spans.findIndex(part => part.action !== undefined && actionKey(part.action) === copiedKey.key)
      const part = r.spans[at]
      if (copiedKey === undefined || part === undefined) return r
      // A bracketed button keeps its brackets; a label in a border keeps the border's columns.
      const label = part.text.startsWith('[') ? (copiedKey.confirmed ? '[Copied]' : '[ Sent ]') : (copiedKey.confirmed ? 'Copied' : 'Sent')
      return relabel(r, at, label, { tone: 'success', bold: true })
    })
  }, [renderer, visibleItems, layoutWidth, height, expandAll, state.panel, overrides, rawTools, tick,
    state.motion, state.cwd, state.links, copiedKey, now, animations, state.transcript.layaPruning, state.transcript.layaPhase,
    layaElapsedMs, compactStart, state.transcript.usage])

  // Keep the selected document stable while new output arrives or tools collapse.
  const docRows = selection?.document ?? liveDocRows

  const transcriptHits = useMemo(
    () => searchMode === 'transcript' ? searchRows(docRows, searchQuery.text) : [],
    [searchMode, docRows, searchQuery.text],
  )

  const historyHits = useMemo(() => {
    if (searchMode !== 'history') return []
    const q = searchQuery.text.toLowerCase()
    return [...history].reverse().filter(entry => entry.toLowerCase().includes(q))
  }, [searchMode, history, searchQuery.text])

  const userPromptIds = useMemo(
    () => new Set(visibleItems.filter(i => i.kind === 'user').map(i => i.id)),
    [visibleItems],
  )
  const marks = useMemo(() => promptMarks(docRows, userPromptIds), [docRows, userPromptIds])

  // Calculate layout regions: header and indicators, the conversation, then the composer block between two rules and the status row.
  // A terminal with rows to spare keeps a blank row under the header, under the indicator row and above the composer.
  const gap = height >= ROOMY_TERMINAL_ROWS ? [row('')] : []
  const header = [headerRow(state, width), ...gap]
  const indicator = indicatorRow(state, width)
  const indicatorLines = indicator === undefined ? [] : [indicator, ...gap]
  const userQueue = state.queue.filter(q => q.placement !== 'context')

  // An open search takes the composer's line: the field between the same two rules, the draft kept behind it.
  const searchField = searchMode === 'none' ? undefined
    : searchMode === 'transcript'
      ? searchFieldRow(searchQuery, searchEditing, '',
        transcriptHits.length === 0 ? (searchQuery.text === '' ? '' : 'no match') : `${searchHitIndex + 1} of ${transcriptHits.length}`,
        searchEditing ? [['Enter', 'search'], ['Esc', 'close']] : [['n · N', 'next · previous'], ['Esc', 'close']], width)
      : searchFieldRow(searchQuery, true, searchQuery.text === '' ? 'prompt history' : historyHits[0]?.replace(/\s+/gu, ' ') ?? 'no match', '',
        [['Enter', 'pick'], ['Esc', 'close']], width)

  const maxComposerLines = Math.max(1, Math.min(6, Math.floor(height / 4)))
  const placeholderText = state.status === 'running' ? 'Enter steers this turn · Tab queues for the next one' : 'Ask anything'
  const compRows = searchField === undefined
    ? composerRows(editor, width, maxComposerLines, placeholderText, false, composerScroll, state.attachments) : [rule(width), searchField]
  const bottomRule = [rule(width)]
  // Approvals, questions and short pickers take the composer's place; the other pickers and in-page panels also cover the conversation.
  const composerShown = state.pending.length === 0 && state.picker === undefined
    && (state.panel === undefined || state.panel === 'transcript')
  const foot = [statusRow(state, width, tick, now, composerShown)]
  // The composer, its rules and the status row always fit; waiting notes, the palette and the Keys box share what is left.
  const fixedHeight = header.length + indicatorLines.length + gap.length + compRows.length + bottomRule.length + foot.length
  const noteRows = composerNotes(state, width).slice(-Math.max(1, height - fixedHeight - 1))
  const paletteIndex = Math.min(commandIndex, Math.max(0, matchingCommands.length - 1))
  const paletteHeight = Math.min(PALETTE_MAX_ROWS, Math.floor(height / 2), height - fixedHeight - noteRows.length - 1)
  const cmdPopupRows = namingCmd ? paletteRows(palette, paletteIndex, paletteTab, width, paletteHeight) : []
  const keyRows = keysOpen ? keysRows(width, height - fixedHeight - noteRows.length - cmdPopupRows.length - 1) : []

  const chromeHeight = fixedHeight + noteRows.length + cmdPopupRows.length + keyRows.length
  const bodyBudget = Math.max(1, height - chromeHeight)

  // Scroll-to-Bottom button, and a sticky prompt header that covers the top viewport row
  const hasScrollBar = anchor !== null && bodyBudget >= 3 && topOf(docRows, bodyBudget - 2, anchor) < docRows.length - (bodyBudget - 2)
  const viewportHeight = Math.max(1, bodyBudget - (hasScrollBar ? 2 : 0))
  const currentTop = topOf(docRows, viewportHeight, anchor)
  const activePromptMark = promptAbove(marks, currentTop)
  // At the top of the document no prompt is above the viewport, even when one starts on its first row.
  const hasStickyHeader = activePromptMark !== undefined && viewportHeight > 1 && currentTop > 0
  const maxTop = Math.max(0, docRows.length - viewportHeight)
  const linesAboveBottom = Math.max(0, maxTop - currentTop)

  /** Close manually expanded, finished tools only after downward navigation passes their final row. */
  const moveViewport = (next: Anchor | null): void => {
    const nextTop = topOf(docRows, viewportHeight, next)
    if (selection === undefined && nextTop > currentTop) {
      const expanded = new Set(visibleItems.filter(item => item.kind === 'tool' && item.settled && overrides[item.id] === true).map(item => item.id))
      const passed: string[] = []
      for (let i = currentTop; i < nextTop; i += 1) {
        const id = docRows[i]?.itemId
        if (id !== undefined && expanded.has(id) && docRows[i + 1]?.itemId !== id) passed.push(id)
      }
      if (passed.length > 0) setOverrides(previous => ({ ...previous, ...Object.fromEntries(passed.map(id => [id, false])) }))
    }
    setAnchor(next)
  }
  const scrollDocument = (delta: number): void => { moveViewport(scrollBy(docRows, viewportHeight, anchor, delta)) }

  const choosePickerRow = (chosen: PickerRow): void => {
    if (chosen.command !== undefined) { clearTransient(); void controller.runCommand(chosen.command).catch(controller.report); return }
    controller.closePicker()
    if (chosen.draft !== undefined) updateDraft(editorAtEnd(chosen.draft))
  }

  /** Scroll a document row into view below the sticky prompt header, which covers the top row. */
  const revealRow = (index: number): void => {
    setAnchor(index <= currentTop ? anchorAt(docRows, Math.max(0, index - 1)) : reveal(docRows, viewportHeight, anchor, index))
  }

  const executeAction = (action: UiAction): void => {
    switch (action.kind) {
      case 'copy-code': {
        const targetItem = state.transcript.items.find(i => i.id === action.itemId)
        if (targetItem?.kind !== 'assistant') return
        const block = codeBlocks(targetItem.text)[action.block]
        if (block === undefined || controller.copyText === undefined) return
        void controller.copyText(block.text).then((res) => {
          setCopiedKey({ key: actionKey(action), confirmed: res.confirmed })
          controller.hint(res.confirmed ? 'Copied code block to clipboard.' : 'Sent via OSC 52.')
        }).catch((err: unknown) => { controller.report(err instanceof Error ? err : new Error(String(err))) })
        return
      }
      case 'copy-text': {
        if (controller.copyText === undefined) return
        void controller.copyText(action.text).then((res) => {
          setCopiedKey({ key: actionKey(action), confirmed: res.confirmed })
          controller.hint(res.confirmed ? `Copied ${action.label}.` : 'Sent via OSC 52.')
        }).catch((err: unknown) => { controller.report(err instanceof Error ? err : new Error(String(err))) })
        return
      }
      case 'inspect-item': {
        // Toggle inline expansion directly in the conversation without locking into a modal/split!
        setOverrides((prev) => {
          const currentVal = prev[action.itemId] ?? expandAll
          return { ...prev, [action.itemId]: !currentVal }
        })
        return
      }
      case 'toggle-reasoning': {
        const key = `reasoning:${action.itemId}`
        setOverrides(prev => ({ ...prev, [key]: !(prev[key] ?? false) }))
        return
      }
      case 'live-tail': {
        moveViewport(null)
        return
      }
      case 'jump-prompt': {
        const mark = marks.find(m => m.itemId === action.itemId)
        if (mark !== undefined) moveViewport(promptAnchor(docRows, viewportHeight, mark))
        return
      }
      case 'command-complete': {
        updateDraft(editorAtEnd(`/${action.name} `))
        setDismissedCommand(undefined)
        return
      }
      case 'detach': {
        store.update((s) => { s.attachments = s.attachments.filter((_, idx) => idx !== action.index) })
        return
      }
      case 'picker-select': {
        const idx = browser.rows.findIndex(r => r.id === action.id)
        if (idx >= 0) setPickerIndex(idx)
        return
      }
      case 'picker-confirm': {
        const target = browser.rows.find(r => r.id === action.id)
        if (target !== undefined) choosePickerRow(target)
        return
      }
      case 'approval-select': {
        setApprovalAllowed(action.allowed)
        return
      }
      case 'approval-arguments': {
        const pending = state.pending[0]
        if (pending?.kind !== 'approval') return
        setApprovalArguments(open => !(open ?? approvalArgumentsOpen(pending)))
        setPanelOffset(0)
        return
      }
      case 'approval-confirm': {
        if (Date.now() - promptMountedAt.current < 250) return
        const pending = state.pending[0]
        if (pending?.kind === 'approval') {
          controller.answerApproval(pending.id, approvalAllowed ? 'allowed-once' : 'rejected')
        }
        return
      }
      case 'question-option': {
        const pending = state.pending[0]
        if (pending?.kind !== 'question') return
        const q = pending.questions[qDraft.index]
        const opt = q?.options?.[action.index]
        if (opt === undefined) return
        setQDraft(d => ({
          ...d,
          customMode: false,
          optionIndex: action.index,
          selected: q?.multiSelect
            ? (d.selected.includes(opt.label) ? d.selected.filter(x => x !== opt.label) : [...d.selected, opt.label])
            : [opt.label],
        }))
        return
      }
      case 'question-confirm': {
        if (Date.now() - promptMountedAt.current < 250) return
        const pending = state.pending[0]
        if (pending?.kind !== 'question') return
        const q = pending.questions[qDraft.index]
        if (q === undefined) return
        const highlighted = q.options?.[qDraft.optionIndex]
        const chosen = qDraft.selected.length > 0
          ? qDraft.selected
          : highlighted !== undefined && !qDraft.customMode ? [highlighted.label] : []
        const customText = qDraft.custom.text.trim() === '' ? '' : qDraft.custom.text
        // A single-select answer is either one option or the custom text, whichever field holds focus;
        // a multi-select answer keeps checked options beside custom text.
        const answer = q.multiSelect === true
          ? { selected: chosen, custom: customText }
          : qDraft.customMode && customText !== ''
            ? { selected: [], custom: customText }
            : { selected: chosen, custom: chosen.length === 0 ? customText : '' }
        controller.answerQuestion(pending.id, {
          answers: [{
            id: q.id,
            selected: answer.selected,
            ...(answer.custom === '' ? {} : { custom: answer.custom }),
          }],
        })
        return
      }
      case 'open-permissions': {
        void controller.runCommand('/permission').catch(controller.report)
        return
      }
      case 'open-jobs': {
        store.update((s) => { s.panel = 'jobs'; s.selectedJob = undefined; s.jobDetail = undefined })
        setPanelOffset(0)
        return
      }
      case 'inspect-job': {
        store.update((s) => { s.panel = 'jobs'; s.selectedJob = action.jobId; s.jobDetail = undefined })
        setPanelOffset(0)
        return
      }
      case 'open-goal': {
        store.update((s) => { s.panel = s.panel === 'goal' ? undefined : 'goal' })
        return
      }
      case 'goal-edit': {
        const goal = record(record(state.projections.goal).goal)
        if (typeof goal.objective === 'string') {
          store.update((s) => { s.panel = undefined })
          updateDraft(editorAtEnd(`/goal edit ${goal.objective}`))
        }
        return
      }
      case 'goal-command': {
        store.update((s) => { s.panel = undefined })
        clearTransient()
        void controller.runCommand(action.command).catch(controller.report)
        return
      }
      case 'close-details': {
        store.update((s) => { s.panel = undefined })
        return
      }
      case 'open-tasks': {
        store.update((s) => { s.panel = 'tasks' })
        setPanelOffset(0)
        return
      }
      case 'palette-tab': {
        setPaletteTab(action.tab)
        setCommandIndex(0)
        return
      }
      case 'toggle-keys': {
        setKeysOpen(open => !open)
        return
      }
      case 'queue-remove': {
        clearTransient()
        void controller.removeQueued?.(action.index).catch(controller.report)
        return
      }
    }
  }

  const documentStartY = header.length + indicatorLines.length
  const documentPoint = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: currentTop + point.y - documentStartY >= docRows.length ? width - 1 : point.x,
    y: Math.max(0, Math.min(docRows.length - 1,
      currentTop + Math.max(hasStickyHeader ? 1 : 0, Math.min(viewportHeight - 1, point.y - documentStartY)))),
  })
  const effectiveSelection = selection?.document !== undefined && selection.pointer !== undefined
    ? { ...selection, head: documentPoint(selection.pointer) } : selection

  // Assemble the painted screen rows
  const paintedFrame = useMemo((): Row[] => {
    const pending = state.pending[0]
    // A request for a choice takes the composer's place as a card: the conversation stays above it and the status row
    // below, so the reader still sees what the request is about.
    const cardHeight = Math.max(3, height - header.length - indicatorLines.length - foot.length)
    const inner = cardInner(width)
    const overComposer = (card: readonly Row[]): Row[] => {
      const room = Math.max(0, height - header.length - indicatorLines.length - card.length - foot.length)
      const end = Math.min(docRows.length, currentTop + viewportHeight)
      // One blank row stays between the conversation and the card.
      const above = visibleItems.length === 0 ? [] : docRows.slice(Math.max(0, end - (room - 1)), end)
      while (above.length < room) above.push(row(''))
      return fitScreen([...header, ...indicatorLines, ...above, ...card, ...foot], width, height)
    }
    if (pending?.kind === 'approval') {
      const details = approvalDetails(pending, inner, approvalArguments)
      const controls = approvalControls(inner, approvalAllowed, state.pending.length)
      const layout = cardLayout('! Permission required', pending.toolName, details, controls, 'warning', width, cardHeight, panelOffset)
      panelFrame.current = { page: layout.page, maximum: layout.maximum }
      return overComposer(layout.rows)
    }
    if (pending?.kind === 'question') {
      const details = questionDetails(pending, qDraft, inner)
      const controls = questionControls(pending, qDraft, inner, height - foot.length)
      const layout = cardLayout(pending.questions[qDraft.index]?.header || 'Question',
        pending.questions.length > 1 ? `question ${qDraft.index + 1} of ${pending.questions.length}` : '', details, controls, 'accent', width, cardHeight, panelOffset)
      panelFrame.current = { page: layout.page, maximum: layout.maximum }
      return overComposer(layout.rows)
    }
    if (state.picker !== undefined && shortPicker(state.picker)) {
      const focused = Math.min(pickerIndex, Math.max(0, browser.rows.length - 1))
      return overComposer(pickerCard(state.picker, browser.rows, pickerSearch, focused, width, cardHeight))
    }
    if (state.picker !== undefined) {
      const statusText = browser.search?.loading ? 'Searching sessions…' : browser.search?.error
      const isSessions = state.picker.kind === 'sessions'
      const previewHeight = isSessions && height >= 18 ? Math.min(10, Math.floor(height * 0.35)) : 0
      const listHeight = Math.max(4, height - previewHeight)
      const selectedRow = Math.min(pickerIndex, Math.max(0, browser.rows.length - 1))
      if (isSessions && width >= SESSIONS_SIDE_MIN_WIDTH && height >= 12) {
        // A wide terminal sets the preview beside the list, so the list keeps the whole height.
        const left = Math.max(44, Math.floor(width * 0.46)), right = width - left - 3
        const list = pickerLayout(state.picker, browser.rows, pickerSearch, selectedRow, left, height, statusText)
        const side = [panelTitle(right, 'Session preview'), ...previewRows(browser.preview, right)]
        return fitScreen(list.map((value, at) => {
          const fitted = fitRow(value, left)
          return row(...fitted.spans, span(' '.repeat(left - widthOf(textOfRow(fitted)))), span(' │ ', 'comment'), ...side[at]?.spans ?? [])
        }), width, height)
      }
      const listRows = pickerLayout(state.picker, browser.rows, pickerSearch, selectedRow, width, listHeight, statusText)
      if (previewHeight === 0) return fitScreen(listRows, width, height)
      const prev = [
        panelTitle(width, 'Session preview'),
        ...previewRows(browser.preview, width).slice(0, Math.max(1, previewHeight - 1)),
      ]
      return fitScreen([...listRows, ...prev], width, height)
    }
    if (state.panel !== undefined && state.panel !== 'transcript') {
      const details = inspectorRows(state, state.panel, allCommands, width, now)
      const controls = state.panel === 'goal'
        ? goalControls(goalPhase(state), width)
        : [fitRow(row({ ...span('[ Close ] ', 'accent', true), action: { kind: 'close-details' as const } }, span('PgUp/PgDn scroll · Esc return to chat', 'footer')), width)]
      const layout = panelLayout(panelName(state.panel), details, controls, width, height - foot.length, panelOffset)
      panelFrame.current = { page: layout.page, maximum: layout.maximum }
      return fitScreen([...layout.rows, ...foot], width, height)
    }

    const bodyRows: Row[] = []

    if (visibleItems.length === 0) {
      // Motion off holds the fully formed whale; otherwise the loop runs from its first frame.
      const whale = state.motion === false ? animations.still(WELCOME_SCENE, WELCOME_STILL_FRAME)
        : animations.frame(WELCOME_SCENE, Math.max(0, tick - (welcomeStart?.tick ?? tick)) * ANIMATION_TICK_MS)
      const effort = state.selection.reasoningEffort
      bodyRows.push(...welcomeRows(whale, width, viewportHeight,
        `${state.cwd} · ${state.selection.provider}/${state.selection.model}${effort === undefined ? '' : ` ${effort}`}`))
    } else {
      const windowRows = docRows.slice(currentTop, currentTop + viewportHeight)
      const windowSelection = selection?.document !== undefined && effectiveSelection !== undefined
        ? { anchor: { ...effectiveSelection.anchor, y: effectiveSelection.anchor.y - currentTop },
          head: { ...effectiveSelection.head, y: effectiveSelection.head.y - currentTop } } : undefined
      const currentHit = transcriptHits[searchHitIndex]
      const visibleSlice = paintSelection(windowRows, windowSelection).map((r, at) =>
        searchMode === 'transcript' ? highlightRow(r, searchQuery.text, currentTop + at === currentHit) : r,
      )
      bodyRows.push(...visibleSlice)
      while (bodyRows.length < viewportHeight) bodyRows.push(row(''))
      if (hasStickyHeader) {
        const promptItem = visibleItems.find(i => i.id === activePromptMark.itemId)
        const promptIdx = marks.findIndex(m => m.itemId === activePromptMark.itemId) + 1
        bodyRows[0] = promptHeader(promptItem?.kind === 'user' ? promptItem.text : '', activePromptMark.itemId, promptIdx, marks.length, width)
      }
    }

    if (hasScrollBar) {
      bodyRows.push(...scrollToBottomBar(linesAboveBottom, width))
    }

    return fitScreen([
      ...header,
      ...indicatorLines,
      ...bodyRows,
      ...gap,
      ...keyRows,
      ...noteRows,
      ...compRows,
      ...cmdPopupRows,
      ...bottomRule,
      ...foot,
    ], width, height)
  }, [
    state, width, height, approvalAllowed, approvalArguments, panelOffset, foot, qDraft, browser, pickerSearch, pickerIndex,
    allCommands, hasStickyHeader, activePromptMark, visibleItems, marks, tick, docRows, currentTop, animations, welcomeStart,
    viewportHeight, searchMode, searchQuery.text, hasScrollBar, linesAboveBottom, header, indicatorLines, selection, effectiveSelection,
    transcriptHits, searchHitIndex, keyRows, noteRows, compRows, cmdPopupRows, bottomRule, gap,
  ])

  const composerStartY = height - foot.length - bottomRule.length - cmdPopupRows.length - compRows.length
  const onComposer = (y: number): boolean => composerShown && searchMode === 'none' && y >= composerStartY && y < composerStartY + compRows.length

  usePaste((rawText: string) => {
    setSelection(undefined)
    setKeysOpen(false)
    if (state.composerError !== undefined) store.update((s) => { s.composerError = undefined })
    const clean = rawText.replace(/\r\n?/gu, '\n')
    if (state.pending[0]?.kind === 'approval') return
    if (state.pending[0]?.kind === 'question') {
      setQDraft(d => ({ ...d, customMode: true, custom: insertText(d.custom, clean) }))
      return
    }
    if (state.picker !== undefined) {
      setPickerSearch(s => insertText(s, clean))
      setPickerIndex(0)
      return
    }
    if (searchMode !== 'none') {
      setSearchQuery(s => insertText(s, clean))
      setSearchHitIndex(0)
      return
    }
    if (shouldCollapse(clean)) {
      const existing = blockWithText(pastedBlocks, clean)
      if (existing !== undefined) {
        const tok = placeholder(existing)
        if (editor.text.includes(tok)) {
          updateDraft(editorAtEnd(editor.text.replace(tok, clean)))
          return
        }
      }
      const id = nextPasteId.current++
      const added = addBlock(pastedBlocks, clean, id)
      setPastedBlocks(added.blocks)
      updateDraft(insertText(editor, placeholder(added.block)))
      return
    }
    updateDraft(insertText(editor, clean))
  })

  /** Copy dragged text and report how much reached the clipboard. */
  const copyDragged = (text: string): void => {
    if (controller.copyText === undefined) { controller.hint('Clipboard is unavailable in this host. Use /export.'); return }
    const chars = Array.from(text).length
    void controller.copyText(text).then((result) => {
      controller.hint(result.confirmed
        ? `Copied ${chars} chars to clipboard`
        : `Sent ${chars} chars to the terminal clipboard (OSC 52)`)
    }).catch(controller.report)
  }

  const submitDraft = (gesture: SubmitGesture): void => {
    setSelection(undefined)
    const expanded = expandPastes(editor.text, pastedBlocks)
    if (submitting.current !== undefined) {
      if (gesture !== 'queue' && expanded.trim() === '' && state.attachments.length === 0) submitting.current.interrupt = true
      return
    }
    if (expanded.trim() === '' && state.attachments.length === 0) {
      if (gesture !== 'queue' && userQueue.length > 0 && controller.sendQueue !== undefined) {
        void controller.sendQueue().catch(controller.report)
      }
      return
    }
    if (gesture === 'enter' && expanded.trim().startsWith('/') && (!expanded.includes('\n') || /^\/prechat(?:\s|$)/u.test(expanded.trim()))) {
      const cmdLine = expanded.trim()
      updateDraft(emptyEditor())
      setPastedBlocks([])
      setDismissedCommand(undefined)
      clearTransient()
      void controller.runCommand(cmdLine).catch(controller.report)
      return
    }
    clearTransient()
    const previousDraft = editor
    const previousBlocks = pastedBlocks
    const submission = { interrupt: false }
    submitting.current = submission
    setHistory(h => [...h.slice(-99), expanded])
    setHistoryIndex(undefined)
    updateDraft(emptyEditor())
    setPastedBlocks([])
    setAnchor(null)
    void controller.submit(expanded, gesture).then(() => {
      if (submission.interrupt && store.getState().sessionId === state.sessionId) {
        void controller.sendQueue?.().catch(controller.report)
      }
    }, (err: unknown) => {
      setEditor(e => e.text === '' ? previousDraft : insertText(previousDraft, e.text))
      setPastedBlocks(previousBlocks)
      controller.report(err instanceof Error ? err : new Error(String(err)))
    }).finally(() => {
      submitting.current = undefined
    })
  }

  useInput((input, key) => {
    if ((key as { eventType?: string }).eventType === 'repeat') return
    // Focus reports (CSI I / CSI O) can arrive batched, and Ink may strip the leading ESC.
    const focusReports = /^(?:\u001b?\[[IO])+$/u.test(input) ? input.match(/\[[IO]/gu) : null
    if (focusReports !== null) { focused.current = focusReports.at(-1) === '[I'; return }

    if (legacyDrop.current > 0) {
      legacyDrop.current--
      return
    }

    const mouse = parseMouse(input)
    if (mouse !== undefined) {
      if (mouse.kind === 'legacy') {
        legacyDrop.current = LEGACY_BYTES
        return
      }
      if (state.mouse === false) return
      if (mouse.kind === 'wheel') {
        const step = mouse.ctrl ? Math.max(1, viewportHeight - 1) : WHEEL_ROWS
        if (state.pending.length > 0 || (state.panel !== undefined && state.panel !== 'transcript')) {
          scrollPanel(mouse.direction * step)
          return
        }
        const paletteStartY = composerStartY + compRows.length
        if (namingCmd && matchingCommands.length > 0 && mouse.y >= paletteStartY && mouse.y < paletteStartY + cmdPopupRows.length) {
          setCommandIndex((paletteIndex + mouse.direction + matchingCommands.length) % matchingCommands.length)
          return
        }
        if (onComposer(mouse.y)) {
          const view = composerView(editor, width, maxComposerLines)
          const lastOffset = Math.max(0, view.lines - maxComposerLines)
          setComposerScroll(cur => Math.max(0, Math.min(lastOffset, (cur ?? view.offset) + mouse.direction)))
          return
        }
        scrollDocument(mouse.direction * step)
        return
      }
      if (!mouse.primary || mouse.modified) return
      if (mouse.pressed && !mouse.motion) {
        // A chip on the composer's rule keeps its own click.
        if (onComposer(mouse.y) && hitTest(paintedFrame, mouse.x, mouse.y) === undefined) {
          const offset = composerOffsetAt(editor, width, maxComposerLines, composerScroll, mouse.y - composerStartY, mouse.x)
          setEditor(e => ({ text: e.text, cursor: offset, anchor: offset }))
          setDraggingDraft(true)
          return
        }
        const action = hitTest(paintedFrame, mouse.x, mouse.y)
        if (action !== undefined) {
          executeAction(action)
          return
        }
        const pointer = { x: mouse.x, y: mouse.y }
        const inDocument = composerShown && mouse.y >= documentStartY + (hasStickyHeader ? 1 : 0)
          && mouse.y < documentStartY + viewportHeight && docRows.length > 0
        const point = inDocument ? documentPoint(pointer) : pointer
        setSelection({ anchor: point, head: point, pointer, ...(inDocument ? { document: docRows } : {}) })
        return
      }
      if (mouse.motion && mouse.pressed) {
        if (draggingDraft) {
          const offset = composerOffsetAt(editor, width, maxComposerLines, composerScroll, mouse.y - composerStartY, mouse.x)
          setEditor(e => ({ ...e, cursor: offset }))
          return
        }
        // A conversation drag stops above the composer; the footer is never selected.
        setSelection((sel) => {
          if (sel === undefined) return undefined
          if (sel.document !== undefined) return { ...sel, pointer: { x: mouse.x, y: mouse.y } }
          const y = sel.anchor.y < composerStartY ? Math.min(mouse.y, composerStartY - 1) : mouse.y
          return { ...sel, head: { x: mouse.x, y } }
        })
        return
      }
      if (!mouse.pressed) {
        if (draggingDraft) {
          setDraggingDraft(false)
          const range = selectionOf(editor)
          if (range !== undefined) copyDragged(editor.text.slice(range.start, range.end))
          return
        }
        if (effectiveSelection !== undefined && selection?.pointer !== undefined && !isEmptySelection(effectiveSelection)) {
          const copied = selectedText(selection.document ?? paintedFrame, effectiveSelection)
          setSelection({ anchor: effectiveSelection.anchor, head: effectiveSelection.head,
            ...(selection.document === undefined ? {} : { document: selection.document }) })
          if (copied !== '') copyDragged(copied)
          return
        }
        if (selection?.pointer !== undefined) setSelection(undefined)
      }
      return
    }

    // Any key closes the Keys box; Esc does nothing else, every other key is then handled as usual.
    const keysWereOpen = keysOpen
    if (keysOpen) {
      setKeysOpen(false)
      if (key.escape) return
    }
    // An error shown above the composer lasts until the next keystroke.
    if (state.composerError !== undefined) store.update((s) => { s.composerError = undefined })

    // Pending Approval Dialog
    const pending = state.pending[0]
    if (pending?.kind === 'approval') {
      if (key.pageUp) { scrollPanel(-panelFrame.current.page); return }
      if (key.pageDown) { scrollPanel(panelFrame.current.page); return }
      if (key.leftArrow || key.rightArrow || key.tab) { setApprovalAllowed(a => !a); return }
      if (input === 'y' || input === 'Y') { setApprovalAllowed(true); return }
      if (input === 'a' || input === 'A') { executeAction({ kind: 'approval-arguments' }); return }
      if (input === 'n' || input === 'N' || key.escape) {
        if (Date.now() - promptMountedAt.current < 250 && !key.escape) return
        controller.answerApproval(pending.id, 'rejected')
        return
      }
      if (key.return) {
        executeAction({ kind: 'approval-confirm' })
        return
      }
      return
    }

    // Pending Question Dialog
    if (pending?.kind === 'question') {
      const q = pending.questions[qDraft.index]
      const opts = q?.options ?? []
      if (key.pageUp) { scrollPanel(-panelFrame.current.page); return }
      if (key.pageDown) { scrollPanel(panelFrame.current.page); return }
      if (key.escape) { pending.reject(new Error('Question cancelled')); return }
      if (key.tab) { setQDraft(d => ({ ...d, customMode: !d.customMode })); return }
      if (qDraft.customMode) {
        if (key.return && !key.shift && !key.meta) {
          executeAction({ kind: 'question-confirm' })
          return
        }
        setQDraft(d => ({ ...d, custom: edit(d.custom, input, key) }))
        return
      }
      if (key.upArrow && opts.length > 0) {
        setQDraft((d) => {
          const nextIdx = (d.optionIndex - 1 + opts.length) % opts.length
          const label = opts[nextIdx]?.label
          return { ...d, optionIndex: nextIdx, selected: q?.multiSelect || label === undefined ? d.selected : [label] }
        })
        return
      }
      if (key.downArrow && opts.length > 0) {
        setQDraft((d) => {
          const nextIdx = (d.optionIndex + 1) % opts.length
          const label = opts[nextIdx]?.label
          return { ...d, optionIndex: nextIdx, selected: q?.multiSelect || label === undefined ? d.selected : [label] }
        })
        return
      }
      if (input === ' ' && opts[qDraft.optionIndex] !== undefined) {
        executeAction({ kind: 'question-option', index: qDraft.optionIndex })
        return
      }
      // A digit picks the option with that number; a custom answer that starts with one opens with Tab.
      if (/^[1-9]$/u.test(input) && !key.ctrl && !key.meta && opts[Number(input) - 1] !== undefined) {
        executeAction({ kind: 'question-option', index: Number(input) - 1 })
        return
      }
      if (key.return) {
        executeAction({ kind: 'question-confirm' })
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setQDraft(d => ({ ...d, customMode: true, custom: edit(d.custom, input, key) }))
      }
      return
    }

    // Active Picker (/resume, /model, /effort, /theme, /skills)
    if (state.picker !== undefined) {
      if (key.escape) { controller.closePicker(); setPickerSearch(emptyEditor()); return }
      if (key.tab && state.picker.kind === 'sessions') {
        void controller.runCommand(state.picker.all ? '/resume' : '/resume --all').catch(controller.report)
        return
      }
      if (key.upArrow) { setPickerIndex(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setPickerIndex(i => Math.min(Math.max(0, browser.rows.length - 1), i + 1)); return }
      if (key.return) {
        const chosen = browser.rows[Math.min(pickerIndex, Math.max(0, browser.rows.length - 1))]
        if (chosen !== undefined) {
          setPickerSearch(emptyEditor())
          choosePickerRow(chosen)
        }
        return
      }
      setPickerSearch(s => edit(s, input, key))
      setPickerIndex(0)
      return
    }

    // Search Mode (Ctrl+F transcript or Ctrl+R history)
    if (searchMode !== 'none') {
      if (key.escape) { setSearchMode('none'); return }
      if (key.return) {
        if (searchMode === 'history' && historyHits[0] !== undefined) {
          updateDraft(editorAtEnd(historyHits[0]))
          setSearchMode('none')
        } else if (searchMode === 'transcript') {
          const hit = transcriptHits[searchHitIndex]
          if (hit !== undefined) revealRow(hit)
          setSearchEditing(false)
        } else setSearchMode('none')
        return
      }
      if (searchMode === 'transcript' && !searchEditing) {
        if ((input === 'n' || input === 'N') && transcriptHits.length > 0) {
          const nextIdx = input === 'n'
            ? (searchHitIndex + 1) % transcriptHits.length
            : (searchHitIndex - 1 + transcriptHits.length) % transcriptHits.length
          const hit = transcriptHits[nextIdx]
          setSearchHitIndex(nextIdx)
          if (hit !== undefined) revealRow(hit)
        }
        return
      }
      setSearchQuery(s => edit(s, input, key))
      setSearchHitIndex(0)
      return
    }

    // Global Shortcuts
    if (key.ctrl && input === 'c') {
      if (effectiveSelection !== undefined && !isEmptySelection(effectiveSelection)) {
        copyDragged(selectedText(selection?.document ?? paintedFrame, effectiveSelection)); return
      }
      if (state.status === 'running' || state.busy !== undefined) {
        controller.cancel()
        return
      }
      if (editor.text !== '') {
        updateDraft(emptyEditor())
        controller.hint('Draft cleared · press Ctrl+C again to exit.')
        lastCtrlC.current = Date.now()
        return
      }
      if (Date.now() - lastCtrlC.current < 1500) {
        controller.exit(0)
      } else {
        lastCtrlC.current = Date.now()
        controller.hint('Press Ctrl+C again to exit.')
      }
      return
    }
    if (key.ctrl && input === 'd' && editor.text === '') {
      controller.exit(0)
      return
    }
    if (key.ctrl && input === 'o') {
      store.update((s) => { s.panel = s.panel === 'transcript' ? undefined : 'transcript' })
      return
    }
    if (key.ctrl && input === 'f') {
      setSearchMode('transcript')
      setSearchEditing(true)
      setSearchQuery(emptyEditor())
      return
    }
    if (key.ctrl && input === 'r') {
      setSearchMode('history')
      setSearchQuery(emptyEditor())
      return
    }
    if (key.ctrl && input === 'g') {
      void runExternalEditor()
      return
    }
    if (key.meta && (input === 'v' || input === 'V')) {
      if (controller.pasteImage !== undefined) void controller.pasteImage().catch(controller.report)
      return
    }
    if (key.meta && (input === 'g' || input === 'G')) {
      store.update((s) => { s.panel = s.panel === 'goal' ? undefined : 'goal' })
      return
    }
    if (key.ctrl && input === 's') {
      if (stash === undefined) {
        setStash(editor)
        updateDraft(emptyEditor())
        controller.hint('Draft stashed · Ctrl+S to restore.')
      } else {
        const restored = stash
        setStash(editor.text === '' ? undefined : editor)
        updateDraft(restored)
        controller.hint('Stashed draft restored.')
      }
      return
    }
    if (key.ctrl && input === '_') {
      const res = undo(undoState, editor)
      setUndoState(res.history)
      setEditor(res.editor)
      return
    }
    if (key.meta && (input === 'u' || input === 'U')) {
      const res = redo(undoState, editor)
      setUndoState(res.history)
      setEditor(res.editor)
      return
    }

    // Prompt jumping (Alt+Up / Alt+Down)
    if (key.meta && key.upArrow) {
      const target = promptAbove(marks, currentTop)
      if (target !== undefined) setAnchor(promptAnchor(docRows, viewportHeight, target))
      return
    }
    if (key.meta && key.downArrow) {
      const target = promptBelow(marks, currentTop)
      moveViewport(target === undefined ? null : promptAnchor(docRows, viewportHeight, target))
      return
    }

    // Escape handling
    if (key.escape) {
      if (selection !== undefined) { setSelection(undefined); return }
      if (namingCmd) {
        setDismissedCommand(editor.text)
        return
      }
      if (state.panel !== undefined) {
        store.update((s) => { s.panel = undefined })
        return
      }
      if (state.status === 'running' || state.busy !== undefined) {
        controller.cancel()
      }
      return
    }

    // In-page Inspector Panel navigation
    if (state.panel !== undefined && state.panel !== 'transcript') {
      if (key.pageUp || key.upArrow) { scrollPanel(key.pageUp ? -panelFrame.current.page : -1); return }
      if (key.pageDown || key.downArrow) { scrollPanel(key.pageDown ? panelFrame.current.page : 1); return }
      if (key.home) { setPanelOffset(0); return }
      if (key.end) { setPanelOffset(panelFrame.current.maximum); return }
    }

    // Transcript Focus Mode (Ctrl+O)
    if (state.panel === 'transcript') {
      if (key.home && key.ctrl) { setAnchor(anchorAt(docRows, 0)); return }
      if (key.end && key.ctrl) { moveViewport(null); return }
      if (key.pageUp) { scrollDocument(-viewportHeight); return }
      if (key.pageDown) { scrollDocument(viewportHeight); return }
      if (key.shift && key.upArrow) { scrollDocument(-1); return }
      if (key.shift && key.downArrow) { scrollDocument(1); return }
      if (key.upArrow) { setSelectedItemIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setSelectedItemIdx(i => Math.min(Math.max(0, visibleItems.length - 1), i + 1)); return }
      if (input === 'r') { setRawTools(r => !r); return }
      if (key.return || input === ' ') {
        const item = visibleItems[selectedItemIdx]
        if (item !== undefined) {
          setOverrides(prev => ({ ...prev, [item.id]: !(prev[item.id] ?? true) }))
        }
        return
      }
      return
    }

    // Viewport scrolling & instant return to bottom
    if (key.pageUp) { scrollDocument(-Math.max(1, viewportHeight - 1)); return }
    if (key.pageDown) { scrollDocument(Math.max(1, viewportHeight - 1)); return }
    if (key.shift && key.upArrow) { scrollDocument(-1); return }
    if (key.shift && key.downArrow) { scrollDocument(1); return }
    if (key.home && key.ctrl) { setAnchor(anchorAt(docRows, 0)); return }
    if ((key.end && key.ctrl) || (key.end && editor.text === '' && anchor !== null)) {
      moveViewport(null)
      return
    }

    // Slash Command Palette Navigation
    if (namingCmd) {
      // ←→ switch tabs only at the end of the query; elsewhere they move the cursor through it.
      const atEnd = editor.cursor === editor.text.length && selectionOf(editor) === undefined
      if ((key.leftArrow || key.rightArrow) && atEnd && !key.ctrl && !key.meta && !key.shift) {
        const at = PALETTE_TABS.findIndex(value => value.id === paletteTab)
        const next = PALETTE_TABS[(at + (key.rightArrow ? 1 : -1) + PALETTE_TABS.length) % PALETTE_TABS.length]
        if (next !== undefined) { setPaletteTab(next.id); setCommandIndex(0) }
        return
      }
    }
    if (namingCmd && matchingCommands.length > 0) {
      if (key.upArrow) { setCommandIndex((paletteIndex - 1 + matchingCommands.length) % matchingCommands.length); return }
      if (key.downArrow) { setCommandIndex((paletteIndex + 1) % matchingCommands.length); return }
      if (key.tab) {
        const chosen = matchingCommands[paletteIndex]
        if (chosen !== undefined) updateDraft(editorAtEnd(`/${chosen.name}${chosen.hint ? ' ' : ''}`))
        return
      }
      // Enter runs the highlighted command, not the partially typed name.
      if (key.return && !key.shift && !key.meta) {
        const chosen = matchingCommands[paletteIndex]
        if (chosen !== undefined) {
          updateDraft(emptyEditor())
          setPastedBlocks([])
          setDismissedCommand(undefined)
          clearTransient()
          void controller.runCommand(`/${chosen.name}`).catch(controller.report)
        }
        return
      }
    }

    // Submit or Queue
    if (key.tab && !namingCmd) {
      if (state.status === 'running') submitDraft('queue')
      return
    }
    if (key.return && !key.shift && !key.meta) {
      if (editor.text.endsWith('\\')) {
        updateDraft({ text: editor.text.slice(0, -1) + '\n', cursor: editor.cursor })
        return
      }
      submitDraft(key.ctrl ? 'interrupt' : 'enter')
      return
    }

    // Multiline cursor movement & Prompt History recall
    if (key.upArrow && !key.ctrl && !key.meta && !key.shift) {
      const moved = moveLine(editor, -1) ?? moveVisual(editor, -1, Math.max(1, width - 3))
      if (moved !== undefined) { setEditor(moved); return }
      if (history.length > 0) {
        const nextIdx = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(nextIdx)
        setEditor(editorAtEnd(history[nextIdx] ?? ''))
      }
      return
    }
    if (key.downArrow && !key.ctrl && !key.meta && !key.shift) {
      const moved = moveLine(editor, 1) ?? moveVisual(editor, 1, Math.max(1, width - 3))
      if (moved !== undefined) { setEditor(moved); return }
      if (historyIndex !== undefined) {
        const nextIdx = historyIndex + 1
        if (nextIdx >= history.length) {
          setHistoryIndex(undefined)
          setEditor(emptyEditor())
        } else {
          setHistoryIndex(nextIdx)
          setEditor(editorAtEnd(history[nextIdx] ?? ''))
        }
      }
      return
    }

    // Whole-placeholder deletion on Backspace/Delete
    if (key.backspace || key.delete) {
      const hit = placeholderAt(editor.text, editor.cursor, key.backspace ? 'before' : 'after')
      if (hit !== undefined) {
        updateDraft({
          text: editor.text.slice(0, hit.start) + editor.text.slice(hit.end),
          cursor: hit.start,
        })
        return
      }
    }

    // `?` on an empty prompt shows the Keys box; pressed again while it shows, it is typed.
    if (input === '?' && editor.text === '' && composerShown && !keysWereOpen && !key.ctrl && !key.meta) {
      setKeysOpen(true)
      return
    }

    const nextEditor = edit(editor, input, key)
    if (nextEditor.text !== editor.text || nextEditor.cursor !== editor.cursor || nextEditor.anchor !== editor.anchor) {
      setDismissedCommand(undefined)
      setCommandIndex(0)
      updateDraft(nextEditor)
    }
  })

  const physicalWidth = Math.max(1, size.columns - 1), physicalHeight = Math.max(1, size.rows)
  const screen = size.columns < 29 || size.rows < 12
    ? fitScreen([row(span('Enlarge terminal', 'muted')), row(span('Minimum 29 × 12', 'muted'))], physicalWidth, physicalHeight)
    : paintSelection(paintedFrame, selection?.document === undefined ? selection : undefined)
  return <Screen rows={ screen } width={ physicalWidth } theme={ state.theme ?? 'dark' } />
}

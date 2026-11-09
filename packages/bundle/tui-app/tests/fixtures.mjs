/** Deterministic presentation fixtures, not recorded provider traffic. */
import { emptyTranscript } from '../src/transcript.ts'
export function fixture(overrides = {}) {
  return { transcript: emptyTranscript(), status: 'idle', pending: [], selection: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
    sessionId: 'session-5a4a51d6-demo', cwd: '/workspace/harness', title: 'Authentication & tests', preset: 'standard', theme: 'dark', panel: undefined,
    approvalPolicy: 'ask', goalActivation: 'armed', expandedTools: false, hint: undefined, exiting: false, busy: undefined, picker: undefined,
    queue: [], jobs: [], projections: { contextPressure: { projectedTokens: 19680, contextWindow: 131072 }, tokenUsage: { uncachedInputTokens: 12500, cacheReadTokens: 48000, cacheWriteTokens: 0, outputTokens: 2650 }, sessionStats: { steps: 6, turns: 2, decodeTokens: 2400, decodeMs: 38000, ttftMs: 2850, ttftSteps: 6 } },
    attachments: [], viewEpoch: 0, hiddenBefore: 0, recoveredInput: undefined, ...overrides }
}
export function tool(overrides = {}) {
  return { kind: 'tool', id: 'tool-1', name: 'bash', args: { command: 'pnpm test --filter auth', cwd: '/workspace/harness' }, call: { card: 'terminal', title: 'pnpm test --filter auth', description: 'Run authentication tests' },
    result: { card: 'terminal', output: 'RUN auth.test.ts\n✓ expired token\n✓ valid session\n\n2 tests passed', exitCode: 0 },
    resultText: '2 tests passed', isError: false, settled: true, startedAt: 1000, completedAt: 2840, ...overrides }
}
export const diffTool = () => tool({ id: 'tool-diff', name: 'edit', args: { path: 'src/auth.ts' }, call: { card: 'generic', title: 'Edit src/auth.ts', kind: 'edit' }, result: { card: 'diff', diffs: [{ path: 'src/auth.ts', oldText: 'export function valid(token: Token) {\n  return token !== null\n}\n', newText: 'export function valid(token: Token) {\n  if (!token) return false\n  return token.expiresAt > Date.now()\n}\n' }] } })
export function conversation() {
  return [ { kind: 'user', id: 'user-1', text: 'Check authentication, fix expired tokens, and run the tests.', settled: true, queued: false },
    { kind: 'assistant', id: 'assistant-1', reasoning: 'I will inspect the token validation path, preserve the session contract, and verify the change with focused tests.', text: '', settled: true },
    tool({ id: 'tool-read', name: 'read', args: { path: 'src/auth.ts' }, call: { card: 'generic', kind: 'read', title: 'Read src/auth.ts' }, result: { card: 'read', path: 'src/auth.ts', offset: 40, totalLines: 100, lines: [{ number: 41, text: 'export function valid(token: Token) {' }, { number: 42, text: '  return token !== null' }, { number: 43, text: '}' }] } }),
    diffTool(), tool(), { kind: 'assistant', id: 'assistant-2', reasoning: '', text: '## Authentication fixed\n\nExpired tokens are rejected without changing session persistence.\n\n- Updated `src/auth.ts`.\n- Both focused tests pass.\n\n```ts\nreturn token.expiresAt > Date.now()\n```', settled: true } ]
}
export const approval = (id = 'approval-1') => ({ kind: 'approval', id, toolName: 'bash', owner: 'session-demo', cwd: '/workspace/harness', reason: 'Run the project test suite using its configured scripts.', detail: '{\n  "command": "pnpm test --filter auth",\n  "cwd": "/workspace/harness"\n}', resolve() {} })
export const question = (id = 'question-1') => ({ kind: 'question', id, questions: [{ id: 'plan-review', header: 'Review implementation plan', question: 'Approve this plan or continue planning?', detail: '# Plan\n\n1. Inspect validation.\n2. Add expiry checks.\n3. Run the tests.', options: [{ label: 'Approve', description: 'Proceed with the proposed implementation.' }, { label: 'Keep planning', description: 'Continue exploring before making changes.' }], multiSelect: false }], resolve() {}, reject() {} })

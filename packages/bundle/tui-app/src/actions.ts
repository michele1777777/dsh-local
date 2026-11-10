/** Local hit targets. No action in a display row is executable model output. */
export type UiAction =
  | { kind: 'copy-code'; itemId: string; block: number }
  | { kind: 'copy-text'; text: string; label: string }
  | { kind: 'inspect-item'; itemId: string }
  | { kind: 'toggle-reasoning'; itemId: string }
  | { kind: 'picker-select'; id: string }
  | { kind: 'picker-confirm'; id: string }
  | { kind: 'command-complete'; name: string }
  | { kind: 'approval-select'; allowed: boolean }
  | { kind: 'approval-confirm' }
  /** Opens or folds the complete arguments of the approval being asked. */
  | { kind: 'approval-arguments' }
  | { kind: 'question-option'; index: number }
  | { kind: 'question-confirm' }
  | { kind: 'detach'; index: number; name: string }
  | { kind: 'close-details' }
  | { kind: 'live-tail' }
  | { kind: 'jump-prompt'; itemId: string }
  | { kind: 'open-jobs' }
  | { kind: 'inspect-job'; jobId: import('@deepseek-ai/dsh-api-job-controller').JobView['id'] }
  | { kind: 'open-goal' }
  | { kind: 'open-tasks' }
  | { kind: 'open-permissions' }
  | { kind: 'goal-edit' }
  | { kind: 'goal-command'; command: string }
  | { kind: 'palette-tab'; tab: import('./commands.ts').PaletteTab }
  | { kind: 'toggle-keys' }
  /** Removes the user-queued message at this position of the composer's queue rows, as `/queue remove N` does. */
  | { kind: 'queue-remove'; index: number }

/**
 * Identity of an action for hit-target deduplication and React keys.
 * @param action - the action to key.
 * @returns a string equal for actions with the same kind and payload fields that distinguish them.
 */
export function actionKey(action: UiAction): string {
  if (action.kind === 'inspect-job') return `${action.kind}:${action.jobId}`
  return action.kind === 'copy-code' ? `${action.kind}:${action.itemId}:${action.block}`
    : action.kind === 'copy-text' ? `${action.kind}:${action.label}:${action.text}`
      : action.kind === 'toggle-reasoning' ? `${action.kind}:${action.itemId}`
        : action.kind === 'inspect-item' ? `${action.kind}:${action.itemId}`
          : action.kind === 'goal-command' ? `${action.kind}:${action.command}`
            : action.kind === 'palette-tab' ? `${action.kind}:${action.tab}`
              : action.kind === 'queue-remove' ? `${action.kind}:${action.index}` : action.kind
}

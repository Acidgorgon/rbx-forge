// Split editor actions shared by the tab strip, the drag layer, the command palette and shortcuts.
// The layout logic itself is pure (@shared/editorGroups); this decides copy vs move per tab kind:
// a file can show in two groups (one buffer, separate views), a page (labs, settings, release…)
// lives in one group at a time, so it moves.
import * as EG from '@shared/editorGroups'
import type { Edge } from '@shared/editorGroups'
import type { Actions, State, Tab } from '../store'

export const canDuplicate = (tab: Tab | undefined): boolean => tab?.kind === 'file'

const tabOf = (state: State, id: string) => state.tabs.find((t) => t.id === id)

// Opens `tabId` (shown in `from`) in a new group on `edge` of `target` (default: `from`).
export function splitTab(state: State, actions: Actions, tabId: string, from: string, edge: Edge, opts: { target?: string; copy?: boolean } = {}): void {
  const tab = tabOf(state, tabId)
  if (!tab) return
  const copy = (opts.copy ?? true) && canDuplicate(tab)
  if (!EG.canSplit(state.editor, { from, tabId, copy })) {
    actions.toast({ text: `Up to ${EG.MAX_GROUPS} editor groups`, detail: 'Close a group, or drag the tab into one of them.' })
    return
  }
  if (copy && tab.preview) actions.pinTab(tabId)
  actions.editorGroups((gs) => EG.splitGroup(gs, opts.target ?? from, edge, tabId, { from, copy }))
  focusGroupSoon()
}

// "Move to other group": the next group in reading order, or a new one on the right.
export function moveToOtherGroup(state: State, actions: Actions, tabId: string, from: string): void {
  const other = EG.otherGroup(state.editor, from)
  if (other) actions.editorGroups((gs) => EG.moveTab(gs, tabId, from, other))
  else splitTab(state, actions, tabId, from, 'right', { copy: false })
  focusGroupSoon()
}

export type DropTarget = { kind: 'strip'; group: string; index: number } | { kind: 'zone'; group: string; zone: EG.DropZone }

// A tab dragged out of `from` and dropped on `target`. `copy` (Alt / Ctrl held) keeps a file in its
// group as well; pages always move.
export function dropTab(state: State, actions: Actions, tabId: string, from: string, target: DropTarget, copyKey: boolean): void {
  const tab = tabOf(state, tabId)
  if (!tab) return
  const copy = copyKey && canDuplicate(tab) && target.group !== from
  if (copy && tab.preview) actions.pinTab(tabId)
  if (target.kind === 'strip') {
    actions.editorGroups((gs) => (copy ? EG.copyTab(gs, tabId, target.group, target.index) : EG.moveTab(gs, tabId, from, target.group, target.index)))
  } else if (target.zone === 'center') {
    if (target.group === from) return
    actions.editorGroups((gs) => (copy ? EG.copyTab(gs, tabId, target.group) : EG.moveTab(gs, tabId, from, target.group)))
  } else {
    splitTab(state, actions, tabId, from, target.zone, { target: target.group, copy: copyKey })
    return
  }
  focusGroupSoon()
}

// Ctrl+1..4: focus the nth group (reading order) and put the keyboard in its editor.
export function focusGroupAt(actions: Actions, index: number): void {
  actions.editorGroups((gs) => EG.focusGroupAt(gs, index))
  focusGroupSoon()
}

// After a group change, move keyboard focus into the active group's editor (when it shows a file).
export function focusGroupSoon(): void {
  setTimeout(() => {
    const el = document.querySelector('.eg-group.active .view:not([style*="none"]) .monaco-editor textarea') as HTMLTextAreaElement | null
    el?.focus()
  }, 30)
}

// Opens a QolTarget (notification click, digest line) in the workbench.
import type { QolTarget } from '@shared/types'
import type { Actions, PageKind } from '../store'
import { setLabValue } from './sessionStore'

// Page kinds this build can open.
export const KNOWN_PAGES: ReadonlySet<string> = new Set<PageKind>(['forge', 'settings', 'packages', 'release', 'analytics', 'memory', 'groups', 'uipreview', 'uimotion', 'model', 'vanguards'])

export function navigate(target: QolTarget, actions: Actions): void {
  switch (target.kind) {
    case 'page':
      if (!KNOWN_PAGES.has(target.page)) return
      if (target.entryId) {
        setLabValue(`${target.page}.selected`, target.entryId)
      }
      actions.openPage(target.page as PageKind)
      return
    case 'file':
      if (target.line) void actions.openFileAt(target.path, target.line)
      else void actions.openFile(target.path)
      return
    case 'side':
      actions.setLayout({ sideOpen: true, sideView: target.view, sideAuto: false })
      return
    case 'conflict':
      actions.openConflict(target.path)
      return
    case 'chat':
      actions.toggleRight(true)
      void actions.selectChat(target.sessionId)
      return
    case 'bottom':
      actions.setLayout({ bottomOpen: true, bottomTab: target.tab })
      return
  }
}

// Opens a QolTarget (notification click, digest line) in the workbench.
import type { QolTarget } from '@shared/types'
import type { Actions, PageKind } from '../store'
import { setLabValue } from './sessionStore'

// Page kinds this build can open. Lab pages from other branches (thumbnails, UI motion) are added here
// when they land; until then their notifications only focus the window.
export const KNOWN_PAGES: ReadonlySet<string> = new Set<PageKind>(['forge', 'settings', 'packages', 'release', 'analytics', 'memory', 'groups', 'art', 'uipreview', 'vfx', 'anim', 'ability', 'thumbs'])

// Lab pages whose library selection lives under "<page>.selected" (and the library tab under "<page>.view").
const LIBRARY_VIEW: Record<string, string> = { vfx: 'effects', anim: 'library', ability: 'moves' }

export function navigate(target: QolTarget, actions: Actions): void {
  switch (target.kind) {
    case 'page':
      if (!KNOWN_PAGES.has(target.page)) return
      if (target.entryId) {
        setLabValue(`${target.page}.selected`, target.entryId)
        if (LIBRARY_VIEW[target.page]) setLabValue(`${target.page}.view`, LIBRARY_VIEW[target.page])
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
      actions.showBottom(target.tab)
      return
  }
}

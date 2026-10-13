// Shared "copy path" actions for Explorer and Scripts rows.
import { robloxPaths } from '@shared/robloxPath'
import type { Actions } from '../store'
import type { MenuEntry } from './Menu'
import { IconCode, IconCopy, IconFile, IconQuote } from './Icons'

export interface PathTarget {
  name: string
  className: string
  // From the service down, e.g. ["ReplicatedStorage", "Assets", "Sword"].
  instancePath: string[]
  filePath?: string
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const mod = isMac ? '⌘' : 'Ctrl+'

export function copyPaths(actions: Actions, targets: PathTarget[]): void {
  if (targets.length === 0) return
  const dots = targets.map((t) => robloxPaths(t.instancePath).dot)
  void actions.copy(dots.join('\n'), targets.length === 1 ? dots[0] : `${targets.length} paths`)
}

export function pathMenu(actions: Actions, target: PathTarget, selection: PathTarget[]): MenuEntry[] {
  const p = robloxPaths(target.instancePath)
  const items: MenuEntry[] = [{ header: p.dot }]
  if (selection.length > 1) {
    items.push({
      label: `Copy ${selection.length} paths`,
      icon: <IconCopy size={14} />,
      hint: `${mod}⇧C`,
      onSelect: () => copyPaths(actions, selection)
    })
  }
  items.push(
    {
      label: 'Copy Roblox path',
      icon: <IconCopy size={14} />,
      hint: selection.length > 1 ? undefined : `${mod}⇧C`,
      onSelect: () => void actions.copy(p.dot)
    },
    {
      label: 'Copy as GetService',
      icon: <IconCode size={14} />,
      onSelect: () => void actions.copy(p.service)
    }
  )
  if (target.filePath) {
    const fp = target.filePath
    items.push({ label: 'Copy file path', icon: <IconFile size={14} />, onSelect: () => void actions.copy(fp) })
  }
  items.push('separator', {
    label: 'Insert path into chat',
    icon: <IconQuote size={14} />,
    onSelect: () => actions.insertIntoComposer('`' + p.dot + '`')
  })
  if (target.filePath) {
    const fp = target.filePath
    items.push({ label: 'Open script', icon: <IconFile size={14} />, onSelect: () => void actions.openFile(fp) })
  }
  return items
}

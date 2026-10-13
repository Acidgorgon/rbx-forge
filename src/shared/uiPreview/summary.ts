// Text outline of a rendered story for agents (preview_ui): each visible GuiObject with its
// relative path, class, text and pixel rect. Pure.

import { layoutTree, isGuiObject, TEXT_CLASSES, type MeasureText } from './layout.ts'
import { bool, str, PreviewTree, type UiTreeSnapshot } from './protocol.ts'

export function outline(snapshot: UiTreeSnapshot, viewport: { w: number; h: number }, options: { measure?: MeasureText; maxLines?: number } = {}): string[] {
  const tree = PreviewTree.from(snapshot)
  const { boxes, root } = layoutTree(tree, { viewport, ...(options.measure ? { measure: options.measure } : {}) })
  const lines: string[] = []
  const max = options.maxLines ?? 120
  let hidden = 0
  let skipped = 0
  const visit = (id: number, depth: number) => {
    const node = tree.get(id)
    const box = boxes.get(id)
    if (!node || !box) return
    const isTarget = node.name === 'StoryTarget' && node.parent === tree.root
    if (isGuiObject(node.cls) && !isTarget) {
      if (!bool(node.props.Visible, true)) {
        hidden++
        return
      }
      if (lines.length < max) {
        const text = TEXT_CLASSES.has(node.cls) ? ` "${str(node.props.Text).replace(/\s+/g, ' ').slice(0, 40)}"` : ''
        lines.push(`${'  '.repeat(depth)}${node.name} ${node.cls}${text} @${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`)
      } else skipped++
    }
    for (const c of box.draw) visit(c, isGuiObject(node.cls) && !isTarget ? depth + 1 : depth)
  }
  if (root != null) for (const c of boxes.get(root)?.draw ?? []) visit(c, 0)
  if (skipped) lines.push(`… ${skipped} more elements`)
  if (hidden) lines.push(`(${hidden} hidden: Visible = false)`)
  return lines
}

// Delete flows the Explorer shares between the Game, Files and Features views: Delete in Studio (a
// Studio-only instance, through the Forge Bridge; Ctrl+Z in Studio restores it) and Delete Feature (all
// of a feature's parts to the Recycle Bin / Trash). Each asks first unless "Don't ask again" was
// ticked, and always when open tabs under it have unsaved changes.
import type { Actions, State } from '../store'
import { errorText } from '../lib/format'
import { featureDeleteTargets, findNode, type FeatureInfo } from '../lib/roblox'
import { shouldConfirmDelete } from '../lib/deleteConfirm'
import { isUnder } from '@shared/fileOps'
import type { TreeNode } from '@shared/types'

export const trashName = (): string => (navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash')

function descendants(node: TreeNode | null): number {
  if (!node) return 0
  return node.children.reduce((n, c) => n + 1 + descendants(c), 0)
}

export async function deleteInStudio(state: State, actions: Actions, instancePath: string[], className: string): Promise<void> {
  const dotted = instancePath.join('.')
  const name = instancePath[instancePath.length - 1]
  const check = await window.harness.syncDeleteCheck(instancePath).catch((e) => ({ reason: errorText(e) }))
  if ('reason' in check) {
    actions.toast({ text: `Cannot delete ${name} in Studio`, detail: check.reason, kind: 'err' })
    return
  }
  const run = () =>
    void window.harness
      .syncDeleteInStudio(instancePath, className)
      .then(() => actions.toast({ text: `Deleted ${name} in Studio`, detail: 'Ctrl+Z in Studio brings it back', kind: 'ok', ms: 4000 }))
      .catch((e) => actions.toast({ text: `Could not delete ${name} in Studio`, detail: errorText(e), kind: 'err' }))
  if (!shouldConfirmDelete(state.appSettings?.confirmStudioDelete, 0)) return run()
  const n = descendants(findNode(state.tree, instancePath))
  actions.openDialog({
    kind: 'confirm',
    title: `Delete ${name} in Studio?`,
    body: `Deletes ${dotted} (${className}${n ? `, and the ${n} instance${n === 1 ? '' : 's'} inside it` : ''}) from the place open in Studio. It is not in the repo, so Forge keeps no copy; Ctrl+Z in Studio brings it back.`,
    confirm: 'Delete in Studio',
    danger: true,
    dontAsk: 'confirmStudioDelete',
    run
  })
}

export function deleteFeature(state: State, actions: Actions, feature: FeatureInfo): void {
  const targets = featureDeleteTargets(feature)
  if (!targets.length) return
  const bin = trashName()
  const unsaved = state.files.filter((f) => f.current !== f.saved && targets.some((t) => (t.isDir ? isUnder(f.path, t.path) : f.path === t.path))).length
  const run = async () => {
    const failed: string[] = []
    // One at a time, in order (Controller, Service, shared last; see featureDeleteTargets).
    for (const t of targets) {
      try {
        await actions.trashPath(t.path, t.isDir)
      } catch (e) {
        failed.push(`${t.path}: ${errorText(e)}`)
      }
    }
    if (failed.length) actions.toast({ text: `Could not delete all of ${feature.name}`, detail: failed.join('\n'), kind: 'err' })
    else actions.toast({ text: `Deleted feature ${feature.name}`, detail: `${targets.length} item${targets.length === 1 ? '' : 's'} moved to the ${bin}`, kind: 'ok', ms: 3500 })
  }
  if (!shouldConfirmDelete(state.appSettings?.confirmFileDelete, unsaved)) return void run()
  actions.openDialog({
    kind: 'confirm',
    title: `Delete feature ${feature.name}?`,
    body: `Moves ${targets.length === 3 ? 'all three parts' : targets.length === 1 ? 'its only part' : `its ${targets.length} parts`} to the ${bin}; you can restore them from there.${unsaved ? ` ${unsaved === 1 ? 'An open file has' : `${unsaved} open files have`} unsaved changes that will be lost.` : ''}`,
    list: targets.map((t) => (t.isDir ? `${t.path}/` : t.path)),
    confirm: `Move to ${bin}`,
    danger: true,
    dontAsk: 'confirmFileDelete',
    run: () => void run()
  })
}

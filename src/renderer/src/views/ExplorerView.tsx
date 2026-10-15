// Explorer (SPEC §7.3, §8.1, §8.2): the Roblox game tree, the repo files and the feature trios,
// with the context menu, inline create flow from GenTree templates, reveal and keyboard navigation.
// The Game and Files views multi-select (Ctrl/Cmd-click, Shift-click, Ctrl/Cmd+A, Shift+Arrow; the
// model is shared/explorerSelection.ts): delete, open and copy act on the whole selection.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent } from 'react'
import type { ScriptEntry, TreeNode } from '@shared/types'
import { robloxPaths } from '@shared/robloxPath'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ClassIcon, FileGlyph } from '../components/ClassIcon'
import { useMenu, type MenuEntry } from '../components/Menu'
import { basename, featuresOf, initSuffix, realmOfFile, realmOfInstance, requireExpression, roots, scriptsFlat, findNode, instancePathOfFile } from '../lib/roblox'
import { createHint, createItem, defaultTarget, dirForInstance, instanceForDir, realmOfDir, storyCovered, type NewKind } from '../lib/templates'
import { validateName } from '../shell/Overlays'
import { errorText, isMac, keyHint } from '../lib/format'
import { entryTarget, isUnder, protectedReason } from '@shared/fileOps'
import { clearKeys, clickSelect, EMPTY_SELECTION, moveFocus, planDelete, pruneSelection, selectAll, single, uniqueKey, unselectedInside, type DeleteCandidate, type DeletePlan, type Selection } from '@shared/explorerSelection'
import { sparks } from '../lib/sparks'
import { shouldConfirmDelete } from '../lib/deleteConfirm'
import { deleteFeature, deleteInStudio, deleteManyFromDisk, deleteManyInStudio, studioDeletable, trashName } from './deleteFlows'
import { useForgeSync } from './ForgeSyncSection'

type Mode = 'tree' | 'files' | 'features'

const SCRIPT_CLASSES = new Set(['ModuleScript', 'Script', 'LocalScript'])

interface Row {
  key: string
  name: string
  className: string
  depth: number
  instancePath?: string[]
  filePath?: string
  dir?: string
  hasChildren: boolean
  studio: boolean
  studioTop: boolean
  wally: boolean
  blinkOut: boolean
  suffix?: string | null
  meta?: string
  // Shown only because something under it matches the filter (Game view): left out of Ctrl/Cmd+A and
  // Shift ranges.
  context?: boolean
}

// Why a selected project-file mount point is left out of a batch delete.
const MOUNT_REASON = 'mapped in the project file'

const DEFAULT_OPEN = ['ReplicatedStorage', 'ReplicatedStorage/Shared', 'ReplicatedStorage/Shared/Features', 'ServerScriptService', 'ServerScriptService/Server', 'StarterPlayer', 'StarterPlayer/StarterPlayerScripts', 'src', 'src/shared', 'src/server', 'src/client']
const OPEN_KEY = 'forge.explorer.open'
const MODE_KEY = 'forge.explorer.mode'

function loadOpen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null') as string[] | null
    return new Set(raw ?? DEFAULT_OPEN)
  } catch {
    return new Set(DEFAULT_OPEN)
  }
}

function matches(node: TreeNode, q: string): boolean {
  return node.name.toLowerCase().includes(q) || node.children.some((c) => matches(c, q))
}

// A DOM id for a row key (rows are role="treeitem" and the tree points aria-activedescendant at the
// focus row). Keys hold any character, so hash them (FNV-1a); clashes get the row index appended.
function rowIds(keys: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>()
  const used = new Set<string>()
  keys.forEach((key, i) => {
    let h = 0x811c9dc5
    for (let j = 0; j < key.length; j++) h = Math.imul(h ^ key.charCodeAt(j), 0x01000193)
    let id = `ex-${(h >>> 0).toString(36)}`
    if (used.has(id)) id += `-${i}`
    used.add(id)
    ids.set(key, id)
  })
  return ids
}

function Name({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q)
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

// Files mode: a directory tree built from the scripts and Blink files the project knows.
interface FileNode {
  name: string
  path: string
  children: Map<string, FileNode>
  file: boolean
}

function fileTree(paths: string[]): FileNode {
  const root: FileNode = { name: '', path: '', children: new Map(), file: false }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.get(part)
      if (!child) node.children.set(part, (child = { name: part, path, children: new Map(), file: i === parts.length - 1 }))
      node = child
    })
  }
  return root
}

interface Creating {
  kind: NewKind
  parentKey: string
  instancePath: string[]
  dir: string | null
  depth: number
  name: string
}

export function ExplorerView() {
  const { state, actions } = useStore()
  const menu = useMenu()
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) as Mode) || 'tree')
  const setMode = (m: Mode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // ignore
    }
  }
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Set<string>>(loadOpen)
  // Multi-select: `sel.keys` are what commands act on; `sel.focus` is the keyboard cursor (outlined
  // when it is not the one selected row).
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const selected = sel.focus
  const setSelected = (key: string | null) => setSel(single(key))
  const [menuTarget, setMenuTarget] = useState<string | null>(null)
  const [creating, setCreating] = useState<Creating | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const q = filter.trim().toLowerCase()
  const scripts = useMemo(() => scriptsFlat(state.scripts), [state.scripts])
  const blinkOutputs = useMemo(() => {
    const models = state.blink?.files ?? (state.blink ? [state.blink] : [])
    return new Set(models.flatMap((m) => [m.outputs?.client, m.outputs?.server, m.outputs?.types].filter((x): x is string => !!x)))
  }, [state.blink])

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]))
    } catch {
      // ignore
    }
  }, [open])

  const toggle = (key: string, force?: boolean) =>
    setOpen((s) => {
      const n = new Set(s)
      const want = force ?? !n.has(key)
      if (want) n.add(key)
      else n.delete(key)
      return n
    })

  // ---- rows
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    if (mode === 'tree') {
      // Keys are the instance path joined with "/", made unique among same-named siblings (#2...).
      const used = new Set<string>()
      const walk = (nodes: TreeNode[], depth: number, parent: string[], parentKey: string | null, parentStudio: boolean, parentWally: boolean) => {
        for (const node of nodes) {
          if (q && !matches(node, q)) continue
          const instancePath = [...parent, node.name]
          const key = uniqueKey(used, parentKey === null ? node.name : `${parentKey}/${node.name}`)
          const studio = node.origin === 'studio'
          const wally = parentWally || ((node.name === 'Packages' || node.name === 'ServerPackages' || node.name === 'DevPackages') && depth <= 1)
          out.push({
            key,
            name: node.name,
            className: node.className,
            depth,
            instancePath,
            filePath: node.filePath,
            hasChildren: node.children.length > 0,
            studio,
            studioTop: studio && !parentStudio,
            wally: wally && !parentWally,
            blinkOut: !!node.filePath && blinkOutputs.has(node.filePath),
            suffix: initSuffix(node.filePath),
            context: !!q && !node.name.toLowerCase().includes(q)
          })
          if (node.children.length && (q || open.has(key))) walk(node.children, depth + 1, instancePath, key, studio, wally)
        }
      }
      walk(roots(state.tree), 0, [], null, false, false)
    } else if (mode === 'files') {
      const paths = [...scripts.map((s) => s.path), ...(state.blink?.files?.map((m) => m.file) ?? [state.blink?.file]).filter((x): x is string => !!x)]
      const tree = fileTree([...new Set(paths)])
      const walk = (node: FileNode, depth: number) => {
        const kids = [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name))
        for (const c of kids) {
          if (q && !c.path.toLowerCase().includes(q)) continue
          out.push({ key: `f:${c.path}`, name: c.name, className: c.file ? 'File' : 'Folder', depth, filePath: c.file ? c.path : undefined, dir: c.file ? undefined : c.path, hasChildren: !c.file, studio: false, studioTop: false, wally: false, blinkOut: blinkOutputs.has(c.path) })
          if (!c.file && (q || open.has(c.path))) walk(c, depth + 1)
        }
      }
      walk(tree, 0)
    }
    return out
  }, [mode, state.tree, scripts, open, q, blinkOutputs, state.blink])

  const features = useMemo(() => featuresOf(scripts).filter((f) => !q || f.name.toLowerCase().includes(q)), [scripts, q])

  // ---- selection
  const visibleKeys = useMemo(() => rows.map((r) => r.key), [rows])
  const contextKeys = useMemo(() => new Set(rows.filter((r) => r.context).map((r) => r.key)), [rows])
  const ids = useMemo(() => rowIds(visibleKeys), [visibleKeys])
  const selSet = useMemo(() => new Set(sel.keys), [sel.keys])
  const selectedRows = useMemo(() => rows.filter((r) => selSet.has(r.key)), [rows, selSet])
  const focusRow = sel.focus === null ? undefined : rows.find((r) => r.key === sel.focus)
  // The one selected row (what F2, Enter, Space and the single-row copies act on), or none.
  const one = selectedRows.length === 1 ? selectedRows[0] : undefined
  // A filter, collapse, delete or mode switch keeps only the selected rows still visible.
  useEffect(() => setSel((s) => pruneSelection(s, visibleKeys)), [visibleKeys])
  // Another project: its rows can share keys with this one's (same template), so start over.
  const projectRoot = state.project?.root ?? null
  const lastRoot = useRef(projectRoot)
  useEffect(() => {
    if (lastRoot.current === projectRoot) return
    lastRoot.current = projectRoot
    setSel(EMPTY_SELECTION)
  }, [projectRoot])
  // Every file the Explorer knows of: a batch delete names the ones inside a folder that were not selected.
  const knownFiles = useMemo(() => {
    const out = new Set<string>(scripts.map((s) => s.path))
    for (const m of state.blink?.files ?? (state.blink ? [state.blink] : [])) if (m.file) out.add(m.file)
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => (n.filePath && out.add(n.filePath), walk(n.children)))
    walk(state.tree)
    return [...out]
  }, [scripts, state.blink, state.tree])

  // ---- reveal
  useEffect(() => {
    const r = state.explorerReveal
    if (!r) return
    setMode('tree')
    setFilter('')
    setOpen((s) => {
      const n = new Set(s)
      for (let i = 1; i < r.instancePath.length; i++) n.add(r.instancePath.slice(0, i).join('/'))
      return n
    })
    const key = r.instancePath.join('/')
    setSelected(key)
    setFlashKey(key)
    setTimeout(() => listRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' }), 60)
  }, [state.explorerReveal])

  // ---- create
  const beginCreate = (kind: NewKind, targetPath?: string[] | null) => {
    let ip = targetPath ?? (mode === 'tree' ? (one ?? focusRow)?.instancePath ?? null : null)
    if (kind === 'Feature') ip = ['ReplicatedStorage', 'Shared', 'Features']
    // A script file can't hold new children unless it is an init folder; use its parent.
    if (ip && kind !== 'Feature') {
      const node = findNode(state.tree, ip)
      if (node?.filePath && !initSuffix(node.filePath)) ip = ip.slice(0, -1)
    }
    if (!ip || !findNode(state.tree, ip)) ip = defaultTarget(state.tree, kind)
    if (!ip) {
      actions.toast({ text: 'No place to create this', detail: 'Open a Rojo project first', kind: 'err' })
      return
    }
    setMode('tree')
    setFilter('')
    const key = ip.join('/')
    setOpen((s) => {
      const n = new Set(s)
      for (let i = 1; i <= ip!.length; i++) n.add(ip!.slice(0, i).join('/'))
      return n
    })
    const name = kind === 'Feature' ? 'NewFeature' : kind === 'Folder' ? 'NewFolder' : kind === 'ModuleScript' ? 'NewModule' : kind === 'Script' ? 'NewScript' : kind === 'Story' ? 'NewStory' : kind === 'Storybook' ? 'Stories' : 'NewLocalScript'
    setCreating({ kind, parentKey: key, instancePath: ip, dir: dirForInstance(state.tree, ip), depth: ip.length, name })
  }

  useEffect(() => {
    const r = state.createRequest
    if (!r || r.kind === 'Blink') return
    beginCreate(r.kind as NewKind)
  }, [state.createRequest])

  // Story modules are named "<Name>.story" / "<Name>.storybook" in the tree.
  const siblingNames = (c: Creating) => {
    const names = (findNode(state.tree, c.instancePath)?.children ?? []).map((n) => n.name)
    if (c.kind !== 'Story' && c.kind !== 'Storybook') return names
    const suffix = c.kind === 'Story' ? '.story' : '.storybook'
    return names.filter((n) => n.endsWith(suffix)).map((n) => n.slice(0, -suffix.length))
  }

  const commitCreate = async (c: Creating, el?: HTMLElement | null) => {
    const taken = c.kind === 'Feature' ? featuresOf(scripts).map((f) => f.name) : siblingNames(c)
    const problem = validateName(c.name, taken)
    if (problem) return
    setCreating(null)
    try {
      const r = await createItem(c.kind, c.dir, c.name)
      sparks(el)
      if (r.open) {
        await actions.openFileAt(r.open, r.line, 2)
      }
      const isFeature = c.kind === 'Feature' || (c.kind === 'Folder' && !!c.dir && /src\/shared\/Features$/.test(c.dir))
      if (isFeature) {
        actions.toast({ text: `Feature "${c.name}" forged`, detail: `+ ${c.name}Service · + ${c.name}Controller · ${r.written.length} files`, kind: 'hot' })
        setFlashKey(['ReplicatedStorage', 'Shared', 'Features', c.name].join('/'))
      } else if (c.kind === 'Story') {
        const list = await window.harness.uiPreviewStories().catch(() => null)
        const covered = list ? storyCovered(list, r.written[0]) : null
        actions.toast({
          text: `Story ${c.name} created`,
          detail: covered === false ? `${r.written[0]} · no storybook covers this folder; add New > Storybook here or above to group it in UI Preview` : r.written[0],
          kind: covered === false ? 'info' : 'ok',
          ms: covered === false ? 6000 : 3500
        })
        setFlashKey([...c.instancePath, `${c.name}.story`].join('/'))
      } else {
        actions.toast({ text: `${c.kind} ${c.name} created`, detail: r.written[0], kind: 'ok', ms: 3500 })
        setFlashKey([...c.instancePath, c.kind === 'Storybook' ? `${c.name}.storybook` : c.name].join('/'))
      }
    } catch (e) {
      actions.toast({ text: `Could not create ${c.name}`, detail: errorText(e), kind: 'err' })
    }
  }

  // ---- context menu
  const newSubmenu = (ip: string[] | null, dir: string | null): MenuEntry[] => {
    const realm = dir ? realmOfDir(dir) : ip ? realmOfInstance(ip) : null
    const target = ip ? ip[ip.length - 1] : 'selection'
    const blocked = !dir ? 'This location is not mapped to a folder in the repo' : undefined
    const items: MenuEntry[] = [{ header: `Script · in ${target}` }]
    items.push({ label: 'ModuleScript', accel: 'm', icon: <ClassIcon className="ModuleScript" realm={realm ?? undefined} size={14} />, disabled: !!blocked, reason: blocked, onSelect: () => beginCreate('ModuleScript', ip) })
    if (realm !== 'client') items.push({ label: 'Script', accel: 's', icon: <ClassIcon className="Script" realm="server" size={14} />, disabled: !!blocked, reason: blocked, onSelect: () => beginCreate('Script', ip) })
    if (realm !== 'server') items.push({ label: 'LocalScript', accel: 'l', icon: <ClassIcon className="LocalScript" realm="client" size={14} />, disabled: !!blocked, reason: blocked, onSelect: () => beginCreate('LocalScript', ip) })
    items.push({ header: 'Scaffold' })
    items.push({ label: 'Feature', accel: 'f', icon: <Icon name="trio" />, sub: 'shared/Features + Service + Controller', onSelect: () => beginCreate('Feature') })
    items.push({ label: 'Folder', accel: 'd', icon: <Icon name="folderPlus" />, disabled: !!blocked, reason: blocked, onSelect: () => beginCreate('Folder', ip) })
    items.push({ label: 'Blink event', accel: 'e', icon: <Icon name="bolt" />, sub: 'appends to events.blink', onSelect: () => actions.requestCreate('Blink') })
    items.push({ header: 'UI' })
    items.push({ label: 'Story', accel: 'u', icon: <ClassIcon className="ModuleScript" realm={realm ?? undefined} size={14} />, sub: '.story.luau (UI Labs, Vide)', disabled: !!blocked, reason: blocked, onSelect: () => beginCreate('Story', ip) })
    items.push({ label: 'Storybook', accel: 'b', icon: <ClassIcon className="ModuleScript" realm={realm ?? undefined} size={14} />, sub: '.storybook.luau for this folder', disabled: !!blocked, reason: blocked, onSelect: () => beginCreate('Storybook', ip) })
    return items
  }

  const featureOf = (path?: string, ip?: string[]) => {
    const fs = featuresOf(scripts)
    if (path) {
      const f = fs.find((x) => x.shared === path || x.service === path || x.controller === path)
      if (f) return f.name
    }
    if (ip && ip.length === 4 && ip.slice(0, 3).join('/') === 'ReplicatedStorage/Shared/Features') return fs.some((x) => x.name === ip[3]) ? ip[3] : null
    return null
  }

  // ---- rename / delete
  // The file or folder on disk a rename or delete acts on. None for Studio-only nodes, packages,
  // Blink output, nodes with no file or folder of their own, and project-file mount points (renaming
  // those would break the project file; main refuses them too).
  const diskEntry = (r: Row): { path: string; isDir: boolean } | null => {
    if (r.studio || r.wally || r.blinkOut) return null
    const mounts = state.project?.mounts ?? []
    const ip = r.instancePath ?? null
    let entry: { path: string; isDir: boolean } | null = null
    if (r.filePath) entry = { path: r.filePath, isDir: false }
    else if (mode === 'files' && r.dir) entry = { path: r.dir, isDir: true }
    else if (mode === 'tree' && ip) {
      const dir = dirForInstance(state.tree, ip)
      if (dir && basename(dir) === r.name) entry = { path: dir, isDir: true }
    }
    if (!entry) return null
    const target = entryTarget(entry.path, entry.isDir).path
    if (protectedReason(target, mounts)) return null
    if (target.split('/').some((part) => /^(Server|Dev)?Packages$|^_Index$/.test(part))) return null
    // The Game view holds only what a project file maps; the Files view also lists root files (events.blink).
    if (mode === 'tree' && !mounts.some((m) => target.startsWith(m + '/'))) return null
    return entry
  }

  const beginRename = (r: Row) => {
    const entry = diskEntry(r)
    if (entry) actions.openDialog({ kind: 'renamePath', path: entry.path, isDir: entry.isDir })
  }

  const confirmDelete = (r: Row) => {
    const entry = diskEntry(r)
    if (!entry) return
    const target = entryTarget(entry.path, entry.isDir)
    const unsaved = state.files.filter((f) => isUnder(f.path, target.path) && f.current !== f.saved).length
    const bin = trashName()
    const what = target.isDir ? `the folder ${target.path} and everything in it` : target.path
    const run = () => {
      actions
        .trashPath(target.path, target.isDir)
        .then(() => actions.toast({ text: `Deleted ${basename(target.path)}`, detail: `Moved to the ${bin}`, kind: 'ok', ms: 3500 }))
        .catch((err) => actions.toast({ text: `Could not delete ${basename(target.path)}`, detail: errorText(err), kind: 'err' }))
    }
    if (!shouldConfirmDelete(state.appSettings?.confirmFileDelete, unsaved)) return run()
    actions.openDialog({
      kind: 'confirm',
      title: `Delete ${basename(target.path)}?`,
      body: `Moves ${what} to the ${bin}; you can restore it from there.${unsaved ? ` ${unsaved === 1 ? 'An open file has' : `${unsaved} open files have`} unsaved changes that will be lost.` : ''}`,
      confirm: `Move to ${bin}`,
      danger: true,
      dontAsk: 'confirmFileDelete',
      run
    })
  }

  // Del / Delete: a Studio-only instance goes through the Forge Bridge, anything else to the trash.
  const deleteRow = (r: Row) => {
    if (r.studio && r.instancePath && mode === 'tree') void deleteInStudio(state, actions, r.instancePath, r.className)
    else confirmDelete(r)
  }

  // ---- multi-select actions
  // Why a selected row is left out of a batch delete (Wally packages, Blink output, mounts...).
  const skipReason = (r: Row): string => {
    const at = r.filePath ?? r.dir ?? r.instancePath?.join('/') ?? ''
    if (r.wally || /(^|\/)((Server|Dev)?Packages|_Index)(\/|$)/.test(at)) return 'Wally package, read-only'
    if (r.blinkOut) return 'generated by Blink'
    const p = r.filePath ?? r.dir ?? (mode === 'tree' && r.instancePath ? dirForInstance(state.tree, r.instancePath) : null)
    if (p && protectedReason(entryTarget(p, !r.filePath).path, state.project?.mounts ?? [])) return MOUNT_REASON
    return 'no file or folder of its own'
  }

  const candidate = (r: Row): DeleteCandidate => {
    const instancePath = mode === 'tree' ? r.instancePath : undefined
    if (r.studio && r.instancePath && mode === 'tree') return { key: r.key, name: r.name, kind: 'studio', instancePath: r.instancePath, className: r.className }
    const entry = diskEntry(r)
    if (!entry) {
      const reason = skipReason(r)
      // Where it is on disk, for telling whether a selected folder holds it: its own file or folder,
      // or (a project-file mount) the folder it maps.
      const path = r.filePath ?? r.dir ?? (reason === MOUNT_REASON && instancePath ? dirForInstance(state.tree, instancePath) ?? undefined : undefined)
      return { key: r.key, name: r.name, kind: 'skip', reason, path, instancePath }
    }
    const t = entryTarget(entry.path, entry.isDir)
    return { key: r.key, name: r.name, kind: 'disk', path: t.path, isDir: t.isDir, file: r.filePath, instancePath }
  }

  // The selection's delete plan, and per folder in it how many files it holds that were not selected
  // (hidden by the filter or a collapse): those always get the confirmation.
  const selectionPlan = (): { plan: DeletePlan; hidden: { path: string; count: number }[] } => {
    const candidates = selectedRows.map(candidate)
    const plan = planDelete(candidates)
    return { plan, hidden: unselectedInside(plan, candidates, knownFiles) }
  }

  // Del with several rows selected: the files and folders to the trash (one confirm); a selection of
  // only Studio-only instances goes through Delete in Studio instead.
  const deleteSelection = () => {
    const { plan, hidden } = selectionPlan()
    if (!plan.disk.length && plan.studio.length) void deleteManyInStudio(state, actions, plan)
    else deleteManyFromDisk(state, actions, plan, hidden)
  }

  const openMany = async (paths: string[]) => {
    for (const p of paths) await actions.openFile(p)
  }

  const copyLines = (lines: string[], label: string) => void actions.copy(lines.join('\n'), label)

  const multiMenu = (e: MouseEvent, r: Row) => {
    setMenuTarget(r.key)
    const at = { clientX: e.clientX, clientY: e.clientY }
    e.preventDefault()
    const picked = selectedRows
    const { plan, hidden } = selectionPlan()
    const files = picked.filter((x) => x.filePath && !x.studio).map((x) => x.filePath!)
    const scriptsOnly = files.every((f) => /\.luau?$/.test(f))
    const diskPaths = picked.map((x) => x.filePath ?? x.dir).filter((x): x is string => !!x)
    const robloxDots = picked.filter((x) => x.instancePath).map((x) => robloxPaths(x.instancePath!).dot)
    const items: MenuEntry[] = [{ header: `${picked.length} selected` }]
    if (files.length) {
      items.push({ label: `Open ${files.length} ${scriptsOnly ? 'script' : 'file'}${files.length === 1 ? '' : 's'}`, icon: <Icon name="file" />, hint: '↵', onSelect: () => void openMany(files) })
    }
    if (mode === 'tree' && robloxDots.length) {
      const reqs = picked.filter((x) => x.instancePath && !x.studio).map((x) => requireExpression(x.instancePath!))
      items.push({
        label: 'Copy paths',
        icon: <Icon name="copy" />,
        hint: keyHint('alt+mod+c'),
        submenu: [
          { header: 'Copy as, one per line' },
          { label: `Roblox paths (${robloxDots.length})`, accel: 'd', onSelect: () => copyLines(robloxDots, `${robloxDots.length} Roblox paths`) },
          { label: `require(…) (${reqs.length})`, accel: 'r', disabled: !reqs.length, reason: 'Studio-only instances have no require path', onSelect: () => copyLines(reqs, `${reqs.length} requires`) },
          { label: `File paths (${diskPaths.length})`, accel: 'p', disabled: !diskPaths.length, reason: 'None of these is a file in the repo', onSelect: () => copyLines(diskPaths, `${diskPaths.length} file paths`) }
        ]
      })
    } else if (diskPaths.length) {
      items.push({ label: 'Copy paths', icon: <Icon name="copy" />, sub: `${diskPaths.length} repo paths, one per line`, onSelect: () => copyLines(diskPaths, `${diskPaths.length} file paths`) })
    }
    if (files.length || robloxDots.length) {
      const refs = files.length ? files : robloxDots
      items.push({ label: 'Ask Assistant about these', icon: <Icon name="at" />, onSelect: () => actions.ask(`${refs.map((x) => `\`${x}\``).join(' ')} `) })
    }
    items.push('separator')
    items.push({ label: 'Rename…', icon: <Icon name="pencil" />, disabled: true, reason: 'Rename works on one item at a time' })
    const reasons = [...new Set(plan.skipped.map((x) => x.reason))]
    const skips = plan.skipped.length ? `leaves out ${plan.skipped.length}${reasons.length === 1 ? ` (${reasons[0]})` : ' that cannot be deleted'}` : undefined
    if (plan.disk.length || !plan.studio.length) {
      items.push(
        plan.disk.length
          ? { label: `Delete ${plan.disk.length} item${plan.disk.length === 1 ? '' : 's'}`, icon: <Icon name="trash" />, hint: isMac ? '⌘⌫' : 'Del', danger: true, sub: skips, onSelect: () => deleteManyFromDisk(state, actions, plan, hidden) }
          : { label: 'Delete', icon: <Icon name="trash" />, disabled: true, reason: plan.skipped[0] ? `Nothing here can be deleted (${plan.skipped[0].reason})` : 'Nothing here can be deleted' }
      )
    }
    if (!plan.studio.length) {
      menu.openAt(at, items)
      return
    }
    // Studio-only rows: the same check as the single "Delete in Studio", then one batch.
    void studioDeletable(plan).then(({ ok, refused }) => {
      const del: MenuEntry = ok.length
        ? { label: `Delete ${ok.length} in Studio`, icon: <Icon name="trash" />, hint: plan.disk.length ? undefined : isMac ? '⌘⌫' : 'Del', danger: true, sub: refused.length ? `${refused.length} refused: ${refused[0].reason}` : undefined, onSelect: () => void deleteManyInStudio(state, actions, plan) }
        : { label: `Delete ${plan.studio.length} in Studio`, icon: <Icon name="trash" />, disabled: true, reason: refused[0]?.reason }
      menu.openAt(at, [...items, del])
    })
  }

  const featureInfo = (name: string) => featuresOf(scripts).find((x) => x.name === name)

  const rowMenu = (e: MouseEvent, r: Row) => {
    // Right-click inside a multi-selection acts on all of it. Outside one, the menu acts on that row
    // alone and the multi-selection stays (only the focus moves there); with one row or none selected,
    // the right-clicked row becomes the selection.
    if (selSet.has(r.key) && sel.keys.length > 1) return multiMenu(e, r)
    if (sel.keys.length > 1) setSel((s) => ({ ...s, focus: r.key }))
    else setSelected(r.key)
    setMenuTarget(r.key)
    const items: MenuEntry[] = []
    const ip = r.instancePath ?? (r.filePath ? instancePathOfFile(state.tree, r.filePath) : null)
    const paths = ip ? robloxPaths(ip) : null
    if (r.studio) {
      if (paths) {
        items.push({ header: paths.dot, mono: true })
        items.push({ label: 'Copy Roblox path', icon: <Icon name="copy" />, hint: keyHint('alt+mod+c'), onSelect: () => void actions.copy(paths.dot) })
        items.push({ label: 'Copy as GetService', icon: <Icon name="code" />, onSelect: () => void actions.copy(paths.service) })
        items.push({ label: 'Copy slash path', icon: <Icon name="copy" />, onSelect: () => void actions.copy(paths.slash) })
        items.push('separator', { label: 'Ask Assistant about this', icon: <Icon name="at" />, onSelect: () => actions.ask(`\`${paths.dot}\` (${r.className}, Studio only) `) })
      }
      if (!ip) {
        menu.openAt(e, items)
        return
      }
      // "Save to repo": a .model.json at its mapped place, only inside a Rojo $path (main decides).
      // "Delete in Studio": through the Forge Bridge plugin (v7), disabled with the reason otherwise.
      const at = { clientX: e.clientX, clientY: e.clientY }
      e.preventDefault()
      const saveable = !SCRIPT_CLASSES.has(r.className)
      void Promise.all([
        saveable ? window.harness.syncSaveTarget(ip).catch((err) => ({ reason: errorText(err) })) : Promise.resolve(null),
        window.harness.syncDeleteCheck(ip).catch((err) => ({ reason: errorText(err) }))
      ]).then(([target, check]) => {
        const del: MenuEntry =
          'ok' in check
            ? { label: 'Delete in Studio', icon: <Icon name="trash" />, hint: isMac ? '⌘⌫' : 'Del', danger: true, onSelect: () => void deleteInStudio(state, actions, ip, r.className) }
            : { label: 'Delete in Studio', icon: <Icon name="trash" />, disabled: true, reason: check.reason }
        if (!target) {
          menu.openAt(at, [...items, 'separator', del])
          return
        }
        const save: MenuEntry =
          'file' in target
            ? {
                label: 'Save to repo',
                icon: <Icon name="download" />,
                sub: target.file,
                onSelect: () =>
                  void window.harness
                    .syncSaveToRepo(ip)
                    .then((entry) => actions.toast({ text: `Saved ${r.name} to the repo`, detail: `${entry.file} (Rojo owns it from now on)`, kind: 'ok' }))
                    .catch((err) => actions.toast({ text: 'Could not save to repo', detail: errorText(err), kind: 'err' }))
              }
            : { label: 'Save to repo', icon: <Icon name="download" />, disabled: true, reason: target.reason }
        menu.openAt(at, [...items.slice(0, 4), save, ...items.slice(4), 'separator', del])
      })
      return
    }
    if (r.blinkOut) {
      const src = (state.blink?.files ?? (state.blink ? [state.blink] : [])).find((m) => m.outputs && Object.values(m.outputs).includes(r.filePath ?? ""))?.file ?? state.blink?.file ?? 'events.blink'
      items.push({ header: 'Generated by Blink' })
      items.push({ label: `Open ${src}`, icon: <Icon name="bolt" />, onSelect: () => void actions.openFile(src) })
      if (r.filePath) items.push({ label: 'Open generated file', icon: <Icon name="file" />, onSelect: () => void actions.openFile(r.filePath!) })
      if (ip) items.push('separator', { label: 'Copy require(…)', icon: <Icon name="code" />, hint: keyHint('shift+mod+c'), onSelect: () => void actions.copy(requireExpression(ip), 'require') })
      menu.openAt(e, items)
      return
    }
    if (r.wally) {
      items.push({ header: 'Wally package' })
      items.push({ label: 'Manage packages…', icon: <Icon name="package" />, onSelect: () => actions.openPage('packages') })
      if (ip) items.push({ label: 'Copy require(…)', icon: <Icon name="code" />, onSelect: () => void actions.copy(requireExpression(ip), 'require') })
      menu.openAt(e, items)
      return
    }
    const dir = r.dir ?? (ip ? dirForInstance(state.tree, ip) : null)
    const targetIp = ip && r.filePath && !initSuffix(r.filePath) ? ip.slice(0, -1) : ip
    const targetDir = r.filePath && !initSuffix(r.filePath) ? (targetIp ? dirForInstance(state.tree, targetIp) : null) : dir
    if (mode === 'tree') items.push({ label: 'New', icon: <Icon name="plus" />, submenu: newSubmenu(targetIp, targetDir) })
    else if (r.dir) {
      // Files tab folder: create inside the instance this folder maps to.
      const dirIp = instanceForDir(state.tree, r.dir)
      items.push({ label: 'New', icon: <Icon name="plus" />, submenu: newSubmenu(dirIp, dirIp ? r.dir : null) })
    }
    if (r.filePath) {
      items.push({ label: 'Open', icon: <Icon name="file" />, hint: '↵', onSelect: () => void actions.openFile(r.filePath!) })
    }
    const feature = featureOf(r.filePath, ip ?? undefined)
    if (feature) {
      items.push({ label: `Rename Feature ${feature}…`, icon: <Icon name="pencil" />, hint: 'F2', onSelect: () => actions.openDialog({ kind: 'renameFeature', from: feature }) })
      const info = featureInfo(feature)
      if (info) items.push({ label: `Delete Feature ${feature}…`, icon: <Icon name="trash" />, danger: true, sub: 'shared, Service and Controller', onSelect: () => deleteFeature(state, actions, info) })
    }
    items.push('separator')
    if (paths) {
      items.push({
        label: 'Copy Roblox path',
        icon: <Icon name="copy" />,
        hint: keyHint('alt+mod+c'),
        submenu: [
          { header: 'Copy as' },
          { label: paths.dot, accel: 'd', onSelect: () => void actions.copy(paths.dot) },
          { label: paths.service, accel: 's', onSelect: () => void actions.copy(paths.service) },
          { label: paths.slash, accel: 'p', onSelect: () => void actions.copy(paths.slash) }
        ]
      })
      items.push({ label: 'Copy require(…)', icon: <Icon name="code" />, hint: keyHint('shift+mod+c'), onSelect: () => void actions.copy(requireExpression(ip!), 'require') })
    }
    if (r.filePath) items.push({ label: 'Copy file path', icon: <Icon name="copy" />, onSelect: () => void actions.copy(r.filePath!, 'file path') })
    if (r.filePath && /\.luau?$/.test(r.filePath)) {
      items.push('separator')
      const isSpec = /\.spec\.luau?$/.test(r.filePath)
      if (isSpec) items.push({ label: 'Run this spec', icon: <Icon name="flask" />, onSelect: () => void actions.runTests({ scope: { kind: 'file', file: r.filePath! } }) })
      else if (r.className === 'ModuleScript') items.push({ label: 'Create spec', icon: <Icon name="flask" />, sub: 'Lune test next to this module', onSelect: () => void actions.createSpec(r.filePath!) })
      items.push({ label: 'Ask Assistant about this', icon: <Icon name="at" />, onSelect: () => actions.ask(`\`${r.filePath}\` `) })
      items.push({ label: 'Claim for my work', icon: <Icon name="lock" />, sub: 'tells teammates you are editing it', onSelect: () => void window.harness.claim(r.filePath!).then((claims) => actions.set({ claims })).catch((err) => actions.toast({ text: 'Could not claim', detail: errorText(err), kind: 'err' })) })
    }
    if (ip && mode === 'tree') items.push({ label: 'Reveal in game tree', icon: <Icon name="reveal" />, onSelect: () => actions.revealInstance(ip) })
    if (diskEntry(r)) {
      items.push('separator')
      items.push({ label: 'Rename…', icon: <Icon name="pencil" />, hint: feature ? undefined : 'F2', onSelect: () => beginRename(r) })
      items.push({ label: 'Delete', icon: <Icon name="trash" />, hint: isMac ? '⌘⌫' : 'Del', danger: true, onSelect: () => confirmDelete(r) })
    }
    menu.openAt(e, items)
  }

  useEffect(() => {
    if (!menu.node) setMenuTarget(null)
  }, [menu.node])

  // ---- activation
  const activate = (r: Row, preview: boolean) => {
    setSelected(r.key)
    if (r.filePath && !r.studio) void actions.openFile(r.filePath, { preview })
    else if (r.hasChildren) toggle(mode === 'files' ? r.dir! : r.key)
  }

  // Plain click: select and open (as before). Ctrl/Cmd-click toggles, Shift-click selects a range;
  // neither opens anything.
  const onRowClick = (e: MouseEvent, r: Row) => {
    const toggle = isMac ? e.metaKey : e.ctrlKey
    if (toggle || e.shiftKey) {
      setSel((s) => clickSelect(s, visibleKeys, r.key, { toggle, range: e.shiftKey }, contextKeys))
      return
    }
    activate(r, true)
  }

  const onKey = (e: RKeyboardEvent) => {
    // An open context menu handles (and prevents) its own arrows / Enter first.
    if ((e.target as HTMLElement).tagName === 'INPUT' || e.defaultPrevented) return
    // The arrows move from, expand and collapse the focus row (the outlined cursor). Everything else
    // acts on the selected rows only: with nothing selected, Enter, F2, Delete and copy do nothing,
    // even when the cursor sits on a row that was just Ctrl/Cmd-clicked off.
    const i = rows.findIndex((r) => r.key === selected)
    const r = rows[i]
    const openKey = (x: Row) => (mode === 'files' ? x.dir! : x.key)
    const mod = e.metaKey || e.ctrlKey
    const targets = selectedRows
    const many = targets.length > 1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = moveFocus(sel, visibleKeys, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey, contextKeys)
      setSel(next)
      if (next.focus) listRef.current?.querySelector(`[data-key="${CSS.escape(next.focus)}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && rows.length) {
      e.preventDefault()
      setSel((s) => selectAll(s, visibleKeys, contextKeys))
    } else if (e.key === 'Escape' && sel.keys.length) {
      e.preventDefault()
      setSel(clearKeys)
    } else if (e.key === 'ArrowRight' && r?.hasChildren) {
      e.preventDefault()
      toggle(openKey(r), true)
    } else if (e.key === 'ArrowLeft' && r) {
      e.preventDefault()
      if (r.hasChildren && open.has(openKey(r))) toggle(openKey(r), false)
      else {
        const parent = rows.slice(0, i).reverse().find((x) => x.depth < r.depth)
        if (parent) setSelected(parent.key)
      }
    } else if (e.key === 'Enter' && many) {
      e.preventDefault()
      void openMany(targets.filter((x) => x.filePath && !x.studio).map((x) => x.filePath!))
    } else if (e.key === 'Enter' && one) {
      e.preventDefault()
      activate(one, false)
    } else if (e.key === ' ' && one) {
      e.preventDefault()
      activate(one, true)
    } else if (e.key === 'F2' && one) {
      e.preventDefault()
      const f = featureOf(one.filePath, one.instancePath)
      if (f) actions.openDialog({ kind: 'renameFeature', from: f })
      else beginRename(one)
    } else if ((e.key === 'Delete' || (isMac && e.key === 'Backspace' && e.metaKey)) && targets.length) {
      e.preventDefault()
      if (many) deleteSelection()
      else deleteRow(targets[0])
    } else if (mod && e.altKey && e.key.toLowerCase() === 'c' && many) {
      e.preventDefault()
      const dots = targets.filter((x) => x.instancePath).map((x) => robloxPaths(x.instancePath!).dot)
      if (dots.length) copyLines(dots, `${dots.length} Roblox paths`)
    } else if (mod && e.altKey && e.key.toLowerCase() === 'c' && one?.instancePath) {
      e.preventDefault()
      void actions.copy(robloxPaths(one.instancePath).dot)
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && many) {
      e.preventDefault()
      const reqs = targets.filter((x) => x.instancePath && !x.studio).map((x) => requireExpression(x.instancePath!))
      if (reqs.length) copyLines(reqs, `${reqs.length} requires`)
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && one?.instancePath) {
      e.preventDefault()
      void actions.copy(requireExpression(one.instancePath), 'require')
    } else if (e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      filterRef.current?.focus()
    }
  }

  const headMenu = (el: HTMLElement) => {
    const ip = mode === 'tree' ? (one ?? focusRow)?.instancePath ?? null : null
    const target = ip ? (findNode(state.tree, ip)?.filePath && !initSuffix(findNode(state.tree, ip)?.filePath) ? ip.slice(0, -1) : ip) : defaultTarget(state.tree, 'ModuleScript')
    menu.openUnder(el, newSubmenu(target, target ? dirForInstance(state.tree, target) : null))
  }

  const studioCount = useMemo(() => {
    let n = 0
    const walk = (ns: TreeNode[]) => ns.forEach((x) => (x.origin === 'studio' && n++, walk(x.children)))
    walk(state.tree)
    return n
  }, [state.tree])
  const rojo = state.services.find((s) => s.id === 'rojo')
  // Why Studio-only instances may be missing from the Game view: Forge only reads linked places.
  const [syncStatus] = useForgeSync()
  const studioHint = useMemo(() => {
    if (!syncStatus || syncStatus.engine !== 'forge') return null
    const unlinked = syncStatus.unlinked?.[0]
    if (unlinked) return `Studio has "${unlinked.name}" open, but it isn't linked to this project: Forge never reads an unlinked place, so instances that exist only in Studio are not shown here. Link it in Studio sync to see them.`
    if (!studioCount && !syncStatus.places.some((p) => p.connected)) return 'Instances that exist only in Studio show here once Studio is connected with the Forge Bridge plugin and its place is checked.'
    return null
  }, [syncStatus, studioCount])

  // ---- render helpers
  const createRow = (c: Creating) => {
    const problem = validateName(c.name, c.kind === 'Feature' ? featuresOf(scripts).map((f) => f.name) : siblingNames(c))
    const hint = createHint(c.kind, c.dir, c.instancePath)
    const glyph = c.kind === 'Feature' || c.kind === 'Story' || c.kind === 'Storybook' ? 'ModuleScript' : c.kind
    return (
      <div className="create-row item-in" style={{ paddingLeft: 8 + c.depth * 12 }}>
        <div className="row" style={{ gap: 6 }}>
          <span style={{ width: 14 }} />
          <ClassIcon className={glyph} realm={c.dir ? realmOfDir(c.dir) ?? undefined : undefined} />
          <input
            className="inline-input"
            autoFocus
            value={c.name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setCreating({ ...c, name: e.target.value.trim() })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void commitCreate(c, e.currentTarget)
              if (e.key === 'Escape') setCreating(null)
            }}
            onBlur={() => (problem ? setCreating(null) : void commitCreate(c))}
            spellCheck={false}
          />
        </div>
        {problem ? <div className="create-msg err">{problem}</div> : hint ? <div className={`create-msg ${hint.level}`}>{hint.text}</div> : null}
        {!problem && c.dir && c.kind !== 'Feature' && <div className="create-msg">{c.dir}/{c.name}{c.kind === 'Script' ? '.server.luau' : c.kind === 'LocalScript' ? '.client.luau' : c.kind === 'Folder' ? '/' : c.kind === 'Story' ? '.story.luau' : c.kind === 'Storybook' ? '.storybook.luau' : '.luau'}</div>}
      </div>
    )
  }

  const renderRow = (r: Row) => {
    const isOpen = q ? true : open.has(mode === 'files' ? r.dir ?? '' : r.key)
    const active = !!r.filePath && r.filePath === state.activeFile
    const realm = r.filePath ? realmOfFile(r.filePath) : r.instancePath ? realmOfInstance(r.instancePath) : undefined
    const showCreate = creating && creating.parentKey === r.key
    return (
      <div key={r.key}>
        <div
          data-key={r.key}
          id={ids.get(r.key)}
          role="treeitem"
          aria-selected={selSet.has(r.key)}
          aria-expanded={r.hasChildren ? isOpen : undefined}
          className={`trow${selSet.has(r.key) ? ' sel' : ''}${r.key === selected && !(sel.keys.length === 1 && sel.keys[0] === r.key) ? ' focus' : ''}${active ? ' active' : ''}${r.studio || r.wally ? ' dim' : ''}${menuTarget === r.key ? ' ctx' : ''}${flashKey === r.key ? ' flash' : ''}`}
          style={{ paddingLeft: 8 + r.depth * 12 }}
          onClick={(e) => onRowClick(e, r)}
          onDoubleClick={() => r.filePath && void actions.openFile(r.filePath)}
          onContextMenu={(e) => rowMenu(e, r)}
          title={r.instancePath ? `${robloxPaths(r.instancePath).dot}\n${r.className}${r.filePath ? `\n${r.filePath}` : ''}${r.studio ? '\nStudio only (not in the repo)' : ''}` : r.filePath ?? r.dir}
          onAnimationEnd={() => flashKey === r.key && setFlashKey(null)}
        >
          <span
            className={`chev${r.hasChildren ? '' : ' none'}${isOpen ? ' open' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              if (r.hasChildren) toggle(mode === 'files' ? r.dir! : r.key)
            }}
          >
            {r.hasChildren && <Icon name="chev" size={12} />}
          </span>
          {r.className === 'File' && r.filePath ? <FileGlyph path={r.filePath} size={15} /> : <ClassIcon className={r.className} realm={realm} size={15} />}
          <span className="tname">
            <Name text={r.name} q={q} />
            {r.suffix && <span className="faint"> {r.suffix}</span>}
          </span>
          {r.studioTop && <span className="tag studio">studio</span>}
          {r.wally && <span className="tag wally">wally</span>}
          {r.blinkOut && <span className="tag blink">blink</span>}
          {r.blinkOut && <Icon name="lock" size={11} className="row-lock" />}
          {mode === 'tree' && r.instancePath && (
            <button
              className="row-act"
              title="Copy Roblox path"
              onClick={(e) => {
                e.stopPropagation()
                void actions.copy(robloxPaths(r.instancePath!).dot)
              }}
            >
              <Icon name="copy" size={12} />
            </button>
          )}
        </div>
        {showCreate && createRow(creating)}
      </div>
    )
  }

  const createAtRoot = creating && !rows.some((r) => r.key === creating.parentKey)

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Explorer</span>
        {sel.keys.length > 1 && mode !== 'features' && (
          <span className="sel-chip" role="status" title={`${sel.keys.length} selected · Esc clears`}>
            {sel.keys.length} selected
            <button className="sel-chip-x" onClick={() => setSel(clearKeys)} aria-label="Clear selection" title="Clear selection (Esc)">
              <Icon name="x" size={10} />
            </button>
          </span>
        )}
        <button className="icon-btn" title="New…" onClick={(e) => headMenu(e.currentTarget)}>
          <Icon name="plus" size={14} />
        </button>
        <button className="icon-btn" title={`New Feature (${keyHint('mod+shift+n')})`} onClick={() => beginCreate('Feature')}>
          <Icon name="trio" size={14} />
        </button>
        <button className="icon-btn" title="Collapse all" onClick={() => setOpen(new Set())}>
          <Icon name="collapse" size={14} />
        </button>
      </div>
      <label className="filter">
        <Icon name="search" size={12} />
        <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={mode === 'features' ? 'filter features' : 'filter instances'} spellCheck={false} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
        {filter && (
          <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setFilter('')} aria-label="Clear filter">
            <Icon name="x" size={11} />
          </button>
        )}
      </label>
      <div className="seg side-seg">
        <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')}>Game</button>
        <button className={mode === 'files' ? 'on' : ''} onClick={() => setMode('files')}>Files</button>
        <button className={mode === 'features' ? 'on' : ''} onClick={() => setMode('features')}>Features</button>
      </div>
      <div className="panel-body tree" role="tree" aria-multiselectable={mode !== 'features'} aria-activedescendant={mode !== 'features' && focusRow ? ids.get(focusRow.key) : undefined} tabIndex={0} ref={listRef} onKeyDown={onKey}>
        {mode === 'tree' && state.tree.length > 0 && (
          <div className="tree-section">
            game · rojo{rojo?.state === 'running' ? '' : ` (${rojo?.state ?? 'off'})`} · {studioCount ? `${studioCount} studio-only` : 'repo'}
          </div>
        )}
        {mode !== 'features' && rows.map(renderRow)}
        {createAtRoot && createRow(creating!)}
        {mode === 'tree' && !state.tree.length && (
          <div className="empty">
            <Icon name="tree" />
            <span>{state.project ? 'No game tree yet. Start Rojo or run ./dev to build the sourcemap.' : 'Open a project to see its game tree.'}</span>
            <div className="row">
              {state.project ? (
                <>
                  <button className="btn" onClick={() => void window.harness.startService('rojo')}><Icon name="play" size={12} /> Serve</button>
                  <button className="btn ghost" onClick={() => setMode('files')}>Files view</button>
                </>
              ) : (
                <button className="btn" onClick={() => void actions.openProject()}>Open folder…</button>
              )}
            </div>
          </div>
        )}
        {mode !== 'features' && q && !rows.length && state.tree.length > 0 && (
          <div className="empty">
            <span>No {mode === 'tree' ? 'instances' : 'files'} match "{filter}".</span>
            {mode === 'tree' && studioHint && <span className="note">{studioHint}</span>}
            <div className="row">
              <button className="btn ghost" onClick={() => setFilter('')}>Clear filter</button>
              {mode === 'tree' && studioHint && <button className="btn ghost" onClick={() => actions.showSide('sync')}>Studio sync</button>}
            </div>
          </div>
        )}
        {mode === 'features' && (
          <FeaturesList features={features} scripts={scripts} onNew={() => beginCreate('Feature')} />
        )}
      </div>
      {menu.node}
    </>
  )
}

function FeaturesList({ features, onNew }: { features: ReturnType<typeof featuresOf>; scripts: ScriptEntry[]; onNew: () => void }) {
  const { state, actions } = useStore()
  const menu = useMenu()
  const part = (label: string, path: string | undefined, cls: string, realm: 'shared' | 'server' | 'client') =>
    path ? (
      <button className={`fpart ${realm}${path === state.activeFile ? ' on' : ''}`} onClick={() => void actions.openFile(path)} title={path}>
        <ClassIcon className={cls} realm={realm} size={13} />
        {label}
      </button>
    ) : (
      <span className="fpart missing" title={`No ${label} file`}>
        <Icon name="warn" size={12} />
        {label}
      </span>
    )
  return (
    <div className="features">
      {features.map((f) => {
        const complete = !!(f.shared && f.service && f.controller)
        return (
          <div
            key={f.name}
            className="frow"
            onContextMenu={(e) =>
              menu.openAt(e, [
                { header: `Feature ${f.name}` },
                { label: 'Rename Feature…', icon: <Icon name="pencil" />, hint: 'F2', onSelect: () => actions.openDialog({ kind: 'renameFeature', from: f.name }) },
                { label: 'Delete Feature…', icon: <Icon name="trash" />, danger: true, sub: [f.shared && 'shared', f.service && 'Service', f.controller && 'Controller'].filter(Boolean).join(', '), onSelect: () => deleteFeature(state, actions, f) },
                { label: 'Ask Assistant about this feature', icon: <Icon name="at" />, onSelect: () => actions.ask(`Feature ${f.name} (${[f.shared, f.service, f.controller].filter(Boolean).join(', ')}) `) },
                ...(f.shared ? [{ label: 'Reveal in game tree', icon: <Icon name="reveal" />, onSelect: () => actions.revealInstance(['ReplicatedStorage', 'Shared', 'Features', f.name]) }] : [])
              ])
            }
          >
            <div className="row" style={{ gap: 6 }}>
              <Icon name="trio" size={14} className="faint" />
              <span className="grow ellipsis">{f.name}</span>
              <span className={`tag ${complete ? 'ok' : 'warn'}`}>{complete ? '3/3' : `${[f.shared, f.service, f.controller].filter(Boolean).length}/3`}</span>
            </div>
            <div className="fparts">
              {part('shared', f.shared, 'ModuleScript', 'shared')}
              {part('Service', f.service, 'ModuleScript', 'server')}
              {part('Controller', f.controller, 'ModuleScript', 'client')}
            </div>
          </div>
        )
      })}
      <button className="trow add-row" onClick={onNew}>
        <Icon name="plus" size={12} />
        New Feature…
        <span className="grow" />
        <kbd>{keyHint('mod+shift+n')}</kbd>
      </button>
      {!features.length && <div className="note" style={{ padding: '6px 14px' }}>No features yet. A feature is src/shared/Features/X plus XService and XController.</div>}
      {menu.node}
    </div>
  )
}

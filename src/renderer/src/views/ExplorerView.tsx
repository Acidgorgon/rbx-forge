// Explorer (SPEC §7.3, §8.1, §8.2): the Roblox game tree, the repo files and the feature trios,
// with the context menu, inline create flow from GenTree templates, reveal and keyboard navigation.
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
import { sparks } from '../lib/sparks'
import { shouldConfirmDelete } from '../lib/deleteConfirm'
import { deleteFeature, deleteInStudio, trashName } from './deleteFlows'

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
}

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
  const [selected, setSelected] = useState<string | null>(null)
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
      const walk = (nodes: TreeNode[], depth: number, parent: string[], parentStudio: boolean, parentWally: boolean) => {
        for (const node of nodes) {
          if (q && !matches(node, q)) continue
          const instancePath = [...parent, node.name]
          const key = instancePath.join('/')
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
            suffix: initSuffix(node.filePath)
          })
          if (node.children.length && (q || open.has(key))) walk(node.children, depth + 1, instancePath, studio, wally)
        }
      }
      walk(roots(state.tree), 0, [], false, false)
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
    let ip = targetPath ?? (selected && mode === 'tree' ? selected.split('/') : null)
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

  const featureInfo = (name: string) => featuresOf(scripts).find((x) => x.name === name)

  const rowMenu = (e: MouseEvent, r: Row) => {
    setSelected(r.key)
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

  const onKey = (e: RKeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const i = rows.findIndex((r) => r.key === selected)
    const r = rows[i]
    const openKey = (x: Row) => (mode === 'files' ? x.dir! : x.key)
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        setSelected(next.key)
        listRef.current?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' })
      }
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
    } else if (e.key === 'Enter' && r) {
      e.preventDefault()
      activate(r, false)
    } else if (e.key === ' ' && r) {
      e.preventDefault()
      activate(r, true)
    } else if (e.key === 'F2' && r) {
      e.preventDefault()
      const f = featureOf(r.filePath, r.instancePath)
      if (f) actions.openDialog({ kind: 'renameFeature', from: f })
      else beginRename(r)
    } else if ((e.key === 'Delete' || (isMac && e.key === 'Backspace' && e.metaKey)) && r) {
      e.preventDefault()
      deleteRow(r)
    } else if (mod && e.altKey && e.key.toLowerCase() === 'c' && r?.instancePath) {
      e.preventDefault()
      void actions.copy(robloxPaths(r.instancePath).dot)
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && r?.instancePath) {
      e.preventDefault()
      void actions.copy(requireExpression(r.instancePath), 'require')
    } else if (e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      filterRef.current?.focus()
    }
  }

  const headMenu = (el: HTMLElement) => {
    const ip = selected && mode === 'tree' ? selected.split('/') : null
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
          role="treeitem"
          aria-selected={selected === r.key}
          aria-expanded={r.hasChildren ? isOpen : undefined}
          className={`trow${selected === r.key ? ' sel' : ''}${active ? ' active' : ''}${r.studio || r.wally ? ' dim' : ''}${menuTarget === r.key ? ' ctx' : ''}${flashKey === r.key ? ' flash' : ''}`}
          style={{ paddingLeft: 8 + r.depth * 12 }}
          onClick={() => activate(r, true)}
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
      <div className="panel-body tree" role="tree" tabIndex={0} ref={listRef} onKeyDown={onKey}>
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
            <button className="btn ghost" onClick={() => setFilter('')}>Clear filter</button>
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

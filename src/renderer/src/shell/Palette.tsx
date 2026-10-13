// Command palette and quick open in one (SPEC §8.5). Prefix picks the mode: none = files,
// ">" = commands, "#" = instances across the game tree, ":" = go to line.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TreeNode } from '@shared/types'
import { useStore } from '../store'
import { buildCommands } from './commands'
import { fuzzy, fuzzyFields } from '../lib/fuzzy'
import { keyHint } from '../lib/format'
import { ClassIcon, FileGlyph } from '../components/ClassIcon'
import { Icon } from '../components/Icons'
import { realmOfFile, realmOfInstance, roots } from '../lib/roblox'

interface Item {
  key: string
  group: string
  icon: ReactNode
  label: string
  labelHits?: number[]
  detail?: string
  tag?: ReactNode
  keys?: string
  run: () => void
}

const RECENT_KEY = 'forge.palette.recent'

function recentCommands(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, 6)))
  } catch {
    // ignore
  }
}

function Highlight({ text, hits }: { text: string; hits?: number[] }) {
  if (!hits?.length) return <>{text}</>
  const set = new Set(hits)
  const out: ReactNode[] = []
  let run = ''
  let marked = false
  const flush = (i: number) => {
    if (!run) return
    out.push(marked ? <mark key={i}>{run}</mark> : <span key={i}>{run}</span>)
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== marked) {
      flush(i)
      marked = m
    }
    run += text[i]
  }
  flush(text.length)
  return <>{out}</>
}

function modeOf(value: string): { mode: 'files' | 'commands' | 'instances' | 'line'; query: string } {
  if (value.startsWith('>')) return { mode: 'commands', query: value.slice(1).trim() }
  if (value.startsWith('#')) return { mode: 'instances', query: value.slice(1).trim() }
  if (value.startsWith(':')) return { mode: 'line', query: value.slice(1).trim() }
  return { mode: 'files', query: value.trim() }
}

export function Palette() {
  const { state, actions } = useStore()
  const req = state.palette
  const [value, setValue] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!req) return
    setValue(req.prefix)
    setSel(0)
    requestAnimationFrame(() => input.current?.focus())
  }, [req])

  const close = () => actions.set({ palette: null })
  const { mode, query } = modeOf(value)

  const items = useMemo<Item[]>(() => {
    if (!req) return []
    if (mode === 'commands') {
      const cmds = buildCommands(state, actions)
      const recent = recentCommands()
      const toItem = (c: (typeof cmds)[number], group: string, hits?: number[]): Item => ({ key: `${group}:${c.id}`, group, icon: c.icon ?? <Icon name="chev" />, label: c.label, labelHits: hits, detail: c.detail, keys: c.keys, run: () => { rememberCommand(c.id); c.run() } })
      if (!query) {
        const rec = recent.map((id) => cmds.find((c) => c.id === id)).filter((c): c is (typeof cmds)[number] => !!c).map((c) => toItem(c, 'Recently used'))
        return [...rec, ...cmds.map((c) => toItem(c, c.group))]
      }
      return cmds
        .map((c) => ({ c, m: fuzzy(query, c.label) ?? (c.detail ? fuzzy(query, `${c.group} ${c.detail}`) && { score: 0.1, hits: [] } : null) }))
        .filter((x): x is { c: (typeof cmds)[number]; m: NonNullable<ReturnType<typeof fuzzy>> } => !!x.m)
        .sort((a, b) => b.m.score - a.m.score + (recent.includes(b.c.id) ? 2 : 0) - (recent.includes(a.c.id) ? 2 : 0))
        .slice(0, 60)
        .map(({ c, m }) => toItem(c, 'Commands', m.hits))
    }
    if (mode === 'line') {
      const n = parseInt(query, 10)
      if (!state.activeFile) return [{ key: 'noline', group: 'Go to line', icon: <Icon name="info" />, label: 'Open a script first', run: () => undefined }]
      return [{ key: 'line', group: 'Go to line', icon: <Icon name="arrowRight" />, label: Number.isFinite(n) ? `Go to line ${n}` : 'Type a line number', detail: state.activeFile, run: () => Number.isFinite(n) && void actions.openFileAt(state.activeFile!, n, 1) }]
    }
    if (mode === 'instances') {
      const out: { item: Item; score: number }[] = []
      const walk = (nodes: TreeNode[], parent: string[]) => {
        for (const n of nodes) {
          const path = [...parent, n.name]
          const dot = path.join('.')
          const m = query ? fuzzyFields(query, [{ text: n.name, weight: 3 }, { text: dot, weight: 2 }]) : { score: -path.length, field: 0, hits: [] }
          if (m) {
            const realm = n.origin === 'studio' ? 'studio' : realmOfInstance(path)
            out.push({
              score: m.score,
              item: {
                key: dot,
                group: 'Instances',
                icon: <ClassIcon className={n.className} realm={realm === 'studio' ? undefined : realm} />,
                label: n.name,
                labelHits: m.field === 0 ? m.hits : undefined,
                detail: dot,
                tag: n.origin === 'studio' ? <span className="tag studio">studio</span> : realm ? <span className={`tag ${realm}`}>{realm}</span> : undefined,
                run: () => {
                  actions.revealInstance(path)
                  if (n.filePath) void actions.openFile(n.filePath)
                }
              }
            })
          }
          walk(n.children, path)
        }
      }
      walk(roots(state.tree), [])
      return out.sort((a, b) => b.score - a.score).slice(0, 80).map((x) => x.item)
    }
    // files
    const scripts = state.scripts.flatMap((g) => g.scripts)
    const paths = new Map<string, { name: string; dot: string }>()
    for (const s of scripts) paths.set(s.path, { name: s.name, dot: s.instancePath.join('.') })
    for (const f of state.blink?.files?.map((b) => b.file).filter((x): x is string => !!x) ?? (state.blink?.file ? [state.blink.file] : [])) paths.set(f, { name: f, dot: '' })
    const fileItem = (path: string, info: { name: string; dot: string }, group: string, hits?: number[]): Item => {
      const realm = realmOfFile(path)
      return { key: `${group}:${path}`, group, icon: <FileGlyph path={path} />, label: info.name, labelHits: hits, detail: info.dot || path, tag: realm ? <span className={`tag ${realm}`}>{realm}</span> : path.endsWith('.blink') ? <span className="tag blink">blink</span> : undefined, run: () => void actions.openFile(path) }
    }
    if (!query) {
      const recent = state.recent.filter((p) => paths.has(p)).slice(0, 8)
      const rest = [...paths.entries()].filter(([p]) => !recent.includes(p)).slice(0, 40)
      return [...recent.map((p) => fileItem(p, paths.get(p)!, 'Recently opened')), ...rest.map(([p, i]) => fileItem(p, i, 'Scripts'))]
    }
    return [...paths.entries()]
      .map(([p, info]) => ({ p, info, m: fuzzyFields(query, [{ text: info.name, weight: 3 }, { text: info.dot, weight: 2 }, { text: p, weight: 1 }]) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .slice(0, 60)
      .map((x) => fileItem(x.p, x.info, 'Scripts', x.m!.field === 0 ? x.m!.hits : undefined))
  }, [req, mode, query, state, actions])

  useEffect(() => setSel(0), [value])
  useEffect(() => {
    list.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!req) return null

  const run = (i: number, keepOpen = false) => {
    const it = items[i]
    if (!it) return
    if (!keepOpen) close()
    it.run()
  }

  let lastGroup = ''
  return (
    <>
      <div className="scrim" onMouseDown={close} />
      <div className="palette palette-anim" role="dialog" aria-label="Command palette" key={req.nonce}>
        <div className="pal-in">
          <Icon name="search" />
          <input
            ref={input}
            value={value}
            placeholder={mode === 'commands' ? 'Type a command' : 'Search scripts by name, instance path or file'}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(items.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(sel, e.metaKey || e.ctrlKey)
              }
            }}
          />
          <div className="pal-modes">
            {([['', 'files'], ['>', 'cmds'], ['#', 'instances'], [':', 'line']] as const).map(([p, label]) => (
              <button key={label} className={modeOf(value).mode === (p === '' ? 'files' : p === '>' ? 'commands' : p === '#' ? 'instances' : 'line') ? 'on' : ''} onClick={() => { setValue(p + query); input.current?.focus() }} tabIndex={-1}>
                {p || '⌘P'} {label}
              </button>
            ))}
          </div>
        </div>
        <div className="pal-list" ref={list}>
          {items.length === 0 && <div className="pal-empty">{mode === 'files' ? `No scripts match “${query}”.` : mode === 'instances' ? `No instances match “${query}”.` : 'No matching commands.'}</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="pal-group">{it.group}</div> : null
            lastGroup = it.group
            return (
              <div key={it.key}>
                {head}
                <div className={`pal-item${i === sel ? ' on' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 18}ms` }} onMouseMove={() => setSel(i)} onClick={() => run(i)}>
                  <span className="pi">{it.icon}</span>
                  <span className="pl"><Highlight text={it.label} hits={it.labelHits} /></span>
                  {it.detail && <span className="pd">{it.detail}</span>}
                  <span className="pk">
                    {it.tag}
                    {it.keys && <kbd>{keyHint(it.keys)}</kbd>}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>{keyHint('mod+enter')}</kbd> run, keep open</span>
          <span style={{ marginLeft: 'auto' }}><kbd>esc</kbd> close</span>
        </div>
      </div>
    </>
  )
}

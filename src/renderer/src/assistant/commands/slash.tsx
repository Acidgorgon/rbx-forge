// Slash commands in the composer: the command list for the typeahead (built-ins + custom commands
// from main), running a command, and acting on its result (pickers for /resume, /rewind, /model;
// opening Memory). Also the command-output message.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage } from '@shared/types'
import { BUILTIN_COMMANDS, matchCommands, parseSlash, type ChatCommandInfo, type ChatCommandResult } from '@shared/chatCommands'
import type { ChatMode } from '@shared/chatModes'
import { useStore } from '../../store'
import { useMenu, type MenuEntry } from '../../components/Menu'
import { Markdown } from '../../components/Markdown'
import { Icon } from '../../components/Icons'
import { ago, errorText } from '../../lib/format'
import './modes.css'

let cache: ChatCommandInfo[] | null = null

// Built-ins right away; custom commands once main answers (refreshed each time "/" is typed).
export function useCommandList(typing: boolean): ChatCommandInfo[] {
  const [list, setList] = useState<ChatCommandInfo[]>(cache ?? BUILTIN_COMMANDS)
  useEffect(() => {
    if (!typing) return
    let live = true
    void window.harness
      .listChatCommands()
      .then((l) => {
        cache = l
        if (live) setList(l)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [typing])
  return list
}

export function slashMatches(list: ChatCommandInfo[], text: string): ChatCommandInfo[] {
  if (!text.startsWith('/') || /\s/.test(text)) return []
  return matchCommands(list, text)
}

// Commands the composer still handles itself (existing UI flows).
const COMPOSER_OWNED = new Set(['new', 'team', 'roundtable', 'agents', 'tests', 'lint', 'sync', 'restate'])

export function useSlashRunner(opts: { anchor: () => HTMLElement | null; mode: ChatMode; send: (text: string, mode?: ChatMode) => void }) {
  const { state, actions } = useStore()
  const menu = useMenu()

  const handle = useCallback(
    (id: string, r: ChatCommandResult) => {
      const a = r.action
      const el = opts.anchor()
      if (!a) return
      if (a.kind === 'openPage') return actions.openPage(a.page)
      if (a.kind === 'selectChat') return void actions.selectChat(a.id)
      if (a.kind === 'newChat') return void actions.newChat()
      if (a.kind === 'send') return opts.send(a.text, a.mode)
      if (!el) return
      if (a.kind === 'pickChat') {
        const entries: MenuEntry[] = [{ header: 'Resume a chat' }]
        if (!a.chats.length) entries.push({ label: 'No other chats yet', disabled: true })
        for (const c of a.chats)
          entries.push({
            label: c.title || 'Untitled',
            sub: `${c.model}${c.lastAt ? ` · ${ago(c.lastAt)}` : ''}`,
            onSelect: () => void actions.selectChat(c.id),
            action: { icon: <Icon name="trash" size={13} />, label: `Delete “${c.title || 'Untitled'}”`, onSelect: () => actions.askDeleteChats([c.id]) }
          })
        return menu.openAbove(el, entries, { minWidth: 320 })
      }
      if (a.kind === 'pickCheckpoint') {
        const rewind = (cp: string, what: 'both' | 'files' | 'chat') =>
          void window.harness
            .rewindChat(id, cp, what)
            .then(() => actions.selectChat(id))
            .catch((e) => actions.toast({ text: 'Could not rewind', detail: errorText(e), kind: 'err' }))
        const entries: MenuEntry[] = [{ header: 'Rewind to before…' }]
        for (const c of a.checkpoints)
          entries.push({
            label: c.label,
            sub: ago(c.at),
            submenu: [
              { label: 'Files and conversation', sub: 'restore both', onSelect: () => rewind(c.id, 'both') },
              { label: 'Conversation only', sub: 'files stay as they are', onSelect: () => rewind(c.id, 'chat') },
              { label: 'Files only', sub: 'keep the conversation', onSelect: () => rewind(c.id, 'files') }
            ]
          })
        return menu.openAbove(el, entries, { minWidth: 320 })
      }
      if (a.kind === 'pickModel') {
        const entries: MenuEntry[] = [{ header: 'Model for this chat' }]
        for (const p of state.providers ?? []) {
          if (!p.ready || !p.models.length) continue
          entries.push({ label: p.label, submenu: p.models.slice(0, 30).map((model) => ({ label: model, onSelect: () => void actions.chooseModel({ provider: p.id, model }) })) })
        }
        if (entries.length === 1) entries.push({ label: 'No provider is set up', sub: 'Settings → Providers', onSelect: () => actions.openSettings() })
        return menu.openAbove(el, entries, { minWidth: 260 })
      }
    },
    [state.providers, opts]
  )

  // true when the text was a command handled here (the composer clears and stops).
  const run = (text: string): boolean => {
    const cmd = parseSlash(text)
    if (!cmd || COMPOSER_OWNED.has(cmd.name)) return false
    void (async () => {
      let id: string
      try {
        id = await actions.ensureChat()
      } catch (e) {
        return actions.toast({ text: 'Could not start a chat', detail: errorText(e), kind: 'err' })
      }
      try {
        const r = await window.harness.runChatCommand(id, cmd.name, cmd.args)
        handle(id, r)
      } catch (e) {
        actions.toast({ text: `/${cmd.name} failed`, detail: errorText(e), kind: 'err' })
      }
    })()
    return true
  }

  // Portalled: the composer sits in a transformed panel, which would offset a fixed menu.
  return { run, node: menu.node ? createPortal(menu.node, document.body) : null }
}

// Output of a slash command (role system + command): a quiet box, never sent to a model.
export function CommandOutput({ m }: { m: ChatMessage }) {
  return (
    <div className="cm-out selectable">
      <div className="cm-out-head">
        <code>{m.command}</code>
      </div>
      <Markdown text={m.text} />
    </div>
  )
}

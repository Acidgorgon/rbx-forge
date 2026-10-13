// Group chat UI: the participants bar (host + guest chips, add model, roundtable), speaker heads on
// messages, the plan and checklist cards, and @mention suggestions for the composer.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ChatSession, GroupParticipant, ModelChoice, Speaker } from '@shared/types'
import { makeParticipant, modelAlias, modelLabel } from '@shared/modelResolve'
import { useStore } from '../store'
import { InlineMarkdown, Markdown } from '../components/Markdown'
import { ModelPicker, ProviderMark } from '../components/ModelPicker'
import { IconCheck, IconClose, IconCopy, IconList, IconPlus, IconRound } from '../components/Icons'
import './groupchat.css'

const ACCENTS = 6

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function useActiveChat(): ChatSession | undefined {
  const { state } = useStore()
  return state.chats.find((c) => c.id === state.activeChatId)
}

// Host first, then guests.
export function participants(chat: ChatSession | undefined): GroupParticipant[] {
  if (!chat) return []
  const host = makeParticipant({ provider: chat.provider, model: chat.model }, 'host')
  return [host, ...(chat.guests ?? [])]
}

// Accent index (0..5): by seat in the chat, so participants never share a colour; a speaker who
// left falls back to a hash.
export function accentOf(chat: ChatSession | undefined, s: Pick<Speaker, 'provider' | 'model'>): number {
  const i = participants(chat).findIndex((p) => p.provider === s.provider && p.model === s.model)
  return (i >= 0 ? i : hash(`${s.provider}/${s.model}`)) % ACCENTS
}

export function isGroup(chat: ChatSession | undefined): boolean {
  return !!chat?.guests?.length
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

function Avatar({ s, accent, size = 20 }: { s: Pick<Speaker, 'provider'>; accent: number; size?: number }) {
  return (
    <span className={`gc-avatar gc-a${accent}`} style={{ width: size + 4, height: size + 4 }}>
      <ProviderMark id={s.provider} size={size} />
    </span>
  )
}

export function SpeakerHead({ s, host, chat }: { s: Speaker; host?: boolean; chat?: ChatSession }) {
  const accent = accentOf(chat, s)
  return (
    <div className="gc-head">
      <Avatar s={s} accent={accent} size={18} />
      <span className={`gc-name gc-t${accent}`}>{s.label}</span>
      {host && <span className="gc-role">host</span>}
    </div>
  )
}

// ---------------------------------------------------------------- participants bar

function RoundtablePop({ onClose, guestTools }: { onClose: () => void; guestTools: boolean }) {
  const { actions } = useStore()
  const [topic, setTopic] = useState('')
  const [rounds, setRounds] = useState(2)
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    input.current?.focus()
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  const start = () => {
    if (!topic.trim()) return
    void actions.startRoundtable(topic.trim(), rounds)
    onClose()
  }
  return (
    <div className="gc-pop" ref={ref} role="dialog" aria-label="Start a roundtable">
      <div className="gc-pop-title">Roundtable</div>
      <div className="gc-pop-sub">Every model takes a turn on the topic, then the host writes a plan.</div>
      <textarea
        ref={input}
        className="gc-topic"
        rows={3}
        placeholder="e.g. How should we save player data?"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
        }}
      />
      <div className="gc-pop-row">
        <span className="gc-pop-label">Rounds</span>
        <div className="gc-seg" role="radiogroup">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rounds === n} className={rounds === n ? 'on' : ''} onClick={() => setRounds(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <label className="gc-check">
        <input type="checkbox" checked={guestTools} onChange={(e) => void actions.setGuestTools(e.target.checked)} />
        Guests can read project files
      </label>
      <div className="gc-pop-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={start} disabled={!topic.trim()}>
          Start
        </button>
      </div>
    </div>
  )
}

export function ParticipantsBar({ compact }: { compact?: boolean }) {
  const { state, actions } = useStore()
  const chat = useActiveChat()
  const [rt, setRt] = useState(false)
  const busy = chat ? !!state.busy[chat.id] : false
  const host: ModelChoice | null = chat ? { provider: chat.provider, model: chat.model } : state.pendingModel ?? state.defaultModel
  if (!host) return null
  const people = chat ? participants(chat) : [makeParticipant(host, 'host')]
  const usage = chat?.usage ?? []
  const used = (p: GroupParticipant) => usage.find((u) => u.provider === p.provider && u.model === p.model)
  const group = people.length > 1

  return (
    <div className={`gc-bar${compact ? ' compact' : ''}`}>
      <div className="gc-chips">
        {people.map((p) => {
          const u = used(p)
          const accent = chat ? accentOf(chat, p) : 0
          const tip = `${p.label} (@${p.alias}) · ${p.provider}/${p.model}${p.role === 'host' ? ' · host, edits files' : ' · read-only adviser'}${u ? `\n${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${u.calls} call${u.calls === 1 ? '' : 's'}` : ''}`
          return (
            <span key={`${p.provider}/${p.model}`} className={`gc-chip${p.role === 'host' ? ' host' : ''}`} title={tip}>
              <span className={`gc-dot gc-a${accent}`} />
              <ProviderMark id={p.provider} size={15} />
              <span className="gc-chip-name">{p.label}</span>
              {p.role === 'host' && group && <span className="gc-role">host</span>}
              {p.role === 'guest' && (
                <button type="button" className="gc-x" aria-label={`Remove ${p.label}`} onClick={() => void actions.removeGuest(p.alias)} disabled={busy}>
                  <IconClose size={11} />
                </button>
              )}
            </span>
          )
        })}
        <ModelPicker
          value={null}
          providers={state.providers}
          onChange={(c) => void actions.addGuest(c)}
          onAddKey={(id) => actions.openSettings(id)}
          direction="down"
          placeholder={group ? 'Add' : 'Add a model'}
          icon={<IconPlus size={13} />}
          disabled={busy}
        />
      </div>
      <div className="gc-tail">
        {group && (
          <div className="gc-rt-wrap">
            <button type="button" className="gc-rt" onClick={() => setRt(!rt)} disabled={busy} title="Models take turns on a topic, then the host writes a plan">
              <IconRound size={13} />
              Roundtable
            </button>
            {rt && <RoundtablePop onClose={() => setRt(false)} guestTools={chat?.guestTools !== false} />}
          </div>
        )}
      </div>
    </div>
  )
}

// Total tokens of a group chat, for the header; per-model numbers in the tooltip.
export function GroupTokens() {
  const chat = useActiveChat()
  const usage = chat?.usage ?? []
  if (!isGroup(chat) || !usage.length) return null
  const total = usage.reduce((n, u) => n + u.input + u.output, 0)
  return (
    <span className="gc-total" title={usage.map((u) => `${u.label}: ${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${u.calls} call${u.calls === 1 ? '' : 's'}`).join('\n')}>
      {fmtTokens(total)} tokens
    </span>
  )
}

// ---------------------------------------------------------------- cards

export function PlanCard({ m }: { m: ChatMessage }) {
  const { actions } = useStore()
  const chat = useActiveChat()
  const accent = m.speaker ? accentOf(chat, m.speaker) : 0
  return (
    <div className={`gc-card plan gc-b${accent}`}>
      <div className="gc-card-head">
        <span className="gc-card-kind">
          <IconList size={13} /> Plan
        </span>
        {m.speaker && (
          <span className="gc-card-by">
            synthesized by <b className={`gc-t${accent}`}>{m.speaker.label}</b>
          </span>
        )}
      </div>
      <div className="gc-card-body">
        <Markdown text={m.text} />
      </div>
      <div className="gc-card-actions">
        <button type="button" className="btn" onClick={() => void actions.copy(m.text, 'the plan')}>
          <IconCopy size={13} /> Copy
        </button>
        <button type="button" className="btn" onClick={() => void actions.planToChecklist(m.id)}>
          <IconCheck size={13} /> Make this a task list
        </button>
      </div>
    </div>
  )
}

export function ChecklistCard({ m }: { m: ChatMessage }) {
  const items = useMemo(
    () =>
      m.text
        .split('\n')
        .map((l) => /^\s*- \[( |x|X)\]\s+(.*)$/.exec(l))
        .filter((x): x is RegExpExecArray => !!x)
        .map((x) => ({ text: x[2], done: x[1] !== ' ' })),
    [m.text]
  )
  const [done, setDone] = useState<boolean[]>(() => items.map((i) => i.done))
  const count = done.filter(Boolean).length
  return (
    <div className="gc-card checklist">
      <div className="gc-card-head">
        <span className="gc-card-kind">
          <IconCheck size={13} /> Tasks
        </span>
        <span className="gc-card-by">
          {count}/{items.length} done
        </span>
      </div>
      <ul className="gc-tasks">
        {items.map((it, i) => (
          <li key={i} className={done[i] ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={!!done[i]} onChange={() => setDone((d) => d.map((v, j) => (j === i ? !v : v)))} />
              <span className="md"><InlineMarkdown text={it.text} /></span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- @mentions

export interface MentionOption {
  alias: string
  label: string
  provider: Speaker['provider']
  model: string
  // In the chat already (host or guest); otherwise mentioning it invites it.
  member: boolean
  host?: boolean
}

// "@que" right before the caret, or null.
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([\w.\-]*)$/.exec(text.slice(0, caret))
  if (!m) return null
  return { start: caret - m[2].length - 1, query: m[2].toLowerCase() }
}

export function useMentionOptions(query: string | null): MentionOption[] {
  const { state } = useStore()
  const chat = useActiveChat()
  return useMemo(() => {
    if (query === null) return []
    const people = participants(chat)
    const out: MentionOption[] = people.map((p) => ({ alias: p.alias, label: p.label, provider: p.provider, model: p.model, member: true, host: p.role === 'host' }))
    const taken = new Set(out.map((o) => `${o.provider}/${o.model}`))
    for (const p of state.providers ?? []) {
      if (!p.ready) continue
      for (const model of p.models) {
        if (taken.has(`${p.id}/${model}`)) continue
        out.push({ alias: modelAlias(model), label: modelLabel(model), provider: p.id, model, member: false })
      }
    }
    const q = query.toLowerCase()
    const hit = (o: MentionOption) => !q || o.alias.startsWith(q) || o.label.toLowerCase().includes(q) || o.model.toLowerCase().includes(q)
    const members = out.filter((o) => o.member && hit(o))
    // Guests first: mentioning the host is rarely what you want.
    members.sort((a, b) => Number(!!a.host) - Number(!!b.host))
    return [...members, ...out.filter((o) => !o.member && hit(o)).slice(0, Math.max(0, 7 - members.length))]
  }, [query, chat, state.providers])
}

export function MentionMenu({ options, index, onPick }: { options: MentionOption[]; index: number; onPick: (o: MentionOption) => void }) {
  const chat = useActiveChat()
  if (!options.length) return null
  return (
    <div className="gc-mentions" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {options.map((o, i) => {
        const accent = o.member ? accentOf(chat, o) : hash(`${o.provider}/${o.model}`) % ACCENTS
        const firstOther = !o.member && (i === 0 || options[i - 1].member)
        return (
          <div key={`${o.provider}/${o.model}`}>
            {firstOther && <div className="gc-mentions-sep">Invite another model</div>}
            <button type="button" role="option" aria-selected={i === index} className={`gc-mention${i === index ? ' sel' : ''}`} onClick={() => onPick(o)}>
              <span className={`gc-dot gc-a${accent}`} />
              <ProviderMark id={o.provider} size={15} />
              <span className="gc-mention-label">{o.label}</span>
              <span className="gc-alias">@{o.alias}</span>
              {o.host && <span className="gc-role">host</span>}
              {!o.member && <span className="gc-mention-model">{o.provider}/{o.model}</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}

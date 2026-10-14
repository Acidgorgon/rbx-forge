// Assistant panel (SPEC §7.5) in the terminal style: model / mode pills, usage meter, compact
// messages (no avatars), group chat, orchestrator task board, and the "> Type a message" composer.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useChatDraft, useChatScroll, rememberChatScroll } from '../qol/chatSession'
import type { BoardView, ChatImage, ChatMessage, OrchestrateMode, TaskView } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { ModelPicker } from '../components/ModelPicker'
import { useMenu, type MenuEntry } from '../components/Menu'
import { ChecklistCard, GroupTokens, isGroup, MentionMenu, mentionQuery, ParticipantsBar, PlanCard, SpeakerHead, useActiveChat, useMentionOptions, type MentionOption } from './GroupChat'
import { useProblems } from '../shell/problems'
import { ago, fmtTokens, fmtUsd, keyHint, errorText } from '../lib/format'
import { basename, scriptsFlat } from '../lib/roblox'
import { MemoryProposals } from '../pages/memory/MemoryProposals'
import { addImageFile, MAX_IMAGES_PER_MESSAGE, onAttachRequest } from './attachments'
import { AttachGlyph, ImageThumb, MessageImages } from './ChatImages'
import { EffortPicker, RouteSummary, useVision } from './EffortPicker'
import { acceptedImageType } from './imageScale'
import { RestateMessage } from './RestateMessage'
import { ConclusionCard, PatchCard, ReviewCard, SettingsNotice, splitStance, StancePill } from './GroupCards'
import './chatextras.css'
import { ModeBadge, ModePill, cycleMode, useChatMode } from './commands/ModePill'
import { PlanModeCard } from './commands/PlanModeCard'
import { DiffCard } from './commands/DiffCard'
import { CommandOutput, slashMatches, useCommandList, useSlashRunner } from './commands/slash'

type Item = { kind: 'msg'; m: ChatMessage } | { kind: 'tools'; ms: ChatMessage[]; id: string }

export function groupMessages(messages: ChatMessage[]): Item[] {
  const out: Item[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      const last = out[out.length - 1]
      if (last && last.kind === 'tools' && last.ms[0].agentId === m.agentId && last.ms[0].speaker?.model === m.speaker?.model) last.ms.push(m)
      else out.push({ kind: 'tools', ms: [m], id: m.id })
    } else out.push({ kind: 'msg', m })
  }
  return out
}

function ToolRow({ m, running }: { m: ChatMessage; running?: boolean }) {
  const [open, setOpen] = useState(false)
  const failed = /^(error|failed)\b/i.test(m.text.trim())
  const body = m.text.trim()
  return (
    <div className={`tool${open ? ' open' : ''}`}>
      <button className="tool-head" onClick={() => body && setOpen(!open)} title={m.tool ? `${m.tool.name} ${m.tool.input}` : undefined}>
        {running ? <span className="spinner" /> : failed ? <Icon name="x" size={12} className="tool-bad" /> : <Icon name="check" size={12} className="tool-ok" />}
        <span className="tool-name">{m.tool?.name ?? 'tool'}</span>
        <span className="tool-input">{m.tool?.input}</span>
      </button>
      {open && <pre className="tool-body selectable">{body}</pre>}
    </div>
  )
}

export function ToolGroup({ ms, last, busy }: { ms: ChatMessage[]; last: boolean; busy: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const shown = ms.length > 4 && !expanded ? ms.slice(-2) : ms
  return (
    <div className="tools">
      {ms[0].agentId !== 'main' && <AgentTag id={ms[0].agentId} />}
      {ms.length > 4 && !expanded && (
        <button className="tool-more" onClick={() => setExpanded(true)}>
          <Icon name="chev" size={11} /> {ms.length} tool calls
        </button>
      )}
      {shown.map((m, i) => (
        <ToolRow key={m.id} m={m} running={busy && last && i === shown.length - 1} />
      ))}
    </div>
  )
}

function AgentTag({ id }: { id: string }) {
  const { state, actions } = useStore()
  const agent = state.agents.find((a) => a.id === id)
  return (
    <button className="agent-tag" title={agent?.scenario} onClick={() => actions.openTranscript(id, agent ? `Agent: ${agent.scenario.slice(0, 24)}` : 'Agent')}>
      <Icon name="bot" size={12} /> agent {agent ? `· ${agent.state}` : ''}
    </button>
  )
}

export function Message({ m }: { m: ChatMessage }) {
  const chat = useActiveChat()
  if (m.role === 'user') {
    return (
      <div className="m-user">
        <span className="m-who">you{m.mode && <ModeBadge mode={m.mode} />}</span>
        <div className="m-body">
          {m.text && <div className="m-text selectable">{m.text}</div>}
          {m.images?.length ? <MessageImages images={m.images} size="sm" /> : null}
        </div>
      </div>
    )
  }
  if (m.command) return <CommandOutput m={m} />
  if (m.role === 'system') return m.settingsLink ? <SettingsNotice m={m} /> : <div className="m-system selectable">{m.text}</div>
  if (m.planMode) return <PlanModeCard m={m} />
  if (m.diff) return <DiffCard m={m} />
  if (m.card === 'plan') return <PlanCard m={m} />
  if (m.card === 'checklist') return <ChecklistCard m={m} />
  if (m.card === 'restate' && m.restate) return <RestateMessage m={m} />
  if (m.card === 'conclusion' && m.conclusion) return <ConclusionCard m={m} />
  if (m.card === 'patch' && m.patch) return <PatchCard m={m} />
  if (m.card === 'review' && m.review) return <ReviewCard m={m} />
  const fromAgent = m.agentId && m.agentId !== 'main'
  const host = !!chat && !!m.speaker && m.speaker.provider === chat.provider && m.speaker.model === chat.model
  const st = m.speaker && isGroup(chat) ? splitStance(m.text) : { text: m.text, stance: null }
  return (
    <div className="m-assistant selectable">
      {fromAgent && <AgentTag id={m.agentId} />}
      {m.speaker && isGroup(chat) && <SpeakerHead s={m.speaker} host={host} chat={chat} />}
      {st.text && <Markdown text={st.text} />}
      {st.stance && <StancePill stance={st.stance} />}
      {m.images?.length ? <MessageImages images={m.images} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------- orchestrator board

const TASK_ICON: Record<TaskView['state'], string> = { queued: '○', running: '◐', blocked: '◌', done: '●', failed: '×', cancelled: '–' }

function Board({ b }: { b: BoardView }) {
  const { actions } = useStore()
  const [open, setOpen] = useState(b.state !== 'done' && b.state !== 'cancelled')
  const live = b.state === 'planning' || b.state === 'running' || b.state === 'integrating'
  const done = b.tasks.filter((t) => t.state === 'done').length
  return (
    <div className={`board ${b.state}`}>
      <button className="board-head" onClick={() => setOpen(!open)}>
        {live ? <span className="lav-dot pulse" /> : <span className={`led ${b.state === 'done' ? 'ok' : b.state === 'failed' ? 'err' : 'idle'}`} />}
        <span className="grow ellipsis">team · {b.request}</span>
        <span className="faint">{done}/{b.tasks.length}</span>
        <Icon name={open ? 'chevDown' : 'chev'} size={12} />
      </button>
      {open && (
        <>
          <div className="board-meta">
            <span>{b.state}{b.detail ? ` · ${b.detail}` : ''}</span>
            <span>round {b.round}</span>
            <span>{fmtTokens(b.tokens)} · {fmtUsd(b.costUsd)}</span>
            {live && (
              <button className="link-btn" onClick={() => void window.harness.cancelOrchestration(b.runId)}>cancel run</button>
            )}
          </div>
          {b.tasks.map((t) => (
            <div key={t.id} className={`task ${t.state}`} onClick={() => actions.openTranscript(`orch:${b.runId}:${t.id}`, `${t.role}: ${t.goal.slice(0, 28)}`)} title={`${t.goal}\n${t.model}${t.detail ? `\n${t.detail}` : ''}${t.summary ? `\n\n${t.summary}` : ''}`}>
              <span className="task-st">{t.state === 'running' ? <span className="spinner" /> : TASK_ICON[t.state]}</span>
              <span className="task-role">{t.role}</span>
              <span className="grow ellipsis">{t.goal}</span>
              {t.filesChanged.length > 0 && <span className="faint">{t.filesChanged.length}f</span>}
              <span className="faint">{fmtTokens(t.tokens)}</span>
              {(t.state === 'running' || t.state === 'queued' || t.state === 'blocked') && (
                <button
                  className="icon-btn"
                  style={{ width: 18, height: 18 }}
                  title="Cancel task"
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.harness.cancelOrchestrationTask(b.runId, t.id)
                  }}
                >
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
          ))}
          {b.changeRequests.length > 0 && (
            <div className="board-cr">
              {b.changeRequests.length} change request{b.changeRequests.length === 1 ? '' : 's'}: {b.changeRequests.map((c) => basename(c.file)).join(', ')}
            </div>
          )}
          {b.answer && (
            <div className="board-answer">
              <Markdown text={b.answer} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- composer

const MODES: { id: OrchestrateMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'auto routing', hint: 'Assistant decides when to split work across a team' },
  { id: 'single', label: 'single agent', hint: 'One agent does the whole turn' },
  { id: 'team', label: 'team mode', hint: 'A lead plans and specialists build, test and review in parallel' }
]


let handledInsert = 0

export function Composer({ mode, setMode }: { mode: OrchestrateMode; setMode: (m: OrchestrateMode) => void }) {
  const { state, actions } = useStore()
  const id = state.activeChatId
  const busy = id ? !!state.busy[id] : false
  const activeChat = useActiveChat()
  const vision = useVision(activeChat ? { provider: activeChat.provider, model: activeChat.model } : state.pendingModel ?? state.defaultModel)
  const [images, setImages] = useState<ChatImage[]>([])
  const [adding, setAdding] = useState(0)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const visionHint = 'This model cannot read images; pick a vision model to attach one'

  const addFiles = async (files: File[]) => {
    const list = files.filter((f) => acceptedImageType(f.type))
    if (!list.length) {
      if (files.length) actions.toast({ text: 'Only PNG, JPEG, WebP and GIF images can be attached', kind: 'err' })
      return
    }
    if (!vision) {
      actions.toast({ text: visionHint, kind: 'err' })
      return
    }
    const room = MAX_IMAGES_PER_MESSAGE - images.length
    if (room <= 0) {
      actions.toast({ text: `At most ${MAX_IMAGES_PER_MESSAGE} images per message`, kind: 'err' })
      return
    }
    setAdding((n) => n + Math.min(room, list.length))
    for (const f of list.slice(0, room)) {
      try {
        const ref = await addImageFile(f)
        setImages((cur) => (cur.length < MAX_IMAGES_PER_MESSAGE ? [...cur, ref] : cur))
      } catch (e) {
        actions.toast({ text: 'Could not attach the image', detail: errorText(e), kind: 'err' })
      } finally {
        setAdding((n) => Math.max(0, n - 1))
      }
    }
  }

  // Images attached from elsewhere (the Art page's "Send to chat").
  useEffect(
    () =>
      onAttachRequest((ref) => {
        actions.toggleRight(true)
        setImages((cur) => (cur.some((i) => i.id === ref.id) || cur.length >= MAX_IMAGES_PER_MESSAGE ? cur : [...cur, ref]))
      }),
    []
  )

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (!files.length) return
    e.preventDefault()
    void addFiles(files)
  }
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = vision ? 'copy' : 'none'
    setDragging(true)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragging(false)
    void addFiles([...e.dataTransfer.files])
  }
  const problems = useProblems()
  const [text, setText] = useState('')
  useChatDraft(id, text, setText)
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const [fileChip, setFileChip] = useState(true)
  const [probChip, setProbChip] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const mq = mentionQuery(text, caret)
  const models = useMentionOptions(mq && closedAt !== mq.start ? mq.query : null)
  const files = useMemo(() => {
    if (!mq || closedAt === mq.start) return []
    const q = mq.query
    return scriptsFlat(state.scripts)
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
      .slice(0, 6)
  }, [mq?.query, mq?.start, closedAt, state.scripts])
  const groupChat = isGroup(useActiveChat())
  const options: ({ kind: 'model'; o: MentionOption } | { kind: 'file'; path: string; name: string })[] = [
    ...(groupChat ? models.map((o) => ({ kind: 'model' as const, o })) : []),
    ...files.map((s) => ({ kind: 'file' as const, path: s.path, name: s.name }))
  ]
  // Chat mode (Ask / Plan / Edit / Auto) and slash commands (built-ins + custom, commands/slash.tsx).
  const chatMode = useChatMode()
  const commandList = useCommandList(text.startsWith('/') && !/\s/.test(text))
  const slash = slashMatches(commandList, text)
  const slashRunner = useSlashRunner({ anchor: () => ref.current, mode: chatMode.mode, send: (t, m) => void actions.send(t, [], m ? { mode: m } : {}) })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(Math.max(el.scrollHeight, 22), 220) + 'px'
  }, [text])

  useEffect(() => {
    const ins = state.composerInsert
    if (!ins || ins.nonce === handledInsert) return
    handledInsert = ins.nonce
    setText((t) => (t && !/\s$/.test(t) ? t + ' ' : t) + ins.text)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    })
  }, [state.composerInsert])

  useEffect(() => {
    if (state.layout.rightOpen) requestAnimationFrame(() => ref.current?.focus())
  }, [state.activeChatId, state.layout.rightOpen])

  const insertAt = (start: number, value: string) => {
    const next = text.slice(0, start) + value + text.slice(caret)
    const pos = start + value.length
    setText(next)
    setCaret(pos)
    setPick(0)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = pos
    })
  }

  const choose = (i: number) => {
    const opt = options[i]
    if (!opt || !mq) return
    if (opt.kind === 'model') {
      const clash = !opt.o.member && models.some((x) => x !== opt.o && x.alias === opt.o.alias)
      insertAt(mq.start, `@${clash ? opt.o.model : opt.o.alias} `)
    } else insertAt(mq.start, `\`${opt.path}\` `)
  }

  const submit = () => {
    let t = text.trim()
    if ((!t && !images.length) || busy || adding) return
    if (!t) {
      const sent = images
      setImages([])
      return void actions.send('', vision ? sent : [])
    }
    const [cmd, ...rest] = t.split(/\s+/)
    const arg = rest.join(' ')
    // /ask and /plan: this one message in that mode; other Forge commands run in main.
    if ((cmd.toLowerCase() === '/ask' || cmd.toLowerCase() === '/plan') && arg) {
      setText('')
      const sent = vision ? images : []
      setImages([])
      return void actions.send(arg, sent, { mode: cmd.toLowerCase() === '/ask' ? 'ask' : 'plan' })
    }
    if (slashRunner.run(t)) return setText('')
    switch (cmd.toLowerCase()) {
      case '/new':
        setText('')
        return void actions.newChat()
      case '/team':
        if (!arg) return
        setText('')
        return void actions.startOrchestration(arg)
      case '/roundtable':
        if (!arg) return
        setText('')
        return void actions.startRoundtable(arg, 2)
      case '/agents':
        setText('')
        if (!arg) return actions.showSide('tests')
        return void window.harness.runAgents([arg], state.pendingModel ?? undefined).then(() => actions.showSide('tests')).catch((e) => actions.toast({ text: 'Agents could not start', detail: errorText(e), kind: 'err' }))
      case '/tests':
        setText('')
        return void actions.runTests({ scope: { kind: 'all' } })
      case '/lint':
        setText('')
        return void actions.runLint()
      case '/sync':
        setText('')
        return void window.harness.syncNow().then((git) => actions.set({ git }))
    }
    const extras: string[] = []
    if (fileChip && state.activeFile) extras.push(`Current file: \`${state.activeFile}\``)
    if (probChip && problems.length) extras.push(`Problems:\n${problems.slice(0, 20).map((p) => `- ${p.path}:${p.line}:${p.col} ${p.severity}: ${p.message.split('\n')[0]} (${p.source})`).join('\n')}`)
    if (extras.length) t += `\n\n${extras.join('\n')}`
    setText('')
    setProbChip(false)
    const sent = vision ? images : []
    setImages([])
    if (mode === 'team' && !id && !sent.length) void actions.startOrchestration(t)
    else void actions.send(t, sent, chatMode.pendingMode ? { mode: chatMode.pendingMode } : {})
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const listLen = slash.length || (mq ? options.length : 0)
    if (listLen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : listLen - 1)) % listLen)
        return
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        if (slash.length) insertAt(0, `/${slash[Math.min(pick, slash.length - 1)].name} `)
        else choose(Math.min(pick, options.length - 1))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !(e.metaKey || e.ctrlKey) && mq && options.length) {
        e.preventDefault()
        choose(Math.min(pick, options.length - 1))
        return
      }
      if (e.key === 'Escape' && mq) {
        e.preventDefault()
        e.stopPropagation()
        setClosedAt(mq.start)
        return
      }
    }
    // Shift+Tab cycles the chat mode (Ask -> Plan -> Edit -> Auto); routing has its own pill.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      cycleMode(chatMode.mode, chatMode.setMode)
      return
    }
    // ⌘↵ sends; Enter is a newline (it is a code tool).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]

  return (
    <div className="composer">
      {(slash.length > 0 || (mq && options.length > 0)) && (
        <div className="cmp-pop" onMouseDown={(e) => e.preventDefault()}>
          {slash.length > 0
            ? slash.map((c, i) => (
                <button key={c.name} className={`cmp-opt${i === pick ? ' on' : ''}`} onClick={() => insertAt(0, `/${c.name} `)}>
                  <span className="cm-opt-name">/{c.name}</span>
                  {c.args && <span className="cm-opt-args">{c.args}</span>}
                  <span className="faint ellipsis">{c.description}</span>
                  {c.source && c.source !== 'builtin' && <span className="cm-opt-src">{c.source}</span>}
                </button>
              ))
            : (
              <>
                {groupChat && models.length > 0 && <MentionMenu options={models} index={pick < models.length ? pick : -1} onPick={(o) => choose(models.indexOf(o))} />}
                {files.map((f, i) => {
                  const idx = (groupChat ? models.length : 0) + i
                  return (
                    <button key={f.path} className={`cmp-opt${idx === pick ? ' on' : ''}`} onClick={() => choose(idx)}>
                      <Icon name="file" size={12} />
                      <span>{f.name}</span>
                      <span className="faint ellipsis">{f.path}</span>
                    </button>
                  )
                })}
              </>
            )}
        </div>
      )}
      <div className={`cmp-box${dragging ? ' drop' : ''}`} onClick={() => ref.current?.focus()} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {(images.length > 0 || adding > 0) && (
          <div className="cmp-images">
            {images.map((img) => (
              <ImageThumb key={img.id} img={img} size="sm" onRemove={() => setImages((cur) => cur.filter((i) => i.id !== img.id))} />
            ))}
            {Array.from({ length: adding }, (_, i) => (
              <span key={`adding-${i}`} className="ci-thumb ci-sm"><span className="ci-loading" /></span>
            ))}
            {!vision && images.length > 0 && <span className="cmp-img-warn">{visionHint}</span>}
          </div>
        )}
        {(state.activeFile || problems.length > 0) && (
          <div className="cmp-chips">
            {state.activeFile && fileChip && (
              <span className="cmp-chip" title={state.activeFile}>
                <Icon name="file" size={11} /> {basename(state.activeFile)}
                <button aria-label="Remove file context" onClick={(e) => (e.stopPropagation(), setFileChip(false))}><Icon name="x" size={10} /></button>
              </span>
            )}
            {state.activeFile && !fileChip && (
              <button className="cmp-chip off" onClick={(e) => (e.stopPropagation(), setFileChip(true))}>
                <Icon name="plus" size={10} /> {basename(state.activeFile)}
              </button>
            )}
            {problems.length > 0 && (
              <button className={`cmp-chip${probChip ? '' : ' off'}`} onClick={(e) => (e.stopPropagation(), setProbChip(!probChip))} title="Attach the problem list">
                <Icon name={probChip ? 'check' : 'plus'} size={10} /> {problems.length} problem{problems.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}
        <div className="cmp-line">
          <span className="cmp-prompt">&gt;</span>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={busy ? 'working…' : 'Type a message, / for commands, @ for files'}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setPick(0)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKey}
            onPaste={onPaste}
            spellCheck={false}
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              void addFiles(files)
            }}
          />
          <span className="cmp-attach-wrap" title={vision ? 'Attach images (or paste / drop them)' : visionHint}>
            <button
              type="button"
              className="cmp-attach"
              aria-label="Attach images"
              disabled={!vision || busy || images.length >= MAX_IMAGES_PER_MESSAGE}
              onClick={(e) => {
                e.stopPropagation()
                fileInput.current?.click()
              }}
            >
              <AttachGlyph size={14} />
            </button>
          </span>
          {busy ? (
            <button className="cmp-send" onClick={() => void actions.stop()} title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button className="cmp-send" onClick={submit} disabled={(!text.trim() && !images.length) || adding > 0} title={`Send (${keyHint('mod+enter')})`}>
              <Icon name="upload" size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="cmp-hint" title={modeInfo.hint}>
        <span className="cmp-hint-l">
          <ModePill mode={chatMode.mode} setMode={chatMode.setMode} />
          <span className="cm-cycle" title={`Shift+Tab cycles the chat mode · routing: ${modeInfo.label}`}>
            <span className="kc">Shift</span>+<span className="kc">Tab</span>
          </span>
        </span>
        <span className="kc cmp-send-kc" title="Send">{keyHint('mod+enter')}</span>
      </div>
      {slashRunner.node}
    </div>
  )
}

// ---------------------------------------------------------------- panel

function Meter() {
  const { state } = useStore()
  const chat = useActiveChat()
  const snap = state.usage.chat
  const t = snap?.totals
  const live = snap?.live
  const tokens = (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0) + (live ? live.input + live.output : 0)
  const cost = (t?.costUsd ?? 0) + (live?.costUsd ?? 0)
  const fraction = Math.min(1, snap?.budget?.fraction ?? 0)
  const level = snap?.budget?.level ?? 'ok'
  const route = snap?.route ?? chat?.route
  if (!chat) return null
  return (
    <div className={`meter ${level}`} title={`${snap?.budget?.reason ?? 'Within budget'}${route ? `\nLast turn: ${route.tier} model · ${route.reason}` : ''}${t?.unpricedRequests ? `\nCost partly unknown (${t.unpricedRequests} unpriced requests)` : ''}\nToday: ${fmtUsd(state.usage.day?.totals.costUsd ?? 0)}`}>
      <span>budget</span>
      <span className="meter-bar"><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
      <span>{fmtTokens(tokens)} · {fmtUsd(cost)}{t?.unpricedRequests ? '+' : ''}</span>
      {chat.route ? <RouteSummary chat={chat} /> : route && route.tier !== 'chosen' && <span className="tag">{route.tier}</span>}
      <GroupTokens />
    </div>
  )
}

export function AssistantPanel() {
  const { state, actions } = useStore()
  const menu = useMenu()
  const chat = useActiveChat()
  const id = state.activeChatId
  const messages = useMemo(() => (id ? state.messages[id] ?? [] : []), [id, state.messages])
  const busy = id ? !!state.busy[id] : false
  const items = useMemo(() => groupMessages(messages), [messages])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [mode, setModeState] = useState<OrchestrateMode>('auto')
  const pendingMode = useRef<OrchestrateMode | null>(null)
  const choice = chat ? { provider: chat.provider, model: chat.model } : state.pendingModel ?? state.defaultModel
  const boards = state.boards.filter((b) => (chat?.orchestrations ? chat.orchestrations.includes(b.runId) : false))
  const noProvider = !!state.providers && state.providers.length > 0 && !state.providers.some((p) => p.ready)
  const problems = useProblems()

  useEffect(() => {
    if (!id) return
    if (pendingMode.current) {
      const m = pendingMode.current
      pendingMode.current = null
      void window.harness.setOrchestrateMode(id, m).catch(() => undefined)
      return
    }
    void window.harness.getOrchestrateMode(id).then(setModeState).catch(() => undefined)
  }, [id])

  const setMode = (m: OrchestrateMode) => {
    setModeState(m)
    if (id) void window.harness.setOrchestrateMode(id, m).catch((e) => actions.toast({ text: 'Could not change the mode', detail: errorText(e), kind: 'err' }))
    else pendingMode.current = m
  }

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, busy, boards.length])
  useChatScroll(id, scroller, stick, items.length)

  const history = (el: HTMLElement) => {
    const entries: MenuEntry[] = [{ header: 'Threads' }]
    if (!state.chats.length) entries.push({ label: 'No threads yet', disabled: true })
    for (const c of state.chats.slice(0, 30)) entries.push({ label: c.title || 'Untitled', sub: `${c.model} · ${ago(c.createdAt)}${c.meter ? ` · ${fmtUsd(c.meter.costUsd)}` : ''}`, checked: c.id === id, onSelect: () => void actions.selectChat(c.id) })
    menu.openUnder(el, entries, { minWidth: 300 })
  }

  const modeMenu = (el: HTMLElement) =>
    menu.openUnder(el, [{ header: 'How the assistant works' }, ...MODES.map((m) => ({ label: m.label, sub: m.hint, checked: m.id === mode, onSelect: () => setMode(m.id) }))], { minWidth: 280 })

  const last = messages[messages.length - 1]
  const thinking = busy && (!last || last.role !== 'assistant' || last.agentId !== 'main')
  const started = state.boards.find((b) => b.state === 'running' || b.state === 'planning')

  return (
    <aside className="panel right" aria-label="Assistant" aria-hidden={!state.layout.rightOpen}>
      <div className="panel-inner">
        <div className="as-head">
          <span className="panel-title">{chat?.title && chat.title !== 'New chat' ? chat.title : 'Assistant'}</span>
          {(busy || started) && <span className="lav-dot pulse" title={busy ? 'Working' : 'Team run in progress'} />}
          <button className="icon-btn" title="History" onClick={(e) => history(e.currentTarget)}>
            <Icon name="clock" size={14} />
          </button>
          <button className="icon-btn" title={`New thread (${keyHint('mod+shift+l')})`} onClick={() => void actions.newChat()}>
            <Icon name="plus" size={14} />
          </button>
          <button className="icon-btn" title={`Close (${keyHint('mod+l')})`} onClick={() => actions.toggleRight(false)}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="as-pills">
          <ModelPicker value={choice} providers={state.providers} onChange={(c) => void actions.chooseModel(c)} onAddKey={(p) => actions.openSettings(p)} direction="down" />
          <EffortPicker chat={chat} choice={choice} />
          <button className="pill" onClick={(e) => modeMenu(e.currentTarget)} title="Single agent, team, or automatic">
            {mode === 'team' ? 'team' : mode === 'single' ? 'single' : 'auto'} <span className="caret">▼</span>
          </button>
          <span className="grow" />
          {problems.length > 0 && (
            <button className={`badge-o ${problems.some((p) => p.severity === 'error') ? 'err' : 'warn'}`} onClick={() => actions.showBottom('problems')} title="Problems">
              Luau {problems.length}
            </button>
          )}
          <button className="icon-btn" title="Test agents and Lune tests" onClick={() => actions.showSide('tests')}>
            <Icon name="bot" size={14} />
          </button>
        </div>
        <Meter />
        {chat && isGroup(chat) && <ParticipantsBar />}
        <div
          className="as-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            rememberChatScroll(id, el.scrollTop, stick.current)
          }}
        >
          {noProvider && (
            <div className="vbox" style={{ margin: '10px 0' }}>
              <div style={{ marginBottom: 6 }}>No model provider is set up.</div>
              <div className="note" style={{ marginBottom: 8 }}>Add an API key for Anthropic, OpenAI, OpenRouter or Gemini, or run Ollama locally.</div>
              <button className="btn" onClick={() => actions.openSettings()}><Icon name="gear" size={12} /> Settings</button>
            </div>
          )}
          {!messages.length && !boards.length && (
            <div className="as-empty">
              <div>context: {state.activeFile ? basename(state.activeFile) : 'no file'}{problems.length ? ` · ${problems.length} problems` : ''}</div>
              <div>@ to add files{isGroup(chat) ? ' or models' : ''} · / for commands</div>
              <div>{keyHint('mod+enter')} to send · shift+tab to change mode</div>
              {!chat && <div style={{ marginTop: 10 }}><ParticipantsBar compact /></div>}
            </div>
          )}
          {items.map((it, i) =>
            it.kind === 'msg' ? <Message key={it.m.id} m={it.m} /> : <ToolGroup key={it.id} ms={it.ms} last={i === items.length - 1} busy={busy} />
          )}
          {boards.map((b) => (
            <Board key={b.runId} b={b} />
          ))}
          {thinking && (
            <div className="thinking" aria-label="Working">
              <span /><span /><span />
            </div>
          )}
          <MemoryProposals sessionId={id} />
        </div>
        <Composer mode={mode} setMode={setMode} />
      </div>
      {menu.node}
    </aside>
  )
}

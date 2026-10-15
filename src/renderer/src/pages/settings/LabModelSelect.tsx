// Settings > Labs: one tier's model as a dropdown in the chat model picker's style (ModelPicker's
// mpick classes). Entries: Auto (what it resolves to now), the ready providers' models grouped by
// provider with a tier hint, and Custom… which reveals a text field for any model id. The value is
// the stored string itself: '' = auto, anything else = that model id (shared/labModels.ts).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ProviderId, ProviderInfo } from '@shared/types'
import { labModelGroups, labModelSelection, labRejection, shortModelId, type LabModelInfo, type LabModelOption, type LabTier } from '@shared/labModels'
import { ProviderMark } from '../../components/ModelPicker'
import { IconCheck, IconChevronDown, IconSearch } from '../../components/Icons'

const REJECTED = 'Rejected by your account recently'

export function LabModelSelect({
  tier,
  label,
  autoNote,
  value,
  info,
  providers,
  disabled,
  onChange,
  onOpen
}: {
  tier: LabTier
  label: string
  // What auto means in words ("provider's cheap tier").
  autoNote: string
  value: string
  info: LabModelInfo | null
  providers: ProviderInfo[] | null
  disabled?: boolean
  onChange: (value: string) => void
  // Called when the list opens (the parent refreshes auto / rejections then).
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [fetched, setFetched] = useState<Partial<Record<ProviderId, string[]>>>({})
  // Custom… picked: the text field shows even while the stored value is still auto or a listed model.
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  // Where the list opens: below the button unless the page has more room above (a native select's
  // rule), capped to the visible room.
  const [place, setPlace] = useState<{ dir: 'up' | 'down'; max: number }>({ dir: 'down', max: 420 })
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const custom = useRef<HTMLInputElement>(null)

  const groups = useMemo(() => labModelGroups(providers, info, fetched), [providers, info, fetched])
  const sel = labModelSelection(value, groups)
  const auto = info?.auto[tier] ?? ''
  const autoRejected = auto ? labRejection(info, auto) : null
  const showCustom = customOpen || sel.kind === 'custom'

  // A new stored value: the field follows it, and stays only while the value is a custom id.
  useEffect(() => {
    setDraft(value)
    setCustomOpen(false)
  }, [value])

  useEffect(() => {
    if (!open) return
    setQuery('')
    onOpen?.()
    requestAnimationFrame(() => search.current?.focus({ preventScroll: true }))
    // Refresh the ready providers' model lists (cached in main), as the chat picker does.
    for (const p of providers ?? []) {
      if (!p.ready || p.id === 'anthropic' || p.id === 'codex') continue
      void window.harness
        .listModels(p.id)
        .then((models) => setFetched((f) => ({ ...f, [p.id]: models })))
        .catch(() => {})
    }
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => groups.map((g) => ({ ...g, options: q ? g.options.filter((o) => o.model.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) : g.options })).filter((g) => g.options.length),
    [groups, q]
  )
  const showAuto = !q || 'auto'.includes(q) || auto.toLowerCase().includes(q)
  const useTyped = q && !groups.some((g) => g.options.some((o) => o.model.toLowerCase() === q)) ? query.trim() : null

  const pick = (next: string) => {
    setOpen(false)
    setCustomOpen(false)
    if (next !== value) onChange(next)
  }
  const pickCustom = () => {
    setOpen(false)
    setCustomOpen(true)
    setDraft(sel.kind === 'custom' ? sel.model : '')
    requestAnimationFrame(() => custom.current?.focus())
  }
  const commitCustom = () => {
    const next = draft.trim()
    // Nothing typed after Custom…: back to the list's choice.
    if (!next && sel.kind !== 'custom') {
      setCustomOpen(false)
      setDraft(value)
      return
    }
    if (next !== value) onChange(next)
    if (!next) setCustomOpen(false)
  }

  // Arrow keys move between the entries; Enter in the search box picks the first one.
  const move = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.lms-pop [role="option"]') ?? [])]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1
    items[next].focus()
  }

  const buttonText =
    sel.kind === 'auto' ? (auto ? `Auto · ${shortModelId(auto)}` : 'Auto') : sel.kind === 'model' ? shortModelId(sel.option.model) : `Custom: ${sel.model}`
  const title =
    sel.kind === 'auto' ? `Auto: ${auto || autoNote}` : sel.kind === 'model' ? `${sel.option.provider} · ${sel.option.model}` : `Custom model id: ${sel.model}`
  const warn = sel.kind === 'model' ? !!sel.option.rejected : sel.kind === 'auto' && !!autoRejected

  return (
    <div className="lms" ref={root}>
      <div className={`mpick mpick-field lms-pick${open ? ' open' : ''}`}>
        <button
          type="button"
          className={`mpick-btn${warn ? ' warn' : ''}`}
          aria-label={`${label} model for the Labs`}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-search=""
          data-kind={sel.kind}
          title={title}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            if (!open) setPlace(placement(e.currentTarget))
            setOpen(!open)
          }}
        >
          {sel.kind === 'model' && <ProviderMark id={sel.option.provider} size={18} />}
          <span className={`mpick-name${sel.kind === 'auto' ? '' : ' mono'}`}>{buttonText}</span>
          {warn && <span className="mpick-dot" aria-label={REJECTED} />}
          <IconChevronDown size={12} className="mpick-caret" />
        </button>
        {open && (
          <div className={`mpick-pop ${place.dir} lms-pop`} style={{ ['--lms-max' as string]: `${place.max}px` }} role="listbox" aria-label={`${label} model`} onClick={(e) => e.stopPropagation()} onKeyDown={move}>
            <div className="mpick-search">
              <IconSearch size={13} />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models or type an id"
                spellCheck={false}
                aria-label={`Search ${label.toLowerCase()} models`}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const first = root.current?.querySelector<HTMLButtonElement>('.lms-pop [role="option"]')
                  first?.click()
                }}
              />
            </div>
            <div className="mpick-list">
              {showAuto && (
                <div className="mpick-group">
                  <Entry kind="auto" model="" selected={sel.kind === 'auto'} onPick={() => pick('')} main={auto ? `Auto (${shortModelId(auto)})` : 'Auto'} sub={autoNote} rejected={autoRejected} rejectedText={`${REJECTED}: the Labs fall back to your chat model`} />
                </div>
              )}
              {shown.map((g) => (
                <div key={g.provider} className="mpick-group">
                  <div className="mpick-head">
                    <ProviderMark id={g.provider} size={16} />
                    <span className="mpick-plabel">{g.label}</span>
                    {!g.primary && <span className="lms-gnote" title="Labs model ids go to your default model's provider">if your default model is here</span>}
                  </div>
                  {g.options.map((o) => (
                    <OptionEntry key={o.model} option={o} selected={sel.kind === 'model' && sel.option.provider === o.provider && sel.option.model === o.model} onPick={() => pick(o.model)} />
                  ))}
                </div>
              ))}
              {!groups.length && !q && <div className="mpick-more lms-none">No provider is signed in or set up yet · Auto or Custom still work</div>}
              <div className="mpick-group">
                {useTyped && <Entry kind="custom" model={useTyped} selected={false} onPick={() => pick(useTyped)} main={`Use “${useTyped}”`} sub="as a custom model id" />}
                {sel.kind === 'custom' && (!q || sel.model.toLowerCase().includes(q)) && <Entry kind="custom" model={sel.model} selected onPick={() => pick(sel.model)} main={`Custom: ${sel.model}`} />}
                <Entry kind="custom-edit" model="" selected={false} onPick={pickCustom} main="Custom…" sub="type any model id" />
              </div>
            </div>
          </div>
        )}
      </div>
      {showCustom && (
        <input
          ref={custom}
          className="input mono lms-custom"
          value={draft}
          disabled={disabled}
          placeholder="model id, e.g. claude-sonnet-5-5"
          aria-label={`${label} custom model id for the Labs`}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(value)
              if (sel.kind !== 'custom') setCustomOpen(false)
            }
          }}
        />
      )}
    </div>
  )
}

// Room below and above the button inside its scrolling page (or the window).
function placement(button: HTMLElement): { dir: 'up' | 'down'; max: number } {
  let box: HTMLElement | null = button.parentElement
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
  const area = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  const r = button.getBoundingClientRect()
  const below = Math.min(area.bottom, window.innerHeight) - r.bottom - 10
  const above = r.top - Math.max(area.top, 0) - 10
  const dir = below >= 320 || below >= above ? 'down' : 'up'
  return { dir, max: Math.max(180, Math.min(420, dir === 'down' ? below : above)) }
}

function OptionEntry({ option, selected, onPick }: { option: LabModelOption; selected: boolean; onPick: () => void }) {
  return <Entry kind="model" model={option.model} provider={option.provider} selected={selected} onPick={onPick} main={option.model} hint={option.hint} rejected={option.rejected ?? null} rejectedText={REJECTED} mono />
}

function Entry({
  kind,
  model,
  provider,
  selected,
  onPick,
  main,
  sub,
  hint,
  rejected,
  rejectedText,
  mono
}: {
  kind: 'auto' | 'model' | 'custom' | 'custom-edit'
  model: string
  provider?: ProviderId
  selected: boolean
  onPick: () => void
  main: string
  sub?: string
  hint?: string | null
  rejected?: string | null
  rejectedText?: string
  mono?: boolean
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-kind={kind}
      data-model={model}
      data-provider={provider}
      className={`mpick-item lms-item${selected ? ' sel' : ''}${kind === 'custom-edit' ? ' use' : ''}`}
      title={rejected ? `${rejectedText}: ${rejected}` : undefined}
      onClick={onPick}
    >
      <span className="lms-body">
        <span className="lms-line">
          <span className={`mpick-model${mono ? ' mono' : ''}`}>{main}</span>
          {hint && <span className={`lms-hint lms-${hint}`}>{hint}</span>}
        </span>
        {sub && <span className="lms-sub">{sub}</span>}
        {rejected && (
          <span className="lms-rej" data-rejected="">
            {rejectedText}
          </span>
        )}
      </span>
      {selected && <IconCheck size={13} />}
    </button>
  )
}

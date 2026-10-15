// Compact model picker: a pill showing the provider mark and model, with a searchable dropdown
// grouped by provider. Providers that are not set up are greyed with an "Add key" action.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ModelChoice, ProviderId, ProviderInfo } from '@shared/types'
import { shortModelId } from '@shared/labModels'
import { IconCheck, IconChevronDown, IconSearch } from './Icons'

const SHORT: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  ollama: 'Ollama',
  custom: 'Custom',
  codex: 'Codex'
}

const MARK: Record<ProviderId, string> = { anthropic: 'A', openai: 'O', openrouter: 'R', gemini: 'G', ollama: 'ol', custom: 'C', codex: 'Cx' }

// Models shown per provider before "type to search".
const PER_GROUP = 6

export function ProviderMark({ id, size = 18 }: { id: ProviderId; size?: number }) {
  return (
    <span className={`pmark pm-${id}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }} aria-hidden>
      {MARK[id]}
    </span>
  )
}

// Pill label: the model id without the provider prefix or date stamp ("claude-sonnet-4-5" → "sonnet-4-5").
const shortModel = shortModelId

export function providerLabel(id: ProviderId): string {
  return SHORT[id]
}

export function ModelPicker({
  value,
  providers,
  onChange,
  onAddKey,
  direction = 'up',
  disabled,
  variant = 'pill',
  placeholder,
  icon
}: {
  value: ModelChoice | null
  providers: ProviderInfo[] | null
  onChange: (choice: ModelChoice) => void
  onAddKey: (provider: ProviderId) => void
  direction?: 'up' | 'down'
  disabled?: boolean
  // 'field' renders as a full-width select-like box (Settings, Agents drawer).
  variant?: 'pill' | 'field'
  // Button text when no model is chosen (e.g. "Add model" in the group chat bar), and an icon before it.
  placeholder?: string
  icon?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [fetched, setFetched] = useState<Partial<Record<ProviderId, string[]>>>({})
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const current = providers?.find((p) => p.id === value?.provider)
  const notReady = !!current && !current.ready

  useEffect(() => {
    if (!open) return
    setQuery('')
    requestAnimationFrame(() => search.current?.focus())
    // Refresh model lists of ready providers (cached in main).
    for (const p of providers ?? []) {
      if (!p.ready || p.id === 'anthropic') continue
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

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Ready providers first; the rest (greyed, with "Add key") at the bottom.
    const ordered = [...(providers ?? [])].sort((a, b) => Number(b.ready) - Number(a.ready))
    return ordered.map((p) => {
      const all = fetched[p.id] ?? p.models
      const matches = q ? all.filter((m) => m.toLowerCase().includes(q) || SHORT[p.id].toLowerCase().includes(q)) : all
      // Keep the selected model visible even when it is beyond the first few.
      let shown = matches.slice(0, q ? 40 : PER_GROUP)
      if (value?.provider === p.id && !shown.includes(value.model) && (!q || value.model.toLowerCase().includes(q))) shown = [value.model, ...shown.slice(0, -1)]
      const custom = q && p.ready && p.id !== 'anthropic' && !all.some((m) => m.toLowerCase() === q) ? query.trim() : null
      return { p, shown, more: matches.length - shown.length, custom }
    })
  }, [providers, fetched, query, value])

  const pick = (choice: ModelChoice) => {
    onChange(choice)
    setOpen(false)
  }

  return (
    <div className={`mpick mpick-${variant}${open ? ' open' : ''}`} ref={root}>
      <button
        type="button"
        className={`mpick-btn${notReady ? ' warn' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        disabled={disabled || !providers}
        title={value ? `${SHORT[value.provider]} · ${value.model}${notReady ? ' (not set up)' : ''}` : placeholder ?? 'Choose a model'}
      >
        {variant === 'field' ? value ? <ProviderMark id={value.provider} size={18} /> : icon ?? null : !value && icon ? icon : null}
        <span className="mpick-name">{value ? shortModel(value.model) : placeholder ?? 'Choose a model'}</span>
        {notReady && <span className="mpick-dot" aria-label="not set up" />}
        {variant === 'pill' ? <span className="mpick-caret">▼</span> : <IconChevronDown size={12} className="mpick-caret" />}
      </button>
      {open && (
        <div className={`mpick-pop ${direction}`} role="listbox" onClick={(e) => e.stopPropagation()}>
          <div className="mpick-search">
            <IconSearch size={13} />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const first = groups.find((g) => g.p.ready && (g.shown.length || g.custom))
                if (!first) return
                pick({ provider: first.p.id, model: first.shown[0] ?? first.custom! })
              }}
            />
          </div>
          <div className="mpick-list">
            {groups.map(({ p, shown, more, custom }) => {
              if (query && !shown.length && !custom && p.ready) return null
              return (
                <div key={p.id} className={`mpick-group${p.ready ? '' : ' off'}`}>
                  <div className="mpick-head">
                    <ProviderMark id={p.id} size={16} />
                    <span className="mpick-plabel">{p.label}</span>
                    {!p.ready && (
                      <button
                        type="button"
                        className="mpick-add"
                        onClick={() => {
                          setOpen(false)
                          onAddKey(p.id)
                        }}
                      >
                        {p.id === 'ollama' ? 'Set up' : p.id === 'custom' ? 'Add URL' : p.id === 'codex' ? 'Sign in' : 'Add key'}
                      </button>
                    )}
                  </div>
                  {p.ready &&
                    shown.map((m) => {
                      const sel = value?.provider === p.id && value.model === m
                      return (
                        <button key={m} type="button" role="option" aria-selected={sel} className={`mpick-item${sel ? ' sel' : ''}`} onClick={() => pick({ provider: p.id, model: m })}>
                          <span className="mpick-model">{m}</span>
                          {sel && <IconCheck size={13} />}
                        </button>
                      )
                    })}
                  {p.ready && custom && (
                    <button type="button" className="mpick-item use" onClick={() => pick({ provider: p.id, model: custom })}>
                      <span className="mpick-model">Use “{custom}”</span>
                    </button>
                  )}
                  {p.ready && more > 0 && <div className="mpick-more">{more} more · type to search</div>}
                  {p.ready && !shown.length && !custom && <div className="mpick-more">No models listed · type a model id</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

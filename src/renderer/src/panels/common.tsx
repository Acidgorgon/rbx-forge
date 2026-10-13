import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { IconClose, IconSearch } from '../components/Icons'
import { copyPaths, type PathTarget } from '../components/pathActions'

export function FilterBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="filter">
      <IconSearch size={14} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} />
      {value && (
        <button className="filter-clear" onClick={() => onChange('')} title="Clear">
          <IconClose size={12} />
        </button>
      )}
    </label>
  )
}

// Ctrl/Cmd+Shift+C copies the selected rows' Roblox paths, unless the user is typing.
export function useCopyShortcut(selection: PathTarget[]): void {
  const { actions } = useStore()
  const ref = useRef(selection)
  ref.current = selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'c') return
      const t = e.target as HTMLElement | null
      if (t && (t.closest('textarea, input, .monaco-editor') || t.isContentEditable)) return
      if (ref.current.length === 0) return
      e.preventDefault()
      copyPaths(actions, ref.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])
}

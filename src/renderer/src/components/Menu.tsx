// Floating menu used for right-click context menus and pill dropdowns.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator' | { header: string }

export interface MenuProps {
  x: number
  y: number
  // 'up' anchors the menu's bottom edge at y (status bar menus).
  direction?: 'down' | 'up'
  items: MenuEntry[]
  onClose: () => void
}

export function Menu({ x, y, direction = 'down', items, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, ready: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = Math.min(x, window.innerWidth - r.width - 8)
    let top = direction === 'up' ? y - r.height : y
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height)
    left = Math.max(8, left)
    top = Math.max(8, top)
    setPos({ left, top, ready: true })
  }, [x, y, direction])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it === 'separator') return <div key={i} className="menu-sep" />
        if ('header' in it) return <div key={i} className="menu-header" title={it.header}>{it.header}</div>
        return (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

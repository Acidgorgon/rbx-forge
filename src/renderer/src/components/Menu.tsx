// Context / dropdown menu with submenus, single-letter accelerators and keyboard navigation (SPEC §6, §8.1).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icons'

export interface MenuItem {
  label: string
  icon?: ReactNode
  // Shortcut shown on the right (display only).
  hint?: string
  // Single letter that picks the item while this menu is open.
  accel?: string
  // Second line (two-line item).
  sub?: string
  danger?: boolean
  disabled?: boolean
  // Tooltip when disabled ("Rojo isn't serving").
  reason?: string
  checked?: boolean
  onSelect?: () => void
  submenu?: MenuEntry[]
  // Small icon button at the item's right end, shown on hover or highlight (delete a thread from the
  // History menu). Delete / Backspace on the highlighted item runs it too.
  action?: { icon: ReactNode; label: string; onSelect: () => void }
}

export type MenuEntry = MenuItem | 'separator' | { header: string; mono?: boolean }

// Drops leading, trailing and doubled separators.
export function tidySeparators(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const it of items) {
    if (it === 'separator' && (!out.length || out[out.length - 1] === 'separator')) continue
    out.push(it)
  }
  while (out[out.length - 1] === 'separator') out.pop()
  return out
}

export interface MenuProps {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
  // 'up' anchors the menu's bottom edge at y (status bar menus).
  direction?: 'down' | 'up'
  minWidth?: number
  // Open this item's submenu right away (index into items).
  openSub?: number
}

const isItem = (e: MenuEntry): e is MenuItem => typeof e === 'object' && 'label' in e

function MenuList({ x, y, items, onClose, direction = 'down', minWidth, openSub, depth, parentRect, onBack }: MenuProps & { depth: number; parentRect?: DOMRect; onBack?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, origin: 'top left', ready: false })
  const [hl, setHl] = useState<number>(openSub ?? -1)
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = x
    let top = direction === 'up' ? y - r.height : y
    let originX = 'left'
    let originY = direction === 'up' ? 'bottom' : 'top'
    if (parentRect) {
      left = parentRect.right + 2
      top = parentRect.top - 4
      if (left + r.width > window.innerWidth - 8) {
        left = parentRect.left - r.width - 2
        originX = 'right'
      }
    } else if (left + r.width > window.innerWidth - 8) {
      left = Math.max(8, x - r.width)
      originX = 'right'
    }
    if (top + r.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - 8 - r.height)
      originY = 'bottom'
    }
    setPos({ left: Math.max(8, left), top: Math.max(8, top), origin: `${originY} ${originX}`, ready: true })
  }, [x, y, direction, parentRect])

  useEffect(() => {
    if (openSub === undefined || !ref.current) return
    const el = ref.current.querySelector<HTMLElement>(`[data-index="${openSub}"]`)
    if (el) setSub({ index: openSub, rect: el.getBoundingClientRect() })
  }, [openSub, pos.ready])

  const pick = useCallback(
    (item: MenuItem, el?: HTMLElement | null) => {
      if (item.disabled) return
      if (item.submenu) {
        const index = items.indexOf(item)
        const target = el ?? ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
        if (target) setSub({ index, rect: target.getBoundingClientRect() })
        return
      }
      onClose()
      item.onSelect?.()
    },
    [items, onClose]
  )

  // Keyboard: only the deepest open menu handles keys.
  useEffect(() => {
    if (sub) return
    const onKey = (e: KeyboardEvent) => {
      const selectable = items.map((it, i) => (isItem(it) && !it.disabled ? i : -1)).filter((i) => i >= 0)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (onBack) onBack()
        else onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!selectable.length) return
        const at = selectable.indexOf(hl)
        const next = e.key === 'ArrowDown' ? selectable[(at + 1) % selectable.length] : selectable[(at - 1 + selectable.length) % selectable.length]
        setHl(next)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && hl >= 0) {
        const it = items[hl]
        if (isItem(it) && it.action && !it.disabled) {
          e.preventDefault()
          onClose()
          it.action.onSelect()
        }
        return
      }
      if (e.key === 'ArrowLeft' && onBack) {
        e.preventDefault()
        onBack()
        return
      }
      if ((e.key === 'Enter' || e.key === 'ArrowRight') && hl >= 0) {
        const it = items[hl]
        if (isItem(it) && (e.key === 'Enter' || it.submenu)) {
          e.preventDefault()
          pick(it)
        }
        return
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const hit = items.find((it) => isItem(it) && !it.disabled && it.accel?.toLowerCase() === e.key.toLowerCase())
        if (hit && isItem(hit)) {
          e.preventDefault()
          pick(hit)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, hl, sub, pick, onClose, onBack])

  const enter = (i: number, it: MenuEntry, el: HTMLElement) => {
    setHl(i)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (isItem(it) && it.submenu && !it.disabled) setSub({ index: i, rect: el.getBoundingClientRect() })
    else if (sub && sub.index !== i) closeTimer.current = setTimeout(() => setSub(null), 250)
  }

  const subItem = sub ? items[sub.index] : null

  return (
    <>
      <div
        ref={ref}
        className="menu"
        role="menu"
        data-depth={depth}
        style={{ left: pos.left, top: pos.top, minWidth, visibility: pos.ready ? 'visible' : 'hidden', transformOrigin: pos.origin }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
      >
        {items.map((it, i) => {
          if (it === 'separator') return <div key={i} className="msep" />
          if (!isItem(it)) return <div key={i} className={`mhead${it.mono ? ' mono' : ''}`} title={it.header}>{it.header}</div>
          return (
            <button
              key={i}
              data-index={i}
              role="menuitem"
              type="button"
              className={`mi${it.sub ? ' tall' : ''}${it.danger ? ' danger' : ''}${hl === i ? ' hl' : ''}${it.checked ? ' checked' : ''}`}
              disabled={it.disabled}
              title={it.disabled ? it.reason : undefined}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              onMouseEnter={(e) => enter(i, it, e.currentTarget)}
              onClick={(e) => pick(it, e.currentTarget)}
            >
              <span className="mic">{it.checked ? <Icon name="check" size={14} /> : it.icon}</span>
              {it.sub ? (
                <span className="two">
                  <span className="mlabel">{it.label}</span>
                  <small>{it.sub}</small>
                </span>
              ) : (
                <span className="mlabel">{it.label}</span>
              )}
              {(it.hint || it.accel || it.submenu) && (
                <span className="mk">
                  {it.hint ?? it.accel?.toUpperCase()}
                  {it.submenu && <Icon name="chev" size={12} />}
                </span>
              )}
              {it.action && (
                <span
                  role="button"
                  className="mact"
                  aria-label={it.action.label}
                  title={it.action.label}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose()
                    it.action!.onSelect()
                  }}
                >
                  {it.action.icon}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {sub && subItem && isItem(subItem) && subItem.submenu && (
        <MenuList x={0} y={0} items={subItem.submenu} onClose={onClose} depth={depth + 1} parentRect={sub.rect} onBack={() => setSub(null)} minWidth={240} />
      )}
    </>
  )
}

export function Menu(props: MenuProps) {
  const { onClose } = props
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest('.menu')) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  return <MenuList {...props} depth={0} />
}

// Menu state helper for components: open at a mouse event or under an element.
export function useMenu() {
  const [menu, setMenu] = useState<(Omit<MenuProps, 'onClose'>) | null>(null)
  const close = useCallback(() => setMenu(null), [])
  const node = menu ? <Menu {...menu} onClose={close} /> : null
  return {
    node,
    close,
    open: (m: Omit<MenuProps, 'onClose'>) => setMenu(m),
    openAt: (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[], extra?: Partial<MenuProps>) => {
      e.preventDefault?.()
      const clean = tidySeparators(items)
      // Nothing to show: no empty frame.
      if (!clean.length) return
      setMenu({ x: e.clientX, y: e.clientY, items: clean, ...extra })
    },
    openUnder: (el: HTMLElement, items: MenuEntry[], extra?: Partial<MenuProps>) => {
      const r = el.getBoundingClientRect()
      setMenu({ x: r.left, y: r.bottom + 4, items, ...extra })
    },
    openAbove: (el: HTMLElement, items: MenuEntry[], extra?: Partial<MenuProps>) => {
      const r = el.getBoundingClientRect()
      setMenu({ x: r.left, y: r.top - 4, items, direction: 'up', ...extra })
    }
  }
}

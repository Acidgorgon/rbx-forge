// Slide-over sheet from the right edge.
import { useEffect, type ReactNode } from 'react'
import { IconClose } from './Icons'

export function Drawer({
  title,
  subtitle,
  icon,
  actions,
  width = 560,
  onClose,
  children
}: {
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  width?: number
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" style={{ width }} role="dialog" aria-label={title}>
        <header className="drawer-head">
          {icon && <span className="drawer-icon">{icon}</span>}
          <div className="drawer-titles">
            <h2>{title}</h2>
            {subtitle && <div className="drawer-sub">{subtitle}</div>}
          </div>
          <div className="drawer-actions">{actions}</div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <IconClose />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}

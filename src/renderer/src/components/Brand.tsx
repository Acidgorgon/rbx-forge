// Coral asterisk mark (terminal-style header) and the RBX Forge name for assistive tech.
export function AnvilMark({ size = 16 }: { size?: number }) {
  const spokes = Array.from({ length: 8 }, (_, i) => i * 22.5)
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <g stroke="var(--ember)" strokeWidth="1.6" strokeLinecap="round">
        {spokes.map((a) => (
          <line key={a} x1="8" y1="1.8" x2="8" y2="14.2" transform={`rotate(${a} 8 8)`} />
        ))}
      </g>
    </svg>
  )
}

export function Wordmark() {
  return <span className="wordmark">RBX Forge</span>
}

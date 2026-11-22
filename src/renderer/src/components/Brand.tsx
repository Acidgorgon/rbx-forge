// Geometric split-cube RBX Forge emblem and visible brand wordmark.
export function AnvilMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2.4 19.9 7 12 11.5 4.1 7Z" fill="var(--ember-hi)" />
      <path d="M3.4 8.4 11.1 12.8v8.8l-7.7-4.5V8.4Z" fill="var(--ember)" />
      <path d="M20.6 8.4v8.7l-7.7 4.5v-8.8l7.7-4.4Z" fill="var(--ember)" fillOpacity="0.55" />
    </svg>
  )
}

export function Wordmark() {
  return <span className="wordmark">RBX Forge</span>
}

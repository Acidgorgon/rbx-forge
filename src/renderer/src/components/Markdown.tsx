// Tiny markdown renderer for chat prose: paragraphs, headings, fenced code,
// inline code, bold/italic, links, ordered/unordered lists, blockquotes.
import { useState, type ReactNode } from 'react'
import { IconCheck, IconCopy } from './Icons'

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul' | 'ol'; items: string[]; start: number }
  | { kind: 'quote'; text: string }

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```\s*([\w+-]*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or EOF while streaming)
      blocks.push({ kind: 'code', lang: fence[1] || '', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const start = ordered ? parseInt(line.trim(), 10) : 1
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i]
        const m = ordered ? l.match(/^\s*\d+[.)]\s+(.*)$/) : l.match(/^\s*[-*+]\s+(.*)$/)
        if (m) {
          items.push(m[1])
          i++
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1] += ' ' + l.trim()
          i++
        } else break
      }
      blocks.push({ kind: ordered ? 'ol' : 'ul', items, start })
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join(' ') })
      continue
    }
    const body: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      body.push(lines[i++])
    }
    blocks.push({ kind: 'p', text: body.join('\n') })
  }
  return blocks
}

// Inline: `code`, **bold**, *italic* / _italic_, [text](url)
function inline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}${k++}`
    if (m[1]) out.push(<code key={key} className="md-inline-code">{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>)
    else if (m[3] || m[4]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>)
    else if (m[5]) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      out.push(
        <a key={key} href={lm[2]} target="_blank" rel="noreferrer">
          {lm[1]}
        </a>
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  // Soft line breaks inside paragraphs.
  return out.flatMap<ReactNode>((node, idx) =>
    typeof node === 'string' && node.includes('\n')
      ? node.split('\n').flatMap((part, j, arr) => (j < arr.length - 1 ? [part, <br key={`${keyPrefix}br${idx}-${j}`} />] : [part]))
      : [node]
  )
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang || 'code'}</span>
        <button
          className="md-code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            })
          }}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text)
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'p':
            return <p key={i}>{inline(b.text, `p${i}-`)}</p>
          case 'h': {
            const Tag = (['h3', 'h3', 'h4', 'h5'] as const)[b.level - 1]
            return <Tag key={i}>{inline(b.text, `h${i}-`)}</Tag>
          }
          case 'code':
            return <CodeBlock key={i} lang={b.lang} text={b.text} />
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `u${i}-${j}-`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `o${i}-${j}-`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return <blockquote key={i}>{inline(b.text, `q${i}-`)}</blockquote>
        }
      })}
    </div>
  )
}

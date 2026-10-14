// Tiny markdown renderer for chat prose: paragraphs, headings, fenced code (with Copy), inline
// code, bold/italic, links, nested ordered/unordered lists, blockquotes, rules and tables.
import { useMemo, useState, type ReactNode } from 'react'
import { IconCheck, IconCopy } from './Icons'
import { parseMarkdown, type Block, type ListItem } from './markdownParse'

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

function Items({ items, k }: { items: ListItem[]; k: string }) {
  return (
    <>
      {items.map((it, j) => (
        <li key={j}>
          {inline(it.text, `${k}-${j}-`)}
          {it.children.length > 0 && <Blocks blocks={it.children} k={`${k}-${j}`} />}
        </li>
      ))}
    </>
  )
}

function Blocks({ blocks, k = '' }: { blocks: Block[]; k?: string }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${k}${i}`
        switch (b.kind) {
          case 'p':
            return <p key={key}>{inline(b.text, `p${key}-`)}</p>
          case 'h': {
            const Tag = (['h2', 'h3', 'h4', 'h5', 'h5', 'h5'] as const)[b.level - 1]
            return <Tag key={key}>{inline(b.text, `h${key}-`)}</Tag>
          }
          case 'code':
            return <CodeBlock key={key} lang={b.lang} text={b.text} />
          case 'ul':
            return (
              <ul key={key}>
                <Items items={b.items} k={`u${key}`} />
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} start={b.start}>
                <Items items={b.items} k={`o${key}`} />
              </ol>
            )
          case 'quote':
            return <blockquote key={key}>{inline(b.text, `q${key}-`)}</blockquote>
          case 'hr':
            return <hr key={key} />
          case 'table':
            return (
              <div key={key} className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                          {inline(c, `th${key}-${j}-`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, j) => (
                          <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                            {inline(r[j] ?? '', `td${key}-${ri}-${j}-`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
    </>
  )
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="md">
      <Blocks blocks={blocks} />
    </div>
  )
}

// Inline markdown only (code, bold, links...), for one-line items such as checklist tasks.
export function InlineMarkdown({ text }: { text: string }) {
  return <>{inline(text)}</>
}

// Pure helpers for the updater (no electron imports; tested in test/updater.test.ts).
import type { UpdateError } from '../../../shared/updateTypes.ts'

export interface FeedConfig {
  owner: string
  repo: string
}

// app-update.yml (written by electron-builder into the app's resources from `publish`), e.g.
//   owner: Acidgorgon
//   repo: rbx-forge
//   provider: github
// Only the github provider is read; anything else returns null.
export function parseFeedConfig(text: string): FeedConfig | null {
  const value = (key: string): string | null => {
    const m = new RegExp(`^${key}:\\s*['"]?([^'"\\s#]+)['"]?\\s*(?:#.*)?$`, 'm').exec(text)
    return m ? m[1] : null
  }
  const provider = value('provider')
  const owner = value('owner')
  const repo = value('repo')
  if (provider !== 'github' || !owner || !repo) return null
  return { owner, repo }
}

export function releasePageUrl(feed: FeedConfig, version?: string): string {
  const base = `https://github.com/${feed.owner}/${feed.repo}/releases`
  return version ? `${base}/tag/v${version.replace(/^v/, '')}` : `${base}/latest`
}

// `codesign -dv --verbose=2 <app>` output (it prints to stderr). Squirrel.Mac validates an update
// against the running app's designated requirement; an ad-hoc signature's requirement is its own
// cdhash, so no other build can satisfy it. Only a Developer ID (or Apple-issued) identity works.
export type MacSignature = 'developerId' | 'adhoc' | 'unsigned' | 'other'

export function macSignatureKind(output: string): MacSignature {
  if (/not signed at all/i.test(output)) return 'unsigned'
  if (/^Signature=adhoc/im.test(output)) return 'adhoc'
  if (/^Authority=Developer ID Application:/im.test(output)) return 'developerId'
  return 'other'
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

// Release notes from the GitHub atom feed are HTML (electron-updater passes them through). The
// renderer shows plain text, so nothing from the feed is ever injected as markup.
export function notesToText(notes: unknown): string {
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        const entry = n as { version?: string; note?: string | null }
        const body = notesToText(entry?.note ?? '')
        return entry?.version ? `${entry.version}\n${body}` : body
      })
      .filter(Boolean)
      .join('\n\n')
  }
  if (typeof notes !== 'string') return ''
  const text = notes
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|pre|blockquote|table)>/gi, '\n\n')
    .replace(/<\/(li|tr)>/gi, '')
    .replace(/<(h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (all, name: string) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name]
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : name.startsWith('#') ? parseInt(name.slice(1), 10) : NaN
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    })
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const MAX_NOTES = 4000

export function clipNotes(text: string): string {
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES).trimEnd()}\n...` : text
}

// Maps an electron-updater / builder-util-runtime error to what Settings says. HttpError carries
// statusCode and code "HTTP_ERROR_<status>"; electron-updater's own errors carry "ERR_UPDATER_*".
export function classifyUpdateError(error: unknown, feed: FeedConfig | null): UpdateError {
  const e = (error ?? {}) as { code?: unknown; statusCode?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const status = typeof e.statusCode === 'number' ? e.statusCode : null
  const raw = typeof e.message === 'string' ? e.message : String(error)
  const detail = raw.split('\n')[0].slice(0, 300)
  const repo = feed ? `${feed.owner}/${feed.repo}` : 'the update repository'

  if (status === 404 || code === 'HTTP_ERROR_404' || (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' && /\b404\b/.test(raw))) {
    return {
      kind: 'private',
      message: `Can't read the releases of ${repo}. The repository is private, renamed or deleted, and Forge never ships a GitHub token. Publish releases to a public repository (see README "Updates").`,
      detail
    }
  }
  if (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
    return { kind: 'noReleases', message: `${repo} has no published release yet.`, detail }
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_INVALID_UPDATE_INFO') {
    return { kind: 'noMetadata', message: 'The newest release has no update info for this platform (latest.yml). Download it from the release page.', detail }
  }
  if (status === 403 || status === 429 || code === 'HTTP_ERROR_403' || code === 'HTTP_ERROR_429') {
    return { kind: 'rateLimited', message: 'GitHub refused the request (rate limited). Forge tries again later.', detail }
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION|TIMED_OUT|PROXY)/.test(`${code} ${raw}`)) {
    return { kind: 'offline', message: "Couldn't reach GitHub. Check your connection; Forge tries again later.", detail }
  }
  return { kind: 'other', message: 'The update check failed.', detail }
}

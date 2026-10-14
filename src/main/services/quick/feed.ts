// Where quick updates are downloaded from, and which URLs a download may touch (pure; tested).
//
// CI keeps one rolling GitHub release with the tag "quick" (marked prerelease, never "latest") and
// replaces its assets on every quick build:
//   quick-stable.json / quick-beta.json   signed manifest envelopes (manifest.ts)
//   forge-code-<version>.zip               the out/ folders (main, preload, renderer)
// The app reads them anonymously from https://github.com/<owner>/<repo>/releases/download/quick/...,
// which redirects to GitHub's asset CDN. Every hop must be https on a GitHub host.
import type { QuickChannel } from './manifest.ts'

export const QUICK_TAG = 'quick'
export const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
export const MAX_REDIRECTS = 5

export interface QuickFeed {
  manifestUrl(channel: QuickChannel): string
  zipUrl(name: string): string
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/

export function githubQuickFeed(owner: string, repo: string): QuickFeed {
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error(`Bad feed repository ${owner}/${repo}`)
  const base = `https://github.com/${owner}/${repo}/releases/download/${QUICK_TAG}`
  return {
    manifestUrl: (channel) => `${base}/quick-${channel}.json`,
    zipUrl: (name) => {
      if (!NAME.test(name)) throw new Error(`Bad bundle name ${name}`)
      return `${base}/${name}`
    }
  }
}

// Development test feed (FORGE_QUICK_FEED, honoured only in an unpackaged build): a local http
// server that serves the same file names.
export function localQuickFeed(base: string): QuickFeed {
  const root = base.replace(/\/+$/, '')
  if (!isAllowedUrl(`${root}/x`, true)) throw new Error(`FORGE_QUICK_FEED must be http://127.0.0.1:<port> (got ${base})`)
  return {
    manifestUrl: (channel) => `${root}/quick-${channel}.json`,
    zipUrl: (name) => {
      if (!NAME.test(name)) throw new Error(`Bad bundle name ${name}`)
      return `${root}/${name}`
    }
  }
}

// https on a GitHub release host, no credentials, default port. allowLocal also admits
// http://127.0.0.1 / http://localhost (development test feed only).
export function isAllowedUrl(url: string, allowLocal = false): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (allowLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true
  return u.protocol === 'https:' && u.port === '' && ALLOWED_HOSTS.includes(u.hostname.toLowerCase())
}

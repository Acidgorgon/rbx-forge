// Electron side of quick updates: anonymous downloads through Electron's net module (system proxy,
// no cookies), the first-window boot check, and the QuickUpdater for this launch.
import { app, net, type BrowserWindow } from 'electron'
import type { QuickUpdateState } from '../../../shared/updateTypes.ts'
import { githubQuickFeed, isAllowedUrl, localQuickFeed, MAX_REDIRECTS, type QuickFeed } from './feed.ts'
import { bootInfo } from './runtime.ts'
import { QuickUpdater, type FetchResult } from './updater.ts'
import type { FeedConfig } from '../updater/util.ts'

const TIMEOUT_MS = 120_000

// GET that follows at most MAX_REDIRECTS redirects, each to an allowed URL (feed.ts), and stops
// reading past maxBytes.
export function netGet(url: string, maxBytes: number, allowLocal: boolean): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    if (!isAllowedUrl(url, allowLocal)) return reject(new Error(`Refusing to download from ${url}`))
    let redirects = 0
    let settled = false
    const request = net.request({ url, method: 'GET', redirect: 'manual', useSessionCookies: false, credentials: 'omit', cache: 'no-store' } as Electron.ClientRequestConstructorOptions)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.abort()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error(`Timed out downloading ${url}`)), TIMEOUT_MS)
    request.on('redirect', (_status, _method, redirectUrl) => {
      if (++redirects > MAX_REDIRECTS) return fail(new Error('Too many redirects'))
      if (!isAllowedUrl(redirectUrl, allowLocal)) return fail(new Error(`Refusing a redirect to ${new URL(redirectUrl).host}`))
      request.followRedirect()
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) return fail(new Error(`${url} is larger than expected`))
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: response.statusCode, body: Buffer.concat(chunks) })
      })
      response.on('error', (error: Error) => fail(error))
    })
    request.on('error', (error) => fail(error))
    request.end()
  })
}

// A quick version counts as started once its first window has loaded and React has drawn into
// #root. If the preload fails or nothing shows within the limit, the version is marked bad and
// Forge restarts into the installed code.
export function watchBoot(window: BrowserWindow, log: (text: string, stream?: 'info' | 'stderr') => void): void {
  const boot = bootInfo()
  if (!boot || boot.source !== 'quick') return
  const LIMIT_MS = 45_000
  let done = false
  const giveUp = (reason: string) => {
    if (done) return
    done = true
    log(`quick update ${boot.version} ${reason}; restarting with the installed code`, 'stderr')
    boot.markBad(reason)
    app.relaunch()
    app.exit(0)
  }
  window.webContents.on('preload-error', (_event, _path, error) => giveUp(`preload failed: ${error?.message ?? error}`))
  window.webContents.once('did-finish-load', () => {
    const started = Date.now()
    const poll = async (): Promise<void> => {
      if (done || window.isDestroyed()) return
      const drawn = await window.webContents.executeJavaScript(`(() => { const r = document.getElementById('root'); return !!r && r.childElementCount > 0 && !!window.harness })()`, true).catch(() => false)
      if (drawn) {
        done = true
        boot.markBooted()
        return
      }
      if (Date.now() - started > LIMIT_MS) return giveUp(`showed no window content after ${LIMIT_MS / 1000} s`)
      setTimeout(() => void poll(), 500)
    }
    void poll()
  })
}

export interface QuickWiringDeps {
  isPackaged: boolean
  feed: FeedConfig | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (state: QuickUpdateState) => void
  log: (text: string, stream?: 'info' | 'stderr') => void
}

export function createQuickUpdater(deps: QuickWiringDeps): QuickUpdater {
  const boot = bootInfo()
  let feed: QuickFeed | null = null
  let unavailable = boot ? boot.unavailable : 'Restart Forge to use quick updates.'
  const devFeed = !deps.isPackaged ? boot?.devFeed : undefined
  if (!unavailable) {
    try {
      if (devFeed) feed = localQuickFeed(devFeed)
      else if (deps.feed) feed = githubQuickFeed(deps.feed.owner, deps.feed.repo)
      else unavailable = 'This build has no update feed (app-update.yml is missing).'
    } catch (e) {
      unavailable = (e as Error).message
    }
  }
  const appVersion = boot?.appVersion ?? app.getVersion()
  return new QuickUpdater({
    running: { source: boot?.source ?? 'bundled', version: boot?.version ?? appVersion, appVersion },
    unavailable,
    shell: boot?.shell ?? null,
    publicKey: boot?.publicKey ?? '',
    codeRoot: boot?.codeRoot ?? '',
    feed,
    get: (url, maxBytes) => netGet(url, maxBytes, Boolean(devFeed)),
    settings: deps.settings,
    emit: deps.emit,
    log: (text, stream) => deps.log(text, stream),
    relaunch: () => {
      app.relaunch()
      app.quit()
    }
  })
}

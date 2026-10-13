// Hidden capture page for the Studio check (?studio-capture=1, opened by main/services/studio/
// electron.ts). It holds the live stream of the Roblox Studio window, keeps ~1.5 s of recent frames,
// and answers two questions from main: the first frame after a time (stepped beats, calibration) and
// the frames nearest a list of target times (realtime beats; shared NearestFramePicker). Timestamps
// are wall-clock ms (performance.timeOrigin + frame time), the same clock main uses.

import { useEffect } from 'react'
import { FrameRing, NearestFramePicker } from '@shared/studio/timing'

interface Frame {
  ts: number
  bmp: ImageBitmap
}

interface Api {
  start(sourceId: string): Promise<{ width: number; height: number }>
  grabAfter(at: number, timeoutMs: number): Promise<{ ts: number; png: string } | null>
  pick(targets: number[], timeoutMs: number): Promise<({ ts: number; png: string; offsetMs: number } | null)[]>
  stop(): void
}

declare global {
  interface Window {
    __studioCapture?: Api
  }
}

const MAX_WIDTH = 1920

function install(): Api {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  let stream: MediaStream | null = null
  let stopped = false
  const pickers = new Set<NearestFramePicker<ImageBitmap>>()
  const waiters = new Set<{ at: number; resolve: (f: Frame) => void }>()
  const keep = new Set<ImageBitmap>()
  const inUse = (b: ImageBitmap) => keep.has(b) || [...pickers].some((p) => p.picks().some((x) => x?.frame === b))
  const ring = new FrameRing<ImageBitmap>(1500, (b) => {
    if (!inUse(b)) b.close()
  })

  const onFrame = (f: Frame) => {
    for (const p of pickers) {
      const before = p.picks().map((x) => x?.frame)
      p.offer(f.ts, f.bmp)
      for (const old of before) if (old && old !== f.bmp && !inUse(old) && !ring.all().some((r) => r.frame === old)) old.close()
    }
    for (const w of [...waiters]) {
      if (f.ts >= w.at) {
        waiters.delete(w)
        keep.add(f.bmp)
        w.resolve(f)
      }
    }
    ring.push(f.ts, f.bmp)
  }

  const grab = async (ts: number) => {
    if (stopped || video.readyState < 2) return
    const w = video.videoWidth
    const opts: ImageBitmapOptions = w > MAX_WIDTH ? { resizeWidth: MAX_WIDTH, resizeQuality: 'high' } : {}
    const bmp = await createImageBitmap(video, opts).catch(() => null)
    if (bmp) onFrame({ ts, bmp })
  }

  const loop = () => {
    if (stopped) return
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; presentationTime?: number }) => void) => number }
    if (v.requestVideoFrameCallback) {
      const tick = (now: number, meta: { captureTime?: number; presentationTime?: number }) => {
        void grab(performance.timeOrigin + (meta.captureTime ?? meta.presentationTime ?? now))
        if (!stopped) v.requestVideoFrameCallback!(tick)
      }
      v.requestVideoFrameCallback(tick)
    } else {
      const t = setInterval(() => (stopped ? clearInterval(t) : void grab(Date.now())), 33)
    }
  }

  const png = async (bmp: ImageBitmap): Promise<string> => {
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext('2d')!.drawImage(bmp, 0, 0)
    return canvas.toDataURL('image/png')
  }

  return {
    async start(sourceId) {
      try {
        // Main answers getDisplayMedia with the Studio window (session.setDisplayMediaRequestHandler).
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30 } } } as unknown as MediaStreamConstraints)
      }
      video.srcObject = stream
      await video.play()
      loop()
      return { width: video.videoWidth, height: video.videoHeight }
    },
    async grabAfter(at, timeoutMs) {
      const hit = ring.all().find((f) => f.ts >= at)
      const have: Frame | undefined = hit ? { ts: hit.ts, bmp: hit.frame } : undefined
      const f =
        have ??
        (await new Promise<Frame | null>((resolve) => {
          const w = { at, resolve: (x: Frame) => (clearTimeout(t), resolve(x)) }
          const t = setTimeout(() => (waiters.delete(w), resolve(null)), timeoutMs)
          waiters.add(w)
        }))
      if (!f) return null
      const out = { ts: f.ts, png: await png(f.bmp) }
      keep.delete(f.bmp)
      return out
    },
    async pick(targets, timeoutMs) {
      const picker = new NearestFramePicker<ImageBitmap>(targets)
      // Frames from before "start" reached main are still in the ring.
      for (const f of ring.all()) picker.offer(f.ts, f.frame)
      pickers.add(picker)
      const deadline = performance.now() + timeoutMs
      while (!picker.settled() && performance.now() < deadline && !stopped) await new Promise((r) => setTimeout(r, 40))
      pickers.delete(picker)
      const out: ({ ts: number; png: string; offsetMs: number } | null)[] = []
      for (const p of picker.picks()) out.push(p ? { ts: p.ts, png: await png(p.frame), offsetMs: Math.round(p.offsetMs) } : null)
      return out
    },
    stop() {
      stopped = true
      for (const t of stream?.getTracks() ?? []) t.stop()
      for (const f of ring.drain()) f.frame.close()
    }
  }
}

export function StudioCapture() {
  useEffect(() => {
    window.__studioCapture ??= install()
  }, [])
  return null
}

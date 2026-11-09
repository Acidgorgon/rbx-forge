// On-demand frame loop for the WebGL previews (VFX, Ability, Anim, Model, Compare).
//
// A preview only needs a new frame while it is playing, or once after something changed (a seek, a
// load, a resize, an orbit, a background or camera change). frame(dt) draws one frame and returns
// true to keep going (playing) or false to stop until the next invalidate(). The loop also stops
// while the window is hidden (document.hidden) or the element is not on screen (scrolled away,
// display:none, a closed panel) and draws once when it shows again, so an idle preview costs
// nothing. dt is the time since the previous frame in seconds (capped at 0.1, 0 on the first frame
// after a stop, so playback resumes where it was instead of jumping).

export interface FrameLoop {
  // Ask for a frame. Cheap: calls before the next animation frame collapse into one.
  invalidate(): void
  dispose(): void
}

export function frameLoop(el: Element | null, frame: (dt: number) => boolean): FrameLoop {
  let raf = 0
  let last = -1
  let onScreen = true
  let disposed = false
  const visible = () => onScreen && !document.hidden
  const schedule = () => {
    if (!raf && !disposed && visible()) raf = requestAnimationFrame(run)
  }
  function run(now: number): void {
    raf = 0
    if (disposed || !visible()) {
      last = -1
      return
    }
    const dt = last < 0 ? 0 : Math.min(0.1, (now - last) / 1000)
    let more = false
    try {
      more = frame(dt)
    } finally {
      last = more ? now : -1
      if (more) schedule()
    }
  }
  const io =
    el && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          onScreen = entries[entries.length - 1].isIntersecting
          if (onScreen) schedule()
        })
      : null
  if (el) io?.observe(el)
  const onVisibility = () => schedule()
  document.addEventListener('visibilitychange', onVisibility)
  schedule()
  return {
    invalidate: schedule,
    dispose() {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      io?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

// Device pixel ratio for the preview renderers: capped at 1.5 (a Retina panel at 2x costs ~1.8x the
// fill of 1.5x for a barely visible difference in a small preview).
export function previewPixelRatio(): number {
  return Math.min(1.5, globalThis.devicePixelRatio || 1)
}

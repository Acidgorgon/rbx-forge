// Content Security Policy for the packaged renderer. Used by the main process (response header) and
// by electron.vite.config.ts (a <meta> tag in the built index.html, since file:// responses may not
// pass through webRequest). Monaco needs blob: workers, inline styles and data: fonts.
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'"
].join('; ')

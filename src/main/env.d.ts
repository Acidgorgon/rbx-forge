/// <reference types="electron-vite/node" />

// Installed-app facts baked in at build time (electron.vite.config.ts, from package-lock.json); the
// bootstrap compares quick bundles against them (services/quick/shellInfo.ts).
declare const __FORGE_SHELL__: import('./services/quick/shellInfo.ts').ShellInfo

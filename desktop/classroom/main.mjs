/**
 * Electron main process — Windows classroom desktop shell.
 *
 * Pre-load dialog: start Classroom Server? Yes → spawn server/classroom.mjs
 * (Electron-as-Node), wait until healthy, open UI. No → probe; connect if
 * already up, otherwise show short setup and optionally open UI without a
 * live relay. App quit kills only a server this process started.
 *
 * Browser / Vercel builds never load this file.
 */

import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildServerEnv,
  classroomBaseUrl,
  DEFAULT_CLASSROOM_PORT,
  probeClassroomServer,
  spawnClassroomServer,
  stopClassroomServer,
  waitForClassroomServer,
} from './serverLifecycle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

const PORT = Number(process.env.PORT || process.env.CLASSROOM_PORT || DEFAULT_CLASSROOM_PORT)
const BASE_URL = classroomBaseUrl(PORT)

/** @type {import('node:child_process').ChildProcess | null} */
let ownedServer = null
let weStartedServer = false

/** @type {{ promptHandled: boolean, serverStarted: boolean, serverOwned: boolean, relayBaseUrl: string | null }} */
let desktopState = {
  promptHandled: false,
  serverStarted: false,
  serverOwned: false,
  relayBaseUrl: null,
}

function scriptPath() {
  return path.join(repoRoot, 'server', 'classroom.mjs')
}

function distIndexPath() {
  return path.join(repoRoot, 'dist', 'index.html')
}

function setupInstructions() {
  return [
    'Classroom Server is not running on this PC.',
    '',
    'For a live multi-student class on your Wi‑Fi:',
    '  • Relaunch this app and choose Yes, or',
    '  • In a terminal from the repo: npm run classroom',
    '',
    'Hosted browser demos (GitHub / Vercel) cannot start the server.',
    'Students join the LAN URL printed when the relay starts (Windows PCs only).',
    '',
    'Simulation only — no real aircraft.',
  ].join('\n')
}

function ensureDistOrWarn() {
  if (existsSync(distIndexPath())) return true
  void dialog.showMessageBox({
    type: 'warning',
    buttons: ['OK'],
    title: 'Classroom UI missing',
    message: 'Classroom UI build not found (dist/index.html).',
    detail:
      'From the repo run:\n  npm run classroom\nor:\n  npx vite build --mode classroom\nthen relaunch the desktop app.',
  })
  return false
}

function createWindow(loadTarget) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Classroom Mission Simulator (simulation only)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('dom-ready', () => {
    void win.webContents.executeJavaScript(
      `window.__CLASSROOM_DESKTOP_STATE__ = ${JSON.stringify(desktopState)};`,
      true,
    )
  })

  if (loadTarget.kind === 'url') {
    void win.loadURL(loadTarget.url)
  } else {
    void win.loadFile(loadTarget.file)
  }
  return win
}

async function startOwnedServer() {
  const already = await probeClassroomServer(BASE_URL)
  if (already.ok) {
    weStartedServer = false
    ownedServer = null
    return { ok: true, owned: false, baseUrl: BASE_URL }
  }

  const child = spawnClassroomServer({
    command: process.execPath,
    scriptPath: scriptPath(),
    args: [String(PORT)],
    cwd: repoRoot,
    env: buildServerEnv(process.env, { electronAsNode: true }),
  })
  ownedServer = child
  weStartedServer = true

  child.on('exit', (code, signal) => {
    if (ownedServer === child) {
      ownedServer = null
      weStartedServer = false
    }
    if (code && code !== 0) {
      console.error(`Classroom server exited (code=${code}, signal=${signal ?? 'none'})`)
    }
  })
  child.stderr?.on('data', (buf) => {
    process.stderr.write(buf)
  })
  child.stdout?.on('data', (buf) => {
    process.stdout.write(buf)
  })

  const ready = await waitForClassroomServer(BASE_URL, { timeoutMs: 45_000 })
  if (!ready.ok) {
    stopClassroomServer(child)
    ownedServer = null
    weStartedServer = false
    return { ok: false, owned: false, reason: ready.reason }
  }
  return { ok: true, owned: true, baseUrl: BASE_URL }
}

function cleanupOwnedServer() {
  if (weStartedServer && ownedServer) {
    stopClassroomServer(ownedServer)
    ownedServer = null
    weStartedServer = false
  }
}

async function boot() {
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Yes', 'No'],
    defaultId: 0,
    cancelId: 1,
    title: 'Classroom Server',
    message: 'Start the Classroom Server?',
    detail:
      'Yes starts the LAN relay on this PC and keeps it running until you close this app.\n'
      + 'No skips auto-start (connects if a relay is already up, or shows short setup).',
    noLink: true,
  })

  desktopState.promptHandled = true

  if (choice.response === 0) {
    if (!ensureDistOrWarn()) {
      app.quit()
      return
    }
    const started = await startOwnedServer()
    if (!started.ok) {
      await dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Classroom Server',
        message: 'Could not start the Classroom Server.',
        detail:
          `Reason: ${started.reason ?? 'unknown'}\n\n`
          + `Confirm dist/ exists and port ${PORT} is free, then try again.`,
      })
      desktopState.serverStarted = false
      desktopState.serverOwned = false
      desktopState.relayBaseUrl = null
      createWindow({ kind: 'file', file: distIndexPath() })
      return
    }
    desktopState.serverStarted = true
    desktopState.serverOwned = started.owned
    desktopState.relayBaseUrl = started.baseUrl
    createWindow({ kind: 'url', url: `${started.baseUrl}/` })
    return
  }

  // No — connect if already up; otherwise setup + optional continue without.
  const probe = await probeClassroomServer(BASE_URL)
  if (probe.ok) {
    desktopState.serverStarted = true
    desktopState.serverOwned = false
    desktopState.relayBaseUrl = BASE_URL
    createWindow({ kind: 'url', url: `${BASE_URL}/` })
    return
  }

  const follow = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Open UI without server', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    title: 'Classroom setup',
    message: 'Continue without a live Classroom Server?',
    detail: setupInstructions(),
    noLink: true,
  })

  desktopState.serverStarted = false
  desktopState.serverOwned = false
  desktopState.relayBaseUrl = null

  if (follow.response !== 0) {
    app.quit()
    return
  }
  if (!ensureDistOrWarn()) {
    app.quit()
    return
  }
  createWindow({ kind: 'file', file: distIndexPath() })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    void boot()
  })

  app.on('window-all-closed', () => {
    cleanupOwnedServer()
    app.quit()
  })

  app.on('before-quit', () => {
    cleanupOwnedServer()
  })
}

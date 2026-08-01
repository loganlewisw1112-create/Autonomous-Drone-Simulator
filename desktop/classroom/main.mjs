/**
 * Electron main process — Windows classroom desktop shell.
 *
 * Pre-load dialog: start Classroom Server? Start → spawn server/classroom.mjs
 * (Electron-as-Node), wait until healthy, open UI. Quit → exit. The app never
 * loads the renderer from file:// or attaches to an unowned relay. App quit
 * kills only the server this process started.
 *
 * Browser / Vercel builds never load this file.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureClassroomCertificates } from '../../server/classroomTls.mjs'
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
const appRoot = app.getAppPath()

const PORT = Number(process.env.PORT || process.env.CLASSROOM_PORT || DEFAULT_CLASSROOM_PORT)
const BASE_URL = classroomBaseUrl(PORT, { secure: true })

/** @type {import('node:child_process').ChildProcess | null} */
let ownedServer = null
let weStartedServer = false
const administratorToken = randomBytes(32).toString('base64url')
let relayCertificates = null

/** @type {{ promptHandled: boolean, serverStarted: boolean, serverOwned: boolean, relayBaseUrl: string | null, relayJoinBaseUrl: string | null }} */
let desktopState = {
  promptHandled: false,
  serverStarted: false,
  serverOwned: false,
  relayBaseUrl: null,
  relayJoinBaseUrl: null,
}
const desktopWindowSenderIds = new Set()

function lanHostnames() {
  const hosts = new Set()
  for (const networks of Object.values(os.networkInterfaces())) {
    for (const network of networks || []) {
      if (network.family === 'IPv4' && !network.internal) hosts.add(network.address)
    }
  }
  return [...hosts].sort((a, b) => {
    const rank = (value) => value.startsWith('192.168.') ? 0
      : value.startsWith('10.') ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(value) ? 2
          : 3
    return rank(a) - rank(b) || a.localeCompare(b)
  })
}

function publicDesktopState() {
  return {
    isDesktop: true,
    promptHandled: desktopState.promptHandled === true,
    serverStarted: desktopState.serverStarted === true,
    serverOwned: desktopState.serverOwned === true,
    relayBaseUrl: typeof desktopState.relayBaseUrl === 'string' ? desktopState.relayBaseUrl : null,
    relayJoinBaseUrl: typeof desktopState.relayJoinBaseUrl === 'string'
      ? desktopState.relayJoinBaseUrl
      : null,
  }
}

ipcMain.on('classroom-desktop:get-state', (event) => {
  if (!desktopWindowSenderIds.has(event.sender.id)) {
    event.returnValue = null
    return
  }
  event.returnValue = publicDesktopState()
})

ipcMain.handle('classroom-desktop:provision-instructor-access', async (event, code) => {
  if (!desktopWindowSenderIds.has(event.sender.id)) return { ok: false, error: 'unauthorized-renderer' }
  if (!weStartedServer || !ownedServer) return { ok: false, error: 'relay-not-owned' }
  if (typeof code !== 'string' || code.normalize('NFKC').length < 12 || code.normalize('NFKC').length > 128) {
    return { ok: false, error: 'invalid-code-policy' }
  }

  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Provision access code', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Provision instructor access',
    message: 'Set this as the school instructor access code?',
    detail: 'This changes the local classroom relay credential. The code itself will not be displayed or stored by the desktop shell.',
    noLink: true,
  })
  if (confirmation.response !== 0) return { ok: false, error: 'cancelled' }

  try {
    const status = await postOwnedRelayAdmin(
      '/api/instructor-access/provision',
      { code: code.normalize('NFKC') },
    )
    if (status >= 200 && status < 300) return { ok: true }
    if (status === 409) return { ok: false, error: 'already-configured' }
    if (status === 401 || status === 403) return { ok: false, error: 'administrator-rejected' }
    return { ok: false, error: 'provision-failed' }
  } catch {
    return { ok: false, error: 'relay-unreachable' }
  }
})

function postOwnedRelayAdmin(pathname, body) {
  if (!relayCertificates) return Promise.reject(new Error('relay-certificate-unavailable'))
  const encoded = Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const request = https.request(`${BASE_URL}${pathname}`, {
      method: 'POST',
      ca: relayCertificates.caCertificatePem,
      rejectUnauthorized: true,
      headers: {
        'content-type': 'application/json',
        'content-length': String(encoded.byteLength),
        'x-classroom-admin-token': administratorToken,
      },
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 500))
    })
    request.on('error', reject)
    request.end(encoded)
  })
}

function scriptPath() {
  return path.join(appRoot, 'server', 'classroom.mjs')
}

function distIndexPath() {
  return path.join(appRoot, 'dist', 'index.html')
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

/**
 * @param {string} ownedRelayUrl
 */
function createWindow(ownedRelayUrl) {
  const allowedOrigin = new URL(ownedRelayUrl).origin
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
      webSecurity: true,
    },
  })
  desktopWindowSenderIds.add(win.webContents.id)
  win.on('closed', () => desktopWindowSenderIds.delete(win.webContents.id))

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' && !target.username && !target.password) {
        void shell.openExternal(target.toString())
      }
    } catch { /* invalid and non-HTTPS URLs stay blocked */ }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      if (target.origin !== allowedOrigin) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  win.webContents.session.setCertificateVerifyProc((request, callback) => {
    const expected = relayCertificates?.fingerprint256?.replaceAll(':', '').toLowerCase()
    const received = request.certificate?.fingerprint?.replaceAll(':', '').toLowerCase()
    const ownedHost = request.hostname === '127.0.0.1' || request.hostname === 'localhost'
    if (ownedHost && expected && received === expected) {
      callback(0)
      return
    }
    callback(-3)
  })

  void win.loadURL(ownedRelayUrl)
  return win
}

/**
 * @returns {Promise<
 *   { ok: true, owned: true, baseUrl: string, joinBaseUrl: string }
 *   | { ok: false, owned: false, reason: string }
 * >}
 */
async function startOwnedServer() {
  const tlsDirectory = path.join(app.getPath('userData'), 'tls')
  const secretsDirectory = path.join(app.getPath('userData'), 'secrets')
  const runsDirectory = path.join(app.getPath('userData'), 'classroom-runs')
  const classroomLanHosts = lanHostnames()
  if (classroomLanHosts.length === 0) {
    return { ok: false, owned: false, reason: 'no-private-lan-address' }
  }
  relayCertificates = await ensureClassroomCertificates({
    directory: tlsDirectory,
    hosts: classroomLanHosts,
  })

  const probeOwnedRelay = (baseUrl) => probeClassroomServer(baseUrl, {
    ca: relayCertificates.caCertificatePem,
  })
  const already = await probeOwnedRelay(BASE_URL)
  if (already.ok) {
    return { ok: false, owned: false, reason: 'relay-port-already-in-use' }
  }

  const child = /** @type {import('node:child_process').ChildProcess} */ (spawnClassroomServer({
    command: process.execPath,
    scriptPath: scriptPath(),
    args: [String(PORT)],
    cwd: app.getPath('userData'),
    env: {
      ...buildServerEnv(process.env, { electronAsNode: true }),
      CLASSROOM_ADMIN_TOKEN: administratorToken,
      CLASSROOM_TLS_DIR: tlsDirectory,
      CLASSROOM_SECRETS_DIR: secretsDirectory,
      CLASSROOM_RUNS_DIR: runsDirectory,
    },
  }))
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

  const ready = await waitForClassroomServer(BASE_URL, {
    timeoutMs: 45_000,
    probe: probeOwnedRelay,
  })
  if (ready.ok === false) {
    stopClassroomServer(/** @type {any} */ (child))
    ownedServer = null
    weStartedServer = false
    return { ok: false, owned: false, reason: ready.reason }
  }
  return {
    ok: true,
    owned: true,
    baseUrl: BASE_URL,
    joinBaseUrl: `https://${classroomLanHosts[0]}:${PORT}`,
  }
}

function cleanupOwnedServer() {
  if (weStartedServer && ownedServer) {
    stopClassroomServer(/** @type {any} */ (ownedServer))
    ownedServer = null
    weStartedServer = false
  }
}

async function boot() {
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Start server', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    title: 'Classroom Server',
    message: 'Start the owned Classroom Server?',
    detail:
      'The desktop host starts and certificate-pins its own LAN relay on this PC, '
      + 'then keeps it running until you close the app.',
    noLink: true,
  })

  desktopState.promptHandled = true

  if (choice.response === 0) {
    if (!ensureDistOrWarn()) {
      app.quit()
      return
    }
    const started = await startOwnedServer()
    if (started.ok === false) {
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
      desktopState.relayJoinBaseUrl = null
      app.quit()
      return
    }
    desktopState.serverStarted = true
    desktopState.serverOwned = started.owned
    desktopState.relayBaseUrl = started.baseUrl
    desktopState.relayJoinBaseUrl = started.joinBaseUrl
    createWindow(`${started.baseUrl}/`)
    return
  }
  app.quit()
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

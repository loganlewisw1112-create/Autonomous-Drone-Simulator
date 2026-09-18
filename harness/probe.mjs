// Playwright driver. HEADED Chromium, fixed 1600×1000 viewport, deviceScaleFactor 1 — headless GL
// differs enough on Windows to make WebGL and perf assertions untrustworthy (plan P-0.4).
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, BASE_URL, VIEWPORT } from './config.mjs'

const MAP_SELECTOR = '.maplibregl-map'
// Every startup surface the app can mount on a cold load of the windows target. The gate asserts
// none of these exist under ?harness=1. (Classroom prompts only exist in classroom-target builds.)
export const INTERSTITIAL_SELECTORS = ['[aria-modal="true"]', '.modal-overlay', '.ls-check-row']

async function launchBrowser() {
  const opts = { headless: false, args: ['--window-position=0,0', `--window-size=${VIEWPORT.width + 40},${VIEWPORT.height + 140}`] }
  try {
    return { browser: await chromium.launch(opts), channel: 'bundled-chromium' }
  } catch {
    // No matching bundled Chromium cached: use the system Chrome rather than downloading one.
    return { browser: await chromium.launch({ ...opts, channel: 'chrome' }), channel: 'chrome' }
  }
}

/**
 * One probe = one browser launch with a brand-new profile (Playwright contexts are always cold:
 * no localStorage, no sessionStorage, no cache carried over).
 */
export async function openProbe({ url = BASE_URL } = {}) {
  const { browser, channel } = await launchBrowser()
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.__harness), null, { timeout: 30_000 })

  const probe = {
    page,
    channel,
    /** Run a function in the page; it reaches the surface through `window.__harness`. */
    eval: (fn, arg) => page.evaluate(fn, arg),
    async ready(timeoutMs = 30_000) {
      const started = Date.now()
      // One retry: a basemap tile request occasionally stalls (remote tile server), which holds
      // map.loaded() false. A second wait is cheap; a genuinely stuck map still fails, just later.
      await page.evaluate((t) => window.__harness.ready(t), timeoutMs)
        .catch(() => page.evaluate((t) => window.__harness.ready(t), timeoutMs))
      return Date.now() - started
    },
    /** PNG of the map region only — app chrome (mission clock, panels) is outside the claim. */
    async shot(name) {
      mkdirSync(ARTIFACTS, { recursive: true })
      const path = name ? resolve(ARTIFACTS, name) : undefined
      if (path) mkdirSync(resolve(path, '..'), { recursive: true })
      return page.locator(MAP_SELECTOR).first().screenshot({ path, animations: 'disabled', caret: 'hide' })
    },
    interstitials: () => page.evaluate(
      (selectors) => selectors.filter((s) => document.querySelector(s) !== null), INTERSTITIAL_SELECTORS),
    consoleErrors: (regex) => (regex ? consoleErrors.filter((e) => regex.test(e)) : consoleErrors.slice()),
    async close() {
      await context.close()
      await browser.close()
    },
  }
  return probe
}

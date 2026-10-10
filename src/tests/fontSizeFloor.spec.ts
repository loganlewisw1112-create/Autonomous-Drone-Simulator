import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Text-size floor. Phones render at least 12px and desktop at least 11px, and the only way to
// get there without an import graph is to forbid every literal under 12 in the shipped UI source:
// a size is either >= 12 or it is `var(--fs-min)` (11px on :root, 12px under .mobile-shell) or
// another `var(--fs-*)`. A literal of 9, 10 or 11 is a violation unless it is allowlisted below
// with a written reason. Allowlist entries are keyed by file + trimmed line text + occurrence
// count, and a stale entry (count differs, or the line no longer violates) fails the guard.
//
// Out of scope by design: MapLibre `text-size` and canvas `ctx.font = ...` (not DOM text), the
// classroom edition (src/components/classroom/**, src/classroom/**) and scenario fixtures.

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const ALLOWLIST_PATH = join(SRC, 'tests', 'fontSizeFloor.allowlist.json')

export const FLOOR = 12
export const ROOT_FLOOR = 11
export const MOBILE_FLOOR = 12

interface Violation { file: string; line: number; text: string; rule: 'A' | 'B' | 'C' | 'D'; detail: string }
interface AllowEntry { file: string; text: string; count: number; reason: string }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const norm = (p: string) => p.split(sep).join('/').replace(/\\/g, '/')

function isExempt(rel: string): boolean {
  return rel.startsWith('src/tests/')
    || rel.startsWith('src/components/classroom/')
    || rel.startsWith('src/classroom/')
    || rel.startsWith('src/scenarios/fixtures/')
}

/** Blank out comments but keep every newline and column, so line numbers stay true. */
export function stripComments(source: string, kind: 'css' | 'code'): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  let out = source.replace(/\/\*[\s\S]*?\*\//g, blank)
  if (kind === 'code') {
    // `//` is a comment only at line start or after whitespace, so `https://` survives.
    out = out.replace(/(^|\s)\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
  }
  return out
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

/** px value of a CSS length, rem/em x 16. Null when the token carries no absolute size. */
function toPx(n: number, unit: string): number {
  return unit === 'rem' || unit === 'em' ? n * 16 : n
}

const KEYWORD_SIZES: Record<string, number> = { 'xx-small': 9, 'x-small': 10, smaller: 11 }

/** Smallest absolute size named by a CSS `font-size` value, or null if it is var(--fs-*) / not absolute. */
function sizesInCssValue(value: string): number[] {
  if (/var\(\s*--fs-/.test(value)) return []
  const sizes: number[] = []
  for (const m of value.matchAll(/(?<![\w.#-])(\d+(?:\.\d+)?|\.\d+)(px|rem|em)\b/g)) sizes.push(toPx(Number(m[1]), m[2]))
  for (const m of value.matchAll(/(?<![\w-])(xx-small|x-small|smaller)(?![\w-])/g)) sizes.push(KEYWORD_SIZES[m[1]])
  if (sizes.length === 0 && /^\s*0(?![\w.%])/.test(value)) sizes.push(0)
  return sizes
}

/** Rule A: `fontSize:` expressions (numbers inside ternaries included) and `.fontSize =` assignments. */
function scanFontSizeProps(rel: string, clean: string, lines: string[], out: Violation[]) {
  const re = /(?:\bfontSize\s*:|\.fontSize\s*=(?!=))\s*/g
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    let i = m.index + m[0].length
    const start = i
    let depth = 0
    let quote: string | null = null
    for (; i < clean.length; i++) {
      const ch = clean[i]
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth-- }
      else if ((ch === ',' || ch === ';') && depth === 0) break
      else if (ch === '\n' && depth === 0 && !/^\s*$/.test(clean.slice(start, i))) {
        // the expression continues on the next line only after a trailing operator or before a leading one
        const next = /^\s*(\S)/.exec(clean.slice(i + 1))?.[1] ?? ''
        if (!/[?:+\-*/&|=<>]\s*$/.test(clean.slice(start, i)) && !'?:+-*/&|'.includes(next)) break
      }
    }
    const expr = clean.slice(start, i)
    const line = lineOf(clean, m.index)
    const found: number[] = []
    // string tokens: need an explicit unit ('9px', '0.7rem'); a bare '10' is not a CSS size
    const bare = expr.replace(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g, (_s, _q, body: string) => {
      found.push(...sizesInCssValue(body))
      return ' '.repeat(_s.length)
    })
    // bare numeric literals that are standalone operands (ternary arms, Math.max(10, x) args), not arithmetic or comparisons
    for (const n of bare.matchAll(/(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.])/g)) {
      const before = bare.slice(0, n.index).trimEnd().slice(-1)
      const after = bare.slice((n.index ?? 0) + n[0].length).trimStart()[0] ?? ''
      if ((before === '' || '?:(,'.includes(before)) && (after === '' || ':,)'.includes(after))) found.push(Number(n[1]))
    }
    if (/var\(\s*--fs-/.test(expr) && found.length === 0) continue
    for (const px of found) {
      if (px < FLOOR) out.push({ file: rel, line, text: lines[line - 1].trim(), rule: 'A', detail: `fontSize ${px}` })
    }
  }
}

/** Rule B: `font-size:` in CSS and in JS strings / cssText / setProperty('font-size', ...). */
function scanFontSizeDecls(rel: string, clean: string, lines: string[], out: Violation[]) {
  for (const m of clean.matchAll(/(?<![\w-])font-size\s*:\s*([^;}\n]*)/g)) {
    const line = lineOf(clean, m.index ?? 0)
    for (const px of sizesInCssValue(m[1])) {
      if (px < FLOOR) out.push({ file: rel, line, text: lines[line - 1].trim(), rule: 'B', detail: `font-size ${px}px` })
    }
  }
  for (const m of clean.matchAll(/setProperty\(\s*['"]font-size['"]\s*,\s*([^)]*)\)/g)) {
    const line = lineOf(clean, m.index ?? 0)
    const sizes = [...sizesInCssValue(m[1].replace(/^\s*['"`]|['"`]\s*$/g, ''))]
    if (sizes.length === 0 && /^\s*\d+(\.\d+)?\s*$/.test(m[1])) sizes.push(Number(m[1]))
    for (const px of sizes) if (px < FLOOR) out.push({ file: rel, line, text: lines[line - 1].trim(), rule: 'B', detail: `setProperty font-size ${px}px` })
  }
}

/** Rule C: every size in a `font:` shorthand (CSS declaration or style-object key); a line-height after `/` is not a size. */
function scanFontShorthand(rel: string, clean: string, lines: string[], out: Violation[]) {
  for (const m of clean.matchAll(/(?<![\w-])font\s*:\s*([^;}\n]*)/g)) {
    if (/var\(\s*--fs-/.test(m[1])) continue
    const line = lineOf(clean, m.index ?? 0)
    for (const size of m[1].matchAll(/(?<![\w.#/-])(\d+(?:\.\d+)?|\.\d+)(px|rem|em)\b/g)) {
      const px = toPx(Number(size[1]), size[2])
      if (px < FLOOR) out.push({ file: rel, line, text: lines[line - 1].trim(), rule: 'C', detail: `font shorthand ${px}px` })
    }
  }
}

/** Rule D: --fs-* custom properties must be >= 11 on :root and >= 12 inside .mobile-shell. */
function scanFsTokens(rel: string, clean: string, lines: string[], out: Violation[]) {
  for (const m of clean.matchAll(/(--fs-[\w-]+)\s*:\s*([^;}\n]*)/g)) {
    const idx = m.index ?? 0
    const open = clean.lastIndexOf('{', idx)
    const selStart = Math.max(clean.lastIndexOf('}', open), clean.lastIndexOf(';', open), -1) + 1
    const selector = clean.slice(selStart, open).trim()
    const min = /\.mobile-shell/.test(selector) ? MOBILE_FLOOR : ROOT_FLOOR
    for (const px of sizesInCssValue(m[2])) {
      const line = lineOf(clean, idx)
      if (px < min) out.push({ file: rel, line, text: lines[line - 1].trim(), rule: 'D', detail: `${m[1]} ${px}px under "${selector}" (min ${min})` })
    }
  }
}

export function scanSource(rel: string, source: string): Violation[] {
  const kind = rel.endsWith('.css') ? 'css' : 'code'
  const clean = stripComments(source, kind)
  const lines = source.split('\n')
  const out: Violation[] = []
  if (kind === 'code') scanFontSizeProps(rel, clean, lines, out)
  scanFontSizeDecls(rel, clean, lines, out)
  scanFontShorthand(rel, clean, lines, out)
  scanFsTokens(rel, clean, lines, out)
  return out
}

function scanRepo(): Violation[] {
  return walk(SRC)
    .filter((p) => /\.(ts|tsx|css)$/.test(p))
    .map((p) => norm(relative(ROOT, p)))
    .filter((rel) => !isExempt(rel))
    .flatMap((rel) => scanSource(rel, readFileSync(join(ROOT, rel), 'utf8')))
}

const flagged = (rel: string, src: string) => scanSource(rel, src).length

describe('font size floor: scanner self-test', () => {
  it.each([
    ['inline number', 'x.tsx', "<b style={{ fontSize: 9 }} />"],
    ['inline 11 (desktop-only literal)', 'x.tsx', "<b style={{ fontSize: 11 }} />"],
    ['inline px string', 'x.tsx', "<b style={{ fontSize: '10px' }} />"],
    ['ternary arm', 'x.tsx', "<b style={{ fontSize: compact ? 10 : 9 }} />"],
    ['ternary with only the second arm low', 'x.tsx', "<b style={{ fontSize: wide ? 14 : 9 }} />"],
    ['fractional', 'x.tsx', "<b style={{ fontSize: 8.5 }} />"],
    ['rem string', 'x.tsx', "<b style={{ fontSize: '0.7rem' }} />"],
    ['font shorthand in css', 'x.css', '.a { font: 700 9px/1.2 x; }'],
    ['font shorthand ternary arm', 'x.tsx', "const s = { font: phone ? '12px x' : '11px x' }"],
    ['font shorthand in style object', 'x.tsx', "const s = { font: '700 9px/1.2 x' }"],
    ['css px', 'x.css', '.a { font-size: 10px; }'],
    ['css 11px', 'x.css', '.a { font-size: 11px; }'],
    ['css rem 0.7 = 11.2', 'x.css', '.a { font-size: 0.7rem; }'],
    ['css keyword', 'x.css', '.a { font-size: x-small; }'],
    ['css smaller', 'x.css', '.a { font-size: smaller; }'],
    ['css zero', 'x.css', '.a { font-size: 0; }'],
    ['cssText string', 'x.ts', "el.style.cssText = 'color:red;font-size:9px;'"],
    ['setProperty', 'x.ts', "el.style.setProperty('font-size', '9px')"],
    ['.fontSize assignment', 'x.ts', "el.style.fontSize = '10px'"],
    ['fs token below root floor', 'x.css', ':root { --fs-min: 10px; }'],
    ['fs token below mobile floor', 'x.css', '.mobile-shell {\n  --fs-min: 11px;\n}'],
  ])('flags %s', (_name, file, src) => {
    expect(flagged(`src/${file}`, src)).toBeGreaterThan(0)
  })

  it.each([
    ['inline 12', 'x.tsx', "<b style={{ fontSize: 12 }} />"],
    ['var(--fs-min)', 'x.tsx', "<b style={{ fontSize: 'var(--fs-min)' }} />"],
    ['ternary of tokens', 'x.tsx', "<b style={{ fontSize: compact ? 'var(--fs-min)' : 14 }} />"],
    ['maplibre text-size', 'x.ts', "paint: { 'text-size': 10 }"],
    ['canvas font', 'x.ts', 'ctx.font = `9px x`'],
    ['canvas font shorthand string', 'x.ts', "ctx.font = '700 9px x'"],
    ['css 12px', 'x.css', '.a { font-size: 12px; }'],
    ['css var', 'x.css', '.a { font-size: var(--fs-min); }'],
    ['css calc over a token', 'x.css', '.a { font-size: calc(var(--fs-min) + 2px); }'],
    ['css rem 0.75 = 12', 'x.css', '.a { font-size: 0.75rem; }'],
    ['comment only', 'x.css', '/* font-size: 9px; */ .a { color: red; }'],
    ['line comment', 'x.tsx', '// fontSize: 9\nconst a = 1'],
    ['block comment in code', 'x.tsx', '/* fontSize: 9 */ const a = 1'],
    ['url with //', 'x.ts', "const u = 'https://example.com/a'; const s = { fontSize: 13 }"],
    ['font shorthand 12', 'x.css', '.a { font: 700 12px/1.2 x; }'],
    ['font shorthand line-height is not a size', 'x.css', '.a { font: 700 12px/9px x; }'],
    ['font shorthand keyword', 'x.css', '.a { font: inherit; }'],
    ['arithmetic and comparison are not sizes', 'x.tsx', "<b style={{ fontSize: w > 5 ? 14 : 16 }} />"],
    ['computed expression', 'x.tsx', "<b style={{ fontSize: base * 0.9 }} />"],
    ['fs token at root floor', 'x.css', ':root { --fs-min: 11px; }'],
    ['fs token at mobile floor', 'x.css', '.mobile-shell {\n  --fs-min: 12px;\n}'],
    ['letter-spacing is not font size', 'x.css', '.a { letter-spacing: 9px; }'],
  ])('does not flag %s', (_name, file, src) => {
    expect(scanSource(`src/${file}`, src)).toEqual([])
  })

  it('reports the line of a multi-line ternary', () => {
    const v = scanSource('src/x.tsx', "const a = 1\nconst s = {\n  fontSize: compact\n    ? 10\n    : 9,\n}")
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].line).toBe(3)
  })

  it('exempts the classroom edition, fixtures and tests by path', () => {
    for (const rel of ['src/components/classroom/a.tsx', 'src/classroom/a.ts', 'src/scenarios/fixtures/a.ts', 'src/tests/a.ts']) {
      expect(isExempt(rel)).toBe(true)
    }
    expect(isExempt('src/components/ControlBar.tsx')).toBe(false)
  })
})

describe('font size floor: shipped UI source', () => {
  const allow: AllowEntry[] = existsSync(ALLOWLIST_PATH) ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as AllowEntry[] : []
  const violations = scanRepo()
  const key = (file: string, text: string) => `${file}\u0000${text}`
  const grouped = new Map<string, { file: string; text: string; count: number }>()
  for (const v of violations) {
    const k = key(v.file, v.text)
    const g = grouped.get(k)
    if (g) g.count++
    else grouped.set(k, { file: v.file, text: v.text, count: 1 })
  }

  it('allowlist entries are well formed, unique and carry a reason', () => {
    const seen = new Set<string>()
    for (const e of allow) {
      expect(e.reason?.trim().length ?? 0, `allowlist entry ${e.file} :: ${e.text} needs a reason`).toBeGreaterThan(10)
      expect(Number.isInteger(e.count) && e.count > 0, `allowlist entry ${e.file} :: ${e.text} needs a positive count`).toBe(true)
      expect(seen.has(key(e.file, e.text)), `duplicate allowlist entry ${e.file} :: ${e.text}`).toBe(false)
      seen.add(key(e.file, e.text))
    }
  })

  it('has no text below 12px (phones) or 11px (desktop) outside the allowlist', () => {
    const allowed = new Map(allow.map((e) => [key(e.file, e.text), e.count]))
    const offenders = violations.filter((v) => !allowed.has(key(v.file, v.text)))
    expect(
      offenders.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail} :: ${v.text}`),
      'Use var(--fs-min) (11px desktop, 12px phone) or a literal >= 12, or allowlist with a reason in src/tests/fontSizeFloor.allowlist.json',
    ).toEqual([])
  })

  it('has no stale allowlist entries (count must match the real occurrences)', () => {
    const stale = allow
      .filter((e) => (grouped.get(key(e.file, e.text))?.count ?? 0) !== e.count)
      .map((e) => `${e.file} :: ${e.text} (allowlisted ${e.count}, found ${grouped.get(key(e.file, e.text))?.count ?? 0})`)
    expect(stale).toEqual([])
  })
})

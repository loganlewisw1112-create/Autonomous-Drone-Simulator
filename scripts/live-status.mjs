#!/usr/bin/env node
/**
 * What is ACTUALLY live right now?
 *
 * Fetches /build-info.json from every public target and compares the deployed Git SHA
 * against this checkout, so "is my change live?" is answered by the deployments
 * themselves rather than by reading scripts and inferring.
 *
 * Why this exists: on 2026-09-22 the deployment model was described from
 * `package.json` alone ("it deploys via gh-pages") and that was wrong — gh-pages is
 * vestigial here, referenced by no workflow. The real path is
 * `.github/workflows/deploy.yml`: CI must succeed on a push to `main`, which then
 * fires a protected Vercel Deploy Hook per target. Vercel's own auto-deploy from
 * `main` is deliberately disabled in `vercel.json` so promotion cannot bypass CI.
 * The conclusion drawn back then happened to be right for the wrong reason, which is
 * the failure mode this script removes: one command, real answer.
 *
 *   npm run deploy:status
 *
 * Exit code is 0 whenever every target answered, regardless of whether they are
 * behind — being behind is normal and is not an error. Exit 1 means a target could
 * not be reached or returned something unparseable.
 */

import { execSync } from 'node:child_process';

const TARGETS = [
  { name: 'windows', url: 'https://autonomous-drone-simulator.vercel.app' },
  { name: 'mobile', url: 'https://autonomous-drone-simulator-mobile.vercel.app' },
  { name: 'classroom', url: 'https://autonomous-drone-simulator-classroom.vercel.app' },
];

const TIMEOUT_MS = 20_000;

/**
 * Run a git command and return trimmed stdout, or `fallback` if it fails.
 * NOTE: avoid `^` and shell chaining in `cmd` — on Windows execSync goes through
 * cmd.exe, where `^` is the escape character (it silently mangles `<sha>^{commit}`).
 * Use gitOk() for exit-code checks instead of `&& echo`.
 */
function git(cmd, fallback = null) {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

/** True when the git command exits 0. Shell-agnostic. */
function gitOk(cmd) {
  try {
    execSync(`git ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function fetchBuildInfo({ name, url }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/build-info.json`, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) return { name, url, error: `HTTP ${res.status}` };
    return { name, url, info: await res.json() };
  } catch (err) {
    return { name, url, error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Where does a deployed SHA sit relative to local main? */
function describeRelation(sha) {
  if (!sha) return 'no gitSha in build-info';
  if (git(`cat-file -t ${sha}`) !== 'commit') {
    return 'commit not in this checkout (try: git fetch --all)';
  }

  if (gitOk(`merge-base --is-ancestor ${sha} origin/main`)) {
    const behind = git(`rev-list --count ${sha}..origin/main`, '?');
    return behind === '0' ? 'up to date with origin/main' : `${behind} commit(s) behind origin/main`;
  }

  // Not an ancestor: most often the pre-squash branch commit whose squashed twin is on
  // main. Identical trees means the deployed CONTENT matches main even though the SHA
  // differs — worth saying explicitly, because the SHA comparison alone looks alarming.
  if (gitOk(`diff --quiet ${sha} origin/main`)) {
    return 'not on main history, but content identical to origin/main (squash-merge twin)';
  }
  return 'not on origin/main history, and content differs';
}

const results = await Promise.all(TARGETS.map(fetchBuildInfo));

const localHead = git('rev-parse --short HEAD', '?');
const localBranch = git('rev-parse --abbrev-ref HEAD', '?');
const mainHead = git('rev-parse --short origin/main', '?');

console.log('');
console.log(`local:  ${localBranch} @ ${localHead}`);
console.log(`main:   origin/main @ ${mainHead}`);
console.log('');

let failed = false;
for (const r of results) {
  if (r.error) {
    failed = true;
    console.log(`  ${r.name.padEnd(10)} UNREACHABLE  (${r.error})`);
    continue;
  }
  const { version, target, gitSha, distributionChannel } = r.info;
  const short = typeof gitSha === 'string' ? gitSha.slice(0, 7) : String(gitSha);
  console.log(`  ${r.name.padEnd(10)} ${String(version).padEnd(12)} ${short}  ${describeRelation(gitSha)}`);
  if (target && target !== r.name) {
    console.log(`  ${''.padEnd(10)} NOTE: serves target "${target}", expected "${r.name}"`);
  }
  if (distributionChannel && distributionChannel !== 'public_demo') {
    console.log(`  ${''.padEnd(10)} NOTE: distributionChannel="${distributionChannel}"`);
  }
}

console.log('');
console.log('Promotion path: push to main -> CI must pass -> .github/workflows/deploy.yml');
console.log('fires the protected Vercel Deploy Hook per target. Vercel git auto-deploy from');
console.log('main is disabled in vercel.json, so nothing reaches production without CI.');
console.log('');

process.exit(failed ? 1 : 0);

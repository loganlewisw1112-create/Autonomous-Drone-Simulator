# Deployment notes

Operational history moved from the README. The designed deployment path is described in the README's **Deployment** paragraph and [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md).

There is no GitHub Pages deployment — `npm run deploy` is retired and now fails with a pointer, because a stale `gh-pages` script in `package.json` had previously been mistaken for the real mechanism. Vercel's own git auto-deploy from `main` is deliberately disabled in [`vercel.json`](../vercel.json) so a push cannot reach production without passing CI first.

That is the *designed* path, and it is worth knowing that it has not always dispatched: promote runs have sat queued with zero jobs, and production has then been brought up to date by aliasing an existing Ready preview build (`vercel alias set <preview-url> <prod-domain>`) instead. That is why a live target's `gitSha` can be a preview-branch commit rather than a `main` SHA — the content can still be identical to `main`. `npm run deploy:status` reports both the deployed SHA's relationship to `main` and the last promote run's state, so a lagging production is diagnosable in one command rather than by hand.

# Admin passes

An admin pass turns an operator profile into an ADMIN profile: every access gate
opens (with a visible "ADMIN override" label), and the debug console becomes
available (Ctrl+` or Ctrl+Shift+D; a DBG button on phones).

A pass is a line of text, `DSA1.<payload>.<signature>`, signed with an Ed25519
key that only the owners hold. The app and the classroom relay carry the public
key (`server/adminKeys.mjs`) and check every pass against it. They can verify a
pass but cannot create one.

## Files

| Path | What it is | In git? |
|---|---|---|
| `local-secrets/admin-signing-key.json` | Private signing key | **Never.** `local-secrets/` is gitignored. Keep an offline backup. |
| `local-secrets/admin-passes/<email>.txt` | Issued passes | Never. Each pass is a bearer credential. |
| `server/adminKeys.mjs` | Trusted public keys + revoked pass ids | Yes |

## Use a pass

1. Sign in to your profile.
2. Open Settings and find **Admin pass**.
3. Paste the whole line from your `.txt` file and choose **Unlock admin**.

The pass is stored on the profile and re-verified at every sign-in. **Remove
admin pass** takes it off again.

## Issue a pass

```bash
node tools/admin/issue-admin-pass.mjs --email someone@example.com --name "Someone"
```

Add `--expires 2027-01-01T00:00:00Z` for a pass that stops working on a date. The
script prints only the output path and the pass id. Send the file privately;
anyone holding it gets admin on whatever profile they paste it into.

## Revoke a pass

Add its pass id to `REVOKED_PASS_IDS` in `server/adminKeys.mjs`, then ship the
change (redeploy the web build and restart any classroom relay). A revoked pass
stops verifying everywhere at the next sign-in.

## Rotate the signing key

1. Move the old `local-secrets/admin-signing-key.json` aside (keygen refuses to
   overwrite it).
2. Run `node tools/admin/admin-keygen.mjs`. It writes the new private key and
   prints only the new public key.
3. Add the new public key to `TRUSTED_ADMIN_PUBLIC_KEYS`, re-issue every pass,
   then remove the old public key and redeploy.

## Limits

- A pass is checked in the browser, so someone who edits their own copy of the
  JavaScript can give themselves admin on their own device. That reaches no one
  else: profiles are local, and the classroom relay verifies passes itself.
- Debug-console changes to a run are recorded in its evidence chain
  (`debug_override`) and keep that run out of analytics.

# Single sign-on (Vibe Auth) — operator notes

Vibe 1040 can let staff sign in through the firm's identity provider instead of a local
password. The identity provider is **Vibe Auth** (bundled authentik plus a broker); this app
talks to it through `@kisaesdevlab/vibe-auth`, OIDC authorization code with PKCE.

Single sign-on is **off until you turn it on**. With `VIBE_AUTH_MODE` unset the app behaves
exactly as it did before P16. Nothing about local accounts, local MFA or password reset
changes in any mode.

| Mode | Sign-in page | Who can use a local password |
|---|---|---|
| `local` (default) | the local form | everyone |
| `both` | the local form and a **Sign in with …** button | everyone |
| `oidc_only` | the button only | the break-glass account, at `/login/local` |

The mode is seeded from the environment and can be changed at **Admin → Authentication**
(admins only). What that page stores overrides the environment, as with every other firm
setting.

---

## The second factor — read this first

MFA is mandatory in this app and cannot be switched off. Single sign-on does not change that
(CLAUDE.md §11, QUESTIONS.md Q18, STATE.md decision log 2026-09-19).

A session that arrives from the identity provider is **already MFA-satisfied** — the user goes
straight to their bundles with no second prompt — and that is only defensible because this app
demands proof. Every ID token carries an `amr` claim listing how the user authenticated. Vibe
1040 accepts the sign-in only if `amr` shows a second factor (`mfa`, or an `otp` / `hwk` /
`webauthn`-style method alongside `pwd`). Otherwise the sign-in is **refused**: no session, an
error page, and a `vibe.auth.login.failure` audit row with `reason: mfa_required`. It is not
downgraded to a local prompt.

Things that follow from this, which differ from the other Vibe products:

- **The "require MFA" switch on the Authentication page does nothing here.** Vibe Auth lets a
  firm turn the `amr` requirement off, with an acknowledgement. This app refuses that request
  (`409 mfa_locked`), ignores the value if it is already stored, and its session adapter
  checks `amr` again on its own. There is no environment variable for it either;
  `VIBE_OIDC_REQUIRE_MFA_AMR` is forced on in code and setting it to `false` has no effect.
- **The Vibe Auth broker must be 1.0.4 or later.** Before 1.0.4, a sign-in during which the
  user *enrolled* their second factor carried no MFA `amr`, so every person's first SSO
  sign-in would be refused here.
- **MFA enforcement must be left on in authentik** (it is by default — the `vibe-mfa-validation`
  stage). If someone disables it there, SSO sign-ins to Vibe 1040 stop working, by design,
  and local sign-in is unaffected.
- The `amr` values are on the `vibe.auth.login.success` audit row for every SSO sign-in, and on
  the session row (`sessions.oidc_amr`). That is the evidence the control ran. Name the
  identity provider as the party performing MFA in the WISP.

On a plain-HTTP LAN origin (`http://<ip>:5177`) browsers offer no passkeys — there is no secure
context — so authentik enrols TOTP or static codes there. That is enough to satisfy `amr`.

---

## Break-glass account

`oidc_only` hides the local form from everyone, so there must be a way in when the identity
provider is down. That is the break-glass account: a local admin, username `vibe-breakglass`
(stored under the email `vibe-breakglass@appliance.local`, because this app signs people in by
email). **The app refuses to start in `oidc_only` without one.**

Provision it inside the running container:

```bash
docker exec -i vibe-1040 node node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure --json
```

It prints the password **once**. Store it where the firm keeps emergency credentials.
`breakglass rotate` issues a new one; `breakglass status` reports whether the account exists.

**Then enrol its authenticator — now, not during an outage.** Unlike the other Vibe products,
this account is *not* exempt from the second factor. Go to `/login/local`, sign in as
`vibe-breakglass` with that password, and complete the authenticator enrolment the same way
the first admin did. An authenticator app needs no SMTP, no SMS and no identity provider, which
is exactly the situation break-glass exists for — but only if the QR code was scanned while
everything still worked. Keep the authenticator with the password.

Every break-glass sign-in writes `vibe.auth.breakglass.used`, which Vibe Sentinel alerts on
(`SENT-V-AUTH-001`). If its authenticator is lost, any other admin can reset the factor under
Admin → Users and it re-enrols at its next sign-in. There is deliberately no way to do that
without a signed-in admin, so test the break-glass sign-in after provisioning it.

---

## Environment

Written by the broker when the app is registered — paste the block it returns:

```
VIBE_OIDC_ISSUER=http://<host>/auth/application/o/vibe-1040/
VIBE_OIDC_INTERNAL_BASE=http://vibe-auth-authentik-server:9000   # origin only; omit if the broker is on another host
VIBE_OIDC_CLIENT_ID=vibe-vibe-1040-<12 hex>
VIBE_OIDC_CLIENT_SECRET=<secret>
VIBE_OIDC_PUBLIC_URL=http://<host>:5177        # this app's public base, no trailing slash
VIBE_OIDC_IDP_NAME=Vibe Auth
```

Set by you:

```
VIBE_AUTH_MODE=local|both|oidc_only            # default local
VIBE_OIDC_ROLE_MAP={"vibe-admin":"admin",...}  # optional; the default map is below
VIBE_OIDC_ALLOW_JIT=true                       # create accounts on first sign-in
VIBE_BREAKGLASS_USERNAME=vibe-breakglass
```

An empty value counts as unset. `VIBE_OIDC_PUBLIC_URL` must carry the scheme the browser
really uses: `http://` on a LAN IP (Caddy issues no certificate for a bare IP), `https://` in
domain mode. The redirect URI is `VIBE_OIDC_PUBLIC_URL + /auth/oidc/callback` and authentik
matches it **exactly**.

The client secret, once saved from the Authentication page, is stored encrypted with
`STORAGE_ENCRYPTION_KEY` — the same key as the documents.

### Roles

Accounts are created on first sign-in with a role mapped from the user's Vibe groups, and the
role is **re-synced on every sign-in** — change someone's group in authentik and their role
here follows at their next sign-in.

| Vibe group | Vibe 1040 role |
|---|---|
| `vibe-admin`, `vibe-it` | `admin` |
| `vibe-partner` | `partner` |
| `vibe-manager`, `vibe-staff` | `staff` |

A user in none of these is refused (`no_role`). An existing local account is linked to its SSO
identity the first time that person signs in through the IdP, by email, case-insensitively —
and only when the IdP says the email is verified. After that the link is the IdP's subject id,
so a later email change does not break it.

A just-in-time account has a random password nobody knows and no local second factor. If the
firm runs `both` and that person wants to sign in locally too, they use **Forgot your
password?** and enrol a factor on that first local sign-in, like any new user.

---

## Registration

### On the Vibe Appliance

**Not automatic yet** (QUESTIONS.md Q19). The console registers a product from its manifest's
`sso` block, and the vendored `vibe-1040` manifest does not have one yet. Until the appliance
change below lands, register by hand as for a standalone install.

Appliance follow-up checklist (in `Vibe-Appliance`, not this repo):

1. `console/manifests/vibe-1040.json` — copy `"requires": ["identity"]`, the `sso` block and the
   `ALLOWED_ORIGIN` env entry from this repo's `.appliance/manifest.json`. Run `npm test` in
   `console/` (manifest validation).
2. `env-templates/per-app/vibe-1040.env.tmpl` — add `ALLOWED_ORIGIN=@ALLOWED_ORIGIN@`. The
   identity script derives the URL it registers from that key. (`VIBE_OIDC_REQUIRE_MFA_AMR=true`
   may be added for legibility; the app forces it regardless.)
3. Confirm the break-glass command resolves in the shipped image:
   `docker run --rm --entrypoint sh ghcr.io/kisaesdevlab/vibe-1040:<tag> -c 'ls node_modules/@kisaesdevlab/vibe-auth/dist/cli.js'`
4. On the host: `sudo vibe identity register vibe-1040`. A rebuilt image alone does not
   re-register.
5. Sign in at `http://<ip>:5177/` in `both`, then `oidc_only` with break-glass at `/login/local`.

### By hand (standalone, or the appliance until the above lands)

```bash
# the broker's console token
sudo grep VIBE_AUTH_CONSOLE_TOKEN /opt/vibe/env/vibe-auth.env

curl -X POST http://<vibe-auth-host>/vibe-auth/registrations \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{
    "slug": "vibe-1040",
    "displayName": "Vibe 1040",
    "baseUrl": "http://<this-app-public-origin>",
    "redirectPaths": ["/auth/oidc/callback"],
    "logoutPaths": ["/auth/oidc/backchannel"],
    "publicPaths": [],
    "internalUrl": "http://vibe-1040:8240"
  }'
```

Append the returned `VIBE_OIDC_*` lines to the app's env, set `VIBE_AUTH_MODE=both`, recreate
the `vibe-1040` container, and check the boot log:

```
[startup] sign-in mode: both — single sign-on via Vibe Auth (reachable); SSO sessions require proof of a second factor (amr), which cannot be disabled here
```

Registration is idempotent on the slug. After a host, IP or routing change, re-register (or
`POST /vibe-auth/rebase`) — the redirect URI is an exact match.

### Networks and back-channel logout

When a user signs out at the identity provider, authentik POSTs a logout token to
`internalUrl + /auth/oidc/backchannel`, container to container, and this app revokes the
matching session rows. For that to arrive, authentik must be able to reach `vibe-1040:8240`:

- On the appliance both are on `vibe_net`. Nothing to do.
- The standalone `docker-compose.yml` here uses the `vibe-suite` network. Put Vibe Auth's
  containers on it as well, or drop `internalUrl` and give the broker a `baseUrl` it can reach.
- **A broker on a different host is not supported by Vibe Auth yet.** It works for sign-in if
  you omit `VIBE_OIDC_INTERNAL_BASE`, but a lost back-channel call is not retried: the session
  here then lives until its 12-hour expiry, or until the user signs out of Vibe 1040.

`/auth/*` is served by the API container itself, which also serves the UI, so no extra Caddy
matcher is needed.

---

## What it writes

- **Migration 0011**: `auth_identities` (the IdP-subject ↔ user link), `auth_settings` (what
  the Authentication page saves, client secret encrypted), `auth_revocations` (unused here),
  and five `oidc_*` columns on `sessions`. Rolling it back drops the links and the stored
  settings; SSO must be re-registered after migrating forward again.
- **Sessions**: an SSO sign-in produces the same `sessions` row and the same `v1040_session`
  cookie (`HttpOnly`, `SameSite=Strict`, `Secure` per `SESSION_SECURE`) as a local one, with
  `oidc_issuer` set. The ID token is kept encrypted, only to hand back to the IdP at sign-out.
- **Audit**: Vibe Auth's event names, verbatim, in `audit_log` behind the same TIN scrubber as
  everything else — `vibe.auth.login.success|failure`, `user.provisioned`, `user.linked`,
  `role.changed`, `logout`, `mode.changed`, `breakglass.used|rotated`, `idp.unreachable`,
  `settings.changed`. Filter the audit viewer by `vibe.auth`.

## Known rough edges

- **The connection test does not report back on its own.** Its popup uses an inline script,
  which this app's Content-Security-Policy blocks deliberately. The result is recorded
  server-side; the Authentication page re-reads when you close the popup.
- **`npm install` needs a token.** `@kisaesdevlab/vibe-auth` is on GitHub Packages, which wants
  a credential even to read. Put `//npm.pkg.github.com/:_authToken=<PAT with read:packages>` in
  your user-level `~/.npmrc` (never in the repo's), or
  `NODE_AUTH_TOKEN=$(gh auth token)` for a one-off. Docker:
  `NODE_AUTH_TOKEN=$(gh auth token) docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN .`
- The package lists Express as a required peer, so npm installs it beside Fastify. Nothing
  loads it; it is dead weight, reported upstream.

## Testing

`npx vitest run test/sso.test.ts` — the real server, the real engine, the real database and a
fake identity provider (`test/helpers/fake-idp.ts`) that signs real tokens. Needs the test
Postgres migrated to 0011 and skips itself, loudly, otherwise.

## Deviations from `Vibe-Auth/docs/integration-plans/vibe-1040.md`

1. **Break-glass enrols TOTP** rather than being marked MFA-satisfied at password login (that
   plan's stated preference). A password-only admin path into taxpayer data is what the locked
   MFA decision forbids.
2. **The `amr` requirement is not configurable**, in three layers, rather than being an env
   template default a firm could change.
3. **Hand-written SQL migration** with a real down, not a drizzle-kit one; the package's SQL is
   inlined so a package upgrade cannot change a schema that has already been migrated.
4. **Break-glass email is `@appliance.local`**, not `@localhost`: this app's sign-in validates
   an email address and rejects a dotless domain.
5. **Vibe-Appliance edits are not in this change** (Q19); the manifest here is ready to copy.
6. **Pinned `^1.0.4`**, not `^1.0.3`, for the broker-side `amr` fix above.

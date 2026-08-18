# Ultra Fischer Authentication

Ultra Fischer keeps the chess experience public. Accounts are an optional server-backed layer for people who want a reusable identity and security settings.

## Architecture

- **Identity and password storage:** Supabase Auth owns normalized email identities, password hashing, email-confirmed state, reset tokens, refresh-token rotation, and provider-side session invalidation. Ultra Fischer never receives or stores a plaintext password.
- **Email delivery:** Supabase Auth sends the confirmation and recovery messages through the project's configured custom SMTP provider. Configure Resend, Postmark, SendGrid, Amazon SES, or another SMTP service in Supabase for production. Supabase's default development mailer is intentionally restricted and is not a production delivery service.
- **Application backend:** `api/auth/[action].js` is a Vercel Node Function. Browser code talks to this same-origin boundary only; the function calls Supabase with server-side environment variables.
- **Browser session:** Supabase access and refresh tokens are stored only in `__Host-uf-access` and `__Host-uf-refresh` cookies. They are `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and never enter `localStorage`, `sessionStorage`, or the page JavaScript runtime.
- **Rate limiting:** `public.auth_rate_limits` is a Supabase Postgres table accessed through the locked-down `consume_auth_rate_limit` function. Keys are HMAC-SHA-256 digests of the action and IP/email identifier, so raw addresses are not stored in the rate-limit table.

## Supabase setup

1. Create a Supabase project and enable email/password sign-up with **Confirm email** enabled.
2. Set the project Site URL to `https://ultra-fischer-retry.vercel.app` and add the production and local URLs to the redirect allow list. Include `https://ultra-fischer-retry.vercel.app/home.html?auth=recovery` and `http://localhost:4175/home.html?auth=recovery`.
3. Apply `supabase/migrations/0001_auth_security.sql` in the Supabase SQL editor or with the Supabase CLI.
4. Set the Confirm signup email template to display `{{ .Token }}` as a six-digit code. The frontend submits that code to `/api/auth/verify-email`, and Supabase validates its expiry and one-time use. Set the Supabase OTP expiry to 600 seconds. The BFF additionally allows at most five verification requests per email in a ten-minute window.
5. Set the Reset password template to link to the app with the provider's hashed token:

   ```text
   {{ .SiteURL }}/home.html?auth=recovery&token_hash={{ .TokenHash }}&type=recovery
   ```

   The app removes the token from the visible URL and sends it once to `/api/auth/verify-recovery`; the server exchanges it with Supabase before showing the new-password form.
6. Configure custom SMTP in Supabase Auth. Disable click tracking for authentication emails so verification and recovery URLs are not rewritten.

The ready-to-apply HTML templates are versioned in `supabase/templates/confirmation.html` and `supabase/templates/recovery.html`. Supabase does not allow template changes while the free-tier default mailer is active, so apply them after custom SMTP is configured.

## Vercel environment variables

Set these for Production, Preview, and local development as appropriate. None of these values belong in client-exposed variables:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Server-side Auth API key for public Auth operations |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for the rate-limit RPC; never expose it to a browser |
| `AUTH_SECRET` | Long random secret used to HMAC rate-limit identifiers |
| `APP_BASE_URL` | Exact app origin used for recovery redirects, normally `https://ultra-fischer-retry.vercel.app` |
| `ALLOWED_ORIGINS` | Comma-separated trusted origins, including local development origins |

Generate a secret locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The repository includes `.env.example` with placeholders and ignores `.env`, `.env.*`, and `.vercel`. No live credentials are committed.

## Flows and limits

- Registration accepts email, password, and confirmation. New passwords must be 8-32 characters. The response is intentionally generic for duplicate addresses; it does not confirm account existence.
- Verification uses the provider's six-digit OTP, 10-minute expiry, and single-use validation. The resend button and server both enforce a 60-second cooldown; the server also limits resends to three per email per hour and fifteen per IP per hour.
- Login is generic for invalid credentials, while an unconfirmed account receives a safe verification-required state. Login attempts are limited to fifteen per IP and eight per email per 15 minutes.
- Forgot-password responses are enumeration-safe. They use a single-use Supabase recovery token and are limited to five requests per IP and three per email per hour.
- Reset and change-password require the new password and confirmation. A password change clears the current application cookies and requires a fresh sign-in.
- Mutating routes require an allowed `Origin` header. Cookies use `SameSite=Lax`, the API is same-origin only, and no wildcard CORS response is emitted.

## Security headers

`vercel.json` applies a restrictive Content Security Policy, `X-Content-Type-Options: nosniff`, clickjacking protection, a strict referrer policy, a permissions policy, and HSTS. Auth responses are explicitly `private, no-store` so a CDN cannot cache a response containing `Set-Cookie`.

## Verification

Focused auth checks run with:

```powershell
node --test api/_lib/auth.test.mjs
node --check api/_lib/auth.js
node --check api/auth/[action].js
node --check maingame/js/auth.js
```

The current deployment also needs the Supabase project migration, SMTP configuration, and Vercel environment variables before the account actions can send real email. Guest gameplay does not depend on those settings and continues to work while account services are unavailable.

## Explicit handling guarantees

- No plaintext passwords are stored or logged by this app.
- No reversible encryption is used for passwords or verification codes.
- No plaintext verification code is stored by this app; Supabase owns the provider-side OTP representation and one-time validation.
- No auth token is stored in browser storage or exposed to client JavaScript.
- No secrets or live credentials are committed.
- Game position persistence, OAuth providers, MFA, and email-address change are outside this first account slice and are not implied by the UI.

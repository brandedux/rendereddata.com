# Contact form — how it sends email

The "Contact sales" / "Talk to us" popup (`index.html` + `src/site.js`) submits straight from the
browser to **[Web3Forms](https://web3forms.com)**, which emails the message to **hello@sorcery.llc**
with the subject **"Rendered Data Contact Form"**. Web3Forms sets the email's `Reply-To` from the
visitor's `email` field, so you reply to them directly from your inbox.

On success the visitor is sent to **`/thanks`** (`thanks.html`), a branded thank-you page. The redirect
is done in JS right after Web3Forms returns success — so it fires for this AJAX form regardless of the
"redirect URL" set in the Web3Forms dashboard (that dashboard setting only applies to plain, non-JS form
posts; both point at the same `/thanks`, so you're covered either way). `serve.mjs` resolves the clean URL
`/thanks` to `thanks.html` locally, exactly as GitHub Pages does.

This needs **no server**, so the site runs as pure static files — hostable on **GitHub Pages**.

## How it's wired

- `src/site.js` → `wireContactForm()` POSTs JSON to `https://api.web3forms.com/submit` with the
  public **access key**, the subject, and the form fields (name, email, company, organization size,
  message).
- The access key (`b79112b2-…`) is a **public, per-form identifier** — safe to commit and ship in
  client code. It only routes submissions to the registered inbox; it cannot read past submissions.
- A hidden `botcheck` honeypot field in the form drops obvious bots. If spam ever becomes a problem,
  turn on hCaptcha in the Web3Forms dashboard and add its widget to the form.
- To change the recipient, edit the email the access key is registered to at web3forms.com (or make a
  new key). To change the subject, edit the `subject` value in `wireContactForm()`.

## Deploy on GitHub Pages (free) with a custom domain

1. Push this repo to GitHub.
2. **Repo → Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`,
   folder `/ (root)`. Save.
3. **Custom domain:** enter your domain (e.g. `rendereddata.com`) in the Pages "Custom domain" box.
   GitHub writes a `CNAME` file into the repo for you.
4. **DNS at your registrar:**
   - `www` (or any subdomain) → a **CNAME** record pointing to `<your-github-username>.github.io`.
   - Apex/root domain (`example.com`) → **A** records to GitHub Pages:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
     (and the matching AAAA records if you want IPv6).
5. Back in Settings → Pages, tick **Enforce HTTPS** once the certificate is issued.

That's it — the form works the moment the page is live; there's nothing server-side to configure.

## Note on the old server-side path

Earlier this repo also grew a server-side route to `/api/contact` that sends via Zoho SMTP:
`serve.mjs` (local dev) and `api/contact.js` + `mailer.mjs`. **That path is not used by the GitHub
Pages + Web3Forms setup** — it only runs if you host on a Node server (Railway, Render, Fly, etc.).
It's kept as an alternative; delete those files if you never plan to self-host the backend.

`serve.mjs` is still handy as the **local dev static server** (`node serve.mjs`), and the form submits
to Web3Forms from localhost just as it will in production.

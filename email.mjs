// Transactional email transport for the gateway (verification links). Picks a provider from env:
//   1. Resend  — HTTPS API (RESEND_API_KEY). Works on hosts that block outbound SMTP (Railway, etc.).
//   2. SMTP    — via mailer.mjs (SMTP_HOST + creds). The self-host fallback.
//   3. none    — returns null; the caller logs the link instead of emailing it.
// Dependency-free: Resend is a single fetch() to https://api.resend.com/emails.
import {sendMail, mailerFromEnv} from './mailer.mjs';

export function makeSender(env = process.env) {
    const from = env.MAIL_FROM || env.CONTACT_FROM || env.SMTP_USER || 'no-reply@rendereddata.com';
    if (env.RESEND_API_KEY) {
        return {
            kind: 'resend',
            from,
            send: async ({to, subject, text, html}) => {
                const res = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json'},
                    body: JSON.stringify({from, to, subject, text, ...(html ? {html} : {})}),
                });
                if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
                return res.json().catch(() => ({}));
            },
        };
    }
    const mailer = mailerFromEnv(env);
    if (mailer) return {kind: 'smtp', from: mailer.from, send: ({to, subject, text}) => sendMail({...mailer, to, subject, text})};
    return null;
}

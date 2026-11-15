// Serverless contact endpoint — the GitHub-Pages-can't-run-a-server replacement for serve.mjs's
// /api/contact. Runs on any Node serverless host that deploys from the repo (Vercel, Netlify, etc.)
// and emails the website contact form through Zoho SMTP. It reuses the same dependency-free SMTP
// client as the local dev server (../mailer.mjs), so there is one code path to trust.
//
// The static site and this function share an origin on Vercel/Netlify, so the front-end's existing
// POST to /api/contact works unchanged — no CORS. Every SMTP setting comes from environment
// variables set in the host's dashboard; no secret ever lives in the repo. See docs/contact-form.md.
import {sendMail, mailerFromEnv} from '../mailer.mjs';

const CONTACT_TO = process.env.CONTACT_TO || 'hello@sorcery.llc';
const CONTACT_SUBJECT = process.env.CONTACT_SUBJECT || 'Rendered Data Contact Form';
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

async function readJson(req) {
    if (req.body && typeof req.body === 'object') return req.body;         // host already parsed JSON
    let raw = typeof req.body === 'string' ? req.body : '';
    if (!raw) { for await (const chunk of req) raw += chunk; }             // raw stream fallback
    try { return JSON.parse(raw || '{}'); } catch { return null; }
}

export default async function handler(req, res) {
    // Optional CORS, only needed if the static site is hosted apart from this function (set ALLOW_ORIGIN).
    const allow = process.env.ALLOW_ORIGIN;
    if (allow) {
        res.setHeader('Access-Control-Allow-Origin', allow);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ok: false, error: 'POST only'});

    const data = await readJson(req);
    if (!data) return res.status(400).json({ok: false, error: 'Could not read the submission.'});

    const lead = {
        name: str(data.name, 200), email: str(data.email, 200), company: str(data.company, 200),
        team: str(data.team, 40), message: str(data.message, 4000)
    };
    if (!lead.name || !lead.message) return res.status(422).json({ok: false, error: 'Name and message are required.'});
    if (!looksLikeEmail(lead.email)) return res.status(422).json({ok: false, error: 'A valid email is required.'});

    const mailer = mailerFromEnv({...process.env, CONTACT_TO});
    if (!mailer) return res.status(500).json({ok: false, error: 'Email is not configured (set SMTP_HOST and credentials).'});

    const text = [
        'New contact from the Rendered Data website:', '',
        `Name:          ${lead.name}`,
        `Email:         ${lead.email}`,
        `Company:       ${lead.company || '(none)'}`,
        `Organization:  ${lead.team || '(none)'}`,
        `When:          ${new Date().toISOString()}`, '',
        'Message:', lead.message
    ].join('\n');

    try {
        // Reply-To is the sender, so replying from your inbox reaches them directly.
        await sendMail({...mailer, subject: CONTACT_SUBJECT, replyTo: lead.email, text});
        return res.status(200).json({ok: true});
    } catch {
        return res.status(502).json({ok: false, error: 'Could not send the email.'});
    }
}

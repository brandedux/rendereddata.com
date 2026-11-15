// Minimal, dependency-free SMTP client. Enough to send one plain-text notification per
// call over STARTTLS (587/25) or implicit TLS (465), with optional AUTH LOGIN.
//
// Config is read from the environment by mailerFromEnv(); nothing is hardcoded. If the
// required variables are absent, mailerFromEnv() returns null and the caller skips email.
import {createConnection} from 'node:net';
import {connect as tlsConnect} from 'node:tls';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// Read SMTP replies off a socket. Each reply is one or more lines "NNN-text" (continuation)
// ending with one "NNN text". Resolves with {code, text} for the next complete reply.
function makeReader(sock) {
    let buf = '';
    const waiters = [];
    const pump = () => {
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            reader._lines.push(line);
            // A space (not a hyphen) in the 4th char marks the final line of a reply.
            if (line.length >= 4 && line[3] === ' ') {
                const code = Number(line.slice(0, 3));
                const text = reader._lines.join('\n');
                reader._lines = [];
                const w = waiters.shift();
                if (w) w.resolve({code, text});
            }
        }
    };
    const reader = {
        _lines: [],
        next() { return new Promise((resolve, reject) => { waiters.push({resolve, reject}); }); },
        fail(err) { while (waiters.length) waiters.shift().reject(err); }
    };
    sock.on('data', (d) => { buf += d.toString('utf8'); pump(); });
    sock.on('error', (err) => reader.fail(err));
    sock.on('close', () => reader.fail(new Error('SMTP connection closed')));
    return reader;
}

function expect(reply, ...okCodes) {
    if (!okCodes.includes(reply.code)) throw new Error(`SMTP: expected ${okCodes.join('/')}, got ${reply.text}`);
    return reply;
}

/**
 * Send one message. Returns the final server reply text on success, throws on failure.
 * @param {object} o
 * @param {string} o.host  @param {number} o.port  @param {boolean} [o.secure] implicit TLS (465)
 * @param {string} [o.user] @param {string} [o.pass]  AUTH LOGIN credentials (optional)
 * @param {string} o.from  @param {string|string[]} o.to  @param {string} [o.replyTo]
 * @param {string} o.subject  @param {string} o.text
 * @param {number} [o.timeoutMs=15000]
 */
export function sendMail(o) {
    const port = o.port || (o.secure ? 465 : 587);
    const helo = o.heloName || 'localhost';
    const recipients = Array.isArray(o.to) ? o.to : [o.to];

    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); try { sock?.end(); } catch {} err ? reject(err) : resolve(val); };
        const timer = setTimeout(() => done(new Error('SMTP timeout')), o.timeoutMs || 15000);

        let sock = o.secure
            ? tlsConnect({host: o.host, port, servername: o.host})
            : createConnection({host: o.host, port});
        sock.setEncoding('utf8');

        (async () => {
            let reader = makeReader(sock);
            const say = async (line, ...ok) => { sock.write(line + '\r\n'); return expect(await reader.next(), ...ok); };

            await new Promise((res, rej) => { sock.once(o.secure ? 'secureConnect' : 'connect', res); sock.once('error', rej); });
            expect(await reader.next(), 220);                    // greeting

            let ehlo = await say(`EHLO ${helo}`, 250);
            // Upgrade to TLS if the server offers STARTTLS and we are not already encrypted.
            if (!o.secure && /STARTTLS/i.test(ehlo.text)) {
                await say('STARTTLS', 220);
                sock = tlsConnect({socket: sock, host: o.host, servername: o.host});
                sock.setEncoding('utf8');
                await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
                reader = makeReader(sock);
                ehlo = await say(`EHLO ${helo}`, 250);
            }

            if (o.user) {
                await say('AUTH LOGIN', 334);
                await say(b64(o.user), 334);
                await say(b64(o.pass || ''), 235);
            }

            await say(`MAIL FROM:<${o.from}>`, 250);
            for (const rcpt of recipients) await say(`RCPT TO:<${rcpt}>`, 250, 251);
            await say('DATA', 354);

            const headers = [
                `From: ${o.from}`,
                `To: ${recipients.join(', ')}`,
                ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
                `Subject: ${o.subject}`,
                `Date: ${new Date().toUTCString()}`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=utf-8'
            ];
            // Dot-stuff any line that begins with a dot, then terminate with <CRLF>.<CRLF>.
            const body = String(o.text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
            const final = await say(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, 250);
            await say('QUIT', 221).catch(() => {});             // some servers drop before replying
            done(null, final.text);
        })().catch((err) => done(err));
    });
}

/** Build a mailer config from environment variables, or null if email is not configured. */
export function mailerFromEnv(env = process.env) {
    const host = env.SMTP_HOST, to = env.CONTACT_TO;
    if (!host || !to) return null;
    return {
        host,
        port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
        secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER || undefined,
        pass: env.SMTP_PASS || undefined,
        from: env.CONTACT_FROM || env.SMTP_USER || `no-reply@${host}`,
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        heloName: env.SMTP_HELO || undefined
    };
}

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const User = require('./Models/User.js');
const Message = require('./Models/message.js');
const RoomNote = require('./Models/RoomNote.js');

const app = express();
const server = http.createServer(app);

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'studyportal_session';
const OTP_PENDING_COOKIE = 'studyportal_otp_pending';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const OTP_PENDING_TTL_MS = 1000 * 60 * 5;
const MAIL_SEND_TIMEOUT_MS = Number(process.env.OTP_MAIL_TIMEOUT_MS) || 15000;
const ALLOW_OTP_PREVIEW_FALLBACK = String(process.env.ALLOW_OTP_PREVIEW_FALLBACK || 'true').toLowerCase() === 'true';
const MAX_JSON_SIZE = '16kb';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const dbURI = process.env.MONGODB_URI;
const geminiApiKey = process.env.GEMINI_API_KEY;
const sessionSecret = process.env.SESSION_SECRET || 'development-session-secret-change-me';
const mailFrom = (process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'no-reply@studyportal.local').trim();

if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET is not set. Using an insecure development fallback.');
}

if (!dbURI) {
    console.warn('MONGODB_URI is not set. Database-backed features will fail until it is configured.');
}

if (!geminiApiKey) {
    console.warn('GEMINI_API_KEY is not set. AI assistant requests will be unavailable.');
}

const activeRooms = {};
const rateLimitStore = new Map();
const passkeyChallengeStore = new Map();
const geminiClient = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
const aiModelCandidates = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
].filter(Boolean);

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        if (!key || process.env[key]) {
            continue;
        }

        let value = trimmed.slice(separatorIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}

function firstDefinedEnv(keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (value) {
            return value;
        }
    }

    return '';
}

function normalizeEnvValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmailPassword(password, serviceName) {
    const normalized = normalizeEnvValue(password);

    if (String(serviceName || '').toLowerCase() === 'gmail') {
        return normalized.replace(/\s+/g, '');
    }

    return normalized;
}

function createSmtpConfig({ host, port, secure, user, pass }) {
    return {
        host,
        port,
        secure,
        connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 10000,
        greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000,
        socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || MAIL_SEND_TIMEOUT_MS,
        tls: {
            servername: host,
        },
        auth: {
            user,
            pass,
        },
    };
}

function createMailTransports() {
    const emailService = normalizeEnvValue(firstDefinedEnv(['EMAIL_SERVICE', 'SMTP_SERVICE', 'MAIL_SERVICE']) || 'gmail');
    const smtpUser = normalizeEnvValue(firstDefinedEnv(['SMTP_USER', 'EMAIL_USER', 'GMAIL_USER']));
    const smtpPass = normalizeEmailPassword(firstDefinedEnv(['SMTP_PASS', 'EMAIL_APP_PASSWORD', 'GMAIL_APP_PASSWORD', 'EMAIL_PASS']), emailService);
    const smtpHost = normalizeEnvValue(firstDefinedEnv(['SMTP_HOST']));
    const smtpSecure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
    const smtpPort = Number(process.env.SMTP_PORT) || (smtpSecure ? 465 : 587);
    const isGmail = emailService.toLowerCase() === 'gmail' || smtpUser.toLowerCase().endsWith('@gmail.com');
    const transports = [];

    if (smtpHost && smtpUser && smtpPass) {
        transports.push({
            label: `custom-${smtpHost}:${smtpPort}`,
            transport: nodemailer.createTransport(createSmtpConfig({
                host: smtpHost,
                port: smtpPort,
                secure: smtpSecure,
                user: smtpUser,
                pass: smtpPass,
            })),
        });
    }

    if (isGmail && smtpUser && smtpPass) {
        transports.push({
            label: 'gmail-465',
            transport: nodemailer.createTransport(createSmtpConfig({
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                user: smtpUser,
                pass: smtpPass,
            })),
        });

        transports.push({
            label: 'gmail-587',
            transport: nodemailer.createTransport({
                ...createSmtpConfig({
                    host: 'smtp.gmail.com',
                    port: 587,
                    secure: false,
                    user: smtpUser,
                    pass: smtpPass,
                }),
                requireTLS: true,
            }),
        });
    }

    if (smtpUser && smtpPass) {
        transports.push({
            label: `service-${emailService}`,
            transport: nodemailer.createTransport({
                service: emailService,
                connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 10000,
                greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000,
                socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || MAIL_SEND_TIMEOUT_MS,
                auth: {
                    user: smtpUser,
                    pass: smtpPass,
                },
            }),
        });
    }

    return transports;
}

const mailTransports = createMailTransports();

async function verifyMailTransport() {
    if (!mailTransports.length) {
        console.warn('OTP email transport is not configured. Add SMTP or Gmail credentials to .env.');
        return;
    }

    for (const candidate of mailTransports) {
        try {
            await candidate.transport.verify();
            console.log(`OTP email transport is ready via ${candidate.label}.`);
            return;
        } catch (error) {
            console.error(`OTP email transport verification failed via ${candidate.label}:`, error && error.stack ? error.stack : (error.message || error));
        }
    }

    console.error('For Gmail, use EMAIL_USER plus a 16-character App Password in EMAIL_APP_PASSWORD.');
}

function isAllowedOrigin(origin) {
    if (!origin) {
        return true;
    }

    if (!allowedOrigins.length) {
        return true;
    }

    return allowedOrigins.includes(origin);
}

function setSecurityHeaders(req, res, next) {
    const scriptSources = [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.tailwindcss.com',
        'https://unpkg.com',
        'https://cdn.jsdelivr.net',
        'https://cdnjs.cloudflare.com',
    ];

    const styleSources = [
        "'self'",
        "'unsafe-inline'",
        'https://cdnjs.cloudflare.com',
    ];

    const connectSources = [
        "'self'",
        'https://generativelanguage.googleapis.com',
        'https://0.peerjs.com',
        'https://unpkg.com',
        'https://cdn.jsdelivr.net',
        'https://justadudewhohacks.github.io',
        'stun:',
        'turn:',
        'wss:',
    ];

    const imgSources = [
        "'self'",
        'data:',
        'https:',
    ];

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            `script-src ${scriptSources.join(' ')}`,
            `style-src ${styleSources.join(' ')}`,
            "font-src 'self' https://cdnjs.cloudflare.com data:",
            `img-src ${imgSources.join(' ')}`,
            "media-src 'self' blob:",
            "frame-ancestors 'none'",
            "object-src 'none'",
            `connect-src ${connectSources.join(' ')}`,
            "base-uri 'self'",
            "form-action 'self'",
        ].join('; ')
    );

    next();
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) {
        return {};
    }

    return header.split(';').reduce((cookies, part) => {
        const [rawName, ...rest] = part.trim().split('=');
        if (!rawName) {
            return cookies;
        }

        cookies[rawName] = decodeURIComponent(rest.join('='));
        return cookies;
    }, {});
}

function signValue(value) {
    return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}

function createSessionToken(payload) {
    const content = {
        ...payload,
        exp: payload.exp || (Date.now() + SESSION_TTL_MS),
    };

    const encoded = Buffer.from(JSON.stringify(content)).toString('base64url');
    const signature = signValue(encoded);
    return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
    if (!token || !token.includes('.')) {
        return null;
    }

    const [encoded, signature] = token.split('.');
    const expectedSignature = signValue(encoded);

    if (
        !signature ||
        signature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    ) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!payload.exp || payload.exp < Date.now()) {
            return null;
        }

        return payload;
    } catch (error) {
        return null;
    }
}

function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];

    if (options.httpOnly) {
        parts.push('HttpOnly');
    }

    if (options.sameSite) {
        parts.push(`SameSite=${options.sameSite}`);
    }

    if (options.maxAge !== undefined) {
        parts.push(`Max-Age=${options.maxAge}`);
    }

    if (options.path) {
        parts.push(`Path=${options.path}`);
    }

    if (options.secure) {
        parts.push('Secure');
    }

    return parts.join('; ');
}

function setSessionCookie(res, payload) {
    const token = createSessionToken(payload);
    res.setHeader(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE, token, {
            httpOnly: true,
            sameSite: 'Strict',
            secure: IS_PRODUCTION,
            path: '/',
            maxAge: Math.floor(SESSION_TTL_MS / 1000),
        })
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE, '', {
            httpOnly: true,
            sameSite: 'Strict',
            secure: IS_PRODUCTION,
            path: '/',
            maxAge: 0,
        })
    );
}

function setOtpPendingCookie(res, payload) {
    const token = createSessionToken(payload);
    res.setHeader(
        'Set-Cookie',
        serializeCookie(OTP_PENDING_COOKIE, token, {
            httpOnly: true,
            sameSite: 'Strict',
            secure: IS_PRODUCTION,
            path: '/',
            maxAge: Math.floor(OTP_PENDING_TTL_MS / 1000),
        })
    );
}

function clearOtpPendingCookie(res) {
    res.setHeader(
        'Set-Cookie',
        serializeCookie(OTP_PENDING_COOKIE, '', {
            httpOnly: true,
            sameSite: 'Strict',
            secure: IS_PRODUCTION,
            path: '/',
            maxAge: 0,
        })
    );
}

function attachUserFromSession(req, res, next) {
    const cookies = parseCookies(req);
    const session = verifySessionToken(cookies[SESSION_COOKIE]);
    req.user = session || null;
    next();
}

function getPendingOtpSession(req) {
    const cookies = parseCookies(req);
    const pendingSession = verifySessionToken(cookies[OTP_PENDING_COOKIE]);

    if (!pendingSession || pendingSession.stage !== 'otp-login') {
        return null;
    }

    return pendingSession;
}

function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    next();
}

function requirePageAuth(req, res, next) {
    if (!req.user) {
        return res.redirect('/login.html');
    }

    next();
}

function rateLimiter({ windowMs, maxRequests, keyPrefix }) {
    return (req, res, next) => {
        const key = `${keyPrefix}:${req.ip}`;
        const now = Date.now();
        const entry = rateLimitStore.get(key);

        if (!entry || entry.resetAt <= now) {
            rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }

        if (entry.count >= maxRequests) {
            return res.status(429).json({
                success: false,
                message: 'Too many requests. Please wait and try again.',
            });
        }

        entry.count += 1;
        next();
    };
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeRoomName(room) {
    if (typeof room !== 'string') {
        return null;
    }

    const trimmed = room.trim();
    if (!/^[A-Za-z0-9 _-]{2,50}$/.test(trimmed)) {
        return null;
    }

    return trimmed;
}

function ensureText(value, { min = 1, max = 500 } = {}) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max) {
        return null;
    }

    return trimmed;
}

function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function toBase64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
    return Buffer.from(value, 'base64url');
}

function createPasskeyChallenge() {
    return toBase64Url(crypto.randomBytes(32));
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest();
}

function getExpectedOriginSet(req) {
    const protocol = req.protocol || (IS_PRODUCTION ? 'https' : 'http');
    const hosts = [req.get('host')].filter(Boolean);
    const origins = hosts.map((host) => `${protocol}://${host}`);

    allowedOrigins.forEach((origin) => origins.push(origin));
    return new Set(origins);
}

function isValidPasskeyOrigin(req, origin) {
    if (!origin) {
        return false;
    }

    return getExpectedOriginSet(req).has(origin);
}

function getRpId(req) {
    return process.env.WEBAUTHN_RP_ID || req.hostname;
}

function storePasskeyChallenge(key, payload) {
    passkeyChallengeStore.set(key, {
        ...payload,
        expiresAt: Date.now() + 5 * 60 * 1000,
    });
}

function consumePasskeyChallenge(key, expectedType) {
    const record = passkeyChallengeStore.get(key);
    passkeyChallengeStore.delete(key);

    if (!record || record.expiresAt < Date.now()) {
        return null;
    }

    if (expectedType && record.type !== expectedType) {
        return null;
    }

    return record;
}

function parseClientDataJSON(encoded) {
    return JSON.parse(fromBase64Url(encoded).toString('utf8'));
}

function parseAuthenticatorData(encoded) {
    const buffer = fromBase64Url(encoded);
    if (buffer.length < 37) {
        throw new Error('Authenticator data is incomplete.');
    }

    return {
        buffer,
        rpIdHash: buffer.subarray(0, 32),
        flags: buffer[32],
        signCount: buffer.readUInt32BE(33),
    };
}

function withTimeout(promise, timeoutMs, errorFactory) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(errorFactory());
        }, timeoutMs);

        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

async function issueLoginOtp(user) {
    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + OTP_PENDING_TTL_MS);

    await User.updateOne(
        { _id: user._id },
        {
            $set: {
                otp,
                otpExpiry,
            },
        }
    );

    user.otp = otp;
    user.otpExpiry = otpExpiry;

    return otp;
}

async function deliverLoginOtpEmail(user, otp) {
    if (!otp) {
        throw new Error('OTP_MISSING');
    }

    if (!mailTransports.length) {
        console.warn(`OTP delivery is not configured. OTP for ${user.email}: ${otp}`);
        return otp;
    }

    let lastError = null;

    for (const candidate of mailTransports) {
        try {
            await withTimeout(
                candidate.transport.sendMail({
                    from: mailFrom,
                    to: user.email,
                    subject: 'StudyPortal login OTP',
                    text: `Your StudyPortal verification code is ${otp}. It expires in 5 minutes.`,
                    html: `<p>Your StudyPortal verification code is <strong>${otp}</strong>.</p><p>It expires in 5 minutes.</p>`,
                }),
                MAIL_SEND_TIMEOUT_MS,
                () => new Error('OTP_DELIVERY_TIMEOUT')
            );
            return otp;
        } catch (error) {
            lastError = error;
            console.error(`OTP email delivery error via ${candidate.label}:`, error && error.stack ? error.stack : (error.message || error));
        }
    }

    const deliveryError = new Error('OTP_DELIVERY_FAILED');
    deliveryError.details = lastError ? (lastError.response || lastError.message || String(lastError)) : 'Unknown SMTP failure';
    throw deliveryError;
}

async function sendLoginOtp(user) {
    const otp = await issueLoginOtp(user);
    await deliverLoginOtpEmail(user, otp);
    return otp;
}

app.set('trust proxy', 1);
app.use(setSecurityHeaders);
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    if (origin && !isAllowedOrigin(origin)) {
        return res.status(403).json({ success: false, message: 'Origin not allowed.' });
    }

    next();
});
app.use(express.json({ limit: MAX_JSON_SIZE }));
app.use(attachUserFromSession);

if (dbURI) {
    mongoose.connect(dbURI)
        .then(() => {
            console.log('StudyPortal database connected.');
        })
        .catch((err) => {
            console.error('Database connection error:', err);
        });
}

app.get('/', (req, res) => {
    if (req.user) {
        return res.redirect('/dashboard.html');
    }

    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login.html', (req, res) => {
    if (req.user) {
        return res.redirect('/dashboard.html');
    }

    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/registers.html', (req, res) => {
    if (req.user) {
        return res.redirect('/dashboard.html');
    }

    res.sendFile(path.join(__dirname, 'public', 'registers.html'));
});

app.get('/dashboard.html', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/otp-check.html', (req, res) => {
    if (req.user) {
        return res.redirect('/dashboard.html');
    }

    if (!getPendingOtpSession(req)) {
        return res.redirect('/login.html');
    }

    res.sendFile(path.join(__dirname, 'public', 'otp-check.html'));
});

app.get('/face-check.html', (req, res) => {
    res.redirect('/login.html');
});

app.get('/studyroom.html', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studyroom.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/me', requireAuth, (req, res) => {
    res.status(200).json({
        success: true,
        user: {
            id: req.user.id,
            username: req.user.username,
            email: req.user.email,
        },
    });
});

app.get('/room-notes/:room', requireAuth, async (req, res) => {
    try {
        const room = sanitizeRoomName(req.params.room);
        if (!room) {
            return res.status(400).json({ success: false, message: 'Invalid room.' });
        }

        const note = await RoomNote.findOne({
            room,
            userId: req.user.id,
        }).lean();

        res.status(200).json({
            success: true,
            content: note ? note.content : '',
            updatedAt: note && note.updatedAt ? note.updatedAt.toISOString() : null,
        });
    } catch (error) {
        console.error('Room notes fetch error:', error);
        res.status(500).json({ success: false, message: 'Could not load notes.' });
    }
});

app.put('/room-notes/:room', requireAuth, rateLimiter({ windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'room-notes-save' }), async (req, res) => {
    try {
        const room = sanitizeRoomName(req.params.room);
        const content = typeof req.body.content === 'string' ? req.body.content.trim().slice(0, 12000) : '';

        if (!room) {
            return res.status(400).json({ success: false, message: 'Invalid room.' });
        }

        const note = await RoomNote.findOneAndUpdate(
            { room, userId: req.user.id },
            {
                room,
                userId: req.user.id,
                content,
                updatedAt: new Date(),
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
            }
        ).lean();

        res.status(200).json({
            success: true,
            updatedAt: note.updatedAt.toISOString(),
        });
    } catch (error) {
        console.error('Room notes save error:', error);
        res.status(500).json({ success: false, message: 'Could not save notes.' });
    }
});

app.get('/security-status', requireAuth, async (req, res) => {
    const user = await User.findById(req.user.id).select('passkeyCredentialId passkeyCreatedAt');
    res.status(200).json({
        success: true,
        otpEnabled: false,
        passkeyAvailable: Boolean(user && user.passkeyCredentialId),
        passkeyCreatedAt: user && user.passkeyCreatedAt ? user.passkeyCreatedAt.toISOString() : null,
    });
});

app.post('/passkey/register/options', requireAuth, rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 10, keyPrefix: 'passkey-register-options' }), async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('username email passkeyCredentialId passkeyTransports');
        if (!user) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        const challenge = createPasskeyChallenge();
        const rpId = getRpId(req);
        const userId = toBase64Url(Buffer.from(String(user._id)));

        storePasskeyChallenge(`register:${req.user.id}`, {
            type: 'register',
            challenge,
            rpId,
        });

        res.status(200).json({
            success: true,
            publicKey: {
                challenge,
                rp: {
                    name: 'StudyPortal',
                    id: rpId,
                },
                user: {
                    id: userId,
                    name: user.email,
                    displayName: user.username,
                },
                timeout: 60000,
                attestation: 'none',
                authenticatorSelection: {
                    residentKey: 'preferred',
                    userVerification: 'preferred',
                },
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 },
                    { type: 'public-key', alg: -257 },
                ],
                excludeCredentials: user.passkeyCredentialId ? [{
                    id: user.passkeyCredentialId,
                    type: 'public-key',
                    transports: user.passkeyTransports || ['internal', 'hybrid'],
                }] : [],
            },
        });
    } catch (error) {
        console.error('Passkey register options error:', error);
        res.status(500).json({ success: false, message: 'Could not prepare passkey registration.' });
    }
});

app.post('/passkey/register/verify', requireAuth, rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 10, keyPrefix: 'passkey-register-verify' }), async (req, res) => {
    try {
        const challengeRecord = consumePasskeyChallenge(`register:${req.user.id}`, 'register');
        if (!challengeRecord) {
            return res.status(400).json({ success: false, message: 'Passkey registration expired. Try again.' });
        }

        const credential = req.body && req.body.credential;
        const rawId = ensureText(credential && credential.rawId, { min: 16, max: 4096 });
        const id = ensureText(credential && credential.id, { min: 16, max: 4096 });
        const type = ensureText(credential && credential.type, { min: 4, max: 32 });
        const response = credential && credential.response;
        const clientDataJSON = ensureText(response && response.clientDataJSON, { min: 16, max: 12000 });
        const publicKey = ensureText(response && response.publicKey, { min: 16, max: 16000 });
        const publicKeyAlgorithm = response && Number.isInteger(response.publicKeyAlgorithm) ? response.publicKeyAlgorithm : null;
        const transports = Array.isArray(response && response.transports)
            ? response.transports.filter((item) => typeof item === 'string').slice(0, 8)
            : [];

        if (!rawId || !id || type !== 'public-key' || !clientDataJSON || !publicKey || !publicKeyAlgorithm) {
            return res.status(400).json({ success: false, message: 'Passkey registration payload is incomplete.' });
        }

        const clientData = parseClientDataJSON(clientDataJSON);
        if (clientData.type !== 'webauthn.create') {
            return res.status(400).json({ success: false, message: 'Unexpected passkey registration type.' });
        }

        if (clientData.challenge !== challengeRecord.challenge) {
            return res.status(400).json({ success: false, message: 'Passkey challenge did not match.' });
        }

        if (!isValidPasskeyOrigin(req, clientData.origin)) {
            return res.status(400).json({ success: false, message: 'Passkey origin was not trusted.' });
        }

        const user = await User.findById(req.user.id).select('passkeyCredentialId');
        if (!user) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        user.passkeyCredentialId = rawId;
        user.passkeyPublicKey = publicKey;
        user.passkeyCounter = 0;
        user.passkeyTransports = transports;
        user.passkeyLabel = ensureText(req.body && req.body.label, { min: 2, max: 80 }) || 'Primary device';
        user.passkeyCreatedAt = new Date();
        await user.save();

        res.status(200).json({ success: true, message: 'Passkey saved for this account.' });
    } catch (error) {
        console.error('Passkey register verify error:', error);
        res.status(500).json({ success: false, message: 'Could not finish passkey registration.' });
    }
});

app.post('/passkey/auth/options', rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 20, keyPrefix: 'passkey-auth-options' }), async (req, res) => {
    try {
        const email = ensureText(req.body.email, { min: 5, max: 120 });
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ success: false, message: 'Enter the email used for your passkey.' });
        }

        const normalizedEmail = email.toLowerCase();
        const user = await User.findOne({ email: normalizedEmail }).select('username email passkeyCredentialId passkeyTransports');
        if (!user || !user.passkeyCredentialId) {
            return res.status(404).json({ success: false, message: 'No passkey is saved for this account yet.' });
        }

        const challenge = createPasskeyChallenge();
        const rpId = getRpId(req);
        storePasskeyChallenge(`auth:${user._id}`, {
            type: 'auth',
            challenge,
            rpId,
        });

        res.status(200).json({
            success: true,
            publicKey: {
                challenge,
                rpId,
                timeout: 60000,
                userVerification: 'preferred',
                allowCredentials: [{
                    id: user.passkeyCredentialId,
                    type: 'public-key',
                    transports: user.passkeyTransports || ['internal', 'hybrid'],
                }],
            },
            username: user.username,
        });
    } catch (error) {
        console.error('Passkey auth options error:', error);
        res.status(500).json({ success: false, message: 'Could not start passkey sign-in.' });
    }
});

app.post('/passkey/auth/verify', rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 20, keyPrefix: 'passkey-auth-verify' }), async (req, res) => {
    try {
        const email = ensureText(req.body.email, { min: 5, max: 120 });
        if (!email || !validateEmail(email)) {
            return res.status(400).json({ success: false, message: 'Email is required for passkey sign-in.' });
        }

        const normalizedEmail = email.toLowerCase();
        const user = await User.findOne({ email: normalizedEmail }).select(
            'username email passkeyCredentialId passkeyPublicKey passkeyCounter'
        );
        if (!user || !user.passkeyCredentialId || !user.passkeyPublicKey) {
            return res.status(404).json({ success: false, message: 'No passkey is available for this account.' });
        }

        const challengeRecord = consumePasskeyChallenge(`auth:${user._id}`, 'auth');
        if (!challengeRecord) {
            return res.status(400).json({ success: false, message: 'Passkey sign-in expired. Try again.' });
        }

        const credential = req.body && req.body.credential;
        const rawId = ensureText(credential && credential.rawId, { min: 16, max: 4096 });
        const type = ensureText(credential && credential.type, { min: 4, max: 32 });
        const response = credential && credential.response;
        const clientDataJSON = ensureText(response && response.clientDataJSON, { min: 16, max: 12000 });
        const authenticatorData = ensureText(response && response.authenticatorData, { min: 16, max: 12000 });
        const signature = ensureText(response && response.signature, { min: 16, max: 12000 });

        if (!rawId || rawId !== user.passkeyCredentialId || type !== 'public-key' || !clientDataJSON || !authenticatorData || !signature) {
            return res.status(400).json({ success: false, message: 'Passkey assertion payload is invalid.' });
        }

        const clientData = parseClientDataJSON(clientDataJSON);
        if (clientData.type !== 'webauthn.get') {
            return res.status(400).json({ success: false, message: 'Unexpected passkey sign-in type.' });
        }

        if (clientData.challenge !== challengeRecord.challenge) {
            return res.status(400).json({ success: false, message: 'Passkey challenge did not match.' });
        }

        if (!isValidPasskeyOrigin(req, clientData.origin)) {
            return res.status(400).json({ success: false, message: 'Passkey origin was not trusted.' });
        }

        const authData = parseAuthenticatorData(authenticatorData);
        if (!authData.rpIdHash.equals(sha256(challengeRecord.rpId))) {
            return res.status(400).json({ success: false, message: 'Passkey RP ID did not match this site.' });
        }

        if ((authData.flags & 0x01) === 0) {
            return res.status(400).json({ success: false, message: 'Passkey user presence check failed.' });
        }

        const signedPayload = Buffer.concat([
            authData.buffer,
            sha256(fromBase64Url(clientDataJSON)),
        ]);

        const verified = crypto.verify(
            'sha256',
            signedPayload,
            {
                key: fromBase64Url(user.passkeyPublicKey),
                format: 'der',
                type: 'spki',
            },
            fromBase64Url(signature)
        );

        if (!verified) {
            return res.status(401).json({ success: false, message: 'Passkey signature could not be verified.' });
        }

        if (authData.signCount > (user.passkeyCounter || 0)) {
            user.passkeyCounter = authData.signCount;
            await user.save();
        }

        setSessionCookie(res, {
            id: String(user._id),
            username: user.username,
            email: user.email,
        });

        res.status(200).json({ success: true, message: 'Signed in with passkey.' });
    } catch (error) {
        console.error('Passkey auth verify error:', error);
        res.status(500).json({ success: false, message: 'Passkey sign-in failed.' });
    }
});

app.delete('/passkey', requireAuth, rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 8, keyPrefix: 'passkey-delete' }), async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select(
            'passkeyCredentialId passkeyPublicKey passkeyCounter passkeyTransports passkeyLabel passkeyCreatedAt'
        );
        if (!user) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        user.passkeyCredentialId = undefined;
        user.passkeyPublicKey = undefined;
        user.passkeyCounter = 0;
        user.passkeyTransports = undefined;
        user.passkeyLabel = undefined;
        user.passkeyCreatedAt = undefined;
        await user.save();

        res.status(200).json({ success: true, message: 'Passkey removed.' });
    } catch (error) {
        console.error('Passkey delete error:', error);
        res.status(500).json({ success: false, message: 'Could not remove passkey.' });
    }
});

app.post('/register', rateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10, keyPrefix: 'register' }), async (req, res) => {
    try {
        const username = ensureText(req.body.username, { min: 2, max: 60 });
        const email = ensureText(req.body.email, { min: 5, max: 120 });
        const password = ensureText(req.body.password, { min: 1, max: 128 });

        if (!username || !email || !password || !validateEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid username, email, and password.',
            });
        }

        const normalizedEmail = email.toLowerCase();
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Email is already registered.' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const newUser = new User({
            username,
            email: normalizedEmail,
            password: hashedPassword,
        });

        await newUser.save();
        res.status(201).json({ success: true, message: 'Registration successful.' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

app.post('/login', rateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 20, keyPrefix: 'login' }), async (req, res) => {
    try {
        const email = ensureText(req.body.email, { min: 5, max: 120 });
        const password = ensureText(req.body.password, { min: 1, max: 128 });

        if (!email || !password || !validateEmail(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email or password.' });
        }

        const normalizedEmail = email.toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ success: false, message: 'Invalid email or password.' });
        }

        if (IS_PRODUCTION && !mailTransports.length) {
            return res.status(503).json({
                success: false,
                message: 'OTP email delivery is not configured on the server yet.',
            });
        }

        let otpPreview = null;

        try {
            const sentOtp = await sendLoginOtp(user);
            if (!IS_PRODUCTION && !mailTransports.length) {
                otpPreview = sentOtp;
            }
        } catch (error) {
            console.error('Login OTP send error:', error);

            if (!IS_PRODUCTION && ALLOW_OTP_PREVIEW_FALLBACK && user.otp && user.otpExpiry && user.otpExpiry.getTime() > Date.now()) {
                otpPreview = user.otp;
            } else {
                return res.status(500).json({
                    success: false,
                    message: `Could not send OTP. ${error.details || 'Verify SMTP or Gmail App Password settings.'}`,
                });
            }
        }

        res.setHeader('Set-Cookie', [
            serializeCookie(SESSION_COOKIE, '', {
                httpOnly: true,
                sameSite: 'Strict',
                secure: IS_PRODUCTION,
                path: '/',
                maxAge: 0,
            }),
            serializeCookie(OTP_PENDING_COOKIE, createSessionToken({
                id: String(user._id),
                username: user.username,
                email: user.email,
                stage: 'otp-login',
                exp: Date.now() + OTP_PENDING_TTL_MS,
            }), {
                httpOnly: true,
                sameSite: 'Strict',
                secure: IS_PRODUCTION,
                path: '/',
                maxAge: Math.floor(OTP_PENDING_TTL_MS / 1000),
            }),
        ]);

        const response = {
            success: true,
            otpRequired: true,
            nextStep: '/otp-check.html',
            username: user.username,
            email: user.email,
            message: otpPreview ? 'OTP preview mode is active for this login.' : 'A 6-digit OTP has been sent to your email.',
        };

        if (otpPreview) {
            response.otpPreview = otpPreview;
        }

        res.status(200).json(response);
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Authentication failure.' });
    }
});

app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', [
        serializeCookie(SESSION_COOKIE, '', {
            httpOnly: true,
            sameSite: 'Strict',
            secure: IS_PRODUCTION,
            path: '/',
            maxAge: 0,
        }),
        serializeCookie(OTP_PENDING_COOKIE, '', {
            httpOnly: true,
            sameSite: 'Strict',
            secure: IS_PRODUCTION,
            path: '/',
            maxAge: 0,
        }),
    ]);
    res.status(200).json({ success: true });
});

app.post('/verify-otp', rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 12, keyPrefix: 'verify-otp' }), async (req, res) => {
    try {
        const cookies = parseCookies(req);
        const pendingSession = verifySessionToken(cookies[OTP_PENDING_COOKIE]);
        if (!pendingSession || pendingSession.stage !== 'otp-login') {
            return res.status(401).json({ success: false, message: 'OTP session expired. Please log in again.' });
        }

        const otp = ensureText(req.body.otp, { min: 6, max: 6 });
        if (!otp || !/^\d{6}$/.test(otp)) {
            return res.status(400).json({ success: false, message: 'Please enter a valid 6-digit OTP.' });
        }

        const user = await User.findById(pendingSession.id).select('username email otp otpExpiry');
        if (!user || !user.otp || !user.otpExpiry) {
            return res.status(400).json({ success: false, message: 'No OTP is pending for this account.' });
        }

        if (user.otpExpiry.getTime() < Date.now()) {
            return res.status(401).json({ success: false, message: 'OTP expired. Request a new code and try again.' });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ success: false, message: 'Incorrect OTP. Please try again.' });
        }

        await User.updateOne(
            { _id: user._id },
            {
                $unset: {
                    otp: 1,
                    otpExpiry: 1,
                },
            }
        );

        res.setHeader('Set-Cookie', [
            serializeCookie(OTP_PENDING_COOKIE, '', {
                httpOnly: true,
                sameSite: 'Strict',
                secure: IS_PRODUCTION,
                path: '/',
                maxAge: 0,
            }),
            serializeCookie(SESSION_COOKIE, createSessionToken({
                id: String(user._id),
                username: user.username,
                email: user.email,
            }), {
                httpOnly: true,
                sameSite: 'Strict',
                secure: IS_PRODUCTION,
                path: '/',
                maxAge: Math.floor(SESSION_TTL_MS / 1000),
            }),
        ]);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('OTP verification error:', error);
        res.status(500).json({ success: false, message: 'OTP verification failed.' });
    }
});

app.post('/resend-otp', rateLimiter({ windowMs: 5 * 60 * 1000, maxRequests: 5, keyPrefix: 'resend-otp' }), async (req, res) => {
    try {
        const cookies = parseCookies(req);
        const pendingSession = verifySessionToken(cookies[OTP_PENDING_COOKIE]);
        if (!pendingSession || pendingSession.stage !== 'otp-login') {
            return res.status(401).json({ success: false, message: 'OTP session expired. Please log in again.' });
        }

        const user = await User.findById(pendingSession.id).select('username email otp otpExpiry');
        if (!user) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        if (IS_PRODUCTION && !mailTransports.length) {
            return res.status(503).json({
                success: false,
                message: 'OTP email delivery is not configured on the server yet.',
            });
        }

        const otp = await sendLoginOtp(user);
        const response = { success: true, message: 'A new OTP has been sent to your email.' };

        if (!IS_PRODUCTION && !mailTransports.length) {
            response.otpPreview = otp;
        }

        res.status(200).json(response);
    } catch (error) {
        console.error('Resend OTP error:', error);
        if (error && error.message === 'OTP_DELIVERY_FAILED' && ALLOW_OTP_PREVIEW_FALLBACK) {
            const cookies = parseCookies(req);
            const pendingSession = verifySessionToken(cookies[OTP_PENDING_COOKIE]);
            if (pendingSession && pendingSession.stage === 'otp-login') {
                const fallbackUser = await User.findById(pendingSession.id).select('otp otpExpiry');
                if (fallbackUser && fallbackUser.otp && fallbackUser.otpExpiry && fallbackUser.otpExpiry.getTime() > Date.now()) {
                    return res.status(200).json({
                        success: true,
                        message: 'OTP email failed, so preview mode is enabled for this resend.',
                        otpPreview: fallbackUser.otp,
                        otpFallback: true,
                    });
                }
            }
        }
        res.status(500).json({ success: false, message: `Could not resend OTP. ${error.details || 'Verify SMTP or Gmail App Password settings.'}` });
    }
});

app.post('/ask-ai', requireAuth, rateLimiter({ windowMs: 60 * 1000, maxRequests: 12, keyPrefix: 'ask-ai' }), async (req, res) => {
    try {
        const prompt = ensureText(req.body.prompt, { min: 2, max: 1000 });
        if (!prompt) {
            return res.status(400).json({ answer: 'Please enter a valid prompt.' });
        }

        if (!geminiClient) {
            return res.status(503).json({
                answer: 'AI assistant is not configured yet. Add a valid `GEMINI_API_KEY` in Render environment variables.',
            });
        }

        let lastError = null;

        for (const modelName of aiModelCandidates) {
            try {
                const model = geminiClient.getGenerativeModel({ model: modelName });
                const result = await model.generateContent(
                    `You are a helpful study assistant. Give a clear, concise, student-friendly answer.\n\nQuestion: ${prompt}`
                );
                const aiResponse = await result.response;
                const answer = aiResponse.text();

                if (answer) {
                    return res.status(200).json({ answer });
                }
            } catch (error) {
                lastError = error;
            }
        }

        console.error('AI model fallback error:', lastError);
        res.status(503).json({
            answer: 'AI assistant could not respond right now. Check the `GEMINI_API_KEY` and optional `GEMINI_MODEL` in Render.',
        });
    } catch (error) {
        console.error('AI error:', error);
        res.status(500).json({ answer: 'The AI service is currently unavailable.' });
    }
});

app.delete('/clear-chat/:room', requireAuth, rateLimiter({ windowMs: 60 * 1000, maxRequests: 6, keyPrefix: 'clear-chat' }), async (req, res) => {
    try {
        const room = sanitizeRoomName(req.params.room);
        if (!room) {
            return res.status(400).json({ success: false, message: 'Invalid room.' });
        }

        await Message.deleteMany({ room });
        io.to(room).emit('chat-cleared');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Clear chat error:', error);
        res.status(500).json({ success: false });
    }
});

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (isAllowedOrigin(origin)) {
                return callback(null, true);
            }

            callback(new Error('Origin not allowed'));
        },
        credentials: true,
    },
    maxHttpBufferSize: 1e6,
});

io.use((socket, next) => {
    const cookies = socket.handshake.headers.cookie
        ? socket.handshake.headers.cookie.split(';').reduce((accumulator, chunk) => {
            const [rawName, ...rest] = chunk.trim().split('=');
            if (rawName) {
                accumulator[rawName] = decodeURIComponent(rest.join('='));
            }
            return accumulator;
        }, {})
        : {};

    const session = verifySessionToken(cookies[SESSION_COOKIE]);
    if (!session) {
        return next(new Error('Unauthorized'));
    }

    socket.user = session;
    next();
});

io.on('connection', (socket) => {
    socket.on('join room', async (data) => {
        const room = sanitizeRoomName(data && data.room);
        if (!room) {
            socket.emit('socket-error', 'Invalid room.');
            return;
        }

        socket.join(room);
        socket.data.room = room;

        if (!activeRooms[room]) {
            activeRooms[room] = [];
        }

        const alreadyTracked = activeRooms[room].some((user) => user.id === socket.id);
        if (!alreadyTracked) {
            activeRooms[room].push({
                id: socket.id,
                username: socket.user.username,
                peerId: null,
                hasMedia: false,
                hasVideo: false,
                hasAudio: false,
            });
        }

        const history = await Message.find({ room }).sort({ timestamp: 1 }).limit(200).lean();
        socket.emit('load history', history);
        io.to(room).emit('room-state', activeRooms[room]);
    });

    socket.on('peer-ready', (data) => {
        const room = sanitizeRoomName(data && data.room);
        const peerId = ensureText(data && data.peerId, { min: 2, max: 200 });
        if (!room || !peerId || !activeRooms[room]) {
            return;
        }

        const participant = activeRooms[room].find((user) => user.id === socket.id);
        if (!participant) {
            return;
        }

        participant.peerId = peerId;
        io.to(room).emit('room-state', activeRooms[room]);
    });

    socket.on('media-state-change', (data) => {
        const room = sanitizeRoomName(data && data.room);
        if (!room || !activeRooms[room]) {
            return;
        }

        const participant = activeRooms[room].find((user) => user.id === socket.id);
        if (!participant) {
            return;
        }

        participant.hasMedia = Boolean(data && data.hasMedia);
        participant.hasVideo = Boolean(data && data.hasVideo);
        participant.hasAudio = Boolean(data && data.hasAudio);
        io.to(room).emit('room-state', activeRooms[room]);
    });

    socket.on('chat message', async (data) => {
        const room = sanitizeRoomName(data && data.room);
        const msg = ensureText(data && data.msg, { min: 1, max: 2000 });

        if (!room || !msg || socket.data.room !== room) {
            socket.emit('socket-error', 'Message rejected.');
            return;
        }

        const messagePayload = {
            room,
            user: socket.user.username,
            msg,
        };

        const msgToSave = new Message(messagePayload);
        await msgToSave.save();
        io.to(room).emit('chat message', {
            ...messagePayload,
            timestamp: msgToSave.timestamp,
        });
    });

    socket.on('drawing', (data) => {
        const room = sanitizeRoomName(data && data.room);
        if (!room || socket.data.room !== room) {
            return;
        }

        socket.to(room).emit('drawing', data);
    });

    socket.on('screen-share-start', (data) => {
        const room = sanitizeRoomName(data && data.room);
        if (!room || socket.data.room !== room) {
            return;
        }

        socket.to(room).emit('notify-share-start', {
            user: socket.user.username,
            room,
        });
    });

    socket.on('screen-share-stop', (data) => {
        const room = sanitizeRoomName(data && data.room);
        if (!room || socket.data.room !== room) {
            return;
        }

        socket.to(room).emit('notify-share-stop', {
            user: socket.user.username,
            room,
        });
    });

    socket.on('user-joined-media', (data) => {
        const room = sanitizeRoomName(data && data.room);
        if (!room || !activeRooms[room]) {
            return;
        }

        const participant = activeRooms[room].find((user) => user.id === socket.id);
        if (!participant) {
            return;
        }

        participant.hasMedia = true;
        participant.hasVideo = true;
        participant.hasAudio = true;
        io.to(room).emit('room-state', activeRooms[room]);
    });

    socket.on('disconnect', () => {
        for (const room of Object.keys(activeRooms)) {
            const nextUsers = activeRooms[room].filter((user) => user.id !== socket.id);
            if (nextUsers.length !== activeRooms[room].length) {
                activeRooms[room] = nextUsers;
                io.to(room).emit('room-state', activeRooms[room]);

                if (!activeRooms[room].length) {
                    delete activeRooms[room];
                }

                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`StudyPortal server listening on port ${PORT}`);
    verifyMailTransport();
});

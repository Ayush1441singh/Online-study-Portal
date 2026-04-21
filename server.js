const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const User = require('./Models/User.js');
const Message = require('./Models/message.js');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'studyportal_session';
const OTP_PENDING_COOKIE = 'studyportal_otp_pending';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const OTP_PENDING_TTL_MS = 1000 * 60 * 5;
const MAX_JSON_SIZE = '16kb';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const dbURI = process.env.MONGODB_URI;
const geminiApiKey = process.env.GEMINI_API_KEY;
const sessionSecret = process.env.SESSION_SECRET || 'development-session-secret-change-me';
const mailFrom = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || 'no-reply@studyportal.local';

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

const aiModel = geminiApiKey
    ? new GoogleGenerativeAI(geminiApiKey).getGenerativeModel({ model: 'gemini-pro' })
    : null;

function createMailTransport() {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        return nodemailer.createTransport({
            service: process.env.EMAIL_SERVICE || 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });
    }

    return null;
}

const mailTransport = createMailTransport();

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
        'https://cdn.jsdelivr.net',
        'https://justadudewhohacks.github.io',
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

async function sendLoginOtp(user) {
    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + OTP_PENDING_TTL_MS);

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    if (!mailTransport) {
        console.warn(`OTP delivery is not configured. OTP for ${user.email}: ${otp}`);
        return otp;
    }

    await mailTransport.sendMail({
        from: mailFrom,
        to: user.email,
        subject: 'StudyPortal login OTP',
        text: `Your StudyPortal verification code is ${otp}. It expires in 5 minutes.`,
        html: `<p>Your StudyPortal verification code is <strong>${otp}</strong>.</p><p>It expires in 5 minutes.</p>`,
    });

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
    const cookies = parseCookies(req);
    const pendingSession = verifySessionToken(cookies[OTP_PENDING_COOKIE]);

    if (!pendingSession) {
        return res.redirect('/login.html');
    }

    res.sendFile(path.join(__dirname, 'public', 'otp-check.html'));
});

app.get('/face-check.html', (req, res) => {
    res.redirect('/otp-check.html');
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

app.get('/security-status', requireAuth, async (req, res) => {
    res.status(200).json({
        success: true,
        otpEnabled: true,
        passkeyAvailable: false,
    });
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

        if (IS_PRODUCTION && !mailTransport) {
            return res.status(503).json({
                success: false,
                message: 'OTP email delivery is not configured on the server yet.',
            });
        }

        const otp = await sendLoginOtp(user);

        setOtpPendingCookie(res, {
            id: String(user._id),
            username: user.username,
            email: user.email,
            stage: 'otp-login',
            exp: Date.now() + OTP_PENDING_TTL_MS,
        });

        const response = {
            success: true,
            requiresOtpVerification: true,
            message: 'Password accepted. We sent a 6-digit code to your email.',
        };

        if (!IS_PRODUCTION && !mailTransport) {
            response.otpPreview = otp;
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

        user.otp = undefined;
        user.otpExpiry = undefined;
        await user.save();

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

        if (IS_PRODUCTION && !mailTransport) {
            return res.status(503).json({
                success: false,
                message: 'OTP email delivery is not configured on the server yet.',
            });
        }

        const otp = await sendLoginOtp(user);
        const response = { success: true, message: 'A new OTP has been sent to your email.' };

        if (!IS_PRODUCTION && !mailTransport) {
            response.otpPreview = otp;
        }

        res.status(200).json(response);
    } catch (error) {
        console.error('Resend OTP error:', error);
        res.status(500).json({ success: false, message: 'Could not resend OTP.' });
    }
});

app.post('/ask-ai', requireAuth, rateLimiter({ windowMs: 60 * 1000, maxRequests: 12, keyPrefix: 'ask-ai' }), async (req, res) => {
    try {
        const prompt = ensureText(req.body.prompt, { min: 2, max: 1000 });
        if (!prompt) {
            return res.status(400).json({ answer: 'Please enter a valid prompt.' });
        }

        if (!aiModel) {
            return res.status(503).json({ answer: 'AI service is not configured on the server.' });
        }

        const result = await aiModel.generateContent(`Provide a professional academic response to: ${prompt}`);
        const aiResponse = await result.response;
        res.status(200).json({ answer: aiResponse.text() });
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
            activeRooms[room].push({ id: socket.id, username: socket.user.username });
        }

        const history = await Message.find({ room }).sort({ timestamp: 1 }).limit(200).lean();
        socket.emit('load history', history);
        io.to(room).emit('update user list', activeRooms[room]);
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
        const userId = ensureText(data && data.userId, { min: 2, max: 200 });
        if (!room || !userId || socket.data.room !== room) {
            return;
        }

        socket.to(room).emit('user-connected', userId);
    });

    socket.on('disconnect', () => {
        for (const room of Object.keys(activeRooms)) {
            const nextUsers = activeRooms[room].filter((user) => user.id !== socket.id);
            if (nextUsers.length !== activeRooms[room].length) {
                activeRooms[room] = nextUsers;
                io.to(room).emit('update user list', activeRooms[room]);

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
});

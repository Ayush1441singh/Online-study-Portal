const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE MODELS ---
// Ensure kar ki tera 'Models' folder aur 'User.js' file sahi path pe hai
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI SETUP (Gemini) ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- EMAIL CONFIG (For Room Passwords) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'ayushproject7@gmail.com', // 👈 TERA EMAIL
        pass: 'abcd efgh ijkl mnop'      // 👈 TERA 16-digit APP PASSWORD
    }
});

const roomPasswords = { "Calculus": "calc123", "Java": "java88" };

// --- DB CONNECTION (Fresh StudyPortal DB) ---
// Is connection string mein humne '/StudyPortal' add kiya hai taaki naya database bane
mongoose.connect('mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/StudyPortal?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
.then(() => console.log('✅ Connected to StudyPortal Production Database'))
.catch(err => console.error('❌ DB Connection Error:', err));

// --- ROUTES ---

// 1. Home Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 2. Registration Logic (Hashing Fix)
app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const lowEmail = email.toLowerCase().trim();
        
        const exists = await User.findOne({ email: lowEmail });
        if (exists) return res.status(400).json({ success: false, message: "Email pehle se registered hai!" });
        
        // Hashing password with Salt
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({ 
            username: username.trim(), 
            email: lowEmail, 
            password: hashedPassword 
        });

        await newUser.save();
        console.log(`✨ New User Registered: ${lowEmail}`);
        res.json({ success: true });
    } catch (err) { 
        console.error("Register Error:", err);
        res.status(500).json({ success: false, message: "Server Registration Error" }); 
    }
});

// 3. Login Logic (Comparison Fix)
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const lowEmail = email.toLowerCase().trim();
        
        const user = await User.findOne({ email: lowEmail });
        if (user && await bcrypt.compare(password, user.password)) {
            console.log(`🔓 Login Success: ${lowEmail}`);
            res.json({ 
                success: true, 
                username: user.username, 
                email: user.email 
            });
        } else { 
            console.log(`❌ Login Failed for: ${lowEmail}`);
            res.status(400).json({ success: false, message: "Invalid email or password!" }); 
        }
    } catch (err) { 
        res.status(500).json({ success: false, message: "Server Login Error" }); 
    }
});

// 4. Room Password Delivery
app.post('/send-room-password', (req, res) => {
    const { email, room } = req.body;
    transporter.sendMail({
        from: '"StudyPortal Security"',
        to: email,
        subject: `Access Code for ${room}`,
        text: `Bhai, room join karne ka password ye hai: ${roomPasswords[room]}`
    }, (err) => {
        if(err) return res.status(500).json({ message: "Email delivery failed" });
        res.json({ success: true });
    });
});

// 5. Room Verification
app.post('/verify-room', (req, res) => {
    const { room, password } = req.body;
    if(roomPasswords[room] === password) res.json({ success: true });
    else res.status(401).json({ success: false });
});

// 6. AI Buddy Assistant
app.post('/ask-ai', async (req, res) => {
    try {
        const result = await aiModel.generateContent(req.body.prompt);
        res.json({ answer: (await result.response).text() });
    } catch (e) { res.json({ answer: "AI buddy thak gaya hai, baad mein pucho!" }); }
});

// 7. Clear History
app.delete('/clear-chat/:room', async (req, res) => {
    await Message.deleteMany({ room: req.params.room });
    res.json({ success: true });
});

// --- SOCKET.IO REAL-TIME LOGIC ---
const onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('join room', async (data) => {
        socket.join(data.room);
        onlineUsers[socket.id] = data;
        
        const history = await Message.find({ room: data.room }).sort({ timestamp: 1 });
        socket.emit('load history', history);
        
        const currentUsers = Object.values(onlineUsers).filter(u => u.room === data.room);
        io.to(data.room).emit('update user list', currentUsers);
    });

    socket.on('chat message', async (data) => {
        const msg = new Message(data);
        await msg.save();
        io.to(data.room).emit('chat message', data);
    });

    socket.on('screen-share-start', (d) => socket.to(d.room).emit('notify-share-start', d));
    socket.on('screen-share-stop', (d) => socket.to(d.room).emit('notify-share-stop', d));
    socket.on('user-joined-media', (d) => socket.to(d.room).emit('user-connected', d.userId));

    socket.on('disconnect', () => {
        const u = onlineUsers[socket.id];
        if(u) {
            delete onlineUsers[socket.id];
            const remaining = Object.values(onlineUsers).filter(x => x.room === u.room);
            io.to(u.room).emit('update user list', remaining);
        }
    });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Portal Live at http://localhost:${PORT}`));
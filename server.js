const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DB MODELS ---
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI SETUP ---
// Apni Gemini API Key yahan dalo ya environment variable use karo
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "YOUR_GEMINI_API_KEY");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- EMAIL CONFIG (Courier Email) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'btkbeast@gmail.com', // 👈 Apna Gmail dalo
        pass: 'onor cpka pojn fsf'    // 👈 16-digit Google App Password dalo
    }
});

// Room Passwords (Tu yahan badal sakta hai)
const roomPasswords = { 
    "Calculus": "calc123", 
    "Java": "java88" 
};

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
    .then(() => console.log('✅ DB Connected & Portal Ready'))
    .catch(err => console.error('❌ DB Connection Error:', err));

// --- AUTH ROUTES (Registration & Login Fix) ---

// Registration Route
app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const lowEmail = email.toLowerCase().trim();
        
        // Check if user exists
        const exists = await User.findOne({ email: lowEmail });
        if (exists) return res.status(400).json({ message: "Email pehle se registered hai bhai!" });
        
        // Hash Password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({ 
            username, 
            email: lowEmail, 
            password: hashedPassword 
        });

        await newUser.save();
        res.json({ success: true, message: "Register ho gaya! Ab login kar lo." });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ message: "Server Error during registration" }); 
    }
});

// Login Route
// Ye line ensure karti hai ki home page pe login.html khule
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', async (req, res) => {
    try {
        const lowEmail = req.body.email.toLowerCase().trim();
        const user = await User.findOne({ email: lowEmail });
        
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            // Login Success: Return username and email for dashboard
            res.json({ 
                success: true, 
                username: user.username, 
                email: user.email 
            });
        } else { 
            res.status(400).json({ message: "Invalid email ya password!" }); 
        }
    } catch (err) { 
        res.status(500).json({ message: "Login Fail" }); 
    }
});

// --- ROOM SECURITY (Emailing Password) ---
app.post('/send-room-password', (req, res) => {
    const { email, room } = req.body;
    
    const mailOptions = {
        from: '"StudyPortal Security" <TERA_EMAIL@gmail.com>',
        to: email,
        subject: `Password for ${room} Room`,
        text: `Bhai, ${room} room join karne ka password ye raha: ${roomPasswords[room]}. Study hard!`
    };

    transporter.sendMail(mailOptions, (err) => {
        if(err) {
            console.error(err);
            return res.status(500).json({ message: "Email nahi gayi!" });
        }
        res.json({ success: true, message: "Password sent to your email." });
    });
});

app.post('/verify-room', (req, res) => {
    const { room, password } = req.body;
    if(roomPasswords[room] === password) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Galat Password!" });
    }
});

// --- AI ASSISTANT ---
app.post('/ask-ai', async (req, res) => {
    try {
        const result = await aiModel.generateContent(`Tu ek friendly desi study buddy hai. Chota aur mast jawab de: ${req.body.prompt}`);
        const response = await result.response;
        res.json({ answer: response.text() });
    } catch (e) { 
        res.json({ answer: "Bhai AI thoda thak gaya hai, baad mein try kar!" }); 
    }
});

// --- CHAT HISTORY & CLEAR ---
app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.json({ success: true });
    } catch (err) { res.status(500).send(err); }
});

// --- SOCKETS (Real-time Logic) ---
const onlineUsers = {};
io.on('connection', (socket) => {
    
    socket.on('join room', async (data) => {
        socket.join(data.room);
        onlineUsers[socket.id] = data;
        
        // Send previous messages
        const history = await Message.find({ room: data.room }).sort({ timestamp: 1 });
        socket.emit('load history', history);
        
        // Update user list
        io.to(data.room).emit('update user list', Object.values(onlineUsers).filter(u => u.room === data.room));
    });

    socket.on('chat message', async (data) => {
        const newMessage = new Message(data);
        await newMessage.save();
        io.to(data.room).emit('chat message', data);
    });

    // Screen Share Signaling Notifications
    socket.on('screen-share-start', (data) => {
        socket.to(data.room).emit('notify-share-start', { user: data.user });
    });

    socket.on('screen-share-stop', (data) => {
        socket.to(data.room).emit('notify-share-stop', { user: data.user });
    });

    // WebRTC Signaling
    socket.on('user-joined-media', (data) => {
        socket.to(data.room).emit('user-connected', data.userId);
    });

    socket.on('disconnect', () => {
        const user = onlineUsers[socket.id];
        if(user) {
            delete onlineUsers[socket.id];
            io.to(user.room).emit('update user list', Object.values(onlineUsers).filter(u => u.room === user.room));
        }
    });
});

// 🚀 Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    🚀  Portal is LIVE!
    📂  Port: ${PORT}
    🌐  http://localhost:${PORT}
    `);
});
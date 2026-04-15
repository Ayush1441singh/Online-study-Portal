const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- APP INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE MODELS ---
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI ASSISTANT SETUP ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- EMAIL CONFIGURATION (For Room Security) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'ayushproject7@gmail.com', // 👈 TERA EMAIL
        pass: 'abcd efgh ijkl mnop'      // 👈 TERA 16-digit APP PASSWORD
    }
});

const roomPasswords = { 
    "Calculus": "calc123", 
    "Java": "java88" 
};

// --- MONGODB CONNECTION (Fresh StudyPortal Database) ---
const mongoURI = 'mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/StudyPortal?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0';

mongoose.connect(mongoURI)
    .then(() => console.log('✅ Success: Connected to StudyPortal Production Database'))
    .catch(err => console.error('❌ Database Connection Error:', err));

// --- API ROUTES ---

// Default Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Full Registration Logic
app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const normalizedEmail = email.toLowerCase().trim();

        const userExists = await User.findOne({ email: normalizedEmail });
        if (userExists) {
            return res.status(400).json({ success: false, message: "Bhai, ye email pehle se registered hai!" });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newUser = new User({
            username: username.trim(),
            email: normalizedEmail,
            password: hashedPassword
        });

        await newUser.save();
        console.log(`✨ New User Created: ${normalizedEmail}`);
        res.status(201).json({ success: true, message: "Registration Successful" });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ success: false, message: "Server registration error" });
    }
});

// Full Login Logic
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email.toLowerCase().trim();

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(401).json({ success: false, message: "Account nahi mila bhai!" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            console.log(`🔓 User Logged In: ${normalizedEmail}`);
            res.status(200).json({
                success: true,
                username: user.username,
                email: user.email
            });
        } else {
            res.status(401).json({ success: false, message: "Password galat hai!" });
        }
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ success: false, message: "Internal login failure" });
    }
});

// Email Password Sending Logic
app.post('/send-room-password', async (req, res) => {
    const { email, room } = req.body;
    
    const mailOptions = {
        from: '"StudyPortal Security" <ayushproject7@gmail.com>',
        to: email,
        subject: `🔒 Access Code for ${room} Room`,
        text: `Hello Student! ${room} room join karne ka secret code ye hai: ${roomPasswords[room]}. Study hard!`
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ success: true, message: "Email Sent" });
    } catch (error) {
        console.error("Mail Error:", error);
        res.status(500).json({ success: false, message: "Email sending failed" });
    }
});

// Room Verification
app.post('/verify-room', (req, res) => {
    const { room, password } = req.body;
    if (roomPasswords[room] === password) {
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Unauthorized access" });
    }
});

// Gemini AI Route
app.post('/ask-ai', async (req, res) => {
    try {
        const { prompt } = req.body;
        const result = await aiModel.generateContent(`Tu ek friendly desi study buddy hai. Chota aur informative jawab de: ${prompt}`);
        const response = await result.response;
        res.json({ answer: response.text() });
    } catch (error) {
        res.status(500).json({ answer: "Bhai AI thoda busy hai, baad mein try kariyo!" });
    }
});

// Chat Cleanup
app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- SOCKET.IO REAL-TIME LOGIC ---
const activeUsers = {};

io.on('connection', (socket) => {
    socket.on('join room', async (data) => {
        socket.join(data.room);
        activeUsers[socket.id] = data;

        const chatHistory = await Message.find({ room: data.room }).sort({ timestamp: 1 });
        socket.emit('load history', chatHistory);

        const roomUsers = Object.values(activeUsers).filter(u => u.room === data.room);
        io.to(data.room).emit('update user list', roomUsers);
    });

    socket.on('chat message', async (data) => {
        const msg = new Message(data);
        await msg.save();
        io.to(data.room).emit('chat message', data);
    });

    socket.on('screen-share-start', (data) => {
        socket.to(data.room).emit('notify-share-start', { user: data.user });
    });

    socket.on('screen-share-stop', (data) => {
        socket.to(data.room).emit('notify-share-stop', { user: data.user });
    });

    socket.on('user-joined-media', (data) => {
        socket.to(data.room).emit('user-connected', data.userId);
    });

    socket.on('disconnect', () => {
        const user = activeUsers[socket.id];
        if (user) {
            delete activeUsers[socket.id];
            const remainingUsers = Object.values(activeUsers).filter(u => u.room === user.room);
            io.to(user.room).emit('update user list', remainingUsers);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Portal is booming on port ${PORT}`);
});
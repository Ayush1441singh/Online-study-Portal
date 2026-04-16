const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100MB limit for attachments
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- MODELS ---
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI CONFIG ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- DATABASE CONNECTION ---
mongoose.connect('mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/StudyPortal?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
.then(() => console.log('✅ StudyPortal DB: Connected Successfully'))
.catch(err => console.error('❌ DB Connection Error:', err));

// --- API ROUTES ---

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const lowEmail = email.toLowerCase().trim();
        const exists = await User.findOne({ email: lowEmail });
        if (exists) return res.status(400).json({ success: false, message: "Email already registered!" });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username: username.trim(), email: lowEmail, password: hashedPassword });
        await newUser.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ success: true, username: user.username, email: user.email });
        } else { res.status(400).json({ success: false, message: "Invalid credentials" }); }
    } catch (err) { res.status(500).json({ success: false }); }
});

// AI Assistant Endpoint
app.post('/ask-ai', async (req, res) => {
    try {
        const prompt = req.body.prompt;
        const result = await aiModel.generateContent(`Tu ek friendly desi study mentor hai. Short aur helpful answer de: ${prompt}`);
        const response = await result.response;
        res.json({ answer: response.text() });
    } catch (e) {
        res.status(500).json({ answer: "Bhai, AI thoda thak gaya hai, baad mein try kar!" });
    }
});

// Clear Chat Endpoint
app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e); }
});

// --- SOCKET.IO REAL-TIME LOGIC ---

const rooms = {}; // Track users in rooms

io.on('connection', (socket) => {
    console.log('New User Connected:', socket.id);

    socket.on('join room', async (data) => {
        const { username, room } = data;
        socket.join(room);
        
        if (!rooms[room]) rooms[room] = [];
        rooms[room].push({ id: socket.id, username });

        // Load chat history
        const history = await Message.find({ room }).sort({ timestamp: 1 });
        socket.emit('load history', history);

        // Update everyone's user list
        io.to(room).emit('update user list', rooms[room]);
        console.log(`${username} joined ${room}`);
    });

    socket.on('chat message', async (data) => {
        const newMessage = new Message(data);
        await newMessage.save();
        io.to(data.room).emit('chat message', data);
    });

    // Whiteboard Syncing
    socket.on('drawing', (data) => {
        socket.to(data.room).emit('drawing', data);
    });

    // Screen Share & Media Signaling
    socket.on('screen-share-start', (data) => {
        socket.to(data.room).emit('notify-share-start', data);
    });

    socket.on('screen-share-stop', (data) => {
        socket.to(data.room).emit('notify-share-stop', data);
    });

    socket.on('user-joined-media', (data) => {
        socket.to(data.room).emit('user-connected', data.userId);
    });

    // Disconnect Logic
    socket.on('disconnect', () => {
        for (const room in rooms) {
            const index = rooms[room].findIndex(u => u.id === socket.id);
            if (index !== -1) {
                const user = rooms[room][index];
                rooms[room].splice(index, 1);
                io.to(room).emit('update user list', rooms[room]);
                console.log(`${user.username} left the room`);
                break;
            }
        }
    });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 STUDYPORTAL ENGINE RUNNING ON PORT ${PORT}`);
});
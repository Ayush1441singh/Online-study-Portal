const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with professional buffer settings for attachments
const io = new Server(server, { 
    cors: { 
        origin: "*" 
    }, 
    maxHttpBufferSize: 1e8 
});

// Middlewares
app.use(express.json());
// Static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE MODELS ---
// Ensure these files exist in your 'Models' folder
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI SERVICE CONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- MONGODB CONNECTION ---
const dbURI = 'mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/StudyPortal?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0';

mongoose.connect(dbURI)
    .then(() => {
        console.log('✅ System Online: Connected to StudyPortal Database');
    })
    .catch((err) => {
        console.error('❌ Database Connection Error:', err);
    });

// --- PAGE ROUTING (Guaranteed Paths) ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/registers.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'registers.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/studyroom.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studyroom.html'));
});

// --- API ENDPOINTS (Full Length) ---

// Registration Logic
app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const normalizedEmail = email.toLowerCase().trim();
        
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "Email is already registered." });
        }
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        const newUser = new User({ 
            username: username.trim(), 
            email: normalizedEmail, 
            password: hashedPassword 
        });
        
        await newUser.save();
        console.log(`✨ New User Account Created: ${normalizedEmail}`);
        res.status(201).json({ success: true, message: "Registration successful." });
    } catch (err) { 
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, message: "Server error during registration." }); 
    }
});

// Login Logic
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email.toLowerCase().trim();
        
        const user = await User.findOne({ email: normalizedEmail });
        if (user && await bcrypt.compare(password, user.password)) {
            console.log(`🔓 Successful Login: ${normalizedEmail}`);
            res.status(200).json({ 
                success: true, 
                username: user.username, 
                email: user.email 
            });
        } else { 
            res.status(400).json({ success: false, message: "Invalid email or password." }); 
        }
    } catch (err) { 
        console.error("Login Error:", err);
        res.status(500).json({ success: false, message: "Authentication failure." }); 
    }
});

// AI Assistant
app.post('/ask-ai', async (req, res) => {
    try {
        const result = await aiModel.generateContent(`Provide a professional academic response to: ${req.body.prompt}`);
        const aiResponse = await result.response;
        res.status(200).json({ answer: aiResponse.text() });
    } catch (e) { 
        console.error("AI Error:", e);
        res.status(500).json({ answer: "The AI service is currently unavailable." }); 
    }
});

// Clear Chat Logic
app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.status(200).json({ success: true });
    } catch (e) { 
        res.status(500).json({ success: false }); 
    }
});

// --- SOCKET.IO ENGINE ---
const activeRooms = {};

io.on('connection', (socket) => {
    socket.on('join room', async (data) => {
        const { username, room } = data;
        socket.join(room);
        
        if (!activeRooms[room]) {
            activeRooms[room] = [];
        }
        
        activeRooms[room].push({ id: socket.id, username: username });

        const history = await Message.find({ room: room }).sort({ timestamp: 1 });
        socket.emit('load history', history);
        
        io.to(room).emit('update user list', activeRooms[room]);
    });

    socket.on('chat message', async (data) => {
        const msgToSave = new Message(data);
        await msgToSave.save();
        io.to(data.room).emit('chat message', data);
    });

    socket.on('drawing', (data) => {
        socket.to(data.room).emit('drawing', data);
    });

    socket.on('screen-share-start', (data) => {
        socket.to(data.room).emit('notify-share-start', data);
    });

    socket.on('screen-share-stop', (data) => {
        socket.to(data.room).emit('notify-share-stop', data);
    });

    socket.on('user-joined-media', (data) => {
        socket.to(data.room).emit('user-connected', data.userId);
    });

    socket.on('disconnect', () => {
        for (const room in activeRooms) {
            const index = activeRooms[room].findIndex(u => u.id === socket.id);
            if (index !== -1) {
                activeRooms[room].splice(index, 1);
                io.to(room).emit('update user list', activeRooms[room]);
                break;
            }
        }
    });
});

// Port configuration for Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Portal Engine Active on Port ${PORT}`);
});
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

// Increased buffer size for attachments/images
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE MODELS ---
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI CONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- MONGODB CONNECTION ---
mongoose.connect('mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/StudyPortal?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
    .then(() => {
        console.log('✅ System Online: Connected to StudyPortal Production Database');
    })
    .catch((err) => {
        console.error('❌ Database Connection Error:', err);
    });

// --- API ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Registration Endpoint
app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const normalizedEmail = email.toLowerCase().trim();
        
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "This email is already registered." });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ 
            username: username.trim(), 
            email: normalizedEmail, 
            password: hashedPassword 
        });
        
        await newUser.save();
        res.status(201).json({ success: true, message: "Registration successful. You can now log in." });
    } catch (err) { 
        console.error("Registration Error:", err);
        res.status(500).json({ success: false, message: "Server error during registration." }); 
    }
});

// Login Endpoint
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email.toLowerCase().trim();
        
        const user = await User.findOne({ email: normalizedEmail });
        
        if (user && await bcrypt.compare(password, user.password)) {
            res.status(200).json({ success: true, username: user.username, email: user.email });
        } else { 
            res.status(400).json({ success: false, message: "Invalid credentials. Please try again." }); 
        }
    } catch (err) { 
        console.error("Login Error:", err);
        res.status(500).json({ success: false, message: "Authentication failure due to server error." }); 
    }
});

// AI Assistant Endpoint
app.post('/ask-ai', async (req, res) => {
    try {
        const promptContext = `You are a professional academic mentor for students. Provide a concise, highly accurate, and helpful response to the following query: ${req.body.prompt}`;
        const result = await aiModel.generateContent(promptContext);
        const responseText = (await result.response).text();
        res.status(200).json({ answer: responseText });
    } catch (e) { 
        console.error("AI Error:", e);
        res.status(500).json({ answer: "The AI service is temporarily unavailable. Please try again later." }); 
    }
});

// Clear Chat Endpoint
app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.status(200).json({ success: true, message: "Chat history cleared." });
    } catch (e) { 
        console.error("Clear Chat Error:", e);
        res.status(500).json({ success: false }); 
    }
});

// --- SOCKET.IO REAL-TIME ENGINE ---
const rooms = {};

io.on('connection', (socket) => {
    console.log('New connection established:', socket.id);

    socket.on('join room', async (data) => {
        const { username, room } = data;
        socket.join(room);
        
        if (!rooms[room]) {
            rooms[room] = [];
        }
        
        rooms[room].push({ id: socket.id, username: username });

        // Load chat history
        const history = await Message.find({ room: room }).sort({ timestamp: 1 });
        socket.emit('load history', history);
        
        // Notify room members
        io.to(room).emit('update user list', rooms[room]);
    });

    socket.on('chat message', async (data) => {
        const newMsg = new Message(data);
        await newMsg.save();
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
        for (const room in rooms) {
            const index = rooms[room].findIndex(u => u.id === socket.id);
            if (index !== -1) {
                rooms[room].splice(index, 1);
                io.to(room).emit('update user list', rooms[room]);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 StudyPortal Live Engine Running on Port ${PORT}`);
});
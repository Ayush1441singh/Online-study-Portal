const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// --- GEMINI AI SETUP ---
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const User = require('./Models/User.js');
const Message = require('./Models/message.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File Upload Config
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir, { recursive: true }); }
const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
})});

// DB Connection
mongoose.connect('mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
    .then(() => console.log('✅Connected to MongoDB '))
    .catch(err => console.error(err));

// --- ROUTES ---
// --- ROUTES SECTION ---

// Ye line ensure karegi ki '/' pe jaate hi login page khule
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// --- server.js mein dashboard ke liye ye route add kar lo ---

app.get('/user-data/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if(user) {
            res.json({ 
                username: user.username, 
                profilePic: user.profilePic || null 
            });
        } else {
            res.status(404).json({ message: "User not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ya fir agar tu redirect use karna chahta hai:
// app.get('/', (req, res) => res.redirect('/login.html'));
app.post('/ask-ai', async (req, res) => {
    try {
        const result = await model.generateContent(`Tu ek helpful study assistant hai. Chota aur badiya jawab de. Sawal: ${req.body.prompt}`);
        const response = await result.response;
        res.json({ answer: response.text() });
    } catch (e) { res.json({ answer: "AI Error! Thodi der baad try kar bhai." }); }
});

app.post('/upload', upload.single('studyFile'), (req, res) => {
    res.json({ filePath: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
});

app.delete('/clear-chat/:room', async (req, res) => {
    await Message.deleteMany({ room: req.params.room });
    res.json({ message: "Success" });
});

app.post('/register', async (req, res) => {
    const newUser = new User(req.body); await newUser.save();
    res.status(201).json({ message: "Success" });
});

app.post('/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) res.json({ username: user.username });
    else res.status(400).json({ message: "Invalid" });
});

// --- SOCKET LOGIC ---
const onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('join room', async (data) => {
        socket.join(data.room);
        onlineUsers[socket.id] = { username: data.username, room: data.room };
        const msgs = await Message.find({ room: data.room }).sort({ timestamp: 1 });
        socket.emit('load history', msgs);
        io.to(data.room).emit('update user list', Object.values(onlineUsers).filter(u => u.room === data.room));
    });

    socket.on('chat message', async (data) => {
        await new Message(data).save();
        io.to(data.room).emit('chat message', data);
    });

    socket.on('typing', (d) => socket.to(d.room).emit('display typing', d));
    socket.on('stop typing', (d) => socket.to(d.room).emit('hide typing', d));

    socket.on('user-joined-media', (data) => {
        socket.to(data.room).emit('user-connected', data.userId);
    });

    socket.on('disconnect', () => {
        const user = onlineUsers[socket.id];
        if (user) {
            const room = user.room;
            delete onlineUsers[socket.id];
            io.to(room).emit('update user list', Object.values(onlineUsers).filter(u => u.room === room));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

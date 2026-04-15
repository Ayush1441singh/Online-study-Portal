const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- GEMINI AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const User = require('./Models/User.js');
const Message = require('./Models/message.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File Upload Logic
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir, { recursive: true }); }
const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
})});

// Database Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
    .then(() => console.log('✅ DB Connected'))
    .catch(err => console.error(err));

// AI Assistant
app.post('/ask-ai', async (req, res) => {
    try {
        const result = await model.generateContent(`Bhai, tu ek friendly study assistant hai. Short jawab de: ${req.body.prompt}`);
        const response = await result.response;
        res.json({ answer: response.text() });
    } catch (e) { res.json({ answer: "AI busy hai bhai!" }); }
});

// --- AUTH ROUTES ---
app.get('/', (req, res) => res.redirect('/login.html'));

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const exists = await User.findOne({ email });
        if (exists) return res.status(400).json({ message: "Email already exists!" });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, email, password: hashedPassword });
        await newUser.save();
        res.json({ message: "Success! Ab login karo." });
    } catch (err) { res.status(500).json({ message: "Server Error!" }); }
});

app.post('/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ username: user.username });
    } else {
        res.status(400).json({ message: "Invalid credentials" });
    }
});

// Clear Chat Route
app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.json({ success: true });
    } catch (err) { res.status(500).send(err); }
});

app.post('/upload', upload.single('studyFile'), (req, res) => {
    res.json({ filePath: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
});

// Sockets
const onlineUsers = {};
io.on('connection', (socket) => {
    socket.on('join room', async (data) => {
        socket.join(data.room);
        onlineUsers[socket.id] = data;
        const history = await Message.find({ room: data.room }).sort({ timestamp: 1 });
        socket.emit('load history', history);
        io.to(data.room).emit('update user list', Object.values(onlineUsers).filter(u => u.room === data.room));
    });

    socket.on('chat message', async (data) => {
        await new Message(data).save();
        io.to(data.room).emit('chat message', data);
    });

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Models
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// DB Connection (Fresh StudyPortal DB)
mongoose.connect('mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/StudyPortal?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
.then(() => console.log('✅ Connected to StudyPortal Production Database'))
.catch(err => console.error('❌ DB Error:', err));

// --- ROUTES ---

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const lowEmail = email.toLowerCase().trim();
        const exists = await User.findOne({ email: lowEmail });
        if (exists) return res.status(400).json({ success: false, message: "Email pehle se hai!" });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username: username.trim(), email: lowEmail, password: hashedPassword });
        await newUser.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: "Register Error" }); }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ success: true, username: user.username, email: user.email });
        } else { res.status(400).json({ success: false, message: "Invalid credentials" }); }
    } catch (err) { res.status(500).json({ success: false, message: "Login Fail" }); }
});

app.post('/ask-ai', async (req, res) => {
    try {
        const result = await aiModel.generateContent(`Tu desi study buddy hai, chota answer de: ${req.body.prompt}`);
        res.json({ answer: (await result.response).text() });
    } catch (e) { res.json({ answer: "AI busy hai!" }); }
});

// --- SOCKETS (Full Detailed Logic) ---
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

    // Screen Share Signaling
    socket.on('screen-share-start', (d) => socket.to(d.room).emit('notify-share-start', d));
    socket.on('screen-share-stop', (d) => socket.to(d.room).emit('notify-share-stop', d));
    
    // Peer Connections
    socket.on('user-joined-media', (d) => socket.to(d.room).emit('user-connected', d.userId));

    socket.on('disconnect', () => {
        const u = onlineUsers[socket.id];
        if(u) {
            delete onlineUsers[socket.id];
            io.to(u.room).emit('update user list', Object.values(onlineUsers).filter(x => x.room === u.room));
        }
    });
});

server.listen(process.env.PORT || 3000, () => console.log("🚀 Server Live at 3000"));
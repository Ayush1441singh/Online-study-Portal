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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- MODELS ---
const User = require('./Models/User.js');
const Message = require('./Models/message.js');

// --- AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.API_KEY || "AIzaSyAFZ7qgyHGspnMEwZdkLqoUqkvfNSozU4I");
const aiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- EMAIL SETUP (Courier) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'TERA_EMAIL@gmail.com', 
        pass: 'abcd efgh ijkl mnop' // 16-digit App Password
    }
});

const roomPasswords = { "Calculus": "calc123", "Java": "java88" };

// --- DB CONNECTION ---
mongoose.connect('mongodb://Admin:1441@ac-kiqfzih-shard-00-00.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-01.t6qiotx.mongodb.net:27017,ac-kiqfzih-shard-00-02.t6qiotx.mongodb.net:27017/?ssl=true&replicaSet=atlas-n7gr5h-shard-0&authSource=admin&appName=Cluster0')
.then(() => console.log('✅ DB Connected')).catch(err => console.log(err));

// --- ROUTES ---

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const lowEmail = email.toLowerCase().trim();
        const exists = await User.findOne({ email: lowEmail });
        if (exists) return res.status(400).json({ message: "Email pehle se registered hai!" });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, email: lowEmail, password: hashedPassword });
        await newUser.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ message: "Registration Error" }); }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ success: true, username: user.username, email: user.email });
        } else { res.status(400).json({ message: "Invalid credentials" }); }
    } catch (err) { res.status(500).json({ message: "Login Fail" }); }
});

app.post('/send-room-password', (req, res) => {
    const { email, room } = req.body;
    transporter.sendMail({
        from: '"StudyPortal Security" <TERA_EMAIL@gmail.com>',
        to: email,
        subject: `Password for ${room} Room`,
        text: `Bhai, ${room} ka password ye raha: ${roomPasswords[room]}`
    }, (err) => {
        if(err) return res.status(500).json({ message: "Email Fail" });
        res.json({ success: true });
    });
});

app.post('/verify-room', (req, res) => {
    if(roomPasswords[req.body.room] === req.body.password) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post('/ask-ai', async (req, res) => {
    try {
        const result = await aiModel.generateContent(req.body.prompt);
        res.json({ answer: (await result.response).text() });
    } catch (e) { res.json({ answer: "AI thoda busy hai!" }); }
});

app.delete('/clear-chat/:room', async (req, res) => {
    try {
        await Message.deleteMany({ room: req.params.room });
        res.json({ success: true });
    } catch (err) { res.status(500).send(err); }
});

// --- SOCKETS ---
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

    socket.on('screen-share-start', (d) => socket.to(d.room).emit('notify-share-start', d));
    socket.on('screen-share-stop', (d) => socket.to(d.room).emit('notify-share-stop', d));
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
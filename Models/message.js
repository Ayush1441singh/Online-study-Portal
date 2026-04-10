const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    room: String,
    user: String,
    msg: String,
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', messageSchema);
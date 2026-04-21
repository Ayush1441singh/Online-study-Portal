const mongoose = require('mongoose');

const roomNoteSchema = new mongoose.Schema({
    room: {
        type: String,
        required: true,
        trim: true,
    },
    userId: {
        type: String,
        required: true,
        trim: true,
    },
    content: {
        type: String,
        default: '',
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
}, { versionKey: false });

roomNoteSchema.index({ room: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('RoomNote', roomNoteSchema);

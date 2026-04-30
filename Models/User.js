const mongoose = require('mongoose');

// --- USER SCHEMA DESIGN ---
const userSchema = new mongoose.Schema({
    username: { 
        type: String, 
        required: true,
        trim: true 
    },
    email: { 
        type: String, 
        required: true, 
        unique: true,
        lowercase: true,
        trim: true 
    },
    password: { 
        type: String, 
        required: true 
    },

    // ✅ OTP FIELD (added)
    otp: {
        type: String
    },

    // ✅ OTP EXPIRY (added)
    otpExpiry: {
        type: Date
    },

    faceDescriptor: {
        type: [Number],
        default: undefined
    },

    faceDescriptorUpdatedAt: {
        type: Date
    },

    passkeyCredentialId: {
        type: String
    },

    passkeyPublicKey: {
        type: String
    },

    passkeyCounter: {
        type: Number,
        default: 0
    },

    passkeyTransports: {
        type: [String],
        default: undefined
    },

    passkeyLabel: {
        type: String
    },

    passkeyCreatedAt: {
        type: Date
    },

    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

// --- EXPORT THE MODEL ---
module.exports = mongoose.model('User', userSchema);

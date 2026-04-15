const mongoose = require('mongoose');

// --- USER SCHEMA DESIGN ---
const userSchema = new mongoose.Schema({
    // User ka naam (Dashboard pe dikhane ke liye)
    username: { 
        type: String, 
        required: true,
        trim: true 
    },
    // Email (Unique hona chahiye taaki ek email se do account na banein)
    email: { 
        type: String, 
        required: true, 
        unique: true,
        lowercase: true,
        trim: true 
    },
    // Hashed Password (Bcrypt wala encrypted string save hoga)
    password: { 
        type: String, 
        required: true 
    },
    // Created At (Optional: Ye dekhne ke liye account kab bana)
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

// --- EXPORT THE MODEL ---
// Dhyaan rakhna yahan 'User' hi export ho kyunki server.js isi naam se dhoond raha hai
module.exports = mongoose.model('User', userSchema);
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    // Nayi fields add karo
    profilePic: { type: String, default: '/uploads/default-avatar.png' }, 
    bio: { type: String, default: 'Hey there! I am using StudyPortal.' }
});
// This is the security layer! 
// It automatically scrambles (hashes) the password right before it saves to the database.
// This is the updated security layer! 
userSchema.pre('save', async function() {
    // If the password wasn't changed, skip this step
    if (!this.isModified('password')) return; 
    
    // Scramble the password with a "salt" of 10 rounds
    this.password = await bcrypt.hash(this.password, 10);
});
module.exports = mongoose.model('User', userSchema);
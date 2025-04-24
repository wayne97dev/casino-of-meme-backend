const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  address: { type: String, required: true, unique: true },
  solBalance: { type: Number, default: 0 },
  comBalance: { type: Number, default: 0 },
});

const User = mongoose.model('User', UserSchema);

module.exports = User;
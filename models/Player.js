const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  address: { type: String, required: true, unique: true },
  totalWinnings: { type: Number, default: 0 },
});

module.exports = mongoose.model('Player', playerSchema);
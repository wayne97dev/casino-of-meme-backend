const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  players: [{
    id: { type: String, required: true }, // Socket ID
    address: { type: String, required: true }, // Indirizzo del wallet
    bet: { type: Number, required: true }, // Puntata in COM
  }],
  pot: { type: Number, required: true }, // Totale del pot
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' }, // Stato della partita
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

gameSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Game', gameSchema);
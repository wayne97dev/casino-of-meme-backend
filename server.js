const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const Player = require('./models/Player');
const Game = require('./models/Game');

const app = express();
const server = http.createServer(app);

// Definizione degli origin consentiti
const allowedOrigins = [
  'https://casino-of-meme.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use((req, res, next) => {
  console.log(`Received request: ${req.method} ${req.url} from origin: ${req.headers.origin}`);
  next();
});

// Middleware manuale per logging e gestione CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log(`Received request: ${req.method} ${req.url} from origin: ${origin}`);
  if (allowedOrigins.includes(origin)) {
    console.log(`Allowing origin: ${origin}`);
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    console.log(`Origin ${origin} not allowed by CORS`);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight request');
    return res.status(200).json({});
  }
  next();
});

// Configurazione di Socket.IO con CORS
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware per parsing JSON
app.use(express.json());

// Connessione a MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Cluster24283:Wkh1UXlmUnNf@cluster24283.ri0qrdr.mongodb.net/casino-of-meme?retryWrites=true&w=majority';
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000, // Timeout per la selezione del server
  connectTimeoutMS: 30000, // Timeout per la connessione
  socketTimeoutMS: 45000, // Timeout per le operazioni
  maxPoolSize: 10, // Limita il numero di connessioni
  retryWrites: true, // Riprova scritture in caso di errori
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Stato del gioco
const games = {};
const waitingPlayers = [];

// Indirizzo del mint COM
const COM_MINT_ADDRESS = process.env.COM_MINT_ADDRESS || '8BtoThi2ZoXnF7QQK1Wjmh2JuBw9FjVvhnGMVZ2vpump';

// Scommessa minima in COM
const MIN_BET = 1000; // 1000 COM

// Funzione per rimuovere riferimenti circolari
const removeCircularReferences = (obj, seen = new WeakSet()) => {
  if (obj && typeof obj === 'object') {
    if (seen.has(obj)) {
      return undefined; // Riferimento circolare trovato, rimuovilo
    }
    seen.add(obj);
    if (Array.isArray(obj)) {
      return obj.map(item => removeCircularReferences(item, seen));
    }
    const result = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = removeCircularReferences(obj[key], seen);
      }
    }
    return result;
  }
  return obj;
};

// Funzione di rimborso per una partita
const refundBetsForGame = async (gameId) => {
  try {
    const game = await Game.findOne({ gameId });
    if (!game || game.status === 'finished') {
      console.log(`No active game ${gameId} to refund or already finished`);
      return;
    }

    for (const player of game.players) {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.emit('refund', {
          message: 'Game crashed or interrupted. Your bet has been refunded.',
          amount: player.bet,
        });
        console.log(`Refunded ${player.bet} COM to ${player.address} for game ${gameId}`);
      }
    }

    // Rimuovi la partita dal database
    await Game.deleteOne({ gameId });
    console.log(`Deleted game ${gameId} after refund`);

    // Rimuovi la partita dallo stato in memoria
    if (games[gameId]) {
      delete games[gameId];
    }
  } catch (err) {
    console.error(`Error refunding bets for game ${gameId}:`, err);
  }
};

// Funzione per rimborsare tutte le partite attive
const refundAllActiveGames = async () => {
  try {
    const activeGames = await Game.find({ status: { $in: ['waiting', 'playing'] } });
    for (const game of activeGames) {
      for (const player of game.players) {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.emit('refund', {
            message: 'Server crashed or shutting down. Your bet has been refunded.',
            amount: player.bet,
          });
          console.log(`Refunded ${player.bet} COM to ${player.address} for game ${game.gameId}`);
        }
      }
      await Game.deleteOne({ gameId: game.gameId });
      console.log(`Deleted game ${game.gameId} after refund`);
    }
  } catch (err) {
    console.error('Error refunding active games:', err);
  }
};

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  socket.on('joinGame', async ({ playerAddress, betAmount }) => {
    console.log(`Player ${playerAddress} attempting to join with bet ${betAmount} COM`);

    // Validazione della scommessa
    const minBet = MIN_BET;
    if (betAmount < minBet) {
      socket.emit('error', { message: `Bet must be at least ${minBet.toFixed(2)} COM` });
      console.log(`Bet ${betAmount} COM rejected: below minimum ${minBet} COM`);
      return;
    }
    if (betAmount <= 0) {
      socket.emit('error', { message: 'Bet amount must be positive' });
      console.log(`Bet ${betAmount} COM rejected: non-positive`);
      return;
    }

    const existingPlayerIndex = waitingPlayers.findIndex(p => p.address === playerAddress);
    if (existingPlayerIndex !== -1) {
      waitingPlayers[existingPlayerIndex].id = socket.id;
      console.log(`Updated player ${playerAddress} socket.id to ${socket.id}`);
    } else {
      waitingPlayers.push({ id: socket.id, address: playerAddress, bet: betAmount });
      console.log(`Added player ${playerAddress} to waiting list with bet ${betAmount} COM`);
    }

    socket.emit('waiting', { message: 'You have joined the game! Waiting for another player...', players: waitingPlayers });
    io.emit('waitingPlayers', { players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) });

    if (waitingPlayers.length >= 2) {
      const gameId = Date.now().toString();
      const players = waitingPlayers.splice(0, 2);
      games[gameId] = {
        players,
        tableCards: [],
        playerCards: {},
        currentTurn: null,
        pot: players[0].bet + players[1].bet,
        currentBet: 0,
        playerBets: {
          [players[0].address]: players[0].bet,
          [players[1].address]: players[1].bet,
        },
        gamePhase: 'pre-flop',
        status: 'waiting',
        message: 'The dealer is preparing the game...',
        opponentCardsVisible: false,
        gameId,
        dealerMessage: '',
        bettingRoundComplete: false,
        turnTimer: null,
        timeLeft: 30,
      };

      // Salva la partita nel database
      try {
        const game = new Game({
          gameId,
          players: players.map(p => ({
            id: p.id,
            address: p.address,
            bet: p.bet,
          })),
          pot: players[0].bet + players[1].bet,
          status: 'waiting',
        });
        await game.save();
        console.log(`Saved game ${gameId} to database`);
      } catch (err) {
        console.error(`Error saving game ${gameId}:`, err);
        socket.emit('error', { message: 'Error starting game' });
        await refundBetsForGame(gameId);
        return;
      }

      players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.join(gameId);
        }
      });

      io.emit('waitingPlayers', { players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) });
      startGame(gameId);
    }
  });

  socket.on('leaveWaitingList', ({ playerAddress }) => {
    const playerIndex = waitingPlayers.findIndex(p => p.address === playerAddress && p.id === socket.id);
    if (playerIndex !== -1) {
      const player = waitingPlayers[playerIndex];
      waitingPlayers.splice(playerIndex, 1);
      console.log(`Player ${playerAddress} left the waiting list`);

      // Invia il rimborso al giocatore
      socket.emit('refund', {
        message: 'You left the waiting list. Your bet has been refunded.',
        amount: player.bet,
      });

      // Aggiorna gli altri giocatori nella lista d'attesa
      io.emit('waitingPlayers', { 
        players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) 
      });
      socket.emit('leftWaitingList', { message: 'You have left the waiting list.' });
    } else {
      socket.emit('error', { message: 'You are not in the waiting list.' });
      console.log(`Player ${playerAddress} not found in waiting list`);
    }
  });

  socket.on('reconnectPlayer', async ({ playerAddress, gameId }) => {
    const game = games[gameId];
    if (game) {
      const player = game.players.find(p => p.address === playerAddress);
      if (player) {
        const oldSocketId = player.id;
        player.id = socket.id;
        console.log(`Player ${playerAddress} reconnected. Updated socket.id from ${oldSocketId} to ${socket.id}`);
        socket.join(gameId);
        if (game.currentTurn === oldSocketId) {
          game.currentTurn = socket.id;
          console.log(`Updated currentTurn to new socket.id: ${socket.id}`);
        }
        // Aggiorna il socket.id nel database
        try {
          await Game.updateOne(
            { gameId, 'players.address': playerAddress },
            { $set: { 'players.$.id': socket.id } }
          );
          console.log(`Updated socket.id for ${playerAddress} in game ${gameId} database`);
        } catch (err) {
          console.error(`Error updating socket.id for ${playerAddress} in game ${gameId}:`, err);
        }
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      } else {
        console.error(`Player ${playerAddress} not found in game ${gameId}`);
      }
    } else {
      console.error(`Game ${gameId} not found during reconnection`);
    }
  });

  socket.on('makeMove', async ({ gameId, move, amount }) => {
    const game = games[gameId];
    if (!game || game.currentTurn !== socket.id) {
      return;
    }

    if (game.turnTimer) {
      clearInterval(game.turnTimer);
    }
    game.timeLeft = 30;

    const playerAddress = game.players.find(p => p.id === socket.id)?.address;
    const opponent = game.players.find(p => p.id !== socket.id);
    if (!playerAddress || !opponent) {
      await refundBetsForGame(gameId);
      return;
    }
    const currentPlayerBet = game.playerBets[playerAddress] || 0;

    if (move === 'fold') {
      game.status = 'finished';
      game.opponentCardsVisible = true;
      game.message = `${opponent.address.slice(0, 8)}... wins! ${playerAddress.slice(0, 8)}... folded.`;
      game.dealerMessage = 'The dealer announces the winner!';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
      await updateLeaderboard(opponent.address, game.pot);
      try {
        await Game.updateOne({ gameId }, { status: 'finished' });
        await Game.deleteOne({ gameId });
        console.log(`Deleted game ${gameId} from database`);
      } catch (err) {
        console.error(`Error updating/deleting game ${gameId}:`, err);
      }
      delete games[gameId];
    } else if (move === 'check') {
      if (game.currentBet > currentPlayerBet) {
        game.message = 'You cannot check, you must call or raise!';
        game.dealerMessage = 'The dealer reminds: You must call or raise!';
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      } else {
        game.message = 'You checked.';
        game.dealerMessage = 'The dealer says: Player checked.';
        if (game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
          game.bettingRoundComplete = true;
          advanceGamePhase(gameId);
        } else {
          game.currentTurn = opponent.id;
          startTurnTimer(gameId, opponent.id);
        }
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      }
    } else if (move === 'call') {
      const amountToCall = game.currentBet - currentPlayerBet;
      game.pot += amountToCall;
      game.playerBets[playerAddress] = game.currentBet;
      game.message = `You called ${amountToCall.toFixed(2)} COM.`;
      game.dealerMessage = `The dealer confirms: ${playerAddress.slice(0, 8)}... called ${amountToCall.toFixed(2)} COM.`;
      game.currentTurn = opponent.id;
      if (game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
        game.bettingRoundComplete = true;
        advanceGamePhase(gameId);
      } else {
        startTurnTimer(gameId, opponent.id);
      }
      // Aggiorna il pot nel database
      try {
        await Game.updateOne({ gameId }, { pot: game.pot });
        console.log(`Updated pot for game ${gameId} to ${game.pot}`);
      } catch (err) {
        console.error(`Error updating pot for game ${gameId}:`, err);
      }
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } else if (move === 'bet' || move === 'raise') {
      const minBet = MIN_BET;
      const newBet = move === 'bet' ? amount : game.currentBet + amount;
      if (newBet <= game.currentBet || amount < minBet) {
        game.message = `The bet must be at least ${minBet.toFixed(2)} COM and higher than the current bet!`;
        game.dealerMessage = `The dealer warns: Bet must be at least ${minBet.toFixed(2)} COM and higher!`;
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
        return;
      }
      const additionalBet = newBet - currentPlayerBet;
      game.pot += additionalBet;
      game.playerBets[playerAddress] = newBet;
      game.currentBet = newBet;
      game.message = `You ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} COM.`;
      game.dealerMessage = `The dealer announces: ${playerAddress.slice(0, 8)}... ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} COM.`;
      game.currentTurn = opponent.id;
      game.bettingRoundComplete = false;
      // Aggiorna il pot nel database
      try {
        await Game.updateOne({ gameId }, { pot: game.pot });
        console.log(`Updated pot for game ${gameId} to ${game.pot}`);
      } catch (err) {
        console.error(`Error updating pot for game ${gameId}:`, err);
      }
      startTurnTimer(gameId, opponent.id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    }
  });

  socket.on('disconnect', async () => {
    console.log('A player disconnected:', socket.id);

    const waitingIndex = waitingPlayers.findIndex(p => p.id === socket.id);
    if (waitingIndex !== -1) {
      const player = waitingPlayers[waitingIndex];
      waitingPlayers.splice(waitingIndex, 1);
      console.log(`Player ${player.address} removed from waiting list due to disconnect`);
      io.emit('waitingPlayers', { 
        players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) 
      });
    }

    for (const gameId in games) {
      const game = games[gameId];
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const opponent = game.players.find(p => p.id !== socket.id);
        if (opponent) {
          if (game.turnTimer) {
            clearInterval(game.turnTimer);
          }
          game.status = 'finished';
          game.opponentCardsVisible = true;
          game.message = `${opponent.address.slice(0, 8)}... wins! Opponent disconnected.`;
          game.dealerMessage = 'The dealer announces: A player disconnected, the game ends.';
          io.to(gameId).emit('gameState', removeCircularReferences(game));
          io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
          await updateLeaderboard(opponent.address, game.pot);
          try {
            await Game.updateOne({ gameId }, { status: 'finished' });
            await Game.deleteOne({ gameId });
            console.log(`Deleted game ${gameId} from database`);
          } catch (err) {
            console.error(`Error updating/deleting game ${gameId}:`, err);
          }
          delete games[gameId];
        } else {
          await refundBetsForGame(gameId);
        }
      }
    }
  });
});

const startTurnTimer = async (gameId, playerId) => {
  const game = games[gameId];
  if (!game) {
    console.error(`Game ${gameId} not found in startTurnTimer`);
    await refundBetsForGame(gameId);
    return;
  }

  const player = game.players.find(p => p.id === playerId);
  if (!player) {
    console.error(`Player with socket.id ${playerId} not found in game ${gameId}`);
    const opponent = game.players.find(p => p.id !== playerId);
    if (opponent) {
      game.status = 'finished';
      game.opponentCardsVisible = true;
      game.message = `${opponent.address.slice(0, 8)}... wins! Opponent disconnected or invalid.`;
      game.dealerMessage = 'The dealer announces: A player is no longer available.';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
      await updateLeaderboard(opponent.address, game.pot);
      try {
        await Game.updateOne({ gameId }, { status: 'finished' });
        await Game.deleteOne({ gameId });
        console.log(`Deleted game ${gameId} from database`);
      } catch (err) {
        console.error(`Error updating/deleting game ${gameId}:`, err);
      }
      delete games[gameId];
    } else {
      await refundBetsForGame(gameId);
    }
    return;
  }

  game.currentTurn = playerId;
  game.timeLeft = 30;

  if (game.turnTimer) {
    console.log(`Clearing previous timer for game ${gameId}`);
    clearInterval(game.turnTimer);
  }

  io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
  console.log(`Turn timer started for game ${gameId}, player ${playerId}, timeLeft: ${game.timeLeft}`);

  const clientsInRoom = io.sockets.adapter.rooms.get(gameId);
  console.log(`Clients in room ${gameId}:`, clientsInRoom ? Array.from(clientsInRoom) : 'No clients');

  const runTimer = async () => {
    try {
      if (!games[gameId]) {
        console.log(`Game ${gameId} no longer exists, stopping timer`);
        await refundBetsForGame(gameId);
        return;
      }

      game.timeLeft -= 1;
      console.log(`Game ${gameId} timer tick: timeLeft = ${game.timeLeft}, currentTurn = ${game.currentTurn}`);

      const playerSocket = io.sockets.sockets.get(game.currentTurn);
      if (!playerSocket || !playerSocket.rooms.has(gameId)) {
        console.error(`Player with socket.id ${game.currentTurn} is not connected or not in room ${gameId}`);
        const opponent = game.players.find(p => p.id !== game.currentTurn);
        if (opponent) {
          game.status = 'finished';
          game.opponentCardsVisible = true;
          game.message = `${opponent.address.slice(0, 8)}... wins! Opponent disconnected or invalid.`;
          game.dealerMessage = 'The dealer announces: A player is no longer available.';
          io.to(gameId).emit('gameState', removeCircularReferences(game));
          io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
          await updateLeaderboard(opponent.address, game.pot);
          try {
            await Game.updateOne({ gameId }, { status: 'finished' });
            await Game.deleteOne({ gameId });
            console.log(`Deleted game ${gameId} from database`);
          } catch (err) {
            console.error(`Error updating/deleting game ${gameId}:`, err);
          }
          delete games[gameId];
        } else {
          await refundBetsForGame(gameId);
        }
        return;
      }

      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));

      if (game.timeLeft <= 0) {
        const playerAddress = game.players.find(p => p.id === playerId)?.address;
        const opponent = game.players.find(p => p.id !== playerId);
        if (!playerAddress || !opponent) {
          console.error(`Player or opponent not found in game ${gameId}`);
          await refundBetsForGame(gameId);
          return;
        }
        game.status = 'finished';
        game.opponentCardsVisible = true;
        game.message = `${opponent.address.slice(0, 8)}... wins! ${playerAddress.slice(0, 8)}... timed out and folded.`;
        game.dealerMessage = 'The dealer announces: A player timed out and folded.';
        io.to(gameId).emit('gameState', removeCircularReferences(game));
        io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
        await updateLeaderboard(opponent.address, game.pot);
        try {
          await Game.updateOne({ gameId }, { status: 'finished' });
          await Game.deleteOne({ gameId });
          console.log(`Deleted game ${gameId} from database`);
        } catch (err) {
          console.error(`Error updating/deleting game ${gameId}:`, err);
        }
        delete games[gameId];
      } else {
        game.turnTimer = setTimeout(runTimer, 1000);
      }
    } catch (err) {
      console.error(`Error in turn timer for game ${gameId}:`, err);
      await refundBetsForGame(gameId);
    }
  };

  game.turnTimer = setTimeout(runTimer, 1000);
};

const startGame = async (gameId) => {
  const game = games[gameId];
  if (!game) {
    console.error(`Game ${gameId} not found in startGame`);
    await refundBetsForGame(gameId);
    return;
  }
  console.log(`Starting game ${gameId} with players:`, game.players);

  game.message = 'The dealer is dealing the cards...';
  game.dealerMessage = 'The dealer is dealing the cards to the players.';
  io.to(gameId).emit('gameState', removeCircularReferences(game));

  try {
    await Game.updateOne({ gameId }, { status: 'playing' });
    console.log(`Updated game ${gameId} status to playing`);
  } catch (err) {
    console.error(`Error updating game ${gameId} status:`, err);
    await refundBetsForGame(gameId);
    return;
  }

  setTimeout(() => {
    try {
      const player1Cards = [drawCard(), drawCard()];
      const player2Cards = [drawCard(), drawCard()];
      if (!player1Cards.every(card => card && card.image) || !player2Cards.every(card => card && card.image)) {
        throw new Error('Invalid cards drawn');
      }
      game.playerCards[game.players[0].address] = player1Cards;
      game.playerCards[game.players[1].address] = player2Cards;
      game.currentTurn = game.players[0].id;
      game.pot = game.players[0].bet + game.players[1].bet;
      game.playerBets[game.players[0].address] = game.players[0].bet;
      game.playerBets[game.players[1].address] = game.players[1].bet;
      game.currentBet = game.players[0].bet;
      game.status = 'playing';
      game.message = 'Pre-Flop: Place your bets.';
      game.dealerMessage = `The dealer says: Cards dealt! ${game.players[0].address.slice(0, 8)}... starts the betting.`;

      console.log(`Game ${gameId} started. Current turn assigned to: ${game.currentTurn}`);
      console.log(`Player 0 socket.id: ${game.players[0].id}, Player 1 socket.id: ${game.players[1].id}`);

      startTurnTimer(gameId, game.players[0].id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } catch (err) {
      console.error(`Error in startGame ${gameId}:`, err);
      game.message = 'Error starting game. Refunding bets...';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      refundBetsForGame(gameId);
    }
  }, 1000);
};

const drawCard = () => {
  const cardNumber = Math.floor(Math.random() * 13) + 1;
  const suit = ['spades', 'hearts', 'diamonds', 'clubs'][Math.floor(Math.random() * 4)];
  const suitChar = 'SHDC'[Math.floor(Math.random() * 4)];
  let cardName;
  if (cardNumber === 1) cardName = 'A';
  else if (cardNumber === 10) cardName = '0';
  else if (cardNumber === 11) cardName = 'J';
  else if (cardNumber === 12) cardName = 'Q';
  else if (cardNumber === 13) cardName = 'K';
  else cardName = cardNumber;
  return {
    value: cardNumber === 1 ? 14 : cardNumber,
    suit: suit,
    image: `https://deckofcardsapi.com/static/img/${cardName}${suitChar}.png`,
  };
};

const advanceGamePhase = async (gameId) => {
  const game = games[gameId];
  if (!game) {
    console.error(`Game ${gameId} not found in advanceGamePhase`);
    await refundBetsForGame(gameId);
    return;
  }

  const lastPlayer = game.players.find(p => p.id !== game.currentTurn);
  const nextPlayer = game.players.find(p => p.id === game.currentTurn);

  if (game.gamePhase === 'pre-flop') {
    game.message = 'The dealer is dealing the Flop...';
    game.dealerMessage = 'The dealer is dealing the Flop cards.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(() => {
      try {
        const newCards = Array(3).fill().map(() => drawCard());
        game.tableCards = newCards;
        game.gamePhase = 'flop';
        game.message = 'Flop: Place your bets.';
        game.dealerMessage = `The dealer reveals the Flop: ${newCards.map(c => `${c.value} of ${c.suit}`).join(', ')}. ${lastPlayer.address.slice(0, 8)}... is up.`;
        game.currentTurn = lastPlayer.id;
        game.bettingRoundComplete = false;
        game.currentBet = 0;
        game.playerBets[lastPlayer.address] = 0;
        game.playerBets[nextPlayer.address] = 0;
        console.log(`Advancing to Flop, turn passed to: ${lastPlayer.id}`);
        startTurnTimer(gameId, lastPlayer.id);
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      } catch (err) {
        console.error(`Error advancing to flop in game ${gameId}:`, err);
        refundBetsForGame(gameId);
      }
    }, 1000);
  } else if (game.gamePhase === 'flop') {
    game.message = 'The dealer is dealing the Turn...';
    game.dealerMessage = 'The dealer is dealing the Turn card.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(() => {
      try {
        const newCard = drawCard();
        game.tableCards.push(newCard);
        game.gamePhase = 'turn';
        game.message = 'Turn: Place your bets.';
        game.dealerMessage = `The dealer reveals the Turn: ${newCard.value} of ${newCard.suit}. ${lastPlayer.address.slice(0, 8)}... is up.`;
        game.currentTurn = lastPlayer.id;
        game.bettingRoundComplete = false;
        game.currentBet = 0;
        game.playerBets[lastPlayer.address] = 0;
        game.playerBets[nextPlayer.address] = 0;
        console.log(`Advancing to Turn, turn passed to: ${lastPlayer.id}`);
        startTurnTimer(gameId, lastPlayer.id);
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      } catch (err) {
        console.error(`Error advancing to turn in game ${gameId}:`, err);
        refundBetsForGame(gameId);
      }
    }, 1000);
  } else if (game.gamePhase === 'turn') {
    game.message = 'The dealer is dealing the River...';
    game.dealerMessage = 'The dealer is dealing the River card.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(() => {
      try {
        const newCard = drawCard();
        game.tableCards.push(newCard);
        game.gamePhase = 'river';
        game.message = 'River: Place your bets.';
        game.dealerMessage = `The dealer reveals the River: ${newCard.value} of ${newCard.suit}. ${lastPlayer.address.slice(0, 8)}... is up.`;
        game.currentTurn = lastPlayer.id;
        game.bettingRoundComplete = false;
        game.currentBet = 0;
        game.playerBets[lastPlayer.address] = 0;
        game.playerBets[nextPlayer.address] = 0;
        console.log(`Advancing to River, turn passed to: ${lastPlayer.id}`);
        startTurnTimer(gameId, lastPlayer.id);
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      } catch (err) {
        console.error(`Error advancing to river in game ${gameId}:`, err);
        refundBetsForGame(gameId);
      }
    }, 1000);
  } else if (game.gamePhase === 'river') {
    game.gamePhase = 'showdown';
    endGame(gameId);
  }
};

const getCombinations = (array, k) => {
  const result = [];
  const combine = (start, combo) => {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < array.length; i++) {
      combine(i + 1, [...combo, array[i]]);
    }
  };
  combine(0, []);
  return result;
};

const evaluatePokerHand = (hand) => {
  const combinations = getCombinations(hand, 5);
  let bestRank = -1;
  let bestDescription = '';
  let bestHighCards = [];
  let bestHand = null;

  for (const combo of combinations) {
    const values = combo.map(card => card.value).sort((a, b) => b - a);
    const suits = combo.map(card => card.suit);
    const isFlush = suits.every(suit => suit === suits[0]);
    const isStraight = values.every((val, i) => i === 0 || val === values[i - 1] - 1);
    const isLowStraight = values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2;
    const valueCounts = {};
    values.forEach(val => {
      valueCounts[val] = (valueCounts[val] || 0) + 1;
    });
    const counts = Object.values(valueCounts).sort((a, b) => b - a);

    let rank = -1;
    let description = '';
    let highCards = [];

    if (isFlush && (isStraight || isLowStraight)) {
      rank = 8;
      description = 'Straight Flush';
      highCards = isLowStraight ? [5] : [values[0]];
    } else if (counts[0] === 4) {
      rank = 7;
      description = 'Four of a Kind';
      highCards = [parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 4))];
    } else if (counts[0] === 3 && counts[1] === 2) {
      rank = 6;
      description = 'Full House';
      highCards = [
        parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 3)),
        parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 2)),
      ];
    } else if (isFlush) {
      rank = 5;
      description = 'Flush';
      highCards = values;
    } else if (isStraight || isLowStraight) {
      rank = 4;
      description = 'Straight';
      highCards = isLowStraight ? [5] : [values[0]];
    } else if (counts[0] === 3) {
      rank = 3;
      description = 'Three of a Kind';
      highCards = [
        parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 3)),
        ...values.filter(val => val !== parseInt(Object.keys(valueCounts).find(v => valueCounts[v] === 3))),
      ];
    } else if (counts[0] === 2 && counts[1] === 2) {
      rank = 2;
      description = 'Two Pair';
      const pairs = Object.keys(valueCounts).filter(val => valueCounts[val] === 2).map(Number).sort((a, b) => b - a);
      const kicker = values.find(val => !pairs.includes(val));
      highCards = [...pairs, kicker];
    } else if (counts[0] === 2) {
      rank = 1;
      description = 'One Pair';
      const pairValue = parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 2));
      highCards = [
        pairValue,
        ...values.filter(val => val !== pairValue),
      ];
    } else {
      rank = 0;
      description = 'High Card';
      highCards = values;
    }

    if (rank > bestRank) {
      bestRank = rank;
      bestDescription = description;
      bestHighCards = highCards;
      bestHand = combo;
    } else if (rank === bestRank) {
      for (let i = 0; i < bestHighCards.length; i++) {
        if (bestHighCards[i] < highCards[i]) {
          bestRank = rank;
          bestDescription = description;
          bestHighCards = highCards;
          bestHand = combo;
          break;
        } else if (bestHighCards[i] > highCards[i]) {
          break;
        }
      }
    }
  }

  console.log('Best hand:', bestHand);
  console.log('Best evaluation:', { rank: bestRank, description: bestDescription, highCards: bestHighCards });
  return { rank: bestRank, description: bestDescription, highCards: bestHighCards };
};

const endGame = async (gameId) => {
  const game = games[gameId];
  if (!game) {
    console.error(`Game ${gameId} not found in endGame`);
    await refundBetsForGame(gameId);
    return;
  }

  if (game.turnTimer) {
    clearInterval(game.turnTimer);
  }

  const player1 = game.players[0];
  const player2 = game.players[1];
  const player1Hand = [...game.playerCards[player1.address], ...game.tableCards];
  const player2Hand = [...game.playerCards[player2.address], ...game.tableCards];
  const player1Evaluation = evaluatePokerHand(player1Hand);
  const player2Evaluation = evaluatePokerHand(player2Hand);

  console.log(`Player 1 (${player1.address}) hand:`, player1Hand);
  console.log(`Player 1 evaluation:`, player1Evaluation);
  console.log(`Player 2 (${player2.address}) hand:`, player2Hand);
  console.log(`Player 2 evaluation:`, player2Evaluation);

  let winner;
  let isTie = false;
  if (player1Evaluation.rank > player2Evaluation.rank) {
    winner = player1;
    game.message = `Player 1 (${player1.address.slice(0, 8)}...) wins with a ${player1Evaluation.description}!`;
    game.dealerMessage = `The dealer declares: Player 1 (${player1.address.slice(0, 8)}...) wins with a ${player1Evaluation.description}!`;
  } else if (player2Evaluation.rank > player1Evaluation.rank) {
    winner = player2;
    game.message = `Player 2 (${player2.address.slice(0, 8)}...) wins with a ${player2Evaluation.description}!`;
    game.dealerMessage = `The dealer declares: Player 2 (${player2.address.slice(0, 8)}...) wins with a ${player2Evaluation.description}!`;
  } else {
    let tieBreaker = false;
    for (let i = 0; i < player1Evaluation.highCards.length; i++) {
      if (player1Evaluation.highCards[i] > player2Evaluation.highCards[i]) {
        winner = player1;
        game.message = `Player 1 (${player1.address.slice(0, 8)}...) wins with a ${player1Evaluation.description} (higher cards: ${player1Evaluation.highCards.join(', ')})!`;
        game.dealerMessage = `The dealer declares: Player 1 (${player1.address.slice(0, 8)}...) wins with a ${player1Evaluation.description} (higher cards: ${player1Evaluation.highCards.join(', ')})!`;
        tieBreaker = true;
        break;
      } else if (player2Evaluation.highCards[i] > player1Evaluation.highCards[i]) {
        winner = player2;
        game.message = `Player 2 (${player2.address.slice(0, 8)}...) wins with a ${player2Evaluation.description} (higher cards: ${player2Evaluation.highCards.join(', ')})!`;
        game.dealerMessage = `The dealer declares: Player 2 (${player2.address.slice(0, 8)}...) wins with a ${player2Evaluation.description} (higher cards: ${player2Evaluation.highCards.join(', ')})!`;
        tieBreaker = true;
        break;
      }
    }
    if (!tieBreaker) {
      isTie = true;
      game.message = "It's a tie! The pot is split.";
      game.dealerMessage = "The dealer declares: It's a tie! The pot is split.";
    }
  }

  game.status = 'finished';
  game.opponentCardsVisible = true;
  io.to(gameId).emit('gameState', removeCircularReferences(game));

  if (isTie) {
    const splitAmount = game.pot / 2;
    io.to(gameId).emit('distributeWinnings', { winnerAddress: player1.address, amount: splitAmount });
    io.to(gameId).emit('distributeWinnings', { winnerAddress: player2.address, amount: splitAmount });
    await updateLeaderboard(player1.address, splitAmount);
    await updateLeaderboard(player2.address, splitAmount);
  } else {
    io.to(gameId).emit('distributeWinnings', { winnerAddress: winner.address, amount: game.pot });
    await updateLeaderboard(winner.address, game.pot);
  }

  try {
    await Game.updateOne({ gameId }, { status: 'finished' });
    await Game.deleteOne({ gameId });
    console.log(`Deleted game ${gameId} from database`);
  } catch (err) {
    console.error(`Error updating/deleting game ${gameId}:`, err);
  }

  delete games[gameId];
};

const updateLeaderboard = async (playerAddress, winnings) => {
  try {
    console.log(`Updating leaderboard for ${playerAddress} with ${winnings.toFixed(2)} COM`);
    let player = await Player.findOne({ address: playerAddress });
    if (!player) {
      player = new Player({ address: playerAddress, totalWinnings: winnings });
    } else {
      player.totalWinnings += winnings;
    }
    await player.save();
    console.log(`Leaderboard updated for ${playerAddress}: ${player.totalWinnings.toFixed(2)} COM`);
  } catch (err) {
    console.error(`Error updating leaderboard for ${playerAddress}:`, err.message);
  }
};

app.get('/leaderboard', async (req, res) => {
  console.log('Received request for /leaderboard');
  try {
    console.log('Fetching leaderboard...');
    const leaderboard = await Player.find().sort({ totalWinnings: -1 }).limit(10);
    console.log('Leaderboard fetched:', leaderboard);
    if (!leaderboard || leaderboard.length === 0) {
      console.log('Leaderboard is empty');
      res.json([]);
    } else {
      const leaderboardWithUnit = leaderboard.map(player => ({
        address: player.address,
        totalWinnings: player.totalWinnings,
        unit: 'COM',
      }));
      res.json(leaderboardWithUnit);
    }
  } catch (err) {
    console.error('Error fetching leaderboard:', err.message);
    console.error('Error stack:', err.stack);
    res.status(500).json({ error: 'Error fetching leaderboard' });
  }
});

// Gestione dei crash non gestiti
process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  await refundAllActiveGames();
  process.exit(1);
});

// Gestione della terminazione del server
process.on('SIGTERM', async () => {
  console.log('Server shutting down...');
  await refundAllActiveGames();
  server.close(() => {
    mongoose.connection.close(() => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
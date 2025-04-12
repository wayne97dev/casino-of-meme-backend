const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const Player = require('./models/Player');
const Game = require('./models/Game');

const app = express();
const server = http.createServer(app);

// Define allowed origins
const allowedOrigins = [
  'https://casino-of-meme.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

// Configure CORS middleware for all requests
app.use(cors({
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
}));

// Manual middleware to handle CORS and log requests
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

// Configure Socket.IO with CORS
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

// Middleware
app.use(express.json());

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Cluster24283:Wkh1UXlmUnNf@cluster24283.ri0qrdr.mongodb.net/casino-of-meme?retryWrites=true&w=majority';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Game state
const games = {};
const waitingPlayers = [];

// COM mint address
const COM_MINT_ADDRESS = process.env.COM_MINT_ADDRESS || '8BtoThi2ZoXnF7QQK1Wjmh2JuBw9FjVvhnGMVZ2vpump';

// Minimum bet in COM
const MIN_BET = 1000; // 1000 COM

// Function to refund bets in case of crash
const refundBets = async () => {
  try {
    const activeGames = await Game.find({ status: { $in: ['waiting', 'playing'] } });
    console.log(`Found ${activeGames.length} active games to refund`);

    for (const game of activeGames) {
      const { gameId, players, pot } = game;
      const refundAmount = pot / players.length;

      for (const player of players) {
        const { address } = player;
        console.log(`Refunding ${refundAmount} COM to player ${address} for game ${gameId}`);
        io.to(gameId).emit('refund', {
          address,
          amount: refundAmount,
          gameId,
          message: `Game ${gameId} crashed or server restarted. Refunding ${refundAmount.toFixed(2)} COM.`,
        });
      }

      await Game.findOneAndUpdate(
        { gameId },
        { status: 'finished' },
        { new: true }
      );
      console.log(`Game ${gameId} marked as finished after refund`);
    }
  } catch (err) {
    console.error('Error refunding bets:', err.message);
  }
};

// Execute refund on server restart
refundBets();

// Function to remove circular references
const removeCircularReferences = (obj, seen = new WeakSet()) => {
  if (obj && typeof obj === 'object') {
    if (seen.has(obj)) {
      return undefined;
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

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  socket.on('joinGame', async ({ playerAddress, betAmount }) => {
    console.log(`Player ${playerAddress} attempting to join with bet ${betAmount} COM`);

    // Validate minimum bet
    if (betAmount < MIN_BET) {
      socket.emit('error', { message: `Bet must be at least ${MIN_BET.toFixed(2)} COM` });
      console.log(`Bet ${betAmount} COM rejected: below minimum ${MIN_BET} COM`);
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

      try {
        const gameDoc = new Game({
          gameId,
          players,
          pot: games[gameId].pot,
          status: 'waiting',
        });
        await gameDoc.save();
        console.log(`Game ${gameId} saved to MongoDB`);
      } catch (err) {
        console.error(`Error saving game ${gameId} to MongoDB:`, err.message);
        socket.emit('error', { message: 'Error starting game. Please try again.' });
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

  socket.on('reconnectPlayer', ({ playerAddress, gameId }) => {
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
      delete games[gameId];
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
        await Game.findOneAndUpdate(
          { gameId },
          { status: 'finished' },
          { new: true }
        );
        console.log(`Game ${gameId} updated in MongoDB with status: finished (player folded)`);
      } catch (err) {
        console.error(`Error updating game ${gameId} in MongoDB:`, err.message);
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
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } else if (move === 'bet' || move === 'raise') {
      const newBet = move === 'bet' ? amount : game.currentBet + amount;
      if (newBet <= game.currentBet || amount < MIN_BET) {
        game.message = `The bet must be at least ${MIN_BET.toFixed(2)} COM and higher than the current bet!`;
        game.dealerMessage = `The dealer warns: Bet must be at least ${MIN_BET.toFixed(2)} COM and higher!`;
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
        return;
      }
      if (amount > 100000) {
        game.message = `The bet cannot exceed 100000 COM!`;
        game.dealerMessage = `The dealer warns: Bet cannot exceed 100000 COM!`;
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
      startTurnTimer(gameId, opponent.id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    }
  });

  socket.on('disconnect', async () => {
    console.log('A player disconnected:', socket.id);

    const waitingIndex = waitingPlayers.findIndex(p => p.id === socket.id);
    if (waitingIndex !== -1) {
      waitingPlayers.splice(waitingIndex, 1);
      io.emit('waitingPlayers', { players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) });
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
            await Game.findOneAndUpdate(
              { gameId },
              { status: 'finished' },
              { new: true }
            );
            console.log(`Game ${gameId} updated in MongoDB with status: finished (player disconnected)`);
          } catch (err) {
            console.error(`Error updating game ${gameId} in MongoDB:`, err.message);
          }
        }
        delete games[gameId];
      }
    }
  });
});

const startTurnTimer = async (gameId, playerId) => {
  const game = games[gameId];
  if (!game) {
    console.error(`Game ${gameId} not found in startTurnTimer`);
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
        await Game.findOneAndUpdate(
          { gameId },
          { status: 'finished' },
          { new: true }
        );
        console.log(`Game ${gameId} updated in MongoDB with status: finished (player invalid)`);
      } catch (err) {
        console.error(`Error updating game ${gameId} in MongoDB:`, err.message);
      }

      delete games[gameId];
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
            await Game.findOneAndUpdate(
              { gameId },
              { status: 'finished' },
              { new: true }
            );
            console.log(`Game ${gameId} updated in MongoDB with status: finished (player disconnected in timer)`);
          } catch (err) {
            console.error(`Error updating game ${gameId} in MongoDB:`, err.message);
          }

          delete games[gameId];
        }
        return;
      }

      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));

      if (game.timeLeft <= 0) {
        const playerAddress = game.players.find(p => p.id === playerId)?.address;
        const opponent = game.players.find(p => p.id !== playerId);
        if (!playerAddress || !opponent) {
          console.error(`Player or opponent not found in game ${gameId}`);
          delete games[gameId];
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
          await Game.findOneAndUpdate(
            { gameId },
            { status: 'finished' },
            { new: true }
          );
          console.log(`Game ${gameId} updated in MongoDB with status: finished (player timed out)`);
        } catch (err) {
          console.error(`Error updating game ${gameId} in MongoDB:`, err.message);
        }

        delete games[gameId];
      } else {
        game.turnTimer = setTimeout(runTimer, 1000);
      }
    } catch (err) {
      console.error(`Error in turn timer for game ${gameId}:`, err);
    }
  };

  game.turnTimer = setTimeout(runTimer, 1000);
};

const startGame = async (gameId) => {
  const game = games[gameId];
  if (!game) {
    console.error(`Game ${gameId} not found in startGame`);
    return;
  }
  console.log(`Starting game ${gameId} with players:`, game.players);

  game.message = 'The dealer is dealing the cards...';
  game.dealerMessage = 'The dealer is dealing the cards to the players.';
  io.to(gameId).emit('gameState', removeCircularReferences(game));

  setTimeout(async () => {
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

      await Game.findOneAndUpdate(
        { gameId },
        { status: 'playing', pot: game.pot },
        { new: true }
      );
      console.log(`Game ${gameId} updated in MongoDB with status: playing`);

      console.log(`Game ${gameId} started. Current turn assigned to: ${game.currentTurn}`);
      console.log(`Player 0 socket.id: ${game.players[0].id}, Player 1 socket.id: ${game.players[1].id}`);

      startTurnTimer(gameId, game.players[0].id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } catch (err) {
      console.error(`Error in startGame ${gameId}:`, err);
      game.message = 'Error starting game. Please try again.';
      game.status = 'waiting';
      io.to(gameId).emit('gameState', removeCircularReferences(game));

      await Game.findOneAndUpdate(
        { gameId },
        { status: 'waiting' },
        { new: true }
      );
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
  if (!game) return;

  const lastPlayer = game.players.find(p => p.id !== game.currentTurn);
  const nextPlayer = game.players.find(p => p.id === game.currentTurn);

  if (game.gamePhase === 'pre-flop') {
    game.message = 'The dealer is dealing the Flop...';
    game.dealerMessage = 'The dealer is dealing the Flop cards.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(() => {
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
    }, 1000);
  } else if (game.gamePhase === 'flop') {
    game.message = 'The dealer is dealing the Turn...';
    game.dealerMessage = 'The dealer is dealing the Turn card.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(() => {
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
    }, 1000);
  } else if (game.gamePhase === 'turn') {
    game.message = 'The dealer is dealing the River...';
    game.dealerMessage = 'The dealer is dealing the River card.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(() => {
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
    }, 1000);
  } else if (game.gamePhase === 'river') {
    game.message = 'The dealer is evaluating hands...';
    game.dealerMessage = 'The dealer is determining the winner.';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    setTimeout(async () => {
      const winner = await determineWinner(game);
      game.status = 'finished';
      game.opponentCardsVisible = true;
      game.message = `${winner.address.slice(0, 8)}... wins the pot of ${game.pot.toFixed(2)} COM!`;
      game.dealerMessage = `The dealer announces: ${winner.address.slice(0, 8)}... wins!`;
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      io.to(gameId).emit('distributeWinnings', { winnerAddress: winner.address, amount: game.pot });
      await updateLeaderboard(winner.address, game.pot);

      try {
        await Game.findOneAndUpdate(
          { gameId },
          { status: 'finished' },
          { new: true }
        );
        console.log(`Game ${gameId} updated in MongoDB with status: finished (showdown)`);
      } catch (err) {
        console.error(`Error updating game ${gameId} in MongoDB:`, err.message);
      }

      delete games[gameId];
    }, 1000);
  }
};

// Simple hand evaluation for Texas Hold'em (placeholder)
const determineWinner = async (game) => {
  const player1 = game.players[0];
  const player2 = game.players[1];
  const player1Cards = [...game.playerCards[player1.address], ...game.tableCards];
  const player2Cards = [...game.playerCards[player2.address], ...game.tableCards];

  // Simplified: Highest card wins (replace with proper poker hand evaluation)
  const player1Max = Math.max(...player1Cards.map(c => c.value));
  const player2Max = Math.max(...player2Cards.map(c => c.value));

  if (player1Max > player2Max) {
    return player1;
  } else if (player2Max > player1Max) {
    return player2;
  } else {
    // Tie: Split pot or random winner for simplicity
    return game.players[Math.floor(Math.random() * 2)];
  }
};

const updateLeaderboard = async (winnerAddress, amount) => {
  try {
    const player = await Player.findOneAndUpdate(
      { address: winnerAddress },
      { $inc: { winnings: amount, gamesWon: 1 } },
      { upsert: true, new: true }
    );
    console.log(`Leaderboard updated for ${winnerAddress}: +${amount} COM, gamesWon: ${player.gamesWon}`);
  } catch (err) {
    console.error('Error updating leaderboard:', err.message);
  }
};

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
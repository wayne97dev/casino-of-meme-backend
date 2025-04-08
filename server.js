const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const Player = require('./models/Player');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://casino-of-meme.vercel.app', // URL del frontend
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Connessione a MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Cluster24283:Wkh1UXlmUnNf@cluster24283.ri0qrdr.mongodb.net/casino-of-meme?retryWrites=true&w=majority';
mongoose.connect(MONGODB_URI, {
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Stato del gioco
const games = {};

// Gestione delle connessioni WebSocket
io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  // Unisciti a una partita
  socket.on('joinGame', async ({ playerAddress, betAmount }) => {
    let gameId = null;
    // Cerca una partita in attesa
    for (const id in games) {
      if (games[id].players.length === 1) {
        gameId = id;
        break;
      }
    }

    if (!gameId) {
      // Crea una nuova partita
      gameId = Date.now().toString();
      games[gameId] = {
        players: [],
        tableCards: [],
        playerCards: {},
        currentTurn: null,
        pot: 0,
        currentBet: 0,
        playerBets: {},
        gamePhase: 'pre-flop',
        status: 'waiting',
        message: 'Waiting for another player...',
        opponentCardsVisible: false,
        gameId,
      };
    }

    // Aggiungi il giocatore alla partita
    games[gameId].players.push({ id: socket.id, address: playerAddress, bet: betAmount });
    socket.join(gameId);

    // Aggiorna la classifica con il nuovo giocatore (se non esiste)
    await updateLeaderboard(playerAddress, 0);

    // Se ci sono 2 giocatori, avvia la partita
    if (games[gameId].players.length === 2) {
      startGame(gameId);
    }

    // Invia lo stato iniziale al giocatore
    io.to(gameId).emit('gameState', games[gameId]);
  });

  // Gestione delle mosse dei giocatori
  socket.on('makeMove', async ({ gameId, move, amount }) => {
    const game = games[gameId];
    if (!game || game.currentTurn !== socket.id) return;

    const playerAddress = game.players.find(p => p.id === socket.id).address;
    const opponent = game.players.find(p => p.id !== socket.id);
    const currentPlayerBet = game.playerBets[playerAddress] || 0;

    if (move === 'fold') {
      game.status = 'finished';
      game.opponentCardsVisible = true;
      game.message = `${opponent.address.slice(0, 8)}... wins! ${playerAddress.slice(0, 8)}... folded.`;
      io.to(gameId).emit('gameState', game);
      await updateLeaderboard(opponent.address, game.pot);
      delete games[gameId];
    } else if (move === 'check') {
      if (game.currentBet > currentPlayerBet) {
        game.message = 'You cannot check, you must call or raise!';
        io.to(gameId).emit('gameState', game);
      } else {
        game.message = 'You checked.';
        advanceGamePhase(gameId, opponent.id);
      }
    } else if (move === 'call') {
      const amountToCall = game.currentBet - currentPlayerBet;
      game.pot += amountToCall;
      game.playerBets[playerAddress] = game.currentBet;
      game.message = `You called ${amountToCall.toFixed(2)} SOL.`;
      advanceGamePhase(gameId, opponent.id);
    } else if (move === 'bet' || move === 'raise') {
      const newBet = move === 'bet' ? amount : game.currentBet + amount;
      if (newBet <= game.currentBet) {
        game.message = 'The bet must be higher than the current bet!';
        io.to(gameId).emit('gameState', game);
        return;
      }
      const additionalBet = newBet - currentPlayerBet;
      game.pot += additionalBet;
      game.playerBets[playerAddress] = newBet;
      game.currentBet = newBet;
      game.message = `You ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} SOL.`;
      game.currentTurn = opponent.id;
      io.to(gameId).emit('gameState', game);
    }
  });

  // Disconnessione
  socket.on('disconnect', () => {
    console.log('A player disconnected:', socket.id);
    for (const gameId in games) {
      const game = games[gameId];
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const opponent = game.players.find(p => p.id !== socket.id);
        if (opponent) {
          game.status = 'finished';
          game.opponentCardsVisible = true;
          game.message = `${opponent.address.slice(0, 8)}... wins! Opponent disconnected.`;
          io.to(gameId).emit('gameState', game);
          updateLeaderboard(opponent.address, game.pot);
        }
        delete games[gameId];
      }
    }
  });
});

// Funzione per avviare la partita
const startGame = (gameId) => {
  const game = games[gameId];
  game.message = 'The dealer is dealing the cards...';
  io.to(gameId).emit('gameState', game);

  setTimeout(() => {
    const player1Cards = [drawCard(), drawCard()];
    const player2Cards = [drawCard(), drawCard()];
    game.playerCards[game.players[0].address] = player1Cards;
    game.playerCards[game.players[1].address] = player2Cards;
    game.currentTurn = game.players[0].id;
    game.pot = game.players[0].bet + game.players[1].bet;
    game.playerBets[game.players[0].address] = game.players[0].bet;
    game.playerBets[game.players[1].address] = game.players[1].bet;
    game.currentBet = game.players[0].bet;
    game.status = 'playing';
    game.message = 'Pre-Flop: Place your bets.';
    io.to(gameId).emit('gameState', game);
  }, 1000);
};

// Funzione per pescare una carta
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
    value: Math.min(cardNumber, 10),
    suit: suit,
    image: `https://deckofcardsapi.com/static/img/${cardName}${suitChar}.png`,
  };
};

// Funzione per avanzare alla fase successiva
const advanceGamePhase = (gameId, nextTurn) => {
  const game = games[gameId];
  if (game.gamePhase === 'pre-flop') {
    game.message = 'The dealer is dealing the Flop...';
    io.to(gameId).emit('gameState', game);
    setTimeout(() => {
      const newCards = Array(3).fill().map(() => drawCard());
      game.tableCards = newCards;
      game.gamePhase = 'flop';
      game.message = 'Flop: Place your bets.';
      game.currentTurn = nextTurn;
      io.to(gameId).emit('gameState', game);
    }, 1000);
  } else if (game.gamePhase === 'flop') {
    game.message = 'The dealer is dealing the Turn...';
    io.to(gameId).emit('gameState', game);
    setTimeout(() => {
      const newCard = drawCard();
      game.tableCards.push(newCard);
      game.gamePhase = 'turn';
      game.message = 'Turn: Place your bets.';
      game.currentTurn = nextTurn;
      io.to(gameId).emit('gameState', game);
    }, 1000);
  } else if (game.gamePhase === 'turn') {
    game.message = 'The dealer is dealing the River...';
    io.to(gameId).emit('gameState', game);
    setTimeout(() => {
      const newCard = drawCard();
      game.tableCards.push(newCard);
      game.gamePhase = 'river';
      game.message = 'River: Place your bets.';
      game.currentTurn = nextTurn;
      io.to(gameId).emit('gameState', game);
    }, 1000);
  } else if (game.gamePhase === 'river') {
    game.gamePhase = 'showdown';
    endGame(gameId);
  }
};

// Funzione per terminare la partita
const endGame = async (gameId) => {
  const game = games[gameId];
  const player1 = game.players[0];
  const player2 = game.players[1];
  const player1Hand = [...game.playerCards[player1.address], ...game.tableCards];
  const player2Hand = [...game.playerCards[player2.address], ...game.tableCards];
  const player1Evaluation = evaluatePokerHand(player1Hand);
  const player2Evaluation = evaluatePokerHand(player2Hand);

  let winner;
  if (player1Evaluation.rank > player2Evaluation.rank) {
    winner = player1;
    game.message = `${player1.address.slice(0, 8)}... wins with a ${player1Evaluation.description}!`;
  } else if (player2Evaluation.rank > player1Evaluation.rank) {
    winner = player2;
    game.message = `${player2.address.slice(0, 8)}... wins with a ${player2Evaluation.description}!`;
  } else {
    const player1HighCard = Math.max(...player1Hand.map(card => card.value));
    const player2HighCard = Math.max(...player2Hand.map(card => card.value));
    if (player1HighCard > player2HighCard) {
      winner = player1;
      game.message = `${player1.address.slice(0, 8)}... wins with a higher card (${player1HighCard})!`;
    } else if (player2HighCard > player1HighCard) {
      winner = player2;
      game.message = `${player2.address.slice(0, 8)}... wins with a higher card (${player2HighCard})!`;
    } else {
      game.message = 'It\'s a tie! The pot is split.';
      winner = player1; // Per semplicità
    }
  }

  game.status = 'finished';
  game.opponentCardsVisible = true;
  io.to(gameId).emit('gameState', game);
  await updateLeaderboard(winner.address, game.pot);
  delete games[gameId];
};

// Funzione per valutare le mani
const evaluatePokerHand = (hand) => {
  const values = hand.map(card => card.value).sort((a, b) => b - a);
  const suits = hand.map(card => card.suit);
  const isFlush = suits.every(suit => suit === suits[0]);
  const isStraight = values.every((val, i) => i === 0 || val === values[i - 1] - 1);
  const valueCounts = {};
  values.forEach(val => {
    valueCounts[val] = (valueCounts[val] || 0) + 1;
  });
  const counts = Object.values(valueCounts).sort((a, b) => b - a);
  if (isFlush && isStraight) return { rank: 8, description: 'Straight Flush' };
  if (counts[0] === 4) return { rank: 7, description: 'Four of a Kind' };
  if (counts[0] === 3 && counts[1] === 2) return { rank: 6, description: 'Full House' };
  if (isFlush) return { rank: 5, description: 'Flush' };
  if (isStraight) return { rank: 4, description: 'Straight' };
  if (counts[0] === 3) return { rank: 3, description: 'Three of a Kind' };
  if (counts[0] === 2 && counts[1] === 2) return { rank: 2, description: 'Two Pair' };
  if (counts[0] === 2) return { rank: 1, description: 'One Pair' };
  return { rank: 0, description: 'High Card', highCard: values[0] };
};

// Funzione per aggiornare la classifica
const updateLeaderboard = async (playerAddress, winnings) => {
  try {
    let player = await Player.findOne({ address: playerAddress });
    if (!player) {
      player = new Player({ address: playerAddress, totalWinnings: winnings });
    } else {
      player.totalWinnings += winnings;
    }
    await player.save();
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
};

// API per ottenere la classifica
app.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await Player.find().sort({ totalWinnings: -1 }).limit(10);
    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching leaderboard' });
  }
});

// API per aggiornare la classifica dai minigiochi
app.post('/updateLeaderboard', async (req, res) => {
  const { playerAddress, winnings } = req.body;
  try {
    await updateLeaderboard(playerAddress, winnings);
    res.status(200).json({ message: 'Leaderboard updated' });
  } catch (err) {
    res.status(500).json({ error: 'Error updating leaderboard' });
  }
});

// Avvia il server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
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
    origin: 'https://casino-of-meme.vercel.app', // Aggiorna con l'URL del tuo frontend
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Connessione a MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Cluster24283:Wkh1UXlmUnNf@cluster24283.ri0qrdr.mongodb.net/casino-of-meme?retryWrites=true&w=majority';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Stato dei giochi
const games = {};
const waitingPlayers = []; // Lista di attesa per i giocatori

// Gestione delle connessioni WebSocket
io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  // Unisciti a una partita
  socket.on('joinGame', async ({ playerAddress, betAmount }) => {
    // Aggiungi il giocatore alla lista di attesa
    waitingPlayers.push({ id: socket.id, address: playerAddress, bet: betAmount });
    socket.emit('waiting', { message: 'You have joined the game! Waiting for another player...', players: waitingPlayers });

    // Invia a tutti i giocatori in attesa la lista aggiornata
    io.emit('waitingPlayers', { players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) });

    // Se ci sono almeno 2 giocatori, avvia una partita
    if (waitingPlayers.length >= 2) {
      const gameId = Date.now().toString();
      const players = waitingPlayers.splice(0, 2); // Prendi i primi 2 giocatori
      games[gameId] = {
        players,
        tableCards: [],
        playerCards: {},
        currentTurn: null,
        pot: 0,
        currentBet: 0,
        playerBets: {},
        gamePhase: 'pre-flop',
        status: 'waiting',
        message: 'The dealer is preparing the game...',
        opponentCardsVisible: false,
        gameId,
        dealerMessage: '',
        bettingRoundComplete: false, // Flag per controllare se il round di scommesse è completo
      };

      // Unisci i giocatori alla stanza del gioco
      players.forEach(player => {
        io.sockets.sockets.get(player.id)?.join(gameId);
      });

      // Aggiorna la lista dei giocatori in attesa per tutti
      io.emit('waitingPlayers', { players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) });

      // Avvia il gioco
      startGame(gameId);
    }
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
      game.dealerMessage = 'The dealer announces the winner!';
      io.to(gameId).emit('gameState', game);
      io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
      await updateLeaderboard(opponent.address, game.pot);
      delete games[gameId];
    } else if (move === 'check') {
      if (game.currentBet > currentPlayerBet) {
        game.message = 'You cannot check, you must call or raise!';
        game.dealerMessage = 'The dealer reminds: You must call or raise!';
      } else {
        game.message = 'You checked.';
        game.dealerMessage = 'The dealer says: Player checked.';
        game.currentTurn = opponent.id;
        // Verifica se entrambi i giocatori hanno checkato
        if (game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
          game.bettingRoundComplete = true;
          advanceGamePhase(gameId);
        }
      }
      io.to(gameId).emit('gameState', game);
    } else if (move === 'call') {
      const amountToCall = game.currentBet - currentPlayerBet;
      game.pot += amountToCall;
      game.playerBets[playerAddress] = game.currentBet;
      game.message = `You called ${amountToCall.toFixed(2)} SOL.`;
      game.dealerMessage = `The dealer confirms: ${playerAddress.slice(0, 8)}... called ${amountToCall.toFixed(2)} SOL.`;
      game.currentTurn = opponent.id;
      // Verifica se le scommesse sono pareggiate
      if (game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
        game.bettingRoundComplete = true;
        advanceGamePhase(gameId);
      }
      io.to(gameId).emit('gameState', game);
    } else if (move === 'bet' || move === 'raise') {
      const newBet = move === 'bet' ? amount : game.currentBet + amount;
      if (newBet <= game.currentBet) {
        game.message = 'The bet must be higher than the current bet!';
        game.dealerMessage = 'The dealer warns: Bet must be higher than the current bet!';
        io.to(gameId).emit('gameState', game);
        return;
      }
      const additionalBet = newBet - currentPlayerBet;
      game.pot += additionalBet;
      game.playerBets[playerAddress] = newBet;
      game.currentBet = newBet;
      game.message = `You ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} SOL.`;
      game.dealerMessage = `The dealer announces: ${playerAddress.slice(0, 8)}... ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} SOL.`;
      game.currentTurn = opponent.id;
      game.bettingRoundComplete = false; // Il round di scommesse non è completo finché l'avversario non risponde
      io.to(gameId).emit('gameState', game);
    }
  });

  // Disconnessione
  socket.on('disconnect', async () => {
    console.log('A player disconnected:', socket.id);

    // Rimuovi il giocatore dalla lista di attesa, se presente
    const waitingIndex = waitingPlayers.findIndex(p => p.id === socket.id);
    if (waitingIndex !== -1) {
      waitingPlayers.splice(waitingIndex, 1);
      io.emit('waitingPlayers', { players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) });
    }

    // Gestisci la disconnessione durante una partita
    for (const gameId in games) {
      const game = games[gameId];
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const opponent = game.players.find(p => p.id !== socket.id);
        if (opponent) {
          game.status = 'finished';
          game.opponentCardsVisible = true;
          game.message = `${opponent.address.slice(0, 8)}... wins! Opponent disconnected.`;
          game.dealerMessage = 'The dealer announces: A player disconnected, the game ends.';
          io.to(gameId).emit('gameState', game);
          io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot });
          await updateLeaderboard(opponent.address, game.pot);
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
  game.dealerMessage = 'The dealer is dealing the cards to the players.';
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
    game.dealerMessage = `The dealer says: Cards dealt! ${game.players[0].address.slice(0, 8)}... starts the betting.`;
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
    value: cardNumber === 1 ? 14 : cardNumber, // Asso vale 14 per il poker
    suit: suit,
    image: `https://deckofcardsapi.com/static/img/${cardName}${suitChar}.png`,
  };
};

// Funzione per avanzare alla fase successiva
const advanceGamePhase = (gameId) => {
  const game = games[gameId];
  if (!game) return;

  if (game.gamePhase === 'pre-flop') {
    game.message = 'The dealer is dealing the Flop...';
    game.dealerMessage = 'The dealer is dealing the Flop cards.';
    io.to(gameId).emit('gameState', game);
    setTimeout(() => {
      const newCards = Array(3).fill().map(() => drawCard());
      game.tableCards = newCards;
      game.gamePhase = 'flop';
      game.message = 'Flop: Place your bets.';
      game.dealerMessage = `The dealer reveals the Flop: ${newCards.map(c => `${c.value} of ${c.suit}`).join(', ')}. ${game.players[0].address.slice(0, 8)}... is up.`;
      game.currentTurn = game.players[0].id;
      game.bettingRoundComplete = false;
      game.currentBet = 0;
      game.playerBets[game.players[0].address] = 0;
      game.playerBets[game.players[1].address] = 0;
      io.to(gameId).emit('gameState', game);
    }, 1000);
  } else if (game.gamePhase === 'flop') {
    game.message = 'The dealer is dealing the Turn...';
    game.dealerMessage = 'The dealer is dealing the Turn card.';
    io.to(gameId).emit('gameState', game);
    setTimeout(() => {
      const newCard = drawCard();
      game.tableCards.push(newCard);
      game.gamePhase = 'turn';
      game.message = 'Turn: Place your bets.';
      game.dealerMessage = `The dealer reveals the Turn: ${newCard.value} of ${newCard.suit}. ${game.players[0].address.slice(0, 8)}... is up.`;
      game.currentTurn = game.players[0].id;
      game.bettingRoundComplete = false;
      game.currentBet = 0;
      game.playerBets[game.players[0].address] = 0;
      game.playerBets[game.players[1].address] = 0;
      io.to(gameId).emit('gameState', game);
    }, 1000);
  } else if (game.gamePhase === 'turn') {
    game.message = 'The dealer is dealing the River...';
    game.dealerMessage = 'The dealer is dealing the River card.';
    io.to(gameId).emit('gameState', game);
    setTimeout(() => {
      const newCard = drawCard();
      game.tableCards.push(newCard);
      game.gamePhase = 'river';
      game.message = 'River: Place your bets.';
      game.dealerMessage = `The dealer reveals the River: ${newCard.value} of ${newCard.suit}. ${game.players[0].address.slice(0, 8)}... is up.`;
      game.currentTurn = game.players[0].id;
      game.bettingRoundComplete = false;
      game.currentBet = 0;
      game.playerBets[game.players[0].address] = 0;
      game.playerBets[game.players[1].address] = 0;
      io.to(gameId).emit('gameState', game);
    }, 1000);
  } else if (game.gamePhase === 'river') {
    game.gamePhase = 'showdown';
    endGame(gameId);
  }
};

// Funzione per generare tutte le combinazioni di k elementi da un array
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

// Funzione per valutare le mani
const evaluatePokerHand = (hand) => {
  // Genera tutte le possibili combinazioni di 5 carte dalle 7 disponibili
  const combinations = getCombinations(hand, 5);

  let bestRank = -1;
  let bestDescription = '';
  let bestHighCards = [];
  let bestHand = null;

  // Valuta ogni combinazione
  for (const combo of combinations) {
    const values = combo.map(card => card.value).sort((a, b) => b - a);
    const suits = combo.map(card => card.suit);
    const isFlush = suits.every(suit => suit === suits[0]);
    const isStraight = values.every((val, i) => i === 0 || val === values[i - 1] - 1);
    // Gestisci il caso speciale dell'Asso basso (A, 2, 3, 4, 5)
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
      highCards = isLowStraight ? [5] : [values[0]]; // Se è uno straight basso, la carta alta è 5
    } else if (counts[0] === 4) {
      rank = 7;
      description = 'Four of a Kind';
      highCards = [parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 4))];
    } else if (counts[0] === 3 && counts[1] === 2) {
      rank = 6;
      description = 'Full House';
      highCards = [
        parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 3)),
        parseInt(Object.keys(valueCounts).find(val => valueCounts[val] === 2))
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
        ...values.filter(val => val !== parseInt(Object.keys(valueCounts).find(v => valueCounts[v] === 3)))
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
        ...values.filter(val => val !== pairValue)
      ];
    } else {
      rank = 0;
      description = 'High Card';
      highCards = values;
    }

    // Confronta con la migliore combinazione trovata finora
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

// Funzione per terminare la partita
const endGame = async (gameId) => {
  const game = games[gameId];
  if (!game) return;

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
      game.message = 'It\'s a tie! The pot is split.';
      game.dealerMessage = 'The dealer declares: It\'s a tie! The pot is split.';
      winner = player1; // Per semplicità
    }
  }

  game.status = 'finished';
  game.opponentCardsVisible = true;
  io.to(gameId).emit('gameState', game);
  io.to(gameId).emit('distributeWinnings', { winnerAddress: winner.address, amount: game.pot });
  await updateLeaderboard(winner.address, game.pot);
  delete games[gameId];
};

// Funzione per aggiornare la classifica
const updateLeaderboard = async (playerAddress, winnings) => {
  try {
    console.log(`Attempting to update leaderboard for ${playerAddress} with winnings: ${winnings}`);
    let player = await Player.findOne({ address: playerAddress });
    if (!player) {
      console.log(`Player ${playerAddress} not found, creating new entry with winnings: ${winnings}`);
      player = new Player({ address: playerAddress, totalWinnings: winnings });
    } else {
      console.log(`Player ${playerAddress} found, current totalWinnings: ${player.totalWinnings}, adding: ${winnings}`);
      player.totalWinnings += winnings;
    }
    await player.save();
    console.log(`Leaderboard successfully updated for ${playerAddress}: totalWinnings now ${player.totalWinnings}`);
  } catch (err) {
    console.error(`Error updating leaderboard for ${playerAddress}:`, err.message);
    console.error('Error stack:', err.stack);
  }
};

// API per ottenere la classifica
app.get('/leaderboard', async (req, res) => {
  try {
    console.log('Fetching leaderboard...');
    const leaderboard = await Player.find().sort({ totalWinnings: -1 }).limit(10);
    console.log('Leaderboard fetched:', leaderboard);
    if (!leaderboard || leaderboard.length === 0) {
      console.log('Leaderboard is empty');
      res.json([]);
    } else {
      res.json(leaderboard);
    }
  } catch (err) {
    console.error('Error fetching leaderboard:', err.message);
    console.error('Error stack:', err.stack);
    res.status(500).json({ error: 'Error fetching leaderboard' });
  }
});

// Avvia il server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
require('dotenv').config(); // Carica le variabili d'ambiente dal file .env



const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const Player = require('./models/Player');
const Game = require('./models/Game');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction, getTokenAccountBalance } = require('@solana/spl-token');
const bs58 = require('bs58');

const gameStates = {}; // Memorizza lo stato dei giochi per Solana Card Duel

const app = express();
const server = http.createServer(app);

// Definizione degli origin consentiti
const allowedOrigins = [
  'https://casino-of-meme.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

// Inizializzazione di socket.io
console.log('DEBUG - Creating socket.io server...');
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
console.log('DEBUG - socket.io server created:', io ? 'Success' : 'Failed');

// Middleware per logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from origin: ${req.headers.origin}`);
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] Response status: ${res.statusCode}`);
  });
  next();
});

// Middleware CORS ottimizzato
app.use(cors({
  origin: (origin, callback) => {
    console.log(`CORS check for origin: ${origin}`);
    if (!origin || allowedOrigins.includes(origin)) {
      console.log(`Allowing origin: ${origin}`);
      callback(null, true);
    } else {
      console.log(`Blocking origin: ${origin}`);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Gestore esplicito per richieste OPTIONS
app.options('*', cors());

// Middleware per parsing JSON
app.use(express.json());

// Endpoint health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Connessione a MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('ERROR - MONGODB_URI is missing in environment variables');
  process.exit(1);
}
console.log('DEBUG - MONGODB_URI:', MONGODB_URI ? 'Present' : 'Missing');
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 50000,
  connectTimeoutMS: 50000,
  socketTimeoutMS: 60000,
  maxPoolSize: 10,
  retryWrites: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Connessione a Solana
const connection = new Connection('https://rpc.helius.xyz/?api-key=fa5d0fbf-c064-4cdc-9e68-0a931504f2ba', 'confirmed');

// Carica la private key in formato base58
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
  console.error('ERROR - WALLET_PRIVATE_KEY is missing in environment variables');
  process.exit(1);
}
console.log('DEBUG - WALLET_PRIVATE_KEY:', WALLET_PRIVATE_KEY ? 'Present' : 'Missing');

// Crea il wallet del casinò (tax wallet)
let taxWallet;
try {
  taxWallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
  console.log('Tax wallet public key:', taxWallet.publicKey.toBase58());
} catch (err) {
  console.error('ERROR - Invalid WALLET_PRIVATE_KEY:', err.message);
  process.exit(1);
}

// Definisci l'ATA del tax wallet per COM in una funzione async
let taxWalletATA;
(async () => {
  try {
    taxWalletATA = await getAssociatedTokenAddress(MINT_ADDRESS, taxWallet.publicKey);
    console.log('Tax wallet ATA:', taxWalletATA.toBase58());
  } catch (err) {
    console.error('ERROR - Failed to get tax wallet ATA:', err.message);
    process.exit(1);
  }
})();


// Stato del gioco
const games = {};
const waitingPlayers = [];

// Indirizzo del mint COM
const COM_MINT_ADDRESS = '5HV956n7UQT1XdJzv43fHPocest5YAmi9ipsuiJx7zt7';
console.log('DEBUG - COM_MINT_ADDRESS:', COM_MINT_ADDRESS);
const MINT_ADDRESS = new PublicKey(COM_MINT_ADDRESS);

// Scommessa minima in COM per Poker PvP
const MIN_BET = 1000; // 1000 COM

// Funzione per rimuovere riferimenti circolari
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



// Costanti per i minigiochi
const COMPUTER_WIN_CHANCE = {
  solanaCardDuel: 0.9,
  memeSlots: 0.8,
  coinFlip: 0.65,
  crazyWheel: 0.95,
};

const slotMemes = [
  { name: 'Doge', image: '/doge.png' },
  { name: 'Pepe', image: '/pepe.png' },
  { name: 'Wojak', image: '/wojak.png' },
  { name: 'Shiba', image: '/shiba.png' },
  { name: 'Moon', image: '/moon.png' },
  { name: 'Meme', image: '/meme.png' },
  { name: 'BONUS', image: '/BONUS.png' },
  { name: 'Random', image: '/random.png' },
];

const crazyTimeWheelBase = [
  ...Array(23).fill().map(() => ({ type: 'number', value: 1, color: '#FFD700', colorName: 'Yellow' })),
  ...Array(15).fill().map(() => ({ type: 'number', value: 2, color: '#00FF00', colorName: 'Green' })),
  ...Array(7).fill().map(() => ({ type: 'number', value: 5, color: '#FF4500', colorName: 'Orange' })),
  ...Array(4).fill().map(() => ({ type: 'number', value: 10, color: '#1E90FF', colorName: 'Blue' })),
  ...Array(4).fill().map(() => ({ type: 'bonus', value: 'Coin Flip', color: '#FF69B4', colorName: 'Pink' })),
  ...Array(2).fill().map(() => ({ type: 'bonus', value: 'Pachinko', color: '#00CED1', colorName: 'Turquoise' })),
  ...Array(2).fill().map(() => ({ type: 'bonus', value: 'Cash Hunt', color: '#8A2BE2', colorName: 'Purple' })),
  { type: 'bonus', value: 'Crazy Time', color: '#FF0000', colorName: 'Red' },
];

const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const crazyTimeWheel = shuffleArray([...crazyTimeWheelBase]);

// Endpoint per Meme Slots
app.post('/play-meme-slots', async (req, res) => {
  const { playerAddress, betAmount, signedTransaction } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction) {
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);

    // Verifica il saldo SOL
    const userBalance = await connection.getBalance(userPublicKey);
    if (userBalance < betInLamports) {
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    // Valida e processa la transazione firmata
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    // Genera il risultato della slot
    let result;
    const winLines = [
      [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
      [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
      [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
    ];

    if (Math.random() < COMPUTER_WIN_CHANCE.memeSlots) {
      // Computer vince: genera un risultato senza linee vincenti
      result = Array(25).fill().map(() => slotMemes[Math.floor(Math.random() * slotMemes.length)]);
      let attempts = 0;
      while (attempts < 20) {
        let hasWin = false;
        for (const line of winLines) {
          const symbolsInLine = line.map(index => result[index].name);
          let currentSymbol = symbolsInLine[0];
          let streak = 1;
          for (let j = 1; j < symbolsInLine.length; j++) {
            if (symbolsInLine[j].toLowerCase() === currentSymbol.toLowerCase()) {
              streak++;
              if (streak >= 3) {
                hasWin = true;
                break;
              }
            } else {
              currentSymbol = symbolsInLine[j];
              streak = 1;
            }
          }
          if (hasWin) break;
        }
        if (!hasWin) break;
        result = Array(25).fill().map(() => slotMemes[Math.floor(Math.random() * slotMemes.length)]);
        attempts++;
      }
    } else {
      // Giocatore vince: genera una linea vincente
      result = Array(25).fill().map(() => slotMemes[Math.floor(Math.random() * slotMemes.length)]);
      const winningSymbol = slotMemes[Math.floor(Math.random() * slotMemes.length)];
      const winningLine = winLines[Math.floor(Math.random() * winLines.length)];
      const streakOptions = [
        { streak: 3, probability: 0.9 },
        { streak: 4, probability: 0.09 },
        { streak: 5, probability: 0.01 },
      ];
      const totalProbability = streakOptions.reduce((sum, option) => sum + option.probability, 0);
      let random = Math.random() * totalProbability;
      let selectedStreak = 3;
      for (const option of streakOptions) {
        if (random < option.probability) {
          selectedStreak = option.streak;
          break;
        }
        random -= option.probability;
      }
      for (let i = 0; i < selectedStreak; i++) {
        result[winningLine[i]] = winningSymbol;
      }
    }

    // Calcola le vincite
    const winningLinesFound = [];
    const winningIndices = new Set();
    let totalWin = 0;

    for (let i = 0; i < winLines.length; i++) {
      const line = winLines[i];
      const symbolsInLine = line.map(index => result[index].name);
      let currentSymbol = symbolsInLine[0];
      let streak = 1;
      let streakStart = 0;

      for (let j = 1; j < symbolsInLine.length; j++) {
        if (symbolsInLine[j] === currentSymbol) {
          streak++;
        } else {
          if (streak >= 3) {
            winningLinesFound.push(i);
            for (let k = streakStart; k < streakStart + streak; k++) {
              winningIndices.add(line[k]);
            }
            let winAmount = streak === 3 ? betAmount * 0.5 : streak === 4 ? betAmount * 3 : betAmount * 10;
            if (currentSymbol.toLowerCase() === 'bonus') winAmount *= 2;
            totalWin += winAmount;
          }
          currentSymbol = symbolsInLine[j];
          streak = 1;
          streakStart = j;
        }
      }

      if (streak >= 3) {
        winningLinesFound.push(i);
        for (let k = streakStart; k < streakStart + streak; k++) {
          winningIndices.add(line[k]);
        }
        let winAmount = streak === 3 ? betAmount * 0.5 : streak === 4 ? betAmount * 3 : betAmount * 10;
        if (currentSymbol.toLowerCase() === 'bonus') winAmount *= 2;
        totalWin += winAmount;
      }
    }

    // Distribuisci le vincite
    if (totalWin > 0) {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userPublicKey,
          lamports: Math.round(totalWin * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);

      const winSignature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(winSignature);
      console.log(`Distributed ${totalWin} SOL to ${playerAddress}`);
    }

    res.json({
      success: true,
      result: result.map(item => ({ name: item.name, image: item.image })),
      winningLines: winningLinesFound,
      winningIndices: Array.from(winningIndices),
      totalWin,
    });
  } catch (err) {
    console.error('Error in play-meme-slots:', err);
    res.status(500).json({ success: false, error: 'Failed to play meme slots' });
  }
});

// Endpoint per Coin Flip
app.post('/play-coin-flip', async (req, res) => {
  const { playerAddress, betAmount, signedTransaction, choice } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction || !choice || !['blue', 'red'].includes(choice)) {
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);

    // Verifica il saldo SOL
    const userBalance = await connection.getBalance(userPublicKey);
    if (userBalance < betInLamports) {
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    // Valida e processa la transazione firmata
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    // Genera il risultato del Coin Flip
    let flipResult;
    if (Math.random() < COMPUTER_WIN_CHANCE.coinFlip) {
      flipResult = choice === 'blue' ? 'red' : 'blue';
    } else {
      flipResult = choice;
    }

    let totalWin = 0;
    if (choice === flipResult) {
      totalWin = betAmount * 2;

      // Distribuisci la vincita
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userPublicKey,
          lamports: Math.round(totalWin * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);

      const winSignature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(winSignature);
      console.log(`Distributed ${totalWin} SOL to ${playerAddress}`);
    }

    res.json({
      success: true,
      flipResult,
      totalWin,
    });
  } catch (err) {
    console.error('Error in play-coin-flip:', err);
    res.status(500).json({ success: false, error: 'Failed to play coin flip' });
  }
});



// Endpoint per Crazy Wheel
app.post('/play-crazy-wheel', async (req, res) => {
  const { playerAddress, bets, signedTransaction } = req.body;

  if (!playerAddress || !bets || !signedTransaction) {
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  const totalBet = Object.values(bets).reduce((sum, bet) => sum + bet, 0);
  if (totalBet <= 0) {
    return res.status(400).json({ success: false, error: 'No bets placed' });
  }

  // Valida le scommesse
  const validSegments = ['1', '2', '5', '10', 'Coin Flip', 'Pachinko', 'Cash Hunt', 'Crazy Time'];
  for (const segment in bets) {
    if (!validSegments.includes(segment) || isNaN(bets[segment]) || bets[segment] < 0) {
      return res.status(400).json({ success: false, error: 'Invalid bet segment or amount' });
    }
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(totalBet * LAMPORTS_PER_SOL);

    // Verifica il saldo SOL
    const userBalance = await connection.getBalance(userPublicKey);
    if (userBalance < betInLamports) {
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    // Valida e processa la transazione firmata
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    // Non genera il risultato del gioco, lascia che il frontend lo gestisca
    res.json({ success: true });
  } catch (err) {
    console.error('Error in play-crazy-wheel:', err);
    res.status(500).json({ success: false, error: 'Failed to process transaction' });
  }
});

app.get('/get-crazy-wheel', (req, res) => {
  try {
    console.log('DEBUG - Fetching crazyTimeWheel for frontend');
    res.json({ success: true, wheel: crazyTimeWheel });
  } catch (err) {
    console.error('Error fetching crazyTimeWheel:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch wheel data' });
  }
});

 







// Endpoint aggiornato
app.post('/play-solana-card-duel', async (req, res) => {
  const { playerAddress, betAmount, signedTransaction, action } = req.body;

  if (!playerAddress || !action) {
    return res.status(400).json({ success: false, error: 'Invalid playerAddress or action' });
  }

  if (action !== 'start') {
    // Ignora azioni diverse da 'start', poiché la logica di gioco è gestita nel frontend
    return res.json({ success: true });
  }

  if (!betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction) {
    return res.status(400).json({ success: false, error: 'Invalid betAmount or signedTransaction' });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);

    // Verifica il saldo SOL
    const userBalance = await connection.getBalance(userPublicKey);
    if (userBalance < betInLamports) {
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    // Valida e processa la transazione
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);
    if (!transaction.verifySignatures()) {
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    res.json({
      success: true,
      message: 'Bet placed successfully',
    });
  } catch (err) {
    console.error('Error in play-solana-card-duel:', err);
    res.status(500).json({ success: false, error: `Failed to play solana card duel: ${err.message}` });
  }
});

// Funzione di rimborso per una partita
const refundBetsForGame = async (gameId) => {
  try {
    const game = await Game.findOne({ gameId });
    if (!game || game.status === 'finished') {
      console.log(`No active game ${gameId} to refund or already finished`);
      return;
    }

    console.log(`Refunding bets for game ${gameId}, players:`, game.players);
    for (const player of game.players) {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        console.log(`Emitting refund event to player ${player.address}, amount: ${player.bet}`);
        playerSocket.emit('refund', {
          message: 'Game crashed or interrupted. Your bet has been refunded.',
          amount: player.bet,
          isRefund: true, // Aggiunto flag
        });
        console.log(`Refunded ${player.bet} COM to ${player.address} for game ${gameId}`);
      } else {
        console.log(`Player ${player.address} socket not found, skipping refund emission`);
      }
    }

    await Game.deleteOne({ gameId });
    console.log(`Deleted game ${gameId} after refund`);

    if (games[gameId]) {
      delete games[gameId];
      console.log(`Removed game ${gameId} from games object`);
    }
  } catch (err) {
    console.error(`Error refunding bets for game ${gameId}:`, err.message, err.stack);
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

// Endpoint per il saldo del tax wallet
app.get('/tax-wallet-balance', async (req, res) => {
  try {
    console.log('Fetching tax wallet balance for:', wallet.publicKey.toBase58());
    const balance = await connection.getBalance(wallet.publicKey);
    console.log('Balance fetched:', balance);
    const taxWalletBalance = balance / LAMPORTS_PER_SOL;
    res.json({ success: true, balance: taxWalletBalance });
  } catch (err) {
    console.error('Error fetching tax wallet balance:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch tax wallet balance' });
  }
});

// Endpoint per le ricompense
app.get('/rewards', async (req, res) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    const usableBalance = balance * 0.5;
    const solPerToken = Math.floor(usableBalance * 0.95);
    const solPerPortion = Math.floor(solPerToken / 3);
    const dailySolReward = solPerPortion / LAMPORTS_PER_SOL;

    const wbtcATA = await getAssociatedTokenAddress(
      new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'),
      wallet.publicKey
    );
    const wethATA = await getAssociatedTokenAddress(
      new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'),
      wallet.publicKey
    );

    const wbtcBalance = await connection.getTokenAccountBalance(wbtcATA).catch(() => ({
      value: { amount: '0' },
    }));
    const wethBalance = await connection.getTokenAccountBalance(wethATA).catch(() => ({
      value: { amount: '0' },
    }));

    const dailyWbtcReward = Number(wbtcBalance.value.amount) / 1e8;
    const dailyWethReward = Number(wethBalance.value.amount) / 1e8;

    res.json({
      success: true,
      rewards: {
        sol: dailySolReward,
        wbtc: dailyWbtcReward,
        weth: dailyWethReward,
      },
    });
  } catch (err) {
    console.error('Error fetching rewards:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// Endpoint per il saldo COM
app.get('/com-balance/:playerAddress', async (req, res) => {
  const { playerAddress } = req.params;
  try {
    const userPublicKey = new PublicKey(playerAddress);
    const userATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey);
    const balance = await connection.getTokenAccountBalance(userATA).catch(() => ({
      value: { uiAmount: 0 },
    }));
    const comBalance = balance.value.uiAmount || 0;
    res.json({ success: true, balance: comBalance });
  } catch (err) {
    console.error('Error fetching COM balance:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch COM balance' });
  }
});

// Endpoint per distribuire vincite in COM (usato per Poker PvP)
app.post('/distribute-winnings', async (req, res) => {
  const { winnerAddress, amount } = req.body;

  if (!winnerAddress || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid winnerAddress or amount' });
  }

  try {
    const casinoATA = await getAssociatedTokenAddress(MINT_ADDRESS, wallet.publicKey);
    const winnerATA = await getAssociatedTokenAddress(MINT_ADDRESS, new PublicKey(winnerAddress));

    const transaction = new Transaction().add(
      createTransferInstruction(
        casinoATA,
        winnerATA,
        wallet.publicKey,
        amount * 1e9
      )
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.partialSign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature);
    console.log(`Sent ${amount} COM to the Winner ${winnerAddress}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error distributing winnings:', err);
    res.status(500).json({ success: false, error: 'Failed to distribute winnings' });
  }
});

// Endpoint per gestire i rimborsi in COM (usato per Poker PvP)
app.post('/refund', async (req, res) => {
  const { playerAddress, amount } = req.body;

  console.log('Received request to /refund:', { playerAddress, amount });

  // Validazione dei parametri
  if (!playerAddress || !amount || isNaN(amount) || amount <= 0) {
    console.log('Invalid refund parameters:', { playerAddress, amount });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress or amount' });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const playerATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey);
    console.log('Player ATA:', playerATA.toBase58());

    // Verifica il saldo SOL del tax wallet per le fee
    console.log('Checking tax wallet SOL balance...');
    const taxWalletSolBalance = await retry(() => connection.getBalance(taxWallet.publicKey));
    const minSolBalance = 0.01 * LAMPORTS_PER_SOL; // Minimo 0.01 SOL per le fee
    console.log('Tax wallet SOL balance:', taxWalletSolBalance / LAMPORTS_PER_SOL, 'SOL');
    if (taxWalletSolBalance < minSolBalance) {
      console.log('Insufficient SOL balance in tax wallet for fees:', {
        balance: taxWalletSolBalance / LAMPORTS_PER_SOL,
        required: minSolBalance / LAMPORTS_PER_SOL,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient SOL balance in tax wallet for transaction fees: ${taxWalletSolBalance / LAMPORTS_PER_SOL} SOL available, ${minSolBalance / LAMPORTS_PER_SOL} SOL required`,
      });
    }

    // Verifica se l'ATA del tax wallet esiste
    let taxWalletAccountExists = false;
    try {
      await getAccount(connection, taxWalletATA);
      taxWalletAccountExists = true;
      console.log('Tax wallet ATA exists:', taxWalletATA.toBase58());
    } catch (err) {
      console.log('Tax wallet ATA does not exist, creating...');
      try {
        const transaction = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            taxWallet.publicKey,
            taxWalletATA,
            taxWallet.publicKey,
            MINT_ADDRESS
          )
        );
        const { blockhash } = await retry(() => connection.getLatestBlockhash());
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = taxWallet.publicKey;
        transaction.partialSign(taxWallet);
        const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
        await retry(() => connection.confirmTransaction(signature));
        console.log('Created tax wallet ATA:', taxWalletATA.toBase58());
      } catch (err) {
        console.error('Failed to create tax wallet ATA:', err.message);
        return res.status(500).json({ success: false, error: `Failed to create tax wallet ATA: ${err.message}` });
      }
    }

    // Verifica il saldo del tax wallet
    console.log('Checking tax wallet COM balance...');
    let taxWalletBalance;
    try {
      taxWalletBalance = await retry(() => connection.getTokenAccountBalance(taxWalletATA));
    } catch (err) {
      console.error('Failed to fetch tax wallet COM balance:', err.message);
      return res.status(500).json({
        success: false,
        error: `Failed to fetch tax wallet COM balance: ${err.message}`,
      });
    }
    console.log('Tax wallet COM balance:', taxWalletBalance.value.uiAmount, 'COM');
    if (!taxWalletBalance || !taxWalletBalance.value || taxWalletBalance.value.uiAmount < amount) {
      const balance = taxWalletBalance?.value?.uiAmount || 0;
      console.log('Insufficient COM balance in tax wallet:', {
        balance: taxWalletBalance.value.uiAmount,
        required: amount,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient COM balance in tax wallet: ${balance} COM available, ${amount} COM required`,
      });
    }

    // Verifica se l'ATA del giocatore esiste, altrimenti crealo
    let playerAccountExists = false;
    try {
      console.log('Checking if player ATA exists...');
      await getAccount(connection, playerATA);
      playerAccountExists = true;
      console.log('Player ATA exists:', playerATA.toBase58());
    } catch (err) {
      console.log('Player ATA does not exist, creating...');
      try {
        const transaction = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            taxWallet.publicKey,
            playerATA,
            userPublicKey,
            MINT_ADDRESS
          )
        );
        const { blockhash } = await retry(() => connection.getLatestBlockhash());
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = taxWallet.publicKey;
        transaction.partialSign(taxWallet);
        const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
        await retry(() => connection.confirmTransaction(signature));
        console.log('Created player ATA:', playerATA.toBase58());
      } catch (err) {
        console.error('Failed to create player ATA:', err.message);
        return res.status(500).json({ success: false, error: `Failed to create player ATA: ${err.message}` });
      }
    }

    // Crea la transazione di rimborso
    console.log('Creating transaction to refund...');
    const transaction = new Transaction().add(
      createTransferInstruction(
        taxWalletATA,
        playerATA,
        taxWallet.publicKey,
        Math.round(amount * 1e6) // Converti in token base (COM usa 6 decimali)
      )
    );

    console.log('Getting latest blockhash...');
    let blockhash;
    try {
      const blockhashResult = await retry(() => connection.getLatestBlockhash());
      blockhash = blockhashResult.blockhash;
    } catch (err) {
      console.error('Failed to get latest blockhash:', err.message);
      return res.status(500).json({ success: false, error: `Failed to get latest blockhash: ${err.message}` });
    }
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = taxWallet.publicKey;
    transaction.partialSign(taxWallet);

    console.log('Sending refund transaction...');
    let signature;
    try {
      signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
      console.log('Refund transaction sent, signature:', signature);
    } catch (err) {
      console.error('Failed to send refund transaction:', err.message);
      return res.status(500).json({ success: false, error: `Failed to send refund transaction: ${err.message}` });
    }

    console.log('Confirming refund transaction:', signature);
    try {
      await retry(() => connection.confirmTransaction(signature));
      console.log(`Successfully refunded ${amount} COM to ${playerAddress}`);
    } catch (err) {
      console.error('Failed to confirm refund transaction:', err.message);
      return res.status(500).json({ success: false, error: `Failed to confirm refund transaction: ${err.message}` });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Unexpected error in /refund:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Unexpected error in /refund: ${err.message}` });
  }
});

// Endpoint per creare una transazione (usato da tutti i minigiochi escluso Poker PvP)
app.post('/create-transaction', async (req, res) => {
  const { playerAddress, betAmount, type } = req.body;

  console.log('DEBUG - /create-transaction called with:', { playerAddress, betAmount, type });

  // Validazione dei parametri
  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !type) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, betAmount, type });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress, betAmount, or type' });
  }

  try {
    // Validazione dell'indirizzo Solana
    let userPublicKey;
    try {
      userPublicKey = new PublicKey(playerAddress);
      console.log('DEBUG - Valid Solana address:', playerAddress);
    } catch (err) {
      console.log('DEBUG - Invalid Solana address:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid Solana address' });
    }

    const transaction = new Transaction();

    if (type === 'sol') {
      // Trasferimento SOL verso il tax wallet
      const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);
      console.log('DEBUG - Bet in lamports:', betInLamports);

      // Verifica il saldo dell'utente
      const userBalance = await connection.getBalance(userPublicKey);
      console.log('DEBUG - User balance:', userBalance / LAMPORTS_PER_SOL, 'SOL');
      if (userBalance < betInLamports) {
        console.log('DEBUG - Insufficient SOL balance:', userBalance / LAMPORTS_PER_SOL);
        return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
      }

      transaction.add(
        SystemProgram.transfer({
          fromPubkey: userPublicKey,
          toPubkey: wallet.publicKey, // Tax wallet
          lamports: betInLamports,
        })
      );
    } else {
      return res.status(400).json({ success: false, error: 'Invalid transaction type' });
    }

    // Ottieni il blockhash recente
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userPublicKey;

    // Log della transazione creata
    console.log('DEBUG - Transaction created:', {
      instructionCount: transaction.instructions.length,
      instructions: transaction.instructions.map((instr, index) => ({
        index,
        programId: instr.programId.toBase58(),
        keys: instr.keys.map(key => key.pubkey.toBase58()),
        data: instr.data.toString('hex'),
      })),
      recentBlockhash: transaction.recentBlockhash,
    });

    // Serializza la transazione
    const serializedTransaction = transaction.serialize({ requireAllSignatures: false }).toString('base64');

    res.json({ success: true, transaction: serializedTransaction });
  } catch (err) {
    console.error('Error in create-transaction:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to create transaction: ${err.message}` });
  }
});

// Endpoint per ottenere solo il recentBlockhash
app.post('/get-recent-blockhash', async (req, res) => {
  const { playerAddress } = req.body;

  console.log('DEBUG - /get-recent-blockhash called with:', { playerAddress });

  // Validazione dei parametri
  if (!playerAddress) {
    console.log('DEBUG - Invalid parameters:', { playerAddress });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress' });
  }

  try {
    // Validazione dell'indirizzo Solana
    let userPublicKey;
    try {
      userPublicKey = new PublicKey(playerAddress);
      console.log('DEBUG - Valid Solana address:', playerAddress);
    } catch (err) {
      console.log('DEBUG - Invalid Solana address:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid Solana address' });
    }

    // Ottieni il blockhash recente
    const { blockhash } = await connection.getLatestBlockhash();
    console.log('DEBUG - Recent blockhash:', blockhash);

    // Restituisci il blockhash
    res.json({
      success: true,
      recentBlockhash: blockhash,
    });
  } catch (err) {
    console.error('Error in get-recent-blockhash:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to get recent blockhash: ${err.message}` });
  }
});


// Nuovo endpoint per processare le transazioni di tutti i minigiochi (escluso Poker PvP)
app.post('/process-transaction', async (req, res) => {
  const { playerAddress, betAmount, signedTransaction, gameType } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction || !gameType) {
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  const validGameTypes = ['memeSlots', 'crazyWheel', 'solanaCardDuel', 'coinFlip'];
  if (!validGameTypes.includes(gameType)) {
    return res.status(400).json({ success: false, error: 'Invalid gameType' });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);

    const userBalance = await connection.getBalance(userPublicKey);
    if (userBalance < betInLamports) {
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    // Reindirizza la logica al gioco specifico
    const endpointMap = {
      memeSlots: '/play-meme-slots',
      coinFlip: '/play-coin-flip',
      crazyWheel: '/play-crazy-wheel',
      solanaCardDuel: '/play-solana-card-duel',
    };

    res.json({ success: true, redirectTo: endpointMap[gameType] });
  } catch (err) {
    console.error('Error in process-transaction:', err);
    res.status(500).json({ success: false, error: `Failed to process transaction: ${err.message}` });
  }
});

// Endpoint per distribuire vincite in SOL (usato per tutti i minigiochi escluso Poker PvP)
const retry = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`Retry attempt ${i + 1}/${retries} failed, retrying in ${delay}ms...`, err.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

app.post('/distribute-winnings', async (req, res) => {
  const { winnerAddress, amount } = req.body;

  console.log('Received request to /distribute-winnings:', { winnerAddress, amount });

  // Validazione dei parametri
  if (!winnerAddress || !amount || isNaN(amount) || amount <= 0) {
    console.log('Invalid parameters:', { winnerAddress, amount });
    return res.status(400).json({ success: false, error: 'Invalid winnerAddress or amount' });
  }

  let winnerPublicKey;
  try {
    console.log('Validating winnerAddress:', winnerAddress);
    winnerPublicKey = new PublicKey(winnerAddress);
  } catch (err) {
    console.error('Invalid winnerAddress:', err.message);
    return res.status(400).json({ success: false, error: `Invalid winnerAddress: ${err.message}` });
  }

  try {
    console.log('Tax wallet ATA (escrow):', taxWalletATA.toBase58());
    console.log('Getting winner ATA...');
    const winnerATA = await getAssociatedTokenAddress(MINT_ADDRESS, winnerPublicKey);
    console.log('Winner ATA:', winnerATA.toBase58());

    // Verifica il saldo SOL del tax wallet per le fee
    console.log('Checking tax wallet SOL balance...');
    const taxWalletSolBalance = await retry(() => connection.getBalance(taxWallet.publicKey));
    const minSolBalance = 0.01 * LAMPORTS_PER_SOL; // Minimo 0.01 SOL per le fee
    console.log('Tax wallet SOL balance:', taxWalletSolBalance / LAMPORTS_PER_SOL, 'SOL');
    if (taxWalletSolBalance < minSolBalance) {
      console.log('Insufficient SOL balance in tax wallet for fees:', {
        balance: taxWalletSolBalance / LAMPORTS_PER_SOL,
        required: minSolBalance / LAMPORTS_PER_SOL,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient SOL balance in tax wallet for transaction fees: ${taxWalletSolBalance / LAMPORTS_PER_SOL} SOL available, ${minSolBalance / LAMPORTS_PER_SOL} SOL required`,
      });
    }

    // Verifica lo stato del mint del token COM
    console.log('Checking token mint state...');
    const mintInfo = await connection.getParsedAccountInfo(MINT_ADDRESS);
    if (!mintInfo.value) {
      console.error('Failed to fetch token mint info for MINT_ADDRESS:', MINT_ADDRESS.toBase58());
      return res.status(500).json({ success: false, error: 'Failed to fetch token mint info' });
    }
    const mintData = mintInfo.value.data.parsed.info;
    console.log('Mint info:', mintData);
    if (mintData.isInitialized === false) {
      console.error('Token mint is not initialized:', MINT_ADDRESS.toBase58());
      return res.status(400).json({ success: false, error: 'Token mint is not initialized' });
    }
    if (mintData.freezeAuthority) {
      console.log('Token mint has freeze authority:', mintData.freezeAuthority);
      try {
        const taxWalletAccountInfo = await getAccount(connection, taxWalletATA);
        if (taxWalletAccountInfo.isFrozen) {
          console.error('Tax wallet ATA is frozen:', taxWalletATA.toBase58());
          return res.status(400).json({ success: false, error: 'Tax wallet ATA is frozen' });
        }
        const winnerAccountInfo = await getAccount(connection, winnerATA);
        if (winnerAccountInfo.isFrozen) {
          console.error('Winner ATA is frozen:', winnerATA.toBase58());
          return res.status(400).json({ success: false, error: 'Winner ATA is frozen' });
        }
      } catch (err) {
        console.error('Error checking ATA freeze status:', err.message);
        return res.status(400).json({ success: false, error: `Error checking ATA status: ${err.message}` });
      }
    }

    // Verifica il saldo COM del tax wallet
    console.log('Checking tax wallet COM balance...');
    let taxWalletBalance;
    try {
      taxWalletBalance = await retry(() => connection.getTokenAccountBalance(taxWalletATA));
    } catch (err) {
      console.error('Failed to fetch tax wallet COM balance:', err.message);
      return res.status(500).json({
        success: false,
        error: `Failed to fetch tax wallet COM balance: ${err.message}`,
      });
    }
    console.log('Tax wallet COM balance:', taxWalletBalance.value.uiAmount, 'COM');
    if (!taxWalletBalance || !taxWalletBalance.value || taxWalletBalance.value.uiAmount < amount) {
      const balance = taxWalletBalance?.value?.uiAmount || 0;
      console.error('Insufficient COM balance in tax wallet:', { balance, required: amount });
      return res.status(400).json({
        success: false,
        error: `Insufficient COM balance in tax wallet: ${balance} COM available, ${amount} COM required`,
      });
    }

    // Verifica se l'ATA del vincitore esiste, altrimenti crealo
    let winnerAccountExists = false;
    try {
      console.log('Checking if winner ATA exists...');
      await getAccount(connection, winnerATA);
      winnerAccountExists = true;
      console.log('Winner ATA exists:', winnerATA.toBase58());
    } catch (err) {
      console.log('Winner ATA does not exist, creating...');
      try {
        const transaction = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            taxWallet.publicKey, // Usa taxWallet come payer
            winnerATA,
            winnerPublicKey,
            MINT_ADDRESS
          )
        );
        const { blockhash } = await retry(() => connection.getLatestBlockhash());
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = taxWallet.publicKey;
        transaction.partialSign(taxWallet);
        const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
        await retry(() => connection.confirmTransaction(signature));
        console.log('Created winner ATA:', winnerATA.toBase58());
      } catch (err) {
        console.error('Failed to create winner ATA:', err.message);
        return res.status(500).json({ success: false, error: `Failed to create winner ATA: ${err.message}` });
      }
    }

    // Crea la transazione per trasferire il premio
    console.log('Creating transaction to transfer winnings...');
    const transaction = new Transaction().add(
      createTransferInstruction(
        taxWalletATA, // Da taxWalletATA
        winnerATA,
        taxWallet.publicKey,
        Math.round(amount * 1e6) // COM ha 6 decimali
      )
    );

    console.log('Getting latest blockhash...');
    const { blockhash } = await retry(() => connection.getLatestBlockhash());
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = taxWallet.publicKey;

    console.log('Estimating transaction fee...');
    let fee;
    try {
      fee = await transaction.getEstimatedFee(connection);
      console.log('Estimated transaction fee:', fee / LAMPORTS_PER_SOL, 'SOL');
    } catch (err) {
      console.error('Failed to estimate transaction fee:', err.message);
      return res.status(500).json({ success: false, error: `Failed to estimate transaction fee: ${err.message}` });
    }

    if (taxWalletSolBalance < fee) {
      console.error('Insufficient SOL balance in tax wallet for transaction fee:', {
        balance: taxWalletSolBalance / LAMPORTS_PER_SOL,
        required: fee / LAMPORTS_PER_SOL,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient SOL balance in tax wallet for transaction fee: ${taxWalletSolBalance / LAMPORTS_PER_SOL} SOL available, ${fee / LAMPORTS_PER_SOL} SOL required`,
      });
    }

    transaction.partialSign(taxWallet);

    console.log('Sending transaction to transfer winnings:', { winnerAddress, amount });
    let signature;
    try {
      signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
      console.log('Transaction sent, signature:', signature);
    } catch (err) {
      console.error('Failed to send transaction:', err.message);
      return res.status(500).json({ success: false, error: `Failed to send transaction: ${err.message}` });
    }

    console.log('Confirming transaction:', signature);
    try {
      await retry(() => connection.confirmTransaction(signature));
      console.log(`Successfully sent ${amount} COM to the winner ${winnerAddress}`);
    } catch (err) {
      console.error('Failed to confirm transaction:', err.message);
      return res.status(500).json({ success: false, error: `Failed to confirm transaction: ${err.message}` });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Unexpected error in /distribute-winnings:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Unexpected error: ${err.message}` });
  }
});

// Endpoint per unirsi a una partita di Poker PvP (invariato)
app.post('/join-poker-game', async (req, res) => {
  const { playerAddress, betAmount, signedTransaction } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction) {
    console.log('Invalid parameters:', { playerAddress, betAmount, signedTransaction });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress, betAmount, or signedTransaction' });
  }

  if (betAmount < MIN_BET) {
    console.log(`Bet ${betAmount} COM is below minimum ${MIN_BET} COM`);
    return res.status(400).json({ success: false, error: `Bet must be at least ${MIN_BET} COM` });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const userATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey);

    // Verifica se l'ATA del tax wallet esiste, altrimenti crealo
    let taxWalletAccountExists = false;
    try {
      await getAccount(connection, taxWalletATA);
      taxWalletAccountExists = true;
      console.log('Tax wallet ATA exists:', taxWalletATA.toBase58());
    } catch (err) {
      console.log('Tax wallet ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          taxWallet.publicKey,
          taxWalletATA,
          taxWallet.publicKey,
          MINT_ADDRESS
        )
      );
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = taxWallet.publicKey;
      transaction.partialSign(taxWallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('Created tax wallet ATA:', taxWalletATA.toBase58());
    }

    // Verifica il saldo COM dell'utente
    const userBalance = await connection.getTokenAccountBalance(userATA).catch(() => ({
      value: { uiAmount: 0 },
    }));
    if (userBalance.value.uiAmount < betAmount) {
      console.log(`Insufficient COM balance for ${playerAddress}: ${userBalance.value.uiAmount} < ${betAmount}`);
      return res.status(400).json({ success: false, error: 'Insufficient COM balance' });
    }

    // Valida e processa la transazione firmata
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      console.log('Invalid transaction signatures for:', playerAddress);
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    // Sostituisci casinoATA con taxWalletATA
    transaction.add(
      createTransferInstruction(
        userATA,
        taxWalletATA,
        userPublicKey,
        betAmount * 1e6
      )
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = taxWallet.publicKey; // Usa taxWallet come feePayer
    transaction.partialSign(taxWallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }
    console.log(`Transferred ${betAmount} COM from ${playerAddress} to tax wallet`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error in join-poker-game:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to join game: ' + err.message });
  }
});

// Endpoint per gestire le mosse in Poker PvP (invariato)
app.post('/make-poker-move', async (req, res) => {
  const { playerAddress, gameId, move, amount } = req.body;

  if (!playerAddress || !gameId || !move || amount === undefined || isNaN(amount) || amount < 0) {
    console.log('Invalid parameters:', { playerAddress, gameId, move, amount });
    return res.status(400).json({ success: false, error: 'Invalid required fields' });
  }

  try {
    const userPublicKey = new PublicKey(playerAddress);
    const userATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey);

    // Verifica se l'ATA del tax wallet esiste
    let taxWalletAccountExists = false;
    try {
      await getAccount(connection, taxWalletATA);
      taxWalletAccountExists = true;
      console.log('Tax wallet ATA exists:', taxWalletATA.toBase58());
    } catch (err) {
      console.log('Tax wallet ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          taxWallet.publicKey,
          taxWalletATA,
          taxWallet.publicKey,
          MINT_ADDRESS
        )
      );
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = taxWallet.publicKey;
      transaction.partialSign(taxWallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('Created tax wallet ATA:', taxWalletATA.toBase58());
    }

    // Verifica se l'ATA del giocatore esiste, altrimenti crealo
    let playerAccountExists = false;
    try {
      await getAccount(connection, userATA);
      playerAccountExists = true;
      console.log('Player ATA exists:', userATA.toBase58());
    } catch (err) {
      console.log('Player ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          taxWallet.publicKey, // Usa taxWallet come payer
          userATA,
          userPublicKey,
          MINT_ADDRESS
        )
      );
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = taxWallet.publicKey;
      transaction.partialSign(taxWallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('Created player ATA:', userATA.toBase58());
    }

    if (amount > 0) {
      const userBalance = await connection.getTokenAccountBalance(userATA);
      if (userBalance.value.uiAmount < amount) {
        console.log(`Insufficient COM balance for ${playerAddress}: ${userBalance.value.uiAmount} < ${amount}`);
        return res.status(400).json({ success: false, error: 'Insufficient COM balance' });
      }

      const transaction = new Transaction().add(
        createTransferInstruction(
          userATA,
          taxWalletATA, // Usa taxWalletATA come destinazione
          userPublicKey,
          amount * 1e6 // COM ha 6 decimali
        )
      );

      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = taxWallet.publicKey; // Usa taxWallet come feePayer
      transaction.partialSign(taxWallet);

      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log(`Transferred ${amount} COM from ${playerAddress} to tax wallet for move ${move}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error in make-poker-move:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to process move: ${err.message}` });
  }
});

// Endpoint per la leaderboard (invariato)
app.get('/leaderboard', async (req, res) => {
  console.log('Received request for /leaderboard');
  try {
    console.log('Fetching leaderboard...');
    const leaderboard = await Player.find()
      .sort({ totalWinnings: -1 })
      .limit(10)
      .maxTimeMS(5000);
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

// Gestione delle connessioni WebSocket per Poker PvP (invariato)
io.on('connection', (socket) => {
  console.log('A player connected:', socket.id, 'from origin:', socket.handshake.headers.origin);

  socket.on('joinGame', async ({ playerAddress, betAmount }, callback) => {
    console.log(`Player ${playerAddress} attempting to join with bet ${betAmount} COM, socket.id: ${socket.id}`);

    // Validazione dei parametri
    if (!playerAddress || !betAmount || isNaN(betAmount)) {
      const errorMsg = 'Invalid playerAddress or betAmount';
      console.log(`Join rejected: ${errorMsg}`);
      socket.emit('error', { message: errorMsg });
      if (callback) callback({ success: false, error: errorMsg });
      return;
    }

    const minBet = MIN_BET;
    if (betAmount < minBet) {
      const errorMsg = `Bet must be at least ${minBet.toFixed(2)} COM`;
      socket.emit('error', { message: errorMsg });
      console.log(`Bet ${betAmount} COM rejected: below minimum ${minBet} COM`);
      if (callback) callback({ success: false, error: errorMsg });
      return;
    }
    if (betAmount <= 0) {
      const errorMsg = 'Bet amount must be positive';
      socket.emit('error', { message: errorMsg });
      console.log(`Bet ${betAmount} COM rejected: non-positive`);
      if (callback) callback({ success: false, error: errorMsg });
      return;
    }

    // Verifica se il giocatore è già nella lista
    const existingPlayerIndex = waitingPlayers.findIndex(p => p.address === playerAddress);
    if (existingPlayerIndex !== -1) {
      waitingPlayers[existingPlayerIndex].id = socket.id;
      waitingPlayers[existingPlayerIndex].bet = betAmount;
      console.log(`Updated player ${playerAddress} in waiting list: socket.id=${socket.id}, bet=${betAmount}`);
    } else {
      waitingPlayers.push({ id: socket.id, address: playerAddress, bet: betAmount });
      console.log(`Added player ${playerAddress} to waiting list with bet ${betAmount} COM`);
    }

    // Log dello stato attuale della waiting list
    console.log('Current waitingPlayers:', waitingPlayers.map(p => ({ address: p.address, bet: p.bet, socketId: p.id })));

    // Emetti evento waiting al giocatore
    socket.emit('waiting', { 
      message: 'You have joined the game! Waiting for another player...', 
      players: waitingPlayers 
    });
    // Emetti evento waitingPlayers a tutti i client
    io.emit('waitingPlayers', { 
      players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) 
    });

    // Rispondi al client con un acknowledgment
    if (callback) {
      callback({ success: true, message: 'Joined waiting list successfully' });
    }

    // Avvia una partita se ci sono almeno 2 giocatori
    if (waitingPlayers.length >= 2) {
      console.log(`Enough players (${waitingPlayers.length}), starting game...`);
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
        if (callback) callback({ success: false, error: 'Error starting game' });
        return;
      }

      players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.join(gameId);
          console.log(`Player ${player.address} joined room ${gameId}`);
        } else {
          console.error(`Socket for player ${player.address} not found`);
        }
      });

      // Aggiorna la lista d'attesa per tutti i client
      io.emit('waitingPlayers', { 
        players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet })) 
      });
      console.log(`Game ${gameId} started with players:`, players.map(p => p.address));

      startGame(gameId);
    }
  });

  socket.on('leaveWaitingList', ({ playerAddress }) => {
    const playerIndex = waitingPlayers.findIndex(p => p.address === playerAddress && p.id === socket.id);
    if (playerIndex !== -1) {
      const player = waitingPlayers[playerIndex];
      waitingPlayers.splice(playerIndex, 1);
      console.log(`Player ${playerAddress} left the waiting list`);
  
      // Emetti l'evento refund con un flag isRefund per indicare che non è una vincita
      socket.emit('refund', {
        message: 'You left the waiting list. Your bet has been refunded.',
        amount: player.bet,
        isRefund: true, // Aggiunto flag
      });
  
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
      console.log(`Invalid move: gameId=${gameId}, currentTurn=${game.currentTurn}, socket.id=${socket.id}`);
      return;
    }
  
    if (game.turnTimer) {
      clearInterval(game.turnTimer);
    }
    game.timeLeft = 30;
  
    const playerAddress = game.players.find(p => p.id === socket.id)?.address;
    const opponent = game.players.find(p => p.id !== socket.id);
    if (!playerAddress || !opponent) {
      console.log(`Player or opponent not found: playerAddress=${playerAddress}, opponent=${opponent}`);
      await refundBetsForGame(gameId);
      return;
    }
    const currentPlayerBet = game.playerBets[playerAddress] || 0;
    console.log(`Processing move: ${move}, gameId=${gameId}, playerAddress=${playerAddress}, currentBet=${game.currentBet}, currentPlayerBet=${currentPlayerBet}`);
  
    if (move === 'fold') {
      game.status = 'finished';
      game.opponentCardsVisible = true;
      game.message = `${opponent.address.slice(0, 8)}... wins! ${playerAddress.slice(0, 8)}... folded.`;
      game.dealerMessage = 'The dealer announces the winner!';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      io.to(gameId).emit('distributeWinnings', { winnerAddress: opponent.address, amount: game.pot, isRefund: false });
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
        console.log(`Check not allowed: currentBet=${game.currentBet}, currentPlayerBet=${currentPlayerBet}`);
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      } else {
        game.message = 'You checked.';
        game.dealerMessage = `The dealer says: ${playerAddress.slice(0, 8)}... checked.`;
        console.log(`Check successful: currentBet=${game.currentBet}, currentPlayerBet=${currentPlayerBet}`);
        if (game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
          game.bettingRoundComplete = true;
          console.log(`Betting round complete, advancing game phase`);
          advanceGamePhase(gameId);
        } else {
          game.currentTurn = opponent.id;
          console.log(`Passing turn to opponent: ${opponent.id}`);
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
      console.log(`Call successful: amountToCall=${amountToCall}, new pot=${game.pot}`);
      game.currentTurn = opponent.id;
      if (game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
        game.bettingRoundComplete = true;
        console.log(`Betting round complete, advancing game phase`);
        advanceGamePhase(gameId);
      } else {
        console.log(`Passing turn to opponent: ${opponent.id}`);
        startTurnTimer(gameId, opponent.id);
      }
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
        console.log(`Invalid ${move}: newBet=${newBet}, currentBet=${game.currentBet}, minBet=${minBet}`);
        io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
        return;
      }
      const additionalBet = newBet - currentPlayerBet;
      game.pot += additionalBet;
      game.playerBets[playerAddress] = newBet;
      game.currentBet = newBet;
      game.message = `You ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} COM.`;
      game.dealerMessage = `The dealer announces: ${playerAddress.slice(0, 8)}... ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} COM.`;
      console.log(`${move} successful: additionalBet=${additionalBet}, new pot=${game.pot}, new currentBet=${game.currentBet}`);
      game.currentTurn = opponent.id;
      game.bettingRoundComplete = false;
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
  console.log(`Starting game ${gameId} with players:`, game.players.map(p => ({ address: p.address, socketId: p.id })));

  game.message = 'The dealer is dealing the cards...';
  game.dealerMessage = 'The dealer is dealing the cards to the players.';
  io.to(gameId).emit('gameState', removeCircularReferences(game));

  try {
    await Game.updateOne({ gameId }, { status: 'playing' });
    console.log(`Updated game ${gameId} status to playing`);
  } catch (err) {
    console.error(`Error updating game ${gameId} status:`, err.message, err.stack);
    await refundBetsForGame(gameId);
    return;
  }

  try {
    const player1Cards = [drawCard(), drawCard()];
    const player2Cards = [drawCard(), drawCard()];
    console.log(`Player 1 cards:`, player1Cards);
    console.log(`Player 2 cards:`, player2Cards);

    if (!player1Cards.every(card => card && card.value && card.suit && card.image) || 
        !player2Cards.every(card => card && card.value && card.suit && card.image)) {
      throw new Error('Invalid cards drawn');
    }

    game.playerCards[game.players[0].address] = player1Cards;
    game.playerCards[game.players[1].address] = player2Cards;

    // Verifica che i socket dei giocatori siano ancora connessi
    const player1Socket = io.sockets.sockets.get(game.players[0].id);
    const player2Socket = io.sockets.sockets.get(game.players[1].id);
    if (!player1Socket || !player2Socket) {
      throw new Error('One or more players disconnected before game start');
    }

    game.currentTurn = game.players[0].id;
    game.pot = game.players[0].bet + game.players[1].bet;
    game.playerBets[game.players[0].address] = 0; // Inizializza a 0 per il round corrente
    game.playerBets[game.players[1].address] = 0; // Inizializza a 0 per il round corrente
    game.currentBet = 0; // Inizializza a 0, le scommesse iniziali sono già nel pot
    game.status = 'playing';
    game.message = 'Pre-Flop: Place your bets.';
    game.dealerMessage = `The dealer says: Cards dealt! ${game.players[0].address.slice(0, 8)}... starts the betting.`;

    console.log(`Game ${gameId} started. Current turn assigned to: ${game.currentTurn}`);
    console.log(`Player 0 socket.id: ${game.players[0].id}, Player 1 socket.id: ${game.players[1].id}`);
    console.log(`Initial game state:`, {
      pot: game.pot,
      playerBets: game.playerBets,
      currentBet: game.currentBet,
    });

    // Avvia il timer del turno
    startTurnTimer(gameId, game.players[0].id);
    io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
  } catch (err) {
    console.error(`Error in startGame ${gameId}:`, err.message, err.stack);
    game.message = 'Error starting game. Refunding bets...';
    io.to(gameId).emit('gameState', removeCircularReferences(game));
    await refundBetsForGame(gameId);
  }
};

const drawCard = () => {
  const cardNumber = Math.floor(Math.random() * 13) + 1;
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const suitChars = ['S', 'H', 'D', 'C'];
  const suitIndex = Math.floor(Math.random() * 4);
  const suit = suits[suitIndex];
  const suitChar = suitChars[suitIndex];
  let cardName;
  if (cardNumber === 1) cardName = 'A';
  else if (cardNumber === 10) cardName = '0';
  else if (cardNumber === 11) cardName = 'J';
  else if (cardNumber === 12) cardName = 'Q';
  else if (cardNumber === 13) cardName = 'K';
  else cardName = cardNumber.toString();
  
  const value = cardNumber === 1 ? 14 : cardNumber;
  const image = `https://deckofcardsapi.com/static/img/${cardName}${suitChar}.png`;
  
  console.log(`Drawn card: ${cardName}${suitChar} (Value: ${value}, Suit: ${suit})`);
  return { value, suit, image };
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
    console.log(`Splitting pot: ${game.pot} COM, each player gets ${splitAmount} COM`);
    io.to(gameId).emit('distributeWinnings', {
      winnerAddress: player1.address,
      amount: splitAmount,
      isRefund: false,
    });
    io.to(gameId).emit('distributeWinnings', {
      winnerAddress: player2.address,
      amount: splitAmount,
      isRefund: false,
    });
    await updateLeaderboard(player1.address, splitAmount);
    await updateLeaderboard(player2.address, splitAmount);
  } else {
    console.log(`Winner: ${winner.address}, winning ${game.pot} COM`);
    io.to(gameId).emit('distributeWinnings', {
      winnerAddress: winner.address,
      amount: game.pot,
      isRefund: false,
    });
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
    const leaderboard = await Player.find()
      .sort({ totalWinnings: -1 })
      .limit(10)
      .maxTimeMS(5000);
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

// Gestione delle promesse non gestite
process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
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
console.log(`PORT environment variable: ${process.env.PORT}`);
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
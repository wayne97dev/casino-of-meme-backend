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
const { client: redisClient, connectRedis } = require('./config/redis'); // Importa il modulo Redis

const gameStates = {}; // Memorizza lo stato dei giochi per Solana Card Duel

const app = express();
const server = http.createServer(app);

// Definizione degli origin consentiti
const allowedOrigins = [
  'https://casino-of-meme.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'https://testdashb.vercel.app',
  'https://casino-of-meme-1tqvl2m34-santes-projects-c6c8cd0c.vercel.app', // Aggiungi questa riga
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
app.use((req, res, next) => {
  console.log('DEBUG - Setting CORS headers for:', req.url, 'Origin:', req.headers.origin);
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      console.log(`DEBUG - Handling OPTIONS request for ${req.url}`);
      return res.sendStatus(204);
    }
    next();
  } else {
    console.log(`DEBUG - CORS blocked - Origin: ${origin} not in allowedOrigins: ${allowedOrigins}`);
    res.status(403).send('Origin not allowed by CORS');
  }
});



app.use(cors({
  origin: (origin, callback) => {
    console.log(`DEBUG - CORS check - Origin received: ${origin}`);
    // Consenti richieste senza origine (es. richieste locali o non browser)
    if (!origin) {
      console.log(`DEBUG - CORS allowed - No origin (local request)`);
      return callback(null, true);
    }
    // Consenti origini nella lista allowedOrigins
    if (allowedOrigins.includes(origin)) {
      console.log(`DEBUG - CORS allowed - Origin: ${origin} in allowedOrigins`);
      return callback(null, true);
    }
    // Consenti dinamicamente tutti i domini Vercel
    if (origin.endsWith('.vercel.app')) {
      console.log(`DEBUG - CORS allowed - Vercel domain: ${origin}`);
      return callback(null, true);
    }
    // Blocca origini non consentite
    console.log(`DEBUG - CORS blocked - Origin: ${origin} not allowed`);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));

// Gestore esplicito per richieste OPTIONS
app.options('*', (req, res) => {
  console.log(`DEBUG - Handling OPTIONS request from origin: ${req.headers.origin}`);
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(204);
});

// Middleware per parsing JSON
app.use(express.json());

// Gestore errori globale
app.use((err, req, res, next) => {
  console.error('DEBUG - Global error handler:', err.message, err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

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
  serverSelectionTimeoutMS: 100000,
  connectTimeoutMS: 60000,
  socketTimeoutMS: 60000,
  maxPoolSize: 20,
  retryWrites: true,
})
  .then(() => console.log('DEBUG - Connected to MongoDB'))
  .catch(err => {
    console.error('DEBUG - MongoDB connection error:', err.message, err.stack);
    process.exit(1);
  });

// Connessione a Redis
connectRedis().catch(err => {
  console.error('DEBUG - Could not connect to Redis:', err.message);
});


const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Connessione a Solana
const primaryConnection = new Connection('https://mainnet.helius-rpc.com/?api-key=40b694c8-8e12-455f-8df5-38661891b200', 'confirmed');
const fallbackConnection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const quickNodeConnection = new Connection('https://indulgent-frequent-shadow.solana-mainnet.quiknode.pro/4d91f8d7189fdb1c241d6b49f024fe351e98f9dd/', 'confirmed');

async function getConnection() {
  // Prova la connessione primaria (Helius)
  try {
    await primaryConnection.getSlot();
    console.log('DEBUG - Using primary RPC (Helius)');
    return primaryConnection;
  } catch (err) {
    console.warn('DEBUG - Primary RPC (Helius) failed:', err.message);
    
    // Prova il primo fallback (Solana pubblico)
    try {
      await fallbackConnection.getSlot();
      console.log('DEBUG - Using fallback RPC (Solana public)');
      return fallbackConnection;
    } catch (err) {
      console.warn('DEBUG - Fallback RPC (Solana public) failed:', err.message);
      
      // Prova il secondo fallback (QuickNode)
      try {
        await quickNodeConnection.getSlot();
        console.log('DEBUG - Using QuickNode RPC');
        return quickNodeConnection;
      } catch (err) {
        console.error('DEBUG - QuickNode RPC failed:', err.message);
        throw new Error('All RPC connections failed');
      }
    }
  }
}

// Carica la private key in formato base58
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
  console.error('ERROR - WALLET_PRIVATE_KEY is missing in environment variables');
  process.exit(1);
}
console.log('DEBUG - WALLET_PRIVATE_KEY:', WALLET_PRIVATE_KEY ? 'Present' : 'Missing');

// Crea il wallet dal backend
let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
} catch (err) {
  console.error('ERROR - Invalid WALLET_PRIVATE_KEY:', err.message);
  process.exit(1);
}

// Stato del gioco
const games = {};
const waitingPlayers = [];
let visitorCount = 0;

// Indirizzo del mint COM
const COM_MINT_ADDRESS = 'H3m8rUk46TCTFd6nbieKLPDM3MqEoP7Uz8nheHduLjcY';
console.log('DEBUG - COM_MINT_ADDRESS:', COM_MINT_ADDRESS);
const MINT_ADDRESS = new PublicKey(COM_MINT_ADDRESS);

// Scommessa minima in COM per Poker PvP
const MIN_BET = 1000;

// Funzioni di caching per Solana
async function getCachedBlockhash(connection) {
  const cacheKey = 'latestBlockhash';
  try {
    const cachedBlockhash = await redisClient.get(cacheKey);
    if (cachedBlockhash) {
      console.log('DEBUG - Using cached blockhash');
      return JSON.parse(cachedBlockhash);
    }
  } catch (err) {
    console.warn('DEBUG - Redis error fetching blockhash:', err.message);
  }

  try {
    const { blockhash } = await connection.getLatestBlockhash();
    await redisClient.setEx(cacheKey, 10, JSON.stringify({ blockhash }));
    console.log('DEBUG - Fetched and cached new blockhash:', blockhash);
    return { blockhash };
  } catch (err) {
    console.error('DEBUG - Error fetching blockhash from Solana:', err.message);
    throw err;
  }
}

async function getCachedBalance(connection, publicKey, type = 'sol', forceRefresh = false) {
  const cacheKey = `balance:${publicKey.toBase58()}:${type}`;
  if (!forceRefresh) {
    try {
      const cachedBalance = await redisClient.get(cacheKey);
      if (cachedBalance) {
        const balance = parseFloat(cachedBalance);
        if (balance >= 0 && !isNaN(balance)) {
          console.log(`DEBUG - Using cached ${type} balance for ${publicKey.toBase58()}: ${balance}`);
          return balance;
        }
        console.log('DEBUG - Invalid cached balance, forcing refresh');
      }
    } catch (err) {
      console.warn('DEBUG - Redis error fetching balance:', err.message);
    }
  }

  try {
    let balance;
    if (type === 'sol') {
      balance = await connection.getBalance(publicKey) / LAMPORTS_PER_SOL;
      console.log(`DEBUG - Successfully fetched SOL balance for ${publicKey.toBase58()}: ${balance}`);
    } else if (type === 'com') {
      console.log(`DEBUG - Verifying mint: ${MINT_ADDRESS.toBase58()}`);
      try {
        const { getMint } = require('@solana/spl-token');
        const mintInfo = await getMint(connection, MINT_ADDRESS, TOKEN_2022_PROGRAM_ID);
        console.log(`DEBUG - Mint verified: decimals=${mintInfo.decimals}, supply=${mintInfo.supply}`);
        if (mintInfo.decimals !== 6) {
          console.warn(`DEBUG - Unexpected mint decimals: expected 6, found ${mintInfo.decimals}`);
          return 0;
        }
      } catch (err) {
        console.error(`DEBUG - Failed to verify mint ${MINT_ADDRESS.toBase58()}:`, err.message, err.stack);
        return 0;
      }

      console.log(`DEBUG - Calculating ATA for mint: ${MINT_ADDRESS.toBase58()}, player: ${publicKey.toBase58()}`);
      const userATA = await getAssociatedTokenAddress(MINT_ADDRESS, publicKey, false, TOKEN_2022_PROGRAM_ID);
      console.log(`DEBUG - ATA: ${userATA.toBase58()}`);
      try {
        const account = await getAccount(connection, userATA, TOKEN_2022_PROGRAM_ID);
        console.log(`DEBUG - ATA exists for ${publicKey.toBase58()}: ${userATA.toBase58()}`);
        const balanceInfo = await connection.getTokenAccountBalance(userATA);
        balance = balanceInfo.value.uiAmount || 0;
        console.log(`DEBUG - Successfully fetched COM balance for ${publicKey.toBase58()}: ${balance}`);
      } catch (err) {
        console.error(`DEBUG - Error fetching ATA for ${publicKey.toBase58()}:`, err.message, err.stack);
        if (err.name === 'TokenAccountNotFoundError' || err.name === 'TokenInvalidAccountOwnerError') {
          console.log(`DEBUG - ATA not found for ${publicKey.toBase58()}`);
          balance = 0;
        } else {
          throw err;
        }
      }
    }
    try {
      await redisClient.setEx(cacheKey, 30, balance.toString());
      console.log(`DEBUG - Cached ${type} balance for ${publicKey.toBase58()}: ${balance}`);
    } catch (err) {
      console.warn('DEBUG - Failed to cache balance:', err.message);
    }
    return balance;
  } catch (err) {
    console.error(`DEBUG - Error fetching ${type} balance from Solana:`, err.message, err.stack);
    return 0;
  }
}

async function getCachedMintInfo(connection, mintAddress) {
  const cacheKey = `mint:${mintAddress.toBase58()}`;
  try {
    const cachedMintInfo = await redisClient.get(cacheKey);
    if (cachedMintInfo) {
      console.log('DEBUG - Using cached mint info');
      return JSON.parse(cachedMintInfo);
    }
  } catch (err) {
    console.warn('DEBUG - Redis error fetching mint info:', err.message);
  }

  try {
    const { getMint } = require('@solana/spl-token');
    const mintInfo = await getMint(connection, mintAddress, TOKEN_2022_PROGRAM_ID);
    const mintData = {
      decimals: mintInfo.decimals,
      supply: mintInfo.supply.toString(),
    };
    await redisClient.setEx(cacheKey, 24 * 60 * 60, JSON.stringify(mintData));
    console.log('DEBUG - Fetched and cached mint info:', mintData);
    return mintData;
  } catch (err) {
    console.error('DEBUG - Error fetching mint info from Solana:', err.message, err.stack);
    return { decimals: 6, supply: '0' }; // Ritorna valori predefiniti in caso di errore
  }
}

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
  solanaCardDuel: 0.97,
  memeSlots: 0.90,
  coinFlip: 0.6,
  crazyWheel: 0.99,
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
  console.log('DEBUG - /play-meme-slots called:', req.body);
  const { playerAddress, betAmount, signedTransaction } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, betAmount, signedTransaction });
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);
    console.log('DEBUG - Bet details:', { betAmount, betInLamports });

    const connection = await getConnection();
    console.log('DEBUG - Checking user SOL balance...');
    const userBalance = await getCachedBalance(connection, userPublicKey, 'sol');
    console.log('DEBUG - User balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
    if (userBalance * LAMPORTS_PER_SOL < betInLamports) {
      console.log('DEBUG - Insufficient SOL balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    console.log('DEBUG - Processing signed transaction...');
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      console.log('DEBUG - Invalid transaction signatures');
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming transaction:', signature);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('DEBUG - Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    let result;
    const winLines = [
      [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
      [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
      [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
    ];

    if (Math.random() < COMPUTER_WIN_CHANCE.memeSlots) {
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

    if (totalWin > 0) {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userPublicKey,
          lamports: Math.round(totalWin * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);

      const winSignature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(winSignature);
      console.log(`DEBUG - Distributed ${totalWin} SOL to ${playerAddress}`);
    }

    res.json({
      success: true,
      result: result.map(item => ({ name: item.name, image: item.image })),
      winningLines: winningLinesFound,
      winningIndices: Array.from(winningIndices),
      totalWin,
    });
  } catch (err) {
    console.error('DEBUG - Error in play-meme-slots:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to play meme slots' });
  }
});

// Endpoint per Coin Flip
app.post('/play-coin-flip', async (req, res) => {
  console.log('DEBUG - /play-coin-flip called:', req.body);
  const { playerAddress, betAmount, signedTransaction, choice } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction || !choice || !['blue', 'red'].includes(choice)) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, betAmount, signedTransaction, choice });
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);
    console.log('DEBUG - Bet details:', { betAmount, betInLamports });

    const connection = await getConnection();
    console.log('DEBUG - Checking user SOL balance...');
    const userBalance = await getCachedBalance(connection, userPublicKey, 'sol', req.body.forceRefresh || false);
    console.log('DEBUG - User balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
    if (userBalance * LAMPORTS_PER_SOL < betInLamports) {
      console.log('DEBUG - Insufficient SOL balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    console.log('DEBUG - Processing signed transaction...');
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      console.log('DEBUG - Invalid transaction signatures:', transaction.signatures);
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming transaction:', signature);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('DEBUG - Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    let flipResult;
    if (Math.random() < COMPUTER_WIN_CHANCE.coinFlip) {
      flipResult = choice === 'blue' ? 'red' : 'blue';
    } else {
      flipResult = choice;
    }

    let totalWin = 0;
    if (choice === flipResult) {
      totalWin = betAmount * 2;

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userPublicKey,
          lamports: Math.round(totalWin * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);

      const winSignature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(winSignature);
      console.log(`DEBUG - Distributed ${totalWin} SOL to ${playerAddress}`);
    }

    res.json({
      success: true,
      flipResult,
      totalWin,
    });
  } catch (err) {
    console.error('DEBUG - Error in play-coin-flip:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to play coin flip' });
  }
});

app.get('/get-crazy-wheel', (req, res) => {
  console.log('DEBUG - /get-crazy-wheel called');
  try {
    console.log('DEBUG - Fetching crazyTimeWheel for frontend');
    res.json({ success: true, wheel: crazyTimeWheel });
  } catch (err) {
    console.error('DEBUG - Error fetching crazyTimeWheel:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to fetch wheel data' });
  }
});

// Endpoint per Crazy Wheel
// Endpoint per Crazy Wheel
app.post('/play-crazy-wheel', async (req, res) => {
  console.log('DEBUG - /play-crazy-wheel called:', req.body);
  const { playerAddress, bets, signedTransaction } = req.body;

  if (!playerAddress || !bets || !signedTransaction) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, bets, signedTransaction });
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  const totalBet = Object.values(bets).reduce((sum, bet) => sum + bet, 0);
  if (totalBet <= 0) {
    console.log('DEBUG - No bets placed:', { bets });
    return res.status(400).json({ success: false, error: 'No bets placed' });
  }

  const validSegments = ['1', '2', '5', '10', 'Coin Flip', 'Pachinko', 'Cash Hunt', 'Crazy Time'];
  for (const segment in bets) {
    if (!validSegments.includes(segment) || isNaN(bets[segment]) || bets[segment] < 0) {
      console.log('DEBUG - Invalid bet segment or amount:', { segment, amount: bets[segment] });
      return res.status(400).json({ success: false, error: 'Invalid bet segment or amount' });
    }
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(totalBet * LAMPORTS_PER_SOL);
    console.log('DEBUG - Bet details:', { totalBet, betInLamports });

    const connection = await getConnection();
    console.log('DEBUG - Checking user SOL balance...');
    const userBalance = await getCachedBalance(connection, userPublicKey, 'sol', req.body.forceRefresh || false);
    console.log('DEBUG - User balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
    if (userBalance * LAMPORTS_PER_SOL < betInLamports) {
      console.log('DEBUG - Insufficient SOL balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    console.log('DEBUG - Processing signed transaction...');
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      console.log('DEBUG - Invalid transaction signatures:', transaction.signatures);
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming transaction:', signature);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('DEBUG - Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    // Logica per selezionare il risultato della ruota con probabilità pesata
    const segmentWeights = {
      '1': 0.80, // 80% di probabilità per il segmento 1
      '2': 0.05, // 5% per il segmento 2
      '5': 0.04, // 4% per il segmento 5
      '10': 0.03, // 3% per il segmento 10
      'Coin Flip': 0.03, // 3% per Coin Flip
      'Pachinko': 0.02, // 2% per Pachinko
      'Cash Hunt': 0.02, // 2% per Cash Hunt
      'Crazy Time': 0.01, // 1% per Crazy Time
    };

    // Selezione pesata del risultato
    const randomValue = Math.random();
    let cumulativeProbability = 0;
    let selectedSegment = null;
    for (const segment in segmentWeights) {
      cumulativeProbability += segmentWeights[segment];
      if (randomValue <= cumulativeProbability) {
        selectedSegment = segment;
        break;
      }
    }

    // Trova il segmento corrispondente nella ruota per il frontend
    const resultSegment = crazyTimeWheel.find(
      (s) => s.value.toString() === selectedSegment || s.value === selectedSegment
    ) || crazyTimeWheel[0]; // Fallback al primo segmento se qualcosa va storto
    console.log('DEBUG - Selected segment:', resultSegment);

    // Calcolo delle vincite
    let totalWin = 0;
    if (bets[selectedSegment]) {
      const betAmount = bets[selectedSegment];
      let multiplier = 1;
      if (selectedSegment === '1') multiplier = 1;
      else if (selectedSegment === '2') multiplier = 2;
      else if (selectedSegment === '5') multiplier = 5;
      else if (selectedSegment === '10') multiplier = 10;
      else if (['Coin Flip', 'Pachinko', 'Cash Hunt', 'Crazy Time'].includes(selectedSegment)) {
        multiplier = 10; // Imposta un moltiplicatore di default per i bonus
      }
      totalWin = betAmount * multiplier;
      console.log(`DEBUG - Win calculated: bet=${betAmount}, multiplier=${multiplier}, totalWin=${totalWin}`);
    }

    // Distribuzione delle vincite in SOL
    if (totalWin > 0) {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userPublicKey,
          lamports: Math.round(totalWin * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);

      const winSignature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(winSignature);
      console.log(`DEBUG - Distributed ${totalWin} SOL to ${playerAddress}`);
    }

    res.json({
      success: true,
      result: resultSegment,
      totalWin,
    });
  } catch (err) {
    console.error('DEBUG - Error in play-crazy-wheel:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to process transaction' });
  }
});

// Endpoint aggiornato per Solana Card Duel
app.post('/play-solana-card-duel', async (req, res) => {
  console.log('DEBUG - /play-solana-card-duel called:', req.body);
  const { playerAddress, betAmount, signedTransaction, action } = req.body;

  if (!playerAddress || !action) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, action });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress or action' });
  }

  if (action !== 'start') {
    return res.json({ success: true });
  }

  if (!betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction) {
    console.log('DEBUG - Invalid bet parameters:', { betAmount, signedTransaction });
    return res.status(400).json({ success: false, error: 'Invalid betAmount or signedTransaction' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);
    console.log('DEBUG - Bet details:', { betAmount, betInLamports });

    const connection = await getConnection();
    console.log('DEBUG - Checking user SOL balance...');
    const userBalance = await getCachedBalance(connection, userPublicKey, 'sol', req.body.forceRefresh || false);
    console.log('DEBUG - User balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
    if (userBalance * LAMPORTS_PER_SOL < betInLamports) {
      console.log('DEBUG - Insufficient SOL balance:', { userBalance, required: betInLamports / LAMPORTS_PER_SOL });
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    console.log('DEBUG - Processing signed transaction...');
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);
    if (!transaction.verifySignatures()) {
      console.log('DEBUG - Invalid transaction signatures:', transaction.signatures);
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming transaction:', signature);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('DEBUG - Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    res.json({
      success: true,
      message: 'Bet placed successfully',
    });
  } catch (err) {
    console.error('DEBUG - Error in play-solana-card-duel:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to play solana card duel: ${err.message}` });
  }
});

// Funzione di rimborso per una partita
const refundBetsForGame = async (gameId) => {
  console.log('DEBUG - Refunding bets for game:', gameId);
  try {
    const game = await Game.findOne({ gameId });
    if (!game || game.status === 'finished') {
      console.log(`DEBUG - No active game ${gameId} to refund or already finished`);
      return;
    }

    console.log(`DEBUG - Refunding bets for game ${gameId}, players:`, game.players);
    for (const player of game.players) {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        console.log(`DEBUG - Emitting refund event to player ${player.address}, amount: ${player.bet}`);
        playerSocket.emit('refund', {
          message: 'Game crashed or interrupted. Your bet has been refunded.',
          amount: player.bet,
          isRefund: true,
        });
        console.log(`DEBUG - Refunded ${player.bet} COM to ${player.address} for game ${gameId}`);
      } else {
        console.log(`DEBUG - Player ${player.address} socket not found, skipping refund emission`);
      }
    }

    await Game.deleteOne({ gameId });
    console.log(`DEBUG - Deleted game ${gameId} from database`);

    if (games[gameId]) {
      delete games[gameId];
      console.log(`DEBUG - Removed game ${gameId} from games object`);
    }
  } catch (err) {
    console.error(`DEBUG - Error refunding bets for game ${gameId}:`, err.message, err.stack);
  }
};

// Funzione per rimborsare tutte le partite attive
const refundAllActiveGames = async () => {
  console.log('DEBUG - Refunding all active games');
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
          console.log(`DEBUG - Refunded ${player.bet} COM to ${player.address} for game ${game.gameId}`);
        }
      }
      await Game.deleteOne({ gameId: game.gameId });
      console.log(`DEBUG - Deleted game ${game.gameId} after refund`);
    }
  } catch (err) {
    console.error('DEBUG - Error refunding active games:', err.message, err.stack);
  }
};

// Endpoint per il saldo del tax wallet
app.get('/tax-wallet-balance', async (req, res) => {
  console.log('DEBUG - /tax-wallet-balance called');
  try {
    console.log('DEBUG - Fetching tax wallet balance for:', wallet.publicKey.toBase58());
    const connection = await getConnection();
    const balance = await getCachedBalance(connection, wallet.publicKey, 'sol');
    console.log('DEBUG - Balance fetched:', balance);
    res.json({ success: true, balance });
  } catch (err) {
    console.error('DEBUG - Error fetching tax wallet balance:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to fetch tax wallet balance' });
  }
});

// Endpoint per le ricompense
app.get('/rewards', async (req, res) => {
  console.log('DEBUG - /rewards called');
  try {
    const connection = await getConnection();
    const balance = await getCachedBalance(connection, wallet.publicKey, 'sol');
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
    console.error('DEBUG - Error fetching rewards:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// Endpoint per il saldo COM
app.get('/com-balance/:playerAddress', async (req, res) => {
  console.log('DEBUG - /com-balance called:', req.params);
  const { playerAddress } = req.params;
  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    let userPublicKey;
    try {
      userPublicKey = new PublicKey(playerAddress);
      console.log('DEBUG - Address validated:', userPublicKey.toBase58());
    } catch (err) {
      console.error('DEBUG - Invalid player address:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid Solana address' });
    }
    const connection = await getConnection();
    console.log('DEBUG - Connection established:', connection.rpcEndpoint);
    console.log('DEBUG - Fetching balance for:', userPublicKey.toBase58());
    const balance = await getCachedBalance(connection, userPublicKey, 'com', true);
    console.log('DEBUG - COM balance fetched:', balance);
    res.json({ success: true, balance });
  } catch (err) {
    console.error('DEBUG - Error fetching COM balance:', {
      message: err.message,
      stack: err.stack,
      name: err.name,
      playerAddress,
    });
    res.status(500).json({ success: false, error: `Failed to fetch COM balance: ${err.message}` });
  }
});

// Endpoint per distribuire vincite in COM (usato per Poker PvP)
app.post('/distribute-winnings', async (req, res) => {
  console.log('DEBUG - /distribute-winnings called:', req.body);
  const { winnerAddress, amount } = req.body;

  if (!winnerAddress || !amount || isNaN(amount) || amount <= 0) {
    console.log('DEBUG - Invalid parameters:', { winnerAddress, amount });
    return res.status(400).json({ success: false, error: 'Invalid winnerAddress or amount' });
  }

  try {
    console.log('DEBUG - Validating winner address:', winnerAddress);
    const winnerPublicKey = new PublicKey(winnerAddress);
    console.log('DEBUG - Getting casino ATA...');
    const casinoATA = await getAssociatedTokenAddress(MINT_ADDRESS, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    console.log('DEBUG - Getting winner ATA...');
    const winnerATA = await getAssociatedTokenAddress(MINT_ADDRESS, winnerPublicKey, false, TOKEN_2022_PROGRAM_ID);

    const connection = await getConnection();
    console.log('DEBUG - Checking casino SOL balance...');
    const casinoSolBalance = await getCachedBalance(connection, wallet.publicKey, 'sol');
    const minSolBalance = 0.01 * LAMPORTS_PER_SOL;
    if (casinoSolBalance * LAMPORTS_PER_SOL < minSolBalance) {
      console.log('DEBUG - Insufficient SOL balance:', {
        balance: casinoSolBalance,
        required: minSolBalance / LAMPORTS_PER_SOL,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient SOL balance in casino wallet for transaction fees: ${casinoSolBalance} SOL available, ${minSolBalance / LAMPORTS_PER_SOL} SOL required`,
      });
    }

    console.log('DEBUG - Checking casino ATA...');
    let casinoAccountExists = false;
    try {
      const casinoAccountInfo = await getAccount(connection, casinoATA, TOKEN_2022_PROGRAM_ID);
      casinoAccountExists = true;
      console.log('DEBUG - Casino ATA exists:', casinoATA.toBase58());
      if (casinoAccountInfo.isFrozen) {
        console.log('DEBUG - Casino ATA is frozen');
        return res.status(400).json({ success: false, error: 'Casino ATA is frozen' });
      }
    } catch (err) {
      console.log('DEBUG - Casino ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          casinoATA,
          wallet.publicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created casino ATA:', casinoATA.toBase58());
    }

    console.log('DEBUG - Checking casino COM balance...');
    const casinoBalance = await getCachedBalance(connection, wallet.publicKey, 'com');
    if (casinoBalance < amount) {
      console.log('DEBUG - Insufficient COM balance:', {
        balance: casinoBalance,
        required: amount,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient COM balance in casino wallet: ${casinoBalance} COM available, ${amount} COM required`,
      });
    }

    console.log('DEBUG - Checking winner ATA...');
    let winnerAccountExists = false;
    try {
      const winnerAccountInfo = await getAccount(connection, winnerATA, TOKEN_2022_PROGRAM_ID);
      winnerAccountExists = true;
      console.log('DEBUG - Winner ATA exists:', winnerATA.toBase58());
      if (winnerAccountInfo.isFrozen) {
        console.log('DEBUG - Winner ATA is frozen');
        return res.status(400).json({ success: false, error: 'Winner ATA is frozen' });
      }
    } catch (err) {
      console.log('DEBUG - Winner ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          winnerATA,
          winnerPublicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()));
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created winner ATA:', winnerATA.toBase58());
    }

    console.log('DEBUG - Verifying mint COM...');
    const mintData = await getCachedMintInfo(connection, MINT_ADDRESS);
    if (mintData.decimals !== 6) {
      console.log('DEBUG - Unexpected mint decimals:', mintData.decimals);
      return res.status(500).json({
        success: false,
        error: `Unexpected mint decimals: expected 6, found ${mintData.decimals}`,
      });
    }

    console.log('DEBUG - Creating transfer transaction...');
    const transaction = new Transaction().add(
      createTransferInstruction(
        casinoATA,
        winnerATA,
        wallet.publicKey,
        Math.round(amount * 1e6),
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    console.log('DEBUG - Getting latest blockhash...');
    const { blockhash } = await getCachedBlockhash(connection);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.partialSign(wallet);

    console.log('DEBUG - Sending transaction...');
    const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()), 3, 1000);
    console.log('DEBUG - Confirming transaction...');
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`DEBUG - Sent ${amount} COM to the Winner ${winnerAddress}, signature: ${signature}`);

    res.json({ success: true, transactionSignature: signature });
  } catch (err) {
    console.error('DEBUG - Error distributing winnings:', err.message, err.stack);
    return res.status(500).json({
      success: false,
      error: `Failed to distribute winnings: ${err.message || 'Unknown error'}`,
    });
  }
});

// Endpoint per gestire i rimborsi in COM (usato per Poker PvP)
app.post('/refund', async (req, res) => {
  console.log('DEBUG - /refund called:', req.body);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || 'https://casino-of-meme.com');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  const { playerAddress, amount } = req.body;

  if (!playerAddress || !amount || isNaN(amount) || amount <= 0) {
    console.log('DEBUG - Invalid refund parameters:', { playerAddress, amount });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress or amount' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    console.log('DEBUG - Getting casino ATA...');
    const casinoATA = await getAssociatedTokenAddress(MINT_ADDRESS, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    console.log('DEBUG - Getting player ATA...');
    const playerATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey, false, TOKEN_2022_PROGRAM_ID);

    const connection = await getConnection();
    console.log('DEBUG - Checking casino ATA...');
    let casinoAccountExists = false;
    try {
      await getAccount(connection, casinoATA, TOKEN_2022_PROGRAM_ID);
      casinoAccountExists = true;
      console.log('DEBUG - Casino ATA exists:', casinoATA.toBase58());
    } catch (err) {
      console.log('DEBUG - Casino ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          casinoATA,
          wallet.publicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created casino ATA:', casinoATA.toBase58());
    }

    console.log('DEBUG - Checking casino COM balance...');
    const casinoBalance = await getCachedBalance(connection, wallet.publicKey, 'com');
    if (casinoBalance < amount) {
      console.log('DEBUG - Insufficient COM balance in casino ATA:', { balance: casinoBalance, required: amount });
      return res.status(400).json({ success: false, error: 'Insufficient COM balance in casino wallet' });
    }

    console.log('DEBUG - Checking player ATA...');
    let playerAccountExists = false;
    try {
      await getAccount(connection, playerATA, TOKEN_2022_PROGRAM_ID);
      playerAccountExists = true;
      console.log('DEBUG - Player ATA exists:', playerATA.toBase58());
    } catch (err) {
      console.log('DEBUG - Player ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          playerATA,
          userPublicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created player ATA:', playerATA.toBase58());
    }

    console.log('DEBUG - Creating refund transaction...');
    const transaction = new Transaction().add(
      createTransferInstruction(
        casinoATA,
        playerATA,
        wallet.publicKey,
        amount * 1e6,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    console.log('DEBUG - Getting latest blockhash...');
    const { blockhash } = await getCachedBlockhash(connection);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.partialSign(wallet);

    console.log('DEBUG - Sending refund transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming refund transaction:', signature);
    await connection.confirmTransaction(signature);
    console.log(`DEBUG - Refunded ${amount} COM to ${playerAddress}`);

    res.json({ success: true });
  } catch (err) {
    console.error('DEBUG - Error processing refund:', err.message, err.stack);
    return res.status(500).json({ success: false, error: `Failed to process refund: ${err.message}` });
  }
});

// Endpoint per creare una transazione
app.post('/create-transaction', async (req, res) => {
  console.log('DEBUG - /create-transaction called:', req.body);
  const { playerAddress, betAmount, type } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !type) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, betAmount, type });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress, betAmount, or type' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    let userPublicKey;
    try {
      userPublicKey = new PublicKey(playerAddress);
      console.log('DEBUG - Valid Solana address:', playerAddress);
    } catch (err) {
      console.log('DEBUG - Invalid Solana address:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid Solana address' });
    }

    const connection = await getConnection();
    const transaction = new Transaction();

    if (type === 'sol') {
      const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);
      console.log('DEBUG - Bet in lamports:', betInLamports);

      console.log('DEBUG - Checking user SOL balance...');
      const userBalance = await getCachedBalance(connection, userPublicKey, 'sol');
      console.log('DEBUG - User balance:', userBalance, 'SOL');
      if (userBalance * LAMPORTS_PER_SOL < betInLamports) {
        console.log('DEBUG - Insufficient SOL balance:', userBalance);
        return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
      }

      transaction.add(
        SystemProgram.transfer({
          fromPubkey: userPublicKey,
          toPubkey: wallet.publicKey,
          lamports: betInLamports,
        })
      );
    } else {
      return res.status(400).json({ success: false, error: 'Invalid transaction type' });
    }

    console.log('DEBUG - Getting latest blockhash...');
    const { blockhash } = await getCachedBlockhash(connection);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userPublicKey;

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

    const serializedTransaction = transaction.serialize({ requireAllSignatures: false }).toString('base64');

    res.json({ success: true, transaction: serializedTransaction });
  } catch (err) {
    console.error('DEBUG - Error in create-transaction:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to create transaction: ${err.message}` });
  }
});

// Endpoint per ottenere solo il recentBlockhash
app.post('/get-recent-blockhash', async (req, res) => {
  console.log('DEBUG - /get-recent-blockhash called:', req.body);
  const { playerAddress } = req.body;

  if (!playerAddress) {
    console.log('DEBUG - Invalid parameters:', { playerAddress });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    let userPublicKey;
    try {
      userPublicKey = new PublicKey(playerAddress);
      console.log('DEBUG - Valid Solana address:', playerAddress);
    } catch (err) {
      console.log('DEBUG - Invalid Solana address:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid Solana address' });
    }

    const connection = await getConnection();
    console.log('DEBUG - Getting latest blockhash...');
    const { blockhash } = await getCachedBlockhash(connection);
    console.log('DEBUG - Recent blockhash:', blockhash);

    res.json({
      success: true,
      recentBlockhash: blockhash,
    });
  } catch (err) {
    console.error('DEBUG - Error in get-recent-blockhash:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to get recent blockhash: ${err.message}` });
  }
});

// Endpoint per processare le transazioni di tutti i minigiochi
app.post('/process-transaction', async (req, res) => {
  console.log('DEBUG - /process-transaction called:', req.body);
  const { playerAddress, betAmount, signedTransaction, gameType } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction || !gameType) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, betAmount, signedTransaction, gameType });
    return res.status(400).json({ success: false, error: 'Invalid parameters' });
  }

  const validGameTypes = ['memeSlots', 'coinFlip', 'crazyWheel', 'solanaCardDuel'];
  if (!validGameTypes.includes(gameType)) {
    console.log('DEBUG - Invalid gameType:', gameType);
    return res.status(400).json({ success: false, error: 'Invalid gameType' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    const betInLamports = Math.round(betAmount * LAMPORTS_PER_SOL);

    const connection = await getConnection();
    console.log('DEBUG - Checking user SOL balance...');
    const userBalance = await getCachedBalance(connection, userPublicKey, 'sol');
    console.log('DEBUG - User balance:', userBalance, 'Required:', betInLamports / LAMPORTS_PER_SOL);
    if (userBalance * LAMPORTS_PER_SOL < betInLamports) {
      console.log('DEBUG - Insufficient SOL balance:', userBalance);
      return res.status(400).json({ success: false, error: 'Insufficient SOL balance' });
    }

    console.log('DEBUG - Processing signed transaction...');
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      console.log('DEBUG - Invalid transaction signatures');
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming transaction:', signature);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('DEBUG - Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }

    const endpointMap = {
      memeSlots: '/play-meme-slots',
      coinFlip: '/play-coin-flip',
      crazyWheel: '/play-crazy-wheel',
      solanaCardDuel: '/play-solana-card-duel',
    };

    res.json({ success: true, redirectTo: endpointMap[gameType] });
  } catch (err) {
    console.error('DEBUG - Error in process-transaction:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to process transaction: ${err.message}` });
  }
});

// Endpoint per distribuire vincite in SOL
const retry = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`DEBUG - Retry attempt ${i + 1}/${retries} failed, retrying in ${delay}ms...`, err.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

app.post('/distribute-winnings-sol', async (req, res) => {
  console.log('DEBUG - /distribute-winnings-sol called:', req.body);
  const { playerAddress, amount } = req.body;

  if (!playerAddress || !amount || isNaN(amount) || amount <= 0) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, amount });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress or amount' });
  }

  if (amount === 0.02) {
    console.log('DEBUG - Detected amount of 0.02 SOL (possible mission reward), delaying by 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    let userPublicKey;
    try {
      userPublicKey = new PublicKey(playerAddress);
    } catch (err) {
      console.log('DEBUG - Invalid player address:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid Solana address' });
    }

    const connection = await getConnection();
    console.log('DEBUG - Checking casino SOL balance...');
    let casinoSolBalance;
    const requiredBalance = amount + 0.01;
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      console.log(`DEBUG - Checking casino SOL balance (attempt ${attempt}/${maxAttempts})...`);
      casinoSolBalance = await getCachedBalance(connection, wallet.publicKey, 'sol', true);
      console.log('DEBUG - Casino balance check:', {
        casinoSolBalance,
        requiredBalance,
        sufficient: casinoSolBalance >= requiredBalance,
      });

      if (casinoSolBalance >= requiredBalance) {
        break;
      }

      console.log(`DEBUG - Insufficient SOL balance (attempt ${attempt}/${maxAttempts}): ${casinoSolBalance} SOL available, ${requiredBalance.toFixed(4)} SOL required. Retrying in 2 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (casinoSolBalance < requiredBalance) {
      console.log('DEBUG - Insufficient SOL balance in casino wallet after retries:', {
        balance: casinoSolBalance,
        required: requiredBalance,
      });
      return res.status(400).json({
        success: false,
        error: `Insufficient SOL balance in casino wallet: ${casinoSolBalance} SOL available, ${requiredBalance.toFixed(4)} SOL required`,
      });
    }

    console.log('DEBUG - Creating SOL transfer transaction for', amount, 'SOL...');
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: userPublicKey,
        lamports: Math.round(amount * LAMPORTS_PER_SOL),
      })
    );

    console.log('DEBUG - Getting latest blockhash...');
    const { blockhash } = await getCachedBlockhash(connection);
    console.log('DEBUG - Blockhash:', blockhash);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    console.log('DEBUG - Signing transaction...');
    try {
      transaction.partialSign(wallet);
    } catch (err) {
      console.error('DEBUG - Error signing transaction:', err.message);
      throw new Error('Failed to sign transaction');
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await retry(() => connection.sendRawTransaction(transaction.serialize()), 3, 1000);
    console.log('DEBUG - Transaction sent, signature:', signature);

    console.log('DEBUG - Confirming transaction...');
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`DEBUG - Distributed ${amount} SOL to ${playerAddress}, signature: ${signature}`);

    res.json({ success: true, transactionSignature: signature });
  } catch (err) {
    console.error('DEBUG - Error distributing SOL winnings:', err.message, err.stack);
    return res.status(500).json({
      success: false,
      error: `Failed to distribute SOL winnings: ${err.message || 'Unknown error'}`,
    });
  }
});

// Endpoint per unirsi a una partita di Poker PvP
app.post('/join-poker-game', async (req, res) => {
  console.log('DEBUG - /join-poker-game called:', req.body);
  const { playerAddress, betAmount, signedTransaction } = req.body;

  if (!playerAddress || !betAmount || isNaN(betAmount) || betAmount <= 0 || !signedTransaction) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, betAmount, signedTransaction });
    return res.status(400).json({ success: false, error: 'Invalid playerAddress, betAmount, or signedTransaction' });
  }

  if (betAmount < MIN_BET) {
    console.log(`DEBUG - Bet ${betAmount} COM is below minimum ${MIN_BET} COM`);
    return res.status(400).json({ success: false, error: `Bet must be at least ${MIN_BET} COM` });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    console.log('DEBUG - Getting user ATA...');
    const userATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey, false, TOKEN_2022_PROGRAM_ID);
    console.log('DEBUG - Getting casino ATA...');
    const casinoATA = await getAssociatedTokenAddress(MINT_ADDRESS, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const connection = await getConnection();
    console.log('DEBUG - Checking casino ATA existence...');
    let casinoAccountExists = false;
    try {
      await getAccount(connection, casinoATA, TOKEN_2022_PROGRAM_ID);
      casinoAccountExists = true;
      console.log('DEBUG - Casino ATA exists:', casinoATA.toBase58());
    } catch (err) {
      console.log('DEBUG - Casino ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          casinoATA,
          wallet.publicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created casino ATA:', casinoATA.toBase58());
    }

    console.log('DEBUG - Checking user COM balance...');
    const userBalance = await getCachedBalance(connection, userPublicKey, 'com');
    console.log('DEBUG - User balance:', userBalance, 'Required:', betAmount);
    if (userBalance < betAmount) {
      console.log(`DEBUG - Insufficient COM balance for ${playerAddress}: ${userBalance} < ${betAmount}`);
      return res.status(400).json({ success: false, error: 'Insufficient COM balance' });
    }

    console.log('DEBUG - Processing signed transaction...');
    const transactionBuffer = Buffer.from(signedTransaction, 'base64');
    const transaction = Transaction.from(transactionBuffer);

    if (!transaction.verifySignatures()) {
      console.log('DEBUG - Invalid transaction signatures for:', playerAddress);
      return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
    }

    console.log('DEBUG - Sending transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log('DEBUG - Confirming transaction:', signature);
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.log('DEBUG - Transaction failed:', confirmation.value.err);
      return res.status(500).json({ success: false, error: 'Transaction failed' });
    }
    console.log(`DEBUG - Transferred ${betAmount} COM from ${playerAddress} to casino`);

    res.json({ success: true });
  } catch (err) {
    console.error('DEBUG - Error in join-poker-game:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to join game: ' + err.message });
  }
});

// Endpoint per gestire le mosse in Poker PvP
app.post('/make-poker-move', async (req, res) => {
  console.log('DEBUG - /make-poker-move called:', req.body);
  const { playerAddress, gameId, move, amount, signedTransaction } = req.body;

  if (!playerAddress || !gameId || !move || amount === undefined || isNaN(amount) || amount < 0) {
    console.log('DEBUG - Invalid parameters:', { playerAddress, gameId, move, amount });
    return res.status(400).json({ success: false, error: 'Invalid required fields' });
  }

  if (amount > 0 && !signedTransaction) {
    console.log('DEBUG - Missing signed transaction for move:', move);
    return res.status(400).json({ success: false, error: 'Missing signed transaction' });
  }

  try {
    console.log('DEBUG - Validating player address:', playerAddress);
    const userPublicKey = new PublicKey(playerAddress);
    console.log('DEBUG - Getting user ATA...');
    const userATA = await getAssociatedTokenAddress(MINT_ADDRESS, userPublicKey, false, TOKEN_2022_PROGRAM_ID);
    console.log('DEBUG - Getting casino ATA...');
    const casinoATA = await getAssociatedTokenAddress(MINT_ADDRESS, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const connection = await getConnection();
    console.log('DEBUG - Checking casino ATA...');
    let casinoAccountExists = false;
    try {
      await getAccount(connection, casinoATA, TOKEN_2022_PROGRAM_ID);
      casinoAccountExists = true;
      console.log('DEBUG - Casino ATA exists:', casinoATA.toBase58());
    } catch (err) {
      console.log('DEBUG - Casino ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          casinoATA,
          wallet.publicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created casino ATA:', casinoATA.toBase58());
    }

    console.log('DEBUG - Checking player ATA...');
    let playerAccountExists = false;
    try {
      await getAccount(connection, userATA, TOKEN_2022_PROGRAM_ID);
      playerAccountExists = true;
      console.log('DEBUG - Player ATA exists:', userATA.toBase58());
    } catch (err) {
      console.log('DEBUG - Player ATA does not exist, creating...');
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userATA,
          userPublicKey,
          MINT_ADDRESS,
          TOKEN_2022_PROGRAM_ID
        )
      );
      const { blockhash } = await getCachedBlockhash(connection);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.partialSign(wallet);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature);
      console.log('DEBUG - Created player ATA:', userATA.toBase58());
    }

    if (amount > 0) {
      console.log('DEBUG - Checking user COM balance for move:', move);
      const userBalance = await getCachedBalance(connection, userPublicKey, 'com');
      console.log('DEBUG - User balance:', userBalance, 'Required:', amount);
      if (userBalance < amount) {
        console.log(`DEBUG - Insufficient COM balance for ${playerAddress}: ${userBalance} < ${amount}`);
        return res.status(400).json({ success: false, error: 'Insufficient COM balance' });
      }

      console.log('DEBUG - Processing signed transaction for move:', move);
      const transactionBuffer = Buffer.from(signedTransaction, 'base64');
      const transaction = Transaction.from(transactionBuffer);

      if (!transaction.verifySignatures()) {
        console.log('DEBUG - Invalid transaction signatures for:', playerAddress);
        return res.status(400).json({ success: false, error: 'Invalid transaction signatures' });
      }

      console.log('DEBUG - Sending transaction for move:', move);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      console.log('DEBUG - Confirming transaction:', signature);
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        console.log('DEBUG - Transaction failed:', confirmation.value.err);
        return res.status(500).json({ success: false, error: 'Transaction failed' });
      }
      console.log(`DEBUG - Transferred ${amount} COM from ${playerAddress} to casino for move ${move}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DEBUG - Error in make-poker-move:', err.message, err.stack);
    res.status(500).json({ success: false, error: `Failed to process move: ${err.message}` });
  }
});

// Endpoint per la leaderboard
app.get('/leaderboard', async (req, res) => {
  console.log('DEBUG - /leaderboard called');
  try {
    console.log('DEBUG - Fetching leaderboard...');
    const leaderboard = await Player.find()
      .sort({ totalWinnings: -1 })
      .limit(10)
      .maxTimeMS(5000);
    console.log('DEBUG - Leaderboard fetched:', leaderboard);
    if (!leaderboard || leaderboard.length === 0) {
      console.log('DEBUG - Leaderboard is empty');
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
    console.error('DEBUG - Error fetching leaderboard:', err.message, err.stack);
    res.status(500).json({ error: 'Error fetching leaderboard' });
  }
});







// Gestione delle connessioni WebSocket
io.on('connection', (socket) => {
  console.log('A player connected:', socket.id, 'from origin:', socket.handshake.headers.origin);

  // Incrementa il conteggio dei visitatori
  visitorCount++;
  console.log(`New visitor connected. Total visitors: ${visitorCount}`);

  // Invia il conteggio iniziale al client appena connesso
  socket.emit('visitorCount', visitorCount);

  // Trasmetti il conteggio aggiornato a tutti i client
  io.emit('visitorCount', visitorCount);

  socket.on('joinGame', async ({ playerAddress, betAmount }, callback) => {
    console.log(`Player ${playerAddress} attempting to join with bet ${betAmount} COM, socket.id: ${socket.id}`);

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

    const existingPlayerIndex = waitingPlayers.findIndex(p => p.address === playerAddress);
    if (existingPlayerIndex !== -1) {
      waitingPlayers[existingPlayerIndex].id = socket.id;
      waitingPlayers[existingPlayerIndex].bet = betAmount;
      console.log(`Updated player ${playerAddress} in waiting list: socket.id=${socket.id}, bet=${betAmount}`);
    } else {
      waitingPlayers.push({ id: socket.id, address: playerAddress, bet: betAmount });
      console.log(`Added player ${playerAddress} to waiting list with bet ${betAmount} COM`);
    }

    console.log('Current waitingPlayers:', waitingPlayers.map(p => ({ address: p.address, bet: p.bet, socketId: p.id })));

    socket.emit('waiting', {
      message: 'You have joined the game! Waiting for another player...',
      players: waitingPlayers
    });
    io.emit('waitingPlayers', {
      players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet }))
    });

    if (callback) {
      callback({ success: true, message: 'Joined waiting list successfully' });
    }

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
        actionsCompleted: 0, // Aggiunto per tracciare le azioni completate
      };

    try {
      console.log('DEBUG - Saving game to database:', gameId);
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
      console.log(`DEBUG - Saved game ${gameId} to database`);
    } catch (err) {
      console.error(`DEBUG - Error saving game ${gameId}:`, err.message, err.stack);
      socket.emit('error', { message: 'Error starting game' });
      await refundBetsForGame(gameId);
      if (callback) callback({ success: false, error: 'Error starting game' });
      return;
    }

    players.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.join(gameId);
        console.log(`DEBUG - Player ${player.address} joined room ${gameId}`);
      } else {
        console.error(`DEBUG - Socket for player ${player.address} not found`);
      }
    });

    console.log('DEBUG - Emitting updated waitingPlayers:', waitingPlayers.map(p => ({ address: p.address, bet: p.bet })));
    io.emit('waitingPlayers', {
      players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet }))
    });
    console.log(`DEBUG - Game ${gameId} started with players:`, players.map(p => p.address));

    startGame(gameId);
  }
});

socket.on('leaveWaitingList', ({ playerAddress }) => {
  console.log('DEBUG - leaveWaitingList called for:', playerAddress);
  const playerIndex = waitingPlayers.findIndex(p => p.address === playerAddress && p.id === socket.id);
  if (playerIndex !== -1) {
    const player = waitingPlayers[playerIndex];
    waitingPlayers.splice(playerIndex, 1);
    console.log(`DEBUG - Player ${playerAddress} left the waiting list`);

    socket.emit('refund', {
      message: 'You left the waiting list. Your bet has been refunded.',
      amount: player.bet,
      isRefund: true,
    });

    console.log('DEBUG - Emitting updated waitingPlayers after leave:', waitingPlayers.map(p => ({ address: p.address, bet: p.bet })));
    io.emit('waitingPlayers', {
      players: waitingPlayers.map(p => ({ address: p.address, bet: p.bet }))
    });
    socket.emit('leftWaitingList', { message: 'You have left the waiting list.' });
  } else {
    socket.emit('error', { message: 'You are not in the waiting list.' });
    console.log(`DEBUG - Player ${playerAddress} not found in waiting list`);
  }
});

socket.on('reconnectPlayer', async ({ playerAddress, gameId }) => {
  console.log('DEBUG - reconnectPlayer called:', { playerAddress, gameId, socketId: socket.id });
  const game = games[gameId];
  if (game) {
    const player = game.players.find(p => p.address === playerAddress);
    if (player) {
      const oldSocketId = player.id;
      player.id = socket.id;
      console.log(`DEBUG - Player ${playerAddress} reconnected. Updated socket.id from ${oldSocketId} to ${socket.id}`);
      socket.join(gameId);
      if (game.currentTurn === oldSocketId) {
        game.currentTurn = socket.id;
        console.log(`DEBUG - Updated currentTurn to new socket.id: ${socket.id}`);
      }
      try {
        await Game.updateOne(
          { gameId, 'players.address': playerAddress },
          { $set: { 'players.$.id': socket.id } }
        );
        console.log(`DEBUG - Updated socket.id for ${playerAddress} in game ${gameId} database`);
      } catch (err) {
        console.error(`DEBUG - Error updating socket.id for ${playerAddress} in game ${gameId}:`, err.message, err.stack);
      }
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } else {
      console.error(`DEBUG - Player ${playerAddress} not found in game ${gameId}`);
    }
  } else {
    console.error(`DEBUG - Game ${gameId} not found during reconnection`);
  }
});

socket.on('makeMove', async ({ gameId, move, amount }) => {
  console.log('DEBUG - makeMove called:', { gameId, move, amount, socketId: socket.id });
  const game = games[gameId];
  if (!game || game.currentTurn !== socket.id) {
    console.log(`DEBUG - Invalid move: gameId=${gameId}, currentTurn=${game.currentTurn}, socket.id=${socket.id}`);
    socket.emit('error', { message: 'Invalid move or not your turn' });
    return;
  }

  if (game.turnTimer) {
    clearInterval(game.turnTimer);
    console.log('DEBUG - Cleared turn timer for game:', gameId);
  }
  game.timeLeft = 30;

  const playerAddress = game.players.find(p => p.id === socket.id)?.address;
  const opponent = game.players.find(p => p.id !== socket.id);
  if (!playerAddress || !opponent) {
    console.log(`DEBUG - Player or opponent not found: playerAddress=${playerAddress}, opponent=${opponent}`);
    await refundBetsForGame(gameId);
    socket.emit('error', { message: 'Player or opponent not found' });
    return;
  }
  const currentPlayerBet = game.playerBets[playerAddress] || 0;
  console.log(`DEBUG - Processing move: ${move}, gameId=${gameId}, playerAddress=${playerAddress}, currentBet=${game.currentBet}, currentPlayerBet=${currentPlayerBet}, actionsCompleted=${game.actionsCompleted}`);

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
      console.log(`DEBUG - Deleted game ${gameId} from database`);
    } catch (err) {
      console.error(`DEBUG - Error updating/deleting game ${gameId}:`, err.message, err.stack);
    }
    delete games[gameId];
  } else if (move === 'check') {
    if (game.currentBet > currentPlayerBet) {
      game.message = 'You cannot check, you must call or raise!';
      game.dealerMessage = 'The dealer reminds: You must call or raise!';
      console.log(`DEBUG - Check not allowed: currentBet=${game.currentBet}, currentPlayerBet=${currentPlayerBet}`);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } else {
      game.message = 'You checked.';
      game.dealerMessage = `The dealer says: ${playerAddress.slice(0, 8)}... checked.`;
      console.log(`DEBUG - Check successful: currentBet=${game.currentBet}, currentPlayerBet=${currentPlayerBet}`);
      game.actionsCompleted += 1;
      console.log(`DEBUG - Actions completed: ${game.actionsCompleted}`);

      if (game.actionsCompleted >= 2 && game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
        game.bettingRoundComplete = true;
        game.actionsCompleted = 0;
        console.log(`DEBUG - Betting round complete in phase ${game.gamePhase}, advancing game phase`);
        advanceGamePhase(gameId);
      } else {
        game.currentTurn = opponent.id;
        game.bettingRoundComplete = false;
        console.log(`DEBUG - Passing turn to opponent: ${opponent.id}`);
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
    console.log(`DEBUG - Call successful: amountToCall=${amountToCall}, new pot=${game.pot}`);
    game.actionsCompleted += 1;
    console.log(`DEBUG - Actions completed: ${game.actionsCompleted}`);

    if (game.actionsCompleted >= 2 && game.playerBets[playerAddress] === game.playerBets[opponent.address]) {
      game.bettingRoundComplete = true;
      game.actionsCompleted = 0;
      console.log(`DEBUG - Betting round complete in phase ${game.gamePhase}, advancing game phase`);
      advanceGamePhase(gameId);
    } else {
      game.currentTurn = opponent.id;
      game.bettingRoundComplete = false;
      console.log(`DEBUG - Passing turn to opponent: ${opponent.id}`);
      startTurnTimer(gameId, opponent.id);
    }
    try {
      await Game.updateOne({ gameId }, { pot: game.pot });
      console.log(`DEBUG - Updated pot for game ${gameId} to ${game.pot}`);
    } catch (err) {
      console.error(`DEBUG - Error updating pot for game ${gameId}:`, err.message, err.stack);
    }
    io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
  } else if (move === 'bet' || move === 'raise') {
    const minBet = MIN_BET;
    const newBet = move === 'bet' ? amount : game.currentBet + amount;
    if (newBet <= game.currentBet || amount < minBet) {
      game.message = `The bet must be at least ${minBet.toFixed(2)} COM and higher than the current bet!`;
      game.dealerMessage = `The dealer warns: Bet must be at least ${minBet.toFixed(2)} COM and higher!`;
      console.log(`DEBUG - Invalid ${move}: newBet=${newBet}, currentBet=${game.currentBet}, minBet=${minBet}`);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
      return;
    }
    const additionalBet = newBet - currentPlayerBet;
    game.pot += additionalBet;
    game.playerBets[playerAddress] = newBet;
    game.currentBet = newBet;
    game.message = `You ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} COM.`;
    game.dealerMessage = `The dealer announces: ${playerAddress.slice(0, 8)}... ${move === 'bet' ? 'bet' : 'raised'} ${additionalBet.toFixed(2)} COM.`;
    console.log(`DEBUG - ${move} successful: additionalBet=${additionalBet}, new pot=${game.pot}, new currentBet=${game.currentBet}`);
    game.actionsCompleted = 1;
    game.currentTurn = opponent.id;
    game.bettingRoundComplete = false;
    try {
      await Game.updateOne({ gameId }, { pot: game.pot });
      console.log(`DEBUG - Updated pot for game ${gameId} to ${game.pot}`);
    } catch (err) {
      console.error(`DEBUG - Error updating pot for game ${gameId}:`, err.message, err.stack);
    }
    startTurnTimer(gameId, opponent.id);
    io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
  }
});

socket.on('disconnect', async () => {
  console.log('DEBUG - A player disconnected:', socket.id);
  visitorCount = Math.max(0, visitorCount - 1);
  console.log(`DEBUG - Visitor disconnected. Total visitors: ${visitorCount}`);
  io.emit('visitorCount', visitorCount);

  for (const gameId in games) {
    const game = games[gameId];
    const playerIndex = game.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
      const opponent = game.players.find(p => p.id !== socket.id);
      if (opponent) {
        console.log(`DEBUG - Player ${socket.id} disconnected, waiting 30s before ending game ${gameId}`);
        setTimeout(async () => {
          if (!games[gameId]) return;
          if (game.turnTimer) clearInterval(game.turnTimer);
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
            console.log(`DEBUG - Deleted game ${gameId} from database`);
          } catch (err) {
            console.error(`DEBUG - Error updating/deleting game ${gameId}:`, err.message, err.stack);
          }
          delete games[gameId];
        }, 30000);
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
  console.error(`DEBUG - Game ${gameId} not found in startTurnTimer`);
  await refundBetsForGame(gameId);
  return;
}

const player = game.players.find(p => p.id === playerId);
if (!player) {
  console.error(`DEBUG - Player with socket.id ${playerId} not found in game ${gameId}`);
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
      console.log(`DEBUG - Deleted game ${gameId} from database`);
    } catch (err) {
      console.error(`DEBUG - Error updating/deleting game ${gameId}:`, err.message, err.stack);
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
  console.log(`DEBUG - Clearing previous timer for game ${gameId}`);
  clearTimeout(game.turnTimer);
  game.turnTimer = null;
}

io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
console.log(`DEBUG - Turn timer started for game ${gameId}, player ${playerId}, timeLeft: ${game.timeLeft}`);

const clientsInRoom = io.sockets.adapter.rooms.get(gameId);
console.log(`DEBUG - Clients in room ${gameId}:`, clientsInRoom ? Array.from(clientsInRoom) : 'No clients');

const runTimer = async () => {
  try {
    if (!games[gameId]) {
      console.log(`DEBUG - Game ${gameId} no longer exists, stopping timer`);
      await refundBetsForGame(gameId);
      return;
    }

    if (game.status !== 'playing') {
      console.log(`DEBUG - Game ${gameId} is not in playing state, stopping timer`);
      clearTimeout(game.turnTimer);
      game.turnTimer = null;
      return;
    }

    game.timeLeft -= 1;
    console.log(`DEBUG - Game ${gameId} timer tick: timeLeft = ${game.timeLeft}, currentTurn = ${game.currentTurn}`);

    const playerSocket = io.sockets.sockets.get(game.currentTurn);
    if (!playerSocket || !playerSocket.rooms.has(gameId)) {
      console.error(`DEBUG - Player with socket.id ${game.currentTurn} is not connected or not in room ${gameId}`);
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
          console.log(`DEBUG - Deleted game ${gameId} from database`);
        } catch (err) {
          console.error(`DEBUG - Error updating/deleting game ${gameId}:`, err.message, err.stack);
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
        console.error(`DEBUG - Player or opponent not found in game ${gameId}`);
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
        console.log(`DEBUG - Deleted game ${gameId} from database`);
      } catch (err) {
        console.error(`DEBUG - Error updating/deleting game ${gameId}:`, err.message, err.stack);
      }
      delete games[gameId];
    } else {
      game.turnTimer = setTimeout(runTimer, 1000);
    }
  } catch (err) {
    console.error(`DEBUG - Error in turn timer for game ${gameId}:`, err.message, err.stack);
    await refundBetsForGame(gameId);
  }
};

game.turnTimer = setTimeout(runTimer, 1000);
};

// In startGame
const startGame = async (gameId) => {
const game = games[gameId];
if (!game) {
  console.error(`DEBUG - Game ${gameId} not found in startGame`);
  await refundBetsForGame(gameId);
  return;
}
console.log(`DEBUG - Starting game ${gameId} with players:`, game.players.map(p => ({ address: p.address, socketId: p.id })));

game.message = 'The dealer is dealing the cards...';
game.dealerMessage = 'The dealer is dealing the cards to the players.';
io.to(gameId).emit('gameState', removeCircularReferences(game));

try {
  await Game.updateOne({ gameId }, { status: 'playing' });
  console.log(`DEBUG - Updated game ${gameId} status to playing`);
} catch (err) {
  console.error(`DEBUG - Error updating game ${gameId} status:`, err.message, err.stack);
  await refundBetsForGame(gameId);
  return;
}

try {
  const player1Cards = [drawCard(), drawCard()];
  const player2Cards = [drawCard(), drawCard()];
  console.log(`DEBUG - Player 1 cards:`, player1Cards);
  console.log(`DEBUG - Player 2 cards:`, player2Cards);

  if (!player1Cards.every(card => card && card.value && card.suit && card.image) ||
      !player2Cards.every(card => card && card.value && card.suit && card.image)) {
    throw new Error('Invalid cards drawn');
  }

  game.playerCards[game.players[0].address] = player1Cards;
  game.playerCards[game.players[1].address] = player2Cards;

  const player1Socket = io.sockets.sockets.get(game.players[0].id);
  const player2Socket = io.sockets.sockets.get(game.players[1].id);
  if (!player1Socket || !player2Socket) {
    throw new Error('One or more players disconnected before game start');
  }

  game.currentTurn = game.players[0].id;
  game.pot = game.players[0].bet + game.players[1].bet;
  game.playerBets[game.players[0].address] = 0;
  game.playerBets[game.players[1].address] = 0;
  game.currentBet = 0;
  game.status = 'playing';
  game.message = 'Pre-Flop: Place your bets.';
  game.dealerMessage = `The dealer says: Cards dealt! ${game.players[0].address.slice(0, 8)}... starts the betting.`;
  game.actionsCompleted = 0;

  console.log(`DEBUG - Game ${gameId} started. Current turn assigned to: ${game.currentTurn}`);
  startTurnTimer(gameId, game.players[0].id);
  io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
} catch (err) {
  console.error(`DEBUG - Error in startGame ${gameId}:`, err.message, err.stack);
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

console.log(`DEBUG - Drawn card: ${cardName}${suitChar} (Value: ${value}, Suit: ${suit})`);
return { value, suit, image };
};

const advanceGamePhase = async (gameId) => {
const game = games[gameId];
if (!game) {
  console.error(`DEBUG - Game ${gameId} not found in advanceGamePhase`);
  await refundBetsForGame(gameId);
  return;
}

if (game.status !== 'playing') {
  console.log(`DEBUG - Game ${gameId} is not in playing state, aborting phase advance`);
  return;
}

if (game.turnTimer) {
  clearTimeout(game.turnTimer);
  game.turnTimer = null;
  console.log(`DEBUG - Cleared timer for game ${gameId} before advancing phase`);
}

const lastPlayer = game.players.find(p => p.id !== game.currentTurn);
const nextPlayer = game.players.find(p => p.id === game.currentTurn);

if (!lastPlayer || !nextPlayer) {
  console.error(`DEBUG - Players not found in game ${gameId}`);
  await refundBetsForGame(gameId);
  return;
}

game.actionsCompleted = 0;
game.bettingRoundComplete = false;

if (game.gamePhase === 'pre-flop') {
  game.message = 'The dealer is dealing the Flop...';
  game.dealerMessage = 'The dealer is dealing the Flop cards.';
  io.to(gameId).emit('gameState', removeCircularReferences(game));
  setTimeout(() => {
    try {
      const newCards = Array(3).fill().map(() => drawCard());
      if (!newCards.every(card => card && card.value && card.suit && card.image)) {
        throw new Error('Invalid flop cards drawn');
      }
      game.tableCards = newCards;
      game.gamePhase = 'flop';
      game.message = 'Flop: Place your bets.';
      game.dealerMessage = `The dealer reveals the Flop: ${newCards.map(c => `${c.value} of ${c.suit}`).join(', ')}. ${lastPlayer.address.slice(0, 8)}... is up.`;
      game.currentTurn = lastPlayer.id;
      game.currentBet = 0;
      game.playerBets[lastPlayer.address] = 0;
      game.playerBets[nextPlayer.address] = 0;
      console.log(`DEBUG - Advancing to Flop, turn passed to: ${lastPlayer.id}`);
      startTurnTimer(gameId, lastPlayer.id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } catch (err) {
      console.error(`DEBUG - Error advancing to flop in game ${gameId}:`, err.message, err.stack);
      game.message = 'Error dealing flop. Refunding bets...';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
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
      if (!newCard || !newCard.value || !newCard.suit || !newCard.image) {
        throw new Error('Invalid turn card drawn');
      }
      game.tableCards.push(newCard);
      game.gamePhase = 'turn';
      game.message = 'Turn: Place your bets.';
      game.dealerMessage = `The dealer reveals the Turn: ${newCard.value} of ${newCard.suit}. ${lastPlayer.address.slice(0, 8)}... is up.`;
      game.currentTurn = lastPlayer.id;
      game.currentBet = 0;
      game.playerBets[lastPlayer.address] = 0;
      game.playerBets[nextPlayer.address] = 0;
      console.log(`DEBUG - Advancing to Turn, turn passed to: ${lastPlayer.id}`);
      startTurnTimer(gameId, lastPlayer.id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } catch (err) {
      console.error(`DEBUG - Error advancing to turn in game ${gameId}:`, err.message, err.stack);
      game.message = 'Error dealing turn. Refunding bets...';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
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
      if (!newCard || !newCard.value || !newCard.suit || !newCard.image) {
        throw new Error('Invalid river card drawn');
      }
      game.tableCards.push(newCard);
      game.gamePhase = 'river';
      game.message = 'River: Place your bets.';
      game.dealerMessage = `The dealer reveals the River: ${newCard.value} of ${newCard.suit}. ${lastPlayer.address.slice(0, 8)}... is up.`;
      game.currentTurn = lastPlayer.id;
      game.currentBet = 0;
      game.playerBets[lastPlayer.address] = 0;
      game.playerBets[nextPlayer.address] = 0;
      console.log(`DEBUG - Advancing to River, turn passed to: ${lastPlayer.id}`);
      startTurnTimer(gameId, lastPlayer.id);
      io.to(gameId).emit('gameState', removeCircularReferences({ ...game, timeLeft: game.timeLeft }));
    } catch (err) {
      console.error(`DEBUG - Error advancing to river in game ${gameId}:`, err.message, err.stack);
      game.message = 'Error dealing river. Refunding bets...';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      refundBetsForGame(gameId);
    }
  }, 1000);
} else if (game.gamePhase === 'river') {
  game.gamePhase = 'showdown';
  game.message = 'Showdown: Evaluating hands...';
  game.dealerMessage = 'The dealer is evaluating the hands...';
  io.to(gameId).emit('gameState', removeCircularReferences(game));
  setTimeout(() => {
    try {
      endGame(gameId);
    } catch (err) {
      console.error(`DEBUG - Error advancing to showdown in game ${gameId}:`, err.message, err.stack);
      game.message = 'Error evaluating hands. Refunding bets...';
      io.to(gameId).emit('gameState', removeCircularReferences(game));
      refundBetsForGame(gameId);
    }
  }, 1000);
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

console.log('DEBUG - Best hand:', bestHand);
console.log('DEBUG - Best evaluation:', { rank: bestRank, description: bestDescription, highCards: bestHighCards });
return { rank: bestRank, description: bestDescription, highCards: bestHighCards };
};

const endGame = async (gameId) => {
const game = games[gameId];
if (!game) {
  console.error(`DEBUG - Game ${gameId} not found in endGame`);
  await refundBetsForGame(gameId);
  return;
}

if (game.turnTimer) {
  clearInterval(game.turnTimer);
  console.log('DEBUG - Cleared turn timer for game:', gameId);
}

const player1 = game.players[0];
const player2 = game.players[1];
const player1Hand = [...game.playerCards[player1.address], ...game.tableCards];
const player2Hand = [...game.playerCards[player2.address], ...game.tableCards];
const player1Evaluation = evaluatePokerHand(player1Hand);
const player2Evaluation = evaluatePokerHand(player2Hand);

console.log(`DEBUG - Player 1 (${player1.address}) hand:`, player1Hand);
console.log(`DEBUG - Player 1 evaluation:`, player1Evaluation);
console.log(`DEBUG - Player 2 (${player2.address}) hand:`, player2Hand);
console.log(`DEBUG - Player 2 evaluation:`, player2Evaluation);

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

console.log(`DEBUG - Distributing winnings for game ${gameId}:`, { pot: game.pot, isTie });

if (isTie) {
  const splitAmount = game.pot / 2;
  console.log(`DEBUG - Splitting pot: ${game.pot} COM into ${splitAmount} COM for each player`);
  io.to(gameId).emit('distributeWinnings', { winnerAddress: player1.address, amount: splitAmount, isRefund: false });
  io.to(gameId).emit('distributeWinnings', { winnerAddress: player2.address, amount: splitAmount, isRefund: false });
  await updateLeaderboard(player1.address, splitAmount);
  await updateLeaderboard(player2.address, splitAmount);
} else {
  console.log(`DEBUG - Distributing full pot: ${game.pot} COM to winner ${winner.address}`);
  io.to(gameId).emit('distributeWinnings', { winnerAddress: winner.address, amount: game.pot, isRefund: false });
  await updateLeaderboard(winner.address, game.pot);
}

try {
  await Game.updateOne({ gameId }, { status: 'finished' });
  await Game.deleteOne({ gameId });
  console.log(`DEBUG - Deleted game ${gameId} from database`);
} catch (err) {
  console.error(`DEBUG - Error updating/deleting game ${gameId}:`, err.message, err.stack);
}

delete games[gameId];
};

const updateLeaderboard = async (playerAddress, winnings) => {
console.log(`DEBUG - Updating leaderboard for ${playerAddress} with ${winnings.toFixed(2)} COM`);
try {
  let player = await Player.findOne({ address: playerAddress });
  if (!player) {
    player = new Player({ address: playerAddress, totalWinnings: winnings });
  } else {
    player.totalWinnings += winnings;
  }
  await player.save();
  console.log(`DEBUG - Leaderboard updated for ${playerAddress}: ${player.totalWinnings.toFixed(2)} COM`);
} catch (err) {
  console.error(`DEBUG - Error updating leaderboard for ${playerAddress}:`, err.message, err.stack);
}
};

// Gestione dei crash non gestiti
process.on('uncaughtException', async (err) => {
console.error('DEBUG - Uncaught Exception:', err.message, err.stack);
await refundAllActiveGames();
// Non terminare il processo per mantenere il server in esecuzione
});

process.on('unhandledRejection', async (reason, promise) => {
console.error('DEBUG - Unhandled Rejection at:', promise, 'reason:', reason);
await refundAllActiveGames();
// Non terminare il processo
});

process.on('SIGTERM', async () => {
console.log('DEBUG - Server shutting down...');
await refundAllActiveGames();
server.close(() => {
  mongoose.connection.close(() => {
    console.log('DEBUG - MongoDB connection closed');
    redisClient.quit(() => {
      console.log('DEBUG - Redis connection closed');
      process.exit(0);
    });
  });
});
});

const PORT = process.env.PORT || 3001;
console.log(`DEBUG - PORT environment variable: ${process.env.PORT}`);
server.listen(PORT, () => {
console.log(`DEBUG - Server running on port ${PORT}`);
});
// config/redis.js
require('dotenv').config();
const redis = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('ERROR - REDIS_URL is missing in environment variables');
  process.exit(1);
}

const client = redis.createClient({
  url: REDIS_URL,
});

client.on('error', (err) => {
  console.error('Redis error:', err);
  // Non terminare il processo, lascia che il server gestisca l'errore
});

client.on('connect', () => console.log('Connected to Redis'));
client.on('ready', () => console.log('Redis client ready'));

const connectRedis = async () => {
  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    throw err;
  }
};

// Esporta una promessa per garantire che Redis sia pronto
module.exports = { client, connectRedis };
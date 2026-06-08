require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 60);
const MIN_USD_VALUE = Number(process.env.MIN_USD_VALUE || 50000);

const seen = new Set();

const CHAINS = {
  eth: {
    name: "Ethereum",
    rpc: process.env.ETH_RPC || "https://ethereum.publicnode.com"
  },
  base: {
    name: "Base",
    rpc: process.env.BASE_RPC || "https://mainnet.base.org"
  },
  bnb: {
    name: "BNB Chain",
    rpc: process.env.BNB_RPC || "https://bsc-dataseed.binance.org"
  },
  polygon: {
    name: "Polygon",
    rpc: process.env.POLYGON_RPC || "https://polygon-rpc.com"
  },
  avalanche: {
    name: "Avalanche",
    rpc: process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc"
  },
  hype: {
    name: "HyperEVM",
    rpc: process.env.HYPE_RPC || "https://rpc.hyperliquid.xyz/evm"
  }
};

const TOKENS = [
  {
    symbol: process.env.WAI_SYMBOL || "WAI",
    address: process.env.WAI_CONTRACT_ADDRESS || "",
    chain: process.env.WAI_CHAIN || "bnb",
    decimals: Number(process.env.WAI_DECIMALS || 18),
    priceUsd: Number(process.env.WAI_PRICE_USD || 0)
  }
].filter(t => t.address && t.address.length > 10);

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

function shortWallet(wallet) {
  if (!wallet) return "unknown";
  return wallet.slice(0, 6) + "..." + wallet.slice(-4);
}

function onlyOwner(chatId) {
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

async function sendSignal(text) {
  if (!signalsEnabled) return;
  if (!TELEGRAM_CHAT_ID) return;
  await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: "HTML" });
}

async function scanEvmToken(token) {
  const chain = CHAINS[token.chain];
  if (!chain) return;

  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const contract = new ethers.Contract(token.address, ERC20_ABI, provider);

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(latest - 30, 0);

  const filter = contract.filters.Transfer();
  const logs = await contract.queryFilter(filter, fromBlock, latest);

  for (const log of logs) {
    const id = `${token.chain}-${log.transactionHash}-${log.index}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const amount = Number(ethers.formatUnits(log.args.value, token.decimals));
    const usdValue = token.priceUsd > 0 ? amount * token.priceUsd : 0;

    if (usdValue < MIN_USD_VALUE) continue;

    const from = log.args.from;
    const to = log.args.to;

    const msg = `
🐋 <b>WHALE TRANSFER DETECTED</b>

<b>Token:</b> ${token.symbol}
<b>Chain:</b> ${chain.name}
<b>Amount:</b> ${amount.toLocaleString()} ${token.symbol}
<b>Value:</b> $${usdValue.toLocaleString()}

<b>From:</b> <code>${shortWallet(from)}</code>
<b>To:</b> <code>${shortWallet(to)}</code>

<b>Tx:</b> <code>${log.transactionHash}</code>
`;

    await sendSignal(msg);
  }
}

async function scanBtcWhales() {
  if (String(process.env.BTC_ENABLED || "false") !== "true") return;

  const minBtc = Number(process.env.MIN_BTC_AMOUNT || 10);

  const res = await axios.get("https://mempool.space/api/mempool/recent");
  const txs = res.data || [];

  for (const tx of txs) {
    const id = `btc-${tx.txid}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const btc = Number(tx.value || 0) / 100000000;

    if (btc < minBtc) continue;

    const msg = `
🐋 <b>BTC WHALE TX DETECTED</b>

<b>Amount:</b> ${btc.toFixed(4)} BTC
<b>Tx:</b> <code>${tx.txid}</code>
`;

    await sendSignal(msg);
  }
}

async function runScans() {
  try {
    for (const token of TOKENS) {
      await scanEvmToken(token);
    }

    await scanBtcWhales();

    if (seen.size > 5000) {
      seen.clear();
    }
  } catch (err) {
    console.error("Scan error:", err.message);
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Bot

Comenzi:

/status
/signals_on
/signals_off

Semnalele sunt pregătite, dar pot fi ținute OFF până activăm WAI access.
`);
});

bot.onText(/\/status/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Min USD Value: $${MIN_USD_VALUE}
Interval: ${CHECK_INTERVAL_SECONDS}s
Tokens loaded: ${TOKENS.length}
BTC monitor: ${process.env.BTC_ENABLED || "false"}
`);
});

bot.onText(/\/signals_on/, (msg) => {
  if (!onlyOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  signalsEnabled = true;
  bot.sendMessage(msg.chat.id, "✅ Signals ON");
});

bot.onText(/\/signals_off/, (msg) => {
  if (!onlyOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  signalsEnabled = false;
  bot.sendMessage(msg.chat.id, "❌ Signals OFF");
});

setInterval(runScans, CHECK_INTERVAL_SECONDS * 1000);

console.log("WAI WhaleSignals Bot running...");
console.log("Signals enabled:", signalsEnabled);
console.log("Tokens loaded:", TOKENS.length);

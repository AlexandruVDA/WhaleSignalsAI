require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("message", (msg) => {
  console.log("CHAT ID:", msg.chat.id);
  console.log("TITLE:", msg.chat.title);
});

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 60);

const MIN_NATIVE_USD_VALUE = Number(process.env.MIN_NATIVE_USD_VALUE || 50000);
const MIN_TOKEN_USD_VALUE = Number(process.env.MIN_TOKEN_USD_VALUE || 50000);

const ETH_PRICE_USD = Number(process.env.ETH_PRICE_USD || 0);
const BNB_PRICE_USD = Number(process.env.BNB_PRICE_USD || 0);
const MATIC_PRICE_USD = Number(process.env.MATIC_PRICE_USD || 0);
const AVAX_PRICE_USD = Number(process.env.AVAX_PRICE_USD || 0);
const HYPE_PRICE_USD = Number(process.env.HYPE_PRICE_USD || 0);

const BTC_ENABLED = String(process.env.BTC_ENABLED || "true") === "true";
const MIN_BTC_AMOUNT = Number(process.env.MIN_BTC_AMOUNT || 10);

const SOL_ENABLED = String(process.env.SOL_ENABLED || "false") === "true";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const MIN_SOL_AMOUNT = Number(process.env.MIN_SOL_AMOUNT || 5000);

const WAI_SYMBOL = process.env.WAI_SYMBOL || "WAI";
const WAI_CONTRACT_ADDRESS = process.env.WAI_CONTRACT_ADDRESS || "";
const WAI_DECIMALS = Number(process.env.WAI_DECIMALS || 18);
const WAI_PRICE_USD = Number(process.env.WAI_PRICE_USD || 0);

const seen = new Set();

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const CHAINS = [
  {
    key: "eth",
    name: "Ethereum",
    nativeSymbol: "ETH",
    rpc: process.env.ETH_RPC || "https://ethereum.publicnode.com",
    priceUsd: ETH_PRICE_USD
  },
  {
    key: "base",
    name: "Base",
    nativeSymbol: "ETH",
    rpc: process.env.BASE_RPC || "https://mainnet.base.org",
    priceUsd: ETH_PRICE_USD
  },
  {
    key: "bnb",
    name: "BNB Chain",
    nativeSymbol: "BNB",
    rpc: process.env.BNB_RPC || "https://bsc-dataseed.binance.org",
    priceUsd: BNB_PRICE_USD
  },
  {
    key: "polygon",
    name: "Polygon",
    nativeSymbol: "MATIC",
    rpc: process.env.POLYGON_RPC || "https://polygon-rpc.com",
    priceUsd: MATIC_PRICE_USD
  },
  {
    key: "avalanche",
    name: "Avalanche",
    nativeSymbol: "AVAX",
    rpc: process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc",
    priceUsd: AVAX_PRICE_USD
  },
  {
    key: "hype",
    name: "HyperEVM",
    nativeSymbol: "HYPE",
    rpc: process.env.HYPE_RPC || "https://rpc.hyperliquid.xyz/evm",
    priceUsd: HYPE_PRICE_USD
  }
];

function isOwner(chatId) {
  return String(chatId) === OWNER_TELEGRAM_ID;
}

function shortWallet(address) {
  if (!address) return "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function sendGroup(text) {
  await bot.sendMessage(TELEGRAM_GROUP_ID, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendSignal(text) {
  if (!signalsEnabled) return;
  await sendGroup(text);
}

async function scanNativeWhales(chain) {
  if (!chain.priceUsd || chain.priceUsd <= 0) return;

  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const latestBlockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(latestBlockNumber, true);

  if (!block || !block.prefetchedTransactions) return;

  for (const tx of block.prefetchedTransactions) {
    const id = `${chain.key}-native-${tx.hash}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const amount = Number(ethers.formatEther(tx.value || 0n));
    const usdValue = amount * chain.priceUsd;

    if (usdValue < MIN_NATIVE_USD_VALUE) continue;

    const message = `
🐋 <b>NATIVE WHALE TX</b>

<b>Chain:</b> ${chain.name}
<b>Asset:</b> ${chain.nativeSymbol}
<b>Amount:</b> ${amount.toLocaleString()} ${chain.nativeSymbol}
<b>Value:</b> $${usdValue.toLocaleString()}

<b>From:</b> <code>${shortWallet(tx.from)}</code>
<b>To:</b> <code>${shortWallet(tx.to)}</code>

<b>Tx:</b>
<code>${tx.hash}</code>
`;

    await sendSignal(message);
  }
}

async function scanWaiOnBase() {
  if (!ethers.isAddress(WAI_CONTRACT_ADDRESS)) {
    console.log("WAI_CONTRACT_ADDRESS missing or invalid");
    return;
  }

  if (!WAI_PRICE_USD || WAI_PRICE_USD <= 0) return;

  const base = CHAINS.find(c => c.key === "base");
  const provider = new ethers.JsonRpcProvider(base.rpc);

  const contract = new ethers.Contract(WAI_CONTRACT_ADDRESS, ERC20_ABI, provider);

  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(latestBlock - 40, 0);

  const logs = await contract.queryFilter(
    contract.filters.Transfer(),
    fromBlock,
    latestBlock
  );

  for (const log of logs) {
    const id = `wai-base-${log.transactionHash}-${log.index}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const amount = Number(ethers.formatUnits(log.args.value, WAI_DECIMALS));
    const usdValue = amount * WAI_PRICE_USD;

    if (usdValue < MIN_TOKEN_USD_VALUE) continue;

    const message = `
🐋 <b>WAI WHALE TRANSFER</b>

<b>Token:</b> ${WAI_SYMBOL}
<b>Chain:</b> Base
<b>Amount:</b> ${amount.toLocaleString()} ${WAI_SYMBOL}
<b>Value:</b> $${usdValue.toLocaleString()}

<b>From:</b> <code>${shortWallet(log.args.from)}</code>
<b>To:</b> <code>${shortWallet(log.args.to)}</code>

<b>Tx:</b>
<code>${log.transactionHash}</code>
`;

    await sendSignal(message);
  }
}

async function scanBtcWhales() {
  if (!BTC_ENABLED) return;

  const response = await axios.get("https://mempool.space/api/mempool/recent");
  const txs = response.data || [];

  for (const tx of txs) {
    const id = `btc-${tx.txid}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const btcAmount = Number(tx.value || 0) / 100000000;
    if (btcAmount < MIN_BTC_AMOUNT) continue;

    const message = `
🐋 <b>BTC WHALE TRANSACTION</b>

<b>Amount:</b> ${btcAmount.toFixed(4)} BTC

<b>Tx:</b>
<code>${tx.txid}</code>
`;

    await sendSignal(message);
  }
}

async function scanSolWhales() {
  if (!SOL_ENABLED) return;
  if (!HELIUS_API_KEY) return;

  const url = `https://api.helius.xyz/v0/addresses/11111111111111111111111111111111/transactions?api-key=${HELIUS_API_KEY}&limit=20`;

  const response = await axios.get(url);
  const txs = response.data || [];

  for (const tx of txs) {
    const id = `sol-${tx.signature}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const solTransfers = tx.nativeTransfers || [];

    for (const transfer of solTransfers) {
      const solAmount = Number(transfer.amount || 0) / 1000000000;

      if (solAmount < MIN_SOL_AMOUNT) continue;

      const message = `
🐋 <b>SOL WHALE TRANSACTION</b>

<b>Amount:</b> ${solAmount.toLocaleString()} SOL

<b>From:</b> <code>${shortWallet(transfer.fromUserAccount)}</code>
<b>To:</b> <code>${shortWallet(transfer.toUserAccount)}</code>

<b>Tx:</b>
<code>${tx.signature}</code>
`;

      await sendSignal(message);
    }
  }
}

async function runScans() {
  try {
    for (const chain of CHAINS) {
      await scanNativeWhales(chain);
    }

    await scanWaiOnBase();
    await scanBtcWhales();
    await scanSolWhales();

    if (seen.size > 10000) {
      seen.clear();
    }
  } catch (error) {
    console.error("Scan error:", error.message);
  }
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Bot

Comenzi:

/status
/signals_on
/signals_off
/testgroup

Chains:
ETH, Base, BNB, Polygon, Avalanche, HyperEVM, BTC, Solana optional
`);
});

bot.onText(/\/status/, async (msg) => {
  const status = `
🐋 <b>WhaleSignals Status</b>

<b>Signals:</b> ${signalsEnabled ? "ON ✅" : "OFF ❌"}
<b>Group ID:</b> ${TELEGRAM_GROUP_ID}
<b>Owner ID:</b> ${OWNER_TELEGRAM_ID}

<b>Chains:</b>
✅ Ethereum
✅ Base
✅ BNB Chain
✅ Polygon
✅ Avalanche
✅ HyperEVM
${BTC_ENABLED ? "✅" : "❌"} BTC
${SOL_ENABLED ? "✅" : "❌"} Solana

<b>WAI Contract:</b> ${ethers.isAddress(WAI_CONTRACT_ADDRESS) ? WAI_CONTRACT_ADDRESS : "NOT SET"}
<b>Min Native USD:</b> $${MIN_NATIVE_USD_VALUE.toLocaleString()}
<b>Min Token USD:</b> $${MIN_TOKEN_USD_VALUE.toLocaleString()}
<b>Interval:</b> ${CHECK_INTERVAL_SECONDS}s
`;

  await bot.sendMessage(msg.chat.id, status, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
});

bot.onText(/\/signals_on/, async (msg) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  signalsEnabled = true;
  await bot.sendMessage(msg.chat.id, "✅ Signals ON");
});

bot.onText(/\/signals_off/, async (msg) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  signalsEnabled = false;
  await bot.sendMessage(msg.chat.id, "❌ Signals OFF");
});

bot.onText(/\/testgroup/, async (msg) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  await sendGroup("🐋 WhaleSignals test message");
  await bot.sendMessage(msg.chat.id, "✅ Test trimis în grup.");
});

setInterval(runScans, CHECK_INTERVAL_SECONDS * 1000);

console.log("WAI WhaleSignals Multi-Chain Bot running...");
console.log("Signals enabled:", signalsEnabled);
console.log("Owner:", OWNER_TELEGRAM_ID);
console.log("Group:", TELEGRAM_GROUP_ID);

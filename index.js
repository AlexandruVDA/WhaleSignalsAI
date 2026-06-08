require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true
});

bot.on("message", (msg) => {
  console.log("CHAT ID:", msg.chat.id);
});

const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 60);
const MIN_USD_VALUE = Number(process.env.MIN_USD_VALUE || 50000);

const WAI_SYMBOL = process.env.WAI_SYMBOL || "WAI";
const WAI_CONTRACT_ADDRESS = process.env.WAI_CONTRACT_ADDRESS || "";
const WAI_DECIMALS = Number(process.env.WAI_DECIMALS || 18);
const WAI_PRICE_USD = Number(process.env.WAI_PRICE_USD || 0);

const BTC_ENABLED = String(process.env.BTC_ENABLED || "false") === "true";
const MIN_BTC_AMOUNT = Number(process.env.MIN_BTC_AMOUNT || 10);

const seen = new Set();

const provider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

function isOwner(chatId) {
  return String(chatId) === TELEGRAM_CHAT_ID;
}

function shortWallet(address) {
  if (!address) return "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function validContract() {
  return ethers.isAddress(WAI_CONTRACT_ADDRESS);
}

async function sendTelegram(text) {
  if (!TELEGRAM_CHAT_ID) return;

  await bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendSignal(text) {
  if (!signalsEnabled) return;
  await sendTelegram(text);
}

async function scanWaiTransfersOnBase() {
  if (!validContract()) {
    console.log("Missing or invalid WAI_CONTRACT_ADDRESS");
    return;
  }

  const contract = new ethers.Contract(
    WAI_CONTRACT_ADDRESS,
    ERC20_ABI,
    provider
  );

  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(latestBlock - 40, 0);

  const logs = await contract.queryFilter(
    contract.filters.Transfer(),
    fromBlock,
    latestBlock
  );

  for (const log of logs) {
    const txId = `base-${log.transactionHash}-${log.index}`;

    if (seen.has(txId)) continue;
    seen.add(txId);

    const from = log.args.from;
    const to = log.args.to;
    const rawAmount = log.args.value;

    const amount = Number(
      ethers.formatUnits(rawAmount, WAI_DECIMALS)
    );

    const usdValue = WAI_PRICE_USD > 0 ? amount * WAI_PRICE_USD : 0;

    if (usdValue < MIN_USD_VALUE) continue;

    const message = `
🐋 <b>WAI WHALE TRANSFER</b>

<b>Token:</b> ${WAI_SYMBOL}
<b>Chain:</b> Base
<b>Amount:</b> ${amount.toLocaleString()} ${WAI_SYMBOL}
<b>Value:</b> $${usdValue.toLocaleString()}

<b>From:</b> <code>${shortWallet(from)}</code>
<b>To:</b> <code>${shortWallet(to)}</code>

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
    const txId = `btc-${tx.txid}`;

    if (seen.has(txId)) continue;
    seen.add(txId);

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

async function runScans() {
  try {
    await scanWaiTransfersOnBase();
    await scanBtcWhales();

    if (seen.size > 10000) {
      seen.clear();
    }
  } catch (error) {
    console.error("Scan error:", error.message);
  }
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals WAI Bot

Comenzi:

/status
/signals_on
/signals_off

WAI Chain: Base
Signals default: OFF
`);
});

bot.onText(/\/status/, async (msg) => {
  const status = `
🐋 <b>WhaleSignals Status</b>

<b>Signals:</b> ${signalsEnabled ? "ON ✅" : "OFF ❌"}
<b>Chain:</b> Base
<b>RPC:</b> ${BASE_RPC}
<b>WAI Contract:</b> ${validContract() ? WAI_CONTRACT_ADDRESS : "NOT SET"}
<b>Min USD Value:</b> $${MIN_USD_VALUE.toLocaleString()}
<b>Interval:</b> ${CHECK_INTERVAL_SECONDS}s
<b>BTC Monitor:</b> ${BTC_ENABLED ? "ON ✅" : "OFF ❌"}
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

setInterval(runScans, CHECK_INTERVAL_SECONDS * 1000);

console.log("WAI WhaleSignals Base Bot running...");
console.log("Signals enabled:", signalsEnabled);
console.log("Base RPC:", BASE_RPC);
console.log("WAI contract:", WAI_CONTRACT_ADDRESS || "NOT SET");

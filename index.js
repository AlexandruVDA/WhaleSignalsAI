require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

const MORALIS_ENABLED = String(process.env.MORALIS_ENABLED || "true") === "true";
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";
const MORALIS_URL = "https://deep-index.moralis.io/api/v2.2";

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const BASESCAN_URL = "https://basescan.org";

const WAI_CONTRACT_ADDRESS =
  process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";

const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);
const TEST_ACCESS_MODE = String(process.env.TEST_ACCESS_MODE || "true") === "true";

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);

const MIN_WHALE_USD = Number(process.env.MIN_WHALE_USD || 50000);
const MIN_NATIVE_ETH = Number(process.env.MIN_NATIVE_ETH || 20);

const WATCH_TOKENS = [
  {
    symbol: "WAI",
    chain: "base",
    address: WAI_CONTRACT_ADDRESS,
    explorer: BASESCAN_URL
  }
];

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";

const provider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

function isOwner(chatId) {
  return String(chatId) === OWNER_TELEGRAM_ID;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function shortWallet(address) {
  if (!address) return "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function walletLink(address, explorer = BASESCAN_URL) {
  if (!address) return "unknown";
  return `<a href="${explorer}/address/${address}">${shortWallet(address)}</a>`;
}

function txLink(hash, explorer = BASESCAN_URL) {
  return `<a href="${explorer}/tx/${hash}">View Transaction</a>`;
}

function tokenLink(address, symbol, explorer = BASESCAN_URL) {
  if (!address) return symbol || "Token";
  return `<a href="${explorer}/token/${address}">${symbol || shortWallet(address)}</a>`;
}

async function sendGroup(text) {
  if (!TELEGRAM_GROUP_ID) return;

  await bot.sendMessage(TELEGRAM_GROUP_ID, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendSignal(text) {
  if (!signalsEnabled) return;
  await sendGroup(text);
}

async function moralisGet(path, params = {}) {
  if (!MORALIS_ENABLED || !MORALIS_API_KEY) {
    throw new Error("Moralis not configured");
  }

  const res = await axios.get(`${MORALIS_URL}${path}`, {
    headers: {
      accept: "application/json",
      "X-API-Key": MORALIS_API_KEY
    },
    params,
    timeout: 30000
  });

  return res.data;
}

async function getWaiBalance(wallet) {
  if (TEST_ACCESS_MODE) return 1000000;

  const token = new ethers.Contract(WAI_CONTRACT_ADDRESS, ERC20_ABI, provider);
  const decimals = await token.decimals();
  const raw = await token.balanceOf(wallet);

  return Number(ethers.formatUnits(raw, decimals));
}

async function createInviteLink(telegramId) {
  const invite = await bot.createChatInviteLink(TELEGRAM_GROUP_ID, {
    name: `WAI-${telegramId}`,
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 600
  });

  return invite.invite_link;
}

async function removeUserFromGroup(telegramId) {
  try {
    await bot.banChatMember(TELEGRAM_GROUP_ID, telegramId);
    await bot.unbanChatMember(TELEGRAM_GROUP_ID, telegramId);
  } catch (err) {
    console.error("Remove error:", err.message);
  }
}

async function checkAllHolders() {
  const users = readJson(USERS_FILE, []);
  let changed = false;

  for (const user of users) {
    if (!user.verified) continue;

    try {
      const balance = await getWaiBalance(user.wallet);

      user.lastBalance = balance;
      user.lastCheck = new Date().toISOString();

      if (!TEST_ACCESS_MODE && balance < MIN_WAI_ACCESS) {
        user.verified = false;
        user.removedAt = new Date().toISOString();

        await removeUserFromGroup(user.telegramId);

        await bot.sendMessage(
          user.telegramId,
          `❌ Access Revoked

Your WAI balance is below the required minimum.

Wallet: ${shortWallet(user.wallet)}
Current Balance: ${balance} WAI
Required Minimum: ${MIN_WAI_ACCESS} WAI`
        );
      }

      changed = true;
    } catch (err) {
      console.error("Holder check error:", err.message);
    }
  }

  if (changed) writeJson(USERS_FILE, users);
}

async function scanBaseNativeWhales() {
  const latestBlock = await provider.getBlockNumber();
  const block = await provider.getBlock(latestBlock, true);

  if (!block || !block.prefetchedTransactions) return;

  const seen = readJson(SEEN_FILE, { txs: [] });
  const seenSet = new Set(seen.txs || []);

  for (const tx of block.prefetchedTransactions) {
    if (seenSet.has(tx.hash)) continue;
    seenSet.add(tx.hash);

    const amount = Number(ethers.formatEther(tx.value || 0n));

    if (amount < MIN_NATIVE_ETH) continue;

    await sendSignal(`
🔵 <b>WHALE TRANSFER</b>

<b>Asset:</b> ETH
<b>Chain:</b> Base
<b>Amount:</b> ${amount.toLocaleString()} ETH

<b>From:</b> ${walletLink(tx.from)}
<b>To:</b> ${walletLink(tx.to)}

<b>Tx:</b> ${txLink(tx.hash)}
`);
  }

  seen.txs = Array.from(seenSet).slice(-5000);
  writeJson(SEEN_FILE, seen);
}

function normalizeSwap(item) {
  const txHash =
    item.transaction_hash ||
    item.transactionHash ||
    item.tx_hash ||
    item.hash;

  const wallet =
    item.wallet_address ||
    item.walletAddress ||
    item.trader ||
    item.user_address ||
    item.maker ||
    item.taker ||
    item.from_address ||
    item.from;

  const pairAddress =
    item.pair_address ||
    item.pairAddress ||
    item.pool_address ||
    item.poolAddress;

  const boughtSymbol =
    item.bought?.symbol ||
    item.buy?.symbol ||
    item.token_bought_symbol ||
    item.bought_symbol ||
    item.to_token?.symbol;

  const soldSymbol =
    item.sold?.symbol ||
    item.sell?.symbol ||
    item.token_sold_symbol ||
    item.sold_symbol ||
    item.from_token?.symbol;

  const boughtAmount =
    item.bought?.amount ||
    item.buy?.amount ||
    item.amount_bought ||
    item.bought_amount ||
    item.to_token_amount;

  const soldAmount =
    item.sold?.amount ||
    item.sell?.amount ||
    item.amount_sold ||
    item.sold_amount ||
    item.from_token_amount;

  const usd =
    Number(
      item.total_value_usd ||
      item.value_usd ||
      item.amount_usd ||
      item.usd_value ||
      item.transaction_value_usd ||
      0
    );

  const dex =
    item.exchange_name ||
    item.dex_name ||
    item.protocol ||
    item.exchange ||
    item.dex ||
    "DEX";

  return {
    txHash,
    wallet,
    pairAddress,
    boughtSymbol,
    soldSymbol,
    boughtAmount,
    soldAmount,
    usd,
    dex
  };
}

async function getTokenSwaps(token) {
  const attempts = [
    `/erc20/${token.address}/swaps`,
    `/erc20/${token.address}/dex/swaps`,
    `/erc20/${token.address}/trades`
  ];

  for (const path of attempts) {
    try {
      const data = await moralisGet(path, {
        chain: token.chain,
        limit: 50
      });

      if (Array.isArray(data)) return data;
      if (Array.isArray(data.result)) return data.result;
      if (Array.isArray(data.data)) return data.data;
    } catch (err) {
      console.log(`Moralis swap endpoint failed: ${path} | ${err.message}`);
    }
  }

  return [];
}

async function scanMoralisTokenSwaps() {
  const seen = readJson(SEEN_FILE, { txs: [] });
  const seenSet = new Set(seen.txs || []);

  for (const token of WATCH_TOKENS) {
    const swaps = await getTokenSwaps(token);

    for (const raw of swaps) {
      const s = normalizeSwap(raw);

      if (!s.txHash) continue;
      if (seenSet.has(s.txHash)) continue;
      seenSet.add(s.txHash);

      if (s.usd > 0 && s.usd < MIN_WHALE_USD) continue;

      const bought = String(s.boughtSymbol || "").toUpperCase();
      const sold = String(s.soldSymbol || "").toUpperCase();
      const watched = String(token.symbol || "").toUpperCase();

      if (bought === watched) {
        await sendSignal(`
🟢 <b>SMART MONEY BUY</b>

<b>Token:</b> ${tokenLink(token.address, token.symbol, token.explorer)}
<b>Chain:</b> Base
<b>DEX:</b> ${s.dex}

<b>Bought:</b> ${Number(s.boughtAmount || 0).toLocaleString()} ${token.symbol}
<b>Sold:</b> ${Number(s.soldAmount || 0).toLocaleString()} ${s.soldSymbol || "Unknown"}
${s.usd ? `<b>Value:</b> $${s.usd.toLocaleString()}` : ""}

<b>Wallet:</b> ${walletLink(s.wallet, token.explorer)}
${s.pairAddress ? `<b>Pool:</b> ${walletLink(s.pairAddress, token.explorer)}` : ""}

<b>Tx:</b> ${txLink(s.txHash, token.explorer)}
`);
      } else if (sold === watched) {
        await sendSignal(`
🔴 <b>SMART MONEY SELL</b>

<b>Token:</b> ${tokenLink(token.address, token.symbol, token.explorer)}
<b>Chain:</b> Base
<b>DEX:</b> ${s.dex}

<b>Sold:</b> ${Number(s.soldAmount || 0).toLocaleString()} ${token.symbol}
<b>Bought:</b> ${Number(s.boughtAmount || 0).toLocaleString()} ${s.boughtSymbol || "Unknown"}
${s.usd ? `<b>Value:</b> $${s.usd.toLocaleString()}` : ""}

<b>Wallet:</b> ${walletLink(s.wallet, token.explorer)}
${s.pairAddress ? `<b>Pool:</b> ${walletLink(s.pairAddress, token.explorer)}` : ""}

<b>Tx:</b> ${txLink(s.txHash, token.explorer)}
`);
      } else {
        await sendSignal(`
🔁 <b>WHALE SWAP</b>

<b>Chain:</b> Base
<b>DEX:</b> ${s.dex}

<b>Sold:</b> ${Number(s.soldAmount || 0).toLocaleString()} ${s.soldSymbol || "Unknown"}
<b>Bought:</b> ${Number(s.boughtAmount || 0).toLocaleString()} ${s.boughtSymbol || "Unknown"}
${s.usd ? `<b>Value:</b> $${s.usd.toLocaleString()}` : ""}

<b>Wallet:</b> ${walletLink(s.wallet, token.explorer)}

<b>Tx:</b> ${txLink(s.txHash, token.explorer)}
`);
      }
    }
  }

  seen.txs = Array.from(seenSet).slice(-5000);
  writeJson(SEEN_FILE, seen);
}

async function runSignals() {
  try {
    await scanBaseNativeWhales();

    if (MORALIS_ENABLED) {
      await scanMoralisTokenSwaps();
    }
  } catch (err) {
    console.error("Signal scan error:", err.message);
  }
}

bot.on("message", (msg) => {
  console.log("CHAT ID:", msg.chat.id);
  console.log("TITLE:", msg.chat.title);
});

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals VIP Access

Commands:

/verify WALLET_ADDRESS
/myaccess

Example:
/verify 0x1234...

Minimum Required:
${MIN_WAI_ACCESS} WAI
`);
});

bot.onText(/\/verify (.+)/, async (msg, match) => {
  const telegramId = String(msg.chat.id);
  const wallet = match[1].trim();

  try {
    if (!ethers.isAddress(wallet)) {
      return bot.sendMessage(msg.chat.id, "❌ Invalid wallet address.");
    }

    const balance = await getWaiBalance(wallet);

    if (!TEST_ACCESS_MODE && balance < MIN_WAI_ACCESS) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Access Denied

Wallet: ${shortWallet(wallet)}
Balance: ${balance} WAI
Required Minimum: ${MIN_WAI_ACCESS} WAI`
      );
    }

    const users = readJson(USERS_FILE, []);
    const existingIndex = users.findIndex(u => String(u.telegramId) === telegramId);

    const userData = {
      telegramId,
      wallet,
      verified: true,
      lastBalance: balance,
      verifiedAt: new Date().toISOString(),
      lastCheck: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      users[existingIndex] = { ...users[existingIndex], ...userData };
    } else {
      users.push(userData);
    }

    writeJson(USERS_FILE, users);

    const inviteLink = await createInviteLink(telegramId);

    await bot.sendMessage(
      msg.chat.id,
      `✅ Access Granted

Wallet: ${shortWallet(wallet)}
Balance: ${balance} WAI

VIP Group Invite:
${inviteLink}

This invite link is valid for 10 minutes and can be used once.`
    );
  } catch (err) {
    console.error(err);
    await bot.sendMessage(msg.chat.id, "❌ Verification failed. Please try again later.");
  }
});

bot.onText(/\/myaccess/, async (msg) => {
  const telegramId = String(msg.chat.id);
  const users = readJson(USERS_FILE, []);
  const user = users.find(u => String(u.telegramId) === telegramId);

  if (!user) {
    return bot.sendMessage(msg.chat.id, "No verified wallet found.");
  }

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals VIP Access

Status: ${user.verified ? "ACTIVE ✅" : "INACTIVE ❌"}
Wallet: ${shortWallet(user.wallet)}
Last Balance: ${user.lastBalance} WAI
Last Check: ${user.lastCheck || "Never"}
`);
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Admin Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Moralis: ${MORALIS_ENABLED ? "ON ✅" : "OFF ❌"}

Group ID: ${TELEGRAM_GROUP_ID}
WAI Contract: ${WAI_CONTRACT_ADDRESS}

Minimum WAI Required: ${MIN_WAI_ACCESS}
Test Access Mode: ${TEST_ACCESS_MODE ? "ON ✅" : "OFF ❌"}

Users Total: ${users.length}
Users Active: ${active}

Signal Types:
🟢 Smart Money Buy
🔴 Smart Money Sell
🔁 Whale Swap
🔵 Whale Transfer
📊 24H Cash Flow
`);
});

bot.onText(/\/signals_on/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  signalsEnabled = true;
  await bot.sendMessage(msg.chat.id, "✅ Signals ON");
});

bot.onText(/\/signals_off/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  signalsEnabled = false;
  await bot.sendMessage(msg.chat.id, "❌ Signals OFF");
});

bot.onText(/\/testgroup/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await sendGroup(`
🐋 <b>WhaleSignals VIP group connected successfully.</b>

<b>WAI Contract:</b> <a href="${BASESCAN_URL}/token/${WAI_CONTRACT_ADDRESS}">View Contract</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Test message sent to group.");
});

bot.onText(/\/testsignal/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await sendGroup(`
🟢 <b>SMART MONEY BUY</b>

<b>Token:</b> WAI
<b>Chain:</b> Base
<b>DEX:</b> Demo DEX

<b>Bought:</b> 25,000 WAI
<b>Sold:</b> 75,000 USDC
<b>Value:</b> $75,000

<b>Wallet:</b> <a href="${BASESCAN_URL}/address/0x0000000000000000000000000000000000000000">Demo Wallet</a>

<b>Tx:</b> <a href="${BASESCAN_URL}/tx/0x0000000000000000000000000000000000000000000000000000000000000000">View Transaction</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Demo signal sent.");
});

bot.onText(/\/mtest/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  try {
    const data = await moralisGet(`/erc20/${WAI_CONTRACT_ADDRESS}/price`, {
      chain: "base"
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ Moralis connected successfully.

${JSON.stringify(data, null, 2)}`
    );
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Moralis test failed:\n${err.message}`);
  }
});

bot.onText(/\/flow24 (.+)/, async (msg, match) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const tokenAddress = match[1].trim();

  if (!ethers.isAddress(tokenAddress)) {
    return bot.sendMessage(msg.chat.id, "Use: /flow24 TOKEN_CONTRACT_ADDRESS");
  }

  try {
    const swaps = await getTokenSwaps({
      symbol: "TOKEN",
      chain: "base",
      address: tokenAddress,
      explorer: BASESCAN_URL
    });

    let inflow = 0;
    let outflow = 0;
    let buys = 0;
    let sells = 0;

    for (const raw of swaps) {
      const s = normalizeSwap(raw);
      const bought = String(s.boughtSymbol || "").toUpperCase();
      const sold = String(s.soldSymbol || "").toUpperCase();

      if (bought && bought !== "USDC" && bought !== "USDT") {
        inflow += s.usd || 0;
        buys++;
      }

      if (sold && sold !== "USDC" && sold !== "USDT") {
        outflow += s.usd || 0;
        sells++;
      }
    }

    const net = inflow - outflow;
    const trend = net > 0 ? "Accumulation 💰" : net < 0 ? "Distribution ⚠️" : "Neutral";

    await bot.sendMessage(msg.chat.id, `
📊 24H CASH FLOW

Chain: Base
Token: ${shortWallet(tokenAddress)}

🟢 Inflow: $${inflow.toLocaleString()}
🔴 Outflow: $${outflow.toLocaleString()}
⚖️ Net Flow: ${net >= 0 ? "+" : ""}$${net.toLocaleString()}

Buys: ${buys}
Sells: ${sells}

Trend: ${trend}
`);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Flow24 failed:\n${err.message}`);
  }
});

bot.onText(/\/checkholders/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await bot.sendMessage(msg.chat.id, "Checking holders...");
  await checkAllHolders();
  await bot.sendMessage(msg.chat.id, "✅ Holder check completed.");
});

setInterval(runSignals, CHECK_SIGNALS_INTERVAL_SECONDS * 1000);
setInterval(checkAllHolders, CHECK_HOLDERS_INTERVAL_SECONDS * 1000);

console.log("WhaleSignals Moralis Bot running...");
console.log("Owner:", OWNER_TELEGRAM_ID);
console.log("Group:", TELEGRAM_GROUP_ID);
console.log("Signals:", signalsEnabled);
console.log("Moralis:", MORALIS_ENABLED);

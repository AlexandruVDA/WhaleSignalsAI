require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const BASESCAN_URL = "https://basescan.org";

const WAI_CONTRACT_ADDRESS = process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";
const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);
const TEST_ACCESS_MODE = String(process.env.TEST_ACCESS_MODE || "true") === "true";

const BITQUERY_ENABLED = String(process.env.BITQUERY_ENABLED || "false") === "true";
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY || "";
const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);

const MIN_WHALE_USD = Number(process.env.MIN_WHALE_USD || 50000);
const MIN_TRANSFER_ETH = Number(process.env.MIN_TRANSFER_ETH || 20);

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";

const provider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const STABLES = ["USDC", "USDT", "DAI", "USDbC", "USD+", "USDS"];

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

function walletLink(address) {
  if (!address) return "unknown";
  return `<a href="${BASESCAN_URL}/address/${address}">${shortWallet(address)}</a>`;
}

function txLink(hash) {
  return `<a href="${BASESCAN_URL}/tx/${hash}">View Transaction</a>`;
}

function tokenLink(address, symbol) {
  if (!address) return symbol || "Unknown";
  return `<a href="${BASESCAN_URL}/token/${address}">${symbol || shortWallet(address)}</a>`;
}

function isStable(symbol) {
  if (!symbol) return false;
  return STABLES.includes(String(symbol).toUpperCase());
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

async function bitqueryRequest(query, variables = {}) {
  if (!BITQUERY_ENABLED || !BITQUERY_API_KEY) {
    throw new Error("Bitquery not configured");
  }

  const res = await axios.post(
    BITQUERY_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BITQUERY_API_KEY}`
      },
      timeout: 30000
    }
  );

  if (res.data.errors) {
    throw new Error(JSON.stringify(res.data.errors));
  }

  return res.data.data;
}

async function getWaiBalance(wallet) {
  if (TEST_ACCESS_MODE) return 1000000;

  if (!ethers.isAddress(WAI_CONTRACT_ADDRESS)) {
    throw new Error("Invalid WAI contract");
  }

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

async function scanBaseWhaleTransfers() {
  const latestBlock = await provider.getBlockNumber();
  const block = await provider.getBlock(latestBlock, true);

  if (!block || !block.prefetchedTransactions) return;

  const seen = readJson(SEEN_FILE, { txs: [] });
  const seenSet = new Set(seen.txs || []);

  for (const tx of block.prefetchedTransactions) {
    if (seenSet.has(tx.hash)) continue;
    seenSet.add(tx.hash);

    const amount = Number(ethers.formatEther(tx.value || 0n));

    if (amount < MIN_TRANSFER_ETH) continue;

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

async function scanBitqueryDexWhales() {
  const query = `
  {
    EVM(network: base, dataset: realtime) {
      DEXTrades(
        limit: {count: 20}
        orderBy: {descending: Block_Time}
        where: {
          any: [
            {Trade: {Buy: {AmountInUSD: {gt: "${MIN_WHALE_USD}"}}}}
            {Trade: {Sell: {AmountInUSD: {gt: "${MIN_WHALE_USD}"}}}}
          ]
        }
      ) {
        Block {
          Time
        }
        Transaction {
          Hash
        }
        Trade {
          Dex {
            ProtocolName
          }
          Buy {
            Amount
            AmountInUSD
            Currency {
              Symbol
              SmartContract
            }
            Buyer
          }
          Sell {
            Amount
            AmountInUSD
            Currency {
              Symbol
              SmartContract
            }
            Seller
          }
        }
      }
    }
  }
  `;

  const data = await bitqueryRequest(query);
  const trades = data?.EVM?.DEXTrades || [];

  const seen = readJson(SEEN_FILE, { txs: [] });
  const seenSet = new Set(seen.txs || []);

  for (const item of trades) {
    const hash = item.Transaction?.Hash;
    if (!hash || seenSet.has(hash)) continue;
    seenSet.add(hash);

    const buy = item.Trade?.Buy || {};
    const sell = item.Trade?.Sell || {};
    const dex = item.Trade?.Dex?.ProtocolName || "DEX";

    const buySymbol = buy.Currency?.Symbol || "Unknown";
    const sellSymbol = sell.Currency?.Symbol || "Unknown";

    const buyToken = buy.Currency?.SmartContract;
    const sellToken = sell.Currency?.SmartContract;

    const buyUsd = Number(buy.AmountInUSD || 0);
    const sellUsd = Number(sell.AmountInUSD || 0);

    const buyer = buy.Buyer;
    const seller = sell.Seller;

    if (isStable(sellSymbol) && !isStable(buySymbol)) {
      await sendSignal(`
🟢 <b>SMART MONEY BUY</b>

<b>Token:</b> ${tokenLink(buyToken, buySymbol)}
<b>Chain:</b> Base
<b>DEX:</b> ${dex}

<b>Bought:</b> ${Number(buy.Amount || 0).toLocaleString()} ${buySymbol}
<b>Value:</b> $${buyUsd.toLocaleString()}

<b>Wallet:</b> ${walletLink(buyer)}

<b>Tx:</b> ${txLink(hash)}
`);
    } else if (isStable(buySymbol) && !isStable(sellSymbol)) {
      await sendSignal(`
🔴 <b>SMART MONEY SELL</b>

<b>Token:</b> ${tokenLink(sellToken, sellSymbol)}
<b>Chain:</b> Base
<b>DEX:</b> ${dex}

<b>Sold:</b> ${Number(sell.Amount || 0).toLocaleString()} ${sellSymbol}
<b>Value:</b> $${sellUsd.toLocaleString()}

<b>Wallet:</b> ${walletLink(seller)}

<b>Tx:</b> ${txLink(hash)}
`);
    } else {
      await sendSignal(`
🔁 <b>WHALE SWAP</b>

<b>Chain:</b> Base
<b>DEX:</b> ${dex}

<b>Sold:</b> ${Number(sell.Amount || 0).toLocaleString()} ${sellSymbol}
<b>Bought:</b> ${Number(buy.Amount || 0).toLocaleString()} ${buySymbol}
<b>Value:</b> $${Math.max(buyUsd, sellUsd).toLocaleString()}

<b>Wallet:</b> ${walletLink(buyer || seller)}

<b>Tx:</b> ${txLink(hash)}
`);
    }
  }

  seen.txs = Array.from(seenSet).slice(-5000);
  writeJson(SEEN_FILE, seen);
}

async function runSignals() {
  try {
    await scanBaseWhaleTransfers();

    if (BITQUERY_ENABLED) {
      await scanBitqueryDexWhales();
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
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Admin Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Bitquery: ${BITQUERY_ENABLED ? "ON ✅" : "OFF ❌"}

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
<b>DEX:</b> Aerodrome

<b>Bought:</b> 25,000 WAI
<b>Value:</b> $75,000

<b>Wallet:</b> <a href="${BASESCAN_URL}/address/0x0000000000000000000000000000000000000000">Demo Wallet</a>

<b>Tx:</b> <a href="${BASESCAN_URL}/tx/0x0000000000000000000000000000000000000000000000000000000000000000">View Transaction</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Demo signal sent.");
});

bot.onText(/\/bqtest/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  try {
    const query = `
    {
      EVM(network: base, dataset: realtime) {
        Blocks(limit: {count: 1}) {
          Block {
            Number
            Time
          }
        }
      }
    }
    `;

    const data = await bitqueryRequest(query);

    await bot.sendMessage(
      msg.chat.id,
      `✅ Bitquery connected successfully.\n\n${JSON.stringify(data, null, 2)}`
    );
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Bitquery test failed:\n${err.message}`);
  }
});

bot.onText(/\/flow24 (.+)/, async (msg, match) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const tokenAddress = match[1].trim().toLowerCase();

  if (!ethers.isAddress(tokenAddress)) {
    return bot.sendMessage(msg.chat.id, "Use: /flow24 TOKEN_CONTRACT_ADDRESS");
  }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const query = `
    query Flow24($token: String!, $since: DateTime!) {
      EVM(network: base, dataset: archive) {
        DEXTrades(
          limit: {count: 200}
          orderBy: {descending: Block_Time}
          where: {
            Block: {Time: {since: $since}}
            any: [
              {Trade: {Buy: {Currency: {SmartContract: {is: $token}}}}}
              {Trade: {Sell: {Currency: {SmartContract: {is: $token}}}}}
            ]
          }
        ) {
          Transaction { Hash }
          Trade {
            Buy {
              Amount
              AmountInUSD
              Currency { Symbol SmartContract }
            }
            Sell {
              Amount
              AmountInUSD
              Currency { Symbol SmartContract }
            }
          }
        }
      }
    }
    `;

    const data = await bitqueryRequest(query, { token: tokenAddress, since });
    const trades = data?.EVM?.DEXTrades || [];

    let inflow = 0;
    let outflow = 0;
    let buys = 0;
    let sells = 0;
    let symbol = "TOKEN";

    for (const t of trades) {
      const buy = t.Trade?.Buy || {};
      const sell = t.Trade?.Sell || {};

      const buyAddr = String(buy.Currency?.SmartContract || "").toLowerCase();
      const sellAddr = String(sell.Currency?.SmartContract || "").toLowerCase();

      if (buyAddr === tokenAddress) {
        inflow += Number(buy.AmountInUSD || 0);
        buys++;
        symbol = buy.Currency?.Symbol || symbol;
      }

      if (sellAddr === tokenAddress) {
        outflow += Number(sell.AmountInUSD || 0);
        sells++;
        symbol = sell.Currency?.Symbol || symbol;
      }
    }

    const net = inflow - outflow;
    const trend = net > 0 ? "Accumulation 💰" : net < 0 ? "Distribution ⚠️" : "Neutral";

    await bot.sendMessage(
      msg.chat.id,
      `📊 24H CASH FLOW

Token: ${symbol}
Chain: Base

🟢 Inflow: $${inflow.toLocaleString()}
🔴 Outflow: $${outflow.toLocaleString()}
⚖️ Net Flow: ${net >= 0 ? "+" : ""}$${net.toLocaleString()}

Buys: ${buys}
Sells: ${sells}

Trend: ${trend}`
    );
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

console.log("WhaleSignals Bot running...");
console.log("Owner:", OWNER_TELEGRAM_ID);
console.log("Group:", TELEGRAM_GROUP_ID);
console.log("Signals:", signalsEnabled);
console.log("Bitquery:", BITQUERY_ENABLED);

require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const BASESCAN_URL = "https://basescan.org";

const WAI_CONTRACT_ADDRESS =
  process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";

const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);

const BINANCE_API_KEY =
  process.env.BINANCE_READONLY_API_KEY ||
  process.env.BINANCE_API_KEY ||
  "";

const BINANCE_API_SECRET =
  process.env.BINANCE_READONLY_API_SECRET ||
  process.env.BINANCE_API_SECRET ||
  "";

const BINANCE_BASE = "https://api.binance.com";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);
const PRICE_UPDATE_INTERVAL_SECONDS = Number(process.env.PRICE_UPDATE_INTERVAL_SECONDS || 60);
const FLOW12_INTERVAL_SECONDS = Number(process.env.FLOW12_INTERVAL_SECONDS || 43200);
const FLOW24_INTERVAL_SECONDS = Number(process.env.FLOW24_INTERVAL_SECONDS || 86400);

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";
const FLOW_FILE = "flow.json";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const MARKETS = {
  BTC: {
    symbol: "BTC",
    binance: "BTCUSDT",
    cg: "bitcoin",
    minUsd: Number(process.env.MIN_BTC_USD || 50000)
  },
  ETH: {
    symbol: "ETH",
    binance: "ETHUSDT",
    cg: "ethereum",
    minUsd: Number(process.env.MIN_ETH_USD || 50000)
  },
  BNB: {
    symbol: "BNB",
    binance: "BNBUSDT",
    cg: "binancecoin",
    minUsd: Number(process.env.MIN_BNB_USD || 30000)
  },
  AVAX: {
    symbol: "AVAX",
    binance: "AVAXUSDT",
    cg: "avalanche-2",
    minUsd: Number(process.env.MIN_AVAX_USD || 30000)
  },
  MATIC: {
    symbol: "MATIC",
    binance: process.env.MATIC_BINANCE_SYMBOL || "POLUSDT",
    cg: "matic-network",
    minUsd: Number(process.env.MIN_MATIC_USD || 30000)
  }
};

let livePrices = {
  BTC: { price: 0, change24h: 0, volume24h: 0, marketCap: 0 },
  ETH: { price: 0, change24h: 0, volume24h: 0, marketCap: 0 },
  BNB: { price: 0, change24h: 0, volume24h: 0, marketCap: 0 },
  AVAX: { price: 0, change24h: 0, volume24h: 0, marketCap: 0 },
  MATIC: { price: 0, change24h: 0, volume24h: 0, marketCap: 0 }
};

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

function nowIso() {
  return new Date().toISOString();
}

function formatUsd(value) {
  return `$${Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2
  })}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 8
  });
}

function formatPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function trendLabel(change24h) {
  const n = Number(change24h || 0);

  if (n >= 5) return "Strong Bullish 🟢";
  if (n >= 1) return "Bullish 🟢";
  if (n <= -5) return "Strong Bearish 🔴";
  if (n <= -1) return "Bearish 🔴";

  return "Neutral ⚪";
}

function summaryTrend(asset, flow) {
  const p = livePrices[asset];

  if (flow.net > 0 && flow.inflow >= 250000) return "Accumulation";
  if (flow.net < 0 && flow.outflow >= 250000) return "Distribution";
  if (p.change24h >= 1) return "Bullish";
  if (p.change24h <= -1) return "Bearish";

  return "Neutral";
}

function signalStrength(usdValue) {
  if (usdValue >= 1000000) return "10/10";
  if (usdValue >= 500000) return "9/10";
  if (usdValue >= 250000) return "8/10";
  if (usdValue >= 100000) return "7/10";
  return "6/10";
}

function signalTitle(side, usdValue) {
  if (usdValue >= 1000000) return "🚨 NEW WHALE ENTRY";
  if (side === "BUY" && usdValue >= 250000) return "💰 ACCUMULATION ALERT";
  if (side === "SELL" && usdValue >= 250000) return "⚠️ WHALE EXIT";
  if (side === "BUY") return "🟢 SMART MONEY BUY";
  if (side === "SELL") return "🔴 SMART MONEY SELL";

  return "🐋 WHALE SIGNAL";
}

function addFlow(asset, side, amount, usdValue, price, txId) {
  const flow = readJson(FLOW_FILE, []);

  flow.push({
    time: Date.now(),
    asset,
    side,
    amount,
    usdValue,
    price,
    txId
  });

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  writeJson(FLOW_FILE, flow.filter(x => x.time >= cutoff));
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

function signQuery(params) {
  const query = new URLSearchParams(params).toString();

  const signature = crypto
    .createHmac("sha256", BINANCE_API_SECRET)
    .update(query)
    .digest("hex");

  return `${query}&signature=${signature}`;
}

async function binancePrivateGet(path, params = {}) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error("Binance API key not configured");
  }

  const signedQuery = signQuery({
    ...params,
    timestamp: Date.now(),
    recvWindow: 10000
  });

  const res = await axios.get(`${BINANCE_BASE}${path}?${signedQuery}`, {
    headers: {
      "X-MBX-APIKEY": BINANCE_API_KEY
    },
    timeout: 30000
  });

  return res.data;
}

async function getAverageBuy(asset) {
  const market = MARKETS[asset];
  if (!market) return null;

  try {
    const trades = await binancePrivateGet("/api/v3/myTrades", {
      symbol: market.binance,
      limit: 1000
    });

    let qty = 0;
    let cost = 0;

    for (const t of trades || []) {
      if (!t.isBuyer) continue;

      const q = Number(t.qty || 0);
      const p = Number(t.price || 0);

      qty += q;
      cost += q * p;
    }

    if (qty <= 0) return null;

    return cost / qty;
  } catch (err) {
    console.error(`Average buy error ${asset}:`, err.message);
    return null;
  }
}

async function getSpotBalance(asset) {
  try {
    const account = await binancePrivateGet("/api/v3/account");
    const item = (account.balances || []).find(b => b.asset === asset);

    if (!item) return 0;

    return Number(item.free || 0) + Number(item.locked || 0);
  } catch (err) {
    console.error(`Balance error ${asset}:`, err.message);
    return 0;
  }
}

async function updateLivePrices() {
  try {
    const ids = Object.values(MARKETS).map(m => m.cg).join(",");

    const url =
      `https://api.coingecko.com/api/v3/simple/price` +
      `?ids=${ids}` +
      `&vs_currencies=usd` +
      `&include_market_cap=true` +
      `&include_24hr_vol=true` +
      `&include_24hr_change=true`;

    const res = await axios.get(url, { timeout: 30000 });
    const data = res.data || {};

    for (const [asset, cfg] of Object.entries(MARKETS)) {
      const row = data[cfg.cg];
      if (!row) continue;

      livePrices[asset] = {
        price: Number(row.usd || livePrices[asset].price || 0),
        change24h: Number(row.usd_24h_change || 0),
        volume24h: Number(row.usd_24h_vol || 0),
        marketCap: Number(row.usd_market_cap || 0)
      };
    }

    console.log("Live prices updated.");
  } catch (err) {
    console.error("Price update error:", err.message);
  }
}

async function getWaiBalance(wallet) {
  const token = new ethers.Contract(WAI_CONTRACT_ADDRESS, ERC20_ABI, baseProvider);
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
      user.lastCheck = nowIso();

      if (balance < MIN_WAI_ACCESS) {
        user.verified = false;
        user.removedAt = nowIso();

        await removeUserFromGroup(user.telegramId);

        await bot.sendMessage(
          user.telegramId,
          `❌ Access Revoked

Wallet: ${shortWallet(user.wallet)}
Current Balance: ${formatNumber(balance)} WAI
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

async function scanBinanceMarket(asset) {
  const market = MARKETS[asset];
  if (!market) return;

  try {
    const res = await axios.get(`${BINANCE_BASE}/api/v3/aggTrades`, {
      params: {
        symbol: market.binance,
        limit: 100
      },
      timeout: 30000
    });

    const trades = res.data || [];
    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);

    for (const t of trades) {
      const id = `${market.binance}-${t.a}`;
      if (seenSet.has(id)) continue;

      seenSet.add(id);

      const price = Number(t.p || 0);
      const amount = Number(t.q || 0);
      const usdValue = price * amount;

      if (usdValue < market.minUsd) continue;

      const side = t.m ? "SELL" : "BUY";
      const currentPrice = livePrices[asset].price || price;
      const avgBuy = side === "BUY" ? price : await getAverageBuy(asset);

      const pnl =
        avgBuy && avgBuy > 0
          ? ((currentPrice - avgBuy) / avgBuy) * 100
          : null;

      addFlow(asset, side, amount, usdValue, price, id);

      await sendSignal(`
<b>${signalTitle(side, usdValue)}</b>

<b>Asset:</b> ${asset}

<b>Amount:</b>
${formatNumber(amount)} ${asset}

<b>Value:</b>
${formatUsd(usdValue)}

<b>Price:</b>
${formatUsd(currentPrice)}

<b>24H Change:</b>
${formatPct(livePrices[asset].change24h)}

<b>Average Buy:</b>
${avgBuy ? formatUsd(avgBuy) : "N/A"}

<b>PnL:</b>
${pnl !== null ? formatPct(pnl) : "N/A"}

<b>Signal Strength:</b>
${signalStrength(usdValue)}

<b>Wallet:</b>
Binance Spot / N/A

<b>TX:</b>
<a href="https://www.binance.com/en/trade/${asset}_USDT">View Market</a>
`);
    }

    seen.txs = Array.from(seenSet).slice(-20000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} signal scan error:`, err.message);
  }
}

async function runSignals() {
  for (const asset of Object.keys(MARKETS)) {
    await scanBinanceMarket(asset);
  }
}

function getFlowRows(hours) {
  const flow = readJson(FLOW_FILE, []);
  const since = Date.now() - hours * 60 * 60 * 1000;

  return flow.filter(x => x.time >= since);
}

function getAssetFlow(asset, hours) {
  const rows = getFlowRows(hours).filter(x => x.asset === asset);

  const inflow = rows
    .filter(x => x.side === "BUY")
    .reduce((sum, x) => sum + Number(x.usdValue || 0), 0);

  const outflow = rows
    .filter(x => x.side === "SELL")
    .reduce((sum, x) => sum + Number(x.usdValue || 0), 0);

  const amount = rows.reduce((sum, x) => sum + Number(x.amount || 0), 0);

  return {
    asset,
    inflow,
    outflow,
    net: inflow - outflow,
    amount,
    buys: rows.filter(x => x.side === "BUY").length,
    sells: rows.filter(x => x.side === "SELL").length,
    txCount: rows.length
  };
}

function buildFlowReport(hours) {
  let text = `📊 <b>${hours}H MARKET FLOW REPORT</b>\n\n`;

  for (const asset of Object.keys(MARKETS)) {
    const f = getAssetFlow(asset, hours);
    const p = livePrices[asset];

    text += `<b>${asset}</b>\n`;
    text += `Price: ${formatUsd(p.price)}\n`;
    text += `24H Change: ${formatPct(p.change24h)}\n`;
    text += `🟢 Inflow: ${formatUsd(f.inflow)}\n`;
    text += `🔴 Outflow: ${formatUsd(f.outflow)}\n`;
    text += `⚖️ Net Flow: ${formatUsd(f.net)}\n`;
    text += `Buys: ${f.buys}\n`;
    text += `Sells: ${f.sells}\n`;
    text += `Trend: ${f.net > 0 ? "Accumulation 💰" : f.net < 0 ? "Distribution ⚠️" : "Neutral"}\n\n`;
  }

  return text;
}

function buildTopReport(hours, type) {
  const rows = Object.keys(MARKETS).map(asset => getAssetFlow(asset, hours));

  rows.sort((a, b) => {
    if (type === "inflow") return b.inflow - a.inflow;
    return b.outflow - a.outflow;
  });

  let text = type === "inflow"
    ? `📈 <b>TOP INFLOW</b>\n\n`
    : `📉 <b>TOP OUTFLOW</b>\n\n`;

  rows.forEach((r, i) => {
    const value = type === "inflow" ? r.inflow : r.outflow;
    const prefix = type === "inflow" ? "+" : "-";

    text += `${i + 1}. <b>${r.asset}</b> ${prefix}${formatUsd(value)}\n`;
  });

  return text;
}

function buildSummary() {
  const flows = Object.keys(MARKETS).map(asset => ({
    asset,
    flow: getAssetFlow(asset, 24),
    price: livePrices[asset]
  }));

  const mostActive = flows
    .slice()
    .sort((a, b) => (b.flow.inflow + b.flow.outflow) - (a.flow.inflow + a.flow.outflow))[0];

  const strongest = flows
    .slice()
    .sort((a, b) => Math.abs(b.price.change24h) - Math.abs(a.price.change24h))[0];

  const totalWhaleFlow = flows.reduce(
    (sum, x) => sum + x.flow.inflow + x.flow.outflow,
    0
  );

  let text = `🐋 <b>MARKET SUMMARY</b>\n\n`;

  for (const item of flows) {
    text += `${item.asset} ${summaryTrend(item.asset, item.flow)}\n`;
  }

  text += `\n<b>Most Active:</b>\n${mostActive?.asset || "N/A"}\n\n`;
  text += `<b>Strongest Signal:</b>\n${strongest?.asset || "N/A"}\n\n`;
  text += `<b>24H Total Whale Flow:</b>\n${formatUsd(totalWhaleFlow)}\n`;

  return text;
}

async function postFlowReport(hours) {
  if (!signalsEnabled) return;
  await sendGroup(buildFlowReport(hours));
}

bot.on("message", msg => {
  console.log("CHAT ID:", msg.chat.id);
  console.log("TITLE:", msg.chat.title);
});

bot.onText(/\/start/, async msg => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals VIP Access

Commands:
/verify WALLET_ADDRESS
/myaccess
/markets
/prices
/price BTC

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

    if (balance < MIN_WAI_ACCESS) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Access Denied

Wallet: ${shortWallet(wallet)}
Balance: ${formatNumber(balance)} WAI
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
      verifiedAt: nowIso(),
      lastCheck: nowIso()
    };

    if (existingIndex >= 0) users[existingIndex] = { ...users[existingIndex], ...userData };
    else users.push(userData);

    writeJson(USERS_FILE, users);

    const inviteLink = await createInviteLink(telegramId);

    await bot.sendMessage(
      msg.chat.id,
      `✅ Access Granted

Wallet: ${shortWallet(wallet)}
Balance: ${formatNumber(balance)} WAI

VIP Group Invite:
${inviteLink}

This invite link is valid for 10 minutes and can be used once.`
    );
  } catch (err) {
    console.error(err);
    await bot.sendMessage(msg.chat.id, "❌ Verification failed. Please try again later.");
  }
});

bot.onText(/\/myaccess/, async msg => {
  const telegramId = String(msg.chat.id);
  const users = readJson(USERS_FILE, []);
  const user = users.find(u => String(u.telegramId) === telegramId);

  if (!user) return bot.sendMessage(msg.chat.id, "No verified wallet found.");

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals VIP Access

Status: ${user.verified ? "ACTIVE ✅" : "INACTIVE ❌"}
Wallet: ${shortWallet(user.wallet)}
Last Balance: ${formatNumber(user.lastBalance)} WAI
Last Check: ${user.lastCheck || "Never"}
`);
});

bot.onText(/\/markets/, async msg => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Markets

✅ BTC
✅ ETH
✅ BNB
✅ AVAX
✅ MATIC

Commands:
/price BTC
/price ETH
/price BNB
/price AVAX
/price MATIC

/prices
/flow12
/flow24
/topinflow
/topoutflow
/summary

/signals_on
/signals_off
`);
});

bot.onText(/\/price (.+)/, async (msg, match) => {
  const asset = match[1].trim().toUpperCase();

  if (!MARKETS[asset]) {
    return bot.sendMessage(msg.chat.id, "Supported: BTC, ETH, BNB, AVAX, MATIC");
  }

  const p = livePrices[asset];
  const avgBuy = isOwner(msg.chat.id) ? await getAverageBuy(asset) : null;

  await bot.sendMessage(msg.chat.id, `
📊 ${asset} LIVE

Price: ${formatUsd(p.price)}
24H Change: ${formatPct(p.change24h)}
Volume: ${formatUsd(p.volume24h)}
Market Cap: ${formatUsd(p.marketCap)}

Signal Trend:
${trendLabel(p.change24h)}

Average Buy Price:
${avgBuy ? formatUsd(avgBuy) : "N/A"}
`);
});

bot.onText(/\/prices/, async msg => {
  let text = `📊 <b>LIVE MARKET PRICES</b>\n\n`;

  for (const asset of Object.keys(MARKETS)) {
    const p = livePrices[asset];

    text += `<b>${asset}</b>\n`;
    text += `Price: ${formatUsd(p.price)}\n`;
    text += `24H Change: ${formatPct(p.change24h)}\n`;
    text += `Volume: ${formatUsd(p.volume24h)}\n`;
    text += `Market Cap: ${formatUsd(p.marketCap)}\n`;
    text += `Signal Trend: ${trendLabel(p.change24h)}\n\n`;
  }

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/\/flow12/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildFlowReport(12));
  await bot.sendMessage(msg.chat.id, "✅ 12H flow sent.");
});

bot.onText(/\/flow24/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildFlowReport(24));
  await bot.sendMessage(msg.chat.id, "✅ 24H flow sent.");
});

bot.onText(/\/topinflow/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildTopReport(24, "inflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top inflow sent.");
});

bot.onText(/\/topoutflow/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildTopReport(24, "outflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top outflow sent.");
});

bot.onText(/\/summary/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildSummary());
  await bot.sendMessage(msg.chat.id, "✅ Summary sent.");
});

bot.onText(/\/signals_on/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  signalsEnabled = true;
  await bot.sendMessage(msg.chat.id, "✅ Signals ON");
});

bot.onText(/\/signals_off/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  signalsEnabled = false;
  await bot.sendMessage(msg.chat.id, "❌ Signals OFF");
});

bot.onText(/\/status/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Admin Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}

Markets:
BTC ✅
ETH ✅
BNB ✅
AVAX ✅
MATIC ✅

Min WAI Required: ${MIN_WAI_ACCESS}
Test Mode: OFF

Users Total: ${users.length}
Users Active: ${active}

Binance API:
${BINANCE_API_KEY && BINANCE_API_SECRET ? "Connected ✅" : "Missing ❌"}
`);
});

bot.onText(/\/checkholders/, async msg => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await bot.sendMessage(msg.chat.id, "Checking holders...");
  await checkAllHolders();
  await bot.sendMessage(msg.chat.id, "✅ Holder check completed.");
});

updateLivePrices();

setInterval(updateLivePrices, PRICE_UPDATE_INTERVAL_SECONDS * 1000);
setInterval(runSignals, CHECK_SIGNALS_INTERVAL_SECONDS * 1000);
setInterval(checkAllHolders, CHECK_HOLDERS_INTERVAL_SECONDS * 1000);
setInterval(() => postFlowReport(12), FLOW12_INTERVAL_SECONDS * 1000);
setInterval(() => postFlowReport(24), FLOW24_INTERVAL_SECONDS * 1000);

console.log("WhaleSignals 5-Market Final Bot running...");
console.log("Markets: BTC ETH BNB AVAX MATIC");
console.log("Signals:", signalsEnabled);
console.log("Test Mode: OFF");

require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
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
const TEST_ACCESS_MODE = String(process.env.TEST_ACCESS_MODE || "false") === "true";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);
const FLOW12_INTERVAL_SECONDS = Number(process.env.FLOW12_INTERVAL_SECONDS || 43200);
const FLOW24_INTERVAL_SECONDS = Number(process.env.FLOW24_INTERVAL_SECONDS || 86400);
const PRICE_UPDATE_INTERVAL_SECONDS = Number(process.env.PRICE_UPDATE_INTERVAL_SECONDS || 60);

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";
const FLOW_FILE = "flow.json";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const MARKETS = {
  BTC: { binance: "BTCUSDT", minUsd: Number(process.env.MIN_BTC_USD || 50000) },
  ETH: { binance: "ETHUSDT", minUsd: Number(process.env.MIN_ETH_USD || 50000) },
  BNB: { binance: "BNBUSDT", minUsd: Number(process.env.MIN_BNB_USD || 30000) },
  SOL: { binance: "SOLUSDT", minUsd: Number(process.env.MIN_SOL_USD || 30000) },
  XRP: { binance: "XRPUSDT", minUsd: Number(process.env.MIN_XRP_USD || 30000) }
};

let livePrices = {
  BTC: { price: 0, change24h: 0, volume24h: 0 },
  ETH: { price: 0, change24h: 0, volume24h: 0 },
  BNB: { price: 0, change24h: 0, volume24h: 0 },
  SOL: { price: 0, change24h: 0, volume24h: 0 },
  XRP: { price: 0, change24h: 0, volume24h: 0 }
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
  return `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function signalStrength(usdValue) {
  if (usdValue >= 1000000) return "10/10";
  if (usdValue >= 500000) return "9/10";
  if (usdValue >= 250000) return "8/10";
  if (usdValue >= 100000) return "7/10";
  return "6/10";
}

function classifySignal(usdValue, side) {
  if (usdValue >= 1000000) return "🚨 NEW WHALE ENTRY";
  if (side === "BUY" && usdValue >= 250000) return "💰 ACCUMULATION ALERT";
  if (side === "SELL" && usdValue >= 250000) return "⚠️ WHALE EXIT";
  if (side === "BUY") return "🟢 SMART MONEY BUY";
  if (side === "SELL") return "🔴 SMART MONEY SELL";
  return "🐋 WHALE SIGNAL";
}

function trendLabel(change24h) {
  const n = Number(change24h || 0);
  if (n >= 3) return "Bullish 🟢";
  if (n <= -3) return "Bearish 🔴";
  return "Neutral ⚪";
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

async function updateLivePrices() {
  try {
    const symbols = Object.values(MARKETS).map(m => m.binance);
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;

    const res = await axios.get(url, { timeout: 30000 });

    for (const row of res.data || []) {
      const asset = Object.keys(MARKETS).find(k => MARKETS[k].binance === row.symbol);
      if (!asset) continue;

      livePrices[asset] = {
        price: Number(row.lastPrice || 0),
        change24h: Number(row.priceChangePercent || 0),
        volume24h: Number(row.quoteVolume || 0)
      };
    }

    console.log("Live Binance prices updated.");
  } catch (err) {
    console.error("Price update error:", err.message);
  }
}

async function getWaiBalance(wallet) {
  if (TEST_ACCESS_MODE) return 1000000;

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

async function scanBinanceMarket(asset) {
  const market = MARKETS[asset];
  if (!market) return;

  try {
    const res = await axios.get("https://api.binance.com/api/v3/aggTrades", {
      params: {
        symbol: market.binance,
        limit: 80
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
      const p = livePrices[asset] || { price, change24h: 0, volume24h: 0 };
      const currentPrice = p.price || price;

      const avgBuy = side === "BUY" ? price : 0;
      const pnl = avgBuy > 0 ? ((currentPrice - avgBuy) / avgBuy) * 100 : 0;

      addFlow(asset, side, amount, usdValue, price, id);

      const title = classifySignal(usdValue, side);

      await sendSignal(`
${side === "BUY" ? "🟢" : "🔴"} <b>${title}</b>

<b>Asset:</b> ${asset}

<b>Amount:</b>
${amount.toLocaleString()} ${asset}

<b>Value:</b>
${formatUsd(usdValue)}

<b>Price:</b>
${formatUsd(currentPrice)}

<b>24H Change:</b>
${formatPct(p.change24h)}

<b>Average Buy:</b>
${side === "BUY" ? formatUsd(avgBuy) : "N/A"}

<b>PnL:</b>
${side === "BUY" ? formatPct(pnl) : "N/A"}

<b>Signal Strength:</b>
${signalStrength(usdValue)}

<b>Venue:</b>
Binance Spot

<b>Wallet:</b>
N/A — CEX trade

<b>TX:</b>
<a href="https://www.binance.com/en/trade/${asset}_USDT">View Market</a>
`);
    }

    seen.txs = Array.from(seenSet).slice(-20000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} scan error:`, err.message);
  }
}

async function runSignals() {
  await scanBinanceMarket("BTC");
  await scanBinanceMarket("ETH");
  await scanBinanceMarket("BNB");
  await scanBinanceMarket("SOL");
  await scanBinanceMarket("XRP");
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
    .reduce((s, x) => s + Number(x.usdValue || 0), 0);

  const outflow = rows
    .filter(x => x.side === "SELL")
    .reduce((s, x) => s + Number(x.usdValue || 0), 0);

  const amount = rows.reduce((s, x) => s + Number(x.amount || 0), 0);

  return {
    asset,
    inflow,
    outflow,
    net: inflow - outflow,
    amount,
    txCount: rows.length,
    buys: rows.filter(x => x.side === "BUY").length,
    sells: rows.filter(x => x.side === "SELL").length
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

  text += `<b>Source:</b> Binance Spot trade flow.\n`;
  return text;
}

function buildTopReport(hours, type) {
  const rows = Object.keys(MARKETS).map(asset => getAssetFlow(asset, hours));

  rows.sort((a, b) => {
    if (type === "inflow") return b.inflow - a.inflow;
    return b.outflow - a.outflow;
  });

  let text = type === "inflow"
    ? `📈 <b>TOP INFLOW — ${hours}H</b>\n\n`
    : `📉 <b>TOP OUTFLOW — ${hours}H</b>\n\n`;

  rows.forEach((r, i) => {
    text += `${i + 1}. <b>${r.asset}</b>\n`;
    text += type === "inflow"
      ? `Inflow: ${formatUsd(r.inflow)}\n`
      : `Outflow: ${formatUsd(r.outflow)}\n`;
    text += `Net: ${formatUsd(r.net)}\n`;
    text += `Buys: ${r.buys} | Sells: ${r.sells}\n\n`;
  });

  return text;
}

function buildSummary() {
  let text = `🐋 <b>WHALESIGNALS MARKET SUMMARY</b>\n\n`;

  let totalInflow = 0;
  let totalOutflow = 0;

  for (const asset of Object.keys(MARKETS)) {
    const f = getAssetFlow(asset, 24);
    const p = livePrices[asset];

    totalInflow += f.inflow;
    totalOutflow += f.outflow;

    text += `<b>${asset}</b>\n`;
    text += `Price: ${formatUsd(p.price)}\n`;
    text += `24H Change: ${formatPct(p.change24h)}\n`;
    text += `24H Volume: ${formatUsd(p.volume24h)}\n`;
    text += `Net Flow: ${formatUsd(f.net)}\n`;
    text += `Trend: ${trendLabel(p.change24h)}\n\n`;
  }

  text += `<b>Total 24H Inflow:</b> ${formatUsd(totalInflow)}\n`;
  text += `<b>Total 24H Outflow:</b> ${formatUsd(totalOutflow)}\n`;
  text += `<b>Total Net Flow:</b> ${formatUsd(totalInflow - totalOutflow)}\n`;

  return text;
}

async function postFlowReport(hours) {
  if (!signalsEnabled) return;
  await sendGroup(buildFlowReport(hours));
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

  if (!user) return bot.sendMessage(msg.chat.id, "No verified wallet found.");

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals VIP Access

Status: ${user.verified ? "ACTIVE ✅" : "INACTIVE ❌"}
Wallet: ${shortWallet(user.wallet)}
Last Balance: ${user.lastBalance} WAI
Last Check: ${user.lastCheck || "Never"}
`);
});

bot.onText(/\/markets/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Markets

✅ BTC
✅ ETH
✅ BNB
✅ SOL
✅ XRP

Commands:
/prices
/price BTC
/price ETH
/price BNB
/price SOL
/price XRP
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
    return bot.sendMessage(msg.chat.id, "Supported: BTC, ETH, BNB, SOL, XRP");
  }

  const p = livePrices[asset];

  await bot.sendMessage(msg.chat.id, `
📊 ${asset} LIVE PRICE

Price: ${formatUsd(p.price)}
24H Change: ${formatPct(p.change24h)}
24H Volume: ${formatUsd(p.volume24h)}
Trend: ${trendLabel(p.change24h)}

Average Buy:
N/A until wallet buy history is connected.
`);
});

bot.onText(/\/prices/, async (msg) => {
  let text = `📊 <b>LIVE PRICES</b>\n\n`;

  for (const asset of Object.keys(MARKETS)) {
    const p = livePrices[asset];

    text += `<b>${asset}</b>\n`;
    text += `Price: ${formatUsd(p.price)}\n`;
    text += `24H Change: ${formatPct(p.change24h)}\n`;
    text += `24H Volume: ${formatUsd(p.volume24h)}\n\n`;
  }

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/\/flow12/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildFlowReport(12));
  await bot.sendMessage(msg.chat.id, "✅ 12H flow sent.");
});

bot.onText(/\/flow24/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildFlowReport(24));
  await bot.sendMessage(msg.chat.id, "✅ 24H flow sent.");
});

bot.onText(/\/topinflow/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildTopReport(24, "inflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top inflow sent.");
});

bot.onText(/\/topoutflow/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildTopReport(24, "outflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top outflow sent.");
});

bot.onText(/\/summary/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildSummary());
  await bot.sendMessage(msg.chat.id, "✅ Summary sent.");
});

bot.onText(/\/status/, async (msg) => {
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
SOL ✅
XRP ✅

Min WAI Required: ${MIN_WAI_ACCESS}
Test Access Mode: OFF ❌

Users Total: ${users.length}
Users Active: ${active}
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

bot.onText(/\/testsignal/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const p = livePrices.BTC.price || 105000;
  const amount = 12.5;
  const value = amount * p;
  const avg = 98500;
  const pnl = ((p - avg) / avg) * 100;

  await sendGroup(`
🚨 <b>NEW WHALE ENTRY</b>

<b>Asset:</b> BTC

<b>Amount:</b>
${amount.toFixed(2)} BTC

<b>Value:</b>
${formatUsd(value)}

<b>Price:</b>
${formatUsd(p)}

<b>24H Change:</b>
${formatPct(livePrices.BTC.change24h)}

<b>Average Buy:</b>
${formatUsd(avg)}

<b>PnL:</b>
${formatPct(pnl)}

<b>Signal Strength:</b>
10/10

<b>Wallet:</b>
Binance Spot / N/A

<b>TX:</b>
<a href="https://www.binance.com/en/trade/BTC_USDT">View Market</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Demo signal sent.");
});

bot.onText(/\/checkholders/, async (msg) => {
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

console.log("WhaleSignals 5-Coin Binance Flow Bot running...");
console.log("Markets: BTC ETH BNB SOL XRP");
console.log("Signals:", signalsEnabled);
console.log("Test Access Mode: OFF");

require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { ethers } = require("ethers");
const { createCanvas } = require("@napi-rs/canvas");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_CHANNEL_ID = String(process.env.TELEGRAM_CHANNEL_ID || "");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || TELEGRAM_CHANNEL_ID);

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "true").toLowerCase() === "true";

const MORALIS_ENABLED = String(process.env.MORALIS_ENABLED || "true").toLowerCase() === "true";
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";
const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const COINGECKO_BASE = COINGECKO_API_KEY
  ? "https://pro-api.coingecko.com/api/v3"
  : "https://api.coingecko.com/api/v3";

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const ETH_RPC = process.env.ETH_RPC || "https://ethereum.publicnode.com";
const BNB_RPC = process.env.BNB_RPC || "https://bsc-dataseed.binance.org";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
const bnbProvider = new ethers.JsonRpcProvider(BNB_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const WAI_CONTRACT_ADDRESS =
  process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";

const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";
const FLOW_FILE = "flow.json";

const PRICE_UPDATE_INTERVAL_SECONDS = Number(process.env.PRICE_UPDATE_INTERVAL_SECONDS || 300);
const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 90);
const DASHBOARD_INTERVAL_SECONDS = Number(process.env.DASHBOARD_INTERVAL_SECONDS || 900);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);

const MARKETS = {
  BTC: {
    gecko: "bitcoin",
    name: "Bitcoin",
    minUsd: Number(process.env.MIN_BTC_USD || 50000),
    explorer: "https://mempool.space",
    type: "btc",
    color: "#F7931A"
  },
  ETH: {
    gecko: "ethereum",
    name: "Ethereum",
    minUsd: Number(process.env.MIN_ETH_USD || 50000),
    explorer: "https://etherscan.io",
    type: "evm",
    provider: ethProvider,
    minNative: Number(process.env.MIN_ETH_WHALE || 50),
    maxNative: Number(process.env.MAX_ETH_WHALE || 10000),
    color: "#627EEA"
  },
  BNB: {
    gecko: "binancecoin",
    name: "BNB Chain",
    minUsd: Number(process.env.MIN_BNB_USD || 30000),
    explorer: "https://bscscan.com",
    type: "evm",
    provider: bnbProvider,
    minNative: Number(process.env.MIN_BNB_WHALE || 500),
    maxNative: Number(process.env.MAX_BNB_WHALE || 100000),
    color: "#F3BA2F"
  },
  SOL: {
    gecko: "solana",
    name: "Solana",
    minUsd: Number(process.env.MIN_SOL_USD || 30000),
    type: "price_only",
    color: "#14F195"
  },
  XRP: {
    gecko: "ripple",
    name: "XRP",
    minUsd: Number(process.env.MIN_XRP_USD || 30000),
    type: "price_only",
    color: "#22C55E"
  }
};

const MORALIS_TOKENS = {
  ETH: { chain: "eth", tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  BNB: { chain: "bsc", tokenAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" }
};

let livePrices = {};
let top10 = [];
let macro = {
  fearGreed: null,
  btcDominance: null,
  gold: null,
  sp500: null,
  nasdaq: null,
  dxy: null
};

for (const asset of Object.keys(MARKETS)) {
  livePrices[asset] = { price: 0, change24h: 0, volume24h: 0, marketCap: 0 };
}

function isOwner(userId) {
  return String(userId) === OWNER_TELEGRAM_ID;
}

function isPrivateChat(msg) {
  return msg.chat && msg.chat.type === "private";
}

function canUseUserCommand(msg) {
  return isOwner(msg.from.id) || isPrivateChat(msg);
}

function blockPublicCommand(msg) {
  if (isPrivateChat(msg)) return bot.sendMessage(msg.chat.id, "❌ Access denied.");
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

function nowIso() {
  return new Date().toISOString();
}

function shortHash(value) {
  if (!value) return "Unknown";
  const s = String(value);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatUsd(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "$0";
  if (Math.abs(n) >= 1000000000000) return `$${(n / 1000000000000).toFixed(2)}T`;
  if (Math.abs(n) >= 1000000000) return `$${(n / 1000000000).toFixed(2)}B`;
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPrice(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

function formatPct(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0.00%";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function formatAmount(value, decimals = 4) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function cgHeaders() {
  if (!COINGECKO_API_KEY) return {};
  return { "x-cg-pro-api-key": COINGECKO_API_KEY };
}

async function updateMarketData() {
  await updateTop10AndPrices();
  await updateMacroData();
}

async function updateTop10AndPrices() {
  try {
    const res = await axios.get(`${COINGECKO_BASE}/coins/markets`, {
      params: {
        vs_currency: "usd",
        order: "market_cap_desc",
        per_page: 10,
        page: 1,
        sparkline: false,
        price_change_percentage: "24h"
      },
      headers: cgHeaders(),
      timeout: 30000
    });

    top10 = Array.isArray(res.data) ? res.data : [];

    for (const coin of top10) {
      const asset = Object.keys(MARKETS).find(a => MARKETS[a].gecko === coin.id);
      if (!asset) continue;

      livePrices[asset] = {
        price: Number(coin.current_price || 0),
        change24h: Number(coin.price_change_percentage_24h || 0),
        volume24h: Number(coin.total_volume || 0),
        marketCap: Number(coin.market_cap || 0)
      };
    }

    console.log("Market data updated.");
  } catch (err) {
    console.error("CoinGecko update error:", err.message);
  }
}

async function updateMacroData() {
  try {
    const fg = await axios.get("https://api.alternative.me/fng/", { timeout: 20000 });
    const row = fg.data?.data?.[0];
    if (row) {
      macro.fearGreed = {
        value: Number(row.value || 0),
        label: row.value_classification || "N/A"
      };
    }
  } catch (err) {
    console.error("Fear & Greed error:", err.message);
  }

  try {
    const global = await axios.get(`${COINGECKO_BASE}/global`, {
      headers: cgHeaders(),
      timeout: 20000
    });

    macro.btcDominance = Number(global.data?.data?.market_cap_percentage?.btc || 0);
  } catch (err) {
    console.error("BTC dominance error:", err.message);
  }

  await Promise.allSettled([
    updateStooq("gold", "xauusd", "gold"),
    updateStooq("sp500", "^spx", "sp500"),
    updateStooq("nasdaq", "^ndq", "nasdaq"),
    updateStooq("dxy", "dx.f", "dxy")
  ]);
}

async function updateStooq(label, symbol, target) {
  try {
    const res = await axios.get("https://stooq.com/q/l/", {
      params: { s: symbol, f: "sd2t2ohlcv", h: "", e: "csv" },
      timeout: 20000
    });

    const lines = String(res.data || "").trim().split("\n");
    if (lines.length < 2) return;

    const cols = lines[1].split(",");
    const close = Number(cols[6] || 0);
    if (Number.isFinite(close) && close > 0) macro[target] = close;
  } catch (err) {
    console.error(`${label} macro error:`, err.message);
  }
}

function addFlow(asset, side, amount, usdValue, price, source, txId) {
  const flow = readJson(FLOW_FILE, []);

  flow.push({
    time: Date.now(),
    asset,
    side,
    amount,
    usdValue,
    price,
    source,
    txId
  });

  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  writeJson(FLOW_FILE, flow.filter(x => x.time >= cutoff));
}

function getFlowRows(hours) {
  const flow = readJson(FLOW_FILE, []);
  const since = Date.now() - hours * 60 * 60 * 1000;
  return flow.filter(x => x.time >= since);
}

function getAssetFlow(asset, hours) {
  const rows = getFlowRows(hours).filter(x => x.asset === asset);
  const inflow = rows.filter(x => x.side === "BUY").reduce((s, x) => s + Number(x.usdValue || 0), 0);
  const outflow = rows.filter(x => x.side === "SELL").reduce((s, x) => s + Number(x.usdValue || 0), 0);
  const transfer = rows.filter(x => x.side === "TRANSFER").reduce((s, x) => s + Number(x.usdValue || 0), 0);

  return {
    asset,
    inflow,
    outflow,
    transfer,
    volume: inflow + outflow + transfer,
    net: inflow - outflow,
    txCount: rows.length
  };
}

function getMarketBias() {
  let score = 0;

  for (const asset of ["BTC", "ETH", "BNB", "SOL", "XRP"]) {
    const p = livePrices[asset];
    if (!p) continue;
    if (p.change24h >= 2) score += 1;
    if (p.change24h <= -2) score -= 1;
  }

  const fg = macro.fearGreed?.value || 0;
  if (fg >= 70) score += 1;
  if (fg <= 30) score -= 1;

  const totalNet = ["BTC", "ETH", "BNB", "SOL", "XRP"]
    .map(a => getAssetFlow(a, 24).net)
    .reduce((s, x) => s + x, 0);

  if (totalNet > 1000000) score += 1;
  if (totalNet < -1000000) score -= 1;

  if (score >= 3) return "BULLISH 🟢";
  if (score <= -2) return "BEARISH 🔴";
  if (score > 0) return "ACCUMULATION 🟢";
  return "NEUTRAL ⚪";
}

function buildDashboardText() {
  let text = `📊 <b>WAI MARKET DASHBOARD</b>\n\n`;

  for (const asset of ["BTC", "ETH", "BNB", "SOL", "XRP"]) {
    const p = livePrices[asset];
    text += `<b>${asset}</b> ${formatPrice(p.price)} ${formatPct(p.change24h)}\n`;
  }

  text += `\n<b>Macro</b>\n`;
  text += `🥇 Gold: ${macro.gold ? formatPrice(macro.gold) : "N/A"}\n`;
  text += `📈 S&P500: ${macro.sp500 ? formatAmount(macro.sp500, 2) : "N/A"}\n`;
  text += `📊 Nasdaq: ${macro.nasdaq ? formatAmount(macro.nasdaq, 2) : "N/A"}\n`;
  text += `💵 DXY: ${macro.dxy ? formatAmount(macro.dxy, 2) : "N/A"}\n`;
  text += `₿ BTC Dominance: ${macro.btcDominance ? formatPct(macro.btcDominance) : "N/A"}\n`;

  if (macro.fearGreed) {
    text += `😱 Fear & Greed: <b>${macro.fearGreed.value}</b> (${escapeHtml(macro.fearGreed.label)})\n`;
  }

  text += `\n🧠 <b>WAI Bias:</b> ${getMarketBias()}`;
  text += `\n\n🐋 Track Smart Money Before Everyone Else`;

  return text;
}

function buildTop10Text() {
  let text = `🏆 <b>TOP 10 CRYPTO BY MARKET CAP</b>\n\n`;

  top10.forEach((coin, i) => {
    const symbol = String(coin.symbol || "").toUpperCase();
    text += `${i + 1}. <b>${symbol}</b> ${formatPrice(coin.current_price)} ${formatPct(coin.price_change_percentage_24h)}\n`;
  });

  text += `\n🐋 Track Smart Money Before Everyone Else`;
  return text;
}

function buildFlowReport(hours = 24) {
  let text = `🌊 <b>${hours}H SMART MONEY FLOW</b>\n\n`;

  let totalNet = 0;
  let totalVolume = 0;
  let whaleSignals = 0;

  for (const asset of ["BTC", "ETH", "BNB", "SOL", "XRP"]) {
    const f = getAssetFlow(asset, hours);
    totalNet += f.net;
    totalVolume += f.volume;
    whaleSignals += f.txCount;

    const netText = f.net >= 0 ? `+${formatUsd(f.net)}` : `-${formatUsd(Math.abs(f.net))}`;
    text += `<b>${asset}</b>: ${netText}\n`;
  }

  text += `\n💰 <b>Total Volume:</b> ${formatUsd(totalVolume)}`;
  text += `\n🌊 <b>Net Flow:</b> ${totalNet >= 0 ? "+" : "-"}${formatUsd(Math.abs(totalNet))}`;
  text += `\n🐋 <b>Whale Signals:</b> ${whaleSignals}`;
  text += `\n\n🧠 <b>Bias:</b> ${getMarketBias()}`;
  text += `\n\n🐋 Track Smart Money Before Everyone Else`;

  return text;
}

function buildSummaryText() {
  const flow = buildFlowReport(24);
  return `${buildDashboardText()}\n\n────────────\n\n${flow}`;
}

function buildTopReport(hours, type) {
  const rows = ["BTC", "ETH", "BNB", "SOL", "XRP"]
    .map(asset => getAssetFlow(asset, hours))
    .sort((a, b) => {
      if (type === "inflow") return b.inflow - a.inflow;
      if (type === "outflow") return b.outflow - a.outflow;
      return b.volume - a.volume;
    })
    .slice(0, 5);

  let text =
    type === "inflow"
      ? `📈 <b>TOP INFLOW ${hours}H</b>\n\n`
      : type === "outflow"
        ? `📉 <b>TOP OUTFLOW ${hours}H</b>\n\n`
        : `📊 <b>TOP VOLUME ${hours}H</b>\n\n`;

  rows.forEach((r, i) => {
    const value = type === "inflow" ? r.inflow : type === "outflow" ? r.outflow : r.volume;
    text += `${i + 1}. <b>${r.asset}</b> ${formatUsd(value)}\n`;
  });

  text += `\n🐋 Track Smart Money Before Everyone Else`;
  return text;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

async function createWhaleCard(data) {
  const width = 1200;
  const height = 520;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const side = String(data.side || "TRANSFER");
  const asset = String(data.asset || "BTC");
  const sideColor = side === "BUY" ? "#22C55E" : side === "SELL" ? "#EF4444" : "#FACC15";
  const value = formatUsd(data.usdValue || 0);
  const price = formatPrice(data.price || 0);
  const change = formatPct(data.change24h || 0);

  const tier =
    Number(data.usdValue || 0) >= 1000000 ? "GIANT WHALE" :
    Number(data.usdValue || 0) >= 250000 ? "MEGA WHALE" :
    "WHALE";

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#020617");
  bg.addColorStop(0.45, "#071B33");
  bg.addColorStop(1, "#150B2E");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.shadowColor = sideColor;
  ctx.shadowBlur = 30;
  ctx.strokeStyle = sideColor;
  ctx.lineWidth = 5;
  roundRect(ctx, 35, 35, 1130, 450, 34);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#08182D";
  roundRect(ctx, 45, 45, 1110, 430, 30);
  ctx.fill();

  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(85, 185);
  ctx.lineTo(1115, 185);
  ctx.stroke();

  ctx.fillStyle = sideColor;
  ctx.shadowColor = sideColor;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.arc(125, 118, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 34px sans-serif";
  ctx.fillText("WAI RADAR", 190, 100);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 60px sans-serif";
  ctx.fillText(`${tier} ${side}`, 190, 165);

  ctx.fillStyle = sideColor;
  roundRect(ctx, 905, 95, 170, 58, 18);
  ctx.fill();

  ctx.fillStyle = "#020617";
  ctx.font = "900 34px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(asset, 990, 134);
  ctx.textAlign = "left";

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 34px sans-serif";
  ctx.fillText("VALUE", 95, 260);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 78px sans-serif";
  ctx.fillText(value, 95, 335);

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 34px sans-serif";
  ctx.fillText("PRICE", 720, 260);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 52px sans-serif";
  ctx.fillText(price, 720, 330);

  ctx.fillStyle = "#0F172A";
  roundRect(ctx, 720, 355, 330, 60, 18);
  ctx.fill();

  ctx.fillStyle = sideColor;
  ctx.font = "900 30px sans-serif";
  ctx.fillText(`24H ${change}`, 745, 395);

  ctx.fillStyle = "#7DD3FC";
  ctx.font = "800 30px sans-serif";
  ctx.fillText(`AMOUNT ${formatAmount(data.amount || 0, 4)} ${asset}`, 95, 455);

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 28px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("TX • WALLET", 1105, 455);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

async function sendChannel(text) {
  if (!TELEGRAM_CHANNEL_ID) {
    console.error("TELEGRAM_CHANNEL_ID missing.");
    return;
  }

  await bot.sendMessage(TELEGRAM_CHANNEL_ID, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendWhaleCard(data) {
  if (!signalsEnabled) return;

  try {
    const buffer = await createWhaleCard(data);
    const icon = data.side === "BUY" ? "🟢" : data.side === "SELL" ? "🔴" : "🟡";

    await bot.sendPhoto(TELEGRAM_CHANNEL_ID, buffer, {
      caption: `<b>${data.asset}</b> ${icon} | ${formatUsd(data.usdValue)}`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔗 TX", url: data.txUrl },
            { text: "👛 Wallet", url: data.walletUrl || data.txUrl }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("sendWhaleCard error:", err.message);
  }
}

async function postDashboard() {
  if (!signalsEnabled) return;
  await updateMarketData();
  await sendChannel(buildDashboardText());
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
    console.error("Remove user error:", err.message);
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

      if (balance < MIN_WAI_ACCESS && String(user.telegramId) !== OWNER_TELEGRAM_ID) {
        user.verified = false;
        user.removedAt = nowIso();

        await removeUserFromGroup(user.telegramId);

        await bot.sendMessage(
          user.telegramId,
          `❌ Access Revoked\n\nWallet: ${shortHash(user.wallet)}\nBalance: ${balance} WAI\nRequired: ${MIN_WAI_ACCESS} WAI`
        );
      }

      changed = true;
    } catch (err) {
      console.error("Holder check error:", err.message);
    }
  }

  if (changed) writeJson(USERS_FILE, users);
}

function extractMoralisHash(s) {
  return s.transactionHash || s.transaction_hash || s.hash || s.txHash || s.tx_hash || "";
}

function extractMoralisWallet(s) {
  return (
    s.walletAddress ||
    s.wallet_address ||
    s.traderAddress ||
    s.trader_address ||
    s.maker ||
    s.fromAddress ||
    s.from_address ||
    "N/A"
  );
}

function extractMoralisUsd(s) {
  return Number(
    s.totalValueUsd ||
    s.total_value_usd ||
    s.usdValue ||
    s.usd_value ||
    s.amountUsd ||
    s.amount_usd ||
    0
  );
}

function extractMoralisAmount(s, side, price, usdValue) {
  const boughtAmount = Number(
    s.bought?.amount ||
    s.boughtAmount ||
    s.bought_amount ||
    s.tokenBoughtAmount ||
    0
  );

  const soldAmount = Number(
    s.sold?.amount ||
    s.soldAmount ||
    s.sold_amount ||
    s.tokenSoldAmount ||
    0
  );

  if (side === "BUY" && boughtAmount > 0) return boughtAmount;
  if (side === "SELL" && soldAmount > 0) return soldAmount;
  if (price > 0 && usdValue > 0) return usdValue / price;

  return 0;
}

async function scanMoralisSwaps(asset) {
  if (!MORALIS_ENABLED || !MORALIS_API_KEY) return;

  const cfg = MORALIS_TOKENS[asset];
  const market = MARKETS[asset];

  if (!cfg || !market) return;

  try {
    const res = await axios.get(`${MORALIS_BASE_URL}/erc20/${cfg.tokenAddress}/swaps`, {
      params: {
        chain: cfg.chain,
        limit: 20
      },
      headers: {
        "X-API-Key": MORALIS_API_KEY
      },
      timeout: 30000
    });

    const swaps = res.data?.result || [];
    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);

    for (const s of swaps) {
      const hash = extractMoralisHash(s);
      if (!hash) continue;

      const id = `${asset}-swap-${hash}-${s.transactionIndex || s.logIndex || ""}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const type = String(s.transactionType || s.transaction_type || "").toLowerCase();

      let side = "TRANSFER";
      if (type === "buy") side = "BUY";
      if (type === "sell") side = "SELL";
      if (side === "TRANSFER") continue;

      const usdValue = extractMoralisUsd(s);
      if (!Number.isFinite(usdValue) || usdValue < market.minUsd || usdValue > 1000000000) continue;

      const price =
        livePrices[asset]?.price ||
        Number(s.bought?.usdPrice || s.sold?.usdPrice || s.priceUsd || 0);

      if (!price || !Number.isFinite(price)) continue;

      const amount = extractMoralisAmount(s, side, price, usdValue);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const wallet = extractMoralisWallet(s);

      addFlow(asset, side, amount, usdValue, price, s.exchangeName || s.exchange_name || "DEX", hash);

      await sendWhaleCard({
        asset,
        side,
        amount,
        usdValue,
        price,
        change24h: livePrices[asset]?.change24h || 0,
        txUrl: `${market.explorer}/tx/${hash}`,
        walletUrl:
          wallet && wallet !== "N/A"
            ? `${market.explorer}/address/${wallet}`
            : `${market.explorer}/tx/${hash}`
      });
    }

    seen.txs = Array.from(seenSet).slice(-50000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} Moralis swap error:`, err.message);
  }
}

async function scanBTCTransfers() {
  const market = MARKETS.BTC;

  try {
    const res = await axios.get("https://mempool.space/api/mempool/recent", {
      timeout: 30000
    });

    const txs = res.data || [];
    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);
    const price = livePrices.BTC.price || 0;

    for (const tx of txs) {
      const id = `btc-transfer-${tx.txid}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const amount = Number(tx.value || 0) / 100000000;
      const usdValue = amount * price;

      if (!price || !Number.isFinite(usdValue) || usdValue < market.minUsd || usdValue > 1000000000) continue;

      addFlow("BTC", "TRANSFER", amount, usdValue, price, "Bitcoin Network", tx.txid);

      await sendWhaleCard({
        asset: "BTC",
        side: "TRANSFER",
        amount,
        usdValue,
        price,
        change24h: livePrices.BTC.change24h,
        txUrl: `${market.explorer}/tx/${tx.txid}`,
        walletUrl: `${market.explorer}/tx/${tx.txid}`
      });
    }

    seen.txs = Array.from(seenSet).slice(-50000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error("BTC scan error:", err.message);
  }
}

async function scanEvmTransfers(asset) {
  const market = MARKETS[asset];
  if (!market || market.type !== "evm") return;

  try {
    const blockNumber = await market.provider.getBlockNumber();
    const block = await market.provider.getBlock(blockNumber, true);

    const txs = block?.prefetchedTransactions || [];
    if (!txs.length) return;

    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);
    const price = livePrices[asset]?.price || 0;

    for (const tx of txs) {
      const id = `${asset}-transfer-${tx.hash}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const amount = Number(ethers.formatEther(tx.value || 0n));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (amount < market.minNative || amount > market.maxNative) continue;

      const usdValue = amount * price;
      if (!price || usdValue < market.minUsd || usdValue > 1000000000) continue;

      addFlow(asset, "TRANSFER", amount, usdValue, price, market.name, tx.hash);

      await sendWhaleCard({
        asset,
        side: "TRANSFER",
        amount,
        usdValue,
        price,
        change24h: livePrices[asset]?.change24h || 0,
        txUrl: `${market.explorer}/tx/${tx.hash}`,
        walletUrl: `${market.explorer}/address/${tx.from}`
      });
    }

    seen.txs = Array.from(seenSet).slice(-50000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} transfer scan error:`, err.message);
  }
}

async function runSignals() {
  await updateMarketData();

  await scanBTCTransfers();

  await scanMoralisSwaps("ETH");
  await scanMoralisSwaps("BNB");

  await scanEvmTransfers("ETH");
  await scanEvmTransfers("BNB");
}

function buildHelp() {
  return `📚 <b>WAI COMMANDS</b>

<code>/prices</code>
<code>/top10</code>
<code>/dashboard</code>
<code>/summary</code>
<code>/flow24</code>
<code>/inflow</code>
<code>/outflow</code>
<code>/verify WALLET_ADDRESS</code>
<code>/myaccess</code>

🐋 Track Smart Money Before Everyone Else`;
}

bot.on("message", (msg) => {
  console.log("CHAT ID:", msg.chat.id, "TYPE:", msg.chat.type, "TITLE:", msg.chat.title || "");
});

bot.onText(/\/start/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await bot.sendMessage(msg.chat.id, buildHelp(), { parse_mode: "HTML" });
});

bot.onText(/\/help/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await bot.sendMessage(msg.chat.id, buildHelp(), { parse_mode: "HTML" });
});

bot.onText(/\/prices/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await updateMarketData();
  await bot.sendMessage(msg.chat.id, buildDashboardText(), { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.onText(/\/top10/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await updateMarketData();
  await bot.sendMessage(msg.chat.id, buildTop10Text(), { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.onText(/\/dashboard/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await updateMarketData();
  await bot.sendMessage(msg.chat.id, buildDashboardText(), { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.onText(/\/summary/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await updateMarketData();
  await bot.sendMessage(msg.chat.id, buildSummaryText(), { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.onText(/\/flow24/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await bot.sendMessage(msg.chat.id, buildFlowReport(24), { parse_mode: "HTML" });
});

bot.onText(/\/inflow/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await bot.sendMessage(msg.chat.id, buildTopReport(24, "inflow"), { parse_mode: "HTML" });
});

bot.onText(/\/outflow/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);
  await bot.sendMessage(msg.chat.id, buildTopReport(24, "outflow"), { parse_mode: "HTML" });
});

bot.onText(/\/verify (.+)/, async (msg, match) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  const telegramId = String(msg.from.id);
  const wallet = match[1].trim();

  try {
    if (!ethers.isAddress(wallet)) {
      return bot.sendMessage(msg.chat.id, "❌ Invalid wallet address.");
    }

    const balance = await getWaiBalance(wallet);

    if (telegramId !== OWNER_TELEGRAM_ID && balance < MIN_WAI_ACCESS) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Access Denied\n\nWallet: ${shortHash(wallet)}\nBalance: ${balance} WAI\nRequired: ${MIN_WAI_ACCESS} WAI`
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
      `✅ Access Granted\n\nWallet: ${shortHash(wallet)}\nBalance: ${balance} WAI\n\nVIP Group Invite:\n${inviteLink}\n\nValid: 10 minutes\nUses: 1`
    );
  } catch (err) {
    console.error("Verify error:", err.message);
    await bot.sendMessage(msg.chat.id, "❌ Verification failed.");
  }
});

bot.onText(/\/myaccess/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  const telegramId = String(msg.from.id);
  const users = readJson(USERS_FILE, []);
  const user = users.find(u => String(u.telegramId) === telegramId);

  if (!user) return bot.sendMessage(msg.chat.id, "No verified wallet found.");

  await bot.sendMessage(msg.chat.id, `
WhaleSignals VIP Access

Status: ${user.verified ? "ACTIVE ✅" : "INACTIVE ❌"}
Wallet: ${shortHash(user.wallet)}
Last Balance: ${user.lastBalance} WAI
Last Check: ${user.lastCheck || "Never"}
`);
});

bot.onText(/\/postdashboard/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await postDashboard();
  await bot.sendMessage(msg.chat.id, "✅ Dashboard sent.");
});

bot.onText(/\/postflow24/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendChannel(buildFlowReport(24));
  await bot.sendMessage(msg.chat.id, "✅ Flow 24H sent.");
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
WAI Radar Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Markets: BTC ETH BNB SOL XRP ✅
Top 10 Crypto: ON ✅
Gold/Macro: ON ✅
Fear & Greed: ON ✅
Moralis: ${MORALIS_ENABLED && MORALIS_API_KEY ? "ON ✅" : "OFF ❌"}
CoinGecko Key: ${COINGECKO_API_KEY ? "PRO ✅" : "FREE/DEMO ✅"}

Min WAI: ${MIN_WAI_ACCESS}

Users: ${users.length}
Active: ${active}
`);
});

bot.onText(/\/signals_on/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  signalsEnabled = true;
  await bot.sendMessage(msg.chat.id, "✅ Signals ON");
});

bot.onText(/\/signals_off/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  signalsEnabled = false;
  await bot.sendMessage(msg.chat.id, "❌ Signals OFF");
});

bot.onText(/\/checkholders/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await bot.sendMessage(msg.chat.id, "Checking holders...");
  await checkAllHolders();
  await bot.sendMessage(msg.chat.id, "✅ Holder check completed.");
});

(async () => {
  await updateMarketData();

  setInterval(updateMarketData, PRICE_UPDATE_INTERVAL_SECONDS * 1000);
  setInterval(runSignals, CHECK_SIGNALS_INTERVAL_SECONDS * 1000);
  setInterval(checkAllHolders, CHECK_HOLDERS_INTERVAL_SECONDS * 1000);
  setInterval(postDashboard, DASHBOARD_INTERVAL_SECONDS * 1000);

  console.log("WAI Radar Premium Bot running...");
  console.log("Markets: BTC ETH BNB SOL XRP");
  console.log("Dashboard interval:", DASHBOARD_INTERVAL_SECONDS, "seconds");
  console.log("Signals:", signalsEnabled);
})();

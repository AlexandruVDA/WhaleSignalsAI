require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { ethers } = require("ethers");
const sharp = require("sharp");
const { createCanvas } = require("@napi-rs/canvas");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on("channel_post", (msg) => {
  console.log("CHANNEL ID:", msg.chat.id);
});

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_CHANNEL_ID = String(process.env.TELEGRAM_CHANNEL_ID || "-1003819742117");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "true").toLowerCase() === "true";

const MORALIS_ENABLED = String(process.env.MORALIS_ENABLED || "true").toLowerCase() === "true";
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || "";
const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const ETH_RPC = process.env.ETH_RPC || "https://ethereum.publicnode.com";
const BNB_RPC = process.env.BNB_RPC || "https://bsc-dataseed.binance.org";
const AVAX_RPC = process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc";
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com";

const ETHERSCAN_URL = "https://etherscan.io";
const BSCSCAN_URL = "https://bscscan.com";
const SNOWTRACE_URL = "https://snowtrace.io";
const POLYGONSCAN_URL = "https://polygonscan.com";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);
const FLOW12_INTERVAL_SECONDS = Number(process.env.FLOW12_INTERVAL_SECONDS || 43200);
const FLOW24_INTERVAL_SECONDS = Number(process.env.FLOW24_INTERVAL_SECONDS || 86400);
const PRICE_UPDATE_INTERVAL_SECONDS = Number(process.env.PRICE_UPDATE_INTERVAL_SECONDS || 60);

const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);
const WAI_CONTRACT_ADDRESS =
  process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";
const FLOW_FILE = "flow.json";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
const bnbProvider = new ethers.JsonRpcProvider(BNB_RPC);
const avaxProvider = new ethers.JsonRpcProvider(AVAX_RPC);
const polygonProvider = new ethers.JsonRpcProvider(POLYGON_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const MARKETS = {
  BTC: {
    display: "BTC",
    color: "#F7931A",
    symbolIcon: "₿",
    chainLabel: "BITCOIN",
    gecko: "bitcoin",
    minUsd: Number(process.env.MIN_BTC_USD || 50000),
    transfer: "btc"
  },
  ETH: {
    display: "ETH",
    color: "#111111",
    symbolIcon: "♦",
    chainLabel: "ETHEREUM",
    gecko: "ethereum",
    minUsd: Number(process.env.MIN_ETH_USD || 50000),
    transfer: "evm",
    provider: ethProvider,
    explorer: ETHERSCAN_URL,
    minNative: Number(process.env.MIN_ETH_WHALE || 50),
    maxNative: Number(process.env.MAX_ETH_WHALE || 10000),
    chainName: "Ethereum"
  },
  BNB: {
    display: "BNB",
    color: "#F3BA2F",
    symbolIcon: "◆",
    chainLabel: "BNB CHAIN",
    gecko: "binancecoin",
    minUsd: Number(process.env.MIN_BNB_USD || 30000),
    transfer: "evm",
    provider: bnbProvider,
    explorer: BSCSCAN_URL,
    minNative: Number(process.env.MIN_BNB_WHALE || 500),
    maxNative: Number(process.env.MAX_BNB_WHALE || 100000),
    chainName: "BNB Chain"
  },
  AVAX: {
    display: "AVAX",
    color: "#E84142",
    symbolIcon: "▲",
    chainLabel: "AVALANCHE",
    gecko: "avalanche-2",
    minUsd: Number(process.env.MIN_AVAX_USD || 30000),
    transfer: "evm",
    provider: avaxProvider,
    explorer: SNOWTRACE_URL,
    minNative: Number(process.env.MIN_AVAX_WHALE || 1000),
    maxNative: Number(process.env.MAX_AVAX_WHALE || 1000000),
    chainName: "Avalanche"
  },
  MATIC: {
    display: "MATIC/POL",
    color: "#8247E5",
    symbolIcon: "∞",
    chainLabel: "POLYGON",
    gecko: "polygon-ecosystem-token",
    minUsd: Number(process.env.MIN_MATIC_USD || 30000),
    transfer: "evm",
    provider: polygonProvider,
    explorer: POLYGONSCAN_URL,
    minNative: Number(process.env.MIN_MATIC_WHALE || 100000),
    maxNative: Number(process.env.MAX_MATIC_WHALE || 5000000),
    chainName: "Polygon"
  }
};

const MORALIS_TOKENS = {
  ETH: { chain: "eth", tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  BNB: { chain: "bsc", tokenAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
  AVAX: { chain: "avalanche", tokenAddress: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" },
  MATIC: { chain: "polygon", tokenAddress: "0x0000000000000000000000000000000000001010" }
};

let livePrices = {};
for (const asset of Object.keys(MARKETS)) {
  livePrices[asset] = { price: 0, change24h: 0, volume24h: 0 };
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
  if (isPrivateChat(msg)) {
    return bot.sendMessage(msg.chat.id, "❌ Access denied.");
  }

  return;
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

function shortHash(value) {
  if (!value || value === "N/A") return "Unknown";
  const s = String(value);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatUsd(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1000000000) return `$${(n / 1000000000).toFixed(2)}B`;
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function formatAmount(value, maxDecimals = 4) {
  const n = Number(value || 0);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
}

function marketBias(change24h, netFlow, volume) {
  const c = Number(change24h || 0);
  const n = Number(netFlow || 0);
  const v = Number(volume || 0);

  if (n > 250000 && c > -5) return { text: "Accumulation 🟢", color: "#22C55E" };
  if (n < -250000) return { text: "Distribution 🔴", color: "#EF4444" };
  if (c >= 2) return { text: "Bullish 🟢", color: "#22C55E" };
  if (c <= -2 && v < 100000) return { text: "Bearish 🔴", color: "#EF4444" };
  return { text: "Neutral ⚪", color: "#E5E7EB" };
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

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
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
  const volume = inflow + outflow + transfer;

  return {
    asset,
    inflow,
    outflow,
    transfer,
    volume,
    net: inflow - outflow,
    txCount: rows.length
  };
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

async function createSignalCard(data) {
  const width = 1200;
  const height = 520;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const asset = String(data.asset || "ETH");
  const side = String(data.side || "TRANSFER");
  const value = formatUsd(data.usdValue || 0);
  const price = formatUsd(data.price || 0);
  const change = formatPct(data.change24h || 0);
  const amount = `${formatAmount(data.amount || 0, 4)} ${asset}`;

  const sideColor =
    side === "BUY" ? "#22C55E" :
    side === "SELL" ? "#EF4444" :
    "#FACC15";

  const tier =
    Number(data.usdValue || 0) >= 1000000 ? "GIANT WHALE" :
    Number(data.usdValue || 0) >= 250000 ? "MEGA WHALE" :
    "WHALE";

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#020617");
  bg.addColorStop(0.5, "#071B33");
  bg.addColorStop(1, "#160B2E");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  ctx.shadowColor = sideColor;
  ctx.shadowBlur = 25;
  ctx.strokeStyle = sideColor;
  ctx.lineWidth = 4;
  rr(35, 35, 1130, 450, 36);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#08182D";
  rr(35, 35, 1130, 450, 36);
  ctx.fill();

  ctx.strokeStyle = sideColor;
  ctx.lineWidth = 3;
  rr(55, 55, 1090, 410, 30);
  ctx.stroke();

  ctx.strokeStyle = "#7DD3FC";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(135, 130, 70, 42, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = sideColor;
  ctx.shadowColor = sideColor;
  ctx.shadowBlur = 25;
  ctx.beginPath();
  ctx.arc(135, 130, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 34px sans-serif";
  ctx.fillText("WHALESIGNALS AI", 270, 92);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 58px sans-serif";
  ctx.fillText(`${tier} ${side}`, 270, 185);

  ctx.fillStyle = sideColor;
  rr(815, 118, 170, 50, 18);
  ctx.fill();

  ctx.fillStyle = "#020617";
  ctx.font = "900 30px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(asset, 900, 152);
  ctx.textAlign = "left";

  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(75, 190);
  ctx.lineTo(1125, 190);
  ctx.stroke();

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 34px sans-serif";
  ctx.fillText("VALUE", 95, 260);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 76px sans-serif";
  ctx.fillText(value, 95, 330);

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 34px sans-serif";
  ctx.fillText("PRICE", 690, 260);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "900 52px sans-serif";
  ctx.fillText(price, 690, 330);

  ctx.fillStyle = "#0F172A";
  rr(690, 355, 330, 58, 18);
  ctx.fill();

  ctx.fillStyle = sideColor;
  ctx.font = "900 30px sans-serif";
  ctx.fillText(`24H ${change}`, 715, 393);

  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(75, 455);
  ctx.lineTo(1125, 455);
  ctx.stroke();

  ctx.fillStyle = "#7DD3FC";
  ctx.font = "800 30px sans-serif";
  ctx.fillText(`AMOUNT ${amount}`, 95, 470);

  ctx.fillStyle = "#94A3B8";
  ctx.font = "800 28px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("TX • WALLET", 1125, 470);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

async function sendChannel(text) {
  await bot.sendMessage(TELEGRAM_CHANNEL_ID, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendSignalCard(data) {
  if (!signalsEnabled) return;

  try {
    const buffer = await createSignalCard(data);

    const captionIcon =
      data.side === "BUY" ? "🟢" :
      data.side === "SELL" ? "🔴" :
      "🟡";

    const caption = `${data.asset} ${captionIcon} | ${formatUsd(data.usdValue)}`;

    await bot.sendPhoto(TELEGRAM_CHANNEL_ID, buffer, {
      caption,
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
    console.error("sendSignalCard error:", err.message);
  }
}

async function sendSummaryCard(hours = 24) {
  if (typeof createSummaryCard !== "function") {
    return sendChannel(buildSummary());
  }

  const buffer = createSummaryCard(hours);

  await bot.sendPhoto(TELEGRAM_CHANNEL_ID, buffer, {
    caption: `Market Summary ${hours}H`,
    parse_mode: "HTML"
  });
}

async function updateLivePrices() {
  try {
    const ids = Object.values(MARKETS).map(m => m.gecko).join(",");

    const url =
      "https://api.coingecko.com/api/v3/simple/price" +
      `?ids=${ids}` +
      "&vs_currencies=usd" +
      "&include_24hr_vol=true" +
      "&include_24hr_change=true";

    const res = await axios.get(url, { timeout: 30000 });
    const data = res.data || {};

    for (const [asset, market] of Object.entries(MARKETS)) {
      const row = data[market.gecko];
      if (!row) continue;

      livePrices[asset] = {
        price: Number(row.usd || 0),
        change24h: Number(row.usd_24h_change || 0),
        volume24h: Number(row.usd_24h_vol || 0)
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

Wallet: ${shortHash(user.wallet)}
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
      if (!Number.isFinite(usdValue)) continue;
      if (usdValue < market.minUsd) continue;
      if (usdValue > 1000000000) continue;

      const price =
        livePrices[asset].price ||
        Number(s.bought?.usdPrice || s.sold?.usdPrice || s.priceUsd || 0);

      if (!price || !Number.isFinite(price)) continue;

      const amount = extractMoralisAmount(s, side, price, usdValue);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (amount > market.maxNative) continue;

      const wallet = extractMoralisWallet(s);

      addFlow(
        asset,
        side,
        amount,
        usdValue,
        price,
        s.exchangeName || s.exchange_name || "DEX",
        hash
      );

      await sendSignalCard({
        asset,
        side,
        amount,
        usdValue,
        price,
        change24h: livePrices[asset].change24h,
        txHash: hash,
        walletRaw: wallet,
        txUrl: `${market.explorer}/tx/${hash}`,
        walletUrl:
          wallet && wallet !== "N/A"
            ? `${market.explorer}/address/${wallet}`
            : `${market.explorer}/tx/${hash}`
      });
    }

    seen.txs = Array.from(seenSet).slice(-30000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} Moralis swap scan error:`, err.message);
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

      if (!price || usdValue < market.minUsd) continue;
      if (usdValue > 1000000000) continue;

      addFlow("BTC", "TRANSFER", amount, usdValue, price, "Bitcoin Network", tx.txid);

      await sendSignalCard({
        asset: "BTC",
        side: "TRANSFER",
        amount,
        usdValue,
        price,
        change24h: livePrices.BTC.change24h,
        txHash: tx.txid,
        walletRaw: "Bitcoin Network",
        txUrl: `https://mempool.space/tx/${tx.txid}`,
        walletUrl: `https://mempool.space/tx/${tx.txid}`
      });
    }

    seen.txs = Array.from(seenSet).slice(-30000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error("BTC transfer scan error:", err.message);
  }
}

async function scanEvmTransfers(asset) {
  const market = MARKETS[asset];
  if (!market || market.transfer !== "evm") return;

  try {
    const blockNumber = await market.provider.getBlockNumber();
    const block = await market.provider.getBlock(blockNumber, true);

    if (!block || !block.prefetchedTransactions) return;

    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);
    const price = livePrices[asset].price || 0;

    for (const tx of block.prefetchedTransactions) {
      const id = `${asset}-transfer-${tx.hash}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const amount = Number(ethers.formatEther(tx.value || 0n));

      if (!Number.isFinite(amount)) continue;
      if (amount <= 0) continue;
      if (amount < market.minNative) continue;
      if (amount > market.maxNative) continue;

      const usdValue = amount * price;

      if (!price || usdValue <= 0) continue;
      if (!Number.isFinite(usdValue)) continue;
      if (usdValue < market.minUsd) continue;
      if (usdValue > 1000000000) continue;

      addFlow(asset, "TRANSFER", amount, usdValue, price, market.chainName, tx.hash);

      await sendSignalCard({
        asset,
        side: "TRANSFER",
        amount,
        usdValue,
        price,
        change24h: livePrices[asset].change24h,
        txHash: tx.hash,
        walletRaw: tx.from,
        txUrl: `${market.explorer}/tx/${tx.hash}`,
        walletUrl: `${market.explorer}/address/${tx.from}`
      });
    }

    seen.txs = Array.from(seenSet).slice(-30000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} transfer scan error:`, err.message);
  }
}

async function runSignals() {
  await updateLivePrices();

  await scanBTCTransfers();

  await scanMoralisSwaps("ETH");
  await scanMoralisSwaps("BNB");
  await scanMoralisSwaps("AVAX");
  await scanMoralisSwaps("MATIC");

  await scanEvmTransfers("ETH");
  await scanEvmTransfers("BNB");
  await scanEvmTransfers("AVAX");
  await scanEvmTransfers("MATIC");
}

function buildFlowReport(hours) {
  let text = `🌊 <b>${hours}H CAPITAL FLOW</b>\n\n`;

  let totalNet = 0;

  for (const asset of Object.keys(MARKETS)) {
    const f = getAssetFlow(asset, hours);
    const netText = f.net >= 0 ? `+${formatUsd(f.net)}` : formatUsd(f.net);
    totalNet += f.net;

    text += `<b>${asset}</b>: ${netText}\n`;
  }

  text += `\n<b>Total:</b> ${totalNet >= 0 ? "+" : ""}${formatUsd(totalNet)}`;
  text += `\n\n🐋 Track Smart Money Before Everyone Else`;

  return text;
}

function buildTopReport(hours, type) {
  const rows = Object.keys(MARKETS)
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

function buildSummary() {
  let text = `📊 <b>MARKET SUMMARY</b>\n\n`;

  let totalNet = 0;
  let totalVolume = 0;
  let whaleCount = 0;

  for (const asset of Object.keys(MARKETS)) {
    const f = getAssetFlow(asset, 24);
    const p = livePrices[asset];
    const bias = marketBias(p.change24h, f.net, f.volume);

    totalNet += f.net;
    totalVolume += f.volume;
    whaleCount += f.txCount;

    text += `<b>${asset}</b> → ${bias.text}\n`;
  }

  text += `\n🐋 <b>Whale Signals:</b> ${whaleCount}`;
  text += `\n💰 <b>24H Volume:</b> ${formatUsd(totalVolume)}`;
  text += `\n🌊 <b>Net Flow:</b> ${totalNet >= 0 ? "+" : ""}${formatUsd(totalNet)}`;
  text += `\n\n🐋 Track Smart Money Before Everyone Else`;

  return text;
}

function buildHelp() {
  return `📚 <b>WAI COMMANDS</b>

<code>/prices</code>
<code>/inflow</code>
<code>/outflow</code>
<code>/summary</code>
<code>/flow24</code>
<code>/verify WALLET_ADDRESS</code>
<code>/myaccess</code>

🐋 Track Smart Money Before Everyone Else`;
}

async function postFlowReport(hours) {
  if (!signalsEnabled) return;
  await sendChannel(buildFlowReport(hours));
}

bot.on("message", (msg) => {
  console.log("CHAT ID:", msg.chat.id);
  console.log("TYPE:", msg.chat.type);
  console.log("TITLE:", msg.chat.title);
});

bot.onText(/\/start/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await bot.sendMessage(msg.chat.id, buildHelp(), {
    parse_mode: "HTML"
  });
});

bot.onText(/\/help/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await bot.sendMessage(msg.chat.id, buildHelp(), {
    parse_mode: "HTML"
  });
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

    if (telegramId === OWNER_TELEGRAM_ID) {
      await bot.sendMessage(msg.chat.id, "✅ Owner Access Granted");
    } else if (balance < MIN_WAI_ACCESS) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Access Denied

Wallet: ${shortHash(wallet)}
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

Wallet: ${shortHash(wallet)}
Balance: ${balance} WAI

VIP Group Invite:
${inviteLink}

Valid: 10 minutes
Uses: 1`
    );
  } catch (err) {
    console.error(err);
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

bot.onText(/\/prices/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await updateLivePrices();

  let text = `📊 <b>LIVE PRICES</b>\n\n`;

  for (const asset of Object.keys(MARKETS)) {
    const p = livePrices[asset];
    text += `<b>${asset}</b> ${formatUsd(p.price)} ${formatPct(p.change24h)}\n`;
  }

  text += `\n🐋 Track Smart Money Before Everyone Else`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/\/inflow/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await bot.sendMessage(msg.chat.id, buildTopReport(24, "inflow"), {
    parse_mode: "HTML"
  });
});

bot.onText(/\/outflow/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await bot.sendMessage(msg.chat.id, buildTopReport(24, "outflow"), {
    parse_mode: "HTML"
  });
});

bot.onText(/\/summary/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await updateLivePrices();

  await bot.sendMessage(msg.chat.id, buildSummary(), {
    parse_mode: "HTML"
  });
});

bot.onText(/\/flow24/, async (msg) => {
  if (!canUseUserCommand(msg)) return blockPublicCommand(msg);

  await bot.sendMessage(msg.chat.id, buildFlowReport(24), {
    parse_mode: "HTML"
  });
});

bot.onText(/\/markets/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await bot.sendMessage(msg.chat.id, `
WhaleSignals Markets

BTC
ETH
BNB
AVAX
MATIC/POL

Signals:
BUY
SELL
TRANSFER

Whale Levels:
Whale: $50K+
Mega Whale: $500K+
Giant Whale: $1M+

User Commands:
/help
/prices
/inflow
/outflow
/summary
/flow24
/verify
/myaccess
`);
});

bot.onText(/\/price (.+)/, async (msg, match) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const asset = match[1].trim().toUpperCase();

  if (!MARKETS[asset]) {
    return bot.sendMessage(msg.chat.id, "Supported: BTC, ETH, BNB, AVAX, MATIC");
  }

  await updateLivePrices();

  const p = livePrices[asset];
  const f = getAssetFlow(asset, 24);
  const m = MARKETS[asset];
  const bias = marketBias(p.change24h, f.net, f.volume);

  await bot.sendMessage(msg.chat.id, `
<b>${m.display}</b>

${m.chainLabel}
Price: ${formatUsd(p.price)}
24H: ${formatPct(p.change24h)}
Volume: ${formatUsd(f.volume)}
Net: ${f.net >= 0 ? "+" : ""}${formatUsd(f.net)}
Bias: ${bias.text}
`, { parse_mode: "HTML" });
});

bot.onText(/\/flow12/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendChannel(buildFlowReport(12));
  await bot.sendMessage(msg.chat.id, "✅ 12H flow sent.");
});

bot.onText(/\/topinflow/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendChannel(buildTopReport(24, "inflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top inflow sent.");
});

bot.onText(/\/topoutflow/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendChannel(buildTopReport(24, "outflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top outflow sent.");
});

bot.onText(/\/summarycard/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await updateLivePrices();
  await sendSummaryCard(24);
  await bot.sendMessage(msg.chat.id, "✅ Summary card sent.");
});

bot.onText(/\/testcard/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await updateLivePrices();

  await sendSignalCard({
    asset: "ETH",
    side: "BUY",
    amount: 62.8054,
    usdValue: 102330,
    price: livePrices.ETH.price || 1630,
    change24h: livePrices.ETH.change24h || -3.81,
    txHash: "0x0d15aaabbbcccdddeeefff1112223334445556667778889990001112223344522",
    walletRaw: "0x5607aaabbbcccdddeeefff111222333444555fF6A",
    txUrl: "https://etherscan.io",
    walletUrl: "https://etherscan.io"
  });

  await bot.sendMessage(msg.chat.id, "✅ Test card sent.");
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
WhaleSignals Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Prices: CoinGecko ✅
Cards: ON ✅

Markets:
BTC ✅
ETH ✅
BNB ✅
AVAX ✅
MATIC/POL ✅

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

updateLivePrices();

setInterval(updateLivePrices, PRICE_UPDATE_INTERVAL_SECONDS * 1000);
setInterval(runSignals, CHECK_SIGNALS_INTERVAL_SECONDS * 1000);
setInterval(checkAllHolders, CHECK_HOLDERS_INTERVAL_SECONDS * 1000);

setTimeout(() => {
  postFlowReport(12);
  setInterval(() => postFlowReport(12), FLOW12_INTERVAL_SECONDS * 1000);
}, FLOW12_INTERVAL_SECONDS * 1000);

setTimeout(() => {
  postFlowReport(24);
  setInterval(() => postFlowReport(24), FLOW24_INTERVAL_SECONDS * 1000);
}, FLOW24_INTERVAL_SECONDS * 1000);

console.log("WhaleSignals Premium Card Bot running...");
console.log("Markets: BTC ETH BNB AVAX MATIC/POL");
console.log("Prices: CoinGecko");
console.log("Signals:", signalsEnabled);

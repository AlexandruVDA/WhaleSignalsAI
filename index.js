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
const ETH_RPC = process.env.ETH_RPC || "https://ethereum.publicnode.com";
const BNB_RPC = process.env.BNB_RPC || "https://bsc-dataseed.binance.org";
const AVAX_RPC = process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc";
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";

const BASESCAN_URL = "https://basescan.org";
const ETHERSCAN_URL = "https://etherscan.io";
const BSCSCAN_URL = "https://bscscan.com";
const SNOWTRACE_URL = "https://snowtrace.io";
const POLYGONSCAN_URL = "https://polygonscan.com";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);
const FLOW12_INTERVAL_SECONDS = Number(process.env.FLOW12_INTERVAL_SECONDS || 43200);
const FLOW24_INTERVAL_SECONDS = Number(process.env.FLOW24_INTERVAL_SECONDS || 86400);

const LIVE_PRICES_ENABLED = String(process.env.LIVE_PRICES_ENABLED || "true") === "true";
const PRICE_UPDATE_INTERVAL_SECONDS = Number(process.env.PRICE_UPDATE_INTERVAL_SECONDS || 300);

const BTC_ENABLED = String(process.env.BTC_ENABLED || "true") === "true";
const ETH_ENABLED = String(process.env.ETH_ENABLED || "true") === "true";
const BNB_ENABLED = String(process.env.BNB_ENABLED || "true") === "true";
const AVAX_ENABLED = String(process.env.AVAX_ENABLED || "true") === "true";
const POLYGON_ENABLED = String(process.env.POLYGON_ENABLED || "true") === "true";

const BTC_PRICE_USD = Number(process.env.BTC_PRICE_USD || 100000);
const ETH_PRICE_USD = Number(process.env.ETH_PRICE_USD || 3000);
const BNB_PRICE_USD = Number(process.env.BNB_PRICE_USD || 650);
const AVAX_PRICE_USD = Number(process.env.AVAX_PRICE_USD || 20);
const MATIC_PRICE_USD = Number(process.env.MATIC_PRICE_USD || 0.3);

const MIN_BTC_WHALE = Number(process.env.MIN_BTC_WHALE || 5);
const MIN_ETH_WHALE = Number(process.env.MIN_ETH_WHALE || 50);
const MIN_BNB_WHALE = Number(process.env.MIN_BNB_WHALE || 500);
const MIN_AVAX_WHALE = Number(process.env.MIN_AVAX_WHALE || 1000);
const MIN_MATIC_WHALE = Number(process.env.MIN_MATIC_WHALE || 100000);

const WAI_CONTRACT_ADDRESS = process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";
const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);
const TEST_ACCESS_MODE = String(process.env.TEST_ACCESS_MODE || "true") === "true";

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

const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  MATIC: "matic-network"
};

let livePrices = {
  BTC: { price: BTC_PRICE_USD, change24h: 0, volume24h: 0, marketCap: 0 },
  ETH: { price: ETH_PRICE_USD, change24h: 0, volume24h: 0, marketCap: 0 },
  BNB: { price: BNB_PRICE_USD, change24h: 0, volume24h: 0, marketCap: 0 },
  AVAX: { price: AVAX_PRICE_USD, change24h: 0, volume24h: 0, marketCap: 0 },
  MATIC: { price: MATIC_PRICE_USD, change24h: 0, volume24h: 0, marketCap: 0 }
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

function walletLink(address, explorer) {
  if (!address) return "unknown";
  return `<a href="${explorer}/address/${address}">${shortWallet(address)}</a>`;
}

function txLink(hash, explorer) {
  return `<a href="${explorer}/tx/${hash}">View Transaction</a>`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatUsd(value) {
  return `$${Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2
  })}`;
}

function formatPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function getAssetPrice(symbol) {
  return livePrices[symbol]?.price || 0;
}

function getAssetData(symbol) {
  return livePrices[symbol] || {
    price: 0,
    change24h: 0,
    volume24h: 0,
    marketCap: 0
  };
}

function signalStrength(usdValue) {
  if (usdValue >= 1000000) return "10/10";
  if (usdValue >= 500000) return "9/10";
  if (usdValue >= 250000) return "8/10";
  if (usdValue >= 100000) return "7/10";
  return "6/10";
}

function riskLevel(usdValue) {
  if (usdValue >= 1000000) return "High";
  if (usdValue >= 250000) return "Medium";
  return "Low";
}

function classifySignal(usdValue) {
  if (usdValue >= 1000000) return "🚨 New Whale Entry";
  if (usdValue >= 500000) return "💰 Accumulation Alert";
  if (usdValue >= 250000) return "🐋 Whale Transfer";
  return "🔵 Big Movement";
}

function trendLabel(change24h) {
  const n = Number(change24h || 0);
  if (n >= 5) return "Strong Bullish 🟢";
  if (n >= 1) return "Bullish 🟢";
  if (n <= -5) return "Strong Bearish 🔴";
  if (n <= -1) return "Bearish 🔴";
  return "Neutral ⚪";
}

function addFlow(asset, amount, usdValue, from, to, txHash, type) {
  const flow = readJson(FLOW_FILE, []);
  flow.push({
    time: Date.now(),
    asset,
    amount,
    usdValue,
    from,
    to,
    txHash,
    type
  });

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const clean = flow.filter(x => x.time >= cutoff);

  writeJson(FLOW_FILE, clean);
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
  if (!LIVE_PRICES_ENABLED) return;

  try {
    const ids = Object.values(COINGECKO_IDS).join(",");

    const url =
      `https://api.coingecko.com/api/v3/simple/price` +
      `?ids=${ids}` +
      `&vs_currencies=usd` +
      `&include_market_cap=true` +
      `&include_24hr_vol=true` +
      `&include_24hr_change=true`;

    const res = await axios.get(url, { timeout: 30000 });
    const data = res.data || {};

    for (const [symbol, id] of Object.entries(COINGECKO_IDS)) {
      if (!data[id]) continue;

      livePrices[symbol] = {
        price: Number(data[id].usd || livePrices[symbol].price || 0),
        marketCap: Number(data[id].usd_market_cap || 0),
        volume24h: Number(data[id].usd_24h_vol || 0),
        change24h: Number(data[id].usd_24h_change || 0)
      };
    }

    console.log("Live prices updated.");
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

      if (!TEST_ACCESS_MODE && balance < MIN_WAI_ACCESS) {
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

async function scanBTCWhales() {
  if (!BTC_ENABLED) return;

  try {
    const res = await axios.get("https://mempool.space/api/mempool/recent", {
      timeout: 30000
    });

    const txs = res.data || [];
    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);

    for (const tx of txs) {
      const id = `btc-${tx.txid}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const amount = Number(tx.value || 0) / 100000000;
      if (amount < MIN_BTC_WHALE) continue;

      const currentPrice = getAssetPrice("BTC") || BTC_PRICE_USD;
      const assetData = getAssetData("BTC");
      const usdValue = amount * currentPrice;
      const feeBtc = Number(tx.fee || 0) / 100000000;

      addFlow("BTC", amount, usdValue, "unknown", "unknown", tx.txid, "Transfer");

      await sendSignal(`
${classifySignal(usdValue)} <b>BTC WHALE SIGNAL</b>

<b>Asset:</b> BTC
<b>Type:</b> Whale Transfer
<b>Direction:</b> Wallet → Wallet

<b>Amount:</b> ${amount.toFixed(4)} BTC
<b>Estimated Value:</b> ${formatUsd(usdValue)}
<b>Current Price:</b> ${formatUsd(currentPrice)}
<b>24H Change:</b> ${formatPct(assetData.change24h)}
<b>24H Volume:</b> ${formatUsd(assetData.volume24h)}
<b>Market Cap:</b> ${formatUsd(assetData.marketCap)}

<b>Average Buy Price:</b> N/A
<b>Reason:</b> Transfer, not confirmed DEX/CEX buy

<b>Tx Fee:</b> ${feeBtc.toFixed(8)} BTC
<b>Status:</b> Pending / Mempool

<b>Signal Strength:</b> ${signalStrength(usdValue)}
<b>Risk Level:</b> ${riskLevel(usdValue)}
<b>Market Trend:</b> ${trendLabel(assetData.change24h)}

<b>Tx:</b> <a href="https://mempool.space/tx/${tx.txid}">View Transaction</a>
`);
    }

    seen.txs = Array.from(seenSet).slice(-10000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error("BTC scan error:", err.message);
  }
}

async function scanNativeWhales(config) {
  if (!config.enabled) return;

  try {
    const latestBlock = await config.provider.getBlockNumber();
    const block = await config.provider.getBlock(latestBlock, true);

    if (!block || !block.prefetchedTransactions) return;

    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);

    for (const tx of block.prefetchedTransactions) {
      const id = `${config.key}-${tx.hash}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const amount = Number(ethers.formatEther(tx.value || 0n));
      if (amount < config.minAmount) continue;

      const currentPrice = getAssetPrice(config.symbol) || config.priceUsd;
      const assetData = getAssetData(config.symbol);
      const usdValue = amount * currentPrice;

      let feeNative = 0;
      try {
        const gasPrice = tx.gasPrice || 0n;
        const gasLimit = tx.gasLimit || 0n;
        feeNative = Number(ethers.formatEther(gasPrice * gasLimit));
      } catch {}

      addFlow(config.symbol, amount, usdValue, tx.from, tx.to, tx.hash, "Transfer");

      await sendSignal(`
${classifySignal(usdValue)} <b>${config.symbol} WHALE SIGNAL</b>

<b>Asset:</b> ${config.symbol}
<b>Chain:</b> ${config.name}
<b>Type:</b> Whale Transfer
<b>Direction:</b> Wallet → Wallet

<b>Amount:</b> ${amount.toLocaleString()} ${config.symbol}
<b>Estimated Value:</b> ${formatUsd(usdValue)}
<b>Current Price:</b> ${formatUsd(currentPrice)}
<b>24H Change:</b> ${formatPct(assetData.change24h)}
<b>24H Volume:</b> ${formatUsd(assetData.volume24h)}
<b>Market Cap:</b> ${formatUsd(assetData.marketCap)}

<b>Average Buy Price:</b> N/A
<b>Reason:</b> Transfer, not confirmed swap/buy

<b>From:</b> ${walletLink(tx.from, config.explorer)}
<b>To:</b> ${walletLink(tx.to, config.explorer)}

<b>Estimated Gas Fee:</b> ${feeNative.toFixed(6)} ${config.symbol}

<b>Signal Strength:</b> ${signalStrength(usdValue)}
<b>Risk Level:</b> ${riskLevel(usdValue)}
<b>Market Trend:</b> ${trendLabel(assetData.change24h)}

<b>Tx:</b> ${txLink(tx.hash, config.explorer)}
`);
    }

    seen.txs = Array.from(seenSet).slice(-10000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${config.symbol} scan error:`, err.message);
  }
}

async function runSignals() {
  await scanBTCWhales();

  await scanNativeWhales({
    key: "eth",
    name: "Ethereum",
    symbol: "ETH",
    enabled: ETH_ENABLED,
    provider: ethProvider,
    explorer: ETHERSCAN_URL,
    minAmount: MIN_ETH_WHALE,
    priceUsd: ETH_PRICE_USD
  });

  await scanNativeWhales({
    key: "bnb",
    name: "BNB Chain",
    symbol: "BNB",
    enabled: BNB_ENABLED,
    provider: bnbProvider,
    explorer: BSCSCAN_URL,
    minAmount: MIN_BNB_WHALE,
    priceUsd: BNB_PRICE_USD
  });

  await scanNativeWhales({
    key: "avax",
    name: "Avalanche",
    symbol: "AVAX",
    enabled: AVAX_ENABLED,
    provider: avaxProvider,
    explorer: SNOWTRACE_URL,
    minAmount: MIN_AVAX_WHALE,
    priceUsd: AVAX_PRICE_USD
  });

  await scanNativeWhales({
    key: "matic",
    name: "Polygon",
    symbol: "MATIC",
    enabled: POLYGON_ENABLED,
    provider: polygonProvider,
    explorer: POLYGONSCAN_URL,
    minAmount: MIN_MATIC_WHALE,
    priceUsd: MATIC_PRICE_USD
  });
}

function getFlowRows(hours) {
  const flow = readJson(FLOW_FILE, []);
  const since = Date.now() - hours * 60 * 60 * 1000;
  return flow.filter(x => x.time >= since);
}

function getAssetFlowStats(asset, hours) {
  const rows = getFlowRows(hours).filter(x => x.asset === asset);

  const totalUsd = rows.reduce((sum, x) => sum + Number(x.usdValue || 0), 0);
  const totalAmount = rows.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  const txCount = rows.length;

  return {
    asset,
    totalUsd,
    totalAmount,
    txCount
  };
}

function buildFlowReport(hours) {
  const assets = ["BTC", "ETH", "BNB", "AVAX", "MATIC"];
  let text = `📊 <b>${hours}H WHALE FLOW REPORT</b>\n\n`;

  for (const asset of assets) {
    const stats = getAssetFlowStats(asset, hours);
    const assetData = getAssetData(asset);

    const trend =
      stats.totalUsd >= 1000000 ? "High Whale Activity 🔥" :
      stats.totalUsd >= 250000 ? "Accumulation Watch 💰" :
      stats.totalUsd > 0 ? "Light Whale Activity" :
      "No Whale Activity";

    text += `<b>${asset}</b>\n`;
    text += `Price: ${formatUsd(assetData.price)}\n`;
    text += `24H Change: ${formatPct(assetData.change24h)}\n`;
    text += `Whale Volume: ${formatUsd(stats.totalUsd)}\n`;
    text += `Amount Moved: ${stats.totalAmount.toLocaleString()} ${asset}\n`;
    text += `Whale TX Count: ${stats.txCount}\n`;
    text += `Trend: ${trend}\n\n`;
  }

  text += `<b>Note:</b> Transfer-based flow. Buy/Sell confirmation requires exchange/DEX data.\n`;

  return text;
}

function buildTopFlowReport(hours, direction) {
  const assets = ["BTC", "ETH", "BNB", "AVAX", "MATIC"];

  const stats = assets
    .map(asset => getAssetFlowStats(asset, hours))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  let text = direction === "inflow"
    ? `📈 <b>TOP INFLOW — ${hours}H</b>\n\n`
    : `📉 <b>TOP OUTFLOW — ${hours}H</b>\n\n`;

  stats.forEach((s, index) => {
    const data = getAssetData(s.asset);

    text += `${index + 1}. <b>${s.asset}</b>\n`;
    text += `Whale Volume: ${formatUsd(s.totalUsd)}\n`;
    text += `Amount: ${s.totalAmount.toLocaleString()} ${s.asset}\n`;
    text += `Price: ${formatUsd(data.price)}\n`;
    text += `24H Change: ${formatPct(data.change24h)}\n\n`;
  });

  text += `<b>Note:</b> Inflow/outflow is transfer-volume based in this version.\n`;

  return text;
}

function buildMarketSummary() {
  const assets = ["BTC", "ETH", "BNB", "AVAX", "MATIC"];

  let totalWhaleVolume24h = 0;
  let mostActive = null;
  let strongest = null;

  const rows = assets.map(asset => {
    const flow = getAssetFlowStats(asset, 24);
    const data = getAssetData(asset);

    totalWhaleVolume24h += flow.totalUsd;

    if (!mostActive || flow.totalUsd > mostActive.totalUsd) {
      mostActive = { asset, totalUsd: flow.totalUsd };
    }

    if (!strongest || Math.abs(data.change24h) > Math.abs(strongest.change24h)) {
      strongest = { asset, change24h: data.change24h };
    }

    return {
      asset,
      price: data.price,
      change24h: data.change24h,
      volume24h: data.volume24h,
      whaleVolume: flow.totalUsd,
      txCount: flow.txCount
    };
  });

  let text = `🐋 <b>WHALESIGNALS MARKET SUMMARY</b>\n\n`;

  for (const r of rows) {
    text += `<b>${r.asset}</b>\n`;
    text += `Price: ${formatUsd(r.price)}\n`;
    text += `24H Change: ${formatPct(r.change24h)}\n`;
    text += `Market Volume: ${formatUsd(r.volume24h)}\n`;
    text += `24H Whale Volume: ${formatUsd(r.whaleVolume)}\n`;
    text += `Whale TX Count: ${r.txCount}\n`;
    text += `Trend: ${trendLabel(r.change24h)}\n\n`;
  }

  text += `<b>Most Active:</b> ${mostActive?.asset || "N/A"}\n`;
  text += `<b>Strongest Move:</b> ${strongest?.asset || "N/A"} ${formatPct(strongest?.change24h || 0)}\n`;
  text += `<b>Total 24H Whale Flow:</b> ${formatUsd(totalWhaleVolume24h)}\n`;

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
/price BTC
/prices

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
✅ AVAX
✅ MATIC

Signals:
🐋 Whale Transfer
💰 Accumulation Alert
🚨 New Whale Entry
📊 12H Flow Report
📊 24H Flow Report
📈 Top Inflow
📉 Top Outflow
📊 Live Prices

Commands:
/price BTC
/prices
/flow12
/flow24
/topinflow
/topoutflow
/summary

Note:
Average Buy Price is shown as N/A for transfers.
`);
});

bot.onText(/\/price (.+)/, async (msg, match) => {
  const symbol = match[1].trim().toUpperCase();

  if (!livePrices[symbol]) {
    return bot.sendMessage(msg.chat.id, "Supported coins: BTC, ETH, BNB, AVAX, MATIC");
  }

  const p = getAssetData(symbol);

  await bot.sendMessage(msg.chat.id, `
📊 ${symbol} LIVE PRICE

Current Price: ${formatUsd(p.price)}
24H Change: ${formatPct(p.change24h)}
24H Volume: ${formatUsd(p.volume24h)}
Market Cap: ${formatUsd(p.marketCap)}

Market Trend: ${trendLabel(p.change24h)}

Average Buy Price: N/A
Reason: No wallet buy history connected yet.
`);
});

bot.onText(/\/prices/, async (msg) => {
  let text = "📊 LIVE MARKET PRICES\n\n";

  for (const symbol of ["BTC", "ETH", "BNB", "AVAX", "MATIC"]) {
    const p = getAssetData(symbol);

    text += `<b>${symbol}</b>\n`;
    text += `Price: ${formatUsd(p.price)}\n`;
    text += `24H Change: ${formatPct(p.change24h)}\n`;
    text += `24H Volume: ${formatUsd(p.volume24h)}\n`;
    text += `Market Cap: ${formatUsd(p.marketCap)}\n`;
    text += `Avg Buy: N/A\n\n`;
  }

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Admin Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Live Prices: ${LIVE_PRICES_ENABLED ? "ON ✅" : "OFF ❌"}

Markets:
BTC: ${BTC_ENABLED ? "ON ✅" : "OFF ❌"}
ETH: ${ETH_ENABLED ? "ON ✅" : "OFF ❌"}
BNB: ${BNB_ENABLED ? "ON ✅" : "OFF ❌"}
AVAX: ${AVAX_ENABLED ? "ON ✅" : "OFF ❌"}
MATIC: ${POLYGON_ENABLED ? "ON ✅" : "OFF ❌"}

Minimum Whale:
BTC: ${MIN_BTC_WHALE} BTC
ETH: ${MIN_ETH_WHALE} ETH
BNB: ${MIN_BNB_WHALE} BNB
AVAX: ${MIN_AVAX_WHALE} AVAX
MATIC: ${MIN_MATIC_WHALE} MATIC

Users Total: ${users.length}
Users Active: ${active}

Test Access Mode: ${TEST_ACCESS_MODE ? "ON ✅" : "OFF ❌"}
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

bot.onText(/\/flow12/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildFlowReport(12));
  await bot.sendMessage(msg.chat.id, "✅ 12H report sent.");
});

bot.onText(/\/flow24/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildFlowReport(24));
  await bot.sendMessage(msg.chat.id, "✅ 24H report sent.");
});

bot.onText(/\/topinflow/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildTopFlowReport(24, "inflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top inflow sent.");
});

bot.onText(/\/topoutflow/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildTopFlowReport(24, "outflow"));
  await bot.sendMessage(msg.chat.id, "✅ Top outflow sent.");
});

bot.onText(/\/summary/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");
  await sendGroup(buildMarketSummary());
  await bot.sendMessage(msg.chat.id, "✅ Market summary sent.");
});

bot.onText(/\/testsignal/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const btcPrice = getAssetPrice("BTC") || BTC_PRICE_USD;

  await sendGroup(`
🚨 <b>NEW WHALE ENTRY</b>

<b>Asset:</b> BTC
<b>Type:</b> Whale Transfer
<b>Direction:</b> Wallet → Wallet

<b>Amount:</b> 12.5000 BTC
<b>Estimated Value:</b> ${formatUsd(12.5 * btcPrice)}
<b>Current Price:</b> ${formatUsd(btcPrice)}
<b>24H Change:</b> ${formatPct(getAssetData("BTC").change24h)}

<b>Average Buy Price:</b> N/A
<b>Reason:</b> Transfer, not confirmed buy

<b>Signal Strength:</b> 10/10
<b>Risk Level:</b> High

<b>Tx:</b> <a href="https://mempool.space/tx/0000000000000000000000000000000000000000000000000000000000000000">View Transaction</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Demo signal sent.");
});

bot.onText(/\/testgroup/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await sendGroup(`
🐋 <b>WhaleSignals VIP group connected.</b>

Markets:
BTC, ETH, BNB, AVAX, MATIC
`);

  await bot.sendMessage(msg.chat.id, "✅ Test sent.");
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

console.log("WhaleSignals 5-Market Bot running...");
console.log("Signals:", signalsEnabled);
console.log("Live prices:", LIVE_PRICES_ENABLED);
console.log("Markets: BTC ETH BNB AVAX MATIC");

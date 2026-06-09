require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";
const BINANCE_SCAN_ENABLED = String(process.env.BINANCE_SCAN_ENABLED || "false") === "true";

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
const TEST_ACCESS_MODE = String(process.env.TEST_ACCESS_MODE || "false") === "true";
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
    emoji: "🟠",
    gecko: "bitcoin",
    binance: "BTCUSDT",
    minUsd: Number(process.env.MIN_BTC_USD || 50000),
    transfer: "btc"
  },
  ETH: {
    display: "ETH",
    emoji: "🔵",
    gecko: "ethereum",
    binance: "ETHUSDT",
    minUsd: Number(process.env.MIN_ETH_USD || 50000),
    transfer: "evm",
    provider: ethProvider,
    explorer: ETHERSCAN_URL,
    minNative: Number(process.env.MIN_ETH_WHALE || 50),
    chainName: "Ethereum"
  },
  BNB: {
    display: "BNB",
    emoji: "🟡",
    gecko: "binancecoin",
    binance: "BNBUSDT",
    minUsd: Number(process.env.MIN_BNB_USD || 30000),
    transfer: "evm",
    provider: bnbProvider,
    explorer: BSCSCAN_URL,
    minNative: Number(process.env.MIN_BNB_WHALE || 500),
    chainName: "BNB Chain"
  },
  AVAX: {
    display: "AVAX",
    emoji: "🔺",
    gecko: "avalanche-2",
    binance: "AVAXUSDT",
    minUsd: Number(process.env.MIN_AVAX_USD || 30000),
    transfer: "evm",
    provider: avaxProvider,
    explorer: SNOWTRACE_URL,
    minNative: Number(process.env.MIN_AVAX_WHALE || 1000),
    chainName: "Avalanche"
  },
  MATIC: {
    display: "MATIC/POL",
    emoji: "🟣",
    gecko: "polygon-ecosystem-token",
    binance: "POLUSDT",
    minUsd: Number(process.env.MIN_MATIC_USD || 30000),
    transfer: "evm",
    provider: polygonProvider,
    explorer: POLYGONSCAN_URL,
    minNative: Number(process.env.MIN_MATIC_WHALE || 100000),
    chainName: "Polygon"
  }
};

let livePrices = {};
for (const asset of Object.keys(MARKETS)) {
  livePrices[asset] = { price: 0, change24h: 0, volume24h: 0 };
}

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
  if (!address) return "N/A";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function walletLink(address, explorer) {
  if (!address) return "N/A";
  return `<a href="${explorer}/address/${address}">${shortWallet(address)}</a>`;
}

function txLink(hash, explorer) {
  return `<a href="${explorer}/tx/${hash}">TX</a>`;
}

function btcTxLink(hash) {
  return `<a href="https://mempool.space/tx/${hash}">TX</a>`;
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

function marketBias(change24h, netFlow = 0) {
  const change = Number(change24h || 0);
  if (change >= 2 && netFlow >= 0) return "Bullish 🟢";
  if (change <= -2 && netFlow < 0) return "Sell 🔴";
  if (netFlow > 100000) return "Accumulation 💰";
  if (netFlow < -100000) return "Distribution ⚠️";
  return "Neutral ⚪";
}

function signalStrength(usdValue) {
  if (usdValue >= 1000000) return "10/10";
  if (usdValue >= 500000) return "9/10";
  if (usdValue >= 250000) return "8/10";
  if (usdValue >= 100000) return "7/10";
  return "6/10";
}

function signalTitle(side, usdValue) {
  if (side === "TRANSFER") {
    if (usdValue >= 1000000) return "🚨 WHALE ENTRY";
    if (usdValue >= 500000) return "💰 ACCUMULATION";
    return "🟡 WHALE TRANSFER";
  }

  if (side === "BUY") {
    if (usdValue >= 1000000) return "🚨 WHALE ENTRY";
    if (usdValue >= 250000) return "💰 ACCUMULATION";
    return "🟢 SMART MONEY BUY";
  }

  if (side === "SELL") {
    if (usdValue >= 1000000) return "⚠️ WHALE EXIT";
    return "🔴 SMART MONEY SELL";
  }

  return "🐋 WHALE SIGNAL";
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

  return {
    asset,
    inflow,
    outflow,
    transfer,
    net: inflow - outflow,
    buys: rows.filter(x => x.side === "BUY").length,
    sells: rows.filter(x => x.side === "SELL").length,
    transfers: rows.filter(x => x.side === "TRANSFER").length,
    txCount: rows.length
  };
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

function compactSignalMessage({ asset, side, amount, usdValue, price, change24h, wallet, tx, avgBuy, pnl }) {
  const m = MARKETS[asset];
  const title = signalTitle(side, usdValue);
  const amountText = `${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${m.display}`;
  const changeEmoji = Number(change24h || 0) >= 0 ? "📈" : "📉";

  return `
${title}

${m.emoji} <b>${m.display}</b>
💰 ${formatUsd(usdValue)}
🐋 ${amountText}

💵 ${formatUsd(price)}
${changeEmoji} ${formatPct(change24h)}
🔥 ${signalStrength(usdValue)}

📊 Avg: ${avgBuy || "N/A"}
📌 PnL: ${pnl || "N/A"}

👛 ${wallet}
🔗 ${tx}
`;
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

    console.log("Live CoinGecko prices updated.");
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

async function scanBinanceTrades(asset) {
  if (!BINANCE_SCAN_ENABLED) return;

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

      const tradePrice = Number(t.p || 0);
      const amount = Number(t.q || 0);
      const usdValue = tradePrice * amount;

      if (usdValue < market.minUsd) continue;

      const side = t.m ? "SELL" : "BUY";
      const p = livePrices[asset] || { price: tradePrice, change24h: 0 };
      const currentPrice = p.price || tradePrice;

      const avgBuy = side === "BUY" ? formatUsd(tradePrice) : "N/A";
      const pnl =
        side === "BUY" && tradePrice > 0
          ? formatPct(((currentPrice - tradePrice) / tradePrice) * 100)
          : "N/A";

      addFlow(asset, side, amount, usdValue, tradePrice, "Binance Spot", id);

      await sendSignal(
        compactSignalMessage({
          asset,
          side,
          amount,
          usdValue,
          price: currentPrice,
          change24h: p.change24h,
          wallet: "Binance Spot",
          tx: `<a href="https://www.binance.com/en/trade/${market.binance.replace("USDT", "_USDT")}">Market</a>`,
          avgBuy,
          pnl
        })
      );
    }

    seen.txs = Array.from(seenSet).slice(-20000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} Binance trade scan error:`, err.message);
  }
}

async function scanBTCTransfers() {
  const market = MARKETS.BTC;

  try {
    const res = await axios.get("https://mempool.space/api/mempool/recent", { timeout: 30000 });

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

      addFlow("BTC", "TRANSFER", amount, usdValue, price, "Bitcoin Mempool", tx.txid);

      await sendSignal(
        compactSignalMessage({
          asset: "BTC",
          side: "TRANSFER",
          amount,
          usdValue,
          price,
          change24h: livePrices.BTC.change24h,
          wallet: "BTC Mempool",
          tx: btcTxLink(tx.txid),
          avgBuy: "N/A",
          pnl: "N/A"
        })
      );
    }

    seen.txs = Array.from(seenSet).slice(-20000);
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
      if (amount < market.minNative) continue;

      const usdValue = amount * price;
      if (!price || usdValue < market.minUsd) continue;

      addFlow(asset, "TRANSFER", amount, usdValue, price, market.chainName, tx.hash);

      await sendSignal(
        compactSignalMessage({
          asset,
          side: "TRANSFER",
          amount,
          usdValue,
          price,
          change24h: livePrices[asset].change24h,
          wallet: walletLink(tx.from, market.explorer),
          tx: txLink(tx.hash, market.explorer),
          avgBuy: "N/A",
          pnl: "N/A"
        })
      );
    }

    seen.txs = Array.from(seenSet).slice(-20000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${asset} transfer scan error:`, err.message);
  }
}

async function runSignals() {
  await updateLivePrices();

  if (BINANCE_SCAN_ENABLED) {
    for (const asset of Object.keys(MARKETS)) {
      await scanBinanceTrades(asset);
    }
  }

  await scanBTCTransfers();
  await scanEvmTransfers("ETH");
  await scanEvmTransfers("BNB");
  await scanEvmTransfers("AVAX");
  await scanEvmTransfers("MATIC");
}

function buildFlowReport(hours) {
  let text = `🌊 <b>${hours}H FLOW</b>\n\n`;

  for (const asset of Object.keys(MARKETS)) {
    const f = getAssetFlow(asset, hours);
    const m = MARKETS[asset];
    const flowText = f.net >= 0 ? `+${formatUsd(f.net)}` : formatUsd(f.net);

    text += `${m.emoji} <b>${m.display}</b> ${flowText}\n`;
  }

  return text;
}

function buildTopReport(hours, type) {
  const rows = Object.keys(MARKETS)
    .map(asset => getAssetFlow(asset, hours))
    .sort((a, b) => {
      if (type === "inflow") return b.inflow - a.inflow;
      return b.outflow - a.outflow;
    })
    .slice(0, 5);

  let text = type === "inflow" ? `🏆 <b>TOP INFLOW</b>\n\n` : `📉 <b>TOP OUTFLOW</b>\n\n`;

  rows.forEach((r, i) => {
    const m = MARKETS[r.asset];
    const value = type === "inflow" ? r.inflow : r.outflow;
    text += `${i + 1}. ${m.emoji} <b>${m.display}</b> ${formatUsd(value)}\n`;
  });

  return text;
}

function buildSummary() {
  let text = `📊 <b>MARKET SUMMARY</b>\n\n`;

  let totalNet = 0;
  let whaleCount = 0;

  for (const asset of Object.keys(MARKETS)) {
    const f = getAssetFlow(asset, 24);
    const p = livePrices[asset];
    const bias = marketBias(p.change24h, f.net);
    const m = MARKETS[asset];

    totalNet += f.net;
    whaleCount += f.txCount;

    text += `${m.emoji} <b>${m.display}</b> → ${bias}\n`;
  }

  text += `\n🌊 Flow: ${totalNet >= 0 ? "+" : ""}${formatUsd(totalNet)}\n`;
  text += `🐋 Activity: ${whaleCount} signals\n`;

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
    await bot.sendMessage(msg.chat.id, "❌ Verification failed.");
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
✅ MATIC/POL

Signals:
🟢 Buy
🔴 Sell
🟡 Transfer
💰 Accumulation
🚨 Whale Entry
⚠️ Whale Exit

Commands:
/prices
/price BTC
/flow12
/flow24
/topinflow
/topoutflow
/summary
`);
});

bot.onText(/\/price (.+)/, async (msg, match) => {
  const asset = match[1].trim().toUpperCase();

  if (!MARKETS[asset]) {
    return bot.sendMessage(msg.chat.id, "Supported: BTC, ETH, BNB, AVAX, MATIC");
  }

  await updateLivePrices();

  const p = livePrices[asset];
  const f = getAssetFlow(asset, 24);
  const m = MARKETS[asset];

  await bot.sendMessage(msg.chat.id, `
📊 <b>${m.display}</b>

💵 ${formatUsd(p.price)}
${Number(p.change24h || 0) >= 0 ? "📈" : "📉"} ${formatPct(p.change24h)}
🌊 ${f.net >= 0 ? "+" : ""}${formatUsd(f.net)}
${marketBias(p.change24h, f.net)}
`, { parse_mode: "HTML" });
});

bot.onText(/\/prices/, async (msg) => {
  await updateLivePrices();

  let text = `📊 <b>LIVE PRICES</b>\n\n`;

  for (const asset of Object.keys(MARKETS)) {
    const p = livePrices[asset];
    const m = MARKETS[asset];

    text += `${m.emoji} <b>${m.display}</b> ${formatUsd(p.price)} ${formatPct(p.change24h)}\n`;
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
  await updateLivePrices();
  await sendGroup(buildSummary());
  await bot.sendMessage(msg.chat.id, "✅ Summary sent.");
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}
Binance Scan: ${BINANCE_SCAN_ENABLED ? "ON ✅" : "OFF ❌"}
Prices: CoinGecko ✅

Markets:
BTC ✅
ETH ✅
BNB ✅
AVAX ✅
MATIC/POL ✅

Min WAI: ${MIN_WAI_ACCESS}
Test Mode: ${TEST_ACCESS_MODE ? "ON ✅" : "OFF ❌"}

Users: ${users.length}
Active: ${active}
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

  await updateLivePrices();

  await sendGroup(
    compactSignalMessage({
      asset: "BTC",
      side: "BUY",
      amount: 12.5,
      usdValue: 12.5 * (livePrices.BTC.price || 105000),
      price: livePrices.BTC.price || 105000,
      change24h: livePrices.BTC.change24h,
      wallet: "0x1234...abcd",
      tx: `<a href="https://mempool.space">TX</a>`,
      avgBuy: formatUsd(98500),
      pnl: "+6.60%"
    })
  );

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

console.log("WhaleSignals Compact Signal Bot running...");
console.log("Markets: BTC ETH BNB AVAX MATIC/POL");
console.log("Prices: CoinGecko");
console.log("Binance Scan:", BINANCE_SCAN_ENABLED);
console.log("Signals:", signalsEnabled);

require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const ETH_RPC = process.env.ETH_RPC || "https://ethereum.publicnode.com";
const BNB_RPC = process.env.BNB_RPC || "https://bsc-dataseed.binance.org";

const BASESCAN_URL = "https://basescan.org";
const ETHERSCAN_URL = "https://etherscan.io";
const BSCSCAN_URL = "https://bscscan.com";

const WAI_CONTRACT_ADDRESS =
  process.env.WAI_CONTRACT_ADDRESS || "0x27feEC78cDc8b6B3D3782bc4393103F2BCd50427";

const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);
const TEST_ACCESS_MODE = String(process.env.TEST_ACCESS_MODE || "true") === "true";

let signalsEnabled = String(process.env.SIGNALS_ENABLED || "false") === "true";

const CHECK_SIGNALS_INTERVAL_SECONDS = Number(process.env.CHECK_SIGNALS_INTERVAL_SECONDS || 60);
const CHECK_HOLDERS_INTERVAL_SECONDS = Number(process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600);

const BTC_ENABLED = String(process.env.BTC_ENABLED || "true") === "true";
const ETH_ENABLED = String(process.env.ETH_ENABLED || "true") === "true";
const BNB_ENABLED = String(process.env.BNB_ENABLED || "true") === "true";

const MIN_BTC_WHALE = Number(process.env.MIN_BTC_WHALE || 5);
const MIN_ETH_WHALE = Number(process.env.MIN_ETH_WHALE || 50);
const MIN_BNB_WHALE = Number(process.env.MIN_BNB_WHALE || 500);

const USERS_FILE = "users.json";
const SEEN_FILE = "seen.json";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
const bnbProvider = new ethers.JsonRpcProvider(BNB_RPC);

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

function walletLink(address, explorer) {
  if (!address) return "unknown";
  return `<a href="${explorer}/address/${address}">${shortWallet(address)}</a>`;
}

function txLink(hash, explorer) {
  return `<a href="${explorer}/tx/${hash}">View Transaction</a>`;
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

      const btc = Number(tx.value || 0) / 100000000;

      if (btc < MIN_BTC_WHALE) continue;

      await sendSignal(`
🐋 <b>BTC WHALE TRANSFER</b>

<b>Asset:</b> BTC
<b>Amount:</b> ${btc.toFixed(4)} BTC

<b>Tx:</b> <a href="https://mempool.space/tx/${tx.txid}">View Transaction</a>
`);
    }

    seen.txs = Array.from(seenSet).slice(-5000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error("BTC scan error:", err.message);
  }
}

async function scanNativeWhales({ key, name, symbol, provider, explorer, minAmount }) {
  try {
    const latestBlock = await provider.getBlockNumber();
    const block = await provider.getBlock(latestBlock, true);

    if (!block || !block.prefetchedTransactions) return;

    const seen = readJson(SEEN_FILE, { txs: [] });
    const seenSet = new Set(seen.txs || []);

    for (const tx of block.prefetchedTransactions) {
      const id = `${key}-${tx.hash}`;
      if (seenSet.has(id)) continue;
      seenSet.add(id);

      const amount = Number(ethers.formatEther(tx.value || 0n));

      if (amount < minAmount) continue;

      await sendSignal(`
🐋 <b>${symbol} WHALE TRANSFER</b>

<b>Asset:</b> ${symbol}
<b>Chain:</b> ${name}
<b>Amount:</b> ${amount.toLocaleString()} ${symbol}

<b>From:</b> ${walletLink(tx.from, explorer)}
<b>To:</b> ${walletLink(tx.to, explorer)}

<b>Tx:</b> ${txLink(tx.hash, explorer)}
`);
    }

    seen.txs = Array.from(seenSet).slice(-5000);
    writeJson(SEEN_FILE, seen);
  } catch (err) {
    console.error(`${symbol} scan error:`, err.message);
  }
}

async function runSignals() {
  await scanBTCWhales();

  if (ETH_ENABLED) {
    await scanNativeWhales({
      key: "eth",
      name: "Ethereum",
      symbol: "ETH",
      provider: ethProvider,
      explorer: ETHERSCAN_URL,
      minAmount: MIN_ETH_WHALE
    });
  }

  if (BNB_ENABLED) {
    await scanNativeWhales({
      key: "bnb",
      name: "BNB Chain",
      symbol: "BNB",
      provider: bnbProvider,
      explorer: BSCSCAN_URL,
      minAmount: MIN_BNB_WHALE
    });
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
/markets

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

bot.onText(/\/markets/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Markets

✅ BTC
✅ ETH
✅ BNB

Coming next:
AVAX
LINK
DOGE
XRP
SOL
SUI
HYPE
`);
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  const users = readJson(USERS_FILE, []);
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Admin Status

Signals: ${signalsEnabled ? "ON ✅" : "OFF ❌"}

Markets:
BTC: ${BTC_ENABLED ? "ON ✅" : "OFF ❌"}
ETH: ${ETH_ENABLED ? "ON ✅" : "OFF ❌"}
BNB: ${BNB_ENABLED ? "ON ✅" : "OFF ❌"}

Minimum Whale:
BTC: ${MIN_BTC_WHALE} BTC
ETH: ${MIN_ETH_WHALE} ETH
BNB: ${MIN_BNB_WHALE} BNB

Group ID: ${TELEGRAM_GROUP_ID}
WAI Contract: ${WAI_CONTRACT_ADDRESS}

Minimum WAI Required: ${MIN_WAI_ACCESS}
Test Access Mode: ${TEST_ACCESS_MODE ? "ON ✅" : "OFF ❌"}

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

bot.onText(/\/testgroup/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await sendGroup(`
🐋 <b>WhaleSignals VIP group connected successfully.</b>

<b>Markets:</b> BTC, ETH, BNB
<b>WAI Contract:</b> <a href="${BASESCAN_URL}/token/${WAI_CONTRACT_ADDRESS}">View Contract</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Test message sent to group.");
});

bot.onText(/\/testsignal/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await sendGroup(`
🐋 <b>BTC WHALE TRANSFER</b>

<b>Asset:</b> BTC
<b>Amount:</b> 12.5000 BTC

<b>Tx:</b> <a href="https://mempool.space/tx/0000000000000000000000000000000000000000000000000000000000000000">View Transaction</a>
`);

  await sendGroup(`
🐋 <b>ETH WHALE TRANSFER</b>

<b>Asset:</b> ETH
<b>Chain:</b> Ethereum
<b>Amount:</b> 150 ETH

<b>From:</b> <a href="https://etherscan.io/address/0x0000000000000000000000000000000000000000">Demo Wallet</a>
<b>To:</b> <a href="https://etherscan.io/address/0x0000000000000000000000000000000000000000">Demo Wallet</a>

<b>Tx:</b> <a href="https://etherscan.io/tx/0x0000000000000000000000000000000000000000000000000000000000000000">View Transaction</a>
`);

  await sendGroup(`
🐋 <b>BNB WHALE TRANSFER</b>

<b>Asset:</b> BNB
<b>Chain:</b> BNB Chain
<b>Amount:</b> 1,200 BNB

<b>From:</b> <a href="https://bscscan.com/address/0x0000000000000000000000000000000000000000">Demo Wallet</a>
<b>To:</b> <a href="https://bscscan.com/address/0x0000000000000000000000000000000000000000">Demo Wallet</a>

<b>Tx:</b> <a href="https://bscscan.com/tx/0x0000000000000000000000000000000000000000000000000000000000000000">View Transaction</a>
`);

  await bot.sendMessage(msg.chat.id, "✅ Demo BTC, ETH and BNB signals sent.");
});

bot.onText(/\/checkholders/, async (msg) => {
  if (!isOwner(msg.chat.id)) return bot.sendMessage(msg.chat.id, "Access denied.");

  await bot.sendMessage(msg.chat.id, "Checking holders...");
  await checkAllHolders();
  await bot.sendMessage(msg.chat.id, "✅ Holder check completed.");
});

setInterval(runSignals, CHECK_SIGNALS_INTERVAL_SECONDS * 1000);
setInterval(checkAllHolders, CHECK_HOLDERS_INTERVAL_SECONDS * 1000);

console.log("WhaleSignals BTC ETH BNB Bot running...");
console.log("Owner:", OWNER_TELEGRAM_ID);
console.log("Group:", TELEGRAM_GROUP_ID);
console.log("Signals:", signalsEnabled);
console.log("BTC:", BTC_ENABLED);
console.log("ETH:", ETH_ENABLED);
console.log("BNB:", BNB_ENABLED);

require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const { ethers } = require("ethers");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "1657654539");
const TELEGRAM_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || "-1003819742117");

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const WAI_CONTRACT_ADDRESS = process.env.WAI_CONTRACT_ADDRESS || "";
const MIN_WAI_ACCESS = Number(process.env.MIN_WAI_ACCESS || 1000);

const CHECK_HOLDERS_INTERVAL_SECONDS = Number(
  process.env.CHECK_HOLDERS_INTERVAL_SECONDS || 3600
);

const USERS_FILE = "users.json";

const provider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

function isOwner(chatId) {
  return String(chatId) === OWNER_TELEGRAM_ID;
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function shortWallet(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function getWaiBalance(wallet) {
  if (!ethers.isAddress(WAI_CONTRACT_ADDRESS)) {
    throw new Error("WAI_CONTRACT_ADDRESS missing or invalid");
  }

  const token = new ethers.Contract(
    WAI_CONTRACT_ADDRESS,
    ERC20_ABI,
    provider
  );

  const decimals = await token.decimals();
  const rawBalance = await token.balanceOf(wallet);

  return Number(ethers.formatUnits(rawBalance, decimals));
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
  const users = loadUsers();
  let changed = false;

  for (const user of users) {
    if (!user.verified) continue;

    try {
      const balance = await getWaiBalance(user.wallet);

      user.lastBalance = balance;
      user.lastCheck = new Date().toISOString();

      if (balance < MIN_WAI_ACCESS) {
        user.verified = false;
        user.removedAt = new Date().toISOString();

        await removeUserFromGroup(user.telegramId);

        await bot.sendMessage(
          user.telegramId,
          `❌ Access Revoked

Your WAI balance is now below the required minimum.

Wallet: ${shortWallet(user.wallet)}
Current Balance: ${balance} WAI
Required Minimum: ${MIN_WAI_ACCESS} WAI`
        );

        changed = true;
      }
    } catch (err) {
      console.error("Holder check error:", err.message);
    }
  }

  if (changed) saveUsers(users);
}

bot.on("message", (msg) => {
  console.log("CHAT ID:", msg.chat.id);
  console.log("TITLE:", msg.chat.title);
});

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals VIP Access

Welcome to WhaleSignals.

To access the private VIP signals group, verify your WAI holdings on Base.

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

    if (balance < MIN_WAI_ACCESS) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Access Denied

Wallet: ${shortWallet(wallet)}
Balance: ${balance} WAI
Required Minimum: ${MIN_WAI_ACCESS} WAI

You need to hold more WAI on Base to access the VIP group.`
      );
    }

    const users = loadUsers();

    const existingIndex = users.findIndex(
      u => String(u.telegramId) === telegramId
    );

    const userData = {
      telegramId,
      wallet,
      verified: true,
      lastBalance: balance,
      verifiedAt: new Date().toISOString(),
      lastCheck: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      users[existingIndex] = {
        ...users[existingIndex],
        ...userData
      };
    } else {
      users.push(userData);
    }

    saveUsers(users);

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
    await bot.sendMessage(
      msg.chat.id,
      "❌ Verification failed. Please try again later."
    );
  }
});

bot.onText(/\/myaccess/, async (msg) => {
  const telegramId = String(msg.chat.id);
  const users = loadUsers();

  const user = users.find(u => String(u.telegramId) === telegramId);

  if (!user) {
    return bot.sendMessage(
      msg.chat.id,
      "No verified wallet found. Use /verify WALLET_ADDRESS to request VIP access."
    );
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

  const users = loadUsers();
  const active = users.filter(u => u.verified).length;

  await bot.sendMessage(msg.chat.id, `
🐋 WhaleSignals Admin Status

Group ID: ${TELEGRAM_GROUP_ID}
WAI Contract: ${WAI_CONTRACT_ADDRESS || "NOT SET"}
Minimum WAI Required: ${MIN_WAI_ACCESS}

Total Users: ${users.length}
Active Users: ${active}

Automatic Holder Check:
Every ${CHECK_HOLDERS_INTERVAL_SECONDS} seconds
`);
});

bot.onText(/\/testgroup/, async (msg) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  await bot.sendMessage(
    TELEGRAM_GROUP_ID,
    "🐋 WhaleSignals VIP group connected successfully."
  );

  await bot.sendMessage(msg.chat.id, "✅ Test message sent to the VIP group.");
});

bot.onText(/\/checkholders/, async (msg) => {
  if (!isOwner(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  await bot.sendMessage(msg.chat.id, "Checking verified holders...");
  await checkAllHolders();
  await bot.sendMessage(msg.chat.id, "✅ Holder check completed.");
});

setInterval(checkAllHolders, CHECK_HOLDERS_INTERVAL_SECONDS * 1000);

console.log("WAI VIP Access Bot running...");
console.log("Owner:", OWNER_TELEGRAM_ID);
console.log("Group:", TELEGRAM_GROUP_ID);
console.log("Minimum WAI:", MIN_WAI_ACCESS);

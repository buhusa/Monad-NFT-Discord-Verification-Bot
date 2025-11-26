# 🤖 Monad NFT Discord Verification Bot

Automatically verify Monad NFT holders and assign Discord roles with a single slash command. Monad is fully EVM compatible, so the entire stack reuses familiar Ethereum tooling.

---

## 📋 Overview

- ⚡ **Monad Performance:** 10k TPS, 400 ms blocks, sub-second finality  
- 🔗 **EVM Compatible:** Works with standard Ethereum RPC APIs and tooling  
- 🎨 **NFT Standards:** Supports ERC‑721 and ERC‑1155 collections  
- 🔐 **Secure Verification:** Wallet signature flow prevents impersonation  

---

## 🛠️ Setup Instructions

1. **Create a Discord Bot**
   - Visit the [Discord Developer Portal](https://discord.com/developers/applications)
   - Create a new application → Bot → *Add Bot*
   - Copy the bot token and enable **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT**

2. **Invite the Bot**
   - Go to **OAuth2 → URL Generator**
   - Scopes: `bot`, `applications.commands`
   - Permissions: *Manage Roles*, *Send Messages*, *Use Slash Commands*
   - Use the generated URL to add the bot to your server

3. **Get a Monad RPC Endpoint**
   - [Chainstack](https://chainstack.com) (recommended, free tier)
   - Public: `https://rpc.monad.xyz/` (mainnet) or `https://testnet-rpc.monad.xyz/`
   - Ankr: `https://rpc.ankr.com/monad_testnet`

4. **Install Dependencies**

   ```bash
   npm init -y
   npm install discord.js ethers dotenv express
   ```

5. **Create the Verification Page**
   - Add a `public` directory with `verify.html` (see code below)

---

## ⚙️ Configuration

Create a `.env` file in the project root:

```bash
DISCORD_TOKEN=your_discord_bot_token_here
MONAD_RPC_URL=https://rpc.monad.xyz/
NFT_CONTRACT_ADDRESS=0xYourNFTContractAddress
VERIFIED_ROLE_ID=your_discord_role_id
GUILD_ID=your_discord_server_id
PORT=3000
```

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Developer Portal |
| `MONAD_RPC_URL` | Monad RPC endpoint (mainnet/testnet) |
| `NFT_CONTRACT_ADDRESS` | Target NFT collection |
| `VERIFIED_ROLE_ID` | Role granted to verified holders |
| `GUILD_ID` | Discord server ID |
| `PORT` | Express server port (default 3000) |

> 💡 **Discord IDs:** Enable *Developer Mode* in Discord → right-click roles/servers → *Copy ID*.

---

## 💻 Core Files

### `bot.js`

```js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const { ethers } = require('ethers');
const express = require('express');
const path = require('path');

const config = {
    token: process.env.DISCORD_TOKEN,
    rpcUrl: process.env.MONAD_RPC_URL,
    nftContract: process.env.NFT_CONTRACT_ADDRESS,
    verifiedRoleId: process.env.VERIFIED_ROLE_ID,
    guildId: process.env.GUILD_ID,
    port: process.env.PORT || 3000
};

const pendingVerifications = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
    ]
});

const provider = new ethers.JsonRpcProvider(config.rpcUrl);

const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'
];

async function checkNFTOwnership(walletAddress) {
    try {
        const contract = new ethers.Contract(config.nftContract, ERC721_ABI, provider);
        const balance = await contract.balanceOf(walletAddress);
        return balance > 0n;
    } catch (error) {
        console.error('Error checking NFT ownership:', error);
        return false;
    }
}

function verifySignature(message, signature, expectedAddress) {
    try {
        const recoveredAddress = ethers.verifyMessage(message, signature);
        return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    } catch (error) {
        console.error('Error verifying signature:', error);
        return false;
    }
}

const commands = [
    { name: 'verify', description: 'Get a link to verify your NFT ownership' },
    {
        name: 'checkwallet',
        description: 'Check if a wallet holds the required NFT',
        options: [
            {
                name: 'address',
                description: 'Wallet address to check',
                type: 3,
                required: true
            }
        ]
    }
];

client.once('ready', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, config.guildId),
            { body: commands }
        );
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply({ ephemeral: true });
        const userId = interaction.user.id;
        const verificationToken = Buffer.from(`${userId}-${Date.now()}`).toString('base64');
        pendingVerifications.set(verificationToken, {
            userId,
            guildId: interaction.guildId,
            timestamp: Date.now()
        });

        const verifyUrl = `http://localhost:3000/verify?token=${verificationToken}`;

        const embed = new EmbedBuilder()
            .setColor('#10b981')
            .setTitle('🔐 Verify Your NFT Ownership')
            .setDescription('Click the button below to connect your wallet and verify!')
            .addFields(
                { name: '📝 Instructions', value: '1. Click "Verify Now"\n2. Connect your wallet\n3. Sign the message\n4. Get your role automatically!' },
                { name: '⏱️ Link Expires', value: 'In 10 minutes', inline: true },
                { name: '🔒 Security', value: 'Ephemeral (only you can see this)', inline: true }
            )
            .setFooter({ text: 'Your wallet info is never stored' })
            .setTimestamp();

        await interaction.editReply({ 
            embeds: [embed],
            components: [{
                type: 1,
                components: [{
                    type: 2,
                    style: 5,
                    label: 'Verify Now 🚀',
                    url: verifyUrl
                }]
            }]
        });

        setTimeout(() => pendingVerifications.delete(verificationToken), 600000);
    }

    if (commandName === 'checkwallet') {
        await interaction.deferReply();
        const address = interaction.options.getString('address');
        const hasNFT = await checkNFTOwnership(address);

        const embed = new EmbedBuilder()
            .setColor(hasNFT ? '#10b981' : '#6b7280')
            .setTitle('🔍 Wallet Check')
            .setDescription(`Wallet: \`${address}\``)
            .addFields(
                { name: 'NFT Holder', value: hasNFT ? '✅ Yes' : '❌ No', inline: true },
                { name: 'Contract', value: `\`${config.nftContract.slice(0, 8)}...${config.nftContract.slice(-6)}\``, inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
});

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.post('/api/verify', async (req, res) => {
    try {
        const { token, walletAddress, signature } = req.body;
        const verification = pendingVerifications.get(token);
        if (!verification) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        const message = 'Verify NFT for Discord';
        const isValidSignature = verifySignature(message, signature, walletAddress);
        if (!isValidSignature) {
            return res.status(400).json({ error: 'Invalid signature' });
        }

        const hasNFT = await checkNFTOwnership(walletAddress);
        if (!hasNFT) {
            return res.status(400).json({ error: 'Wallet does not hold required NFT' });
        }

        const guild = client.guilds.cache.get(verification.guildId);
        const member = await guild.members.fetch(verification.userId);
        const role = guild.roles.cache.get(config.verifiedRoleId);
        if (!role) {
            return res.status(500).json({ error: 'Role not found' });
        }

        await member.roles.add(role);
        pendingVerifications.delete(token);

        res.json({ 
            success: true, 
            message: 'Verification successful! Check Discord for your new role.',
            wallet: `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
        });

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

app.listen(config.port, () => {
    console.log(`🌐 Verification server running on http://localhost:${config.port}`);
});

setInterval(async () => {
    console.log('🔄 Running periodic verification check...');

    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;

    const role = guild.roles.cache.get(config.verifiedRoleId);
    if (!role) return;

    const members = role.members;

    for (const [memberId, member] of members) {
        console.log(`Checking member: ${member.user.tag}`);
        // TODO: look up wallets from your DB and re-verify ownership.
    }
}, 3600000);

client.login(config.token);
```

### `public/verify.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify NFT Ownership</title>
    <script src="https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
        p { color: #666; margin-bottom: 30px; }
        .btn {
            width: 100%;
            padding: 16px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            margin-bottom: 15px;
        }
        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .status {
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            display: none;
        }
        .status.success { background: #d1fae5; color: #065f46; display: block; }
        .status.error { background: #fee2e2; color: #991b1b; display: block; }
        .status.info { background: #dbeafe; color: #1e40af; display: block; }
        .wallet-info {
            background: #f3f4f6;
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            display: none;
        }
        .wallet-info.show { display: block; }
        .wallet-address {
            font-family: monospace;
            font-size: 14px;
            color: #374151;
            word-break: break-all;
        }
        .spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 20px auto;
            display: none;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 NFT Verification</h1>
        <p>Connect your wallet to verify NFT ownership</p>

        <button id="connectBtn" class="btn btn-primary">Connect Wallet</button>
        <button id="signBtn" class="btn btn-primary" style="display:none;">Sign Message &amp; Verify</button>

        <div id="walletInfo" class="wallet-info">
            <strong>Connected Wallet:</strong><br>
            <span class="wallet-address" id="walletAddress"></span>
        </div>

        <div id="status" class="status"></div>
        <div id="spinner" class="spinner"></div>
    </div>

    <script>
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');
        
        let provider, signer, userAddress;

        const connectBtn = document.getElementById('connectBtn');
        const signBtn = document.getElementById('signBtn');
        const walletInfo = document.getElementById('walletInfo');
        const walletAddress = document.getElementById('walletAddress');
        const status = document.getElementById('status');
        const spinner = document.getElementById('spinner');

        function showStatus(message, type) {
            status.textContent = message;
            status.className = `status ${type}`;
            status.style.display = 'block';
        }

        function showSpinner(show) {
            spinner.style.display = show ? 'block' : 'none';
        }

        connectBtn.addEventListener('click', async () => {
            try {
                if (typeof window.ethereum === 'undefined') {
                    showStatus('Please install MetaMask or another Web3 wallet!', 'error');
                    return;
                }

                showSpinner(true);
                provider = new window.ethers.providers.Web3Provider(window.ethereum);
                await provider.send("eth_requestAccounts", []);
                signer = provider.getSigner();
                userAddress = await signer.getAddress();

                walletAddress.textContent = userAddress;
                walletInfo.classList.add('show');
                connectBtn.style.display = 'none';
                signBtn.style.display = 'block';
                showStatus('Wallet connected! Now click "Sign Message" to verify.', 'success');
                showSpinner(false);
            } catch (error) {
                console.error(error);
                showStatus('Failed to connect wallet: ' + error.message, 'error');
                showSpinner(false);
            }
        });

        signBtn.addEventListener('click', async () => {
            try {
                showSpinner(true);
                signBtn.disabled = true;
                showStatus('Please sign the message in your wallet...', 'info');

                const message = 'Verify NFT for Discord';
                const signature = await signer.signMessage(message);

                showStatus('Verifying NFT ownership...', 'info');

                const response = await fetch('/api/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, walletAddress: userAddress, signature })
                });

                const result = await response.json();

                if (response.ok) {
                    showStatus('✅ ' + result.message + ' You can close this window.', 'success');
                } else {
                    showStatus('❌ ' + result.error, 'error');
                    signBtn.disabled = false;
                }
                showSpinner(false);
            } catch (error) {
                console.error(error);
                showStatus('Verification failed: ' + error.message, 'error');
                signBtn.disabled = false;
                showSpinner(false);
            }
        });
    </script>
</body>
</html>
```

### `package.json`

```json
{
  "name": "monad-nft-discord-bot",
  "version": "1.0.0",
  "description": "Discord bot for verifying Monad NFT holders",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js",
    "dev": "node --watch bot.js"
  },
  "keywords": ["discord", "nft", "monad", "verification"],
  "author": "",
  "license": "MIT",
  "dependencies": {
    "discord.js": "^14.14.1",
    "dotenv": "^16.3.1",
    "ethers": "^6.10.0",
    "express": "^4.18.2"
  }
}
```

### Advanced: ERC-1155 Support

```js
const ERC1155_ABI = [
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])'
];

async function checkERC1155Ownership(walletAddress, tokenId) {
    try {
        const contract = new ethers.Contract(config.nftContract, ERC1155_ABI, provider);
        const balance = await contract.balanceOf(walletAddress, tokenId);
        return balance > 0n;
    } catch (error) {
        console.error('Error checking ERC-1155 ownership:', error);
        return false;
    }
}

async function checkMultipleTokens(walletAddress, tokenIds) {
    try {
        const contract = new ethers.Contract(config.nftContract, ERC1155_ABI, provider);
        const addresses = new Array(tokenIds.length).fill(walletAddress);
        const balances = await contract.balanceOfBatch(addresses, tokenIds);
        return balances.some(balance => balance > 0n);
    } catch (error) {
        console.error('Error checking multiple tokens:', error);
        return false;
    }
}
```

---

## 🚀 Running the Bot

1. **Populate `.env`** with your configuration.  
2. **Start the bot**

   ```bash
   npm start
   ```

3. **Test in Discord** using `/verify` or `/checkwallet`.

---

## 📝 User Verification Flow (Easy Mode)

1. In Discord, type `/verify`.  
2. Click the private verification link.  
3. Connect wallet → sign message → done.  

> ⚠️ The verification page talks directly to wallets via Web3—no manual signatures needed.

---

## 🔧 Advanced Features

- **Automatic Re-Verification:** Periodic job (default hourly) re-checks holders and can remove roles if they sell the NFT. Store wallet ↔ user mappings in a DB to enable this.  
- **Multiple Collections:** Extend `config` to map NFT contracts → Discord roles for tiered communities.  
- **Database Integration:** Persist wallet addresses, verification timestamps, and allow multiple wallets per user with MongoDB/PostgreSQL.

---

## 🐛 Troubleshooting

| Issue | Fix |
| --- | --- |
| Bot ignores commands | Enable MESSAGE CONTENT INTENT, ensure permissions, confirm `GUILD_ID` |
| RPC errors / timeouts | Switch RPC provider, try Chainstack, check Monad network status |
| Role assignment fails | Bot role must be higher; ensure `Manage Roles` permission and correct `VERIFIED_ROLE_ID` |
| NFT not detected | Confirm contract address, token standard, and test with `/checkwallet` |

---

## 🌐 Deployment Options

- 🖥️ **VPS:** DigitalOcean, Linode, AWS EC2 for 24/7 uptime  
- ☁️ **Heroku:** Quick deployment (keep dynos awake)  
- 🐳 **Docker:** Containerize for reproducible environments  
- 💻 **Local:** Great for development; keep machine on for continuous service  

---

✨ **All set!** Keep the bot running to continuously verify Monad NFT holders and auto-assign roles.

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const { ethers } = require('ethers');
const express = require('express');
const path = require('path');

// Configuration
const config = {
    token: process.env.DISCORD_TOKEN,
    rpcUrl: process.env.MONAD_RPC_URL,
    nftContract: process.env.NFT_CONTRACT_ADDRESS,
    verifiedRoleId: process.env.VERIFIED_ROLE_ID,
    guildId: process.env.GUILD_ID,
    port: process.env.PORT || 3000
};

// Store pending verifications (use Redis/DB in production)
const pendingVerifications = new Map();

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
    ]
});

// Initialize Monad provider
const provider = new ethers.JsonRpcProvider(config.rpcUrl);

// ERC-721 ABI for balanceOf function
const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'
];

// Check if wallet holds NFT
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

// Verify wallet signature
function verifySignature(message, signature, expectedAddress) {
    try {
        const recoveredAddress = ethers.verifyMessage(message, signature);
        return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    } catch (error) {
        console.error('Error verifying signature:', error);
        return false;
    }
}

// Register slash commands
const commands = [
    {
        name: 'verify',
        description: 'Get a link to verify your NFT ownership'
    },
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

// Bot ready event
client.once('ready', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    
    // Register slash commands
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

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'verify') {
        await interaction.deferReply({ ephemeral: true });

        // Generate unique verification token
        const userId = interaction.user.id;
        const verificationToken = Buffer.from(`${userId}-${Date.now()}`).toString('base64');
        
        // Store pending verification (in production, use a database)
        pendingVerifications.set(verificationToken, {
            userId,
            guildId: interaction.guildId,
            timestamp: Date.now()
        });

        // Create verification URL
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
                    style: 5, // Link button
                    label: 'Verify Now 🚀',
                    url: verifyUrl
                }]
            }]
        });

        // Cleanup old tokens after 10 minutes
        setTimeout(() => {
            pendingVerifications.delete(verificationToken);
        }, 600000);
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

// Express server for verification page
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Serve verification page
app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

// Handle verification submission
app.post('/api/verify', async (req, res) => {
    try {
        const { token, walletAddress, signature } = req.body;

        // Check if token is valid
        const verification = pendingVerifications.get(token);
        if (!verification) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        // Verify signature
        const message = 'Verify NFT for Discord';
        const isValidSignature = verifySignature(message, signature, walletAddress);
        
        if (!isValidSignature) {
            return res.status(400).json({ error: 'Invalid signature' });
        }

        // Check NFT ownership
        const hasNFT = await checkNFTOwnership(walletAddress);
        
        if (!hasNFT) {
            return res.status(400).json({ error: 'Wallet does not hold required NFT' });
        }

        // Assign role
        const guild = client.guilds.cache.get(verification.guildId);
        const member = await guild.members.fetch(verification.userId);
        const role = guild.roles.cache.get(config.verifiedRoleId);

        if (!role) {
            return res.status(500).json({ error: 'Role not found' });
        }

        await member.roles.add(role);

        // Clean up
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

// Start Express server
app.listen(config.port, () => {
    console.log(`🌐 Verification server running on http://localhost:${config.port}`);
});

// Automatic re-verification (runs every hour)
setInterval(async () => {
    console.log('🔄 Running periodic verification check...');
    
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    
    const role = guild.roles.cache.get(config.verifiedRoleId);
    if (!role) return;
    
    const members = role.members;
    
    for (const [memberId, member] of members) {
        // Note: In production, store wallet addresses in a database
        // For now, this just logs the check
        console.log(`Checking member: ${member.user.tag}`);
        // To implement fully, you'd query your DB for their wallet and check:
        // const walletAddress = await getWalletFromDB(memberId);
        // const hasNFT = await checkNFTOwnership(walletAddress);
        // if (!hasNFT) await member.roles.remove(role);
    }
}, 3600000); // Every hour (3600000ms)

// Login
client.login(config.token);
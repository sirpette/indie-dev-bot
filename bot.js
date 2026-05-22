const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

// ============================================
// RATE LIMITING SYSTEM
// ============================================
const userUsage = new Map();

function checkRateLimit(userId, command) {
  const now = Date.now();
  const key = `${userId}-${command}`;
  
  if (!userUsage.has(key)) {
    userUsage.set(key, []);
  }
  
  const requests = userUsage.get(key).filter(time => now - time < 24 * 60 * 60 * 1000);
  
  const limits = {
    'ask-game-design': 5,
    'launch-countdown': 1
  };
  
  const limit = limits[command] || 999;
  
  if (requests.length >= limit) {
    return { allowed: false, used: limit, limit: limit };
  }
  
  requests.push(now);
  userUsage.set(key, requests);
  
  return { allowed: true, used: requests.length, limit: limit };
}

// ============================================
// INITIALIZE DISCORD CLIENT
// ============================================
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// Track bot statistics
const stats = {
  commands_run: 0,
  errors: 0,
  start_time: new Date(),
  servers: new Set()
};

// ============================================
// READY EVENT - Bot connected to Discord
// ============================================
client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  registerCommands();
  
  // Set bot status
  client.user.setActivity('/ask-game-design', { type: 'LISTENING' });
});

// ============================================
// REGISTER SLASH COMMANDS
// ============================================
async function registerCommands() {
  const commands = [
    // Command 1: Ask Game Design
    new SlashCommandBuilder()
      .setName('ask-game-design')
      .setDescription('Ask Claude about game design questions')
      .addStringOption(option =>
        option.setName('question')
          .setDescription('Your game design question')
          .setRequired(true)
      ),
    
    // Command 2: Launch Countdown
    new SlashCommandBuilder()
      .setName('launch-countdown')
      .setDescription('Create a launch countdown timeline for your game')
      .addStringOption(option =>
        option.setName('game-name')
          .setDescription('Your game name')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName('days-until-launch')
          .setDescription('Days until launch (1-90)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(90)
      ),

    // Command 3: Premium Info
    new SlashCommandBuilder()
      .setName('premium')
      .setDescription('Learn about Premium tier - unlimited usage')
  ];

  try {
    console.log('📝 Registering commands...');
    
    const commandsJSON = commands.map(cmd => cmd.toJSON());
    console.log('Commands to register:', commandsJSON.map(c => c.name).join(', '));
    
    await client.application.commands.set(commandsJSON);
    
    console.log('✅ Commands registered successfully!');
    const registered = await client.application.commands.fetch();
    console.log('🔍 Registered commands:', Array.from(registered.values()).map(c => c.name).join(', '));
    
  } catch (error) {
    console.error('❌ Error registering commands:', error);
    console.error('Error details:', error.message);
  }
}

// ============================================
// CLAUDE API CALL (via HTTP)
// ============================================
async function askClaude(question) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: `You are an expert game designer helping indie developers. 
                 Keep answers concise (under 500 words), practical, and actionable.
                 Use bullet points when helpful.
                 Focus on indie game constraints (small teams, limited budgets, tight timelines).`,
        messages: [
          { role: 'user', content: question }
        ]
      },
      {
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY
        }
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error('❌ Claude API error:', error.response?.data || error.message);
    throw new Error(`API Error: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ============================================
// COMMAND HANDLERS
// ============================================
client.on('interactionCreate', async (interaction) => {
  // Only handle slash commands
  if (!interaction.isChatInputCommand()) return;

  // Track command execution
  stats.commands_run++;
  stats.servers.add(interaction.guildId);
  console.log(`\n📊 Command: /${interaction.commandName} by ${interaction.user.username}`);

  // ============================================
  // COMMAND 1: /ask-game-design
  // ============================================
  if (interaction.commandName === 'ask-game-design') {
    const { allowed, used, limit } = checkRateLimit(interaction.user.id, 'ask-game-design');

    if (!allowed) {
      await interaction.reply({
        content: `❌ **Rate limit reached!**\n\nFree tier: ${limit} questions per day\nYou've used all ${limit} today.\n\nUpgrade to Premium for unlimited! Use \`/premium\` to learn more.`,
        ephemeral: true
      });
      return;
    }

    console.log(`📊 User ${interaction.user.username}: ${used}/${limit} questions used today`);

    await interaction.deferReply();
    
    const question = interaction.options.getString('question');
    console.log(`   Question: ${question}`);
    
    try {
      // Call Claude API
      const response = await askClaude(question);

      // Split response if too long for Discord (max 2000 chars per message)
      if (response.length > 2000) {
        const chunks = response.match(/[\s\S]{1,1900}/g) || [];
        console.log(`   Response: ${response.length} chars (split into ${chunks.length} messages)`);
        
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await interaction.editReply(chunks[i]);
          } else {
            await interaction.followUp(chunks[i]);
          }
        }
      } else {
        console.log(`   Response: ${response.length} chars`);
        await interaction.editReply(response);
      }
    } catch (error) {
      stats.errors++;
      console.error(`   ❌ Error:`, error.message);
      await interaction.editReply({
        content: '❌ Error calling Claude API: ' + error.message,
        ephemeral: true
      });
    }
  }

  // ============================================
  // COMMAND 2: /launch-countdown
  // ============================================
  else if (interaction.commandName === 'launch-countdown') {
    const { allowed, used, limit } = checkRateLimit(interaction.user.id, 'launch-countdown');

    if (!allowed) {
      await interaction.reply({
        content: `❌ **Rate limit reached!**\n\nFree tier: ${limit} timeline per day\nYou've used your ${limit} timeline today.\n\nUpgrade to Premium for unlimited! Use \`/premium\` to learn more.`,
        ephemeral: true
      });
      return;
    }

    const gameName = interaction.options.getString('game-name');
    const daysUntilLaunch = interaction.options.getInteger('days-until-launch');

    console.log(`   Game: ${gameName} | Launch in: ${daysUntilLaunch} days`);

    // Calculate launch date
    const launchDate = new Date();
    launchDate.setDate(launchDate.getDate() + daysUntilLaunch);

    // Calculate milestone dates
    const d75 = Math.floor(daysUntilLaunch * 0.75);
    const d50 = Math.floor(daysUntilLaunch * 0.5);
    const d25 = Math.floor(daysUntilLaunch * 0.25);

    // Build timeline
    const timeline = `
🎮 **${gameName} - Launch Timeline**

📅 **Launch Date**: ${launchDate.toDateString()}
⏳ **Time to Go**: ${daysUntilLaunch} days

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 **MILESTONE TIMELINE**

**${d75} days before launch** (Heavy preparation)
• Create 3-5 short gameplay clips (30-60s each)
• Post on TikTok, Instagram Reels, YouTube Shorts
• Reach out to 5-10 relevant indie game streamers
• Start building hype on Reddit/Twitter
• Join indie dev Discord communities

**${d50} days before launch** (Go public)
• Launch Discord community/channel
• Create Steam/Epic wishlist campaign
• Send press kit to indie game journalists
• Do first devlog/behind-the-scenes content
• Reach out to game critics/influencers

**${d25} days before launch** (Intensity up)
• Post daily social media updates
• Gather playtest feedback + iterate
• Create countdown posts ("25 days until launch!")
• Setup launch day live stream
• Coordinate with streamers on launch day

**7 days before** (Final push)
• Daily social media blitz
• Email newsletter if you have one
• Final bug fixes
• Setup launch day schedule

**3 days before** (Last minute)
• Check all links/store pages work
• Test Discord bot (if you have one)
• Prepare thank you messages
• Do final social media blitz

**1 day before** (Ready?!)
• Final social media post
• Confirm streamer coordination
• Check servers/infrastructure
• Get some sleep! 😴

**LAUNCH DAY!** 🚀
• Monitor social media mentions
• Respond to early players on Discord
• Track wishlist → sales conversion
• Engage with streamers/reviewers
• Celebrate! You did it! 🎉

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**💡 Pro Tips:**
✓ Start content creation early (best engagement)
✓ Don't launch on a Friday (weekend = less visibility)
✓ Have Discord moderators ready
✓ Monitor reviews/feedback closely
✓ Thank early supporters publicly

**🎯 Success Metrics to Track:**
• Wishlist count → conversions
• Social media impressions/clicks
• Discord member growth
• Streamer views on launch day
• Day 1 reviews/feedback sentiment
    `;

    try {
      await interaction.reply(timeline);
      console.log(`   ✅ Timeline created successfully`);
    } catch (error) {
      stats.errors++;
      console.error(`   ❌ Error:`, error.message);
      await interaction.reply({
        content: '❌ Error creating timeline: ' + error.message,
        ephemeral: true
      });
    }
  }

  // ============================================
  // COMMAND 3: /premium
  // ============================================
  else if (interaction.commandName === 'premium') {
    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('🚀 Premium Tier - Unlimited Power')
      .setDescription(`
**Free Tier:**
• 5 questions/day with \`/ask-game-design\`
• 1 launch timeline/day with \`/launch-countdown\`
• Basic features
• $0/month

**Premium Tier:**
• Unlimited questions & timelines
• Priority support
• Advanced analytics (coming soon)
• Exclusive features (coming soon)
• $9.99/month

Coming soon: Stripe integration for easy upgrading!
In the meantime, use \`/ask-game-design\` and \`/launch-countdown\` to see what premium could unlock.
      `)
      .setFooter({ text: 'Help indie developers succeed with Indie Dev Bot' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    console.log(`   ✅ Premium info shown`);
  }
});

// ============================================
// ERROR HANDLING
// ============================================
client.on('error', error => {
  stats.errors++;
  console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
  stats.errors++;
  console.error('❌ Unhandled promise rejection:', error);
});

// ============================================
// STATISTICS LOGGING
// ============================================
setInterval(() => {
  const uptime_hours = ((new Date() - stats.start_time) / 1000 / 60 / 60).toFixed(1);
  console.log(`
╔════════════════════════════════════════╗
║          BOT STATISTICS (${uptime_hours}h)          ║
╠════════════════════════════════════════╣
║ Commands Executed: ${stats.commands_run.toString().padEnd(20)}║
║ Errors: ${stats.errors.toString().padEnd(27)}║
║ Active Servers: ${stats.servers.size.toString().padEnd(21)}║
╚════════════════════════════════════════╝
  `);
}, 60 * 60 * 1000); // Every hour

// ============================================
// LOGIN
// ============================================
client.login(process.env.DISCORD_TOKEN);

console.log('🤖 Bot starting...');
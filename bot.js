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
    'launch-countdown': 1,
    'find-testers': 3
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
// IN-MEMORY STORAGE (MVP)
// ============================================
const gamesLookingForTesters = new Map();
const testerProfiles = new Map();
const playtestAssignments = new Map();

// ============================================
// INITIALIZE DISCORD CLIENT
// ============================================
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ]
});

const stats = {
  commands_run: 0,
  errors: 0,
  start_time: new Date(),
  servers: new Set(),
  games_registered: 0,
  playtests_active: 0
};

// ============================================
// READY EVENT
// ============================================
client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  registerCommands();
  client.user.setActivity('/find-testers', { type: 'LISTENING' });
});

// ============================================
// REGISTER COMMANDS
// ============================================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('ask-game-design')
      .setDescription('Ask AI about game design questions')
      .addStringOption(option =>
        option.setName('question')
          .setDescription('Your game design question')
          .setRequired(true)
      ),
    
    new SlashCommandBuilder()
      .setName('launch-countdown')
      .setDescription('Create a launch countdown timeline')
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

    new SlashCommandBuilder()
      .setName('premium')
      .setDescription('Learn about Premium tier'),

    new SlashCommandBuilder()
      .setName('find-testers')
      .setDescription('Register game or browse playtests')
      .addStringOption(option =>
        option.setName('action')
          .setDescription('What do you want to do?')
          .setRequired(true)
          .addChoices(
            { name: 'register', value: 'register' },
            { name: 'browse', value: 'browse' },
            { name: 'my-games', value: 'my-games' },
            { name: 'set-preferences', value: 'set-preferences' }
          )
      )
      .addStringOption(option =>
        option.setName('game')
          .setDescription('Game name (for register)')
      )
      .addStringOption(option =>
        option.setName('genre')
          .setDescription('Genre: platformer, rpg, puzzle, adventure, shooter')
      )
      .addStringOption(option =>
        option.setName('platforms')
          .setDescription('Platforms: PC, mobile, console, web (comma-separated)')
      )
      .addIntegerOption(option =>
        option.setName('testers-needed')
          .setDescription('How many testers do you need? (1-50)')
          .setMinValue(1)
          .setMaxValue(50)
      )
  ];

  try {
    console.log('📝 Registering commands...');
    const commandsJSON = commands.map(cmd => cmd.toJSON());
    await client.application.commands.set(commandsJSON);
    console.log('✅ Commands registered:', commandsJSON.map(c => c.name).join(', '));
  } catch (error) {
    console.error('❌ Error registering commands:', error.message);
  }
}

// ============================================
// GROQ API
// ============================================
async function askAI(question) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content: `You are an expert game designer helping indie developers. 
                     Keep answers concise (under 500 words), practical, and actionable.
                     Use bullet points when helpful.
                     Focus on indie game constraints.`
          },
          { role: 'user', content: question }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('❌ Groq API error:', error.response?.data || error.message);
    throw new Error(`API Error: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ============================================
// HELPER: Find Matching Testers
// ============================================
function findMatchingTesters(genre, platforms) {
  const matching = [];
  
  testerProfiles.forEach((profile, testerId) => {
    const genreMatch = profile.preferredGenres.some(g => 
      g.toLowerCase() === genre.toLowerCase()
    );
    const platformMatch = profile.preferredPlatforms.some(p => 
      platforms.map(pl => pl.toLowerCase()).includes(p.toLowerCase())
    );
    
    if (genreMatch || platformMatch) {
      matching.push({ testerId, username: profile.username });
    }
  });
  
  return matching;
}

// ============================================
// COMMAND HANDLERS
// ============================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  stats.commands_run++;
  stats.servers.add(interaction.guildId);
  console.log(`\n📊 Command: /${interaction.commandName} by ${interaction.user.username}`);

  // ============================================
  // /ask-game-design
  // ============================================
  if (interaction.commandName === 'ask-game-design') {
    const { allowed, used, limit } = checkRateLimit(interaction.user.id, 'ask-game-design');

    if (!allowed) {
      await interaction.reply({
        content: `❌ **Rate limit reached!**\n\nFree tier: ${limit} questions per day\n\nUpgrade to Premium! Use \`/premium\``,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();
    const question = interaction.options.getString('question');
    console.log(`   Question: ${question}`);
    
    try {
      const response = await askAI(question);

      if (response.length > 2000) {
        const chunks = response.match(/[\s\S]{1,1900}/g) || [];
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await interaction.editReply(chunks[i]);
          } else {
            await interaction.followUp(chunks[i]);
          }
        }
      } else {
        await interaction.editReply(response);
      }
    } catch (error) {
      stats.errors++;
      console.error('   ❌ Error:', error.message);
      await interaction.editReply('❌ Error: ' + error.message);
    }
  }

  // ============================================
  // /launch-countdown
  // ============================================
  else if (interaction.commandName === 'launch-countdown') {
    const { allowed } = checkRateLimit(interaction.user.id, 'launch-countdown');

    if (!allowed) {
      await interaction.reply({
        content: '❌ Rate limit! 1 timeline per day on free tier.',
        ephemeral: true
      });
      return;
    }

    const gameName = interaction.options.getString('game-name');
    const daysUntilLaunch = interaction.options.getInteger('days-until-launch');

    console.log(`   Game: ${gameName} | Launch in: ${daysUntilLaunch} days`);

    const launchDate = new Date();
    launchDate.setDate(launchDate.getDate() + daysUntilLaunch);

    const d75 = Math.floor(daysUntilLaunch * 0.75);
    const d50 = Math.floor(daysUntilLaunch * 0.5);
    const d25 = Math.floor(daysUntilLaunch * 0.25);

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

**${d50} days before launch** (Go public)
• Launch Discord community/channel
• Create Steam/Epic wishlist campaign
• Send press kit to indie game journalists

**${d25} days before launch** (Intensity up)
• Post daily social media updates
• Gather playtest feedback + iterate
• Setup launch day live stream

**7 days before** (Final push)
• Daily social media blitz
• Final bug fixes

**LAUNCH DAY!** 🚀
• Monitor social media mentions
• Engage with early players
• Celebrate! 🎉

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use \`/find-testers\` to find playtesters!
    `;

    try {
      await interaction.reply(timeline);
      console.log('   ✅ Timeline created');
    } catch (error) {
      stats.errors++;
      await interaction.reply('❌ Error: ' + error.message);
    }
  }

  // ============================================
  // /premium
  // ============================================
  else if (interaction.commandName === 'premium') {
    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('🚀 Premium Tier')
      .setDescription(`
**Free:** 5 questions/day, 1 timeline/day, 3 game registrations/day
**Premium:** Unlimited + priority notifications + analytics
**Price:** $9.99/month (Coming soon)
      `);

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ============================================
  // /find-testers
  // ============================================
  else if (interaction.commandName === 'find-testers') {
    const action = interaction.options.getString('action');

    if (action === 'register') {
      const { allowed } = checkRateLimit(interaction.user.id, 'find-testers');
      
      if (!allowed) {
        await interaction.reply({
          content: '❌ Rate limit! 3 games per day on free tier.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply();

      const gameName = interaction.options.getString('game');
      const genre = interaction.options.getString('genre');
      const platformsStr = interaction.options.getString('platforms') || 'PC';
      const testersNeeded = interaction.options.getInteger('testers-needed') || 5;

      if (!gameName || !genre) {
        await interaction.editReply('❌ Please provide game name and genre');
        return;
      }

      const gameId = `game-${Date.now()}-${interaction.user.id}`;
      const platforms = platformsStr.split(',').map(p => p.trim());

      gamesLookingForTesters.set(gameId, {
        id: gameId,
        developerId: interaction.user.id,
        developerName: interaction.user.username,
        name: gameName,
        genre: genre.toLowerCase(),
        platforms: platforms,
        testersNeeded: testersNeeded,
        currentTesters: 0,
        status: 'open',
        createdAt: new Date()
      });

      playtestAssignments.set(gameId, []);
      stats.games_registered++;
      stats.playtests_active++;

      // Find matching testers
      const matchingTesters = findMatchingTesters(genre, platforms);
      const matchingInfo = matchingTesters.length > 0
        ? `\n✅ **${matchingTesters.length} testers notified!**\nMatching: ${matchingTesters.map(t => t.username).join(', ')}`
        : `\n⏳ No testers with matching preferences yet.\nTesters: Use \`/find-testers action:set-preferences genre:${genre} platforms:${platformsStr}\` to get notified!`;

      await interaction.editReply({
        content: `
✅ **Game Registered for Testing!**

**Game:** ${gameName}
**Genre:** ${genre}
**Platforms:** ${platforms.join(', ')}
**Testers needed:** ${testersNeeded}
${matchingInfo}

**Testers:** Use \`/find-testers action:browse genre:${genre}\` to see all games!
        `
      });

      console.log(`📝 Game registered: ${gameName} by ${interaction.user.username}`);
      console.log(`📢 Found ${matchingTesters.length} matching testers`);
    }

    else if (action === 'browse') {
      const genre = interaction.options.getString('genre')?.toLowerCase();

      let games = Array.from(gamesLookingForTesters.values())
        .filter(g => g.status === 'open' && g.currentTesters < g.testersNeeded);

      if (genre) {
        games = games.filter(g => g.genre === genre);
      }

      games = games.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);

      if (games.length === 0) {
        await interaction.reply({
          content: `❌ No playtests available right now for ${genre || 'your preferences'}. Check back later!`,
          ephemeral: true
        });
        return;
      }

      let gamesList = '🎮 **Available Playtests**\n\n';
      games.forEach((game, i) => {
        const spotsLeft = game.testersNeeded - game.currentTesters;
        gamesList += `${i + 1}. **${game.name}**
   Dev: ${game.developerName}
   Genre: ${game.genre} | Platforms: ${game.platforms.join(', ')}
   🎯 Spots: ${spotsLeft}/${game.testersNeeded}

`;
      });

      gamesList += `_React to apply or use \`/find-testers action:set-preferences\` to get auto-notified!_`;

      await interaction.reply({
        content: gamesList,
        ephemeral: false
      });

      console.log(`📊 Browsed ${games.length} games (genre: ${genre || 'all'})`);
    }

    else if (action === 'my-games') {
      const devGames = Array.from(gamesLookingForTesters.values())
        .filter(g => g.developerId === interaction.user.id);

      if (devGames.length === 0) {
        await interaction.reply({
          content: '❌ No games registered yet!\nUse `/find-testers action:register`',
          ephemeral: true
        });
        return;
      }

      let gamesList = '📊 **Your Registered Games**\n\n';
      devGames.forEach(game => {
        const testers = playtestAssignments.get(game.id) || [];
        gamesList += `**${game.name}**
Status: ${game.status}
Testers: ${testers.length}/${game.testersNeeded}
Created: ${game.createdAt.toLocaleDateString()}

`;
      });

      await interaction.reply({
        content: gamesList,
        ephemeral: true
      });

      console.log(`📊 Dev viewing their ${devGames.length} games`);
    }

    else if (action === 'set-preferences') {
      const genre = interaction.options.getString('genre');
      const platformsStr = interaction.options.getString('platforms') || 'PC';

      if (!genre) {
        await interaction.reply({
          content: '❌ Please specify preferred genres!',
          ephemeral: true
        });
        return;
      }

      const platforms = platformsStr.split(',').map(p => p.trim());

      testerProfiles.set(interaction.user.id, {
        username: interaction.user.username,
        preferredGenres: [genre.toLowerCase()],
        preferredPlatforms: platforms,
        updatedAt: new Date()
      });

      await interaction.reply({
        content: `
✅ **Preferences Saved!**

You'll be notified when games matching your preferences are registered:
📌 Genres: ${genre}
📌 Platforms: ${platforms.join(', ')}

Now when developers register games with these tags, you'll see them when you use \`/find-testers action:browse\`!
        `,
        ephemeral: true
      });

      console.log(`👤 Tester ${interaction.user.username} set preferences: ${genre} + ${platformsStr}`);
    }
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
  console.error('❌ Unhandled rejection:', error);
});

// ============================================
// STATISTICS
// ============================================
setInterval(() => {
  const uptime = ((new Date() - stats.start_time) / 1000 / 60 / 60).toFixed(1);
  console.log(`
╔════════════════════════════════════════╗
║          BOT STATS (${uptime}h)           ║
╠════════════════════════════════════════╣
║ Commands Executed: ${stats.commands_run}
║ Games Registered: ${stats.games_registered}
║ Active Playtests: ${stats.playtests_active}
║ Errors: ${stats.errors}
║ Servers: ${stats.servers.size}
╚════════════════════════════════════════╝
  `);
}, 60 * 60 * 1000);

// ============================================
// LOGIN
// ============================================
client.login(process.env.DISCORD_TOKEN);

console.log('🤖 Bot starting...');
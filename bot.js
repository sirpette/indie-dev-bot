const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

// ============================================
// DATABASE SETUP
// ============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize database tables on startup
async function initializeDatabase() {
  try {
    console.log('📝 Checking database tables...');

    // Tester profiles table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tester_profiles (
        id SERIAL PRIMARY KEY,
        discord_id VARCHAR(20) UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL,
        preferred_genres TEXT[] DEFAULT '{}',
        preferred_platforms TEXT[] DEFAULT '{}',
        playtests_completed INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Games seeking testers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games_seeking_testers (
        id SERIAL PRIMARY KEY,
        game_id VARCHAR(255) UNIQUE NOT NULL,
        developer_id VARCHAR(20) NOT NULL,
        developer_name VARCHAR(255) NOT NULL,
        game_name VARCHAR(255) NOT NULL,
        genre VARCHAR(100) NOT NULL,
        platforms TEXT[] DEFAULT '{}',
        testers_needed INT NOT NULL,
        current_testers INT DEFAULT 0,
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Playtest assignments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS playtest_assignments (
        id SERIAL PRIMARY KEY,
        game_id VARCHAR(255) NOT NULL,
        tester_id VARCHAR(20) NOT NULL,
        tester_username VARCHAR(255),
        status VARCHAR(50) DEFAULT 'assigned',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(game_id, tester_id)
      );
    `);

    console.log('✅ Database tables ready!');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
  }
}

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
// DATABASE HELPERS
// ============================================

// Find matching testers from database
async function findMatchingTesters(genre, platforms) {
  try {
    const result = await pool.query(
      `SELECT discord_id, username FROM tester_profiles 
       WHERE $1 = ANY(preferred_genres) OR 
             (preferred_platforms && $2)
       LIMIT 100`,
      [genre.toLowerCase(), platforms.map(p => p.toLowerCase())]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Database error finding testers:', error.message);
    return [];
  }
}

// Register tester preferences in database
async function saveTesterPreferences(discordId, username, genres, platforms) {
  try {
    await pool.query(
      `INSERT INTO tester_profiles (discord_id, username, preferred_genres, preferred_platforms, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (discord_id) DO UPDATE SET 
       preferred_genres = $3,
       preferred_platforms = $4,
       updated_at = CURRENT_TIMESTAMP`,
      [discordId, username, genres, platforms]
    );
    return true;
  } catch (error) {
    console.error('❌ Error saving tester preferences:', error.message);
    return false;
  }
}

// Register game in database
async function registerGame(gameId, developerId, developerName, gameName, genre, platforms, testersNeeded) {
  try {
    await pool.query(
      `INSERT INTO games_seeking_testers 
       (game_id, developer_id, developer_name, game_name, genre, platforms, testers_needed, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [gameId, developerId, developerName, gameName, genre.toLowerCase(), platforms, testersNeeded]
    );
    return true;
  } catch (error) {
    console.error('❌ Error registering game:', error.message);
    return false;
  }
}

// Get all games from database
async function getAllGames(genre = null) {
  try {
    let query = 'SELECT * FROM games_seeking_testers WHERE status = \'open\' AND current_testers < testers_needed';
    const params = [];

    if (genre) {
      query += ' AND genre = $1';
      params.push(genre.toLowerCase());
    }

    query += ' ORDER BY created_at DESC LIMIT 10';

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching games:', error.message);
    return [];
  }
}

// Get developer's games from database
async function getDevGames(developerId) {
  try {
    const result = await pool.query(
      `SELECT * FROM games_seeking_testers WHERE developer_id = $1 ORDER BY created_at DESC`,
      [developerId]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching dev games:', error.message);
    return [];
  }
}

// Get testers for a game
async function getGameTesters(gameId) {
  try {
    const result = await pool.query(
      `SELECT tester_id, tester_username FROM playtest_assignments WHERE game_id = $1`,
      [gameId]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching game testers:', error.message);
    return [];
  }
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
  // /find-testers - WITH DATABASE
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

      // Save to database
      const saved = await registerGame(
        gameId,
        interaction.user.id,
        interaction.user.username,
        gameName,
        genre,
        platforms,
        testersNeeded
      );

      if (!saved) {
        await interaction.editReply('❌ Error registering game. Try again.');
        return;
      }

      stats.games_registered++;
      stats.playtests_active++;

      // Find matching testers
      const matchingTesters = await findMatchingTesters(genre, platforms);
      const matchingInfo = matchingTesters.length > 0
        ? `\n✅ **${matchingTesters.length} testers matched!**\nMatching: ${matchingTesters.map(t => t.username).join(', ')}`
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
      console.log(`📊 Database saved | ${matchingTesters.length} matching testers`);
    }

    else if (action === 'browse') {
      const genre = interaction.options.getString('genre')?.toLowerCase();

      const games = await getAllGames(genre);

      if (games.length === 0) {
        await interaction.reply({
          content: `❌ No playtests available right now for ${genre || 'your preferences'}. Check back later!`,
          ephemeral: true
        });
        return;
      }

      let gamesList = '🎮 **Available Playtests**\n\n';
      games.forEach((game, i) => {
        const spotsLeft = game.testers_needed - game.current_testers;
        gamesList += `${i + 1}. **${game.game_name}**
   Dev: ${game.developer_name}
   Genre: ${game.genre} | Platforms: ${game.platforms.join(', ')}
   🎯 Spots: ${spotsLeft}/${game.testers_needed}

`;
      });

      gamesList += `_React to apply or use \`/find-testers action:set-preferences\` to get auto-notified!_`;

      await interaction.reply({
        content: gamesList,
        ephemeral: false
      });

      console.log(`📊 Browsed ${games.length} games from database (genre: ${genre || 'all'})`);
    }

    else if (action === 'my-games') {
      const devGames = await getDevGames(interaction.user.id);

      if (devGames.length === 0) {
        await interaction.reply({
          content: '❌ No games registered yet!\nUse `/find-testers action:register`',
          ephemeral: true
        });
        return;
      }

      let gamesList = '📊 **Your Registered Games**\n\n';
      devGames.forEach(async (game) => {
        const testers = await getGameTesters(game.game_id);
        gamesList += `**${game.game_name}**
Status: ${game.status}
Testers: ${testers.length}/${game.testers_needed}
Created: ${new Date(game.created_at).toLocaleDateString()}

`;
      });

      await interaction.reply({
        content: gamesList,
        ephemeral: true
      });

      console.log(`📊 Dev viewing their ${devGames.length} games from database`);
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

      // Save to database
      const saved = await saveTesterPreferences(
        interaction.user.id,
        interaction.user.username,
        [genre.toLowerCase()],
        platforms
      );

      if (!saved) {
        await interaction.reply({
          content: '❌ Error saving preferences. Try again.',
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        content: `
✅ **Preferences Saved to Database!**

You'll be notified when games matching your preferences are registered:
📌 Genres: ${genre}
📌 Platforms: ${platforms.join(', ')}

Now when developers register games with these tags, you'll see them when you use \`/find-testers action:browse\`!
        `,
        ephemeral: true
      });

      console.log(`👤 Tester ${interaction.user.username} saved preferences in DB: ${genre} + ${platformsStr}`);
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
║ Database: PostgreSQL ✅
╚════════════════════════════════════════╝
  `);
}, 60 * 60 * 1000);

// ============================================
// DATABASE CLEANUP ON SHUTDOWN
// ============================================
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  await pool.end();
  process.exit(0);
});

// ============================================
// LOGIN
// ============================================
async function start() {
  await initializeDatabase();
  client.login(process.env.DISCORD_TOKEN);
  console.log('🤖 Bot starting...');
}

start();
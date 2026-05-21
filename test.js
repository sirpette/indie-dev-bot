const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

async function listModels() {
  try {
    // Zkus listat dostupné modely
    console.log('Trying to list available models...');
    
    // Zkus jednoduchou zprávu s nejnovějším modellem
    const msg = await client.messages.create({
      model: 'claude-opus-4-20250805',
      max_tokens: 50,
      messages: [{role: 'user', content: 'test'}]
    });
    console.log('✅ MODEL WORKS');
  } catch (e) {
    console.log('❌ Error details:');
    console.log('Status:', e.status);
    console.log('Message:', e.message);
    console.log('Error type:', e.error?.error?.type);
  }
}

listModels();

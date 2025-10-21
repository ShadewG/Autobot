require('dotenv').config();

console.log('\n🔍 Checking Autobot MVP Configuration...\n');

const checks = {
    'Database URL': process.env.DATABASE_URL,
    'Redis URL': process.env.REDIS_URL,
    'SendGrid API Key': process.env.SENDGRID_API_KEY,
    'SendGrid From Email': process.env.SENDGRID_FROM_EMAIL,
    'Notion API Key': process.env.NOTION_API_KEY,
    'Notion Database ID': process.env.NOTION_CASES_DATABASE_ID,
    'OpenAI API Key': process.env.OPENAI_API_KEY,
    'Anthropic API Key': process.env.ANTHROPIC_API_KEY,
    'Node Environment': process.env.NODE_ENV || 'development'
};

let allGood = true;

for (const [name, value] of Object.entries(checks)) {
    const status = value ? '✓' : '✗';
    const display = value
        ? (name.includes('Key') || name.includes('URL') || name.includes('ID')
            ? value.substring(0, 20) + '...'
            : value)
        : 'NOT SET';

    console.log(`${status} ${name.padEnd(25)}: ${display}`);

    if (!value && !name.includes('Anthropic')) {
        allGood = false;
    }
}

console.log('\n' + '='.repeat(60));

if (allGood) {
    console.log('✓ All required environment variables are set!');
    console.log('\nOptional checks:');
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('  ⚠ Anthropic API Key not set (Claude fallback disabled)');
    }
} else {
    console.log('✗ Some required environment variables are missing!');
    console.log('\nPlease check your .env file or Railway environment variables.');
}

console.log('\n' + '='.repeat(60));
console.log('\nNext steps:');
console.log('1. Ensure all variables are set in Railway');
console.log('2. Deploy to Railway');
console.log('3. Visit /health endpoint to verify deployment');
console.log('4. Add a test case to Notion');
console.log('5. Watch the magic happen! 🤖\n');

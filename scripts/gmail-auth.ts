import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import { loadPartialEnv } from '../src/config/env.js';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

async function main(): Promise<void> {
  const env = loadPartialEnv();

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    console.error(
      'Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in .env. Please set both before running gmail:auth.',
    );
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
  });

  console.log('\n=== Invoice X-Ray — Gmail OAuth2 Setup ===\n');
  console.log('1. Open this URL in your browser and authorize read + compose (drafts) access:\n');
  console.log(authUrl);
  console.log('\n2. After granting access, your browser will redirect to:');
  console.log(`   ${REDIRECT_URI}?code=<AUTHORIZATION_CODE>&scope=...`);
  console.log('   Copy the value of the "code" query parameter and paste it below.\n');

  const rl = readline.createInterface({ input, output });
  try {
    const code = (await rl.question('Paste authorization code here: ')).trim();
    if (!code) {
      console.error('No authorization code entered. Aborting.');
      process.exit(1);
    }

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      console.error(
        'Google did not return a refresh_token. Revoke previous app access in your Google Account and retry with prompt=consent.',
      );
      process.exit(1);
    }

    console.log('\n=== Success! Add this line to your .env file ===\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('Gmail OAuth2 setup failed:', err);
  process.exit(1);
});

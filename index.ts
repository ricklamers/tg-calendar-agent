import express, { Request, Response } from 'express';
import TelegramBot from 'node-telegram-bot-api';
import Groq from 'groq-sdk';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import moment from 'moment-timezone';
import fs from 'fs';
import path from 'path';

// Load environment variables (use a package like dotenv if necessary)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';

if (!TELEGRAM_BOT_TOKEN || !GROQ_API_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("Missing required environment variables. Please set TELEGRAM_BOT_TOKEN, GROQ_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET");
  process.exit(1);
}

// Initialize Telegram Bot (using polling for simplicity)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Setup Express server for handling OAuth callbacks
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Groq SDK for interacting with the LLM API
const groq = new Groq({ apiKey: GROQ_API_KEY });

// New interfaces for multiple events
interface CalendarEvent {
  title: string;
  start_time: string; // ISO formatted time
  end_time: string;   // ISO formatted time
  description: string;
  accountId: number;  // the account id to use
  calendar?: string;  // Optional calendar id, defaults to 'primary'
}

interface PendingEvents {
  events: CalendarEvent[];
  originalText: string;
  previousJSONProposal?: string;
  editHistory?: string;
}

// Also update pendingEvents declaration
const pendingEvents = new Map<number, PendingEvents>();

// New interfaces for handling multiple OAuth accounts
interface OAuthAccount {
  accountId: number;
  email?: string;  // new field for user's email
  oauth2Client: OAuth2Client;
  calendars: { id: string; summary: string }[];
}

interface PendingOAuth {
  chatId: number;
  oauth2Client: OAuth2Client;
}

// Map of chatId to an array of authenticated accounts
const oauthAccounts = new Map<number, OAuthAccount[]>();
// Temporary storage for pending OAuth authentications
const pendingOAuth = new Map<string, PendingOAuth>();

// Disk-based caching for authenticated clients
const AUTH_CACHE_PATH = path.join(__dirname, 'authCache.json');

function saveAuthCache() {
  let cacheData: any = {};
  for (const [chatId, accounts] of oauthAccounts.entries()) {
    cacheData[chatId] = accounts.map(account => ({
      accountId: account.accountId,
      email: account.email,
      calendars: account.calendars,
      tokens: account.oauth2Client.credentials
    }));
  }
  try {
    fs.writeFileSync(AUTH_CACHE_PATH, JSON.stringify(cacheData, null, 2));
  } catch (error) {
    console.error("Failed to save auth cache:", error);
  }
}

function loadAuthCache() {
  if (fs.existsSync(AUTH_CACHE_PATH)) {
    try {
      let data = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf-8'));
      for (let chatId in data) {
        let accountsList = data[chatId];
        let oauthAccountsList = accountsList.map((accountData: any) => {
          let oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
          oauth2Client.setCredentials(accountData.tokens);
          return {
            accountId: accountData.accountId,
            email: accountData.email,
            oauth2Client: oauth2Client,
            calendars: accountData.calendars
          };
        });
        oauthAccounts.set(parseInt(chatId, 10), oauthAccountsList);
      }
    } catch (error) {
      console.error("Failed to load auth cache:", error);
    }
  }
}

loadAuthCache();

function buildAccountsAndCalendarsMessage(accounts: OAuthAccount[]): string {
  if (accounts.length === 0) return "No accounts connected.\n";
  let message = "";
  accounts.forEach(account => {
    const accountLabel = account.email ? `Account ${account.accountId} (${account.email})` : `Account ${account.accountId}`;
    message += `${accountLabel}:\n`;
    if (!account.calendars || account.calendars.length === 0) {
      message += "- No calendars found.\n";
    } else {
      account.calendars.forEach(cal => {
        message += `- ${cal.summary} (ID: ${cal.id})\n`;
      });
    }
  });
  return message;
}

function formatEventsReply(events: CalendarEvent[], confirmMessage: string = "If these look good, type /confirm to add the events."): string {
  let reply = "Proposed events:";
  events.forEach((evt, index) => {
    reply += `\n\nEvent ${index + 1}:` +
             `\nTitle: ${evt.title}` +
             `\nStart: ${evt.start_time}` +
             `\nEnd: ${evt.end_time}` +
             `\nDescription: ${evt.description}` +
             `\nAccount: ${evt.accountId}` +
             `\nCalendar: ${evt.calendar || 'primary'}`;
  });
  reply += `\n\n` + confirmMessage;
  return reply;
}

// Helper function to fetch calendars for an OAuth2 client
async function fetchCalendars(oauth2Client: OAuth2Client): Promise<{ id: string; summary: string }[]> {
  const calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
  const calendarList = await calendarClient.calendarList.list();
  return calendarList.data.items?.map(item => ({
    id: item.id || '',
    summary: item.summary || 'No Title'
  })) || [];
}

// New extractJSON supporting JSON arrays
function extractJSON(response: string): string {
  const firstBracket = response.indexOf('[');
  const lastBracket = response.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    return response.substring(firstBracket, lastBracket + 1);
  }
  const firstBrace = response.indexOf('{');
  const lastBrace = response.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No valid JSON string found in response');
  }
  return response.substring(firstBrace, lastBrace + 1);
}

// Updated parseEventDescription function signature and prompt
async function parseEventDescription(userText: string, chatId: number): Promise<{ events: CalendarEvent[], jsonProposal: string }> {
  const currentDate = moment().format('YYYY-MM-DD');
  const accounts = oauthAccounts.get(chatId) || [];
  const accountInfo = buildAccountsAndCalendarsMessage(accounts);
  const pending = pendingEvents.get(chatId);
  const previousProposalText = pending && pending.previousJSONProposal ? `Previous JSON proposal: ${pending.previousJSONProposal}\n` : "";
  const prompt = `
You are an assistant that extracts calendar event details from natural language.
Current Date: ${currentDate}
Available accounts and calendars:
${accountInfo}
Extract an array of JSON objects, where each object has the following fields:
{
  "title": string,
  "start_time": string (ISO format),
  "end_time": string (ISO format),
  "description": string,
  "accountId": number,
  "calendar": string    // if not provided, default to "primary"
}
If the time zone is not specified, assume the default timezone ${DEFAULT_TIMEZONE}.

${previousProposalText}Description: ${userText}
`;
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "user", content: prompt }
      ],
      model: "deepseek-r1-distill-llama-70b-specdec",
    });
    const rawResponse = chatCompletion.choices[0]?.message?.content || '';
    const jsonString = extractJSON(rawResponse);
    const events = JSON.parse(jsonString);
    return { events, jsonProposal: jsonString };
  } catch (error) {
    console.error("Error parsing event description:", error);
    throw error;
  }
}

// Function to add event to Google Calendar using the selected account
async function addEventToCalendar(chatId: number, eventData: {
  title: string;
  start_time: string;
  end_time: string;
  description: string;
  accountId?: number;
  calendar?: string;
}) {
  const accounts = oauthAccounts.get(chatId);
  let oauthAccount: OAuthAccount | undefined;
  if (eventData.accountId) {
    oauthAccount = accounts?.find(acc => acc.accountId === eventData.accountId);
  }
  // If not specified, default to the first account if available
  if (!oauthAccount && accounts && accounts.length > 0) {
    oauthAccount = accounts[0];
  }
  if (!oauthAccount) {
    bot.sendMessage(chatId, "No authenticated Google account found. Use /auth to authenticate.");
    return;
  }
  const calendarId = eventData.calendar || "primary";
  const calendarApi = google.calendar({ version: 'v3', auth: oauthAccount.oauth2Client });
  const event = {
    summary: eventData.title,
    description: eventData.description,
    start: {
      dateTime: moment.tz(eventData.start_time, DEFAULT_TIMEZONE).toISOString(),
    },
    end: {
      dateTime: moment.tz(eventData.end_time, DEFAULT_TIMEZONE).toISOString(),
    },
  };
  try {
    await calendarApi.events.insert({
      calendarId,
      requestBody: event,
    });
    bot.sendMessage(chatId, `Event added to calendar (${calendarId}) for Account ${oauthAccount.accountId}: ${eventData.title}`);
  } catch (error) {
    console.error("Error adding event:", error);
    bot.sendMessage(chatId, "There was an error adding the event. Please try again.");
  }
}

// Telegram Bot message handling
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  // Start command
  if (text.startsWith('/start')) {
    bot.sendMessage(chatId, "Welcome! Send me a description of your calendar event and I'll help add it to your Google Calendar.\n\nCommands:\n/auth - Authenticate with Google Calendar\n/confirm - Confirm adding the proposed event(s)\n/edit <new description> - Edit the proposed event(s)");
    return;
  }

  // OAuth authentication command
  if (text.startsWith('/auth')) {
    // Create an OAuth2 client
    const oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
    // Generate a unique state in the format "chatId:uniqueId"
    const uniqueId = Date.now().toString();
    const state = `${chatId}:${uniqueId}`;
    // Updated scopes to include userinfo.email for fetching the user's email
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email'
      ],
      state
    });
    // Temporarily store the OAuth client
    pendingOAuth.set(state, { chatId, oauth2Client });
    bot.sendMessage(chatId, `Please authenticate with Google Calendar by visiting this URL: ${authUrl}`);
    return;
  }

  // Confirm command to add events
  if (text.startsWith('/confirm')) {
    const pending = pendingEvents.get(chatId);
    if (!pending) {
      bot.sendMessage(chatId, "No pending events. Send an event description first.");
      return;
    }
    for (const eventData of pending.events) {
      await addEventToCalendar(chatId, eventData);
    }
    pendingEvents.delete(chatId);
    return;
  }

  // Edit command to update the event description
  if (text.startsWith('/edit')) {
    const latestEdit = text.replace('/edit', '').trim();
    if (!latestEdit) {
      bot.sendMessage(chatId, "Please provide the update changes after the /edit command.");
      return;
    }
    const pending = pendingEvents.get(chatId);
    if (!pending) {
      bot.sendMessage(chatId, "No pending events available to edit. Please provide an event description first.");
      return;
    }
    const originalDescription = pending.originalText;
    const previousEdits = pending.editHistory || "";
    const newEditHistory = previousEdits ? previousEdits + "\n" + latestEdit : latestEdit;
    const combinedDescription = `Original description: ${originalDescription}\nUser requested changes:\nLatest edit: ${latestEdit}\n` +
                                (previousEdits ? `Previously requested changes: ${previousEdits}\n` : "");
    try {
      const { events, jsonProposal } = await parseEventDescription(combinedDescription, chatId);
      let newPreviousJSONProposal = jsonProposal;
      if (pending.previousJSONProposal) {
        newPreviousJSONProposal = pending.previousJSONProposal + "\n" + jsonProposal;
      }
      pendingEvents.set(chatId, { 
        events, 
        originalText: originalDescription, 
        previousJSONProposal: newPreviousJSONProposal,
        editHistory: newEditHistory
      });
      const reply = formatEventsReply(events, "If these look good, type /confirm to add the events.");
      bot.sendMessage(chatId, reply);
    } catch (error) {
      bot.sendMessage(chatId, "Error parsing updated event description. Please try again.");
    }
    return;
  }

  // New command to list authenticated calendars
  if (text.startsWith('/calendars')) {
    const accounts = oauthAccounts.get(chatId);
    if (!accounts || accounts.length === 0) {
      bot.sendMessage(chatId, "No authenticated calendars found. Please use /auth to connect your Google Calendar.");
      return;
    }
    const accountDetails = buildAccountsAndCalendarsMessage(accounts);
    const reply = "Authenticated Calendars and Accounts:\n" + accountDetails;
    bot.sendMessage(chatId, reply);
    return;
  }

  // If the message is a command we don't recognize
  if (text.startsWith('/')) {
    bot.sendMessage(chatId, "Unrecognized command. Please send an event description or use a valid command.");
    return;
  }

  // Otherwise, treat the message as a new event description
  try {
    const { events, jsonProposal } = await parseEventDescription(text, chatId);
    pendingEvents.set(chatId, { events, originalText: text, previousJSONProposal: jsonProposal });
    const reply = formatEventsReply(events, "If these look good, type /confirm to add the events, or /edit to modify.");
    bot.sendMessage(chatId, reply);
  } catch (error) {
    bot.sendMessage(chatId, "Error parsing event description. Please ensure your description is clear and try again.");
  }
});

// Express route to handle OAuth2 callback
app.get('/oauth2callback', async (req: Request, res: Response): Promise<void> => {
  const code = req.query.code as string;
  const state = req.query.state as string; // expected format: "chatId:uniqueId"
  const parts = state.split(':');
  if (parts.length < 2) {
    res.send("Invalid state parameter.");
    return;
  }
  const chatId = parseInt(parts[0], 10);
  const pending = pendingOAuth.get(state);
  if (!pending) {
    res.send("OAuth client not found for this session.");
    return;
  }
  try {
    const { tokens } = await pending.oauth2Client.getToken(code);
    pending.oauth2Client.setCredentials(tokens);
    // Fetch calendars
    const calendars = await fetchCalendars(pending.oauth2Client);
    // Fetch user email using google.oauth2 API
    const oauth2 = google.oauth2({ version: 'v2', auth: pending.oauth2Client });
    const userInfoResponse = await oauth2.userinfo.get();
    const email = userInfoResponse.data.email || 'Unknown Email';

    const existingAccounts = oauthAccounts.get(chatId) || [];
    const newAccount: OAuthAccount = {
      accountId: existingAccounts.length + 1,
      email,  // store the email address
      oauth2Client: pending.oauth2Client,
      calendars: calendars
    };
    existingAccounts.push(newAccount);
    oauthAccounts.set(chatId, existingAccounts);
    saveAuthCache();
    pendingOAuth.delete(state);
    let calendarMsg = `Account ${newAccount.accountId} (${newAccount.email}) connected. Available calendars:\n`;
    calendars.forEach((cal, index) => {
      calendarMsg += `${index + 1}. ${cal.summary} (ID: ${cal.id})\n`;
    });
    res.send("Authentication successful! You can now return to Telegram.");
    bot.sendMessage(chatId, calendarMsg);
  } catch (error) {
    console.error("Error during OAuth callback:", error);
    res.send("Error during authentication.");
    bot.sendMessage(chatId, "There was an error during Google Calendar authentication.");
  }
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});

// Main function for Railway deployment or local run
export async function main() {
  console.log("Telegram Calendar Bot is running...");
}

main();
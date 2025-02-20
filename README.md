# Telegram Calendar Bot powered by Groq

This project is a Telegram bot that helps you manage your Google Calendar events using natural language. The bot leverages OAuth2 for secure authentication with Google, and it extracts event details from simple text messages. With it, you can create, edit, and confirm events directly through Telegram commands.

![Screenshot 2025-02-18 at 7 50 17 PM](https://github.com/user-attachments/assets/c8929c80-a78a-4437-84b5-e6455d6910e2)

## Features

- Authenticate with your Google Calendar via OAuth2.
- Extract event details (title, start/end time, description) from natural language.
- Support for multiple Google accounts and calendars.
- Support for multiple timezones.
- Enable or disable specific calendars for event insertion.
- Integrated Express server to handle OAuth callbacks.

## Getting Started

1. Clone the repository.
2. Install dependencies:
   npm install
3. Set the required environment variables:
   - GROQ_API_KEY
   - TELEGRAM_BOT_TOKEN
   - GOOGLE_CLIENT_ID
   - GOOGLE_CLIENT_SECRET
   - Optionally: GOOGLE_REDIRECT_URI, DEFAULT_TIMEZONE
4. Run the project:
   npm start

### Getting API keys

- Groq API key: https://console.groq.com/keys
- Telegram bot token: https://core.telegram.org/bots/tutorial#obtain-your-bot-token
- Google OAuth2 credentials:

Go to the Google Cloud Console:
https://console.cloud.google.com

Create a new project (or choose an existing project) by clicking the project drop-down at the top.

Enable the Google Calendar API for your project:
• Select “APIs & Services” > “Library”.
• Search for “Google Calendar API” and click “Enable”.

Set up the OAuth consent screen:
• Go to “APIs & Services” > “OAuth consent screen”.
• Choose “External” (if your app is for general use) and fill in the required details (app name, email, etc.).

Create OAuth 2.0 credentials:
• Go to “APIs & Services” > “Credentials”.
• Click on “Create Credentials” and choose “OAuth client ID”.
• Select “Web application” as the application type.
• Under “Authorized redirect URIs”, add the URI you plan to use (commonly, http://localhost:3000/oauth2callback for local testing).

After creation, the console will display your GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.

Once running, use Telegram to interact with the bot:
- Use /auth to connect a Google account.
- Send an event description to propose a new calendar event.
- Use /confirm to add the event(s) to your calendar.
- Use /edit to modify an event before confirming.

Enjoy managing your calendar with ease!

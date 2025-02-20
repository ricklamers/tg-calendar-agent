# Telegram Calendar Bot powered by Groq

This project is a Telegram bot that helps you manage your Google Calendar events using natural language. The bot leverages OAuth2 for secure authentication with Google, and it extracts event details from simple text messages. With it, you can create, edit, and confirm events directly through Telegram commands.

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

Once running, use Telegram to interact with the bot:
- Use /auth to connect a Google account.
- Send an event description to propose a new calendar event.
- Use /confirm to add the event(s) to your calendar.
- Use /edit to modify an event before confirming.

Enjoy managing your calendar with ease!

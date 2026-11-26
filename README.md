# Civilization VI MCP Server

## What this fork adds

This is a fork of [lowrykun/civ6mcp](https://github.com/lowrykun/civ6mcp), the Civilization VI MCP server by lowrykun. It adds an HTTP transport and makes the game data the tools report more reliable.

- A Streamable HTTP entry point next to stdio, with separate MCP sessions and cleanup of idle sessions. See [HTTP Transport](#http-transport-optional).
- Uses save-file actor records to identify the human player and match scores to civilizations, with warnings when save data is missing or does not match the logs.
- Skips actor parsing for saves under 200 kB to avoid a parser hang seen with truncated files. Looks for `UserOptions.txt` in several known locations.
- An updated dependency lockfile, which cleared the 10 `npm audit` advisories reported at the time.

An MCP (Model Context Protocol) server that provides Claude with real-time access to your Civilization VI game data. Get strategic analysis, diplomatic intelligence, military assessments, and more by connecting Claude to your active game.

## Features

- **Strategic Overview** - Comprehensive situational briefing combining all intelligence
- **Diplomatic Intelligence** - Track relationships, alliances, and the reasons behind them
- **Military Analysis** - Monitor troop strength, combat desire, and threat levels
- **Production Tracking** - See what every civilization is building
- **City Status** - Analyze city growth potential and food challenges
- **Victory Progress** - Track who's leading each victory type
- **Score Breakdown** - Understand where each civ's score comes from (Empire, Tech, Wonders, etc.)
- **Trend Analysis** - Identify rising powers and declining civilizations
- **Combat History** - Review recent battles and ongoing conflicts
- **World Congress** - Track voting records and resolutions
- **Great People** - Monitor the great people race
- **Cultural Victory Tracking** - Track Great Artists, Writers, and Musicians

## Requirements

- Node.js 18+
- Civilization VI (macOS or Windows)
- Claude Desktop

> **Important**: You must enable game logging in Civilization VI for the MCP server to access game data. See [Enable Game Logging](#enable-game-logging) below.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/therealmodbom/civ6mcp.git
   cd civ6mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Enable Game Logging

The MCP server reads data from Civilization VI's log files. You need to enable logging:

1. Find your `UserOptions.txt` file:
   - **macOS**: `~/Library/Application Support/Sid Meier's Civilization VI/Firaxis Games/Sid Meier's Civilization VI/UserOptions.txt`
   - **Windows**: `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI\UserOptions.txt`

   Civ VI has moved this file between updates, so older installs may keep it elsewhere —
   `~/Library/Application Support/Sid Meier's Civilization VI/` on macOS, or
   `%USERPROFILE%\Documents\My Games\Sid Meier's Civilization VI\` on Windows. The server
   probes these locations and names the one it finds in its error messages.

2. Add or modify this line:
   ```
   GameHistoryLogLevel=1
   ```

3. Start Civilization VI and play at least one turn to generate log data.

## Claude Desktop Configuration

Add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "civ6": {
      "command": "node",
      "args": ["/path/to/civ6mcp/dist/index.js"]
    }
  }
}
```

Replace `/path/to/civ6mcp` with the actual path to where you cloned the repository.

## HTTP Transport (Optional)

Claude Desktop spawns the server itself over stdio, so it has to run on the same machine as the game. For a client that cannot do that, `npm run start:http` serves the same tools over Streamable HTTP at `/mcp`.

```bash
npm run build
npm run start:http
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8000` | Port to listen on |
| `MCP_ALLOWED_HOSTS` | — | Extra `Host` header values to accept, comma-separated (for example `civ6.tail1234.ts.net`) |
| `MCP_ALLOWED_ORIGINS` | — | `Origin` values to accept, comma-separated. Unset means the `Origin` header is not checked |
| `MCP_SESSION_IDLE_MS` | `1800000` | Close a session after this long without activity. Minimum `1000`. Also the idle delay before a silent connection is probed |

The server binds `127.0.0.1` only and has no authentication of its own. Put a proxy in front of it — `tailscale serve` for instance — and name that proxy's hostname in `MCP_ALLOWED_HOSTS`. Do not expose the port itself.

`MCP_ALLOWED_ORIGINS` is not a way to let a web page talk to the server. No CORS headers are sent and a preflight `OPTIONS /mcp` is rejected, so a browser blocks the call whatever the variable says. It only narrows which non-browser clients may send an `Origin` header, which is why leaving it unset is the sensible default. Serving a browser client would mean CORS on a loopback endpoint that has no authentication of its own, and that is the proxy's job, not this server's.

A client that disappears without closing its connection — a laptop that sleeps, a network that drops — keeps its session alive until the connection is probed and found dead. Closing that dead connection then starts a fresh idle window before the sweep reclaims the session, so the worst case is about two times `MCP_SESSION_IDLE_MS` plus the operating system's keepalive budget (ten minutes on macOS defaults) plus one sweep interval — roughly seventy-one minutes at the defaults. Sessions are held in memory only; restarting the server clears them.

## Claude Project Setup (Recommended)

For the best experience, create a Claude Project with the strategic advisor instructions:

1. In Claude, create a new Project called "Civilization VI"
2. Copy the contents of [PROJECT_INSTRUCTIONS.md](PROJECT_INSTRUCTIONS.md) into the Project Instructions
3. Start a conversation in that project

This gives Claude context about all the available tools and how to provide strategic advice.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_strategic_overview` | Comprehensive briefing: threats, opportunities, victory race |
| `get_yield_comparison` | Compare all civs' science, culture, gold, faith, military |
| `get_victory_progress` | Who's leading each victory type |
| `get_civ_statistics` | Detailed per-civ stats (specify turn number optional) |
| `get_score_breakdown` | Score breakdown by category (Empire, Tech, Wonders, etc.) |
| `get_trend_analysis` | Track changes over time, identify rising/declining powers |
| `get_diplomatic_status` | Relationships: allied, friendly, denounced, war |
| `get_diplomatic_modifiers` | Specific reasons for +/- relations |
| `get_military_intelligence` | Strength, combat desire, threat levels |
| `get_combat_log` | Recent battles, units, damage |
| `get_city_production` | What every city is building |
| `get_city_status` | City growth potential based on food advantage at founding |
| `get_tech_status` | Technology progress by civilization |
| `get_world_congress` | Voting records and resolution outcomes |
| `get_great_people` | Great People claimed and available |
| `get_great_people_culture` | Track Artists, Writers, Musicians for cultural victory |
| `list_saves` | Find save files |
| `read_game_state` | Parse save file for basic game info |
| `get_strategy_brief` | Formatted briefing from save file |

See [TOOLS.md](TOOLS.md) for detailed documentation.

## Usage Examples

Ask Claude things like:
- "What's my current strategic situation?"
- "Who is the biggest threat right now?"
- "What are my neighbors building?"
- "How are my yields compared to other civs?"
- "Show me the trend analysis for the last 10 turns"
- "What's the diplomatic situation with Persia?"

## How It Works

The MCP server reads from two sources:

1. **Save Files** (`.Civ6Save`) - Basic game info like leader, turn, map settings
2. **Log Files** (CSV) - Detailed statistics generated each turn when logging is enabled

Log files provide much richer data including:
- All civilizations' yields and military strength
- Diplomatic relationships and their modifiers
- Combat records
- City production queues
- Technology progress
- World Congress votes

## Platform Support

- **macOS** - Fully supported
- **Windows** - Fully supported

## Troubleshooting

**"No game data available"**
- Make sure `GameHistoryLogLevel=1` is set in UserOptions.txt
- Play at least one turn after enabling logging
- Check that log files exist in your Logs directory

**Data seems outdated**
- Log files update when you complete a turn
- Mid-turn, you'll only see your own civilization's latest data

## License

MIT License - see [LICENSE](LICENSE) for details.

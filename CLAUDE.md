# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LAN-based Texas Hold'em poker game (局域网德州扑克). Players on the same network connect via browser, create/join rooms, and play multi-player poker with full betting, blinds, side pots, and reconnection support.

## Commands

- **Run server:** `npm start` (starts on port 3000, or `PORT` env var)
- **Docker:** `docker-compose up` (maps host port 3031 → container 3000)

No test framework, linter, or build step is configured. Playwright is a dev dependency but no test files exist yet.

## Architecture

**Server (Node.js, Express + Socket.IO):**

- `server.js` — Entry point. Express static server + Socket.IO setup. Binds to `0.0.0.0` and prints LAN IP on startup.
- `server/socketHandlers.js` — All Socket.IO event handling. Manages the `socketToPlayer` mapping (socketId → room/player info), action timers (25s timeout with auto-fold), disconnect grace periods (10s auto-fold, 60s removal), and wires up game callbacks. This is the central coordination layer between rooms and clients.
- `server/RoomManager.js` — In-memory room registry (Map). Generates 6-char alphanumeric room codes (excludes I/O/0/1).
- `server/game/Room.js` — Room state: players, host, settings (blinds, chips, max players). Handles player add/remove/reconnect and delegates to `PokerGame`.
- `server/game/PokerGame.js` — Core game engine. Manages full hand lifecycle: dealer rotation, blind posting, dealing, betting rounds (pre-flop through river), stage advancement, side pot calculation, showdown, and all-in runout. Uses callback hooks (`onPlayerAction`, `onStageChange`, `onShowdown`, `onHandComplete`, `onRunoutContinue`) set by `socketHandlers.js`.
- `server/game/HandEvaluator.js` — Evaluates best 5-card hand from 7 cards via brute-force C(7,5) combinations. Returns ranked score arrays for comparison.
- `server/game/Card.js` / `Deck.js` — Card representation (rank/suit/value) and Fisher-Yates shuffled deck.

**Client (vanilla JS, no framework):**

- `public/index.html` + `public/css/lobby.css` + `public/js/lobby.js` — Lobby: create/join rooms.
- `public/game.html` + `public/css/game.css` + `public/js/game.js` — Game UI: table rendering, player actions, showdown display.
- `public/js/tableRenderer.js` — Canvas-based poker table and card rendering.
- `public/js/socket.js` — Socket.IO client wrapper with auto-reconnect and room rejoin logic.

## Key Design Patterns

- **Per-player state visibility:** `getGameState(forPlayerId)` filters hole cards — each player only sees their own hand (except at showdown). The server sends individualized state to each socket.
- **Callback-driven game flow:** `PokerGame` exposes callback hooks rather than emitting events directly. `socketHandlers.js` sets these callbacks to bridge game logic to Socket.IO emissions.
- **Raise amounts are "raise to" (total bet)**, not "raise by" (increment). The `amount` parameter in `game:action` for raises represents the target total bet.
- **All UI strings are in Chinese (Simplified).** Error messages, hand names, and game labels use Chinese text.
- **No persistent storage.** All state is in-memory; rooms are cleaned up when empty.

## Socket Events

Room events: `room:create`, `room:join`, `room:leave`, `room:start`, `room:update`, `room:playerLeft`, `room:playerDisconnected`

Game events: `game:action`, `game:nextHand`, `game:state`, `game:started`, `game:stageChange`, `game:showdown`, `game:timer`, `game:timeout`, `game:autoStartTimer`, `game:over`

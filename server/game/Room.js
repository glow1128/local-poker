const { PokerGame, STAGES } = require('./PokerGame');
const { AI_ID_PREFIX } = require('../ai/AIPlayerManager');

class Room {
  constructor(id, options = {}) {
    this.id = id;
    this.hostId = null;
    this.players = new Map();  // id -> { id, name, socketId, seat }
    this.maxPlayers = options.maxPlayers || 9;
    this.initialChips = options.initialChips || 1000;
    this.smallBlind = options.smallBlind || 10;
    this.bigBlind = options.bigBlind || 20;
    this.game = null;
    this.started = false;

    // Pause state
    this.paused = false;
    this.pausedBy = null;

    // Disconnection tracking
    this.disconnectedPlayers = new Map(); // id -> { name, timeout }
  }

  addPlayer(id, name, socketId) {
    if (this.players.size >= this.maxPlayers) {
      return { success: false, error: '房间已满' };
    }

    if (this.started) {
      return { success: false, error: '游戏已开始' };
    }

    // Check name uniqueness
    for (const [, p] of this.players) {
      if (p.name === name) {
        return { success: false, error: '昵称已被使用' };
      }
    }

    const seat = this._getNextSeat();
    const isAI = typeof id === 'string' && id.startsWith(AI_ID_PREFIX);
    this.players.set(id, { id, name, socketId, seat, isAI });

    if (this.players.size === 1) {
      this.hostId = id;
    }

    return { success: true, seat };
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;

    this.players.delete(id);

    // If host left, transfer
    if (this.hostId === id && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }

    // Remove from game if in progress
    if (this.game) {
      this.game.playerDisconnected(id);
      this.game.removePlayer(id);
    }
  }

  reconnectPlayer(oldId, newId, socketId) {
    const disconnectInfo = this.disconnectedPlayers.get(oldId);
    if (!disconnectInfo) return false;

    clearTimeout(disconnectInfo.removeTimeout);
    this.disconnectedPlayers.delete(oldId);

    const player = this.players.get(oldId);
    if (!player) return false;

    // Update player references
    player.id = newId;
    player.socketId = socketId;
    this.players.delete(oldId);
    this.players.set(newId, player);

    if (this.hostId === oldId) this.hostId = newId;

    if (this.game) {
      this.game.playerReconnected(oldId, newId);
    }

    return true;
  }

  startGame() {
    if (this.players.size < 2) {
      return { success: false, error: '至少需要2名玩家' };
    }

    this.started = true;
    this.game = new PokerGame({
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind
    });

    for (const [, p] of this.players) {
      this.game.addPlayer({
        id: p.id,
        name: p.name,
        chips: this.initialChips,
        seat: p.seat
      });
    }

    return { success: true };
  }

  getState(forPlayerId = null) {
    const state = {
      id: this.id,
      hostId: this.hostId,
      started: this.started,
      maxPlayers: this.maxPlayers,
      initialChips: this.initialChips,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      paused: this.paused,
      pausedBy: this.pausedBy,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        isAI: p.isAI
      }))
    };

    if (this.game) {
      state.game = this.game.getGameState(forPlayerId);
    }

    return state;
  }

  _getNextSeat() {
    const taken = new Set(Array.from(this.players.values()).map(p => p.seat));
    for (let i = 0; i < this.maxPlayers; i++) {
      if (!taken.has(i)) return i;
    }
    return this.players.size;
  }

  get playerCount() {
    return this.players.size;
  }

  isEmpty() {
    // A room with only AI players is considered empty
    const humanPlayers = Array.from(this.players.values()).filter(p => !p.isAI);
    return humanPlayers.length === 0 && this.disconnectedPlayers.size === 0;
  }

  /**
   * Ensure host is never an AI player. Transfer to first human if needed.
   */
  ensureHumanHost() {
    if (!this.hostId) return;
    const host = this.players.get(this.hostId);
    if (host && !host.isAI) return;
    for (const [id, p] of this.players) {
      if (!p.isAI) { this.hostId = id; return; }
    }
  }
}

module.exports = { Room };

/**
 * AI Player Manager
 *
 * Manages AI player lifecycle within rooms:
 *   - Adding/removing AI players to rooms
 *   - Detecting when it's an AI player's turn
 *   - Triggering AI decisions with a realistic delay
 *   - Bridging AI actions into the game engine
 */

const { AIDecisionEngine, AI_NAMES, getRandomPersonality } = require('./AIDecisionEngine');

// AI player IDs use this prefix for easy identification
const AI_ID_PREFIX = 'ai_';
const AI_THINK_DELAY_MIN = 0;  // ms — minimum "thinking" time
const AI_THINK_DELAY_MAX = 0;  // ms — maximum "thinking" time

class AIPlayerManager {
  constructor() {
    this.engine = new AIDecisionEngine();
    // Track AI players per room: roomId -> Set<playerId>
    this.aiPlayers = new Map();
    // Track AI personalities per room: roomId -> Map<playerId, personality>
    this.aiPersonalities = new Map();
    // Track pending AI action timers: roomId -> timeoutId
    this.pendingActions = new Map();
    // Counter for unique AI IDs
    this._nextId = 1;
  }

  /**
   * Add an AI player to a room.
   * @param {Room} room
   * @returns {{ success: boolean, error?: string, aiPlayer?: object }}
   */
  addAIPlayer(room) {
    const currentAIs = this.getAIPlayers(room.id);
    if (currentAIs.size >= 2) {
      return { success: false, error: '最多添加2个AI玩家' };
    }

    if (room.players.size >= room.maxPlayers) {
      return { success: false, error: '房间已满' };
    }

    const aiId = `${AI_ID_PREFIX}${this._nextId++}`;
    const nameIdx = currentAIs.size;
    const aiName = AI_NAMES[nameIdx] || `AI_${nameIdx + 1}`;

    // Assign random personality
    const personality = getRandomPersonality();

    // Add to room (AI uses its own ID as socketId — it won't actually use sockets)
    const result = room.addPlayer(aiId, aiName, aiId);
    if (!result.success) {
      return result;
    }

    // Track this AI
    this.aiPlayers.set(room.id, (this.aiPlayers.get(room.id) || new Set()).add(aiId));

    // Track personality
    if (!this.aiPersonalities.has(room.id)) {
      this.aiPersonalities.set(room.id, new Map());
    }
    this.aiPersonalities.get(room.id).set(aiId, personality);

    // Log personality
    console.log(`[AI][LLM] AI玩家 ${aiName} (${aiId}) 添加，性格：${personality.name}`);

    return { success: true, aiPlayer: { id: aiId, name: aiName, seat: result.seat } };
  }

  /**
   * Remove an AI player from a room.
   */
  removeAIPlayer(room, aiPlayerId) {
    if (!this.isAIPlayer(aiPlayerId)) {
      return { success: false, error: '不是AI玩家' };
    }

    room.removePlayer(aiPlayerId);

    const roomAIs = this.aiPlayers.get(room.id);
    if (roomAIs) {
      roomAIs.delete(aiPlayerId);
      if (roomAIs.size === 0) this.aiPlayers.delete(room.id);
    }

    // Clean up personality data
    const roomPersonalities = this.aiPersonalities.get(room.id);
    if (roomPersonalities) {
      roomPersonalities.delete(aiPlayerId);
      if (roomPersonalities.size === 0) this.aiPersonalities.delete(room.id);
    }

    return { success: true };
  }

  /**
   * Check if a player ID belongs to an AI.
   */
  isAIPlayer(playerId) {
    return typeof playerId === 'string' && playerId.startsWith(AI_ID_PREFIX);
  }

  /**
   * Get the set of AI player IDs in a room.
   */
  getAIPlayers(roomId) {
    return this.aiPlayers.get(roomId) || new Set();
  }

  /**
   * Check if the current player is an AI and schedule its action.
   * Call this after every state change / action in the game.
   *
   * @param {Room} room
   * @param {Function} onActionReady - callback(playerId, action, amount) when AI decides
   */
  checkAndScheduleAIAction(room, onActionReady) {
    if (!room.game) return;

    const game = room.game;
    if (game.stage === 'WAITING' || game.stage === 'SHOWDOWN') return;

    const currentIdx = game.currentPlayerIndex;
    if (currentIdx < 0 || currentIdx >= game.players.length) return;

    const currentPlayer = game.players[currentIdx];
    if (!currentPlayer || !this.isAIPlayer(currentPlayer.id)) return;
    if (currentPlayer.folded || currentPlayer.allIn || currentPlayer.sittingOut) return;

    // Clear any existing pending action for this room
    this.clearPendingAction(room.id);

    // Schedule AI action with a realistic delay
    const delay = AI_THINK_DELAY_MIN + Math.random() * (AI_THINK_DELAY_MAX - AI_THINK_DELAY_MIN);
    const playerId = currentPlayer.id;

    // Get AI personality
    const personality = this.aiPersonalities.get(room.id)?.get(playerId);

    const timer = setTimeout(async () => {
      this.pendingActions.delete(room.id);

      // Double-check it's still this AI's turn
      if (!room.game || room.game.stage === 'WAITING' || room.game.stage === 'SHOWDOWN') return;
      const stillCurrent = room.game.players[room.game.currentPlayerIndex];
      if (!stillCurrent || stillCurrent.id !== playerId) return;

      // Make decision (async — may call LLM)
      const decision = await this.engine.decide(room.game, playerId, personality);
      console.log(`[AI] ${currentPlayer.name} decides: ${decision.action}${decision.amount != null ? ` ${decision.amount}` : ''} (${JSON.stringify(decision.meta)})`);

      onActionReady(playerId, decision.action, decision.amount);
    }, delay);

    this.pendingActions.set(room.id, timer);
  }

  /**
   * Clear any pending AI action for a room.
   */
  clearPendingAction(roomId) {
    const timer = this.pendingActions.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.pendingActions.delete(roomId);
    }
  }

  /**
   * Clean up all AI state for a room (when room is destroyed).
   */
  cleanupRoom(roomId) {
    this.clearPendingAction(roomId);
    this.aiPlayers.delete(roomId);
    this.aiPersonalities.delete(roomId);
  }
}

// Singleton instance
const aiPlayerManager = new AIPlayerManager();

module.exports = { aiPlayerManager, AIPlayerManager, AI_ID_PREFIX };

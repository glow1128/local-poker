const { RoomManager } = require('./RoomManager');
const { aiPlayerManager } = require('./ai/AIPlayerManager');

const roomManager = new RoomManager();

// Track socket -> player mapping
const socketToPlayer = new Map(); // socketId -> { roomId, playerId, playerName }

// Action timers
const actionTimers = new Map(); // roomId -> timer

const ACTION_TIMEOUT = 25000;        // 25 seconds to act
const DISCONNECT_TIMEOUT = 10000;     // 10 seconds before auto-fold
const REMOVE_TIMEOUT = 60000;         // 60 seconds before removal
const PAGE_NAV_GRACE = 5000;          // 5 seconds grace for page navigation

// Game state broadcast delays
const AUTO_START_DELAY = 8000;        // Auto-start next hand delay
const SHOWDOWN_STATE_DELAY = 200;     // Showdown state update delay
const PLAYER_ACTION_STATE_DELAY = 100; // Player action state update delay

/**
 * Broadcast game state to all human players in a room.
 * @param {Room} room - The room containing players
 * @param {SocketIO.Server} io - Socket.IO instance
 * @param {string} eventName - Event name to emit ('game:state', 'game:started', etc.)
 */
function broadcastGameStateToHumans(room, io, eventName = 'game:state') {
  for (const [, player] of room.players) {
    if (!player.isAI) {
      io.to(player.socketId).emit(eventName, room.getState(player.id));
    }
  }
}

function setupSocketHandlers(io) {

  io.on('connection', (socket) => {
    console.log(`连接: ${socket.id}`);

    // --- Room Events ---

    socket.on('room:create', (data, callback) => {
      const { playerName, initialChips, smallBlind, bigBlind } = data;

      if (!playerName || !playerName.trim()) {
        return callback({ success: false, error: '请输入昵称' });
      }

      const room = roomManager.createRoom({
        initialChips: initialChips || 1000,
        smallBlind: smallBlind || 10,
        bigBlind: bigBlind || 20
      });

      const result = room.addPlayer(socket.id, playerName.trim(), socket.id);
      if (!result.success) {
        roomManager.removeRoom(room.id);
        return callback(result);
      }

      socket.join(room.id);
      socketToPlayer.set(socket.id, {
        roomId: room.id,
        playerId: socket.id,
        playerName: playerName.trim()
      });

      callback({ success: true, roomId: room.id, playerId: socket.id });
      io.to(room.id).emit('room:update', room.getState());
    });

    socket.on('room:join', (data, callback) => {
      const { playerName, roomId } = data;

      if (!playerName || !playerName.trim()) {
        return callback({ success: false, error: '请输入昵称' });
      }

      if (!roomId) {
        return callback({ success: false, error: '请输入房间号' });
      }

      const room = roomManager.getRoom(roomId.toUpperCase());
      if (!room) {
        return callback({ success: false, error: '房间不存在' });
      }

      // Check for reconnection
      const name = playerName.trim();
      let reconnected = false;

      for (const [oldId, info] of room.disconnectedPlayers) {
        if (info.name === name) {
          reconnected = room.reconnectPlayer(oldId, socket.id, socket.id);
          if (reconnected) break;
        }
      }

      if (!reconnected) {
        const result = room.addPlayer(socket.id, name, socket.id);
        if (!result.success) {
          return callback(result);
        }
      }

      socket.join(room.id);
      socketToPlayer.set(socket.id, {
        roomId: room.id,
        playerId: socket.id,
        playerName: name
      });

      callback({
        success: true,
        roomId: room.id,
        playerId: socket.id,
        reconnected
      });

      // Send full state to reconnected player
      if (reconnected && room.game) {
        socket.emit('game:state', room.getState(socket.id));
      }

      io.to(room.id).emit('room:update', room.getState());
    });

    socket.on('room:leave', () => {
      handleLeave(socket, io);
    });

    socket.on('room:start', (data, callback) => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return callback({ success: false, error: '未加入房间' });

      const room = roomManager.getRoom(info.roomId);
      if (!room) return callback({ success: false, error: '房间不存在' });

      if (room.hostId !== socket.id) {
        return callback({ success: false, error: '只有房主可以开始游戏' });
      }

      const result = room.startGame();
      if (!result.success) return callback(result);

      // Setup game callbacks
      setupGameCallbacks(room, io);

      // Start first hand
      room.game.startHand();

      // Send each player their own state (with private hand)
      broadcastGameStateToHumans(room, io, 'game:started');

      startActionTimer(room, io);
      // Check if first player to act is AI
      scheduleAIAction(room, io);
      callback({ success: true });
    });

    // --- AI Player Events ---

    socket.on('room:addAI', (data, callback) => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return callback({ success: false, error: '未加入房间' });

      const room = roomManager.getRoom(info.roomId);
      if (!room) return callback({ success: false, error: '房间不存在' });

      if (room.hostId !== socket.id) {
        return callback({ success: false, error: '只有房主可以添加AI' });
      }

      if (room.started) {
        return callback({ success: false, error: '游戏已开始，无法添加AI' });
      }

      const result = aiPlayerManager.addAIPlayer(room);
      if (!result.success) return callback(result);

      io.to(room.id).emit('room:update', room.getState());
      callback({ success: true, aiPlayer: result.aiPlayer });
    });

    socket.on('room:removeAI', (data, callback) => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return callback({ success: false, error: '未加入房间' });

      const room = roomManager.getRoom(info.roomId);
      if (!room) return callback({ success: false, error: '房间不存在' });

      if (room.hostId !== socket.id) {
        return callback({ success: false, error: '只有房主可以移除AI' });
      }

      const { aiPlayerId } = data;
      const result = aiPlayerManager.removeAIPlayer(room, aiPlayerId);
      if (!result.success) return callback(result);

      io.to(room.id).emit('room:update', room.getState());
      callback({ success: true });
    });

    // --- Game Events ---

    socket.on('game:action', (data, callback) => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return callback({ success: false, error: '未加入房间' });

      const room = roomManager.getRoom(info.roomId);
      if (!room || !room.game) return callback({ success: false, error: '游戏未开始' });

      const { action, amount } = data;
      const result = room.game.handleAction(socket.id, action, amount);

      callback(result);
    });

    socket.on('game:nextHand', (data, callback) => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return callback({ success: false, error: '未加入房间' });

      const room = roomManager.getRoom(info.roomId);
      if (!room || !room.game) return callback({ success: false, error: '游戏未开始' });

      if (room.hostId !== socket.id) {
        return callback({ success: false, error: '只有房主可以开始下一局' });
      }

      // Clear auto-start timer if exists
      if (room.nextHandTimer) {
        clearTimeout(room.nextHandTimer);
        room.nextHandTimer = null;
      }

      // Check if enough players with chips
      const withChips = room.game.players.filter(p => p.chips > 0 && !p.disconnected);
      if (withChips.length < 2) {
        return callback({ success: false, error: '筹码不足的玩家太多，无法继续' });
      }

      room.game.startHand();

      // Send each player their own state
      broadcastGameStateToHumans(room, io, 'game:started');

      startActionTimer(room, io);
      scheduleAIAction(room, io);
      callback({ success: true });
    });

    socket.on('game:pause', (data, callback) => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return callback({ success: false, error: '未加入房间' });

      const room = roomManager.getRoom(info.roomId);
      if (!room || !room.game) return callback({ success: false, error: '游戏未开始' });

      const { action } = data; // 'pause' or 'resume'

      if (action === 'pause') {
        // Check if it's this player's turn
        if (room.game.currentPlayerIndex < 0) {
          return callback({ success: false, error: '无效的游戏状态' });
        }
        const currentPlayer = room.game.players[room.game.currentPlayerIndex];
        if (currentPlayer.id !== socket.id) {
          return callback({ success: false, error: '只有当前行动的玩家可以暂停' });
        }
        if (room.paused) {
          return callback({ success: false, error: '游戏已暂停' });
        }

        room.paused = true;
        room.pausedBy = socket.id;

        // Stop the timer
        clearActionTimer(room.id);

        io.to(room.id).emit('game:paused', {
          paused: true,
          pausedBy: room.players.get(socket.id)?.name || '未知玩家'
        });
        callback({ success: true });

      } else if (action === 'resume') {
        if (!room.paused) {
          return callback({ success: false, error: '游戏未暂停' });
        }
        if (room.pausedBy !== socket.id) {
          return callback({ success: false, error: '只有暂停游戏的玩家可以恢复' });
        }

        room.paused = false;
        room.pausedBy = null;

        io.to(room.id).emit('game:paused', {
          paused: false,
          pausedBy: null
        });

        // Restart timer
        startActionTimer(room, io);
        callback({ success: true });
      } else {
        return callback({ success: false, error: '无效的操作' });
      }
    });

    // --- Disconnection ---

    socket.on('disconnect', () => {
      console.log(`断开: ${socket.id}`);
      handleDisconnect(socket, io);
    });
  });
}

/**
 * Schedule AI action if the current player is an AI.
 * Called after every game state transition that might change whose turn it is.
 */
function scheduleAIAction(room, io) {
  aiPlayerManager.checkAndScheduleAIAction(room, (playerId, action, amount) => {
    if (!room.game) return;

    // Execute the AI's action through the normal game engine
    const result = room.game.handleAction(playerId, action, amount);
    if (!result.success) {
      // Fallback: if action failed, try fold
      console.log(`[AI] Action failed: ${result.error}, forcing fold`);
      room.game.handleAction(playerId, 'fold');
    }
  });
}

function setupGameCallbacks(room, io) {
  room.game.onPlayerAction = (player, action, amount) => {
    clearActionTimer(room.id);

    io.to(room.id).emit('game:action', {
      playerId: player.id,
      playerName: player.name,
      action,
      amount
    });

    // Send updated state to each player
    setTimeout(() => {
      broadcastGameStateToHumans(room, io);
      // Restart timer if game is still in a betting stage
      if (room.game && room.game.stage !== 'WAITING' && room.game.stage !== 'SHOWDOWN') {
        startActionTimer(room, io);
        // Check if next player is AI
        scheduleAIAction(room, io);
      }
    }, PLAYER_ACTION_STATE_DELAY);
  };

  room.game.onStageChange = (stage, communityCards) => {
    io.to(room.id).emit('game:stageChange', {
      stage,
      communityCards: communityCards.map(c => c.toJSON())
    });
  };

  room.game.onShowdown = (showdownData) => {
    clearActionTimer(room.id);

    // Serialize cards
    const data = {
      ...showdownData,
      communityCards: showdownData.communityCards.map(c => c.toJSON()),
      playerHands: showdownData.playerHands.map(ph => ({
        ...ph,
        hand: ph.hand.map(c => c.toJSON()),
        bestCards: ph.bestCards ? ph.bestCards.map(c => c.toJSON()) : null
      })),
      results: showdownData.results.map(r => ({
        ...r,
        bestCards: r.bestCards ? r.bestCards.map(c => c.toJSON()) : null
      }))
    };

    io.to(room.id).emit('game:showdown', data);

    // Send final state
    setTimeout(() => {
      broadcastGameStateToHumans(room, io);
    }, SHOWDOWN_STATE_DELAY);
  };

  room.game.onRunoutContinue = () => {
    setTimeout(() => {
      if (!room.game || room.game.stage === 'SHOWDOWN') return;
      room.game.continueRunout();
      // Send updated state to each player
      broadcastGameStateToHumans(room, io);
    }, 1500);
  };

  room.game.onHandComplete = () => {
    // Check game-over condition
    const withChips = room.game.players.filter(p => p.chips > 0 && !p.disconnected);
    if (withChips.length <= 1) {
      io.to(room.id).emit('game:over', {
        winner: withChips[0] ? { id: withChips[0].id, name: withChips[0].name, chips: withChips[0].chips } : null
      });
    } else {
      // Auto start next hand
      const delay = AUTO_START_DELAY;

      // Notify players
      io.to(room.id).emit('game:autoStartTimer', { seconds: delay / 1000 });

      if (room.nextHandTimer) clearTimeout(room.nextHandTimer);

      room.nextHandTimer = setTimeout(() => {
        room.nextHandTimer = null;

        // Ensure game still exists and room has players
        if (!room.game || room.players.size < 2) return;

        // Reuse logic from game:nextHand
        room.game.startHand();

        broadcastGameStateToHumans(room, io, 'game:started');

        startActionTimer(room, io);
        scheduleAIAction(room, io);
      }, delay);
    }
  };
}

function startActionTimer(room, io) {
  clearActionTimer(room.id);

  if (!room.game || room.game.stage === 'WAITING' || room.game.stage === 'SHOWDOWN') return;

  // Don't start timer if game is paused
  if (room.paused) return;

  const currentIdx = room.game.currentPlayerIndex;
  if (currentIdx < 0 || currentIdx >= room.game.players.length) return;

  const currentPlayer = room.game.players[currentIdx];
  if (!currentPlayer || currentPlayer.folded || currentPlayer.allIn) return;

  // AI players handle their own timing via AIPlayerManager
  if (aiPlayerManager.isAIPlayer(currentPlayer.id)) return;

  // Notify all players about the timer
  io.to(room.id).emit('game:timer', {
    playerId: currentPlayer.id,
    timeout: ACTION_TIMEOUT
  });

  const timer = setTimeout(() => {
    if (!room.game || room.game.stage === 'WAITING' || room.game.stage === 'SHOWDOWN') return;

    const stillCurrent = room.game.players[room.game.currentPlayerIndex];
    if (!stillCurrent || stillCurrent.id !== currentPlayer.id) return;

    // Auto action: check if possible, otherwise fold
    const maxBet = Math.max(0, ...room.game.players.map(p => p.bet));
    if (stillCurrent.bet >= maxBet) {
      room.game.handleAction(currentPlayer.id, 'check');
    } else {
      room.game.handleAction(currentPlayer.id, 'fold');
    }

    io.to(room.id).emit('game:timeout', { playerId: currentPlayer.id });
  }, ACTION_TIMEOUT);

  actionTimers.set(room.id, timer);
}

function clearActionTimer(roomId) {
  const timer = actionTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    actionTimers.delete(roomId);
  }
}

function handleDisconnect(socket, io) {
  const info = socketToPlayer.get(socket.id);
  if (!info) return;

  const room = roomManager.getRoom(info.roomId);
  if (!room) {
    socketToPlayer.delete(socket.id);
    return;
  }

  const player = room.players.get(socket.id);
  if (!player) {
    socketToPlayer.delete(socket.id);
    return;
  }

  const removeTimeout = room.started ? REMOVE_TIMEOUT : PAGE_NAV_GRACE;

  // Track as disconnected with grace period (allows page navigation / reconnect)
  room.disconnectedPlayers.set(socket.id, {
    name: player.name,
    removeTimeout: setTimeout(() => {
      room.disconnectedPlayers.delete(socket.id);
      room.removePlayer(socket.id);
      socketToPlayer.delete(socket.id);
      io.to(room.id).emit('room:playerLeft', { playerName: player.name });
      io.to(room.id).emit('room:update', room.getState());
      if (room.isEmpty()) {
        if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
        roomManager.removeRoom(room.id);
      }
    }, removeTimeout)
  });

  // Game in progress: auto-fold after short timeout if it's their turn
  if (room.started && room.game) {
    const gamePlayer = room.game.players.find(p => p.id === socket.id);
    if (gamePlayer) gamePlayer.disconnected = true;

    setTimeout(() => {
      if (room.game && room.game.stage !== 'WAITING' && room.game.stage !== 'SHOWDOWN') {
        const currentIdx = room.game.currentPlayerIndex;
        if (currentIdx >= 0 && room.game.players[currentIdx]?.id === socket.id) {
          room.game.handleAction(socket.id, 'fold');
        }
      }
    }, DISCONNECT_TIMEOUT);
  }

  if (room.started) {
    io.to(room.id).emit('room:playerDisconnected', { playerName: player.name });
  }
}

function handleLeave(socket, io) {
  const info = socketToPlayer.get(socket.id);
  if (!info) return;

  const room = roomManager.getRoom(info.roomId);
  if (!room) {
    socketToPlayer.delete(socket.id);
    return;
  }

  // Clear any disconnect timers
  const disconnectInfo = room.disconnectedPlayers.get(socket.id);
  if (disconnectInfo) {
    clearTimeout(disconnectInfo.removeTimeout);
    room.disconnectedPlayers.delete(socket.id);
  }

  room.removePlayer(socket.id);
  socket.leave(room.id);
  socketToPlayer.delete(socket.id);

  io.to(room.id).emit('room:update', room.getState());

  if (room.isEmpty()) {
    clearActionTimer(room.id);
    aiPlayerManager.cleanupRoom(room.id);
    if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
    roomManager.removeRoom(room.id);
  }
}

module.exports = { setupSocketHandlers };

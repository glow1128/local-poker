(function () {
  // Restore session
  if (!socketClient.restoreSession()) {
    window.location.href = '/';
    return;
  }

  const socket = socketClient.connect();
  const myId = () => socketClient.playerId;
  const myRoomId = () => socketClient.roomId;

  // Turn notification beep using Web Audio API
  let audioCtx = null;
  function playTurnBeep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      // First tone: 880Hz for 100ms
      const osc1 = audioCtx.createOscillator();
      const gain1 = audioCtx.createGain();
      osc1.frequency.value = 880;
      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc1.connect(gain1).connect(audioCtx.destination);
      osc1.start(now);
      osc1.stop(now + 0.1);
      // Second tone: 1046Hz for 100ms
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.frequency.value = 1046;
      gain2.gain.setValueAtTime(0.3, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc2.connect(gain2).connect(audioCtx.destination);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.2);
    } catch (e) {
      // Audio not supported or blocked
    }
  }

  // DOM elements
  const waitingRoom = document.getElementById('waiting-room');
  const gameView = document.getElementById('game-view');
  const roomIdDisplay = document.getElementById('room-id-display');
  const playerList = document.getElementById('player-list');
  const btnStart = document.getElementById('btn-start');
  const btnLeaveWaiting = document.getElementById('btn-leave-waiting');
  const btnAddAI = document.getElementById('btn-add-ai');
  const statusMessage = document.getElementById('status-message');
  const pokerTable = document.getElementById('poker-table');
  const communityCardsEl = document.getElementById('community-cards');
  const potDisplay = document.getElementById('pot-display');
  const myHandEl = document.getElementById('my-hand');
  const actionBar = document.getElementById('action-bar');
  const timerFill = document.getElementById('timer-fill');
  const timerText = document.getElementById('timer-text');
  const gameLog = document.getElementById('game-log');
  const showdownOverlay = document.getElementById('showdown-overlay');
  const showdownResults = document.getElementById('showdown-results');
  const showdownTitle = document.getElementById('showdown-title');
  const btnNextHand = document.getElementById('btn-next-hand');
  const btnCloseShowdown = document.getElementById('btn-close-showdown');

  // Chat elements
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnSendChat = document.getElementById('btn-send-chat');


  // Action buttons
  const btnFold = document.getElementById('btn-fold');
  const btnCheck = document.getElementById('btn-check');
  const btnCall = document.getElementById('btn-call');
  const btnRaise = document.getElementById('btn-raise');
  const btnAllin = document.getElementById('btn-allin');
  const btnPause = document.getElementById('btn-pause');
  const raiseControls = document.getElementById('raise-controls');
  const raiseSlider = document.getElementById('raise-slider');
  const raiseInput = document.getElementById('raise-input');
  const raiseAmount = document.getElementById('raise-amount');

  let currentState = null;
  let timerInterval = null;
  let autoStartInterval = null;
  let isGameStarted = false;
  let isGamePaused = false;
  let lastHandHistory = null;
  let lastShowdownData = null;

  // Hand history tracking for review
  let currentHandHistory = null;
  let lastShowdownData = null;
  const gtoAnalysisCache = new Map(); // handNumber -> analysis

  /**
   * Helper function to bind button actions with common pattern.
   * @param {HTMLButtonElement} btn - Button element
   * @param {string} eventName - Socket event name
   * @param {object} data - Event data
   * @param {function} onSuccess - Success callback
   */
  function bindButtonAction(btn, eventName, data, onSuccess) {
    btn.disabled = true;
    socket.emit(eventName, data, (res) => {
      btn.disabled = false;
      if (!res.success) {
        alert(res.error);
      } else if (onSuccess) {
        onSuccess(res);
      }
    });
  }

  // --- Waiting Room ---

  function updateWaitingRoom(state) {
    roomIdDisplay.textContent = state.id;
    playerList.innerHTML = '';

    let aiCount = 0;
    for (const p of state.players) {
      if (p.isAI) aiCount++;

      const li = document.createElement('li');
      li.textContent = p.name;
      if (p.id === state.hostId) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = '房主';
        li.appendChild(badge);
      }
      if (p.isAI) {
        const badge = document.createElement('span');
        badge.className = 'ai-badge';
        badge.textContent = 'AI';
        li.appendChild(badge);
        // Remove button for host
        if (state.hostId === myId()) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'btn-remove-ai';
          removeBtn.textContent = '移除';
          removeBtn.addEventListener('click', () => {
            removeBtn.disabled = true;
            socket.emit('room:removeAI', { aiPlayerId: p.id }, (res) => {
              removeBtn.disabled = false;
              if (!res.success) alert(res.error);
            });
          });
          li.appendChild(removeBtn);
        }
      }
      playerList.appendChild(li);
    }

    // Show start button for host
    if (state.hostId === myId() && state.players.length >= 2) {
      btnStart.classList.remove('hidden');
    } else {
      btnStart.classList.add('hidden');
    }

    // Show add-AI button for host, max 2 AI
    if (state.hostId === myId() && aiCount < 2 && !state.started) {
      btnAddAI.classList.remove('hidden');
    } else {
      btnAddAI.classList.add('hidden');
    }
  }

  // --- Game Table Rendering ---

  function renderGame(state) {
    if (!state.game) return;

    const game = state.game;
    currentState = state;

    // Clear table
    pokerTable.querySelectorAll('.player-seat, .player-bet').forEach(el => el.remove());

    // Find my index in players array
    const players = game.players;
    const myIndex = players.findIndex(p => p.id === myId());
    if (myIndex === -1) return;

    const positions = getPlayerPositions(players.length, myIndex);

    // Render each player
    players.forEach((player, i) => {
      const pos = positions[i];
      const isMe = player.id === myId();
      const seat = renderPlayerSeat(player, pos, isMe);
      pokerTable.appendChild(seat);

      // Render bet
      const betPos = getBetPosition(pos);
      renderBetChip(player, betPos, pokerTable);
    });

    // Community cards
    const prevCardCount = parseInt(communityCardsEl.dataset.cardCount || '0');
    communityCardsEl.innerHTML = '';
    game.communityCards.forEach((card, i) => {
      const isNew = i >= prevCardCount;
      communityCardsEl.appendChild(createCardElement(card, { dealing: isNew }));
    });
    communityCardsEl.dataset.cardCount = game.communityCards.length;

    // Pot
    if (game.pot > 0) {
      potDisplay.textContent = `奖池: $${game.pot}`;
      potDisplay.style.display = '';
    } else {
      potDisplay.style.display = 'none';
    }

    // My hand
    const me = players[myIndex];
    myHandEl.innerHTML = '';
    if (me.hand && me.hand.length > 0) {
      for (const card of me.hand) {
        myHandEl.appendChild(createCardElement(card, { dealing: true }));
      }
    }

    // Status message
    updateStatus(game, players);

    // Actions
    updateActions(game);
  }

  function updateStatus(game, players) {
    const stageNames = {
      'PRE_FLOP': '翻牌前',
      'FLOP': '翻牌',
      'TURN': '转牌',
      'RIVER': '河牌',
      'SHOWDOWN': '摊牌',
      'WAITING': '等待中'
    };

    let msg = stageNames[game.stage] || '';

    if (game.stage !== 'WAITING' && game.stage !== 'SHOWDOWN') {
      if (game.currentPlayerIndex >= 0 && game.currentPlayerIndex < players.length) {
        const current = players[game.currentPlayerIndex];
        if (current.id === myId()) {
          msg += ' — 轮到你行动';
        } else {
          msg += ` — 等待 ${current.name}`;
        }
      }
    }

    statusMessage.textContent = msg;
  }

  function updateActions(game) {
    if (!game.availableActions) {
      actionBar.classList.add('hidden');
      btnPause.classList.add('hidden');
      return;
    }

    actionBar.classList.remove('hidden');

    // Show pause button only if it's my turn
    const isMyTurn = game.currentPlayerIndex >= 0 &&
                     game.players[game.currentPlayerIndex]?.id === myId();

    if (isMyTurn) {
      btnPause.classList.remove('hidden');
    } else {
      btnPause.classList.add('hidden');
    }

    // Reset
    btnCheck.classList.add('hidden');
    btnCall.classList.add('hidden');
    btnRaise.classList.add('hidden');
    btnAllin.classList.add('hidden');
    raiseControls.classList.add('hidden');

    const actions = game.availableActions;

    for (const a of actions) {
      if (a === 'fold') {
        // Fold is always shown
      } else if (a === 'check') {
        btnCheck.classList.remove('hidden');
      } else if (a.action === 'call') {
        btnCall.classList.remove('hidden');
        btnCall.textContent = `跟注 $${a.amount}`;
      } else if (a.action === 'raise') {
        btnRaise.classList.remove('hidden');
        raiseControls.classList.remove('hidden');
        raiseSlider.min = a.min;
        raiseSlider.max = a.max;
        raiseSlider.value = a.min;
        if (raiseInput) {
          raiseInput.min = a.min;
          raiseInput.max = a.max;
          raiseInput.value = a.min;
        }
        raiseAmount.textContent = `$${a.min}`;
        btnRaise.textContent = `加注到 $${a.min}`;
      } else if (a.action === 'allin') {
        btnAllin.classList.remove('hidden');
        btnAllin.textContent = `全下 $${a.amount}`;
      }
    }
  }

  // --- Event Handlers ---

  btnStart.addEventListener('click', () => {
    bindButtonAction(btnStart, 'room:start', {});
  });

  btnLeaveWaiting.addEventListener('click', () => {
    socket.emit('room:leave');
    socketClient.clearSession();
    window.location.href = '/';
  });

  btnAddAI.addEventListener('click', () => {
    bindButtonAction(btnAddAI, 'room:addAI', {});
  });

  btnFold.addEventListener('click', () => {
    sendAction('fold');
  });

  btnCheck.addEventListener('click', () => {
    sendAction('check');
  });

  btnCall.addEventListener('click', () => {
    sendAction('call');
  });

  btnRaise.addEventListener('click', () => {
    const amount = parseInt(raiseSlider.value);
    sendAction('raise', amount);
  });

  btnAllin.addEventListener('click', () => {
    sendAction('allin');
  });

  raiseSlider.addEventListener('input', () => {
    const val = parseInt(raiseSlider.value);
    raiseAmount.textContent = `$${val}`;
    if (raiseInput) raiseInput.value = val;
    btnRaise.textContent = `加注到 $${val}`;
  });

  if (raiseInput) {
    raiseInput.addEventListener('input', () => {
      let val = parseInt(raiseInput.value);
      if (isNaN(val)) return;
      raiseSlider.value = val;
      raiseAmount.textContent = `$${val}`;
      btnRaise.textContent = `加注到 $${val}`;
    });
  }

  btnNextHand.addEventListener('click', () => {
    clearAutoStartTimer();
    bindButtonAction(btnNextHand, 'game:nextHand', {}, (res) => {
      showdownOverlay.classList.add('hidden');
    });
  });

  btnCloseShowdown.addEventListener('click', () => {
    showdownOverlay.classList.add('hidden');
  });

  btnPause.addEventListener('click', () => {
    const action = isGamePaused ? 'resume' : 'pause';
    socket.emit('game:pause', { action }, (res) => {
      if (!res.success) {
        alert(res.error);
      }
    });
  });

  function sendAction(action, amount) {
    // Prevent action if game is paused
    if (isGamePaused) {
      alert('游戏已暂停，请先恢复');
      return;
    }

    // FIX: Clear timer immediately when sending action
    clearTimer();

    actionBar.classList.add('hidden');
    socket.emit('game:action', { action, amount }, (res) => {
      if (!res.success) {
        addLog('系统', res.error);
        // Re-show actions
        if (currentState && currentState.game) {
          updateActions(currentState.game);
        }
      }
    });
  }

  // --- Socket Events ---

  socket.on('room:update', (state) => {
    currentState = state; // Always update current state
    if (!isGameStarted) {
      updateWaitingRoom(state);
    }
  });

  socket.on('game:started', (state) => {
    isGameStarted = true;
    lastHandHistory = null;
    lastShowdownData = null;
    clearAutoStartTimer();
    waitingRoom.classList.add('hidden');
    gameView.classList.remove('hidden');
    showdownOverlay.classList.add('hidden');
    gameLog.innerHTML = '';
    addLog('系统', `第 ${state.game.handNumber} 局开始`);

    // Initialize hand history for this hand
    currentHandHistory = {
      handNumber: state.game.handNumber,
      players: state.game.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        position: p.seat
      })),
      smallBlind: state.game.smallBlind,
      bigBlind: state.game.bigBlind,
      actions: { PRE_FLOP: [], FLOP: [], TURN: [], RIVER: [] },
      communityCards: [],
      currentStage: 'PRE_FLOP'
    };

    renderGame(state);
  });

  socket.on('game:state', (state) => {
    if (!isGameStarted) {
      isGameStarted = true;
      waitingRoom.classList.add('hidden');
      gameView.classList.remove('hidden');
    }
    renderGame(state);
  });

  socket.on('game:action', (data) => {
    const actionNames = {
      fold: '弃牌',
      check: '过牌',
      call: '跟注',
      raise: '加注到',
      allin: '全下'
    };

    let msg = actionNames[data.action] || data.action;
    if (data.action === 'raise' && data.amount) {
      msg += ` $${data.amount}`;
    } else if (data.action === 'call' && data.amount) {
      msg += ` $${data.amount}`;
    } else if (data.action === 'allin' && data.amount) {
      msg += ` $${data.amount}`;
    }
    addLog(data.playerName, msg);

    // Track action in hand history
    if (currentHandHistory) {
      const stage = currentHandHistory.currentStage;
      if (currentHandHistory.actions[stage]) {
        currentHandHistory.actions[stage].push({
          playerName: data.playerName,
          playerId: data.playerId,
          action: data.action,
          amount: data.amount || null
        });
      }
    }
  });

  socket.on('game:stageChange', (data) => {
    const stageNames = {
      'FLOP': '翻牌',
      'TURN': '转牌',
      'RIVER': '河牌'
    };
    addLog('系统', `--- ${stageNames[data.stage] || data.stage} ---`);

    // Track stage change in hand history
    if (currentHandHistory) {
      currentHandHistory.currentStage = data.stage;
      if (data.communityCards) {
        currentHandHistory.communityCards = data.communityCards;
      }
    }
  });

  socket.on('game:showdown', (data) => {
    lastShowdownData = data;
    lastHandHistory = data.handHistory || null;

    // Finalize hand history with showdown data
    if (currentHandHistory) {
      if (data.communityCards) {
        currentHandHistory.communityCards = data.communityCards;
      }
      if (data.playerHands) {
        currentHandHistory.playerHands = data.playerHands;
      }
      currentHandHistory.results = data.results;
      currentHandHistory.foldWin = !!data.foldWin;
    }

    showShowdown(data);
  });

  socket.on('game:timer', (data) => {
    startTimer(data.timeout);
    // Play beep if it's my turn
    if (data.playerId === myId()) {
      playTurnBeep();
    }
  });

  socket.on('game:timeout', (data) => {
    const player = currentState?.game?.players.find(p => p.id === data.playerId);
    if (player) {
      addLog(player.name, '超时');
    }
  });

  socket.on('game:over', (data) => {
    if (data.winner) {
      addLog('系统', `游戏结束! ${data.winner.name} 获胜，最终筹码: $${data.winner.chips}`);
    }
  });

  socket.on('game:autoStartTimer', (data) => {
    startAutoStartTimer(data.seconds);
  });

  socket.on('game:paused', (data) => {
    isGamePaused = data.paused;

    if (data.paused) {
      timerFill.classList.add('paused');
      timerText.classList.add('paused');
      timerText.textContent = '已暂停';
      btnPause.textContent = '恢复';
      btnPause.classList.add('is-paused');
      document.querySelector('.game-container').classList.add('is-paused');
      addLog('系统', `游戏已暂停 (${data.pausedBy})`);
    } else {
      timerFill.classList.remove('paused');
      timerText.classList.remove('paused');
      btnPause.textContent = '暂停';
      btnPause.classList.remove('is-paused');
      document.querySelector('.game-container').classList.remove('is-paused');
      addLog('系统', '游戏已恢复');
    }
  });

  socket.on('room:playerDisconnected', (data) => {
    addLog('系统', `${data.playerName} 断开连接`);
  });

  socket.on('room:playerLeft', (data) => {
    addLog('系统', `${data.playerName} 离开了房间`);
  });

  // --- Chat Events ---

  socket.on('chat:message', (data) => {
    addChatMessage(data);
  });

  function formatChatTime(timestamp) {
    const date = new Date(typeof timestamp === 'number' ? timestamp : Date.now());
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function addChatMessage(data) {
    const { playerId, playerName, message, isAI, timestamp } = data;
    if (!message) return;

    const isMe = playerId === myId();
    const entry = document.createElement('div');
    entry.className = 'chat-message';
    if (isMe) {
      entry.classList.add('is-me');
    }
    if (isAI) {
      entry.classList.add('chat-ai');
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    const meta = document.createElement('div');
    meta.className = 'chat-meta';

    const nameEl = document.createElement('span');
    nameEl.className = `chat-name ${isAI ? 'ai' : ''}`.trim();
    nameEl.textContent = playerName || '未知玩家';

    const timeEl = document.createElement('span');
    timeEl.className = 'chat-time';
    timeEl.textContent = formatChatTime(timestamp);

    const textEl = document.createElement('div');
    textEl.className = 'chat-text';
    textEl.textContent = message;

    meta.appendChild(nameEl);
    meta.appendChild(timeEl);
    bubble.appendChild(meta);
    bubble.appendChild(textEl);
    entry.appendChild(bubble);

    chatMessages.appendChild(entry);

    if (typeof chatMessages.scrollTo === 'function') {
      chatMessages.scrollTo({
        top: chatMessages.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Keep max 50 messages
    while (chatMessages.children.length > 50) {
      chatMessages.removeChild(chatMessages.firstChild);
    }
  }

  function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    socket.emit('chat:send', { message }, (res) => {
      if (res && !res.success) {
        alert(res.error || '发送失败');
      }
    });

    chatInput.value = '';
  }

  btnSendChat.addEventListener('click', sendChatMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });


  // --- Timer ---

  function startTimer(timeout) {
    clearTimer();
    const start = Date.now();
    timerFill.style.width = '100%';
    timerFill.classList.remove('warning', 'paused');
    timerText.textContent = Math.ceil(timeout / 1000) + 's';
    timerText.classList.remove('warning', 'paused');

    timerInterval = setInterval(() => {
      // Skip countdown if paused
      if (isGamePaused) {
        return;
      }

      const elapsed = Date.now() - start;
      const timeLeft = Math.max(0, timeout - elapsed);
      const remaining = timeLeft / timeout;

      timerFill.style.width = `${remaining * 100}%`;
      timerText.textContent = Math.ceil(timeLeft / 1000) + 's';

      if (remaining < 0.3) {
        timerFill.classList.add('warning');
        timerText.classList.add('warning');
      }
      if (remaining <= 0) {
        clearTimer();
      }
    }, 100);
  }

  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerFill.style.width = '0%';
    timerFill.classList.remove('warning', 'paused');
    timerText.textContent = '';
    timerText.classList.remove('warning', 'paused');
  }

  function startAutoStartTimer(seconds) {
    clearAutoStartTimer();

    let timeLeft = Math.floor(seconds);
    const updateText = () => {
      // Remove existing countdown if any
      const existing = document.getElementById('auto-start-countdown');
      if (existing) existing.remove();

      if (currentState && currentState.hostId === myId()) {
        btnNextHand.textContent = `下一局 (${timeLeft})`;
        btnNextHand.classList.remove('hidden');
      } else {
        // Show countdown message
        let countdownEl = document.createElement('div');
        countdownEl.id = 'auto-start-countdown';
        countdownEl.className = 'auto-start-countdown';

        const panel = document.querySelector('.showdown-panel');
        // Insert before buttons or at the end
        const actions = panel.querySelector('.modal-actions') || panel;
        if (actions.classList.contains('modal-actions')) {
          panel.insertBefore(countdownEl, actions);
        } else {
          panel.appendChild(countdownEl);
        }

        countdownEl.textContent = `下一局将在 ${timeLeft} 秒后开始...`;
      }
    };

    updateText();

    autoStartInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft <= 0) {
        clearAutoStartTimer();
      } else {
        updateText();
      }
    }, 1000);
  }

  function clearAutoStartTimer() {
    if (autoStartInterval) {
      clearInterval(autoStartInterval);
      autoStartInterval = null;
    }
    const existing = document.getElementById('auto-start-countdown');
    if (existing) existing.remove();

    // Reset button text
    btnNextHand.textContent = '下一局';
  }

  // --- Showdown ---

  function showShowdown(data) {
    clearTimer();
    showdownOverlay.classList.remove('hidden');

    if (data.foldWin) {
      showdownTitle.textContent = '所有人弃牌';
    } else {
      showdownTitle.textContent = '摊牌';
    }

    showdownResults.innerHTML = '';

    // Show community cards at top (not for fold wins)
    if (!data.foldWin && data.communityCards && data.communityCards.length > 0) {
      const communityDiv = document.createElement('div');
      communityDiv.className = 'showdown-community';
      communityDiv.innerHTML = '<div class="showdown-community-label">公共牌</div>';
      const cardsRow = document.createElement('div');
      cardsRow.className = 'showdown-community-cards';
      for (const card of data.communityCards) {
        cardsRow.appendChild(createCardElement(card, { small: true }));
      }
      communityDiv.appendChild(cardsRow);
      showdownResults.appendChild(communityDiv);
    }

    // Show my hand at the top (not for fold wins)
    if (!data.foldWin && data.playerHands && data.playerHands.length > 0) {
      const myHand = data.playerHands.find(ph => ph.id === myId());
      if (myHand && myHand.hand && myHand.hand.length > 0) {
        const myHandDiv = document.createElement('div');
        myHandDiv.className = 'showdown-my-hand';
        myHandDiv.innerHTML = '<div class="showdown-my-hand-label">我的手牌</div>';
        const cardsRow = document.createElement('div');
        cardsRow.className = 'showdown-my-hand-cards';
        for (const card of myHand.hand) {
          const cardEl = createCardElement(card, { small: true });
          cardsRow.appendChild(cardEl);
        }
        myHandDiv.appendChild(cardsRow);
        showdownResults.appendChild(myHandDiv);
      }
    }

    // Helper: check if a card matches any hole card
    function isHoleCard(card, holeCards) {
      if (!holeCards) return false;
      return holeCards.some(h => h.rank === card.rank && h.suit === card.suit);
    }

    // Show winners
    for (const result of data.results) {
      const div = document.createElement('div');
      div.className = 'showdown-result';

      let html = `<div class="winner-name">${result.player.name}</div>`;
      html += `<div class="winner-amount">赢得 $${result.amount}</div>`;
      if (result.hand) {
        html += `<div class="winner-hand">${result.hand}</div>`;
      }
      div.innerHTML = html;

      // Show hole cards (left) and best combination (right)
      if (result.bestCards && result.bestCards.length > 0) {
        const ph = data.playerHands && data.playerHands.find(p => p.id === result.player.id);
        const holeCards = ph ? ph.hand : null;
        const container = document.createElement('div');
        container.className = 'showdown-cards-container';

        // Hole cards group
        if (holeCards && holeCards.length > 0) {
          const holeGroup = document.createElement('div');
          holeGroup.className = 'showdown-cards-group';
          const holeCardsDiv = document.createElement('div');
          holeCardsDiv.className = 'showdown-cards';
          for (const card of holeCards) {
            const el = createCardElement(card, { small: true });
            el.classList.add('card-hole');
            holeCardsDiv.appendChild(el);
          }
          holeGroup.appendChild(holeCardsDiv);
          const holeLabel = document.createElement('div');
          holeLabel.className = 'showdown-cards-label';
          holeLabel.textContent = '手牌';
          holeGroup.appendChild(holeLabel);
          container.appendChild(holeGroup);
        }

        // Best 5-card combination group
        const bestGroup = document.createElement('div');
        bestGroup.className = 'showdown-cards-group';
        const bestCardsDiv = document.createElement('div');
        bestCardsDiv.className = 'showdown-cards';
        for (const card of result.bestCards) {
          const el = createCardElement(card, { small: true });
          if (isHoleCard(card, holeCards)) {
            el.classList.add('card-hole');
          }
          bestCardsDiv.appendChild(el);
        }
        bestGroup.appendChild(bestCardsDiv);
        const bestLabel = document.createElement('div');
        bestLabel.className = 'showdown-cards-label';
        bestLabel.textContent = '最佳组合';
        bestGroup.appendChild(bestLabel);
        container.appendChild(bestGroup);

        div.appendChild(container);
      }

      showdownResults.appendChild(div);
    }

    // Show all hands (non-winners)
    if (data.playerHands && data.playerHands.length > 0) {
      const winnerIds = new Set(data.results.map(r => r.player.id));
      for (const ph of data.playerHands) {
        if (winnerIds.has(ph.id)) continue;

        const div = document.createElement('div');
        div.className = 'showdown-result';
        div.style.opacity = '0.6';

        let html = `<div class="winner-name">${ph.name}</div>`;
        html += `<div class="winner-hand">${ph.bestHand}</div>`;
        div.innerHTML = html;

        // Show hole cards (left) and best combination (right)
        const bestCards = ph.bestCards || ph.hand;
        const container = document.createElement('div');
        container.className = 'showdown-cards-container';

        // Hole cards group
        if (ph.hand && ph.hand.length > 0) {
          const holeGroup = document.createElement('div');
          holeGroup.className = 'showdown-cards-group';
          const holeCardsDiv = document.createElement('div');
          holeCardsDiv.className = 'showdown-cards';
          for (const card of ph.hand) {
            const el = createCardElement(card, { small: true });
            el.classList.add('card-hole');
            holeCardsDiv.appendChild(el);
          }
          holeGroup.appendChild(holeCardsDiv);
          const holeLabel = document.createElement('div');
          holeLabel.className = 'showdown-cards-label';
          holeLabel.textContent = '手牌';
          holeGroup.appendChild(holeLabel);
          container.appendChild(holeGroup);
        }

        // Best 5-card combination group
        const bestGroup = document.createElement('div');
        bestGroup.className = 'showdown-cards-group';
        const bestCardsDiv = document.createElement('div');
        bestCardsDiv.className = 'showdown-cards';
        for (const card of bestCards) {
          const el = createCardElement(card, { small: true });
          if (isHoleCard(card, ph.hand)) {
            el.classList.add('card-hole');
          }
          bestCardsDiv.appendChild(el);
        }
        bestGroup.appendChild(bestCardsDiv);
        const bestLabel = document.createElement('div');
        bestLabel.className = 'showdown-cards-label';
        bestLabel.textContent = '最佳组合';
        bestGroup.appendChild(bestLabel);
        container.appendChild(bestGroup);

        div.appendChild(container);

        showdownResults.appendChild(div);
      }
    }

    // Show review button if hand history is available
    if (lastHandHistory) {
      const reviewBtn = document.createElement('button');
      reviewBtn.className = 'btn btn-review';
      reviewBtn.textContent = '复盘';
      reviewBtn.addEventListener('click', () => showHandReview(lastHandHistory));
      showdownResults.appendChild(reviewBtn);
    }

    // Show next hand button for host
    if (currentState && currentState.hostId === myId()) {
      btnNextHand.classList.remove('hidden');
    } else {
      btnNextHand.classList.add('hidden');
    }
    btnCloseShowdown.classList.remove('hidden');

    // Add review button (only if we have action history)
    const existingReviewBtn = document.getElementById('btn-hand-review');
    if (existingReviewBtn) existingReviewBtn.remove();

    if (currentHandHistory && !data.foldWin) {
      const hasActions = Object.values(currentHandHistory.actions).some(a => a.length > 0);
      if (hasActions) {
        const reviewBtn = document.createElement('button');
        reviewBtn.id = 'btn-hand-review';
        reviewBtn.className = 'btn-secondary btn-review';
        reviewBtn.textContent = '复盘';
        reviewBtn.addEventListener('click', () => {
          showHandReview(currentHandHistory);
        });
        const panel = document.querySelector('.showdown-panel');
        panel.appendChild(reviewBtn);
      }
    }
  }

  // --- Hand Review ---

  function showHandReview(history, analysis) {
    const stageNames = {
      'PRE_FLOP': '翻牌前',
      'FLOP': '翻牌',
      'TURN': '转牌',
      'RIVER': '河牌'
    };

    const actionNames = {
      fold: '弃牌', check: '过牌', call: '跟注',
      raise: '加注到', allin: '全下'
    };

    showdownOverlay.classList.remove('hidden');
    showdownTitle.textContent = '复盘分析';
    showdownResults.innerHTML = '';

    // Community cards
    if (history.communityCards && history.communityCards.length > 0) {
      const communityDiv = document.createElement('div');
      communityDiv.className = 'showdown-community';
      communityDiv.innerHTML = '<div class="showdown-community-label">公共牌</div>';
      const cardsRow = document.createElement('div');
      cardsRow.className = 'showdown-community-cards';
      for (const card of history.communityCards) {
        cardsRow.appendChild(createCardElement(card, { small: true }));
      }
      communityDiv.appendChild(cardsRow);
      showdownResults.appendChild(communityDiv);
    }

    // Player hands
    if (history.playerHands && history.playerHands.length > 0) {
      const handsDiv = document.createElement('div');
      handsDiv.className = 'review-hands';
      for (const ph of history.playerHands) {
        if (!ph.hand || ph.hand.length === 0) continue;
        const row = document.createElement('div');
        row.className = 'review-hand-row';
        row.innerHTML = `<span class="review-player-name">${ph.name}</span>`;
        const cardsSpan = document.createElement('span');
        cardsSpan.className = 'review-hand-cards';
        for (const card of ph.hand) {
          cardsSpan.appendChild(createCardElement(card, { small: true }));
        }
        row.appendChild(cardsSpan);
        if (ph.bestHand) {
          const label = document.createElement('span');
          label.className = 'review-hand-label';
          label.textContent = ph.bestHand;
          row.appendChild(label);
        }
        handsDiv.appendChild(row);
      }
      showdownResults.appendChild(handsDiv);
    }

    // Actions by stage
    const stages = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'];
    for (const stage of stages) {
      const actions = history.actions[stage];
      if (!actions || actions.length === 0) continue;

      const stageDiv = document.createElement('div');
      stageDiv.className = 'review-stage';

      const stageHeader = document.createElement('div');
      stageHeader.className = 'review-stage-header';
      stageHeader.textContent = stageNames[stage];
      stageDiv.appendChild(stageHeader);

      actions.forEach((act, idx) => {
        const row = document.createElement('div');
        row.className = 'review-action-row';

        let actionText = actionNames[act.action] || act.action;
        if (act.amount) actionText += ` $${act.amount}`;

        row.innerHTML = `<span class="review-action-player">${act.playerName}</span>` +
          `<span class="review-action-text">${actionText}</span>`;

        // GTO annotation
        if (analysis) {
          const match = analysis.actions.find(a => a.stage === stage && a.index === idx);
          if (match) {
            const annotation = document.createElement('span');
            annotation.className = 'gto-annotation';

            const badge = document.createElement('span');
            badge.className = `gto-badge gto-${match.rating}`;
            badge.textContent = match.rating === 'good' ? '合理' :
              match.rating === 'questionable' ? '可疑' : '失误';

            const tooltip = document.createElement('div');
            tooltip.className = 'gto-tooltip';
            tooltip.innerHTML = `<div class="gto-explanation">${match.explanation}</div>`;
            if (match.suggestion) {
              tooltip.innerHTML += `<div class="gto-suggestion">建议: ${match.suggestion}</div>`;
            }

            annotation.appendChild(badge);
            annotation.appendChild(tooltip);
            row.appendChild(annotation);
          }
        }

        stageDiv.appendChild(row);
      });

      showdownResults.appendChild(stageDiv);
    }

    // Results summary
    if (history.results && history.results.length > 0) {
      const resultsDiv = document.createElement('div');
      resultsDiv.className = 'review-results';
      resultsDiv.innerHTML = '<div class="review-stage-header">结果</div>';
      for (const r of history.results) {
        const row = document.createElement('div');
        row.className = 'review-result-row';
        row.innerHTML = `<span class="review-action-player">${r.player.name}</span>` +
          `<span class="review-result-amount">赢得 $${r.amount}</span>`;
        if (r.hand) {
          row.innerHTML += `<span class="review-hand-label">${r.hand}</span>`;
        }
        resultsDiv.appendChild(row);
      }
      showdownResults.appendChild(resultsDiv);
    }

    // GTO summary
    if (analysis && analysis.summary) {
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'gto-summary-section';
      summaryDiv.innerHTML = `<div class="gto-summary-label">AI 分析总结</div>` +
        `<div class="gto-summary-text">${analysis.summary}</div>`;
      showdownResults.appendChild(summaryDiv);
    }

    // Bottom buttons
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'review-actions';

    // Back button
    const backBtn = document.createElement('button');
    backBtn.className = 'btn-secondary';
    backBtn.textContent = '返回';
    backBtn.addEventListener('click', () => {
      if (lastShowdownData) {
        showShowdown(lastShowdownData);
      } else {
        showdownOverlay.classList.add('hidden');
      }
    });
    actionsDiv.appendChild(backBtn);

    // AI analysis button (only if no analysis yet)
    if (!analysis) {
      const aiBtn = document.createElement('button');
      aiBtn.className = 'btn-ai-analysis';
      aiBtn.textContent = 'AI分析';
      aiBtn.addEventListener('click', () => {
        requestGTOAnalysis(history, aiBtn);
      });
      actionsDiv.appendChild(aiBtn);
    }

    showdownResults.appendChild(actionsDiv);

    // Hide default showdown buttons
    btnNextHand.classList.add('hidden');
    btnCloseShowdown.classList.add('hidden');
  }

  function requestGTOAnalysis(history, button) {
    const handNum = history.handNumber;

    // Check cache
    const cached = gtoAnalysisCache.get(handNum);
    if (cached) {
      showHandReview(history, cached);
      return;
    }

    // Show loading state
    button.disabled = true;
    button.innerHTML = '<span class="gto-spinner"></span> AI分析中...';
    button.classList.add('gto-loading');

    socket.emit('game:requestReview', { handHistory: history }, (res) => {
      button.disabled = false;
      button.textContent = 'AI分析';
      button.classList.remove('gto-loading');

      if (res.success && res.analysis) {
        gtoAnalysisCache.set(handNum, res.analysis);
        showHandReview(history, res.analysis);
      } else {
        alert(res.error || 'AI分析失败');
      }
    });
  }

  function showHandReview(history) {
    showdownOverlay.classList.remove('hidden');
    showdownTitle.textContent = `第 ${history.handNumber} 局复盘`;
    showdownResults.innerHTML = '';
    btnNextHand.classList.add('hidden');
    btnCloseShowdown.classList.add('hidden');

    const actionNames = {
      fold: '弃牌', check: '过牌', call: '跟注',
      raise: '加注到', allin: '全下'
    };
    const stageNames = {
      PRE_FLOP: '翻牌前', FLOP: '翻牌', TURN: '转牌', RIVER: '河牌'
    };
    const winnerIds = new Set((history.results || []).map(r => r.playerId));

    // Section 1: All player hands
    const handsSection = document.createElement('div');
    handsSection.className = 'review-section';
    handsSection.innerHTML = '<div class="review-section-title">所有玩家手牌</div>';

    for (const p of history.players) {
      const row = document.createElement('div');
      row.className = 'review-player-row';

      let roleTag = '';
      if (p.isDealer) roleTag += ' <span class="review-role-badge badge-dealer">D</span>';
      if (p.isSB) roleTag += ' <span class="review-role-badge badge-sb">SB</span>';
      if (p.isBB) roleTag += ' <span class="review-role-badge badge-bb">BB</span>';

      const nameDiv = document.createElement('div');
      nameDiv.className = 'review-player-name';
      nameDiv.innerHTML = p.name + roleTag;
      row.appendChild(nameDiv);

      const cardsDiv = document.createElement('div');
      cardsDiv.className = 'review-player-cards';
      for (const card of p.hand) {
        cardsDiv.appendChild(createCardElement(card, { small: true }));
      }
      row.appendChild(cardsDiv);

      if (winnerIds.has(p.id)) {
        const badge = document.createElement('span');
        badge.className = 'review-winner-badge';
        badge.textContent = '赢家';
        row.appendChild(badge);
      }

      handsSection.appendChild(row);
    }
    showdownResults.appendChild(handsSection);

    // Section 2: Actions by stage
    const stages = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'];
    for (const stage of stages) {
      const actions = history.actions[stage];
      if (!actions || actions.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'review-section';
      section.innerHTML = `<div class="review-section-title">${stageNames[stage]}</div>`;

      // Show community cards for this stage
      const cc = history.communityCards[stage];
      if (cc && cc.length > 0) {
        const ccDiv = document.createElement('div');
        ccDiv.className = 'review-community-cards';
        for (const card of cc) {
          ccDiv.appendChild(createCardElement(card, { small: true }));
        }
        section.appendChild(ccDiv);
      }

      const list = document.createElement('div');
      list.className = 'review-actions-list';
      for (const a of actions) {
        const item = document.createElement('div');
        item.className = 'review-action';
        let text = actionNames[a.action] || a.action;
        if (a.amount !== undefined && a.action !== 'fold' && a.action !== 'check') {
          text += ` $${a.amount}`;
        }
        item.innerHTML = `<span class="review-action-name">${a.playerName}</span> <span class="review-action-text">${text}</span>`;
        list.appendChild(item);
      }
      section.appendChild(list);
      showdownResults.appendChild(section);
    }

    // Section 3: Results
    if (history.results && history.results.length > 0) {
      const resultSection = document.createElement('div');
      resultSection.className = 'review-section';
      resultSection.innerHTML = '<div class="review-section-title">结果</div>';
      for (const r of history.results) {
        const row = document.createElement('div');
        row.className = 'review-result';
        let text = `${r.playerName} 赢得 $${r.amount}`;
        if (r.hand) text += ` (${r.hand})`;
        row.textContent = text;
        resultSection.appendChild(row);
      }
      showdownResults.appendChild(resultSection);
    }

    // Back button
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-review-back';
    backBtn.textContent = '返回';
    backBtn.addEventListener('click', () => {
      if (lastShowdownData) showShowdown(lastShowdownData);
    });
    showdownResults.appendChild(backBtn);
  }

  // --- Log ---

  function addLog(name, message) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    if (name === '系统') {
      entry.innerHTML = `<span class="log-action">${message}</span>`;
    } else {
      entry.innerHTML = `<span class="log-name">${name}</span> <span class="log-action">${message}</span>`;
    }

    gameLog.appendChild(entry);
    gameLog.scrollTop = gameLog.scrollHeight;

    // Keep max 50 entries
    while (gameLog.children.length > 50) {
      gameLog.removeChild(gameLog.firstChild);
    }
  }

  // --- Initial load ---

  // Try to rejoin room
  socket.emit('room:join', {
    playerName: socketClient.playerName,
    roomId: myRoomId()
  }, (res) => {
    if (res.success) {
      socketClient.playerId = res.playerId;
      if (res.reconnected) {
        addLog('系统', '已重新连接');
      }
    } else {
      // Room doesn't exist, go back to lobby
      socketClient.clearSession();
      window.location.href = '/';
    }
  });

})();

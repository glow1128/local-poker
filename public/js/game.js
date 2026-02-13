(function () {
  // Restore session
  if (!socketClient.restoreSession()) {
    window.location.href = '/';
    return;
  }

  const socket = socketClient.connect();
  const myId = () => socketClient.playerId;
  const myRoomId = () => socketClient.roomId;

  // DOM elements
  const waitingRoom = document.getElementById('waiting-room');
  const gameView = document.getElementById('game-view');
  const roomIdDisplay = document.getElementById('room-id-display');
  const playerList = document.getElementById('player-list');
  const btnStart = document.getElementById('btn-start');
  const btnLeaveWaiting = document.getElementById('btn-leave-waiting');
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
  const dealerContainer = document.getElementById('dealer-container');

  // Action buttons
  const btnFold = document.getElementById('btn-fold');
  const btnCheck = document.getElementById('btn-check');
  const btnCall = document.getElementById('btn-call');
  const btnRaise = document.getElementById('btn-raise');
  const btnAllin = document.getElementById('btn-allin');
  const raiseControls = document.getElementById('raise-controls');
  const raiseSlider = document.getElementById('raise-slider');
  const raiseInput = document.getElementById('raise-input');
  const raiseAmount = document.getElementById('raise-amount');

  let currentState = null;
  let timerInterval = null;
  let autoStartInterval = null;
  let isGameStarted = false;
  let previousCurrentPlayerId = null;

  // Sound notification function
  function playTurnNotification() {
    try {
      // Use Web Audio API to generate a notification sound
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Create a pleasant notification tone (two beeps)
      oscillator.frequency.value = 800;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);

      // Second beep
      setTimeout(() => {
        const oscillator2 = audioContext.createOscillator();
        const gainNode2 = audioContext.createGain();

        oscillator2.connect(gainNode2);
        gainNode2.connect(audioContext.destination);

        oscillator2.frequency.value = 1000;
        oscillator2.type = 'sine';

        gainNode2.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);

        oscillator2.start(audioContext.currentTime);
        oscillator2.stop(audioContext.currentTime + 0.15);
      }, 150);
    } catch (e) {
      console.error('Failed to play notification sound:', e);
    }
  }

  // Dealer image display functions
  function showDealer() {
    if (dealerContainer) {
      dealerContainer.classList.remove('hidden');
    }
  }

  function hideDealer() {
    if (dealerContainer) {
      dealerContainer.classList.add('hidden');
    }
  }

  // --- Waiting Room ---

  function updateWaitingRoom(state) {
    roomIdDisplay.textContent = state.id;
    playerList.innerHTML = '';

    for (const p of state.players) {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (p.id === state.hostId) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = '房主';
        li.appendChild(badge);
      }
      playerList.appendChild(li);
    }

    // Show start button for host
    if (state.hostId === myId() && state.players.length >= 2) {
      btnStart.classList.remove('hidden');
    } else {
      btnStart.classList.add('hidden');
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
    communityCardsEl.innerHTML = '';
    for (const card of game.communityCards) {
      communityCardsEl.appendChild(createCardElement(card));
    }

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
      return;
    }

    actionBar.classList.remove('hidden');

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
    btnStart.disabled = true;
    socket.emit('room:start', {}, (res) => {
      btnStart.disabled = false;
      if (!res.success) {
        alert(res.error);
      }
    });
  });

  btnLeaveWaiting.addEventListener('click', () => {
    socket.emit('room:leave');
    socketClient.clearSession();
    window.location.href = '/';
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
    btnNextHand.disabled = true;
    clearAutoStartTimer();
    socket.emit('game:nextHand', {}, (res) => {
      btnNextHand.disabled = false;
      if (!res.success) {
        alert(res.error);
      } else {
        showdownOverlay.classList.add('hidden');
      }
    });
  });

  btnCloseShowdown.addEventListener('click', () => {
    showdownOverlay.classList.add('hidden');
  });

  function sendAction(action, amount) {
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
    clearAutoStartTimer();
    waitingRoom.classList.add('hidden');
    gameView.classList.remove('hidden');
    showdownOverlay.classList.add('hidden');
    gameLog.innerHTML = '';
    addLog('系统', `第 ${state.game.handNumber} 局开始`);
    renderGame(state);
  });

  socket.on('game:state', (state) => {
    if (!isGameStarted) {
      isGameStarted = true;
      waitingRoom.classList.add('hidden');
      gameView.classList.remove('hidden');
    }

    // Check if it's now the user's turn and play notification sound
    if (state.game && state.game.stage !== 'WAITING' && state.game.stage !== 'SHOWDOWN') {
      const players = state.game.players || [];
      if (state.game.currentPlayerIndex >= 0 && state.game.currentPlayerIndex < players.length) {
        const currentPlayer = players[state.game.currentPlayerIndex];
        const currentPlayerId = currentPlayer.id;

        // Play sound if it's now the user's turn and it wasn't before
        if (currentPlayerId === myId() && previousCurrentPlayerId !== currentPlayerId) {
          playTurnNotification();
        }

        previousCurrentPlayerId = currentPlayerId;
      }
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
  });

  socket.on('game:stageChange', (data) => {
    const stageNames = {
      'FLOP': '翻牌',
      'TURN': '转牌',
      'RIVER': '河牌'
    };
    addLog('系统', `--- ${stageNames[data.stage] || data.stage} ---`);

    // Show dealer image when dealing cards
    if (data.stage === 'PREFLOP' || data.stage === 'FLOP' || data.stage === 'TURN' || data.stage === 'RIVER') {
      showDealer();
      // Hide dealer after 2.5 seconds
      setTimeout(() => {
        hideDealer();
      }, 2500);
    }
  });

  socket.on('game:showdown', (data) => {
    showShowdown(data);
  });

  socket.on('game:timer', (data) => {
    startTimer(data.timeout);
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

  socket.on('room:playerDisconnected', (data) => {
    addLog('系统', `${data.playerName} 断开连接`);
  });

  socket.on('room:playerLeft', (data) => {
    addLog('系统', `${data.playerName} 离开了房间`);
  });

  // --- Timer ---

  function startTimer(timeout) {
    clearTimer();
    const start = Date.now();
    timerFill.style.width = '100%';
    timerFill.classList.remove('warning');
    timerText.textContent = Math.ceil(timeout / 1000) + 's';
    timerText.classList.remove('warning');

    timerInterval = setInterval(() => {
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
    timerText.textContent = '';
    timerText.classList.remove('warning');
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
        countdownEl.className = 'auto-start-countdown'; // Add class for styling if needed
        countdownEl.style.marginTop = '15px';
        countdownEl.style.fontSize = '1.2em';
        countdownEl.style.color = '#ffd700'; // Gold color

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

      // Show best cards
      if (result.bestCards && result.bestCards.length > 0) {
        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'showdown-cards';
        for (const card of result.bestCards) {
          cardsDiv.appendChild(createCardElement(card, { small: true }));
        }
        div.appendChild(cardsDiv);
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

        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'showdown-cards';
        for (const card of ph.hand) {
          cardsDiv.appendChild(createCardElement(card, { small: true }));
        }
        div.appendChild(cardsDiv);

        showdownResults.appendChild(div);
      }
    }

    // Show next hand button for host
    if (currentState && currentState.hostId === myId()) {
      btnNextHand.classList.remove('hidden');
    } else {
      btnNextHand.classList.add('hidden');
    }
    btnCloseShowdown.classList.remove('hidden');
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

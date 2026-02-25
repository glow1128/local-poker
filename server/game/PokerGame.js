const { Deck } = require('./Deck');
const { HandEvaluator } = require('./HandEvaluator');

const STAGES = {
  WAITING: 'WAITING',
  PRE_FLOP: 'PRE_FLOP',
  FLOP: 'FLOP',
  TURN: 'TURN',
  RIVER: 'RIVER',
  SHOWDOWN: 'SHOWDOWN'
};

class PokerGame {
  constructor({ smallBlind = 10, bigBlind = 20 } = {}) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.stage = STAGES.WAITING;
    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.players = [];         // ordered by seat
    this.dealerIndex = -1;     // will become 0 on first hand
    this.currentPlayerIndex = -1;
    this.lastRaiserIndex = -1;
    this.lastRaiseSize = 0;
    this.handNumber = 0;
    this.winners = null;       // set after showdown
    this.handHistory = null;   // recorded each hand for post-game review

    // Callbacks — set by Room
    this.onStateChange = null;
    this.onPlayerAction = null;
    this.onStageChange = null;
    this.onShowdown = null;
    this.onHandComplete = null;
  }

  addPlayer(player) {
    // player: { id, name, chips, seat }
    this.players.push({
      id: player.id,
      name: player.name,
      chips: player.chips,
      seat: player.seat,
      hand: [],
      bet: 0,
      totalBet: 0,    // total bet this hand (for side pots)
      folded: false,
      allIn: false,
      acted: false,
      disconnected: false,
      sittingOut: false
    });
    this.players.sort((a, b) => a.seat - b.seat);
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;

    // Adjust dealer index if needed
    if (idx < this.dealerIndex) {
      this.dealerIndex--;
    } else if (idx === this.dealerIndex) {
      this.dealerIndex = Math.min(this.dealerIndex, this.players.length - 2);
    }
    if (this.dealerIndex < 0) this.dealerIndex = 0;

    this.players.splice(idx, 1);
  }

  getActivePlayers() {
    return this.players.filter(p => !p.folded && !p.sittingOut);
  }

  getActionablePlayers() {
    return this.players.filter(p => !p.folded && !p.allIn && !p.sittingOut);
  }

  getPlayersInHand() {
    return this.players.filter(p => !p.sittingOut);
  }

  startHand() {
    const eligible = this.players.filter(p => p.chips > 0 && !p.disconnected);
    if (eligible.length < 2) return false;

    // Mark players with no chips as sitting out
    for (const p of this.players) {
      p.sittingOut = p.chips <= 0 || p.disconnected;
      p.hand = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.acted = false;
      p._isSB = false;
      p._isBB = false;
    }

    this.handNumber++;
    this.deck.reset();
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.winners = null;
    this.lastRaiseSize = this.bigBlind;

    // Advance dealer
    this._advanceDealer();

    const inHand = this.getPlayersInHand();
    const numPlayers = inHand.length;

    // Post blinds
    if (numPlayers === 2) {
      // Heads up: dealer posts SB, other posts BB
      const sbPlayer = inHand.find(p => p.seat === this.players[this.dealerIndex].seat);
      const bbPlayer = inHand.find(p => p !== sbPlayer);
      this._postBlind(sbPlayer, this.smallBlind);
      this._postBlind(bbPlayer, this.bigBlind);
      sbPlayer._isSB = true;
      bbPlayer._isBB = true;
    } else {
      // SB is left of dealer, BB is left of SB
      const sbIdx = this._nextActivePlayerIndex(this.dealerIndex);
      const bbIdx = this._nextActivePlayerIndex(sbIdx);
      this._postBlind(this.players[sbIdx], this.smallBlind);
      this._postBlind(this.players[bbIdx], this.bigBlind);
      this.players[sbIdx]._isSB = true;
      this.players[bbIdx]._isBB = true;
    }

    // Deal hole cards
    for (const p of inHand) {
      p.hand = this.deck.deal(2);
    }

    this.stage = STAGES.PRE_FLOP;

    // Initialize hand history for post-game review
    this.handHistory = {
      handNumber: this.handNumber,
      players: inHand.map(p => ({
        id: p.id, name: p.name, seat: p.seat,
        chips: p.chips + p.totalBet,  // chips before blinds
        hand: p.hand.map(c => c.toJSON()),
        isDealer: this.players.indexOf(p) === this.dealerIndex,
        isSB: p._isSB, isBB: p._isBB
      })),
      actions: { PRE_FLOP: [], FLOP: [], TURN: [], RIVER: [] },
      communityCards: { FLOP: [], TURN: [], RIVER: [] },
      results: null
    };

    // Set first to act: left of BB (or SB in heads-up)
    if (numPlayers === 2) {
      // Heads up: dealer/SB acts first pre-flop
      this.currentPlayerIndex = this.dealerIndex;
    } else {
      const bbIdx = this._findBBIndex();
      this.currentPlayerIndex = this._nextActionablePlayerIndex(bbIdx);
    }

    // The last raiser pre-flop is the BB (everyone needs to match or raise)
    this.lastRaiserIndex = this._findBBIndex();

    if (this.onStateChange) this.onStateChange();
    return true;
  }

  handleAction(playerId, action, amount = 0) {
    const playerIdx = this.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1) return { success: false, error: '玩家不存在' };

    const player = this.players[playerIdx];

    if (this.stage === STAGES.WAITING || this.stage === STAGES.SHOWDOWN) {
      return { success: false, error: '当前不在下注阶段' };
    }
    if (playerIdx !== this.currentPlayerIndex) {
      return { success: false, error: '不是你的回合' };
    }
    if (player.folded || player.allIn || player.sittingOut) {
      return { success: false, error: '无法操作' };
    }

    const maxBet = this._getCurrentMaxBet();

    switch (action) {
      case 'fold':
        return this._handleFold(player, playerIdx);
      case 'check':
        return this._handleCheck(player, playerIdx, maxBet);
      case 'call':
        return this._handleCall(player, playerIdx, maxBet);
      case 'raise':
        return this._handleRaise(player, playerIdx, amount, maxBet);
      case 'allin':
        return this._handleAllIn(player, playerIdx, maxBet);
      default:
        return { success: false, error: '无效操作' };
    }
  }

  _handleFold(player, playerIdx) {
    player.folded = true;
    player.acted = true;

    if (this.onPlayerAction) {
      this.onPlayerAction(player, 'fold');
    }
    this._recordAction(player, 'fold');

    // Check if only one player left
    const active = this.getActivePlayers();
    if (active.length === 1) {
      this._awardPotToLastPlayer(active[0]);
      return { success: true };
    }

    this._advanceAction();
    return { success: true };
  }

  _handleCheck(player, playerIdx, maxBet) {
    if (player.bet < maxBet) {
      return { success: false, error: '不能过牌，需要跟注或加注' };
    }

    player.acted = true;
    if (this.onPlayerAction) {
      this.onPlayerAction(player, 'check');
    }
    this._recordAction(player, 'check');

    this._advanceAction();
    return { success: true };
  }

  _handleCall(player, playerIdx, maxBet) {
    const callAmount = Math.min(maxBet - player.bet, player.chips);
    if (callAmount <= 0) {
      return { success: false, error: '无需跟注' };
    }

    player.chips -= callAmount;
    player.bet += callAmount;
    player.totalBet += callAmount;
    this.pot += callAmount;
    player.acted = true;

    if (player.chips === 0) {
      player.allIn = true;
    }

    if (this.onPlayerAction) {
      this.onPlayerAction(player, 'call', callAmount);
    }
    this._recordAction(player, 'call', callAmount);

    this._advanceAction();
    return { success: true };
  }

  _handleRaise(player, playerIdx, raiseTo, maxBet) {
    // raiseTo is the total bet amount the player wants to have
    if (raiseTo <= maxBet) {
      return { success: false, error: '加注金额必须大于当前最大注' };
    }

    const minRaise = maxBet + this.lastRaiseSize;
    // Allow all-in even if less than min raise
    const totalNeeded = raiseTo - player.bet;
    if (totalNeeded > player.chips) {
      return { success: false, error: '筹码不足' };
    }

    if (raiseTo < minRaise && totalNeeded < player.chips) {
      return { success: false, error: `最低加注到 ${minRaise}` };
    }

    const actualRaise = raiseTo - maxBet;
    this.lastRaiseSize = Math.max(this.lastRaiseSize, actualRaise);

    player.chips -= totalNeeded;
    player.bet += totalNeeded;
    player.totalBet += totalNeeded;
    this.pot += totalNeeded;
    player.acted = true;

    if (player.chips === 0) {
      player.allIn = true;
    }

    // Reset acted for all other non-folded, non-allin players
    for (const p of this.players) {
      if (p !== player && !p.folded && !p.allIn && !p.sittingOut) {
        p.acted = false;
      }
    }
    this.lastRaiserIndex = playerIdx;

    if (this.onPlayerAction) {
      this.onPlayerAction(player, 'raise', raiseTo);
    }
    this._recordAction(player, 'raise', raiseTo);

    this._advanceAction();
    return { success: true };
  }

  _handleAllIn(player, playerIdx, maxBet) {
    const allInAmount = player.chips;
    const newBet = player.bet + allInAmount;

    player.chips = 0;
    player.totalBet += allInAmount;
    this.pot += allInAmount;
    player.acted = true;
    player.allIn = true;

    if (newBet > maxBet) {
      const raiseAmount = newBet - maxBet;
      // Only reopen betting if the raise is at least the minimum raise size
      if (raiseAmount >= this.lastRaiseSize) {
        this.lastRaiseSize = raiseAmount;
        this.lastRaiserIndex = playerIdx;
        // Reset acted for others
        for (const p of this.players) {
          if (p !== player && !p.folded && !p.allIn && !p.sittingOut) {
            p.acted = false;
          }
        }
      }
    }

    player.bet = newBet;

    if (this.onPlayerAction) {
      this.onPlayerAction(player, 'allin', allInAmount);
    }
    this._recordAction(player, 'allin', allInAmount);

    // Check if only one active non-allin player or fewer
    const active = this.getActivePlayers();
    if (active.length === 1) {
      this._awardPotToLastPlayer(active[0]);
      return { success: true };
    }

    this._advanceAction();
    return { success: true };
  }

  _recordAction(player, action, amount) {
    if (!this.handHistory) return;
    const entry = { playerId: player.id, playerName: player.name, action };
    if (amount !== undefined) entry.amount = amount;
    const stageActions = this.handHistory.actions[this.stage];
    if (stageActions) stageActions.push(entry);
  }

  _advanceAction() {
    const actionable = this.getActionablePlayers();

    // If no one can act (all folded or all-in), advance stage
    if (actionable.length === 0) {
      this._advanceStage();
      return;
    }

    // If only one actionable and they've acted, advance stage
    if (actionable.length === 1 && actionable[0].acted) {
      this._advanceStage();
      return;
    }

    // Find next player who hasn't acted
    let nextIdx = this._nextActionablePlayerIndex(this.currentPlayerIndex);
    let checked = 0;

    while (checked < this.players.length) {
      const p = this.players[nextIdx];
      if (!p.folded && !p.allIn && !p.sittingOut && !p.acted) {
        this.currentPlayerIndex = nextIdx;
        if (this.onStateChange) this.onStateChange();
        return;
      }
      nextIdx = this._nextActionablePlayerIndex(nextIdx);
      checked++;
    }

    // Everyone has acted
    this._advanceStage();
  }

  _advanceStage() {
    // Collect bets into pot (already done incrementally)
    // Reset per-round state
    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
    }
    this.lastRaiseSize = this.bigBlind;

    const activePlayers = this.getActivePlayers();
    const actionablePlayers = this.getActionablePlayers();

    // If only one not-folded player, they win
    if (activePlayers.length === 1) {
      this._awardPotToLastPlayer(activePlayers[0]);
      return;
    }

    const allInOrFolded = actionablePlayers.length <= 1;

    switch (this.stage) {
      case STAGES.PRE_FLOP:
        this.stage = STAGES.FLOP;
        this.deck.burn();
        this.communityCards.push(...this.deck.deal(3));
        if (this.handHistory) this.handHistory.communityCards.FLOP = this.communityCards.slice(0, 3).map(c => c.toJSON());
        break;
      case STAGES.FLOP:
        this.stage = STAGES.TURN;
        this.deck.burn();
        this.communityCards.push(this.deck.deal());
        if (this.handHistory) this.handHistory.communityCards.TURN = [this.communityCards[3].toJSON()];
        break;
      case STAGES.TURN:
        this.stage = STAGES.RIVER;
        this.deck.burn();
        this.communityCards.push(this.deck.deal());
        if (this.handHistory) this.handHistory.communityCards.RIVER = [this.communityCards[4].toJSON()];
        break;
      case STAGES.RIVER:
        this._showdown();
        return;
    }

    if (this.onStageChange) this.onStageChange(this.stage, this.communityCards);

    // If all remaining players are all-in (or only 1 can act), run out remaining cards
    if (allInOrFolded) {
      if (this.onRunoutContinue) {
        this.onRunoutContinue();
      } else {
        this._advanceStage();
      }
      return;
    }

    // Set first to act: first active player left of dealer
    this.currentPlayerIndex = this._nextActionablePlayerIndex(this.dealerIndex);
    this.lastRaiserIndex = -1;

    if (this.onStateChange) this.onStateChange();
  }

  _showdown() {
    this.stage = STAGES.SHOWDOWN;
    const activePlayers = this.getActivePlayers();

    // Calculate side pots
    const pots = this._calculateSidePots();

    const results = [];

    for (const pot of pots) {
      // Evaluate hands for eligible players
      const evaluations = [];
      for (const p of pot.eligible) {
        if (p.folded) continue;
        const allCards = [...p.hand, ...this.communityCards];
        const eval_ = HandEvaluator.evaluate(allCards);
        evaluations.push({ player: p, eval: eval_ });
      }

      // Sort by hand strength (best first)
      evaluations.sort((a, b) => HandEvaluator.compareScores(b.eval.score, a.eval.score));

      // Find winners (may be tied)
      const bestScore = evaluations[0].eval.score;
      const winners = evaluations.filter(e =>
        HandEvaluator.compareScores(e.eval.score, bestScore) === 0
      );

      // Split pot among winners
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;

      winners.forEach((w, i) => {
        const bonus = i === 0 ? remainder : 0; // remainder to first winner (closest left of dealer)
        w.player.chips += share + bonus;

        const existing = results.find(r => r.player.id === w.player.id);
        if (existing) {
          existing.amount += share + bonus;
        } else {
          results.push({
            player: { id: w.player.id, name: w.player.name },
            amount: share + bonus,
            hand: w.eval.name,
            bestCards: w.eval.bestCards,
            score: w.eval.score
          });
        }
      });
    }

    // Add hand info for all active players (for showing cards)
    const showdownData = {
      results,
      playerHands: activePlayers.map(p => {
        const allCards = [...p.hand, ...this.communityCards];
        const eval_ = HandEvaluator.evaluate(allCards);
        return {
          id: p.id,
          name: p.name,
          hand: p.hand,
          bestHand: eval_.name,
          bestCards: eval_.bestCards,
          score: eval_.score
        };
      }),
      communityCards: this.communityCards,
      pots
    };

    // Record results to hand history
    if (this.handHistory) {
      this.handHistory.results = results.map(r => ({
        playerId: r.player.id, playerName: r.player.name,
        amount: r.amount, hand: r.hand
      }));
      showdownData.handHistory = this.handHistory;
    }

    this.winners = results;

    if (this.onShowdown) this.onShowdown(showdownData);
    if (this.onHandComplete) this.onHandComplete();
  }

  _calculateSidePots() {
    const playersInHand = this.getPlayersInHand().filter(p => p.totalBet > 0);

    if (playersInHand.length === 0) return [{ amount: this.pot, eligible: this.getActivePlayers() }];

    // Get unique bet levels from all-in players
    const betLevels = [...new Set(playersInHand.map(p => p.totalBet))].sort((a, b) => a - b);

    const pots = [];
    let previousLevel = 0;

    for (const level of betLevels) {
      const diff = level - previousLevel;
      if (diff <= 0) continue;

      const eligible = playersInHand.filter(p => p.totalBet >= level);
      const contributors = playersInHand.filter(p => p.totalBet > previousLevel);
      const amount = contributors.reduce((sum, p) => {
        return sum + Math.min(diff, p.totalBet - previousLevel);
      }, 0);

      if (amount > 0) {
        // Only non-folded players are eligible to win
        const eligibleActive = eligible.filter(p => !p.folded);
        pots.push({ amount, eligible: eligibleActive.length > 0 ? eligibleActive : eligible });
      }

      previousLevel = level;
    }

    // Merge pots with identical eligible sets
    const mergedPots = [];
    for (const pot of pots) {
      const ids = pot.eligible.map(p => p.id).sort().join(',');
      const existing = mergedPots.find(mp =>
        mp.eligible.map(p => p.id).sort().join(',') === ids
      );
      if (existing) {
        existing.amount += pot.amount;
      } else {
        mergedPots.push(pot);
      }
    }

    return mergedPots.length > 0 ? mergedPots : [{ amount: this.pot, eligible: this.getActivePlayers() }];
  }

  _awardPotToLastPlayer(winner) {
    winner.chips += this.pot;
    this.stage = STAGES.SHOWDOWN;

    const results = [{
      player: { id: winner.id, name: winner.name },
      amount: this.pot,
      hand: null,
      bestCards: null,
      score: null
    }];

    this.winners = results;

    // Record results to hand history
    if (this.handHistory) {
      this.handHistory.results = results.map(r => ({
        playerId: r.player.id, playerName: r.player.name,
        amount: r.amount, hand: r.hand
      }));
    }

    if (this.onShowdown) {
      this.onShowdown({
        results,
        playerHands: [],
        communityCards: this.communityCards,
        pots: [{ amount: this.pot, eligible: [winner] }],
        foldWin: true,
        handHistory: this.handHistory || null
      });
    }
    if (this.onHandComplete) this.onHandComplete();
  }

  playerDisconnected(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return;

    player.disconnected = true;

    if (this.stage !== STAGES.WAITING && this.stage !== STAGES.SHOWDOWN) {
      if (!player.folded && !player.allIn) {
        const idx = this.players.indexOf(player);
        if (idx === this.currentPlayerIndex) {
          this.handleAction(playerId, 'fold');
        } else {
          player.folded = true;
          // Check if only one remains
          const active = this.getActivePlayers();
          if (active.length === 1) {
            this._awardPotToLastPlayer(active[0]);
          }
        }
      }
    }
  }

  playerReconnected(oldId, newId) {
    const player = this.players.find(p => p.id === oldId);
    if (player) {
      player.id = newId;
      player.disconnected = false;
    }
  }

  _postBlind(player, amount) {
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.bet = actual;
    player.totalBet = actual;
    this.pot += actual;
    if (player.chips === 0) player.allIn = true;
  }

  _advanceDealer() {
    const inHand = this.getPlayersInHand();
    if (inHand.length === 0) return;

    if (this.dealerIndex === -1) {
      this.dealerIndex = 0;
    } else {
      this.dealerIndex = this._nextActivePlayerIndexForDealer(this.dealerIndex);
    }
  }

  _nextActivePlayerIndexForDealer(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    let count = 0;
    while (count < this.players.length) {
      if (!this.players[idx].sittingOut) return idx;
      idx = (idx + 1) % this.players.length;
      count++;
    }
    return fromIdx;
  }

  _nextActivePlayerIndex(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    let count = 0;
    while (count < this.players.length) {
      const p = this.players[idx];
      if (!p.folded && !p.sittingOut) return idx;
      idx = (idx + 1) % this.players.length;
      count++;
    }
    return fromIdx;
  }

  _nextActionablePlayerIndex(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    let count = 0;
    while (count < this.players.length) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && !p.sittingOut) return idx;
      idx = (idx + 1) % this.players.length;
      count++;
    }
    return fromIdx;
  }

  _findBBIndex() {
    return this.players.findIndex(p => p._isBB);
  }

  continueRunout() {
    this._advanceStage();
  }

  _getCurrentMaxBet() {
    return Math.max(0, ...this.players.map(p => p.bet));
  }

  getGameState(forPlayerId = null) {
    const state = {
      stage: this.stage,
      pot: this.pot,
      communityCards: this.communityCards.map(c => c.toJSON()),
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      handNumber: this.handNumber,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      winners: this.winners,
      players: this.players.map((p, idx) => {
        const info = {
          id: p.id,
          name: p.name,
          chips: p.chips,
          bet: p.bet,
          totalBet: p.totalBet,
          folded: p.folded,
          allIn: p.allIn,
          sittingOut: p.sittingOut,
          disconnected: p.disconnected,
          seat: p.seat,
          isDealer: idx === this.dealerIndex,
          isSB: !!p._isSB,
          isBB: !!p._isBB,
          isCurrent: idx === this.currentPlayerIndex && this.stage !== STAGES.WAITING && this.stage !== STAGES.SHOWDOWN,
          hand: null
        };

        // Only send hole cards to the player themselves
        if (forPlayerId && p.id === forPlayerId && p.hand.length > 0) {
          info.hand = p.hand.map(c => c.toJSON());
        }

        // Show hands during showdown
        if (this.stage === STAGES.SHOWDOWN && !p.folded && p.hand.length > 0) {
          info.hand = p.hand.map(c => c.toJSON());
        }

        return info;
      })
    };

    // Add available actions for current player
    if (forPlayerId) {
      const playerIdx = this.players.findIndex(p => p.id === forPlayerId);
      if (playerIdx === this.currentPlayerIndex && this.stage !== STAGES.WAITING && this.stage !== STAGES.SHOWDOWN) {
        state.availableActions = this._getAvailableActions(this.players[playerIdx]);
      }
    }

    return state;
  }

  _getAvailableActions(player) {
    const maxBet = this._getCurrentMaxBet();
    const actions = ['fold'];

    if (player.bet >= maxBet) {
      actions.push('check');
    } else {
      const callAmount = Math.min(maxBet - player.bet, player.chips);
      actions.push({ action: 'call', amount: callAmount });
    }

    // Raise
    const minRaise = maxBet + this.lastRaiseSize;
    const maxRaise = player.bet + player.chips;
    if (maxRaise > maxBet) {
      actions.push({
        action: 'raise',
        min: Math.min(minRaise, maxRaise),
        max: maxRaise
      });
    }

    // All-in (always available if has chips)
    if (player.chips > 0) {
      actions.push({ action: 'allin', amount: player.chips });
    }

    return actions;
  }
}

module.exports = { PokerGame, STAGES };

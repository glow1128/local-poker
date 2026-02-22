/**
 * AI Decision Engine (MVP)
 *
 * Decision flow:
 *   1. normalizeInput() — collect game state into structured input
 *   2. computeBaseline() — simple heuristic strategy (placeholder for GTO)
 *   3. decideWithLLM() — TODO: call real LLM for style-aware selection
 *   4. validateAction() — legality check; fallback to baseline if invalid
 */

const { HandEvaluator } = require('../game/HandEvaluator');
const aiConfig = require('./aiConfig');

// LLM request/response logging (opt-in via AI_LLM_LOG=1)
const LLM_LOG = process.env.AI_LLM_LOG === '1';
const LLM_LOG_PREFIX = '[AI][LLM]';

function _llmLog(...args) {
  if (LLM_LOG) console.log(LLM_LOG_PREFIX, ...args);
}

// AI player name pool
const AI_NAMES = ['Alice AI', 'Bob AI', 'Charlie AI', 'Diana AI'];

// AI personality definitions
const AI_PERSONALITIES = {
  BALANCED: {
    id: 'balanced',
    name: '均衡',
    instruction: '根据牌力和赔率合理决策。偶尔在有利位置进行小额诈唬，强牌时正常价值下注（锅注的50-75%）。'
  },
  BLUFFER: {
    id: 'bluffer',
    name: '诈唬',
    instruction: '在有利位置时比均衡风格更频繁选择下注而非过牌，弱牌时偶尔做小额诈唬（不超过锅注）。强牌时正常跟注或小幅加注，避免大注暴露风格。'
  },
  AGGRESSIVE: {
    id: 'aggressive',
    name: '激进',
    instruction: '比均衡风格更频繁加注，中等以上手牌倾向加注而非跟注。强牌时选择较大的价值下注（锅注的75-100%）。但不用全下代替正常加注。'
  }
};

// Personality-specific baseline parameters
const PERSONALITY_CONFIG = {
  balanced:    { raiseQualityThreshold: 0.8, raiseSizingFraction: 0.35, bluffProb: 0.08 },
  aggressive:  { raiseQualityThreshold: 0.5, raiseSizingFraction: 0.55, bluffProb: 0.10 },
  bluffer:     { raiseQualityThreshold: 0.7, raiseSizingFraction: 0.25, bluffProb: 0.18 }
};
const DEFAULT_PERSONALITY_CONFIG = PERSONALITY_CONFIG.balanced;

/**
 * Get a random AI personality.
 * @returns {object} A personality object from AI_PERSONALITIES
 */
function getRandomPersonality() {
  const personalities = Object.values(AI_PERSONALITIES);
  return personalities[Math.floor(Math.random() * personalities.length)];
}

// Hand quality thresholds
const WEAK_HAND_THRESHOLD = 0.3;
const MEDIUM_HAND_THRESHOLD = 0.5;
const STRONG_HAND_THRESHOLD = 0.7;
const VERY_STRONG_HAND_THRESHOLD = 0.8;

class AIDecisionEngine {
  constructor() {
    // TODO: accept aiConfig (style, aggression, etc.)
  }

  /**
   * Main entry point: decide an action for the AI player.
   * @param {object} game - PokerGame instance
   * @param {string} playerId - AI player's id
   * @param {object} personality - AI personality object (optional)
   * @returns {{ action: string, amount: number|null, meta: object }}
   */
  async decide(game, playerId, personality = null) {
    const input = this.normalizeInput(game, playerId);
    const baseline = this.computeBaseline(input, personality);

    let decision = await this.decideWithLLM(input, baseline, personality);

    // Validate and fallback
    if (!this.validateAction(decision, input)) {
      console.log(`[AI] Invalid action from LLM: ${JSON.stringify(decision)}, falling back to baseline`);
      decision = { ...baseline.baselineAction, meta: { source: 'baseline', fallback: true } };
    }

    return decision;
  }

  /**
   * Step 1: Normalize game state into structured input for decision-making.
   */
  normalizeInput(game, playerId) {
    const player = game.players.find(p => p.id === playerId);
    const playerIdx = game.players.indexOf(player);
    const maxBet = Math.max(0, ...game.players.map(p => p.bet));
    const activePlayers = game.getActivePlayers();
    const actionablePlayers = game.getActionablePlayers();

    // Map stage to street name
    const stageToStreet = {
      'PRE_FLOP': 'preflop',
      'FLOP': 'flop',
      'TURN': 'turn',
      'RIVER': 'river'
    };

    // Compute available actions (same logic as PokerGame._getAvailableActions)
    const availableActions = game._getAvailableActions(player);

    // Evaluate hand strength if we have community cards
    let handStrength = null;
    if (player.hand.length === 2 && game.communityCards.length > 0) {
      const allCards = [...player.hand, ...game.communityCards];
      handStrength = HandEvaluator.evaluate(allCards);
    }

    // Simple pre-flop hand ranking (0-1 scale, very rough)
    let preflopStrength = 0;
    if (player.hand.length === 2 && game.communityCards.length === 0) {
      preflopStrength = this._estimatePreflopStrength(player.hand);
    }

    return {
      street: stageToStreet[game.stage] || game.stage,
      stage: game.stage,
      publicCards: game.communityCards.map(c => c.toJSON()),
      holeCards: player.hand.map(c => c.toJSON()),
      potSize: game.pot,
      currentBet: maxBet,
      playerBet: player.bet,
      playerChips: player.chips,
      minRaise: maxBet + game.lastRaiseSize,
      callAmount: Math.min(maxBet - player.bet, player.chips),
      playersInHand: activePlayers.length,
      actionablePlayers: actionablePlayers.length,
      totalPlayers: game.players.filter(p => !p.sittingOut).length,
      position: this._getPosition(game, playerIdx),
      dealerIndex: game.dealerIndex,
      playerIndex: playerIdx,
      handStrength,
      preflopStrength,
      availableActions,
      bigBlind: game.bigBlind,
      smallBlind: game.smallBlind,
      // TODO: actionHistory for current hand
    };
  }

  /**
   * Step 2: Compute baseline strategy action.
   * MVP: simple heuristic based on hand strength & pot odds.
   * Personality config adjusts raise thresholds, sizing, and bluff frequency.
   */
  computeBaseline(input, personality = null) {
    const { street, potSize, currentBet, playerBet, playerChips,
            callAmount, minRaise, preflopStrength, handStrength,
            availableActions, bigBlind } = input;

    // Look up personality-specific parameters
    const pConfig = personality
      ? (PERSONALITY_CONFIG[personality.id] || DEFAULT_PERSONALITY_CONFIG)
      : DEFAULT_PERSONALITY_CONFIG;

    // Determine hand quality (0-1 rough scale)
    let quality = WEAK_HAND_THRESHOLD; // default mediocre
    if (street === 'preflop') {
      quality = preflopStrength;
    } else if (handStrength) {
      // Use hand rank for post-flop quality estimation
      quality = this._handRankToQuality(handStrength);
    }

    // Pot odds
    const potOdds = callAmount > 0 ? callAmount / (potSize + callAmount) : 0;

    // Decide baseline action using personality-aware raise threshold
    let baselineAction;

    if (quality >= pConfig.raiseQualityThreshold) {
      // Hand meets personality's raise threshold: raise
      const raiseInfo = availableActions.find(a => a.action === 'raise');
      if (raiseInfo) {
        // Cap raise at pot-sized: min + fraction of (pot-level raise - min)
        const potSizedRaise = Math.min(currentBet + potSize, raiseInfo.max);
        const raiseRange = Math.max(0, potSizedRaise - raiseInfo.min);
        const raiseAmount = Math.min(
          Math.round(raiseInfo.min + raiseRange * pConfig.raiseSizingFraction),
          raiseInfo.max
        );
        baselineAction = { action: 'raise', amount: raiseAmount };
      } else {
        baselineAction = callAmount > 0
          ? { action: 'call', amount: null }
          : { action: 'check', amount: null };
      }
    } else if (quality >= MEDIUM_HAND_THRESHOLD) {
      // Medium hand: call or check
      if (callAmount === 0 || currentBet <= playerBet) {
        baselineAction = { action: 'check', amount: null };
      } else if (potOdds < 0.35) {
        baselineAction = { action: 'call', amount: null };
      } else {
        baselineAction = { action: 'fold', amount: null };
      }
    } else if (quality >= WEAK_HAND_THRESHOLD) {
      // Marginal: check if free, otherwise fold (with some call threshold)
      if (callAmount === 0 || currentBet <= playerBet) {
        baselineAction = { action: 'check', amount: null };
      } else if (callAmount <= bigBlind && potOdds < 0.2) {
        baselineAction = { action: 'call', amount: null };
      } else {
        baselineAction = { action: 'fold', amount: null };
      }
    } else {
      // Weak hand: fold (or check if free)
      if (callAmount === 0 || currentBet <= playerBet) {
        baselineAction = { action: 'check', amount: null };
      } else {
        baselineAction = { action: 'fold', amount: null };
      }
    }

    // Build action mix (simplified probabilities)
    const actionMix = {
      fold: quality < WEAK_HAND_THRESHOLD ? 0.6 : quality < MEDIUM_HAND_THRESHOLD ? 0.3 : 0.05,
      check: 0, // filled contextually
      call: quality >= WEAK_HAND_THRESHOLD ? 0.4 : 0.1,
      raise: quality >= STRONG_HAND_THRESHOLD ? 0.4 : quality >= MEDIUM_HAND_THRESHOLD ? 0.15 : 0.05
    };

    return {
      baselineAction: { ...baselineAction, meta: { source: 'baseline' } },
      actionMix,
      quality,
      pConfig
    };
  }

  /**
   * Step 3: LLM-based decision.
   * Calls Azure OpenAI Responses API when configured, falls back to baseline heuristic.
   *
   * Env vars: AI_LLM_BASE_URL, AI_LLM_API_KEY, AI_LLM_MODEL (default gpt-5.2)
   *
   * @param {object} input - normalized game input
   * @param {object} baseline - baseline strategy result
   * @param {object} personality - AI personality object (optional)
   * @returns {Promise<{ action: string, amount: number|null, meta: object }>}
   */
  async decideWithLLM(input, baseline, personality = null) {
    const baseUrl = `${aiConfig.endpoint}/openai/v1`;
    const apiKey = aiConfig.apiKey;
    const model = aiConfig.model;
    const instructions = this._buildLLMInstructions(personality);
    const userInput = this._buildLLMInput(input, baseline);

    try {
      _llmLog('--- REQUEST ---');
      _llmLog('model:', model);
      _llmLog('temperature:', 0.7);
      _llmLog('instructions:', instructions);
      _llmLog('input:', userInput);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const url = `${baseUrl.replace(/\/+$/, '')}/responses`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          instructions,
          input: userInput
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        console.log(`[AI] LLM HTTP error ${res.status}, falling back to baseline`);
        return this._baselineFallback(input, baseline);
      }

      const data = await res.json();

      // Extract text from Responses API output
      const text = this._extractResponseText(data);
      _llmLog('--- RESPONSE ---');
      _llmLog('raw text:', text || '(empty)');

      if (!text) {
        console.log('[AI] LLM returned empty response, falling back to baseline');
        return this._baselineFallback(input, baseline);
      }

      // Parse JSON from model output
      const parsed = this._parseLLMAction(text);
      _llmLog('parsed action:', parsed ? JSON.stringify(parsed) : '(parse failed)');

      if (parsed) {
        return { action: parsed.action, amount: parsed.amount ?? null, meta: { source: 'llm' } };
      }

      console.log(`[AI] Failed to parse LLM output: ${text.slice(0, 200)}`);
      return this._baselineFallback(input, baseline);
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      console.log(`[AI] LLM call failed (${reason}), falling back to baseline`);
      return this._baselineFallback(input, baseline);
    }
  }

  /**
   * Build the system instructions for the LLM.
   * @param {object} personality - AI personality object (optional)
   */
  _buildLLMInstructions(personality = null) {
    const instructions = [
      '你是一个poker AI助手。根据当前game state和baseline recommendation，决定最佳action。',
      '',
      '【不可违反的理性原则】',
      '1. 下注大小必须与手牌强度匹配：弱牌(weak)下注不超过锅注，中等牌(medium)下注锅注的50-75%，强牌(strong/very_strong)可以做大注。',
      '2. all-in仅限以下情况：handQualityLabel为very_strong、筹码不足5个大盲注、或跟注金额已超过筹码的80%。',
      '3. 诈唬下注不超过锅注大小。',
      '4. 优先参考raiseSuggestions中的建议值（halfPot、pot）来确定加注金额，不要随意选择极端值。',
      '',
      '【输出格式】',
      '请仅回复JSON对象：{"action": "fold|check|call|raise", "amount": <number or null>}。',
      '对于raise，amount是"raise to"的total。对于fold/check/call，amount应为null。',
      '不要包含任何其他text。'
    ];

    if (personality) {
      instructions.push('');
      instructions.push(`【风格偏好（在理性原则范围内调整）】`);
      instructions.push(`你的游戏风格是：${personality.name}。${personality.instruction}`);
    }

    return instructions.join('\n');
  }

  /**
   * Build the user input message for the LLM.
   * Exposes named raise suggestions instead of raw min/max to avoid anchoring on all-in.
   */
  _buildLLMInput(input, baseline) {
    // Build action name list (no min/max details)
    const actionNames = [];
    for (const a of input.availableActions) {
      if (typeof a === 'string') actionNames.push(a);
      else if (a.action && a.action !== 'allin') actionNames.push(a.action);
    }

    // Build raise suggestions with named anchors
    let raiseSuggestions = null;
    const raiseInfo = input.availableActions.find(a => a.action === 'raise');
    if (raiseInfo) {
      const halfPot = Math.max(raiseInfo.min, Math.round(input.currentBet + input.potSize * 0.5));
      const pot = Math.max(raiseInfo.min, Math.round(input.currentBet + input.potSize));
      const twoPot = Math.max(raiseInfo.min, Math.round(input.currentBet + input.potSize * 2));
      raiseSuggestions = {
        min: raiseInfo.min,
        halfPot: Math.min(halfPot, raiseInfo.max),
        pot: Math.min(pot, raiseInfo.max),
        twoPot: Math.min(twoPot, raiseInfo.max),
        allInAmount: raiseInfo.max
      };
    }

    // Map quality to label
    const q = baseline.quality;
    let handQualityLabel;
    if (q >= VERY_STRONG_HAND_THRESHOLD) handQualityLabel = 'very_strong';
    else if (q >= STRONG_HAND_THRESHOLD) handQualityLabel = 'strong';
    else if (q >= MEDIUM_HAND_THRESHOLD) handQualityLabel = 'medium';
    else if (q >= WEAK_HAND_THRESHOLD) handQualityLabel = 'marginal';
    else handQualityLabel = 'weak';

    const state = {
      street: input.street,
      publicCards: input.publicCards,
      holeCards: input.holeCards,
      potSize: input.potSize,
      currentBet: input.currentBet,
      playerBet: input.playerBet,
      playerChips: input.playerChips,
      callAmount: input.callAmount,
      playersInHand: input.playersInHand,
      position: input.position,
      bigBlind: input.bigBlind,
      availableActions: actionNames,
      raiseSuggestions,
      handQualityLabel,
      baselineRecommendation: baseline.baselineAction
    };
    return JSON.stringify(state);
  }

  /**
   * Extract text content from Azure OpenAI Responses API output.
   */
  _extractResponseText(data) {
    // Responses API: data.output is an array of output items
    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) return part.text;
          }
        }
      }
    }
    // Fallback: direct text field
    if (data.output_text) return data.output_text;
    return null;
  }

  /**
   * Parse a JSON {action, amount} from LLM text output.
   */
  _parseLLMAction(text) {
    // Try to extract JSON from the text (may have markdown fences or extra text)
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    try {
      const obj = JSON.parse(jsonMatch[0]);
      const validActions = ['fold', 'check', 'call', 'raise', 'allin'];
      if (obj.action && validActions.includes(obj.action)) {
        return {
          action: obj.action,
          amount: typeof obj.amount === 'number' ? obj.amount : null
        };
      }
    } catch {
      // JSON parse failed
    }
    return null;
  }

  /**
   * Baseline fallback with personality-aware randomization.
   */
  _baselineFallback(input, baseline) {
    const { baselineAction, quality, pConfig } = baseline;
    const bluffProb = pConfig ? pConfig.bluffProb : DEFAULT_PERSONALITY_CONFIG.bluffProb;
    const rand = Math.random();

    // Occasionally bluff with weak hands (personality-driven probability)
    if (quality < WEAK_HAND_THRESHOLD && rand < bluffProb && input.callAmount === 0) {
      const raiseInfo = input.availableActions.find(a => a.action === 'raise');
      if (raiseInfo) {
        return { action: 'raise', amount: raiseInfo.min, meta: { source: 'baseline', bluff: true } };
      }
    }

    // Occasionally slow-play strong hands (fixed low probability)
    if (quality >= VERY_STRONG_HAND_THRESHOLD && rand < 0.12) {
      if (input.callAmount === 0) {
        return { action: 'check', amount: null, meta: { source: 'baseline', slowplay: true } };
      }
      return { action: 'call', amount: null, meta: { source: 'baseline', slowplay: true } };
    }

    return { ...baselineAction };
  }

  /**
   * Step 4: Validate that the decided action is legal.
   * @returns {boolean}
   */
  validateAction(decision, input) {
    if (!decision || !decision.action) return false;

    const { action, amount } = decision;
    const { availableActions, currentBet, playerBet, playerChips } = input;

    const validActions = ['fold', 'check', 'call', 'raise', 'allin'];
    if (!validActions.includes(action)) return false;

    // Fold is always legal
    if (action === 'fold') return true;

    // Check requires no bet to match
    if (action === 'check') {
      return availableActions.includes('check') || currentBet <= playerBet;
    }

    // Call requires bet to match
    if (action === 'call') {
      const callInfo = availableActions.find(a => a.action === 'call');
      return !!callInfo || (currentBet > playerBet && playerChips > 0);
    }

    // Raise requires valid amount within range
    if (action === 'raise') {
      const raiseInfo = availableActions.find(a => a.action === 'raise');
      if (!raiseInfo || amount == null) return false;
      return amount >= raiseInfo.min && amount <= raiseInfo.max;
    }

    // All-in requires chips
    if (action === 'allin') {
      return playerChips > 0;
    }

    return false;
  }

  // --- Helper methods ---

  /**
   * Rough pre-flop hand strength estimator (0-1).
   */
  _estimatePreflopStrength(hand) {
    if (hand.length !== 2) return 0.3;

    const r1 = hand[0].value; // 2-14 (2=2, ..., A=14)
    const r2 = hand[1].value;
    const suited = hand[0].suit === hand[1].suit;
    const paired = r1 === r2;

    let score = 0;

    if (paired) {
      // Pairs: AA=1.0, KK=0.95, ..., 22=0.5
      score = 0.5 + (r1 - 2) * 0.042;
    } else {
      const high = Math.max(r1, r2);
      const low = Math.min(r1, r2);
      const gap = high - low;

      score = (high + low) / 28; // base score from card ranks
      if (suited) score += 0.06;
      if (gap <= 2) score += 0.04; // connected
      if (gap >= 5) score -= 0.05;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Convert HandEvaluator result to 0-1 quality scale.
   */
  _handRankToQuality(evalResult) {
    // Hand ranks from HandEvaluator (higher score = better)
    // score[0] is the hand rank: 1=high card ... 9=straight flush
    const rank = evalResult.score[0];
    const rankMap = {
      1: 0.15, // high card
      2: 0.35, // pair
      3: 0.55, // two pair
      4: 0.65, // three of a kind
      5: 0.75, // straight
      6: 0.78, // flush
      7: 0.85, // full house
      8: 0.92, // four of a kind
      9: 0.98  // straight flush
    };
    return rankMap[rank] || 0.2;
  }

  /**
   * Determine position label for the AI player.
   */
  _getPosition(game, playerIdx) {
    const inHand = game.getPlayersInHand();
    const n = inHand.length;
    if (n <= 1) return 'unknown';

    const dealerSeat = game.players[game.dealerIndex]?.seat;
    const playerSeat = game.players[playerIdx]?.seat;

    // Simple position: early / middle / late / blinds
    const seats = inHand.map(p => p.seat).sort((a, b) => a - b);
    const dealerPos = seats.indexOf(dealerSeat);
    const playerPos = seats.indexOf(playerSeat);

    // Relative position from dealer
    const relPos = ((playerPos - dealerPos) + n) % n;

    if (relPos === 0) return 'dealer';
    if (relPos === 1) return n === 2 ? 'bb' : 'sb';
    if (relPos === 2 && n > 2) return 'bb';
    if (relPos <= Math.floor(n / 3) + 2) return 'early';
    if (relPos <= Math.floor(2 * n / 3) + 1) return 'middle';
    return 'late';
  }
}

module.exports = { AIDecisionEngine, AI_NAMES, AI_PERSONALITIES, getRandomPersonality };

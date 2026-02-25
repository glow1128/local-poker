/**
 * GTO Analyzer — LLM-powered hand review with GTO strategy analysis.
 *
 * Reuses aiConfig for endpoint/model/apiKey and the same fetch+response
 * extraction pattern as AIDecisionEngine.
 */

const aiConfig = require('./aiConfig');

const LLM_LOG = process.env.AI_LLM_LOG === '1';
const LLM_LOG_PREFIX = '[GTO]';

function _log(...args) {
  if (LLM_LOG) console.log(LLM_LOG_PREFIX, ...args);
}

const SYSTEM_PROMPT = `你是一位专业的德州扑克GTO（博弈论最优策略）分析师。你将收到一手完整的牌局记录，需要分析每个玩家在每个阶段的每个行动是否符合GTO策略。

分析维度：
1. 位置（庄位、小盲、大盲、前位、中位、后位）
2. 手牌强度与公共牌的配合
3. 底池赔率和筹码底池比（SPR）
4. 在手玩家数量
5. 前序行动提供的信息

评分标准：
- "good"：符合或接近GTO策略
- "questionable"：有一定偏差但不严重
- "bad"：明显偏离GTO策略

【输出格式】仅输出一个JSON对象：
{
  "actions": [
    {
      "stage": "PRE_FLOP|FLOP|TURN|RIVER",
      "index": 0,
      "rating": "good|questionable|bad",
      "explanation": "简短中文解释（不超过30字）",
      "suggestion": "GTO建议的替代行动（仅rating非good时提供），否则null"
    }
  ],
  "summary": "整手牌的总结性分析（2-3句中文）"
}

actions数组必须与输入中的行动按stage+index一一对应。`;

/**
 * Extract text content from Azure OpenAI Responses API output.
 * Same logic as AIDecisionEngine._extractResponseText.
 */
function extractResponseText(data) {
  if (data.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text' && part.text) return part.text;
        }
      }
    }
  }
  if (data.output_text) return data.output_text;
  return null;
}

/**
 * Parse the LLM analysis response.
 * Extracts the outermost JSON object and validates structure.
 * @returns {{ actions: Array, summary: string } | null}
 */
function parseAnalysisResponse(text) {
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const obj = JSON.parse(text.slice(start, end + 1));

    if (!Array.isArray(obj.actions)) return null;

    const validRatings = new Set(['good', 'questionable', 'bad']);
    const actions = obj.actions.map(a => ({
      stage: a.stage || '',
      index: typeof a.index === 'number' ? a.index : 0,
      rating: validRatings.has(a.rating) ? a.rating : 'questionable',
      explanation: typeof a.explanation === 'string' ? a.explanation : '',
      suggestion: typeof a.suggestion === 'string' ? a.suggestion : null
    }));

    return {
      actions,
      summary: typeof obj.summary === 'string' ? obj.summary : ''
    };
  } catch {
    return null;
  }
}

/**
 * Analyze a completed hand using LLM + GTO strategy.
 * @param {object} handHistory — serialized hand data from the client
 * @returns {Promise<{ actions: Array, summary: string } | null>}
 */
async function analyzeHand(handHistory) {
  if (!aiConfig.endpoint || !aiConfig.apiKey) {
    console.log('[GTO] AI not configured, skipping analysis');
    return null;
  }

  const url = `${aiConfig.endpoint.replace(/\/+$/, '')}/openai/v1/responses`;
  const input = JSON.stringify(handHistory);

  _log('--- REQUEST ---');
  _log('url:', url);
  _log('input:', input.slice(0, 500));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: aiConfig.model,
        temperature: 0.3,
        instructions: SYSTEM_PROMPT,
        input
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[GTO] LLM HTTP error ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = extractResponseText(data);

    _log('--- RESPONSE ---');
    _log('raw:', text ? text.slice(0, 500) : '(empty)');

    const analysis = parseAnalysisResponse(text);

    _log('parsed:', analysis ? `${analysis.actions.length} actions` : '(parse failed)');

    return analysis;
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    console.log(`[GTO] LLM call failed (${reason})`);
    return null;
  }
}

module.exports = { analyzeHand };

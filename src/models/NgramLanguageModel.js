/**
 * NgramLanguageModel.js
 *
 * Ngram language model for predictive text interfaces.
 * Wraps an ngram index to provide continuation probabilities.
 * Works with any token unit (words, characters, etc.) depending
 * on the tokenizer used when building the ngram index.
 *
 * Implements the standard language model interface:
 *   - createContext() → context
 *   - cloneContext(ctx) → context
 *   - enterToken(ctx, token)
 *   - getContinuations(ctx) → [{token, prob, color?}]
 */

import {
  getForwardContinuations,
  getUnigramSuggestions,
  getVocabularyByPrefix,
} from "./localNgrams.js";

/**
 * Context for ngram language model.
 * Tracks the sequence of tokens entered so far.
 */
export class NgramContext {
  constructor(tokens = []) {
    this.tokens = tokens;
  }

  clone() {
    return new NgramContext([...this.tokens]);
  }
}

/**
 * Ngram Language Model
 */
export class NgramLanguageModel {
  /**
   * @param {Object} ngramIndex - Index from buildNgramIndex()
   * @param {Object} options - Configuration options
   * @param {number} options.maxContextSize - Max tokens to consider for context
   * @param {number} options.temperature - Probability redistribution (default 1.0)
   */
  constructor(ngramIndex, options = {}) {
    this.index = ngramIndex;
    this.maxContextSize = options.maxContextSize ?? 2;
    this.temperature = options.temperature ?? 1.0;
    this._cachedUnigrams = null;
  }

  /**
   * Set temperature for probability redistribution.
   * T=1.0 is identity. T>1 flattens. T<1 sharpens.
   */
  setTemperature(t) {
    this.temperature = t;
  }

  createContext() {
    return new NgramContext();
  }

  cloneContext(ctx) {
    return ctx.clone();
  }

  enterToken(ctx, token) {
    ctx.tokens.push(token);
    if (ctx.tokens.length > this.maxContextSize * 2) {
      ctx.tokens = ctx.tokens.slice(-this.maxContextSize * 2);
    }
  }

  /**
   * Get continuations with probabilities.
   * Uses backoff: context-based ngram predictions are primary,
   * with unigram fallback for sparse contexts.
   *
   * @param {NgramContext} ctx - Current context
   * @returns {Array<{token: string, prob: number, color: number}>}
   */
  getContinuations(ctx) {
    if (!this.index) return [];

    const items = new Map();

    const UNIGRAM_WEIGHT = 0.1;
    const BACKOFF_THRESHOLD = 20;

    if (ctx.tokens.length > 0) {
      const continuations = getForwardContinuations(
        this.index,
        ctx.tokens.slice(-this.maxContextSize),
        1000
      );
      for (const { token, score } of continuations) {
        items.set(token, {
          token,
          prob: score,
          color: this._getColorCategory(token),
        });
      }
    }

    if (items.size < BACKOFF_THRESHOLD) {
      if (!this._cachedUnigrams) {
        this._cachedUnigrams = getUnigramSuggestions(this.index, 100);
      }

      for (const { token, score } of this._cachedUnigrams) {
        if (!items.has(token)) {
          items.set(token, {
            token,
            prob: score * UNIGRAM_WEIGHT,
            color: this._getColorCategory(token),
          });
        }
      }
    }

    let result = Array.from(items.values());

    if (this.temperature !== 1.0 && this.temperature > 0) {
      const invT = 1 / this.temperature;
      for (const item of result) {
        item.prob = Math.pow(item.prob, invT);
      }
    }

    const totalProb = result.reduce((sum, item) => sum + item.prob, 0);
    if (totalProb > 0) {
      for (const item of result) {
        item.prob = item.prob / totalProb;
      }
    }

    result.sort((a, b) => b.prob - a.prob);

    return result;
  }

  /**
   * Get completions matching a prefix.
   */
  getContinuationsByPrefix(ctx, prefix, limit = 100) {
    if (!this.index || !prefix) return this.getContinuations(ctx);

    const prefixMatches = getVocabularyByPrefix(this.index, prefix, limit);

    return prefixMatches.map(({ token, score }) => ({
      token,
      prob: score,
      color: this._getColorCategory(token),
    }));
  }

  _getColorCategory(token) {
    if (!token || token.length === 0) return 0;

    const firstChar = token.charAt(0).toLowerCase();
    const charCode = firstChar.charCodeAt(0);

    if (charCode >= 97 && charCode <= 122) {
      return Math.floor((charCode - 97) / 5) + 1;
    }

    return 1;
  }
}

export default NgramLanguageModel;

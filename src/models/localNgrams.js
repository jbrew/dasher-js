/**
 * localNgrams.js - In-memory ngram index for continuation predictions
 *
 * Builds and queries a transition matrix from plain text.
 */

/**
 * Normalize a token: lowercase and strip leading/trailing punctuation
 */
export function normalizeToken(word) {
  return word
    .toLowerCase()
    .replace(/^[^\w]+/, "")
    .replace(/[^\w]+$/, "");
}

/**
 * Tokenizers for different granularities
 */
export const tokenizers = {
  word: (text) =>
    text
      .split(/\s+/)
      .map(normalizeToken)
      .filter((w) => w.length > 0),

  character: (text) =>
    text
      .toLowerCase()
      .split("")
      .filter((c) => /[a-z ]/.test(c)),
};

/**
 * Build an ngram index from plain text
 * @param {string} text - Source text to index
 * @param {number} maxContextSize - Maximum context window (default 2 for bigrams)
 * @param {Object} options - Optional configuration
 * @param {Function} options.tokenize - Tokenizer function (default: word tokenizer)
 * @returns {Object} Ngram index with forward/backward maps
 */
export function buildNgramIndex(text, maxContextSize = 2, options = {}) {
  const forward = new Map();
  const backward = new Map();
  const vocabulary = new Map();

  const tokenize = options.tokenize || tokenizers.word;
  const tokens = tokenize(text);

  for (const token of tokens) {
    vocabulary.set(token, (vocabulary.get(token) || 0) + 1);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    for (let contextSize = 1; contextSize <= maxContextSize; contextSize++) {
      if (i >= contextSize) {
        const contextSlice = tokens.slice(i - contextSize, i);
        const contextKey = contextSlice.join(" ");

        if (!forward.has(contextKey)) forward.set(contextKey, new Map());
        const transitions = forward.get(contextKey);
        transitions.set(token, (transitions.get(token) || 0) + 1);
      }
    }

    for (let contextSize = 1; contextSize <= maxContextSize; contextSize++) {
      if (i + contextSize < tokens.length) {
        const contextSlice = tokens.slice(i + 1, i + 1 + contextSize);
        const contextKey = contextSlice.join(" ");

        if (!backward.has(contextKey)) backward.set(contextKey, new Map());
        const transitions = backward.get(contextKey);
        transitions.set(token, (transitions.get(token) || 0) + 1);
      }
    }
  }

  return {
    forward,
    backward,
    vocabulary,
    tokenCount: tokens.length,
    uniqueTokens: vocabulary.size,
    maxContextSize,
  };
}

function mergeContextResults(contextResults, limit) {
  if (contextResults.length === 0) return [];

  const tokenScores = new Map();

  for (const { contextSize, transitions } of contextResults) {
    const total = Array.from(transitions.values()).reduce((a, b) => a + b, 0);
    const weight = Math.pow(10, contextSize - 1);

    for (const [token, count] of transitions) {
      const normalizedScore = (count / total) * weight;
      tokenScores.set(token, (tokenScores.get(token) || 0) + normalizedScore);
    }
  }

  const maxScore = Math.max(...tokenScores.values());

  return Array.from(tokenScores.entries())
    .map(([token, score]) => ({ token, score: score / maxScore }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Get forward continuations (what comes after this context)
 */
export function getForwardContinuations(index, contextTokens, limit = 30) {
  if (!index || contextTokens.length === 0) return [];

  const contextResults = [];

  for (
    let size = Math.min(contextTokens.length, index.maxContextSize);
    size >= 1;
    size--
  ) {
    const contextKey = contextTokens
      .slice(-size)
      .join(" ")
      .toLowerCase();
    const transitions = index.forward.get(contextKey);

    if (transitions && transitions.size > 0) {
      contextResults.push({ contextSize: size, transitions });
    }
  }

  return mergeContextResults(contextResults, limit);
}

/**
 * Get unigram suggestions from vocabulary, sorted by frequency.
 */
export function getUnigramSuggestions(index, limit = 30, exclude = null) {
  if (!index || !index.vocabulary || index.vocabulary.size === 0) return [];

  const entries = Array.from(index.vocabulary.entries());
  const totalCount = entries.reduce((sum, [, count]) => sum + count, 0);

  return entries
    .filter(([token]) => !exclude || !exclude.has(token))
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .slice(0, limit)
    .map(({ token, count }) => ({
      token,
      score: count / totalCount,
    }));
}

/**
 * Get vocabulary words matching a prefix, sorted by frequency.
 */
export function getVocabularyByPrefix(index, prefix, limit = 100) {
  if (!index || !index.vocabulary || index.vocabulary.size === 0) return [];
  if (!prefix) return getUnigramSuggestions(index, limit);

  const lowerPrefix = prefix.toLowerCase();
  const entries = Array.from(index.vocabulary.entries());
  const totalCount = entries.reduce((sum, [, count]) => sum + count, 0);

  return entries
    .filter(([token]) => token.toLowerCase().startsWith(lowerPrefix))
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .slice(0, limit)
    .map(({ token, count }) => ({
      token,
      score: count / totalCount,
    }));
}

/**
 * PPMLanguageModel.js
 *
 * JavaScript port of Dasher's PPM (Prediction by Partial Matching) language model.
 * Based on PPMLanguageModel.cpp from the original Dasher project.
 *
 * Copyright (c) 1999-2005 David Ward (original C++ implementation)
 * JavaScript port for the Dasher text entry interface.
 */

const DEFAULT_MAX_ORDER = 5;
const DEFAULT_ALPHA = 100;
const DEFAULT_BETA = 100;

/**
 * PPM trie node - stores symbol counts and child pointers.
 */
class PPMNode {
  constructor(symbol = -1) {
    this.sym = symbol;
    this.count = 1;
    this.vine = null;
    this.children = new Map();
  }

  findChild(symbol) {
    return this.children.get(symbol) || null;
  }

  addChild(node) {
    this.children.set(node.sym, node);
  }

  *childIterator() {
    for (const child of this.children.values()) {
      yield child;
    }
  }
}

/**
 * PPM Context - represents current position in the trie
 */
class PPMContext {
  constructor(head = null, order = 0) {
    this.head = head;
    this.order = order;
  }

  clone() {
    return new PPMContext(this.head, this.order);
  }
}

/**
 * PPM Language Model
 *
 * Implements the algorithm from Dasher's PPMLanguageModel.cpp.
 *
 * Conforms to the standard language model interface:
 *   - createContext() → context
 *   - cloneContext(ctx) → context
 *   - enterToken(ctx, token)
 *   - getContinuations(ctx) → [{token, prob, color?}]
 */
export class PPMLanguageModel {
  /**
   * @param {number} numSymbols - Size of alphabet
   * @param {number} maxOrder - Maximum context length (default: 5)
   * @param {number} alpha - Smoothing parameter for escape probability (default: 100)
   * @param {number} beta - Smoothing parameter for count adjustment (default: 100)
   * @param {boolean} updateExclusion - Whether to use update exclusion (default: false)
   */
  constructor(numSymbols, maxOrder = DEFAULT_MAX_ORDER, alpha = DEFAULT_ALPHA, beta = DEFAULT_BETA, updateExclusion = false) {
    this.numSymbols = numSymbols;
    this.maxOrder = maxOrder;
    this.alpha = alpha;
    this.beta = beta;
    this.updateExclusion = updateExclusion;

    this.root = new PPMNode(-1);
    this.root.count = 0;

    this.rootContext = new PPMContext(this.root, 0);
    this.contexts = new Set();
  }

  createContext() {
    const ctx = this.rootContext.clone();
    this.contexts.add(ctx);
    return ctx;
  }

  cloneContext(ctx) {
    const newCtx = ctx.clone();
    this.contexts.add(newCtx);
    return newCtx;
  }

  releaseContext(ctx) {
    this.contexts.delete(ctx);
  }

  /**
   * Enter a symbol into the context WITHOUT learning.
   */
  enterSymbol(ctx, symbol) {
    if (symbol <= 0) return;

    while (ctx.head) {
      if (ctx.order < this.maxOrder) {
        const child = ctx.head.findChild(symbol);
        if (child) {
          ctx.order++;
          ctx.head = child;
          return;
        }
      }

      ctx.order--;
      ctx.head = ctx.head.vine;
    }

    if (ctx.head === null) {
      ctx.head = this.root;
      ctx.order = 0;
    }
  }

  /**
   * Learn a symbol in the given context.
   */
  learnSymbol(ctx, symbol) {
    if (symbol <= 0) return;

    const node = this._addSymbolToNode(ctx.head, symbol);
    ctx.head = node;
    ctx.order++;

    while (ctx.order > this.maxOrder) {
      ctx.head = ctx.head.vine;
      ctx.order--;
    }
  }

  _addSymbolToNode(node, symbol) {
    let child = node.findChild(symbol);

    if (child !== null) {
      child.count++;

      if (!this.updateExclusion) {
        for (let v = child.vine; v; v = v.vine) {
          v.count++;
        }
      }
    } else {
      child = new PPMNode(symbol);
      node.addChild(child);

      child.vine = (node === this.root)
        ? this.root
        : this._addSymbolToNode(node.vine, symbol);
    }

    return child;
  }

  /**
   * Get probability distribution for all symbols given current context.
   */
  getProbs(ctx, norm = 65536, uniform = 1000) {
    const probs = new Array(this.numSymbols + 1).fill(0);
    const exclusions = new Array(this.numSymbols + 1).fill(false);

    let iToSpend = norm;
    let iUniformLeft = uniform;

    probs[0] = 0;
    exclusions[0] = false;

    for (let i = 1; i <= this.numSymbols; i++) {
      probs[i] = Math.floor(iUniformLeft / (this.numSymbols - i + 1));
      iUniformLeft -= probs[i];
      iToSpend -= probs[i];
    }

    const doExclusion = false;

    for (let pTemp = ctx.head; pTemp; pTemp = pTemp.vine) {
      let iTotal = 0;

      for (const child of pTemp.childIterator()) {
        if (!(exclusions[child.sym] && doExclusion)) {
          iTotal += child.count;
        }
      }

      if (iTotal > 0) {
        const sizeOfSlice = iToSpend;

        for (const child of pTemp.childIterator()) {
          if (!(exclusions[child.sym] && doExclusion)) {
            exclusions[child.sym] = true;

            const p = Math.floor(
              sizeOfSlice * (100 * child.count - this.beta) / (100 * iTotal + this.alpha)
            );

            probs[child.sym] += p;
            iToSpend -= p;
          }
        }
      }
    }

    const sizeOfSlice = iToSpend;
    let symbolsLeft = 0;

    for (let i = 1; i <= this.numSymbols; i++) {
      if (!(exclusions[i] && doExclusion)) {
        symbolsLeft++;
      }
    }

    for (let i = 1; i <= this.numSymbols; i++) {
      if (!(exclusions[i] && doExclusion)) {
        const p = Math.floor(sizeOfSlice / symbolsLeft);
        probs[i] += p;
        iToSpend -= p;
        symbolsLeft--;
      }
    }

    let iLeft = this.numSymbols;
    for (let i = 1; i <= this.numSymbols; i++) {
      const p = Math.floor(iToSpend / iLeft);
      probs[i] += p;
      iLeft--;
      iToSpend -= p;
    }

    return probs;
  }

  /**
   * Train the model on a string of text.
   */
  train(text) {
    const ctx = this.createContext();
    for (const char of text) {
      const symbol = this.charToSymbol(char);
      if (symbol > 0) {
        this.learnSymbol(ctx, symbol);
      }
    }
    this.releaseContext(ctx);
  }

  charToSymbol(char) {
    const code = char.charCodeAt(0);
    if (code >= 32 && code < 127) {
      return code - 31;
    }
    return 0;
  }

  symbolToChar(symbol) {
    if (symbol > 0 && symbol <= 95) {
      return String.fromCharCode(symbol + 31);
    }
    return '';
  }

  // ========================================
  // Standard Language Model Interface
  // ========================================

  enterToken(ctx, token) {
    const symbol = this.charToSymbol(token);
    if (symbol > 0) {
      this.enterSymbol(ctx, symbol);
    }
  }

  getContinuations(ctx) {
    const NORM = 65536;
    const probs = this.getProbs(ctx, NORM);

    const continuations = [];

    for (let sym = 1; sym <= this.numSymbols; sym++) {
      const prob = probs[sym];
      if (prob > 0) {
        const token = this.symbolToChar(sym);
        if (token) {
          continuations.push({
            token,
            prob: prob / NORM,
            color: this._getColorForChar(token),
          });
        }
      }
    }

    continuations.sort((a, b) => {
      if (a.token === ' ') return -1;
      if (b.token === ' ') return 1;
      return a.token.localeCompare(b.token);
    });

    return continuations;
  }

  _getColorForChar(char) {
    const vowels = 'aeiouAEIOU';
    if (char === ' ') return 0;
    if (vowels.includes(char)) return 1;
    return 2;
  }
}

/**
 * Alphabet definitions
 */
export const ALPHABETS = {
  LOWERCASE: ' abcdefghijklmnopqrstuvwxyz',
  LETTERS: ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ASCII: Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
};

/**
 * Create a PPM model for a specific alphabet
 */
export function createPPMModel(alphabet = ALPHABETS.LOWERCASE, options = {}) {
  const {
    maxOrder = DEFAULT_MAX_ORDER,
    alpha = DEFAULT_ALPHA,
    beta = DEFAULT_BETA
  } = options;

  const model = new PPMLanguageModel(alphabet.length, maxOrder, alpha, beta);

  model.alphabet = alphabet;

  model.charToSymbol = function(char) {
    const idx = this.alphabet.indexOf(char.toLowerCase());
    return idx >= 0 ? idx + 1 : 0;
  };

  model.symbolToChar = function(symbol) {
    if (symbol > 0 && symbol <= this.alphabet.length) {
      return this.alphabet[symbol - 1];
    }
    return '';
  };

  return model;
}

export default PPMLanguageModel;

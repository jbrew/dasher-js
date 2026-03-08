/**
 * arithmeticCodec.js
 *
 * Encode/decode token sequences as compact numbers using arithmetic coding.
 * Interface-agnostic—works with any sequential probability model.
 *
 * Uses renormalization (streaming) to support arbitrarily long sequences
 * with fixed working precision. Bits are output as they become fixed,
 * similar to how Dasher's UI "forgets" leading bits by promoting nodes to root.
 */

// Working precision: 32 bits is plenty for per-token operations
// (we renormalize after each token to prevent underflow)
const WORKING_BITS = 32n;
const WORKING_SCALE = 1n << WORKING_BITS; // 2^32
const HALF = WORKING_SCALE >> 1n; // 2^31
const QUARTER = WORKING_SCALE >> 2n; // 2^30
const THREE_QUARTERS = 3n * QUARTER; // 3 * 2^30

// Probability scaling: 10^12 gives precision while staying in safe Number range
const PROB_SCALE = 1000000000000n;

// Base64url alphabet (URL-safe)
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Encode a sequence of tokens into an arithmetic code.
 *
 * Uses renormalization to output bits incrementally, allowing arbitrarily
 * long sequences with fixed working precision.
 *
 * @param {string[]} sequence - Array of tokens (words/chars)
 * @param {object} model - Language model with:
 *   - createContext() → context
 *   - getContinuations(context) → [{token, prob}, ...]
 *   - enterToken(context, token) or enterChar(context, char)
 * @returns {string} Base64url-encoded arithmetic code with precision suffix
 *                   Format: "{code}.{precision}"
 */
export function encode(sequence, model) {
  // Working interval [low, high) in [0, WORKING_SCALE)
  let low = 0n;
  let high = WORKING_SCALE;

  // Output bits and pending count for underflow handling
  const outputBits = [];
  let pendingBits = 0;

  // Track cumulative surprisal for precision suffix
  let totalSurprisal = 0;

  let context = model.createContext();

  for (const token of sequence) {
    const continuations = model.getContinuations(context);
    const bounds = computeBounds(continuations);

    const tokenBounds = bounds.get(token);
    if (!tokenBounds) {
      throw new Error(`Token "${token}" not found in model continuations`);
    }

    // Calculate surprisal: -log2(prob)
    const tokenWidth = tokenBounds.hbnd - tokenBounds.lbnd;
    totalSurprisal += Number(WORKING_BITS) - log2BigInt(tokenWidth);

    // Narrow interval
    const range = high - low;
    const newLow = low + (range * tokenBounds.lbnd) / WORKING_SCALE;
    const newHigh = low + (range * tokenBounds.hbnd) / WORKING_SCALE;

    low = newLow;
    high = newHigh;

    // Renormalization: output bits while interval is in a decidable region
    while (true) {
      if (high <= HALF) {
        // Interval entirely in lower half [0, 0.5) - output 0
        outputBit(outputBits, 0, pendingBits);
        pendingBits = 0;
        // Scale up: [0, 0.5) → [0, 1)
        low = low << 1n;
        high = high << 1n;
      } else if (low >= HALF) {
        // Interval entirely in upper half [0.5, 1) - output 1
        outputBit(outputBits, 1, pendingBits);
        pendingBits = 0;
        // Scale up: [0.5, 1) → [0, 1)
        low = (low - HALF) << 1n;
        high = (high - HALF) << 1n;
      } else if (low >= QUARTER && high <= THREE_QUARTERS) {
        // Interval straddles middle [0.25, 0.75) - underflow case
        // Can't output a bit yet, but can still rescale
        pendingBits++;
        // Scale up: [0.25, 0.75) → [0, 1)
        low = (low - QUARTER) << 1n;
        high = (high - QUARTER) << 1n;
      } else {
        // Interval spans across the boundary - can't rescale yet
        break;
      }
    }

    if (model.enterToken) {
      model.enterToken(context, token);
    } else if (model.enterChar) {
      model.enterChar(context, token);
    }
  }

  // Flush: output enough bits to uniquely identify final interval
  // Output 2 more bits to disambiguate the final position
  pendingBits++;
  if (low < QUARTER) {
    outputBit(outputBits, 0, pendingBits);
  } else {
    outputBit(outputBits, 1, pendingBits);
  }

  // Convert bits to base64url
  const code = bitsToBase64url(outputBits);
  const precisionTenths = Math.ceil(totalSurprisal * 10);
  const precisionSuffix = precisionToBase64url(precisionTenths);

  return `${code}.${precisionSuffix}`;
}

/**
 * Output a bit plus any pending underflow bits.
 */
function outputBit(bits, bit, pendingCount) {
  bits.push(bit);
  const oppositeBit = bit === 0 ? 1 : 0;
  for (let i = 0; i < pendingCount; i++) {
    bits.push(oppositeBit);
  }
}

/**
 * Convert bit array to base64url string.
 */
function bitsToBase64url(bits) {
  if (bits.length === 0) return "A";

  // Pad to multiple of 6 for base64
  while (bits.length % 6 !== 0) {
    bits.push(0);
  }

  let result = "";
  for (let i = 0; i < bits.length; i += 6) {
    let value = 0;
    for (let j = 0; j < 6; j++) {
      value = (value << 1) | bits[i + j];
    }
    result += BASE64URL_ALPHABET[value];
  }

  // Trim trailing 'A's (zeros) but keep at least one char
  result = result.replace(/A+$/, "") || "A";

  return result;
}

/**
 * Convert base64url string to bit array.
 */
function base64urlToBits(code) {
  const bits = [];
  for (const char of code) {
    const index = BASE64URL_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base64url character: ${char}`);
    }
    // Extract 6 bits from each character
    for (let i = 5; i >= 0; i--) {
      bits.push((index >> i) & 1);
    }
  }
  return bits;
}

/**
 * Decode an arithmetic code back to a token sequence.
 *
 * Uses renormalization to consume bits incrementally, matching the encoder.
 *
 * @param {string} codeWithPrecision - Base64url-encoded arithmetic code with precision suffix
 * @param {object} model - Same model used for encoding
 * @param {number} [maxTokens=1000] - Safety limit on decoded length
 * @returns {string[]} Decoded token sequence
 */
export function decode(codeWithPrecision, model, maxTokens = 1000) {
  // Parse code and precision suffix
  const dotIndex = codeWithPrecision.lastIndexOf(".");
  if (dotIndex === -1) {
    throw new Error(
      "Invalid code format: missing precision suffix (expected 'code.precision')"
    );
  }

  const code = codeWithPrecision.slice(0, dotIndex);
  const precisionSuffix = codeWithPrecision.slice(dotIndex + 1);
  const maxSurprisal = base64urlToPrecision(precisionSuffix) / 10;

  // Convert code to bits
  const bits = base64urlToBits(code);
  let bitIndex = 0;

  // Read next bit (0 if past end of input)
  const readBit = () => (bitIndex < bits.length ? bits[bitIndex++] : 0);

  // Initialize value from first WORKING_BITS bits
  let value = 0n;
  for (let i = 0; i < Number(WORKING_BITS); i++) {
    value = (value << 1n) | BigInt(readBit());
  }

  // Working interval
  let low = 0n;
  let high = WORKING_SCALE;

  const sequence = [];
  let context = model.createContext();
  let cumulativeSurprisal = 0;

  for (let i = 0; i < maxTokens; i++) {
    // Stop if we've reached the precision threshold
    if (cumulativeSurprisal >= maxSurprisal) {
      break;
    }

    const continuations = model.getContinuations(context);
    if (continuations.length === 0) break;

    const bounds = computeBounds(continuations);
    const range = high - low;

    // Find which token's interval contains our value
    let foundToken = null;
    let tokenLow = 0n;
    let tokenHigh = 0n;
    let foundTokenWidth = 0n;

    for (const [token, tokenBounds] of bounds) {
      const tLow = low + (range * tokenBounds.lbnd) / WORKING_SCALE;
      const tHigh = low + (range * tokenBounds.hbnd) / WORKING_SCALE;

      if (value >= tLow && value < tHigh) {
        foundToken = token;
        tokenLow = tLow;
        tokenHigh = tHigh;
        foundTokenWidth = tokenBounds.hbnd - tokenBounds.lbnd;
        break;
      }
    }

    if (!foundToken) {
      // Value doesn't fall in any interval
      break;
    }

    // Check if adding this token would exceed precision
    const tokenSurprisal = Number(WORKING_BITS) - log2BigInt(foundTokenWidth);
    if (cumulativeSurprisal + tokenSurprisal > maxSurprisal) {
      break;
    }

    sequence.push(foundToken);
    cumulativeSurprisal += tokenSurprisal;

    // Narrow interval
    low = tokenLow;
    high = tokenHigh;

    // Renormalization: match encoder's bit output
    while (true) {
      if (high <= HALF) {
        // Lower half - scale up
        low = low << 1n;
        high = high << 1n;
        value = (value << 1n) | BigInt(readBit());
      } else if (low >= HALF) {
        // Upper half - scale up
        low = (low - HALF) << 1n;
        high = (high - HALF) << 1n;
        value = ((value - HALF) << 1n) | BigInt(readBit());
      } else if (low >= QUARTER && high <= THREE_QUARTERS) {
        // Middle - underflow case
        low = (low - QUARTER) << 1n;
        high = (high - QUARTER) << 1n;
        value = ((value - QUARTER) << 1n) | BigInt(readBit());
      } else {
        break;
      }
    }

    if (model.enterToken) {
      model.enterToken(context, foundToken);
    } else if (model.enterChar) {
      model.enterChar(context, foundToken);
    }
  }

  return sequence;
}

/**
 * Compute cumulative probability bounds for continuations.
 * Returns Map<token, {lbnd, hbnd}> where bounds are BigInts scaled to WORKING_SCALE.
 */
function computeBounds(continuations) {
  // Sort deterministically to ensure consistent bounds between encode/decode
  const sorted = [...continuations].sort((a, b) => {
    const aToken = a.token;
    const bToken = b.token;
    if (b.prob !== a.prob) {
      return b.prob - a.prob; // Descending by probability
    }
    return aToken.localeCompare(bToken); // Tiebreaker: alphabetical
  });

  const bounds = new Map();
  let cumulative = 0n;

  for (const item of sorted) {
    const token = item.token;
    const prob = item.prob;
    const lbnd = cumulative;
    // Convert probability to BigInt: scale to intermediate, then to working scale
    const probAsInt = BigInt(Math.round(prob * Number(PROB_SCALE)));
    const probScaled = (WORKING_SCALE * probAsInt) / PROB_SCALE;
    cumulative += probScaled;
    const hbnd = cumulative;

    bounds.set(token, { lbnd, hbnd });
  }

  // Normalize: ensure last bound reaches WORKING_SCALE
  if (bounds.size > 0 && cumulative < WORKING_SCALE) {
    const lastEntry = [...bounds.entries()].pop();
    if (lastEntry) {
      lastEntry[1].hbnd = WORKING_SCALE;
    }
  }

  return bounds;
}

/**
 * Compute log2 of a BigInt.
 */
function log2BigInt(n) {
  if (n <= 0n) return -Infinity;
  const str = n.toString(2);
  const bitLength = str.length;

  if (bitLength <= 52) {
    return Math.log2(Number(n));
  }

  const topBits = str.slice(0, 52);
  const topValue = parseInt(topBits, 2);
  return Math.log2(topValue) + (bitLength - 52);
}

/**
 * Encode precision (surprisal in tenths of bits) as compact base64url.
 */
function precisionToBase64url(tenths) {
  if (tenths < 0) tenths = 0;
  if (tenths <= 63) {
    return BASE64URL_ALPHABET[tenths];
  } else if (tenths <= 4095) {
    const high = Math.floor(tenths / 64);
    const low = tenths % 64;
    return BASE64URL_ALPHABET[high] + BASE64URL_ALPHABET[low];
  } else {
    const high = Math.floor(tenths / 4096);
    const mid = Math.floor((tenths % 4096) / 64);
    const low = tenths % 64;
    return (
      BASE64URL_ALPHABET[high] + BASE64URL_ALPHABET[mid] + BASE64URL_ALPHABET[low]
    );
  }
}

/**
 * Decode precision from base64url.
 */
function base64urlToPrecision(suffix) {
  let value = 0;
  for (const char of suffix) {
    const index = BASE64URL_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base64url character in precision: ${char}`);
    }
    value = value * 64 + index;
  }
  return value;
}

/**
 * Get information about an encoded sequence.
 */
export function getCodeInfo(codeWithPrecision) {
  const dotIndex = codeWithPrecision.lastIndexOf(".");
  const code =
    dotIndex === -1 ? codeWithPrecision : codeWithPrecision.slice(0, dotIndex);
  const precisionSuffix =
    dotIndex === -1 ? null : codeWithPrecision.slice(dotIndex + 1);

  const bits = code.length * 6; // Each base64 char = 6 bits
  const precisionTenths = precisionSuffix
    ? base64urlToPrecision(precisionSuffix)
    : null;

  return {
    code: codeWithPrecision,
    codeBits: bits,
    codeBytes: Math.ceil(bits / 8),
    codeCharacters: code.length,
    precisionBits: precisionTenths ? precisionTenths / 10 : null,
    totalCharacters: codeWithPrecision.length,
  };
}

/**
 * Create a model adapter that wraps a language model for use with the codec.
 */
export function createModelAdapter(model, options = {}) {
  const { mode = "word" } = options;

  return {
    createContext: () => model.createContext(),
    cloneContext: (ctx) => model.cloneContext(ctx),
    getContinuations: (ctx) => model.getContinuations(ctx),
    enterToken:
      mode === "word" ? (ctx, token) => model.enterToken(ctx, token) : null,
    enterChar:
      mode === "char" ? (ctx, char) => model.enterChar(ctx, char) : null,
  };
}

export default {
  encode,
  decode,
  getCodeInfo,
  createModelAdapter,
};

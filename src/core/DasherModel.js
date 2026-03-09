/**
 * DasherModel.js
 *
 * Dasher model implementing the coordinate system, zoom dynamics,
 * and node tree management. Based on the original C++ implementation
 * by David MacKay et al.
 *
 * Works with any token type (characters, words, BPE tokens, etc.)
 * as long as the language model implements the standard interface:
 *   - createContext() → context
 *   - cloneContext(ctx) → context
 *   - enterToken(ctx, token)
 *   - getContinuations(ctx) → [{token, prob, color?}]
 *
 * Key concepts:
 * - Dasher space: A coordinate system where Y ranges from 0 to MAX_Y (4096)
 * - The crosshair is at fixed position (ORIGIN_X=2048, ORIGIN_Y=2048)
 * - Nodes have normalized bounds [lbnd, hbnd] in range [0, NORMALIZATION]
 * - rootmin/rootmax define where the root node sits in Dasher Y-space
 * - Zooming changes rootmin/rootmax, which moves all nodes on screen
 * - Each node stores a context representing the token path to that node
 */

// Core constants from DasherModel.h
export const NORMALIZATION = 1 << 16;  // 65536 - probability space for child bounds
export const ORIGIN_X = 2048;          // Crosshair X position in Dasher space
export const ORIGIN_Y = 2048;          // Crosshair Y position (center of MAX_Y)
export const MAX_Y = 4096;             // Full Y range in Dasher space

/**
 * A node in the Dasher tree.
 * Each node represents a token with probability-based bounds.
 */
export class DasherNode {
  constructor(token, lbnd, hbnd, parent = null) {
    this.token = token;         // The token this node represents (char, word, etc.)
    this.lbnd = lbnd;           // Lower bound in parent's space [0, NORMALIZATION]
    this.hbnd = hbnd;           // Upper bound in parent's space [0, NORMALIZATION]
    this.parent = parent;       // Parent node (null for root)
    this.children = null;       // Array of child nodes (null = not expanded)
    this.color = null;          // Rendering color (assigned during creation)
    this.context = null;        // Language model context at this node
  }

  /**
   * Probability of this node (proportion of parent's space)
   */
  get probability() {
    return (this.hbnd - this.lbnd) / NORMALIZATION;
  }
}

/**
 * The Dasher Model - manages the coordinate system and node tree.
 */
export class DasherModel {
  /**
   * @param {Object} options - Configuration options
   * @param {Object} options.languageModel - Language model for predictions
   * @param {number} options.topK - Max tokens per expansion (null = show all)
   */
  constructor(options = {}) {
    this.languageModel = options.languageModel || null;
    this.topK = options.topK ?? null;  // null means show all
    this.sortAlphabetical = options.sortAlphabetical ?? false;

    // Root node bounds in Dasher Y-space
    // Initially centered with the root filling most of the view
    this.rootmin = 0;
    this.rootmax = MAX_Y;

    // The root node of the tree
    this.root = null;

    // Stack of old roots for backing up (cache for performance)
    this.oldRoots = [];

    // Token path from original root to current root (for RebuildParent)
    // This enables infinite undo - we can always reconstruct ancestors
    this.rootTokenPath = [];

    // Currently output tokens (array)
    this.outputTokens = [];

    // Output items with metadata (for rich output rendering)
    this.outputItems = []; // [{token, ...}]

    // Track the last node that was under the crosshair
    // This is used to detect when we enter/exit nodes for output
    this.lastNodeUnderCrosshair = null;

    // Callback for text changes
    this.onTextChange = null;

    // Callback for output items changes
    this.onOutputItemsChange = null;
  }

  /**
   * Set the language model (can be called after construction)
   */
  setLanguageModel(model) {
    this.languageModel = model;
  }

  /**
   * Set topK (can be called after construction)
   */
  setTopK(topK) {
    this.topK = topK;
  }

  /**
   * Initialize with a fresh root node
   */
  init() {
    // Create root node spanning full probability space
    this.root = new DasherNode('', 0, NORMALIZATION, null);
    this.root.color = 0;

    // Create root context for language model
    if (this.languageModel) {
      this.root.context = this.languageModel.createContext();
    }

    // Expand the root to show initial choices
    this.expandNode(this.root);

    // Set initial viewport - root slightly larger than screen
    // so we're "inside" it but not at any child yet
    const width = MAX_Y * 1.2;
    this.rootmin = ORIGIN_Y - width / 2;
    this.rootmax = ORIGIN_Y + width / 2;

    this.outputTokens = [];
    this.outputItems = [];
    this.rootTokenPath = [];
    this.lastNodeUnderCrosshair = null;
  }

  /**
   * Expand a node by creating its children based on language model probabilities.
   * Uses the language model interface: getContinuations(ctx) → [{token, prob, ...}]
   */
  expandNode(node) {
    if (node.children) return; // Already expanded

    node.children = [];

    if (!this.languageModel) {
      // Fallback: uniform distribution over lowercase alphabet + space
      const alphabet = ' abcdefghijklmnopqrstuvwxyz';
      const prob = 1 / alphabet.length;
      let cumulative = 0;

      for (const token of alphabet) {
        const lbnd = Math.round(cumulative * NORMALIZATION);
        cumulative += prob;
        const hbnd = Math.round(cumulative * NORMALIZATION);

        const child = new DasherNode(token, lbnd, hbnd, node);
        child.color = this.getColorForToken(token);
        node.children.push(child);
      }
      return;
    }

    // Get continuations from language model
    const ctx = node.context || this.languageModel.createContext();
    let continuations = this.languageModel.getContinuations(ctx);

    if (!continuations || continuations.length === 0) {
      // No continuations - show placeholder
      const child = new DasherNode("...", 0, NORMALIZATION, node);
      child.color = 0;
      node.children.push(child);
      return;
    }

    // Apply topK if set
    if (this.topK !== null && continuations.length > this.topK) {
      // Sort by probability descending and take top K
      continuations = [...continuations]
        .sort((a, b) => b.prob - a.prob)
        .slice(0, this.topK);

      // Renormalize probabilities
      const totalProb = continuations.reduce((sum, c) => sum + c.prob, 0);
      if (totalProb > 0) {
        for (const c of continuations) {
          c.prob = c.prob / totalProb;
        }
      }
    }

    // Sort alphabetically if requested (character mode)
    if (this.sortAlphabetical) {
      continuations.sort((a, b) => {
        if (a.token === ' ') return -1;
        if (b.token === ' ') return 1;
        return a.token.localeCompare(b.token);
      });
    }

    // Create children with bounds from probabilities
    let cumulative = 0;

    for (const item of continuations) {
      const lbnd = Math.round(cumulative * NORMALIZATION);
      cumulative += item.prob;
      const hbnd = Math.round(cumulative * NORMALIZATION);

      if (hbnd > lbnd) {
        const child = new DasherNode(item.token, lbnd, hbnd, node);

        // Use color from model if provided, otherwise compute
        child.color = item.color ?? this.getColorForToken(item.token);

        // Create a cloned context for this child with the token entered
        child.context = this.languageModel.cloneContext(ctx);
        this.languageModel.enterToken(child.context, item.token);

        node.children.push(child);
      }
    }

    // Handle any rounding gap to reach NORMALIZATION
    if (node.children.length > 0) {
      node.children[node.children.length - 1].hbnd = NORMALIZATION;
    }
  }

  /**
   * Get the text path from root to a given node
   */
  getPathToNode(node) {
    const tokens = [];
    let current = node;
    while (current && current.parent) {
      if (current.token) {
        tokens.unshift(current.token);
      }
      current = current.parent;
    }
    return this.tokensToText(tokens);
  }

  /**
   * Convert array of tokens to display text.
   * Default implementation joins with appropriate spacing.
   */
  tokensToText(tokens) {
    if (tokens.length === 0) return '';

    // For character-level (single chars), join without spaces
    if (tokens.every(t => typeof t === 'string' && t.length === 1)) {
      return tokens.join('');
    }

    // For word-level, join with spaces
    return tokens.join(' ');
  }

  /**
   * Get color index for a token.
   * Vowels, consonants, space, other.
   */
  getColorForToken(token) {
    if (typeof token !== 'string' || token.length === 0) return 0;

    const char = token.charAt(0).toLowerCase();
    const vowels = 'aeiou';

    if (token === ' ' || token.trim() === '') return 0;  // Space = white/light
    if (vowels.includes(char)) return 1;                  // Vowels = one color family
    if (char >= 'a' && char <= 'z') return 2;            // Consonants = another
    return 3;                                             // Punctuation/other
  }

  /**
   * Convert a node's normalized bounds to Dasher Y coordinates
   * given a parent's Dasher bounds.
   */
  getNodeDasherBounds(node, parentY1, parentY2) {
    const range = parentY2 - parentY1;
    const y1 = parentY1 + (range * node.lbnd) / NORMALIZATION;
    const y2 = parentY1 + (range * node.hbnd) / NORMALIZATION;
    return { y1, y2 };
  }

  /**
   * Get the Dasher bounds of the root node
   */
  getRootBounds() {
    return { y1: this.rootmin, y2: this.rootmax };
  }

  /**
   * The core zoom/navigation step.
   *
   * Given cursor position in Dasher coordinates (dasherX, dasherY),
   * compute one step of movement toward that target.
   *
   * The elegant formula from the original: target = [Y - X, Y + X]
   * - X determines zoom rate (smaller X = faster zoom in)
   * - Y determines steering direction
   *
   * @param dasherX - Cursor X in Dasher space (distance from Y-axis)
   * @param dasherY - Cursor Y in Dasher space
   * @param nSteps - Number of steps to reach target (controls speed)
   */
  scheduleOneStep(dasherX, dasherY, nSteps = 10) {
    const targetY1 = dasherY - dasherX;
    const targetY2 = dasherY + dasherX;

    const R1 = this.rootmin;
    const R2 = this.rootmax;

    const targetRange = targetY2 - targetY1;

    if (targetRange <= 0) return;

    const r1 = MAX_Y * (R1 - targetY1) / targetRange;
    const r2 = MAX_Y * (R2 - targetY1) / targetRange;

    let m1 = r1 - R1;
    let m2 = r2 - R2;

    const sqrtTarget = Math.sqrt(targetRange);
    const sqrtMax = Math.sqrt(MAX_Y);
    const denom = sqrtMax * (nSteps - 1) + sqrtTarget;
    const alpha = sqrtTarget / denom;

    m1 *= alpha;
    m2 *= alpha;

    const newRootmin = R1 + m1;
    const newRootmax = R2 + m2;

    this.rootmin = Math.min(newRootmin, ORIGIN_Y - 1);
    this.rootmax = Math.max(newRootmax, ORIGIN_Y + 1);

    if (this.rootmax - this.rootmin < MAX_Y / 4) {
      const center = (this.rootmin + this.rootmax) / 2;
      const halfWidth = MAX_Y / 8;
      this.rootmin = center - halfWidth;
      this.rootmax = center + halfWidth;
    }
  }

  /**
   * Check if a node covers the crosshair
   */
  coversCrosshair(y1, y2) {
    const range = y2 - y1;
    return range > ORIGIN_X && y1 < ORIGIN_Y && y2 > ORIGIN_Y;
  }

  /**
   * Make a child node the new root (when zoomed in enough).
   */
  makeRoot(newRoot) {
    if (!newRoot || newRoot.parent !== this.root) return;

    this.rootTokenPath.push(newRoot.token);

    this.oldRoots.push(this.root);
    if (this.oldRoots.length > 20) {
      this.oldRoots.shift();
    }

    const range = this.rootmax - this.rootmin;
    const newRootmax = this.rootmin + (range * newRoot.hbnd) / NORMALIZATION;
    const newRootmin = this.rootmin + (range * newRoot.lbnd) / NORMALIZATION;

    this.rootmin = newRootmin;
    this.rootmax = newRootmax;

    this.root = newRoot;
    this.root.parent = null;

    this.expandNode(this.root);
  }

  /**
   * Reconstruct the parent node when oldRoots cache is empty.
   * Enables infinite undo via the language model and token path.
   *
   * @returns {DasherNode|null} The reconstructed parent, or null if at original root
   */
  rebuildParent() {
    if (this.rootTokenPath.length === 0) return null;
    if (!this.languageModel) return null;

    const currentToken = this.rootTokenPath[this.rootTokenPath.length - 1];
    const parentTokens = this.rootTokenPath.slice(0, -1);

    const parentNode = new DasherNode('', 0, NORMALIZATION, null);

    parentNode.context = this.languageModel.createContext();
    for (const token of parentTokens) {
      this.languageModel.enterToken(parentNode.context, token);
    }

    this.expandNode(parentNode);

    if (!parentNode.children || parentNode.children.length === 0) {
      return null;
    }

    const matchingChild = parentNode.children.find(c => c.token === currentToken);

    if (!matchingChild) {
      this.root.lbnd = parentNode.children[0].lbnd;
      this.root.hbnd = parentNode.children[0].hbnd;
    } else {
      this.root.lbnd = matchingChild.lbnd;
      this.root.hbnd = matchingChild.hbnd;

      const childIndex = parentNode.children.indexOf(matchingChild);
      parentNode.children[childIndex] = this.root;
    }

    return parentNode;
  }

  /**
   * Reparent: make the parent of current root into the new root (for backing up).
   */
  reparentRoot() {
    let newRoot;

    if (this.oldRoots.length > 0) {
      newRoot = this.oldRoots.pop();
    } else {
      newRoot = this.rebuildParent();
      if (!newRoot) return false;
    }

    this.rootTokenPath.pop();

    this.root.parent = newRoot;

    const lower = this.root.lbnd;
    const upper = this.root.hbnd;
    const nodeRange = upper - lower;
    const rootWidth = this.rootmax - this.rootmin;

    const newRootmax = this.rootmax + ((NORMALIZATION - upper) * rootWidth) / nodeRange;
    const newRootmin = this.rootmin - (lower * rootWidth) / nodeRange;

    this.rootmin = newRootmin;
    this.rootmax = newRootmax;
    this.root = newRoot;

    return true;
  }

  /**
   * Check if there's visible space around the current root
   */
  isSpaceAroundRoot(visibleMinY, visibleMaxY, visibleMaxX) {
    const rootRange = this.rootmax - this.rootmin;
    return rootRange < visibleMaxX ||
           this.rootmin > visibleMinY ||
           this.rootmax < visibleMaxY;
  }

  /**
   * Find the node currently under the crosshair
   */
  getNodeUnderCrosshair() {
    return this._findNodeAtPoint(this.root, this.rootmin, this.rootmax, ORIGIN_X, ORIGIN_Y);
  }

  _findNodeAtPoint(node, y1, y2, targetX, targetY) {
    const range = y2 - y1;

    if (range <= targetX || y1 >= targetY || y2 <= targetY) {
      return null;
    }

    if (node.children) {
      for (const child of node.children) {
        const childBounds = this.getNodeDasherBounds(child, y1, y2);
        const found = this._findNodeAtPoint(
          child, childBounds.y1, childBounds.y2, targetX, targetY
        );
        if (found) return found;
      }
    }

    return node;
  }

  /**
   * Update output based on current node under crosshair.
   * Called each frame after viewport updates.
   *
   * @returns {boolean} True if output changed
   */
  updateOutput() {
    const currentNode = this.getNodeUnderCrosshair();

    if (currentNode === this.lastNodeUnderCrosshair) {
      return false;
    }

    const currentPath = this._getNodePath(currentNode);
    const lastPath = this._getNodePath(this.lastNodeUnderCrosshair);

    let commonLength = 0;
    while (commonLength < currentPath.length &&
           commonLength < lastPath.length &&
           currentPath[commonLength] === lastPath[commonLength]) {
      commonLength++;
    }

    const tokensToRemove = lastPath.length - commonLength;
    if (tokensToRemove > 0) {
      this.outputTokens = this.outputTokens.slice(0, -tokensToRemove);
      this.outputItems = this.outputItems.slice(0, -tokensToRemove);
    }

    for (let i = commonLength; i < currentPath.length; i++) {
      const node = currentPath[i];
      if (node.token) {
        this.outputTokens.push(node.token);
        this.outputItems.push({ token: node.token, image: node.image });
      }
    }

    this.lastNodeUnderCrosshair = currentNode;

    if (this.onTextChange) {
      this.onTextChange(this.tokensToText(this.outputTokens));
    }

    if (this.onOutputItemsChange) {
      this.onOutputItemsChange(this.outputItems);
    }

    return true;
  }

  /**
   * Get the path from root to a node (as array of nodes)
   */
  _getNodePath(node) {
    const path = [];
    let current = node;
    while (current) {
      path.unshift(current);
      current = current.parent;
    }
    for (let i = this.oldRoots.length - 1; i >= 0; i--) {
      path.unshift(this.oldRoots[i]);
    }
    return path;
  }
}

export default DasherModel;

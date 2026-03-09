# Dasher

A text entry interface that turns cursor movement into text via arithmetic coding.

Dasher was created by the [Inference Group](https://www.inference.org.uk/is/) at Cambridge, led by the late Sir David MacKay. You write by zooming into a fractal arrangement of characters or words, where each symbol's size reflects its probability given the preceding context. The result is part productivity software, part accessibility device, and part psychotropic cyborg fidget toy.

This is a JavaScript reimplementation supporting both character-level and word-level entry with pluggable language models.

**[Live demo](https://frigital.onrender.com/tools/dasher/)**

## Quick Start

### Vanilla JS

Serve the repo root and open the example in your browser:

```bash
cd dasher
python3 -m http.server 8000
# open http://localhost:8000/examples/vanilla/
```

Paste text, pick a mode (character or word), and click Load. Click the canvas to start, then move your mouse to write.

### React

```jsx
import { DasherCanvas, useDasher } from 'dasher/react';
import { createPPMModel, ALPHABETS } from 'dasher/models';

const ppm = createPPMModel(ALPHABETS.LOWERCASE, { maxOrder: 5 });
ppm.train("your training text here");

function App() {
  const { modelRef, viewRef, modelReady, outputText } = useDasher({
    languageModel: ppm,
    mode: "character",
  });

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <DasherCanvas
        modelRef={modelRef}
        viewRef={viewRef}
        modelReady={modelReady}
        settings={{ mode: "character" }}
      />
      <p>{outputText}</p>
    </div>
  );
}
```

### Programmatic (no UI)

```javascript
import { DasherModel, createPPMModel, ALPHABETS } from 'dasher';

const ppm = createPPMModel(ALPHABETS.LOWERCASE, { maxOrder: 5 });
ppm.train("the cat sat on the mat");

const model = new DasherModel();
model.setLanguageModel(ppm);
model.init();

// The model is now ready to receive cursor input via scheduleOneStep()
```

## Language Models

Dasher works with any object implementing this interface:

```typescript
interface LanguageModel {
  createContext(): Context;
  cloneContext(ctx: Context): Context;
  enterToken(ctx: Context, token: string): void;
  getContinuations(ctx: Context): Array<{
    token: string;
    prob: number;
    color?: number;
  }>;
}
```

### Included Models

**PPM (Prediction by Partial Matching)** — Character-level model ported from the original Dasher C++ code. Trains on raw text and predicts the next character given a variable-length context. Best for the classic Dasher experience.

```javascript
import { createPPMModel, ALPHABETS } from 'dasher';

const model = createPPMModel(ALPHABETS.LOWERCASE, {
  maxOrder: 5,   // Context length (default 5)
  alpha: 100,    // Escape probability (default 100)
  beta: 100,     // Count smoothing (default 100)
});
model.train(text);
```

**Ngram** — Word or character level model built from an in-memory transition matrix. Supports temperature for probability redistribution.

```javascript
import { NgramLanguageModel, buildNgramIndex, tokenizers } from 'dasher';

// Word-level
const wordIndex = buildNgramIndex(text, 2);
const wordModel = new NgramLanguageModel(wordIndex, {
  maxContextSize: 2,
  temperature: 1.5,  // >1 flattens, <1 sharpens
});

// Character-level
const charIndex = buildNgramIndex(text, 5, { tokenize: tokenizers.character });
const charModel = new NgramLanguageModel(charIndex, { maxContextSize: 5 });
```

### Custom Models

Implement the four-method interface above. For example, a uniform random model:

```javascript
const uniformModel = {
  createContext: () => ({}),
  cloneContext: () => ({}),
  enterToken: () => {},
  getContinuations: () =>
    "abcdefghijklmnopqrstuvwxyz ".split("").map((c) => ({
      token: c,
      prob: 1 / 27,
    })),
};
```

## Arithmetic Codec

Dasher sequences can be encoded as compact URL-safe strings:

```javascript
import { encode, decode } from 'dasher';

const code = encode(['the', 'cat', 'sat'], wordModel);  // "ABcD.12"
const words = decode(code, wordModel);                   // ['the', 'cat', 'sat']
```

The encoding uses the language model's probability distribution, so likely sequences compress to shorter codes.

## Architecture

```
src/
├── core/
│   ├── DasherModel.js      # Coordinate system, zoom dynamics, node tree
│   ├── DasherView.js       # Screen ↔ Dasher coordinate transforms
│   └── DasherRenderer.js   # Canvas rendering
├── models/
│   ├── PPMLanguageModel.js  # Character PPM (from original Dasher)
│   ├── NgramLanguageModel.js # Word/char ngram model
│   └── localNgrams.js       # Ngram index builder
├── codec/
│   └── arithmeticCodec.js   # Sequence ↔ compact string encoding
└── react/
    ├── DasherCanvas.jsx     # Canvas component with input handling
    └── useDasher.js         # Model lifecycle hook
```

## Attribution

- **Original Dasher**: David MacKay, David Ward, and the Inference Group at the University of Cambridge. [dasher-project/dasher](https://github.com/dasher-project/dasher)
- **PPM Language Model**: JavaScript port of `PPMLanguageModel.cpp` by David Ward (1999-2005)
- **This implementation**: Jamie Brew

## License

GPL-2.0 (consistent with the original Dasher project)

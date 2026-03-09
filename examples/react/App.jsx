import { useState, useMemo } from "react";
import { DasherCanvas, useDasher } from "dasher/react";
import { createPPMModel, ALPHABETS, NgramLanguageModel, buildNgramIndex } from "dasher";

const DEFAULT_TEXT = `it was the best of times it was the worst of times it was the age of wisdom it was the age of foolishness it was the epoch of belief it was the epoch of incredulity it was the season of light it was the season of darkness it was the spring of hope it was the winter of despair`;

export default function App() {
  const [mode, setMode] = useState("character");
  const [text, setText] = useState(DEFAULT_TEXT);
  const [trainingText, setTrainingText] = useState(DEFAULT_TEXT);

  const languageModel = useMemo(() => {
    if (!trainingText.trim()) return null;

    if (mode === "character") {
      const ppm = createPPMModel(ALPHABETS.LOWERCASE, { maxOrder: 5 });
      ppm.train(trainingText.toLowerCase());
      return ppm;
    } else {
      const index = buildNgramIndex(trainingText, 2);
      return new NgramLanguageModel(index, {
        maxContextSize: 2,
        temperature: 1.5,
      });
    }
  }, [trainingText, mode]);

  const { modelRef, viewRef, modelReady, outputText } = useDasher({
    languageModel,
    mode,
    topK: mode === "word" ? 10 : null,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "monospace" }}>
      <div style={{ padding: "8px 12px", borderBottom: "2px solid black", background: "white", minHeight: 32, fontSize: 14, whiteSpace: "pre-wrap" }}>
        {outputText || "Click the canvas to start, then move your mouse to write."}
      </div>

      <div style={{ flex: 1 }}>
        <DasherCanvas
          modelRef={modelRef}
          viewRef={viewRef}
          modelReady={modelReady}
          settings={{ mode, zoomSpeed: 12 }}
        />
      </div>

      <div style={{ padding: 12, display: "flex", gap: 12, alignItems: "start", borderTop: "1px solid #ccc", background: "#f5f5f5" }}>
        <div>
          <label style={{ fontSize: 13 }}>Mode:</label><br />
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ fontFamily: "monospace" }}>
            <option value="character">Character (PPM)</option>
            <option value="word">Word (Ngram)</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 13 }}>Training text:</label><br />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: 400, height: 60, fontFamily: "monospace", fontSize: 13, resize: "vertical" }}
          />
        </div>
        <button
          onClick={() => setTrainingText(text)}
          style={{ padding: "6px 12px", fontFamily: "monospace", cursor: "pointer" }}
        >
          Load
        </button>
      </div>
    </div>
  );
}

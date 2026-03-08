/**
 * useDasher.js
 *
 * React hook that manages the DasherModel + DasherView lifecycle.
 * Takes a language model directly — no API calls, no source loading.
 *
 * Usage:
 *   const { modelRef, viewRef, outputText, outputItems, modelReady } = useDasher({
 *     languageModel: myPPMModel,
 *     mode: "character",
 *     topK: null,
 *   });
 */

import { useRef, useState, useCallback, useEffect } from "react";
import { DasherModel } from "../core/DasherModel.js";
import { DasherView } from "../core/DasherView.js";

export function useDasher({
  languageModel,
  mode = "character",
  topK = null,
  sortAlphabetical = null,
  width = 800,
  height = 600,
  crosshairRatio = 0.75,
  onTextChange,
} = {}) {
  const modelRef = useRef(null);
  const viewRef = useRef(null);
  const [modelReady, setModelReady] = useState(false);
  const [outputText, setOutputText] = useState("");
  const [outputItems, setOutputItems] = useState([]);

  // Initialize view
  useEffect(() => {
    viewRef.current = new DasherView(width, height, crosshairRatio);
  }, []);

  // Resize view when dimensions change
  useEffect(() => {
    viewRef.current?.resize(width, height);
  }, [width, height]);

  // Build model when language model changes
  useEffect(() => {
    if (!languageModel) {
      setModelReady(false);
      return;
    }

    const model = new DasherModel();
    model.setLanguageModel(languageModel);
    model.setTopK(topK);

    // Default: sort alphabetically for character mode
    model.sortAlphabetical = sortAlphabetical ?? (mode === "character");

    model.onTextChange = (text) => {
      setOutputText(text);
      if (onTextChange) onTextChange(text);
    };

    model.onOutputItemsChange = (items) => {
      setOutputItems([...items]);
    };

    model.init();
    modelRef.current = model;
    setModelReady(true);
    setOutputText("");
    setOutputItems([]);
  }, [languageModel, mode, topK, sortAlphabetical, onTextChange]);

  // Update topK on existing model without full rebuild
  useEffect(() => {
    if (modelRef.current) {
      modelRef.current.setTopK(topK);
    }
  }, [topK]);

  return {
    modelRef,
    viewRef,
    modelReady,
    outputText,
    outputItems,
  };
}

export default useDasher;

import { Leva, useControls } from "leva";
import { useDeferredValue, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_OPTIONS, LiquidType, type LetterPlacement, type LiquidTypeOptions } from "liquid-type";

const FONTS = [
  { label: "Bagel Fat One", family: '"Bagel Fat One"' },
  { label: "Titan One", family: '"Titan One"' },
  { label: "Chango", family: '"Chango"' },
];

// Leva sliders for every option, ranged around its default.
const optionControls = Object.fromEntries(
  Object.entries(DEFAULT_OPTIONS).map(([key, value]) => [
    key,
    { value, min: 0, max: value >= 1 ? Math.ceil(value * 4) : Math.max(1, value * 4), step: value >= 10 ? 1 : 0.005 },
  ]),
);

function App() {
  const params = new URLSearchParams(location.search);
  const [text, setText] = useState(params.get("text") ?? "DURVA");
  const [seed, setSeed] = useState(Number(params.get("seed") ?? 1));
  const [font, setFont] = useState(FONTS[0].family);
  const [background, setBackground] = useState("#F1ECE3");
  const [ink, setInk] = useState("#0b0b0c");
  const [copied, setCopied] = useState(false);
  const layout = useRef<LetterPlacement[]>([]);
  const options = useControls("Options", optionControls) as unknown as LiquidTypeOptions;
  // Rebuilding the letters takes a moment, so let typing stay responsive.
  const deferredText = useDeferredValue(text);

  const copyLayout = async () => {
    await navigator.clipboard.writeText(JSON.stringify(layout.current, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <LiquidType
        text={deferredText}
        seed={seed}
        fontFamily={font}
        background={background}
        ink={ink}
        options={options}
        onLayout={(l) => (layout.current = l)}
        style={{ height: "100svh" }}
      />
      <form className="bar" onSubmit={(e) => e.preventDefault()}>
        <input
          aria-label="Text"
          value={text}
          maxLength={48}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a word"
        />
        <select aria-label="Font" value={font} onChange={(e) => setFont(e.target.value)}>
          {FONTS.map((f) => (
            <option key={f.label} value={f.family}>
              {f.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setSeed((s) => s + 1)}>
          Shuffle layout
        </button>
        <label>
          Ink <input type="color" value={ink} onChange={(e) => setInk(e.target.value)} />
        </label>
        <label>
          Background <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} />
        </label>
        <button type="button" onClick={copyLayout}>
          {copied ? "Copied" : "Copy layout"}
        </button>
        <a href="https://github.com/durvagaikwad/liquid-type">GitHub</a>
      </form>
      <Leva collapsed />
      <style>{`
        .bar {
          position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
          display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center;
          max-width: calc(100vw - 32px); box-sizing: border-box;
          padding: 8px 10px; border-radius: 14px;
          background: rgba(20, 20, 22, 0.82); color: #f1ece3; font-size: 13px;
          backdrop-filter: blur(8px);
        }
        .bar input:not([type=color]), .bar select, .bar button {
          font: inherit; color: inherit; background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.16); border-radius: 8px; padding: 6px 10px;
        }
        .bar input:not([type=color]) { width: 160px; }
        .bar button { cursor: pointer; }
        .bar label { display: flex; gap: 6px; align-items: center; }
        .bar input[type=color] { width: 28px; height: 28px; padding: 0; border: none; background: none; }
        .bar a { color: inherit; opacity: 0.8; padding: 0 4px; }
      `}</style>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

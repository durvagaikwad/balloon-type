import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_OPTIONS, BalloonType, type LetterPlacement, type BalloonTypeOptions } from "balloon-type";

const FONTS = [
  { label: "Bagel Fat One", family: '"Bagel Fat One"' },
  { label: "Titan One", family: '"Titan One"' },
  { label: "Chango", family: '"Chango"' },
];

type Group = "Look" | "Melt" | "Movement";
type Spec = { label: string; min: number; max: number; step: number; group: Group };
type Control = Spec & { key: keyof BalloonTypeOptions };

// A slider for every option the package has. The Record type makes TypeScript
// fail the build if an option is added to the package without a control here.
const CONTROLS: Record<keyof BalloonTypeOptions, Spec> = {
  puffiness: { label: "Puffiness", min: 0.01, max: 0.15, step: 0.001, group: "Look" },
  glossSharpness: { label: "Gloss", min: 4, max: 120, step: 1, group: "Look" },
  tilt: { label: "Tilt", min: 0, max: 30, step: 1, group: "Look" },
  shadow: { label: "Shadow", min: 0, max: 0.3, step: 0.005, group: "Look" },
  rounding: { label: "Rounding", min: 0, max: 0.08, step: 0.005, group: "Look" },

  meltStrength: { label: "Strength", min: 0, max: 0.6, step: 0.01, group: "Melt" },
  recoveryTime: { label: "Recovery time", min: 0.3, max: 5, step: 0.1, group: "Melt" },
  meltGain: { label: "Gain", min: 5, max: 300, step: 5, group: "Melt" },
  jiggle: { label: "Jiggle", min: 0, max: 0.8, step: 0.01, group: "Melt" },
  speedForMax: { label: "Swipe speed", min: 0.5, max: 20, step: 0.5, group: "Melt" },
  speedCurve: { label: "Speed curve", min: 0.5, max: 3, step: 0.05, group: "Melt" },

  letterPush: { label: "Push", min: 0, max: 200, step: 1, group: "Movement" },
  bounce: { label: "Bounce", min: 0, max: 1, step: 0.05, group: "Movement" },
  friction: { label: "Friction", min: 0.2, max: 10, step: 0.1, group: "Movement" },
  homePull: { label: "Home pull", min: 0, max: 50, step: 0.5, group: "Movement" },
  hoverFloor: { label: "Hover push", min: 0, max: 1, step: 0.01, group: "Movement" },
  flingBias: { label: "Fling", min: 0, max: 2, step: 0.05, group: "Movement" },
  spin: { label: "Spin", min: 0, max: 12, step: 0.1, group: "Movement" },
};

const GROUPS = (["Look", "Melt", "Movement"] as const).map((title) => ({
  title,
  controls: (Object.keys(CONTROLS) as (keyof BalloonTypeOptions)[])
    .filter((key) => CONTROLS[key].group === title)
    .map((key): Control => ({ key, ...CONTROLS[key] })),
}));

// Inline icons (no icon library), drawn on a 16px grid in the current text colour.
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Icon>
);
const CheckIcon = () => (
  <Icon>
    <path d="M3 8.5l3 3 7-7" />
  </Icon>
);
const SlidersIcon = () => (
  <Icon>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    <circle cx="5.5" cy="4.5" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="7" cy="11.5" r="1.6" fill="currentColor" stroke="none" />
  </Icon>
);
const CloseIcon = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
const GitHubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const format = (value: number, step: number) => (step >= 1 ? String(value) : value.toFixed(step < 0.01 ? 3 : 2));

// A ready-to-paste <BalloonType /> snippet for what's on screen: text, font,
// colours, the exact arrangement, and only the options changed from the defaults.
function toSnippet(p: {
  text: string;
  font: string;
  ink: string;
  background: string;
  layout: LetterPlacement[];
  options: BalloonTypeOptions;
}) {
  const plain = /^[^"\\\n{}]*$/.test(p.text);
  const changed = (Object.keys(p.options) as (keyof BalloonTypeOptions)[])
    .filter((k) => p.options[k] !== DEFAULT_OPTIONS[k])
    .map((k) => `${k}: ${p.options[k]}`);
  const lines = [
    plain ? `  text="${p.text}"` : `  text={${JSON.stringify(p.text)}}`,
    `  fontFamily='${p.font}'`,
    `  ink="${p.ink}"`,
    `  background="${p.background}"`,
    "  layout={[",
    ...p.layout.map((l) => `    { x: ${l.x}, y: ${l.y}, height: ${l.height}, rotate: ${l.rotate} },`),
    "  ]}",
    ...(changed.length ? [`  options={{ ${changed.join(", ")} }}`] : []),
  ];
  return [
    'import { BalloonType } from "balloon-type";',
    "",
    `// Load the font on your page first (e.g. Google Fonts or next/font).`,
    "<BalloonType",
    ...lines,
    "/>",
    "",
  ].join("\n");
}

function App() {
  const params = new URLSearchParams(location.search);
  const [text, setText] = useState(params.get("text") ?? "DURVA");
  const [seed, setSeed] = useState(Number(params.get("seed") ?? 1));
  // ?embed shows the letters alone, with no controls: for the demo framed
  // inside another page (Durva's portfolio playground card)
  const embed = params.has("embed");
  const [font, setFont] = useState(FONTS[0].family);
  const [background, setBackground] = useState("#F1ECE3");
  const [ink, setInk] = useState("#0b0b0c");
  const [options, setOptions] = useState<BalloonTypeOptions>(DEFAULT_OPTIONS);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const layout = useRef<LetterPlacement[]>([]);
  const tunePanel = useRef<HTMLElement>(null);
  // Rebuilding the letters takes a moment, so keep typing and sliders responsive.
  const deferredText = useDeferredValue(text);
  const deferredOptions = useDeferredValue(options);

  // The panel lines up with the Tune button's left edge; on narrow screens,
  // nudge it left just enough to stay on screen.
  useLayoutEffect(() => {
    const el = tunePanel.current;
    if (!tuneOpen || !el) return;
    const place = () => {
      el.style.transform = "";
      const overflow = el.getBoundingClientRect().right - (window.innerWidth - 16);
      if (overflow > 0) el.style.transform = `translateX(${-overflow}px)`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [tuneOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTuneOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const copyCode = async () => {
    await navigator.clipboard.writeText(
      toSnippet({ text, font, ink, background, layout: layout.current, options }),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const renderGroups = (groups: typeof GROUPS) =>
    groups.map((group) => (
      <fieldset key={group.title}>
        <legend>{group.title}</legend>
        {group.controls.map((c) => (
          <label key={c.key} className="row">
            <span>{c.label}</span>
            <input
              type="range"
              min={c.min}
              max={c.max}
              step={c.step}
              value={options[c.key]}
              onChange={(e) => setOptions((o) => ({ ...o, [c.key]: Number(e.target.value) }))}
            />
            <output>{format(options[c.key], c.step)}</output>
          </label>
        ))}
      </fieldset>
    ));

  return (
    <>
      <BalloonType
        text={deferredText}
        seed={seed}
        fontFamily={font}
        background={background}
        ink={ink}
        options={deferredOptions}
        onLayout={(l) => (layout.current = l)}
        style={{ height: "100svh" }}
      />
      <div className="dock" style={embed ? { display: "none" } : undefined}>
        <form className="panel bar" onSubmit={(e) => e.preventDefault()}>
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
        </form>
        <div className="panel pill">
          <button
            type="button"
            className="icon"
            onClick={copyCode}
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code: a ready-to-paste <BalloonType /> for what's on screen"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        <div className="panel pill">
          <a className="button icon" href="https://github.com/durvagaikwad/balloon-type" aria-label="GitHub" title="View on GitHub">
            <GitHubIcon />
          </a>
        </div>
        {/* Tune sits last; its panel opens right above it, aligned to its left edge. */}
        <div className="tune-anchor">
          {tuneOpen && (
            <section ref={tunePanel} className="panel" id="tune" aria-label="Tune">
              <header>
                <span>Tune</span>
                <button type="button" onClick={() => setOptions(DEFAULT_OPTIONS)}>
                  Reset
                </button>
              </header>
              {renderGroups(GROUPS)}
            </section>
          )}
          <div className="panel pill">
            <button
              type="button"
              className="icon"
              aria-expanded={tuneOpen}
              aria-controls="tune"
              aria-label={tuneOpen ? "Close tune" : "Tune"}
              title={tuneOpen ? "Close" : "Tune"}
              onClick={() => setTuneOpen((o) => !o)}
            >
              {tuneOpen ? <CloseIcon /> : <SlidersIcon />}
            </button>
          </div>
        </div>
      </div>
      <style>{`
        .dock {
          position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
          display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px;
          width: max-content; max-width: calc(100vw - 32px);
        }
        .panel {
          box-sizing: border-box; max-width: 100%;
          border-radius: 999px; padding: 8px;
          background: rgba(20, 20, 22, 0.82); color: #f1ece3; font-size: 13px;
          backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        }
        .panel input:not([type=color]):not([type=range]), .panel select, .panel button, .panel .button {
          font: inherit; color: inherit; background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.16); border-radius: 999px; padding: 6px 14px;
        }
        .panel button, .panel .button { cursor: pointer; text-decoration: none; }
        .panel button:hover, .panel .button:hover, .panel button[aria-expanded=true] { background: rgba(255,255,255,0.16); }

        .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; }
        .bar input:not([type=color]) { width: 160px; }
        .bar label { display: flex; gap: 6px; align-items: center; padding: 0 2px; }
        /* Own chevron, inset from the rounded end (the native one gets clipped by the pill shape). */
        .bar select {
          appearance: none; -webkit-appearance: none; padding-right: 32px; cursor: pointer;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none' stroke='%23f1ece3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 14px center;
        }
        .bar select option { color: #111; }
        /* Colour swatches as dots. */
        .bar input[type=color] {
          width: 26px; height: 26px; padding: 0; border: 1px solid rgba(255,255,255,0.3);
          border-radius: 50%; background: none; overflow: hidden; cursor: pointer;
        }
        .bar input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
        .bar input[type=color]::-webkit-color-swatch { border: none; border-radius: 50%; }
        .bar input[type=color]::-moz-color-swatch { border: none; border-radius: 50%; }

        /* Separate single-button circles, same height as the bar. */
        .pill { display: flex; align-items: center; justify-content: center; width: 47px; height: 47px; padding: 0; border-radius: 50%; }
        .tune-anchor { position: relative; display: flex; }
        /* Round icon buttons, same height as the bar's controls. */
        .panel .icon { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; box-sizing: border-box; border-radius: 50%; }
        #tune {
          position: absolute; left: 0; bottom: calc(100% + 8px);
          width: min(300px, calc(100vw - 32px)); max-width: none; /* wider than its anchor */
          max-height: calc(100svh - 120px); overflow-y: auto;
          display: flex; flex-direction: column; gap: 4px; padding: 14px 18px 16px;
          border-radius: 24px;
        }
        #tune header {
          display: flex; justify-content: space-between; align-items: center;
          padding-bottom: 4px;
        }
        #tune header button { padding: 4px 12px; }
        #tune fieldset { border: none; margin: 0; padding: 0; min-width: 0; }
        #tune legend { opacity: 0.6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 0 4px; }
        #tune .row { display: grid; grid-template-columns: 96px 1fr 44px; gap: 8px; align-items: center; min-height: 26px; }
        #tune .row span { opacity: 0.85; }
        #tune output { text-align: right; font-variant-numeric: tabular-nums; opacity: 0.7; }
        #tune input[type=range] { width: 100%; accent-color: #f1ece3; margin: 0; }
      `}</style>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

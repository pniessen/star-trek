/**
 * Bundles the game into a single self-contained HTML file with no external
 * requests — everything inlined, so it runs from a file:// path, a static host,
 * or anywhere with a strict content-security policy.
 *
 *   npm run build && node tools/build-standalone.mjs [outFile]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "dist/kobayashi.html";
const ASSETS = "dist/assets";

const scripts = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
if (scripts.length !== 1) {
  throw new Error(`expected exactly one bundled script, found ${scripts.length}: ${scripts}`);
}
const code = readFileSync(join(ASSETS, scripts[0]), "utf8");

// Pull the canvas styling out of the built index so the two cannot drift.
const builtIndex = readFileSync("dist/index.html", "utf8");
const styleMatch = builtIndex.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("no <style> block found in dist/index.html");

const page = `<title>KOBAYASHI — vector arcade prototype</title>

<style>
${styleMatch[1].trim()}

  /* The page is one screen; nothing scrolls. */
  html, body { overflow: hidden; height: 100%; }

  #engage {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-content: center;
    gap: 26px;
    justify-items: center;
    background: rgba(4, 7, 11, 0.94);
    color: #b9d3d8;
    font-family: "Helvetica Neue", Helvetica, "Segoe UI", system-ui, sans-serif;
    text-align: center;
    padding: 32px;
    cursor: pointer;
    transition: opacity 0.35s ease;
  }
  #engage.gone { opacity: 0; pointer-events: none; }
  #engage h1 {
    margin: 0;
    font-size: clamp(30px, 6vw, 58px);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: #e8fbfa;
    text-shadow: 0 0 30px rgba(86, 231, 224, 0.45);
  }
  #engage .keys {
    display: grid;
    grid-template-columns: auto auto;
    gap: 8px 22px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #6d8c93;
    text-align: left;
  }
  #engage .keys b { color: #56e7e0; font-weight: 400; }
  #engage .go {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: #04070b;
    background: #56e7e0;
    padding: 11px 26px;
    border: 0;
    cursor: pointer;
  }
  #engage .go:focus-visible { outline: 2px solid #f2a63b; outline-offset: 3px; }
  #engage small { color: #6d8c93; font-size: 12px; max-width: 46ch; line-height: 1.7; }
</style>

<canvas id="view"></canvas>
<div id="fault"></div>

<div id="engage">
  <h1>Kobayashi</h1>
  <div class="keys">
    <b>Arrows / WASD</b><span>turn and thrust</span>
    <b>Space</b><span>phasers — drain energy, weaker at range</span>
    <b>X</b><span>torpedoes — limited, must be led</span>
    <b>R</b><span>restart the run</span>
    <b>G</b><span>wireframe vs occluded geometry</span>
    <b>B / F / V</b><span>bloom, phosphor trail, CRT glass</span>
    <b>1 / 2 / 3</b><span>cockpit, chase, orbit</span>
  </div>
  <button class="go" id="go" type="button">Engage</button>
  <small>
    Clear a wave, then fly to the starbase — the ring on your scanner — and dock
    slowly and lined up to bank your multiplier. Die before you dock and the
    run's earnings go with you.
  </small>
</div>

<script type="module">
${code}
</script>

<script>
  // Keyboard only reaches the game once this document has focus, which an
  // embedded frame does not get for free. The overlay doubles as the thing
  // that takes it.
  (function () {
    var engage = document.getElementById("engage");
    var go = document.getElementById("go");
    function start() {
      engage.classList.add("gone");
      window.focus();
      document.getElementById("view").focus();
    }
    engage.addEventListener("click", start);
    go.addEventListener("click", start);
    window.addEventListener("keydown", function (e) {
      if (!engage.classList.contains("gone")) start();
      // Stop the host page scrolling out from under the game.
      if (e.key === " " || e.key.indexOf("Arrow") === 0) e.preventDefault();
    });
  })();
</script>
`;

writeFileSync(OUT, page);
console.log(`${OUT}  ${(page.length / 1024).toFixed(0)} kB  (no external requests)`);

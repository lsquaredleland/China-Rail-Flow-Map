/* `?fps=1` meter (P2.4 / M3): a small fixed overlay with the page's frames per
   second, the mean and worst frame time of the last second, and the deck
   renders per second. Off by default: with no `fps=1` in the URL nothing is
   created and no frame callback is scheduled. Dev / device-check tooling. */
export function initFpsMeter(): void {
  if (new URLSearchParams(window.location.search).get("fps") !== "1") return;
  const el = document.createElement("div");
  el.id = "fpsMeter";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  let last = performance.now();
  let winStart = last;
  let frames = 0;
  let worst = 0;
  let renders0 = 0;
  const tick = (now: number) => {
    const dt = now - last;
    last = now;
    frames++;
    if (dt > worst) worst = dt;
    if (now - winStart >= 1000) {
      const span = now - winStart;
      const stats = (window as unknown as { __deckStats?: { afterRenders: number } }).__deckStats;
      const renders = stats ? stats.afterRenders : 0;
      el.textContent =
        `${((frames * 1000) / span).toFixed(0)} fps · ${(span / frames).toFixed(1)} ms (max ${worst.toFixed(0)})` +
        ` · ${(((renders - renders0) * 1000) / span).toFixed(0)} renders/s`;
      renders0 = renders;
      winStart = now;
      frames = 0;
      worst = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hideSplash } from "./splash";

/**
 * boot.js draws its "startup did not finish" panel by replacing `#splash`, so by the
 * time the app is up there is no splash to fade. `boot-ready` is still the only thing
 * that takes that panel away, and the window is usable by then.
 */
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="splash"></div>';
  delete document.documentElement.dataset.boot;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Lets the two animation frames and the trailing timers of `hideSplash` run. */
async function settle() {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(50);
}

it("reports a ready app so boot.js can drop its slow-start panel", async () => {
  // A late start: boot.js marked the document "slow" and swapped the splash for a panel.
  document.getElementById("splash")!.remove();
  document.documentElement.dataset.boot = "slow";
  const ready = vi.fn();
  window.addEventListener("pyforge:boot-ready", ready);

  hideSplash();
  await settle();

  expect(ready).toHaveBeenCalled();
});

it("leaves a panel that reports a real failure", async () => {
  document.getElementById("splash")!.remove();
  document.documentElement.dataset.boot = "failed";
  const ready = vi.fn();
  window.addEventListener("pyforge:boot-ready", ready);

  hideSplash();
  await settle();

  expect(ready).not.toHaveBeenCalled();
});

it("fades the splash out and then reports ready", async () => {
  const splash = document.getElementById("splash")!;
  const ready = vi.fn();
  window.addEventListener("pyforge:boot-ready", ready);

  hideSplash();
  await settle();

  expect(splash.isConnected).toBe(false);
  expect(ready).toHaveBeenCalled();
});

import { DEMO_STEPS, readDemoMode } from '../demoSequence.js';

function $(sel, root = document) {
  return root.querySelector(sel);
}

export function bindDemoScript(session, { location = globalThis.location } = {}) {
  const root = document.getElementById('ts-demo-script');
  if (!root || !session) return null;

  const mode = readDemoMode(location);
  let index = 0;
  let autoTimer = null;
  let playing = Boolean(mode.auto);
  let collapsed = false;

  const paint = () => {
    const step = DEMO_STEPS[index] || DEMO_STEPS[DEMO_STEPS.length - 1];
    const done = index >= DEMO_STEPS.length;
    root.hidden = false;
    root.classList.add('visible');
    // Once the first step has been taken the rail has taught what it needs to;
    // it collapses to a strip of step dots and expands again on hover.
    root.classList.toggle('is-collapsed', index > 0 || collapsed);
    root.dataset.step = done ? 'done' : step.id;
    const title = $('[data-ts-demo-step-title]', root);
    const copy = $('[data-ts-demo-step-copy]', root);
    const phrase = $('[data-ts-demo-phrase]', root);
    const next = $('[data-ts-demo-next]', root);
    const play = $('[data-ts-demo-auto]', root);
    if (title) title.textContent = done ? 'Demo complete' : step.title;
    if (copy) {
      copy.textContent = done
        ? 'Saved is open. WORLD recenters the market. DRIVE is a separate simulated route.'
        : step.copy;
    }
    if (phrase) {
      phrase.hidden = done || !step.phrase;
      phrase.textContent = step.phrase || '';
    }
    if (next) {
      next.textContent = done
        ? 'Replay'
        : (step.kind === 'hunt' || step.kind === 'scene' ? step.cta : 'Send this phrase');
    }
    if (play) play.textContent = playing ? 'Pause' : 'Play';
    const list = $('[data-ts-demo-list]', root);
    if (list) {
      list.innerHTML = DEMO_STEPS.map((row, i) => (
        `<li class="${i < index ? 'is-done' : i === index ? 'is-current' : ''}">${row.phrase || row.cta}</li>`
      )).join('');
    }
  };

  const wait = (ms) => new Promise((resolve) => {
    autoTimer = globalThis.setTimeout(resolve, ms);
  });

  const runCurrent = async () => {
    if (index >= DEMO_STEPS.length) {
      index = 0;
      playing = false;
      paint();
      return;
    }
    const step = DEMO_STEPS[index];
    if (step.kind === 'hunt') {
      await session.beginHunt?.();
    } else if (step.kind === 'scene') {
      // A scene is a different page, not another phrase: hand the browser the
      // URL and let the session boot into it. Auto-play stops here rather than
      // navigating out from under a reviewer who did not ask for it.
      playing = false;
      if (autoTimer) globalThis.clearTimeout(autoTimer);
      try {
        globalThis.location.assign(step.href);
      } catch {
        // A test harness with no real location: nothing to navigate.
      }
      return;
    } else if (step.phrase) {
      const input = document.getElementById('ts-demo-input');
      if (input) input.value = step.phrase;
      session.handleIntent(step.phrase);
      if (input) input.value = '';
    }
    index += 1;
    paint();
  };

  const playLoop = async () => {
    while (playing && index < DEMO_STEPS.length) {
      const step = DEMO_STEPS[index];
      // Auto-play runs the conversation; changing scene is an explicit click.
      if (step.kind === 'scene') break;
      const delay = step.kind === 'hunt' ? 700 : 2200;
      await wait(delay);
      if (!playing) return;
      await runCurrent();
      if (step.kind === 'hunt') await wait(1200);
    }
    playing = false;
    paint();
  };

  $('[data-ts-demo-next]', root)?.addEventListener('click', () => {
    playing = false;
    if (autoTimer) globalThis.clearTimeout(autoTimer);
    void runCurrent();
  });
  $('[data-ts-demo-auto]', root)?.addEventListener('click', () => {
    playing = !playing;
    paint();
    if (playing) void playLoop();
  });

  document.getElementById('ts-demo-chip')?.addEventListener('click', () => {
    root.hidden = !root.hidden;
    if (!root.hidden) {
      root.classList.add('visible');
      paint();
    }
  });

  if (mode.enabled) {
    paint();
    if (mode.auto) void playLoop();
  } else {
    root.hidden = true;
  }

  session.demoScript = {
    get index() { return index; },
    runCurrent,
    paint,
    /** Once the hunt has begun the rail has taught what it needed to. */
    collapse() {
      collapsed = true;
      paint();
    },
  };
  return session.demoScript;
}

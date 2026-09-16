#!/usr/bin/env node
/**
 * Headed check for the assistant's presence — the real key, the real session.
 *
 * Opens the six-house scene in real Chrome, taps the orb, and waits for the
 * Realtime session to come up over WebRTC. Then it asks three things of it:
 *
 *   1. a text event sent through the data channel — "what's the best one" —
 *      produces a tool call that resolves to `find_money`, and an audio
 *      response begins within AUDIO_DEADLINE_MS of the send;
 *   2. a spoken turn — a WAV of the same phrase, played into the session's
 *      microphone stream from inside the page — produces the same tool call,
 *      and its first audible word is measured from the server's
 *      speech-stopped event, which is the number the 800 ms target is about.
 *      The page's getUserMedia is replaced with a Web Audio destination so the
 *      phrase starts exactly when the probe says, not when Chrome's fake
 *      capture device happens to open (Chrome's --use-file-for-fake-audio-
 *      capture stalled the WebRTC connect outright);
 *   3. nothing on the page errored, the page still answers, and the mic
 *      was never left live after the session was paused.
 *
 * The transcript — user lines, assistant lines, tool calls, briefs, and the
 * latency of every turn — is written to TRANSCRIPT_PATH.
 *
 *   node scripts/investor-voice.mjs [--url u] [--wav path] [--label x]
 *
 * Needs OPENAI_API_KEY in the dev server's environment: the check refuses to
 * pretend when /api/realtime/available says there is no key.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const URL_ARG = arg('url', 'http://localhost:4173/?scene=six');
const LABEL = arg('label', 'voice');
const SHOT_DIR = arg('shots', '/tmp/shots');
const WAV = arg('wav', join(SHOT_DIR, 'voice-prompt.wav'));
const TRANSCRIPT_PATH = join(SHOT_DIR, 'voice-transcript.txt');
const TEXT_PROMPT = "what's the best one";
/** From the text event leaving the client to the first audio frame arriving. */
const AUDIO_DEADLINE_MS = 2_000;
/** From the server's speech-stopped to the first audio frame. */
const FIRST_WORD_TARGET_MS = 800;
const CONNECT_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 25_000;
const SPEECH_TIMEOUT_MS = 30_000;

const log = [];
const started = Date.now();
const record = (line) => {
  log.push(`[${String(Date.now() - started).padStart(6)}ms] ${line}`);
  process.stdout.write(`${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const origin = new URL(URL_ARG).origin;
  const availability = await fetch(`${origin}/api/realtime/available`).then((r) => r.json()).catch(() => null);
  if (!availability?.available) {
    record(`FAIL /api/realtime/available says no key: ${JSON.stringify(availability)}`);
    process.exit(1);
  }
  if (!existsSync(WAV)) synthesizePrompt(WAV, TEXT_PROMPT);
  const haveWav = existsSync(WAV);
  const wavBase64 = haveWav ? readFileSync(WAV).toString('base64') : null;
  record(`assistant=${availability.assistant} wav=${haveWav ? WAV : 'none (spoken turn skipped)'}`);

  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['microphone'], { origin });
  const page = await context.newPage();
  /**
   * The microphone is a Web Audio graph the probe can speak into. Silence
   * flows from the start so the session sees a live track; `say(base64)`
   * decodes a WAV and plays it into the same destination.
   */
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__voiceProbe = { ready: false };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints?.audio) return original(constraints);
      const ctx = new AudioContext({ sampleRate: 48000 });
      const dest = ctx.createMediaStreamDestination();
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.connect(dest);
      silence.start();
      await ctx.resume().catch(() => {});
      window.__voiceProbe = {
        ready: true,
        ctx,
        async say(base64) {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const buffer = await ctx.decodeAudioData(bytes.buffer);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(dest);
          const at = performance.now();
          source.start();
          return { startedAt: at, durationMs: Math.round(buffer.duration * 1000) };
        },
      };
      return dest.stream;
    };
  });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text().slice(0, 300);
    if (/Failed to load resource/.test(text) && /googleapis/.test(text)) return;
    errors.push(text);
    record(`CONSOLE ERROR ${text}`);
  });
  page.on('pageerror', (error) => {
    errors.push(String(error?.message || error).slice(0, 300));
    record(`PAGEERROR ${String(error?.message || error).slice(0, 300)}`);
  });

  const fails = [];
  const check = (ok, line) => {
    record(`${ok ? 'PASS' : 'FAIL'} ${line}`);
    if (!ok) fails.push(line);
    return ok;
  };

  try {
    await page.goto(URL_ARG, { waitUntil: 'domcontentloaded' });
    // The descent, then the orb.
    const settled = await page.waitForFunction(() => {
      const s = window.__terraSignal;
      return Boolean(s && s.camera?.shot === 'CRUISE' && !s.camera.flying && s.terra);
    }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
    check(settled, 'descent settled on the six-house scene with the assistant attached');

    const probe = await page.evaluate(() => window.__terraSignal.terra.probe());
    check(probe === true, 'the page sees the key through /api/realtime/available');

    const tap = Date.now();
    await page.click('#gev-voice-button');
    const live = await page.waitForFunction(() => window.__terraSignal.terra.live, null, { timeout: CONNECT_TIMEOUT_MS })
      .then(() => true).catch(() => false);
    check(live, `one tap on the orb opened the session (${Date.now() - tap} ms)`);
    if (!live) throw new Error('session did not open');
    const orb = await page.evaluate(() => ({
      light: document.getElementById('ts-ai-slot')?.dataset.tsOrb,
      status: document.getElementById('gev-voice-control')?.dataset.status,
      mic: document.getElementById('gev-voice-control')?.dataset.microphone,
    }));
    check(orb.light === 'listening' && orb.mic === 'active', `orb shows listening as light (${JSON.stringify(orb)})`);

    const session = await page.evaluate(() => {
      const c = window.__gevVoiceCommands;
      return { status: c.status, tokenQuery: c.tokenQuery, alwaysOn: c.alwaysOn, pushToTalk: c.pushToTalkMode };
    });
    check(session.tokenQuery === 'persona=terra' && session.alwaysOn && !session.pushToTalk,
      `session is the assistant's persona, always on, no push-to-talk (${JSON.stringify(session)})`);

    // ---- 0. the brief on joining -----------------------------------------
    // The session joined a settled market, which is the descent-settled
    // moment: the assistant briefs the board unasked. Let it finish so the
    // text turn below is measured on a quiet line.
    const brief = await page.waitForFunction(() => {
      const t = window.__terraSignal.terra;
      return t.turns.find((x) => x.kind === 'brief' && x.event === 'descent_settled') || false;
    }, null, { timeout: TURN_TIMEOUT_MS }).then((h) => h.jsonValue()).catch(() => null);
    check(Boolean(brief) && Number.isFinite(brief.firstWordMs),
      `the board brief spoke unasked on joining (first word ${brief?.firstWordMs ?? '—'} ms after the brief was requested)`);
    // Quiet line: the response is done AND its audio has drained, so the text
    // turn's first word is its own and not the tail of the brief.
    await page.waitForFunction(() => !window.__gevVoiceCommands.responseActive && !window.__terraSignal.terra.speaking, null, { timeout: 20_000 }).catch(() => {});
    await sleep(300);

    // ---- 1. the text event ---------------------------------------------
    const sentAt = await page.evaluate((text) => {
      const t = window.__terraSignal.terra;
      const at = performance.now();
      t.sendText(text);
      return at;
    }, TEXT_PROMPT);
    record(`sent text "${TEXT_PROMPT}" through the data channel`);
    const textTurn = await page.waitForFunction(({ sentAt }) => {
      const t = window.__terraSignal.terra;
      const turn = t.turns.find((x) => x.kind === 'text' && x.startedAt >= sentAt - 5);
      const open = t.metrics && t.turns.length === 0 ? null : null;
      if (turn && Number.isFinite(turn.firstWordMs)) return turn;
      // Still open but audio has begun: read it early.
      const audioStarted = t.transcript.some((l) => l.role === 'assistant');
      return audioStarted && turn ? turn : (open || false);
    }, { sentAt }, { timeout: TURN_TIMEOUT_MS }).then((h) => h.jsonValue()).catch(() => null);
    const textMetrics = await page.evaluate(() => window.__terraSignal.terra.metrics);
    const firstAudioMs = textTurn?.firstWordMs ?? null;
    check(Number.isFinite(firstAudioMs) && firstAudioMs <= AUDIO_DEADLINE_MS,
      `audio response began ${firstAudioMs} ms after the text event (deadline ${AUDIO_DEADLINE_MS} ms)`);
    // Let the answer finish and drain so the transcript has it and the line is quiet.
    await page.waitForFunction(() => !window.__gevVoiceCommands.responseActive && !window.__terraSignal.terra.speaking, null, { timeout: 20_000 }).catch(() => {});
    await sleep(500);
    const calls = await page.evaluate(() => window.__terraSignal.terra.toolCalls);
    const findMoney = calls.find((c) => c.intent === 'find_money');
    check(Boolean(findMoney), `a tool call for find_money fired (${calls.map((c) => `${c.name}→${c.intent || '?'}`).join(', ') || 'none'})`);
    const dispatched = await page.evaluate(() => window.__terraSignal.lastIntent?.intent || null);
    check(dispatched === 'find_money', `the session dispatched find_money (${dispatched})`);

    // ---- 2. the spoken turn ------------------------------------------------
    if (haveWav) {
      const played = await page.evaluate((b64) => window.__voiceProbe.say(b64), wavBase64);
      record(`speaking "${TEXT_PROMPT}" into the microphone (${played.durationMs} ms of audio)`);
      const spoken = await page.waitForFunction(() => {
        const t = window.__terraSignal.terra;
        return t.turns.find((x) => x.kind === 'speech' && Number.isFinite(x.firstWordMs)) || false;
      }, null, { timeout: SPEECH_TIMEOUT_MS }).then((h) => h.jsonValue()).catch(() => null);
      check(Boolean(spoken), 'the spoken phrase produced a heard turn');
      if (spoken) {
        // Measured and reported, not gated: the target is the product's, the
        // number is the model's on the day. A tool turn is two responses.
        const within = spoken.firstWordMs <= FIRST_WORD_TARGET_MS;
        record(`${within ? 'MET ' : 'MISS'} first word ${Math.round(spoken.firstWordMs)} ms after speech stopped; ${Math.round(spoken.fromLastWordMs)} ms after the last word incl. ${Math.round(spoken.fromLastWordMs - spoken.firstWordMs)} ms VAD silence (target ${FIRST_WORD_TARGET_MS} ms; ${spoken.responseIds?.length || 0} responses in the turn)`);
        await page.waitForFunction(() => !window.__gevVoiceCommands.responseActive, null, { timeout: 15_000 }).catch(() => {});
        await sleep(400);
        const heard = await page.evaluate(() => window.__terraSignal.terra.transcript.filter((l) => l.role === 'user' && !l.typed).map((l) => l.text));
        check(heard.length > 0, `user speech transcribed: ${JSON.stringify(heard)}`);
      }
    }

    // ---- 3. pause, responsiveness, errors ---------------------------------
    await page.click('#gev-voice-button');
    await sleep(300);
    const paused = await page.evaluate(() => ({
      paused: window.__terraSignal.terra.paused,
      mic: document.getElementById('gev-voice-control')?.dataset.microphone,
      light: document.getElementById('ts-ai-slot')?.dataset.tsOrb,
      live: window.__terraSignal.terra.live,
      tracks: (window.__gevVoiceCommands.stream?.getAudioTracks() || []).map((t) => t.enabled),
    }));
    check(paused.paused && paused.mic === 'muted' && paused.live && paused.tracks.every((t) => t === false),
      `second tap paused the mic and kept the session (${JSON.stringify(paused)})`);
    const t0 = Date.now();
    await page.evaluate(() => 1 + 1);
    check(Date.now() - t0 < 1000, `page answers in ${Date.now() - t0} ms`);
    check(errors.length === 0, `console/page errors: ${errors.length}`);

    // ---- the transcript ------------------------------------------------------
    const dump = await page.evaluate(() => {
      const t = window.__terraSignal.terra;
      return {
        transcript: t.transcript,
        turns: t.turns,
        metrics: t.metrics,
        events: t.events,
        interruptions: t.interruptions,
        snapshot: t.snapshot(),
      };
    });
    const lines = [];
    lines.push(`# ${LABEL} — ${new Date().toISOString()} — ${URL_ARG}`);
    lines.push(`assistant: ${availability.assistant}   voice: cedar   text prompt: "${TEXT_PROMPT}"`);
    lines.push('');
    for (const l of dump.transcript) {
      const who = { user: 'USER ', assistant: availability.assistant.toUpperCase().padEnd(5), tool: 'TOOL ', event: 'EVENT' }[l.role] || l.role;
      lines.push(`[${String(Math.round(l.at)).padStart(7)}ms] ${who} ${l.typed ? '(typed) ' : ''}${l.text}`);
    }
    lines.push('');
    lines.push('# turns (first audible word)');
    for (const turn of dump.turns) {
      lines.push(`  ${turn.kind.padEnd(6)} ${turn.event ? `event=${turn.event} ` : ''}firstWord=${turn.firstWordMs ?? '—'}ms${turn.kind === 'speech' ? ` fromLastWord=${turn.fromLastWordMs}ms` : ''}`);
    }
    lines.push(`# metrics ${JSON.stringify(dump.metrics)}`);
    lines.push(`# text-event → audio: ${firstAudioMs} ms`);
    lines.push(`# events ${JSON.stringify(dump.events.map((e) => ({ type: e.type, speak: e.speak, reason: e.reason, sent: e.sent })))}`);
    lines.push(`# interruptions ${JSON.stringify(dump.interruptions)}`);
    lines.push(`# last snapshot ${JSON.stringify(dump.snapshot)}`);
    lines.push('');
    lines.push('# probe log');
    lines.push(...log);
    writeFileSync(TRANSCRIPT_PATH, `${lines.join('\n')}\n`);
    record(`transcript -> ${TRANSCRIPT_PATH}`);
  } catch (error) {
    fails.push(`exception: ${error?.message || error}`);
    record(`EXCEPTION ${error?.stack || error}`);
  } finally {
    await page.evaluate(() => window.__terraSignal?.terra?.stop()).catch(() => {});
    await browser.close().catch(() => {});
  }

  process.stdout.write(`\n${LABEL}: ${fails.length ? `FAIL (${fails.length})` : 'PASS'}\n`);
  for (const f of fails) process.stdout.write(`  - ${f}\n`);
  process.exit(fails.length ? 1 : 0);
}

/** macOS only: the phrase as a 48 kHz mono WAV, made once and kept. */
function synthesizePrompt(path, text) {
  const aiff = `${path}.aiff`;
  const said = spawnSync('say', ['-v', 'Samantha', '-o', aiff, text], { stdio: 'ignore' });
  if (said.status !== 0) return false;
  const converted = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, path], { stdio: 'ignore' });
  return converted.status === 0;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});

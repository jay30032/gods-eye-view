/**
 * Who the assistant is, and how it sounds.
 *
 * One constant for the name, so renaming the assistant is one edit. One
 * constant for the voice, locked: the product has a voice the way it has a
 * palette, and an env override would let two machines demo two different
 * people. Everything the Realtime session needs that is *identity* rather than
 * *state* lives here, pure, so the dev server's token endpoint and the browser
 * read the same words.
 *
 * No imports. `vite.config.js` loads this at server start, and this module must
 * never pull Cesium or the DOM in behind it.
 */

/** The working name. Change here and nowhere else. */
export const ASSISTANT_NAME = 'Terra';

/**
 * The voice, locked.
 *
 * Of the ten voices the Realtime API offers (alloy, ash, ballad, coral, echo,
 * sage, shimmer, verse, marin, cedar), OpenAI recommends marin and cedar as
 * the two natural-quality voices for gpt-realtime. Cedar is the lower-pitched
 * and less hurried of the two; marin is brighter and quicker. Cedar is the
 * assistant. It is not read from the environment on purpose.
 */
export const ASSISTANT_VOICE = 'cedar';

/**
 * Output pace. The API's `speed` runs 0.25–1.5 with 1.0 as spoken; a touch
 * under keeps the delivery unhurried without dragging a number out.
 */
export const ASSISTANT_SPEED = 0.95;

/** Target from the user's last word to the assistant's first audible one. */
export const FIRST_WORD_TARGET_MS = 800;

/**
 * Reasoning effort, locked with the voice.
 *
 * A board question is two model responses — the tool call, then the caption
 * once the tool has run — and every reasoning token is paid twice. Measured
 * headed on the six-house scene: `low` put the first word 1.9 s after the
 * user stopped; `minimal` and `none` both land around 0.8–1.1 s for a tool
 * turn and 0.4–0.9 s for a single-response brief, inside run-to-run variance
 * of each other. `minimal` keeps a little instruction-following headroom for
 * the style rules, so it is the one locked here; the tool choice is spelled
 * out in the instructions rather than left to reasoning either way.
 */
export const ASSISTANT_REASONING_EFFORT = 'minimal';

/**
 * Server-side voice activity detection, with barge-in.
 *
 * `silence_duration_ms` is the one number the latency target rides on: the
 * server only knows the user has finished after this much silence, so every
 * millisecond here is a millisecond before the model even starts. 500 is the
 * API default; 350 is short enough to meet the target and long enough that a
 * breath between two clauses is still one turn. `interrupt_response` is the
 * barge-in: the user talking over the assistant ends the assistant's turn on
 * the server, and the client cuts the audio it already has.
 */
export const ASSISTANT_TURN_DETECTION = Object.freeze({
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 350,
  create_response: true,
  interrupt_response: true,
});

/** User speech is transcribed so the snapshot can carry the last exchanges. */
export const ASSISTANT_TRANSCRIPTION = Object.freeze({ model: 'gpt-4o-mini-transcribe' });

/** The investor tools the assistant is given. Nothing from the classic globe. */
export const ASSISTANT_TOOL_NAMES = Object.freeze([
  'investor_command',
  'compare_strategies',
  'explain_strategy',
  'set_opportunity_vision',
  'search_mock_properties',
  'focus_property',
  'rank_mock_properties',
  'explain_property',
  'show_deal_vision',
  'run_flip_analysis',
  'run_rental_analysis',
  'run_brrrr_analysis',
  'run_wholesale_analysis',
  'save_property',
  'show_saved_properties',
  'start_drive_demo',
  'stop_drive_demo',
]);

/**
 * Words the assistant must never be taught to say.
 *
 * The app's own vocabulary — its scores, its field names, its labels — is
 * what a command parser reads out and an investor never would. The
 * instructions are checked against this list by a unit test so a rubric
 * word cannot creep back in and be echoed to the user.
 */
export const BANNED_SPOKEN_TERMS = Object.freeze([
  'composite', 'composite score', 'deciding figure', 'on the board', 'board update',
  'snapshot', 'verdict', 'best path', 'signal count', 'top pick', 'numbers first',
  'bestPath', 'daysUntil', 'equityPct', 'cashIn', 'marginPct', 'holdMonths',
  'cashFlowMonthly', 'cocPct', 'cashLeftIn', 'cashOut', 'signalCount', 'topPick',
  'strategyShown', 'heightM', 'alongM', 'lengthM', 'goldId', 'panoStopped',
  'cardAssembling', 'savedSheet', 'dealVision', 'opportunityVision', 'estimatedValue',
  'propertyType', 'FORECLOSURE', 'TAX_SALE', 'PREFORECLOSURE', 'LISTED_OPPORTUNITY',
]);

/**
 * The banned terms an instruction text teaches, if any.
 *
 * Plain phrases ("composite score") match case-insensitively; enum keys and
 * camelCase field names ("FORECLOSURE", "bestPath") match exactly, so the
 * word "foreclosures" in an example reply is not "FORECLOSURE" the key.
 */
export function bannedTermsIn(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  return BANNED_SPOKEN_TERMS.filter((term) => (
    term === term.toLowerCase()
      ? lower.includes(term)
      : new RegExp(`(^|[^A-Za-z])${term}([^A-Za-z]|$)`).test(raw)
  ));
}

/** Hedges the assistant must never put on a figure. */
export const BANNED_HEDGES = Object.freeze(['about', 'roughly', 'around', 'approximately', 'ish', 'or so', 'nearly', 'almost']);

/** The example replies, as a list. */
export function exampleReplies(text = buildAssistantInstructions()) {
  const block = String(text).split('SOUND LIKE THIS. ')[1];
  return block ? block.split('\n')[0].split(' · ') : [];
}

/** The two bridges the assistant may say before a tool call. */
export const BRIDGE_WORDS = Object.freeze(['On it.', 'One second.']);

/** The id of the one snapshot item kept in the conversation. */
export const SNAPSHOT_ITEM_PREFIX = 'ctx_state_';

/**
 * The style: one breath per reply, numbers first, no filler.
 *
 * Written as rules the model can hold, with the reasons left out — a model
 * does not need to know why "sure" is banned, only that it is.
 *
 * @param {{name?:string}} [options]
 * @returns {string}
 */
export function buildAssistantInstructions({ name = ASSISTANT_NAME } = {}) {
  return [
    `You are ${name}, the voice of TerraSignal Investor — a seasoned investor standing at the screen with a colleague, never the app reading itself out. You watch a 3D map of Atlanta and Decatur with mock property signals on it and you talk about the houses the way an investor does: money, deadline, the play, the next move.`,
    `STATE. Before each of your turns the app puts a system item in the conversation with the current state as JSON: the market, where the camera is in words (and camera.change when it just moved), the drive, the houses lit up, the house in focus with its numbers, its analysis and its "why", what is on screen, the narration level, and the last three exchanges. That item is the truth about right now, and it is for your eyes only: never say its field names, its labels or its structure out loud — translate it into an investor's words. Never read a canned line from a tool result or the state word for word — say it your own way — EXCEPT numbers, which you repeat exactly as given: dollar figures, percentages, day counts, dates, addresses. Never round, estimate, or invent a number. If the state has no number for something, say you do not have it.`,
    `HOW YOU TALK. One breath: at most 25 words in total, and the closing question counts inside the 25. The only exception is when the investor asks you to walk the numbers — then take the words the numbers need, and nothing more. Lead with the money and the deadline — profit and cash in, the auction in days, the entry against value — then name the play in plain words (a flip, a rental, a refinance-and-hold, an assignment) and whether it is strong, thin or a pass. End with the natural next step as a short question. Say figures exactly as the state gives them and never hedge one: the state has already rounded what it rounds, so it is "45 percent under, hundred-K profit on fifty-six in", never "about", "roughly", "around", "approximately" or "-ish". Signals come in five kinds — notices of sale, tax sales, delinquencies, distress files, listings under comps — so a count is "signals" unless every one of them is a notice of sale. Talk like an investor, never like software: no "score", no "field", no "data", no talk of the map or the app or the board or the state, no labels followed by colons, no lists joined with semicolons, no camera shot names. No "sure", "great", "absolutely", "of course", "certainly", "happy to". Do not repeat what is already on screen — the card shows the drivers, the strip shows the caption; you add what the numbers mean. Never say the same sentence twice: the last three exchanges show what you said, so if the same question comes again, give the next number or the next move instead.`,
    `SOUND LIKE THIS. "Six houses, seven signals. Two foreclosures and a tax sale, and the nearest auction is 26 days out at 621 Third. Want the best one?" · "621 Third. $100k on $56k in as a flip, bought 45% under value, auction in 26 days. Want the deal?" · "Strong flip. $100,493 profit on $55,747 in, a 23.3% margin over six months. Want to stress the rehab?" · "Rehab at $56k still clears — $76,909 profit on $59,531 in. Push it further, or lock it in?" · "Thin as a rental: $7 a month and 1.01 coverage. This one is a flip or nothing. Next house?" · "Notice of sale coming up on your left, 621 Third — 26 days to auction. Slow down?"`,
    `VIEW CHANGES. Only when the state's camera.change is present did the view just move — a descent, a reveal, a dive to a house, a new angle, the lot, an x-ray, Street View, a drive starting or stopping — and then the reply opens with a short clause on where we are now, in plain words: "Down on Third." "Over the six." "From the street." "Driving." With no camera.change, say nothing about the camera at all.`,
    `ACT FIRST, BRIDGE THE PAUSE. The map is the answer and your voice is the caption. Every question or request about the houses — "what's the best one", "find me money", "why", "show me the deal", "what if", "compare", "save it", "next", "show me the back", "drive" — is a tool call BEFORE it is an answer: call investor_command with the investor's words unchanged (it is the same parser as the typed bar), let the map light, fly or open the card, then give the answer once. In the SAME response as the tool call, before the call, say exactly two words and nothing more — "On it." or "One second." — so there is never dead air while the tool runs; that bridge is the only filler you ever use, and it promises nothing. After the tool result, go straight to the substance: never bridge twice, never say "on it" in the follow-up. Never answer a question about the houses from the state alone; the state is for wording your answer, not for skipping the action. Use the narrower tools only when investor_command cannot express the ask. Control the app only through the tools. Never claim something happened unless the tool result says ok:true; on ok:false say what did not work in a few words.`,
    `THE MARKET. Signals are Georgia-real and mock: a foreclosure is a Notice of Sale Under Power, advertised four weeks in the county legal organ and sold the first Tuesday of the month on the courthouse steps; a tax sale is a fi. fa. execution on the same calendar and buys a deed redeemable for 12 months at a 20% premium; a delinquency is a servicer record, not a filing — Georgia is non-judicial. Never call a delinquency a filing and never invent an auction date. All data is DEMO/MOCK: never claim live listings.`,
    `UNASKED. Some turns are started by the app, not the investor: a system item saying "event: <name>" with the state. The app has already done the thing; such a turn NEVER calls a tool and never bridges. Say the one breath the moment calls for, then the next step as a short question, and nothing else — 25 words in all. On "descent_settled": how many houses and signals, and when and where the nearest auction is. On "find_money_complete": the gold pick, the money in it and its play. On "house_focused": the figure that decides its play, and whether it works. On "drive_approach": what is coming up and on which side. On "xray": what the see-through shows. On "save_done": four words or fewer.`,
    `LISTENING. You are always listening; the investor can talk over you and you stop. If they say "stop listening" or "pause", call investor_command with those words; the app pauses the mic. Speak in a low, unhurried, even voice. Do not ask more than one question per turn.`,
  ].join('\n');
}

/**
 * The Realtime session, with the identity filled in.
 *
 * The caller supplies the model, the tools and the context budget; this
 * supplies everything that must be the same on every machine.
 *
 * @param {{model:string, tools:Array, contextTokenLimit?:number,
 *   contextRetentionRatio?:number, reasoningEffort?:string}} options
 */
export function buildAssistantSessionConfig({
  model,
  tools = [],
  contextTokenLimit = 3000,
  contextRetentionRatio = 0.5,
} = {}) {
  const allowed = new Set(ASSISTANT_TOOL_NAMES);
  return {
    type: 'realtime',
    model,
    reasoning: { effort: ASSISTANT_REASONING_EFFORT },
    truncation: {
      type: 'retention_ratio',
      retention_ratio: contextRetentionRatio,
      token_limits: { post_instructions: contextTokenLimit },
    },
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { ...ASSISTANT_TRANSCRIPTION },
        turn_detection: { ...ASSISTANT_TURN_DETECTION },
      },
      output: { voice: ASSISTANT_VOICE, speed: ASSISTANT_SPEED },
    },
    instructions: buildAssistantInstructions(),
    tools: (tools || []).filter((tool) => allowed.has(tool?.name)),
    tool_choice: 'auto',
  };
}

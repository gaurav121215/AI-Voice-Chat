/**
 * Question detection = (1) WHEN: pause-based endpointing (done in session.ts)
 *                      (2) WHAT: cheap heuristics here, runs in <1ms.
 *
 * Why heuristics and not an LLM classifier? An extra LLM round-trip costs 200-500ms,
 * which eats the 3s budget. Heuristics catch the vast majority of interview questions
 * ("what/why/how...", "tell me about...", "walk me through...") and the "?" that
 * Deepgram's smart_format adds. An LLM fallback for ambiguous cases is the next step.
 */
const LEAD = /^(hi|hello|hey|ok|okay|alright|all right|so|well|great|nice|awesome|cool|thanks|thank you|um+|uh+|right|sure|yeah|yes)\b[\s,.!]*/i;

const SMALL_TALK = /^(how are you( doing)?( today)?|how'?s it going|how'?s your day( going)?|nice to meet you|can you hear me|can you see (my|the) screen|is that (ok|okay)|good (morning|afternoon|evening)|(i'?m|i am) (good|fine|great)|let'?s (get started|begin))[\s.,!?]*$/i;

const OPENER = /^(what|why|how|when|where|who|which|can you|could you|would you|will you|do you|did you|have you|are you|were you|is there|tell me|walk me through|describe|explain|talk (me )?(about|through)|give me|share|elaborate|let'?s talk about|i'?d like to (hear|know|understand))\b/i;

const INSIDE = /\b(tell me about|walk me through|describe (a|the|how)|explain (how|why|what|the)|what (is|are|was|were|would)|how (do|did|would|does)|why (do|did|would)|difference between)\b/i;

export interface Detection { isQuestion: boolean; reason: string; text: string }

export function detectQuestion(raw: string): Detection {
  let t = raw.trim();
  let prev: string;
  do { prev = t; t = t.replace(LEAD, '').trim(); } while (t !== prev); // strip "okay, great, ..."

  if (!t) return { isQuestion: false, reason: 'filler', text: raw };
  if (SMALL_TALK.test(t)) return { isQuestion: false, reason: 'small talk', text: t };

  const words = t.split(/\s+/).length;
  if (words < 3) return { isQuestion: false, reason: 'too short', text: t };
  if (/\?\s*$/.test(t)) return { isQuestion: true, reason: 'question mark', text: t };
  if (OPENER.test(t)) return { isQuestion: true, reason: 'question/imperative opener', text: t };
  if (words >= 5 && INSIDE.test(t)) return { isQuestion: true, reason: 'question phrase', text: t };
  return { isQuestion: false, reason: 'statement', text: t };
}

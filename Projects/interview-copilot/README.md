# Interview Copilot (POC)

Listens to the interviewer (browser tab audio or microphone), transcribes in real time, detects
when a question has been asked, and streams a short, speakable answer based on the candidate's
resume and the job description.

**Stack:** Node.js + TypeScript (`ws`) backend, React + TypeScript (Vite) frontend,
Deepgram streaming STT, Groq-hosted LLM through the OpenAI-compatible API.

## 1. Setup and run (clean machine)

**Requirements:** Node.js 20+ and Google Chrome (tab-audio capture works best there).

```bash
git clone <repo-url>
cd interview-copilot

# --- backend ---
cd server
cp .env.example .env          # Windows cmd: copy .env.example .env
# edit .env and fill in the two API keys (see below)
npm install
npm run dev                   # listens on ws://localhost:8080/ws

# --- frontend (new terminal) ---
cd web
npm install
npm run dev                   # http://localhost:5173
```

Open http://localhost:5173 in Chrome, paste a resume and job description, click
**Start listening**. In the picker, choose a tab and tick **Share tab audio** to capture the
interviewer (Meet, Zoom web, YouTube...). Cancel the picker to fall back to the microphone.

### Environment variables (`server/.env`)

Never commit `.env`; it is git-ignored. `server/.env.example` is the template.

| Variable           | Required | Description                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `DEEPGRAM_API_KEY` | yes      | Streaming STT. Free credit at https://console.deepgram.com              |
| `LLM_API_KEY`      | yes      | Groq key (starts with `gsk_`), free tier: https://console.groq.com/keys |
| `LLM_BASE_URL`     | no       | Default `https://api.groq.com/openai/v1`                                |
| `LLM_MODEL`        | no       | Default in code is Groq-dependent; this POC uses `openai/gpt-oss-20b`   |
| `DEEPGRAM_MODEL`   | no       | Default `nova-2`                                                        |
| `PORT`             | no       | Default `8080`. The frontend expects 8080 unless `VITE_WS_URL` is set   |
| `PAUSE_MS`         | no       | Extra silence (ms) before judging a question, default `700`             |

Frontend (optional, `web/.env`): `VITE_WS_URL`, default `ws://localhost:8080/ws`.

Notes: no quotes, spaces or trailing commas around values in `.env`. Restart the server after
editing it. Groq changes its model catalog, so if you get a `404 model not found`, list the
models your key can use (`GET https://api.groq.com/openai/v1/models`) and set `LLM_MODEL`
to one of the text models.

## 2. Architecture and data flow

```
Browser (React)                            Node/TS server                          Providers
---------------                            ------------------------------          ---------
getDisplayMedia (tab) or mic
  -> AudioWorklet: 16 kHz mono PCM16
     in 100 ms chunks
  -> WebSocket (binary frames)  ---------> Session.audio()  ------------------->   Deepgram live
                                                                                      (WebSocket)
Live transcript  <------------------------ transcript events  <-------------------   interim + final
 (interim grey/italic, final solid)
                                           buffer finals
                                           -> pause timer (PAUSE_MS)
                                           -> detectQuestion() heuristics
Detected-question panel <----------------- question event
                                           streamAnswer(question, resume, JD,
                                                        last 6 Q&A)  ----------->   LLM (streaming)
Streaming answer panel <------------------ token events  <-----------------------   tokens
Status + latency metrics <---------------- status / metrics events
```

| Part               | File                     | Responsibility                                                   |
| ------------------ | ------------------------ | ---------------------------------------------------------------- |
| Audio capture      | `web/src/audio.ts`       | Tab/mic capture, downsample to 16 kHz PCM16, 100 ms chunks       |
| UI                 | `web/src/App.tsx`        | Transcript, question, answer panels, Start/Stop, status, metrics |
| WebSocket server   | `server/src/index.ts`    | One `Session` per browser connection                             |
| STT                | `server/src/stt.ts`      | Deepgram live stream, interim/final/utterance-end events         |
| Question detection | `server/src/detector.ts` | Filler/small-talk filtering and question heuristics              |
| LLM                | `server/src/llm.ts`      | System prompt (resume + JD), streaming completion                |
| Orchestration      | `server/src/session.ts`  | Pause timer, barge-in/abort, memory, latency metrics             |

Everything is streamed end to end: audio chunks, STT results, LLM tokens, UI updates.
Nothing waits for a full response.

## 3. Key decisions and trade-offs

**STT: Deepgram live (`nova-2`).** Streaming over WebSocket with interim results and built-in
endpointing, plus a free credit. Trade-off: vendor lock-in and a network hop. Self-hosted
Whisper streaming avoids the vendor but is more work and typically higher latency.

**LLM: Groq (`openai/gpt-oss-20b`) via the OpenAI-compatible API.** Free tier with fast
inference, which matters for the 3 s target. The client is OpenAI-compatible, so switching to
OpenAI, Gemini or a local Ollama model only needs `LLM_BASE_URL`, `LLM_MODEL` and the key.
Trade-offs: gpt-oss models are reasoning models, so I set low reasoning effort and a larger
`max_tokens` to keep first-token latency down without truncating answers; a 20B model is
weaker than larger ones, and answer length is controlled by the prompt rather than the token cap.

**Question detection: pause detection + heuristics (no LLM classifier).**

- _When the question ended:_ after a final transcript, wait `PAUSE_MS` of extra silence
  (300 ms if the text already ends with "?"). Deepgram's `UtteranceEnd` also triggers judging.
  New speech cancels the timer, so a speaker who pauses mid-thought is not cut off for long.
- _Whether it is a question:_ strip leading fillers ("okay, great,"), reject small talk
  ("how are you", "can you hear me"), accept a trailing "?", wh-words, and phrases such as
  "tell me about" and "walk me through".
- _Why:_ it runs in under 1 ms. An LLM classifier adds roughly 200-500 ms, a large share of the
  3 s budget. The cost is lower accuracy on unusual phrasing (see limitations).

**Prompt design.** First person, 3-6 bullets, under 90 words, uses only facts from the
resume (no invented employers or numbers), tailors to the job description, compact STAR for
behavioral questions, tolerates garbled speech-to-text.

**Barge-in.** A newer question aborts the in-flight LLM stream so stale answers are not shown.

**Nice-to-haves (2):** conversation memory (last 6 Q&A turns are sent as chat history, so
follow-ups work) and latency metrics in the UI (detect delay, time to first token,
last-words-to-first-token, full answer time).

## Latency (target: under 3 s from end of question to first token)

Expected budget: Deepgram endpointing ~400 ms + pause wait 300-700 ms + LLM first token.
The UI shows the measured numbers for every question. "Last words to first token" is measured
from the last final transcript, so it excludes the ~400 ms endpointing delay.

| Run | Question                 | Last words to first token | Full answer |
| --- | ------------------------ | ------------------------- | ----------- |
| 1   | _fill in from your demo_ | _ms_                      | _ms_        |
| 2   | _fill in_                | _ms_                      | _ms_        |
| 3   | _fill in_                | _ms_                      | _ms_        |

If a run exceeds 3 s, the levers are: lower `PAUSE_MS`, use a smaller/faster model, keep the
LLM connection warm, or start the LLM speculatively on the interim transcript.

## 4. Known limitations

- Heuristic detection: a question split by a long pause ("Tell me about... [pause] your last
  project") can fire on the first half, and multi-part questions can fire twice.
- Prompts phrased as statements ("I'd love to hear about your role") may be missed.
- No speaker diarization: in mic mode the candidate's own voice can trigger answers. Use tab
  audio for the interviewer.
- English only; STT accuracy drops with accents, crosstalk and poor audio.
- No WebSocket auto-reconnect: if the connection drops, press Start again.
- Resume and job description are capped at 8000 characters each and sent only on Start.
- Rate limiting is limited to input-size caps; no authentication (out of scope).
- The LLM can still hallucinate despite the prompt; answers should be sanity-checked.
- Free-tier rate limits (Groq, Deepgram) apply and would not survive production traffic.

## 5. What I would build next with another week

1. WebSocket auto-reconnect with backoff, and resuming the session.
2. LLM classifier as a fallback for ambiguous detections, plus question-type classification
   (technical / behavioral / HR) with a tailored prompt each.
3. Speculative generation on interim transcripts to cut time to first token.
4. A labelled set of interview transcripts to measure detection precision/recall and answer
   quality, run as regression tests.
5. Speaker diarization so only the interviewer's speech is treated as questions.
6. Answer modes (concise, detailed, STAR) and a simple Docker setup.
7. Per-user rate limits, cost tracking and provider fallbacks.

## Production risks

See `RISKS.md` for the written answer on the top 3 risks and how to address them.

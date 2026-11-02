import { WebSocket } from 'ws';
import { DeepgramStream } from './stt.js';
import { detectQuestion } from './detector.js';
import { streamAnswer, Ctx, Turn } from './llm.js';

const PAUSE_MS = Number(process.env.PAUSE_MS || 700);
const QMARK_PAUSE_MS = 300;   // transcript already ends with "?" -> fire sooner
const MAX_HISTORY = 6;        // conversation memory: last 6 Q&A turns
const MAX_CTX_CHARS = 8000;   // basic abuse guard

type State = 'idle' | 'listening' | 'thinking' | 'answering';

/** One browser connection = one session: STT stream + detector + LLM stream. */
export class Session {
  private stt?: DeepgramStream;
  private ctx: Ctx = { resume: '', jd: '' };
  private buffer = '';          // final transcript text not yet judged
  private lastFinalAt = 0;
  private timer?: NodeJS.Timeout;
  private history: Turn[] = [];
  private abort?: AbortController;

  constructor(private ws: WebSocket) {}

  private send(m: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
  private status(state: State) { this.send({ type: 'status', state }); }

  control(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'start') {
      this.ctx = {
        resume: String(m.resume || '').slice(0, MAX_CTX_CHARS),
        jd: String(m.jd || '').slice(0, MAX_CTX_CHARS),
      };
      this.start();
    } else if (m.type === 'stop') {
      this.stop();
    }
  }

  audio(chunk: Buffer) { this.stt?.send(chunk); }

  private start() {
    this.stop(true);
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) { this.send({ type: 'error', message: 'DEEPGRAM_API_KEY missing on server' }); return; }
    this.stt = new DeepgramStream(key, {
      onTranscript: (t) => this.onTranscript(t),
      onUtteranceEnd: () => { if (this.buffer.trim()) this.evaluate(); },
      onError: (message) => this.send({ type: 'error', message }),
    });
    this.status('listening');
  }

  stop(silent = false) {
    clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = undefined;
    this.stt?.close();
    this.stt = undefined;
    this.buffer = '';
    if (!silent) this.status('idle');
  }

  private onTranscript(t: { text: string; isFinal: boolean; speechFinal: boolean }) {
    if (t.text) {
      this.send({ type: 'transcript', text: t.text, isFinal: t.isFinal });
      clearTimeout(this.timer); // new speech -> speaker is not done yet
    }
    if (t.isFinal && t.text) {
      this.buffer += (this.buffer ? ' ' : '') + t.text;
      this.lastFinalAt = Date.now();
    }
    // Pause-based endpointing: after a final chunk, wait for extra silence before judging.
    if (t.isFinal && this.buffer) {
      const delay = /\?\s*$/.test(this.buffer) ? QMARK_PAUSE_MS : PAUSE_MS;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.evaluate(), delay);
    }
  }

  private evaluate() {
    clearTimeout(this.timer);
    const text = this.buffer.trim();
    this.buffer = '';
    if (!text) return;
    const d = detectQuestion(text);
    this.send({ type: 'detect', text, isQuestion: d.isQuestion, reason: d.reason });
    if (d.isQuestion) void this.answer(d.text, this.lastFinalAt);
  }

  private async answer(question: string, endedAt: number) {
    this.abort?.abort(); // barge-in: a newer question cancels the previous answer
    const ac = new AbortController();
    this.abort = ac;
    const firedAt = Date.now();

    this.send({ type: 'question', text: question, detectMs: firedAt - endedAt });
    this.status('thinking');

    let first = true;
    let full = '';
    try {
      for await (const tok of streamAnswer(question, this.ctx, this.history, ac.signal)) {
        if (ac.signal.aborted) return;
        if (first) {
          first = false;
          const now = Date.now();
          this.status('answering');
          // ttft: question fired -> first token. e2e: last final transcript -> first token
          // (true e2e from the interviewer's last word adds ~400ms Deepgram endpointing)
          this.send({ type: 'metrics', ttftMs: now - firedAt, e2eMs: now - endedAt });
        }
        full += tok;
        this.send({ type: 'token', text: tok });
      }
      this.history.push({ q: question, a: full });
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.send({ type: 'answer_done', totalMs: Date.now() - firedAt });
    } catch (e: any) {
      if (!ac.signal.aborted) this.send({ type: 'error', message: `LLM error: ${e?.message || e}` });
    } finally {
      if (this.abort === ac) {
        this.abort = undefined;
        if (this.stt) this.status('listening');
      }
    }
  }
}

import WebSocket from 'ws';

export interface SttEvents {
  onTranscript: (t: { text: string; isFinal: boolean; speechFinal: boolean }) => void;
  onUtteranceEnd: () => void;
  onError: (msg: string) => void;
}

/** Thin wrapper over Deepgram's live (streaming) endpoint. Input: 16 kHz mono PCM16. */
export class DeepgramStream {
  private ws: WebSocket;
  private open = false;
  private queue: Buffer[] = [];

  constructor(apiKey: string, ev: SttEvents) {
    const qs = new URLSearchParams({
      model: process.env.DEEPGRAM_MODEL || 'nova-2',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: '400',        // Deepgram marks speech_final after 400ms silence
      utterance_end_ms: '1000',  // backup signal: 1s with no words at all
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    this.ws.on('open', () => {
      this.open = true;
      this.queue.forEach((b) => this.ws.send(b));
      this.queue = [];
    });

    this.ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'Results') {
        const text: string = m.channel?.alternatives?.[0]?.transcript ?? '';
        if (text || m.speech_final) {
          ev.onTranscript({ text, isFinal: !!m.is_final, speechFinal: !!m.speech_final });
        }
      } else if (m.type === 'UtteranceEnd') {
        ev.onUtteranceEnd();
      }
    });

    this.ws.on('unexpected-response', (_req, res) =>
      ev.onError(`Deepgram rejected connection (HTTP ${res.statusCode}) - check DEEPGRAM_API_KEY`));
    this.ws.on('error', (e) => ev.onError(`Deepgram error: ${e.message}`));
  }

  send(chunk: Buffer) {
    if (this.open) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk); }
    else if (this.queue.length < 100) this.queue.push(chunk); // buffer ~10s max while connecting
  }

  close() {
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close();
    } catch { /* ignore */ }
  }
}

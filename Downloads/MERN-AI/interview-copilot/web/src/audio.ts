// AudioWorklet: downsample browser audio (44.1/48 kHz) -> 16 kHz mono PCM16, 100ms chunks.
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.pos = 0; this.sum = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) { this.pos -= this.ratio; this.buf.push(this.sum / this.n); this.sum = 0; this.n = 0; }
    }
    if (this.buf.length >= 1600) {
      const out = new Int16Array(this.buf.length);
      for (let i = 0; i < out.length; i++) { const s = Math.max(-1, Math.min(1, this.buf[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = [];
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm16);
`;

export interface Capture {
  source: "tab" | "mic";
  stop: () => void;
}

/** Try tab/system audio first (interviewer's voice on a call); fall back to the microphone. */
export async function startCapture(
  onChunk: (b: ArrayBuffer) => void,
  onEnded: () => void,
): Promise<Capture> {
  let stream: MediaStream;
  let source: "tab" | "mic" = "tab";
  try {
    // stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); // Chrome needs video:true
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio shared (tick "Share tab audio")');
    }
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    source = "mic";
  }

  const ctx = new AudioContext();
  const url = URL.createObjectURL(
    new Blob([WORKLET], { type: "application/javascript" }),
  );
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const src = ctx.createMediaStreamSource(
    new MediaStream(stream.getAudioTracks()),
  );
  const node = new AudioWorkletNode(ctx, "pcm16");
  node.port.onmessage = (e) => onChunk(e.data as ArrayBuffer);
  const mute = ctx.createGain(); // keep graph alive without playing audio back
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  stream.getTracks().forEach((t) => t.addEventListener("ended", onEnded));

  return {
    source,
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      src.disconnect();
      node.disconnect();
      void ctx.close();
    },
  };
}

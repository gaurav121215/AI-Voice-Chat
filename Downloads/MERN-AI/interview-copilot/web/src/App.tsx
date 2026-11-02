import { useEffect, useRef, useState } from "react";
import { startCapture, Capture } from "./audio";

type Status = "idle" | "listening" | "thinking" | "answering";
interface Metrics {
  detectMs?: number;
  ttftMs?: number;
  e2eMs?: number;
  totalMs?: number;
}

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3000/ws";
const LABEL: Record<Status, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  answering: "Answering",
};

export default function App() {
  const [resume, setResume] = useState("");
  const [jd, setJd] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [finals, setFinals] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const [question, setQuestion] = useState("");
  const [ignored, setIgnored] = useState("");
  const [answer, setAnswer] = useState("");
  const [metrics, setMetrics] = useState<Metrics>({});
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const capRef = useRef<Capture | null>(null);
  const tEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tEnd.current?.scrollIntoView({ block: "end" });
  }, [finals, interim]);
  useEffect(() => () => teardown(), []);

  function teardown() {
    capRef.current?.stop();
    capRef.current = null;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "stop" }));
    ws?.close();
  }

  function onMessage(ev: MessageEvent) {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case "status":
        setStatus(m.state);
        break;
      case "transcript":
        if (m.isFinal) {
          setFinals((f) => [...f, m.text]);
          setInterim("");
        } else setInterim(m.text);
        break;
      case "detect":
        if (!m.isQuestion) setIgnored(`Ignored (${m.reason}): "${m.text}"`);
        break;
      case "question":
        setQuestion(m.text);
        setAnswer("");
        setIgnored("");
        setMetrics({ detectMs: m.detectMs });
        break;
      case "token":
        setAnswer((a) => a + m.text);
        break;
      case "metrics":
        setMetrics((x) => ({ ...x, ttftMs: m.ttftMs, e2eMs: m.e2eMs }));
        break;
      case "answer_done":
        setMetrics((x) => ({ ...x, totalMs: m.totalMs }));
        break;
      case "error":
        setError(m.message);
        break;
    }
  }

  async function start() {
    setError("");
    setFinals([]);
    setInterim("");
    setQuestion("");
    setAnswer("");
    setMetrics({});
    setIgnored("");
    try {
      // capture first: getDisplayMedia needs the click's user-activation
      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onmessage = onMessage;
      ws.onclose = () => {
        if (wsRef.current === ws) {
          setError("Connection to backend lost");
          stop();
        }
      };
      const opened = new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("Cannot reach backend at " + WS_URL));
      });
      const cap = await startCapture(
        (buf) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(buf);
        },
        () => stop(),
      );
      capRef.current = cap;
      setSource(cap.source === "tab" ? "tab audio" : "microphone");
      await opened;
      ws.send(JSON.stringify({ type: "start", resume, jd }));
    } catch (e: any) {
      setError(e?.message || String(e));
      teardown();
      setStatus("idle");
    }
  }

  function stop() {
    teardown();
    setStatus("idle");
    setInterim("");
  }

  const running = status !== "idle";
  const ms = (n?: number) => (n === undefined ? "-" : `${n} ms`);

  return (
    <div className="app">
      <header className="bar">
        <h1>Interview Copilot</h1>
        <div className={`status s-${status}`} role="status">
          <i />
          {LABEL[status]}
          {running && source ? ` · ${source}` : ""}
        </div>
        {running ? (
          <button className="btn stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="btn go" onClick={start}>
            Start listening
          </button>
        )}
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <main className="grid">
        <section className="panel ctx">
          <h2>Your context</h2>
          <label>
            Resume or summary
            <textarea
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              disabled={running}
              placeholder="Paste your resume or a short professional summary"
            />
          </label>
          <label>
            Job description
            <textarea
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              disabled={running}
              placeholder="Paste the job description"
            />
          </label>
          <p className="hint">
            Context is sent when you press Start. Pick a tab and tick "Share tab
            audio" to capture the interviewer, or cancel the picker to use your
            microphone.
          </p>
        </section>

        <section className="panel tr">
          <h2>Live transcript</h2>
          <div className="scroll transcript">
            {finals.length === 0 && !interim && (
              <p className="empty">
                Transcript appears here once someone speaks.
              </p>
            )}
            {finals.map((t, i) => (
              <p key={i} className="final">
                {t}
              </p>
            ))}
            {interim && <p className="interim">{interim}</p>}
            <div ref={tEnd} />
          </div>
        </section>

        <section className="panel qs">
          <h2>Detected question</h2>
          {question ? (
            <p className="question">{question}</p>
          ) : (
            <p className="empty">Waiting for a question.</p>
          )}
          {ignored && <p className="ignored">{ignored}</p>}
          <dl className="metrics">
            <div>
              <dt>Detect delay</dt>
              <dd>{ms(metrics.detectMs)}</dd>
            </div>
            <div>
              <dt>First token</dt>
              <dd>{ms(metrics.ttftMs)}</dd>
            </div>
            <div>
              <dt>Last words to first token</dt>
              <dd>{ms(metrics.e2eMs)}</dd>
            </div>
            <div>
              <dt>Full answer</dt>
              <dd>{ms(metrics.totalMs)}</dd>
            </div>
          </dl>
        </section>

        <section className="panel answer">
          <h2>Suggested answer</h2>
          {answer ? (
            <div className="answer-text">
              {answer}
              {status === "answering" && <span className="caret" />}
            </div>
          ) : (
            <p className="empty">
              {status === "thinking" ? "Thinking…" : "The answer streams here."}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

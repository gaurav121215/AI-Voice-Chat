import OpenAI from "openai";

export interface Ctx {
  resume: string;
  jd: string;
}
export interface Turn {
  q: string;
  a: string;
}

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY || "missing",
  baseURL: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
});
const MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

function system(ctx: Ctx) {
  return `You are a real-time interview copilot. The user is the CANDIDATE; you write what they can say out loud right now.

RULES
- Speak as the candidate, first person ("I...").
- Output 3-6 bullets, each starting with "- ", each under 16 words. TOTAL under 90 words. No intro, no outro, no markdown besides "- ".
- Use ONLY facts from the resume/summary below. Never invent employers, numbers or tools. If something is missing, give a safe generic answer.
- Tailor to the job description when relevant (e.g. "why this role", "why should we hire you").
- "Tell me about yourself": present role -> key past wins -> why this role.
- Behavioral questions: compact STAR (Situation, Task, Action, Result) in bullets.
- Technical questions: direct answer first, then one trade-off or example.
- The question comes from speech-to-text and may be slightly garbled; answer the most likely intent.
- Earlier Q&A is in the chat history; use it for follow-ups ("can you expand on that?").

RESUME / SUMMARY
${ctx.resume.trim() || "(not provided)"}

JOB DESCRIPTION
${ctx.jd.trim() || "(not provided)"}`;
}

export async function* streamAnswer(
  question: string,
  ctx: Ctx,
  history: Turn[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system(ctx) },
    ...history.flatMap((t): OpenAI.Chat.ChatCompletionMessageParam[] => [
      { role: "user", content: t.q },
      { role: "assistant", content: t.a },
    ]),
    { role: "user", content: question },
  ];
  // const stream = await client.chat.completions.create(
  //   { model: MODEL, messages, stream: true, temperature: 0.4, max_tokens: 220 },
  //   { signal },
  // );
  const stream = await client.chat.completions.create(
    {
      model: MODEL,
      messages,
      stream: true,
      temperature: 0.4,
      max_tokens: 500,
      ...(MODEL.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    { signal },
  );
  for await (const chunk of stream) {
    const tok = chunk.choices[0]?.delta?.content;
    if (tok) yield tok;
  }
}

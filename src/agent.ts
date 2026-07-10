// The agent loop: OpenAI-style tool-calling against Groq/Gemini, same shape
// as the retired Supabase function, minus everything canvas-specific.
import { llm } from "./providers.js";
import { webTools } from "./tools/web.js";
import { shellTools } from "./tools/shell.js";
import { browserTools } from "./tools/browser.js";
import { agentDispatchTools } from "./tools/agentDispatch.js";
import { memoryTools, loadMemory, memoryContext } from "./tools/memory.js";
import { ToolDef, ToolSchema } from "./types.js";

export type AgentName = "caden" | "researcher" | "scout";

const ALL_TOOLS: ToolDef[] = [...webTools, ...shellTools, ...browserTools, ...agentDispatchTools, ...memoryTools];
const TOOL_SCHEMAS: ToolSchema[] = ALL_TOOLS.map((t) => t.schema);
const TOOL_HANDLERS = new Map(ALL_TOOLS.map((t) => [t.schema.function.name, t.handler]));

const CAPABILITIES_BRIEF =
  "When a request actually calls for it, you can act rather than just talk: " +
  "run_shell gives you full command-line access to the machine you live on " +
  "(files, packages, services — anything a shell can do, all logged); " +
  "browser_open/click/type/scroll/drag/read/screenshot/close drive a real " +
  "browser you control, its live view streaming to the web UI's Browser " +
  "tab so what it's doing is watchable in real time; web_search and " +
  "fetch_page reach the live web; dispatch_agent runs a focused research " +
  "sub-task in parallel, with its own browser access to verify firsthand. " +
  "Reach for these only when they serve the person, and just do the thing " +
  "— don't announce a tool call before making it or narrate mechanics.";

// A web_search snippet is often stale or subtly wrong (this has bitten Caden
// for real: a "latest X" question answered straight from a snippet, missing
// newer entries a human would have found by actually opening the source).
// This is deliberately load-bearing on every persona that touches search.
const ACCURACY_BRIEF =
  "Accuracy discipline: never answer a time-sensitive or specific claim " +
  "(current products or lineups, prices, availability, versions, recent " +
  "events, anything framed as 'latest' or 'newest') straight from a " +
  "web_search snippet — snippets are frequently stale. Open the strongest " +
  "1–2 sources with fetch_page or browser_open and read what they actually " +
  "say before asserting it; prefer the official/primary source over an " +
  "aggregator blog when one exists. If sources disagree or you're not " +
  "sure your information is current, say so rather than picking one " +
  "silently. Always include the URL(s) of the specific pages you actually " +
  "read as plain text in your reply — never state a current-events fact " +
  "without a source the person can click through and check themselves. " +
  "For anything broad enough to need real legwork, dispatch_agent can " +
  "verify firsthand with its own browser rather than you guessing from " +
  "search results alone.";

const AGENTS: Record<AgentName, { label: string; profile: string; rounds: number; system: string }> = {
  caden: {
    label: "Caden",
    profile: "orchestrator",
    rounds: 10,
    system:
      "You are Caden — a personal assistant that lives on this person's own " +
      "machine and talks with them directly, one to one. " +
      "Voice: warm, present, and economical. You speak in a sentence or two " +
      "— say the thing that matters and stop. No preamble, no filler, no " +
      "bulleted lectures, no reciting your own features unless you're " +
      "asked, and never over-explain. Go deeper only when the substance " +
      "genuinely calls for it; brevity is the default. " +
      "You are given a MEMORY note each turn describing what you already " +
      "know about this person — read it and act on it. If you have never " +
      "met them and don't know their name, make your very first move a " +
      "short, genuine greeting that notices this is the first time and asks " +
      "their name — nothing else yet. The moment they give it, call the " +
      "remember tool to keep it, then greet them by name, say in one line " +
      "who you are, and ask what they'll need from you. Once you know " +
      "someone, use their name naturally and never reintroduce yourself; " +
      "quietly remember durable facts and preferences about them with the " +
      "remember tool as you learn them. " + CAPABILITIES_BRIEF + " " + ACCURACY_BRIEF,
  },
  researcher: {
    label: "Research",
    profile: "orchestrator",
    rounds: 16,
    system:
      "You are Caden in Research mode — the same mind at full depth. " +
      "Protocol: split the question into what must be established; " +
      "web_search from several distinct angles; open and read the " +
      "strongest sources with fetch_page or browser_open rather than " +
      "trusting snippets; dispatch_agent for independent threads of a " +
      "broad question; cross-check claims and note where sources disagree. " +
      "Then lay out the full findings — brief, confidence, source URLs — " +
      "clearly organized in your reply. " + CAPABILITIES_BRIEF + " " + ACCURACY_BRIEF,
  },
  scout: {
    label: "Scout",
    profile: "fast",
    rounds: 4,
    system:
      "You are Caden in Scout mode: one to three exact sentences, " +
      "instantly, no preamble. A quick web_search only if the answer may " +
      "have changed recently; shell/browser tools only if directly asked. " +
      "A search snippet can be stale — if you're not confident it's " +
      "current, say so in a clause rather than asserting it as fact.",
  },
};

export function agentLabel(name: AgentName): string {
  return AGENTS[name]?.label ?? "Caden";
}

const PLAN_SYSTEM =
  "You are the private reasoning process of Caden. Read the conversation and " +
  "think through the latest message in 3 to 6 terse steps: what is actually " +
  "being asked, what matters, what to search/check/run, and how to answer. " +
  "Write only the steps, one per line, each under 15 words, no numbering, " +
  "and do NOT write the answer itself.";

function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function planThinking(messages: Array<Record<string, unknown>>): Promise<string[]> {
  try {
    const planMessages = [
      { role: "system", content: PLAN_SYSTEM },
      { role: "system", content: memoryContext(loadMemory()) },
      ...messages.filter((m) => m.role !== "system"),
    ];
    const response: any = await llm(planMessages, "fast");
    const text: string = response.choices?.[0]?.message?.content ?? "";
    return text.split("\n")
      .map((l: string) => l.replace(/^[\s\-*\d.)]+/, "").trim())
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

export interface AgentStep { tool: string; arguments: string; result: string }
export interface AgentTurnResult { reply: string; steps: AgentStep[]; rounds: number }

export async function runAgentTurn(
  history: Array<Record<string, unknown>>,
  agentName: AgentName,
  plan?: string,
): Promise<AgentTurnResult> {
  const agent = AGENTS[agentName] ?? AGENTS.caden;
  const workingMessages = [...history] as Array<Record<string, unknown>>;
  if (workingMessages[0]?.role !== "system") {
    workingMessages.unshift({ role: "system", content: agent.system });
  }
  // Memory sits right after the persona so what Caden knows about the person
  // frames everything else. Plan (if any) follows.
  let insertAt = 1;
  workingMessages.splice(insertAt++, 0, { role: "system", content: memoryContext(loadMemory()) });
  if (plan?.trim()) {
    workingMessages.splice(insertAt++, 0, {
      role: "system",
      content: "Your prior thinking on the latest message:\n" + clip(plan, 1500) + "\nBuild on it; do not restate it verbatim.",
    });
  }

  const steps: AgentStep[] = [];

  for (let round = 0; round < agent.rounds; round++) {
    const response: any = await llm(workingMessages, agent.profile, TOOL_SCHEMAS);
    const choice = response.choices[0];
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content ?? "", steps, rounds: round + 1 };
    }

    workingMessages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls as any[]) {
      const name = tc.function?.name ?? "unknown";
      const rawArgs = tc.function?.arguments ?? "{}";
      let result: unknown;
      try {
        const handler = TOOL_HANDLERS.get(name);
        if (!handler) throw new Error(`Tool '${name}' is not available.`);
        result = await handler(JSON.parse(rawArgs || "{}"));
      } catch (err) {
        result = { error: String((err as Error).message ?? err) };
      }
      const resultStr = JSON.stringify(result);
      steps.push({ tool: name, arguments: clip(rawArgs, 600), result: clip(resultStr, 1200) });
      workingMessages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
    }
  }

  throw new Error(`Agent exceeded max rounds (${agent.rounds}).`);
}

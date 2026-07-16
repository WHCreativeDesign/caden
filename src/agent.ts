// The agent loop: OpenAI-style tool-calling against Groq/Gemini, same shape
// as the retired Supabase function, minus everything canvas-specific.
import { llm } from "./providers.js";
import { webTools } from "./tools/web.js";
import { shellTools } from "./tools/shell.js";
import { browserTools } from "./tools/browser.js";
import { desktopTools } from "./tools/desktop.js";
import { agentDispatchTools } from "./tools/agentDispatch.js";
import { memoryTools, loadMemory, memoryContext } from "./tools/memory.js";
import { systemTools } from "./tools/system.js";
import { weatherTools } from "./tools/weather.js";
import { reminderTools, pendingNotifications, acknowledgeReminders } from "./tools/reminders.js";
import { MAINFRAME_VERSION } from "./version.js";
import { triggerSfx } from "./sfx.js";
import { ToolDef, ToolSchema } from "./types.js";

export type AgentName = "caden" | "researcher" | "scout";

const ALL_TOOLS: ToolDef[] = [
  ...webTools, ...shellTools, ...browserTools, ...desktopTools, ...agentDispatchTools,
  ...memoryTools, ...systemTools, ...weatherTools, ...reminderTools,
];
const TOOL_SCHEMAS: ToolSchema[] = ALL_TOOLS.map((t) => t.schema);
const TOOL_HANDLERS = new Map(ALL_TOOLS.map((t) => [t.schema.function.name, t.handler]));

// Tools whose result carries a screenshot the model should actually see —
// runAgentTurn forwards these as a real image content part afterward instead
// of leaving a giant inert base64 blob sitting in the tool result.
const IMAGE_RESULT_TOOLS = new Set(["screenshot_desktop", "browser_screenshot"]);

// This Pi is Caden's own machine, not a device it's a guest on — it should
// never hedge or ask permission before looking at its own screen. This
// exists because it did exactly that for real: asked to check what's on
// screen, it tried a few missing CLI tools and then just gave up and said it
// couldn't tell, instead of using screenshot_desktop or fixing the gap. In
// that same episode it also tried `mainframe -v`, a command that doesn't
// exist, trying to guess its own version — MAINFRAME_VERSION below means it
// never has to guess that again.
const OWN_MACHINE_BRIEF =
  "This Raspberry Pi is your own personal computer — not a device you're a " +
  "guest on. You have full, unrestricted control over the whole machine; " +
  "that's the deliberate governance model here (total access, backed by an " +
  "audit log, not a curated allowlist). When asked what's on screen, what's " +
  "running, or to check something visually, just look: screenshot_desktop " +
  "shows you the entire desktop — local or a remote session (e.g. " +
  "Raspberry Pi Connect) — and run_shell can inspect processes or install a " +
  "missing tool on the spot. Never respond that you 'can't tell' or don't " +
  "have access — you do; use the tool or fix the gap and try again. " +
  `Your own build identifier — your mainframe version — is v${MAINFRAME_VERSION}; ` +
  "if asked what version you're running, just say this rather than guessing " +
  "or trying to run a command to check it.";

const CAPABILITIES_BRIEF =
  "When a request actually calls for it, you can act rather than just talk: " +
  "run_shell gives you full command-line access to the machine you live on " +
  "(files, packages, services — anything a shell can do, all logged); " +
  "browser_open/click/type/scroll/drag/read/screenshot/close drive a real " +
  "browser you control, its live view streaming to the web UI's Browser " +
  "tab so what it's doing is watchable in real time; screenshot_desktop " +
  "captures your ENTIRE desktop — every window, not just a browser tab, " +
  "local or remote session alike; web_search and fetch_page reach the live " +
  "web; dispatch_agent runs a focused research sub-task in parallel, with " +
  "its own browser access to verify firsthand; system_status reports your " +
  "own CPU temperature, memory, disk, and load, so you can actually answer " +
  "how you're doing instead of guessing; get_weather gives live conditions " +
  "for a place, no extra verification needed since it's already a live " +
  "source; set_reminder/list_reminders/cancel_reminder let you follow up on " +
  "something later, unprompted — even in a future conversation, and as a " +
  "live notification if someone's watching. Images the person sends you, " +
  "and screenshots you take yourself, are shown to you directly afterward — " +
  "you actually see them, not just a note that a file exists. Reach for " +
  "these only when they serve the person, and just do the thing — don't " +
  "announce a tool call before making it or narrate mechanics.";

// Reminders that fired since the last turn get folded in here, the same
// pattern as memoryContext below — read it, mention it naturally, don't
// recite it as a system notification. See tools/reminders.ts for how firing
// and the live toast/SFX work independently of this.
function reminderContext(): string | null {
  const due = pendingNotifications();
  if (!due.length) return null;
  acknowledgeReminders(due.map((r) => r.id));
  const lines = due.map((r) => `- ${r.message} (was due ${new Date(r.due_at).toLocaleString()})`);
  return "REMINDERS: The following came due since you last spoke — bring them up naturally, don't just recite this list:\n" + lines.join("\n");
}

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
      "remember tool as you learn them. " + OWN_MACHINE_BRIEF + " " + CAPABILITIES_BRIEF + " " + ACCURACY_BRIEF,
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
      "clearly organized in your reply. " + OWN_MACHINE_BRIEF + " " + CAPABILITIES_BRIEF + " " + ACCURACY_BRIEF,
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

function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export interface AgentStep { tool: string; arguments: string; result: string }
export interface AgentTurnResult { reply: string; steps: AgentStep[]; rounds: number }

export async function runAgentTurn(
  history: Array<Record<string, unknown>>,
  agentName: AgentName,
): Promise<AgentTurnResult> {
  const agent = AGENTS[agentName] ?? AGENTS.caden;
  const workingMessages = [...history] as Array<Record<string, unknown>>;
  if (workingMessages[0]?.role !== "system") {
    workingMessages.unshift({ role: "system", content: agent.system });
  }
  // Memory sits right after the persona so what Caden knows about the person
  // frames everything else, then any reminders that just came due.
  let insertAt = 1;
  workingMessages.splice(insertAt++, 0, { role: "system", content: memoryContext(loadMemory()) });
  const reminders = reminderContext();
  if (reminders) workingMessages.splice(insertAt++, 0, { role: "system", content: reminders });

  const steps: AgentStep[] = [];
  let announcedThinking = false;

  for (let round = 0; round < agent.rounds; round++) {
    const response: any = await llm(workingMessages, agent.profile, TOOL_SCHEMAS);
    const choice = response.choices[0];
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content ?? "", steps, rounds: round + 1 };
    }

    // Once per turn, the moment real tool work starts — an audible "on it"
    // distinct from "sent", since a turn that needs several rounds of tool
    // calls (browsing, research) can otherwise go quiet for a while.
    if (!announcedThinking) { triggerSfx("thinking"); announcedThinking = true; }

    workingMessages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

    // Screenshots collected this round get forwarded as real image content
    // after all tool results are in (see below) so the model actually sees
    // them, instead of a multi-hundred-KB base64 string sitting inert in a
    // tool message that a text-only model can't interpret anyway.
    const pendingImages: Array<{ mime: string; base64: string; source: string }> = [];

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

      let resultForModel = result;
      if (IMAGE_RESULT_TOOLS.has(name) && result && typeof result === "object" && "image_base64" in (result as any)) {
        const { image_base64, mime, ...rest } = result as any;
        pendingImages.push({ mime: mime || "image/jpeg", base64: image_base64, source: name });
        resultForModel = { ...rest, ok: true, note: "captured — the image follows as an attachment you can see" };
      }

      const resultStr = JSON.stringify(resultForModel);
      steps.push({ tool: name, arguments: clip(rawArgs, 600), result: clip(resultStr, 1200) });
      workingMessages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
    }

    for (const img of pendingImages) {
      workingMessages.push({
        role: "user",
        content: [
          { type: "text", text: `(image from ${img.source})` },
          { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } },
        ],
      });
    }
  }

  throw new Error(`Agent exceeded max rounds (${agent.rounds}).`);
}

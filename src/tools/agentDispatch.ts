// Parallel research dispatch — a bounded sub-agent with real web AND
// browser tools, so it can actually verify a claim (open the source page,
// read it, scroll if the relevant bit is below the fold) rather than
// reporting a search-result snippet as fact. There's no canvas anymore to
// show it working, so it's just a tool the parent model can use for
// independent threads of a broader question.
import { llm } from "../providers.js";
import { webTools } from "./web.js";
import { browserTools } from "./browser.js";
import { schema, ToolDef } from "../types.js";

const SUB_AGENT_SYSTEM =
  "You are a focused research agent working inside Caden. Complete your " +
  "task using web_search, fetch_page, and the browser_* tools. " +
  "Discipline: a search snippet is a lead, not a fact — for anything " +
  "time-sensitive or specific (current products, prices, availability, " +
  "recent events, 'latest' anything), open the strongest source with " +
  "browser_open (or fetch_page) and actually read it — browser_scroll if " +
  "the relevant part is further down the page — before asserting it. " +
  "Prefer official/primary sources over aggregator blogs when they exist. " +
  "If two sources disagree, say so rather than picking one silently. " +
  "Return a tight findings brief in plain text that states what you " +
  "verified and lists the exact URLs of the pages you actually opened and " +
  "read, not just search-result links you skimmed. Be factual and " +
  "efficient — you have a limited number of steps.";

const subTools: ToolDef[] = [...webTools, ...browserTools];
const subSchemas = subTools.map((t) => t.schema);
const subHandlers = new Map(subTools.map((t) => [t.schema.function.name, t.handler]));

async function runSubAgent(task: string): Promise<string> {
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: SUB_AGENT_SYSTEM },
    { role: "user", content: task },
  ];
  for (let round = 0; round < 8; round++) {
    const response: any = await llm(msgs, "orchestrator", subSchemas);
    const msg = response.choices[0].message;
    if (!msg.tool_calls?.length) return msg.content ?? "";
    msgs.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls as any[]) {
      let result: unknown;
      try {
        const handler = subHandlers.get(tc.function?.name);
        if (!handler) throw new Error(`unknown tool ${tc.function?.name}`);
        result = await handler(JSON.parse(tc.function?.arguments || "{}"));
      } catch (err) {
        result = { error: String((err as Error).message ?? err) };
      }
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return "(agent ran out of rounds before reporting)";
}

export const agentDispatchTools: ToolDef[] = [
  {
    schema: schema(
      "dispatch_agent",
      "Dispatch a focused research sub-agent to investigate a specific question in parallel. It has web search AND real browser control (open pages, scroll, read, screenshot) so it can actually verify claims on the live page rather than trusting a search snippet — use it for anything time-sensitive or when accuracy matters. Returns a findings brief with the exact source URLs it verified.",
      {
        task: { type: "string", description: "the specific question to investigate" },
      },
      ["task"],
    ),
    handler: async (args) => ({ findings: await runSubAgent(String(args.task ?? "")) }),
  },
];

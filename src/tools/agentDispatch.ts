// Optional parallel research dispatch — a bounded sub-agent that only gets
// the web tools (no shell, no browser) and reports findings back as text.
// There's no canvas anymore to show it working, so it's just a tool the
// parent model can use for independent threads of a broader question.
import { llm } from "../providers.js";
import { webTools } from "./web.js";
import { schema, ToolDef } from "../types.js";

const SUB_AGENT_SYSTEM =
  "You are a focused research agent working inside Caden. Complete your task " +
  "using web_search and fetch_page — search from more than one angle, read " +
  "the strongest sources, and return a tight findings brief in plain text " +
  "with the source URLs you relied on. Be factual and efficient.";

const subSchemas = webTools.map((t) => t.schema);
const subHandlers = new Map(webTools.map((t) => [t.schema.function.name, t.handler]));

async function runSubAgent(task: string): Promise<string> {
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: SUB_AGENT_SYSTEM },
    { role: "user", content: task },
  ];
  for (let round = 0; round < 5; round++) {
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
      "Dispatch a focused research sub-agent to investigate a specific question in parallel, using web search only. Returns a findings brief with sources. Use for independent threads of a broader question.",
      {
        task: { type: "string", description: "the specific question to investigate" },
      },
      ["task"],
    ),
    handler: async (args) => ({ findings: await runSubAgent(String(args.task ?? "")) }),
  },
];

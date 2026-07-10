export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  };
}

export interface ToolDef {
  schema: ToolSchema;
  handler: (args: any) => Promise<unknown>;
}

export function schema(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSchema {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

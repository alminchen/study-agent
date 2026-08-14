export interface ToolDefinition {
  name: string;
  schema: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: readonly string[];
      };
    };
  };
  run: (rawArguments: string) => unknown;
}

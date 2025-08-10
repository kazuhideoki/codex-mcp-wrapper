/*
 Heuristic JSON Schema normalizer for Codex CLI compatibility.
 - Convert type "integer" -> "number"
 - Ensure missing "type" is filled with a reasonable default
 - Recurse through common schema containers
*/

type Json = any;

export function normalizeToolsListResult(result: Json, debug = false): Json {
  try {
    if (!result || typeof result !== 'object') return result;
    if (Array.isArray(result.tools)) {
      for (const tool of result.tools) {
        if (!tool || typeof tool !== 'object') continue;

        // Map snake_case -> camelCase for Codex compatibility
        if (tool.input_schema && !tool.inputSchema) {
          tool.inputSchema = tool.input_schema;
        }
        if (tool.output_schema && !tool.outputSchema) {
          tool.outputSchema = tool.output_schema;
        }

        // Legacy: parameters -> inputSchema
        if (tool.parameters && !tool.inputSchema && !tool.input_schema) {
          tool.inputSchema = normalizeSchema(tool.parameters, debug);
          delete tool.parameters;
        }

        // Normalize schemas if present
        if (tool.inputSchema) tool.inputSchema = normalizeSchema(tool.inputSchema, debug);
        if (tool.outputSchema) tool.outputSchema = normalizeSchema(tool.outputSchema, debug);
      }
    }
  } catch (e) {
    if (debug) console.error(`[mcp-wrapper] normalizeToolsListResult error: ${String(e)}`);
  }
  return result;
}

export function normalizeSchema(schema: Json, debug = false): Json {
  const seen = new WeakSet();
  function visit(node: Json, path: string): void {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    // Fix type
    if (node.type === 'integer') {
      node.type = 'number';
      if (debug) console.error(`[mcp-wrapper] ${path}.type: integer -> number`);
    } else if (Array.isArray(node.type)) {
      const before = node.type.slice();
      node.type = node.type.map((t: any) => (t === 'integer' ? 'number' : t));
      if (debug && JSON.stringify(before) !== JSON.stringify(node.type)) {
        console.error(`[mcp-wrapper] ${path}.type: replaced integer in union`);
      }
      // If somehow empty array, default to string
      if (node.type.length === 0) node.type = 'string';
    } else if (node.type == null) {
      const inferred = inferType(node);
      if (inferred) {
        node.type = inferred;
        if (debug) console.error(`[mcp-wrapper] ${path}.type: added default '${inferred}'`);
      }
    }

    // Recurse common containers
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, v] of Object.entries(node.properties)) {
        visit(v, `${path}.properties.${k}`);
      }
    }
    if (node.patternProperties && typeof node.patternProperties === 'object') {
      for (const [k, v] of Object.entries(node.patternProperties)) {
        visit(v, `${path}.patternProperties.${k}`);
      }
    }
    if (node.items != null) {
      if (Array.isArray(node.items)) {
        node.items.forEach((it: any, i: number) => visit(it, `${path}.items[${i}]`));
      } else {
        visit(node.items, `${path}.items`);
      }
    }
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((s: any, i: number) => visit(s, `${path}.anyOf[${i}]`));
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((s: any, i: number) => visit(s, `${path}.oneOf[${i}]`));
    if (Array.isArray(node.allOf)) node.allOf.forEach((s: any, i: number) => visit(s, `${path}.allOf[${i}]`));
    if (node.$defs && typeof node.$defs === 'object') {
      for (const [k, v] of Object.entries(node.$defs)) visit(v, `${path}.$defs.${k}`);
    }
    if (node.definitions && typeof node.definitions === 'object') {
      for (const [k, v] of Object.entries(node.definitions)) visit(v, `${path}.definitions.${k}`);
    }
  }

  const clone = deepClone(schema);
  visit(clone, '$');
  return clone;
}

function inferType(node: any): string | undefined {
  // Simple heuristics to satisfy strict consumers
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const t = typeof node.enum[0];
    if (t === 'string' || t === 'number' || t === 'boolean') return t;
    if (t === 'object' && !Array.isArray(node.enum[0])) return 'object';
    if (Array.isArray(node.enum[0])) return 'array';
  }
  if (node.properties && typeof node.properties === 'object') return 'object';
  if (node.items != null) return 'array';
  // When ambiguous, default to string
  return 'string';
}

function deepClone<T>(v: T): T {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

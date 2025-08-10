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
    // Do not treat raw arrays as schema objects themselves. Caller traverses
    // into array-typed containers (anyOf/oneOf/allOf/items) explicitly.
    if (Array.isArray(node)) return;
    if (seen.has(node)) return;
    seen.add(node);

    // Fix type
    if (node.type === 'integer') {
      node.type = 'number';
      if (debug) console.error(`[mcp-wrapper] ${path}.type: integer -> number`);
    } else if (Array.isArray(node.type)) {
      // Many consumers (incl. OpenAI tools) expect a single string,
      // not a union. Collapse union types heuristically.
      const before = node.type.slice();
      const collapsed = collapseTypeUnion(before, node);
      if (collapsed) {
        node.type = collapsed;
        if (debug) console.error(`[mcp-wrapper] ${path}.type: union ${JSON.stringify(before)} -> '${collapsed}'`);
      } else {
        // Fallback when nothing usable: default to string
        node.type = 'string';
        if (debug) console.error(`[mcp-wrapper] ${path}.type: union ${JSON.stringify(before)} -> 'string' (fallback)`);
      }
    } else if (node.type == null) {
      // Avoid forcing a type when $ref is present; many validators dislike mixing them.
      if (!node.$ref) {
        const inferred = inferType(node);
        if (inferred) {
          node.type = inferred;
          if (debug) console.error(`[mcp-wrapper] ${path}.type: added default '${inferred}'`);
        }
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
    // additionalProperties can be boolean or schema
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      visit(node.additionalProperties, `${path}.additionalProperties`);
    }
    // propertyNames is a schema
    if (node.propertyNames && typeof node.propertyNames === 'object') {
      visit(node.propertyNames, `${path}.propertyNames`);
    }
    // dependentSchemas is a map of schemas
    if (node.dependentSchemas && typeof node.dependentSchemas === 'object') {
      for (const [k, v] of Object.entries(node.dependentSchemas)) visit(v, `${path}.dependentSchemas.${k}`);
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

    // Sanitize 'required' to be an array of strings if present
    if (node.required != null) {
      if (!Array.isArray(node.required)) {
        // Drop invalid shapes to avoid strict parsers choking
        delete node.required;
        if (debug) console.error(`[mcp-wrapper] ${path}.required: dropped non-array shape`);
      } else {
        const filtered = (node.required as any[]).filter((x) => typeof x === 'string');
        if (filtered.length !== node.required.length) {
          node.required = filtered;
          if (debug) console.error(`[mcp-wrapper] ${path}.required: filtered invalid entries`);
        }
      }
    }
  }

  const clone = deepClone(schema);
  visit(clone, '$');
  return clone;
}

function collapseTypeUnion(types: any[], node: any): string | undefined {
  // Map 'integer' -> 'number', drop nullish-like entries, de-duplicate
  const normalized = Array.from(
    new Set(
      types
        .filter((t) => typeof t === 'string')
        .map((t: string) => (t === 'integer' ? 'number' : t))
        .filter((t: string) => t !== 'null' && t !== 'undefined' && t !== '')
    ),
  );
  if (normalized.length === 0) return undefined;
  if (normalized.length === 1) return normalized[0];

  // Prefer a type that matches structure
  if (node && typeof node === 'object') {
    if (node.properties && typeof node.properties === 'object' && normalized.includes('object')) {
      return 'object';
    }
    if (node.items != null && normalized.includes('array')) {
      return 'array';
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      const t = typeof node.enum[0];
      if (t === 'string' && normalized.includes('string')) return 'string';
      if (t === 'number' && normalized.includes('number')) return 'number';
      if (t === 'boolean' && normalized.includes('boolean')) return 'boolean';
      if (t === 'object' && normalized.includes('object')) return 'object';
    }
  }

  // Generic priority to keep schemas usable by function callers
  const priority = ['object', 'array', 'string', 'number', 'boolean'];
  for (const p of priority) if (normalized.includes(p)) return p;
  // As a last resort, pick the first
  return normalized[0];
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

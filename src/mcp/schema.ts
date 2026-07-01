import { z, type ZodTypeAny } from "zod";

/**
 * Convert an MCP tool input schema (JSON Schema 7 object) into a matching Zod
 * schema. This is intentionally defensive: unknown shapes fall back to
 * z.any() instead of failing to connect to a server.
 */
export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (schema === null || typeof schema !== "object") {
    return z.any();
  }

  const s = schema as Record<string, unknown>;
  const type = s.type;

  if (s.enum && Array.isArray(s.enum)) {
    const values = s.enum as unknown[];
    if (values.length === 0) return z.any();
    if (values.length === 1) return z.literal(values[0] as string | number | boolean);
    const literals = values.map((v) => z.literal(v as string | number | boolean));
    return z.union(literals as [z.ZodLiteral<string | number | boolean>, z.ZodLiteral<string | number | boolean>, ...z.ZodLiteral<string | number | boolean>[]]);
  }

  if (type === "object") {
    const properties = s.properties as Record<string, unknown> | undefined;
    const required = (s.required as string[] | undefined) ?? [];
    const additionalProperties = s.additionalProperties;

    const shape: Record<string, ZodTypeAny> = {};
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        let field = jsonSchemaToZod(value);
        if (!required.includes(key)) {
          field = field.optional();
        }
        shape[key] = field;
      }
    }

    let obj = z.object(shape);

    if (additionalProperties === true) {
      obj = obj.catchall(z.any()) as unknown as typeof obj;
    } else if (additionalProperties && typeof additionalProperties === "object") {
      obj = obj.catchall(jsonSchemaToZod(additionalProperties)) as unknown as typeof obj;
    }

    return obj;
  }

  if (type === "array") {
    const items = s.items;
    if (items && typeof items === "object") {
      return z.array(jsonSchemaToZod(items));
    }
    return z.array(z.any());
  }

  if (type === "string") {
    let str = z.string();
    if (s.minLength !== undefined && typeof s.minLength === "number") {
      str = str.min(s.minLength);
    }
    if (s.maxLength !== undefined && typeof s.maxLength === "number") {
      str = str.max(s.maxLength);
    }
    if (s.pattern && typeof s.pattern === "string") {
      str = str.regex(new RegExp(s.pattern));
    }
    return str;
  }

  if (type === "number") {
    return z.number();
  }

  if (type === "integer") {
    return z.number().int();
  }

  if (type === "boolean") {
    return z.boolean();
  }

  if (type === "null") {
    return z.null();
  }

  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const branchSchemas = (s.anyOf ?? s.oneOf) as unknown[];
    if (branchSchemas.length === 0) return z.any();
    if (branchSchemas.length === 1) return jsonSchemaToZod(branchSchemas[0]);
    const branches = branchSchemas.map(jsonSchemaToZod) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]];
    return z.union(branches);
  }

  if (Array.isArray(s.allOf)) {
    if (s.allOf.length === 0) return z.any();
    if (s.allOf.length === 1) return jsonSchemaToZod(s.allOf[0]);
    return (s.allOf as unknown[]).slice(1).map(jsonSchemaToZod).reduce((acc, curr) => acc.and(curr), jsonSchemaToZod(s.allOf[0]));
  }

  // "$ref” or exotic keywords we don't model yet.
  return z.any();
}

import { SchemaError, compileSchema } from "../validate/index.js";
import type { CompiledSchema, Schema } from "../validate/index.js";

/**
 * MCP form-mode elicitation allows only a flat object of primitive properties. This checks that
 * shape, then compiles a stricter private copy (unknown answer fields rejected) while the schema
 * sent to the client stays as given, without `additionalProperties`.
 */

const MAX_PROPERTIES = 16;
const ROOT_KEYS = new Set(["type", "title", "description", "properties", "required"]);
const PROPERTY_KEYS = new Set([
  "type", "title", "description", "default", "enum", "minLength", "maxLength", "minimum", "maximum", "pattern",
]);
const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`invalid elicitation schema: ${message}`);
}

export function checkElicitSchema(schema: unknown): { published: Schema; compiled: CompiledSchema } {
  if (!isPlainObject(schema) || schema["type"] !== "object") fail("requestedSchema must be an object schema");
  for (const key of Object.keys(schema)) {
    if (!ROOT_KEYS.has(key)) fail(`unsupported key "${key}" (form mode is a flat object of primitive properties)`);
  }
  const properties = schema["properties"];
  if (!isPlainObject(properties)) fail("properties must be an object");
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_PROPERTIES) fail(`needs 1 to ${MAX_PROPERTIES} properties`);
  for (const [name, property] of entries) {
    if (!isPlainObject(property) || typeof property["type"] !== "string" || !PRIMITIVES.has(property["type"])) {
      fail(`property "${name}" must be a string, number, integer or boolean`);
    }
    for (const key of Object.keys(property)) {
      if (!PROPERTY_KEYS.has(key)) fail(`property "${name}" uses unsupported key "${key}"`);
    }
    if (property["enum"] !== undefined && (property["type"] !== "string" || !Array.isArray(property["enum"]) || !property["enum"].every((v) => typeof v === "string"))) {
      fail(`property "${name}": enum is only supported for strings`);
    }
  }
  const published = JSON.parse(JSON.stringify(schema)) as Schema;
  try {
    const compiled = compileSchema({ ...(published as object), additionalProperties: false } as Schema);
    return { published, compiled };
  } catch (error) {
    if (error instanceof SchemaError) fail(error.message);
    throw error;
  }
}

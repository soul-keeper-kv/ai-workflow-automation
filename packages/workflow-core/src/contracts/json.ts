import type { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Serialises `value` and parses it back, then validates the copy with `schema`.
 * Catches values that do not survive a JSON round trip (Date, Map, undefined fields, ...)
 * when they are written, instead of when a restarted app reads them back.
 */
export function jsonRoundTrip<T>(
  schema: z.ZodType<T>,
  value: unknown,
): { success: true; json: JsonValue; data: T } | { success: false; message: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    return { success: false, message: `not JSON-serialisable: ${String(error)}` };
  }
  if (text === undefined) {
    return { success: false, message: 'not JSON-serialisable: value is undefined' };
  }

  const json = JSON.parse(text) as JsonValue;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { success: false, message: parsed.error.message };
  }
  return { success: true, json, data: parsed.data };
}

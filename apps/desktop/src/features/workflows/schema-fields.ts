import { z } from 'zod';

/**
 * Turns a workflow's input JSON Schema (from the backend registry) into form fields, so the UI
 * renders a form for any workflow without workflow-specific code. Only a small subset is
 * mapped to dedicated controls; anything else becomes a JSON text field. The backend validates
 * every request either way.
 */
export type FieldSpec = {
  name: string;
  label: string;
  description: string | null;
  required: boolean;
} & (
  | { kind: 'text'; maxLength: number | null }
  | { kind: 'number'; integer: boolean; min: number | null; max: number | null }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  /** An array of strings, edited as one item per line. */
  | { kind: 'string-list'; minItems: number | null; maxItems: number | null }
  | { kind: 'json' }
);

export type FormValues = Record<string, string | boolean>;

const propertySchema = z
  .object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.unknown()).optional(),
    default: z.unknown().optional(),
    maxLength: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    items: z.object({ type: z.unknown().optional() }).loose().optional(),
  })
  .loose();

const objectSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).default({}),
    required: z.array(z.string()).default([]),
  })
  .loose();

function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface FormModel {
  fields: FieldSpec[];
  defaults: FormValues;
}

/** Returns null when the schema is not an object schema; the caller then offers raw JSON. */
export function buildFormModel(inputSchema: Record<string, unknown>): FormModel | null {
  const root = objectSchema.safeParse(inputSchema);
  if (!root.success) return null;

  const fields: FieldSpec[] = [];
  const defaults: FormValues = {};
  for (const [name, raw] of Object.entries(root.data.properties)) {
    const parsed = propertySchema.safeParse(raw);
    const property = parsed.success ? parsed.data : {};
    const common = {
      name,
      label: property.title ?? humanize(name),
      description: property.description ?? null,
      required: root.data.required.includes(name),
    };
    const fallback = property.default;

    if (property.enum !== undefined && property.enum.every((v) => typeof v === 'string')) {
      fields.push({ ...common, kind: 'enum', options: property.enum });
      defaults[name] = typeof fallback === 'string' ? fallback : '';
    } else if (property.type === 'string') {
      fields.push({ ...common, kind: 'text', maxLength: property.maxLength ?? null });
      defaults[name] = typeof fallback === 'string' ? fallback : '';
    } else if (property.type === 'integer' || property.type === 'number') {
      fields.push({
        ...common,
        kind: 'number',
        integer: property.type === 'integer',
        min: property.minimum ?? null,
        max: property.maximum ?? null,
      });
      defaults[name] = typeof fallback === 'number' ? String(fallback) : '';
    } else if (property.type === 'boolean') {
      fields.push({ ...common, kind: 'boolean' });
      defaults[name] = fallback === true;
    } else if (property.type === 'array' && property.items?.type === 'string') {
      fields.push({
        ...common,
        kind: 'string-list',
        minItems: property.minItems ?? null,
        maxItems: property.maxItems ?? null,
      });
      defaults[name] = Array.isArray(fallback) ? fallback.map(String).join('\n') : '';
    } else {
      fields.push({ ...common, kind: 'json' });
      defaults[name] = fallback === undefined ? '' : JSON.stringify(fallback, null, 2);
    }
  }
  return { fields, defaults };
}

export type ConversionResult =
  | { success: true; input: Record<string, unknown> }
  | { success: false; errors: Record<string, string> };

/** Form strings to the input object the workflow expects. Empty optional fields are omitted. */
export function toWorkflowInput(
  fields: readonly FieldSpec[],
  values: FormValues,
): ConversionResult {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === 'boolean') {
      input[field.name] = value === true;
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '' && field.kind !== 'string-list') continue;

    switch (field.kind) {
      case 'text':
      case 'enum':
        input[field.name] = text;
        break;
      case 'number':
        input[field.name] = Number(text);
        break;
      case 'string-list': {
        const items = text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
        if (items.length > 0 || field.required) input[field.name] = items;
        break;
      }
      case 'json':
        try {
          input[field.name] = JSON.parse(text) as unknown;
        } catch {
          errors[field.name] = 'Not valid JSON.';
        }
        break;
    }
  }
  return Object.keys(errors).length > 0 ? { success: false, errors } : { success: true, input };
}

/**
 * A client-side validator rebuilt from the same JSON Schema, for instant feedback. If the
 * schema uses something Zod cannot rebuild, the form skips client checks; the server still
 * validates.
 */
export function clientValidator(inputSchema: Record<string, unknown>): z.ZodType | null {
  try {
    return z.fromJSONSchema(inputSchema);
  } catch {
    return null;
  }
}

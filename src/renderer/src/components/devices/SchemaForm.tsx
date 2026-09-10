import { useEffect, useState } from "react";
import { INPUT_CLASS } from "../../lib/styles";

interface JsonSchemaProperty {
  type?: "string" | "integer" | "number" | "boolean";
  title?: string;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
}

interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface SchemaFormProps {
  schema: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => void;
  submitLabel?: string;
}

function defaultValueFor(prop: JsonSchemaProperty): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.type === "boolean") return false;
  if (prop.type === "string") return "";
  return 0;
}

function initialValues(schema: JsonSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    // `config_schema` comes from the daemon's GET /drivers response --
    // untrusted input as far as the renderer is concerned. A property
    // literally named "__proto__" would, via this bracket assignment,
    // reassign `values`'s own prototype instead of setting a normal
    // field (JS's `__proto__` is a special accessor every plain object
    // inherits from Object.prototype) -- skip it rather than let a
    // malformed/malicious schema pollute this object's prototype chain.
    if (key === "__proto__") continue;
    values[key] = defaultValueFor(prop);
  }
  return values;
}

/**
 * Renders an add-instance/add-device form directly from a driver's Pydantic
 * config model (as JSON Schema, from GET /drivers) -- no per-driver-type
 * form component to write or keep in sync. Handles the flat {string,
 * integer, number, boolean} shape every driver config in this codebase
 * uses; nested objects/arrays aren't supported because no driver needs them
 * yet -- extend here, not by special-casing a driver in the UI, if one ever does.
 */
export function SchemaForm({ schema, onSubmit, submitLabel = "Add" }: SchemaFormProps): JSX.Element {
  const typedSchema = schema as JsonSchema;
  const properties = typedSchema.properties ?? {};
  const required = new Set(typedSchema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(typedSchema));

  // Reset the form when the underlying schema changes (operator picked a different driver_type).
  useEffect(() => setValues(initialValues(typedSchema)), [schema]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (key: string, value: unknown): void => setValues((prev) => ({ ...prev, [key]: value }));

  const inputClass = INPUT_CLASS;

  return (
    <form
      className="flex flex-col gap-sm"
      onSubmit={(e) => {
        e.preventDefault();
        // An optional number field left empty parses to NaN, which
        // JSON.stringify silently turns into `null` -- that used to reach
        // the daemon as an explicit null for a numeric config field instead
        // of just being absent, which a required field's `required`
        // attribute already blocks at the browser level, but nothing
        // caught for an optional one. Dropping undefined keys here sends
        // "not specified" instead, so the driver's own Pydantic default
        // applies, same as if the operator had never seen this field.
        const cleaned = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
        onSubmit(cleaned);
      }}
    >
      {Object.entries(properties).map(([key, prop]) => (
        <label key={key} className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">
            {prop.title ?? key}
            {required.has(key) && <span className="text-danger"> *</span>}
          </span>

          {prop.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(values[key])}
              onChange={(e) => setField(key, e.target.checked)}
              className="h-4 w-4 self-start accent-accent"
            />
          ) : prop.type === "integer" || prop.type === "number" ? (
            <input
              type="number"
              value={(values[key] as number | undefined) ?? ""}
              min={prop.minimum}
              max={prop.maximum}
              step={prop.type === "integer" ? 1 : "any"}
              required={required.has(key)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  // Cleared by the operator -- store as "not specified"
                  // rather than NaN, see the submit handler above.
                  setField(key, undefined);
                  return;
                }
                const parsed = prop.type === "integer" ? parseInt(raw, 10) : parseFloat(raw);
                setField(key, Number.isNaN(parsed) ? undefined : parsed);
              }}
              className={inputClass}
            />
          ) : (
            <input
              type="text"
              value={(values[key] as string) ?? ""}
              required={required.has(key)}
              onChange={(e) => setField(key, e.target.value)}
              className={inputClass}
            />
          )}

          {prop.description && <span className="text-xs text-text-muted">{prop.description}</span>}
        </label>
      ))}

      <button
        type="submit"
        className="mt-xs h-control rounded-control bg-primary px-md text-sm font-medium text-text-primary hover:bg-primary-hover"
      >
        {submitLabel}
      </button>
    </form>
  );
}

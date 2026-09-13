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
    // config_schema is untrusted (from the daemon's GET /drivers); skip "__proto__" so a malicious schema can't pollute this object's prototype via the bracket assignment below.
    if (key === "__proto__") continue;
    values[key] = defaultValueFor(prop);
  }
  return values;
}

/** Renders an add-instance form directly from a driver's Pydantic config (as JSON Schema) so no per-driver-type form component is needed; only the flat {string,integer,number,boolean} shape is supported -- extend here, not with per-driver UI, if a driver ever needs nested config. */
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
        // An empty optional number field parses to NaN, which JSON.stringify silently turns into `null`; dropping undefined keys here sends "not specified" instead, so the driver's own Pydantic default applies.
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
                  // Cleared by the operator -- store as "not specified" rather than NaN (see submit handler above).
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

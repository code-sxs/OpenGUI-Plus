/**
 * `{{variable}}` handling for action templates.
 *
 * Recording a template captures steps with the *literal* values that were used
 * at record time. Turning that into something reusable means scanning every
 * parameter value for `{{name}}` placeholders, declaring them as template
 * variables, and substituting on execute. Pure string work, so it lives here
 * and carries its own tests.
 */

/** Matches `{{name}}`, tolerating inner spacing. */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** A declared variable the caller may (or must) fill in at execute time. */
export interface TemplateVariable {
  readonly name: string
  readonly label: string
  readonly defaultValue?: string
  readonly required: boolean
}

/** Parameter bag of a step; values may contain placeholders. */
export type StepParams = Readonly<Record<string, string | number>>

/** Name of the placeholder, or `null` when the name is not a valid identifier. */
export function placeholderNames(value: string): readonly string[] {
  const names: string[] = []
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1]
    if (name === undefined) continue
    if (names.includes(name) === false) names.push(name)
  }
  return names
}

/**
 * Scan every string parameter of every step and declare one variable per
 * distinct placeholder. Duplicates collapse; first occurrence wins the order.
 */
export function extractVariables(steps: readonly { readonly params?: StepParams }[]): readonly TemplateVariable[] {
  const out: TemplateVariable[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    for (const value of Object.values(step.params ?? {})) {
      if (typeof value !== 'string') continue
      for (const name of placeholderNames(value)) {
        if (seen.has(name)) continue
        seen.add(name)
        out.push({ name, label: name, required: true })
      }
    }
  }
  return out
}

/** Replace placeholders, leaving unknown ones untouched. */
export function substitute(value: string, variables: Readonly<Record<string, string>>): string {
  return value.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const replacement = variables[name]
    return replacement === undefined ? whole : replacement
  })
}

/** Placeholders referenced by the steps that the caller did not supply. */
export function missingVariables(
  steps: readonly { readonly params?: StepParams }[],
  provided: Readonly<Record<string, string>>,
): readonly string[] {
  const missing: string[] = []
  for (const variable of extractVariables(steps)) {
    const value = provided[variable.name]
    if (typeof value !== 'string' || value.length === 0) {
      if (missing.includes(variable.name) === false) missing.push(variable.name)
    }
  }
  return missing
}

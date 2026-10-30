export type UnnamedButton = {
  file: string;
  line: number;
  snippet: string;
};

/**
 * Finds `<button>` elements with no accessible name (aria-label,
 * aria-labelledby, title, or visible content). Exported for the classifier tests.
 */
export function findUnnamedButtons(source: string, file?: string): UnnamedButton[];

/** Finds input/select/textarea controls with no accessible name. */
export function findUnnamedInputs(source: string, file?: string): UnnamedButton[];

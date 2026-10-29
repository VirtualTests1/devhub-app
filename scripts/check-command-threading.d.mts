export type CommandEntry = {
  file: string;
  line: number;
  name: string;
  async: boolean;
};

export type AuditResult = {
  commands: CommandEntry[];
  sync: CommandEntry[];
  unknownSync: CommandEntry[];
  staleAllowlist: string[];
};

export const ALLOWLIST: Map<string, string>;

export function scanSource(file: string, text: string): CommandEntry[];

export function audit(
  sources: readonly { file: string; text: string }[],
  allowlist?: Map<string, string>,
): AuditResult;

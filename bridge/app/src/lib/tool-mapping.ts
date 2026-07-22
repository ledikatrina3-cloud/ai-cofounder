export type OrbitalName = 'FS' | 'BASH' | 'WEB' | 'DB' | 'TG' | 'EMAIL';

export interface ToolMapping {
  orbital: OrbitalName;
  color: string;
}

const MAPPINGS: Array<[RegExp, ToolMapping]> = [
  [/^(Read|Glob|Grep)$/, { orbital: 'FS', color: '#7c9eb2' }],
  [/^(Edit|Write|NotebookEdit)$/, { orbital: 'FS', color: '#d97757' }],
  [/^Bash$/, { orbital: 'BASH', color: '#c4a747' }],
  [/^(WebSearch|WebFetch)$/, { orbital: 'WEB', color: '#9ca77c' }],
  [/mcp__(postgres|db)/i, { orbital: 'DB', color: '#d97757' }],
  [/mcp__.*telegram/i, { orbital: 'TG', color: '#7cb29a' }],
  [/mcp__.*(gmail|calendar|email)/i, { orbital: 'EMAIL', color: '#a77c9c' }],
];

export function mapTool(toolName: string): ToolMapping {
  for (const [re, mapping] of MAPPINGS) {
    if (re.test(toolName)) return mapping;
  }
  return { orbital: 'FS', color: '#7c9eb2' };
}

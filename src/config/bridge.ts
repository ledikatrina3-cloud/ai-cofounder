// Зеркало bridge/config.ts на стороне AI-Cofounder. Bridge живёт в отдельном
// дереве (bridge/), чтобы Electron-зависимости не текли в основной runtime —
// поэтому root-код не импортирует bridge/config.ts напрямую. Дефолт совпадает
// с bridge/config.ts (3737, мостик.md L132); env BRIDGE_PORT перекрывает обе
// стороны одновременно.

export const BRIDGE_PORT_DEFAULT = 3737;

export function bridgePort(): number {
  const raw = process.env.BRIDGE_PORT;
  if (raw === undefined || raw.trim() === '') return BRIDGE_PORT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`BRIDGE_PORT='${raw}' — невалидное значение, ожидался номер порта 1..65535`);
  }
  return parsed;
}

export function bridgeBaseUrl(): string {
  const explicit = process.env.BRIDGE_URL;
  if (explicit !== undefined && explicit.trim() !== '') return explicit.replace(/\/$/, '');
  return `http://127.0.0.1:${bridgePort()}`;
}

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { type ReactNode, useEffect, useRef } from 'react';
import type { BridgeEvent } from '../../../../events.js';

interface Props {
  events: BridgeEvent[];
}

export function Terminal({ events }: Props): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const processedRef = useRef(0); // индекс последнего обработанного события

  // Инициализация Terminal — только один раз
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new XTerminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#e9e3dc',
        cursor: '#d97757',
        selectionBackground: 'rgba(217,119,87,0.3)',
      },
      cursorBlink: true,
      rows: 6,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      fontSize: 11,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.writeln('\x1b[36m[BRIDGE]\x1b[0m Terminal ready. Waiting for events…');

    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []); // пустой массив — только mount/unmount

  // Ресайз при изменении окна
  useEffect(() => {
    const handleResize = (): void => {
      fitRef.current?.fit();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Обработка новых событий
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const newEvents = events.slice(processedRef.current);
    processedRef.current = events.length;

    for (const ev of newEvents) {
      if (ev.type === 'tool.start') {
        const input = ev.input as Record<string, unknown> | null;
        // Bash → command, Read/Edit/Write → file_path, Grep → pattern, Glob → pattern,
        // WebFetch → url. Показываем первый осмысленный из них; в остальных случаях
        // — JSON.stringify первого ключа. Длина обрезается до 200, чтобы строка
        // не уехала за ширину терминала.
        let arg = '';
        if (typeof input === 'object' && input !== null) {
          const candidate =
            input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.path;
          arg = String(candidate ?? Object.values(input)[0] ?? '').slice(0, 200);
        }
        term.writeln(`\x1b[33m▸\x1b[0m \x1b[36m${ev.name}\x1b[0m ${arg}`);
      } else if (ev.type === 'tool.end' && typeof ev.output === 'string') {
        const lines = ev.output.split('\n').slice(0, 3); // max 3 строки вывода
        for (const line of lines) {
          if (line.trim().length > 0) {
            term.writeln(`  \x1b[2m${line.slice(0, 180)}\x1b[0m`);
          }
        }
      } else if (ev.type === 'tool.error') {
        term.writeln(`\x1b[31m✗\x1b[0m ${ev.error.slice(0, 200)}`);
      } else if (ev.type === 'subagent.start') {
        term.writeln(`\x1b[36m▼\x1b[0m \x1b[1m${ev.subagentType}\x1b[0m thinking…`);
      } else if (ev.type === 'subagent.end') {
        const verdict = ev.verdict ?? 'done';
        const cost =
          typeof ev.totalUsd === 'number' ? ` \x1b[2m$${ev.totalUsd.toFixed(3)}\x1b[0m` : '';
        term.writeln(`\x1b[36m▲\x1b[0m ${verdict} \x1b[2m(${ev.durationMs}ms)\x1b[0m${cost}`);
      } else if (ev.type === 'assistant.message') {
        // Многострочные ответы режем — терминал маленький.
        const firstLine = ev.text.split('\n').find((l) => l.trim().length > 0);
        if (firstLine) {
          term.writeln(`\x1b[37m▌\x1b[0m ${firstLine.slice(0, 180)}`);
        }
      } else if (ev.type === 'routine.start') {
        term.writeln(`\x1b[35m[ROUTINE]\x1b[0m ${ev.routineId} (${ev.runDate})`);
      } else if (ev.type === 'routine.end') {
        const icon = ev.status === 'ok' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        term.writeln(`\x1b[35m[DONE]\x1b[0m ${icon} ${ev.status} ${ev.durationMs}ms`);
      } else if (ev.type === 'audit.spend') {
        term.writeln(`\x1b[2m  $${ev.usd.toFixed(4)} ${ev.model} (${ev.promptId})\x1b[0m`);
      }
    }
  }, [events]);

  return (
    <div
      style={{
        height: '100%',
        background: '#0a0a0a',
        borderTop: '1px solid rgba(217,119,87,0.12)',
        padding: '8px',
        overflow: 'hidden',
      }}
    >
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BridgeEvent } from '../../../../events.js';

interface FeedLine {
  id: string;
  text: string;
  displayed: string; // typewriter progress
  ts: number;
}

function eventToLine(ev: BridgeEvent): string | null {
  switch (ev.type) {
    case 'routine.start':
      return `Routine: ${ev.routineId} starting…`;
    case 'tool.start': {
      const arg =
        typeof ev.input === 'object' && ev.input !== null
          ? Object.values(ev.input as Record<string, unknown>)[0]
          : '';
      const argStr = String(arg ?? '').slice(0, 60);
      return `▸ ${ev.name}${argStr ? ` ${argStr}` : ''}`;
    }
    case 'tool.error':
      return `✗ tool: ${ev.error.slice(0, 80)}`;
    case 'subagent.start':
      return `⟁ ${ev.subagentType} thinking…`;
    case 'subagent.end': {
      const verdict = ev.verdict ?? 'done';
      const cost = typeof ev.totalUsd === 'number' ? ` $${ev.totalUsd.toFixed(3)}` : '';
      return `⟁ ${verdict} (${ev.durationMs}ms${cost})`;
    }
    case 'assistant.message': {
      const text = ev.text.replace(/\s+/g, ' ').trim();
      if (text.length === 0) return null;
      return `▌ ${text.slice(0, 110)}`;
    }
    case 'audit.spend':
      return `$ ${ev.usd.toFixed(4)} ${ev.model}`;
    case 'routine.end':
      return `Done: ${ev.status} in ${ev.durationMs}ms`;
    case 'runIteration.step':
      return `Step: ${ev.step}`;
    case 'triage.extract.start':
      return `Triage: extracting from ${ev.messagesIn} messages`;
    case 'investigate.batch.start':
      return `Investigating ${ev.problemsIn} problems (×${ev.concurrency})`;
    case 'solve.batch.start':
      return `Solving ${ev.diagnosesIn} diagnoses`;
    case 'support.fetch.start':
      return `Support: pulling messages from ${ev.chatIds.length} chats`;
    case 'support.fetch.end':
      return `Support: +${ev.messagesInserted} new (${ev.durationMs}ms)`;
    case 'bot.start':
      return `bot online · allowlist=${ev.allowlistSize}`;
    default:
      return null;
  }
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function DecisionFeed({ events }: { events: BridgeEvent[] }): ReactNode {
  const [lines, setLines] = useState<FeedLine[]>([]);
  const processedCount = useRef<number>(0);

  // Derive candidate lines from the last 20 events
  const candidates = useMemo(() => {
    const slice = events.slice(-20);
    const result: { text: string; ts: number }[] = [];
    for (const ev of slice) {
      const text = eventToLine(ev);
      if (text !== null) {
        result.push({ text, ts: ev.ts });
      }
    }
    return result;
  }, [events]);

  // Flush all unseen candidates as soon as they arrive — типографский эффект
  // (typewriter ниже) сам растягивает их по времени, но в feed видны все, не
  // только самое свежее. throttle стоит только для защиты от шторма (>20 за раз).
  useEffect(() => {
    if (candidates.length === 0) return;
    const seen = processedCount.current;
    if (candidates.length <= seen) return;
    const fresh = candidates.slice(seen);
    processedCount.current = candidates.length;
    setLines((prev) => {
      const additions: FeedLine[] = fresh.map((c) => ({
        id: makeId(),
        text: c.text,
        displayed: '',
        ts: c.ts,
      }));
      return [...prev, ...additions].slice(-5);
    });
  }, [candidates]);

  // Typewriter effect: advance the last incomplete line at ~60 chars/sec (16ms interval)
  useEffect(() => {
    const incomplete = lines.findIndex((l) => l.displayed.length < l.text.length);
    if (incomplete === -1) return;

    const timer = setInterval(() => {
      setLines((prev) =>
        prev.map((line, idx) => {
          if (idx !== incomplete) return line;
          if (line.displayed.length >= line.text.length) return line;
          return { ...line, displayed: line.text.slice(0, line.displayed.length + 1) };
        }),
      );
    }, 16);

    return () => clearInterval(timer);
  }, [lines]);

  return (
    <div
      style={{
        padding: '8px 12px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        lineHeight: '1.8',
        color: '#e9e3dc',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 2,
      }}
    >
      <style>{'@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }'}</style>
      <AnimatePresence mode="popLayout">
        {lines.map((line) => (
          <motion.div
            key={line.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            <span style={{ color: 'rgba(217,119,87,0.5)', marginRight: 8, fontSize: 10 }}>
              {new Date(line.ts).toISOString().slice(11, 19)}
            </span>
            {line.displayed}
            {line.displayed.length < line.text.length && (
              <span style={{ opacity: 0.7, animation: 'blink 1s step-end infinite' }}>▋</span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

import { useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { BridgeEvent } from '../../../../events.js';
import { mapTool } from '../../lib/tool-mapping.js';

interface Capsule {
  id: string; // toolId
  name: string;
  color: string;
  startTs: number;
  durationMs: number | null; // null = in progress
  width: number; // px
}

const WINDOW_MS = 60_000; // last 60 seconds
const MERGE_WINDOW_MS = 500; // merge same tool calls within 500ms

function computeWidth(durationMs: number | null): number {
  if (durationMs === null) return 8;
  return Math.max(8, Math.min(200, durationMs / 50));
}

function useCapsules(events: BridgeEvent[]): Capsule[] {
  return useMemo(() => {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    // Build a map of toolId -> capsule data from tool.start / tool.end events
    const startMap = new Map<string, { name: string; ts: number }>();
    const endMap = new Map<string, { durationMs: number }>();

    for (const ev of events) {
      if (ev.ts < cutoff) continue;
      if (ev.type === 'tool.start') {
        startMap.set(ev.toolId, { name: ev.name, ts: ev.ts });
      } else if (ev.type === 'tool.end') {
        endMap.set(ev.toolId, { durationMs: ev.durationMs });
      }
    }

    // Build raw capsules from startMap
    const raw: Capsule[] = [];
    for (const [toolId, start] of startMap) {
      const end = endMap.get(toolId);
      const durationMs = end?.durationMs ?? null;
      const { color } = mapTool(start.name);
      raw.push({
        id: toolId,
        name: start.name,
        color,
        startTs: start.ts,
        durationMs,
        width: computeWidth(durationMs),
      });
    }

    // Sort by startTs ascending
    raw.sort((a, b) => a.startTs - b.startTs);

    // Merge same tool name within MERGE_WINDOW_MS
    const merged: (Capsule & { count: number })[] = [];
    for (const cap of raw) {
      const last = merged[merged.length - 1];
      if (
        last !== undefined &&
        last.name === cap.name &&
        cap.startTs - last.startTs < MERGE_WINDOW_MS
      ) {
        last.count += 1;
        last.id = `${last.id}+${cap.id}`;
        // Use max duration for merged capsule
        if (cap.durationMs !== null) {
          const combined = Math.max(last.durationMs ?? 0, cap.durationMs);
          last.durationMs = combined;
          last.width = computeWidth(combined);
        }
      } else {
        merged.push({ ...cap, count: 1 });
      }
    }

    return merged;
  }, [events]);
}

export function EventTimeline({ events }: { events: BridgeEvent[] }): ReactNode {
  // scrollElRef stores the DOM node; we scroll right whenever the ref callback fires.
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const capsules = useCapsules(events);

  // Callback ref: called with the DOM node on every mount/update cycle.
  // Auto-scrolls right so the latest capsule is always visible.
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollElRef.current = el;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, []);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        borderTop: '1px solid rgba(217,119,87,0.12)',
        borderBottom: '1px solid rgba(217,119,87,0.12)',
      }}
    >
      <div
        ref={setScrollRef}
        style={{
          display: 'flex',
          gap: 4,
          overflowX: 'auto',
          alignItems: 'center',
          scrollbarWidth: 'none',
        }}
      >
        {capsules.map((cap) => (
          <div
            key={cap.id}
            title={`${cap.name} ${cap.durationMs != null ? `${cap.durationMs}ms` : '…'}`}
            style={{
              width: cap.width,
              height: cap.durationMs != null ? 32 : 20,
              background: cap.color,
              borderRadius: 4,
              opacity: cap.durationMs != null ? 0.8 : 0.4,
              flexShrink: 0,
              transition: 'all 0.3s ease',
              cursor: 'default',
              fontSize: 9,
              color: '#0a0a0a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            {cap.width > 30 ? cap.name.slice(0, 6) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

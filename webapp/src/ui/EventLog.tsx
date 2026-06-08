import { useEffect, useRef } from "react";

export interface LogEntry { ts: string; msg: string }

export default function EventLog({ entries }: { entries: LogEntry[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);
  return (
    <div className="card">
      <h3 style={{ margin: "0 0 12px" }}>Event log</h3>
      <div className="log" ref={ref}>
        {entries.map((e, i) => (
          <div key={i}>
            <span className="ts">{e.ts}</span>
            <span>{e.msg}</span>
          </div>
        ))}
        {entries.length === 0 && <div style={{ color: "var(--fg-1)" }}>(empty)</div>}
      </div>
    </div>
  );
}

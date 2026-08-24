import { useEffect, useState } from "react";
import { usageRecords } from "../ipc";
import type { Project, UsageRecord } from "../types";

interface Props {
  projects: Project[];
  onClose: () => void;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface Row {
  label: string;
  sessions: number;
  seconds: number;
}

function aggregate(records: UsageRecord[], key: (r: UsageRecord) => string): Row[] {
  const map = new Map<string, Row>();
  for (const r of records) {
    const k = key(r);
    const row = map.get(k) ?? { label: k, sessions: 0, seconds: 0 };
    row.sessions++;
    row.seconds += r.seconds;
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds);
}

export default function UsagePanel({ projects, onClose }: Props) {
  const [records, setRecords] = useState<UsageRecord[]>([]);

  useEffect(() => {
    usageRecords().then(setRecords).catch(() => {});
  }, []);

  const weekAgo = Date.now() / 1000 - 7 * 86400;
  const week = records.filter((r) => r.startedAt >= weekAgo);
  const byProvider = aggregate(week, (r) => (r.provider === "claude" ? "Claude" : "Codex"));
  const byProject = aggregate(
    week,
    (r) => projects.find((p) => p.id === r.projectId)?.name ?? "(deleted project)",
  ).slice(0, 8);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card">
        <h2>Usage · last 7 days</h2>
        {week.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            No completed sessions yet. Time is recorded when a session ends.
          </p>
        ) : (
          <>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Sessions</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {byProvider.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.sessions}</td>
                    <td>{fmtDuration(row.seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Sessions</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {byProject.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.sessions}</td>
                    <td>{fmtDuration(row.seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

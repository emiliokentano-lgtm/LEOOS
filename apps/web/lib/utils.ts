import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, with later Tailwind utilities winning. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Relative time, in the terse form an operator reads at a glance. */
export function timeAgo(date: Date | string, now: Date = new Date()): string {
  const then = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** 24-hour clock — the only time format used in the interface. */
export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })} ${formatTime(d)}`;
}

/**
 * Elapsed duration for incident age.
 *
 * MM:SS under an hour, then an explicit `1h34` — a bare "1:34" reads as one
 * minute thirty-four at a glance, which is exactly the wrong impression for a
 * call that has been open for an hour and a half.
 */
export function formatElapsed(from: Date | string, now: Date = new Date()): string {
  const start = typeof from === 'string' ? new Date(from) : from;
  const total = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

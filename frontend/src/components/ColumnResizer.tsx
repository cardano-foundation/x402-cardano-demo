import { useEffect, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

interface ColumnResizerProps {
  /** The grid whose `--detail-width` this handle sets. */
  grid: RefObject<HTMLElement | null>;
  /** The resized column; its left edge follows the handle. */
  column: RefObject<HTMLElement | null>;
  /** Smallest width for the resized column, and for what is left of it. */
  min: number;
  /** Space the other columns need (controls + steps minimum). */
  reserved: number;
  storageKey: string;
  label: string;
}

const STEP = 24;

const read = (key: string): number | undefined => {
  try { const value = Number(window.localStorage.getItem(key)); return value > 0 ? value : undefined; } catch { return undefined; }
};
const write = (key: string, value: number | undefined) => {
  try { if (value === undefined) window.localStorage.removeItem(key); else window.localStorage.setItem(key, String(Math.round(value))); } catch { /* storage unavailable: width just isn't remembered */ }
};

/**
 * A vertical splitter: drag it, or focus it and use the arrow keys, to resize
 * the column to its right. Double-click or Escape returns to the default
 * share. The width is remembered in this browser.
 */
export function ColumnResizer({ grid, column, min, reserved, storageKey, label }: ColumnResizerProps) {
  const [width, setWidth] = useState<number | undefined>(() => read(storageKey));
  const [dragging, setDragging] = useState(false);

  const bounds = () => {
    const total = grid.current?.clientWidth ?? 0;
    return { min, max: Math.max(min, total - reserved) };
  };
  const clamp = (value: number) => { const { min: lo, max: hi } = bounds(); return Math.min(hi, Math.max(lo, value)); };

  // Apply to the grid; also re-clamp when the window shrinks.
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const apply = () => {
      if (width === undefined) element.style.removeProperty("--detail-width");
      else element.style.setProperty("--detail-width", `${clamp(width)}px`);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  });

  function commit(next: number | undefined) {
    const value = next === undefined ? undefined : clamp(next);
    setWidth(value);
    write(storageKey, value);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragging || !grid.current) return;
    // The column spans from the pointer to the grid's right edge.
    commit(grid.current.getBoundingClientRect().right - event.clientX);
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = column.current?.getBoundingClientRect().width ?? width ?? min;
    const { min: lo, max: hi } = bounds();
    const next = event.key === "ArrowLeft" ? current + STEP
      : event.key === "ArrowRight" ? current - STEP
      : event.key === "Home" ? hi
      : event.key === "End" ? lo
      : undefined;
    if (event.key === "Escape") { event.preventDefault(); commit(undefined); return; }
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  }

  const now = Math.round(column.current?.getBoundingClientRect().width ?? width ?? 0);
  const { min: lo, max: hi } = bounds();
  return (
    <div
      className="dash__resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={now}
      aria-valuemin={lo}
      aria-valuemax={hi}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => commit(undefined)}
      onKeyDown={onKeyDown}
    />
  );
}

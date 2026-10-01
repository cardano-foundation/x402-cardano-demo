import { useEffect, type RefObject } from "react";

/**
 * While a run progresses, scrolls the column to the newest step matching
 * `selector`. It moves only the column (never the page) and only while
 * `active`, so it never fights someone reading an earlier step afterwards.
 * `version` changes whenever a step changes.
 */
export function useFollowRun(column: RefObject<HTMLElement | null>, selector: string, active: boolean, version: unknown) {
  useEffect(() => {
    const element = column.current;
    if (!active || !element || element.scrollHeight <= element.clientHeight) return;
    const targets = element.querySelectorAll<HTMLElement>(selector);
    const target = targets[targets.length - 1];
    if (!target) return;
    const top = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - 16;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }, [column, selector, active, version]);
}

import { useRef, type KeyboardEvent } from "react";

export interface TabInfo<Id extends string> {
  id: Id;
  label: string;
  /** One line under the label: what this tab demonstrates. */
  detail: string;
}

interface TabNavProps<Id extends string> {
  tabs: TabInfo<Id>[];
  current: Id;
  onChange: (id: Id) => void;
  /** Set while a payment is in flight: switching would lose track of it. */
  lockedReason?: string;
}

/** WAI-ARIA tabs: arrow keys move between tabs, Home and End jump to the ends. */
export function TabNav<Id extends string>({ tabs, current, onChange, lockedReason }: TabNavProps<Id>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKey(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0 || lockedReason) return;
    event.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  }
  return (
    <div className="tab-nav">
      <div className="tab-nav__list" role="tablist" aria-label="Demos">
        {tabs.map((tab, index) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              ref={(element) => { refs.current[index] = element; }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className="tab-nav__tab"
              disabled={!selected && Boolean(lockedReason)}
              title={!selected ? lockedReason : undefined}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKey(event, index)}
            >
              <span className="tab-nav__label">{tab.label}</span>
              <span className="tab-nav__detail">{tab.detail}</span>
            </button>
          );
        })}
      </div>
      {lockedReason && <p className="tab-nav__lock" role="status">{lockedReason}</p>}
    </div>
  );
}

import type { InterfacePrefs } from "./storage-prefs";

type InterfacePrefsPopoverProps = {
  open: boolean;
  prefs: InterfacePrefs;
  onToggle: () => void;
  onClose: () => void;
  onChange: (patch: Partial<InterfacePrefs>) => void;
  onReset: () => void;
};

export function InterfacePrefsPopover({ open, prefs, onToggle, onClose, onChange, onReset }: InterfacePrefsPopoverProps) {
  return (
    <div className="interface-prefs-wrap">
      <button className={`icon-button prefs-button ${open ? "active" : ""}`} onClick={onToggle} aria-expanded={open} title="Display settings">
        Aa
      </button>
      {open && (
        <>
          <button className="prefs-backdrop" aria-label="Close display settings" onClick={onClose} />
          <section className="prefs-popover" role="dialog" aria-label="Display settings">
            <div className="prefs-head">
              <h2>Display</h2>
              <button className="icon-button compact-button" onClick={onReset}>
                Reset
              </button>
            </div>
            <RangeControl
              label="Interface"
              value={prefs.uiScale}
              min={0.88}
              max={1.22}
              step={0.01}
              display={`${Math.round(prefs.uiScale * 100)}%`}
              onChange={(uiScale) => onChange({ uiScale })}
            />
            <RangeControl
              label="Chat text"
              value={prefs.chatScale}
              min={0.9}
              max={1.36}
              step={0.01}
              display={`${Math.round(prefs.chatScale * 100)}%`}
              onChange={(chatScale) => onChange({ chatScale })}
            />
            <RangeControl
              label="Spacing"
              value={prefs.density}
              min={0.82}
              max={1.22}
              step={0.01}
              display={`${Math.round(prefs.density * 100)}%`}
              onChange={(density) => onChange({ density })}
            />
            <RangeControl
              label="Line width"
              value={prefs.chatWidth}
              min={680}
              max={1120}
              step={20}
              display={`${prefs.chatWidth}px`}
              onChange={(chatWidth) => onChange({ chatWidth })}
            />
          </section>
        </>
      )}
    </div>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="prefs-range">
      <span>
        <b>{label}</b>
        <output>{display}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

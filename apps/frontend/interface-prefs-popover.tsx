import { INTERFACE_PREF_LIMITS, type DisplayMode, type InterfacePrefs } from "./storage-prefs";

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
            <DisplayModeControl value={prefs.displayMode} onChange={(displayMode) => onChange({ displayMode })} />
            <RangeControl
              label="Interface"
              value={prefs.uiScale}
              min={INTERFACE_PREF_LIMITS.uiScale.min}
              max={INTERFACE_PREF_LIMITS.uiScale.max}
              step={INTERFACE_PREF_LIMITS.uiScale.step}
              display={`${Math.round(prefs.uiScale * 100)}%`}
              onChange={(uiScale) => onChange({ uiScale })}
            />
            <RangeControl
              label="Chat text"
              value={prefs.chatScale}
              min={INTERFACE_PREF_LIMITS.chatScale.min}
              max={INTERFACE_PREF_LIMITS.chatScale.max}
              step={INTERFACE_PREF_LIMITS.chatScale.step}
              display={`${Math.round(prefs.chatScale * 100)}%`}
              onChange={(chatScale) => onChange({ chatScale })}
            />
            <RangeControl
              label="Spacing"
              value={prefs.density}
              min={INTERFACE_PREF_LIMITS.density.min}
              max={INTERFACE_PREF_LIMITS.density.max}
              step={INTERFACE_PREF_LIMITS.density.step}
              display={`${Math.round(prefs.density * 100)}%`}
              onChange={(density) => onChange({ density })}
            />
            <RangeControl
              label="Line width"
              value={prefs.chatWidth}
              min={INTERFACE_PREF_LIMITS.chatWidth.min}
              max={INTERFACE_PREF_LIMITS.chatWidth.max}
              step={INTERFACE_PREF_LIMITS.chatWidth.step}
              display={`${prefs.chatWidth}px`}
              onChange={(chatWidth) => onChange({ chatWidth })}
            />
          </section>
        </>
      )}
    </div>
  );
}

function DisplayModeControl({ value, onChange }: { value: DisplayMode; onChange: (value: DisplayMode) => void }) {
  const options: Array<{ value: DisplayMode; label: string }> = [
    { value: "auto", label: "Auto" },
    { value: "desktop", label: "Desktop" },
    { value: "eink", label: "Color e-ink" },
  ];
  return (
    <div className="prefs-mode" role="group" aria-label="Display mode">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
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
  const stepValue = (direction: -1 | 1) => {
    onChange(roundRangeValue(clampRangeValue(value + step * direction, min, max), step));
  };
  return (
    <div className="prefs-range">
      <div className="prefs-range-head">
        <b>{label}</b>
        <output>{display}</output>
      </div>
      <div className="range-stepper">
        <button type="button" className="range-step-button" onClick={() => stepValue(-1)} aria-label={`Decrease ${label}`}>
          -
        </button>
        <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <button type="button" className="range-step-button" onClick={() => stepValue(1)} aria-label={`Increase ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function clampRangeValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundRangeValue(value: number, step: number) {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(step < 1 ? 4 : 0));
}

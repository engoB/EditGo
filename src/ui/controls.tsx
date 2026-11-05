import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { toasts, beginGesture } from '../state/store';
import { Icon } from './icons';

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const { value, min, max } = props;
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label class="slider">
      <span class="slider-head">
        <span>{props.label}</span>
        <b>{props.format ? props.format(value) : value.toFixed(2)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={props.step ?? 0.01}
        value={value}
        style={{ '--p': `${pct}%` }}
        onPointerDown={() => beginGesture()}
        onKeyDown={(e) => e.key.startsWith('Arrow') && beginGesture()}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ComponentChildren; title?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div class={'seg' + (props.small ? ' seg-sm' : '')} role="radiogroup">
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          title={o.title}
          class={o.value === props.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>(props: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label class="field">
      {props.label && <span class="field-label">{props.label}</span>}
      <div class="select">
        <select value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value as T)}>
          {props.options.map((o) => (
            <option value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    </label>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label class="toggle">
      <span>
        {props.label}
        {props.hint && <small>{props.hint}</small>}
      </span>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <i />
    </label>
  );
}

const sectionState = new Map<string, boolean>();
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('editgo-sections') || '{}'))) sectionState.set(k, !!v);
} catch {
  /* préférences indisponibles */
}

/** Section repliable (état mémorisé par titre). */
export function Section(props: { title: string; children: ComponentChildren; right?: ComponentChildren; closed?: boolean }) {
  const key = props.title.replace(/\s*·.*$/, '');
  const [open, setOpen] = useState(sectionState.get(key) ?? !props.closed);
  const toggle = () => {
    const v = !open;
    setOpen(v);
    sectionState.set(key, v);
    try {
      localStorage.setItem('editgo-sections', JSON.stringify(Object.fromEntries(sectionState)));
    } catch {
      /* rien */
    }
  };
  return (
    <section class={'isec' + (open ? '' : ' closed')}>
      <header>
        <button class="isec-toggle" onClick={toggle} aria-expanded={open}>
          <i class="chev" />
          <h4>{props.title}</h4>
        </button>
        {open && props.right}
      </header>
      {open && props.children}
    </section>
  );
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={'toast toast-' + t.kind}>
          <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'error' ? 'x' : 'info'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

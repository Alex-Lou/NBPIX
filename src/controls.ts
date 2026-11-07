/**
 * The page's widgets. They know how to build themselves, how to read the state back, and nothing
 * else — no knowledge of the chain, of the canvases or of what any value means. One callback,
 * given once, says a value changed.
 *
 * Every control reads the state back on demand, because one control can change another's value:
 * picking the portrait frame sets the height, and a control showing a number the tool is not using
 * is a lie the eye believes.
 */

export interface Toggle<Key extends string> {
  readonly key: Key;
  /** What the toggle shows, e.g. an arrow for a corner. */
  readonly mark: string;
  readonly title: string;
}

export interface Controls {
  /** Reads every control's value back from the state. */
  readonly refresh: () => void;
  readonly group: (title: string, children: readonly HTMLElement[]) => HTMLElement;
  readonly range: (
    label: string,
    get: () => number,
    set: (value: number) => void,
    bounds: { readonly min: number; readonly max: number; readonly step: number },
    show?: (value: number) => string,
  ) => HTMLElement;
  readonly check: (label: string, get: () => boolean, set: (value: boolean) => void) => HTMLElement;
  readonly choice: (
    label: string,
    get: () => number,
    set: (value: number) => void,
    values: readonly { readonly value: number; readonly label: string }[],
  ) => HTMLElement;
  readonly toggles: <Key extends string>(
    label: string,
    items: readonly Toggle<Key>[],
    get: (key: Key) => boolean,
    set: (key: Key, value: boolean) => void,
  ) => HTMLElement;
  readonly button: (text: string, onClick: () => void) => HTMLButtonElement;
}

export function controlsOn(onChange: () => void): Controls {
  const refreshers: (() => void)[] = [];

  /** The row every control shares: its name, and room for what it is worth right now. */
  function labelled(label: string): { row: HTMLElement; value: HTMLElement } {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'value';
    row.append(name, value);
    return { row, value };
  }

  function changed(): void {
    onChange();
  }

  return {
    refresh: () => {
      for (const refresh of refreshers) refresh();
    },

    group: (title, children) => {
      const set = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = title;
      set.append(legend, ...children);
      return set;
    },

    range: (label, get, set, bounds, show = String) => {
      const { row, value } = labelled(label);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(bounds.min);
      input.max = String(bounds.max);
      input.step = String(bounds.step);
      input.value = String(get());
      value.textContent = show(get());
      input.addEventListener('input', () => {
        set(Number(input.value));
        value.textContent = show(get());
        changed();
      });
      refreshers.push(() => {
        // Only when it differs: writing the same value back mid-drag can interrupt the drag.
        if (input.value !== String(get())) input.value = String(get());
        value.textContent = show(get());
      });
      row.append(input);
      return row;
    },

    check: (label, get, set) => {
      const { row, value } = labelled(label);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = get();
      input.addEventListener('change', () => {
        set(input.checked);
        changed();
      });
      refreshers.push(() => {
        input.checked = get();
      });
      value.append(input);
      return row;
    },

    choice: (label, get, set, values) => {
      const { row, value } = labelled(label);
      const select = document.createElement('select');
      for (const option of values) {
        const node = document.createElement('option');
        node.value = String(option.value);
        node.textContent = option.label;
        select.append(node);
      }
      select.value = String(get());
      select.addEventListener('change', () => {
        set(Number(select.value));
        changed();
      });
      refreshers.push(() => {
        select.value = String(get());
      });
      value.append(select);
      return row;
    },

    toggles: (label, items, get, set) => {
      const { row, value } = labelled(label);
      const grid = document.createElement('div');
      grid.className = 'toggle-grid';
      for (const item of items) {
        const box = document.createElement('label');
        box.className = 'toggle';
        box.title = item.title;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = get(item.key);
        input.addEventListener('change', () => {
          set(item.key, input.checked);
          changed();
        });
        refreshers.push(() => {
          input.checked = get(item.key);
        });
        const mark = document.createElement('span');
        mark.textContent = item.mark;
        box.append(input, mark);
        grid.append(box);
      }
      value.append(grid);
      return row;
    },

    button: (text, onClick) => {
      const button = document.createElement('button');
      button.textContent = text;
      button.addEventListener('click', onClick);
      return button;
    },
  };
}

/** Fill a <select> with the model ladder, grouped by era. Used by the main prompt form and the compare chapter. */
import { MODELS, eraGroup } from './models.js';
import { el } from './dom.js';

export function buildModelSelect(select, { selected = null, noteNoLogprobs = true } = {}) {
  const groups = new Map();
  for (const m of MODELS) {
    const g = eraGroup(m);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  select.replaceChildren();
  for (const [label, models] of groups) {
    select.append(el('optgroup', { label },
      ...models.map(m => el('option', { value: m.id, text: m.label + (noteNoLogprobs && !m.logprobs ? ' · no probabilities' : '') }))));
  }
  if (selected) select.value = selected;
  return select;
}

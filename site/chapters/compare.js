// Chapter stub. The real module will export the same mount(root, store) shape; this one only marks the slot.
export function mount(root) {
  const viz = root.querySelector('.viz');
  if (!viz) return;
  const note = document.createElement('p');
  note.className = 'placeholder';
  note.textContent = 'Coming in a later step: the side-by-side era comparison.';
  viz.replaceChildren(note);
}

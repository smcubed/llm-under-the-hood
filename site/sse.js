/** Split accumulated SSE text into complete `data:` payloads. */
export function parseSSE(buffer) {
  const events = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop();
  for (const block of parts) {
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push(data.join('\n'));
  }
  return { events, rest };
}

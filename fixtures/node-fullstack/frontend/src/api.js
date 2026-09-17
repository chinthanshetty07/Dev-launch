// The shape that breaks a single-service runner: an absolute origin, resolved by the
// browser, pointing at a sibling service on a port nothing published.
const API = 'http://localhost:5001';

export const getHistory = () => fetch(`${API}/api/history`).then((r) => r.json());
export const optimize = (text) =>
  fetch(`${API}/api/optimize`, { method: 'POST', body: JSON.stringify({ text }) });

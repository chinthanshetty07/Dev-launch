// Reads configuration first, falls back to a hardcoded origin — the shape almost every
// real frontend ships, and the reason both halves of phase D exist. The fallback is
// resolved by the browser, so it only works if the API is published on exactly that port.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';

export const getHistory = () => fetch(`${API_URL}/api/history`).then((r) => r.json());
export const optimize = (text) =>
  fetch(`${API_URL}/api/optimize`, { method: 'POST', body: JSON.stringify({ text }) });

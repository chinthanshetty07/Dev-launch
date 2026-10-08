// The base the page calls, as written for life behind nginx: a path on its own address.
const API_BASE_URL = "/api";
export const hello = () => fetch(`${API_BASE_URL}/hello`).then((r) => r.json());

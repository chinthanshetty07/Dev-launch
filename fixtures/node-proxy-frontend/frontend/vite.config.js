// The proxy target is a literal, and it is the whole point of this fixture: inside the
// frontend's container `localhost` is the frontend, so every /api request 502s unless
// something repoints it at the backend service.
export default {
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5001', changeOrigin: true },
    },
  },
};

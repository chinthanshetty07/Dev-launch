fetch('/api/hello')
  .then((r) => r.json())
  .then((d) => { document.getElementById('root').textContent = `api says ${d.from}`; });

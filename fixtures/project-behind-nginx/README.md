# project-behind-nginx

A frontend that calls its API only as `/api/...` on its own address, and a backend beside
it, joined by an nginx that sends `/api` to the backend — the shape of
`jamall-mahmoudi-dev/django-react-production-stack`. Run without the nginx, the page's
calls reach the frontend and answer 404. DevLaunch must serve both at one address.

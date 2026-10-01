# python-fastapi-https

A FastAPI app that refuses plain HTTP, run over TLS with certificate files the repository
ships, as its README says:

```
uvicorn main:app --host 127.0.0.1 --port 8443 --ssl-certfile certs/localhost.pem --ssl-keyfile certs/localhost-key.pem
```

The `certs/` files are not committed: the test that uses this fixture copies it and makes a
throwaway self-signed pair with `openssl` first, so no private key lives in the repository.

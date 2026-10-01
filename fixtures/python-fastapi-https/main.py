from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()


# Like nkwus/fastapi-starter: plain HTTP is refused outright.
@app.middleware("http")
async def https_only(request: Request, call_next):
    if request.url.scheme != "https":
        return JSONResponse(status_code=403, content={"detail": "HTTPS is required for all requests."})
    return await call_next(request)


@app.get("/api_health")
def api_health():
    return {"status": "ok"}

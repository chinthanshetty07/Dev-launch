import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Stands in for the real thing this reproduces: an application that connects to
    # something at boot which never answers. Sleeping rather than dialling keeps the
    # fixture deterministic — a real unreachable host would depend on how this machine
    # times out, which is the one thing a fixture must not do.
    await asyncio.sleep(3600)
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def root():
    return {"never": "reached"}

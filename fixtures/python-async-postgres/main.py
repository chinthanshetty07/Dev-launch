import os

from fastapi import FastAPI, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Read exactly as the repositories this fixture stands for do: no default, because a
# default is what lets a misconfigured run look like a working one.
DATABASE_URL = os.environ["DATABASE_URL"]

app = FastAPI()
engine = create_async_engine(DATABASE_URL)


@app.get("/")
async def root(response: Response):
    # A real query, not a ping. The failure this fixture exists for — a synchronous
    # driver behind an async engine — happens at connect time and nowhere earlier.
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        return {"database": "reachable", "value": result.scalar()}

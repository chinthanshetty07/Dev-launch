# Written for Flask 2, as nsidnev/fastapi-realworld-example-app was written for pydantic 1:
# it refuses to start on the next major, which installing by name alone would give it.
from importlib.metadata import version

from flask import Flask

major = int(version("flask").split(".")[0])
if major != 2:
    raise RuntimeError(f"this application needs Flask 2 (pyproject says ^2.3); got Flask {version('flask')}")

app = Flask(__name__)


@app.get("/")
def index():
    return f"flask {version('flask')}\n"

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# A fixture, never a deployment: the key is fixed so runs are reproducible.
SECRET_KEY = "fixture-not-a-secret"
DEBUG = True

# DevLaunch publishes the container on an arbitrary host port, so the Host header is
# whatever Docker mapped. Django rejects an unknown Host with 400 before any view runs.
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth"]
MIDDLEWARE = []
ROOT_URLCONF = "demo.urls"
DATABASES = {}
USE_TZ = True

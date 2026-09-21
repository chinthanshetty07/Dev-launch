# python-django-basic

Django detection from `manage.py`, and a server that actually answers.

`DJANGO_SETTINGS_MODULE` pointed at `site.settings` and no `site/` directory existed.
`site` is a Python standard-library module, so the import resolved to that and failed
with `'site' is not a package` — every single run. No test noticed, because analysis and
planning read `manage.py` without ever importing anything.

`ALLOWED_HOSTS = ["*"]` matters here: DevLaunch publishes on an arbitrary host port, and
Django answers an unrecognised Host header with 400 before any view runs.

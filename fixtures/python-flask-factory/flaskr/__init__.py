"""The Flask tutorial's layout: the application is built by a factory in the package."""
from flask import Flask


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    if test_config is not None:
        app.config.update(test_config)

    @app.route("/")
    def index():
        return "flask factory fixture"

    return app

#!/usr/bin/env python
import os
import sys


def main():
    # Not "site": that is a standard-library module, and Python finds it first. A
    # settings package named after one can never be imported, which is how this fixture
    # spent its life planning correctly and failing the moment it was run.
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "demo.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()

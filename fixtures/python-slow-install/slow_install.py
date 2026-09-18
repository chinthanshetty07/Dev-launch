# Stands in for a dependency resolution that takes minutes.
#
# A real one downloads and backtracks; this one only waits, so the fixture is offline and
# takes the same time everywhere. What matters is that nothing listens on the port while
# it runs — which is exactly what readiness used to misread as a failure.
import os, sys, time

seconds = int(os.environ.get("FIXTURE_INSTALL_SECONDS", "75"))
print(f"resolving dependencies (simulated, {seconds}s)...", flush=True)
time.sleep(seconds)
print("dependencies installed", flush=True)
sys.exit(0)

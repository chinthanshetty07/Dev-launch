# node-port-conflict

Starts two servers on the same port. The second fails with EADDRINUSE and the process
exits. DevLaunch must name the port conflict, not report a missing port or READY.

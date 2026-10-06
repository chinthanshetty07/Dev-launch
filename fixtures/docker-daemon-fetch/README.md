# docker-daemon-fetch

`ADD` from the cloud-metadata address. The Docker daemon makes that download itself, on the
VM's own network, outside the egress rules; DevLaunch must refuse it by name and build nothing.

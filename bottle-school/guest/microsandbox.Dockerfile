# syntax=docker/dockerfile:1
# The microsandbox backend's guest: the Gondolin guest's filesystem (Dockerfile) plus what a guest with no network device
# needs. socat turns the host's vsock doors into localhost ports, and sshfs is for the folder support that comes later.
ARG BASE=pi-guest-base:v5
FROM ${BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat sshfs \
 && rm -rf /var/lib/apt/lists/*

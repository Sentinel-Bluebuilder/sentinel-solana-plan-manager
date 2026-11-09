#!/usr/bin/env python3
"""Loopback TCP bridge into WSL for the provider daemon.

dvpnd listens on a unix socket (gRPC control) and on *:9443 (provider HTTPS
API). A Plan Manager on Windows can reach 127.0.0.1:<port> inside WSL only
when something in WSL listens on IPv4 loopback, so this bridge does exactly
that and forwards raw bytes (TLS passes through untouched):

    python3 daemon-bridge.py 50052 unix:/root/dvpnd-provider/daemon.sock
    python3 daemon-bridge.py 9443  tcp:127.0.0.1:9443

Dev only. Binds 127.0.0.1.
"""
import asyncio
import sys


async def pump(reader, writer):
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001 - best-effort close on a dev bridge
            pass


async def open_target(target):
    if target.startswith("unix:"):
        return await asyncio.open_unix_connection(target[5:])
    if target.startswith("tcp:"):
        host, port = target[4:].rsplit(":", 1)
        return await asyncio.open_connection(host, int(port))
    raise ValueError(f"target must be unix:<path> or tcp:<host>:<port>, got {target}")


async def handle(target, client_reader, client_writer):
    try:
        upstream_reader, upstream_writer = await open_target(target)
    except OSError as exc:
        sys.stderr.write(f"bridge: cannot open {target}: {exc}\n")
        client_writer.close()
        return
    await asyncio.gather(
        pump(client_reader, upstream_writer),
        pump(upstream_reader, client_writer),
    )


async def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: daemon-bridge.py <listen port> <unix:/path | tcp:host:port>\n")
        sys.exit(2)
    port, target = int(sys.argv[1]), sys.argv[2]
    server = await asyncio.start_server(lambda r, w: handle(target, r, w), host="127.0.0.1", port=port)
    sys.stderr.write(f"bridge: 127.0.0.1:{port} -> {target}\n")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

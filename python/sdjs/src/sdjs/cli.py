"""`sdjs serve [root]`: the Python twin of the npm `sdjs` command."""

from __future__ import annotations

import argparse
import errno
import secrets
import sys
import urllib.parse
import webbrowser
from pathlib import Path

from sdjs.server import build_catalog, create_server, find_stores, resolve_served_root, stores_prefix

APP_DIR = Path(__file__).parent / "app"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
KIND_NOTE = {"zarr": "  (zarr, not SpatialData)", "unknown": "  (no zarr metadata)"}


def serve(args: argparse.Namespace) -> None:
    root = resolve_served_root(Path(args.root))
    token = None if args.no_token else secrets.token_urlsafe(16)
    app_dir = APP_DIR if (APP_DIR / "index.html").is_file() else None
    try:
        server = create_server(root, token, app_dir, args.host, 8000 if args.port is None else args.port,
                               args.host in LOOPBACK, args.depth)
    except OSError as e:
        # Only the default port falls back; an explicit --port that is taken is an error.
        if e.errno != errno.EADDRINUSE or args.port is not None:
            raise
        server = create_server(root, token, app_dir, args.host, 0, args.host in LOOPBACK, args.depth)
    port = server.server_address[1]
    host = f"[{args.host}]" if ":" in args.host else args.host
    origin = f"http://{host}:{port}"
    catalog_path = f"{stores_prefix(token)}catalog.json"
    viewer = f"{origin}/?catalog={urllib.parse.quote(catalog_path, safe='')}"
    stores = build_catalog(root, find_stores(root, args.depth))["stores"]
    print(f"Serving {len(stores)} store(s) under {root.dir}")
    for store in stores:
        print(f"  {store['path']}{KIND_NOTE.get(store.get('kind'), '')}")
    print(f"\nViewer:  {viewer}\nCatalog: {origin}{catalog_path}")
    if token:
        print("The URL carries an access token: share it like a password.")
    if app_dir is None:
        print("(No bundled viewer in this install; serving data only.)")
    elif not args.no_open:
        webbrowser.open(viewer)
    sys.stdout.flush()
    with server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="sdjs")
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser(
        "serve",
        help="Serve the SpatialData stores under a directory and open them in the viewer",
        description="Serve the SpatialData stores (*.zarr, *.zarr.zip) under root, and open "
                    "them in the bundled viewer.")
    p.add_argument("root", nargs="?", default=".", help="Directory or store (default: current directory)")
    p.add_argument("--port", type=int, default=None, help="Port (default 8000, or a free one if taken)")
    p.add_argument("--host", default="127.0.0.1", help="Interface to bind (default 127.0.0.1)")
    p.add_argument("--no-token", action="store_true",
                   help="Serve stores at a fixed /stores/ path rather than a random one")
    p.add_argument("--no-open", action="store_true", help="Do not open a browser")
    p.add_argument("--depth", type=int, default=8, help="How deep to look for stores (default 8)")
    p.set_defaults(func=serve)
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()

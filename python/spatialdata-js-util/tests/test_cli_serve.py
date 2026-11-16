"""`spatialdata-js-util serve` is sdjs's server, not a copy of it."""

from sdjs.cli import serve

from spatialdata_js_util.cli import build_parser


def test_serve_uses_sdjs():
    args = build_parser().parse_args(["serve", "stores", "--port", "9000", "--no-open"])
    assert args.func is serve
    assert (args.root, args.port, args.no_open, args.no_token) == ("stores", 9000, True, False)

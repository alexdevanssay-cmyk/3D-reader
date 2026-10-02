"""Command line: `python -m reader3d serve` or `python -m reader3d analyze FILE`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    from .mesh import UNITS

    parser = argparse.ArgumentParser(prog="reader3d", description="3D model reader: viewer and real volume calculation")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="start the web interface")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)

    an = sub.add_parser("analyze", help="print the volume and dimensions of a file")
    an.add_argument("file")
    an.add_argument("--unit", default="auto", choices=["auto", *UNITS], help="source unit of mesh files (default: auto)")
    an.add_argument("--json", action="store_true", help="print the full JSON result")

    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn

        uvicorn.run("reader3d.server:app", host=args.host, port=args.port)
    else:
        sys.exit(_analyze(args))


def _analyze(args) -> int:
    # Like the server, analyse in a child process: OpenCascade crashes on some
    # malformed files, which then gives an error message instead of a segfault.
    from .isolate import AnalysisCrashed, analyze_isolated

    if not Path(args.file).is_file():
        return _error(f"no such file: {args.file}")
    try:
        result = analyze_isolated(args.file, args.unit, include_mesh=False)
    except (ValueError, AnalysisCrashed) as exc:
        return _error(str(exc))
    except KeyboardInterrupt:  # the child is killed on the way out
        return 130
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        _print_report(result)
    return 0


def _error(message: str) -> int:
    print(f"reader3d: error: {message}", file=sys.stderr)
    return 1


def _fmt(v, unit, scale=1.0, digits=3):
    return "—" if v is None else f"{v / scale:,.{digits}f} {unit}"


def _print_report(r: dict) -> None:
    s = r["summary"]
    print(f"File: {r['file']}  ({r['kind']}, source unit: {r['source_unit']})")
    print(f"{'Body':30} {'Volume':>18} {'Area':>18}  Size (mm)")
    for b in r["bodies"]:
        size = " x ".join(f"{x:.2f}" for x in b["bbox"]["size"])
        print(f"{b['name'][:30]:30} {_fmt(b['volume'], 'cm3', 1000):>18} {_fmt(b['area'], 'cm2', 100):>18}  {size}")
        for n in b["notes"]:
            print(f"   ! {n}")
    print()
    print(f"Total real volume : {_fmt(s['volume'], 'mm3')}  ({_fmt(s['volume'], 'cm3', 1000)})")
    print(f"Total surface area: {_fmt(s['area'], 'mm2')}")
    print(f"Envelope (AABB)   : {' x '.join(f'{x:.3f}' for x in s['bbox']['size'])} mm  = {_fmt(s['bbox']['volume'], 'mm3')}")
    if s["obb"]:
        print(f"Envelope (min OBB): {' x '.join(f'{x:.3f}' for x in s['obb']['size'])} mm  = {_fmt(s['obb']['volume'], 'mm3')}")
    if s["fill_ratio"] is not None:
        print(f"Fill ratio        : {s['fill_ratio'] * 100:.2f} % of the envelope")


if __name__ == "__main__":
    main()

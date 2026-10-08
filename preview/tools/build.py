#!/usr/bin/env python3
"""Build the Dakscan preview.

Inlines src/stage.js and the asset modules in src/assets/ into src/page.html and writes:
  dist/dakscan-voorbeeld.html  body fragment, as published to the claude.ai artifact (it adds the <head>)
  dist/drone/index.html        standalone page for any static host (e.g. upload the folder as /drone/)

Asset modules are wrapped in IIFEs so their private names cannot collide.
Usage: python3 tools/build.py [--stubs]   (--stubs replaces the assets with empty placeholders)
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
DIST = ROOT / 'dist'
ALLOWED = {
    "import * as THREE from 'three';",
    "import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';",
}
KITS = {
    'trees.js': ('TreesKit', "function buildTree(){return new THREE.Group();}\nfunction buildShrub(){return new THREE.Group();}\nfunction buildHedge(){return new THREE.Group();}", ['buildTree', 'buildShrub', 'buildHedge']),
    'car.js': ('CarKit', "function buildCar(){return new THREE.Group();}", ['buildCar']),
    'drone.js': ('DroneKit', "function buildDrone(){return new THREE.Group();}\nfunction animateDrone(){}", ['buildDrone', 'animateDrone']),
    'neighbourhood.js': ('HoodKit', "function buildNeighbourhood(){const g=new THREE.Group();const m=new THREE.Mesh(new THREE.CircleGeometry(1500,64),new THREE.MeshStandardMaterial({color:0x5f8a45,roughness:1}));m.rotation.x=-Math.PI/2;m.receiveShadow=true;g.add(m);return {group:g,treeSpots:[],shrubSpots:[],hedgeRuns:[],carSpots:[]};}", ['buildNeighbourhood']),
}
# Same reset the artifact viewer wraps around the fragment, so the standalone page looks identical.
HEAD_RESET = (
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
    'body{margin:0;font:14px system-ui,sans-serif;background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style>'
)


def strip_module(src, name, allow_any_import=False):
    lines, out, exports = src.splitlines(), [], []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith('import '):
            stmt = ln
            while not stmt.rstrip().endswith(';'):
                i += 1
                stmt += ' ' + lines[i].strip()
            if not allow_any_import and stmt.strip() not in ALLOWED:
                sys.exit(f'{name}: import not allowed in an asset module: {stmt}')
            i += 1
            continue
        m = re.match(r'export (async )?function (\w+)', ln) or re.match(r'export (const|let) (\w+)', ln)
        if m:
            exports.append(m.group(2))
            ln = ln.replace('export ', '', 1)
        out.append(ln)
        i += 1
    return '\n'.join(out), exports


def main():
    stubs = '--stubs' in sys.argv
    page = (SRC / 'page.html').read_text()
    stage_src, _ = strip_module((SRC / 'stage.js').read_text(), 'stage.js', allow_any_import=True)
    kits = []
    for fname, (kit, stub, stub_exports) in KITS.items():
        f = SRC / 'assets' / fname
        if f.exists() and not stubs:
            body, exports = strip_module(f.read_text(), fname)
            status = 'real'
        else:
            body, exports, status = stub, stub_exports, 'STUB'
        kits.append(f"/* ---- {fname} ({status}) ---- */\nconst {kit} = (() => {{\n{body}\nreturn {{ {', '.join(exports)} }};\n}})();")
        print(f'{fname}: {status}, exports {exports}')
    fragment = page.replace('/*@@STAGE@@*/', '/* ---- render pipeline ---- */\n' + stage_src).replace('/*@@ASSETS@@*/', '\n\n'.join(kits))
    DIST.mkdir(exist_ok=True)
    (DIST / 'dakscan-voorbeeld.html').write_text(fragment)

    # Standalone: everything before the hidden SVG sprite (title, fonts, styles) goes into <head>.
    cut = fragment.index('<svg width="0" height="0"')
    head, body = fragment[:cut], fragment[cut:]
    standalone = (
        '<!doctype html>\n<html lang="nl">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="robots" content="noindex, nofollow">\n'
        f'{HEAD_RESET}\n{head.strip()}\n</head>\n<body>\n{body.strip()}\n</body>\n</html>\n'
    )
    (DIST / 'drone').mkdir(exist_ok=True)
    (DIST / 'drone' / 'index.html').write_text(standalone)
    print(f'wrote dist/dakscan-voorbeeld.html ({len(fragment)} bytes) and dist/drone/index.html ({len(standalone)} bytes)')


if __name__ == '__main__':
    main()

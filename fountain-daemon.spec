# PyInstaller spec for a distributable daemon .exe -- see build.ps1 for the
# one-command build. Bundles a frozen interpreter + every dependency into a
# single .exe so a site install no longer needs its own Python + a
# `fountain-daemon/.venv` set up by hand (main/index.ts's
# resolveDaemonPaths() picks this exe up automatically in a packaged
# Electron build -- see its `app.isPackaged` branch).
#
# Runtime behavior is unchanged: the built exe still reads/writes `data/`
# relative to its OWN current working directory, exactly like
# `python -m app.main` does today -- see app/persistence.py's DATA_DIR.
# Electron spawns it with cwd=<daemon resource dir>, so `data/` ends up
# next to the exe in a packaged install, same relationship as
# fountain-daemon/data/ today.
#
from PyInstaller.utils.hooks import collect_all

# --collect-all for pymodbus and pygame, not just --hidden-import: both
# import a large, version-varying set of their own submodules dynamically
# (pymodbus's transaction/framer registry, pygame's compiled extension
# modules), which PyInstaller's static analysis can't fully see coming.
# --collect-all is the blunt, sanctioned fix for exactly this -- it costs a
# few extra MB (pygame's own test suite comes along for the ride), which is
# a fine trade against a build that silently drops a device driver.
_datas = []
_binaries = []
_hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]
for _pkg in ("pymodbus", "pygame"):
    _d, _b, _h = collect_all(_pkg)
    _datas += _d
    _binaries += _b
    _hiddenimports += _h

a = Analysis(
    ["app/main.py"],
    pathex=[],
    binaries=_binaries,
    datas=_datas,
    hiddenimports=_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

# Passing a.binaries/a.datas straight into EXE (rather than routing them
# through a COLLECT() into a onedir/) is what makes this a single-file
# build -- everything gets appended to the .exe itself, unpacked to a temp
# dir at each run.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="fountain-daemon",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX-compressed pymodbus/pygame binaries have a history of
                # false-positive AV flags on a fresh Windows install -- not
                # worth the size savings for a one-file build this small.
    console=True,  # keep a console window: this exe is meant to be watched
                    # via Electron's own daemon-status/log-export UI, but a
                    # console window if someone runs it directly (as the
                    # "gave up after N restart attempts" log line suggests)
                    # is more useful than a silently vanishing background process.
)

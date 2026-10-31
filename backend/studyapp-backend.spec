# PyInstaller spec for the backend sidecar: `uv run pyinstaller studyapp-backend.spec --noconfirm`
# Output: dist/studyapp-backend/studyapp-backend.exe (one folder; electron-builder ships it as resources/backend).
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = [("studyapp/office_export.ps1", "studyapp")]
datas += collect_data_files("pptx") + collect_data_files("docx")  # default templates and XML schemas
datas += collect_data_files("pymupdf")  # pymupdf.layout's ONNX model and configs

hiddenimports = collect_submodules("uvicorn") + collect_submodules("studyapp") + collect_submodules("pymupdf")

a = Analysis(
    ["run_backend.py"],
    pathex=["."],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "matplotlib", "IPython"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="studyapp-backend",
    icon="../app/assets/icon.ico",
    console=True,  # keeps stdout for Electron's log; Electron spawns it with windowsHide
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="studyapp-backend", upx=False)

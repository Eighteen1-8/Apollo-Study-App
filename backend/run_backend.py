"""Entry point for the frozen backend (PyInstaller needs a script outside the package)."""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()  # pymupdf.layout starts worker processes; without this they rerun the backend
    from studyapp.main import main
    main()

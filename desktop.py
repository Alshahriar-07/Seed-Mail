"""Optional desktop packaging for Seed Code Mail using PyWebView.

This is NOT required to use the application.  Run ``python desktop.py`` to
start the FastAPI server on localhost in a background thread and open a
native desktop window pointing at it.

Security note: the web content is loaded over localhost HTTP only; no Python
objects are exposed to the page.
"""

from __future__ import annotations

import socket
import threading
import time

import uvicorn

import app as backend


def _free_port(start: int = 8000) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start


def main() -> None:
    port = _free_port()
    url = f"http://127.0.0.1:{port}"

    config = uvicorn.Config(backend.app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait for the server to accept connections.
    for _ in range(40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                break
        time.sleep(0.15)

    try:
        import webview  # type: ignore
    except ImportError:
        print("PyWebView is not installed. Run: python -m pip install -r requirements-dev.txt")
        print(f"The server is running at {url} - open it in your browser.")
        try:
            thread.join()
        except KeyboardInterrupt:
            server.should_exit = True
        return

    webview.create_window("Seed Code Mail", url, width=1360, height=880, min_size=(960, 640))
    webview.start()
    server.should_exit = True


if __name__ == "__main__":
    main()

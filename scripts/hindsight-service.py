"""Owned, optional Hindsight 1.1.0 service. Secrets arrive only on the parent pipe."""

import importlib.metadata
import json
import logging
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.request


def service_state_path(value):
    """Keep the same owned directory while allowing deep Windows model-cache paths."""
    state = Path(value).resolve()
    if os.name == "nt":
        path = str(state)
        if not path.startswith("\\\\?\\"):
            path = "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path
        state = Path(path)
    return state


def own_process_tree():
    """A forced service exit must also end its PostgreSQL descendants."""
    if os.name != "nt":
        if os.getpgrp() != os.getpid():
            raise RuntimeError("The service requires its own process group")
        return
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t),
                    ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", ctypes.c_uint64 * 6),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise RuntimeError("Cannot contain the service process tree")
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise RuntimeError("Cannot contain the service process tree")
    # Keep this non-inheritable handle open until the process exits; Windows then kills all descendants.
    globals()["_process_job"] = handle


def force_owned_exit():
    if os.name == "nt":
        os._exit(0)
    os.killpg(os.getpgrp(), signal.SIGKILL)


def create_authenticated_app(config):
    from hindsight_api import MemoryEngine
    from hindsight_api.api import create_app
    from hindsight_api.extensions.builtin.tenant import ApiKeyTenantExtension

    # The convenience HindsightServer bypasses environment-loaded tenant extensions.
    memory = MemoryEngine(
        db_url=config["databaseUrl"], memory_llm_provider="openai",
        memory_llm_api_key=config["bridgeToken"], memory_llm_model="pugport-memory",
        memory_llm_base_url=config["bridgeUrl"],
        tenant_extension=ApiKeyTenantExtension({"api_key": config["token"]}),
    )
    return create_app(memory=memory, mcp_api_enabled=False, initialize_memory=True)


def verify_authentication(url, token):
    for supplied, expected in ((None, 401), ("invalid-" + token, 401), (token, 200)):
        headers = {} if supplied is None else {"Authorization": "Bearer " + supplied}
        request = urllib.request.Request(url + "/v1/default/banks", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        if status != expected:
            raise RuntimeError("Hindsight authentication check failed")


def main():
    config = json.loads(sys.stdin.readline(16384))
    own_process_tree()
    stopping = threading.Event()
    forced = threading.Timer(10, force_owned_exit)
    forced.daemon = True

    def control():
        if os.name == "nt":
            import ctypes
            import msvcrt
            available = ctypes.c_ulong()
            peek = ctypes.WinDLL("kernel32").PeekNamedPipe
            peek.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong,
                             ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
            handle = msvcrt.get_osfhandle(sys.stdin.fileno())
            # Blocking CRT stdin reads can stall native DLL imports on Windows.
            while peek(handle, None, 0, None, ctypes.byref(available), None) and not available.value:
                stopping.wait(0.1)
        else:
            sys.stdin.readline()
        stopping.set()
        forced.start()

    # A Windows venv launcher is a separate parent process. Observe its control
    # pipe before imports so cancellation also exits the actual interpreter.
    threading.Thread(target=control, daemon=True).start()
    for distribution, expected in (
        ("hindsight-all", "1.1.0"), ("hindsight-api-slim", "1.1.0"),
        ("hindsight-embed", "1.1.0"), ("pg0-embedded", "0.15.2"),
    ):
        if importlib.metadata.version(distribution) != expected:
            raise RuntimeError("The pinned Hindsight and pg0 versions are required")

    state = service_state_path(config["stateDir"])
    logging.disable(logging.CRITICAL)
    os.environ.update({
        "HOME": str(state / "home"),
        "USERPROFILE": str(state / "home"),
        "HF_HOME": str(state / "models" / "huggingface"),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "NUMEXPR_MAX_THREADS": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "HINDSIGHT_API_TENANT_EXTENSION": "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
        "HINDSIGHT_API_TENANT_API_KEY": config["token"],
        "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION": "false",
        "HINDSIGHT_API_WORKER_ENABLED": "false",
        "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true",
        "HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH": "false",
        "HINDSIGHT_API_LLM_MAX_CONCURRENT": "1",
        "HINDSIGHT_API_LLM_MAX_RETRIES": "0",
        "HINDSIGHT_API_LLM_TIMEOUT": "190",
        "HINDSIGHT_API_LLM_STRUCTURED_OUTPUT_FORCED_TOOL": "false",
        "HINDSIGHT_API_LLM_TRACE_ENABLED": "false",
        "HINDSIGHT_API_RETAIN_MAX_CONCURRENT": "1",
        "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "local",
        "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL": "BAAI/bge-small-en-v1.5",
        "HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU": "true",
        "HINDSIGHT_API_EMBEDDINGS_LOCAL_TRUST_REMOTE_CODE": "false",
        "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
    })
    import uvicorn
    from pg0 import Pg0

    if stopping.is_set():
        return

    instance = config["databaseUrl"].rsplit("@", 1)[-1]
    if not re.fullmatch(r"pugport-[a-f0-9]{32}", instance):
        raise RuntimeError("Invalid owned database instance")
    database = Pg0(name=instance)
    if database.running:
        raise RuntimeError("The owned database is already running")

    server = uvicorn.Server(uvicorn.Config(
        app=lambda: create_authenticated_app(config), factory=True,
        host="127.0.0.1", port=int(config["port"]), log_level="error", loop="asyncio",
    ))
    thread = threading.Thread(target=server.run, daemon=True)
    try:
        thread.start()
        deadline = time.monotonic() + 150
        while thread.is_alive() and not server.started and not stopping.is_set():
            if time.monotonic() >= deadline:
                raise RuntimeError("Hindsight startup timed out")
            stopping.wait(0.1)
        if stopping.is_set():
            return
        if not server.started:
            raise RuntimeError("Hindsight startup failed")
        verify_authentication(f"http://127.0.0.1:{config['port']}", config["token"])
        print("PUGPORT_HINDSIGHT_READY 1.1.0", flush=True)
        stopping.wait()
    finally:
        try:
            server.should_exit = True
            thread.join(timeout=5)
            database.stop()
        finally:
            forced.cancel()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Provider bodies, environment values, and project text never enter application logs.
        print("Hindsight service unavailable", file=sys.stderr, flush=True)
        sys.exit(1)

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core import config
from app.routers import agentdock, ai, batch, commands, identity, lists, live, mcp, media, pdf, reviews, scan, system
from app.services import events, plugins, terminal


def _write_discovery() -> None:
    info = {"port": config.port(), "pid": os.getpid(), "version": config.VERSION, "desktop": config.is_desktop(), "started": time.time()}
    try:
        config.discovery_path().write_text(json.dumps(info), encoding="utf-8")
    except OSError:
        pass


def _clear_discovery() -> None:
    try:
        info = json.loads(config.discovery_path().read_text(encoding="utf-8"))
        if info.get("pid") == os.getpid():
            config.discovery_path().unlink()
    except (OSError, ValueError):
        pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    _write_discovery()
    loop = asyncio.get_running_loop()
    events.bind(loop)
    terminal.bind(loop)
    plugins.start()
    yield
    terminal.close_all()
    _clear_discovery()


app = FastAPI(title=config.APP_NAME, version=config.VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins(), allow_methods=["*"], allow_headers=["*"], expose_headers=["X-Slides", "X-Text-Boxes"])
app.include_router(system.router, prefix="/api")
app.include_router(media.router, prefix="/api")
app.include_router(pdf.router, prefix="/api")
app.include_router(batch.router, prefix="/api")
app.include_router(scan.router, prefix="/api")
app.include_router(identity.router, prefix="/api")
app.include_router(lists.router, prefix="/api")
app.include_router(reviews.router, prefix="/api")
app.include_router(ai.router, prefix="/api")
app.include_router(live.router)
app.include_router(agentdock.router)
app.include_router(commands.router)
app.include_router(mcp.router)

_dist = config.dist_dir()
if _dist is not None:
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")

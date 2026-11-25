"""
Modal Serverless 8-Core MPI OpenFOAM v2512 Engine for the 3D Pipe Flow Calculator.
80,000+ hexahedral O-grid 3D cells solved in ~12-20s (~$0.005 / ¥0.04 per run).
"""

import os

import modal

app = modal.App("pipe-calc-3d-openfoam")

image = (
    modal.Image.from_registry("opencfd/openfoam-run:2512", add_python="3.11")
    .apt_install("libglu1-mesa", "libgl1", "libgomp1")
    .pip_install("numpy", "vtk", "fastapi[standard]")
    .add_local_file("compute/pipe_calc_solver.py", "/app/pipe_calc_solver.py")
)


@app.function(
    image=image,
    cpu=8.0,
    memory=8192,
    timeout=360,
    scaledown_window=30,
    secrets=[modal.Secret.from_name("pipe-calc3d-secrets")],
)
@modal.asgi_app()
def fastapi_app():
    import sys

    sys.path.insert(0, "/app")
    from fastapi import Body, FastAPI, Header, HTTPException
    from pipe_calc_solver import PipeCalcParams, run_pipe_calc_3d

    web_app = FastAPI(title="3D Pipe Flow Calculator OpenFOAM 8-Core MPI")

    @web_app.get("/health")
    def health():
        return {"status": "ok", "engine": "openfoam2512-8core-mpi", "cells": "80k-hex-ogrid"}

    @web_app.post("/calculate")
    def calculate(payload: dict = Body(...), authorization: str | None = Header(default=None)):
        expected = os.environ.get("COMPUTE_AUTH_TOKEN", "")
        if expected and (not authorization or authorization != f"Bearer {expected}"):
            raise HTTPException(status_code=401, detail="Unauthorized")
        try:
            params = PipeCalcParams(
                diameter_mm=float(payload.get("diameter_mm", 80.0)),
                length_m=float(payload.get("length_m", 4.0)),
                flow_rate_lpm=float(payload.get("flow_rate_lpm", 450.0)),
                density_kgm3=float(payload.get("density_kgm3", 998.2)),
                viscosity_pas=float(payload.get("viscosity_pas", 0.001002)),
                geometry=str(payload.get("geometry", "straight")),
                pump_eff=float(payload.get("pump_eff", 0.75)),
            )
            return run_pipe_calc_3d(params)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    return web_app

"""
Modal Serverless 8-Core MPI OpenFOAM v2512 High-Resolution 3D Pipe Flow Calculator:
  Inputs  : diameter_mm, length_m, flow_rate_lpm, density_kgm3, viscosity_pas, geometry (straight|elbow), pump_eff
  Outputs : Pressure Drop (Pa/kPa/bar/head m), Reynolds Number & Regime, Darcy f (CFD vs Colebrook),
            Hydraulic & Shaft Pump Power (W/kW), + High-Res 3D VTPs (wall, longitudinal slice,
            5 axial cross-sections, 3D streamlines) & quantitative axial/radial curves.
"""

from __future__ import annotations

import hashlib
import math
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

OPENFOAM_BASHRC_CANDIDATES = [
    os.environ.get("OPENFOAM_BASHRC", ""),
    "/usr/lib/openfoam/openfoam2512/etc/bashrc",
    "/usr/lib/openfoam/openfoam2412/etc/bashrc",
    "/opt/openfoam2512/etc/bashrc",
]

N_PROCS = min(8, os.cpu_count() or 1)


@dataclass(frozen=True)
class PipeCalcParams:
    diameter_mm: float = 80.0       # Inner diameter D [15 .. 400 mm]
    length_m: float = 4.0           # Pipe length L [0.5 .. 50.0 m]
    flow_rate_lpm: float = 450.0    # Volumetric flow rate Q [2 .. 20000 L/min]
    density_kgm3: float = 998.2     # Fluid density rho [0.5 .. 3000 kg/m^3]
    viscosity_pas: float = 0.001002 # Dynamic viscosity mu [1e-5 .. 2.0 Pa·s]
    geometry: str = "straight"      # straight | elbow
    pump_eff: float = 0.75          # Pump efficiency [0.40 .. 0.95]

    def normalized(self) -> "PipeCalcParams":
        d = round(min(max(float(self.diameter_mm), 15.0), 400.0), 1)
        l = round(min(max(float(self.length_m), 0.5), 50.0), 2)
        q = round(min(max(float(self.flow_rate_lpm), 1.0), 30000.0), 1)
        rho = round(min(max(float(self.density_kgm3), 0.5), 3000.0), 2)
        mu = float(f"{min(max(float(self.viscosity_pas), 1.0e-5), 2.0):.4g}")
        geom = "elbow" if str(self.geometry).lower().strip() == "elbow" else "straight"
        eff = round(min(max(float(self.pump_eff), 0.40), 0.95), 2)
        return PipeCalcParams(
            diameter_mm=d,
            length_m=l,
            flow_rate_lpm=q,
            density_kgm3=rho,
            viscosity_pas=mu,
            geometry=geom,
            pump_eff=eff,
        )

    def case_key(self) -> str:
        p = self.normalized()
        c = (
            f"pcalc3d|g={p.geometry}|d={p.diameter_mm:.1f}|l={p.length_m:.2f}|"
            f"q={p.flow_rate_lpm:.1f}|r={p.density_kgm3:.2f}|m={p.viscosity_pas:.4g}|e={p.pump_eff:.2f}"
        )
        return hashlib.sha256(c.encode("utf-8")).hexdigest()[:16]


def _find_bashrc() -> Optional[str]:
    for p in OPENFOAM_BASHRC_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return None


def _run_foam(case_dir: Path, cmd: str, timeout: int = 240) -> str:
    bashrc = _find_bashrc()
    full_cmd = f"source '{bashrc}' >/dev/null 2>&1 || true; {cmd}" if bashrc else cmd
    proc = subprocess.run(
        ["bash", "-lc", full_cmd],
        cwd=str(case_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = "\n".join(proc.stdout.splitlines()[-28:])
        raise RuntimeError(f"OpenFOAM failed ({cmd}):\n{tail}")
    return proc.stdout


def _poly_to_ascii(poly) -> str:
    import vtk

    w = vtk.vtkXMLPolyDataWriter()
    w.SetWriteToOutputString(True)
    w.SetInputData(poly)
    w.SetDataModeToAscii()
    if w.Write() != 1:
        raise RuntimeError("Failed serializing VTP")
    return w.GetOutputString()


def _keep_only(poly, keep: Tuple[str, ...]):
    import vtk

    out = vtk.vtkPolyData()
    out.DeepCopy(poly)
    out.GetCellData().Initialize()
    out.GetFieldData().Initialize()
    pd = out.GetPointData()
    for n in [pd.GetArrayName(i) for i in range(pd.GetNumberOfArrays())]:
        if n not in keep:
            pd.RemoveArray(n)
    if keep and pd.GetArray(keep[0]) is not None:
        pd.SetActiveScalars(keep[0])
    return out


def _colebrook_darcy_f(re: float, roughness_m: float, d_m: float) -> float:
    """Exact analytical friction factor (Hagen-Poiseuille for laminar, Colebrook-White iteration for turbulent)."""
    if re < 2300.0:
        return 64.0 / max(re, 1.0)
    rel_e = roughness_m / max(d_m, 1e-6)
    # Haaland initial guess + 6 Newton/fixed-point Colebrook iterations
    inv_sqrt_f = -1.8 * math.log10((rel_e / 3.7) ** 1.11 + 6.9 / max(re, 2300.0))
    for _ in range(6):
        inv_sqrt_f = -2.0 * math.log10(rel_e / 3.7 + 2.51 * inv_sqrt_f / max(re, 2300.0))
    return 1.0 / (inv_sqrt_f ** 2)


def _build_straight_ogrid_blockmesh(D: float, L_sim: float) -> str:
    R = 0.5 * D
    a = 0.36 * R
    c = R / math.sqrt(2.0)
    pts2d = [(-a, -a), (+a, -a), (+a, +a), (-a, +a), (-c, -c), (+c, -c), (+c, +c), (-c, +c)]
    v_lines = [f"    ({xv:.8g} {yv:.8g} {zv:.8g}) // {s*8+i}" for s, xv in enumerate((0.0, L_sim)) for i, (yv, zv) in enumerate(pts2d)]
    arcs = [(4, 5, 0.0, -R), (5, 6, +R, 0.0), (6, 7, 0.0, +R), (7, 4, -R, 0.0)]
    e_lines = [f"    arc {s*8+i0} {s*8+i1} ({xv:.8g} {ym:.8g} {zm:.8g})" for s, xv in enumerate((0.0, L_sim)) for i0, i1, ym, zm in arcs]

    # High-resolution 3D grid: nc=10, nr=10 (wall grading 4.0/0.25), nx=160 -> 80,000 crisp hex cells
    nc, nr, nx = 10, 10, 160
    return f"""FoamFile
{{ version 2.0; format ascii; class dictionary; object blockMeshDict; }}
scale 1;
vertices
(
{chr(10).join(v_lines)}
);
blocks
(
    hex (0 1 2 3  8  9 10 11) ({nc} {nc} {nx}) simpleGrading (1 1 1)
    hex (4 5 1 0  12 13 9  8) ({nc} {nr} {nx}) simpleGrading (1 4.0 1)
    hex (1 5 6 2  9 13 14 10) ({nr} {nc} {nx}) simpleGrading (0.25 1 1)
    hex (3 2 6 7  11 10 14 15) ({nc} {nr} {nx}) simpleGrading (1 0.25 1)
    hex (4 0 3 7  12 8 11 15) ({nr} {nc} {nx}) simpleGrading (4.0 1 1)
);
edges
(
{chr(10).join(e_lines)}
);
boundary
(
    inlet  {{ type patch; faces ( (0 3 2 1) (4 0 1 5) (1 2 6 5) (3 7 6 2) (4 7 3 0) ); }}
    outlet {{ type patch; faces ( (8 9 10 11) (12 13 9 8) (9 13 14 10) (11 10 14 15) (12 8 11 15) ); }}
    walls  {{ type wall;  faces ( (4 5 13 12) (5 6 14 13) (6 7 15 14) (7 4 12 15) ); }}
);
mergePatchPairs ();
"""


def _build_elbow_ogrid_blockmesh(D: float, L_sim: float) -> Tuple[str, float, float, float]:
    """Build 90-degree circular 5-block O-grid pipe bend with straight inlet + bend + straight outlet."""
    R = 0.5 * D
    R_b = 2.0 * D
    arc_len = 0.5 * math.pi * R_b
    L_in = max(3.0 * D, 0.22 * (L_sim - arc_len))
    L_out = max(4.0 * D, L_sim - L_in - arc_len)

    a = 0.36 * R
    c = R / math.sqrt(2.0)
    local_pts = [(-a, -a), (+a, -a), (+a, +a), (-a, +a), (-c, -c), (+c, -c), (+c, +c), (-c, +c)]

    stations = [
        ((-L_in, R_b, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
        ((0.0, R_b, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
        ((R_b * math.sin(math.pi / 4), R_b * math.cos(math.pi / 4), 0.0), (math.sin(math.pi / 4), math.cos(math.pi / 4), 0.0), (0.0, 0.0, 1.0)),
        ((R_b, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
        ((R_b, -L_out, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    ]

    def st_pt(cen, nv, bv, u, v):
        return (cen[0] + u * nv[0] + v * bv[0], cen[1] + u * nv[1] + v * bv[1], cen[2] + u * nv[2] + v * bv[2])

    v_lines = []
    for s_idx, (cen, nv, bv) in enumerate(stations):
        for k, (u, v) in enumerate(local_pts):
            x, y, z = st_pt(cen, nv, bv, u, v)
            v_lines.append(f"    ({x:.8g} {y:.8g} {z:.8g}) // {s_idx*8+k}")

    nc, nr = 10, 10
    nz_list = [42, 28, 28, 56]
    block_lines = []
    for sec in range(4):
        A, B, nz = sec * 8, (sec + 1) * 8, nz_list[sec]
        block_lines.extend([
            f"    hex ({A+0} {A+1} {A+2} {A+3}  {B+0} {B+1} {B+2} {B+3}) ({nc} {nc} {nz}) simpleGrading (1 1 1)",
            f"    hex ({A+4} {A+5} {A+1} {A+0}  {B+4} {B+5} {B+1} {B+0}) ({nc} {nr} {nz}) simpleGrading (1 4.0 1)",
            f"    hex ({A+1} {A+5} {A+6} {A+2}  {B+1} {B+5} {B+6} {B+2}) ({nr} {nc} {nz}) simpleGrading (0.25 1 1)",
            f"    hex ({A+3} {A+2} {A+6} {A+7}  {B+3} {B+2} {B+6} {B+7}) ({nc} {nr} {nz}) simpleGrading (1 0.25 1)",
            f"    hex ({A+4} {A+0} {A+3} {A+7}  {B+4} {B+0} {B+3} {B+7}) ({nr} {nc} {nz}) simpleGrading (4.0 1 1)",
        ])

    e_lines = []
    cross_arcs = [(4, 5, (0.0, -R)), (5, 6, (+R, 0.0)), (6, 7, (0.0, +R)), (7, 4, (-R, 0.0))]
    for s_idx, (cen, nv, bv) in enumerate(stations):
        b = s_idx * 8
        for i0, i1, (um, vm) in cross_arcs:
            x, y, z = st_pt(cen, nv, bv, um, vm)
            e_lines.append(f"    arc {b+i0} {b+i1} ({x:.8g} {y:.8g} {z:.8g})")

    for seg, am in ((0, math.pi / 8.0), (1, 3.0 * math.pi / 8.0)):
        A, B = (1 + seg) * 8, (2 + seg) * 8
        cm = (R_b * math.sin(am), R_b * math.cos(am), 0.0)
        nm = (math.sin(am), math.cos(am), 0.0)
        for k, (u, v) in enumerate(local_pts):
            x, y, z = st_pt(cm, nm, (0.0, 0.0, 1.0), u, v)
            e_lines.append(f"    arc {A+k} {B+k} ({x:.8g} {y:.8g} {z:.8g})")

    L0 = 4 * 8
    wall_faces = []
    for sec in range(4):
        A, B = sec * 8, (sec + 1) * 8
        wall_faces.extend([
            f"({A+4} {A+5} {B+5} {B+4})",
            f"({A+5} {A+6} {B+6} {B+5})",
            f"({A+6} {A+7} {B+7} {B+6})",
            f"({A+7} {A+4} {B+4} {B+7})",
        ])

    bmd = f"""FoamFile
{{ version 2.0; format ascii; class dictionary; object blockMeshDict; }}
scale 1;
vertices
(
{chr(10).join(v_lines)}
);
blocks
(
{chr(10).join(block_lines)}
);
edges
(
{chr(10).join(e_lines)}
);
boundary
(
    inlet  {{ type patch; faces ( (0 3 2 1) (4 0 1 5) (1 2 6 5) (3 7 6 2) (4 7 3 0) ); }}
    outlet {{ type patch; faces ( ({L0+0} {L0+1} {L0+2} {L0+3}) ({L0+4} {L0+5} {L0+1} {L0+0}) ({L0+1} {L0+5} {L0+6} {L0+2}) ({L0+3} {L0+2} {L0+6} {L0+7}) ({L0+4} {L0+0} {L0+3} {L0+7}) ); }}
    walls  {{ type wall;  faces ( {" ".join(wall_faces)} ); }}
);
mergePatchPairs ();
"""
    return bmd, L_in, R_b, L_out


def run_pipe_calc_3d(raw_params: PipeCalcParams) -> Dict[str, Any]:
    import vtk
    from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

    t0 = time.perf_counter()
    params = raw_params.normalized()
    case_key = params.case_key()

    D = params.diameter_mm * 1e-3
    R = 0.5 * D
    A = math.pi * (R ** 2)
    Q_m3s = params.flow_rate_lpm / 60000.0
    U_mean = Q_m3s / A
    rho = params.density_kgm3
    mu = params.viscosity_pas
    nu = mu / rho
    Re = (rho * U_mean * D) / mu
    is_turb = Re >= 2300.0
    L_actual = params.length_m

    # Keep 3D CFD cell aspect ratios crisp by simulating up to 50*D directly (scaling fully-developed dp/dx to L_actual if longer)
    L_sim = min(L_actual, max(12.0 * D, min(50.0 * D, L_actual)))
    if params.geometry == "elbow":
        L_sim = max(L_sim, 11.0 * D)

    i_turb = 0.16 * (max(Re, 2300.0) ** (-0.125))
    k_in = max(1.5 * (U_mean * i_turb) ** 2, 1e-8)
    omega_in = max(math.sqrt(k_in) / (0.09 ** 0.25 * 0.07 * D), 0.1)

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"of_pcalc3d_{case_key}_"))
    try:
        for sub in ("0", "constant", "system"):
            (tmp_dir / sub).mkdir(parents=True, exist_ok=True)

        if params.geometry == "elbow":
            bmd, l_in_e, r_b_e, l_out_e = _build_elbow_ogrid_blockmesh(D, L_sim)
            L_sim_total = l_in_e + 0.5 * math.pi * r_b_e + l_out_e
        else:
            bmd = _build_straight_ogrid_blockmesh(D, L_sim)
            L_sim_total = L_sim

        (tmp_dir / "system" / "blockMeshDict").write_text(bmd)
        (tmp_dir / "system" / "controlDict").write_text("""FoamFile
{ version 2.0; format ascii; class dictionary; object controlDict; }
application simpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime 550;
deltaT 1; writeControl timeStep; writeInterval 550; purgeWrite 1;
writeFormat binary; writePrecision 8; writeCompression off; timeFormat general; timePrecision 6;
functions
{
    inletP  { type surfaceFieldValue; libs (fieldFunctionObjects); writeControl writeTime; writeFields false; regionType patch; name inlet; operation areaAverage; fields (p); }
    outletP { type surfaceFieldValue; libs (fieldFunctionObjects); writeControl writeTime; writeFields false; regionType patch; name outlet; operation areaAverage; fields (p); }
}
""")
        (tmp_dir / "system" / "decomposeParDict").write_text(f"""FoamFile
{{ version 2.0; format ascii; class dictionary; object decomposeParDict; }}
numberOfSubdomains {N_PROCS}; method scotch;
""")
        (tmp_dir / "system" / "fvSchemes").write_text("""FoamFile
{ version 2.0; format ascii; class dictionary; object fvSchemes; }
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; }
divSchemes
{
    default none;
    div(phi,U) bounded Gauss linearUpwind grad(U);
    div(phi,k) bounded Gauss upwind;
    div(phi,omega) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
wallDist { method meshWave; }
""")
        (tmp_dir / "system" / "fvSolution").write_text("""FoamFile
{ version 2.0; format ascii; class dictionary; object fvSolution; }
solvers
{
    p { solver GAMG; smoother GaussSeidel; tolerance 1e-6; relTol 0.05; }
    "(U|k|omega)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-6; relTol 0.1; }
}
SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; residualControl { p 1e-5; U 1e-5; "(k|omega)" 1e-5; } }
relaxationFactors { fields { p 0.3; } equations { U 0.7; k 0.65; omega 0.65; } }
""")
        (tmp_dir / "constant" / "transportProperties").write_text(f"""FoamFile
{{ version 2.0; format ascii; class dictionary; object transportProperties; }}
transportModel Newtonian; nu [0 2 -1 0 0 0 0] {nu:.8e};
""")
        (tmp_dir / "constant" / "turbulenceProperties").write_text(
            """FoamFile
{ version 2.0; format ascii; class dictionary; object turbulenceProperties; }
simulationType RAS; RAS { RASModel kOmegaSST; turbulence on; printCoeffs off; }
""" if is_turb else """FoamFile
{ version 2.0; format ascii; class dictionary; object turbulenceProperties; }
simulationType laminar;
"""
        )

        (tmp_dir / "0" / "U").write_text(f"""FoamFile
{{ version 2.0; format ascii; class volVectorField; object U; }}
dimensions [0 1 -1 0 0 0 0]; internalField uniform ({U_mean:.6g} 0 0);
boundaryField {{ inlet {{ type fixedValue; value uniform ({U_mean:.6g} 0 0); }} outlet {{ type zeroGradient; }} walls {{ type noSlip; }} }}
""")
        (tmp_dir / "0" / "p").write_text("""FoamFile
{ version 2.0; format ascii; class volScalarField; object p; }
dimensions [0 2 -2 0 0 0 0]; internalField uniform 0;
boundaryField { inlet { type zeroGradient; } outlet { type fixedValue; value uniform 0; } walls { type zeroGradient; } }
""")
        if is_turb:
            for fn, dim, val, wtype in (
                ("k", "[0 2 -2 0 0 0 0]", k_in, "kqRWallFunction"),
                ("omega", "[0 0 -1 0 0 0 0]", omega_in, "omegaWallFunction"),
            ):
                (tmp_dir / "0" / fn).write_text(f"""FoamFile
{{ version 2.0; format ascii; class volScalarField; object {fn}; }}
dimensions {dim}; internalField uniform {val:.6e};
boundaryField {{ inlet {{ type fixedValue; value uniform {val:.6e}; }} outlet {{ type zeroGradient; }} walls {{ type {wtype}; value uniform {val:.6e}; }} }}
""")
            (tmp_dir / "0" / "nut").write_text("""FoamFile
{ version 2.0; format ascii; class volScalarField; object nut; }
dimensions [0 2 -1 0 0 0 0]; internalField uniform 0;
boundaryField { inlet { type calculated; value uniform 0; } outlet { type calculated; value uniform 0; } walls { type nutkWallFunction; value uniform 0; } }
""")

        t_cfd0 = time.perf_counter()
        _run_foam(tmp_dir, "blockMesh", timeout=90)
        if N_PROCS > 1:
            _run_foam(tmp_dir, "decomposePar -force", timeout=90)
            _run_foam(
                tmp_dir,
                f"OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1 mpirun --allow-run-as-root --oversubscribe -np {N_PROCS} simpleFoam -parallel",
                timeout=240,
            )
            _run_foam(tmp_dir, "reconstructPar -latestTime", timeout=120)
        else:
            _run_foam(tmp_dir, "simpleFoam", timeout=240)
        _run_foam(tmp_dir, "foamToVTK -latestTime -noFaceZones", timeout=120)
        cfd_sec = time.perf_counter() - t_cfd0

        # Read inlet/outlet surfaceFieldValue pressures
        def read_patch_p(fn: str) -> float:
            files = sorted((tmp_dir / "postProcessing" / fn).rglob("*.dat"))
            for line in reversed(files[-1].read_text().splitlines()):
                s = line.strip()
                if s and not s.startswith("#"):
                    return float(s.split()[-1]) * rho
            return 0.0

        p_in_pa = read_patch_p("inletP")
        p_out_pa = read_patch_p("outletP")
        dp_sim_pa = max(p_in_pa - p_out_pa, 0.0)

        # Read VTK internal grid & outer pipe wall
        vtu_path = sorted((tmp_dir / "VTK").rglob("internal.vtu"), key=lambda p: p.stat().st_mtime)[-1]
        r_int = vtk.vtkXMLUnstructuredGridReader()
        r_int.SetFileName(str(vtu_path))
        r_int.Update()
        ug = r_int.GetOutput()
        c2p = vtk.vtkCellDataToPointData()
        c2p.SetInputData(ug)
        c2p.Update()
        ug_pt = c2p.GetOutput()

        walls_vtp = sorted((tmp_dir / "VTK").rglob("walls.vtp"), key=lambda p: p.stat().st_mtime)[-1]
        rw = vtk.vtkXMLPolyDataReader()
        rw.SetFileName(str(walls_vtp))
        rw.Update()
        c2pw = vtk.vtkCellDataToPointData()
        c2pw.SetInputData(rw.GetOutput())
        c2pw.Update()
        wall_poly = c2pw.GetOutput()
        w_pts = vtk_to_numpy(wall_poly.GetPoints().GetData()).astype(np.float64)
        wp_pa = vtk_to_numpy(wall_poly.GetPointData().GetArray("p")) * rho
        wp_v = numpy_to_vtk(wp_pa.astype(np.float32), deep=True)
        wp_v.SetName("p_pa")
        wall_poly.GetPointData().AddArray(wp_v)

        # Probe near-wall boundary-layer velocity & TKE at r = 0.84*R inside the pipe onto ALL 3D wall nodes!
        if params.geometry == "straight":
            centers = np.column_stack([w_pts[:, 0], np.zeros(len(w_pts)), np.zeros(len(w_pts))])
        else:
            centers = np.zeros_like(w_pts)
            m_in = w_pts[:, 0] < 0.0
            m_out = (~m_in) & (w_pts[:, 1] <= 0.0)
            m_arc = (~m_in) & (~m_out)
            centers[m_in, 0] = w_pts[m_in, 0]
            centers[m_in, 1] = r_b_e
            centers[m_out, 0] = r_b_e
            centers[m_out, 1] = w_pts[m_out, 1]
            ang_r = np.maximum(np.hypot(w_pts[m_arc, 0], w_pts[m_arc, 1]), 1e-6)
            centers[m_arc, 0] = r_b_e * w_pts[m_arc, 0] / ang_r
            centers[m_arc, 1] = r_b_e * w_pts[m_arc, 1] / ang_r

        probe_pts = w_pts - 0.16 * (w_pts - centers)
        pr_poly = vtk.vtkPolyData()
        pr_vpts = vtk.vtkPoints()
        pr_vpts.SetData(numpy_to_vtk(probe_pts.astype(np.float32), deep=True))
        pr_poly.SetPoints(pr_vpts)
        prober_w = vtk.vtkProbeFilter()
        prober_w.SetInputData(pr_poly)
        prober_w.SetSourceData(ug_pt)
        prober_w.Update()
        pw_pd = prober_w.GetOutput().GetPointData()
        uw_arr = pw_pd.GetArray("U")
        if uw_arr is not None:
            wu_mag = np.linalg.norm(vtk_to_numpy(uw_arr), axis=1).astype(np.float32)
        else:
            wu_mag = np.full(len(w_pts), U_mean * 0.85, dtype=np.float32)
        kw_arr = pw_pd.GetArray("k")
        wk_np = vtk_to_numpy(kw_arr).astype(np.float32) if kw_arr is not None else np.zeros(len(w_pts), dtype=np.float32)

        for nm, arr in (("U_mag", wu_mag), ("k_turb", wk_np)):
            va = numpy_to_vtk(arr, deep=True)
            va.SetName(nm)
            wall_poly.GetPointData().AddArray(va)

        def add_derived_fields(poly):
            pd = poly.GetPointData()
            u_np = vtk_to_numpy(pd.GetArray("U"))
            p_np = vtk_to_numpy(pd.GetArray("p"))
            k_arr = pd.GetArray("k")
            k_np = vtk_to_numpy(k_arr) if k_arr is not None else np.zeros(len(p_np), dtype=np.float32)
            for nm, arr in (
                ("U_mag", np.linalg.norm(u_np, axis=1).astype(np.float32)),
                ("p_pa", (p_np * rho).astype(np.float32)),
                ("k_turb", k_np.astype(np.float32)),
            ):
                va = numpy_to_vtk(arr, deep=True)
                va.SetName(nm)
                pd.AddArray(va)

        def cut_plane(origin, normal):
            pl = vtk.vtkPlane()
            pl.SetOrigin(*origin)
            pl.SetNormal(*normal)
            cut = vtk.vtkCutter()
            cut.SetCutFunction(pl)
            cut.SetInputData(ug_pt)
            cut.Update()
            tf = vtk.vtkTriangleFilter()
            tf.SetInputConnection(cut.GetOutputPort())
            tf.Update()
            p = tf.GetOutput()
            if p.GetNumberOfPoints() > 0:
                add_derived_fields(p)
            return p

        # Longitudinal center plane z = 0
        slice_long = cut_plane((0.0, 0.0, 0.0), (0.0, 0.0, 1.0))

        # 5 axial cross-sectional planes inside the 3D pipe (stacked into one multi-ring polydata!)
        append_rings = vtk.vtkAppendPolyData()
        if params.geometry == "straight":
            ring_specs = [((f * L_sim_total, 0.0, 0.0), (1.0, 0.0, 0.0)) for f in (0.04, 0.25, 0.50, 0.75, 0.96)]
        else:
            ring_specs = [
                ((-l_in_e * 0.7, r_b_e, 0.0), (1.0, 0.0, 0.0)),
                ((0.0, r_b_e, 0.0), (1.0, 0.0, 0.0)),
                ((r_b_e * math.sin(math.pi / 4), r_b_e * math.cos(math.pi / 4), 0.0), (math.cos(math.pi / 4), -math.sin(math.pi / 4), 0.0)),
                ((r_b_e, 0.0, 0.0), (0.0, 1.0, 0.0)),
                ((r_b_e, -l_out_e * 0.8, 0.0), (0.0, 1.0, 0.0)),
            ]
        for org, nrm in ring_specs:
            ring = cut_plane(org, nrm)
            if ring.GetNumberOfPoints() > 0:
                append_rings.AddInputData(ring)
        append_rings.Update()
        slice_cross = append_rings.GetOutput()

        # Probe axial pressure & radial velocity distribution
        def probe_pts(pts):
            pp = vtk.vtkPolyData()
            vp = vtk.vtkPoints()
            for x, y, z in pts:
                vp.InsertNextPoint(float(x), float(y), float(z))
            pp.SetPoints(vp)
            pr = vtk.vtkProbeFilter()
            pr.SetInputData(pp)
            pr.SetSourceData(ug_pt)
            pr.Update()
            return pr.GetOutput().GetPointData()

        if params.geometry == "straight":
            x_ax = np.linspace(0.02 * L_sim_total, 0.98 * L_sim_total, 40)
            p_ax = vtk_to_numpy(probe_pts([(float(x), 0.0, 0.0) for x in x_ax]).GetArray("p")) * rho
            s_over_d = x_ax / D
            # Developed gradient from second half of pipe
            m_dev = x_ax >= 0.45 * L_sim_total
            slope, _ = np.polyfit(x_ax[m_dev], p_ax[m_dev], 1)
            dp_dx_cfd = max(-float(slope), dp_sim_pa / max(L_sim_total, 1e-6))

            r_norm = np.linspace(-0.98, 0.98, 41)
            u_rad = np.maximum(vtk_to_numpy(probe_pts([(0.95 * L_sim_total, float(rn * R), 0.0) for rn in r_norm]).GetArray("U"))[:, 0], 0.0)
        else:
            # Sample along centerline of elbow: straight inlet -> 90 deg arc -> straight outlet
            pts_ax, s_m = [], []
            for f in np.linspace(0.05, 0.95, 10):
                pts_ax.append((-l_in_e * (1.0 - f), r_b_e, 0.0))
                s_m.append(f * l_in_e)
            for a in np.linspace(0.0, 0.5 * math.pi, 14)[1:]:
                pts_ax.append((r_b_e * math.sin(a), r_b_e * math.cos(a), 0.0))
                s_m.append(l_in_e + a * r_b_e)
            for f in np.linspace(0.05, 0.95, 16):
                pts_ax.append((r_b_e, -f * l_out_e, 0.0))
                s_m.append(l_in_e + 0.5 * math.pi * r_b_e + f * l_out_e)
            p_ax = vtk_to_numpy(probe_pts(pts_ax).GetArray("p")) * rho
            s_over_d = np.array(s_m) / D
            dp_dx_cfd = dp_sim_pa / max(L_sim_total, 1e-6)

            r_norm = np.linspace(-0.98, 0.98, 41)
            u_vec = vtk_to_numpy(probe_pts([(r_b_e + float(rn * R), -0.92 * l_out_e, 0.0) for rn in r_norm]).GetArray("U"))
            u_rad = np.linalg.norm(u_vec, axis=1)

        u_max_ms = max(float(np.max(u_rad)), U_mean, 1e-6)
        # Scale CFD Pressure Drop cleanly to full requested length L_actual
        if L_actual > L_sim_total + 1e-4:
            dp_cfd_total_pa = dp_sim_pa + dp_dx_cfd * (L_actual - L_sim_total)
        else:
            dp_cfd_total_pa = dp_sim_pa

        # Analytical Darcy-Weisbach + Colebrook-White (0.045 mm commercial steel roughness) + minor bend K=0.25 if elbow
        f_cfd = (dp_dx_cfd * D) / max(0.5 * rho * U_mean ** 2, 1e-9)
        f_colebrook = _colebrook_darcy_f(Re, 0.000045, D)
        k_minor = 0.25 if params.geometry == "elbow" else 0.0
        dp_analytic_pa = (f_colebrook * (L_actual / D) + k_minor) * 0.5 * rho * (U_mean ** 2)

        hyd_power_w = Q_m3s * dp_cfd_total_pa
        pump_power_w = hyd_power_w / params.pump_eff
        head_loss_m = dp_cfd_total_pa / (rho * 9.81)
        tau_wall_pa = 0.25 * dp_dx_cfd * D

        # 3D Velocity Streamlines inside the full 3D pipe
        bnds = ug_pt.GetBounds()
        res_img = vtk.vtkResampleToImage()
        res_img.SetInputDataObject(ug_pt)
        res_img.UseInputBoundsOff()
        res_img.SetSamplingBounds(bnds[0], bnds[1], bnds[2], bnds[3], -R * 1.05, R * 1.05)
        if params.geometry == "straight":
            res_img.SetSamplingDimensions(110, 28, 28)
        else:
            res_img.SetSamplingDimensions(72, 72, 26)
        res_img.Update()
        img = res_img.GetOutput()
        u_i = vtk_to_numpy(img.GetPointData().GetArray("U"))
        um_i = numpy_to_vtk(np.linalg.norm(u_i, axis=1).astype(np.float32), deep=True)
        um_i.SetName("U_mag")
        img.GetPointData().AddArray(um_i)
        img.GetPointData().SetActiveVectors("U")

        seeds = vtk.vtkPoints()
        x0_seed = 0.02 * L_sim_total if params.geometry == "straight" else -l_in_e * 0.94
        y0_seed = 0.0 if params.geometry == "straight" else r_b_e
        seeds.InsertNextPoint(x0_seed, y0_seed, 0.0)
        for rf in (0.35, 0.68, 0.88):
            for ang in range(0, 360, 60):
                rad = math.radians(ang)
                seeds.InsertNextPoint(x0_seed, y0_seed + rf * R * math.cos(rad), rf * R * math.sin(rad))
        seed_poly = vtk.vtkPolyData()
        seed_poly.SetPoints(seeds)

        tracer = vtk.vtkStreamTracer()
        tracer.SetInputData(img)
        tracer.SetSourceData(seed_poly)
        tracer.SetMaximumPropagation(L_sim_total * 1.15)
        tracer.SetInitialIntegrationStep(0.15 * D)
        tracer.SetMaximumIntegrationStep(0.4 * D)
        tracer.SetIntegrationDirectionToForward()
        tracer.SetIntegratorTypeToRungeKutta45()
        tracer.SetInputArrayToProcess(0, 0, 0, vtk.vtkDataObject.FIELD_ASSOCIATION_POINTS, "U")
        tracer.Update()

        raw_s = tracer.GetOutput()
        out_pts, out_lines, out_u = vtk.vtkPoints(), vtk.vtkCellArray(), []
        if raw_s.GetNumberOfPoints() > 0:
            s_pts = vtk_to_numpy(raw_s.GetPoints().GetData())
            s_u = vtk_to_numpy(raw_s.GetPointData().GetArray("U_mag"))
            lines = raw_s.GetLines()
            lines.InitTraversal()
            ids = vtk.vtkIdList()
            while lines.GetNextCell(ids):
                n = ids.GetNumberOfIds()
                if n < 5:
                    continue
                step = max(1, n // 68)
                idxs = list(range(0, n, step))
                if idxs[-1] != n - 1:
                    idxs.append(n - 1)
                nids = []
                for k in idxs:
                    oid = ids.GetId(k)
                    c = s_pts[oid]
                    nids.append(out_pts.InsertNextPoint(round(float(c[0]), 4), round(float(c[1]), 4), round(float(c[2]), 4)))
                    out_u.append(round(float(s_u[oid]), 4))
                out_lines.InsertNextCell(len(nids))
                for nid in nids:
                    out_lines.InsertCellPoint(nid)
        streams_poly = vtk.vtkPolyData()
        streams_poly.SetPoints(out_pts)
        streams_poly.SetLines(out_lines)
        if out_u:
            au = numpy_to_vtk(np.array(out_u, dtype=np.float32), deep=True)
            au.SetName("U_mag")
            streams_poly.GetPointData().SetScalars(au)

        files_content = {
            "wall.vtp": _poly_to_ascii(_keep_only(wall_poly, ("U_mag", "p_pa", "k_turb"))),
            "slice_long.vtp": _poly_to_ascii(_keep_only(slice_long, ("U_mag", "p_pa", "k_turb"))),
            "slice_cross.vtp": _poly_to_ascii(_keep_only(slice_cross, ("U_mag", "p_pa", "k_turb"))),
            "streamlines.vtp": _poly_to_ascii(streams_poly),
        }

        total_sec = time.perf_counter() - t0
        metrics = {
            "case_key": case_key,
            "params": asdict(params),
            "kpis": {
                "reynolds": round(Re, 0),
                "regime": "Turbulent (k-ω SST)" if is_turb else "Laminar (Hagen-Poiseuille)",
                "mean_velocity_ms": round(U_mean, 3),
                "max_velocity_ms": round(u_max_ms, 3),
                "pressure_drop_pa": round(dp_cfd_total_pa, 1),
                "pressure_drop_kpa": round(dp_cfd_total_pa / 1000.0, 3),
                "pressure_drop_analytic_pa": round(dp_analytic_pa, 1),
                "dp_dx_pam": round(dp_dx_cfd, 2),
                "head_loss_m": round(head_loss_m, 3),
                "hydraulic_power_w": round(hyd_power_w, 2),
                "pump_power_w": round(pump_power_w, 2),
                "pump_power_kw": round(pump_power_w / 1000.0, 4),
                "darcy_f_cfd": round(f_cfd, 4),
                "darcy_f_colebrook": round(f_colebrook, 4),
                "wall_shear_pa": round(tau_wall_pa, 2),
                "n_cells": int(ug.GetNumberOfCells()),
                "l_sim_m": round(L_sim_total, 3),
                "diameter_m": round(D, 4),
            },
            "charts": {
                "axial_pressure": {
                    "s_over_d": [round(float(x), 2) for x in s_over_d],
                    "p_pa": [round(float(v), 2) for v in p_ax],
                },
                "radial_profile": {
                    "r_over_r": [round(float(rn), 3) for rn in r_norm],
                    "u_norm_cfd": [round(float(v / u_max_ms), 4) for v in u_rad],
                    "u_power7": [round((1.0 - abs(float(rn))) ** (1.0 / 7.0), 4) for rn in r_norm],
                    "u_poiseuille": [round(1.0 - float(rn) ** 2, 4) for rn in r_norm],
                },
            },
            "timing_sec": {"cfd_openfoam": round(cfd_sec, 2), "total": round(total_sec, 2)},
            "file_sizes_kb": {k: round(len(v.encode("utf-8")) / 1024.0, 1) for k, v in files_content.items()},
            "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        return {"metrics": metrics, "files_content": files_content}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

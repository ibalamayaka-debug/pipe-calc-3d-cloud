export type GeometryId = 'straight' | 'elbow';
export type FieldId = 'U_mag' | 'p_pa' | 'k_turb';
export type PaletteId = 'rainbow' | 'thermal';

export interface PipeCalcParams {
  diameter_mm: number;
  length_m: number;
  flow_rate_lpm: number;
  density_kgm3: number;
  viscosity_pas: number;
  geometry: GeometryId;
  pump_eff: number;
}

export interface PipeCalcMetrics {
  case_key: string;
  params: PipeCalcParams;
  kpis: {
    reynolds: number;
    regime: string;
    mean_velocity_ms: number;
    max_velocity_ms: number;
    pressure_drop_pa: number;
    pressure_drop_kpa: number;
    pressure_drop_analytic_pa: number;
    dp_dx_pam: number;
    head_loss_m: number;
    hydraulic_power_w: number;
    pump_power_w: number;
    pump_power_kw: number;
    darcy_f_cfd: number;
    darcy_f_colebrook: number;
    wall_shear_pa: number;
    n_cells: number;
    l_sim_m: number;
    diameter_m: number;
  };
  charts: {
    axial_pressure: { s_over_d: number[]; p_pa: number[] };
    radial_profile: { r_over_r: number[]; u_norm_cfd: number[]; u_power7: number[]; u_poiseuille: number[] };
  };
  timing_sec: { cfd_openfoam: number; total: number };
  computed_at: string;
}

export interface PipeCalcResponse {
  status: string;
  cached: boolean;
  backend: string;
  case_key: string;
  metrics: PipeCalcMetrics;
  urls: {
    wall: string;
    slice_long: string;
    slice_cross: string;
    streamlines: string;
    metrics: string;
  };
}

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/*                                                                            */
/* One PerspectiveCamera throughout. Blending an orthographic and a            */
/* perspective projection matrix is fiddly and looks wrong at the midpoint, so */
/* the flat state is a very narrow field of view pulled far back: visually     */
/* orthographic, and a single scalar to animate alongside the morph.           */
/* Distance tracks the field of view so framing stays constant while it moves. */
/* -------------------------------------------------------------------------- */

export const FOV_3D = 42;
export const FOV_2D = 8;

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export type Flight = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  spline: THREE.CatmullRomCurve3;
  start: number;
  duration: number;
  onArrive?: () => void;
};

export class TreeCamera {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(0, 45, 0);

  /** Orbit state. Distance is derived from framing, never set directly. */
  azimuth = 0.6;
  elevation = 0.22;
  frameHeight = 130;

  private flight: Flight | null = null;
  private velAz = 0;
  private velEl = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private reduceMotion = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV_3D, aspect, 0.5, 8000);
    this.apply(1);
  }

  setReduceMotion(v: boolean): void {
    this.reduceMotion = v;
  }

  /** Distance that keeps `frameHeight` world units filling the viewport at the current FOV. */
  private distance(): number {
    const fov = (this.camera.fov * Math.PI) / 180;
    return this.frameHeight / (2 * Math.tan(fov / 2));
  }

  /**
   * `morph` 0 is the flat state, 1 is the orbitable one. The flat state is a
   * drawing on a plate, so the camera squares up to it as the field of view
   * narrows; anything else reads as a three-dimensional tree seen badly.
   */
  setUnfold(morph: number): void {
    this.camera.fov = FOV_2D + (FOV_3D - FOV_2D) * morph;
    this.camera.updateProjectionMatrix();
    if (morph < 0.999 && !this.dragging) {
      const pull = (1 - morph) * 0.14;
      this.azimuth += (0 - this.azimuth) * pull;
      this.elevation += (0.06 - this.elevation) * pull;
      this.velAz *= 1 - pull;
      this.velEl *= 1 - pull;
    }
  }

  frame(bounds: { min: [number, number, number]; max: [number, number, number] }, aspect: number): void {
    const h = bounds.max[1] - bounds.min[1];
    const w = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]);
    this.target.set(0, (bounds.min[1] + bounds.max[1]) / 2, 0);
    this.frameHeight = Math.max(h * 1.18, (w * 1.25) / Math.max(0.4, aspect), 20);
  }

  apply(_dt: number): void {
    const d = this.distance();
    const ce = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + Math.sin(this.azimuth) * ce * d,
      this.target.y + Math.sin(this.elevation) * d,
      this.target.z + Math.cos(this.azimuth) * ce * d,
    );
    this.camera.lookAt(this.target);
  }

  update(dt: number, now: number): void {
    if (this.flight) {
      const raw = (now - this.flight.start) / this.flight.duration;
      const t = EASE(Math.min(1, raw));
      const p = this.flight.spline.getPoint(t);
      const tgt = this.flight.fromTarget.clone().lerp(this.flight.toTarget, t);
      this.target.copy(tgt);
      this.camera.position.copy(p);
      this.camera.lookAt(this.target);
      if (raw >= 1) {
        // Hand control back to the orbit state without a jump.
        const rel = this.camera.position.clone().sub(this.target);
        this.frameHeight = 2 * rel.length() * Math.tan((this.camera.fov * Math.PI) / 360);
        this.elevation = Math.asin(THREE.MathUtils.clamp(rel.y / rel.length(), -1, 1));
        this.azimuth = Math.atan2(rel.x, rel.z);
        const done = this.flight.onArrive;
        this.flight = null;
        done?.();
      }
      return;
    }

    // Inertia, so a flick keeps drifting. Reduced motion kills it outright.
    if (!this.dragging) {
      this.azimuth += this.velAz * dt;
      this.elevation += this.velEl * dt;
      const damp = Math.exp(-dt * (this.reduceMotion ? 40 : 4.2));
      this.velAz *= damp;
      this.velEl *= damp;
    }
    this.elevation = THREE.MathUtils.clamp(this.elevation, -0.35, 1.35);
    this.apply(dt);
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  /**
   * Fly to an offset from a world point along a Catmull-Rom spline, easing in
   * and out. The arc is what makes it read as travelling rather than cutting.
   */
  flyTo(point: THREE.Vector3, now: number, duration = 1200, onArrive?: () => void): void {
    const from = this.camera.position.clone();
    const fromTarget = this.target.clone();
    const dir = new THREE.Vector3(Math.sin(this.azimuth), 0.32, Math.cos(this.azimuth)).normalize();
    const dist = Math.max(14, this.frameHeight * 0.22);
    const to = point.clone().add(dir.multiplyScalar(dist));

    // Lift the midpoint out of the tree so the path arcs around it.
    const mid = from.clone().lerp(to, 0.5);
    mid.y += from.distanceTo(to) * 0.16;
    mid.multiplyScalar(1.06);

    this.flight = {
      from,
      to,
      fromTarget,
      toTarget: point.clone(),
      spline: new THREE.CatmullRomCurve3([from, mid, to], false, 'catmullrom', 0.4),
      start: now,
      duration: this.reduceMotion ? Math.min(duration, 260) : duration,
      onArrive,
    };
  }

  cancelFlight(): void {
    this.flight = null;
  }

  /* ---- input ---- */

  onPointerDown(x: number, y: number): void {
    this.dragging = true;
    this.lastX = x;
    this.lastY = y;
    this.cancelFlight();
  }

  onPointerMove(x: number, y: number, allowOrbit: boolean): void {
    if (!this.dragging) return;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    if (!allowOrbit) return;
    this.azimuth -= dx * 0.006;
    this.elevation += dy * 0.004;
    this.velAz = -dx * 0.06;
    this.velEl = dy * 0.04;
  }

  onPointerUp(): void {
    this.dragging = false;
  }

  onWheel(delta: number): void {
    this.cancelFlight();
    this.frameHeight = THREE.MathUtils.clamp(this.frameHeight * Math.exp(delta * 0.0012), 8, 900);
  }

  nudge(dAz: number, dEl: number): void {
    this.cancelFlight();
    this.azimuth += dAz;
    this.elevation = THREE.MathUtils.clamp(this.elevation + dEl, -0.35, 1.35);
  }

  /** Normalized camera height, 0 at the ground and 1 at the crown. Drives the ambient bed. */
  heightFactor(bounds: { min: [number, number, number]; max: [number, number, number] }): number {
    const span = Math.max(1, bounds.max[1] - bounds.min[1]);
    return THREE.MathUtils.clamp((this.camera.position.y - bounds.min[1]) / span, 0, 1);
  }
}

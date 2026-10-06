/** Continuous display positions are measured in records, not pixels or pages. */
export interface GalleryPoint {x: number; y: number}
export type GalleryOrbitMode = 'flow' | 'crate' | 'fan' | 'ring';
export interface GalleryMotionState {
  position: number;
  velocity: number;
  phase: 'coast' | 'settle' | 'idle';
  target: number | null;
}

const FRICTION = 5.8;
const SETTLE_RATE = 14;
const COAST_END = .045;

export function clampGalleryPosition(position: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), Number.isFinite(position) ? position : min));
}

/** The repeat must restore both the record sequence and all three lane phases. */
export function galleryIsometricPeriod(count: number): number {
  const length = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return length % 3 === 0 ? length : length * 3;
}

/** Positive modulo preserves fractional free-scroll positions across either seam. */
export function wrapGalleryPosition(position: number, period: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(period) || period <= 0) return 0;
  const remainder = position % period;
  return remainder < 0 ? remainder + period : remainder || 0;
}

export interface GalleryIsometricSlot {
  slot: number;
  row: number;
  lane: number;
  recordIndex: number;
}

/** A bounded virtual window over an endless sequence; no blank lanes at either end. */
export function galleryIsometricSlots(position: number, count: number, radius = 6): GalleryIsometricSlot[] {
  const length = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!length) return [];
  const center = Math.floor((Number.isFinite(position) ? position : 0) / 3);
  const reach = Number.isFinite(radius) ? Math.max(0, Math.min(6, Math.floor(radius))) : 6;
  const slots: GalleryIsometricSlot[] = [];
  for (let row = center - reach; row <= center + reach; row++) {
    for (let lane = 0; lane < 3; lane++) {
      const slot = row * 3 + lane;
      slots.push({slot, row, lane, recordIndex: wrapGalleryPosition(slot, length)});
    }
  }
  return slots;
}

export function projectGalleryLine(delta: GalleryPoint, direction: GalleryPoint, pitch: number): number {
  const length = Math.hypot(direction.x, direction.y);
  if (!length || pitch <= 0) return 0;
  return (delta.x * direction.x + delta.y * direction.y) / length / pitch;
}

/** Recent samples rather than the last event alone avoid a noisy release impulse. */
export function galleryReleaseVelocity(samples: ReadonlyArray<{position: number; at: number}>): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const recent = samples.filter(sample => last.at - sample.at <= 100);
  if (recent.length < 2 || last.at - recent[0].at < 12) return 0;
  const origin = recent[0].at;
  const meanTime = recent.reduce((sum, sample) => sum + (sample.at - origin) / 1000, 0) / recent.length;
  const meanPosition = recent.reduce((sum, sample) => sum + sample.position, 0) / recent.length;
  let numerator = 0, denominator = 0;
  for (const sample of recent) {
    const time = (sample.at - origin) / 1000 - meanTime;
    numerator += time * (sample.position - meanPosition);
    denominator += time * time;
  }
  return denominator ? Math.max(-10, Math.min(10, numerator / denominator)) : 0;
}

export function releaseGalleryMotion(position: number, velocity: number, min: number, max: number,
                                     snap: boolean): GalleryMotionState {
  const bounded = clampGalleryPosition(position, min, max);
  const speed = Number.isFinite(velocity) ? Math.max(-10, Math.min(10, velocity)) : 0;
  if (Math.abs(speed) > COAST_END && !((bounded === min && speed < 0) || (bounded === max && speed > 0))) {
    return {position: bounded, velocity: speed, phase: 'coast', target: null};
  }
  const target = snap ? clampGalleryPosition(Math.round(bounded), min, max) : bounded;
  return {position: bounded, velocity: 0, phase: target === bounded ? 'idle' : 'settle', target};
}

/** Exact exponential coast and critically damped settle; independent of frame rate. */
export function advanceGalleryMotion(state: GalleryMotionState, seconds: number, min: number, max: number,
                                     snap: boolean): GalleryMotionState {
  let position = clampGalleryPosition(state.position, min, max);
  let velocity = state.velocity;
  let target = state.target;
  let phase = state.phase;
  let time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (phase === 'idle' || !time) return {...state, position};
  if (phase === 'coast') {
    const endAt = Math.max(0, Math.log(Math.max(Math.abs(velocity), COAST_END) / COAST_END) / FRICTION);
    const coastTime = Math.min(time, endAt);
    const decay = Math.exp(-FRICTION * coastTime);
    const raw = position + velocity * (1 - decay) / FRICTION;
    position = clampGalleryPosition(raw, min, max);
    velocity *= decay;
    time -= coastTime;
    if (raw !== position || coastTime >= endAt) {
      target = snap ? clampGalleryPosition(Math.round(position), min, max) : position;
      velocity = raw !== position ? 0 : velocity;
      phase = target === position ? 'idle' : 'settle';
    }
  }
  if (phase === 'settle' && target !== null) {
    const error = position - target;
    const coupling = velocity + SETTLE_RATE * error;
    const decay = Math.exp(-SETTLE_RATE * time);
    position = clampGalleryPosition(target + (error + coupling * time) * decay, min, max);
    velocity = (velocity - SETTLE_RATE * coupling * time) * decay;
    if (Math.abs(position - target) < .0005 && Math.abs(velocity) < .006) {
      position = target; velocity = 0; phase = 'idle';
    }
  }
  return {position, velocity: phase === 'idle' ? 0 : velocity, phase, target};
}

export interface GalleryOrbitPose {
  x: number; y: number; z: number;
  rotateX: number; rotateY: number; rotateZ: number;
  scale: number; opacity: number;
}

function mixOrbitPose(a: GalleryOrbitPose, b: GalleryOrbitPose, fraction: number): GalleryOrbitPose {
  return {
    x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction,
    z: a.z + (b.z - a.z) * fraction,
    rotateX: a.rotateX + (b.rotateX - a.rotateX) * fraction,
    rotateY: a.rotateY + (b.rotateY - a.rotateY) * fraction,
    rotateZ: a.rotateZ + (b.rotateZ - a.rotateZ) * fraction,
    scale: a.scale + (b.scale - a.scale) * fraction,
    opacity: a.opacity + (b.opacity - a.opacity) * fraction,
  };
}

function sampleOrbitPose(mode: GalleryOrbitMode, offset: number, handoff = true): GalleryOrbitPose {
  const a = Math.abs(offset);
  const pose: GalleryOrbitPose = {x: 0, y: 0, z: 0, rotateX: 0, rotateY: 0, rotateZ: 0,
    scale: 1, opacity: Math.max(0, Math.min(1, 3.6 - a))};
  if (mode === 'flow') {
    pose.x = Math.sign(offset) * (a <= 1 ? .98 * a : .98 + .67 * (a - 1));
    pose.z = .14 - .38 * a;
    pose.rotateY = -Math.sign(offset) * Math.min(a, 1.5) * 43;
    pose.scale = 1 - .08 * Math.min(a, 3);
  } else if (mode === 'crate') {
    const tipped = Math.min(Math.max(-offset, 0), 1);
    pose.y = offset < 0 ? -.58 * offset : -.13 * offset;
    pose.z = offset < 0 ? .06 + .06 * tipped : .06 - .18 * offset;
    pose.rotateX = offset < 0 ? -3 + 78 * tipped : -3 - 2 * Math.min(offset, 4);
    pose.opacity = offset <= -1 ? 0 : 1;
  } else if (mode === 'fan') {
    const angle = offset * .33;
    pose.x = 1.6 * Math.sin(angle);
    pose.y = -.08 + 1.6 * (1 - Math.cos(angle));
    pose.z = .08 - .07 * a;
    pose.rotateZ = offset * 19;
    pose.scale = 1 - .05 * Math.min(a, 4);
    if (handoff) {
      // Keep the resting arc and size. A broad local side turn changes
      // occlusion without throwing either cover up/down or pulsing its scale.
      const left = Math.floor(offset * 2) / 2;
      const base = mixOrbitPose(sampleOrbitPose(mode, left, false), sampleOrbitPose(mode, left + .5, false), (offset - left) * 2);
      Object.assign(pose, base);
      const turn = a < 1 ? Math.sin(Math.PI * a) ** 2 : 0;
      if (turn) {
        pose.x += Math.sign(offset) * .035 * turn;
        pose.rotateY = -Math.sign(offset) * 78 * turn;
      }
    }
  } else {
    const angle = offset * .62;
    pose.x = 1.45 * Math.sin(angle);
    pose.y = .14 - .86 * (1 - Math.cos(angle));
    pose.z = .16 - 1.5 * (1 - Math.cos(angle));
    pose.rotateY = -Math.max(-78, Math.min(78, offset * 32));
    pose.scale = 1 - .04 * Math.min(a, 4);
  }
  return pose;
}

/** Matches external CSS seeking, including the fan's eighth-record handoff keyframes. */
export function galleryOrbitPose(mode: GalleryOrbitMode, offset: number, handoff = true): GalleryOrbitPose {
  const bounded = Math.max(-4, Math.min(4, offset));
  const rate = mode === 'fan' && handoff ? 8 : 2;
  const left = Math.floor(bounded * rate) / rate;
  const fraction = (bounded - left) * rate;
  return mixOrbitPose(sampleOrbitPose(mode, left, handoff), sampleOrbitPose(mode, Math.min(4, left + 1 / rate), handoff), fraction);
}

/** The fan exchanges whole composited cases while their silhouettes are apart. */
export function galleryFanLayer(offset: number): number {
  // Adjacent cases on one side always retain their inner-to-outer order. Ties
  // occur only across the fan, where the silhouettes have already separated.
  return 9 - Math.floor(Math.min(4, Math.abs(offset)) * 2);
}

/** Project the solid case's eight corners, including its largest thickness/contact lift. */
export function galleryOrbitCorners(mode: GalleryOrbitMode, offset: number, size: number,
                                    perspective = 1050, contact = false): GalleryPoint[] {
  const pose = galleryOrbitPose(mode, offset);
  const rx = pose.rotateX * Math.PI / 180, ry = pose.rotateY * Math.PI / 180, rz = pose.rotateZ * Math.PI / 180;
  const contactScale = contact ? 1.012 : 1;
  const points: GalleryPoint[] = [];
  for (const sideX of [-1, 1]) for (const sideY of [-1, 1]) for (const sideZ of [-1, 1]) {
    const x = sideX * size * .5 * contactScale, y = sideY * size * .5 * contactScale;
    const z = sideZ * 3 * contactScale + (contact ? 12 : 0);
    const az = x * Math.cos(rz) - y * Math.sin(rz), bz = x * Math.sin(rz) + y * Math.cos(rz);
    const ay = az * Math.cos(ry) + z * Math.sin(ry), cy = -az * Math.sin(ry) + z * Math.cos(ry);
    const by = bz * Math.cos(rx) - cy * Math.sin(rx), cz = bz * Math.sin(rx) + cy * Math.cos(rx);
    const projection = perspective / (perspective - pose.z * size - cz * pose.scale);
    points.push({x: (pose.x * size + ay * pose.scale) * projection,
      y: (pose.y * size + by * pose.scale) * projection});
  }
  return points;
}

/** Conservative bounds. Shadows are not solid cover silhouettes. */
export function galleryOrbitBounds(mode: GalleryOrbitMode, offset: number, size: number,
                                   perspective = 1050, contact = false) {
  const points = galleryOrbitCorners(mode, offset, size, perspective, contact);
  return {left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
    top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y))};
}

export function galleryOrbitPoint(mode: GalleryOrbitMode, offset: number, size: number,
                                   perspective = 1050): GalleryPoint {
  const pose = galleryOrbitPose(mode, offset, mode !== 'fan');
  const projection = perspective / (perspective - pose.z * size);
  return {x: pose.x * size * projection, y: pose.y * size * projection};
}

/** Closest screen-space point on the visible rail, with branch continuity for a curved rail. */
export function projectGalleryOrbit(mode: GalleryOrbitMode, point: GalleryPoint, size: number,
                                    nearOffset: number, perspective = 1050): number {
  const start = Math.max(-4, nearOffset - 1.6), end = Math.min(4, nearOffset + 1.6);
  let best = nearOffset, distance = Infinity;
  for (let left = start; left < end;) {
    // Include every half-record keyframe boundary, particularly the crate's tip
    // at offset zero; a segment crossing that corner invents a diagonal shortcut.
    const right = Math.min(end, (Math.floor(left * 16 + 1e-7) + 1) / 16);
    const a = galleryOrbitPoint(mode, left, size, perspective), b = galleryOrbitPoint(mode, right, size, perspective);
    const dx = b.x - a.x, dy = b.y - a.y;
    const square = dx * dx + dy * dy;
    const fraction = square ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / square)) : 0;
    const candidate = left + (right - left) * fraction;
    const error = (a.x + dx * fraction - point.x) ** 2 + (a.y + dy * fraction - point.y) ** 2;
    if (error < distance) {distance = error; best = candidate;}
    left = right;
  }
  return Math.max(-4, Math.min(4, best));
}

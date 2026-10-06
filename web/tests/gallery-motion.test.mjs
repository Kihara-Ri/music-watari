import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const output = mkdtempSync(join(tmpdir(), 'diedu-gallery-motion-'));
let motion;
try {
  const source = fileURLToPath(new URL('../src/core/gallery-motion.ts', import.meta.url));
  const program = ts.createProgram([source], {target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, strict: true, skipLibCheck: true, types: [], outDir: output});
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => output, getCanonicalFileName: name => name, getNewLine: () => '\n',
  }));
  assert.equal(program.emit().emitSkipped, false);
  writeFileSync(join(output, 'package.json'), '{"type":"commonjs"}');
  motion = createRequire(import.meta.url)(join(output, 'gallery-motion.js'));
} catch (error) {rmSync(output, {recursive: true, force: true}); throw error;}
after(() => rmSync(output, {recursive: true, force: true}));

function advanceAtRate(initial, rate, seconds, snap = true) {
  let state = initial;
  let remaining = seconds;
  while (remaining > 1e-10) {
    const delta = Math.min(1 / rate, remaining);
    state = motion.advanceGalleryMotion(state, delta, 0, 30, snap);
    remaining -= delta;
  }
  return state;
}

test('同一次释放在 30 / 60 / 120Hz 的惯性与归位轨迹一致', () => {
  const initial = motion.releaseGalleryMotion(5.31, 3.8, 0, 30, true);
  for (const seconds of [.2, .5, .8, 1.1, 2]) {
    const a = advanceAtRate(initial, 30, seconds);
    const b = advanceAtRate(initial, 60, seconds);
    const c = advanceAtRate(initial, 120, seconds);
    assert.ok(Math.abs(a.position - b.position) < .0005, `30/60Hz at ${seconds}s`);
    assert.ok(Math.abs(a.position - c.position) < .0005, `30/120Hz at ${seconds}s`);
  }
  assert.equal(advanceAtRate(initial, 60, 3).phase, 'idle');
  assert.equal(advanceAtRate(initial, 60, 3).position, 6);
});

test('自由轨道停在非整数位置，中心轨道轻柔归位而不是一划一格', () => {
  const free = motion.releaseGalleryMotion(3.27, 0, 0, 30, false);
  assert.equal(free.position, 3.27);
  assert.equal(free.phase, 'idle');
  const snapped = motion.releaseGalleryMotion(3.27, 0, 0, 30, true);
  assert.equal(snapped.phase, 'settle');
  const midway = motion.advanceGalleryMotion(snapped, .05, 0, 30, true);
  assert.ok(midway.position < 3.27 && midway.position > 3);
  assert.equal(advanceAtRate(snapped, 60, 2).position, 3);
  const coast = advanceAtRate(motion.releaseGalleryMotion(3.27, 4, 0, 30, false), 60, 3, false);
  assert.notEqual(coast.position, Math.round(coast.position));
  assert.equal(coast.phase, 'idle');
});

test('首尾释放不越界；反向速度可立即离开边界', () => {
  const first = motion.releaseGalleryMotion(0, -5, 0, 4, true);
  assert.equal(first.phase, 'idle');
  const last = motion.releaseGalleryMotion(4, 5, 0, 4, true);
  assert.equal(last.phase, 'idle');
  const incoming = motion.releaseGalleryMotion(3.9, 8, 0, 4, true);
  const clamped = motion.advanceGalleryMotion(incoming, .3, 0, 4, true);
  assert.equal(clamped.position, 4);
  assert.equal(clamped.velocity, 0);
  const reversed = motion.advanceGalleryMotion(motion.releaseGalleryMotion(4, -2, 0, 4, false), .1, 0, 4, false);
  assert.ok(reversed.position < 4);
  assert.equal(motion.releaseGalleryMotion(0, 9, 0, 0, true).phase, 'idle');
});

test('最近速度样本反映方向与抬手前停顿，忽略陈旧冲量', () => {
  assert.ok(Math.abs(motion.galleryReleaseVelocity([
    {position: 0, at: 0}, {position: .1, at: 50}, {position: .2, at: 100},
  ]) - 2) < 1e-10);
  assert.equal(motion.galleryReleaseVelocity([
    {position: 0, at: 0}, {position: .2, at: 50}, {position: .2, at: 300},
  ]), 0);
  assert.ok(motion.galleryReleaseVelocity([
    {position: 1, at: 0}, {position: .9, at: 30}, {position: .8, at: 60},
  ]) < 0);
});

test('斜向投影保留轨道方向，垂直于轨道的移动不翻页', () => {
  const direction = {x: 1, y: 1};
  assert.ok(Math.abs(motion.projectGalleryLine({x: 50, y: 50}, direction, 100) - Math.SQRT1_2) < 1e-10);
  assert.equal(motion.projectGalleryLine({x: 50, y: -50}, direction, 100), 0);
  assert.ok(motion.projectGalleryLine({x: -50, y: -50}, direction, 100) < 0);
});

test('等距无限循环在正负边界保留小数位置，并同时复位三列与专辑顺序', () => {
  for (const count of [1, 2, 4, 24, 100]) {
    const period = motion.galleryIsometricPeriod(count);
    assert.equal(period % 3, 0);
    assert.equal(period % count, 0);
    assert.equal(motion.wrapGalleryPosition(-.25, period), period - .25);
    assert.equal(motion.wrapGalleryPosition(period + .75, period), .75);
    assert.equal(motion.wrapGalleryPosition(-period - .25, period), period - .25);
    assert.equal(motion.wrapGalleryPosition(period * 3 + .5, period), .5);

    const original = motion.galleryIsometricSlots(.75, count);
    const repeated = motion.galleryIsometricSlots(period + .75, count);
    assert.deepEqual(repeated.map(item => [item.lane, item.recordIndex]),
      original.map(item => [item.lane, item.recordIndex]));
    assert.ok(repeated.every((item, index) => item.row - original[index].row === period / 3));
  }
  assert.equal(motion.galleryIsometricPeriod(4), 12);
  assert.equal(motion.galleryIsometricPeriod(100), 300);
  assert.equal(motion.wrapGalleryPosition(7, 0), 0);
});

test('等距虚拟窗口填满三列且最多 39 张，跨边界时共有槽位身份不跳变', () => {
  for (const count of [1, 2, 4, 24, 100]) {
    const period = motion.galleryIsometricPeriod(count);
    for (const boundary of [-period, 0, period, period * 1000]) {
      const before = motion.galleryIsometricSlots(boundary - .1, count, 20);
      const after = motion.galleryIsometricSlots(boundary + .1, count, 20);
      assert.equal(before.length, 39);
      assert.equal(after.length, 39);
      assert.equal(new Set(before.map(item => item.slot)).size, 39);
      assert.ok(before.every(item => item.recordIndex >= 0 && item.recordIndex < count));
      assert.deepEqual(before.slice(0, 3).map(item => item.lane), [0, 1, 2]);
      const incoming = new Map(after.map(item => [item.slot, item]));
      const shared = before.filter(item => incoming.has(item.slot));
      assert.equal(shared.length, 36);
      assert.ok(shared.every(item => item.recordIndex === incoming.get(item.slot).recordIndex));
      for (let index = 1; index < before.length; index++) {
        assert.equal(before[index].recordIndex, (before[index - 1].recordIndex + 1) % count);
      }
    }
  }
  assert.deepEqual(motion.galleryIsometricSlots(0, 0), []);
  assert.equal(motion.galleryIsometricSlots(-.5, 2, 0).length, 3);
});

test('四条轨道的屏幕投影可往返，扇形与环形跟随弧线的纵向分量', () => {
  for (const mode of ['flow', 'crate', 'fan', 'ring']) {
    for (const size of [160, 230, 280]) {
      for (const offset of [-2.1, -1.2, -.25, 0, .3, 1.35, 2.2]) {
        const point = motion.galleryOrbitPoint(mode, offset, size);
        const projected = motion.projectGalleryOrbit(mode, point, size, offset + .15);
        assert.ok(Math.abs(projected - offset) < .003, `${mode}/${size}/${offset}: ${projected}`);
      }
    }
  }
  const fanCenter = motion.galleryOrbitPoint('fan', 0, 200);
  const fanSide = motion.galleryOrbitPoint('fan', 1.5, 200);
  assert.ok(fanSide.y > fanCenter.y + 30);
  const ringCenter = motion.galleryOrbitPoint('ring', 0, 200);
  const ringSide = motion.galleryOrbitPoint('ring', 1.5, 200);
  assert.ok(ringSide.y < ringCenter.y - 40);
  const crate = motion.galleryOrbitPoint('crate', 1, 200);
  assert.equal(crate.x, 0);
  assert.ok(crate.y < 0);
});

test('扇形在整数停留点保留原来的封面位置、角度和大小', () => {
  // Frozen from the established resting fan, independent of the handoff path.
  const resting = [
    [0, -.08, .08, 0, 1, 1],
    [.5184688454, .0063322504, .01, 19, .95, 1],
    [.9809869632, .2560124296, -.06, 38, .9, 1],
    [1.3376415658, .6420962231, -.13, 57, .85, .6],
    [1.5499441602, 1.1229192774, -.2, 76, .8, 0],
  ];
  for (let offset = -4; offset <= 4; offset++) {
    const expected = resting[Math.abs(offset)];
    const actual = motion.galleryOrbitPose('fan', offset);
    const values = [actual.x, actual.y, actual.z, actual.rotateZ, actual.scale, actual.opacity];
    for (let key = 0; key < values.length; key++) {
      const value = expected[key] * ((key === 0 || key === 3) && offset < 0 ? -1 : 1);
      assert.ok(Math.abs(values[key] - value) < 1e-8, `offset ${offset}, field ${key}`);
    }
    assert.equal(actual.rotateX, 0);
    assert.equal(actual.rotateY, 0);
  }
});

test('扇形换层前后实体轮廓错开，触碰抬起和所有封面尺寸仍有安全间距', () => {
  const step = .001;
  const owner = progress => motion.galleryFanLayer(-progress) > motion.galleryFanLayer(1 - progress) ? 0 : 1;
  assert.equal(owner(0), 0, '起点由原来的中心封面遮挡邻张');
  assert.equal(owner(1), 1, '终点由新的中心封面遮挡原封面');
  const changes = [];
  let previous = owner(0);
  for (let index = 1; index <= 1 / step; index++) {
    const progress = index * step;
    const next = owner(progress);
    if (next !== previous) changes.push(progress);
    previous = next;
  }
  assert.equal(changes.length, 1, '一次交接只有一次前后关系变化，反向拖动沿同一路径换回');

  for (const size of [100, 160, 230, 280, 360]) {
    for (const touchOutgoing of [false, true]) {
      for (const touchIncoming of [false, true]) {
        // A small interval on both sides catches a layer flip before the cases
        // have separated, rather than accepting one lucky non-overlap frame.
        for (let index = -10; index <= 10; index++) {
          const progress = changes[0] + index * step;
          const outgoing = motion.galleryOrbitBounds('fan', -progress, size, 1050, touchOutgoing);
          const incoming = motion.galleryOrbitBounds('fan', 1 - progress, size, 1050, touchIncoming);
          const clearance = Math.max(incoming.left - outgoing.right, outgoing.left - incoming.right,
            incoming.top - outgoing.bottom, outgoing.top - incoming.bottom);
          assert.ok(clearance >= 2,
            `${size}px, p=${progress.toFixed(3)}, contact=${touchOutgoing}/${touchIncoming}: ${clearance}px`);
        }
      }
    }
  }
});

function pointSide(origin, end, point) {
  return (end.x - origin.x) * (point.y - origin.y) - (end.y - origin.y) * (point.x - origin.x);
}

function convexOutline(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = sequence => {
    const result = [];
    for (const point of sequence) {
      while (result.length > 1 && pointSide(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return half(sorted).concat(half([...sorted].reverse()));
}

function intersectOutlines(subject, clip) {
  let result = subject;
  for (let edge = 0; edge < clip.length && result.length; edge++) {
    const start = clip[edge], end = clip[(edge + 1) % clip.length];
    const input = result;
    result = [];
    for (let index = 0; index < input.length; index++) {
      const a = input[index], b = input[(index + 1) % input.length];
      const sideA = pointSide(start, end, a), sideB = pointSide(start, end, b);
      if (sideA >= 0) result.push(a);
      if ((sideA >= 0) !== (sideB >= 0)) {
        const fraction = sideA / (sideA - sideB);
        result.push({x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction});
      }
    }
  }
  return result;
}

function containsOutline(outer, inner, margin) {
  return inner.every(point => outer.every((start, index) => {
    const end = outer[(index + 1) % outer.length];
    return pointSide(start, end, point) / Math.hypot(end.x - start.x, end.y - start.y) >= margin;
  }));
}

test('扇形所有可见记录对换层时轮廓分离，整数端点的交叠仅允许完整藏在高层封面后', () => {
  const owner = (a, b, progress) => {
    const layerA = motion.galleryFanLayer(a - progress), layerB = motion.galleryFanLayer(b - progress);
    return layerA > layerB || (layerA === layerB && a > b) ? a : b;
  };
  const swaps = [];
  for (let a = -4; a <= 4; a++) {
    for (let b = a + 1; b <= 5; b++) {
      let previous = owner(a, b, 0);
      for (let index = 1; index <= 1000; index++) {
        const progress = index / 1000;
        const next = owner(a, b, progress);
        if (next !== previous && motion.galleryOrbitPose('fan', a - progress).opacity > .001 &&
            motion.galleryOrbitPose('fan', b - progress).opacity > .001) swaps.push({a, b, progress});
        previous = next;
      }
    }
  }
  assert.ok(swaps.length >= 3, '验收包含中心及多张对侧专辑的真实换层');

  for (const swap of swaps) {
    for (const size of [160, 230, 280, 360]) {
      for (const contactA of [false, true]) {
        for (const contactB of [false, true]) {
          for (let index = -10; index <= 10; index++) {
            const progress = Math.max(0, Math.min(1, swap.progress + index / 1000));
            const boundsA = motion.galleryOrbitBounds('fan', swap.a - progress, size, 1050, contactA);
            const boundsB = motion.galleryOrbitBounds('fan', swap.b - progress, size, 1050, contactB);
            const clearance = Math.max(boundsB.left - boundsA.right, boundsA.left - boundsB.right,
              boundsB.top - boundsA.bottom, boundsA.top - boundsB.bottom);
            if (clearance >= 2) continue;
            const outlineA = convexOutline(motion.galleryOrbitCorners('fan', swap.a - progress, size, 1050, contactA));
            const outlineB = convexOutline(motion.galleryOrbitCorners('fan', swap.b - progress, size, 1050, contactB));
            const intersection = intersectOutlines(outlineA, outlineB);
            if (!intersection.length) continue;
            let hidden = false;
            for (let front = -4; front <= 5 && !hidden; front++) {
              if (front === swap.a || front === swap.b || owner(front, swap.a, progress) !== front ||
                  owner(front, swap.b, progress) !== front ||
                  motion.galleryOrbitPose('fan', front - progress).opacity < 1) continue;
              // A covered layer exchange is invisible only if either contact
              // state of the occluding case still covers the entire overlap.
              hidden = [false, true].every(contact => containsOutline(convexOutline(
                motion.galleryOrbitCorners('fan', front - progress, size, 1050, contact)), intersection, 2));
            }
            assert.ok(hidden,
              `pair ${swap.a}/${swap.b}, ${size}px, p=${progress.toFixed(3)}, contact=${contactA}/${contactB}: visible overlap`);
          }
        }
      }
    }
  }
});

test('扇形交接中按住停留或反向拖动时姿态连续，新的避让轨迹仍能反推手指位置', () => {
  for (const size of [160, 230, 280, 360]) {
    for (let index = -100; index <= 100; index++) {
      const offset = index / 100;
      const point = motion.galleryOrbitPoint('fan', offset, size);
      for (const near of [offset - .04, offset + .04]) {
        const reconstructed = motion.projectGalleryOrbit('fan', point, size, near);
        assert.ok(Math.abs(reconstructed - offset) < .003,
          `${size}px, offset=${offset}, near=${near}: ${reconstructed}`);
      }
      const before = motion.galleryOrbitPose('fan', offset - .00001);
      const after = motion.galleryOrbitPose('fan', offset + .00001);
      for (const key of ['x', 'y', 'z']) {
        assert.ok(Math.abs(after[key] - before[key]) * size < .2,
          `${size}px, offset=${offset}: ${key} position must not jump`);
      }
      for (const key of ['rotateX', 'rotateY', 'rotateZ']) {
        assert.ok(Math.abs(after[key] - before[key]) < .1,
          `offset=${offset}: ${key} angle must not jump`);
      }
      assert.ok(Math.abs(after.scale - before.scale) < .001, `offset=${offset}: size must not jump`);
    }
  }
});

test('扇形快速连翻不附加上下跳或缩放脉冲，横向让位和转侧速度有界', () => {
  for (let index = -1000; index <= 1000; index++) {
    const offset = index / 1000;
    const visual = motion.galleryOrbitPose('fan', offset);
    const track = motion.galleryOrbitPose('fan', offset, false);
    assert.ok(Math.abs(visual.y - track.y) < 1e-10, `offset ${offset}: no vertical throw`);
    assert.ok(Math.abs(visual.scale - track.scale) < 1e-10, `offset ${offset}: no scale pulse`);
    assert.ok(Math.abs(visual.x - track.x) <= .05, `offset ${offset}: bounded lateral motion`);
    const next = motion.galleryOrbitPose('fan', offset + .001);
    assert.ok(Math.abs(next.rotateY - visual.rotateY) / .001 <= 255,
      `offset ${offset}: avoid compressing the turn into a sharp phase`);
  }
});

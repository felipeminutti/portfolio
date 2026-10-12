/* morfeo — visualizador 3D (WebGL puro, sem dependências)
   Lê model/morfeo.bin (gerado a partir de riv_comp.stp, exportado do Rhino) */
(function () {
  const stage = document.getElementById('modelo-stage');
  if (!stage) return;
  const canvas = stage.querySelector('canvas');
  const fallback = stage.querySelector('.stage-fallback');
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) { stage.classList.add('no-webgl'); return; }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const debug = /debug/.test(location.hash);

  // ---------- shaders
  const vs = `
    attribute vec3 aPos; attribute vec3 aNrm;
    uniform mat4 uModel, uVP; uniform mat3 uNM; uniform vec3 uLo, uSize;
    varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 p = uLo + aPos * uSize;
      vec4 w = uModel * vec4(p,1.0);
      vW = w.xyz; vN = uNM * aNrm;
      gl_Position = uVP * w;
    }`;
  const fs = `
    precision highp float;
    varying vec3 vN; varying vec3 vW;
    uniform vec3 uCam, uBase; uniform float uGloss, uSpec, uGlow, uFade;
    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(uCam - vW);
      if (dot(N,V) < 0.0) N = -N;
      vec3 L1 = normalize(vec3(-0.45, 0.85, 0.55));
      vec3 L2 = normalize(vec3(0.8, 0.15, 0.45));
      vec3 L3 = normalize(vec3(0.1, 0.35, -1.0));
      float hemi = 0.5 + 0.5*N.y;
      vec3 amb = mix(vec3(0.42,0.42,0.44), vec3(0.95,0.95,0.97), hemi) * 0.55;
      float d1 = max(dot(N,L1),0.0), d2 = max(dot(N,L2),0.0);
      vec3 col = uBase * (amb + d1*0.85 + d2*0.25);
      float fres = pow(1.0 - max(dot(N,V),0.0), 3.0);
      // reflexo de softbox (estúdio branco)
      vec3 R = reflect(-V, N);
      float box = smoothstep(0.35, 0.75, R.y) * smoothstep(1.0, 0.55, abs(R.x));
      float side = smoothstep(0.55, 0.95, R.x) * 0.5;
      vec3 H1 = normalize(L1 + V), H2 = normalize(L3 + V);
      float sp = pow(max(dot(N,H1),0.0), uGloss) * uSpec + pow(max(dot(N,H2),0.0), uGloss*0.5) * uSpec*0.6;
      col += vec3(box*0.34 + side*0.16) * (0.35 + 0.65*fres) * (uSpec*2.0);
      col += vec3(sp);
      col += vec3(0.9,0.92,0.95) * fres * 0.28 * max(dot(N,L3)+0.6,0.0);
      col += uBase * uGlow;
      col = pow(col, vec3(1.0/1.12));
      gl_FragColor = vec4(col * uFade, uFade);
    }`;
  function sh(t, s) { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o); return o; }
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  const U = {}; ['uModel','uVP','uNM','uLo','uSize','uCam','uBase','uGloss','uSpec','uGlow','uFade']
    .forEach(n => U[n] = gl.getUniformLocation(prog, n));
  const aPos = gl.getAttribLocation(prog, 'aPos'), aNrm = gl.getAttribLocation(prog, 'aNrm');

  // ---------- materiais
  const MATS = [
    { base: [0.07, 0.072, 0.08], gloss: 40, spec: 0.32, glow: 0.0 },   // fibra de carbono
    { base: [0.03, 0.36, 0.45],    gloss: 110, spec: 0.6, glow: 0.12 },  // resina
  ];

  // ---------- math
  const m4 = {
    mul(a, b) { const o = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; }
      return o; },
    persp(f, a, n, fa) { const t = 1 / Math.tan(f / 2), o = new Float32Array(16);
      o[0] = t / a; o[5] = t; o[10] = (fa + n) / (n - fa); o[11] = -1; o[14] = 2 * fa * n / (n - fa); return o; },
    trans(x, y, z) { const o = m4.id(); o[12] = x; o[13] = y; o[14] = z; return o; },
    scale(x, y, z) { const o = m4.id(); o[0] = x; o[5] = y; o[10] = z; return o; },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a), o = m4.id(); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a), o = m4.id(); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
    id() { const o = new Float32Array(16); o[0] = o[5] = o[10] = o[15] = 1; return o; },
  };
  // só rotações/espelhamentos (ortogonais): a matriz normal é o próprio 3x3
  const normalMat = m => new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);

  // ---------- estado
  let model = null;
  const st = { yaw: -0.55, pitch: 0.12, vy: 0, vp: 0, pair: 1, pairT: 1, auto: !reduce,
    dragging: false, lastInput: 0, fade: 0, intro: reduce ? 0 : 1 };

  async function load() {
    const res = await fetch(stage.dataset.model);
    if (!res.ok) throw new Error('model ' + res.status);
    const buf = await res.arrayBuffer(); const dv = new DataView(buf);
    const nV = dv.getUint32(4, true), nT = dv.getUint32(8, true), isz = dv.getUint32(12, true);
    const lo = [0, 1, 2].map(i => dv.getFloat32(16 + i * 4, true));
    const hi = [0, 1, 2].map(i => dv.getFloat32(28 + i * 4, true));
    const nG = dv.getUint32(40, true); const groups = [];
    for (let g = 0; g < nG; g++) { const o = 44 + g * 16;
      groups.push({ start: dv.getUint32(o, true), count: dv.getUint32(o + 4, true), mat: dv.getUint32(o + 8, true), id: dv.getUint32(o + 12, true) }); }
    let off = 44 + nG * 16; off += (4 - off % 4) % 4;
    const pos = new Uint16Array(buf, off, nV * 3); off += nV * 6; off += (4 - off % 4) % 4;
    const nrm = new Int8Array(buf, off, nV * 3); off += nV * 3; off += (4 - off % 4) % 4;
    const idx = isz === 2 ? new Uint16Array(buf, off, nT * 3) : new Uint32Array(buf, off, nT * 3);
    if (isz === 4) gl.getExtension('OES_element_index_uint');
    const mk = (t, d) => { const b = gl.createBuffer(); gl.bindBuffer(t, b); gl.bufferData(t, d, gl.STATIC_DRAW); return b; };
    // mesclar grupos contíguos do mesmo material
    const draws = [];
    for (const g of groups) { const last = draws[draws.length - 1];
      if (!debug && last && last.mat === g.mat && last.start + last.count === g.start) last.count += g.count;
      else draws.push({ ...g }); }
    model = { pb: mk(gl.ARRAY_BUFFER, pos), nb: mk(gl.ARRAY_BUFFER, nrm), ib: mk(gl.ELEMENT_ARRAY_BUFFER, idx),
      itype: isz === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, lo, size: hi.map((h, i) => h - lo[i]), draws, groups,
      half: hi.map((h, i) => (h - lo[i]) / 2) };
    stage.classList.add('is-ready');
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  const ease = t => 1 - Math.pow(1 - t, 3);
  function draw(dt) {
    resize();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!model) return;
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    st.fade = Math.min(1, st.fade + dt * 1.6);
    st.pairT += (st.pair - st.pairT) * Math.min(1, dt * 6);
    const idle = !st.dragging && performance.now() - st.lastInput > 2500;
    if (!st.dragging) { st.yaw += st.vy; st.pitch += st.vp; st.vy *= 0.92; st.vp *= 0.9; }
    if (st.auto && idle) st.yaw += dt * 0.32;
    if (!st.dragging) st.pitch += (0.12 - st.pitch) * Math.min(1, dt * 0.8) * (idle ? 1 : 0);
    st.pitch = Math.max(-1.0, Math.min(1.0, st.pitch));
    const intro = st.intro > 0 ? (st.intro = Math.max(0, st.intro - dt * 0.7)) : 0;

    const aspect = canvas.width / canvas.height;
    const W = model.size[0], gap = 6;
    const sep = (W / 2 + gap / 2) * ease(st.pairT);
    const fitW = (W + (W + gap) * ease(st.pairT)) * 1.12, fitH = model.size[1] * 1.35;
    const fov = 0.42;
    const distW = (fitW / 2) / Math.tan(fov / 2) / aspect, distH = (fitH / 2) / Math.tan(fov / 2);
    const dist = Math.max(distW, distH) * (1 + ease(intro) * 0.25);
    const cam = [0, 0, dist];
    const view = m4.trans(0, 0, -dist);
    const vp = m4.mul(m4.persp(fov, aspect, dist * 0.2, dist * 4), view);
    const rot = m4.mul(m4.rotX(st.pitch), m4.rotY(st.yaw - ease(intro) * 1.4));

    gl.useProgram(prog);
    gl.uniformMatrix4fv(U.uVP, false, vp);
    gl.uniform3fv(U.uCam, cam); gl.uniform3fv(U.uLo, model.lo); gl.uniform3fv(U.uSize, model.size);
    gl.uniform1f(U.uFade, ease(st.fade));
    gl.bindBuffer(gl.ARRAY_BUFFER, model.pb); gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, model.nb); gl.enableVertexAttribArray(aNrm);
    gl.vertexAttribPointer(aNrm, 3, gl.BYTE, true, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, model.ib);

    // peça direita (original) e esquerda (espelhada)
    const pieces = [{ x: sep, s: 1 }];
    if (st.pairT > 0.01) pieces.push({ x: -sep, s: -1 });
    for (const p of pieces) {
      const local = m4.mul(m4.trans(p.x, 0, 0), m4.scale(p.s, 1, 1));
      const M = m4.mul(rot, local);
      gl.uniformMatrix4fv(U.uModel, false, M);
      gl.uniformMatrix3fv(U.uNM, false, normalMat(M));
      const fadePiece = p.s < 0 ? Math.min(1, st.pairT * 1.5) : 1;
      gl.uniform1f(U.uFade, ease(st.fade) * fadePiece);
      for (const d of model.draws) {
        const m = MATS[d.mat];
        if (debug) { const h = (d.id * 0.6180339) % 1; gl.uniform3fv(U.uBase, [0.3 + 0.6 * h, 0.3 + 0.6 * ((h * 3) % 1), 0.3 + 0.6 * ((h * 7) % 1)]); }
        else gl.uniform3fv(U.uBase, m.base);
        gl.uniform1f(U.uGloss, m.gloss); gl.uniform1f(U.uSpec, m.spec); gl.uniform1f(U.uGlow, m.glow);
        gl.drawElements(gl.TRIANGLES, d.count * 3, model.itype, d.start * 3 * (model.itype === gl.UNSIGNED_SHORT ? 2 : 4));
      }
    }
  }

  // ---------- loop (só roda quando visível)
  let visible = false, raf = 0, last = 0;
  function frame(t) { const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t; draw(dt); raf = visible ? requestAnimationFrame(frame) : 0; }
  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) start(); }, { rootMargin: '100px' }).observe(stage);

  // ---------- interação
  let px = 0, py = 0, pid = null;
  canvas.addEventListener('pointerdown', e => { pid = e.pointerId; px = e.clientX; py = e.clientY; st.dragging = true;
    st.lastInput = performance.now(); canvas.setPointerCapture(pid); stage.classList.add('is-dragging'); });
  canvas.addEventListener('pointermove', e => { if (e.pointerId !== pid) return;
    const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
    st.yaw += dx * 0.009; st.pitch += dy * 0.006; st.vy = dx * 0.009; st.vp = dy * 0.004; st.lastInput = performance.now(); });
  const up = e => { if (e.pointerId !== pid) return; pid = null; st.dragging = false; st.lastInput = performance.now(); stage.classList.remove('is-dragging'); };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('keydown', e => {
    const k = { ArrowLeft: [-0.25, 0], ArrowRight: [0.25, 0], ArrowUp: [0, -0.15], ArrowDown: [0, 0.15] }[e.key];
    if (k) { e.preventDefault(); st.yaw += k[0]; st.pitch += k[1]; st.lastInput = performance.now(); start(); }
  });

  document.querySelectorAll('[data-pair]').forEach(b => b.addEventListener('click', () => {
    st.pair = +b.dataset.pair;
    document.querySelectorAll('[data-pair]').forEach(o => o.setAttribute('aria-checked', String(o === b)));
  }));
  const autoBtn = document.getElementById('modelo-auto');
  if (autoBtn) {
    const sync = () => { autoBtn.setAttribute('aria-pressed', String(st.auto)); autoBtn.querySelector('span').textContent = st.auto ? 'Pausar giro' : 'Girar'; };
    sync(); autoBtn.addEventListener('click', () => { st.auto = !st.auto; st.lastInput = 0; sync(); });
  }
  const resetBtn = document.getElementById('modelo-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => { st.yaw = -0.55; st.pitch = 0.12; st.vy = st.vp = 0; });

  load().catch(err => { console.error(err); stage.classList.add('no-webgl'); });
})();

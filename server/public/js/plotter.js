class TelemetryPlotter {
  constructor(canvasId, streams, maxPoints = 50) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.streams = streams;
    this.maxPoints = maxPoints;
    this.history = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    if (!this.canvas) return;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * devicePixelRatio;
    this.canvas.height = r.height * devicePixelRatio;
    this.draw();
  }
  addData(data) {
    this.history.push({ ...data, time: Date.now() });
    if (this.history.length > this.maxPoints) this.history.shift();
    this.draw();
  }
  draw() {
    if (!this.canvas) return;
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo((i / 8) * w, 0);
      ctx.lineTo((i / 8) * w, h);
      ctx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i / 4) * h);
      ctx.lineTo(w, (i / 4) * h);
      ctx.stroke();
    }

    if (this.history.length < 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.25)';
      ctx.font = `${10 * devicePixelRatio}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for data...', w / 2, h / 2);
      return;
    }

    this.streams.forEach(stream => {
      const vals = this.history.map(d => d[stream.key]).filter(v => v !== undefined && !isNaN(v) && v !== null);
      if (vals.length < 2) return;
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = (max - min) || 1;
      ctx.beginPath();
      let drawn = 0;
      for (let i = 0; i < this.history.length; i++) {
        const val = this.history[i][stream.key];
        if (val === undefined || isNaN(val) || val === null) continue;
        const x = (i / (this.history.length - 1)) * w;
        const y = h - ((val - min) / range) * (h - 16) - 8;
        drawn === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        drawn++;
      }
      ctx.strokeStyle = stream.color;
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = stream.color;
      ctx.shadowBlur = 4 * devicePixelRatio;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineTo(w, h);
      ctx.lineTo((this.history.findIndex(d => d[stream.key] !== undefined) / (this.history.length - 1)) * w, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, stream.color + '10');
      g.addColorStop(1, stream.color + '00');
      ctx.fillStyle = g;
      ctx.fill();
    });
  }
}

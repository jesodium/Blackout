class Sparkline {
  constructor(canvasId, color, maxPoints = 20) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.color = color;
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
  addPoint(val) {
    if (val === undefined || isNaN(val) || val === null) return;
    this.history.push(val);
    if (this.history.length > this.maxPoints) this.history.shift();
    this.draw();
  }
  draw() {
    if (!this.canvas || this.history.length < 2) return;
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const min = Math.min(...this.history), max = Math.max(...this.history);
    const range = (max - min) || 1;
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const x = (i / (this.history.length - 1)) * w;
      const y = h - ((this.history[i] - min) / range) * (h - 6) - 3;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 4 * devicePixelRatio;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, this.color + '28');
    g.addColorStop(1, this.color + '00');
    ctx.fillStyle = g;
    ctx.fill();
  }
}

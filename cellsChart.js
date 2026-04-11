// cellsChart.js — график для mqtt web.html

const cellsChartState = {
    history: [],
    maxPoints: 80,
    periods: [60, 180, 300, 600],                      // 1мин, 3мин, 5мин, 10мин
    periodNames: ['1 мин', '3 мин', '5 мин', '10 мин'],
    periodIdx: 0,                                       // начать с 1 мин
    canvas: null,
    ctx: null,
    cellCount: 4,
    padding: 20,
    colors: ['#3b82f6', '#10b981', '#fbbf24', '#ef4444', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316', '#06b6d4', '#f43f5e']
};

function drawCellsChart() {
    try {
        const canvas = cellsChartState.canvas;
        const ctx = cellsChartState.ctx;
        if (!canvas || !ctx || cellsChartState.history.length === 0) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== width * window.devicePixelRatio || canvas.height !== height * window.devicePixelRatio) {
            canvas.width = width * window.devicePixelRatio;
            canvas.height = height * window.devicePixelRatio;
            ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
        }
        const w = width;
        const h = height;
        const p = cellsChartState.padding;

        const history = cellsChartState.history;
        const points = Math.min(history.length, cellsChartState.maxPoints);
        const visibleSlice = history.slice(history.length - points);

        const allVisible = visibleSlice.flatMap((entry) => entry.cells.filter((v) => typeof v === 'number' && v > 0));
        let minV = allVisible.length ? Math.min(...allVisible) : 2.5;
        let maxV = allVisible.length ? Math.max(...allVisible) : 4.2;
        const range = maxV - minV;
        const pad = range < 0.01 ? 0.05 : range * 0.1;
        minV = Math.floor((minV - pad) * 100) / 100;
        maxV = Math.ceil((maxV + pad) * 100) / 100;
        if (maxV - minV < 0.01) maxV = minV + 0.01;

        const gridRange = maxV - minV;
        const rawStep = gridRange / 4;
        const step = Math.ceil(rawStep * 100) / 100 || 0.01;
        const gridMin = Math.floor(minV / step) * step;
        const gridLines = [];
        for (let v = gridMin; v <= maxV + step * 0.5; v = Math.round((v + step) * 1000) / 1000) {
            if (v >= minV && v <= maxV) gridLines.push(v);
        }

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '10px sans-serif';
        gridLines.forEach((v) => {
            const y = p + (h - 2 * p) * (1 - (v - minV) / (maxV - minV));
            ctx.beginPath();
            ctx.moveTo(p, y);
            ctx.lineTo(w - p, y);
            ctx.stroke();
            ctx.fillText(`${v.toFixed(2)}`, 2, y + 4);
        });

        const segment = (w - 2 * p) / (cellsChartState.maxPoints - 1 || 1);
        const timeLabels = 4;
        if (points > 1) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font = '8px monospace';
            for (let i = 0; i < timeLabels; i++) {
                const x = p + ((w - 2 * p) * i) / (timeLabels - 1);
                const idx = Math.round(i * (points - 1) / (timeLabels - 1));
                const item = history[history.length - points + idx];
                if (!item) continue;
                const date = new Date(item.ts);
                const t = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
                ctx.fillText(t, x - 20, h - p + 16);
            }
        }

        for (let cellIdx = 0; cellIdx < cellsChartState.cellCount; cellIdx++) {
            const color = cellsChartState.colors[cellIdx % cellsChartState.colors.length];
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < points; i++) {
                const item = history[history.length - points + i];
                if (!item) continue;
                const v = item.cells[cellIdx];
                if (typeof v !== 'number') continue;
                const x = p + segment * i;
                const y = p + (h - 2 * p) * (1 - ((v - minV) / (maxV - minV)));
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            const last = history[history.length - 1]?.cells[cellIdx];
            if (typeof last === 'number') {
                ctx.fillStyle = color;
                ctx.font = '11px sans-serif';
                ctx.fillText(`${last.toFixed(3)}V`, w - p - 40, p + 14 + cellIdx * 14);
            }
        }

        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '11px sans-serif';
        const periodLabel = cellsChartState.periodNames[cellsChartState.periodIdx] || `${cellsChartState.maxPoints} pts`;
        ctx.fillText(periodLabel, p, h - p - 2);
    } catch (e) {
        console.error('drawCellsChart error', e);
    }
}

function registerCellsChartCanvas() {
    const canvas = document.getElementById('cellsChart');
    if (!canvas) return;
    cellsChartState.canvas = canvas;
    cellsChartState.ctx = canvas.getContext('2d');

    canvas.addEventListener('click', () => {
        cellsChartState.periodIdx = (cellsChartState.periodIdx + 1) % cellsChartState.periods.length;
        cellsChartState.maxPoints = cellsChartState.periods[cellsChartState.periodIdx];
        updatePeriodButtons();
        drawCellsChart();
    });

    document.querySelectorAll('.period-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            cellsChartState.periodIdx = parseInt(e.target.dataset.period);
            cellsChartState.maxPoints = cellsChartState.periods[cellsChartState.periodIdx];
            updatePeriodButtons();
            drawCellsChart();
        });
    });

    window.addEventListener('resize', () => drawCellsChart());
    drawCellsChart();
}

function updatePeriodButtons() {
    document.querySelectorAll('.period-btn').forEach((btn, idx) => {
        if (idx === cellsChartState.periodIdx) btn.classList.add('active');
        else btn.classList.remove('active');
    });
}

function updateCellsChartFromMqtt(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return;
    cellsChartState.cellCount = cells.length;
    cellsChartState.history.push({ ts: Date.now(), cells: [...cells] });

    const maxHistorySize = Math.max(...cellsChartState.periods);
    if (cellsChartState.history.length > maxHistorySize) {
        cellsChartState.history.splice(0, cellsChartState.history.length - maxHistorySize);
    }

    drawCellsChart();
}

window.registerCellsChartCanvas = registerCellsChartCanvas;
window.updateCellsChartFromMqtt = updateCellsChartFromMqtt;
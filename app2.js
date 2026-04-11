// --- Публикация в MQTT только при изменении значения ---
function isMqttServerMode() {
    try {
        const s = getMqttSettings();
        return (s.mode || 'client') === 'server';
    } catch { return false; }
}

function publishIfChanged(key, value) {
    if (!isMqttServerMode()) return; // Только в режиме сервер
    if (lastData['_last_' + key] === value) return;
    lastData['_last_' + key] = value;
    sendMqttCmd(key, value);
}
// --- Унифицированный источник тока с приоритетом ---
function getCurrent() {
    // если только что был tap — доверяем ему
    if (lastData.currentJustTapped) return Number(lastData.current);

    // иначе MQTT
    if (!isNaN(Number(lastData.a))) return Number(lastData.a);

    return Number(lastData.current);
}
// --- Автоматическое обновление v-val от ползунков ---
function updateMosfetPills() {
    const chargePill = document.getElementById('charge-pill');
    const dischgPill = document.getElementById('dischg-pill');
    if (chargePill) {
        const on = lastData['mosfet_chg'] === 'ON';
        chargePill.classList.toggle('on', on);
        chargePill.classList.toggle('charge-active', on);
        setMosfetPending('chg', false);
    }
    if (dischgPill) {
        const on = lastData['mosfet_dis'] === 'ON';
        dischgPill.classList.toggle('on', on);
        dischgPill.classList.toggle('dischg-active', on);
        setMosfetPending('dis', false);
    }
}

function closeSettings() {
    var panel = document.getElementById('settingsPanelRoot');
    if (panel) {
        panel.classList.remove('open');
        panel.classList.add('hidden');
    }
}

let client = null;
let manualDisconnect = false;
let mqttConnectionSeq = 0;
let lastUpdateTime = 0;
let hasTelemetryData = false;
let lastData = {};
let currentGenIdx = 0;
const currentGenValues = [1, 2, 3, 4, 5];
let uiScheduled = false;
let lastUIUpdate = 0;
let firstSuccessfulConnect = false;
const mosfetCommandState = { chg: false, dis: false };
const UI_INTERVAL = 200;
let lastSocSentTime = 0;

// --- Кэш для .mini-battery-grid .batt-val ---
let battValsCache = [];
function scheduleUI() {
    const now = Date.now();
    if (now - lastUIUpdate < UI_INTERVAL) return;
    lastUIUpdate = now;
    if (!uiScheduled) {
        uiScheduled = true;
        requestAnimationFrame(() => {
            updateUIfromMqtt();
            uiScheduled = false;
        });
    }
}

function getDefaultMqttPort() {
    return location.protocol === 'https:' ? 8084 : 8083;
}

function normalizeMqttSettings(settings) {
    const normalized = Object.assign({}, settings || {});
    const host = String(normalized.host || '').trim().toLowerCase();
    const port = Number(normalized.port) || getDefaultMqttPort();

    normalized.port = port;
    if (host === 'broker.emqx.io') {
        if (location.protocol === 'https:' && port === 8083) normalized.port = 8084;
        if (location.protocol !== 'https:' && port === 8084) normalized.port = 8083;
    }

    return normalized;
}

function getMqttSettings() {
    const def = {
        host: 'broker.emqx.io',
        port: getDefaultMqttPort(),
        user: '',
        pass: '',
        topic: 'shaman/bms315/#',
        mode: 'client'
    };
    try {
        const s = JSON.parse(localStorage.getItem('mqttSettings'));
        const merged = normalizeMqttSettings(Object.assign({}, def, s || {}));
        merged.topic = normalizeTopicWithWildcard(merged.topic);
        localStorage.setItem('mqttSettings', JSON.stringify(merged));
        return merged;
    } catch {
        return def;
    }
}

async function loadInitialMqttSettings() {
    const local = getMqttSettings();
    const isStaticHost = location.protocol === 'file:' || location.hostname.endsWith('github.io');
    if (isStaticHost) return local;
    try {
        const response = await fetch('/settings', { cache: 'no-store' });
        if (!response.ok) return local;

        const settings = await response.json();
        const merged = {
            host: String(settings.mqttHost || '').trim() || local.host,
            port: Number(settings.mqttPort) || local.port,
            user: String(settings.mqttUser || ''),
            pass: String(settings.mqttPass || ''),
            topic: normalizeTopicWithWildcard(String(settings.mqttTopic || '').trim() || local.topic)
        };

        localStorage.setItem('mqttSettings', JSON.stringify(merged));
        return merged;
    } catch {
        return local;
    }
}

function normalizeBaseTopic(topic) {
    const value = String(topic || '').trim().replace(/\/+$/, '');
    return value.endsWith('/#') ? value.slice(0, -2) : value;
}

function normalizeTopicWithWildcard(topic) {
    let value = String(topic || '').trim();
    if (!value) return '#';
    value = value.replace(/\/?#$/, '').replace(/\/+$/, '');
    return value ? (value + '/#') : '#';
}

function normalizeSubscribeTopic(topic) {
    const base = normalizeBaseTopic(topic);
    return base ? (base + '/#') : '#';
}

function saveMqttSettings() {
    const host = document.getElementById('mqttHost').value.trim();
    const port = Number(document.getElementById('mqttPort').value);
    const user = document.getElementById('mqttUser').value.trim();
    const pass = document.getElementById('mqttPass').value;
    const topicInput = document.getElementById('mqttTopic');
    const topic = normalizeTopicWithWildcard(topicInput ? topicInput.value : '');
    if (topicInput) topicInput.value = topic;
    const modeSelect = document.getElementById('mqttMode');
    const mode = modeSelect ? modeSelect.value : 'client';
    const settings = { host, port, user, pass, topic, mode };
    localStorage.setItem('mqttSettings', JSON.stringify(settings));
    setStatus('Настройки сохранены, переподключение...');
    setTimeout(() => {
        disconnectMQTT();
        connectMQTT();
        closeSettings();
    }, 500);
// При открытии настроек — подставлять сохранённый режим
function setMqttModeSelectFromStorage() {
    const modeSelect = document.getElementById('mqttMode');
    if (modeSelect) {
        const settings = getMqttSettings();
        modeSelect.value = settings.mode || 'client';
    }
}

document.addEventListener('DOMContentLoaded', function() {
    setMqttModeSelectFromStorage();
    // Если настройки открываются динамически, обновлять select при каждом открытии панели
    const menuBtn = document.getElementById('menuBtnTop');
    if (menuBtn) {
        menuBtn.addEventListener('click', setMqttModeSelectFromStorage);
    }
});
}

function setMosfetPending(kind, isPending) {
    const buttonId = kind === 'chg' ? 'charge-pill' : 'dischg-pill';
    const pill = document.getElementById(buttonId);
    if (!pill) return;
    mosfetCommandState[kind] = !!isPending;
    pill.classList.toggle('pending', !!isPending);
    pill.disabled = !!isPending;
}

function connectMQTT() {
    const previousClient = client;
    manualDisconnect = false;
    mqttConnectionSeq += 1;
    const connectionSeq = mqttConnectionSeq;
    client = null;
    if (previousClient) {
        try { previousClient.removeAllListeners(); } catch {}
        try { previousClient.end(true); } catch {}
    }

    const s = getMqttSettings();
    setStatus('Подключение...');

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${s.host}:${s.port}/mqtt`;
    const subscribeTopic = normalizeSubscribeTopic(s.topic);
    const base = normalizeBaseTopic(s.topic);

    client = mqtt.connect(url, {
        username: s.user || undefined,
        password: s.pass || undefined,
        reconnectPeriod: 2000,
        connectTimeout: 10000
    });

    client.on('connect', () => {
        if (connectionSeq !== mqttConnectionSeq) return;
        hasTelemetryData = false;
        lastUpdateTime = 0;
        setStatus('MQTT');
        client.subscribe(subscribeTopic);
        if (base) {
            client.subscribe(base + '/mosfet_chg/state');
            client.subscribe(base + '/mosfet_dis/state');
        }
        // --- Автоматическое сохранение настроек при первом успешном подключении ---
        if (!firstSuccessfulConnect) {
            firstSuccessfulConnect = true;
            try {
                const s = getMqttSettings();
                localStorage.setItem('mqttSettings', JSON.stringify(s));
            } catch (e) {}
        }
        // --- После подключения: отправка случайных значений только в режиме сервер ---
        if (isMqttServerMode()) {
            const containers = Array.from(document.querySelectorAll('.mini-battery-grid .batt-container'));
            const generatedValues = [];
            containers.forEach((container, idx) => {
                setTimeout(() => {
                    const minV = 2.5, maxV = 3.65;
                    const value = (Math.random() * (maxV - minV) + minV).toFixed(3);
                    const cellNum = idx + 1;
                    sendMqttCmd(`cell${cellNum}`, value);
                    generatedValues[idx] = Number(value);
                    // Визуально обновим batt-val
                    const valSpan = container.querySelector('.batt-val');
                    if (valSpan) {
                        valSpan.textContent = value;
                        valSpan.style.color = '#79c0ff';
                        setTimeout(() => { valSpan.style.color = ''; }, 700);
                    }
                    // --- Обновляем ползунок, если он есть ---
                    const slider = document.getElementById(`cell-slider-${cellNum}`);
                    if (slider) {
                        slider.value = value;
                        const valSliderSpan = document.getElementById(`cell-slider-val-${cellNum}`);
                        if (valSliderSpan) valSliderSpan.textContent = value + ' В';
                    }
                    // После последней ячейки — отправить агрегаты
                    if (idx === containers.length - 1) {
                        // Сохраняем значения ячеек в lastData
                        for (let i = 0; i < generatedValues.length; i++) {
                            lastData['cell' + (i + 1)] = generatedValues[i];
                        }
                        // Генерируем ток поочерёдно
                        let current = currentGenValues[currentGenIdx % currentGenValues.length];
                        currentGenIdx++;
                        lastData.current = current;
                        lastData.currentJustTapped = true;
                        // Вызываем только один раз, без задержек и лишних вызовов
                        updateCellSlidersSummary(true);
                    }
                }, idx * 200);
            });
        }
    });

    client.on('message', (topic, msg) => {
        if (connectionSeq !== mqttConnectionSeq) return;
        handleMqttMessage(topic, msg.toString());
    });
    client.on('reconnect', () => {
        if (connectionSeq !== mqttConnectionSeq || manualDisconnect) return;
        setStatus('Reconnect...', true);
    });
    client.on('error', (err) => {
        if (connectionSeq !== mqttConnectionSeq || manualDisconnect) return;
        setStatus('Ошибка: ' + err.message, true);
        // --- Автоматический показ настроек при ошибке подключения ---
        showSettingsPanel();
    });
    client.on('offline', () => {
        if (connectionSeq !== mqttConnectionSeq || manualDisconnect) return;
        setStatus('Offline', true);
    });
    client.on('close', () => {
        if (connectionSeq !== mqttConnectionSeq || manualDisconnect) return;
        setStatus('Reconnect...', true);
    });
}

function disconnectMQTT() {
    manualDisconnect = true;
    mqttConnectionSeq += 1;
    if (client) {
        try { client.removeAllListeners(); } catch {}
        try { client.end(true); } catch {}
    }
    client = null;
}

function setStatus(text, error) {
    const el = document.getElementById('mqtt-status-text');
    if (!el) return;
    el.textContent = text;
    if (error) {
        el.style.color = '#f43f5e';
    } else if (text === 'MQTT') {
        el.style.color = '#22c55e';
    } else {
        el.style.color = '#eab308';
    }
}

function showSettingsPanel() {
    var panel = document.getElementById('settingsPanelRoot');
    if (panel) {
        panel.classList.remove('hidden');
        panel.classList.add('open');
    }
}
function handleMqttMessage(topic, payload) {
    const base = getBaseTopic();
    const prefix = base.endsWith('/') ? base : (base + '/');
    if (topic.startsWith(prefix)) {
        let key = topic.slice(prefix.length);
        if (!key) return;

        // Fallback: если пришёл старый топик 'power', приводим к 'p'
        if (key === 'power') key = 'p';

        if (key === 'v' || key === 'soc' || key === 'a' || key === 'p' || key.startsWith('cell')) {
            lastUpdateTime = Date.now();
            hasTelemetryData = true;
        }

        if (key === 'mosfet_chg/state') {
            lastData.mosfet_chg = payload.trim();
            updateMosfetPills();
            return;
        }
        if (key === 'mosfet_dis/state') {
            lastData.mosfet_dis = payload.trim();
            updateMosfetPills();
            return;
        }
        const clean = payload.trim();
        const num = Number(clean);
        const newVal = Number.isNaN(num) ? clean : num;
        // (Фильтр soc=0 убран — теперь любые значения soc принимаются)
        let processedVal = newVal;
        if (key === 'a' && typeof newVal === 'number') {
            // игнорируем ноль из MQTT, если только что был tap (currentJustTapped)
            if (newVal === 0 && lastData.currentJustTapped) return;
            processedVal = smooth(typeof lastData.a === 'number' ? lastData.a : newVal, newVal);
        }
        if (lastData[key] !== processedVal) {
            lastData[key] = processedVal;
            if (key.startsWith('cell')) {
                const cellKeys = Object.keys(lastData).filter((k) => k.startsWith('cell'));
                const indices = cellKeys.map((k) => parseInt(k.replace('cell', ''))).filter((n) => !isNaN(n));
                if (indices.length > 0) {
                    const minIdx = Math.min(...indices);
                    const expectedKeys = [];
                    for (let i = minIdx; i < minIdx + indices.length; ++i) {
                        expectedKeys.push('cell' + i);
                    }
                    cellKeys.forEach((k) => {
                        if (!expectedKeys.includes(k)) {
                            delete lastData[k];
                        }
                    });
                }
            }
            scheduleUI();
            if (key.startsWith('cell')) {
                updateCells();
            }
        }
    }
}

function updateCells() {
    const cells = Object.keys(lastData)
        .filter((k) => k.startsWith('cell'))
        .sort((a, b) => {
            const na = parseInt(a.replace('cell', ''));
            const nb = parseInt(b.replace('cell', ''));
            return na - nb;
        })
        .map((k) => Number(lastData[k]) || 0);
    if (cells.some((x) => x > 0)) {
        updateCellsChartFromMqtt(cells);
    }
}

function updateUIfromMqtt() {
    if (typeof lastData.v !== 'undefined' || typeof lastData.soc !== 'undefined') {
        setStatus('MQTT');
    }
    // Суммируем напряжения всех ячеек, если они есть
    const cellKeys = Object.keys(lastData).filter((k) => k.startsWith('cell'));
    let vSum = 0;
    if (cellKeys.length > 0) {
        vSum = cellKeys.map((k) => Number(lastData[k]) || 0).reduce((a, b) => a + b, 0);
    }
    const v = cellKeys.length > 0 ? vSum : Number(lastData.v);
    setText('v-val', isNaN(v) ? '0.00' : v.toFixed(2));
    const soc = Number(lastData.soc);
    setText('soc-val', isNaN(soc) ? '0%' : soc + '%');
    const battFill = document.getElementById('batt-fill');
    if (battFill) {
        const percent = isNaN(soc) ? 0 : Math.max(0, Math.min(100, soc));
        battFill.style.width = percent + '%';

        if (percent < 20) {
            battFill.style.background = 'linear-gradient(90deg, #7f2a24, #b83c34)';
        } else if (percent < 60) {
            battFill.style.background = 'linear-gradient(90deg, #7b611f, #a98329)';
        } else {
            battFill.style.background = 'linear-gradient(90deg, #176838, #2b8c47)';
        }
    }
    const a = getCurrent();
    setText('current-val', isNaN(a) ? '0.00A' : a.toFixed(2) + 'A');

    const currentEl = document.getElementById('current-val');
    if (currentEl) {
        if (a > 0) {
            currentEl.style.color = '#3fb950';
        } else if (a < 0) {
            currentEl.style.color = '#f85149';
        } else {
            currentEl.style.color = '';
        }
    }
    const p = Number(lastData.p);
    setText('power-val', isNaN(p) ? '0.0W' : p.toFixed(1) + 'W');
    const ein = Number(lastData.energy_in);
    setText('energy-charged-val', isNaN(ein) ? '0.00Wh' : ein.toFixed(2) + 'Wh');
    const eout = Number(lastData.energy_out);
    setText('energy-consumed-val', isNaN(eout) ? '0.00Wh' : eout.toFixed(2) + 'Wh');
    const tmos = Number(lastData.t_mos);
    setText('temp-mos', isNaN(tmos) ? '0°C' : tmos + '°C');
    const tbox = Number(lastData.t_box);
    setText('temp-t1', isNaN(tbox) ? '0°C' : tbox + '°C');
    const uptimeSec = Number(lastData.uptime);
    setText('footer_uptime', formatUptime(uptimeSec));
    const eta = calculateEta(soc, a, lastData);
    setText('time-val', eta.value);
    setText('time-label', eta.label);
    const heap = Number(lastData.heap);
    setText('footer_mem', isNaN(heap) ? '0 KB' : heap + ' KB');

    const cells = Object.keys(lastData)
        .filter((k) => k.startsWith('cell'))
        .sort((aKey, bKey) => {
            const na = parseInt(aKey.replace('cell', ''));
            const nb = parseInt(bKey.replace('cell', ''));
            return na - nb;
        })
        .map((k) => Number(lastData[k]));
    document.querySelectorAll('.batt-val').forEach((el, i) => {
        const val = cells[i];
        el.textContent = isNaN(val) ? '0.000' : val.toFixed(3);
    });

    const validCells = cells.filter((x) => typeof x === 'number' && !isNaN(x));
    if (validCells.length) {
        // Определяем тип батареи по количеству ячеек
        let batteryType = '';
        if (validCells.length === 3) {
            batteryType = 'li-ion';
        } else if (validCells.length === 4 || validCells.length === 8) {
            batteryType = 'lifepo4';
        } else {
            batteryType = 'li-ion'; // по умолчанию
        }

        // Диапазоны напряжений для разных типов
        let minVoltage = 2.5, maxVoltage = 4.2;
        if (batteryType === 'lifepo4') {
            minVoltage = 2.5;
            maxVoltage = 3.65;
        } else if (batteryType === 'li-ion') {
            minVoltage = 3.0;
            maxVoltage = 4.2;
        }

        const min = Math.min(...validCells);
        const max = Math.max(...validCells);
        const delta = max - min;
        document.querySelectorAll('.mini-battery-grid .batt-container').forEach((container, i) => {
            const fill = container.querySelector('.batt-fill');
            if (!fill) return;
            const value = cells[i];
            container.classList.remove('batt-low', 'batt-high', 'glow-green', 'glow-red', 'glow-blue');
            fill.classList.remove('state-min', 'state-max', 'state-normal');

            if (typeof value === 'number' && !isNaN(value)) {
                // Абсолютная шкала по типу батареи
                const pct = Math.max(2, Math.min(100, ((value - minVoltage) / (maxVoltage - minVoltage)) * 100));
                fill.style.width = pct + '%';

                if (Math.abs(value - min) < 0.0005) {
                    fill.classList.add('state-min');
                    container.classList.add('batt-low', 'glow-red');
                } else if (Math.abs(value - max) < 0.0005) {
                    fill.classList.add('state-max');
                    container.classList.add('batt-high', 'glow-green');
                } else {
                    fill.classList.add('state-normal');
                    container.classList.add('glow-blue');
                }
            }
        });
        setText('min-val', isNaN(min) ? '0.000' : min.toFixed(3));
        setText('max-val', isNaN(max) ? '0.000' : max.toFixed(3));
        setText('delta-val', isNaN(min) || isNaN(max) ? '0.000' : delta.toFixed(3));
        const balancePill = document.getElementById('balance-pill');
        if (balancePill) balancePill.classList.toggle('warn', delta > 0.005);
        const deltaEl = document.getElementById('delta-val');
        if (deltaEl) {
            if (delta > 0.03) {
                deltaEl.style.color = '#f85149';
            } else if (delta > 0.015) {
                deltaEl.style.color = '#d29922';
            } else {
                deltaEl.style.color = '#3fb950';
            }
        }
    }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function smooth(prev, next, alpha = 0.2) {
    return prev + alpha * (next - prev);
}

function formatUptime(sec) {
    sec = Math.floor(Number(sec) || 0);
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (d > 0 ? `${d}d ` : '') + `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatCompactUptime(sec) {
    sec = Math.floor(Number(sec) || 0);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function calculateEta(soc, current, data) {
    const socClamped = Math.max(0, Math.min(100, Number(soc)));
    const amp = Number(current);

    if (!isFinite(amp) || Math.abs(amp) < 0.05 || !isFinite(socClamped)) {
        return { value: '--', label: 'ETA' };
    }

    const cap = Number(data?.battery_capacity ?? data?.batteryCapacity);
    const capacityAh = isFinite(cap) && cap > 0 ? cap : 100;

    let hoursToTarget;
    let label;
    if (amp > 0) {
        const remainingAh = capacityAh * (100 - socClamped) / 100;
        hoursToTarget = remainingAh / amp;
        label = 'ДО 100%';
    } else {
        const remainingAh = capacityAh * socClamped / 100;
        hoursToTarget = remainingAh / Math.abs(amp);
        label = 'ДО 0%';
    }

    if (!isFinite(hoursToTarget) || hoursToTarget < 0) {
        return { value: '--', label: 'ETA' };
    }

    const totalMinutes = Math.min(99 * 60 + 59, Math.round(hoursToTarget * 60));
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return { value: `${hh}ч${String(mm).padStart(2, '0')}м`, label };
}

function getBaseTopic() {
    return normalizeBaseTopic(getMqttSettings().topic);
}

function sendMqttCmd(cmd, payload) {
    if (!isMqttServerMode()) return false; // Только в режиме сервер
    if (!client) {
        console.warn('[MQTT publish] НЕ отправлено: client не определён', cmd, payload);
        return false;
    }
    if (!client.connected) {
        console.warn('[MQTT publish] НЕ отправлено: client не подключён', cmd, payload);
        return false;
    }
    const base = getBaseTopic();
    if (!base) {
        console.warn('[MQTT publish] НЕ отправлено: base topic пустой', cmd, payload);
        return false;
    }
    const topic = base + '/' + cmd;
    console.log('[MQTT publish]', topic, payload);
    // Для агрегатов публикуем с retain
    const retainTopics = ['v', 'cell_min', 'cell_max', 'cell_delta', 'soc', 'a', 'p'];
    const retain = retainTopics.includes(cmd);
    client.publish(topic, payload, { retain }, (err) => {
        if (err) {
            console.error('[MQTT publish ERROR]', topic, payload, err);
        }
    });
    return true;
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
        return;
    }
    try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        registration.update();
    } catch (error) {
        console.warn('Service worker registration failed:', error);
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    // --- Кэшируем .mini-battery-grid .batt-val один раз ---
    battValsCache = Array.from(document.querySelectorAll('.mini-battery-grid .batt-val'));

    // --- Клик по визуальной ячейке: отправка случайного значения (LiFePO4) ---
    document.querySelectorAll('.mini-battery-grid .batt-container').forEach((container, idx) => {
        const minV = 2.5, maxV = 3.65;
        const cellNum = idx + 1;
        container.style.cursor = 'pointer';
        container.addEventListener('click', () => {
            if (!isMqttServerMode()) return; // Только в режиме сервер
            const valueTap = (Math.random() * (maxV - minV) + minV).toFixed(3);
            sendMqttCmd(`cell${cellNum}`, valueTap);
            const valSpan = container.querySelector('.batt-val');
            if (valSpan) {
                valSpan.textContent = valueTap;
                valSpan.style.color = '#79c0ff';
                setTimeout(() => { valSpan.style.color = ''; }, 700);
            }
            const slider = document.getElementById(`cell-slider-${cellNum}`);
            if (slider) {
                // Отключаем обработчик change временно
                const oldOnChange = slider.onchange;
                slider.onchange = null;
                slider.value = valueTap;
                const valSliderSpan = document.getElementById(`cell-slider-val-${cellNum}`);
                if (valSliderSpan) valSliderSpan.textContent = valueTap + ' В';
                setTimeout(() => { slider.onchange = oldOnChange; }, 0);
            }
            let current = currentGenValues[currentGenIdx % currentGenValues.length];
            currentGenIdx++;
            lastData.current = current;
            lastData.currentJustTapped = true;
            updateCellSlidersSummary(true); // обновляем DOM и публикуем в MQTT
        });
    });
    const s = await loadInitialMqttSettings();
    document.getElementById('mqttHost').value = s.host;
    document.getElementById('mqttPort').value = s.port;
    document.getElementById('mqttUser').value = s.user;
    document.getElementById('mqttPass').value = s.pass;
    const topicInput = document.getElementById('mqttTopic');
    if (topicInput) {
        topicInput.value = normalizeTopicWithWildcard(s.topic);
        topicInput.addEventListener('blur', () => {
            topicInput.value = normalizeTopicWithWildcard(topicInput.value);
        });
    }
    registerServiceWorker();
    connectMQTT();
    registerCellsChartCanvas();

    document.getElementById('charge-pill')?.addEventListener('click', () => {
        if (mosfetCommandState.chg) return;
        const isOn = lastData.mosfet_chg === 'ON';
        if (!sendMqttCmd('mosfet_chg/set', isOn ? 'OFF' : 'ON')) {
            setStatus('MQTT не подключен', true);
            return;
        }
        setMosfetPending('chg', true);
        setTimeout(() => setMosfetPending('chg', false), 5000);
    });
    document.getElementById('dischg-pill')?.addEventListener('click', () => {
        if (mosfetCommandState.dis) return;
        const isOn = lastData.mosfet_dis === 'ON';
        if (!sendMqttCmd('mosfet_dis/set', isOn ? 'OFF' : 'ON')) {
            setStatus('MQTT не подключен', true);
            return;
        }
        setMosfetPending('dis', true);
        setTimeout(() => setMosfetPending('dis', false), 5000);
    });
    // убрано, чтобы не было лишних вызовов updateCellSlidersSummary при старте
    setInterval(() => {
        if (!client || !client.connected || manualDisconnect) return;
        if (!hasTelemetryData) return;
        if (Date.now() - lastUpdateTime > 15000) {
            setStatus('Нет данных', true);
        } else {
            setStatus('MQTT');
        }
    }, 2000);
});

// --- Вынесенная глобально функция ---
function updateCellSlidersSummary(sendMqtt = false, currentArg, valuesOverride) {
    // Если передан массив значений — используем его, иначе берём из DOM
    // Используем глобальный кэш battValsCache
    let values = Array.isArray(valuesOverride)
        ? valuesOverride.filter(x => !isNaN(x))
        : battValsCache.map(el => Number(el.textContent)).filter(x => !isNaN(x));
    // Фильтруем только положительные значения
    values = values.filter(v => v > 0);
    if (!values.length) {
        console.log('[DEBUG] Нет валидных значений для агрегатов, расчёты не выполняются');
        return;
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const delta = max - min;
    let current = getCurrent();
    let power = (!isNaN(current) && !isNaN(sum)) ? current * sum : NaN;
    // ...лог убран...
    // Если есть элементы для отображения суммы/min/max
    const sumEl = document.getElementById('cell-sliders-sum');
    if (sumEl) sumEl.textContent = sum.toFixed(3);
    const minEl = document.getElementById('cell-sliders-min');
    if (minEl) minEl.textContent = min.toFixed(3);
    const maxEl = document.getElementById('cell-sliders-max');
    if (maxEl) maxEl.textContent = max.toFixed(3);
    // Обновляем v-val на странице
    const vValEl = document.getElementById('v-val');
    if (vValEl) vValEl.textContent = sum.toFixed(2);

    // --- Расчёт SOC на основе напряжения ---
    let soc = 0;
    const n = values.length;
    let vMin = 2.5, vMax = 3.65; // LiFePO4 по умолчанию
    if (n === 3) { vMin = 3.0; vMax = 4.2; } // Li-ion
    // Суммарный диапазон
    const vSumMin = n * vMin;
    const vSumMax = n * vMax;
    soc = ((sum - vSumMin) / (vSumMax - vSumMin)) * 100;
    // Сглаживание для стабильности отображения
    soc = smooth(lastData.soc || soc, soc, 0.3);
    soc = Math.max(0, Math.min(100, Math.round(soc)));

    // --- Публикуем вычисленный soc как строку ---
    const socToSend = String(soc);
    // Обновить lastData и на странице
    lastData.soc = soc;
    const socEl = document.getElementById('soc-val');
    if (socEl) socEl.textContent = soc + '%';

    // --- Публикация агрегатов: soc первым ---
    // --- Генерация и публикация тока и мощности ---
    // lastData.current = current; // не обновляем current при отображении
    lastData.p = power;
    // Обновить на странице, если есть элементы
    const currentEl = document.getElementById('current-val');
    if (currentEl) currentEl.textContent = (!isNaN(current) ? current.toFixed(2) : '--') + ' A';
    const powerEl = document.getElementById('power-val');
    if (powerEl) powerEl.textContent = isNaN(power) ? '-- W' : power.toFixed(2) + ' W';

    if (sendMqtt) {
        if (Date.now() - lastSocSentTime > 1000) {
            sendMqttCmd('soc', socToSend);
            lastSocSentTime = Date.now();
        }
        publishIfChanged('v', sum.toFixed(3));
        publishIfChanged('cell_min', min.toFixed(3));
        publishIfChanged('cell_max', max.toFixed(3));
        publishIfChanged('cell_delta', delta.toFixed(3));
        // При первом запуске всегда отправляем a и p явно
        if (!isNaN(current)) {
            lastData.a = current; // ВАЖНО: фиксируем ток при отправке
            sendMqttCmd('a', current.toFixed(2));
        }
        if (!isNaN(power)) {
            sendMqttCmd('p', power.toFixed(2));
        }
    }
}
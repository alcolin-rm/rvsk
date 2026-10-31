// static/app.js
let pollTimer;
const hiddenJobIds = new Set();

// ──────────────────────────────────────────────────────────────
// Status helper
// ──────────────────────────────────────────────────────────────

function setVKStatus(text, kind) {
    const el = document.getElementById('vkStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
}

// ──────────────────────────────────────────────────────────────
// Fetch from VK via the extension bridge
// ──────────────────────────────────────────────────────────────

async function fetchFromVK() {
    const albumOrLink = document.getElementById('albumOrLink');
    const url = albumOrLink.value.trim();

    if (!url.startsWith('http')) {
        setVKStatus('Paste a VK playlist URL (https://...) first', 'error');
        return;
    }

    const btn = document.getElementById('vkFetchBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    setVKStatus('Submitting command to extension bridge...', 'info');

    try {
        const fd = new FormData();
        fd.append('playlist_url', url);
        const submit = await fetch('/api/vk-command', { method: 'POST', body: fd });
        if (!submit.ok) {
            const err = await submit.json().catch(() => ({}));
            throw new Error(err.detail || 'Could not submit command');
        }
        const { command_id } = await submit.json();

        setVKStatus('Waiting for extension to respond (up to 90 seconds)...', 'info');
        btn.textContent = 'Waiting...';

        const deadline = Date.now() + 90000;
        let result = null;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            const r = await fetch(`/api/vk-command/${command_id}`, { cache: 'no-store' });
            const d = await r.json();
            if (d.status === 'done') {
                result = d.result;
                break;
            }
        }

        if (!result) {
            throw new Error('No response from the extension. Make sure it is installed and running.');
        }
        if (result.error) {
            throw new Error(result.error);
        }

        const lines = result.tracks.map((t, i) => {
            const dur = t.duration ? ` [${t.duration}]` : '';
            return `${i + 1}. ${t.artist} - ${t.title}${dur}`;
        });
        const trackList = document.getElementById('trackList');
        trackList.value = lines.join('\n');

        if (albumOrLink.value.trim().startsWith('http') && result.playlistTitle) {
            albumOrLink.value = result.playlistTitle;
        }

        trackList.dispatchEvent(new Event('input'));
        albumOrLink.dispatchEvent(new Event('input'));

        setVKStatus(`Loaded ${result.total} tracks from "${result.playlistTitle}"`, 'success');
    } catch (e) {
        setVKStatus(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch from VK';
    }
}

// ──────────────────────────────────────────────────────────────
// Downloads
// ──────────────────────────────────────────────────────────────

async function startDownload() {
    const list = document.getElementById('trackList').value;
    if (!list.trim()) {
        setVKStatus('Paste a track list first', 'error');
        return;
    }

    const fd = new FormData();
    fd.append('track_list', list);
    fd.append('playlist_name', document.getElementById('albumOrLink').value);
    fd.append('album_mode', document.getElementById('preferOneSeeder').checked ? 'true' : 'false');
    
    fd.append('format_pref', document.getElementById('filterFormat').value);
    fd.append('min_bitrate', document.getElementById('filterMinBitrate').value);

    const btn = document.getElementById('downloadBtn');
    btn.disabled = true;
    btn.textContent = 'Starting...';

    try {
        const r = await fetch('/api/download', { method: 'POST', body: fd });
        
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || 'Request failed');
        }
        
        const data = await r.json();
        
        if (!data || !data.job_id) {
            throw new Error('Server returned an invalid response.');
        }

        setVKStatus(`Download started - job ${data.job_id} (${data.total} tracks)`, 'success');
        startPolling();
    } catch (e) {
        setVKStatus(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Download';
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchJobs, 2000);
    fetchJobs();
}

async function fetchJobs() {
    try {
        const r = await fetch('/api/jobs');
        const d = await r.json();
        const jobs = d.jobs || {};
        renderJobs(jobs);
        renderLeechers(jobs);
        updateDaemonLog(jobs);
    } catch (e) {
        // ignore
    }
}

// ──────────────────────────────────────────────────────────────
// Jobs panel
// ──────────────────────────────────────────────────────────────

function captureLogScrolls() {
    const map = {};
    document.querySelectorAll('pre[data-logid]').forEach(el => {
        map[el.dataset.logid] = { top: el.scrollTop, height: el.scrollHeight };
    });
    return map;
}

function restoreLogScrolls(map) {
    document.querySelectorAll('pre[data-logid]').forEach(el => {
        const saved = map[el.dataset.logid];
        if (!saved) return;
        const grew = el.scrollHeight > saved.height;
        const atBottom = saved.top + el.clientHeight >= saved.height - 5;
        if (atBottom && grew) {
            el.scrollTop = el.scrollHeight;
        } else {
            el.scrollTop = saved.top;
        }
    });
}

function renderJobs(jobs) {
    const block = document.getElementById('logsBlock');
    const el = document.getElementById('jobsList');
    const entries = Object.values(jobs).filter(j => !hiddenJobIds.has(j.id));

    if (!entries.length) {
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');

    const scrolls = captureLogScrolls();
    const outerTop = block.scrollTop;

    el.innerHTML = entries.map(j => {
        const pct = (j.progress || 0) * 100;
        const log = (j.log || []).slice(-40).join('\n');
        const folder = j.folder_name ? ` -> ${escapeHtml(j.folder_name)}` : '';
        return `
            <div class="job ${j.status}" data-jobid="${j.id}">
                <div class="job-header">
                    <span><strong>${j.id}</strong>${folder}</span>
                    <button class="small" data-joblog="${j.id}">Full Log</button>
                </div>
                <div>${escapeHtml(j.message || '')}</div>
                <div class="progress">
                    <div class="progress-fill" style="width:${pct}%"></div>
                </div>
                <div class="job-stats">
                    ${j.downloaded || 0} / ${j.total || 0} downloaded | 
                    ${j.failed || 0} failed
                    ${j.skipped ? ` | ${j.skipped} skipped` : ''}
                </div>
                ${log ? `<pre data-logid="${j.id}">${escapeHtml(log)}</pre>` : ''}
            </div>
        `;
    }).join('');

    restoreLogScrolls(scrolls);
    block.scrollTop = outerTop;

    const failures = entries.reduce((acc, j) => acc + (j.failed || 0), 0);
    if (failures > 0 && !entries.some(j => ['running', 'searching', 'starting'].includes(j.status))) {
        setVKStatus(`⚠️ ${failures} tracks failed. Check the logs or try changing the format filter.`, 'error');
    }
}

function clearFinishedJobs() {
    document.querySelectorAll('.job').forEach(el => {
        if (el.classList.contains('complete') ||
            el.classList.contains('partial') ||
            el.classList.contains('error') ||
            el.classList.contains('cancelled')) {
            const id = el.dataset.jobid;
            if (id) hiddenJobIds.add(id);
        }
    });
    fetchJobs();
}

// ──────────────────────────────────────────────────────────────
// Seeders panel
// ──────────────────────────────────────────────────────────────

function renderLeechers(jobs) {
    const block = document.getElementById('seedersBlock');
    const el = document.getElementById('leechersList');
    const totals = {};

    for (const job of Object.values(jobs)) {
        if (hiddenJobIds.has(job.id)) continue;
        const leech = job.leechers || {};
        for (const [user, count] of Object.entries(leech)) {
            totals[user] = (totals[user] || 0) + count;
        }
    }

    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');

    const top = block.scrollTop;
    el.innerHTML = entries.map(([user, count]) => `
        <div class="leecher-row">
            <span class="leecher-name">${escapeHtml(user)}</span>
            <span class="leecher-count">${count} file${count === 1 ? '' : 's'}</span>
        </div>
    `).join('');
    block.scrollTop = top;
}

// ──────────────────────────────────────────────────────────────
// Daemon Log Viewer
// ──────────────────────────────────────────────────────────────

async function updateDaemonLog(jobs) {
    const el = document.getElementById('daemonLog');
    const entries = Object.values(jobs).filter(j => !hiddenJobIds.has(j.id));
    
    if (!entries.length) {
        el.textContent = "No active jobs.";
        return;
    }

    try {
        const r = await fetch('/api/daemon-log');
        const d = await r.json();
        // d.log is guaranteed to be a string from the backend
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
        el.textContent = d.log;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    } catch (e) { 
        el.textContent = "Failed to fetch daemon log.";
    }
}






// ──────────────────────────────────────────────────────────────
// Full log viewer
// ──────────────────────────────────────────────────────────────

async function openFullLog(jobId) {
    const r = await fetch(`/api/jobs/${jobId}/log`);
    const d = await r.json();
    const w = window.open('', '_blank');
    w.document.write(
        `<pre style="background:#0a0a0f;color:#d0d0d0;padding:20px;` +
        `font-family:monospace;white-space:pre-wrap;word-break:break-all;">` +
        `${escapeHtml(d.log)}</pre>`
    );
}

// ──────────────────────────────────────────────────────────────
// Settings
// ──────────────────────────────────────────────────────────────

async function loadSettings() {
    try {
        const r = await fetch('/api/config');
        const cfg = await r.json();
        document.getElementById('settingsUser').textContent =
            cfg.soulseek_username || '(not configured)';
        document.getElementById('settingsOutput').textContent =
            cfg.output_dir || '-';
    } catch (e) {}
}

async function refreshAccountChip() {
    const chip  = document.getElementById('accountChip');
    const label = document.getElementById('accountLabel');
    try {
        const r = await fetch('/api/config');
        const cfg = await r.json();
        if (cfg.soulseek_username) {
            chip.className = 'account-chip ok';
            label.textContent = cfg.soulseek_username;
        } else {
            chip.className = 'account-chip warn';
            label.textContent = 'not configured';
        }
    } catch (e) {
        chip.className = 'account-chip bad';
        label.textContent = 'offline';
    }
}

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadSettings();
}

async function resetConfig() {
    if (!confirm('Reset credentials and return to setup?')) return;
    await fetch('/api/config/reset', { method: 'POST' });
    window.location.href = '/setup';
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const downloadBtn   = document.getElementById('downloadBtn');
    const resetBtn      = document.getElementById('resetBtn');
    const settingsBtn   = document.getElementById('settingsBtn');
    const clearLogsBtn  = document.getElementById('clearLogsBtn');
    const vkFetchBtn    = document.getElementById('vkFetchBtn');
    const albumOrLink   = document.getElementById('albumOrLink');
    const trackListArea = document.getElementById('trackList');

    function looksLikeVKUrl(val) {
        if (!val) return false;
        const v = val.trim().toLowerCase();
        if (/^(https?:\/\/)?(www\.)?vk\.(com|ru)\//.test(v)) return true;
        if (/(music\/playlist|audio_playlist)[\/_]/i.test(v)) return true;
        return false;
    }

    function updateButtons() {
        const linkVal  = albumOrLink.value.trim();
        const trackVal = trackListArea.value.trim();
        vkFetchBtn.disabled  = !looksLikeVKUrl(linkVal);
        const isUrl = looksLikeVKUrl(linkVal);
        const hasAlbumOrTrack = isUrl ? false : linkVal.length > 0;
        downloadBtn.disabled = !(trackVal || hasAlbumOrTrack);
    }

    downloadBtn.addEventListener('click', startDownload);
    resetBtn.addEventListener('click', resetConfig);
    settingsBtn.addEventListener('click', toggleSettings);
    vkFetchBtn.addEventListener('click', fetchFromVK);
    clearLogsBtn.addEventListener('click', clearFinishedJobs);

    ['input', 'change', 'keyup', 'paste', 'blur'].forEach(evt => {
        albumOrLink.addEventListener(evt, () => setTimeout(updateButtons, 0));
    });
    ['input', 'change', 'keyup', 'paste', 'blur'].forEach(evt => {
        trackListArea.addEventListener(evt, () => setTimeout(updateButtons, 0));
    });

    setInterval(updateButtons, 500);
    
    document.getElementById('jobsList').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-joblog]');
        if (btn) openFullLog(btn.dataset.joblog);
    });

    updateButtons();
    refreshAccountChip();
    loadSettings();
    setInterval(refreshAccountChip, 15000);

    startPolling();
});
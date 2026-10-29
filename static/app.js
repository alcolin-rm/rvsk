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

        const deadline = Date.now() + 30000;
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
            throw new Error(
                'No response from the extension. Make sure it is installed, ' +
                'loaded in this browser, and the Revseeker web app is running at ' +
                'http://127.0.0.1:8000.'
            );
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

        setVKStatus(
            `Loaded ${result.total} tracks from "${result.playlistTitle}"`,
            'success'
        );
    } catch (e) {
        setVKStatus(e.message, 'error');
        console.error('[VK fetch]', e);
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
        alert('Paste a track list first');
        return;
    }

    const fd = new FormData();
    fd.append('track_list', list);
    fd.append('playlist_name', document.getElementById('albumOrLink').value);
    fd.append('album_mode', document.getElementById('preferOneSeeder').checked ? 'true' : 'false');

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
        
        // DEFENSIVE CHECK: If data is null, throw a clear error
        if (!data || !data.job_id) {
            throw new Error('Server returned an invalid response (missing job_id)');
        }

        setVKStatus(
            `Download started - job ${data.job_id} (${data.total} tracks)`,
            'success'
        );
        startPolling();
    } catch (e) {
        setVKStatus(e.message, 'error');
        alert('Error: ' + e.message);
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
        renderBrowseWindow(jobs);
    } catch (e) {
        // ignore
    }
}

// ──────────────────────────────────────────────────────────────
// Jobs panel
// ──────────────────────────────────────────────────────────────

// Snapshot the current scroll positions of any open log pre blocks
// so we can restore them after re-rendering.
function captureLogScrolls() {
    const map = {};
    document.querySelectorAll('pre[data-logid]').forEach(el => {
        map[el.dataset.logid] = {
            top: el.scrollTop,
            height: el.scrollHeight,
        };
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
            // User was already at the bottom; keep them there
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

    // Snapshot scroll positions before replacing DOM
    const scrolls = captureLogScrolls();

    // Snapshot the outer panel scroll too
    const outerTop = block.scrollTop;

    el.innerHTML = entries.map(j => {
        const pct = (j.progress || 0) * 100;
        // Last 40 lines only, keep the HTML small enough for 2s repaints
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

    // Restore scroll positions
    restoreLogScrolls(scrolls);
    block.scrollTop = outerTop;
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
    // Re-render immediately with the updated filter
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

    // Preserve scroll
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
// Fake soulseek panel - live download feed
// ──────────────────────────────────────────────────────────────

function renderBrowseWindow(jobs) {
    const scroll = document.getElementById('browseScroll');

    // Collect entries from every job, newest job first
    const entries = [];
    const orderedJobs = Object.values(jobs)
        .sort((a, b) => (b.created || '').localeCompare(a.created || ''));

    for (const job of orderedJobs) {
        for (const entry of (job.browse_entries || [])) {
            entries.push({ ...entry, jobId: job.id });
        }
    }

    if (!entries.length) {
        scroll.innerHTML = `
            <div class="muted" style="padding: 24px; text-align: center;">
                Files will appear here as the downloader picks seeders.
            </div>`;
        return;
    }

    // Preserve scroll if user was near the bottom
    const prevTop = scroll.scrollTop;
    const prevHeight = scroll.scrollHeight;
    const wasAtBottom = prevTop + scroll.clientHeight >= prevHeight - 10;

    // Group by seeder
    const bySeeder = {};
    for (const e of entries) {
        const s = e.seeder;
        if (!bySeeder[s]) bySeeder[s] = [];
        bySeeder[s].push(e);
    }

    const seeders = Object.entries(bySeeder)
        .sort((a, b) => b[1].length - a[1].length);

    scroll.innerHTML = seeders.map(([seeder, list]) => {
        // Sort: active first, then done, then failed; within a group by filename
        const order = { active: 0, done: 1, failed: 2 };
        list.sort((a, b) => {
            const d = order[a.state] - order[b.state];
            if (d !== 0) return d;
            const fa = (a.path || '').split(/[\\/]/).pop() || '';
            const fb = (b.path || '').split(/[\\/]/).pop() || '';
            return fa.localeCompare(fb);
        });

        const rows = list.map(e => {
            const filename = (e.path || '').split(/[\\/]/).pop() || e.path || '';
            const dotClass = `dot-${e.state}`;
            return `<tr>
                <td class="dot-cell"><span class="status-dot ${dotClass}"></span></td>
                <td>${escapeHtml(filename)}</td>
                <td class="track-cell">${escapeHtml(e.track)}</td>
            </tr>`;
        }).join('');

        return `
            <div class="browse-folder">
                <div class="folder-path">${escapeHtml(seeder)} (${list.length} file${list.length === 1 ? '' : 's'})</div>
                <table class="file-table">
                    <thead>
                        <tr><th></th><th>File</th><th>Track</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }).join('');

    // Auto-follow if user was at bottom
    if (wasAtBottom) {
        scroll.scrollTop = scroll.scrollHeight;
    } else {
        scroll.scrollTop = prevTop;
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
    } catch (e) {
        // ignore
    }
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
        // Accept with or without scheme
        if (/^(https?:\/\/)?(www\.)?vk\.(com|ru)\//.test(v)) return true;
        // Accept fragment forms
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

        // Fire on every plausible change path
    ['input', 'change', 'keyup', 'paste', 'blur'].forEach(evt => {
        albumOrLink.addEventListener(evt, () => setTimeout(updateButtons, 0));
    });
    ['input', 'change', 'keyup', 'paste', 'blur'].forEach(evt => {
        trackListArea.addEventListener(evt, () => setTimeout(updateButtons, 0));
    });

    // Safety net for programmatic .value changes
    setInterval(updateButtons, 500);
    document.getElementById('jobsList').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-joblog]');
        if (btn) openFullLog(btn.dataset.joblog);
    });

    updateButtons();
    refreshAccountChip();
    loadSettings();

    setInterval(refreshAccountChip, 15000);
    
    
    // Check if VK URL was passed from the extension
    const vkUrlParam = new URLSearchParams(window.location.search).get('vk_url');
    if (vkUrlParam) {
        // Put the URL in the input field
        albumOrLink.value = vkUrlParam;
        
        // Remove the query param from the address bar so refreshing doesn't re-trigger it
        window.history.replaceState({}, document.title, window.location.pathname);
        
        // Enable the button and trigger the fetch
        updateButtons();
        setTimeout(fetchFromVK, 500);
    }

    startPolling();
});
// popup.js — runs in the popup context

const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('exportCurrentBtn');
const copyBtn = document.getElementById('copyCurrentBtn');

let lastResult = null;

function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
}

function formatTracks(result) {
    return result.tracks.map((t, i) => {
        const dur = t.duration ? ` [${t.duration}]` : '';
        return `${i + 1}. ${t.artist} - ${t.title}${dur}`;
    }).join('\n');
}

function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(resp);
            }
        });
    });
}

async function extractCurrent() {
    exportBtn.disabled = true;
    copyBtn.disabled = true;
    setStatus('Extracting...');

    try {
        const result = await sendToBackground({ action: 'extractFromActiveTab' });
        if (result.error) throw new Error(result.error);
        lastResult = result;
        return result;
    } catch (e) {
        setStatus(e.message, 'error');
        throw e;
    } finally {
        exportBtn.disabled = false;
        copyBtn.disabled = false;
    }
}

exportBtn.addEventListener('click', async () => {
    try {
        const result = await extractCurrent();
        const trackListText = formatTracks(result);

        setStatus('Sending to Revseeker...');

        // Send directly to the local FastAPI backend
        const fd = new FormData();
        fd.append('track_list', trackListText);
        fd.append('playlist_name', result.playlistTitle || '');

        const response = await fetch('http://127.0.0.1:8000/api/download', {
            method: 'POST',
            body: fd
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        setStatus(`Sent ${result.total} tracks!`, 'success');

        // FIXED: Match any path on 127.0.0.1/localhost, then filter by the port in JS
        const tabs = await chrome.tabs.query({ 
            url: ["*://127.0.0.1/*", "*://localhost/*"] 
        });
        
        // Find the specific tab that is running Revseeker on port 8000
        const revTab = tabs.find(t => t.url && t.url.includes(':8000'));

        if (revTab) {
            // Switch to the existing tab
            await chrome.tabs.update(revTab.id, { active: true });
            await chrome.windows.update(revTab.windowId, { focused: true });
        } else {
            // It's not open, so create it
            await chrome.tabs.create({ url: "http://127.0.0.1:8000" });
        }

        // Close the popup
        setTimeout(() => window.close(), 500);

    } catch (e) {
        if (e.name === 'TypeError' && e.message.includes('Failed to fetch')) {
            setStatus('Is Revseeker running? Could not connect to localhost:8000.', 'error');
        } else {
            setStatus(`${e.message}`, 'error');
        }
    }
});




copyBtn.addEventListener('click', async () => {
    try {
        const result = lastResult || await extractCurrent();
        const text = formatTracks(result);
        await navigator.clipboard.writeText(text);
        setStatus(`✅ Copied ${result.total} tracks to clipboard`, 'success');
    } catch (e) {
        setStatus(`❌ ${e.message}`, 'error');
    }
});
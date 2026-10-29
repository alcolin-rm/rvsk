// content_vk.js
// Injects a native-looking "Revseeker" button into VK playlist headers and modals.

(function () {
    'use strict';

    const BUTTON_ID = 'revseeker-inject-btn-wrapper';

    // 1. Find the modal overlay (or the page body if it's a standalone page)
    function findModal() {
        const modal = document.querySelector('[role="dialog"], [class*="vkuiModal"], [class*="ModalPage"]');
        if (modal) return modal;
        
        // Fallback: If we are on a full standalone playlist page, use the body
        if (window.location.href.includes('playlist')) {
            return document.body;
        }
        return null;
    }

    // 2. Find the row containing Play, Shuffle, and the three-dot menu
    function findActionRow(modal) {
        // Look for the Shuffle icon first, as it's unique to the action row
        let icon = modal.querySelector('svg[class*="vkuiIcon--shuffle"]');
        
        // Fallbacks: Play icon, or the "More" (three dots) button
        if (!icon) icon = modal.querySelector('svg[class*="vkuiIcon--play"]');
        if (!icon) icon = modal.querySelector('button[aria-label*="Ещё"], button[aria-label*="More"]');
        
        if (icon) {
            const btn = icon.closest('button');
            if (btn && btn.parentElement) {
                return btn.parentElement;
            }
        }
        return null;
    }

    // 3. Extract the actual playlist URL from the page or modal
    function extractPlaylistUrl(modal) {
        let url = window.location.href;
        
        // If we are already on a playlist page URL, return it
        if (/(?:music|audio)[/_]playlist[/]\d+_\d+/.test(url) || /[?&]z=audio_playlist\d+_\d+/.test(url)) {
            return url;
        }

        // If we are in a modal over /im or /feed, scan the modal for the hidden link
        const links = modal.querySelectorAll('a[href]');
        for (const a of links) {
            if (a.href.includes('playlist') || a.href.includes('audio_playlist')) {
                return a.href;
            }
        }

        return null;
    }

    // 4. Build and style the button
    function makeButton(sampleBtn) {
        const wrapper = document.createElement('div');
        wrapper.id = BUTTON_ID;
        wrapper.style.display = 'inline-block';
        wrapper.style.marginLeft = '8px';

        const btn = document.createElement('button');
        btn.type = 'button';
        
        // Copy classes directly from the Shuffle button so it perfectly matches the theme
        if (sampleBtn) {
            btn.className = sampleBtn.className;
        } else {
            // Fallback to standard VKUI classes if we can't find the sample
            btn.className = 'vkuiButton vkuiButton--secondary vkuiButton--size-l';
        }
        
        btn.style.cursor = 'pointer';
        btn.innerHTML = `
            <span class="vkuiButton__in">
                <span class="vkuiButton__content" style="display:flex; align-items:center; gap:6px;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                    </svg>
                    Revseeker
                </span>
            </span>
        `;

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const url = extractPlaylistUrl(findModal());
            
            if (!url) {
                alert("Could not extract playlist link. Please try opening the playlist as a full page.");
                return;
            }

            // Visual feedback
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<span style="opacity:0.7">Fetching...</span>';
            
            chrome.runtime.sendMessage(
                { action: 'launchWebApp', url: url },
                () => {
                    // Restore original text after 2 seconds
                    setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
                }
            );
        });
        
        wrapper.appendChild(btn);
        return wrapper;
    }

    // 5. Main injection logic
    function injectButton() {
        // Don't inject if it's already there
        if (document.getElementById(BUTTON_ID)) return;

        const modal = findModal();
        if (!modal) return;

        const actionRow = findActionRow(modal);
        if (!actionRow) return;

        // Find the Shuffle button to use as a styling template
        const shuffleBtn = actionRow.querySelector('button[aria-label*="еремеш"], button[aria-label*="huffle"]');
        
        actionRow.appendChild(makeButton(shuffleBtn));
        console.log('[Revseeker] Button injected into VK UI');
    }

    // 6. Watch for VK's SPA navigation and React re-renders
    let debounceTimer;
    const observer = new MutationObserver(() => {
        // Debounce to avoid performance issues on heavy DOM updates
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(injectButton, 200);
    });

    function start() {
        observer.observe(document.body, { childList: true, subtree: true });
        injectButton();
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
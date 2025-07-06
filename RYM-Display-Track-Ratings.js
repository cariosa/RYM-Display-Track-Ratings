// ==UserScript==
// @name         RYM Display Track Ratings
// @namespace    cariosa
// @version      1.6
// @description  Displays average Track ratings and info directly on rateyourmusic album or any other release pages.
// @author       cariosa
// @match        https://rateyourmusic.com/release/*
// @icon         https://e.snmc.io/2.5/img/sonemic.png
// @downloadURL  https://update.greasyfork.org/scripts/527869/RYM%20Display%20Track%20Ratings.user.js
// @updateURL    https://raw.githubusercontent.com/cariosa/RYM-Display-Track-Ratings/refs/heads/main/RYM-Display-Track-Ratings.js
// @require      https://openuserjs.org/src/libs/sizzle/GM_config.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @license      GPL-3.0-or-later
// ==/UserScript==

// --- I. SETTINGS PANEL SETUP ---
GM_config.init({
    'id': 'RYMTrackRatingsConfig',
    'title': 'RYM Track Ratings Settings',
    'fields': {
        'requestDelay': {
            'label': 'Delay between request chunks (ms):',
            'type': 'int',
            'default': 1500,
            'title': 'The pause between fetching each batch of tracks.'
        },
        'cacheDays': {
            'label': 'Cache expiration (days):',
            'type': 'int',
            'default': 7,
            'title': 'How long to store data before fetching it again.'
        }
    }
});
GM_registerMenuCommand('Configure Track Ratings', () => GM_config.open());


// --- II. MAIN SCRIPT LOGIC ---
function runScript() {
    'use strict';

    // --- A. Script State and Helpers ---
    const CHUNK_SIZE = 4;
    const DEBUG_MODE = false;

    let loadClickCount = 0;
    let trackDataCache = getCache();
    let genreRankingsVisible = GM_getValue('genreRankingsVisible', true);

    const log = (message) => { if (DEBUG_MODE) console.log(message); };

    function showError(message) {
        const errorElement = document.createElement('div');
        errorElement.textContent = `Error: ${message}`;
        errorElement.style.cssText = 'color: red; position: fixed; top: 10px; right: 10px; background-color: white; padding: 10px; z-index: 9999; border-radius: 5px; box-shadow: 0 1px 5px rgba(0,0,0,0.4);';
        document.body.appendChild(errorElement);
        setTimeout(() => errorElement.remove(), 5000);
    }

    // --- B. UI Creation and Insertion ---
    function createButton(text, onClick, id = '') {
        const button = document.createElement('button');
        button.textContent = text;
        button.id = id;
        button.style.cssText = `margin-left: 3px; padding: 3px; border: 0; border-radius: 2px; background: #cba6f7; cursor: pointer; font-size: 10px; transition: background-color 0.2s;`;
        button.addEventListener('mouseover', () => { if (!button.disabled) button.style.backgroundColor = '#f2cdcd'; });
        button.addEventListener('mouseout', () => { if (!button.disabled) button.style.backgroundColor = '#cba6f7'; });
        button.addEventListener('click', onClick);
        return button;
    }

    function createButtons(buttonsData) {
        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginBottom = '10px';
        buttonContainer.classList.add('rym-track-ratings-buttons');
        buttonsData.forEach(({ text, onClick, id }) => {
            buttonContainer.appendChild(createButton(text, onClick, id));
        });
        return buttonContainer;
    }

    function insertButtons() {
        const trackContainers = [document.getElementById('tracks'), document.getElementById('tracks_mobile')];
        trackContainers.forEach((tracksContainer) => {
            if (tracksContainer && !tracksContainer.previousElementSibling?.classList.contains('rym-track-ratings-buttons')) {
                const buttonContainer = createButtons([
                    { text: 'Load Track Ratings', onClick: (e) => toggleTrackRatings(e.target), id: 'load-ratings-btn' },
                    { text: 'Toggle Genre/Rankings', onClick: toggleGenreRankings },
                    { text: 'Clear Cache', onClick: clearCache }
                ]);
                tracksContainer.parentNode.insertBefore(buttonContainer, tracksContainer);
            }
        });
    }

    // --- C. Data Parsing and HTML Injection ---
    function parseTrackRating(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const ratingElement = doc.querySelector('.page_section_main_info_music_rating_value_rating');
        const countElement = doc.querySelector('.page_section_main_info_music_rating_value_number');
        if (!ratingElement || !countElement) return null;
        return { rating: ratingElement.textContent.trim().match(/\d+\.\d+/)?.[0], count: countElement.textContent.trim().match(/[\d,]+/)?.[0], isBold: !!ratingElement.querySelector('img[alt="rating bolded"]') };
    }

    function parseTrackInfo(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return { genre: doc.querySelector('.page_song_header_info_genre_item_primary .genre')?.outerHTML || null, rankings: Array.from(doc.querySelectorAll('.page_song_header_info_rest .comma_separated')).map(el => el.outerHTML).join('<br>') };
    }

    function createRatingHTML(rating, count, isBold) {
        const starClass = isBold ? 'metadata-star-bold' : 'metadata-star';
        return `<span data-tiptip="${rating} from ${count} ratings" class="has_tip page_release_section_tracks_songs_song_stats significant"><span class="page_release_section_tracks_track_stats_scores"><span class="page_release_section_tracks_track_stats_score_star pipe_separated"><img alt="${isBold ? 'bold star' : 'star'}" class="${starClass}"><div class="page_release_section_tracks_track_stats_rating pipe_separated">${rating}</div></span><div class="page_release_section_tracks_track_stats_count pipe_separated">${count}</div></span></span>`;
    }

    function insertTrackRating(trackElement, rating, count, isBold) {
        if (trackElement.querySelector('.page_release_section_tracks_track_stats_scores')) return;
        const tracklistLine = trackElement.querySelector('.tracklist_line');
        const trackNumber = trackElement.querySelector('.tracklist_num');
        if (tracklistLine && trackNumber) {
            const ratingElement = document.createElement('span');
            ratingElement.innerHTML = createRatingHTML(rating, count, isBold);
            tracklistLine.insertBefore(ratingElement, trackNumber);
        }
    }

    function insertTrackInfo(trackElement, genre, rankings) {
        if (trackElement.querySelector('.genre-info')) return;
        const tracklistLine = trackElement.querySelector('.tracklist_line');
        if (tracklistLine) {
            const genreElement = document.createElement('div');
            genreElement.innerHTML = genre;
            genreElement.style.marginTop = '2px';
            genreElement.classList.add('genre-info');
            genreElement.style.display = genreRankingsVisible ? 'block' : 'none';
            tracklistLine.appendChild(genreElement);
            const rankingElement = document.createElement('div');
            rankingElement.innerHTML = rankings;
            rankingElement.style.marginTop = '2px';
            rankingElement.classList.add('ranking-info');
            rankingElement.style.display = genreRankingsVisible ? 'block' : 'none';
            tracklistLine.appendChild(rankingElement);
        }
    }

    // --- D. Core Logic: Fetching and Processing ---
    async function processTrackData(trackElement) {
        const songLink = trackElement.querySelector('a.song');
        if (!songLink) return 'failed';

        const trackName = songLink.textContent.trim();
        const cacheKey = `rym_track_data_${songLink.href}`;
        const cachedData = trackDataCache[cacheKey];

        if (cachedData) {
            insertTrackRating(trackElement, cachedData.rating, cachedData.count, cachedData.isBold);
            if (cachedData.genre) insertTrackInfo(trackElement, cachedData.genre, cachedData.rankings);
            return 'cached';
        }

        try {
            const response = await fetch(songLink.href, { method: 'GET', credentials: 'include' });
            if (!response.ok) {
                if (response.status === 429) showError('Rate limit hit! Try increasing the request delay in settings.');
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const responseText = await response.text();
            const trackRating = parseTrackRating(responseText);
            const trackInfo = parseTrackInfo(responseText);
            if (!trackRating || !trackInfo) return 'failed';

            trackDataCache[cacheKey] = { ...trackRating, ...trackInfo, timestamp: Date.now() };
            GM_setValue('trackDataCache', trackDataCache);
            insertTrackRating(trackElement, trackRating.rating, trackRating.count, trackRating.isBold);
            insertTrackInfo(trackElement, trackInfo.genre, trackInfo.rankings);
            return 'fetched';
        } catch (error) {
            showError(`Failed to fetch data for "${trackName}".`);
            console.error(`Error processing "${trackName}":`, error);
            return 'failed';
        }
    }

    async function processAllTracks(button) {
        // --- THE FIX: Get a single, unified list of ALL track elements from both lists. ---
        const allTrackElements = Array.from(document.querySelectorAll('#tracks li.track, #tracks_mobile li.track'));

        // The "to-do list" is now correctly based on this unified list.
        const tracksToFetch = allTrackElements.filter(trackElement => {
            const songLink = trackElement.querySelector('a.song');
            return songLink && !trackDataCache[`rym_track_data_${songLink.href}`];
        });

        // Instantly process all cached tracks from the unified list.
        allTrackElements.filter(t => !tracksToFetch.includes(t)).forEach(t => processTrackData(t));

        if (tracksToFetch.length === 0) {
            log('All tracks were already in cache.');
            button.textContent = 'Unload Ratings';
            button.disabled = false;
            return;
        }

        log(`Found ${tracksToFetch.length} elements to process.`);

        button.disabled = true;
        button.style.cursor = 'wait';
        button.textContent = `Loading...`;

        // The chunking logic operates on the unified list, and the cache prevents duplicate fetches.
        for (let i = 0; i < tracksToFetch.length; i += CHUNK_SIZE) {
            const chunk = tracksToFetch.slice(i, i + CHUNK_SIZE);
            log(`Processing chunk starting at index ${i}...`);

            await Promise.all(chunk.map(track => processTrackData(track)));

            if (i + CHUNK_SIZE < tracksToFetch.length) {
                const requestDelay = GM_config.get('requestDelay');
                await new Promise(resolve => setTimeout(resolve, requestDelay));
            }
        }

        log('All tracks processed.');
        button.textContent = 'Unload Ratings';
        button.disabled = false;
        button.style.cursor = 'pointer';
    }

    // --- E. User-Facing Button Actions ---
    async function toggleTrackRatings(button) {
        const allButtons = Array.from(document.querySelectorAll('#load-ratings-btn'));
        const mainButton = button || allButtons[0];

        if (loadClickCount++ % 2 === 0) {
            log('Loading track ratings');
            allButtons.forEach(btn => {
                btn.disabled = true;
                btn.textContent = 'Loading...';
            });
            await processAllTracks(mainButton);
            allButtons.forEach(btn => {
                btn.textContent = 'Unload Ratings';
                btn.disabled = false;
                btn.style.cursor = 'pointer';
            });
        } else {
            log('Unloading track ratings');
            clearTrackRatings();
        }
    }

    function clearTrackRatings() {
        document.querySelectorAll('.page_release_section_tracks_track_stats_scores').forEach(el => el.parentElement.remove());
        document.querySelectorAll('.genre-info, .ranking-info').forEach(el => el.remove());
        document.querySelectorAll('#load-ratings-btn').forEach(btn => {
            btn.textContent = 'Load Track Ratings';
            btn.disabled = false;
            btn.style.cursor = 'pointer';
        });
        log('Cleared track ratings and additional info');
    }

    function toggleGenreRankings() {
        genreRankingsVisible = !genreRankingsVisible;
        GM_setValue('genreRankingsVisible', genreRankingsVisible);
        document.querySelectorAll('li.track').forEach(trackElement => {
            const genreInfoEl = trackElement.querySelector('.genre-info');
            const rankingInfoEl = trackElement.querySelector('.ranking-info');
            if (genreRankingsVisible) {
                if (genreInfoEl) {
                    genreInfoEl.style.display = 'block';
                    if (rankingInfoEl) rankingInfoEl.style.display = 'block';
                } else {
                    const songLink = trackElement.querySelector('a.song');
                    if (!songLink) return;
                    const cachedData = trackDataCache[`rym_track_data_${songLink.href}`];
                    if (cachedData && cachedData.genre) {
                        insertTrackInfo(trackElement, cachedData.genre, cachedData.rankings);
                    }
                }
            } else {
                if (genreInfoEl) genreInfoEl.style.display = 'none';
                if (rankingInfoEl) rankingInfoEl.style.display = 'none';
            }
        });
    }

    // --- F. Cache Management ---
    function clearCache() {
        trackDataCache = {};
        GM_setValue('trackDataCache', {});
        alert('RYM Track Ratings cache has been cleared.');
    }

    function getCache() {
        const cacheDays = GM_config.get('cacheDays');
        const cacheExpiration = cacheDays * 24 * 60 * 60 * 1000;
        const cachedData = GM_getValue('trackDataCache', {});
        const now = Date.now();
        Object.keys(cachedData).forEach(key => {
            if (now - (cachedData[key]?.timestamp || 0) > cacheExpiration) {
                delete cachedData[key];
            }
        });
        return cachedData;
    }

    // --- G. SCRIPT INITIALIZATION ---
    insertButtons();
}

// --- III. SCRIPT EXECUTION TRIGGER ---
window.addEventListener('load', runScript, false);

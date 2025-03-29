// ==UserScript==
// @name         RYM Display Track Ratings
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Displays average Track ratings and info directly on rateyourmusic album or any other release pages.
// @author       cariosa
// @match        https://rateyourmusic.com/release/*
// @icon         https://e.snmc.io/2.5/img/sonemic.png
// @downloadURL  https://update.greasyfork.org/scripts/527869/RYM%20Display%20Track%20Ratings.user.js
// @updateURL    https://raw.githubusercontent.com/cariosa/RYM-Display-Track-Ratings/refs/heads/main/RYM-Display-Track-Ratings.js
// @grant        GM_setValue
// @grant        GM_getValue
// @license      GPL-3.0-or-later
// ==/UserScript==

(function() {
    'use strict';

    // Constants
    const CACHE_EXPIRATION = 7 * 24 * 60 * 60 * 1000; // Cache expiration time in milliseconds (7 days)
    const DEBUG_MODE = false; // Enable debug mode for logging
    const DEFAULT_DELAY = 500; // Default delay between requests in milliseconds

    // Variables to manage state
    let loadClickCount = 0; // Count of how many times "Load Track Ratings" has been clicked
    let trackDataCache = getCache(); // Retrieve cache from storage or initialize empty object

    // Fetch the global state of the "Toggle Genre/Rankings" button
    let genreRankingsVisible = GM_getValue('genreRankingsVisible', true);

    // Logging function for debug messages
    const log = (message) => {
        if (DEBUG_MODE) {
            console.log(message);
        }
    };

    // Show error notifications
    function showError(message) {
        const errorElement = document.createElement('div');
        errorElement.textContent = `Error: ${message}`;
        errorElement.style.color = 'red';
        errorElement.style.position = 'fixed';
        errorElement.style.top = '10px';
        errorElement.style.right = '10px';
        errorElement.style.backgroundColor = 'white';
        errorElement.style.padding = '5px';
        document.body.appendChild(errorElement);
        setTimeout(() => errorElement.remove(), 5000);
    }

    // Create a button with specified text and click handler
    function createButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.style.cssText = `
            margin-left: 3px;
            padding: 3px;
            border: 0;
            border-radius: 2px;
            background: #cba6f7;
            cursor: pointer;
            font-size: 10px;
        `;
        button.addEventListener('mouseover', () => button.style.backgroundColor = '#f2cdcd');
        button.addEventListener('mouseout', () => button.style.backgroundColor = '#cba6f7');
        button.addEventListener('click', onClick);
        return button;
    }

    // Create buttons dynamically
    function createButtons(buttonsData) {
        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginBottom = '10px';

        buttonsData.forEach(({ text, onClick }) => {
            const button = createButton(text, onClick);
            buttonContainer.appendChild(button);
        });

        return buttonContainer;
    }

    // Insert control buttons for loading track ratings and genres/rankings
    function insertButtons() {
        const trackContainers = [
            document.getElementById('tracks'),
            document.getElementById('tracks_mobile')
        ];

        trackContainers.forEach((tracksContainer) => {
            if (!tracksContainer) {
                log('Tracks container not found');
                return;
            }

            const buttonContainer = createButtons([
                { text: 'Load Track Ratings', onClick: toggleTrackRatings },
                { text: 'Toggle Genre/Rankings', onClick: toggleGenreRankings },
                { text: 'Clear Cache', onClick: clearCache }
            ]);

            tracksContainer.parentNode.insertBefore(buttonContainer, tracksContainer);
            log('Buttons inserted successfully');
        });
    }

    // Parse the rating and count from the track's HTML
    function parseTrackRating(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const ratingElement = doc.querySelector('.page_section_main_info_music_rating_value_rating');
        const countElement = doc.querySelector('.page_section_main_info_music_rating_value_number');
        if (!ratingElement || !countElement) {
            log('Failed to find rating or count elements in HTML');
            return null;
        }

        const rating = ratingElement.textContent.trim().match(/\d+\.\d+/)?.[0];
        const count = countElement.textContent.trim().match(/[\d,]+/)?.[0];
        const isBold = ratingElement.querySelector('img[alt="rating bolded"]') !== null;

        return { rating, count, isBold };
    }

    // Parse genre and rankings from the track's HTML
    function parseTrackInfo(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const genreElement = doc.querySelector('.page_song_header_info_genre_item_primary .genre');
        const genre = genreElement ? genreElement.outerHTML : null;

        const rankingElements = doc.querySelectorAll('.page_song_header_info_rest .comma_separated');
        const rankings = Array.from(rankingElements).map(el => el.outerHTML).join('<br>');

        return { genre, rankings };
    }

    // Create HTML for displaying the track rating
    function createRatingHTML(rating, count, isBold) {
        const starClass = isBold ? 'metadata-star-bold' : 'metadata-star';
        return `
            <span data-tiptip="${rating} from ${count} ratings" class="has_tip page_release_section_tracks_songs_song_stats significant">
                <span class="page_release_section_tracks_track_stats_scores">
                    <span class="page_release_section_tracks_track_stats_score_star pipe_separated">
                        <img alt="${isBold ? 'bold star' : 'star'}" class="${starClass}">
                        <div class="page_release_section_tracks_track_stats_rating pipe_separated">
                            ${rating}
                        </div>
                    </span>
                    <div class="page_release_section_tracks_track_stats_count pipe_separated">
                        ${count}
                    </div>
                </span>
            </span>
        `;
    }

    // Insert track rating HTML into the track element
    function insertTrackRating(trackElement, rating, count, isBold) {
        const tracklistLine = trackElement.querySelector('.tracklist_line');
        const trackNumber = trackElement.querySelector('.tracklist_num');
        if (tracklistLine && trackNumber) {
            const ratingElement = document.createElement('span');
            ratingElement.innerHTML = createRatingHTML(rating, count, isBold);
            tracklistLine.insertBefore(ratingElement, trackNumber);
            log('Successfully inserted rating for track');
        }
    }

    // Insert genre and rankings HTML into the track element
    function insertTrackInfo(trackElement, genre, rankings) {
        if (!genreRankingsVisible) {
            return;
        }

        const tracklistLine = trackElement.querySelector('.tracklist_line');
        if (tracklistLine) {
            const genreElement = document.createElement('div');
            genreElement.innerHTML = genre;
            genreElement.style.marginTop = '2px';
            genreElement.classList.add('genre-info');
            tracklistLine.appendChild(genreElement);

            const rankingElement = document.createElement('div');
            rankingElement.innerHTML = rankings;
            rankingElement.style.marginTop = '2px';
            rankingElement.classList.add('ranking-info');
            tracklistLine.appendChild(rankingElement);
        }
    }

    // Process the track data by fetching ratings and genre/rankings
    async function processTrackData(trackElement, index) {
        const songLink = trackElement.querySelector('a.song');
        if (!songLink) {
            log(`No song link found for track ${index + 1}`);
            return;
        }

        const trackName = songLink.textContent.trim();
        const cacheKey = `rym_track_data_${trackName}`;
        const cachedData = trackDataCache[cacheKey];

        if (cachedData) {
            log(`Using cached data for "${trackName}"`);
            insertTrackRating(trackElement, cachedData.rating, cachedData.count, cachedData.isBold);
            insertTrackInfo(trackElement, cachedData.genre, cachedData.rankings);
            return;
        }

        try {
            log(`Fetching data for track: "${trackName}"`);

            const response = await fetch(songLink.href, {
                method: 'GET',
                credentials: 'include',
            });

            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

            const responseText = await response.text();
            const trackRating = parseTrackRating(responseText);
            const trackInfo = parseTrackInfo(responseText);

            if (!trackRating || !trackInfo) {
                log(`Failed to fetch data for "${trackName}"`);
                return;
            }

            trackDataCache[cacheKey] = { ...trackRating, ...trackInfo, timestamp: Date.now() };
            GM_setValue('trackDataCache', trackDataCache);
            insertTrackRating(trackElement, trackRating.rating, trackRating.count, trackRating.isBold);
            insertTrackInfo(trackElement, trackInfo.genre, trackInfo.rankings);
        } catch (error) {
            showError(`Failed to fetch data for "${trackName}". Please try again later.`);
            console.error(`Error processing "${trackName}":`, error);
        }

        await new Promise(resolve => setTimeout(resolve, DEFAULT_DELAY));
    }

    // Process all tracks on the current page
    async function processAllTracks() {
        const trackContainers = [
            document.getElementById('tracks'),
            document.getElementById('tracks_mobile')
        ];

        for (const tracksContainer of trackContainers) {
            if (!tracksContainer) {
                log('Could not find tracks container');
                return;
            }

            const tracks = tracksContainer.querySelectorAll('li.track');
            log(`Found ${tracks.length} tracks`);

            for (let i = 0; i < tracks.length; i++) {
                await processTrackData(tracks[i], i);
            }
        }
    }

    // Toggle the track ratings visibility and load/unload the data
    function toggleTrackRatings() {
        if (loadClickCount % 2 === 0) {
            log('Loading track ratings');
            processAllTracks();
        } else {
            log('Unloading track ratings');
            clearTrackRatings();
        }
        loadClickCount++;
    }

    // Clear the track ratings and additional data from the page
    function clearTrackRatings() {
        const ratingElements = document.querySelectorAll('.page_release_section_tracks_track_stats_scores');
        ratingElements.forEach(el => el.remove());

        const genreInfoElements = document.querySelectorAll('.genre-info');
        genreInfoElements.forEach(el => el.remove());

        const rankingInfoElements = document.querySelectorAll('.ranking-info');
        rankingInfoElements.forEach(el => el.remove());

        log('Cleared track ratings and additional info');
    }

    // Toggle visibility of genre/rankings
    function toggleGenreRankings() {
        genreRankingsVisible = !genreRankingsVisible;
        GM_setValue('genreRankingsVisible', genreRankingsVisible); // Save state globally

        // Hide or show genre/rankings based on the state
        const genreInfoElements = document.querySelectorAll('.genre-info');
        const rankingInfoElements = document.querySelectorAll('.ranking-info');

        genreInfoElements.forEach(el => el.style.display = genreRankingsVisible ? 'block' : 'none');
        rankingInfoElements.forEach(el => el.style.display = genreRankingsVisible ? 'block' : 'none');
        log(genreRankingsVisible ? 'Genres and rankings visible' : 'Genres and rankings hidden');
    }

    // Clear cached data
    function clearCache() {
        trackDataCache = {};
        GM_setValue('trackDataCache', trackDataCache);
        log('Cache cleared');
    }

    // Get the cache data from GM storage or initialize it
    function getCache() {
        const cachedData = GM_getValue('trackDataCache', {});
        const now = Date.now();

        // Delete expired cache entries
        Object.keys(cachedData).forEach(key => {
            const entry = cachedData[key];
            if (now - entry.timestamp > CACHE_EXPIRATION) {
                delete cachedData[key];
            }
        });

        return cachedData;
    }

    // Initialize the script by inserting the control buttons
    insertButtons();
})();

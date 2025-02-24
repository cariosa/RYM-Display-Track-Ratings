// ==UserScript==
// @name         RYM Display Track Ratings
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Displays individual track ratings, genres, and track rankings on RateYourMusic album or any release pages.
// @author       cariosa
// @match        https://rateyourmusic.com/release/*
// @icon         https://e.snmc.io/2.5/img/sonemic.png
// @grant        GM_xmlhttpRequest
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
    let ratingsVisible = false; // Track visibility state of ratings and additional info
    let loadClickCount = 0; // Count of how many times "Load Track Ratings" has been clicked
    let trackDataCache = GM_getValue('trackDataCache', {}); // Retrieve cache from storage or initialize empty object

    // Logging function for debug messages
    const log = (message) => {
        if (DEBUG_MODE) {
            console.log(message);
        }
    };

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

            const buttonContainer = document.createElement('div');
            buttonContainer.style.marginBottom = '10px';

            // Create buttons for loading track ratings, toggling genre/rankings, and clearing cache
            const loadButton = createButton('Load Track Ratings', toggleTrackRatings);
            const toggleButton = createButton('Toggle Genre/Rankings', toggleGenreRankings);
            const clearCacheButton = createButton('Clear Cache', clearCache);
            buttonContainer.appendChild(loadButton);
            buttonContainer.appendChild(toggleButton);
            buttonContainer.appendChild(clearCacheButton);

            // Insert button container before the track list
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
        log(`Processing track ${index + 1}`);

        const songLink = trackElement.querySelector('a.song');
        if (!songLink) {
            log(`No song link found for track ${index + 1}`);
            return;
        }

        const url = songLink.href;
        const trackName = songLink.textContent.trim();
        const cacheKey = `rym_track_data_${trackName}`;
        const cachedData = trackDataCache[cacheKey];

        if (cachedData) {
            const { rating, count, isBold, genre, rankings } = cachedData;
            log(`Using cached data for "${trackName}"`);
            insertTrackRating(trackElement, rating, count, isBold);
            insertTrackInfo(trackElement, genre, rankings);
            return;
        }

        try {
            log(`Fetching data for track: "${trackName}" from URL: ${url}`);

            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    onload: (response) => resolve(response),
                    onerror: (error) => reject(error)
                });
            });

            const trackRating = parseTrackRating(response.responseText);
            const trackInfo = parseTrackInfo(response.responseText);

            if (!trackRating || !trackInfo) {
                log(`Failed to fetch data for "${trackName}"`);
                return;
            }

            // Cache the fetched track data
            trackDataCache[cacheKey] = {
                rating: trackRating.rating,
                count: trackRating.count,
                isBold: trackRating.isBold,
                genre: trackInfo.genre,
                rankings: trackInfo.rankings,
            };
            GM_setValue('trackDataCache', trackDataCache); // Save cache to storage

            insertTrackRating(trackElement, trackRating.rating, trackRating.count, trackRating.isBold);
            insertTrackInfo(trackElement, trackInfo.genre, trackInfo.rankings);
        } catch (error) {
            console.error(`Error processing "${trackName}":`, error);
            alert(`Failed to fetch data for "${trackName}". Please try again later.`);
        }

        await new Promise(resolve => setTimeout(resolve, DEFAULT_DELAY)); // Delay between requests
    }

    // Process all tracks on the current page
    async function processAllTracks() {
        log('Starting to process tracks');
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
                await processTrackData(tracks[i], i); // Wait for each track to be processed
            }
        }

        log('Finished processing all tracks');
    }

    // Toggle visibility of track ratings and additional info
    function toggleTrackRatings() {
        loadClickCount++;

        const tracksContainers = [
            document.getElementById('tracks'),
            document.getElementById('tracks_mobile')
        ];

        tracksContainers.forEach((tracksContainer) => {
            const trackRatings = tracksContainer.querySelectorAll('.page_release_section_tracks_songs_song_stats');
            const genreElements = tracksContainer.querySelectorAll('.genre-info');
            const rankingElements = tracksContainer.querySelectorAll('.ranking-info');

            if (loadClickCount % 2 !== 0) {
                if (!ratingsVisible) {
                    processAllTracks();
                    ratingsVisible = true;
                    log('Track ratings and additional info loaded');
                }
            } else {
                trackRatings.forEach(rating => rating.remove());
                genreElements.forEach(genre => genre.remove());
                rankingElements.forEach(ranking => ranking.remove());
                ratingsVisible = false;
                log('Track ratings and additional info removed');
            }
        });
    }

    // Toggle visibility of genre and ranking information
    function toggleGenreRankings() {
        const genreElements = document.querySelectorAll('.genre-info');
        const rankingElements = document.querySelectorAll('.ranking-info');
        const isVisible = genreElements.length && genreElements[0].style.display !== 'none';

        genreElements.forEach(el => el.style.display = isVisible ? 'none' : 'block');
        rankingElements.forEach(el => el.style.display = isVisible ? 'none' : 'block');
    }

    // Clear the track data cache
    function clearCache() {
        trackDataCache = {};
        GM_setValue('trackDataCache', {}); // Clear cache from storage
        alert('Cache cleared!');
    }

    // Initialize the script after the page is fully loaded
    window.addEventListener('load', () => {
        log('Page loaded, inserting buttons');
        insertButtons();
    });
})();

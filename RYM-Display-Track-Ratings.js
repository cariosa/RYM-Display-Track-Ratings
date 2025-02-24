// ==UserScript==
// @name         RYM Display Track Ratings
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Displays individual track ratings, genres, and track rankings on RateYourMusic album or any release pages.
// @author       cariosa
// @match        https://rateyourmusic.com/release/*
// @icon         https://e.snmc.io/2.5/img/sonemic.png
// @grant        GM_xmlhttpRequest
// @license      GPL-3.0-or-later
// ==/UserScript==

(function() {
    'use strict';

    // Constants for cache expiration and debugging mode
    const CACHE_EXPIRATION = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const DEBUG_MODE = true; // Set to false to disable logging
    let ratingsVisible = false; // Track the visibility of ratings and additional info

    // Logging function that only logs messages if DEBUG_MODE is true
    const log = (message) => {
        if (DEBUG_MODE) {
            console.log(message);
        }
    };

    // Creates a button element with specified text and click handler
    function createButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.style.cssText = `
            margin-left: 3px;
            padding: 3px 3px;
            border: 0px solid #ccc;
            border-radius: 2px;
            background: #cba6f7;
            cursor: pointer;
            font-size: 10px;
        `;
        // Add mouseover and mouseout effects
        button.addEventListener('mouseover', () => button.style.backgroundColor = '#f2cdcd');
        button.addEventListener('mouseout', () => button.style.backgroundColor = '#cba6f7');
        button.addEventListener('click', onClick);
        return button;
    }

    // Inserts control buttons above the track list
    function insertButtons() {
        const tracksContainer = document.getElementById('tracks');
        if (!tracksContainer) {
            log('Tracks container not found');
            return;
        }

        const buttonContainer = document.createElement('div');
        buttonContainer.style.marginBottom = '10px';

        // Create buttons for loading ratings, toggling genre/rankings, and clearing cache
        const loadButton = createButton('Load Track Ratings', toggleTrackRatings);
        const toggleButton = createButton('Toggle Genre/Rankings', toggleGenreRankings);
        const clearCacheButton = createButton('Clear Cache', clearCache);
        buttonContainer.appendChild(loadButton);
        buttonContainer.appendChild(toggleButton);
        buttonContainer.appendChild(clearCacheButton);

        // Insert buttons into the DOM
        tracksContainer.parentNode.insertBefore(buttonContainer, tracksContainer);
        log('Buttons inserted successfully');
    }

    // Parses the track rating and count from the provided HTML
    function parseTrackRating(html) {
        log('Parsing track rating from HTML');
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Select elements containing the rating and count
        const ratingElement = doc.querySelector('.page_section_main_info_music_rating_value_rating');
        const countElement = doc.querySelector('.page_section_main_info_music_rating_value_number');

        // Check if elements were found and extract values
        if (!ratingElement || !countElement) {
            log('Failed to find rating or count elements in HTML');
            return null;
        }

        const rating = ratingElement.textContent.trim().match(/\d+\.\d+/)?.[0]; // Extract rating
        const count = countElement.textContent.trim().match(/[\d,]+/)?.[0]; // Extract count
        const isBold = ratingElement.querySelector('img[alt="rating bolded"]') !== null; // Check if rating is bold

        log('Parsed rating data:', { rating, count, isBold });
        return { rating, count, isBold };
    }

    // Creates HTML for displaying the track rating
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

    // Inserts the track rating HTML into the track element
    function insertTrackRating(trackElement, rating, count, isBold) {
        const tracklistLine = trackElement.querySelector('.tracklist_line');
        const trackNumber = trackElement.querySelector('.tracklist_num');
        if (tracklistLine && trackNumber) {
            const ratingElement = document.createElement('span');
            ratingElement.innerHTML = createRatingHTML(rating, count, isBold);
            tracklistLine.insertBefore(ratingElement, trackNumber); // Insert rating before track number
            log('Successfully inserted rating for track');
        } else {
            log('Could not find required elements to insert rating');
        }
    }

    // Processes a single track to fetch and display its rating
    async function processTrack(trackElement, index) {
        log(`Processing track ${index + 1}`);

        const songLink = trackElement.querySelector('a.song');
        if (!songLink) {
            log(`No song link found for track ${index + 1}`);
            return;
        }

        const url = songLink.href; // Get the track URL
        const trackName = songLink.textContent.trim();
        const cacheKey = `rym_track_rating_${trackName}`; // Create a unique cache key for the track
        const cachedData = localStorage.getItem(cacheKey); // Check for cached data

        if (cachedData) {
            const { rating, count, isBold, timestamp } = JSON.parse(cachedData);
            if (Date.now() - timestamp < CACHE_EXPIRATION) {
                log(`Using cached data for "${trackName}"`);
                insertTrackRating(trackElement, rating, count, isBold); // Insert cached rating
                return;
            } else {
                log(`Cache expired for "${trackName}", fetching new data`);
            }
        }

        log(`Fetching data for track: "${trackName}" from URL: ${url}`);

        try {
            // Fetch the track page data
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    onload: (response) => resolve(response),
                    onerror: (error) => reject(error)
                });
            });

            // Parse the fetched track rating data
            const trackData = parseTrackRating(response.responseText);
            if (!trackData) {
                log(`Could not parse rating data for "${trackName}"`);
                return;
            }

            // Cache the fetched data
            localStorage.setItem(cacheKey, JSON.stringify({
                rating: trackData.rating,
                count: trackData.count,
                isBold: trackData.isBold,
                timestamp: Date.now()
            }));

            insertTrackRating(trackElement, trackData.rating, trackData.count, trackData.isBold); // Insert new rating
        } catch (error) {
            console.error(`Error processing "${trackName}":`, error);
            alert(`Failed to fetch data for "${trackName}". Please try again later.`);
        }
    }

    // Parses the track genre and ranking from the provided HTML
    function parseTrackInfo(html) {
        log('Parsing track genre and ranking from HTML');
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const genreElement = doc.querySelector('.page_song_header_info_genre_item_primary .genre'); // Select genre element
        const genre = genreElement ? genreElement.outerHTML : null;

        // Select ranking elements and create a string of rankings
        const rankingElements = doc.querySelectorAll('.page_song_header_info_rest .comma_separated');
        const rankings = Array.from(rankingElements).map(el => el.outerHTML).join('<br>');

        return { genre, rankings };
    }

    // Inserts the track genre and rankings into the track element
    function insertTrackInfo(trackElement, genre, rankings) {
        const tracklistLine = trackElement.querySelector('.tracklist_line');
        if (tracklistLine) {
            const genreElement = document.createElement('div');
            genreElement.innerHTML = genre;
            genreElement.style.marginTop = '2px'; // Maintain spacing
            genreElement.classList.add('genre-info');
            tracklistLine.appendChild(genreElement); // Insert genre info

            const rankingElement = document.createElement('div');
            rankingElement.innerHTML = rankings;
            rankingElement.style.marginTop = '2px'; // Maintain spacing
            rankingElement.classList.add('ranking-info');
            tracklistLine.appendChild(rankingElement); // Insert ranking info
        }
    }

    // Processes a single track to fetch and display its genre and rankings
    async function processTrackInfo(trackElement, index) {
        log(`Processing track info for track ${index + 1}`);

        const songLink = trackElement.querySelector('a.song');
        if (!songLink) return;

        const url = songLink.href; // Get the track URL
        const trackName = songLink.textContent.trim();
        const cacheKey = `rym_track_info_${trackName}`; // Create a unique cache key for the track
        const cachedData = localStorage.getItem(cacheKey); // Check for cached data

        if (cachedData) {
            const { genre, rankings, timestamp } = JSON.parse(cachedData);
            if (Date.now() - timestamp < CACHE_EXPIRATION) {
                insertTrackInfo(trackElement, genre, rankings); // Insert cached genre/ranking
                return;
            }
        }

        try {
            // Fetch the track page data
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    onload: (response) => resolve(response),
                    onerror: (error) => reject(error)
                });
            });

            // Parse the fetched track info data
            const trackInfo = parseTrackInfo(response.responseText);
            if (!trackInfo) return;

            // Cache the fetched data
            localStorage.setItem(cacheKey, JSON.stringify({
                genre: trackInfo.genre,
                rankings: trackInfo.rankings,
                timestamp: Date.now()
            }));

            insertTrackInfo(trackElement, trackInfo.genre, trackInfo.rankings); // Insert new genre/ranking
        } catch (error) {
            console.error(`Error processing "${trackName}":`, error);
            alert(`Failed to fetch genre/ranking data for "${trackName}". Please try again later.`);
        }
    }

    // Processes all tracks on the page
    async function processAllTracks() {
        log('Starting to process tracks');
        const tracksContainer = document.getElementById('tracks');
        if (!tracksContainer) {
            log('Could not find tracks container');
            return;
        }

        const tracks = tracksContainer.querySelectorAll('li.track'); // Select all track elements
        log(`Found ${tracks.length} tracks`);

        // Process each track
        for (let i = 0; i < tracks.length; i++) {
            await processTrack(tracks[i], i);
            await processTrackInfo(tracks[i], i);
        }
        log('Finished processing all tracks');
    }

    // Toggles the display of track ratings and additional info
    function toggleTrackRatings() {
        const tracksContainer = document.getElementById('tracks');
        const trackRatings = tracksContainer.querySelectorAll('.page_release_section_tracks_songs_song_stats');
        const genreElements = tracksContainer.querySelectorAll('.genre-info');
        const rankingElements = tracksContainer.querySelectorAll('.ranking-info');

        if (ratingsVisible) {
            // Remove ratings, genres, and rankings
            trackRatings.forEach(rating => rating.remove());
            genreElements.forEach(genre => genre.remove());
            rankingElements.forEach(ranking => ranking.remove());
            ratingsVisible = false;
            log('Track ratings and additional info removed');
        } else {
            // Process and show ratings and additional info
            processAllTracks();
            ratingsVisible = true;
            log('Track ratings and additional info loaded');
        }
    }

    // Toggles the display of genre and ranking info
    function toggleGenreRankings() {
        const genreElements = document.querySelectorAll('.genre-info');
        const rankingElements = document.querySelectorAll('.ranking-info');
        const isVisible = genreElements.length && genreElements[0].style.display !== 'none';

        genreElements.forEach(el => el.style.display = isVisible ? 'none' : 'block');
        rankingElements.forEach(el => el.style.display = isVisible ? 'none' : 'block');
    }

    // Clears all cached data from local storage
    function clearCache() {
        localStorage.clear();
        alert('Cache cleared!');
    }

    // Set up event listener to run when the page loads
    window.addEventListener('load', () => {
        log('Page loaded, inserting buttons');
        insertButtons();
    });
})();

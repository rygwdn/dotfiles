/**
 * @file Define functions to manipulate YouTube from tridactyl.
 *
 * This implements functions for keyboard shortcuts that Google
 * documents
 * [here](https://support.google.com/youtube/answer/7631406?hl=en).
 *
 * @todo Not all functions are currently implemented.
 */

(function () {
  /** @namespace */
  tri.youtube_mode = {
    /**
     * A reference to the YouTube player.
     *
     * @const
     * @type {HTMLMediaElement}
     */
    get VIDEO_ELEMENT() { return document.getElementsByTagName("video")[0]},

    /**
     * Toggle video pausing.
     *
     * Equivalent to `k` with the default shortcuts.
     */
    togglePause: function togglePause() {
      if (tri.youtube_mode.VIDEO_ELEMENT.paused) {
        tri.youtube_mode.VIDEO_ELEMENT.play();
      } else {
        tri.youtube_mode.VIDEO_ELEMENT.pause();
      }
    },

    /**
     * Toggle video mute.
     *
     * Equivalent to `m` with the default shortcuts.
     *
     * @todo Figure out how to make the player volume display update.
     */
    toggleMute: function toggleMute() {
      if (tri.youtube_mode.VIDEO_ELEMENT.muted) {
        tri.youtube_mode.VIDEO_ELEMENT.mute = true;
      } else {
        tri.youtube_mode.VIDEO_ELEMENT.mute = true;
      }
    },

    /**
     * Seek the video by the given amount.
     *
     * Equivalent to `j`/`l` with the default shortcuts.
     *
     * @param {number} amount - The amount by which to seek.
     */
    seek: function seek(amount) {
      tri.youtube_mode.VIDEO_ELEMENT.currentTime += amount;
    },

    /**
     * Toggle fullscreen mode.
     *
     * Equivalent to the `f` key with default shortcuts.
     */
    toggleFullScreen: function toggleFullScreen() {
      if (!document.fullscreen) {
        tri.youtube_mode.VIDEO_ELEMENT.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    },

    /**
     * Toggle closed captions.
     *
     * Equivalent to the `c` key with default shortcuts.
     *
     * @todo Figure out how to implement this.
     */
    toggleCaptions: function toggleCaptions() {
    },

    /**
     * Move to the previous playlist item.
     *
     * Equivalent to the `N` key with default shortcuts.
     *
     * @todo Figure out how to implement this
     */
    nextPlaylistItem: function previousPlaylistItem() {
    },

    /**
     * Move to the previous playlist item.
     *
     * Equivalent to the `P` key with default shortcuts.
     *
     * @todo Figure out how to implement this
     */
    previousPlaylistItem: function previousPlaylistItem() {
    },
  };
})();

// Desktop/phone notifications for "it's your turn".
//
// A wordser day is long and turns arrive hours apart, so the game is only
// worth playing if it can tap you on the shoulder. Two rules keep that from
// becoming a nuisance: nothing is ever sent for the game you are looking at
// (you can see the banner), and each game may only tell you once per turn.

const KEY = 'wordser:notify';

const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

const write = (on) => {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Private browsing: the choice just won't survive the reload.
  }
};

export const notify = {
  /** Does this browser have the Notification API at all? */
  supported() {
    return typeof Notification !== 'undefined';
  },

  /** Permission as the browser sees it: 'granted' | 'denied' | 'default'. */
  permission() {
    return this.supported() ? Notification.permission : 'denied';
  },

  /** Asked for, granted, and switched on. */
  enabled() {
    return this.supported() && Notification.permission === 'granted' && read();
  },

  /**
   * Turn them on, asking the browser's permission if it hasn't been asked.
   * Resolves to what actually happened, so the caller can say so.
   */
  async enable() {
    if (!this.supported()) return 'unsupported';
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      write(false);
      return permission === 'denied' ? 'blocked' : 'dismissed';
    }
    write(true);
    return 'on';
  },

  disable() {
    write(false);
  },

  /**
   * Show one. `tag` collapses repeats for the same game, so a phone that was
   * asleep for three turns wakes up to one line rather than three.
   */
  show(title, { body, tag, url } = {}) {
    if (!this.enabled()) return null;
    try {
      const n = new Notification(title, { body, tag, icon: ICON, badge: ICON, renotify: false });
      n.onclick = () => {
        window.focus();
        if (url && !location.href.endsWith(url)) location.href = url;
        n.close();
      };
      return n;
    } catch {
      return null; // some browsers refuse the constructor outside a worker
    }
  },
};

// The tab's own favicon, inlined: notifications may outlive the page.
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔠</text></svg>',
  );
